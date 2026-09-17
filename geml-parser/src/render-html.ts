// GEML CLI HTML export — the standalone, self-contained page.
//
// This is the CLI-only entry point that wraps a rendered document body in a
// full HTML page shell. Math (KaTeX) and Mermaid load from a CDN, and only when
// the document actually uses them, so a document of prose, tables and charts is
// fully self-contained with zero network.
//
// It lives in its OWN module (separate from ./render) so that consumers who only
// need the in-browser graph runtime (buildCodeGraph/codeGraphRuntime/
// codeGraphWaves) — notably the browser-extension viewer bundle — never pull in
// these CDN/remote-script string literals. The Chrome Web Store scanner rejects
// bundles that contain remotely-hosted-code references.

import { type Block, type Document } from "./geml.js";
import {
  CSS,
  JS,
  CODE_GRAPH_JS,
  CODE_GRAPH_CSS,
  RenderCtx,
  esc,
  escAttr,
  type RenderOptions,
} from "./render.js";

function page(title: string, body: string, ctx: RenderCtx, source?: string): string {
  const mathHead = ctx.usedMath
    ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">\n` +
      `<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>\n` +
      `<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body,{delimiters:[{left:'\\\\[',right:'\\\\]',display:true},{left:'\\\\(',right:'\\\\)',display:false}]})"></script>\n`
    : "";
  const mermaidHead = ctx.usedMermaid
    ? `<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";m.initialize({startOnLoad:true});</script>\n`
    : "";
  const footer = source
    ? `<footer class="geml-footer">Rendered from <code>${esc(source)}</code> by the GEML runtime. Tables are sortable and filterable; the chart is inline SVG drawn from its bound table.</footer>`
    : "";
  // Live enhancement for served pages: attach _cgView loaders after the
  // static bootstrap has drawn. The runtime reads the hook lazily, so late
  // binding works with no redraw; if this module never loads (offline copy,
  // old browser), the page simply stays static. The parser dist imports
  // node:* for its CLI paths — an import map points those at the served stub
  // (same trick as the viewer's esbuild alias), and the process shim must be
  // in place BEFORE the modules evaluate, hence the dynamic import().
  const wantLive = ctx.usedAssets.has("code-graph") && !!ctx.opts.liveGraph;
  const lg = wantLive ? escAttr(ctx.opts.liveGraph!) : "";
  const importMap = wantLive
    ? `<script type="importmap">{"imports":{"node:fs":"${lg}_node-stub.js","node:path":"${lg}_node-stub.js","node:crypto":"${lg}_node-stub.js","node:url":"${lg}_node-stub.js","node:child_process":"${lg}_node-stub.js","node:os":"${lg}_node-stub.js"}}</script>\n`
    : "";
  const liveJs = wantLive
    ? `<script type="module">
globalThis.process ??= { argv: [], env: {} };
const { parse } = await import("${lg}geml.js");
const { codeGraphWaves } = await import("${lg}render.js");
const w = codeGraphWaves(async (rel) => {
  try { const r = await fetch(rel, { cache: "no-cache" }); return r.ok ? await r.text() : null; } catch { return null; }
}, parse);
for (const m of document.querySelectorAll(".cg-mount[data-start]")) {
  const start = m.getAttribute("data-start");
  m._cgView = async (view) => {
    // A directed view builds from the node's OWN document (its meta names the
    // module and graph-depth); {doc} opens that document; else the mount's.
    const src = view && view.doc ? view.doc
      : view && view.node ? view.node.slice(0, view.node.lastIndexOf("#"))
      : start;
    const r = await w.build(src, view && view.doc ? undefined : view);
    return r.error !== undefined ? null : r.data;
  };
}
</script>\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}${ctx.usedAssets.has("code-graph") ? CODE_GRAPH_CSS : ""}</style>
${importMap}${mathHead}${mermaidHead}</head>
<body>
<main>
${body}
</main>
${footer}
<script>${JS}</script>
${ctx.usedAssets.has("code-graph") ? `<script>${CODE_GRAPH_JS}</script>\n` : ""}${liveJs}</body>
</html>
`;
}

export function renderHtml(doc: Document, opts: RenderOptions = {}): string {
  const ctx = new RenderCtx(doc, opts);
  let body = doc.children.map((b) => ctx.block(b)).filter((s) => s !== "").join("\n");
  // Codemap scenario ① (GEP-0003): a codemap document (meta declares module=
  // or container=, plus an entry surface) IS the graph data — offer the layered
  // method-flow view at the top, an implicit self-embed.
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta" && b.data) as
    Extract<Block, { kind: "block" }> | undefined;
  const md = meta?.data ?? {};
  if ((md["module"] !== undefined || md["container"] !== undefined)
      && opts.loadDoc && opts.parseDoc && opts.source) {
    const cap = md["entry"] !== undefined || md["container"] !== undefined
      ? `layered method flow — roots from this document's <code>entry</code>`
      : `layered method flow — roots: in-degree-zero methods (no <code>entry</code> declared)`;
    // Through the registered renderer, not a method on the context: this page
    // shell used to reach into the core renderer for one vocabulary's figure.
    // A build that does not register `geml-code-graph` simply gets no offer.
    const draw = opts.diagrams?.["geml-code-graph"];
    if (draw !== undefined) {
      const synthetic = { kind: "block", type: "diagram", mode: "raw", classes: [], attrs: { format: "geml-code-graph", src: opts.source } } as Parameters<typeof draw>[0];
      body = draw(synthetic, {
        raw: "", idAttr: "", cap: `<figcaption>${cap}</figcaption>`, classes: [],
        clsAttr: (cs, own) => ` class="${[...cs, ...(own === undefined ? [] : [own])].join(" ")}"`,
        opts, use: (asset) => { ctx.usedAssets.add(asset); },
      }) + "\n" + body;
    }
  }
  // Fragment mode: the body markup alone, for embedding into an existing
  // layout. No shell, no CDN tags, no inline CSS/JS — see RenderOptions.
  if (opts.fragment) return body + "\n";
  // A vocabulary this processor does not ship (§8.6.2 rule 3) degrades what is
  // on this page: its blocks are drawn by the unknown-type fallback, which
  // labels them "unknown block type" — the same label a MISTYPED type gets. A
  // reader cannot tell those apart from the block alone, and the difference is
  // the whole question of whose fault it is. So the page says which vocabulary
  // it was rendered without, once, above the content it explains.
  //
  // Fragment mode gets none of this on purpose: a fragment goes into someone
  // else's layout, which owns its chrome, and the viewer already renders every
  // model diagnostic as a banner of its own.
  // …and only when the page actually shows a block it could not read. A notice
  // naming a vocabulary whose absence changed nothing visible tells the reader
  // about a dependency without showing them any effect of it.
  const missing = !ctx.usedUnknownType ? [] : [...new Set(
    (doc.diagnostics ?? [])
      .filter((d) => d.code === "unrecognized-vocabulary" && d.subject !== undefined)
      .map((d) => d.subject!),
  )];
  if (missing.length > 0) {
    const names = missing.map((n) => `<code>${esc(n)}</code>`).join(", ");
    const was = missing.length === 1 ? "a vocabulary this renderer does not have" : "vocabularies this renderer does not have";
    body = `<div class="geml-missing-vocab">Rendered without ${was}: ${names}. `
      + `Blocks those define are shown below as raw text, labelled <em>unknown block type</em>; `
      + `that label here means this renderer is missing something, not that the document is wrong.</div>\n`
      + body;
  }
  const title = opts.title ?? ctx.docTitle() ?? "GEML document";
  return page(title, body, ctx, opts.source);
}

// The page shell's static assets, for fragment consumers: `css` styles every
// geml-* class a fragment emits (include once per site); `js` is the tables'
// sort/filter enhancement (once per page); `codeGraphJs` matters only when a
// fragment carries a code-graph mount. The full-page output inlines all three.
export const pageAssets = { css: CSS, js: JS, codeGraphJs: CODE_GRAPH_JS, codeGraphCss: CODE_GRAPH_CSS } as const;
