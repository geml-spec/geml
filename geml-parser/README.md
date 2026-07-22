<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/geml-spec/geml/main/docs/assets/logo/geml-logo-dark.svg">
    <img src="https://raw.githubusercontent.com/geml-spec/geml/main/docs/assets/logo/geml-logo-light.svg" alt="GEML" width="300">
  </picture>
</p>

# @geml/geml

Reference parser, validator, renderer, and CLI for **GEML** — the General
Expressive Markup Language: a plain-text document format that stays legible to
people and reliable for machines. Every kind of structured content — code,
tables, diagrams, math, callouts, metadata — is carried on **one** primitive,
the typed block:

```
=== code {#hello lang=python}
print("hi")
===
```

References are checked at build time (a dangling `#id` is an error, not a silent
dead link), and the parser emits a document-model JSON with `diagnostics`, so
agents and CI get a structured pass/fail signal.

Built for AI-editing workflows: every block is **addressable** — `geml get` /
`geml set '#id'` read or replace one section without re-emitting the whole file
(on this repo's own spec that is roughly **31× less context** than shipping the
full document) — and **versioned**, via `geml history` and `geml revert` over a
plain-text `.gemlhistory` sidecar. Try the format in the
[playground](https://geml-spec.github.io/geml/playground/), no install needed.

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
geml get    file.geml '#id'      # print ONE block by id — a heading id yields its whole section
geml set    file.geml '#id' --from new.geml  # replace just that block; re-parsed, refused if it breaks the doc
geml check  file.geml            # validate only: diagnostics + exit code
geml check --json file.geml      # machine-readable: diagnostics array (or {"error":…} on IO failure)
geml        file.geml            # full document-model JSON
geml history <commit|verify|show|restore|log> file.geml [...]   # .gemlhistory version sidecar
geml revert file.geml '#id' [--to -1]  # roll ONE block back to an earlier revision (-N | latest | id)
geml render file.geml -o out.html  # one self-contained, interactive HTML file
geml export file.geml -o out.md    # project to GitHub-Flavored Markdown (lossy; notes on stderr)
geml convert in.md     -o out.geml # Markdown -> GEML
geml fmt    file.geml            # canonical re-format (idempotent)
geml codemap <build|verify|render|serve|refresh|find|mcp>  # your codebase's call graph as GEML docs
geml --help | --version          # --version --json prints {"parser","spec"}
```

The agent loop: `geml get` a block → edit it → `geml set` (guarded splice) →
`geml check` → `geml history commit` — small, precise, verifiable edits.

A **heading's** `#id` addresses its whole **section** — the heading line through
the line before the next heading of the same-or-higher level — so the prose
under a heading is block-editable with no extra syntax.
Spans overlap: blocks nested in the section keep their own ids, and a `set` on
the section that drops one of them is refused by the guard. `get --json` on a
heading covers the same content as the raw span: a section envelope
`{kind:"section", id, level, blocks:[heading, …its section's blocks]}` (a
block/footnote id still prints its single model node).

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
