# Changelog

The plugin (`logseq-plugin-sync-vault-with-geml`) and the watcher
(`@geml/logseq-sync`) are released together under one version. MAJOR tracks the
Logseq major this speaks to — 2.x means Logseq 2.x DB graphs, and nothing
older.

## v2.2.0

**The parser underneath understands `view`.** No plugin or watcher code changed
in this release; what moved is the floor — `@geml/geml` ^1.10.0, and the
lockfile pin with it. A vault page whose GEML carries a `=== view` block — a
table selected, derived or aggregated from another one — is now read as that
table instead of degrading to raw text. The pin is the part that matters: `npm
ci` installs what the lock says, and the lock said 1.9.1 until now.

## v2.1.0

**The vault root is now a graph Logseq opens.** Markdown pages sit at the top
and the GEML tree moves into `.logseq-sync-vault-with-geml/` beside them. The
setting has always been called *Vault folder* and the README has always promised
a plain-text vault, but the folder filled with `.geml` and Markdown was an opt-in
into a second directory — the first person to set it up asked why there was no
Markdown. **The layouts are incompatible and there is no migration: point the
plugin at a fresh folder, or delete the old one and sync again.**

```
<vault>/
  pages/*.md  journals/*.md          open this in Logseq (file version)
  .logseq-sync-vault-with-geml/      the source of truth; restore and --two-way
      graph.geml  ontology.geml      read only this
      pages/*.geml  journals/*.geml
      .geml-manifest.json
```

- **Markdown is the default output.** `--markdown <dir>` still works but now
  means *write it somewhere else* rather than *turn it on*, and `--no-markdown`
  is the off switch it never had.
- **A Markdown page you edited is held, even one the sync wrote earlier.** v2.0.9
  protected files the sync had never written; a page it HAD written was read as
  its own echo and replaced, because the check asked whether the path was in the
  ledger rather than whether the bytes still matched what was recorded. With the
  vault root now inviting edits, that gap was the one that mattered: a `.geml`
  edit can come back through `--two-way`, a Markdown edit cannot come back at
  all, so overwriting one destroys it. Upgrading from a v1 ledger holds nothing
  extra — no hashes recorded means no edit can be proven, and unknown counts as
  ours.
- **The choice lives in the settings panel too.** *When a file was edited
  outside the graph* → *Keep my edit* / *Overwrite with the graph*.
  `--overwrite-unmanaged` still wins for a single run.
- **Both answers are said out loud.** Keeping an edit reports which file was
  kept; taking one reports which file was replaced — in the run's output and in
  the toolbar status. A mode that discards somebody's edit without naming it is
  not offered: that list is the input their next step needs, and it exists only
  if it is printed.
- **Held files are named in the toolbar status.** The watcher had always recorded
  them; nothing read them, so the only place a protected file was visible was a
  terminal — while the person who edited the page is looking at Logseq.
- **Git versions both trees and both ledgers.** The repository is the vault, not
  the GEML tree inside it, so a commit carries the Markdown a person reads. The
  Markdown ledger is committed with it: leaving it out meant a clone restored the
  pages without the record of who wrote them, and the next sync held every
  changed page and stopped updating the tree.

## v2.0.9

The sync will no longer overwrite a file it did not write. If you have been
pointing a vault — or `--markdown` — at a graph you already had, **the first
sync after upgrading holds some pages back and names them** instead of
replacing them; `--overwrite-unmanaged` says you meant it. A file already
byte-identical to what the sync would write is adopted silently, so an
ordinary vault sees no difference.

- **A file the sync never wrote is not its to overwrite.** A vault IS a Logseq
  graph, so people point this at the one they already have — and until now
  that ate it. Three ways: the GEML tree replaced any `.geml` on disk that
  differed from the export, its only guard (`preserve`) carrying two-way
  conflicts alone; the `--markdown` tree kept no record at all and wrote
  `pages/*.md` over whatever was there, and `--markdown` takes any directory;
  and the empty-export guard counted only `.geml`, so a directory that was
  already an OG graph — pages held as Markdown — read as empty and a 0-page
  export was accepted over it. The test is ownership rather than a changed
  hash: a manifest that never claimed a file does not get to replace it, and a
  held file is never recorded, or the next run would read your content as the
  sync's own last write. Held files are named on stderr, counted in the sync
  line, and listed in the status file, so a run that held everything can no
  longer read as success.
- **The Markdown tree keeps its own ledger**, `.geml-md-manifest.json`. A
  separate file because `--markdown` may point at the vault itself, and
  rewritten only when it actually changes — it lives inside somebody's graph,
  and touching it every poll would have Logseq re-reading it forever.

## v2.0.8

Both entries change the vault's text, so **the first sync after upgrading
rewrites every page** — one real diff, once.

- **The vault checks clean.** Outline depth rode as `level=N`, which `text` has
  no known attribute for, so `geml check` answered a real vault with one
  `unknown attribute 'level'` warning per block — nine on the demo export. It
  is a class now (`.level-3`): same meaning, no warning, because classes are
  free-form by design. The reader accepts both spellings, so an older vault
  still imports.
- **`--markdown` writes an OG graph, not generic Markdown.** One bullet per
  block, `id::` for identity, `((uuid))` for block refs — the file version of
  Logseq opens that directory. Page references (`[[Some Page]]`) are the same
  in both dialects and are left alone. Still lossy and one-way: properties,
  tags, tables and data blocks have no OG shape, the GEML tree remains the one
  that round-trips, and `restore` never reads the Markdown. Generic
  GEML-to-Markdown is `geml <file> --to md`, which belongs to the parser.

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
