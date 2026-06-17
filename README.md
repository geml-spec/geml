# GEML — General Expressive Markup Language

GEML is a plain-text markup language for structured, expressive documents:

- fully legible as plain text, no rendering required;
- every kind of structured content (code, tables, diagrams, math, callouts,
  metadata) expressed through **one** typed-block primitive;
- stable `id`s on any block, with **build-time** reference checking;
- hosts external diagram DSLs (Mermaid/Graphviz/D2/…) without inventing one;
- no raw-HTML escape hatch — semantics are not tied to any backend.

## Contents

| Path | What |
|------|------|
| `GEML-spec-draft.md` | Mini-spec (bilingual 中/EN) |
| `GEML-spec-draft_EN.md` | Mini-spec (English) |
| `GEML-spec-draft.geml` | The spec written in GEML itself (dogfood) |
| `GEML-history-spec.md` / `_EN.md` | The `.gemlhistory` versioning extension |
| `GEML-spec-draft.gemlhistory` | History-format sample |
| `geml-parser/` | TypeScript reference parser (Node 22) |

## Reference parser

```sh
cd geml-parser
npm install
npm run build
node dist/geml.js ../GEML-spec-draft.geml   # → document-model JSON
npm test                                    # M2 conformance checks
```

Milestones:

- **M1** — block scanner: typed-block fences, `meta` data block, headings,
  lists, paragraphs, attribute objects with §4 value typing.
- **M2** — inline content (§5: emphasis/strong/strike, code, math, media
  embeds, links, auto-references, footnotes) and build-time reference
  validation (§8: unique ids, resolvable internal/cross-document references).

**Status:** 0.1 draft, parser at M2.
