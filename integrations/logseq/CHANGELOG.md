# Changelog

The plugin (`logseq-plugin-sync-vault-with-geml`) and the watcher
(`@geml/logseq-sync`) are released together under one version. MAJOR tracks the
Logseq major this speaks to — 2.x means Logseq 2.x DB graphs, and nothing
older.

## v2.0.7

- **Block references are checked now.** Logseq stores a block ref as
  `[[<uuid>]]`, which no tool validates. The vault gets GEML's checked form
  instead — `[[#uuid]]` for a target in the same page,
  `[[../pages/other.geml#uuid]]` across pages — so
  `geml check <file> --root <vault>` reports a reference that goes nowhere
  rather than shrugging at it. Page links (`[[Some Page]]`) are left alone;
  the translation reverses exactly, so the round trip stays an identity, and
  the import accepts both forms (a vault written before this holds bare
  uuids).
- A ref whose target is not in the vault — a block on a journal page, which
  `@logseq/cli` 0.4.3 does not export — is reported as unresolved, because
  within the vault it is. It resolves by itself once journals export.
- **Upgrading rewrites every page holding a ref**, once: expect one real diff
  on the first sync after this version.

## v2.0.6

- **`--two-way`.** Vault edits import back into the graph on every cycle,
  under three rules: a file changed on BOTH sides since the last sync is a
  conflict — held exactly as you left it, named in the toolbar status until
  you merge it; deletions are never imported; and a graph backup precedes the
  session's first import and every tenth after. Needs the app CLI.
- The manifest (`.geml-manifest.json`) now records content hashes
  (`{version: 2}`) so the sync tells its own writes from a person's edits.
  Older manifests upgrade on the next sync; the first cycle after an upgrade
  only baselines.
- The toolbar status shows `N imported` and names conflicts.
- README: **Editing the vault from outside** — the agent recipe
  (`geml mcp --root <vault> --no-history`), the one-liner, and bulk
  refactoring via plain shell tools.

## v2.0.5

- `--graph <name>` is refused when the name is not among the graphs found —
  including when none were found (`LOGSEQ_ROOT_DIR` is the escape hatch; the
  API-server route is exempt). The app CLI silently creates unknown graphs, so
  a typo would have synced emptiness over the vault.
- Every preflight error ends with: run `logseq-sync doctor`.

## v2.0.4

- A single-dash typo (`-graph`) is an unknown flag, not a graph name.
- Graph names may not start with `-` or `.` (argv injection into the exporter).
- Windows: a missing `@logseq/cli` fails with install instructions instead of
  `spawnSync npx.cmd EINVAL` on every poll (Node refuses to spawn a `.cmd`
  without a shell). POSIX keeps the `npx` fallback.

## v2.0.3

- The command is `logseq-sync`, matching the package `@geml/logseq-sync`.
  Scripts calling `geml-sync` need the new name. The bridge filenames
  (`geml-sync-*.json`) are unchanged — they are the installed plugins' storage
  contract.

## v2.0.2

- `--help`, `-h` and `help` print the usage, which speaks the installed name
  instead of a repo path; an unknown flag points at it.

## v2.0.1-1

Re-release of 2.0.1 (same manifests; the `-1` distinguishes the GitHub
release), plus what its first screenshots turned up:

- The toolbar shows a clock time, not a raw ISO stamp.
- `~` in the vault folder means home (vault, `--markdown`, `--signal`).
- README screenshots; `publish.yml` builds and attaches the marketplace zip on
  a `v*` tag.

## 2.0.1

### `geml-sync` with nothing after it

Install the plugin, set **Vault folder** in its settings, run
`npx @geml/logseq-sync`. Everything else is worked out — the CLI inside the
Logseq app, the graph the app has open, the plugin's signal file, the vault —
and every one of them has a flag to override it. The old
`geml-sync <graph> <vault>` form still works.

- **`geml-sync doctor`** reports what was found and what is missing, and exits
  non-zero when the setup cannot sync.
- **`geml-sync restore [vault]`** imports a vault back into the graph, merging
  by block uuid. It rehearses unless you pass `--yes`, and `--yes` takes the
  app's own graph backup first.
- **`--markdown <dir>`** also writes a lossy Markdown copy of every page. It is
  not a Logseq graph; the GEML tree stays the one that round-trips.
- **`--mirror`** propagates deletions. Without it, pages removed from the graph
  are kept on disk and reported.
- Detection asks the app's CLI (`graph list`, `server list`) rather than
  reading Logseq's internal state; candidates are ranked and the first that
  answers is used.

### Changed behaviour

- **Watching is the default.** Pass `--once` for a single sync.
- **No repository is created uninvited.** A vault that already is a git repo is
  committed to; a plain folder is left plain. `--git-commit` asks for one to be
  created; `--no-git-commit` opts out entirely.
- The plugin's setting is now **Vault folder** (stored key unchanged).

### Fixed

- A mistyped graph name is refused, with the real ones listed (the app CLI
  would create it and export the empty result).
- A run that wrote files but could not commit says `Git: NOT COMMITTED — …`
  instead of just `Synced`; `doctor` refuses to call such a setup ready.
- A token never reaches the logs or the status file.
- Windows: the app's `logseq.cmd` launcher is read rather than run (Node cannot
  exec it without a shell), and the install directory is searched too.

### Added dependency

`@geml/geml`, for the Markdown conversion behind `--markdown`.

## 2.0.0

First release. The plugin signals on graph change and shows the last sync
result; the watcher exports the DB graph to a folder of GEML documents, writes
only what changed, and commits scoped strictly to the vault.
