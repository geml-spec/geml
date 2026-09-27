# Writing to a Markdown file with `geml set`

`geml set` and `geml add` edit one block of a `.md` in place. Nothing is
converted: the file stays the Markdown it was, and a reader who does not have
`geml` sees no trace of it.

Everything below was measured against real documents, not read off the help
text. Two of the rules are **silent** when broken — no error, exit code 0 — and
they are the reason to read this before the first write rather than after.

## What holds

**A write is surgical.** After `geml set <file> '#id' --body --in -`, the YAML
frontmatter and every block other than `#id` are byte-for-byte what they were.
The verb splices; it does not re-serialize the file.

**The body lands verbatim.** Whatever you write goes in as typed — a
`> [!tip]` callout, a `[[wikilink]]`, a `` ```dataview `` fence, a table. No
escaping, no reflowing, no normalization of your Markdown to anyone else's
taste.

**A broken result is refused.** The file is re-parsed before the write lands;
if the result would not parse, nothing is written.

**Heading addresses are stable.** `## Entities` is `#entities` on every run and
every platform, and it survives anything happening above it. That is the whole
reason to address a file this way instead of by line number.

## The five that bite

### 1. Never `set` the frontmatter block — it destroys the frontmatter

Frontmatter is not a typed block in Markdown; it is an anonymous prose block,
and its **closing `---` is part of that block's body**. Replace the body and the
closer is gone, leaving an opener with nothing to close it — no properties at
all, for every tool that reads them.

Change frontmatter with an ordinary editor. This is silent: exit code 0.

### 2. `--body` is for a heading. On a prose block it APPENDS

A heading's block is a heading line plus a body. A prose block is body all the
way down, so it has no separate body to set — `get '#x' --body` on one comes
back empty, and `set --body` writes into that emptiness, which lands **after**
the prose already there. Nothing is removed.

| target | `set '#id'` | `set '#id' --body` |
|---|---|---|
| a heading block | refused: *content is prose, not a block — use --body* | replaces the section body, keeps the heading line |
| a prose block | replaces it | **appends to it, silently** |

The rule is the opposite of what one habit would give you, and picking wrong
fails loudly one way and quietly the other. `geml list` prints the kind in its
second column — read it before choosing. This is the other silent one.

### 3. A `[[name#anchor]]` link is a GEML reference, and is checked

`[[file#id]]` is GEML's own cross-document reference syntax, resolved when a
write lands. A wiki-style `[[Note#Heading]]` has the same shape, and there is
usually no document called `Note` — only `Note.md` — so the reference does not
resolve and **the write is refused**. Plain `[[Note]]`, `[[Note|alias]]` and
`![[image.png]]` are fine, and `[[Note.md#Heading]]` passes.

Refused, note — not mangled. Nothing is written.

### 4. Repeated heading text makes the whole file unwritable

Two `## Added` headings derive the same id. The guard judges the **result** of a
write, and the result still carries the collision, so the write is refused —
including one in a section nowhere near it, and the message names the collision
rather than your edit. A Keep-a-Changelog file cannot be edited this way at all.

```sh
geml check <file>          # exit 0 = writable
```

### 5. `--in <file>` is not "read this text"

`--in F` means *take block `#id` from file F*. Raw text goes in on **stdin**:

```sh
printf '…' | geml set page.md '#id' --body --in -      # right
geml set page.md '#id' --body --in fragment.txt        # looks for #id INSIDE fragment.txt
```

## Smaller things worth knowing

- `find` is a **literal substring**, not a pattern. `Hot.Cache` does not match
  "Hot Cache". Case-insensitive unless `--case`.
- `find --head` shows **one line per block**. A block with thirteen matches
  reports one; `find` locates, `get` reads.
- `set --body` replaces a trailing `---` rule too, if the section ends with one.
- The blank line after a heading is not re-inserted. Cosmetic; renderers do not
  care, a diff does.
- A directory walk skips hidden directories. A tree that hides sources in
  `.raw/` must name that directory: `geml find 'x' notes .raw`.
- `@…` addresses are content hashes and change when the content does. Fine to
  read from a fresh `list`; never store one, and never write to one.

## Do not convert the file

`geml <page>.md --to geml` and back is lossy for anything beyond plain
Markdown — frontmatter lists collapse, `[[…]]` comes back escaped, thematic
breaks are dropped. The point of addressing a Markdown file is that it **stays
Markdown**.
