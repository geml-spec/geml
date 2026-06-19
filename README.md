# GEML — General Expressive Markup Language

*English | [中文](README_CN.md)*

**A plain-text document format that stays legible to people and reliable for machines.**
*One typed block carries every kind of structured content — code, tables, diagrams, math, metadata.*

`1.0-draft` spec (EN / 中文) · reference parser + CLI (TypeScript) · **79-check** conformance suite · self-hosting (the spec is written in GEML) · self-contained version history · browser extension · MIT

---

GEML is a markup language for structured, expressive documents. A `.geml` file is **fully legible as plain text** — you never need a renderer to read it — and instead of a different mini-syntax per kind of content, GEML carries them all on exactly **one** construct: the **typed block**.

```
=== code {#hello lang=python}
print("hi")
===
```

Code is a block. So are tables, diagrams, math, callouts, and document metadata. Same shape, every time — which is what makes the format easy for a person to learn and hard for a machine to get wrong.

## Why a new format now

Markdown was designed for documents that **people hand-write and people read**. Today the same documents are also written, edited, reviewed, and queried by **AI agents and CI pipelines** — and that shift asks three things of a format that Markdown was never built to give:

- **Predictable structure**, so a model emits valid output instead of guessing among a pile of per-feature special cases.
- **References that can be verified**, so an automated edit that breaks a link fails loudly instead of rotting silently.
- **History that travels with the document**, so a reader — human or agent — can see how and why it changed, offline and with no external service.

GEML is shaped around those three. Not by bolting on "AI features", but by choosing a format that is **simultaneously** simpler for people and more dependable for machines.

## Three things GEML has that others don't — together

Plenty of formats do one or two of these. GEML's case is that no other plain-text format does all three **at once** — and that, not a feature count, is the point (AsciiDoc, for one, ships more built-in elements than GEML):

1. **One primitive for every structured block.** Code, tables, diagrams, math, callouts, metadata — all the same `=== type {…}` typed block. One grammar to learn, one grammar to generate correctly: no per-feature syntax, no HTML fallback.
2. **References checked at build time.** Put an `#id` on any block and reference it anywhere; a dangling reference or a broken cross-document link is a build **error**, not a silent 404. Automated edits can't quietly rot.
3. **Self-contained version history.** A sibling `.gemlhistory` file reconstructs any past revision and rolls the document back — offline, with no git and no service — and it's plain text an agent can read to understand how the document evolved.

For a fuller side-by-side across **Markdown, HTML, CommonMark, AsciiDoc, and Org-mode**, see the [format comparison](COMPARISON.md).

## The format in 5 minutes

### Typed blocks

Every kind of content is the same shape — only the **type** (and what goes in the body) changes:

```
=== code {lang=python}
print("hi")
===

=== note {.intro}
Parsed prose with *emphasis* and a [[#budget]] reference.
===

=== meta
title = "Budget plan"
===
```

A run of `=` (three or more) opens a block; an equal-length run closes it; longer fences nest inside shorter ones. The type decides how the body is read — `raw` (verbatim: `code`, `diagram`, `math`, `table`), `flow` (parsed prose with inline markup: `note`, `aside`), or `data` (one `key=val` per line: `meta`) — and every block may carry `{#id .class key=val}`. The full inline grammar (emphasis, links, `[[#id]]` auto-references, media, footnotes, inline `$math$`) is in the [spec](GEML-spec.md).

### Tables — two bodies, one model

Write a table visually:

```
=== table {#budget caption="Annual cost"}
| Plan  | Months | Rate |
|-------|-------:|-----:|
| Basic |      1 |   30 |
| Pro   |      2 |   30 |
===
```

…or as data, with **computed columns** and a **summary row**:

```
=== table {#fy25 format=csv header=1 compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4" summary="Segment = 'Total'; FY [%.1f] = sum(FY)"}
Segment,  Q1, Q2, Q3, Q4
Cloud,     8, 10, 12, 14
Platform,  5,  6,  7,  9
Services,  3,  4,  4,  5
===
```

*Both forms describe the same model. The `FY` column and `Total` row are computed at build time:*

| Segment   | Q1 | Q2 | Q3 | Q4 |   FY |
|-----------|---:|---:|---:|---:|-----:|
| Cloud     |  8 | 10 | 12 | 14 | 44.0 |
| Platform  |  5 |  6 |  7 |  9 | 27.0 |
| Services  |  3 |  4 |  4 |  5 | 16.0 |
| **Total** |    |    |    |    | **87.0** |

`compute` runs `+ - * / ( )` per row over columns; `summary` adds a foot row from the aggregates `sum / avg / min / max / count` (with arithmetic over them, e.g. weighted ratios); a trailing `[printf]` sets numeric display.

### Diagrams & charts — host a DSL, or chart a table

GEML never interprets a diagram body; it routes it to a pluggable renderer (an unknown `format` is a warning, body preserved):

```
=== diagram {#flow format=mermaid caption="Review flow"}
graph LR
  A[Draft] --> B{Review} -->|ok| C[Publish]
===
```

```mermaid
graph LR
  A[Draft] --> B{Review} -->|ok| C[Publish]
```

A diagram can also **chart a table** — single source of truth, with the column references checked at build time and no data copied:

```
=== diagram {format=geml-chart data=#fy25 type=bar x=Segment y=FY}
===
```

*Drawn from the `#fy25` table above:*

```mermaid
xychart-beta
  title "FY by segment"
  x-axis [Cloud, Platform, Services]
  y-axis "FY"
  bar [44, 27, 16]
```

### Math

```
=== math {#gauss caption="Gaussian integral"}
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
===
```

$$\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}$$

## Human + AI, by construction

The same shape that makes GEML pleasant to read by hand is what makes it dependable under automation — not an add-on, a consequence of the design:

- **Plain text, zero rendering.** A model reads and writes `.geml` directly; what it sees *is* the document.
- **One uniform primitive.** Far less ambiguity to generate or parse than Markdown's special cases — and far fewer malformed-output edge cases.
- **Build-time reference checking.** A broken cross-reference is a hard error, so automated edits are reliable instead of quietly rotting.
- **Structured content stays textual.** Tables, math, diagrams, and metadata are first-class *and* still plain text — an agent manipulates them without leaving the text modality or emitting HTML.
- **Machine-checkable feedback.** The parser emits a document-model JSON with `diagnostics`, so agents and CI get structured pass/fail signals.

## Ecosystem

- **Reference parser + CLI** — [`geml-parser/`](geml-parser/) (TypeScript / Node 22). Parses a document to **document-model JSON** and exits non-zero on errors.
  ```sh
  cd geml-parser && npm install && npm run build
  node dist/geml.js ../GEML-spec.geml      # parse → JSON (+ diagnostics)
  npm test
  ```
- **Markdown → GEML converter** — `node dist/geml.js convert <file.md> [-o out.geml]`. Maps frontmatter → `meta`, fenced code → `code`, ` ```mermaid/graphviz/… ` → `diagram`, `$$` → `math`, blockquote → `note`, GFM tables → `table`, footnotes, autolinks, and setext → ATX.
- **Browser extension** — [`geml-viewer/`](geml-viewer/) renders `.geml` locally (`file://`) and on the web: tables with computed columns, `geml-chart` as inline SVG, Mermaid diagrams, KaTeX math, and the build-time diagnostics shown as a banner.
- **Versioned history** — `geml history <commit | verify | show | restore> <file.geml>` over the self-contained [`.gemlhistory`](GEML-history-spec.md) sidecar.

## Status, scope & contributing

GEML is **`1.0-draft`** — stable enough to write real documents in (this repo's own spec is one), with refinement expected before 1.0.

**Maturity signals.** A complete core spec (§1–§8) plus a history-extension spec, both EN / 中文; a working reference parser + CLI; a **79-check** conformance suite (including an element-rich kitchen-sink fixture and a real-world Markdown document); and **self-hosting** — [`GEML-spec.geml`](GEML-spec.geml) is the specification written in GEML, parsed clean on every test run.

**Design boundaries (non-goals).** GEML stays small on purpose:

- **No raw-HTML escape hatch** — semantics stay portable, tied to no backend or renderer.
- **Hosts external diagram DSLs** (Mermaid, Graphviz, D2, …) rather than inventing one.
- **Tables compute, but aren't a spreadsheet engine** — per-row formulas and summary aggregates, not cell addressing, lookups, or macros.
- **ATX headings only** — no setext, no `---` frontmatter, no thematic-break guesswork.

**Roadmap & contributing.** The path to 1.0 is spec refinement, broader conformance coverage, and renderer/tooling integrations. Issues and pull requests are welcome; the reference parser's test suite is the contract, so changes should keep `npm test` green and the dogfood spec parsing clean.

| Document | English | 中文 |
|----------|---------|------|
| Core spec | [`GEML-spec.md`](GEML-spec.md) | [`GEML-spec_CN.md`](GEML-spec_CN.md) |
| History extension | [`GEML-history-spec.md`](GEML-history-spec.md) | [`GEML-history-spec_CN.md`](GEML-history-spec_CN.md) |

## Repository layout

```
GEML-spec.md / _CN.md            Core spec (EN / 中文)
GEML-history-spec.md / _CN.md    .gemlhistory extension (EN / 中文)
GEML-spec.geml                   The spec, written in GEML (dogfood)
GEML-spec.gemlhistory            History-format sample
COMPARISON.md / _CN.md           GEML vs other markup formats
geml-parser/                     Reference parser + CLI (TypeScript, Node 22)
geml-viewer/                     Browser extension that renders .geml
```

## License

MIT.
