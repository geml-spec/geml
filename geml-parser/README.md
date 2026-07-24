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

Every command reads a file path, or `-` for stdin. Exit codes: `0` ok ·
`1` document/operation error · `2` usage error.

```sh
geml doc.geml                       # document-model JSON (default --to json)
geml doc.geml --to md -o doc.md     # GEML -> Markdown (lossy)
geml doc.geml --to html -o doc.html # GEML -> one self-contained HTML file
geml doc.geml --to geml             # canonical re-format
geml notes.md                       # Markdown -> GEML (md input defaults to --to geml)
geml - --from md --to geml          # read Markdown on stdin -> GEML
geml get doc.geml                   # list every addressable id (--json for an array)
geml get doc.geml '#plan'           # print ONE block by id (a heading id = its whole section)
geml set doc.geml '#license' --in template.geml#license   # replace #license with the same block from another file
geml revert doc.geml '#plan' --rev -1                      # roll ONE block back to an earlier revision
geml check  doc.geml                # validate only: diagnostics + exit code (--root <dir> widens cross-doc refs)
geml check --json doc.geml          # machine-readable: diagnostics array (or {"error":…} on IO failure)
geml history <commit|verify|show|restore|log> doc.geml [...]   # .gemlhistory version sidecar
geml codemap <build|verify|render|serve|refresh|find|mcp>  # your codebase's call graph as GEML docs
geml --help | --version             # --version --json prints {"parser","spec"}
```

The agent loop: `geml get` a block → edit it → `geml set` (guarded splice) →
`geml check` → `geml history commit` — small, precise, verifiable edits.

Conversion is one entry, `geml <file> [--to json|html|md|geml]`: the input
format is inferred (`--from` overrides > extension > GEML), the target is `--to`
(default: a GEML input → JSON, a Markdown input → GEML), and `-o` only names the
output path. `set --in FILE#id` supplies the new content from one block of
another file — `#id` selects the slot to replace, `--in FILE#id` provides the
source bytes verbatim (its id must match the target, or the splice guard refuses
the write).

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
