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

## [1.7.6] — 2026-08-12

### Changed
- The authoring skill wakes up for documents that were never GEML. Its
  description is the whole trigger, and it only matched when the task already
  sounded like GEML — while the case worth catching is a long README in a
  project that has never heard of the format. The description now names the
  situation, and the skill opens with the route for a document that stays
  Markdown: `list` to map it, `find` to locate a phrase as an address, `get` to
  read one block, then the ordinary editing tool. Nothing is converted and
  nothing is written, and the first rule in that section is when NOT to take
  the route — what is saved is only ever the part of the file you did not have
  to read.

### Added
- The Claude Code plugin ships a `SessionStart` hook: six hundred bytes naming
  what exists and when to skip it, in every session, because a description is a
  match and not a guarantee. It points at the MCP tools rather than the CLI,
  since the plugin registers the server but cannot promise `geml` is on PATH.
  `geml skill install` still installs no hooks, so the hook reaches plugin
  users and nobody else.
- `plugin.json`'s version is asserted against `package.json`. It had sat at
  1.7.0 while the package shipped 1.7.5, and a plugin's users only receive
  updates when that field is bumped — so the lag failed nothing and delivered
  nothing.

## [1.7.5] — 2026-08-12

### Changed
- `geml find` searches a file you NAME whatever its extension. `list` and `get`
  already read Markdown, and having only `find` refuse meant
  `geml find GEML README.md` exited 1 against a file holding forty-four
  matches — a search that answers "no" about a file you pointed straight at.
  The `.geml` filter belongs to the DIRECTORY walk, where taking every file
  would drag a whole source tree through the parser, and it still applies
  there. With this, `find` + `list` + `get` address a plain README the same way
  they address a GEML document, without converting anything.

## [1.7.3] — 2026-08-07

### Added
- `geml list` — the listing `geml get <file>` already printed with no selector,
  under the name the MCP surface uses, and told to be called first. The
  capability was there; nothing pointed at it.
- `geml find <pattern> [path…]` — searches block CONTENT and answers with an
  ADDRESS rather than a line number, so a hit survives the next edit. Reports
  the innermost block holding the match, once per block, and exits 1 on no match
  so `if geml find …` works in a script.
- `L27` / `L27-58` position selectors — the smallest block fully containing
  those lines. Editors, linters, diff hunks and stack traces speak line numbers;
  this is where they cross into block addressing.
- `--intro` on `get` and `set` — a heading's opening region, everything under
  it up to its FIRST subheading. Empty when a heading follows immediately (and
  setting an empty one writes an opening where the section had none); the whole
  body when none does. A block has no intro and asking for one is a usage error.
- `geml replace <file> <old> <new> [--within <selector>]` — **EXPERIMENTAL, and
  may be withdrawn.** A literal swap, never a pattern. Costs what `sed -i` costs
  and adds what it cannot: the result is re-parsed and refused if it would break
  the document, the blocks it touched are named, and the write is in
  `.gemlhistory`. Refuses a swap that would rename an id and points at
  `geml rename`, which fixes the references too.
- `geml_find` on the MCP server, answering in paths relative to the root so a
  row pastes straight into `geml_get`.

### Changed
- Removing content now has ONE rule across every verb: a replacement that drops
  blocks is carried out and REPORTED — every id named, unnamed ones counted,
  orphaned references warned about — with `geml revert` as the way back. It used
  to be refused when the block had an id and done in silence when it did not, so
  a block's fate turned on whether anyone had named it, and a section whose
  opening held a note could not have that opening replaced at all. What is still
  refused is a write that BREAKS the document.
- A link to a directory is no longer a broken link. `ParseOptions.docExists`
  answers the narrower question for LINK checking only; `embed`, `table src=`
  and `data src=` need bytes and still refuse one.
- A fragment is read as a block id only when the target is a `.geml` document.
  In `page.html#sec` or `notes.md#sec` it belongs to that format. The old
  behaviour was wrong in both directions — it accepted `{#brace}` ids no forge
  resolves and refused `<a id>` and slug anchors that every forge does — and it
  passed by ACCIDENT whenever the name appeared anywhere in the target.
- `geml list` prints a line range on EVERY row, headings included. The range is
  itself an address, and a section's was the one most worth having.

### Removed
- Four branches that could never run: `runTransform`'s no-input-file guard
  (dispatch only reaches it with a file) and three in `replace` that restated a
  guarantee `selectUnits` already makes.

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
