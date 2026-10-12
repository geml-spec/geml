# logseq-any-sync

Keep an [Anytype](https://anytype.io) space and a folder of plain-text GEML pages in step, both ways.

Anytype carries the sync between your devices, your phone and the people you share a space with,
end-to-end encrypted. This bridge gives that space a face on disk: one `.geml` file per object, every
block addressable by its id, every page with a `.gemlhistory` beside it that records each edit and
merges. An agent or an editor changes one block with `geml set page.geml '#id'`; the bridge sends
exactly that block to Anytype.

> **Status.** Not published. Every test runs against a stand-in for the Anytype local API built from
> its specification; a run against a real Anytype desktop app has not been done yet, and it is the
> step that confirms the parts of the API this was written against without seeing (see *Limits*).

## What you need

- The Anytype **desktop** app, running. The bridge talks to the local API it serves; the mobile apps
  sync through Anytype as usual and reach the vault through the desktop.
- An API key paired in the desktop app, in the environment as `ANYTYPE_API_KEY`. It is sent only to
  that local API.
- The id of the space to mirror.
- Node 22 or later.

## Run it

```sh
export ANYTYPE_API_KEY=…            # paired in the desktop app
logseq-any-sync doctor --space <space-id>
logseq-any-sync ~/notes --space <space-id>
```

`doctor` checks that the API answers, the key works and the space lists. The second command keeps
watching (every 2 seconds; `--interval` changes it); `--once` runs one cycle and exits.

| Flag | |
|---|---|
| `--space <id>` | the space (or `ANYTYPE_SPACE`) |
| `--once` | one cycle, then exit |
| `--interval <s>` | seconds between cycles |
| `--dry-run` | print the operations it would send; write and send nothing |
| `--markdown <dir>` | also write the pages to `<dir>` as Markdown, one way |
| `--no-git-commit` | never commit (by default it commits when the vault is a git repository) |
| `--api <url>` | the local API (default `http://127.0.0.1:31009`, or `ANYTYPE_API_URL`) |

`GEML_AUTHOR` names who the vault's edits are recorded as (default `vault`).

## What a page looks like

```geml
=== data {#object .object format=json}
{"id":"bafyreie…","type":"Page","properties":{"Name":"Project Phoenix"}}
===

# Project Phoenix

## Goals {#65f0a1…}

=== text {#65f0a2…}
Ship the **new export** by Q3.
===

=== text {#65f0a3… .level-2}
- Validate in CI
===

=== text {#65f0a4…}
- [x] Draft spec
===
```

- The `#object` block is the object's id, type and properties. The `#` heading under it is only for
  reading; renaming the object is done in Anytype.
- Every Anytype block is one GEML block carrying its id. Headings are one level down (`#` is the
  title); nesting is `.level-N`.
- Paragraphs, lists, checkboxes, headings, code, maths, mermaid and graphviz diagrams, callouts,
  quotes and toggles are written as GEML. A field GEML has no place for rides on a `%% anytype:`
  comment line inside the block; a block with no GEML shape at all (a divider, a bookmark, a link to an
  object, a table, a dataview…) is kept verbatim as `=== data {#id .anyblock format=json}`.
- A block the vault adds needs no id; Anytype gives it one and the next cycle writes it in. A block you
  named yourself keeps your name: the bridge remembers which Anytype id it is.
- GEML Anytype has no shape for — a chart, a view, a form — travels to Anytype as a code block whose
  language is `geml`, and comes back as itself.

## How edits meet

Each cycle, for every object that changed on either side:

1. edits in the vault are saved into the page's `.gemlhistory`;
2. what Anytype holds is recorded there too, as a change by `anytype`;
3. the two are merged block by block, and the merged page is written;
4. what changed is sent to Anytype as operations on those blocks; if Anytype changed again meanwhile,
   the cycle reads it again and merges again;
5. the ids Anytype gave new blocks are read back.

Edits to different blocks both survive. Where both sides changed the same block, the later edit wins on
both sides and the cycle reports the other one, which stays in the history:
`geml history get pages/x.geml <id>` shows it. The rules are the
[geml-history profile](../../spec/profiles/geml-history/geml-history-profile.md)'s.

## What it will not do

- **Send a page that does not parse.** It is held and named until it does.
- **Delete an object because its page was deleted.** That is reported; restore the file, or remove its
  entry from `.geml-sync.json` to stop syncing it.
- **Overwrite a page edited while it was syncing.** That page waits for the next cycle.
- **Change an object without a backup.** Before each push, what Anytype held is saved under
  `.geml-backup/<object>/`.
- **Run twice on one space.** Run one bridge per space; use Anytype itself, not git, to get the space
  onto another machine — two bridges would create a new block twice.

## Files and images

An image or file block's bytes are downloaded into `assets/` when they are 20 MB or less, and the page
links to the local copy; a larger file stays in Anytype and the page links to it there. A paragraph that
is only `![alt](path/to/local.png)` is uploaded and becomes an image block.

## The vault

```
notes/                         a git repository, if you like
  space.geml                   which page is which object
  pages/project-phoenix.geml
  pages/project-phoenix.gemlhistory
  assets/                      downloaded images and files
  .geml-sync.json              this machine's sync state (git-ignored)
  .geml-backup/                what Anytype held before each push (git-ignored)
```

## Markdown for Logseq

`--markdown <dir>` writes every page the cycle changed to `<dir>` as Markdown, so the file version of
Logseq — or any Markdown tool — can open them. It is one way: edits there are not read back, and data
blocks and comment fields do not survive the conversion.

## Limits

- The Anytype local API v2 is shipped but its document is marked draft. Three things here follow that
  document without having been seen on a real app: the list rows asking for `last_modified_date`
  (without it every cycle reads every object — `doctor` says which), the multipart upload, and the
  created-object response. The live run checks them.
- Anytype does not publish its own change history, so each read of an object is recorded as one change;
  the history is coarser than Anytype's.
- Tables are kept as data blocks, not GEML tables.
- Anytype's inline tags (`<mention>`, `<u>`, `<font>`) stay as literal text in the page.

## Tests

```sh
npm test
```

Runs the mapping (both AnyBlock conformance documents round-trip exactly), the block diff, the engine end
to end and the CLI, against `test/fake-anytype.mjs`.
