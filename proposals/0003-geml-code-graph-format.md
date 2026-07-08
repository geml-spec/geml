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
   marker). Renderers MAY cap the slice, and a cap MUST be visible AND
   recoverable — say "showing X of Y reachable" and offer controls to extend
   it (this implementation: the view draws the first 400 in BFS order with
   `+400`/`all` buttons; the embedded payload is capped only at 4000 as
   insurance, and the codemap documents themselves are always complete).
2. **Back edges.** Depth-first search over the slice from the roots; an edge to
   a node currently on the DFS stack is a *back edge*. Self-recursion is a back
   edge by definition. Back edges are excluded from layering and drawn
   distinctly (dashed, looping to the side); self-recursion renders as a loop
   badge on the node.
3. **Layering.** Longest-path layering over the remaining DAG:
   `layer(v) = max(layer(pred)) + 1`, roots at layer 0. In-layer order is
   stable: group first (the tint group — same-coloured nodes sit together),
   display name second; the layout SHOULD leave a small extra gap where the
   group changes so the colour runs read as blocks.
4. **Index documents.** A codemap INDEX (meta declares `container =`)
   renders GROUPED module navigation over its `#modules`/`#module-edges`
   tables. The module paths span a grouping tree; **each view is exactly one
   tree node's children** — subgroups (badged `seg ▸count`) and containers,
   never a mixed-depth cut — and a view whose only child is a group TUNNELS
   into it, so single-child package ceremony (`src/main/java/…`) costs
   nothing. Module paths arrive PRE-NORMALISED from the build (each
   module's shared ceremony prefix — the source root like `src/main/java`
   plus the common package root — is stripped into the display path; the
   true directory stays in the document's `src=`, see
   docs/codemap-profile.md §2), so the grouping tree spans real structure
   and tunnelling only absorbs the single-child ceremony that
   normalisation cannot prove shared. Edges aggregate to the view's level
   (tooltips carry call counts); calls leaving the subtree aggregate into dimmed external stubs —
   a view must not hide its dependencies. Roots per view are the children
   holding app entries **plus** in-degree-zero children (a merged
   multi-project map has clusters no app entry reaches — a library consumed
   through its built package — and each must layer from its own top);
   children still unreachable park on one extra bottom layer. Clicking a
   group descends IN PLACE — the payload ships the raw rows, so every tree
   level derives without refetch or rebuild — and the breadcrumb walks back
   up. Clicking a container opens it: a live renderer swaps the embedded
   view in place, while static multi-page output links the container's
   pre-rendered sibling page (`<doc>.geml` → `<doc>.html`). Descending into
   methods happens per container — never as one whole-repo method canvas.
5. **Scale.** Renderers MUST draw at natural size inside a scrollable pane
   and SHOULD offer zoom controls (−/+/fit/1:1). Squeezing the canvas to the
   column width is non-conforming: at repo scale it yields unreadable 1px
   text. The initial view SHOULD fit the CROSS axis only — height in
   left-right, width in top-down; the reading axis is meant to scroll —
   clamped to [2/3, 1] so text stays readable and small graphs open at
   exactly 1:1; the fit control SHOWS the whole graph (both axes, no floor).
   Left-right (layers as columns, call flow reading with the text) is the
   default orientation, with a top-down toggle persisted per reader. The toolbar (crumb, zoom,
   back/reset) and the footer MUST stay visible while the canvas scrolls —
   navigation that scrolls out of reach is how a reader gets stranded. Slice
   caps stay (with a visible note), but the module overview is the intended
   first view, where the cap is never the reader's problem.
6. **Styling semantics.** `.leaf` targets render de-emphasised (dimmed);
   `.test` nodes render distinctly (dashed border); `.accessor` nodes
   (bean-style get/set/is leaves) are HIDDEN by default — with a visible
   count and toggle ("N accessors hidden"), never silently; `candidate`
   edges render dotted; `medium`/`low`-confidence edges render softened. Every edge
   carries a small arrowhead pointing at the CALLEE (back-edges in their own
   tint) — in every view, including the callers view, the arrow direction is
   the call direction. Hovering a node SHOULD light up its caller cone — every
   upstream node and edge within the current view — and dim the rest. Clicking
   a node re-roots the view on it within the embedded slice; the renderer MAY
   load the block's `src=` to display source.
7. **Caller direction and the way back up.** A ⊕ handle sits on the current
   view's ROOT node(s) only — a mid-graph node's callers are already drawn
   as its in-edges; the entry is the one place the upstream is invisible.
   Clicking it expands the COMPLETE caller chain (traversal from `#called-by`
   tables, not depth-limited — its point is reaching the app entry; only the
   node cap guards it). The chain MUST render in TRUE call order — the same
   direction as every other view: ultimate callers first, the focused method
   at the far end (data carries edges callee → caller with roots=[focus] so
   the standard layering applies; the renderer flips layers and edge
   endpoints at draw time). The focused method carries the MIRRORED handle
   at its far edge, which flips straight back to the callee chain it came
   from: `⊕C1→C2→C3` ⇄ `A→B→C1⊕`; the callers view opens SCROLLED to the
   focused end, not the app-entry end. A static payload MAY fall back to
   reversing its in-slice edges but MUST label the view partial. In the
   callers view a node-body click opens that node's callee chain. The toolbar
   crumb is a breadcrumb over the navigation hierarchy,
   `modules / <container> / <state>`: both upper levels are clickable, and a
   live renderer swaps views in place (the embed walks the `.geml` tree
   without leaving the page) while static pages link their pre-rendered
   siblings. The footer carries live facts (visible/total counts).

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
