# GEML — General Expressive Markup Language

*English | [中文](GEML-spec-draft_CN.md)*

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

---

## 3. Typed-block primitive

A typed block has the following form:

```
=== <type> <attrs>?
<body>
===
```

- The fence is a run of `=` (≥ 3). The closing fence MUST be a run of `=` of
  exactly the opening length; a shorter or longer run does not close the block.
- Nesting uses longer fences (`====` wraps `===`).
- The **type registry** declares each type's body mode: `raw` (verbatim, e.g.
  `code` with `lang=`, `diagram`/`table` with `format=`, `math`), `flow`
  (parsed, e.g. `note`, `aside`), or `data` (one `key=val` per line, e.g.
  `meta`).
- An unknown type is a build warning; its body is preserved as raw.

### 3.1 EBNF (draft)

```ebnf
document      = { block } ;
block         = flow-block | typed-block ;

typed-block   = fence , SP , type , [ SP , attrs ] , NL ,
                body ,
                close-fence ;
fence         = "===" , { "=" } ;            (* open: N equals signs, N>=3 *)
close-fence   = fence ;                       (* exactly equal to opening length *)
type          = NAME ;
body          = { LINE } ;                    (* raw, flow or data per registry *)

attrs         = "{" , { attr-item , [ SP ] } , "}" ;
attr-item     = id-attr | class-attr | kv-attr ;
id-attr       = "#" , NAME ;
class-attr    = "." , NAME ;
kv-attr       = NAME , "=" , value ;
value         = bare-word | quoted-string ;

flow-block    = heading | list | paragraph ;
heading       = "#" , { "#" } , SP , text , [ SP , attrs ] , NL ;
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
- A `=== meta` block holds document metadata as one `key=val` per line, using
  the value typing above.
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
- *Note (non-normative):* backlinks and graph views are a derived inverted index
  over resolved references; GEML adds no syntax for them.

### 5.3 Precedence

1. Backslash escapes, code spans, and inline math are recognized first; their
   contents are not parsed further.
2. Then images, links, auto-refs (`[[#id]]`), and footnote refs (`[^id]`); a
   link or ref MUST NOT nest inside another link or ref.
3. Then emphasis, strong, and strikethrough.

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

**(b) Data form**

```
=== table {#budget format=csv header=1 compute="Total = Months * Rate"}
Plan,  Months, Rate, Total
Basic, 1,      30,
Pro,   2,      30,
===
```

- Merged cells are declared, not drawn: `span="r2c1:2x1"`.
- `compute` formulas operate per row over columns referenced by header name or
  letter, using `+ - * / ( )`; summary rows MAY use the aggregates `sum, avg,
  min, max, count`. No cross-row addressing, conditionals or lookups.

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

---

## 8. Conformance

A conforming processor MUST:

1. Parse the typed-block primitive (§3) and the attribute object (§4).
2. Build a document model in which every block id is unique and resolvable.
3. Emit an **error** on any unresolved internal/cross-doc reference (§5).
4. Treat an unknown block `type` and an unknown diagram `format` as
   **warnings**, never errors, preserving the body verbatim.
5. NOT require any specific editor, and NOT depend on raw HTML.

A test suite accompanies the spec: input `.geml` ⇒ expected document-model JSON.
