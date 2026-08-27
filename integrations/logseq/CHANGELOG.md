# Changelog

The plugin (`logseq-plugin-sync-vault-with-geml`) and the watcher
(`@geml/logseq-sync`) are released together under one version. MAJOR tracks the
Logseq major this speaks to — 2.x means Logseq 2.x DB graphs, and nothing
older.

## v2.0.3

- **The command is `logseq-sync` now, matching the package.** You install
  `@geml/logseq-sync` and got a command called `geml-sync` — informative
  twice over, confusing once installed. One name survives, the package's.
  If a script of yours calls `geml-sync`, it needs the new name; nothing
  else changes.
- What deliberately does NOT change: the bridge filenames
  (`geml-sync-dirty.json`, `geml-sync-status.json`). They are the storage
  contract between the installed plugin and the watcher — renaming them
  would break every existing install's bridge for a cosmetic win.
- The README's terminal transcript was re-recorded with the renamed
  command — it is real output, so it gets re-run rather than edited.

## v2.0.2

- **`geml-sync --help` exists now.** The command answered it with
  `Unknown flag`, while the full usage sat in the file's header comment —
  visible to source readers, invisible to anyone who got the command from npm.
  The text moved into the program: `--help`, `-h` and a bare `help` print it,
  and an unknown flag says where usage lives. The tests pin what the fix is
  about — the usage speaks the installed name (`geml-sync …`) and never a repo
  path, which is what the old fallback line taught
  (`node watcher/bin/geml-sync.mjs`, to people who do not have a repo).

## v2.0.1-1

A re-release of package version 2.0.1 — the manifests still read `2.0.1`; the
`-1` distinguishes this release from the earlier one carrying the same version.
Everything in 2.0.1, plus what the first screenshots of it turned up.

- **The toolbar shows a clock time.** It read `last sync at
  2026-08-26T16:46:51.943Z` — the watcher records an ISO instant, which is the
  right thing to store in a status file and the wrong thing to put in front of
  a person. A stamp that will not parse is passed through untouched rather than
  rendered as "Invalid Date".
- **`~` in the vault folder means home.** The setting is typed into a text field
  in Logseq's settings panel, where nothing expands it, so `~/logseq-vault`
  resolved to a directory literally named `~` beside the working directory.
  Fixed for the vault, `--markdown` and `--signal`.
- **The vault setting says what to put there** — any folder, created if missing,
  read back by `restore` — **and what happens if you leave it empty**: there is
  deliberately no default, and `geml-sync` asks you for one rather than choosing
  where your notes live.
- The README shows the plugin in action: the toolbar reporting a sync, and the
  settings panel.
- `publish.yml`: pushing a `v*` tag builds the plugin, assembles the zip, checks
  it carries the plugin manifest, `dist/index.js` and the icon, and uploads it.

## 2.0.1

### `geml-sync` with nothing after it

Setup was six steps, four flags and a storage path you had to transcribe. Now:
install the plugin, set **Vault folder** in its settings, run
`npx @geml/logseq-sync`. Everything else is worked out — the CLI inside the
Logseq app, the graph the app has open, the plugin's signal file, the vault.
Every one of them still has a flag to override it, and the old
`geml-sync <graph> <vault>` form still works.

- **`geml-sync doctor`** reports what was found and what is missing, and exits
  non-zero when the setup cannot sync.
- **`geml-sync restore [vault]`** imports a vault back into the graph, merging
  by block uuid. It rehearses unless you pass `--yes`, and `--yes` takes the
  app's own graph backup first.
- **`--markdown <dir>`** also writes a lossy Markdown copy of every page, for
  tools that read nothing else. It is not a Logseq graph and will not open in
  the file version; the GEML tree stays the one that round-trips.
- **`--mirror`** propagates deletions. Without it, pages removed from the graph
  are kept on disk and reported.
- Detection asks the app's CLI (`graph list`, `server list`) rather than reading
  Logseq's internal state, so a graph root outside the default place works, and
  so does an OS this has not been run on. Candidates are ranked — what the app
  installed first, a hardcoded path last — and the first that actually answers
  is the one used.

### Changed behaviour

- **Watching is the default.** Pass `--once` for a single sync.
- **No repository is created uninvited.** A vault that is already a git repo is
  committed to; a plain folder is left plain, because it may be inside Dropbox
  or iCloud. `--git-commit` asks for one to be created; `--no-git-commit` opts
  out entirely.
- The plugin's setting is now **Vault folder** (stored key unchanged), and its
  description says which direction it points: destination when syncing, source
  when restoring.

### Fixed

- **A mistyped graph name is refused.** `logseq graph export --graph <name>`
  does not fail on an unknown name — it creates that graph and exports the empty
  result. Names absent from the graph root are now rejected, with the real ones
  listed.
- **A failed git commit is reported.** A run that wrote files but could not
  commit (no configured author, `user.useConfigOnly`) said only `Synced`. It now
  says `Git: NOT COMMITTED — …`, and `doctor` refuses to call such a setup ready.
- **A token never reaches the logs.** `execFileSync` puts the whole failed argv
  into its error message, which is both printed and written into the status file
  the plugin shows. Every path that surfaces an error scrubs it.
- **Windows: the app's launcher is usable.** Logseq installs `logseq.cmd` there,
  which Node cannot exec without a shell. It is a wrapper the app generates and
  marks; it is now read rather than run. The app's install directory is searched
  on Windows too.

### Added dependency

`@geml/geml`, for the Markdown conversion behind `--markdown`.

## 2.0.0

First release. The plugin signals on graph change and shows the last sync
result; the watcher exports the DB graph to a folder of GEML documents, writes
only what changed, and commits scoped strictly to the vault.
