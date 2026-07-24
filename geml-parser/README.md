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

- **Addressable** — every block has an `#id`; `geml get` / `geml set '#id'`
  read or patch one section without re-emitting the whole file (on this repo's
  own spec, ~**31× less context** than shipping the whole document).
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

Every command reads a file path, or `-` for stdin. Exit codes: `0` ok ·
`1` document/operation error · `2` usage error.

```sh
geml doc.geml                       # document-model JSON (default --to json)
geml doc.geml --to md|html|geml     # convert; geml notes.md -> GEML
geml get    doc.geml ['#id']        # list addressable ids, or print one block (heading id = its section)
geml set    doc.geml '#id' [--head|--body] [--in F[#src]]   # replace a block's content (id kept)
geml add    doc.geml (--append|--before #id|--after #id) [--in F[#src]]   # insert a fragment
geml delete doc.geml '#id' ['#id2' …]     # remove one or more blocks
geml rename doc.geml '#old' '#new'        # rename an id + every reference to it
geml revert doc.geml '#id' [--rev -1]     # roll a block back to an earlier revision
geml check  doc.geml [--root <dir>]       # validate only: diagnostics + exit code (--json for the array)
geml history <commit|verify|show|restore|log> doc.geml [...]   # .gemlhistory version sidecar
geml codemap <build|verify|render|serve|refresh|find|mcp>      # your codebase's call graph as GEML docs
geml --help | --version             # --version --json prints {"parser","spec"}
```

The agent loop: `geml get` a block → `set`/`add`/`delete`/`rename` it →
`geml check` → `geml history commit` — small, precise, verifiable edits.

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

## License

MIT.
