# Writing GEML — one-page cheatsheet

GEML is plain text. Every structured thing is one **typed block**:

```
=== <type> {#id .class key=val}
<body>
===
```

The opening fence is **≥ 3** `=`. The **closing fence must be the same length**.
To nest a block inside a block, make the **outer fence longer**:

```
==== note
Example code:
=== code {lang=python}
print("hi")
===
====
```

**Easier — close by name.** Give a block an `#id` and close it with `=== #id`.
That closes by *name*, not by length, so you can nest with all `===` fences and
never miscount:

```
=== note {#ex}
Example code:
=== code {#snippet lang=python}
print("hi")
=== #snippet
=== #ex
```

Body modes: `code` / `diagram` / `math` / `table` / `output` are **raw**;
`note` are **parsed prose**; `meta` is one `key=val` per line.

## Metadata
```
=== meta
title = "My doc"
version = 0.1
===
```
In prose, `{{title}}` inserts a meta value (an unknown key is a build **error**).

## Headings & lists (ATX only)
```
# Title          ## Section {#explicit-id}
- bullet         1. ordered
  - nested by indentation (2 spaces)
- [ ] task       - [x] done
```

## Inline
`*em*`  `**strong**`  `` `code` ``  `~~strike~~`  `$a^2$` (inline math)
`[text](https://x)`  `[text](#id)`  `[[#id]]` (auto text)  `[^note]`  `![alt](pic.png)`
A reference to a missing id is a build **error**. Define a footnote with
`[^note]: text` on its own line, then cite it inline with `[^note]`.

## Tables
```
=== table {#fy caption="Sales" format=csv header=1 compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4" summary="Seg = 'Total'; Q1 = sum(Q1); FY = sum(FY)"}
Seg, Q1, Q2, Q3, Q4
Cloud, 1, 2, 3, 4
===
```
- The attribute object `{…}` is **one physical line** (don't wrap it).
- `compute`: `Name = expr` over `+ - * / ( )`, columns by header name (quote names
  with spaces: `'Unit Price'`) or letter `A,B,…`; `;`-separate multiple formulas;
  `[%.1f]` sets number display.
- `summary`: one foot row; each cell is a literal (`'Total'`) or an aggregate
  expression over `sum/avg/min/max/count`. A bare (non-aggregated) column is an
  **error**.
- Visual form also works: `| a | b |` rows with a `|---|` separator.

## Diagrams & charts
```
=== diagram {#flow format=mermaid caption="Flow"}
graph LR
  A --> B
===
```
Chart drawn from a table (empty body — the spec is in the attributes):
```
=== diagram {format=geml-chart data=#fy type=bar x=Seg y=FY}
===
```
`type` ∈ `bar|line|area|pie|scatter`; `x`/`y` are column names; `data=#id` must
point at a table; a typo'd column or dangling id is a build **error**.

## Math
```
=== math {#g caption="Gaussian"}
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
===
```

## Things that are build ERRORS — avoid them
- A reference / footnote / chart column / `{{meta}}` key that does not resolve.
- A duplicate `#id`.
- A block not closed by an **equal-length** fence (when nesting, the **outer**
  fence must be longer than any fence inside it).
- A `summary` cell using a column that isn't wrapped in an aggregate.
- Raw HTML (there is none in GEML).
