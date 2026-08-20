# Demo: "Claude, change that note"

Artifacts of one real run against a Logseq DB graph (2026-08-20), kept as the
walkthrough: the user asked for one block to say `hola, GEML!`, and the agent
did it without opening the app.

| file | step |
|---|---|
| `graph.edn` | 1. `logseq export-edn` — the graph as Logseq exports it |
| `geml/` | 2. the same graph as GEML — one document per page; the target block is `#aaaaaaaa-…` in `pages/0006-spike-refs.geml` |
| — | 3–5. `geml find "hola"` → `geml get '#aaaa…'` → `geml set '#aaaa…'` (only that block read, only that block written, write re-validated) |
| `import.edn` | 6. converted back, `logseq import-edn` merged it by uuid |
| `after.edn` | 7–8. `logseq validate`: Valid! — and the re-export carries `hola, GEML!` exactly once |

Reproduce with your own graph: `bin/live-roundtrip.mjs` runs the whole loop.
