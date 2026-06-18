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
node dist/geml.js convert in.md -o out.geml # Markdown → GEML
npm test                                    # conformance checks
```

### Markdown → GEML

`geml convert <file.md> [-o out.geml]` maps Markdown's block constructs onto
GEML's typed-block primitive (inline syntax passes through, being a subset):

| Markdown | GEML |
|----------|------|
| YAML frontmatter | `=== meta` (data) |
| ` ``` ` fenced code | `=== code {lang=…}` |
| ` ```mermaid `/`graphviz`/`dot`/`d2`/`plantuml` | `=== diagram {format=…}` (§7) |
| `$$ … $$` math | `=== math` |
| `>` blockquote | `=== note` |
| GFM pipe table | `=== table` (§6) |
| `[^id]: …` footnote def | `=== note {#id}` |
| `<https://…>` autolink | `[url](url)` |
| setext heading | ATX heading |
| thematic break (`---`) | dropped (not a GEML construct) |

Converted typed blocks get auto-assigned `#type-N` ids so they are
referenceable; media embeds (`![](clip.mp4)`) get their `as` kind inferred from
the source extension (§5.1).

Milestones:

- **M1** — block scanner: typed-block fences, `meta` data block, headings,
  lists, paragraphs, attribute objects with §4 value typing.
- **M2** — inline content (§5: emphasis/strong/strike, code, math, media
  embeds, links, auto-references, footnotes) and build-time reference
  validation (§8: unique ids, resolvable internal/cross-document references).
- **M3** — tables (§6: visual and `csv`/`tsv` forms parsed to one model,
  per-row `compute` formulas with `sum/avg/min/max/count` aggregates, `span`
  merges) and the diagram renderer registry (§7: unknown `format` → warning).

**Status:** 0.1 draft, parser covers §3–§8.
