# GEML — General Expressive Markup Language

*English | [中文](README_CN.md)*

**A plain-text markup language where one primitive expresses everything structured.**

> Status: `1.0-draft`
> Spec: [English](GEML-spec.md) · [中文](GEML-spec_CN.md)

---

GEML is a markup language for structured, expressive documents. A `.geml` file is **fully legible as plain text** — you never need a renderer to read it. And instead of bolting on a different mini-syntax for every kind of content, GEML has exactly **one** construct that carries them all: the **typed block**.

```
=== code {#hello lang=python}
print("hi")
===
```

That's a block. Code is a block. So are tables, diagrams, math, callouts, and even document metadata. Same shape, every time.

## Why GEML?

- **Read it without rendering.** No HTML, no hidden semantics. What you see in the file *is* the document.
- **One primitive for everything.** Code, tables, diagrams, math, notes, metadata — all the same typed block. No per-content grammar to memorize.
- **Stable ids, checked at build time.** Put an `#id` on any block and reference it anywhere. A broken link or dangling reference is a build **error**, not a silent 404.
- **Hosts external diagram DSLs.** Mermaid, Graphviz, D2, PlantUML — GEML routes the body to a pluggable renderer instead of inventing its own diagram language.
- **No raw-HTML escape hatch.** Semantics aren't tied to any backend or renderer.
- **No syntax ambiguity.** Headings are ATX `#` only — no setext, no `---` frontmatter quirks, no thematic-break guesswork.

### Markdown vs. GEML

Markdown is wonderful, and GEML owes it a great deal. But Markdown grows by *addition*: a new syntax for each new need, plus renderer-specific extensions and an HTML fallback for everything else.

| | Markdown | GEML |
|---|---|---|
| Structured content | A different syntax per feature (+ HTML) | One typed block for all of it |
| Metadata | `---` YAML frontmatter (convention) | A native `=== meta` block |
| References | Manual anchors; broken links fail silently | `#id` refs, **checked at build time** |
| Diagrams | Fenced + renderer-specific magic | A `diagram` block hosting any DSL |
| Raw HTML | Common escape hatch | None — semantics stay portable |
| Headings | ATX *and* setext | ATX `#` only |

For a fuller picture across **Markdown, HTML, CommonMark, AsciiDoc, and Org-mode**, see the [format comparison](COMPARISON.md).

## The format in 5 minutes

### Typed blocks

A run of `=` (three or more) opens a block; an **equal-length** run closes it. Longer fences nest inside shorter ones.

```
=== note {#welcome}
This is parsed prose. You can use *emphasis* and `code` here.
===
```

The word after the fence is the **type**. The type decides how the body is read:

| Mode | Body is read as… | Types |
|------|------------------|-------|
| `raw` | verbatim, untouched | `code`, `diagram`, `math`, `table` |
| `flow` | parsed prose with inline markup | `note`, `aside` |
| `data` | one `key=val` per line | `meta` |

### Attributes

Every block can carry an attribute object: `{#id .class key=val}`.

- `#id` — unique per document; the anchor for references.
- `.class` — a *semantic* label, never a styling hook.
- `key=val` — typed values: quoted text is a string, `true`/`false` is a bool, number syntax is a number, anything else is a string.

### Metadata is just a block

```
=== meta
title = "Budget plan"
version = 0.1
===
```

### Inline markup (inside `flow` blocks)

`*emphasis*` · `**strong**` · `` `code` `` · `~~strike~~` · `$inline math$`

- Links: `[text](https://example.com)`
- Internal reference: `[text](#budget)`
- Auto-reference: `[[#budget]]` — link text is pulled from the target's caption or heading
- Media embed: `![alt](clip.mp4)` — kind (image / audio / video) is inferred from the extension
- Footnote: `[^note]`

If an `#id`, a `[^id]`, or a cross-document reference doesn't resolve, the build **fails**. No dangling references survive.

### Tables — two bodies, one model

Write a table visually:

```
=== table {#budget caption="Annual cost"}
| Plan  | Months | Rate |
|-------|-------:|-----:|
| Basic |      1 |   30 |
===
```

…or as data, with **computed columns** and a **summary row**:

```
=== table {#fy format=csv header=1 compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4" summary="Segment = 'Total'; FY = sum(FY)"}
Segment, Q1, Q2, Q3, Q4
Cloud,   1,  2,  3,  4
===
```

`compute` runs `+ - * / ( )` per row over columns (by header name or letter); `summary` adds one foot row built from the aggregates `sum / avg / min / max / count` (with arithmetic over them, e.g. weighted ratios). A trailing `[printf]` like `[%.1f]` or `[%.1f%%]` sets numeric display. Merge cells with `span="r2c1:2x1"`. Both forms describe the same table model.

### Diagrams — bring your own DSL

GEML never interprets a diagram body; it routes it to a pluggable renderer. An unknown `format` is a warning, and the body is preserved as-is.

```
=== diagram {#flow format=mermaid caption="Review flow"}
graph LR
  A[Draft] --> B{Review} -->|ok| C[Publish]
===
```

A diagram can also **draw a table**: `=== diagram {format=geml-chart data=#fy25 type=bar x=Segment y=FY}` binds to table `#fy25` (single source of truth) and validates the column references at build time. Complex charts fall back to a hosted DSL like `format=vega-lite` with the spec in the body.

### Math

```
=== math {#steady caption="Steady state"}
y^* = a / k
===
```

## Built for AI and agents

GEML is unusually friendly to LLMs and automated tooling — not by adding AI features, but because of how the format is shaped.

- **Plain text, zero rendering.** A model reads and writes `.geml` directly. What it sees is the document — no rendered layer to reconstruct.
- **One uniform primitive.** Instead of Markdown's pile of special cases, there's a single block shape. Far less ambiguity to generate or parse correctly, and far fewer malformed-output edge cases.
- **Build-time reference checking.** When an agent makes a broken cross-reference or leaves a dangling id, the toolchain catches it as a hard error — so automated edits are reliable instead of quietly rotting.
- **Structured content stays in the text modality.** Tables, math, diagrams, and metadata are first-class *and* still plain text, so an agent can manipulate them without leaving text or emitting HTML.
- **Machine-checkable feedback.** The reference parser emits a document-model JSON with `diagnostics`, so agents and CI get structured pass/fail signals.

## Versioned & self-contained: `.gemlhistory`

A companion specification — [`GEML-history-spec.md`](GEML-history-spec.md) — adds full version history to a document **without git and without any online service**.

- **The `.geml` file holds only the current version** — the hot path stays small and clean no matter how long the history grows. A sibling `doc.gemlhistory` holds the history — the cold path, loaded only when you need it.
- History is stored as **reverse deltas from the current version** plus periodic full **keyframe** snapshots. It's **self-contained**: it always carries a tool-maintained keyframe mirroring the committed current version.
- So you can **reconstruct any past revision** or **roll the live file back** with the history file alone — offline, no git, no service. The history travels with the document as a plain-text sibling, survives copying and forwarding, and is self-describing.
- **SHA-256** content hashing for integrity, and chronologically sortable revision ids (`<timestamp>-<short-hash>`).
- **Graceful degradation.** If the history file is ever lost, the current document is still fully intact in `.geml`.
- **AI-readable.** History is plain text, block-keyed, with a human-readable `summary` per revision, so an agent can read it to understand *how and why* a document evolved. (Agents should call the history **tool** to commit, reconstruct, verify, or roll back — not hand-write patches or hashes.)
- **No new grammar.** Versioning rides on the same typed-block primitive; a plain GEML tool still renders the `.geml` fine.

## Reference parser & CLI

A working reference parser and CLI live in [`geml-parser/`](geml-parser/) — TypeScript, Node 22. It covers spec §3–§8 and ships a test suite of 59 checks (including an element-rich kitchen-sink fixture and a real-world Markdown document).

```sh
cd geml-parser
npm install
npm run build
node dist/geml.js ../GEML-spec.geml      # parse → document-model JSON
node dist/geml.js convert ../some.md -o out.geml
npm test
```

`node dist/geml.js <file.geml>` parses a document to the **document-model JSON** and exits non-zero if there are errors.

### Markdown → GEML converter

Already have Markdown? Convert it:

```sh
node dist/geml.js convert <file.md> [-o out.geml]
```

The converter maps:

- YAML frontmatter → `=== meta`
- Fenced code → `=== code {lang=…}`
- ` ```mermaid / graphviz / dot / d2 / plantuml ` → `=== diagram {format=…}`
- `$$…$$` → `=== math`
- `>` blockquote → `=== note`
- GFM tables → `=== table`
- Footnote defs `[^id]:` → `=== note {#id}`
- Autolinks `<url>` → `[url](url)`
- Setext headings → ATX

It auto-assigns `#type-N` ids to converted typed blocks, infers media `as` from the file extension, and drops thematic breaks (not a GEML construct).

### History CLI

```sh
geml history <commit | verify | show | restore> <file.geml>
```

## Status & spec

GEML is at **`1.0-draft`**. The format is stable enough to write real documents in — this repo's own spec is written in GEML — but expect refinement before the final 1.0.

| Document | English | 中文 |
|----------|---------|------|
| Core spec | [`GEML-spec.md`](GEML-spec.md) | [`GEML-spec_CN.md`](GEML-spec_CN.md) |
| History extension | [`GEML-history-spec.md`](GEML-history-spec.md) | [`GEML-history-spec_CN.md`](GEML-history-spec_CN.md) |

**Dogfood:** [`GEML-spec.geml`](GEML-spec.geml) is the spec written in GEML itself, and [`GEML-spec.gemlhistory`](GEML-spec.gemlhistory) is a sample of the history format. Conformance is exercised by the reference parser's test suite (`npm test`).

## Repository layout

```
GEML-spec.md          Core spec (English)
GEML-spec_CN.md        Core spec (中文)
GEML-history-spec.md         .gemlhistory extension (English)
GEML-history-spec_CN.md      .gemlhistory extension (中文)
GEML-spec.geml         The spec, written in GEML (dogfood)
GEML-spec.gemlhistory  History-format sample
COMPARISON.md                GEML vs other markup formats
geml-parser/                 Reference parser + CLI (TypeScript, Node 22)
```

## License

MIT.
