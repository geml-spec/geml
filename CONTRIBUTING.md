# Contributing to GEML

Issues and pull requests are welcome. Here is what helps most, roughly in order
of impact.

Two documents frame the rest: [`GOVERNANCE.md`](GOVERNANCE.md) for how decisions
are made, and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for the one rule about
people — argue with the design as sharply as you like, not with the person.

## ⭐ Write a GEML implementation in your language

The highest-impact thing you can do for GEML: implement it from the spec in
another language. Independent parsers that agree are what turn a spec into a
standard — and the proof it's unambiguous.

**→ Start here: [Write a GEML parser in your language](docs/WRITING-A-PARSER.md)**
— build order, the document model, the projection contract, and how to
self-certify against the [conformance suite](geml-parser/test/conformance/) and
the dogfood spec.

[`geml-parser-rs/`](geml-parser-rs/) is the worked example: a second
implementation written from the spec and the conformance suite alone, without
reading the reference parser, in Rust and compiled to WebAssembly. Both
implementations are by one author, though, so a parser from other hands is
still the proof that counts.

Open an issue when you start — we'll link your implementation from the README and
help you get the suite green.

## Propose a spec change (GEP)

Open an issue labelled `gep` (GEML Enhancement Proposal) with: the change, the
motivation, before/after examples, and the effect on the conformance suite. **The
conformance suite is the contract** — a spec change lands together with its
conformance case, never without one. See [`GOVERNANCE.md`](GOVERNANCE.md).

## Improve the reference implementation

Ordinary PRs against [`geml-parser/`](geml-parser/),
[`geml-parser-rs/`](geml-parser-rs/) and
[`chrome-geml-viewer/`](integrations/chrome-geml-viewer/). The bar:

- Keep `npm test` green — it runs unit tests, the conformance corpus, an
  independent second implementation, round-trip checks, and end-to-end CLI tests.
- Keep the dogfood spec ([`GEML-spec.geml`](spec/in_geml_format/GEML-spec.geml)) parsing clean.

```sh
cd geml-parser && npm install && npm run build && npm test
```

### What CI checks

A pull request is green when every job in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) passes. Run the ones
your change touches before you push:

| Job | What it runs |
|---|---|
| lockfiles | `npm ci --dry-run` in every directory with a `package-lock.json` — a manifest and its lockfile must agree |
| parser (ubuntu, windows, macos) | `npm test` in `geml-parser/` on all three; on Linux also `npm run coverage:check` — lines, statements, functions and branches each at 95% or more |
| parser-rs | in `geml-parser-rs/`: `cargo fmt --check`, `cargo clippy --all-targets --features wasm -- -D warnings`, `cargo llvm-cov --fail-under-lines 95 --fail-under-regions 95 --fail-under-functions 95`, then `wasm-pack build --target nodejs --out-dir wasm/pkg --release -- --features wasm`, `node wasm/conformance.mjs` and `node wasm/profiles.mjs` |
| viewer | `npm run coverage:check` in `integrations/chrome-geml-viewer/`, the VS Code preview bundle (`npm run build:vscode`), and `npm test` in `integrations/vscode/` |
| logseq, obsidian | `npm test` in `integrations/logseq/` and `integrations/obsidian/` |

[`geml-check.yml`](.github/workflows/geml-check.yml) runs beside it: every
tracked `.geml` document in the repository has to pass `geml check`.

## License of contributions

By opening a pull request you agree that your contribution is licensed under
the repository's existing terms: MIT for code ([`LICENSE`](LICENSE)) and
CC-BY-4.0 for the specification documents
([`spec/LICENSE-spec.md`](spec/LICENSE-spec.md)). There is no CLA to sign and
no DCO: a `Signed-off-by` line is welcome but not required.

## Tooling & integrations

All welcome, and among the best first contributions. Several already exist —
a browser viewer, a VS Code extension, an Obsidian plugin, a CI action — so
check what is open before you start: the README's
**[claim a piece](README.md#integrations)** table is the one list of the gaps
that are open right now, with what each one takes, and the table under it lists
every shipped integration with its current state. Open an issue to claim one so
we can link it.

## Reporting bugs

Open an issue with a minimal `.geml` input and what `geml check` reports versus
what you expected. Reproducible cases often become new conformance cases.
