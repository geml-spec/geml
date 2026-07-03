---
name: callnav
description: >-
  Navigate a codebase's call graph through GEML documents: resolve a
  function/class name to its symbol block, read its precise callers/callees as
  followable references, and walk the chain in both directions. Use when asked
  "who calls X", "what does X call", to trace a call chain / impact path, or
  whenever a graph/ directory with index.geml and _index/name-lookup.json
  exists (build one with tools/callnav when asked to index a codebase).
---

# Call-graph navigation (callnav)

The call graph lives as **text documents, not a database**: one GEML document
per source directory (`graph/<lang>/<dir>.geml`), one block per symbol. Edges
are GEML references — **`geml check` has verified none of them dangles** — so
navigation is: get a block, follow its references. Reverse direction lives in
mirrored backlink documents (`graph/_backlinks/…`).

## The three moves

```sh
# 1. resolve_name — find where a symbol lives (exact key lookup)
node -e "const l=require('./graph/_index/name-lookup.json');console.log(JSON.stringify(l['hashtableFind']))"
#   → [{"anchor":"c:src/hashtable.c#hashtableFind","doc":"c/src.geml","id":"sym-hashtableFind-1a291b"}]
#   Multiple entries = real ambiguity (overloads/same name); inspect each, never assume.

# 2. open_symbol — read ONE symbol's block (never load the whole document)
geml get graph/c/src.geml '#sym-hashtableFind-1a291b'

# 3. get_backlinks — who calls it (the target of the block's `called-by:` line)
geml get graph/_backlinks/c/src.geml '#bl-findBucket-fdd531'
```

Follow any reference the same way: `[[#id]]` targets live in the same document;
`[name](../other.geml#id)` targets in the named sibling document. Start points
for a whole-repo look: `graph/index.geml` (entry points, critical flows,
partition list).

## Reading a symbol block

```
=== note {#sym-findBucket-fdd531 .Function anchor="c:src/hashtable.c#findBucket" file="src/hashtable.c" lines="856-890"}
`findBucket`
calls: [[#sym-checkCandidateInBucket-d7bbd7]] [[#sym-expToMask-e6b779]]
calls-leaf: [[#sym-hashtableSize-c92011]]
- calls [apply](discount.geml#sym-apply-cd3401) (medium — interface, 3 impls) candidates: [[#sym-apply-ef56aa]]
calls-unresolved: `formatCurrency` `log.debug`
called-by: [6 个调用点](../_backlinks/c/src.geml#bl-findBucket-fdd531)
===
```

| Line | Meaning |
|---|---|
| `calls:` / `imports:` / `inherits:` / `tested-by:` | Default-confidence edges (the document meta's `resolution-default`), all verified references |
| `calls-leaf:` | Calls into terminal helpers (`.leaf` targets) — usually safe to skip when tracing logic |
| `- calls … (confidence — note) candidates: …` | **Suspicious edge, spelled out**: lower confidence, or several implementation candidates (virtual/interface dispatch). Treat candidates as the honest answer, not the first one |
| `calls-unresolved:` | Targets the extractor could NOT resolve — plain text, **blind spots**, not evidence of absence |
| `called-by:` | Link to this symbol's backlink block (reverse direction) |

Classes on the block: `.entry` (a `main`) · `.flow-entry` (start of a critical
flow) · `.Test` (a test case) · `.test` (in test territory) · `.leaf` (calls
nothing, only called).

## Trust semantics (do not skip)

- The document meta's `resolution-default` says how edges were derived:
  `cpg` = static analysis (precise); `heuristic` = syntax-level extraction.
- Under `heuristic`, cross-file calls are mostly **unresolved**: a missing
  `called-by:` line means "no *resolved* callers", never "no callers". Say so
  when reporting; fall back to grep for the blind spots that matter.
- Anything in `(…)` annotations or `candidates:` is the extractor refusing to
  guess for you. Preserve that uncertainty in your answer.

## Building / refreshing the graph

```sh
node tools/callnav/build.mjs --db <graph.db> --root <repo-root> --out graph
node tools/callnav/verify.mjs graph          # MUST exit 0 (every reference resolves)
```

The build is deterministic and only rewrites changed documents (mtime shows
what a change touched). A red `verify` means the graph is stale or a
regeneration was missed — rebuild before trusting navigation. The `graph.db`
input comes from the code-review-graph tool (tree-sitter level today; a Joern
adapter with `cpg` precision is the planned upgrade — see
`docs/DESIGN-callnav.md`).
