# `geml mcp` — document editing over MCP

*English | [中文](mcp-guide_CN.md)*

Let Claude change **one block** of a document instead of rewriting the whole
file; a bad edit is caught before it reaches disk, and a wrong one can be undone
a single block at a time.

When `--root` also holds a **code graph**, this same server adds the four
read-only call-graph tools — one client entry, one process, instead of two.
This replaced the separate `geml codemap mcp` server, which has been removed;
if you registered it, switch to `geml mcp --root <dir>`.

## Install & Configure

### Claude Code

One command installs the skill, global CLI, and registers the user-scope MCP server:

```sh
npx -y @geml/geml skill install
```

Or register manually:

```sh
claude mcp add --scope user geml -- npx -y @geml/geml mcp --root .
```

`--root .` binds the server to whichever project directory you open Claude Code in.

### Cursor

**Project-level (recommended):** Create `.cursor/mcp.json` in your repository root:

```json
{
  "mcpServers": {
    "geml": {
      "command": "npx",
      "args": ["-y", "@geml/geml", "mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

**Global (Cursor UI):** In **Cursor Settings** → **Features** → **MCP** → **Add New MCP Server**:
- **Name**: `geml`
- **Type**: `command`
- **Command**: `npx -y @geml/geml mcp --root .`

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "geml": {
      "command": "npx",
      "args": ["-y", "@geml/geml", "mcp", "--root", "/abs/path/to/your/docs"]
    }
  }
}
```

### The `--root` Boundary

`--root` is required and is the **only** directory the server will read or
write. A client cannot override or widen it: every path a tool receives is
resolved through it, with symlinks followed before the check, so neither
`../../etc/passwd` nor a symlink planted inside the workspace escapes.

- In IDEs and CLI agents (Cursor, Claude Code), use `.` or `${workspaceFolder}` so confinement follows your active workspace.
- In desktop apps (Claude Desktop), provide an explicit absolute path to your documents folder.

## Serving the code graph too

Point `--root` at the repository and the server picks up
`<root>/.geml-code-graph` automatically, adding the four `geml_codemap_*` tools
to the same tool list:

```sh
geml codemap build --root /abs/path/to/repo      # once, to create the graph
claude mcp add geml -- geml mcp --root /abs/path/to/repo
```

Use `--graph <dir>` for a graph kept somewhere else inside the root. With no
graph those tools are **not listed at all**, so a client never sees a tool it
cannot use.

The graph tools are read-only, but they now share a process that writes — so a
client-supplied `graph_dir` is confined to `--root` like every other path,
rather than being free to name any directory as it was on the old standalone
server. `$GEML_GRAPH_DIR` is ignored here for the same reason: the operator who
chose `--root` decides what the server can reach, not the environment it
inherits.

## The tools

Every tool is named after the command it wraps — `geml set` is `geml_set`,
`geml codemap search` is `geml_codemap_search` — so the CLI and the tools are one
vocabulary, learned once.

| Tool | What it does |
|------|--------------|
| `geml_list` | Every addressable block: its address, kind, heading text |
| `geml_find` | Search block content — answers with addresses, never line numbers |
| `geml_get` | One block by id — not the whole file; `part` cuts a section into `head` / `intro` / `body` |
| `geml_check` | Diagnostics with stable codes ([Appendix A](../spec/GEML-spec.md#appendix-a-diagnostic-catalogue)) |
| `geml_history` | Recorded revisions, newest first |
| `geml_to` | Convert a whole document — `json` / `md` / `geml` / `html`; nothing is written |
| `geml_set` | Replace one block (whole / head / body) |
| `geml_add` | Insert blocks or prose (append / before / after) |
| `geml_delete` | Remove blocks by id |
| `geml_rename` | Rename an id **and every reference to it** |
| `geml_revert` | Undo **one block** — its last change, or a named revision |

`geml_list` reports **every** block, including the ones the author never gave an
`#id`, each with an `address` — and that address feeds straight back into
`geml_get` and `geml_set`, so a block with no id is readable and writable here,
not only from the CLI. The parameter is still called `id` and still takes a bare
one; it simply also accepts the other forms the listing prints (`## Heading`,
`=== type`, `@<hex>`). A content address changes when you write to the block, so
re-read it from `geml_list` before a second edit, and note that `geml_set`
refuses an address matching several blocks rather than choosing one.

`geml_add`, `geml_delete`, `geml_rename` and `geml_revert` still take ids only —
their CLI counterparts do too, so accepting an address here would promise
something the command behind it would refuse.

With a code graph under `--root`, four more (read-only):

| Tool | What it does |
|------|--------------|
| `geml_codemap_search` | Find symbols by name — substring by default, the whole name with `exact` |
| `geml_codemap_list` | The modules, or one module's symbols — browse when you have no name to search for |
| `geml_codemap_node` | Open one node: a symbol's block (with `source: true`, its real source lines too), or a `#calls` / `#called-by` / `#unresolved` table |
| `geml_codemap_callchain` | Several hops as a tree — `callees` downstream, `callers` for the impact path |

`geml_codemap_search` and `geml_codemap_callchain` are the two that keep an agent
off the one-call-per-hop treadmill: the first because a substring is what you
usually have (`exact` is there for when you know the whole name), the second
because a three-level chain would otherwise be three round trips carrying three
full symbol blocks. Every line the chain prints is a complete `doc.geml#id`, so
it can be fed straight back to `geml_codemap_node` without working out which
document it belongs to. Call SITES (`file:line`) live in the `#called-by` table —
read it with `geml_codemap_node`.

A symbol's block stores a **pointer** (`src=path#Lstart-end`), not the code.
`geml_codemap_node(doc, id, source: true)` follows it and returns the symbol's
own lines, numbered — the same source the local viewer shows in its panel, so a
lookup does not have to end with "now open the file yourself". It is off by
default because a node is often opened in a loop, where the pointer is enough.

Where the sources are is the graph's own recorded answer (`_index/refresh.json`,
the same one `geml codemap serve` uses). That file lives inside the graph, so
`geml mcp` bounds it to `--root` as well: a hand-edited recipe pointing outside
is refused rather than followed, and so is a `src=` that resolves out of the
source tree.

Building and refreshing a graph stay on the CLI (`geml codemap build` /
`refresh`): both run indexers or recorded shell steps, and `refresh` is behind a
trust gate for that reason — not something a model should be able to trigger.
`geml codemap serve` renders HTML for a person, which a model cannot consume.

## What makes it different from editing the file directly

**A write is validated before it reaches disk.** Every mutation is first
produced without touching the file; the *result* is parsed; the file is
overwritten only if the result is clean. A broken edit is refused with the
diagnostics that refused it:

```json
{ "ok": false,
  "diagnostics": [
    { "severity": "error", "code": "unresolved-reference",
      "message": "unresolved reference `#ghost`", "line": 12 }
  ],
  "hint": "… The write was refused; the file on disk is unchanged." }
```

The `hint` is there for the model: without being told the file is unchanged, a
model reads "error" and carries on as though its edit landed.

**Every write is preceded by a saved history revision,** so `geml_revert` always
has a revision to undo to. Pass `--no-history` to turn that off; the default is
on, because without it the strongest tool in the set has nothing to revert to.

**`geml_revert` undoes one block.** After a bad edit you recover that
block while every other byte of the document — including good edits made since —
stays exactly as it was. General file-editing tools can restore a whole file
from a snapshot; none of them can put back a single block.

Called without `rev`, it undoes **that block's last change**, however many other
blocks were edited in between. This matters more than it sounds: history records
a snapshot of the whole document per write, so a `-N` offset is a *document*
cursor, and which N holds a given block's previous content depends on how many
unrelated writes followed — a number the caller has no way to know. Pass `rev`
only when you want one specific revision:

```
geml_revert(file, id)                 # undo my last edit to this block
geml_revert(file, id, rev="-2")       # go to a specific document snapshot
geml_revert(file, id, rev="c9d5f1cc") # go to a specific revision id
```

Repeating the call does not walk further back — it alternates between the last
two versions of the block. Revert once, look at the result, and use an explicit
`rev` from `geml_history` if you need to go deeper.

## Two behaviours worth knowing

**Deleting a referenced block is allowed.** References left dangling are
reported in `diagnostics`, but they do not block the deletion — removing
something on purpose is a legitimate act, and the caller decides whether to
repair or restore.

**A document that already has errors is locked until they are repaired.** The
pre-write check refuses any result containing an error, including one the
document already had, so editing an unrelated block in a broken document is
refused too. The refusal says so explicitly — that the errors predate the edit
and which ones they are — so the fix is to repair those first. Repairing them
is never blocked.

## Try it

```
> list the blocks in spec.geml
> read #budget
> rewrite #budget's body to mention Q3
> that was wrong — revert #budget
```

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `--root <dir> is required` | The server refuses to start rather than serve the whole filesystem. |
| `path escapes the server root` | The path resolved outside `--root`. Use a path relative to that root. |
| `graph_dir escapes the server root` | Same rule for the code-graph tools: the directory must sit inside `--root`. |
| The code-graph tools are missing | No graph was found. Run `geml codemap build --root <dir>`, or pass `--graph <dir>`. |
| A write keeps being refused with the same error | The error predates your edit. Run `geml_check` and repair it first. |
| `no .gemlhistory sidecar yet` | Nothing has been written through the server yet; the first write creates it. |
