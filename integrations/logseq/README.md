# Sync Vault with GEML

Your Logseq DB graph as **continuously synced plain-text files** — pages and
journals back in readable files and folders, the way OG vaults felt, kept in
step with the database. And, when you want it, back again.

![How it works](docs/how-it-works.svg)

Edit a block; seconds later the file on disk has caught up, and the toolbar says
so. Two settings, and only the first usually needs touching.

![The toolbar reports the last sync](docs/screenshot-toolbar.png)
![The plugin's settings](docs/screenshot-settings.png)

## Two directions, and only one of them is a round trip

```
Logseq 2.x DB graph  ⇄  .logseq-sync-vault-with-geml/*.geml    two-way, LOSSLESS
                     →  pages/*.md  journals/*.md              one-way, LOSSY
```

The GEML tree is the source of truth: `restore` and `--two-way` read only it,
and `npm test` proves EDN → GEML → EDN is a structural identity. The Markdown
tree is a **copy for reading** — Logseq's own file-version dialect, so the
folder opens in the file version of the app, but typed properties, tags, tables
and data blocks have no OG shape and do not survive it. An edit to a `.md` file
never reaches the graph, and the sync refuses to overwrite one rather than
pretending otherwise.

That gap is the whole reason this exists. Logseq ships both ends of it —
`logseq export` gives Markdown (readable, lossy), `logseq export-edn` gives EDN
(lossless, not something a person edits). GEML is the point between: as
readable as the one, as lossless as the other, and **addressable**, so a tool
can edit one block instead of round-tripping the graph.

## What you get

- 📦 **A plain-text copy that stays yours** — every page a readable file in a folder you chose
- 🔁 **Continuous, not one-shot** — edit in Logseq, seconds later the file has caught up; with `--two-way`, the reverse too
- ↩️ **A way back** — `logseq-sync restore` imports the vault into a graph, merging by block uuid
- 🌿 **Git if you want it** — point the vault at a repository and every sync is a clean commit; point it at a plain folder and nothing git-shaped appears

Pages you delete in Logseq are **kept** on disk and reported — a plain folder
has no history to recover them from. `--mirror` asks for an exact copy instead.

## Setup

**1. Install the plugin** — from the marketplace, or the zip from the
[latest release](https://github.com/geml-spec/logseq-plugin-sync-vault-with-geml/releases/latest)
(it carries the built plugin; nothing to compile).

**2. Set the vault folder** — Settings → Plugins → *Sync Vault with GEML* →
**Vault folder**. Any folder: `~/logseq-vault`, a directory in a repository you
already keep, one your backup tool watches. Created if missing. There is
deliberately no default.

**3. Run the watcher:**

```sh
npx @geml/logseq-sync
```

That is the setup. With no arguments it works out the rest — the CLI inside the
Logseq app, the graph the app has open, the plugin's signal file, the vault path
you just set — makes the vault a git repository if it is not one, syncs, and
keeps watching. `logseq-sync --help` lists the flags; the ones you are likely to
want are `--two-way`, `--once`, `--mirror`, `--no-markdown` and `--graph`.

**Not sure it is wired up?** `npx @geml/logseq-sync doctor` prints what it found
and what is missing, and exits non-zero when the setup cannot sync.

## The vault

The GEML tree is laid out the way an OG vault is; Logseq's file-graph indexer
walks past the dot directory, so the Markdown at the top is what it sees.

```
<vault>/
  pages/<name>.md  journals/2025_02_20.md    OG Markdown. Opens in Logseq
                                             (file version). Lossy, one-way.
  .logseq-sync-vault-with-geml/              The source of truth.
      ontology.geml            :properties/:classes as `data {format=edn}`
      graph.geml               page ORDER, an addressable data block
      journals/2025_02_20.geml journal pages, OG date names
      pages/<name>.geml        one per page:
                                 block title  → `=== text` body
                                 block uuid   → `{#uuid}`  ← geml get/set address
                                 outline tree → flat blocks with `.level-N`
                                 everything else → `data {format=edn}`
      .geml-manifest.json      what this tool last wrote, so a stranger's edit
                               is distinguishable from its own echo
```

## Editing the vault from outside

The vault is ordinary text, and that is the point: agents, scripts and plain
`sed` all work on it, and none of them needs to know Logseq exists. With
`--two-way` running, an edit imports on the next cycle; without it, run
`logseq-sync restore` when you are ready.

**An agent** gets addressed, validated block edits from the
[`geml` MCP server](https://github.com/geml-spec/geml) — `geml mcp --root
<your-vault-dir> --no-history`. The flag matters: git is this vault's history,
and without it every write also saves a `.gemlhistory` sidecar.

**One block**, by its address — every block carries its uuid:

```sh
geml find "that phrase" …/.logseq-sync-vault-with-geml        # → pages/foo.geml  #<uuid>
printf 'new text' | geml set …/pages/foo.geml '#<uuid>' --in - -o <same-file>
```

**One property** is an address too. They ride in a `data` block named after the
block they belong to, so a coordinate reaches one value and changes only it:

```
=== text {#1111… .level-1}
ship the sync plugin
===
=== data {#meta-1111… .block-meta format=edn}
{:build/keep-uuid? true
 :build/properties {:user.property/status "doing"
                    :user.property/tags #{"infra" "logseq"}}}
===
```

```sh
printf 'done' | geml set …/pages/foo.geml \
  '#meta-<uuid>[":build/properties"][":user.property/status"]' --in - -o <same-file>
```

A page's own properties are `#page-meta`, the graph's definitions `#properties`
in `ontology.geml`. Needs `@geml/geml` 1.10.2 or newer.

**In bulk** it is whatever your shell already does — the result is re-imported
by uuid, so identity survives the edit. `geml check <file> --root <vault>` after
one is cheap insurance: it names a mangled block, and a reference that now goes
nowhere, before the import carries either into the graph.

## Going back: `logseq-sync restore`

```sh
logseq-sync restore                 # rehearse: says what it would import, writes nothing
logseq-sync restore --yes           # take a Logseq backup, then import the vault
```

The vault imports by block uuid, so an edit lands in place rather than
duplicating. This is the one direction that writes into your notes, so it
rehearses unless you pass `--yes`, and `--yes` takes the app's own graph backup
first.

## Honesty corner

- **Restore merges, it does not replace.** An import lands by uuid over whatever
  the graph currently holds; it will not remove pages the vault no longer has.
- **Files the sync did not write are never touched** — not deleted, not
  overwritten. A manifest records what it wrote; anything else belongs to
  whoever put it there, so it is held and named. `--overwrite-unmanaged` is how
  you say you meant it.
- **A running Logseq holds `db.sqlite` exclusively**, so continuous sync goes
  through the desktop app's own CLI, which asks the running app instead of
  opening the file.
- **A conflict is held, not resolved.** With `--two-way`, a file changed on both
  sides since the last sync is left exactly as you wrote it and named in the
  status. Deletions are never imported.
- **The in-app half is verified against the 2.0.1 runtime**, the watcher half
  end-to-end in CI with no Logseq installed. If something misbehaves in your
  setup, an issue with your Logseq version is gold.

Versioning: MAJOR tracks the Logseq major this speaks to — 2.x means Logseq 2.x
DB graphs, and nothing older.

MIT © GEML contributors
