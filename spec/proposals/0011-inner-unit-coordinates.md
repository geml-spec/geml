---
gep: 0011
title: Coordinates for units inside a block — a table's rows and cells, a value tree in `data` or merged `meta`
state: draft
author: GEML (maintainer)
created: 2026-09-03
issue: (pending)
---

## Summary

Give the units **inside** a block an address, for the units that have no name of
their own: a bracket **coordinate**.

```
#fy[2]                  the second body row
#fy[2]["Q1"]            one cell, the column named by its header
#fy["Q1"]               one column
#intake["sections"][0]["fields"][1]["name"]     a data block's value tree
#meta["version"]        a value from this document's merged meta
```

Coordinates compose with §5.2 cross-document addressing unchanged
(`other.geml#fy[2]["Q1"]`). `[` cannot occur in a conforming id (§4), so a
coordinate can never be mistaken for one and no existing document changes
meaning.

Reading lands first: `geml get`, and checked references. Writing is defined but
narrow — refused wherever the source holds no byte to change (a computed column,
a `src=`-fed table) and wherever changing one byte would corrupt its neighbours
(a delimiter inside a `format=csv` cell).

**Named** inner units are not this GEP's business.
[GEP 0008](0008-form-block.md) addresses a `form`'s fields as `#signup#email`
and keeps that rule scoped to `form`, where its one consumer is.

## Motivation

Today **every** address resolves to a block. The reference implementation's
selector layer carries six forms — the empty listing filter, `#id`,
`=== type`, the `@<hex>` content key, the `L<n>[-<m>]` position, and the
declared-but-unimplemented `{k=v}` attribute filter — and each hands back a unit
of the document, never a part of one.

The only narrowing that reaches inside a block is a **flag**:
`geml get <file> '#id' --head|--intro|--body`. A flag cannot be pasted into a
document, cannot be a reference, and cannot cross a document boundary. So the
pieces a reader points at and an agent edits — a table row, one record in a
`data` block — have no address at all.

That gap contradicts all three claims this project makes: build-time reference
checking, block-level addressability, agent-editability by block. A forty-row
table is exactly the shape an agent should edit one row of; today `geml set` can
only hand back all forty.

## Design

### Which blocks have inner units

§3's registry holds nine types, and their body modes are `raw`, `flow` and
`data` — there is no container mode. So the units this GEP addresses live in
three of them, and every other type's are already addressed elsewhere:

| type | inner units | addressed how |
|---|---|---|
| `table` | body rows, cells, columns | **this GEP** — coordinates |
| `data` | value-tree nodes | **this GEP** — coordinates |
| `code`, `math`, `diagram` | lines | already addressable: `L<n>[-<m>]` (§2) |
| `note`, `text` | prose runs | already addressable as units in their own right (GEP 0010) |
| `embed` | none — `src=` points at the content, the body is unused | — |
| `meta` | keys | **this GEP** — coordinates under the reserved `#meta` |
| `form` (GEP 0008, not yet registered) | fields, which carry ids | GEP 0008 — `#form#field` |

#### `#meta` is the merged namespace, and it is reserved

A document may carry several `meta` blocks, and §4 merges them key-wise: a later
definition of the same key is the `duplicate-meta-key` warning, and the **first**
definition is kept. Every key therefore has one defined value, so the merged view
can be addressed — and it is the view, not any one block, that an author means:

```
#meta["version"]              this document's merged meta
A.geml#meta["version"]        another document's
```

`#meta` is reserved for it. Three rules follow, and the third is the reason the
first two are worth their cost:

1. **A declared `{#meta}` is an error only where it is ambiguous.** With one
   `meta` block an author's `{#meta}` denotes that block, which *is* the merged
   namespace — the two readings agree and nothing is wrong. With two or more the
   id would mean "this block" while `#meta` means "all of them, merged": that is
   a `reserved-id` **error**, fixed by renaming the block's own id. (Today
   `=== meta {#meta}` is conforming, so this rule invalidates a document that
   parses cleanly now. That is deliberate.)
2. **`get '#meta'` answers the view, not source bytes.** Every other address in
   §2 names a span of the file; this one names a derived value tree. So `get`
   prints the merged values, `--json` gives the tree, and there is no `L`-range
   to map back — a coordinate under it (`#meta["version"]`) is the everyday
   case, and the bare `#meta` is the whole view.
3. **`set '#meta["key"]'` writes the definition in force.** First definition
   wins, so a write has to land where the value is actually read from, or it
   would not take effect. That is the block holding the winning definition; a
   key defined nowhere is created in the **first** `meta` block.

   *Why not always the first block:* if `version` is defined only in the second
   `meta` block, writing it into the first one does take effect — but it demotes
   the author's existing definition into a `duplicate-meta-key` warning nobody
   wrote. Landing on the definition in force takes effect just as reliably and
   leaves the document as the author shaped it.

`{{key}}` reads the same merged namespace inside its own document and is still
the shorter way to do that; `#meta[…]` is what makes it addressable, checkable,
and reachable across documents.

**A note on what to export.** A `data` block remains the better carrier for
values other documents are *meant* to read: `meta` is how a document declares
its own processing, and exporting it turns private configuration into a public
contract that cannot be renamed without breaking a reader.

### Rows, cells and columns

- `#<block>[<n>]` — one **body row**, 1-based. A header is not a row: the
  reference implementation's table model already draws that line (its `rows` are
  "body rows (header excluded)").
- `#<block>[<n>]["<column>"]` — one cell, the column named by its header.
- `#<block>["<column>"]` — one column, header excluded, in row order.
- `#<block>[summary]["<column>"]` — the cell in the `summary=` foot row, and
  `#<block>[summary]` the row itself.

Three token species live inside the brackets and no two can be confused: a bare
**integer** is a row index, a **quoted string** is a column or map key, and a
bare **word** is a reserved row name, of which `summary` is the only one this
GEP defines. The reserved word is also the *stable* one — inserting a row moves
every index below it and leaves `[summary]` where it was.

That is what makes a source's total reachable without copying it:
`A.geml#fy[summary]["FY"]` reads it, and `![[A.geml#fy[summary]["FY"]]]`
projects it inline — the leaf-value case this GEP allows for a transclusion
target.

A table with no header row already has letter columns (`A`, `B`, …) in the
model, so those letters *are* its column names. That keeps **one column
namespace** in the format — the same one `compute=` and `summary=` read, where
`'Unit Price'` is already the way a name with a space is written.

### A `data` block's value tree

The same brackets walk maps and sequences:
`#intake["sections"][0]["fields"][1]["name"]`. A key is a quoted string, an
index a bare integer, which is also how the two are told apart.

### An embed's coordinate is not an address

`=== embed {#embedB src=A.geml#tableA}` holds no rows of its own: in the
embedding document's model an embed is a `raw` block with an empty body, and
its target resolves at render time. So `#embedB[1]["col1"]` does not resolve —
for reading as much as for writing — and the diagnostic names the address that
does work: `A.geml#tableA[1]["col1"]`.

Writing *through* an embed would edit another document from this one, breaking
§6's one-source rule (`src=` plus an inline body is already an error). Reading
through it would make one value depend on two moving parts — A's rows, and where
`src=` points today — and a reference resolves on the source, never on the
render, which is the same reason `find` reports blocks and the listing is built
from the file.

### A coordinate as an embed's target

The converse direction is allowed, for one shape: a coordinate may be the target
of block transclusion or inline projection when it names a **leaf value**.

```
![[vars.geml#vars["version"]]]      inline projection of one value
```

A **positional slice** — `src=A.geml#tickets[2]`, a row or a column — is not a
transclusion target. "Which row" is almost always a predicate rather than an
index, so the useful form of that feature is a filter — and a filter is the
consuming block's business, declared as an attribute beside `src=`, not an
address. A named leaf value has no such analogue: it is one value, complete on
its own, and nothing about it moves when the rows around it do.

### Reading

`geml get` on a coordinate prints that unit — a row as its source line, a cell
as its text, a value-tree node as its JSON; `--json` answers the model node.

`geml find` keeps reporting the **containing block's** address, never a cell's:
a search hit is a place to start reading, and a coordinate is only stable while
the rows above it are.

`geml list` does **not** enumerate inner units. §6.2 promises that every address
the listing prints pastes straight back into `get`/`set`; a four-hundred-row
table would drown that listing, so a coordinate is constructed by the author,
never offered by the tool.

### Writing, and the four refusals

`geml set` on a coordinate replaces that unit and nothing else. It is REFUSED,
naming the reason, when:

1. **The target is derived.** A `compute=` column has no bytes in the source —
   the model marks the cell computed and the serializer never writes one.
   (The upside: because derived values are not materialized, writing a *data*
   cell cannot leave a stale total behind. Recomputation is free.)
2. **The rows have no bytes in this file.** A `src=`-fed table's rows do reach
   the document model — the CLI resolves them while parsing — but they live in
   the source the `src=` names, so there is nothing here to rewrite. Reading
   such a coordinate is therefore fine; writing one is refused, and writing
   *through* to the other file is a separate proposal.
3. **The new value would re-split its row.** A data-form body (`format=csv` /
   `tsv`) splits on the delimiter and does nothing more — it does not dequote. A
   value containing the delimiter is refused, with the two ways out named: the
   visual pipe grid, or `delim=`. This is not hypothetical — thirteen rows of
   this repository's own `docs/PUBLISHING` were rendering into the wrong columns
   for exactly this reason.
4. **The result would not parse.** A `data` block write whose value breaks the
   block's declared `format=` is refused, as a malformed body already is at
   build time ([GEP 0005](0005-data-block.md)).

**Alignment is the writer's job.** There is no `geml fmt` — canonical
serialization is `--to geml` — so a `set` into a visual grid re-pads that grid
itself rather than leaving a ragged table for a formatter that does not exist.

**History stays block-level.** A `.gemlhistory` revision is a block's tile, so a
cell write is one block revision and `revert` keeps its present granularity.
That is a feature: two agents writing two cells of one table collide at the
block, where the collision is visible, instead of interleaving into a table
neither of them wrote.

## Conformance impact

- §2 gains the coordinate as an address form. §4 gains exactly one id: `#meta`
  is reserved for the merged meta view, and no other id space is introduced —
  a coordinate is not an id.
- Appendix A gains `reserved-id` (**error**): a declared `{#meta}` in a document
  that carries more than one `meta` block.
- §6.2's paste-back promise is preserved by keeping coordinates out of the
  listing.
- **Parsers** gain one production. It is a lookup, not a traversal, so §9.3's
  termination argument is unaffected.
- **Writers** gain the four refusals. A writer that implements none of this
  still conforms: a coordinate is then a usage error, exactly as the
  unimplemented `{k=v}` filter is today.
- **The conformance suite** gains cases for: a row read at a header-excluded
  index, a cell read by header name, a cell in a header-less table read by
  letter, a value-tree walk mixing keys and indices, an out-of-range coordinate,
  and one refusal per rule above.

## Alternatives considered

**`#fy#Q1` — the `#` narrowing operator, as GEP 0008 uses for fields.**
Rejected for unnamed units: `Q1` and `B3` are conforming NAMEs, so the second
segment's meaning would depend on the parent block's type, and an address would
stop being self-describing — every other form in §2 can be read without knowing
what it points at. A bracket says "coordinate" in the address itself.

**Generalizing GEP 0008's rule into "named inner units" and covering both here.**
Rejected: `#a#b` has exactly one consumer, and §3's registry has no
container-mode type at all, so the general rule would be written for a
hypothetical second one. It stays in 0008, scoped to `form`, until a second
container type exists to generalize it *from*.

**JSON Pointer for `data`** (`#intake#/sections/0/fields/1`). Rejected: it would
give the format two coordinate languages for one concept. Brackets already reach
into the value tree.

**A `--path` flag instead of an address.** Rejected as the primary form — a flag
cannot be a reference, which is most of the point. Worth remembering as the
cheap fallback if this GEP stalls: it needs no address grammar at all, and it
has a precedent in `--head|--intro|--body`.

**Real ids on rows** (`| {#r7} | … |`). Rejected: a csv row has no attribute
position, so the rule would hold for one body form and not the other.

## Compatibility & migration

No conforming document changes meaning — `#a[…]` was an unreachable address
before this GEP. There is nothing to migrate and nothing to keep compatible:
GEML is not adopted widely enough yet to owe an old spelling a bridge.

## Drawbacks & open questions

- **A coordinate is not stable.** Insert a row and every address below it
  shifts. This is the argument for an id wherever a unit can carry one, and the
  reason `find` reports blocks.
- **1-based rows, 0-based sequences.** Rows are lines a human counts; a value
  tree's sequences are JSON. The asymmetry is deliberate and worth challenging.
- **Ranges, wildcards and predicates** (`#t[2:5]`, `#t[*]["Q1"]`,
  `#t[Status='open']`) are deliberately not addresses: each yields a result set,
  which moves with the data. Selecting a subset is the consuming block's
  business, declared beside `src=` — a separate proposal, not this one.
- **Write atomicity across two coordinates** is undefined. Today the block is
  the unit of change and `set` takes one address.
- **If a second container-mode type ever lands**, GEP 0008's `#a#b` becomes a
  rule with two consumers, and lifting it out of 0008 into a shared section
  becomes worth doing. Not before.
