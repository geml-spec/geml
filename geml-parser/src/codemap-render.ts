// `geml-code-graph` — the diagram renderer `geml-codemap/v1` supplies.
//
// The dispatch for it used to be an `if (fmt === "geml-code-graph")` inside
// render.ts, in the same chain as the specification's own `geml-chart` and
// `mermaid`: the core renderer knew one vocabulary by name. It is a
// host-registered renderer now (`RenderOptions.diagrams`). §7 already said a
// `format=` names a RENDERER and that an unknown one degrades to a labelled
// source block — the extension point was the specification's all along; what
// was missing was that the table could be extended.
//
// The SLICE BUILDER stays in render.ts and is imported here, which is a
// deliberate stop short of the whole move: `buildCodeGraph`,
// `codeGraphRuntime` and `codeGraphWaves` are on the viewer's own import path
// (`integrations/geml-viewer/src/parse-entry.js` takes all three from
// `render.js`), and the extension's esbuild build fails on any missing named
// export. Moving them is a cross-package change, not a refactor of this file.
import { buildCodeGraph, CG_MAX_NODES, type DiagramRenderer, esc, escAttr } from "./render.js";

/**
 * The renderer itself. Registered by the host under `geml-code-graph`; a build
 * that does not register it leaves such a block to §7's labelled-source
 * fallback, which is the correct degradation and not an error.
 */
export const codeGraphDiagram: DiagramRenderer = (b, ctx) => {
  const src = typeof b.attrs["src"] === "string" ? (b.attrs["src"] as string) : "";
  const { idAttr, cap, classes } = ctx;
  if (!src) {
    return `<figure${ctx.clsAttr(classes, "code-graph")}${idAttr}><p class="render-error">geml-code-graph: missing <code>src=</code></p>${cap}</figure>`;
  }
  if (ctx.opts.graphSidecar) {
    // Sidecar mode (served pages): don't build the slice here at all — the
    // page ships without the payload and the runtime fetches it from the
    // sidecar route after first paint. Errors surface in the mount then.
    ctx.use("code-graph");
    return `<figure${ctx.clsAttr(classes, "code-graph")}${idAttr}><div class="cg-mount" data-start="${escAttr(src)}"` +
      ` data-graph-src="${escAttr(ctx.opts.graphSidecar + encodeURIComponent(src))}"></div>${cap}</figure>`;
  }
  const r = buildCodeGraph(src, ctx.opts);
  if (r.error !== undefined) {
    return `<figure${ctx.clsAttr(classes, "code-graph")}${idAttr}><p class="render-error">geml-code-graph: ${esc(r.error)}</p>${cap}</figure>`;
  }
  ctx.use("code-graph");
  const note = r.truncated ? `<p class="cg-note">graph data capped at ${CG_MAX_NODES} nodes for this embed — the codemap documents themselves are complete</p>` : "";
  // data-start carries the slice's own document path so a live module
  // script (opts.liveGraph) can hook the mount without re-parsing the
  // multi-MB payload attribute.
  return `<figure${ctx.clsAttr(classes, "code-graph")}${idAttr}><div class="cg-mount" data-start="${escAttr(r.data!.start)}" data-graph="${escAttr(JSON.stringify(r.data))}"></div>${note}${cap}</figure>`;
};
