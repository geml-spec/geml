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
2. **Slice cross-block edges.** When emitting a slice (a module, or a PR's impact
   subgraph), edges that leave the slice need a policy: drop them, or point at a
   per-module document via cross-doc references (`other.geml#id`).
3. **Build ② or stay ⓪-slice?** Decide once there is a concrete consumer (a
   reviewer view, a CI architectural-diff check). Until then, ⓪ + slicing is
   sufficient and costs nothing.
4. **Tooling.** `tools/graph2geml.mjs` is a working prototype serializer
   (code-review-graph SQLite → GEML, encoding ⓪; `full` / `dir` / `flow` modes).

## Status

Exploratory. Spike and scale validation complete; no implementation commitment
beyond the prototype serializer. Recorded so the direction and its evidence are
not lost.
