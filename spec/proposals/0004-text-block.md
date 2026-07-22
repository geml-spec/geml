---
gep: 0004
title: Register a `text` typed block — an addressable prose container
state: accepted
author: GEML (maintainer)
created: 2026-07-22
issue: (maintainer decision)
---

## Summary

Register `text` as a `flow` type. `=== text {#intro} … ===` wraps a run of
prose (one or more paragraphs, lists, nested blocks) solely so that run carries
an `#id` and attributes — making it referenceable (`[[#intro]]`), block-editable
(`geml get/set #intro`), and versionable (`geml history` / `revert`). It renders
as a **neutral** container (a plain `<div class="text">`), with none of the
callout chrome that `note` carries, and exports to Markdown as plain paragraphs.

## Motivation

GEML's addressable-block editing is its center of gravity for AI-agent and CI
workflows: `geml get/set #id` lets a tool read or replace one block without
touching the rest of the document, guarded by a re-parse. But the unit of most
documents — plain prose — has no id. Today an author who wants an addressable
paragraph must either promote it to a heading section, or wrap it in `note` and
accept callout styling that misstates its role.

The workaround people actually reach for (an unregistered `=== text` block)
half-works: `get`/`set` operate on it, but every `geml check` emits
`warning: unknown block type` and the body stays raw — `**bold**` is not parsed,
and `[[#ref]]`s inside it are **not reference-checked**, silently exempting that
prose from GEML's core build-time guarantee.

## Design

- Registry: add `text: flow` (beside `note: flow`). The body is parsed as flow;
  inline markup works; every reference in it is build-time checked (§8).
- HTML: `<div class="text …classes" id="…">…</div>` — no `<aside>`, no callout.
  `.class` tokens land on the div (`.class` stays a semantic label, §4).
- Markdown export: children project as plain paragraphs (no `> ` prefix);
  `note` keeps its blockquote projection, `note.footnote` is untouched.
- `geml fmt` / serialize: mode-driven already; a `text` block round-trips.
- `geml convert`: no Markdown construct maps to `text` (nothing in Markdown
  expresses "this prose is addressable"); conversion is unchanged.

Before / after (the workaround becomes the feature):

```
=== text {#thesis}                      same source — but now:
GEML documents are *addressable*.       - no unknown-type warning
===                                     - body is flow (emphasis, refs parsed)
                                        - [[#thesis]] and geml set work checked
```

## Guarding the "stay small" boundary

GEP-0001 dropped `aside` for being a synonym of `note` with no behavioural
difference. `text` is not that: no registered type provides **addressable,
versionable, reference-checked prose rendered plainly**. `note` has callout
semantics in every backend (aside/blockquote); raw types don't parse prose;
headings address *sections*, not passages. `text` is the smallest type that
closes the gap, and it adds no new syntax — only a registry entry.

The intended discipline stays editorial: wrap only prose you actually need to
address (a thesis paragraph an agent edits, a legal clause under review, a
paragraph a chart caption cites). Plain paragraphs remain the default; `text`
is not a `<p>`-everywhere habit, and the spec wording says so.

## Conformance impact

None. The conformance corpus (`inline/precedence/lists/interp.json`) contains no
typed blocks, and the projection grammar is untouched (a typed block projects as
`block:text` like any other). The behavioural pin lives in the parser/renderer/
exporter suites: registration (flow body, refs checked, no warning), neutral
HTML, plain-paragraph export, `get`/`set` spans, and serialize round-trip.

## Alternatives considered

- **Do nothing** (keep the unknown-type fallback): leaves a permanent warning in
  clean documents and — worse — leaves the wrapped prose's references unchecked.
- **`note {.plain}`**: renders as a callout in every existing backend; a class
  that *negates* its type's meaning is a misuse of `.class` (semantic label).
- **Ids on bare paragraphs** (e.g. `{#p}` suffix syntax): new inline/attribute
  grammar on every paragraph — far larger spec surface than one registry entry,
  and it changes the paragraph parse for all documents.

## Compatibility & migration

Purely additive. Documents already using `=== text` (the workaround) lose the
warning and gain flow parsing; if such a body relied on staying raw (unlikely —
that's what `code`/unknown types are for), it now renders as prose. No other
behaviour changes; `fmt`, `convert`, history and the CLI are unaffected.

## Drawbacks & open questions

- Overuse risk: authors could wrap everything for "future addressability",
  bloating documents. Mitigated editorially (spec + skill say "sparingly").
- A second neutral container may invite future synonyms (`section`, `div`).
  The 0001 boundary answers this: no new type without a capability nothing
  else delivers.
