---
gep: 0002
title: Representing a code dependency graph as GEML
state: draft
author: GEML (maintainer)
created: 2026-07-01
issue: (exploratory — spike + scale validation done)
---

## Summary

Represent a codebase's dependency graph — nodes (files / functions / types),
edges (calls / imports / inherits) — as a GEML document, so the graph gains
GEML's three properties: build-time **reference checking** (a dangling edge is a
`geml check` error, not a silent broken pointer), plain-text **diffability**
(per-node blocks review cleanly in a PR), and **versioned history** via
`.gemlhistory` (`history log` / `revert` a single node across code commits). The
graph is produced by an existing tool (the tree-sitter–based *code-review-graph*);
GEML is proposed as its **verifiable, versionable, diffable source
representation**, from which interactive views are *rendered* — not the reverse.

This GEP records the design space and the evidence. It does **not** commit to
shipping a new block type: the zero-new-spec encoding (⓪ below) already works.

## Motivation

A dependency graph is exactly the kind of reference structure GEML checks. An
edge to a function that no longer exists is a *dangling reference* — the failure
mode GEML was built to turn into a hard error. Versioning the graph beside the
code (reverse-delta `.gemlhistory`) yields a plain-text, offline **architectural
history**: "what did the call graph look like three commits ago", "which edges
did this PR add/remove", "roll this node's edges back". These are awkward with a
binary graph store and impossible with a one-line JSON blob.

## Design

**The fork: are nodes first-class GEML blocks, or opaque data inside a body?**
This single choice decides whether the representation keeps verifiability and
per-node history.

- **⓪ Flow blocks + `[[#id]]` edges.** Each node is `=== note {#id .Kind}`; each
  internal edge is a `[[#id]]` auto-reference in the body. Uses only existing
  GEML: `geml check` verifies every edge resolves, `geml get`/`set`/`revert`
  address one node, `.gemlhistory` versions per node. **Zero new spec, works
  today.** Cost: verbose (one block per node).
- **① Opaque external DSL** (`=== diagram {format=mermaid|d2|graphviz}`). GEML
  does not interpret the body, so edges are **unchecked** and there is no
  per-node history. Fine for a hand-drawn picture; wrong for a graph whose
  integrity should be enforced.
- **② A registered, interpreted `dep-graph` format** (`=== diagram
  {format=dep-graph}`), following the `geml-chart` precedent — GEML parses the
  body, checks edge endpoints, then renders. Keeps verifiability, is compact,
  can render a laid-out graph. Cost: a spec addition — body grammar,
  reference-checking rules, a renderer, conformance cases, and a second
  implementation.

**Principle — store the checked structure, project the picture.** As
`geml-chart` treats a `#table` as the single source of truth and derives the
chart, a code graph should live as the checked + versioned GEML source and be
*projected* to an interactive view (D3 / graphviz / mermaid). Do not store the
graph *as* a picture — ① throws away the checking.

**Internal vs external edges.** In a real graph most edges leave it (stdlib
headers, unresolved symbols). Only **internal** edges (target is also a node) may
be encoded as checked `[[#id]]` references; external endpoints must be plain data
(an attribute, or a declared stub), or they become tens of thousands of false
"dangling reference" errors.

## Evidence (scale test)

Serialized the real *code-review-graph* SQLite DB of **valkey** (14,406 nodes,
100,020 edges) to GEML with encoding ⓪ (`tools/graph2geml.mjs`):

- Whole graph → **1.04 MB** `.geml`; `geml check` verified all **24,525 internal
  edges in 0.66 s**. Whole-repo-in-one-document is comfortable at ~10⁴ nodes;
  slicing is for *focus*, not scale.
- **68,923 / 100,020 edges (69 %) are external** — confirms the internal/external
  partition above.
- `.gemlhistory` on the 1 MB graph: commit v1 (keyframe) 0.39 s; commit v2 (one
  node changed) **2.9 s** — the reverse-delta diff is an **O(N²) LCS over
  document units**, the one scaling bottleneck (~3 s at 14 k units; painful past
  ~50 k). `verify` 0.28 s; sidecar ≈ 1× the document plus deltas.

**Edge quality — the tree-sitter ceiling.** Breaking the edges down by kind
exposes what "69 % external" is made of: of **80,863 CALLS** edges, only ~15,570
resolve to an internal node, and of those a mere **12 are cross-file**; resolved
IMPORTS_FROM: 10. Another 15,287 edges are CONTAINS (file → member), which is
structural, not semantic. So with tree-sitter extraction the graph effectively
contains **no cross-module dependency structure** — the unresolved majority is
mostly *same-repo calls the parser cannot link*, not stdlib. Two consequences:

1. **Checking is only as good as edge resolution.** With tree-sitter data,
   `geml check` mostly verifies same-file calls and containment — low value. The
   compelling check ("this PR broke a cross-module dependency") requires
   **LSP-grade resolution** (`callHierarchy`, `references`, `typeHierarchy` from
   clangd / rust-analyzer / gopls …). The pragmatic pipeline is hybrid:
   tree-sitter for fast uniform structure, LSP to resolve edges.
2. **Partition quality cannot be measured from this data.** Every granularity
   (file / directory / top-level) shows "100 % intra-partition edges" — an
   artifact of the missing cross-file edges, not evidence of modularity. Choosing
   a partition by minimizing cross-partition edges needs LSP-resolved edges.

**Partitioned (organized) emit.** `graph2geml.mjs partition` emits one document
per source **directory** — inside each, a `##` heading per file with its member
nodes nested under it (containment expressed as document structure, CONTAINS
edges dropped as redundant), semantic edges as `calls:` / `imports:` /
`tested-by:` reference lines, cross-directory edges as **cross-document
references** (`[name](other.geml#id)`), plus an `index.geml`. On valkey this
yields **44 documents + index (0.88 MB total, median 66 nodes/doc)** and all 45
pass `geml check` — including cross-document reference resolution, which GEML
checks fully (a missing sibling file or id is an error, verified separately), so
**splitting costs no verifiability**. Directory is the sensible *default*
granularity: stable across commits, PR-aligned, incrementally re-emittable —
until LSP edges allow an evidence-based split.

**Entry points as navigation anchors.** Two data-driven signals, no semantic
guessing: a `main` function gets the semantic class `.entry`, the entry of a
high-criticality execution flow (≥ 0.6 from the tool's `flows` table) gets
`.flow-entry` — both queryable in the model. Partition mode surfaces them for
navigation: an "Entry points:" line under each document's title, and two index
sections — program entry points grouped by partition (few-main partitions first,
so a vendored repo's test/example mains pile up at the end instead of burying
`src`'s real ones; capped with "+N more" links) and the top critical flow
entries. On valkey: 176 `main`s, 68 flow entries ≥ 0.6 (e.g. `hashtableFind`).

**Tests are marked and separated.** The db marks recognized test *cases*
(kind `Test` → class `.Test`; 306 on valkey) but not test *code*: helpers inside
a test file are plain Functions. Test territory is therefore derived from the
repo's own path conventions — a `test`/`tests`/`spec` directory segment or a
test-named file — an avowed heuristic, kept conservative. Every node in test
territory gets the `.test` class (valkey: 2,437), so a query can exclude tests
("non-test callers of X") or select them. Navigation separates them too: the
index splits `main`s into *Program* vs *Test entry points* and the partition
list into *source* vs *tests* (≥ 50 % test nodes); mixed partitions show their
test count, and each document's `meta` records `tests = N`. On valkey the
filename convention even catches `src/unit` (203/219 test nodes) although its
directory name never says "test".

For comparison, the tool's existing `graph.html` export embeds the same graph as
an inline JSON blob + a D3 viewer in a **20 MB** self-contained file. That proves
the single-file whole-graph pattern is viable and useful — but it is a *projected
view*: not text-diffable, not reference-checked, not per-node versioned, and it
loads D3 from a CDN. The GEML source is ~20× smaller and is all three.

## Conformance impact

- Encoding ⓪ introduces **no** new block types — it is an application of existing
  GEML (`note`, `[[#id]]`), so there is nothing to add to the conformance suite.
- Encoding ② would register a new interpreted `diagram` format and therefore
  require conformance cases (body grammar + reference checking) reproduced by the
  second implementation, exactly as `geml-chart` is.

## Alternatives considered

- **Opaque DSL (①)** as the source representation. Rejected: it discards
  reference checking and per-node history — the whole reason GEML is interesting
  here. Retained only as a *render target*.
- **A JSON blob (as `graph.html` does).** Great for an interactive view; poor as
  a versioned source (one-line diffs, no checking, no per-node addressing).

## Open questions / follow-ups

1. **History at scale — LCS by id.** Most graph nodes carry a unique `#id`; those
   units can be matched by id in linear time, reserving the O(N²) LCS for the
   unkeyed remainder — a concrete `geml-parser/src/history.ts` optimization that
   removes the one measured bottleneck.
2. **LSP-resolved edges.** The measured tree-sitter graph has essentially no
   cross-module edges (12 resolved cross-file calls out of 80,863) — so the
   valuable half of the check is empty. Feed the serializer LSP-resolved edges
   (hybrid: tree-sitter structure + `callHierarchy`/`references` resolution) and
   re-measure: cross-document reference counts, check time, and — for the first
   time meaningfully — partition quality (cross-partition edge %).
3. **Partition granularity.** Directory is the default (valkey: 44 docs, median
   66 nodes, all checks green). Revisit with LSP edges: pick the granularity
   minimizing cross-document edges, or align with the tool's own community
   detection. ~~Slice cross-block edge policy~~ — resolved: emit them as
   cross-document references; GEML checks them fully, so splitting costs no
   verifiability.
4. **Build ② or stay ⓪-slice?** Decide once there is a concrete consumer (a
   reviewer view, a CI architectural-diff check). Until then, ⓪ + slicing is
   sufficient and costs nothing.
5. **Tooling.** `tools/graph2geml.mjs` is the working prototype serializer
   (code-review-graph SQLite → GEML, encoding ⓪; `full` / `dir` / `flow` /
   `partition` modes).

## Status

Exploratory. Spike and scale validation complete; no implementation commitment
beyond the prototype serializer. Recorded so the direction and its evidence are
not lost.
