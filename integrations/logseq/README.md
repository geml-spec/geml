# GEML ⇄ Logseq DB graphs

Logseq 2.0 ships both ends of a trade-off: `logseq export` gives Markdown
(readable, lossy) and `logseq export-edn` gives EDN (lossless, not something a
person edits). GEML is the point between: **as readable as the Markdown export,
as lossless as the EDN one** — and addressable, so external tools and agents
can edit one block of a graph instead of round-tripping all of it.

This package converts `logseq export-edn` output (sqlite.build EDN) into a tree
of `.geml` documents and back.

Versioning: the MAJOR version tracks the Logseq major it targets — this is
2.x because it speaks Logseq 2.x (DB graphs) and nothing older. Minor/patch
are this package's own.

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

## Status: proven on a live DB graph, judged by Logseq's own validator

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
duplicate**. One caveat for anyone re-running: `better-sqlite3` was overridden
to 12.11.1 (first version with a Node 24 prebuilt binding).

The design and the reasoning live in
[`docs/design/specs/2026-08-20-logseq-integration-scoping.md`](../../docs/design/specs/2026-08-20-logseq-integration-scoping.md);
the community thread is
[logseq/logseq#13086](https://github.com/logseq/logseq/discussions/13086).

## Next

- **Reference translation**: block refs in titles are literally `[[<uuid>]]`,
  one character away from GEML's checked `[[#uuid]]` — translating them lets
  `geml check` catch broken block refs, the actual headline of the proposal.
- Property readability: scalar `:build/properties` as GEML attributes instead
  of the `.block-meta` EDN ride-along (NAME rules permitting).
- **Continuous sync** on top of the proven round trip, so the GEML tree stays
  the graph's durable text form: git-committable, agent-editable, with the app
  as one editor over it. `bin/geml-sync.mjs <graph> <dir> [--watch]
  [--git-commit]` watches a graph and keeps a local Git-tracked folder in step,
  writing only the files that changed and committing only what it wrote. Export
  direction today; the write-back path exists in the engine
  (`syncDiskToEdn`) and is not wired to the CLI yet.

## In-app plugin (Logseq 2.0)

`plugin/` is a Logseq 2.0 plugin — **Live Sync Vault** — with one deliberately
small job: it listens
for graph changes (`logseq.DB.onChanged`, debounced) and writes a dirty-marker
file through `logseq.FileStorage`; a toolbar button and a command-palette entry
show the last sync result. The sync itself — files, git, everything with side
effects — stays in the external watcher. That split is not modesty, it is the
sandbox: a 2.0 plugin runs in an iframe with no arbitrary-path filesystem and
no exec API (verified against the 2.0.1 app bundle: 145 `logseq.api.*`
functions, none of them shell or git), so the plugin physically cannot be the
monster, only the doorbell.

The two halves meet in the plugin's own storage directory
(`<dotdir>/storages/logseq-live-sync-vault/`) — the one disk location both can
reach. The plugin writes `geml-sync-dirty.json` there; the watcher, started
with `--signal`, reacts to it immediately (interval polling stays on as a
fallback) and writes `geml-sync-status.json` back for the plugin to display:

```sh
node bin/geml-sync.mjs my-graph ~/notes-geml --watch --git-commit \
  --signal ~/.logseq/storages/logseq-live-sync-vault/geml-sync-dirty.json
```

Build and load the plugin (dist/ is not checked in):

```sh
cd plugin && npm install && npm run build
```

Then in Logseq 2.0: Settings → Advanced → Developer mode, and
"Load unpacked plugin" pointing at `plugin/`.

Verified so far: the signaller logic and the whole watcher pipeline
(signal-triggered re-sync, status write-back) run under tests with a planted
fake CLI — no Logseq needed. What is NOT yet verified is the in-app half
loading in the real desktop app: the plugin runtime demonstrably ships in
2.0.1 (`lsplugin.core.js`, `hook:db:changed`, the `Load unpacked plugin`
string) and the SDK is `@logseq/libs` 0.3.x (`next` tag — `latest` still
points at the classic 0.0.17 line), but this machine cannot launch the GUI to
click through it. If you load it, the toolbar `⇄` button telling you about
`geml-sync-status.json` is the whole acceptance test.

## Run

The tests import the reference parser's build, which is not checked in — build
it once first:

```sh
cd ../../geml-parser && npm install && npm run build && cd ../integrations/logseq
npm install
npm test
```

The live stages need `@logseq/cli` installed somewhere. On Node 24 its
`better-sqlite3` has no prebuilt binding until 12.11.1, so pin an override
(without it, install tries to compile and node-gyp does not recognize
VS 2026 yet):

```sh
mkdir logseq-cli && cd logseq-cli && npm init -y
npm pkg set overrides.better-sqlite3=12.11.1
npm i @logseq/cli
```

Then point `LOGSEQ_CLI_DIR` at that directory:

```sh
node bin/create-graph.mjs my-graph      # create a DB graph WITHOUT the desktop app
node bin/live-roundtrip.mjs my-graph            # read-only: export → GEML → back → compare
node bin/live-roundtrip.mjs my-graph --edit     # + geml set → import-edn → logseq validate
```

The converter is two pure functions in `src/mapping.mjs` —
`ednToGemlFiles(ednText)` and `gemlFilesToEdn(files, lib)` — with the reference
parser injected, so nothing here depends on how it is packaged later (CLI
subcommand, Logseq plugin, or both).
