# Sync Vault with GEML

Your Logseq DB graph as a **continuously synced, Git-friendly plain-text
vault** — pages and journals back in readable files and folders, the way OG
vaults felt, kept in step with the database.

![How it works](docs/how-it-works.svg)

## What you get

- 🌿 **Real git workflows** — clean commits, readable line-by-line diffs, full
  version history for a DB graph
- 📦 **A plain-text escape hatch that stays yours** — every page a readable
  file, not a database dump
- 🔁 **Continuous, not one-shot** — edit in Logseq, and seconds later the file
  and its git commit exist

Logseq 2.0 ships both ends of a trade-off: `logseq export` gives Markdown
(readable, lossy) and `logseq export-edn` gives EDN (lossless, not something a
person edits). The vault's format, [GEML](https://github.com/geml-spec/geml),
is the point between: **as readable as the Markdown export, as lossless as the
EDN one** — and addressable, so external tools and agents can edit one block
of a graph instead of round-tripping all of it.

The tree is laid out the way an OG vault is — the thing a file-version user
recognizes as "my graph, as files again":

```
{:pages-and-blocks [...]}          ontology.geml            :properties/:classes, verbatim EDN
                          ⇄        graph.geml               page ORDER (an addressable data block,
                                                            so filenames need no numeric prefixes)
                                   journals/2025_02_20.geml journal pages, OG date names
                                   pages/<name>.geml        one per page:
                                     block title  → `=== text` body
                                     block uuid   → `{#uuid}`  ← geml get/set address
                                     outline tree → flat blocks with `level=N`
                                     everything else rides along in `code {lang=edn}`
```

(`@logseq/cli` 0.4.3's `export-edn` does not include journal pages, so live
exports show `pages/` only today; the journal mapping is fixture-tested.)

## How it works — two halves, one honest boundary

A Logseq 2.0 plugin runs in a sandboxed iframe: no arbitrary-path filesystem,
no git, no shell (verified against the 2.0.1 app bundle). So the in-app plugin
(`plugin/`) does the only two things only it can do:

- **hear** the graph change (`logseq.DB.onChanged`, debounced) and write a
  dirty-marker file through the plugin storage API;
- **show** the last sync result in the toolbar (`⇄`) and command palette.

Everything with side effects lives in the **watcher** (`watcher/bin/geml-sync.mjs`),
built on the official `@logseq/cli` export. It reacts to the marker file
immediately (interval polling stays on as a fallback), writes only the files
that actually changed — so `git diff` is never noise — commits with a pathspec
scoped strictly to the vault, and reports back for the toolbar to display.
The two halves meet in the plugin's own storage directory
(`<dotdir>/storages/logseq-plugin-sync-vault-with-geml/`), the one disk location both can
reach. A file as the bridge beats a local HTTP API: no port, no server, no
CORS.

Real output, real DB graph (exported with the official CLI, validated by
`logseq validate`):

```text
$ node watcher/bin/geml-sync.mjs geml-spike ~/vault-demo --git-commit --signal <storage>/geml-sync-dirty.json
Starting GEML Sync: Graph "geml-spike" ➔ ~/vault-demo
Git auto-commit: enabled (scoped to target paths)
[19:29:14] Synced: 8 written, 0 unchanged.
  Git: [master (root-commit) 9cc348c] logseq-geml: sync graph "geml-spike"
 9 files changed, 142 insertions(+)
 create mode 100644 graph.geml
 create mode 100644 pages/contents.geml
 ...

$ node watcher/bin/geml-sync.mjs geml-spike ~/vault-demo --git-commit --signal ...   # run again
[19:29:55] Graph is up-to-date (0 written, 8 unchanged).
```

## Setup

**1. Install the plugin** from the marketplace — or build and load it
unpacked (`dist/` is not checked in):

```sh
cd plugin && npm install && npm run build
```

then Settings → Advanced → Developer mode → "Load unpacked plugin" → `plugin/`.

**2. Get the watcher** — one npm install, gives you the `geml-sync` command:

```sh
npm install -g @geml/logseq-sync
```

(or run it ad hoc with `npx @geml/logseq-sync …`; the source lives in this
repository under `watcher/` and `core/`)

**3. Install `@logseq/cli`** (one time, anywhere). On Node 24 its
`better-sqlite3` has no prebuilt binding until 12.11.1, so pin an override
(without it, install tries to compile and node-gyp does not recognize
VS 2026 yet):

```sh
mkdir logseq-cli && cd logseq-cli && npm init -y
npm pkg set overrides.better-sqlite3=12.11.1
npm i @logseq/cli
```

**4. Run the watcher**, with `LOGSEQ_CLI_DIR` pointing at that directory and
`--signal` pointing at this plugin's storage directory:

```sh
geml-sync <your-graph> <your-vault-dir> --watch --git-commit \
  --signal <logseq-dotdir>/storages/logseq-plugin-sync-vault-with-geml/geml-sync-dirty.json
```

Edit a block in Logseq → the plugin signals → the watcher syncs → the toolbar
`⇄` button shows `Sync Vault with GEML: last sync at … — 1 written, 7 unchanged.`

**Settings**: *Debounce (seconds)* — quiet period after the last change before
the watcher is signalled (default 5; syncs feed git commits, so this is
deliberately calmer than UI-style debounce).

## Honesty corner

- Sync is **export-direction** today (graph → files, continuously). The
  write-back path (edit a `.geml` file → import back by UUID) is proven in the
  engine (`syncDiskToEdn`) and lands next; deletions are reported, never
  auto-propagated (`--signal` never deletes your hand-written files either — a
  manifest tracks what the sync owns).
- Journal pages appear as soon as `@logseq/cli` exports them (0.4.3 does not).
- The watcher half is tested end-to-end in CI (a planted fake CLI exports
  fixture EDN, so the signal → re-sync → status round trip runs with no Logseq
  installed). The in-app half is verified against the 2.0.1 runtime — the
  plugin API surface, `hook:db:changed`, the storage-file bridge — and its
  SDK is `@logseq/libs` 0.3.x (the `next` tag). If anything misbehaves in
  your setup, an issue with your Logseq version is gold.

## Proven on a live DB graph, judged by Logseq's own validator

`npm test` proves, on fixtures lifted from Logseq's own `deps/db` export tests:

1. **EDN → GEML → EDN is a structural identity** (EDN map/set semantics).
2. Every generated document parses as GEML with **zero error diagnostics**.
3. A block Logseq considers addressable (exported uuid) is **addressable in
   GEML by the same id**.
4. **Editing one block's text changes exactly that block** in the EDN — no
   collateral change anywhere in the graph.

And `bin/live-roundtrip.mjs` has confirmed all four against a real DB graph
(2026-08-20, schema 65.22): export → 6 clean documents → identity; then with
`--edit`, a `geml set` on one block imported back with `logseq import-edn`,
**`logseq validate`: Valid!**, and the re-export showed the edit landed **in
place by uuid, exactly once — whole-graph re-import merges, it does not
duplicate**.

The design and the reasoning live in the
[GEML monorepo](https://github.com/geml-spec/geml)
(`docs/design/specs/2026-08-20-logseq-integration-scoping.md`); the community
threads are
[logseq/logseq#13086](https://github.com/logseq/logseq/discussions/13086) and
[the forum post](https://discuss.logseq.com/t/35193).

## Development

```
core/      converter (mapping.mjs), sync engine, bridge.mjs (the signal/status file contract)
watcher/   the geml-sync CLI and its end-to-end tests — published to npm as @geml/logseq-sync
plugin/    the in-app half (this package.json is the Logseq plugin manifest)
```

Source of truth is
[`integrations/logseq/`](https://github.com/geml-spec/geml/tree/main/integrations/logseq)
in the GEML monorepo; this repository mirrors it for the marketplace and
carries the releases. Please open issues here, and PRs against the monorepo.

The converter is two pure functions in `core/src/mapping.mjs` —
`ednToGemlFiles(ednText)` and `gemlFilesToEdn(files, lib)` — with the reference
parser injected. The tests import the parser's build:

```sh
cd geml-parser && npm install && npm run build && cd ../integrations/logseq
npm install
npm test
```

Live-stage demos (need `@logseq/cli` via `LOGSEQ_CLI_DIR`, see Setup step 3):

```sh
node watcher/bin/create-graph.mjs my-graph      # create a DB graph WITHOUT the desktop app
node watcher/bin/live-roundtrip.mjs my-graph            # read-only: export → GEML → back → compare
node watcher/bin/live-roundtrip.mjs my-graph --edit     # + geml set → import-edn → logseq validate
```

Versioning: the MAJOR version tracks the Logseq major it targets — this is
2.x because it speaks Logseq 2.x (DB graphs) and nothing older. Minor/patch
are this package's own.

## Next

- **Reference translation**: block refs in titles are literally `[[<uuid>]]`,
  one character away from GEML's checked `[[#uuid]]` — translating them lets
  `geml check` catch broken block refs, the actual headline of the proposal.
- Property readability: scalar `:build/properties` as GEML attributes instead
  of the `.block-meta` EDN ride-along (NAME rules permitting).
- **Write-back**: wiring `syncDiskToEdn` to the CLI so the vault is
  two-way — edit the file, the graph follows.

MIT © GEML contributors
