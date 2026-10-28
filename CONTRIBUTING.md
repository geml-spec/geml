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
the README's [where it runs](README.md#integrations) table lists every shipped
integration with its current state. These are the gaps open right now, with what
each one takes; open an issue to claim one so we can link it.

| Gap | Where it stands | What it takes |
|---|---|---|
| **Skill installation for more agent tools** | Gemini CLI, Qwen Code and AGENTS.md are installed by detection already; the MCP server works with any client | Add the rest the same way: **Cursor**, **GitHub Copilot**, **Cline** — their rule-file conventions move fast, so check the current docs before writing one in |
| **How well the primer holds on other models** | Only exercised on Claude | Have GPT / Gemini / a local model each write a batch of GEML from the primer, count how many pass `geml check` first time, and report the rules they keep getting wrong — those are the ones the primer should name |
| **Deeper Obsidian integration** | Renders, but not in the community store yet | Editing at the CodeMirror layer and seamless two-way rendering, plus the store submission itself. Wants someone who knows the Obsidian API. |
| **The viewer on other browsers** | Chrome works | Firefox / Safari ports. |
| **Packaging the RAG integrations** | LangChain / LlamaIndex are reference implementations | Publishing to PyPI; and wiring up other frameworks (Haystack, DSPy, …). |

## Repository layout

```
spec/                  The specification as .md (EN / 中文) and the CC-BY spec
                       license, with profiles/ (application layers — geml-history,
                       geml-codemap, geml-style, geml-form, geml-media,
                       geml-translator, geml-statechart — each a reference beside
                       a one-page usage guide) and proposals/ (GEPs), both MIT
spec/in_geml_format/   The dogfood: the specification written in GEML, with its
                       .gemlhistory sidecar
geml-parser/           Reference parser, renderer, CLI + codemap toolkit (TypeScript, Node 22)
geml-parser-rs/        The second implementation: the same spec in Rust, compiled to
                       WebAssembly, written from the spec and the conformance suite alone
integrations/          Everywhere GEML plugs in: chrome-geml-viewer (browser extension),
                       geml-check-action (CI), vscode, intellij+androidstudio-plugin,
                       obsidian, logseq (two-way vault sync + the watcher), tree-sitter (brief),
                       langchain+llamaindex (RAG loaders), windows-icon
                       (Explorer file icons), geml-mcp-worker (the hosted MCP
                       server, a Cloudflare Worker), the agent-harness plugins —
                       claude-plugin, codex-plugin, grok-plugin, dsh-plugin — and
                       website (what this repository pushes to the site)
.agents/, .claude-plugin/   Plugin marketplace manifests, so the plugins show up
                       from a checkout (Codex `/plugins`, Claude Code `/plugin`)
docs/                  Guides (MCP, writing a parser), design records, the release
                       runbook, assets (logos)
.claude/skills/        Claude skills: GEML authoring, and the code graph
.github/               CI, security-scan, release and site workflows (npm, MCP
                       registry, VS Code, viewer, website), issue templates (bug,
                       GEP, new implementation) and the PR template
(website)              The homepage, playground, demos, blog, comparisons,
                       benchmarks, manifesto and illustrated pages live in their
                       own repository, geml-spec/geml-spec.github.io, which links
                       here for the spec and guides; the website workflow pushes it
                       the playground bundle, code graph and logos. What
                       this repository publishes at geml-spec.github.io/geml/ is
                       site/ — a forward to the same path on the new site.
```

## Reporting bugs

Open an issue with a minimal `.geml` input and what `geml check` reports versus
what you expected. Reproducible cases often become new conformance cases.
