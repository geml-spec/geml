---
name: geml-code-graph
description: >-
  Navigate a codebase's call graph through GEML codemap documents: resolve a
  function/class name to its method block, read its precise callers/callees
  from CSV edge tables, and walk the chain in both directions. Use when asked
  "who calls X", "what does X call", to trace a call chain / impact path, or
  whenever a codemap/ (or graph/) directory with index.geml and
  _index/name-lookup.json exists (build one with tools/geml-code-graph when
  asked to index a codebase).
---

# Code-graph navigation (codemap profile)

The call graph lives as **text documents, not a database** (profile:
`docs/codemap-profile.md`): one GEML document per container (module / dir /
file), each with ONE meta (`module`, `src`, `entry`, `resolution-default`),
empty-body `code` blocks per method, and up to three CSV edge tables —
`#calls` (out), `#called-by` (in), `#unresolved` (blind spots). The build's
`verify` has checked that every edge reference resolves.

## The moves

```sh
# 1. resolve_name — where does a symbol live
node -e "console.log(JSON.stringify(require('./codemap/_index/name-lookup.json')['hashtableFind'],null,1))"
#   → [{"anchor":"c:hashtable.c#hashtableFind(…)","doc":"hashtable.c.geml","id":"hashtableFind"}, …]
#   Multiple entries = real ambiguity (e.g. a .c definition and a .h inline) — inspect each.

# 2. container overview — the module's surface, one glance
head -8 codemap/hashtable.c.geml          # meta: entry = the externally-called methods

# 3. open the method block (src= tells you exactly where the code is)
geml get codemap/hashtable.c.geml '#hashtableFind'

# 4. forward: what it calls (grep your method's rows; follow doc.geml#id refs)
geml get codemap/hashtable.c.geml '#calls'

# 5. reverse: who calls it (aggregated, with file:line sites)
geml get codemap/hashtable.c.geml '#called-by'
```

A reference is `#id` (same document) or `sibling.geml#id` (that document, that
block) — `geml get` it the same way. `index.geml` holds the repo-level view:
app entries in its meta, `#modules` / `#module-edges` aggregate tables.

## Reading the tables

| Line | Meaning |
|---|---|
| `#calls` row, empty confidence | resolved at the document's `resolution-default`, high confidence |
| `#calls` row `kind=candidate` | dispatch ambiguity: one of several implementations, right after its main `call` row. Treat the SET as the answer, never just the first |
| `#calls` row confidence `medium`/`low` | the extractor is less sure — say so when reporting |
| `#unresolved` rows (hidden table) | calls the extractor could NOT resolve — **blind spots, not evidence of absence**; fall back to grep when one matters |
| `#called-by` absent for a method | no *resolved* callers. Under `resolution-default = heuristic` that means little; under `cpg` it is strong (but pointer/dynamic dispatch still lands in `#unresolved`) |

Symbol classes: `.leaf` (calls nothing, only called — usually skippable when
tracing logic) · `.test` (test territory) · `.flow-entry` (critical-flow start).

## Building / refreshing

```sh
# precise (resolution: cpg) — Joern (C:\joern\joern-cli here) + JDK; run from a scratch cwd
GEML_SRC=<abs-src> GEML_OUT=<abs-raw> joern --script tools/geml-code-graph/joern-export.sc
node tools/geml-code-graph/build.mjs --adapter joern --raw <raw> --root <src> --out codemap \
     --container file            # module|dir|file: match the repo's layout (flat C repo → file)

# fallback (resolution: heuristic) — from a code-review-graph graph.db
node tools/geml-code-graph/build.mjs --db <graph.db> --root <repo> --out codemap

node tools/geml-code-graph/verify.mjs codemap   # MUST exit 0: geml check + profile edge refs
```

Builds are deterministic (only changed files rewritten). Add
`--history [-m msg]` to snapshot changed documents into `.gemlhistory`
sidecars — then `geml history log codemap/<doc>.geml` shows the graph's
evolution and `geml revert codemap/<doc>.geml '#method' --to -1` rolls one
method's edges back. Language maturity tiers and the smoke-test gate:
`docs/DESIGN-geml-code-graph.md` §3.4. An MCP wrapper with the same three
moves exists (`tools/geml-code-graph/mcp-server.mjs`); the CLI path works
without it.
