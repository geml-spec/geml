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

## Install

```sh
npm install -g @geml/geml   # global CLI — installs the `geml` command
# or, per project:
npm install @geml/geml      # library + local bin
```

Requires Node ≥ 18.

## CLI

Every command reads a file path, or `-` for stdin. Exit codes: `0` ok ·
`1` document/operation error · `2` usage error.

```sh
geml check  file.geml            # validate only: diagnostics + exit code
geml check --json file.geml      # machine-readable: diagnostics array (or {"error":…} on IO failure)
geml        file.geml            # full document-model JSON
geml render file.geml -o out.html  # one self-contained, interactive HTML file
geml export file.geml -o out.md    # project to GitHub-Flavored Markdown (lossy; notes on stderr)
geml convert in.md     -o out.geml # Markdown -> GEML
geml fmt    file.geml            # canonical re-format (idempotent)
geml history <commit|verify|show|restore> file.geml [...]   # .gemlhistory sidecar
geml --help | --version          # --version --json prints {"parser","spec"}
```

The agent loop: write `.geml` → `geml check` → fix on non-zero → done.

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
[repository](https://github.com/xiongjy2104/geml-spec). The spec is itself
written in GEML (`GEML-spec.geml`) and parsed clean on every test run.

## License

MIT.
