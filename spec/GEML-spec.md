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
3. Every addressable block — a heading or a typed block (§2) — MAY carry a
   stable `id`; references MUST be resolved and validated at build time (§5).
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
  (raw, flow or data — §3).

A heading or a typed block MAY carry an **attribute object** `{#id .class key=val}`
(§4). Paragraphs and lists carry none: a trailing `{…}` on a paragraph is literal
text, and prose that needs an id goes in a `text` block (§3). Inline content exists
only inside unfenced blocks.

### 2.1 Paragraphs

A **paragraph** is a sequence of one or more non-blank lines of text. A paragraph is interrupted (ended) by any of the following constructs appearing at the start of a line:

- A blank line.
- A heading line.
- A list item marker line.
- A typed-block fence (`===`).
- A `%%` comment line.


Any line that does not match these interrupting constructs is a `text-line` and continues the paragraph.

### 2.2 Lists

A **list** is a run of one or more **item lines**. An item line is leading
indentation, a **marker**, a single space, and the item's inline content (§5):

- an **unordered** marker is `-` or `*`;
- an **ordered** marker is one or more digits followed by `.`; the first item's
  number is the list's `start`.

An item's content is a single line. A list item MAY begin with a **task marker** —
`[ ]`, `[x]`, or `[X]` followed by a space — which is stripped and recorded as a
checked/unchecked state.

**Nesting is by indentation.** Indentation is a column count (a tab counts as 4
columns). An item indented *more* than the current item's marker opens a nested
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

- The fence is a run of `=` (≥ 3). A block is closed by the **first** subsequent
  line that is either a run of `=` of exactly the opening length, or — when the
  block has an `#id` — its **labeled fence** `=== #id` (a `=` run of any length
  ≥ 3 followed by the block's id). An `#id` does NOT disable the bare
  equal-length close: whichever closer appears first ends the block.
- Nesting is safe only through fence-length discipline: no line of the body may
  be a bare `=` run of exactly the opening length. The RECOMMENDED convention
  is a **longer outer fence** (`====` wraps `===`), longer than every
  fence-like line in the body. A labeled close does not lift this rule — a bare
  run of the opening length inside the body closes the block at that line,
  silently truncating it before a later `=== #id` is ever reached.
- The labeled close removes the *length-counting* hazard — the close line names
  its block instead of matching a length — and is RECOMMENDED for long blocks,
  where miscounting `=` is the common failure. It is not a substitute for a
  longer opening fence when the body may contain fence-like lines.
- The **type registry** declares each type's body mode: `raw` (verbatim, e.g.
  `code` with `lang=`, `diagram`/`table`/`data` with `format=`, `math`, `embed`
  with `src=`),
  `flow` (parsed, e.g. `note`, `text`), or key–value (one `key=val` per line,
  e.g. `meta`; this mode is serialized as `"data"` in the document model — a
  name that predates the `data` block type, kept for model stability).
- An unknown type is a build warning; its body is preserved as raw.
- A `text` block is an **addressable prose container**: a flow body whose only
  purpose is to give a run of prose an `#id` and attributes, so it can be
  referenced, block-edited (`geml get`/`set`), and versioned. It renders as a
  neutral block — no callout chrome (a callout is `note`). Wrap only prose you
  actually need to address; plain paragraphs remain the default.
- An `embed` block stands for content that lives elsewhere: `src=` names a
  document, optionally with a fragment (`src=other.geml#budget`), and the block
  renders as that content in place. A fragment naming a heading selects the
  heading's whole section (the heading itself and all subsequent blocks up to, but not including, the next heading of the same or higher level, or the end of the document). `src=` is reference-checked like any other reference
  (§5), and the body of an `embed` block is ignored.

The document `src=` names MUST be **parsed as a document in its own right**, with
the target then selected from the result; it is never a run of text spliced into
the document that named it. So that document's metadata, its references, the base
its relative paths resolve against, and its external data (`src=`) all resolve
against **itself**, not against the document holding the `embed`:

```
a.geml                              b.geml
─────────────────────────────       ──────────────────────────────
=== embed {src=b.geml#tbl}          === table {#tbl src=rows.csv}
===                                 ===
```

`rows.csv` resolves against `b.geml`'s directory — the same way it resolves when
`b.geml` is opened on its own — not against `a.geml`'s. The document holding the
`embed` decides only where the result appears; it changes nothing about how the
other side resolves.

This holds for both forms — an `embed` block and an inline projection (§5.3) —
and at every depth of a chain: each document in the chain is the base for the
next one it names.

### 3.1 Grammar

The block structure is context-free and is given below. Inline **emphasis** is not
a context-free construct; it is resolved by the delimiter-run algorithm of §5.3,
not by this grammar.

```ebnf
(* The grammar is stated over LOGICAL lines. Before it applies, a fence or
   heading line ending with `\` is folded with the line(s) that follow it —
   backslash and newline become one space (§4, line continuation) — so NL below
   is the end of a folded logical line, and an attribute object may occupy more
   than one physical line. *)

document       = { block } ;
block          = unfenced-block | typed-block ;

typed-block    = fence , SP , type , [ SP , attrs ] , NL , body , close-fence ;
fence          = "===" , { "=" } ;            (* open: N equals signs, N >= 3 *)
close-fence    = fence ;                      (* exactly equal to the opening length *)
type           = NAME ;
body           = { LINE } ;                    (* raw, flow or data per the registry *)

unfenced-block = heading | list | paragraph | comment-line ;
heading        = "#" , { "#" } , SP , text , [ SP , attrs ] , NL ; (* 1 to 6 #s *)
paragraph      = text-line , { text-line } ;
text-line      = LINE ;                       (* non-empty line not matching an interruption rule *)
comment-line   = indent , "%%" , [ SP , text ] , NL ; (* §4: kept, never rendered *)

list           = item , { item | blank-line } ;
item           = indent , marker , SP , [ task ] , text , NL ;
marker         = "-" | "*" | DIGIT , { DIGIT } , "." ;
task           = "[" , ( " " | "x" | "X" ) , "]" , SP ;
indent         = { " " | TAB } ;              (* nesting depth, by column *)

attrs          = "{" , { attr-item , [ SP ] } , "}" ;
attr-item      = id-attr | class-attr | kv-attr | flag-attr ;
id-attr        = "#" , NAME ;
class-attr     = "." , NAME ;
kv-attr        = NAME , "=" , value ;
flag-attr      = NAME ;                       (* boolean true flag *)
value          = bare-word | quoted-string ;

quoted-string  = '"' , { quoted-char } , '"' ;
quoted-char    = escape-seq | ( CHAR - '"' - "\" ) ;
escape-seq     = "\" , ( '"' | "\" ) ;         (* only " and \ can be escaped *)
bare-word      = NAME | number ;
number         = [ "-" ] , integer , [ frac ] ;
integer        = "0" | ( NONZERO , { DIGIT } ) ;
frac           = "." , DIGIT , { DIGIT } ;
NONZERO        = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;

NAME           = NAME-CHAR , { NAME-CHAR } ;
NAME-CHAR      = LETTER | DIGIT | "-" | "_" ;  (* LETTER: any Unicode letter *)
```

A NAME is not restricted to ASCII, and needs no leading letter: the id a heading
derives from its own text (§4) may begin with a digit or `-`, and non-Latin
scripts are ordinary NAME characters.

### 3.2 The `data` block

A `data` block carries the **value tree** — scalars, sequences and maps,
exactly JSON's value domain — as *verified data*, where `code` carries text
the processor must never interpret. The body is `raw` at scan time (fences
delimit verbatim text); a **format engine** then parses it into the block's
**value**, and a body the engine rejects is a build **error** naming the
offending line.

- `format=` selects a surface syntax *within* this one model. Admission to
  the registry requires the syntax to be **self-describing** — the bytes
  alone determine the value, with no dialect parameters. Delimited text fails
  this (delimiter, header presence and quoting are parameters, and they are
  only meaningful against a column model), which is why `csv`/`tsv` are
  `table` formats (§6), not `data` formats.
- `json` — the default — the body MUST parse as one JSON value. The default
  follows a registry-wide rule: when a model has an isomorphic canonical
  syntax, that syntax is the default (`table` → the pipe form). JSON is the
  value tree's own serialization, and the one syntax a zero-dependency
  processor can always verify.
- `jsonl` — every non-blank body line MUST parse as one JSON value; blank
  lines are ignored; the block's value is the sequence of line values. This
  is the record-stream form: because a document is a flat sequence of blocks,
  a complete `data` block appended at end-of-file is a valid continuation of
  any document — jsonl's blind-append ergonomics, with ids and verification.
- `src=` names the block's content externally, under the same one-source
  discipline tables have (§6): exactly one of `src=` and an inline body —
  both is an **error**. The file MUST look like data (`.json`/`.jsonl`; an
  explicit `format=` still wins over the extension). An `http(s)` source is
  fetched by the RENDERER, never the parser (§9.4) — the block, and any
  chart over it, defers; any other URL scheme is refused. This is the log
  arrangement: the records stay a plain `.jsonl` file every existing tool
  can append to and tail, and the GEML document is its verified,
  addressable, chartable view.
- `yaml` and `toml` are RESERVED format names (the value-tree readings of
  those syntaxes). A processor without an engine for them MUST keep the body
  raw and emit a **warning**, and MUST NOT guess — the same degradation as an
  unknown `diagram` format (§7). An unknown `format=` value degrades
  identically.
- `schema=` is RESERVED: it names a block (`#id`) or a GEML document
  (`doc.geml`, optionally `doc.geml#id`) holding a schema, and is
  reference-checked like any other reference (§5); any other shape is an
  error. Validating the value against the schema is not defined by this
  version of the specification.
- A successfully parsed body is exposed in the document model as the block's
  `value`. Canonical serialization re-emits `json` pretty-printed at
  two-space indent and `jsonl` as one compact value per line; engine-less
  bodies are byte-preserved like any raw body.
- A `data` block whose value is a **record array** may feed a chart — §7.1.

### 3.3 Source routes

A `code` block MAY name the code it shows with `src=` rather than hold a copy of
it, and a `data` block MAY name its value the same way (§3.2). Both use one
**route** syntax:

```
<path>[#L<start>[-<end>]]
```

The path names a file; the optional fragment narrows it to a line range, **1-based
and inclusive** (`#L14-24`, or `#L14` for a single line). With no fragment the
route names the whole file. A range MUST NOT be empty or start before line 1.

- **Resolution.** A route resolves relative to the document. When a resolution
  root is named (`--root`), a route that does not exist document-relative MAY
  also be resolved relative to that root — how a generated code graph writes
  routes from documents nested below the sources they describe. Both resolutions
  stay inside the confinement boundary of §9.4.
- **Remote.** An `http(s)` route is fetched by the **renderer**, not the parser
  (§9.4); the block, and anything reading it, defers. Any other URL scheme MUST
  be refused.
- **A route that cannot be resolved is a warning, not an error.** A `code` block
  names a region of code at a location whether or not that file is reachable, so
  a document describing sources that are absent — a generated code graph
  published on its own, or describing another checkout — stays valid and is
  merely unchecked. A `data` route is the opposite case: its value is what the
  document promised, so failing to load it is an error (§3.2). A disallowed URL
  scheme is an authoring mistake either way, and MUST be refused.
- **A stale range is an error.** If the file no longer has the named lines, a
  processor MUST report `bad-source-range`. This is the point of checking a
  route: a reference that has drifted fails the build instead of rendering an
  empty region.
- **A body alongside `src=` is a snapshot.** It is permitted — it keeps a
  document legible with no fetch — but the route is the source of truth, and a
  processor SHOULD warn (`stale-code-snapshot`) when the two differ.
- **No extension gate.** Code is written in any language, so a route to code is
  not restricted by suffix; the safety boundary is confinement (§9.4) alone. A
  `data` route keeps its `.json`/`.jsonl` gate (§3.2), whose purpose is to name
  a *format*, not to bound the filesystem.

For `data`, a range narrows the file to lines and the format then reads them as
usual: a window of a `jsonl` log is the obvious use, and a `json` slice is valid
exactly when the slice is itself a value.

---

## 4. Attributes and identifiers

- `{#budget}` sets block id `budget`. Ids MUST be unique per document.
- `{.warning}` adds a semantic class (no styling implied).
- `{caption="Annual cost"}` and other `key=val` pairs are type-defined
  parameters. Two are not type-specific and are valid on **every** typed block:
  `caption`, a short label a renderer shows with the block and §5.2 uses as
  auto-reference text, and the `hidden` flag below. A key a type does not define
  is an `unknown-attribute` warning, never an error — it is preserved.
- A heading auto-derives an id from its text; an explicit id is written as a
  trailing attribute object on the heading line, e.g. `## Title {#sec}`. The
  derivation is **normative**: a reference (`[[#id]]`, `other.geml#id`, a URL
  fragment) has to name the same block in every implementation, so the id a
  heading yields cannot be left to one. From the heading's text — taken **before**
  `{{key}}` interpolation (meaning the literal braces and variable name form the slug),
  to ensure the id remains stable when meta values change — a processor MUST
  apply these rules in order:
  1. lower-case it;
  2. delete every code span, its backticks and its content alike — so the
     punctuation inside `` `foo()` `` cannot leak into the id;
  3. delete every character that is neither a Unicode letter, a digit,
     whitespace, nor `-` (an underscore is therefore dropped: `_` is legal in an
     explicit id but never survives a derivation);
  4. trim leading and trailing whitespace;
  5. replace each run of whitespace with a single `-`.

  So `## Use \`foo()\` in 2024 Design` derives `#use-in-2024-design`, and — since
  step 3 keeps every Unicode letter — `## Ubytovací zařízení` derives
  `#ubytovací-zařízení` and `## 设计说明` derives `#设计说明`. A derived id
  collides like any other: two headings that derive the SAME id are a
  `duplicate-id` **error** (Appendix A) — the id addresses the first, and the
  second MUST declare an explicit `{#id}`. Two distinct headings can derive one
  id (`foo_bar` and `foobar` both derive `#foobar`, since step 3 drops the
  underscore), so this is a collision to expect, not an exotic one. A heading
  whose text carries no letter and no digit derives the empty id, which is a
  derived id like any other and therefore collides with a second such heading;
  give either one an explicit `{#id}`.
- Style note (non-normative): keep the document title in `=== meta`
  (`title = "…"`), not in a top-level heading — every heading then denotes a
  genuine section of the document.
- Attribute value typing: a quoted `"…"` is always a string; `true`/`false` is a
  boolean; a bare word matching integer/float syntax is a number; any other bare
  word is a string. Arrays, dates and nested tables are not supported.
- A bare attribute word with no `=` is a boolean flag set to `true` (e.g.
  `hidden`).
- A `=== meta` block holds document metadata as one `key=val` per line, using
  the value typing above. If a document contains multiple `=== meta` blocks,
  their keys are merged; a later definition overwrites an earlier one for the
  same key. In flow text, `{{key}}` is replaced with the matching
  `meta` value; an unknown key is a build **error**. Interpolation reads the
  flow source text and honors the verbatim atoms of §5.3 phase 1(1): a
  `{{key}}` inside a code span or inline math is left untouched (so a GEML
  document can quote this very syntax), raw block bodies are never
  interpolated, and a backslash-escaped `\{{key}}` renders as the literal text
  `{{key}}`.

  Interpolation is a **single pass over flow text**, and both halves of that are
  normative. Single pass: a substituted value is never rescanned, so a value
  that itself reads `{{other}}` produces those six characters literally — there
  is no nesting to resolve, and therefore no cycle to detect (`a = "{{b}}"` with
  `b = "{{a}}"` terminates, yielding the literal text). Flow text: `{{key}}` in
  an attribute value is NOT interpolated — `caption="{{title}}"` is the literal
  string — which is also why a heading's derived id (above) is stable.
- The `hidden` flag marks a block as part of the document and
  fully reference-checked, but **not rendered** — e.g. a source table that only
  feeds a chart. A `%%` line is a hidden, raw, never-rendered author note. The division of labor is: use `hidden` for structured content that participates in the document model (data sources, reusable fragments) but should remain invisible; use `%%` for throwaway comments that do not participate in the document model. Note that `%%` is only recognized as a comment at block positions (top-level or inside the body of a `flow` block). Inside a `raw` block body, `%%` lines are preserved exactly as-is and are not treated as comments.
- Attribute order is insignificant; the recommended order is `#id`, then
  `.class`, then `key=val`.
- **Line continuation:** A typed block fence (`===`) or heading (`#`) line ending
  with a backslash `\` continues its attribute object onto the next line. The
  backslash and newline are treated as a single space, allowing long attribute
  objects (e.g., table schemas) to be split for readability. Folding repeats
  while each continued line also ends with `\`, and stops after the first one
  that does not; the folded result is the logical line the grammar of §3.1
  parses. Only fence and heading lines fold: a `\` ending a line of prose is a
  hard break (§5.1), and a `\` ending a line inside a block body is body text.

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
| `![[#id]]` | in-place content embed (inline projection) |
| `\` at line end | hard line break |
| `\` + ASCII punctuation | escape: the punctuation is literal |

- Emphasis/strong delimiters MUST attach to a non-space character and MUST NOT
  span block boundaries.
- **Block escapes:** Because block syntax (like `===` fences, `#` headings, and `-` lists) must match at the start of a line, prepending a backslash (e.g., `\===` or `\#`) prevents the line from being parsed as a block. The inline parser then turns the `\`+punctuation into a literal character, effectively escaping block syntax in flow text.
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
| `[[#budget]]` | auto-ref: link text taken from target's caption/heading (or the raw `#id` string as fallback) |
| `![[#budget]]` | inline projection: content from block `budget` |
| `[[other.geml#budget]]` | the same, across documents: the block in that document |
| `![[other.geml#budget]]` | inline projection, across documents |
| `[text](other.geml#budget)` | cross-document ref |
| `[^note]` | footnote: renders the block with id `note` as a footnote |

- External link options go in the attribute object:
  `[text](url){rel=nofollow target=_blank}`.
- An unresolved `#id`, `other.geml#id`, or `[^id]` is a build **error**.
- **A fragment is read as a block id only when the target is a `.geml`
  document.** In `page.html#sec` or `notes.md#sec` the fragment belongs to that
  format — an element id, a forge's heading slug — and a GEML build neither
  resolves nor reports it. The target document must still exist; only the part
  after `#` is left to the format that defines it.
- A footnote reference points to any block with a matching `#id` (typically a `note` block). The renderer may use this to present it as a document footnote.
- *Note (non-normative):* backlinks and graph views are a derived inverted index
  over resolved references; GEML adds no syntax for them.

### 5.3 Recognition order and emphasis

Inline parsing of an unfenced block runs in two phases and assigns exactly one
parse to every input.

**Phase 1 — atoms** (left to right, in this priority):

1. Backslash escapes (`\` + ASCII punctuation → that literal character; `\` at
   line end → hard break), code spans, and inline math; their contents are not
   parsed further.
2. Metadata interpolations (`{{key}}`); replaced with the scalar value.
3. Images (`![alt](src)`), links, auto-refs (`[[#id]]`), inline projections (`![[#id]]`), and footnote refs (`[^id]`); a link or
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
  followed by whitespace and either is not followed by punctuation or is
  preceded by whitespace or punctuation; **right-flanking** is the mirror. A run
  MAY **open** when left-flanking and MAY **close** when right-flanking.
- **Punctuation** here is any character in a Unicode punctuation (`P*`) or symbol
  (`S*`) category — not merely ASCII. Curly quotes, guillemets, and the CJK forms
  `“` `）` `，` are punctuation exactly as `"` `)` `,` are, so `“*(foo)*”`
  emphasizes just like `"*(foo)*"`. (The `\` escape of §5.1 is the opposite: it
  applies to ASCII punctuation only, because no non-ASCII character is GEML
  syntax to begin with.)
- Pair runs in one left-to-right scan: each closing run matches the nearest
  preceding opening run of the same character. When a run can both open and close,
  a pairing whose two run lengths sum to a multiple of three is rejected unless
  both lengths are multiples of three (the **rule of three**).
- A matched `*` pair is **emphasis** (one delimiter per side) or **strong** (two
  per side, when both runs have two or more); a matched `~~` pair is
  **strikethrough** (two per side). Any delimiter left unpaired is literal.

*This is the CommonMark delimiter-run algorithm — flanking, and the rule of three
— restricted to GEML's delimiters: `*` and `~~`, with no `_` emphasis. It is NOT
the whole of CommonMark's inline pass: phase 2 above runs per literal-text run,
so a delimiter before an atom can never pair with one after it, and
`*text with a [link](x.geml)*` is literal asterisks rather than emphasis
containing a link. Whether that restriction should stand is
[GEP-0007](proposals/0007-emphasis-across-atoms.md).*

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
=== table {#fy25 caption="FY2025 revenue by segment ($M)" format=csv header=1 \
           compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4; \
                    YoY [%.1f%%] = (FY - PriorFY) * 100 / PriorFY" \
           summary="Segment = 'Total'; \
                    Q1 = sum(Q1); Q2 = sum(Q2); Q3 = sum(Q3); Q4 = sum(Q4); \
                    PriorFY = sum(PriorFY); FY = sum(FY); \
                    YoY [%.1f%%] = (sum(FY) - sum(PriorFY)) * 100 / sum(PriorFY)"}
Segment,   Q1,    Q2,    Q3,    Q4,    PriorFY
Cloud,     124.5, 131.2, 142.8, 158.3, 470.0
Hardware,  88.1,  84.6,  90.3,  95.7,  372.0
Services,  45.2,  47.8,  49.1,  52.6,  168.0
===
```

*The `{…}` attribute object is split with the `\` line continuation of §4 — the
backslash and the newline become one space. The backslashes are load-bearing:
without them the opening fence never closes its `{…}`, and the whole block —
fences and all — is a paragraph.* The example resolves to:

| Segment | Q1 | Q2 | Q3 | Q4 | PriorFY | FY | YoY |
|---------|----:|----:|----:|----:|--------:|------:|-----:|
| Cloud | 124.5 | 131.2 | 142.8 | 158.3 | 470.0 | 556.8 | 18.5% |
| Hardware | 88.1 | 84.6 | 90.3 | 95.7 | 372.0 | 358.7 | -3.6% |
| Services | 45.2 | 47.8 | 49.1 | 52.6 | 168.0 | 194.7 | 15.9% |
| **Total** | **257.8** | **263.6** | **282.2** | **306.6** | **1010** | **1110.2** | **9.9%** |

- **Delimiter** — a data body splits on its format's natural delimiter: `,` for
  `format=csv`, a tab for `format=tsv`. `delim=` overrides it with any single
  character, so a European `;`-separated CSV or a `|`-delimited export is
  readable as it stands. The value MUST be exactly one character; anything else is
  a `bad-table-delimiter` error, and the natural delimiter is used so the rest of
  the table still reads. Attribute values carry no escape syntax (§4), so a tab
  delimiter is spelled `format=tsv`, never `delim="\t"`. A data body splits on the
  delimiter and on nothing else: with `delim="|"` the outer pipes of `| a | b |`
  are cells of their own — stripping them is the visual form's rule (a), not this
  one. `delim` refines the data form, it does not select it: on a table with no
  data `format` it is ignored, with an `ignored-table-delimiter` warning.
- **Data from elsewhere** — instead of an inline body, a table MAY name where its
  data comes from. For a `table` block that is the `src=` attribute (a `diagram`
  spells the same idea `data=`; see Appendix B.3), and it takes one of three
  targets: a data file with `format=csv`/`tsv` (a path relative to the document,
  or an `http(s)` URL); `#id`, naming a table block in this document; or
  `doc.geml#id`, naming one in another document. A local-path or cross-document target MUST be resolved and
  existence-checked at build time — an unresolvable one is an error, and a target
  that exists but is not a table is an error. Only the `src` text — never
  the resolved contents — enters the `.gemlhistory` hash. A table MUST NOT carry
  both `src` and an inline body (an error). Because the data arrives at render
  time, the column names used by `compute` and by a referencing `geml-chart` are
  validated then, not at build time. Inlining stays the default; `src` is an
  explicit choice.

- **Computed columns** — `compute` lists one or more `Name = expr` formulas
  separated by `;`. Each `expr` is evaluated once per data row over `+ - * / ( )`
  and unary `-` (with `*`/`/` binding tighter than `+`/`-`, left-associative).
  When encountering empty or non-numeric cells, row-level computation treats them as `0` to allow the formula to complete, and MUST report each substituted cell as a `compute-non-numeric-cell` warning: the total is still produced, but a reader is told which cell it rests on rather than being handed a silently wrong number. Conversely, when evaluating aggregate functions, `count` tallies all non-empty cells, while the others (like `sum` or `avg`) skip non-numeric cells (they do not count towards the total or denominator). Columns are referenced by header name — quoting
  names with spaces in single quotes, e.g. `'Unit Price'` — or by spreadsheet
  letter (`A`, `B`, …). A formula MAY reference an earlier computed column (above,
  `YoY` references `FY`); references MUST be acyclic. Computed columns are appended
  after the data columns in formula order and are NOT written in the body.
- **Results a cell cannot hold** — division by zero yields ±∞ and `0 / 0` yields
  NaN. Neither is a table value: the cell MUST hold no value and MUST display
  `-`, and the processor MUST report a `compute-not-a-number` warning naming the
  cell. Because the cell then holds no value, a later formula or aggregate reading
  it treats it as any other non-numeric cell (counted as `0` in a row formula,
  skipped by `sum`/`avg`). This applies to `summary` expressions identically. A
  zero denominator is a fact about the data, not a defect in the document, so it
  is a warning and the document stays conforming — but it is never silent.
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

  The split is defined on the left side of a formula, and only there: a format
  is the LAST `[…]` group of the left side, it MUST end the left side (trailing
  whitespace aside), it MUST NOT contain `]`, and it MUST contain a `%`.
  Everything before it, trimmed, is the column name. The `%` test is what lets a
  column name be bracketed: in `[Data] = A + B` nothing matches, so the column is
  named `[Data]`; in `[Data] [%.1f] = A + B` the format is `%.1f` and the column
  is still `[Data]`.
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
resolve the reference and supply a **table model** to the renderer. Two
target forms produce one: a `table` (its model, computed columns included),
or a `data` block (§3.2) whose value is a **record array** — a non-empty
sequence of maps. Record keys project to columns in first-seen order, and
every column the chart references MUST be present with a scalar value in
every record; columns the chart does not reference may hold anything. A
dangling id, a target of neither form, or a record violating the rule is a
build **error**. The processor still does NOT interpret the body.

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
  a typo'd column or a dangling id is a build error. (If the table's data is
  external and fetched at render time per §9.4, column validation is deferred
  to the renderer).
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

Every input is nonetheless *parseable*: §2, §3, §5.3 and §6 assign exactly one
document model to any character stream. There is no input a conforming parser
may reject, refuse to model, or fail on — a non-conforming document still
produces a model, alongside the errors that describe it.

### 8.2 Conforming parser

A conforming parser MUST:

1. Normalize its input exactly as §0.5 requires.
2. Parse the typed-block primitive (§3) and the attribute object (§4).
3. Build a document model in which every block id is unique and resolvable.
4. Resolve inline emphasis (§5.3) and list nesting (§2.2) so that every input has
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
(§5.3), list nesting (§2.2), atom precedence, and metadata interpolation (§4). A
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
- there is no raw-HTML escape hatch (§1(5)) and no expression language beyond the
  closed arithmetic of §6 — which has no conditionals, no lookups, no
  cross-table references, and no embedded program by construction.

### 9.2 Resource limits

A processor MUST bound the depth to which it will recurse over a document, for
each of: typed-block nesting (§3), list nesting (§2.2), and inline nesting
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
- **Cross-document references** are *checked* exactly one level deep. A
  processor collects the target document's ids *without* resolving that
  document's own references, so two documents that reference each other
  terminate when validating references.
- **Content transclusion** (an `embed` block or inline projection expanding its target in-place) is recursive. A processor MUST track the chain of expanded documents and stop if a document transcludes a target in a document already being expanded in that chain, emitting a `transclusion-cycle` error.
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

### 9.6 How much of this the conformance suite certifies

Because §9.5 requires the scheme check to be applied **when building the model**,
its effect is visible in the model and therefore machine-checkable: the
conformance suite's `safety.json` cases pin both which destinations disappear and
which must survive, and §8's acceptance test runs them against a second
implementation.

The rest of this section is **equally normative and not covered there**. §9.2's
limits and §9.3's cycle detection are reported as diagnostics and would require
pinning a particular bound; §9.5's expansion budgets act at render time, and
§9.4's confinement is a property of the host environment. An implementation
claiming conformance MUST still satisfy them, and SHOULD carry its own tests for
each — a suite pass is evidence about parsing, not a security certificate. The
conformance suite's own README lists the failures these requirements have
actually prevented.

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
| `unknown-attribute` | warning | A known block type declares an attribute key outside its defined attributes. |
| `block-nesting-too-deep` | error | Typed-block nesting exceeded the processor's bound (§9.2). The body at that depth is kept as `raw` rather than scanned further. |
| `list-nesting-too-deep` | error | List nesting exceeded the processor's bound (§9.2). |
| `inline-nesting-too-deep` | error | Inline nesting exceeded the processor's bound (§9.2). The over-deep run degrades to text with emphasis only. |
| `stray-labeled-fence` | warning | A line shaped exactly like a labeled close (`=== #id`) fell through to paragraph text, closing nothing. When the id names a block a bare fence already closed, everything after that close silently fell out of the block (§3) — the message names the closing line. |
| `fence-like-line` | warning | A line that begins with a `=` run (≥ 3) and a registered type name fell through to paragraph text because it does not match the open-fence production (§3.1) — most often attributes written without braces, as in `=== embed src=#a`. The line is prose, so any reference in it is never resolved or checked. |

### A.2 Identifiers, references and metadata (§4, §5)

| Code | Severity | Condition |
|------|----------|-----------|
| `duplicate-id` | error | Two blocks in one document declare the same `id`. Ids MUST be unique per document (§4). |
| `unresolved-reference` | error | An internal reference `[…](#id)` or `[[#id]]`, or a chart `data=#id`, names an id no block declares. |
| `unresolved-footnote` | error | A footnote reference `[^id]` names an id no block declares. |
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

| `unresolvable-table-source` | error | A table's `src=` names a data file that cannot be resolved. |
| `table-source-not-a-table` | error | A table's `src=` names a block that exists but is not a table. |
| `unknown-metadata-reference` | error | A `{{key}}` interpolation names a key no `=== meta` block defines (§4). |

### A.3 Tables (§6)

| Code | Severity | Condition |
|------|----------|-----------|
| `table-src-and-body` | error | A table carries both `src=` and an inline body. Exactly one is permitted (§6). |
| `unknown-table-format` | warning | The `format=` value is not a recognized data format; the body is parsed as a visual pipe grid instead. |
| `bad-table-delimiter` | error | A `delim=` value is not exactly one character (§6). The format's natural delimiter is used instead, so the table still reads. |
| `ignored-table-delimiter` | warning | A table carries `delim=` but no data `format=`, so no delimited body exists for it to apply to; the body is parsed as a visual pipe grid. |
| `bad-compute-formula` | error | A `compute` entry is not of the form `Name = expr`. |
| `unlexable-compute-formula` | error | A `compute` expression contains a character or token the §6 expression grammar does not define. |
| `compute-error` | error | A `compute` expression failed to evaluate — most often because it names a column that does not exist, or one computed later (§9.3). |
| `compute-non-numeric-cell` | warning | A `compute` formula read a cell that is empty or not a number; it counted as `0` (§6). The result is still produced — the warning names the cell it rests on. |
| `compute-not-a-number` | warning | A `compute` or `summary` expression produced a value a cell cannot hold — ±∞ from a division by zero, or NaN from `0 / 0` (§6). The cell holds no value and displays `-`. |
| `bad-summary-entry` | error | A `summary` entry is not of the form `Cell = value`. |
| `summary-unknown-column` | error | A `summary` entry's left-hand side names no column of the table. |
| `unlexable-summary-expression` | error | A `summary` expression contains a token the §6 expression grammar does not define. |
| `summary-error` | error | A `summary` expression failed to evaluate — including a column reference not reduced by an aggregate, which has no value in the summary row (§6). |


### A.4 Diagrams and charts (§7)

| Code | Severity | Condition |
|------|----------|-----------|
| `unknown-diagram-format` | warning | No renderer is registered for the diagram's `format`. The body is preserved verbatim (§8.2(6)). |
| `ignored-diagram-body` | warning | A diagram whose configuration lives entirely in attributes (`geml-chart`, `geml-code-graph`) was given a non-empty body, which is ignored. |
| `code-graph-missing-src` | warning | A `geml-code-graph` diagram declares no `src=`, so there is nothing to render. |
| `code-graph-unresolvable-document` | warning | A `geml-code-graph` diagram's `src=` could not be resolved. |
| `chart-missing-data` | error | A `geml-chart` declares no `data=#id`. |
| `chart-data-not-a-table` | error | A `geml-chart`'s `data=#id` resolves to a block that is neither a `table` nor a `data` block (§7.1). |
| `chart-data-not-records` | error | A `geml-chart`'s `data=#id` resolves to a `data` block whose value is not a record array, or a referenced column is missing or non-scalar in some record (§7.1). The message names the first offending record. |
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


### A.5 Data blocks (§3.2)

| Code | Severity | Condition |
|------|----------|-----------|
| `data-parse` | error | The body does not parse under the declared `format=` — not one JSON value (`json`), or a non-blank line that is not one JSON value (`jsonl`). The diagnostic names the offending line. |
| `unknown-data-format` | warning | The `format=` value is not in the data format registry. The body is kept raw and not verified. |
| `data-format-no-engine` | warning | The `format=` names a RESERVED format (`yaml`, `toml`) this processor ships no engine for. The body is kept raw and not verified — never guessed at. |
| `bad-data-schema` | error | `schema=` is not a block reference (`#id`) or a GEML document reference (`doc.geml[#id]`). |
| `data-src-and-body` | error | A `data` block carries both `src=` and an inline body; exactly one is permitted (§3.2). The body wins. |
| `bad-data-source` | error | A data source (`src=`, or a chart's `data=` file form) does not name a `.json`/`.jsonl` data file — or a remote json/jsonl chart source was named without a `data` block to defer on. |
| `unresolvable-data-source` | error | A `.json`/`.jsonl` source could not be resolved, or names a disallowed URL scheme. |
| `unresolvable-code-source` | warning | A `code` block route could not be resolved, so it was not checked. A warning, not an error: the block still names a region of code, so a graph read away from its sources stays valid (§3.3). |
| `bad-code-source` | error | A `code` block route names a disallowed URL scheme (§3.3). |
| `bad-source-range` | error | A source route's fragment is not `#L<start>[-<end>]`, names an empty range, or names lines the file no longer has — a drifted reference (§3.3). |
| `stale-code-snapshot` | warning | A `code` block holds a body alongside `src=` and the two differ: the body is a snapshot of the route and is out of date (§3.3). |

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
| List — `-`/`*`, `1.`; task marker `[ ]`/`[x]` | unfenced | inline items | §2.2 |
| `=== code` | typed | raw | §3 |
| `=== math` | typed | raw | §3 |
| `=== table` | typed | raw: pipe grid or `format=` data | §6 |
| `=== data` | typed | raw: `format=` value tree (`json` default, `jsonl`; `yaml`/`toml` reserved) | §3.2 |
| `=== diagram` | typed | raw: external DSL | §7 |
| `=== embed` | typed | raw (body unused); `src=` names the content | §3, §6 |
| `=== note` | typed | flow | §3 |
| `=== text` | typed | flow | §3 |
| `=== meta` | typed | key–value | §3, §4 |

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

Seven attribute keys carry references; all of them are validated (Appendix A):

| Key | Host block | Target | Defined in |
|-----|------------|--------|------------|
| `src=` | `table` | where the data comes from, in three forms: a data file (`csv`/`tsv`, document-relative path or `http(s)` URL), `#id` naming a table block in this document, or `doc.geml#id` naming one in another. | §6 |
| `data=` | `diagram` (`geml-chart`) | where the data comes from, in the same three forms a table's `src=` takes: a data file (`csv`/`tsv` standing for the anonymous table it describes; a local `.json`/`.jsonl` for the anonymous record source), `#id` in this document, or `doc.geml#id` in another — naming a `table`, or a record-array `data` block (§3.2). | §6, §7.1 |
| `schema=` | `data` | a block (`#id`) or a GEML document (`doc.geml[#id]`) holding a schema; reference-checked only | §3.2 |
| `src=` | `data` | the block's external content: a `.json`/`.jsonl` file, taking the same route syntax as a code source (a line range MAY narrow it, which is how a window of a jsonl log is addressed); document-relative or `http(s)` (render-time) | §3.2 |
| `src=` | `code` | the code the block shows: a source file, optionally narrowed to a line range — `<path>[#L<start>[-<end>]]`, 1-based and inclusive. Document-relative, or relative to the resolution root (`--root`); an `http(s)` route is fetched at render time. A range the file no longer has is an error. | §3.3 |
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
| Spatial content | — | heading, list, `table`, `data`, `diagram`, `note`, `text` |
| Hidden content, comments | — | `hidden` flag, `%%` line |
| Metadata | `{{key}}` (use) | `=== meta` (definition) |
| Footnote | `[^id]` (use) | A block with target `#id` |

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
the full context rules of §3 — the document the reference names is parsed as a
document in its own right, the target then selected from it. With `=== embed`
for a block or a section, the three granularities are a scalar, a phrase, and
a block.
