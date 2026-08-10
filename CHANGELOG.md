# Changelog

All notable changes to **`@geml/geml`** (the reference parser, CLI and MCP
server). The **specification** is versioned separately and independently — it
has been `1.0` (Stable) since the first npm release; see
[`spec/GEML-spec.md`](spec/GEML-spec.md) and
[`GOVERNANCE.md`](GOVERNANCE.md#versioning).

`geml --version --json` prints both: `{"parser":"…","spec":"…"}`.

The format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/); this
project follows [Semantic Versioning](https://semver.org/). Entries for `1.0.0`
through `1.7.2` were reconstructed from the release commits, so they record what
each version shipped rather than a contemporaneous editorial note.

The browser extension (`integrations/geml-viewer/`) versions on its own track
and is released under `viewer-v*` tags.

## [Unreleased]

Nothing yet.

## [1.7.2] — 2026-08-06

### Changed
- The CLI is a separate entry point (`dist/cli.js`) from the library
  (`dist/geml.js`), so importing the package no longer pulls the command-line
  layer in.
- `geml codemap serve` renders the graph fullscreen.

## [1.7.1] — 2026-08-05

### Security
- Follow-up hardening for the areas covered under *Scope notes* in
  [`SECURITY.md`](SECURITY.md).

## [1.7.0] — 2026-08-05

### Added
- **`=== data` blocks** ([GEP-0005](spec/proposals/0005-data-block.md)) — a
  block whose body is a *value*, not text: `json` (default) and `jsonl`, with
  `yaml`/`toml` reserved. A malformed body fails the build, `geml get --json`
  returns the value itself, and a chart can bind to it directly.

## [1.6.1] — 2026-08-04

### Added
- **`geml skill install`** — one command sets up the authoring skill, the CLI
  and the MCP server for Claude Code, user-global. It edits no `settings.json`
  and installs no hooks.
- A Claude Code plugin channel (`claude plugin marketplace add geml-spec/geml`).

## [1.6.0] — 2026-08-04

### Changed
- **One selector syntax across `geml get` and `geml set`** — `#id`, a copied
  heading line, `=== type`, and `@<content-hash>` all resolve the same way, and
  a heading id addresses its whole section.
- **`geml history` becomes four verbs** — `save` / `get` / `restore` / `verify`.

## [1.5.1] — 2026-08-01

### Fixed
- Maintenance release.

## [1.5.0] — 2026-07-31

### Added
- **`=== embed` transcludes a block** — in the same document by `#id`, or across
  documents by `src=other.geml#id`, rendering the target's current state in
  place.

### Changed
- `src=` and `data=` resolve under one rule.

### Removed
- The `output` attribute was withdrawn before it shipped in a stable form.

## [1.4.6] — 2026-07-30

### Fixed
- Maintenance release.

## [1.4.5] — 2026-07-29

### Changed
- **Breaking (MCP clients):** every MCP tool is renamed to its CLI command path
  — `geml set` → `geml_set`, `geml codemap search` → `geml_codemap_search` — so
  the terminal and the agent share one vocabulary. Re-register the server after
  upgrading.

## [1.4.4] — 2026-07-28

### Added
- Published to the **MCP Registry**; `server.json` carries the server manifest
  and is versioned in lockstep with `package.json`.

## [1.4.3] — 2026-07-28

### Fixed
- Maintenance release.

## [1.4.2] — 2026-07-24
## [1.4.1] — 2026-07-24
## [1.4.0] — 2026-07-23

### Added
- Block-mutation CLI work landing across these releases: `get` / `set` / `add` /
  `delete` / `rename` / `revert` over addressed blocks, each write re-parsed and
  refused before it reaches disk.

## [1.3.2] — 2026-07-23

### Added
- `geml codemap serve --watch`.

### Fixed
- `geml codemap refresh` pathspec handling.
- `render-html` split into its own module (no API change).

## [1.3.1] — 2026-07-22

### Changed
- Refreshed npm README and package metadata.

## [1.3.0] — 2026-07-22

### Added
- **`=== text` blocks** ([GEP-0004](spec/proposals/0004-text-block.md)) — a run
  of prose becomes addressable without inventing new syntax.

### Fixed
- `{{key}}` interpolation now skips code spans and math, and `\{{key}}` escapes
  it.

## [1.2.3] — 2026-07-21

### Added
- **`geml check --root <dir>`** — widens cross-document reference resolution to
  a directory, so sibling directories can reference each other. Escapes past the
  root are still refused.

## [1.2.2] — 2026-07-21

### Security
- Round-two security-audit fixes. Codemap recipes became structured
  (`{cwd, env, argv}`) behind a schema version gate; older recipes are refused or
  upgraded rather than executed as-is. Plus fixes for scheme control characters,
  same-origin `fetchDoc`, `vscode:`/`action:` schemes, recursion and DoS limits.

## [1.2.1] — 2026-07-21

### Security
- Round-one security-audit fixes: a trust gate closing a remote-code-execution
  path in the codemap recipe runner.

## [1.2.0] — 2026-07-17

### Added
- Published to npm as `@geml/geml`.

## [1.1.1] — 2026-07-13

### Fixed
- Maintenance release.

## [1.1.0] — 2026-07-06

### Added
- **The codemap toolkit ships in the package** — `geml codemap
  build|verify|render|serve|mcp`, writing a codebase's call graph as a tree of
  GEML documents. (The separate `geml codemap mcp` entry point was later
  removed; the code-graph tools are served by `geml mcp --root <dir>` when the
  root holds a graph.)

## [1.0.0] — 2026-06-29

### Added
- First npm release of the reference parser, validator, renderer and CLI,
  against **GEML specification 1.0**.

[Unreleased]: https://github.com/geml-spec/geml/compare/main...HEAD
