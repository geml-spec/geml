# `geml mcp` — document editing over MCP

Let Claude change **one block** of a document instead of rewriting the whole
file; a bad edit is caught before it reaches disk, and a wrong one can be undone
a single block at a time.

This is the document-editing server. There is a separate, read-only server for
navigating a codebase's call graph — see [`geml codemap mcp`](../geml-parser/codemap/).

## Install

```sh
npm install -g @geml/geml
```

```sh
claude mcp add geml -- geml mcp --workspace /abs/path/to/your/docs
```

Or in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "geml": {
      "command": "geml",
      "args": ["mcp", "--workspace", "/abs/path/to/your/docs"]
    }
  }
}
```

`--workspace` is required and is the **only** directory the server will read or
write. A client cannot override or widen it: every path a tool receives is
resolved through it, with symlinks followed before the check, so neither
`../../etc/passwd` nor a symlink planted inside the workspace escapes.

## The tools

| Tool | What it does |
|------|--------------|
| `geml_list_ids` | Every addressable block: `#id`, kind, heading text |
| `geml_read_block` | One block by id — not the whole file |
| `geml_check` | Diagnostics with stable codes ([Appendix A](../spec/GEML-spec.md#appendix-a-diagnostic-catalogue)) |
| `geml_history_log` | Recorded revisions, newest first |
| `geml_write_block` | Replace one block (whole / head / body) |
| `geml_add_block` | Insert blocks or prose (append / before / after) |
| `geml_delete_block` | Remove blocks by id |
| `geml_rename_id` | Rename an id **and every reference to it** |
| `geml_revert_block` | Undo **one block** — its last change, or a named revision |

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

**Every write is preceded by a history commit,** so `geml_revert_block` always
has a revision to undo to. Pass `--no-history` to turn that off; the default is
on, because without it the strongest tool in the set has nothing to revert to.

**`geml_revert_block` undoes one block.** After a bad edit you recover that
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
geml_revert_block(file, id)                 # undo my last edit to this block
geml_revert_block(file, id, rev="-2")       # go to a specific document snapshot
geml_revert_block(file, id, rev="c9d5f1cc") # go to a specific revision id
```

Repeating the call does not walk further back — it alternates between the last
two versions of the block. Revert once, look at the result, and use an explicit
`rev` from `geml_history_log` if you need to go deeper.

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
| `--workspace <dir> is required` | The server refuses to start rather than serve the whole filesystem. |
| `path escapes the workspace` | The path resolved outside `--workspace`. Use a path relative to that root. |
| A write keeps being refused with the same error | The error predates your edit. Run `geml_check` and repair it first. |
| `no .gemlhistory sidecar yet` | Nothing has been written through the server yet; the first write creates it. |
