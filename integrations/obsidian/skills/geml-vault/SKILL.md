---
name: geml-vault
description: >-
  Work a Markdown knowledge base — an Obsidian vault, a wiki, a docs tree — by
  BLOCK ADDRESS instead of by whole page. Use when the job is to find which page
  and which section says something, read that one section, add a line to an
  index or a log, or rewrite one section of a note: `geml find` answers with
  `file#address`, `geml get` hands back that block alone, and `geml set` /
  `geml add` change it in place while every other block, and the YAML
  frontmatter, stay byte-for-byte identical. Wikilinks, callouts and embeds are
  written through verbatim, so the file stays the Markdown Obsidian renders. No
  Obsidian process, no REST API, no plugin required. Triggers on: wiki, vault,
  knowledge base, second brain, ingest a source, update the index, append to the
  log, find which note says, edit one section of a note.
---

# A Markdown vault, addressed by block

The pages stay Markdown. Nothing is converted. What changes is how you reach
into them: an **address** (`#entities`) instead of a line number, and a write
that touches one block instead of rewriting a file.

This buys three things `grep` + `Read` + `Edit` cannot give you:

1. **An address survives edits.** A line number stops being true the moment
   anything above it changes. `#entities` does not.
2. **A write needs nothing read first.** No whole page pulled into context to
   build an `old_string` that has to match exactly.
3. **It works offline.** No Obsidian running, no Local REST API, no API key.

## Read: locate, then take one block

```sh
geml find '<literal text>' <dir> --head   # → file ⇥ #address ⇥ the matching line
geml get  <file> '#address' --body        # → that block, nothing else
geml list <file>                          # → every address in one page
```

`find` walks a directory for `*.geml` and `*.md`. It skips **hidden
directories** — a vault that hides sources in `.raw/` must name that directory
explicitly.

Read a whole page only when `list` shows it is short enough that taking one
block saves nothing. Most notes are; index, log and cache pages are not, and
those are where this skill earns its place.

## Write: change one block

```sh
geml list <file>                          # ALWAYS first — addresses AND the kind column
geml set  <file> '#heading' --body --in - # a HEADING: --body replaces the section body
geml set  <file> '#prose-addr' --in -     # a PROSE block: NO --body, or it appends
geml add  <file> --after '#id' --in -     # insert a new block after one
geml add  <file> --append   --in -        # append to the end (log pages)
```

`--body` and the block's kind must agree. On a heading it means "the section
below the heading line"; a prose block has no body of its own, so `--body`
writes *after* the prose instead of over it — silently, exit 0. `geml list`
prints the kind in its second column, which is why it comes first.

A write is re-parsed before it lands: a change that would break the document is
**refused**, and nothing is written.

What you get back, verified by `test/vault.test.mjs`:

- frontmatter and every block you did not address are **byte-for-byte
  unchanged**;
- `> [!tip]` callouts, `[[wikilinks]]`, `![[embeds]]` and ```` ```dataview ````
  blocks are written **verbatim, unescaped** — the page still renders in
  Obsidian.

## The rules that keep this safe

Read `references/invariants.md` before the first write in a session. The six
that bite hardest:

1. **Never `set` the frontmatter block.** Its closing `---` lives inside the
   block body; replacing the body deletes it and the page loses every property.
   Frontmatter is read-only through this skill.
2. **Never write to an `@hash` address.** `@…` is a content hash and changes the
   moment the content does. Writes address `#id` only.
3. **`--body` on a prose block appends instead of replacing.** Match the flag to
   the kind `geml list` reports: `--body` for a heading, no `--body` for prose.
   The wrong way round is refused on a heading and silent on prose.
4. **Never `Write` a page that already exists.** Use `set` / `add`. `Write` is
   for a page you are creating.
5. **A block holding `[[Note#Heading]]` cannot be written.** `[[file#id]]` is
   GEML's own reference syntax and is checked on write; there is no document
   called `Note`, only `Note.md`, so the write is refused. `[[Note]]`,
   `[[Note|alias]]` and `![[image.png]]` are all fine, and `[[Note.md#Heading]]`
   is the spelling that passes — Obsidian follows it too.
6. **A page with two identically-titled headings cannot be written** — the
   derived ids collide, and the guard judges the result, so a write to any
   section of that page is refused. Check with `geml check <file>` first.

Rules 5 and 6 are refusals — nothing is written, and the error says so. Rules 1,
2 and 3 are silent, which is why they have to be rules rather than error
messages you would see.

## Using this with an existing vault convention

`references/claude-obsidian.md` maps this onto the `claude-obsidian` plugin's
vault: its directory layout, the stable addresses in its `index.md`, which of
its skills' steps to replace, and the one file that must never be edited with a
tool.

Any other vault works the same way; the reference is an example, not a
requirement.

## Block history, when you want it

Off unless asked for. `geml history save <page>` snapshots a page and
`geml revert <page> '#id'` rolls back one block. The cost is one
`<page>.md.gemlhistory` sidecar per edited page, inside a directory that Obsidian
syncs and git tracks.

If the vault is already in git — most are, and `claude-obsidian` commits it on a
hook — this is a second, partial history of the same thing. Leave it off.

## The link graph

`scripts/vault-graph.mjs` reports orphans and dead wikilinks, each dead link
carrying the **block address** that holds it — so the fix is a `geml set` on
that address, not a hunt through the page.

```sh
node integrations/obsidian/scripts/vault-graph.mjs <vault-dir> [more-dirs…]
```
