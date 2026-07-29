# Contributing to GEML

Issues and pull requests are welcome. Here is what helps most, roughly in order
of impact.

## ⭐ Write a GEML implementation in your language

The highest-impact thing you can do for GEML: implement it from the spec in
another language. Two independent parsers that agree are what turn a spec into a
standard — and the proof it's unambiguous.

**→ Start here: [Write a GEML parser in your language](docs/WRITING-A-PARSER.md)**
— build order, the document model, the projection contract, and how to
self-certify against the [conformance suite](geml-parser/test/conformance/) and
the dogfood spec.

Open an issue when you start — we'll link your implementation from the README and
help you get the suite green.

## Propose a spec change (GEP)

Open an issue labelled `gep` (GEML Enhancement Proposal) with: the change, the
motivation, before/after examples, and the effect on the conformance suite. **The
conformance suite is the contract** — a spec change lands together with its
conformance case, never without one. See [`GOVERNANCE.md`](GOVERNANCE.md).

## Improve the reference implementation

Ordinary PRs against [`geml-parser/`](geml-parser/) and
[`geml-viewer/`](integrations/geml-viewer/). The bar:

- Keep `npm test` green — it runs unit tests, the conformance corpus, an
  independent second implementation, round-trip checks, and end-to-end CLI tests.
- Keep the dogfood spec ([`GEML-spec.geml`](spec/GEML-spec.geml)) parsing clean.

```sh
cd geml-parser && npm install && npm run build && npm test
```

## Tooling & integrations

All welcome, and among the best first contributions. Several already exist —
a browser viewer, a VS Code extension, an Obsidian plugin, a CI action — so
check what is open before you start: the README's
**[Build an integration](README.md#build-an-integration)** table lists every
integration with its current state, and names the ones nobody has started (a
tree-sitter grammar, Logseq, Notion, Pandoc, an LSP). Open an issue to claim one
so we can link it.

## Reporting bugs

Open an issue with a minimal `.geml` input and what `geml check` reports versus
what you expected. Reproducible cases often become new conformance cases.
