---
gep: 0003
title: The `geml-code-graph` diagram format
state: accepted
author: GEML (maintainer)
created: 2026-07-03
issue: (design reviewed in docs/DESIGN-codemap-delta.md §2/§11-5)
---

## Summary

Register `geml-code-graph` as an interpreted diagram format: a layered
method-flow view over a **codemap** document tree (docs/codemap-profile.md).
The embed takes **exactly one attribute** — `src=`, the codemap document to
render — and an empty body:

```
=== diagram {format=geml-code-graph src=codemap/index.geml}
===
```

Roots and depth are **never** authored at the embed site: they come from the
meta of the document `src` points at (`entry`, optional `graph-depth`). View
configuration travels with the data, so an embed cannot drift from it; a
different root means pointing at a different container document, and
method-level drill-down is an *interaction* (click a node), not an authored
parameter.

## Two scenarios

1. **Inside a codemap** — generated documents are pure data and carry **no**
   diagram block. A renderer that recognises a codemap document (its meta
   declares `module =` or `container =`, plus an `entry` surface) SHOULD offer
   the layered view for it directly (an implicit self-embed).
2. **Anywhere else** — the explicit embed above, e.g. in a design document or
   README, following the `geml-chart` precedent of pointing at data rather than
   copying it.

## Parse-time checks

- `format=geml-code-graph` is a registered format (no "unregistered renderer"
  warning).
- A missing `src=` is a **warning** ("nothing to render").
- With a `resolveDoc` hook, an unresolvable `src` is a **warning** (documents
  render on other machines; a hard error would be wrong).
- A non-empty body is a **warning** (the embed is configured by `src=` alone).

## Rendering algorithm (normative)

The slice is built at **data time**; the layout runs at **draw time** (in the
page runtime), which is what makes interactive re-rooting possible. Conforming
renderers MUST produce the same layering for the same input:

1. **Slice.** Starting from the roots (the target document's meta `entry`
   references), traverse `#calls` tables breadth-first following `call` and
   `candidate` rows, resolving `doc.geml#id` references relative to each
   document, to at most `graph-depth` (default **6**) levels. A container with
   **no** `entry` (an app's very top — nothing external calls into it, so the
   generator writes none) roots at its in-degree-zero methods instead,
   computed from its own `#calls`/`#called-by` rows: an implicit view MUST NOT
   come out blank. Nodes at the
   horizon that still have outgoing rows are marked (rendered with a `›`
   marker). Renderers MAY cap the slice (this implementation: 400 nodes) and
   MUST say so visibly when they do.
2. **Back edges.** Depth-first search over the slice from the roots; an edge to
   a node currently on the DFS stack is a *back edge*. Self-recursion is a back
   edge by definition. Back edges are excluded from layering and drawn
   distinctly (dashed, looping to the side); self-recursion renders as a loop
   badge on the node.
3. **Layering.** Longest-path layering over the remaining DAG:
   `layer(v) = max(layer(pred)) + 1`, roots at layer 0. In-layer order is
   stable (lexicographic by display name).
4. **Index documents.** A codemap INDEX (meta declares `container =`)
   renders the MODULE-level aggregation from its `#modules`/`#module-edges`
   tables — one node per container, edge tooltips carry call counts. Roots are
   the modules holding app entries **plus** in-degree-zero modules (a merged
   multi-project map has clusters no app entry reaches — a library consumed
   through its built package — and each must layer from its own top); modules
   still unreachable park on one extra bottom layer (an overview must not
   hide anything). Clicking a
   module opens that container document's own rendered page
   (`<doc>.geml` → `<doc>.html`). Descending into methods happens per
   container — never as one whole-repo method canvas.
5. **Scale.** Renderers MUST draw at natural size inside a scrollable mount
   and SHOULD offer zoom controls (−/+/fit/1:1). Squeezing the canvas to the
   column width is non-conforming: at repo scale it yields unreadable 1px
   text. Slice caps stay (with a visible note), but the module overview is
   the intended first view, where the cap is never the reader's problem.
6. **Styling semantics.** `.leaf` targets render de-emphasised (dimmed);
   `.test` nodes render distinctly (dashed border); `candidate` edges render
   dotted; `medium`/`low`-confidence edges render softened. Clicking a node
   re-roots the view on it within the embedded slice; the renderer MAY load the
   block's `src=` to display source.

Total cost is O(V+E) per redraw.

## Conformance impact

This format is interpretation at *render* time; the parse-time surface is the
three warnings above. Conformance cases cover: format registration (no
unregistered-format warning), the missing-`src` / unresolvable-`src` /
non-empty-body warnings. The layered layout itself is exercised by the
reference renderer's test suite (slice content, cross-document traversal,
root/depth sourcing from meta) rather than the language conformance corpus —
same split as `geml-chart` (whose data binding is conformance-tested but whose
SVG is not).

## Compatibility

Pre-existing documents are unaffected: the format name was previously an
unregistered-format warning; it now parses clean. The codemap profile itself
needs no change — generated files remain diagram-free (scenario 1).

## Reference implementation

`geml-parser/src/render.ts` (`buildCodeGraph` + the embedded draw-time
runtime; CLI supplies document loading via `RenderOptions.loadDoc/parseDoc`).
Verified on the valkey codemap: index view (9 app entries), container view
(62 entries / 355 nodes), interactive re-root, dashed back edge, dotted
candidate, dimmed leaves — in-browser DOM assertions.
