# GEML — General Expressive Markup Language

*English | [中文](GEML-spec_CN.md)*

## Specification (Stable)

| Field | Value |
|-------|-------|
| Working name | GEML (General Expressive Markup Language) |
| Version | 1.0 |
| Status | Stable |
| File extension | `.geml` |

---

## Abstract

GEML is a plain-text markup language for structured, expressive documents.
A GEML file remains fully legible as plain text, expresses every kind of
structured content (code, diagrams, tables, mathematics, callouts) through a
single typed-block primitive, supports stable identifiers with build-time
reference checking, and hosts external diagram DSLs without defining a diagram
language of its own. This document specifies the document model, the syntax of
blocks, attributes, inline content and references, and the requirements a
conforming processor must satisfy.

## Contents

0. [Preliminaries](#0-preliminaries)
1. [Constraints](#1-constraints)
2. [Document model](#2-document-model)
3. [Typed-block primitive](#3-typed-block-primitive)
4. [Attributes and identifiers](#4-attributes-and-identifiers)
5. [Inline content and links](#5-inline-content-and-links)
6. [Tables](#6-tables)
7. [Graphics](#7-graphics)
8. [Conformance](#8-conformance)
9. [Security and resource limits](#9-security-and-resource-limits)

[Appendix A: Diagnostic catalogue](#appendix-a-diagnostic-catalogue) ·
[Appendix B: Syntax inventory](#appendix-b-syntax-inventory-non-normative)

## Conventions

The key words **MUST**, **MUST NOT**, **MAY**, and **SHOULD** in this document
are to be interpreted as requirement levels: **MUST** and **MUST NOT** denote an
absolute requirement or prohibition, **SHOULD** denotes a recommendation, and
**MAY** denotes an optional, permitted behaviour. Throughout this document,
"§*n*" refers to the section bearing that number.

Text marked *non-normative* is explanatory and imposes no requirement. Examples
are non-normative unless they appear in the conformance suite (§8.4).

This English text is the **normative** version of the specification.
Translations (such as [中文](GEML-spec_CN.md)) are informative: where a
translation and this document disagree, this document governs.

---

## 0. Preliminaries

This section defines the character-level input to a GEML processor. Every rule
in §1–§9 is stated over the **normalized character stream** defined in §0.5.

### 0.1 Character encoding

A `.geml` file MUST be encoded in **UTF-8**. A processor MUST NOT attempt to
detect, or accept, any other encoding.

*Rationale (non-normative):* unlike a format that is only ever rendered, GEML
carries build-time identity — block ids, cross-document references, and the
SHA-256 content hashes of the `.gemlhistory` sidecar. Those are defined over
bytes, so a document that round-trips through a second encoding is a different
document, and its version history no longer verifies.

A processor MUST decode with UTF-8 replacement semantics: an ill-formed byte
sequence is decoded as U+FFFD REPLACEMENT CHARACTER. It MUST NOT fall back to
re-interpreting the input in another encoding.

A **character** is a Unicode code point. Code points that do not correspond to
a character in an intuitive sense (combining marks, for example) still count as
characters throughout this document.

### 0.2 Byte order mark

If the decoded input begins with U+FEFF, that single character MUST be removed
before parsing. Exactly one leading U+FEFF is removed; a second one, or a
U+FEFF anywhere else in the document, is ordinary content.

### 0.3 Lines and line endings

A **line ending** is a line feed (U+000A), a carriage return (U+000D) not
followed by a line feed, or a carriage return followed by a line feed.

A **line** is a sequence of zero or more characters other than U+000A and
U+000D, followed by a line ending or by the end of the input.

A **blank line** is a line containing no characters, or containing only spaces
(U+0020) and tabs (U+0009).

Every line ending MUST be normalized to a single U+000A before parsing. A
processor MUST NOT let the choice of line ending change the document model: the
same document written with CRLF and with LF MUST produce identical models.

*Note (non-normative):* the `.gemlhistory` sidecar records the file's dominant
line ending separately, so restoring a revision reproduces the original bytes.
Normalization governs *parsing*, not storage.

### 0.4 Insecure characters

U+0000 MUST be replaced with U+FFFD.

*Rationale (non-normative):* a NUL truncates the document for any downstream
consumer that handles it as a C string. A document MUST NOT be able to make one
tool in a pipeline see less content than the parser saw.

### 0.5 Normalized input

A processor MUST apply exactly the following, in order, before parsing:

1. decode as UTF-8, ill-formed sequences becoming U+FFFD (§0.1);
2. remove one leading U+FEFF (§0.2);
3. replace every line ending with U+000A (§0.3);
4. replace U+0000 with U+FFFD (§0.4).

The result is the **normalized character stream**. Each step rewrites
characters only *within* a line — none splits or joins one — so the line count
of the normalized stream equals that of the input. A processor MAY therefore
address the original bytes by line index, which is what makes block-level
editing (`geml get`/`set`) byte-faithful for the untouched part of a file.

### 0.6 Media type, extension and fragment identifiers

| | |
|---|---|
| File extension | `.geml` (version sidecar: `.gemlhistory`) |
| Media type | `text/geml` |
| Vendor-tree name | `text/vnd.geml` |
| `charset` parameter | `UTF-8` is the only permitted value, and SHOULD be omitted as redundant with §0.1 |
| Fragment identifier | a block `id` (§4) |

`text/geml` is not currently registered with IANA; `text/vnd.geml` is the
vendor-tree name to use where a registered type is required. A fragment
identifier on a `.geml` resource denotes the block bearing that `id`, matching
the reference syntax of §5.2 — `other.geml#budget` names the same block whether
it is written as a GEML reference or as a URL.

---

## 1. Constraints

This section states the design constraints that govern the rest of the
specification.

1. A `.geml` file MUST be fully readable as plain text without rendering.
2. Code, diagrams, tables, math and callouts MUST share the single typed-block
   primitive (§3); no per-content grammar.
3. Every block MAY carry a stable `id`; references MUST be resolved and
   validated at build time (§5).
4. Graphics MUST embed an external DSL; the format defines the hosting protocol
   only, never a diagram language (§7).
5. There is no raw-HTML escape hatch; semantics are not tied to any backend.
6. Headings use ATX `#` only. Setext headings and `---`/`===` thematic-break or
   frontmatter rules are not part of GEML.

---

## 2. Document model

A document is a sequence of **blocks**, in two shapes:

- **Unfenced blocks** — paragraphs, headings, and lists; their body is parsed as
  inline GEML.
- **Typed blocks** — fenced; their body handling is decided by the block *type*
  (raw or flow).

Every block MAY carry an **attribute object** `{#id .class key=val}`. Inline
content exists only inside unfenced blocks.

### 2.1 Lists

A **list** is a run of one or more **item lines**. An item line is leading
indentation, a **marker**, a single space, and the item's inline content (§5):

- an **unordered** marker is `-` or `*`;
- an **ordered** marker is one or more digits followed by `.`; the first item's
  number is the list's `start`.

An item's content is a single line. A list item MAY begin with a **task marker** —
`[ ]`, `[x]`, or `[X]` followed by a space — which is stripped and recorded as a
checked/unchecked state.

**Nesting is by indentation.** Indentation is a column count (a tab counts as one
column). An item indented *more* than the current item's marker opens a nested
list under that item; an item indented *less* closes back to an enclosing list. A
**blank line** between two sibling items makes the list **loose** (otherwise it is
**tight**); blank lines do not otherwise end a list. A list ends at the first line
that is neither blank nor an item line at or below its indentation.

Multi-paragraph list items are not part of GEML; rich item content belongs in a
typed block (§3).

---

## 3. Typed-block primitive

A typed block has the following form:

```
=== <type> <attrs>?
<body>
===
```

- The fence is a run of `=` (≥ 3). A block is closed by a run of `=` of exactly
  the opening length, OR — when the block has an `#id` — by a **labeled fence**
  `=== #id` (a `=` run of any length ≥ 3 followed by the block's id).
- Nesting works two ways: with **longer outer fences** (`====` wraps `===`), or,
  more robustly, by giving each block an `#id` and closing it with `=== #id`.
  The labeled close is *local* — it does not depend on counting `=` — and is
  RECOMMENDED when a block's body itself contains fence-like lines.
- The **type registry** declares each type's body mode: `raw` (verbatim, e.g.
  `code` with `lang=`, `diagram`/`table` with `format=`, `math`, `embed` with
  `src=`),
  `flow` (parsed, e.g. `note`, `text`), or `data` (one `key=val` per line, e.g.
  `meta`).
- An unknown type is a build warning; its body is preserved as raw.
- A `text` block is an **addressable prose container**: a flow body whose only
  purpose is to give a run of prose an `#id` and attributes, so it can be
  referenced, block-edited (`geml get`/`set`), and versioned. It renders as a
  neutral block — no callout chrome (a callout is `note`). Wrap only prose you
  actually need to address; plain paragraphs remain the default.
- An `embed` block stands for content that lives elsewhere: `src=` names a
  document, optionally with a fragment (`src=other.geml#budget`), and the block
  renders as that content in place. A fragment naming a heading selects the
  heading's whole section. `src=` is reference-checked like any other reference
  (§5), and the body of an `embed` block is ignored.

### 3.1 Grammar

The block structure is context-free and is given below. Inline **emphasis** is not
a context-free construct; it is resolved by the delimiter-run algorithm of §5.3,
not by this grammar.

```ebnf
document       = { block } ;
block          = unfenced-block | typed-block ;

typed-block    = fence , SP , type , [ SP , attrs ] , NL , body , close-fence ;
fence          = "===" , { "=" } ;            (* open: N equals signs, N >= 3 *)
close-fence    = fence ;                      (* exactly equal to the opening length *)
type           = NAME ;
body           = { LINE } ;                    (* raw, flow or data per the registry *)

unfenced-block = heading | list | paragraph ;
heading        = "#" , { "#" } , SP , text , [ SP , attrs ] , NL ;
paragraph      = text-line , { text-line } ;

list           = item , { item | blank-line } ;
item           = indent , marker , SP , [ task ] , text , NL ;
marker         = "-" | "*" | DIGIT , { DIGIT } , "." ;
task           = "[" , ( " " | "x" | "X" ) , "]" , SP ;
indent         = { " " | TAB } ;              (* nesting depth, by column *)

attrs          = "{" , { attr-item , [ SP ] } , "}" ;
attr-item      = id-attr | class-attr | kv-attr ;
id-attr        = "#" , NAME ;
class-attr     = "." , NAME ;
kv-attr        = NAME , "=" , value ;
value          = bare-word | quoted-string ;

NAME           = NAME-CHAR , { NAME-CHAR } ;
NAME-CHAR      = LETTER | DIGIT | "-" | "_" ;  (* LETTER: any Unicode letter *)
```

A NAME is not restricted to ASCII, and needs no leading letter: the id a heading
derives from its own text (§4) may begin with a digit or `-`, and non-Latin
scripts are ordinary NAME characters.

---

## 4. Attributes and identifiers

- `{#budget}` sets block id `budget`. Ids MUST be unique per document.
- `{.warning}` adds a semantic class (no styling implied).
- `{caption="Annual cost"}` and other `key=val` pairs are type-defined
  parameters.
- A heading auto-derives an id from its text; an explicit id is written as a
  trailing attribute object on the heading line, e.g. `## Title {#sec}`. The
  derivation is **normative**: a reference (`[[#id]]`, `other.geml#id`, a URL
  fragment) has to name the same block in every implementation, so the id a
  heading yields cannot be left to one. From the heading's text — taken **after**
  `{{key}}` interpolation, so the substituted text is what is slugged — a
  processor MUST, in this order:
  1. lower-case it;
  2. delete every code span, its backticks and its content alike — so the
     punctuation inside `` `foo()` `` cannot leak into the id;
  3. delete every character that is neither a Unicode letter, a digit,
     whitespace, nor `-` (an underscore is therefore dropped: `_` is legal in an
     explicit id but never survives a derivation);
  4. trim leading and trailing whitespace;
  5. replace each run of whitespace with a single `-`.

  So `## Use \`foo()\` in 2024 设计` derives `#use-in-2024-设计`. Two headings
  that derive the SAME id do not make the document invalid — only the first is
  addressable by it, and a later one that needs an address MUST declare an
  explicit `{#id}`. A heading whose text carries no letter and no digit derives
  an empty id; address such a heading by giving it an explicit `{#id}`.
- Style note (non-normative): keep the document title in `=== meta`
  (`title = "…"`), not in a top-level heading — every heading then denotes a
  genuine section of the document.
- Attribute value typing: a quoted `"…"` is always a string; `true`/`false` is a
  boolean; a bare word matching integer/float syntax is a number; any other bare
  word is a string. Arrays, dates and nested tables are not supported.
- A bare attribute word with no `=` is a boolean flag set to `true` (e.g.
  `hidden`).
- A `=== meta` block holds document metadata as one `key=val` per line, using
  the value typing above. In flow text, `{{key}}` is replaced with the matching
  `meta` value; an unknown key is a build **error**. Interpolation reads the
  flow source text and honors the verbatim atoms of §5.3 phase 1(1): a
  `{{key}}` inside a code span or inline math is left untouched (so a GEML
  document can quote this very syntax), raw block bodies are never
  interpolated, and a backslash-escaped `\{{key}}` renders as the literal text
  `{{key}}`.
- The `hidden` flag marks a block (or a `%%` line) as part of the document and
  fully reference-checked, but **not rendered** — e.g. a source table that only
  feeds a chart. A `%%` line is a hidden, raw, never-rendered note.
- Attribute order is insignificant; the recommended order is `#id`, then
  `.class`, then `key=val`.

---

## 5. Inline content and links

### 5.1 Inline elements

Inline elements appear only inside unfenced blocks.

| Syntax | Meaning |
|--------|---------|
| `*emphasis*` | emphasis |
| `**strong**` | strong |
| `` `code` `` | code span (verbatim; nothing parsed inside) |
| `~~strike~~` | strikethrough |
| `$…$` | inline math (verbatim body) |
| `![alt](src){…}` | in-place media embed (image/audio/video) |
| `\` at line end | hard line break |
| `\` + ASCII punctuation | escape: the punctuation is literal |

- Emphasis/strong delimiters MUST attach to a non-space character and MUST NOT
  span block boundaries.
- Block-level math uses the `=== math` typed block (§3).
- An embed `![…]` renders/plays its source in place (never navigates), while a
  link `[…]` navigates. `as ∈ {image, audio, video}`, inferred from the source
  extension when omitted.
- A list item MAY begin with a **task marker** — `[ ]` (open) or `[x]`/`[X]`
  (done) followed by a space. The marker is stripped from the item text and
  recorded as a checked/unchecked state; the remaining text is parsed as inline.

### 5.2 Links and references

Internal and cross-document references are validated at build time.

| Form | Meaning |
|------|---------|
| `[text](https://…)` | external link |
| `[text](#budget)` | internal ref to block `budget`, explicit text |
| `[[#budget]]` | auto-ref: link text taken from target's caption/heading |
| `[[other.geml#budget]]` | the same, across documents: the block in that document |
| `[text](other.geml#budget)` | cross-document ref |
| `[^note]` | footnote: renders the block with id `note` as a footnote |

- External link options go in the attribute object:
  `[text](url){rel=nofollow target=_blank}`.
- An unresolved `#id`, `other.geml#id`, or `[^id]` is a build **error**.
- A footnote target MAY be written as a **footnote definition** `[^id]: text` on
  its own line (Markdown-style): it records a note block with that id, so the
  matching `[^id]` reference resolves.
- *Note (non-normative):* backlinks and graph views are a derived inverted index
  over resolved references; GEML adds no syntax for them.

### 5.3 Recognition order and emphasis

Inline parsing of an unfenced block runs in two phases and assigns exactly one
parse to every input.

**Phase 1 — atoms** (left to right, in this priority):

1. Backslash escapes (`\` + ASCII punctuation → that literal character; `\` at
   line end → hard break), code spans, and inline math; their contents are not
   parsed further.
2. Images, links, auto-refs (`[[#id]]`), and footnote refs (`[^id]`); a link or
   ref MUST NOT nest inside another link or ref.

Text between atoms is literal. An **escaped** delimiter character is a literal atom
and is therefore not eligible for emphasis.

**Phase 2 — emphasis** runs over each maximal run of literal text *between*
phase-1 atoms; emphasis never spans an atom or a block boundary. Emphasis, strong,
and strikethrough are resolved by **delimiter-run flanking**:

- A **delimiter run** is a maximal run of `*`, or a maximal run of two or more `~`
  (a single `~` is literal).
- Taking the characters immediately before and after a run (the start and end of
  the text run count as whitespace), a run is **left-flanking** if it is not
  followed by whitespace and either is not followed by ASCII punctuation or is
  preceded by whitespace or punctuation; **right-flanking** is the mirror. A run
  MAY **open** when left-flanking and MAY **close** when right-flanking.
- Pair runs in one left-to-right scan: each closing run matches the nearest
  preceding opening run of the same character. When a run can both open and close,
  a pairing whose two run lengths sum to a multiple of three is rejected unless
  both lengths are multiples of three (the **rule of three**).
- A matched `*` pair is **emphasis** (one delimiter per side) or **strong** (two
  per side, when both runs have two or more); a matched `~~` pair is
  **strikethrough** (two per side). Any delimiter left unpaired is literal.

*This is the CommonMark emphasis algorithm restricted to GEML's delimiters: `*`
and `~~`, with no `_` emphasis.*

---

## 6. Tables

Block type `table` accepts two interchangeable bodies, parsed to one model.

**(a) Visual form**

```
=== table {#budget caption="Annual cost"}
| Plan  | Months | Rate |
|-------|-------:|-----:|
| Basic |      1 |   30 |
| Pro   |      2 |   30 |
===
```

**(b) Data form** — with computed columns and a summary row:

```
=== table {#fy25 caption="FY2025 revenue by segment ($M)" format=csv header=1
           compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4;
                    YoY [%.1f%%] = (FY - PriorFY) * 100 / PriorFY"
           summary="Segment = 'Total';
                    Q1 = sum(Q1); Q2 = sum(Q2); Q3 = sum(Q3); Q4 = sum(Q4);
                    PriorFY = sum(PriorFY); FY = sum(FY);
                    YoY [%.1f%%] = (sum(FY) - sum(PriorFY)) * 100 / sum(PriorFY)"}
Segment,   Q1,    Q2,    Q3,    Q4,    PriorFY
Cloud,     124.5, 131.2, 142.8, 158.3, 470.0
Hardware,  88.1,  84.6,  90.3,  95.7,  372.0
Services,  45.2,  47.8,  49.1,  52.6,  168.0
===
```

*The `{…}` attribute object is one physical line; it is wrapped above only for
readability — per §3.1, GEML attributes do not span lines.* The example resolves
to:

| Segment | Q1 | Q2 | Q3 | Q4 | PriorFY | FY | YoY |
|---------|----:|----:|----:|----:|--------:|------:|-----:|
| Cloud | 124.5 | 131.2 | 142.8 | 158.3 | 470.0 | 556.8 | 18.5% |
| Hardware | 88.1 | 84.6 | 90.3 | 95.7 | 372.0 | 358.7 | -3.6% |
| Services | 45.2 | 47.8 | 49.1 | 52.6 | 168.0 | 194.7 | 15.9% |
| **Total** | **257.8** | **263.6** | **282.2** | **306.6** | **1010** | **1110.2** | **9.9%** |

- **Data from elsewhere** — instead of an inline body, a table MAY name where its
  data comes from. `src=` and `data=` are the same attribute in two spellings, and
  carrying both is an error. Three target forms resolve by one rule: a data file
  with `format=csv`/`tsv` (a path relative to the document, or an `http(s)` URL);
  `#id`, naming a table block in this document; or `doc.geml#id`, naming one in
  another document. A local-path or cross-document target MUST be resolved and
  existence-checked at build time — an unresolvable one is an error, and a target
  that exists but is not a table is an error. Only the `src`/`data` text — never
  the resolved contents — enters the `.gemlhistory` hash. A table MUST NOT carry
  both `src` and an inline body (an error). Because the data arrives at render
  time, the column names used by `compute` and by a referencing `geml-chart` are
  validated then, not at build time. Inlining stays the default; `src` is an
  explicit choice.
- Merged cells are declared, not drawn: `span="r2c1:2x1"`.
- **Computed columns** — `compute` lists one or more `Name = expr` formulas
  separated by `;`. Each `expr` is evaluated once per data row over `+ - * / ( )`
  and unary `-` (with `*`/`/` binding tighter than `+`/`-`, left-associative),
  operating on numeric cells. Columns are referenced by header name — quoting
  names with spaces in single quotes, e.g. `'Unit Price'` — or by spreadsheet
  letter (`A`, `B`, …). A formula MAY reference an earlier computed column (above,
  `YoY` references `FY`); references MUST be acyclic. Computed columns are appended
  after the data columns in formula order and are NOT written in the body.
- **Summary row** — `summary` defines a single row at the foot of the table, as
  `Cell = value` entries separated by `;`, the left side naming the target
  column. Each `value` is either a string/number literal used as a label
  (`Segment = 'Total'`) or an expression combining the aggregates `sum, avg, min,
  max, count` — each applied to one column — with `+ - * / ( )` and literals
  (`(sum(FY) - sum(PriorFY)) * 100 / sum(PriorFY)`). Aggregates fold a column
  over the data rows and are the only construct that crosses rows; every column
  reference in a summary expression MUST be reduced by an aggregate (a bare
  column name has no value in the summary row). Unspecified columns are blank.
- **Display format** — a computed column or summary cell MAY carry a `[printf]`
  format bound to its name on the left: `FY [%.1f]`, `YoY [%.1f%%]` (`%%` is a
  literal percent). The format is numeric and affects display only, not the
  stored value. There is no date/time format: cell values are string, number, or
  boolean (§4); dates are written as plain ISO-8601 text.
- **Excluded by design**, to keep tables a document feature rather than a
  spreadsheet engine: single-cell and range addressing (`@3$4`, `@2$1..@4$3`),
  relative-row references (`@-1`), conditionals, cross-table `remote()`
  references, lookup/VLOOKUP, and any embedded program (no Lisp, no JS).

---

## 7. Graphics

Block type `diagram` hosts an external diagram DSL.

```
=== diagram {#flow format=mermaid caption="Review flow"}
graph LR
  A[Draft] --> B{Review}
  B -->|ok|   C[Publish]
  B -->|back| A
===
```

- `format` selects a pluggable renderer (`mermaid`, `graphviz`, `d2`,
  `plantuml`, …).
- Body is `raw` and passed verbatim to that renderer.
- A processor MUST expose the renderer registry and MUST NOT interpret the body.
  An unknown `format` is a warning; body is preserved.
- `#flow` makes the diagram referenceable: `see [[#flow]]`.

### 7.1 Data-bound charts

A `diagram` MAY declare a data source with `data=#id`. The processor MUST
resolve the reference (a dangling id, or a target that is not a `table`, is a
build **error**) and supply the referenced table's model — computed columns
included — to the renderer. The processor still does NOT interpret the body.

The built-in `geml-chart` renderer draws a table as a chart. `format` still only
selects the renderer; the chart is described entirely in **attributes**, so the
processor validates it (the body stays empty — a non-empty body is a warning):

```
=== diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY caption="FY revenue"}
===
```

- `type` — `bar | line | area | pie | scatter`. It only changes how the channels
  are drawn; it never adds new attributes.
- Encoding channels (a closed set): `x` (category), `y` (value; a comma list is
  multiple series), `series` (group by a column), `size` (scatter bubble).
  Required: `x`, `y`. A channel a type does not use is a warning.
- `rows` — `data` (default, summary row excluded), `all` (data + the summary row
  as one extra point), or `summary` (only the summary row).
- Column names, the `data` id, and `rows` are validated against the table:
  a typo'd column or a dangling id is a build error.
- Charts that need more (annotations, reference lines, heatmaps, …) use a hosted
  DSL instead: `=== diagram {format=vega-lite data=#fy25}` with the spec in the
  body. The body is raw and NOT column-checked.

---

## 8. Conformance

This specification defines three conformance classes. A product claims each one
separately: a validator that never renders is a conforming **parser** without
being a conforming **renderer**, and is not thereby non-conforming.

### 8.1 Conforming document

A **conforming GEML document** is a normalized character stream (§0.5) that a
conforming parser processes without emitting any diagnostic of severity
`error` (Appendix A).

Warnings do not make a document non-conforming: they mark constructs a
processor could not fully interpret but MUST preserve — an unknown block type,
an unknown diagram format, an unchecked cross-document reference.

Every input is nonetheless *parseable*: §2.1, §3, §5.3 and §6 assign exactly one
document model to any character stream. There is no input a conforming parser
may reject, refuse to model, or fail on — a non-conforming document still
produces a model, alongside the errors that describe it.

### 8.2 Conforming parser

A conforming parser MUST:

1. Normalize its input exactly as §0.5 requires.
2. Parse the typed-block primitive (§3) and the attribute object (§4).
3. Build a document model in which every block id is unique and resolvable.
4. Resolve inline emphasis (§5.3) and list nesting (§2.1) so that every input has
   exactly one parse.
5. Emit an **error** on any unresolved internal or cross-document reference (§5).
6. Treat an unknown block `type` and an unknown diagram `format` as
   **warnings**, never errors, preserving the body verbatim.
7. Report every diagnostic with the **code and severity** Appendix A assigns it.
8. Observe the resource limits of §9.2, degrading to a diagnostic rather than
   failing.
9. NOT require any specific editor, and NOT depend on raw HTML.

### 8.3 Conforming renderer

A renderer is OPTIONAL: a conforming parser need not produce output in any
presentation format. A renderer that does MUST:

1. Present the document model a conforming parser produced, without
   reinterpreting the body of a `raw` block (§3).
2. NOT execute a `code` block, and NOT interpret a `diagram` body (§7) other
   than by handing it to the registered external renderer (§9.1).
3. Uphold the sink requirements of §9.5 for document-controlled text.
4. Omit blocks marked `hidden` (§4) from its output while keeping them in the
   model.

### 8.4 The conformance suite

A **conformance suite** accompanies the spec: input `.geml` paired with a
normalized projection of the expected document model. The suite is the normative
reference for the rules this document states algorithmically — inline emphasis
(§5.3), list nesting (§2.1), atom precedence, and metadata interpolation (§4). A
second, independent implementation conforms when it reproduces every case. In the
reference repository it lives under
[`geml-parser/test/conformance/`](https://github.com/geml-spec/geml/tree/main/geml-parser/test/conformance).

### 8.5 Versioning

The specification is versioned independently of any implementation. This
document is **GEML 1.0**; the reference implementation's package version tracks
its own release cadence and is not a specification version.

An implementation states conformance as "conforms to GEML 1.0". A processor
encountering a construct it does not know MUST degrade as §8.2(6) requires —
that is the format's forward-compatibility mechanism, and it is why adding a
block type or a diagram format is not a breaking change.

The **type registry** (§3) is open. A type name that is not defined by this
specification and not registered SHOULD contain a hyphen (for example
`acme-invoice`), reserving unhyphenated names for future versions of this
specification. Diagram `format` names follow the same convention.

---

## 9. Security and resource limits

A GEML document is frequently machine-generated and frequently untrusted: it
may arrive from a model, a pipeline, or a pull request. This section states what
a processor MUST guarantee when the document is hostile. It applies to every
conformance class of §8.

### 9.1 Documents are data, never code

A processor MUST NOT execute or evaluate any part of a document:

- a `code` block's body is stored text; it MUST NOT be run (§3);
- a `diagram` body MUST be passed verbatim to the external renderer selected by
  `format` and MUST NOT be interpreted by the processor (§7);
- there is no raw-HTML escape hatch (§1.5) and no expression language beyond the
  closed arithmetic of §6 — which has no conditionals, no lookups, no
  cross-table references, and no embedded program by construction.

### 9.2 Resource limits

A processor MUST bound the depth to which it will recurse over a document, for
each of: typed-block nesting (§3), list nesting (§2.1), and inline nesting
(§5). On reaching a bound it MUST emit the corresponding
`*-nesting-too-deep` error (Appendix A) and continue processing the remaining
input. It MUST NOT overflow its call stack, abort, or fail to produce a model.

The bounds are implementation-defined; a processor SHOULD admit at least 64
levels of each, which is far past any document written to be read. *The
reference implementation admits 256 levels of block and list nesting and 100 of
inline nesting.*

A processor MUST NOT construct a regular expression, a shell command, or any
other executable form from document-controlled text without escaping that text
for the target grammar. *Block ids, class names and attribute values are all
document-controlled; a `.geml` file is an untrusted input in the same sense a
`.zip` is.*

### 9.3 References, cycles and termination

Reference resolution MUST terminate on every input, including one crafted to
make it loop:

- **Internal references** cannot loop: ids are unique per document (§4), so
  resolving `#id` is a lookup, not a traversal.
- **Cross-document references** are resolved exactly one level deep. A
  processor collects the target document's ids *without* resolving that
  document's own references, so two documents that reference each other
  terminate.
- **Computed columns** (§6) are evaluated in declaration order, and a formula
  sees only data columns and *earlier* computed columns. A self-reference or a
  forward reference is therefore not a cycle but an unknown column, reported as
  `compute-error`. GEML tables need no cycle detector: the evaluation order
  makes the dependency graph acyclic by construction.

### 9.4 Cross-document resolution and external data

Resolving a cross-document reference (§5.2) reads a file named by the document.
A processor MUST confine that resolution to an explicitly configured root
directory, MUST resolve every symbolic link before deciding whether a target is
inside the root, and MUST refuse a target that escapes it. Resolution MUST
**fail closed**: a processor that cannot establish a confinement root resolves
nothing and reports `unresolvable-document`, rather than falling back to an
unconfined lookup.

A media `src` (§5.1), and a table source naming an `http(s)` URL (§6), are
fetched at **render time** by the renderer and are never read by the parser. A renderer MUST treat such a
source as untrusted input. Where documents may come from untrusted authors, a
renderer SHOULD confine `src` to the document's own origin or directory and
SHOULD require an explicit opt-in before performing `http(s)` fetches: a fetched
URL discloses the reader's address, and the fact and time of reading, to whoever
controls it.

Because external data is fetched at render time, its contents never enter the
`.gemlhistory` hash — only the `src` text does (§6).

### 9.5 Sink requirements

A destination in a link or an embed (§5.1, §5.2) that names a URL scheme other
than `http`, `https`, `mailto` or `tel` MUST NOT be emitted as a navigable or
loadable target. A processor MUST apply this check **when building the model**,
not at the rendering sink, so that every consumer of the model inherits it. The
check MUST ignore leading and embedded characters in the range U+0000–U+0020
when determining the scheme, because user agents strip them before acting on a
URL — `java&#9;script:` is `javascript:`.

A renderer emitting a markup format MUST escape document-controlled text for
the position it occupies — element text, attribute value, or URL — and MUST
reduce `.class` tokens (§4) to the target format's identifier character set
rather than escaping them alone.

---

## Appendix A: Diagnostic catalogue

Every diagnostic a conforming parser emits carries a **code** in addition to a
human-readable message. The message is prose: it MAY be reworded, translated, or
given more context between releases. The **code and the severity are the
contract** — they are what a conformance test, an editor integration, or a CI
gate matches on, and a processor MUST report the code and severity this appendix
assigns.

A processor MUST NOT invent a code outside this catalogue for a condition the
catalogue covers. A processor MAY emit additional diagnostics for conditions
this specification does not define; such a code SHOULD contain a hyphenated
vendor prefix (`acme-…`) so that a future version of this catalogue cannot
collide with it.

The line number a diagnostic carries is 1-based and refers to the normalized
character stream (§0.5) — which, per §0.5, is also the line number in the
original file.

### A.1 Block structure (§3)

| Code | Severity | Condition |
|------|----------|-----------|
| `unterminated-block` | error | A typed block's fence is never closed by an equal-length `=` run, nor by its labeled fence `=== #id`. The body is kept, running to the end of the enclosing content. |
| `unknown-block-type` | warning | The block `type` is not in the registry. Its body is preserved verbatim as `raw` (§8.2(6)). |
| `block-nesting-too-deep` | error | Typed-block nesting exceeded the processor's bound (§9.2). The body at that depth is kept as `raw` rather than scanned further. |
| `list-nesting-too-deep` | error | List nesting exceeded the processor's bound (§9.2). |
| `inline-nesting-too-deep` | error | Inline nesting exceeded the processor's bound (§9.2). The over-deep run degrades to text with emphasis only. |

### A.2 Identifiers, references and metadata (§4, §5)

| Code | Severity | Condition |
|------|----------|-----------|
| `duplicate-id` | error | Two blocks in one document declare the same `id`. Ids MUST be unique per document (§4). |
| `unresolved-reference` | error | An internal reference `[…](#id)` or `[[#id]]`, or a chart `data=#id`, names an id no block declares. |
| `unresolved-footnote` | error | A footnote reference `[^id]` names an id no block and no footnote definition declares. |
| `unresolved-cross-document-reference` | error | A reference `other.geml#id` resolved to a document that declares no such id. |
| `unresolvable-document` | error | The document named by a cross-document reference could not be read, or lies outside the confinement root (§9.4). |
| `unchecked-cross-document-reference` | warning | A cross-document reference was found, but the processor was given no document resolver, so its target could not be verified. |
| `embed-missing-src` | error | An `embed` block carries no `src=`, so it names no content. |
| `ignored-embed-body` | warning | An `embed` block has a body. The content it stands for lives in `src=`; the body is ignored. |
| `transclusion-cycle` | error | A chain of block transclusions returns to a document already being expanded. The chain is reported and expansion stops; it is never followed. |
| `embed-target-not-geml` | error | An `embed` block names a target that is not a `.geml` document. Its bytes are never parsed as GEML. |
| `media-target-is-document` | error | A media embed `![](…)` points at a GEML document. Block content cannot be expanded in inline position; the `embed` block is the form for it. |
| `inline-transclusion-not-inline` | error | An inline projection `![[…]]` names a target that is not inline content — not a single-paragraph `text` block. Block content cannot be expanded inside a sentence; the `embed` block is the form for it. |
| `unsafe-embed-scheme` | error | An `embed` block names a URL scheme outside the allowlist of §9.5. The attribute is blanked in the model as well as reported, so no consumer can emit it. |
| `source-attr-conflict` | error | A block carries both `src=` and `data=`. They name the same thing; exactly one must be given. |
| `unresolvable-table-source` | error | A table's `src=`/`data=` names a data file that cannot be resolved. |
| `table-source-not-a-table` | error | A table's `src=`/`data=` names a block that exists but is not a table. |
| `unknown-metadata-reference` | error | A `{{key}}` interpolation names a key no `=== meta` block defines (§4). |

### A.3 Tables (§6)

| Code | Severity | Condition |
|------|----------|-----------|
| `table-src-and-body` | error | A table carries both `src=` and an inline body. Exactly one is permitted (§6). |
| `unknown-table-format` | warning | The `format=` value is not a recognized data format; the body is parsed as a visual pipe grid instead. |
| `bad-compute-formula` | error | A `compute` entry is not of the form `Name = expr`. |
| `unlexable-compute-formula` | error | A `compute` expression contains a character or token the §6 expression grammar does not define. |
| `compute-error` | error | A `compute` expression failed to evaluate — most often because it names a column that does not exist, or one computed later (§9.3). |
| `bad-summary-entry` | error | A `summary` entry is not of the form `Cell = value`. |
| `summary-unknown-column` | error | A `summary` entry's left-hand side names no column of the table. |
| `unlexable-summary-expression` | error | A `summary` expression contains a token the §6 expression grammar does not define. |
| `summary-error` | error | A `summary` expression failed to evaluate — including a column reference not reduced by an aggregate, which has no value in the summary row (§6). |
| `bad-span` | error | A `span=` declaration is not of the form `rNcM:RxC`. |
| `span-outside-table` | warning | A `span=` declaration targets a cell beyond the table's bounds; it is ignored. |

### A.4 Diagrams and charts (§7)

| Code | Severity | Condition |
|------|----------|-----------|
| `unknown-diagram-format` | warning | No renderer is registered for the diagram's `format`. The body is preserved verbatim (§8.2(6)). |
| `ignored-diagram-body` | warning | A diagram whose configuration lives entirely in attributes (`geml-chart`, `geml-code-graph`) was given a non-empty body, which is ignored. |
| `code-graph-missing-src` | warning | A `geml-code-graph` diagram declares no `src=`, so there is nothing to render. |
| `code-graph-unresolvable-document` | warning | A `geml-code-graph` diagram's `src=` could not be resolved. |
| `chart-missing-data` | error | A `geml-chart` declares no `data=#id`. |
| `chart-data-not-a-table` | error | A `geml-chart`'s `data=#id` resolves to a block that is not a `table`. |
| `chart-missing-type` | error | A `geml-chart` declares no `type`. |
| `chart-unknown-type` | error | A `geml-chart`'s `type` is outside the closed set `bar \| line \| area \| pie \| scatter` (§7.1). |
| `chart-unknown-rows-scope` | error | A `geml-chart`'s `rows` is outside `data \| all \| summary`. |
| `chart-missing-channel` | error | A required encoding channel (`x` or `y`) is absent. |
| `chart-empty-channel` | error | The `y` channel is present but lists no columns. |
| `chart-unknown-column` | error | An encoding channel names a column the referenced table does not have. |
| `chart-unused-channel` | warning | A channel is present that this chart `type` does not draw; it is ignored (§7.1). |
| `chart-missing-summary-row` | error | `rows=summary` was requested, but the table defines no summary row. |
| `chart-summary-row-unavailable` | warning | `rows=all` was requested, but the table defines no summary row; the data rows are charted alone. |
| `chart-non-numeric-value` | error | A cell in a value column holds a non-empty, non-numeric value. (An *empty* numeric cell is not an error: that row contributes no data point.) |

---

## Appendix B: Syntax inventory (non-normative)

This appendix is a complete index of the language's syntactic constructs,
organized by the **position** each construct may occupy. It defines nothing:
every row cites the section that does. A change that adds, removes, or moves a
construct updates this inventory in the same change — an entry missing here is
a documentation bug, never a hidden feature.

GEML has three syntactic positions:

- **Block position** — the document level: a document is a sequence of blocks
  (§2).
- **Inline position** — inside the flow content of unfenced blocks and
  flow-mode block bodies (§2, §5).
- **Attribute position** — inside a block's attribute object `{…}` (§4), where
  certain keys carry references to other blocks, documents, or external data.

### B.1 Block position

| Construct | Shape | Body | Defined in |
|-----------|-------|------|------------|
| Paragraph | unfenced | inline | §2, §3.1 |
| Heading `#`…`######` | unfenced | inline | §1(6), §3.1, §4 |
| List — `-`/`*`, `1.`; task marker `[ ]`/`[x]` | unfenced | inline items | §2.1 |
| `=== code` | typed | raw | §3 |
| `=== math` | typed | raw | §3 |
| `=== table` | typed | raw: pipe grid or `format=` data | §6 |
| `=== diagram` | typed | raw: external DSL | §7 |
| `=== embed` | typed | raw (body unused); `src=` names the content | §3, §6 |
| `=== note` | typed | flow | §3 |
| `=== text` | typed | flow | §3 |
| `=== meta` | typed | data | §3, §4 |
| Footnote definition `[^id]: text` | line | inline | §5.2 |
| `%%` comment line | line | raw, never rendered | §4 |

*Shape* is one of: **unfenced** (§2), **typed** (fenced, §3), and **line** — a
single-line construct recognized during block parsing.

### B.2 Inline position

| Construct | Family | Defined in |
|-----------|--------|------------|
| `*emphasis*` · `**strong**` · `~~strike~~` | decoration | §5.1, §5.3 |
| `` `code` `` | verbatim atom | §5.1 |
| `$math$` | verbatim atom | §5.1 |
| `[text](url)` · `[text](#id)` · `[text](doc.geml#id)` | navigation | §5.2 |
| `[[#id]]` · `[[doc.geml#id]]` | navigation, automatic link text | §5.2 |
| `[^id]` | footnote reference | §5.2 |
| `![alt](src)` | projection: media | §5.1 |
| `{{key}}` | projection: metadata scalar | §4 |
| `\` at line end · `\` + punctuation | hard break · escape | §5.1 |

### B.3 Attribute position

Four attribute keys carry references; all of them are validated (Appendix A):

| Key | Host block | Target | Defined in |
|-----|------------|--------|------------|
| `src=` / `data=` | `table` | where the data comes from, in three forms: a data file (`csv`/`tsv`, document-relative path or `http(s)` URL), `#id` naming a table block in this document, or `doc.geml#id` naming one in another. The two spellings are synonyms; carrying both is an error. | §6 |
| `data=` | `diagram` (`geml-chart`) | a `table` block: `#id` in this document, or `doc.geml#id` in another (not a data file) | §7.1 |
| `src=` | `embed` | the content the block stands for: a document, optionally with a fragment | §3 |
| `src=` | `diagram` (`geml-code-graph`) | a GEML document | §7 |

The remaining attribute machinery — `#id`, `.class`, typed `key=val` values,
and the `hidden` flag — is defined in §4.

### B.4 Concept × position matrix

Most concepts are single-position by nature; three exist in both inline and
block form, and two more are definition↔use pairs across the two positions.

| Concept | Inline position | Block position |
|---------|-----------------|----------------|
| Prose | text run | paragraph |
| Code | `` `code` `` | `=== code` |
| Math | `$…$` | `=== math` |
| Projection — render a target in place | `![alt](src)` (media), `![[#id]]` (content) | `=== embed {src=…}` |
| Navigation — a link the reader follows | `[t](…)`, `[[#id]]`, `[^id]` | — |
| Spatial content | — | heading, list, `table`, `diagram`, `note`, `text` |
| Hidden content, comments | — | `hidden` flag, `%%` line |
| Metadata | `{{key}}` (use) | `=== meta` (definition) |
| Footnote | `[^id]` (use) | `[^id]: text` (definition) |

*Note (non-normative).* Read by rows, the matrix separates two reference
families. **Navigation** renders a link the reader follows (`[t](…)`,
`[[#id]]`); **projection** renders the referenced target itself in place. GEML
projects at three granularities today: a scalar (`{{key}}`, from `=== meta`), a
media object (`![alt](src)`), and a table's data model (a chart's `data=#id`).
A footnote reference is a hybrid: a navigational marker whose target is also
projected at the document's foot.

`!` is the projection prefix throughout: `![](src)` projects media, `![[#id]]`
projects content. The line between the two content projections is *value* versus
*content*. `{{key}}` substitutes a metadata **scalar** — no markup, no context
rules. `![[#id]]` projects the target's **inlines**, formatting intact and under
the full context rules of §3: the target document's own metadata, and its own
references. With `=== embed` for a block or a section, the three granularities are
a scalar, a phrase, and a block.
