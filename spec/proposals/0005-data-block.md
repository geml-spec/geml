---
gep: 0005
title: Register a `data` typed block — the value tree, with a scoped format registry
state: draft
author: GEML (maintainer)
created: 2026-08-05
issue: (maintainer decision)
---

## Summary

Register `data` as a typed block carrying the **value-tree model** — scalars,
sequences, maps — with a per-type **format registry** selecting the surface
syntax: `format=json` (the default) and `format=jsonl` are parsed and verified
in core; `yaml` and `toml` are reserved names that keep the body raw with a
warning until an engine is attached. A malformed body is a build **error**, the
parsed value is exposed in the document model, and `geml fmt` canonicalizes
JSON bodies. The chart binding widens: `diagram {format=geml-chart data=#id}`
MAY target a `data` block whose value is a **record array**, projecting keys to
columns under the existing column checks. An informative section defines the
**blind-append convention** that makes a `.geml` of `data` blocks an
appendable record log — the jsonl workload, with ids, verification, and
rendering that jsonl cannot carry.

## Motivation

GEML gives every other content class a typed carrier with its own verifier —
tables (column algebra), math, diagrams (external DSLs), code (verbatim) — but
hierarchical data has no home. Both workarounds fail, measurably:

- **`code {lang=json}`** is verbatim by contract: the body is never verified
  (a missing comma passes `check`), `lang=` has always been a display hint,
  and `fmt` must not rewrite it. Attaching verification to one `lang=` value
  would break every document that quotes partial or pseudo-JSON as an example.
- **`text`** is flow. Measured against the reference parser: a trailing-comma
  JSON body passes `check` silently (zero verification); a string value
  holding a template — `{"tpl":"{{name}}"}`, common in real configs — raises a
  spurious `unknown metadata reference` **error**; rendering re-interprets the
  payload (`"*.js*"` → `<em>`, `"$5 to $6"` → a math span). Storage works;
  format, verification, and the model are exactly what it cannot provide.

The workloads that feel this are GEML's center of gravity — documents written
and edited by agents and CI: config corpora and fixtures that want per-record
ids and build-time verification; eval records annotated with prose; and
program-appended record streams (the jsonl niche), where GEML has an unused
structural advantage: a document is a **flat sequence of blocks**, so a writer
can append a complete block at end-of-file *without reading the file* — the
same blind-append ergonomics as jsonl, which formats with a closing bracket
(JSON arrays, XML) can never offer. `.gemlhistory` already runs an
append-oriented GEML log in production, with a hash chain and `verify`.

## Design

**Registry.** `data` registers with a `raw` body (block scanning is unchanged;
fences delimit verbatim text), followed by a format-driven parse to the value
model — the two-stage pattern `table` already uses. The type carries the
model; `format=` selects only the surface syntax *within* it. Format names are
**type-scoped**: `csv` remains a `table` format (the column algebra —
`compute=`, `summary=`, `span=` — is `table`'s model, not the value tree's),
exactly as `mermaid` remains a `diagram` format. Admission to `data`'s format
registry requires the syntax to be **self-describing** — the bytes alone
determine the value, with no dialect parameters. JSON, JSON Lines, YAML and
TOML qualify; delimited text does not (delimiter, header presence and quoting
are parameters), and those parameters are only meaningful against a column
model in the first place — the deeper reason csv/tsv are `table` formats,
where headerless bodies already get `A, B, …` columns today.

**Attributes.**

- `format=` — `json` (default) | `jsonl` | `yaml` | `toml`. Unknown values,
  and reserved values with no engine attached (`yaml`, `toml` in core), keep
  the body raw and emit a **warning** — the same lattice as an unknown
  `diagram` format, so older or minimal processors degrade identically.
  The default follows a registry-wide rule: *when a model has an isomorphic
  canonical syntax, it is the default* — `table` defaults to the pipe form,
  `data` to JSON (the value tree's native serialization, and the one syntax a
  zero-dependency core can always verify); `diagram`, whose model has no
  canonical DSL, has none, which is why its `format=` is effectively required.
- `schema=` — reserved. Names a block or sibling document holding a schema;
  in this GEP it is **reference-checked only** (a dangling `schema=` is an
  error, like any reference). Validating the value against it is out of scope.
- `src=` — external content, under `table`'s one-source discipline (§6):
  exactly one of `src=` and an inline body; the file must look like data
  (`.json`/`.jsonl`, explicit `format=` winning over the extension);
  `http(s)` fetches at render time (the block and any chart over it defer);
  other schemes are refused. This completes the log arrangement: the records
  stay a plain `.jsonl` any tool can append to and tail — the GEML document
  is the verified, addressable, chartable VIEW over it. A chart may also
  name a local `.json`/`.jsonl` directly (`data=log.jsonl`), the record
  twin of the `.csv` desugaring.
- `#id`, `.class`, `caption=`, `hidden` — as on any typed block. `hidden`
  supports the source-feeds-a-chart idiom unchanged.

**Verification.** `format=json`: the body MUST parse as one JSON value; a
parse failure is an **error** diagnostic naming the body-relative line.
`format=jsonl`: every non-blank line MUST parse as one JSON value (blank lines
are permitted and ignored); the diagnostic names the offending line. There are
no cross-record checks.

**Model.** The block node exposes `format` and, when an engine parsed it,
`value` — the value tree — beside the raw body, as `table` exposes its parsed
model. `geml get '#cfg' --json` therefore returns data a consumer can use
without re-parsing text; for `jsonl`, `value` is the array of line values.

**Serialization.** `geml fmt` (and `--to geml`) canonicalizes engine-parsed
bodies: `json` pretty-prints at two-space indent; `jsonl` emits one compact
value per line. Engine-less bodies (`yaml`, `toml`, unknown) are
byte-preserved, like any raw body.

**Chart binding.** `data=` on a `geml-chart` diagram currently requires a
`table`. It now accepts a `data` block whose value is a **record array**: a
non-empty sequence whose elements are maps, where every column the chart
references (`x=`, `y=`, …) is present in every record with a scalar value.
Keys project to columns; the existing column-reference checks, type inference,
and rendering apply unchanged. A source that is not a record array, or a
record missing a referenced key, is a build **error** naming the first
offending record. `compute=`/`summary=` remain `table`-only: derived columns
live where the column algebra lives.

```
=== data {#log format=jsonl}
{"ts":"09:00","latency":41}
{"ts":"09:01","latency":58}
===

=== diagram {format=geml-chart data=#log type=line x=ts y=latency}
===
```

**Blind-append convention (informative).** Appending a complete
`=== data … ===` block at end-of-file yields a valid document with no
read-modify-write. Appenders SHOULD generate collision-free ids
(timestamp+sequence, as `.gemlhistory` revision ids do) or omit ids and rely
on content addresses (`@hex`). A torn write leaves one `unterminated-block`
error and a recoverable tail — the analogue of jsonl's dropped last line.
High-volume streams need rotation; a streaming block reader is future work
(see open questions). Two cheap bridges keep jsonl toolchains fed:
`geml get file.geml '=== data' --json` today, and a `--to jsonl` projection
as CLI follow-up work outside this GEP.

## Conformance impact

New cases in `geml-parser/test/conformance/`:

- a `json` body projecting its `value` (and `format`) in the document model;
- a malformed `json` body → error, with the body-relative line;
- a `jsonl` body: blank lines ignored; per-line failure named;
- `format=yaml` → body kept raw, warning, no `value`;
- an unknown `format` → the same warning lattice;
- `geml-chart` over a record-array `data` source (columns check, chart
  resolves) and over a non-record source (error).

The projection grammar gains `block:data` with an optional `value`; no
existing case changes.

## Alternatives considered

- **Verify `code {lang=json}`.** Breaks `code`'s verbatim contract and
  retro-fails every illustrative snippet; makes one `lang=` value silently
  change semantics where `lang=` was always presentational.
- **`text {format=json}`.** Empirically unfit (measurements above); worse, a
  `format=` that flips a body from flow to raw breaks the language's first
  registry rule — *the type decides how the body is read* — and turns the
  safe unknown-degradation path ambiguous.
- **One type per syntax** (`=== json`, `=== yaml`, `=== toml`). Three types,
  one model: triplicated verify/schema/binding rules, a registry that grows
  with every wire format, and three names for one concept. Types track
  models; syntaxes are formats. (For the same reason `table` does **not**
  fold into `data`: its column algebra is a distinct model, and merging by
  "everything is JSON-encodable" collapses the registry into untyped.)
- **`csv` in both types.** Type-scoped format names make it well-defined,
  but it fails the self-describing admission rule (the dialect parameters
  come along), forces an arbitrary value-tree mapping (arrays vs records),
  and buys nothing `table {hidden}` plus the record-array binding does not
  already cover. Deferred, not forbidden: scoped names mean it can be added
  later without breaking anything, so deferral is free.
- **Do nothing.** The unregistered-block workaround leaves permanent
  warnings, no verification, no model value — measured above.

## Compatibility & migration

Additive, with one honest edge: a document already using an *unregistered*
`=== data` block today (unknown-type warning, raw body) will now have its
body parsed as JSON and may gain errors. The name is generic enough that such
blocks may exist in the wild; migration is `format=`-annotating or renaming
the block. `fmt` canonicalization changes bytes of JSON bodies on first
touch — noted so history diffs are expected. Editorial: spec prose currently
names the `meta` body mode "data"; it is renamed ("keyed" or "key-value") to
free the word for the type.

## Drawbacks & open questions

- **Zero-dependency line.** `yaml`/`toml` engines stay out of core; the
  attachment mechanism (optional dependency, plugin, or external check pass)
  is unresolved.
- **`schema=` validation.** Reference-checked here; whether validation is a
  JSON-Schema subset in core or delegated externally is deferred.
- **Streaming.** The parser is whole-document; until a streaming block reader
  exists, `data` logs must rotate and cannot credibly replace high-volume
  jsonl. Deferred deliberately rather than promised.
- **Consumer profile.** Whether the first target is closed-loop (our own
  agent/MCP logs) or external toolchains decides how early the `--to jsonl`
  bridge must land; unresolved at draft time.
- Diagnostics inside large bodies need careful body-relative line mapping to
  stay useful.
