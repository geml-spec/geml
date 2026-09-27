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

One exception, and it is GitHub's too: **a repeated heading is numbered by
position.** The second `## Added` is `#added-1`, the third `#added-2` — the same
anchors GitHub gives them — so a Keep-a-Changelog file is writable section by
section. But a new `## Added` inserted above one shifts it: `#added-1` becomes
`#added-2`. Take a repeated heading's address from a fresh `geml list`, never
from memory.

**The file is read as Markdown, not as GEML.** Where the two disagree, a `.md`
gets Markdown's reading:

- `[[Note]]`, `[[Note#Heading]]`, `[[Note#Heading|alias]]`, `[[Note#^block]]`
  and `![[Note#Heading]]` are Obsidian links. The note is found by name
  anywhere under the resolution root, `.md` implied; one that does not exist
  yet is a **warning**, never a refusal — a vault plans notes that way.
  Within the page, `[[#Heading Text]]` may name a heading by its text.
- `[^label]` is a GFM footnote. With a `[^label]:` line it is a footnote;
  without one it is plain text — so `[^0-9]` in a sentence about a regex is
  nothing to worry about.
- `{{title}}` is text: a template engine's placeholder, not a reference.
- `~~~` fences and indented code blocks are code, like ``` ones. Nothing inside
  is a link, a heading or a footnote.

The resolution root is the file's own directory unless you pass `--root`. A
note in a subfolder that links across its vault needs `--root <vault>`, and
`geml check` says so when it sees the vault's `.obsidian/` above you. It never
looks above the root on its own.

## The three that bite

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

### 3. `--in <file>` is not "read this text"

`--in F` means *take block `#id` from file F*. Raw text goes in on **stdin**:

```sh
printf '…' | geml set page.md '#id' --body --in -      # right
geml set page.md '#id' --body --in fragment.txt        # looks for #id INSIDE fragment.txt
```

Loud, at least: when F has no such block the refusal names the stdin form.

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

Before a first write to a page, `geml check <file>` — exit 0 means every block is
writable; warnings (a note not yet written) never block one.

## Do not convert the file

`geml <page>.md --to geml` and back is lossy for anything beyond plain
Markdown — frontmatter lists collapse, `[[…]]` comes back escaped, thematic
breaks are dropped. The point of addressing a Markdown file is that it **stays
Markdown**.
