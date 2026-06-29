# GEML — General Expressive Markup Language

*English | [中文](GEML-spec_CN.md)*

## Mini Specification (Draft)

| Field | Value |
|-------|-------|
| Working name | GEML (General Expressive Markup Language) |
| Version | 1.0-draft |
| Status | Draft |
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

1. [Constraints](#1-constraints)
2. [Document model](#2-document-model)
3. [Typed-block primitive](#3-typed-block-primitive)
4. [Attributes and identifiers](#4-attributes-and-identifiers)
5. [Inline content and links](#5-inline-content-and-links)
6. [Tables](#6-tables)
7. [Graphics](#7-graphics)
8. [Conformance](#8-conformance)

## Conventions

The key words **MUST**, **MUST NOT**, **MAY**, and **SHOULD** in this document
are to be interpreted as requirement levels: **MUST** and **MUST NOT** denote an
absolute requirement or prohibition, **SHOULD** denotes a recommendation, and
**MAY** denotes an optional, permitted behaviour. Throughout this document,
"§*n*" refers to the section bearing that number.

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

- **Flow blocks** — paragraphs, headings, and lists; their body is parsed as
  inline GEML.
- **Typed blocks** — fenced; their body handling is decided by the block *type*
  (raw or flow).

Every block MAY carry an **attribute object** `{#id .class key=val}`. Inline
content exists only inside flow blocks.

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
  `code` with `lang=`, `diagram`/`table` with `format=`, `math`, `output`),
  `flow` (parsed, e.g. `note`, `aside`), or `data` (one `key=val` per line, e.g.
  `meta`).
- An unknown type is a build warning; its body is preserved as raw.
- An `output` block stores the captured result of a code block (text/data),
  recorded by tooling — never executed by the processor. An optional `of=#id`
  binds it to that code block and is reference-checked (§5).

### 3.1 Grammar

The block structure is context-free and is given below. Inline **emphasis** is not
a context-free construct; it is resolved by the delimiter-run algorithm of §5.3,
not by this grammar.

```ebnf
document      = { block } ;
block         = flow-block | typed-block ;

typed-block   = fence , SP , type , [ SP , attrs ] , NL , body , close-fence ;
fence         = "===" , { "=" } ;            (* open: N equals signs, N >= 3 *)
close-fence   = fence ;                      (* exactly equal to the opening length *)
type          = NAME ;
body          = { LINE } ;                    (* raw, flow or data per the registry *)

flow-block    = heading | list | paragraph ;
heading       = "#" , { "#" } , SP , text , [ SP , attrs ] , NL ;
paragraph     = text-line , { text-line } ;

list          = item , { item | blank-line } ;
item          = indent , marker , SP , [ task ] , text , NL ;
marker        = "-" | "*" | DIGIT , { DIGIT } , "." ;
task          = "[" , ( " " | "x" | "X" ) , "]" , SP ;
indent        = { " " | TAB } ;              (* nesting depth, by column *)

attrs         = "{" , { attr-item , [ SP ] } , "}" ;
attr-item     = id-attr | class-attr | kv-attr ;
id-attr       = "#" , NAME ;
class-attr    = "." , NAME ;
kv-attr       = NAME , "=" , value ;
value         = bare-word | quoted-string ;

NAME          = ALPHA , { ALPHA | DIGIT | "-" | "_" } ;
```

---

## 4. Attributes and identifiers

- `{#budget}` sets block id `budget`. Ids MUST be unique per document.
- `{.warning}` adds a semantic class (no styling implied).
- `{caption="Annual cost"}` and other `key=val` pairs are type-defined
  parameters.
- A heading auto-derives an id from its text; an explicit id is written as a
  trailing attribute object on the heading line, e.g. `## Title {#sec}`.
- Attribute value typing: a quoted `"…"` is always a string; `true`/`false` is a
  boolean; a bare word matching integer/float syntax is a number; any other bare
  word is a string. Arrays, dates and nested tables are not supported.
- A bare attribute word with no `=` is a boolean flag set to `true` (e.g.
  `hidden`).
- A `=== meta` block holds document metadata as one `key=val` per line, using
  the value typing above. In flow text, `{{key}}` is replaced with the matching
  `meta` value; an unknown key is a build **error**.
- The `hidden` flag marks a block (or a `%%` line) as part of the document and
  fully reference-checked, but **not rendered** — e.g. a source table that only
  feeds a chart. A `%%` line is a hidden, raw, never-rendered note.
- Attribute order is insignificant; the recommended order is `#id`, then
  `.class`, then `key=val`.

---

## 5. Inline content and links

### 5.1 Inline elements

Inline elements appear only inside flow blocks.

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

Inline parsing of a flow block runs in two phases and assigns exactly one parse to
every input.

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

A conforming processor MUST:

1. Parse the typed-block primitive (§3) and the attribute object (§4).
2. Build a document model in which every block id is unique and resolvable.
3. Emit an **error** on any unresolved internal/cross-doc reference (§5).
4. Treat an unknown block `type` and an unknown diagram `format` as
   **warnings**, never errors, preserving the body verbatim.
5. Resolve inline emphasis (§5.3) and list nesting (§2.1) so that every input has
   exactly one parse.
6. NOT require any specific editor, and NOT depend on raw HTML.

A **conformance suite** accompanies the spec: input `.geml` paired with a
normalized projection of the expected document model. The suite is the normative
reference for these rules — a second, independent implementation conforms when it
reproduces every case. In the reference repository it lives under
[`geml-parser/test/conformance/`](geml-parser/test/conformance/).
