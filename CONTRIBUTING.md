# Contributing to GEML

Issues and pull requests are welcome. Here is what helps most, roughly in order
of impact.

## ⭐ Write a GEML implementation in your language

GEML's standing as a *standard* — rather than one person's project — depends on
**independent implementations written by different people**. If you build a
parser in Python, Rust, Go, or anything else, you move the project further than
almost any other contribution.

**→ Start here: [Write a GEML parser in your language](docs/WRITING-A-PARSER.md)** —
a step-by-step guide: build order, the document model, the projection contract,
and how to self-certify against the conformance suite + the dogfood spec.

- The conformance corpus is the spec-as-tests:
  [`geml-parser/test/conformance/`](geml-parser/test/conformance/) — each case is
  `input → projected document model`. Make your parser reproduce it and you are,
  by definition, conformant.
- Open an issue when you start. We will link your implementation prominently from
  the README and help you get the suite passing.

A second independent implementation is worth more to GEML than any single
feature. If you are looking for the highest-impact thing to do, this is it.

## Propose a spec change (GEP)

Open an issue labelled `gep` (GEML Enhancement Proposal) with: the change, the
motivation, before/after examples, and the effect on the conformance suite. **The
conformance suite is the contract** — a spec change lands together with its
conformance case, never without one. See [`GOVERNANCE.md`](GOVERNANCE.md).

## Improve the reference implementation

Ordinary PRs against [`geml-parser/`](geml-parser/) and
[`geml-viewer/`](geml-viewer/). The bar:

- Keep `npm test` green — it runs unit tests, the conformance corpus, an
  independent second implementation, round-trip checks, and end-to-end CLI tests.
- Keep the dogfood spec ([`GEML-spec.geml`](GEML-spec.geml)) parsing clean.

```sh
cd geml-parser && npm install && npm run build && npm test
```

## Tooling & integrations

All welcome, and all good first contributions: a tree-sitter grammar, an LSP /
VS Code extension, an Obsidian plugin, a Pandoc reader/writer, editor syntax
files, CI actions. Open an issue to coordinate so we can link it.

## Reporting bugs

Open an issue with a minimal `.geml` input and what `geml check` reports versus
what you expected. Reproducible cases often become new conformance cases.
