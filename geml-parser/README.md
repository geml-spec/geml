<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/geml-spec/geml/main/docs/assets/logo/geml-logo-dark.svg">
    <img src="https://raw.githubusercontent.com/geml-spec/geml/main/docs/assets/logo/geml-logo-light.svg" alt="GEML" width="300">
  </picture>
</p>

# @geml/geml

The reference parser, validator, renderer, and CLI for **GEML** (General
Expressive Markup Language) — **one format, two readers.** People and AI agents
co-write the same document: plain text that stays legible for people, and
**addressable, verifiable, and versioned** for machines.

Every kind of structured content — code, tables, diagrams, math, callouts,
metadata — rides on **one** primitive, the typed block:

```
=== code {#hello lang=python}
print("hi")
===
```

- **Addressable** — every block can be named: an `#id`, or a content address for
  the ones nobody named; `geml get` / `geml set '<selector>'`
  read or patch one section without re-emitting the whole file (on this repo's
  own spec, ~**120× less context** than shipping the whole document — the block
  is ~590 chars whatever the document grows to).
- **Verifiable** — references are checked at build time (a dangling `#id` is an
  error, not a silent dead link), and the parser emits a document-model JSON
  with a `diagnostics` array, so agents and CI get a structured pass/fail signal.
- **Versioned** — `geml history` and `geml revert` snapshot and rewind
  revisions over a plain-text `.gemlhistory` sidecar.

Try the format in the [playground](https://geml-spec.github.io/geml/playground/)
— no install. Full pitch, spec, and format comparison live in the
[repository](https://github.com/geml-spec/geml).

## Install

```sh
npm install -g @geml/geml   # global CLI — installs the `geml` command
# or, per project:
npm install @geml/geml      # library + local bin
```

Requires Node ≥ 22.

## CLI

The CLI is built around one question: can a single agent author and maintain an
entire `.geml` file from the command line — create, add, edit, delete, and copy
blocks in from other files? Three tests keep the command set honest:

- **Complete** — every step of a document's life has a verb, so an agent never
  rewrites the whole file to change one block.
- **Ergonomic** — few flags, sensible defaults, and pipeline-friendly I/O, so
  multi-step edits chain without ceremony.
- **Consistent** — behavior is uniform and predictable: name a target `#id` and
  the content adopts it, every write is guarded, a file is edited in place while
  `-` streams to stdout.

The command set borrows from two settled models rather than inventing one, and
they overlap where it counts. **A document is a table**: a block is a row, its
`#id` is the primary key (unique per document), and `[[#id]]`/`[t](#id)`/`[^id]`/
`data=#id` are foreign keys — so `get`/`add`/`set`/`delete` are
SELECT/INSERT/UPDATE/DELETE. **A block is also a resource** at a URI-like address
(`file#id`), named before the operation, the way REST puts the noun first. Both
models agree on a small orthogonal verb set instead of a method per use case, and
they agree on idempotence: `set` and `delete` are idempotent (deleting a missing
id is a no-op, so a retry is safe), `add` is not.

Where they diverge, each covers what the other cannot. The relational view names
the integrity rules: the write guard is a constraint check with rollback, and
`delete` merely *warning* about references it leaves dangling is a **deferred**
foreign-key check, not `ON DELETE RESTRICT`. It also explains `rename`, the verb
most open to "can this be cut" — a **primary-key update with a cascading
foreign-key rewrite**, irreducible because `delete` + `add` would leave every
reference dangling and nothing else rewrites references in bulk. HTTP has no
method for that at all. The REST view supplies what a database deliberately does
not: every call is **stateless** — no session, no current document, no config
file, no environment variable — which is what lets calls be retried,
parallelized, and piped.

Both pay off in undo. Because the verbs are orthogonal, each edit has exactly one
inverse, so `revert` never needs to know which verb made a change — it reconciles
a block to a revision in three cases (content changed, row missing, row extra)
and there is no fourth, while `rename` is its own inverse and needs no history at
all. A wider, RPC-shaped verb set (`replace`, `move`, `merge`, `split`, …) would
need a per-verb inverse and an operation log to pick one — an undo-stack engine
instead of three branches. Full rationale:
[`docs/design/specs/2026-07-24-geml-block-mutation-cli-design.md`](../docs/design/specs/2026-07-24-geml-block-mutation-cli-design.md).

Every command reads a file path, or `-` for stdin. Exit codes: `0` ok ·
`1` document/operation error · `2` usage error.

```sh
geml doc.geml                       # document-model JSON (default --to json)
geml doc.geml --to md|html|geml     # convert; geml notes.md -> GEML
geml list   doc.geml                # CALL FIRST: every block, its address, kind, line range
geml find   "text" doc.geml|dir     # search block CONTENT -> file<TAB>address; exit 1 = no hit
geml get    doc.geml ['<selector>'] # list addressable blocks, or print what the selector matches
geml get    doc.geml '#sec' --intro # a section cuts three ways: --head | --intro | --body
geml set    doc.geml '<selector>' [--head|--intro|--body] [--in F[#src]]   # replace ONE block's content
geml replace doc.geml OLD NEW [--within '<selector>']   # EXPERIMENTAL: literal swap, checked and reported
geml add    doc.geml (--append|--before #id|--after #id) [--in F[#src]]   # insert a fragment
geml delete doc.geml '#id' ['#id2' …]     # remove one or more blocks
geml rename doc.geml '#old' '#new'        # rename an id + every reference to it
geml revert doc.geml '#id' [--rev -1]     # undo a block: splice / resurrect / remove
geml check  doc.geml [--root <dir>]       # validate only: diagnostics + exit code (--json for the array)
# --root works on every verb above, not just check. A write is refused when the result
# would not parse, so a document whose ../sibling.md links resolve only from the repo
# root needs --root to be editable at all. The MCP server passes its own root for you.
geml history <save|get|restore|verify> doc.geml [...]   # .gemlhistory version sidecar (get = list revisions, or print one)
geml codemap <build|verify|render|serve|refresh|find>   # your codebase's call graph as GEML docs
geml mcp    --root <dir> [--graph <dir>]  # serve documents (+ the code graph) over MCP
geml --help | --version             # --version --json prints {"parser","spec"}
```

The agent loop: `geml get` a block → `set`/`add`/`delete`/`rename` it →
`geml check` → `geml history save` — small, precise, verifiable edits.

### Selectors

`get` and `set` take the same selector, which is a **filter over blocks**:

| Selector | Matches |
|---|---|
| *(omitted)* | nothing — `get` **lists** every addressable block, one per line, by its shortest unique address |
| `#id` | that block. A heading id addresses its **whole section** |
| `'## Heading'` | a heading line copied out of the document, resolved to its id |
| `'=== note'` | **every** `note` block — 0..N of them |
| `'=== note@a3f9c1d2'` | one block by CONTENT, for blocks that carry no `#id` |
| `'@a3f9c1d2'` | the same, with the type check dropped |

`get` answers with N contents when N match (document order, count on stderr);
`set` writes ONE block, so a selector matching several is refused (exit 2) with
the unique address of each candidate. A section cuts three ways: `--head` is the
heading line, `--intro` its opening region — everything under it up to its first
subheading — and `--body` everything under it, so `--body` always contains
`--intro`, and equals it when the section has no subheading. All three
round-trip — `geml get f X --body | geml set f X --body` leaves the file
byte-identical — and `--intro` is how a section's opening is edited without
pulling its subsections into context. A block has no intro; asking for one is a
usage error rather than a quiet fall back to the body.

`replace` is the cheap path when the exact old text is already known and nothing
needs reading — a version string in six places, a term renamed. It is the one
operation where GEML can beat `sed` outright rather than imitate it: the same
two short strings, but the result is re-parsed before it lands, the blocks it
touched are named back to you, and it is in `.gemlhistory` to revert. It swaps a
LITERAL, never a pattern, and refuses a swap that would rename an id — that is
`geml rename`, which fixes the references too. **It is EXPERIMENTAL and may be
withdrawn**; build nothing on it that cannot change.

A write is refused when it would break the document, never merely because it
removes something. A replacement that drops blocks is carried out and the
dropped blocks are named on stderr — unnamed ones counted, references left
dangling reported — with `geml revert` as the way back. That is the same stance
`delete` takes, so removing content has one rule rather than two, and no region
becomes uneditable because something inside it happens to carry an id. The
round trip above drops nothing: the blocks came back in the text you sent.

A `@<hex>` **content address** is the first 8 hex of the SHA-256 of the block's
own text (line endings normalized to LF, no trailing newline), with `~1`, `~2`…
distinguishing byte-identical blocks. Read them out of `geml get doc.geml` —
they are printed for every block that has no `#id`. Being content-derived, an
address **goes stale when the block changes** and then fails with exit 1 rather
than silently addressing a different block: it doubles as a precondition. That
also means `set` through one prints the new address on stderr. The exact hash
input is pinned in
[the selector design doc](../docs/design/specs/2026-08-04-geml-get-set-selector-design-change.md)
§3.4 so a second implementation computes the same values.

Conversion is one entry — `geml <file> [--to json|html|md|geml]`; the input
format is inferred (`--from` overrides > extension > GEML), the target is `--to`
(default: GEML → JSON, Markdown → GEML), and `-o` names the output path.

`set` and `add` take their content from `--in F` (F's block whose id equals the
target), `--in F#src` (F's block `#src`), or stdin (raw bytes). `set` **replaces
a whole block** and normalizes the content's id to the target — so you can fork
any block into this slot without hand-editing its id (`--head` swaps just the
head line, `--body` just the body). `add` **inserts a fragment** (one or more
blocks, or bare prose) at `--append` / `--before #id` / `--after #id`, keeping
the content's own ids (a collision is refused). `delete` removes one or more
ids; `rename` rewrites an id's declaration and every reference to it.

Mutations (`set`/`add`/`delete`/`rename`) write the **whole updated document**:
in place when the input is a file, or to **stdout** when the input is `-`; `-o`
redirects the write (`-o -` forces stdout), so edits pipe cleanly. Every write
is guarded — re-parsed and refused if it would break the document or drop an id
(a reference left dangling by `delete` is a warning, not a refusal; `geml check`
flags it later).

Undo is `revert`, which reconciles one block to a past revision (`--rev`, default
`-1`): it **splices** back changed content, **resurrects** a deleted block (placed
by its old neighbours, or `--append`/`--before`/`--after`), or **removes** a block
that did not exist then. So each forward edit has an inverse:

| forward edit | undo |
|---|---|
| `set #id` | `revert #id` (splice) |
| `delete #id` | `revert #id` (resurrect) |
| `add #id` | `revert #id` (remove) — or `delete #id` |
| `rename #old #new` | `rename #new #old` (self-inverse) |

`revert` reads the `.gemlhistory` sidecar, so `set`/`delete`/`add` undo needs a
prior `geml history save`; `rename` is its own inverse and needs no history.

A **heading's** `#id` addresses its whole **section** — the heading line through
the line before the next heading of the same-or-higher level — so the prose
under a heading is block-editable with no extra syntax.
Spans overlap: blocks nested in the section keep their own ids, and a `set` on
the section that drops one of them is refused by the guard. `get --json` on a
heading covers the same content as the raw span: a section envelope
`{kind:"section", id, level, blocks:[heading, …its section's blocks]}` (a
block/footnote id still prints its single model node). `--head` narrows
`get`/`set`/`revert` to ANY id's head line — a heading's line, or a typed
block's opening fence line, so an agent renames a heading or edits a block's
attributes (caption, compute, …) without touching the body. Convention: keep
the document title in `=== meta` (`title = "…"`), not an H1 — a lone top-level
`#` section is the whole document, the telltale that it is really a title.

## MCP Server

This package includes a standard Model Context Protocol (MCP) server that exposes GEML document CRUD operations. It runs locally and supports Windows, macOS, and Linux.

To connect it to an MCP-compatible client, provide the `npx` execution command and specify the `--root` argument (the directory containing your `.geml` files).

### Claude Desktop
Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "geml": {
      "command": "npx",
      "args": [
        "-y",
        "@geml/geml@latest",
        "mcp",
        "--root",
        "/absolute/path/to/your/docs"
      ]
    }
  }
}
```

### Claude Code / CLI Clients
Run the following command to add the server:
```sh
claude mcp add geml -- npx -y @geml/geml@latest mcp --root /absolute/path/to/your/docs
```

With a code graph under `--root` (`geml codemap build`), the same server also
serves four read-only `geml_codemap_*` tools. Every tool and option:
[`docs/mcp-guide.md`](https://github.com/geml-spec/geml/blob/main/docs/mcp-guide.md).

## Library

```js
import { parse, serialize, renderHtml, gemlToMd, mdToGeml } from "@geml/geml";

const doc = parse(src);                 // { kind:"document", children, ids, diagnostics }
const ok  = !doc.diagnostics.some(d => d.severity === "error");
const html = renderHtml(doc);           // one self-contained HTML string
const md   = gemlToMd(doc).md;          // GitHub-Flavored Markdown (lossy)
const geml = mdToGeml(markdown).geml;   // the inverse
const canonical = serialize(doc);       // GEML text; parse(serialize(parse(x))) is stable
```

`parse(src, { resolveDoc })` enables cross-document reference checking — pass a
function that returns another file's source by path (or `null`).

## Documentation

Full normative spec, history-sidecar spec, and format comparison live in the
[repository](https://github.com/geml-spec/geml). The spec is itself
written in GEML (`GEML-spec.geml`) and parsed clean on every test run.

What changed between releases:
[`CHANGELOG.md`](https://github.com/geml-spec/geml/blob/main/CHANGELOG.md).
The parser and the specification version independently — `geml --version --json`
prints both.

## License

MIT.
