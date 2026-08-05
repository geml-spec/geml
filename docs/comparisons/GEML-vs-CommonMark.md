# GEML vs. CommonMark — a construct-by-construct comparison

*English | [中文](GEML-vs-CommonMark_CN.md)*

[CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/) is the reference point
for "what Markdown means". This page walks its constructs in spec order and
records what GEML does with each, then lists what GEML adds that CommonMark has
no equivalent for.

For a shorter matrix across Markdown, HTML, AsciiDoc and Org-mode, see
[COMPARISON.md](COMPARISON.md). This page is the deep one, and it is limited to
CommonMark.

**Every "GEML" cell was measured** against the reference parser rather than read
off the spec, because the interesting rows are the ones where a Markdown habit
silently produces something else. Constructs GEML does not implement are not
errors — they parse as ordinary text, which is exactly why they are worth
knowing.

**Legend** — ✅ same syntax and meaning · ⚠️ same syntax, different result ·
🔁 different syntax, same capability · ❌ not a construct in GEML (parses as text)

---

## 1. Preliminaries

| Topic | CommonMark | GEML | |
|---|---|---|---|
| Encoding | Deliberately unspecified — "This spec does not specify an encoding" | **MUST be UTF-8** (§0.1) | 🔁 |
| Why | Only ever rendered | `.gemlhistory` hashes document bytes, so encoding is load-bearing | |
| BOM | Not mentioned | One leading U+FEFF removed (§0.2) | 🔁 |
| Line endings | LF, CR, CRLF all recognized | Same three, normalized to LF before parsing (§0.3) | ✅ |
| Blank line | No chars, or only spaces/tabs | Same (§0.3) | ✅ |
| `U+0000` | Replaced with U+FFFD | Same (§0.4) | ✅ |
| Tabs | Elaborate: tab stops of 4, partial expansion when a tab straddles a boundary (§2.2, its own spec section) | **A tab counts as one column** for list indentation (§2.1) | ⚠️ |
| Backslash escapes | Any ASCII punctuation | Same (§5.1) | ✅ |
| Entity references | `&amp;` `&copy;` `&#35;` `&#x22;` all decoded | **Not decoded** — literal text | ❌ |
| Invalid input | No such thing: every byte sequence is a valid document | Documents can carry **`error` diagnostics** (Appendix A); a conforming document has none (§8.1) | 🔁 |

The last row is the deepest difference and shapes everything else: CommonMark
has no failure mode, so its 655 examples exist to pin what each input *means*.
GEML is build-checked — a dangling reference is an error with a stable code —
so its spec pins meaning *and* diagnostics.

---

## 2. Leaf blocks

| CommonMark construct | Example | GEML | |
|---|---|---|---|
| ATX heading | `# H1` … `###### H6` | Same, and it **auto-derives an `#id`** (`## My Section` → `#my-section`); an explicit id is `## Sec {#s}` | ✅ |
| Closing sequence | `## H2 ##` | The trailing `##` is **kept as text** ("H2 ##") | ⚠️ |
| Setext heading | `Title` / `=====` | Not a construct — stays a paragraph. Excluded so `=` belongs to fences alone (§1.6) | ❌ |
| Thematic break | `---` `***` `___` | Not a construct — stays a paragraph (§1.6) | ❌ |
| Indented code block | 4 spaces | Not a construct — stays a paragraph. Use `=== code` | ❌ |
| Fenced code block | ` ```js ` … ` ``` ` | **Becomes an inline code span**, not a block — see §6 | ⚠️ |
| " (tilde form) | `~~~js` … `~~~` | Stays a paragraph | ❌ |
| HTML block | `<div>…</div>` | Literal text. There is no raw-HTML escape hatch, by constraint (§1.5) | ❌ |
| Link reference definition | `[foo]: /url "t"` | Not a construct — stays a paragraph. | ❌ |
| Paragraph | any text run | Same | ✅ |
| **Typed block** | — | `=== type {attrs}` … `===` — the single primitive behind code, math, tables, diagrams, notes, metadata (§3) | 🔁 |

---

## 3. Container blocks

| CommonMark construct | Example | GEML | |
|---|---|---|---|
| Block quote | `> quoted` | Not a construct — stays a paragraph. A callout is `=== note` | 🔁 |
| Nested block quote | `> > deep` | Same — literal text | ❌ |
| Bullet list | `-` `*` `+` | `-` and `*` only; **`+` is not a marker** | ⚠️ |
| Ordered list | `1.` `1)` | `1.` only; **`1)` is not a marker** | ⚠️ |
| Start number | `5.` sets start | Same (§2.1) | ✅ |
| Tight vs. loose | Blank line between items ⇒ loose | Same (§2.1) | ✅ |
| Nesting | By indentation, with content-column rules | By indentation, **column count, tab = 1 column** | ⚠️ |
| Multi-paragraph item | Supported | **Not supported** — an item is one line; rich content goes in a typed block (§2.1) | ❌ |
| Task list item | GFM extension, not CommonMark | **Core syntax**: `- [ ]` / `- [x]` (§2.1) | 🔁 |

---

## 4. Inlines

| CommonMark construct | Example | GEML | |
|---|---|---|---|
| Code span | `` `code` `` | Same, same backtick-run rules | ✅ |
| Emphasis | `*em*` and `_em_` | **`*` only** — `_em_` is literal text (§5.3) | ⚠️ |
| Strong | `**st**` and `__st__` | **`**` only** — `__st__` is literal text | ⚠️ |
| Delimiter algorithm | Flanking runs + rule of three | **Identical algorithm**, restricted to `*` and `~~` (§5.3) | ✅ |
| Strikethrough | GFM extension, not CommonMark | **Core syntax**: `~~s~~` (a lone `~` is literal) | 🔁 |
| Inline link | `[t](/url)` | Same syntax. A **scheme-less** target is read as a *document* reference, not an href — see §6 | ⚠️ |
| Link title | `[t](/url "ti")` | The title is not a link title; options go in an attribute object: `[t](url){rel=nofollow}` | ⚠️ |
| Reference link | `[t][ref]` + `[ref]: /url` | Not a construct — literal text | ❌ |
| Image | `![alt](/img.png)` | Same, and generalized to **audio/video** by extension or `as=` (§5.1) | ✅ |
| Autolink | `<https://e.com>`, `<a@b.com>` | Not a construct — literal text. Write `[text](url)` | ❌ |
| Raw inline HTML | `a <b>bold</b> c` | Literal text (§1.5) | ❌ |
| Hard line break | Two trailing spaces, **or** `\` | **`\` only** — trailing spaces do nothing | ⚠️ |
| Soft line break | Newline inside a paragraph | Same | ✅ |
| Inline math | — | `$E=mc^2$`, verbatim body (§5.1) | 🔁 |

---

## 5. What GEML adds

No CommonMark equivalent — this is the reason the format exists.

| Capability | Syntax | Notes |
|---|---|---|
| **Typed blocks** | `=== code {lang=js}` … `===` | One primitive for code, math, tables, diagrams, callouts, metadata. Fence is a `=` run ≥ 3; a longer fence nests; `=== #id` closes by label when the body itself contains fences (§3) |
| **Block identity** | `{#budget}` | Unique per document — the primary key of the block (§4) |
| **Classes / parameters** | `{.warning caption="Annual cost"}` | Semantic classes and type-defined parameters (§4) |
| **Checked references** | `[t](#budget)`, `[[#budget]]`, `other.geml#budget` | Resolved **at build time**; a dangling one is an `error`, not a broken link discovered later (§5.2) |
| **Auto-reference** | `[[#budget]]` | Link text taken from the target's caption/heading |
| **Footnotes** | `[^f]` + `=== note {#f}` | Core, not an extension |
| **Document metadata** | `=== meta` with `key = value` | Replaces frontmatter |
| **Interpolation** | `{{key}}` | Substituted from `meta`; unknown key is an **error**; skipped inside code spans and math; `\{{key}}` escapes |
| **Computed tables** | `compute="FY = Q1+Q2+Q3+Q4"`, `summary="…sum(FY)…"` | Columns and a summary row computed at build time; formulas are acyclic by construction (§6) |
| **External table data** | `src=data.csv`, `src=#fy25`, `src=other.geml#fy25` | Three targets, one attribute; a local or cross-document one is existence-checked at build time, and `src` plus an inline body is an error — one source, always (§6) |
| **Custom delimiter** | `delim=";"` | Overrides the format's natural delimiter, so a European `;`-CSV or a `\|`-delimited export reads as it stands; a value longer than one character is an error (§6) |
| **Merged cells** | `span="r2c1:2x1"` | Declared, not drawn |
| **Verified data blocks** | `=== data {#limits format=json}` … `===` | JSON's value domain — scalars, sequences, maps — as data the build *parses*; a malformed body is an error naming the offending line. `format=jsonl` is the record-stream form: a complete `data` block appended at end-of-file is a valid continuation of any document (§3.2) |
| **Data from a plain file** | `=== data {#events format=jsonl src=events.jsonl}` | The records stay a `.jsonl` file every existing tool can append to and tail; the document is its verified, addressable, chartable view. `schema=` is reserved (§3.2) |
| **Source routes** | `=== code {lang=ts src=src/parser.ts#L14-24}` | The block *is* those lines of a real file, 1-based inclusive. A range the file no longer has is a build **error** (`bad-source-range`); a body kept alongside `src=` is a snapshot and warns when it has drifted (§3.3) |
| **Hosted diagrams** | `=== diagram {format=mermaid}` | Body passed verbatim to an external renderer; GEML defines no diagram language (§7) |
| **Data-bound charts** | `=== diagram {format=geml-chart data=#fy25 type=bar x=Segment y=FY}` | Chart declared entirely in attributes, so column names are build-checked against the target. `data=` takes a `table`, or a `data` block whose value is a record array (§7.1) |
| **Addressable prose** | `=== text {#intro}` | Gives a run of prose an id so it can be referenced and block-edited |
| **Block transclusion** | `=== embed {src=other.geml#id}` | Renders another document's block in place. `src=` is reference-checked and a transclusion cycle is an error; the named document is **parsed as a document in its own right**, so its metadata and relative paths resolve against *itself*, at every depth of the chain (§3) |
| **Inline projection** | `![[#intro]]`, `![[other.geml#intro]]` | The same idea inside a sentence. Only inline content qualifies — pointing it at block content is an error, and the `embed` block is the form for that (§5.1) |
| **Hidden content** | `{hidden}`, `%% line` | In the model and reference-checked, never rendered |
| **Diagnostics** | — | Stable codes with fixed severities (Appendix A) |
| **Versioning** | `.gemlhistory` sidecar | Block-level revert (`geml revert file #id`) |

---

## 6. Four things that will surprise a Markdown author

These are the rows where the same keystrokes produce a different document. All
four were measured, not inferred.

**1. A ` ``` ` fence is a code *span*, not a code block.**

````
```js
x = 1
```
````

parses to a paragraph containing one inline code span whose value is
`"js\nx = 1\n"` — the backtick run opens a code span, the newlines are inside
it, and the closing run ends it. Nothing errors, and the rendered output looks
roughly right, which is what makes it a trap. Use a typed block:

```
=== code {lang=js}
x = 1
===
```

**2. A scheme-less link target is a document reference.**

`[t](/url)` produces a link whose `doc` is `/url` — GEML tries to resolve it as
a cross-document reference and warns `unchecked-cross-document-reference`.
`[t](https://example.com)` produces an ordinary `href`. Only `http`, `https`,
`mailto` and `tel` are emitted as navigable targets at all (§9.5).

**3. `_underscores_` and `__double__` are literal.**

GEML runs CommonMark's exact delimiter-run algorithm but over `*` and `~~`
only. This is deliberate: `_` inside identifiers (`my_var_name`) is the single
most common accidental-emphasis bug in Markdown, and dropping it costs nothing
because `*` covers the same ground.

**4. Two trailing spaces are not a line break.**

Only `\` at end of line is. Invisible syntax that a trailing-whitespace trimmer
can silently delete has no place in a format meant to be diffed and
machine-edited.

---

## 7. Migrating

`geml notes.md` converts Markdown to GEML:

| Markdown | becomes |
|---|---|
| YAML frontmatter | `=== meta` |
| ` ```lang ` fenced code | `=== code {lang=…}` |
| ` ```mermaid ` / `graphviz` / … | `=== diagram {format=…}` |
| `$$ … $$` | `=== math` |
| `> blockquote` | `=== note` |
| GFM pipe table | `=== table` |
| `[^f]: text` footnote definition | `=== note {#f}` |
| `<https://e.com>` autolink | `[https://e.com](https://e.com)` |
| Setext heading | ATX heading |
| Thematic break | dropped (reported as a note) |

Converted blocks are **given ids automatically** (`#note-1`, `#code-1`,
`#table-1`, …), so the result is addressable and block-editable immediately.
Inline syntax passes through unchanged, since GEML's inline grammar is a
superset of the subset Markdown authors actually use.

`geml <file.geml> --to md` goes back, and is lossy by nature — Markdown has no
typed-block primitive — so every unmappable construct (`geml-chart`, `{hidden}`,
block ids) is reported rather than silently dropped.

---

## 8. Why the differences exist

CommonMark's job is to say what the Markdown people already write means, with
no failure mode. Its constraint is compatibility with a decade of existing
documents, which is why it carries setext headings, four ways to mark emphasis,
two list-marker families, and an HTML escape hatch.

GEML has no such legacy. Its constraints (§1) are that a file stays readable as
plain text, that every kind of structured content shares **one** primitive, that
references are checked at build time, and that nothing ties the document to a
rendering backend. Each removal above buys one of those: dropping setext and
thematic breaks frees `=` and `---` for fences and keeps them unambiguous;
dropping raw HTML keeps semantics backend-independent; dropping `_` emphasis and
trailing-space breaks removes two classes of silent misparse.

The result is a smaller surface that is stricter about what it does accept — and
that a second implementation can reproduce from the spec, which is the test
GEML sets for itself (§8.4).
