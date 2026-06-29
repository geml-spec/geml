---
name: geml
description: >-
  Read, author, edit, or validate GEML — the General Expressive Markup Language
  (.geml files) and its .gemlhistory versioning sidecar. Use whenever creating
  or modifying a .geml/.gemlhistory file, converting Markdown to GEML, or when
  the user mentions GEML, typed blocks, === fences, or geml-chart. Ensures the
  output parses cleanly (zero error diagnostics) against the reference parser.
---

# Writing and reading GEML correctly

GEML expresses **every** kind of structured content — code, tables, diagrams,
math, callouts, metadata — through **one** primitive: the **typed block**. It is
fully legible as plain text, has no raw-HTML escape hatch, and **validates
references at build time** (a dangling `#id` is an error, not a silent dead
link).

Always finish by **validating** (see *Validation* below). A GEML file is correct
only when the parser reports **no error diagnostics**.

## Golden rules (the things that are easy to get wrong)

1. **Fences are runs of `=` (≥3).** The closing fence MUST be a run of `=` of
   **exactly the opening length**. `=== … ===`, `==== … ====`. A shorter/longer
   run does NOT close the block.
2. **Nest with longer fences.** To embed GEML (or anything containing `===`)
   inside a block, the outer fence must be **longer** than the longest fence in
   the body: `====` wraps a body that uses `===`.
3. **Headings are ATX `#` only** (`#`…`######`). No setext (`====` underlines),
   no `---` thematic breaks, no `---` YAML frontmatter. Metadata is a `=== meta`
   block instead.
4. **Every `#id` is unique per document**, and **every reference must resolve** —
   `[t](#id)`, `[[#id]]`, `[^id]`, `other.geml#id`, chart `data=#id`, output
   `of=#id`. An unresolved reference is a build **error**.
5. **No raw HTML.** There is no `<div>`/`<!-- -->` escape hatch. Use the typed
   block or inline syntax for the effect you want (notes → `=== note`, comments
   → `%%`, hidden content → `{hidden}`).

## Typed block

```
=== <type> {#id .class key=val}
<body>
===
```

The **type** decides how the body is read (the *body mode*):

- `raw` (verbatim): `code`, `diagram`, `table`, `math`, `output`
- `flow` (parsed prose with inline markup): `note`, `aside`
- `data` (one `key=val` per line): `meta`

An **unknown type** is a warning (body kept raw) — prefer the registered types.

### Attribute object `{#id .class key=val}`

- `#id` — unique anchor for references.
- `.class` — a *semantic* label (no styling implied).
- `key=val` — typed: quoted `"…"` = string; `true`/`false` = bool; integer/float
  syntax = number; any other bare word = string. A **bare word with no `=` is a
  boolean flag set to true** (e.g. `hidden`).
- Order is insignificant; recommended `#id`, then `.class`, then `key=val`.

### Examples of each block

```
=== meta
title = "Budget plan"
version = "1.0-draft"
===

=== code {#hello lang=python}
print("hi")
===

=== note {.warning}
Back up before upgrading.        (flow body — inline markup works here)
===

=== math {#gauss caption="Gaussian integral"}
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
===

=== diagram {#flow format=mermaid caption="Review flow"}
graph LR
  A[Draft] --> B{Review} -->|ok| C[Publish]
===
```

`diagram` hosts an external DSL (`mermaid`, `graphviz`, `dot`, `d2`, `plantuml`,
`geml-chart`); the processor never interprets the body. An unknown `format` is a
warning.

## Tables (`=== table`) — two bodies, one model

Visual (pipe) form, or data form (`format=csv`/`tsv`). Both parse to the same
model.

```
=== table {#budget caption="Annual cost"}
| Plan  | Months | Rate |
|-------|-------:|-----:|
| Basic |      1 |   30 |
===

=== table {#fy25 format=csv header=1 compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4" summary="Segment = 'Total'; FY [%.1f] = sum(FY)"}
Segment,  Q1, Q2, Q3, Q4
Cloud,     8, 10, 12, 14
===
```

- `compute="Name = expr; Name2 = expr2"` — per-row formulas over columns (by
  header name, or single letter `A`,`B`,…), operators `+ - * / ( )`. Reference an
  earlier computed column by name. Quote names with spaces: `'Unit Price'`.
- Aggregates `sum|avg|min|max|count` (e.g. `sum(FY)`) — for the `summary=` foot
  row. A bare (non-aggregated) column ref in `summary` is an error.
- A trailing `[printf]` on a name sets numeric display: `FY [%.1f]`, `P [%.1f%%]`.
- Merge cells with `span="r2c1:2x1"`.

### Charts (`geml-chart`) — render a table, don't copy it

```
=== diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY}
===
```

`data=#id` must point at a `table` block (single source of truth); the column
refs (`x`, `y`, …) are checked. `type ∈ {bar,line,area,scatter}`. The body is
empty (the spec lives in attributes).

## Inline markup (inside flow blocks only)

`*emphasis*` · `**strong**` · `` `code` `` · `~~strike~~` · `$inline math$`

- Link: `[text](https://…)` · internal ref `[text](#id)` · auto-ref `[[#id]]`
  (link text from the target's caption/heading) · footnote `[^id]`.
- Media embed: `![alt](clip.mp4)` — kind (image/audio/video) inferred from the
  extension; renders/plays in place (a link navigates, an embed does not).
- Hard line break: trailing `\`. Escape punctuation with `\`.
- Lists: `- item` / `1. item`. **Task list**: `- [ ] open` / `- [x] done`.

## Hidden, comments, interpolation, output

- **`%%` line** — a hidden, raw, never-rendered note (TODO/review remark). Kept
  in the model (tools can find it) but NOT inline-parsed, so a scratch note can't
  break the build. Line-start only.
- **`{hidden}` block** — present in the model and **fully reference-checked**, but
  not rendered. Use it for a source table that only feeds a chart:
  `=== table {#fy25 hidden …}`.
- **`{{key}}`** in flow text is replaced with the matching `=== meta` value;
  an unknown key is a build **error** (single source of truth).
- **`=== output {of=#codeId}`** stores a code block's captured result (raw,
  **never executed** by GEML). `of=#id` is reference-checked. Gives a plain-text,
  diff-able, versionable notebook (code + result together).

## Validation (do this every time)

Validate with the `geml` CLI — it **exits non-zero on any error**, so it is a
hard pass/fail signal. Prefer `check`: it prints only diagnostics (not the whole
document-model JSON), which is cheap on context.

```sh
geml check path/to/file.geml          # diagnostics + exit code only
geml check --json path/to/file.geml   # machine-readable: a diagnostics array, or {"error":…} on an IO/usage failure
```

A file is correct only when `check` **exits 0** (no `severity:"error"`
diagnostics). Warnings (unknown block type / unknown diagram format / unchecked
cross-doc ref) are acceptable but worth reviewing.

Other commands (all accept `-` to read from stdin):

```sh
geml path/to/file.geml                # full document-model JSON (for inspection)
geml render  file.geml -o out.html    # one self-contained, interactive HTML file
geml export  file.geml -o out.md      # project to GitHub-Flavored Markdown (lossy; loss notes on stderr)
geml convert input.md  -o out.geml    # Markdown -> GEML
geml fmt     file.geml                # canonical re-format (idempotent)
```

If `geml` is not on PATH, install it once with `npm i -g geml-cli` (the package
is `geml-cli`; the command it installs is `geml`). From a clone of
this repo instead: `cd geml-parser && npm install && npm run build && npm link`.
Last-resort fallback without an install: `node <path>/geml-parser/dist/geml.js
<args>`. If no parser is reachable at all, still follow the *Golden rules* above
and ask to validate once it is present.

## Authoring checklist

- [ ] Every closing fence length equals its opening fence.
- [ ] Bodies containing `===` are wrapped in a longer fence.
- [ ] Headings are ATX `#`; metadata is a `=== meta` block (no frontmatter).
- [ ] All ids unique; all `#id` / `[[#id]]` / `[^id]` / `data=#id` / `of=#id`
      references resolve.
- [ ] `{{key}}` keys exist in `=== meta`.
- [ ] No raw HTML; comments use `%%`, hidden content uses `{hidden}`.
- [ ] Validated: parser reports zero error diagnostics.

## Reference

Full normative spec (in this repo): `GEML-spec.md` (English), `GEML-spec_CN.md`
(中文). History sidecar: `GEML-history-spec.md`. The spec is itself written in
GEML: `GEML-spec.geml` (dogfood).
