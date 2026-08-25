# Demo: "Claude, change that note"

Artifacts of a real run against a Logseq DB graph, kept as the walkthrough: the
user asked for one block to say `hola, Logseq feels good with GEML!`, and the
agent did it without opening the app.

| file | step |
|---|---|
| `graph.edn` | 1. `logseq export-edn` — the graph as Logseq exports it |
| `geml/` | 2. the same graph as GEML, laid out like an OG vault: `pages/<name>.geml`, order in `graph.geml`, ontology in `ontology.geml`. The target block is `#aaaaaaaa-…` in `pages/spike-refs.geml` |
| — | 3–5. `geml find "hola"` → `geml get '#aaaa…'` → `geml set '#aaaa…'` (only that block read, only that block written, the write re-validated) |
| `import.edn` | 6. converted back, `logseq import-edn` merged it by uuid |
| `after.edn` | 7–8. `logseq validate`: Valid! — and the re-export carries the new text exactly once |

Journal pages map to `journals/YYYY_MM_DD.geml` (fixture-tested); they are
absent here because `@logseq/cli` 0.4.3's `export-edn` does not include
journal pages in its export.

Reproduce with your own graph: `bin/live-roundtrip.mjs` runs the whole loop.
