---
gep: 0001
title: Drop the `aside` block type
state: accepted
author: GEML (BDFL)
created: 2026-07-01
issue: (BDFL decision)
---

## Summary

Remove `aside` from GEML's registered block types. Keep `note` as the single
flow "callout" type; express finer intent with a semantic class
(`=== note {.aside}`, `{.seealso}`, `{.warning}`, …). An `=== aside` block
becomes an *unknown type* — a warning, body kept raw — like any unregistered
type. It can be re-added later (a future GEP) if a distinct, well-defined role
and rendering emerge.

## Motivation

`note` and `aside` were both listed only as *examples* of flow blocks (§3); the
spec never defined a behavioural difference, and the reference renderer rendered
them identically. Giving `aside` a distinct rendering surfaced the real
question: what is it *for*? The honest answer is that "tangential/complementary
content" is already expressible as `note {.aside}` — a semantic class, which the
spec explicitly endorses (`.class` is a semantic label). Two near-synonymous flow
types violate GEML's stated design boundary ("GEML stays small on purpose").
Removing `aside` before the format has adopters is the low-cost moment to do it.

## Design

- Remove `aside` from the type registry (it was `flow`). `note` stays `flow`.
- An `=== aside …` block is now an **unknown type**: a `warning` ("no registered
  type … body kept raw"), body preserved raw — the standard forward-compatible
  fallback (§3/§8). It is *not* an error.
- Migration: `=== aside {.x}` → `=== note {.aside}` (or another class).

Before / after:

```
=== aside {.x}          →      === note {.aside}
tangential prose               tangential prose
===                            ===
```

## Conformance impact

None to the conformance corpus (`inline/lists/precedence.json` contain no typed
blocks; no case references `aside`). The change is: the registry loses one
entry, so `aside` joins the open set of unregistered types. The reference
parser, the second implementation, and any conformant parser agree by simply not
special-casing `aside`.

## Alternatives considered

- **Keep `aside`, give it a real sidebar role + layout** (a genuine `<aside>`
  side column). Rejected: no compelling authored use that `note {.class}` can't
  cover, and it adds rendering complexity against the "stay small" goal.
- **Keep it as a silent flow alias of `note`.** Rejected: a phantom, undocumented
  type is worse than either having it or not.

## Compatibility & migration

Pre-adoption, so blast radius is internal. Existing `=== aside` usage (none in
this repo's documents) would degrade to a raw unknown block with a warning, not
an error; `geml fmt`/`convert` are unaffected. Docs, both renderers, the
Markdown exporter, the playground sample, and the skill are updated to present
only `note`.

## Drawbacks & open questions

- Someone may genuinely want semantic `<aside>` output. That is re-addable via a
  future GEP with a concrete role and rendering — the point of leaving the door
  open.
