# What holds, and what bites

Every line below was measured against the reference parser on a real vault, not
inferred from the help text. The tests in `integrations/obsidian/test/` pin the
ones that matter, including the destructive ones — a negative test is how a
footgun stays documented after everyone who found it has moved on.

## What holds

**A write is surgical**, given the right form for the block's kind (see 3). After `geml set <page> '#id' --body --in -`, the YAML
frontmatter and every block other than `#id` are byte-for-byte what they were.
The verb splices; it does not re-serialize the page.

**Obsidian syntax is written through verbatim.** A body containing
`> [!tip] Title`, `[[Note Name]]`, `![[image.png|300]]` or a ```` ```dataview ````
fence lands as typed, unescaped. (This is true of the **write** path only. See
"Do not convert the vault" below for what the `--to md` *writer* does.)

**`add` is clean.** `--after '#id'` and `--append` both keep frontmatter and
neighbours intact and get the blank lines right.

**A broken result is refused.** The document is re-parsed before the write
lands. Nothing is written if it would not parse.

**Heading addresses are stable and meaningful.** `## Entities` is `#entities`
on every run, on every platform. It survives anything happening above it.

## What bites

### 1. `set` on the frontmatter block destroys the frontmatter

Frontmatter is not a typed block in Markdown mode — it is an anonymous prose
block, and its **closing `---` is part of the block body**. Replace the body and
the closer is gone, leaving an unterminated opener: Obsidian shows no
properties, Dataview sees nothing, and every `related:` graph edge dies.

```
  # before                  # after `set --body` with three key: value lines
  ---                       ---
  type: meta                type: meta
  tags:                     title: "Wiki Index"
    - meta                  updated: 2026-09-16
  ---
                            # Wiki Index          ← no closing ---, no frontmatter
  # Wiki Index
```

**Frontmatter is read-only through this skill.** Change it with an editor, a
templating tool, or Obsidian itself.

### 2. `@hash` addresses are not stable

An anonymous block's address is a hash of its content. Edit the block and the
address changes (`@07bb2b3b` → `@e9c420e9`). Fine to *read* from a fresh
`list`; never store one, never write to one. **Writes take `#id` only.**

### 3. `--body` is for a heading. On a prose block it appends instead of replacing

A heading's block is a heading line plus a body; a prose block is body all the
way down, so it has no separate body to set — `get '#x' --body` on one comes
back empty. `set --body` then writes into that emptiness, which lands **after**
the prose already there. Nothing is removed and the exit code is 0.

| target | `set '#id'` | `set '#id' --body` |
|---|---|---|
| a heading block (`## Entities`) | refused: *content is prose, not a block — use --body* | replaces the section body, keeps the heading line |
| a prose block (`#intro-before-entities`) | replaces it | **appends to it, silently** |

So the rule is the opposite of what one habit would give you, and picking wrong
fails loudly one way and quietly the other. `geml list` names the kind in its
second column — read it before choosing.

### 4. A repeated heading is numbered by position

A `.md` is read as Markdown, so two `## Added` headings take GitHub's anchors:
the first is `#added`, the second `#added-1`, the third `#added-2`. Every section
is writable — a Keep-a-Changelog file with nineteen `### Added` headings edits
like any other page.

The cost is GitHub's too: the number is a **position**. Insert another
`## Added` above `#added-1` and it becomes `#added-2`. So for a repeated heading
take the address from a fresh `geml list` right before the write, never from an
earlier one.

An explicit `{#id}` is never renumbered, and two identical explicit ids are
still an error.

### 5. Wikilinks resolve by note name — within the root, and no further

Every shape a vault writes goes in verbatim and resolves the way Obsidian
resolves it — the note by name, `.md` implied, in any folder under the
resolution root:

| written into a block | `geml set` / `geml check` |
|---|---|
| `[[Alpha]]`, `[[Alpha\|alias]]`, `![[cover.png]]` | fine |
| `[[Alpha#Heading]]`, `[[Alpha#Heading\|alias]]`, `![[Alpha#Heading]]` | fine — the heading is Obsidian's to resolve |
| `[[Alpha#^block-id]]`, `[[Alpha.md#Heading]]` | fine |
| `[[#Heading Text]]`, `[[#^block-id]]` on the same page | checked: the heading or the `^block-id` marker must be there |
| `[[Not Written Yet]]` | a **warning**, never a refusal — a vault plans notes this way |

The resolution root is the page's own folder unless `--root` names another. A
note linking across its vault from a subfolder therefore warns about every link
into a sibling folder until it is checked with `--root <vault>`; `geml check`
names the vault when it sees `.obsidian/` above. It never searches above the
root on its own — what a page may probe is the user's to widen.

### 6. `--in <file>` is not "read this text"

`--in F` means *take block `#id` from file F*; `--in F#src` means *take block
`#src` from F*. Raw text goes in on **stdin**:

```sh
printf '…' | geml set page.md '#id' --body --in -      # right
geml set page.md '#id' --body --in fragment.txt        # wrong: looks for #id INSIDE fragment.txt
```

### 7. `find` is a literal substring, not a pattern

`Hot.Cache` does not match "Hot Cache". Case-insensitive unless `--case`. There
is no regex.

### 8. `find --head` shows one line per block

A block containing thirteen wikilinks reports one. `find` **locates**; to get
everything in a block, `get` it.

### 9. `set --body` swallows a trailing `---` rule

A thematic break sitting between a section and the next heading belongs to the
first section's body. Replacing that body removes the rule. Put it back in the
replacement if the page uses them as dividers.

### 10. The blank line after a heading is eaten

`set` leaves the new body flush against the heading line. Obsidian renders it
the same; a diff shows it. Cosmetic.

### 11. Hidden directories are not walked

`find <dir>` skips anything starting with `.` (and `node_modules`). A vault that
hides its sources in `.raw/` — as `claude-obsidian` does, deliberately, to keep
them out of Obsidian's file explorer and graph — must name that directory:

```sh
geml find 'needle' wiki .raw --head
```

## Do not convert the vault

`geml <page>.md --to geml` and back is **lossy for Obsidian-flavoured
Markdown**, measured:

| | |
|---|---|
| `tags: [a, b]`, `related: ["[[x]]"]` | → `tags=""`, `related=""` — **data loss**; `=== meta` is flat key=value and holds no YAML lists |
| `[[wikilink]]` | → `\[\[wikilink\]\]` on the way back to Markdown |
| `> [!tip]` | → `=== note` → an escaped blockquote |
| `![[embed]]` | → escaped |
| `---` rules, heading ids | → dropped |

Obsidian's graph, backlinks, Bases/Dataview, canvas and mobile app read `.md`
and nothing else. The point of this skill is that **the vault stays Markdown**.
