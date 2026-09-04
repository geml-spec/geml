---
gep: 0012
title: Register a `view` typed block — selection, derivation and aggregation of another relation
state: draft
author: GEML (maintainer)
created: 2026-09-03
issue: (pending)
---

## Summary

Register `view`: a block with no body that names another relation and says what
it takes from it.

```geml
=== view {#open src=#tickets where="Status = 'open'" order="Age desc" limit=3 select="Id, Age"}
===

=== view {#per-area src=#tickets by="Area" aggregate="Open = count(Id); Days = sum(Age)"}
===
```

`table` keeps what it always was — a grid of facts written in the document, or
loaded from a data **file** — and hands over everything derived: `compute=` and
`summary=` move here, and so does a `src=` that names a **block** (`#id`,
`other.geml#id`), which is by definition another block's output.

Three attribute families, one block:

| family | attributes |
|---|---|
| selection | `where=`, `order=`, `limit=`, `select=` |
| derivation | `compute=`, `summary=` |
| aggregation | `by=`, `aggregate=` |

`HAVING` and `DISTINCT` need no vocabulary of their own: a grouping view's
tuples ARE its groups, so filtering them is a `where=` on the view that consumes
it, and the distinct values of a column are `by=` with nothing aggregated.

## Motivation

Real documents want a subset, a total, a ranking, a roll-up. Today a document
has two options, and both are bad: embed the whole table and let the reader
scan, or copy the rows in by hand and watch them drift from the source — the
one failure this project exists to prevent.

### Why a block, and not attributes on `table`

The first draft of this GEP put `where=`/`order=`/`limit=`/`select=` on `table`.
Weighing them by what a processor that does NOT implement them shows the reader
is what moved them:

| written | ignored, the reader sees | over-shows? |
|---|---|---|
| `where=` | every row, including the ones the author excluded | **yes** |
| `select=` | every column, including the ones dropped | **yes** |
| `limit=` | every row rather than the first *n* | **yes**, and unbounded |
| `order=` | the same rows in source order | no — complete and honest |

Appendix A makes an unknown attribute a **warning**, and nothing in §8 stops the
block from rendering: three of those four therefore over-show, and over-showing
is not a degraded render but a false one. An unknown block `type` degrades
differently — §8.2(6) keeps the body verbatim, and a `view`'s body is empty, so
a processor that does not implement it shows **nothing**. For semantics that
decide what may be shown at all, that is the only honest direction.

`part=` looks like a counter-example and is not: it narrows a transclusion of
one target, so over-showing means more of the same section. `where=` and
`select=` carry an author's decision about what may appear at all.

### What belongs on a block, and what does not

Three questions, asked in order. Failing the first is *never*; failing the
second means *a different block*; passing all three with no demonstrated need is
*not yet*.

1. **Does it read exactly one source?** §6 already says a table has one source,
   always. An attribute that introduces a second one would also make this
   document's validity depend on another document's schema — rename a column
   there and a document here stops parsing. → `join` / `on`: **never**.
2. **Does it act per tuple?** It may drop tuples, reorder them, and narrow or
   extend each tuple's columns. It may **not** fold several tuples into one:
   what comes out of a fold is a *different relation*, and a different relation
   is a block rather than an attribute. → `group by` / `having` / `distinct`:
   this block, through `by=`/`aggregate=` and a chained view.
3. **Can it be checked against the declaration in front of you?** `where=`,
   `order=` and `select=` name columns of the relation the block already has.
   A join's columns could only be checked by resolving something else, which is
   question 1 again.

`summary=` is the one attribute that fails question 2 and stays anyway: it adds
an aggregate row. Its exceptional status is visible everywhere it appears — it
does not cross a `src=` boundary, it needs a reserved row name to be addressed
([GEP 0011](0011-inner-unit-coordinates.md)), it must target a column that
survived `select=`, and it is edited in the attribute rather than in a body.
Those four special cases are one root cause, written down.

## Design

### The block

`view` takes **no body** and a **required `src=`**, which may name a data file
(`rows.csv`), a block in this document (`#tickets`), or a block in another
(`other.geml#tickets`) — §6's three targets, unchanged. A body alongside `src=`
is an error, as it already is for `table`.

`table` keeps `format=`, `delim=`, `header=`, `caption=`, its body, and a `src=`
that names a **data file**. A `table` whose `src=` names a block is an error
pointing at `view`: a block target is another block's output, and a table that
borrows it would be a block of "facts" whose content someone else derived.

The split is by what `src=` points at, which is a property of the value rather
than of the author's intention — so it is decidable, and "a `table` is facts"
stays true.

### Selection

- `where="<expr>"` — the rows to keep.
- `order="<key>[ asc|desc][, …]"` — comma-separated keys, `asc` the default.
  The sort is **stable**: ties keep source order, which is what makes `limit=`
  reproducible. Direction is spelled `asc`/`desc`, never `+`/`-`: `-` is already
  the arithmetic minus over these same columns, and one token cannot mean
  "negate" in one attribute and "descending" in another. It also leaves room for
  `order="sum(FY) desc"` later, where `-sum(FY)` would be unreadable.
- `limit=<n>` — the first *n* rows after ordering; without `order=`, the first
  *n* in source order, which is still deterministic.
- `select="<column>[, …]"` — the columns to show, in the order given, so it
  reorders as well as narrows. It takes names and nothing more: an `=` inside it
  is an **error** naming `compute=`, because SQL's `SELECT` both picks columns
  and derives them while here deriving is `compute=`'s job.

### Derivation

`compute=` and `summary=` keep the grammar and behaviour §6 gave them; they
simply live here now, where the derived content is.

### Aggregation

- `by="<column>[, …]"` — the grouping keys.
- `aggregate="<name> = <fn>(<column>)[; …]"` — the group columns, in `summary=`'s
  own grammar and with its aggregates (`sum`, `avg`, `min`, `max`, `count`).

`by=` with no `aggregate=` is the distinct set of those keys. On a grouping view
`compute=` is per **input** row only — an aggregate formula there is an error
naming `aggregate=`, which is the attribute for it.

A grouping view's output columns are the `by=` keys followed by the aggregate
names, in that order.

### The expression

One expression language, extended — not a second one. `compute=` already reads
a column by header name, by letter (`A`, `B`, …), or quoted when the name has a
space (`'Unit Price'`), with `+ - * / ( )`. `where=` adds:

- comparisons `=`, `!=`, `<`, `<=`, `>`, `>=`
- `and`, `or`, `not`, and parentheses
- literals: a number, or a single-quoted string (`'open'`)

**A single-quoted run means one of two things, and position decides which.**
`compute=` already spells a column whose name has a space `'Unit Price'`, and a
filter needs `'open'` to be a string — the same lexical shape. Where a COLUMN is
expected it is a column name; where a VALUE is expected — the right of a
comparison — it is a literal. So `where="'Unit Price' > 10"` compares a column
against ten, and `where="Status = 'open'"` compares a column against a string.
There is no third position, because §4 gives an attribute value no escapes to
introduce a second quote with.

No regular expressions, no `like`, no functions beyond the aggregates. A date is
a single-quoted ISO-8601 string, which compares correctly as text.

**Types come from the cell, as they already do.** The table model records a
cell's numeric value when the cell is or becomes a number; a numeric comparison
uses that, a string comparison uses the cell's text.

- A column named in `where=` that does not exist is an **error** — the same typo
  `compute=` already catches, and the guard that keeps a mistyped literal from
  silently emptying a view.
- A column that holds **no** numeric value in any row, compared against a
  number, is an **error**: that is a mistake in the expression, not dirty data.
- A single non-numeric cell in an otherwise numeric column simply does not
  match. No diagnostic: data from `src=` is allowed to be imperfect.

### Evaluation order

The load-bearing sentence, and it is **SQL's logical processing order**:

> `src` loads → `compute`'s per-row formulas → `where` filters →
> `compute`'s aggregate formulas → `by`/`aggregate` folds → `order` sorts →
> `limit` truncates → `select` narrows → `summary` aggregates.

| GEML | SQL |
|---|---|
| `src=` | `FROM` |
| `where=` | `WHERE` |
| `compute=` | the `SELECT` list's derived columns |
| `by=` / `aggregate=` | `GROUP BY` and its aggregate list |
| `order=` | `ORDER BY` |
| `limit=` | `LIMIT` |
| `select=` | the `SELECT` list's projection |
| `summary=` | — a report row; see the deviations |

**`compute=` runs in two passes, and the split is not arbitrary.** A formula
that reads only its own row can be evaluated before anything is dropped, so
`where=` may name the column it produces: `where="FY > 40"` works with `FY`
defined in the same block. A formula that reads an **aggregate** cannot — its
value depends on which rows survive the filter, so filtering on it would be
circular. That one case is refused, and the diagnostic names the formula that
made it circular rather than blaming the reference.

The reward is that every aggregate means one thing: `sum(FY)` in `compute=` and
in `summary=` are both over the rows that are **shown**. One pass before the
filter and the same `sum(FY)` would silently mean two different numbers in two
attributes of one block.

This is a deliberate departure from SQL, where a `SELECT` alias is invisible to
`WHERE` and the author repeats the expression instead. A document's table is
small and its author's model is a spreadsheet, not a query planner.

**Projection runs late, and that is the point.** SQL evaluates its `SELECT` list
before `ORDER BY` yet still lets `ORDER BY` name a base column that was not
projected. Running `select=` after `order=` and `limit=` buys the same freedom
without a second scope rule: every reference in `where=`, `compute=` and
`order=` stays valid whether or not the column is shown.

**`summary=` runs last**, after `select=`, where SQL would aggregate before
`SELECT` and `ORDER BY`. It is a report row over the rows actually shown, so
`summary="Total = sum(FY)"` totals what the reader sees — and it must target a
column that survived `select=`, since a dropped column has no cell to render it
in.

**Filtering groups is the next view, not a keyword.** On a grouping view
`where=` filters the input rows, exactly as SQL's `WHERE` precedes `GROUP BY`.
To filter the groups themselves — SQL's `HAVING` — consume this view from
another one: `=== view {#busy src=#by-area where="Open > 3"}`. A grouping view's
tuples are its groups, so that is the same `where=` doing the same per-tuple
job, one relation later.

### What a view sees

A `src=` naming another block takes that block's **tuples together with the
columns it computes**. Derivation is encapsulated: the source publishes a
relation, and a reader depends on its column names rather than on how they were
produced. That is also the safer direction — re-deriving `FY` in every consumer
is how one formula becomes several that disagree, while a renamed or dropped
source column fails the build loudly.

A source's `summary=` row does **not** cross. `compute=` extends each tuple, so
the result is the same shape of relation; an aggregate row is a different
relation stacked underneath, and a block carrying one is a report rather than a
relation. Consuming a report is what would put a total among the rows a filter
then filters. A view that wants its own total declares `summary=`; one that wants
*the source's* total addresses it — `A.geml#fy[summary]["FY"]`
([GEP 0011](0011-inner-unit-coordinates.md)).

**Shadowing is allowed, and warned about.** `compute="FY = …"` in a view whose
source already publishes `FY` is legal: the left of the `=` names this block's
output column while the right reads the source's, the same way `SELECT a+1 AS a`
is legal SQL. It earns a `shadowed-source-column` **warning**, because the
column then renders a different number than the source publishes under that
name — and because a block's own definition is in force from the first pass on,
the source's `FY` is not reachable anywhere in this block. Give the new column
its own name when you need both.

### Chaining, and the cycle it must not close

A view may be another view's `src=`: a view of a view is just a source that
happens to be declared, and it is how `HAVING`, a re-sort, or a second
projection are spelled. What that admits is a dependency chain, and it has to
terminate. A `src=` that resolves — directly, or through any number of
intermediate blocks — back to where it started is an **error** naming the cycle,
and the depth of a legal chain is bounded exactly as a nested `embed`'s is
(§9.3): the same shape of resolution, so deliberately the same argument.

### What does not change

- **No rows match** is not an error. "No open tickets" is a legitimate state:
  the view renders its header and an empty body. The unknown-column error is
  what catches the typo that would otherwise empty it silently.
- **Coordinates do not move.** [GEP 0011](0011-inner-unit-coordinates.md)
  addresses a block's own rows, and a view has none in its source, so a
  coordinate on one reads and never writes — the same rule, and now the only
  one, since a `table` no longer carries computed columns or borrowed rows.
- **Cost is bounded**: one pass over the loaded rows per term, no recursion, and
  the aggregates run on fewer rows than they were given.

## A worked example

A source that carries its own derivation — the shape a view has to reckon with:

```geml
=== table {#fy caption="FY25 by segment" format=csv header=1}
Segment, Area, Q1, Q2
Cloud, infra, 8, 10
Edge, infra, 3, 4
Support, ops, 1, 1
===
```

**Which rows, in what order, how many, and which columns.**

```geml
=== view {#big src=#fy compute="FY [%.1f] = Q1 + Q2" where="FY > 5" order="FY desc" select="Segment, FY" summary="Segment = 'Shown'; FY [%.1f] = sum(FY)"}
===
```

| Segment | FY |
| --- | --- |
| Cloud | 18.0 |
| Edge | 7.0 |
| **Shown** | **25.0** |

`where="FY > 5"` names a column this very block computes, which is legal because
a per-row formula is evaluated before anything is dropped. Had `FY` been
`sum(Q1) / 2`, filtering on it would have been circular and refused.

**A roll-up, and then a filter on its groups.**

```geml
=== view {#by-area src=#fy by="Area" aggregate="Segments = count(Segment); Q1 = sum(Q1)"}
===

=== view {#busy src=#by-area where="Segments > 1"}
===
```

| Area | Segments | Q1 |
| --- | --- | --- |
| infra | 2 | 11 |
| ops | 1 | 1 |

…and `#busy` keeps the `infra` row alone. That second block is `HAVING`, spelled
as what it is: a per-tuple filter on a relation whose tuples are groups.

**At a glance**, written in a view whose source publishes `FY`:

| written | verdict |
|---|---|
| `where="FY > 10"` | ✅ a column the source publishes |
| `where="Weeks > 2"`, with `compute="Weeks [%.1f] = Q1 / 4"` | ✅ a per-row column exists before the filter |
| `where="Share > 0.1"`, with `compute="Share = FY / sum(FY)"` | ❌ circular: an aggregate depends on what the filter kept |
| `order="Weeks desc"` | ✅ any computed column, aggregate or not |
| `compute="FY [%.1f] = Q1 + Q2"` over a source publishing `FY` | ⚠ legal, `shadowed-source-column` |
| `compute="Total = sum(Q1)"` on a block with `by=` | ❌ that is what `aggregate=` is for |
| `select="FY = Q1 + Q2"` | ❌ names columns only — an `=` points at `compute=` |
| `#big[1]["FY"]` | ❌ a view has no bytes to address ([GEP 0011](0011-inner-unit-coordinates.md)) |
| `=== table {src=#fy}` | ❌ a block target is another block's output — use `view` |

*The rendered tables above are drawn by hand:* none of this is implemented yet.

## Conformance impact

- §3's registry gains `view`, with **no body** (a body alongside `src=` is an
  error) — the registry is open, and a type that produces model content cannot
  be admitted by a vocabulary (§8.6.1 rule 4), so it takes a GEP.
- §6 loses `compute=` and `summary=` to `view`, and keeps a `src=` that names a
  data file; a `table` whose `src=` names a block becomes an error.
- Appendix A gains: `shadowed-source-column` (**warning**), and errors for a
  circular filter, an aggregate formula in `compute=` on a grouping view, an
  `=` inside `select=`, a `summary=` targeting a projected-away column, a
  `table` whose `src=` names a block, and a `src=` chain that closes a cycle.
- §8.3 gains nothing. A processor that does not implement `view` keeps its
  (empty) body verbatim and warns, per §8.2(6) — which is exactly why these
  semantics live on a type rather than on attributes.
- **The conformance suite** gains cases for: each operator, `and`/`or`/`not`
  precedence, a quoted column name against a quoted literal, an unknown column
  (error), a numeric comparison against a text-only column (error), a
  non-numeric cell in a numeric column (no match, no diagnostic), `asc` as the
  default, a stable sort under ties, `limit=` without `order=`, `where=` naming
  a per-row computed column (fine) and an aggregate-derived one (error),
  `sum()` agreeing between `compute=` and `summary=`, `select=` narrowing and
  reordering, `summary=` targeting a projected-away column (error), a source's
  `summary=` row not crossing, a shadowed source column (warning), `by=` with
  and without `aggregate=`, `where=` on a grouping view filtering input rows,
  a two-view chain, and a chain that closes a cycle.

## Alternatives considered

**Keep the attributes on `table`.** The first draft did. Rejected on the
degradation weighing above: three of the four over-show when unimplemented, and
an unknown attribute is a warning that does not stop the block from rendering.

**`table` keeps `src=` for block targets too.** Rejected: `src=#a` may name a
view, so a block of "facts" would carry columns someone else derived — which is
the whole thing the split exists to prevent. Splitting `src=` by what it points
at keeps the rule decidable and the fact block honest.

**Express a table as `data {format=csv}` and drop `table`.** Rejected, and not
narrowly: a table's cells are **inline content** — `` `code` ``, emphasis and
`[[#ref]]` work inside them and references inside them are build-checked — while
a `data` body is raw text a format engine parses into scalars, where a backtick
stays a backtick. GEP 0008's two trial forms measured exactly this. Alignment
has no place in a value tree either, `csv` is not a `data` format, and a `data`
block taught to render a grid with header names and alignment would BE `table`.

**A profile (`geml-query/v1`) instead of a core type.** Rejected: §8.6.1 rule 4
forbids a vocabulary from changing the document model, and folding rows or
adding a computed column is model content — the same reason `compute=` could not
move to a profile.

**The attributes on `embed`.** Rejected: an embed's target is any block, so the
validity of `where=` would depend on what another document's block happens to
be, and an inapplicable embed attribute is currently ignored in silence.

**Prefixed attribute names** (`query-where=`). Rejected: §8.5 reserves
unhyphenated names for this specification and recommends a hyphen for everything
outside it, so a prefix would read as an extension's key. Attribute names are
already scoped by their block type.

**`pivot` as the name.** Reserved, not used: in spreadsheet usage a pivot is a
two-dimensional cross-tab (rows × columns × values), and `by=`/`aggregate=` is
one-dimensional. Naming this one `pivot` would over-promise exactly as
`select=` would have if it also derived columns. The name stays free for the
2-D form.

**A `materialize` attribute, settling a view into a table.** The need is real —
the values become bytes: diffable, readable with no processor, writable by
coordinate (a table cell always is, a view never), and still there when the
source is not. But an attribute would mean rendering rewrites the document: a
side effect at render time, no longer idempotent, and against both §9.1 and a
renderer that must not modify its input. So it is a tool verb —
`geml materialize <file> '#view'` replacing the block with a `table` and its
computed rows — and if the result should keep saying where it came from, that
is [GEP 0006](0006-declared-projections.md)'s declared-projection machinery,
which can then report a snapshot whose source has moved on.

**`join` / `on`, and `offset`.** The first fails question 1 above and is
*never*: join upstream and point `src=` at the result. `offset` passes all three
questions and is *not yet* — `order=` plus `limit=` covers what the documented
cases ask for, and paging has no meaning in a rendered document until someone
shows one.

## Compatibility & migration

`view` is a new type, so no conforming document changes meaning by its
existence. Moving `compute=`/`summary=` and block-target `src=` off `table`
does: those are `final` in §6, and this is a breaking change to them.

The migration surface, measured: `README.md` and `README_CN.md` carry one
example each, six copies of the packaged skill reference carry the same one,
`geml-parser/bench/SKILL.md` and `integrations/langchain+llamaindex/proposal.geml`
one apiece, plus §6's own prose, the two CommonMark comparison tables, the GEML
copy under `spec/in_geml_format/`, and the parser's table suites. No document in
this repository uses a `table` whose `src=` names a block — the three occurrences
are this proposal's own examples.

Nothing is kept compatible: GEML is not adopted widely enough yet to owe an old
spelling a bridge.

## Drawbacks & open questions

- **A total now costs two blocks.** The facts, then the view that sums them.
  This is the real ergonomic price of the split, and no argument removes it —
  only the fact that a view is one line.
- **Typed columns.** Comparison leans on "the cell is or becomes a number", and
  dates work by ISO-8601 string ordering, which is a convention rather than a
  check. A per-column `type=` would make both explicit.
- **An empty result is silent.** The unknown-column error catches most typos,
  but a wrong literal (`'Open'` for `'open'`) still yields an empty view with no
  complaint.
- **Where missing values sort.** SQL says `nulls last`; this draft says nothing,
  and whatever it says has to agree with the rule that a non-numeric cell in a
  numeric column does not match.
- **The cost of two `compute=` passes.** Splitting formulas by whether they read
  an aggregate is a rule an author never states and can still trip over: adding
  `sum()` to a formula moves it to the later pass, and a `where=` that named its
  column stops resolving. The diagnostic has to explain that, not merely refuse.
- **Should `table` lose `src=` entirely?** A data file is external facts, which
  is why it stays. If a later proposal gives `view` a better story for plain
  external data — its degradation shows nothing where a `table` shows a
  placeholder — the file target could follow the block target out.
