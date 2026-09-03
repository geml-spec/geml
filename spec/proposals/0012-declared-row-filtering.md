---
gep: 0012
title: Declared row selection — `where=`, `order=` and `limit=` on the table that consumes the data
state: draft
author: GEML (maintainer)
created: 2026-09-03
issue: (pending)
---

## Summary

A table that draws its rows from elsewhere may declare **which** rows it takes:

```geml
=== table {#open src=#fy where="FY > 10"}
===
```

The source may equally sit in another document (`src=other.geml#tickets`) or in
a plain file (`src=tickets.csv`) — §6's three targets, unchanged.

The filter is an attribute of the **consuming** block. It is not part of an
address, and it is not in the source document — so an address stays
single-valued ([GEP 0011](0011-inner-unit-coordinates.md)) and a source stays
unaware of who reads it.

`order=` and `limit=` come with it, because the useful form of a subset is
usually "the top two", not "the ones that match":

```geml
=== table {#top src=#fy where="FY > 10" order="FY desc" limit=2}
===
```

The three extend the expression language the format already has: `compute=`
parses column references and arithmetic, `summary=` adds aggregates, and this
GEP adds comparison and boolean operators over the same column namespace.

A processor that does not implement them renders the whole source table and
warns, as §3's `part=` already does when a narrowing cannot be applied. No new
conformance obligation.

## Motivation

Real documents want a subset: the open tickets, this quarter's rows, the checks
that failed. Today a document has two options, and both are bad:

- **Embed the whole table** and let the reader scan for the rows that matter.
- **Copy the rows in by hand** — which drifts from the source, the single
  failure this project exists to prevent.

Filtering does not belong in an address. [GEP 0011](0011-inner-unit-coordinates.md)
addresses *units*, and §6.2 promises that an address pastes straight back into
`get`/`set`. A filter yields 0..N rows and its result changes when the data
does: that is a result set, not an address.

It does not belong in the source either. A document that publishes a table
should not have to enumerate its readers' views, and a reader's view is exactly
what its own document can be checked for at build time.

That leaves the consuming block's attributes, where `src=`, `compute=` and
`summary=` already live.

## Design

### The attributes

`where="<expr>"`, `order="<key>[ asc|desc][, …]"` and `limit=<n>` on a `table`
block, and each **only together with a data source** (`src=`). Filtering,
reordering or truncating a table's own inline body is refused: the rows are
right there in the document, and hiding or shuffling them behind an attribute
makes the source say one thing and the render another. Edit the rows instead.

### The expression

One expression language, extended — not a second one. `compute=` already reads
a column by header name, by letter (`A`, `B`, …), or quoted when the name has a
space (`'Unit Price'`), with `+ - * / ( )`. `where=` adds:

- comparisons `=`, `!=`, `<`, `<=`, `>`, `>=`
- `and`, `or`, `not`, and parentheses
- literals: a number, or a single-quoted string (`'open'`)

`order=` takes column references from that same namespace, separated by
**commas** — each item is a plain reference, not an assignment, which is why
`compute=` and `summary=` use `;` and this does not. `asc` is the default and
may be omitted; the sort is **stable**, so ties keep source order and `limit=`
is reproducible.

Direction is spelled `asc`/`desc`, never `+`/`-`: `-` is already the arithmetic
minus over these very columns in `compute=` and `where=`, and one token cannot
mean "negate" in one attribute and "descending" in another. It also leaves room
for `order="sum(FY) desc"` later, where `-sum(FY)` would be unreadable.

`limit=<n>` takes the first *n* rows after ordering; without `order=` that is
the first *n* in source order, which is still deterministic.

No regular expressions, no `like`, no functions. A date is a single-quoted
ISO-8601 string, which compares correctly as text.

**Types come from the cell, as they already do.** The table model records a
cell's numeric `value` when the cell is or becomes a number; a numeric
comparison uses that, a string comparison uses the cell's text.

- A column named in `where=` that does not exist is an **error** — the same
  typo `compute=` already catches, and the guard that keeps a mistyped literal
  from silently emptying a table.
- A column that holds **no** numeric value in any row, compared against a
  number, is an **error**: that is a mistake in the expression, not dirty data.
- A single non-numeric cell in an otherwise numeric column simply does not
  match. No diagnostic: data from `src=` is allowed to be imperfect.

### Evaluation order

This is the load-bearing sentence of the proposal, and it is **SQL's logical
processing order**, not a new invention:

> `src` loads → `where` filters → `compute` adds columns → `order` sorts →
> `limit` truncates → `summary` aggregates.

| GEML | SQL |
|---|---|
| `src=` | `FROM` |
| `where=` | `WHERE` |
| `compute=` | the `SELECT` list's derived columns |
| `order=` | `ORDER BY` |
| `limit=` | `LIMIT` |
| `summary=` | — see the deviation below |

Two consequences follow from that order, and both are SQL's:

- **`where=` takes expressions, not aliases.** A column `compute=` defines does
  not exist yet when `where=` runs, exactly as a `SELECT` alias is invisible to
  `WHERE`. Nothing is lost: write the expression —
  `where="Q1+Q2+Q3+Q4 > 40"` rather than `where="FY > 40"`.
- **`order=` may use an alias**, because it runs after `compute=` — as
  `ORDER BY` may use a `SELECT` alias. So `order="FY desc"` is fine.

A column the **source** publishes is a different matter: it arrives with the
relation, so it is a base column here and `where=` may name it freely, computed
or not, on the far side.

**The one deliberate deviation from SQL.** `summary=` runs *last*, after
`limit=`, where SQL would aggregate before `SELECT` and `ORDER BY`. It is not a
grouped relation but a report row over the rows that are actually shown, so
`summary="Total = sum(FY)"` totals what the reader sees. `compute=` is never
evaluated for a row `where=` dropped.

### What a consumer sees

A `src=` pointing at another table takes that table's **tuples together with the
columns it computes**. Derivation is encapsulated: the source publishes a
relation, and a reader depends on its column names rather than on how they were
produced. That is also the safer direction — re-deriving `FY` in every consumer
is how one formula becomes several that disagree, whereas a renamed or dropped
source column fails the build loudly.

A source's `summary=` row does **not** cross. `compute=` extends each tuple, so
the result is still the same shape of relation; an aggregate row is a different
relation stacked underneath, and a table carrying one is a report rather than a
relation. Consuming a report is what puts a total into the rows a filter then
filters. A consumer that wants its own total declares `summary=`; a consumer
that wants *the source's* total addresses it —
`A.geml#fy[summary]["FY"]` (GEP 0011).

**Shadowing is allowed, and warned about.** `compute="FY = …"` in a consumer
whose source already publishes `FY` is legal: the left of the `=` names this
block's output column while the right reads the source's, the same way
`SELECT a+1 AS a` is legal SQL. It earns a `shadowed-source-column` **warning**,
because it is the one case where a column renders a different number than the
source publishes under that name, and the reader of the rendered table cannot
see it.

### What does not change

- **No rows match** is not an error. "No open tickets" is a legitimate state:
  the table renders with its header and an empty body. The unknown-column error
  above is what catches the typo that would otherwise empty a table silently.
- **Coordinates do not move.** [GEP 0011](0011-inner-unit-coordinates.md)
  addresses a block's own rows, and a `src=`-fed table has none in its source —
  so `#open[1]` is refused there already, for the same reason and with the same
  message. A filter changes nothing about that.
- **Cost is bounded**: one pass over the loaded rows per term, no recursion, no
  function calls (the aggregates run afterwards, on fewer rows than before).

### A worked example

A source that carries its own derivation — the shape a consumer has to reckon
with:

```geml
=== table {#fy caption="FY25 by segment" format=csv header=1 compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4" summary="Segment = 'Total'; FY [%.1f] = sum(FY)"}
Segment, Q1, Q2, Q3, Q4
Cloud, 8, 10, 12, 14
Edge, 3, 4, 4, 5
Support, 1, 1, 2, 2
===
```

| Segment | Q1 | Q2 | Q3 | Q4 | FY |
| --- | --- | --- | --- | --- | --- |
| Cloud | 8 | 10 | 12 | 14 | 44.0 |
| Edge | 3 | 4 | 4 | 5 | 16.0 |
| Support | 1 | 1 | 2 | 2 | 6.0 |
| **Total** | | | | | **66.0** |

**A consumer filtering on a column the source published.** `FY` is not this
block's to compute — it arrives with the relation, so `where=` may name it:

```geml
=== table {#big src=#fy caption="Segments above 10" where="FY > 10" order="FY desc" summary="Segment = 'Shown'; FY [%.1f] = sum(FY)"}
===
```

| Segment | Q1 | Q2 | Q3 | Q4 | FY |
| --- | --- | --- | --- | --- | --- |
| Cloud | 8 | 10 | 12 | 14 | 44.0 |
| Edge | 3 | 4 | 4 | 5 | 16.0 |
| **Shown** | | | | | **60.0** |

The source's `Total` row did not cross, which is the whole reason it must not:
had it come across, `66.0 > 10` would have passed the filter and then been
summed a second time into `Shown`.

**A consumer that derives its own column, and shadows one.** `Q1 + Q2` is the
test written as an expression, which is how a filter reaches a derived value;
`order=` then sorts by the alias, which exists by the time it runs:

```geml
=== table {#half src=#fy where="Q1 + Q2 > 12" compute="FY [%.1f] = Q1 + Q2" order="FY desc"}
===
```

| Segment | Q1 | Q2 | Q3 | Q4 | FY |
| --- | --- | --- | --- | --- | --- |
| Cloud | 8 | 10 | 12 | 14 | 18.0 |

plus a `shadowed-source-column` warning — and here is what it is warning
about: in *this* block `where="FY > 20"` would still test the source's `FY`
(44, 16, 6), not the `18.0` the block renders, because `where=` sees the
relation it was given. Same name, two values, one line apart.

**The source's total, without copying it.** `![[A.geml#fy[summary]["FY"]]]`
projects `66.0` inline, and `A.geml#fy[summary]["FY"]` is the address behind
it ([GEP 0011](0011-inner-unit-coordinates.md)). A consumer's own `summary=`
answers a different question — the total of what *it* shows.

**At a glance**, written in a consumer whose source publishes `FY`:

| written | verdict |
|---|---|
| `where="FY > 10"` | ✅ a base column here — the source publishes it |
| `where="Weeks > 2"`, with `compute="Weeks [%.1f] = Q1 / 4"` | ❌ an alias this block is still creating |
| `where="Q1 / 4 > 2"` — the same test, as an expression | ✅ |
| `order="Weeks desc"` | ✅ `order=` runs after `compute=` |
| `compute="FY [%.1f] = Q1 + Q2"` | ⚠ legal, `shadowed-source-column` |
| `#big[1]["FY"]` | ❌ no bytes in this file to address ([GEP 0011](0011-inner-unit-coordinates.md)) |
| `src=A.geml#fy` instead of `src=#fy` | ✅ identical semantics; §6's three targets are unchanged |

*The rendered tables above are drawn by hand.* None of these three attributes
is implemented: a processor today emits `unknown attribute` and renders the
source table whole, which is the degradation this GEP adopts rather than
forbids. What the example leans on *besides* those three does work today: a
consumer's own `compute=`/`summary=` apply to the rows it borrows, and the
source's `Total` row stays behind. Writing this draft is what turned up the
two bugs that used to make both wrong — a model shared with the source in the
CLI, and a viewer that fetched a `src=` carrying a `#id` as though it were a
file, inlining the whole target document.

## Conformance impact

- §6 gains the `where=` attribute, valid only alongside `src=`.
- §8.3 gains nothing. A processor that does not implement these attributes
  emits `unknown-attribute` and renders the whole source table — the behaviour
  Appendix A already prescribes for a `part=` that cannot be applied ("the whole
  target stands: a projection that quietly selects nothing is the failure §8.2
  exists to prevent"). The cost is that such a processor over-shows; making it
  refuse instead would contradict a rule the spec has already settled.
- Appendix A gains `shadowed-source-column` (**warning**): a `compute=` column
  whose name the `src=` source already publishes.
- **Parsers** gain the comparison and boolean operators in the existing
  expression parser, and one attribute check (`where=` without `src=`).
- **The conformance suite** gains cases for: each operator, `and`/`or`/`not`
  precedence, a quoted column name, an unknown column (error), a numeric
  comparison against a text-only column (error), a non-numeric cell in a
  numeric column (no match, no diagnostic), any of the three without `src=`
  (error), `summary=` aggregating post-filter rows, an empty result rendering
  cleanly, `asc` as the default, a stable sort under ties, `limit=` without
  `order=`, `order=` naming a computed column (fine), `where=` naming one
  (refused) beside the same test written as an expression (fine), `where=`
  naming a column the *source* computed (fine), a source's `summary=` row not
  crossing a `src=`, and a shadowed source column (warning).

## Alternatives considered

**A filter inside the address** (`#t[Status='open']`). Rejected: an address must
be single-valued and paste-back-able (§6.2), and a filter's result moves with
the data. This is the boundary GEP 0011 draws between addressing a unit and
querying a set.

**A view block in the source document.** Rejected: it makes the publisher
maintain its readers' views, and it puts the declaration in the document that
cannot be checked for whether the view is still wanted.

**A general query language** (`select`, joins, grouping). Rejected for now:
`where=` alone covers what the documented cases need, and every piece left out
— ordering, limits, grouping — is separable and can arrive with evidence rather
than in advance.

**`join` / `on`, and `group by` / `having`.** Not now, and for the first pair
not ever: joining two sources inside a document means a relational engine —
multiplicities, key semantics, missing values, result order — and it breaks §6's
one-source rule outright. Join upstream and point `src=` at the result.
Grouping is a pivot table, which is a block rather than an attribute; `summary=`
already covers the single total row, and `having` presupposes grouping.

**Move derivation and selection off `table` entirely** — the objection being
that a derived column is not a fact, so it does not belong in the block that
carries facts. Three routes, each refused for a mechanical reason: a profile
cannot carry `compute=`, because §8.6.1 forbids a vocabulary from changing the
model and a derived column is model content; `embed` cannot host the attributes,
because its target is any block, so validity would depend on what another
document's block happens to be — and an inapplicable embed attribute is
currently ignored in silence; and a dedicated type costs a permanent registry
entry that the remaining argument, being one of taste, does not buy.

**Do nothing; embed the whole table.** That is today's behaviour, and the reason
this GEP exists: the alternative authors actually choose is a hand-copied
subset, which drifts.

## Compatibility & migration

No conforming document changes meaning — `where=` is a new attribute, and a
table without one behaves exactly as it does today. Nothing to migrate, and
nothing to keep compatible: GEML is not adopted widely enough yet to owe an old
spelling a bridge.

## Drawbacks & open questions

- **`order=` and `limit=`.** A "top five" table needs both, and neither is here.
  They belong with this attribute rather than in an address, so the question is
  whether they land in this GEP or the next one.
- **Filtering on a computed column** inverts the stated evaluation order and is
  refused in this draft. It is the most likely follow-up, and doing it properly
  means either a two-pass model or a declared dependency order.
- **Typed columns.** Comparison leans on "the cell is or becomes a number".
  Dates work by ISO-8601 string ordering, which is a convention, not a check. A
  per-column `type=` declaration would make both explicit — a bigger change to
  §6 than this GEP wants.
- **An empty result is silent.** The unknown-column error catches most typos,
  but a wrong literal (`'Open'` for `'open'`) still yields an empty table with
  no complaint. A `where=` that matches nothing at build time could be worth a
  warning.
- **Projection.** `columns="Id, Status"` is the obvious companion, left out on
  purpose: it interacts with `compute=` and `summary=` — may a formula read a
  column projection removed? — and that question is separable from this one.
- **Where missing values sort.** SQL says `nulls last`; this draft says nothing,
  and whatever it says has to agree with the rule above that a non-numeric cell
  in a numeric column simply does not match.
- **Chaining.** May a filtered table be another table's `src=`? Nothing here
  forbids it; whether the resulting dependency chain needs the same termination
  argument as nested embeds (§9.3) is unexamined.
