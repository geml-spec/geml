// GEML reference renderer — P0 runtime: a GEML document -> one self-contained,
// interactive HTML artifact.
//
// What an agent hands a person is the `.geml` file. This runtime turns it into a
// page a browser can open and *use*: prose and headings, callouts, code, math,
// diagrams, tables you can sort and filter, and charts drawn as inline SVG
// straight from their bound table (no second copy of the data).
//
// Self-containment: the CSS, the table interactivity, and every chart are inlined
// into the single HTML file. Math (KaTeX) and Mermaid diagrams are the one
// exception. They load from a CDN, and only when the document actually uses them,
// so a document of prose, tables and charts is fully self-contained with zero
// network. Bundling those two engines offline is the next step (roadmap P0 #6).

import { type Block, type Document } from "./geml.js";
import { type Inline } from "./inline.js";
import { type Align, type TableCell, type TableModel } from "./table.js";
import { type ChartModel } from "./chart.js";
import { type Value } from "./attrs.js";

const PALETTE = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#ea580c"];

export interface RenderOptions {
  title?: string;
  source?: string; // source file name, shown in the footer
  // Hooks for the geml-code-graph embed (GEP-0003): load a sibling document's
  // source by path relative to the rendered file, and parse it. Supplied by the
  // CLI; without them an embed degrades to a plain note.
  loadDoc?: (relPath: string) => string | null;
  parseDoc?: (source: string) => Document;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

class RenderCtx {
  usedMath = false;
  usedMermaid = false;
  usedCodeGraph = false;
  labels = new Map<string, string>(); // id -> link label for [[#id]] auto-refs

  constructor(private doc: Document, readonly opts: RenderOptions = {}) {
    this.indexLabels(doc.children);
  }

  // Build the id -> label map: a heading's text, or a block's caption, or its id.
  private indexLabels(blocks: Block[]): void {
    for (const b of blocks) {
      if (b.kind === "heading") this.labels.set(b.id ?? "", b.text);
      else if (b.kind === "block") {
        if (b.id) {
          const cap = b.attrs["caption"];
          this.labels.set(b.id, typeof cap === "string" ? cap : (b.table?.caption ?? b.id));
        }
        if (b.children) this.indexLabels(b.children);
      }
    }
  }

  docTitle(): string | undefined {
    for (const b of this.doc.children) {
      if (b.kind === "block" && b.type === "meta" && b.data && typeof b.data["title"] === "string") {
        return b.data["title"] as string;
      }
    }
    for (const b of this.doc.children) if (b.kind === "heading") return b.text;
    return undefined;
  }

  // ----- inline -----

  inlines(ns: Inline[]): string {
    return ns.map((n) => this.inline(n)).join("");
  }

  private inline(n: Inline): string {
    switch (n.type) {
      case "text": return esc(n.value);
      case "emph": return `<em>${this.inlines(n.children)}</em>`;
      case "strong": return `<strong>${this.inlines(n.children)}</strong>`;
      case "strike": return `<del>${this.inlines(n.children)}</del>`;
      case "code": return `<code>${esc(n.value)}</code>`;
      case "math": this.usedMath = true; return `<span class="math">\\(${esc(n.value)}\\)</span>`;
      case "break": return "<br>\n";
      case "image": return this.media(n);
      case "link": return this.link(n);
      case "autoref": {
        const href = n.doc ? `${n.doc.replace(/\.geml$/, ".html")}#${n.anchor}` : `#${n.anchor}`;
        const label = n.doc ? (n.anchor ?? n.doc) : (this.labels.get(n.anchor) ?? n.anchor);
        return `<a href="${escAttr(href)}">${esc(label)}</a>`;
      }
      case "footnote": return `<sup class="fn"><a href="#${escAttr(n.ref)}">${esc(n.ref)}</a></sup>`;
    }
  }

  private media(n: Extract<Inline, { type: "image" }>): string {
    const src = escAttr(n.src);
    if (n.as === "video") return `<video class="media" src="${src}" controls></video>`;
    if (n.as === "audio") return `<audio class="media" src="${src}" controls></audio>`;
    return `<img class="media" src="${src}" alt="${escAttr(n.alt)}">`;
  }

  private link(n: Extract<Inline, { type: "link" }>): string {
    let href = "#";
    if (n.href) href = n.href;
    else if (n.doc) href = `${n.doc.replace(/\.geml$/, ".html")}${n.anchor ? "#" + n.anchor : ""}`;
    else if (n.anchor) href = `#${n.anchor}`;
    const rel = typeof n.attrs["rel"] === "string" ? ` rel="${escAttr(n.attrs["rel"] as string)}"` : "";
    const target = typeof n.attrs["target"] === "string" ? ` target="${escAttr(n.attrs["target"] as string)}"` : "";
    return `<a href="${escAttr(href)}"${rel}${target}>${this.inlines(n.children)}</a>`;
  }

  // ----- blocks -----

  block(b: Block): string {
    switch (b.kind) {
      case "hidden": return "";
      case "heading": {
        if (b.hidden) return "";
        const id = b.id ? ` id="${escAttr(b.id)}"` : "";
        const lvl = Math.min(6, Math.max(1, b.level));
        return `<h${lvl}${id}>${this.inlines(b.inlines)}</h${lvl}>`;
      }
      case "paragraph": {
        const html = this.inlines(b.inlines).trim();
        return html === "" ? "" : `<p>${html}</p>`;
      }
      case "list": return this.list(b);
      case "block": return this.typed(b);
    }
  }

  private list(b: Extract<Block, { kind: "list" }>): string {
    const tag = b.ordered ? "ol" : "ul";
    const start = b.ordered && b.start !== undefined && b.start !== 1 ? ` start="${b.start}"` : "";
    const isTask = b.items.some((it) => it.checked !== undefined);
    const items = b.items.map((it) => {
      let inner = this.inlines(it.inlines);
      if (b.loose) inner = `<p>${inner}</p>`;
      const box = it.checked === undefined ? "" : `<input type="checkbox" disabled${it.checked ? " checked" : ""}> `;
      const kids = (it.children ?? []).map((c) => this.block(c)).filter((s) => s).join("\n");
      const cls = it.checked === undefined ? "" : ' class="task"';
      return `  <li${cls}>${box}${inner}${kids ? "\n" + kids : ""}</li>`;
    }).join("\n");
    return `<${tag}${isTask ? ' class="task-list"' : ""}${start}>\n${items}\n</${tag}>`;
  }

  private typed(b: Extract<Block, { kind: "block" }>): string {
    if (b.hidden) return ""; // {hidden}: in the model, never rendered
    const raw = (b.raw ?? []).join("\n");
    const caption = typeof b.attrs["caption"] === "string" ? (b.attrs["caption"] as string) : undefined;
    const idAttr = b.id ? ` id="${escAttr(b.id)}"` : "";

    switch (b.type) {
      case "meta": return ""; // header metadata, not body content
      case "code": {
        const lang = typeof b.attrs["lang"] === "string" ? (b.attrs["lang"] as string) : "";
        const cls = lang ? ` class="language-${escAttr(lang)}"` : "";
        return `<pre${idAttr}><code${cls}>${esc(raw)}</code></pre>`;
      }
      case "output":
        return `<pre class="output"${idAttr}><code>${esc(raw)}</code></pre>`;
      case "math":
        this.usedMath = true;
        return `<div class="math-block"${idAttr}>\\[${esc(raw)}\\]</div>`;
      case "note": {
        const classes = ["callout", b.type, ...b.classes].join(" ");
        const inner = (b.children ?? []).map((c) => this.block(c)).filter((s) => s).join("\n");
        return `<aside class="${classes}"${idAttr}>\n${inner}\n</aside>`;
      }
      case "table":
        return b.table ? this.table(b.table, b.id, caption) : `<p class="render-error">table failed to parse</p>`;
      case "diagram":
        return this.diagram(b, raw, caption);
      default: {
        // Unknown type: preserved as raw (spec §3). Show it, labelled.
        return `<figure${idAttr}><pre class="diagram-src" data-type="${escAttr(b.type)}">${esc(raw)}</pre>` +
          `<figcaption>unknown block type <code>${esc(b.type)}</code>; shown as raw</figcaption></figure>`;
      }
    }
  }

  private diagram(b: Extract<Block, { kind: "block" }>, raw: string, caption?: string): string {
    const idAttr = b.id ? ` id="${escAttr(b.id)}"` : "";
    const fmt = typeof b.attrs["format"] === "string" ? (b.attrs["format"] as string) : "";
    const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";

    if (fmt === "geml-chart") {
      if (b.chart) return `<figure class="chart"${idAttr}>${chartSvg(b.chart, caption)}${cap}</figure>`;
      return `<figure${idAttr}><p class="render-error">chart could not be built (see diagnostics)</p>${cap}</figure>`;
    }
    if (fmt === "geml-code-graph") {
      const src = typeof b.attrs["src"] === "string" ? (b.attrs["src"] as string) : "";
      return this.codeGraphFigure(src, idAttr, cap);
    }
    if (fmt === "mermaid") {
      this.usedMermaid = true;
      return `<figure${idAttr}><pre class="mermaid">${esc(raw)}</pre>${cap}</figure>`;
    }
    // graphviz / d2 / plantuml / vega-lite / unknown: no bundled engine yet.
    return `<figure${idAttr}><pre class="diagram-src" data-format="${escAttr(fmt)}">${esc(raw)}</pre>` +
      `<figcaption>${caption ? esc(caption) + " — " : ""}<code>${esc(fmt || "diagram")}</code> (no bundled renderer in this build)</figcaption></figure>`;
  }

  // geml-code-graph embed (GEP-0003): build the call-graph slice from the
  // codemap document `src` points at (roots/depth from ITS meta), embed the
  // data, and let the in-page runtime lay it out at draw time — that is what
  // makes click-to-re-root possible.
  codeGraphFigure(src: string, idAttr: string, cap: string): string {
    if (!src) {
      return `<figure class="code-graph"${idAttr}><p class="render-error">geml-code-graph: missing <code>src=</code></p>${cap}</figure>`;
    }
    const r = buildCodeGraph(src, this.opts);
    if (r.error !== undefined) {
      return `<figure class="code-graph"${idAttr}><p class="render-error">geml-code-graph: ${esc(r.error)}</p>${cap}</figure>`;
    }
    this.usedCodeGraph = true;
    const note = r.truncated ? `<p class="cg-note">slice truncated at ${CG_MAX_NODES} nodes — narrow the entry set or lower graph-depth</p>` : "";
    return `<figure class="code-graph"${idAttr}><div class="cg-mount" data-graph="${escAttr(JSON.stringify(r.data))}"></div>${note}${cap}</figure>`;
  }

  private table(t: TableModel, id?: string, caption?: string): string {
    const idAttr = id ? ` id="${escAttr(id)}"` : "";
    const alignStyle = (a?: Align) => (a ? ` style="text-align:${a}"` : "");

    // Coverage grid for declared spans, so cells a span covers are not emitted.
    const covered = t.rows.map((r) => r.map(() => false));
    t.rows.forEach((row, r) => row.forEach((cell, c) => {
      if (!cell.span) return;
      for (let dr = 0; dr < cell.span.rows; dr++)
        for (let dc = 0; dc < cell.span.cols; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr, cc = c + dc;
          if (covered[rr]?.[cc] !== undefined) covered[rr]![cc] = true;
        }
    }));

    const thead = t.header
      ? `<thead><tr>${t.columns.map((col, c) => `<th${alignStyle(t.align[c])}>${esc(col)}</th>`).join("")}</tr></thead>`
      : "";

    const bodyRows = t.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        if (covered[r]?.[c]) return "";
        const span = cell.span ? `${cell.span.rows > 1 ? ` rowspan="${cell.span.rows}"` : ""}${cell.span.cols > 1 ? ` colspan="${cell.span.cols}"` : ""}` : "";
        const cls = cell.computed ? ' class="computed"' : "";
        const sortVal = typeof cell.value === "number" ? ` data-sort="${cell.value}"` : "";
        return `<td${alignStyle(cell.align ?? t.align[c])}${span}${cls}${sortVal}>${this.inlines(cell.inlines)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("\n");

    const tfoot = t.summary
      ? `<tfoot><tr>${t.summary.map((cell, c) => {
          const sortVal = typeof cell.value === "number" ? ` data-sort="${cell.value}"` : "";
          return `<td${alignStyle(cell.align ?? t.align[c])}${sortVal}>${this.inlines(cell.inlines)}</td>`;
        }).join("")}</tr></tfoot>`
      : "";

    const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";
    const tools = `<div class="table-tools"><input class="table-filter" type="search" placeholder="Filter rows…" aria-label="Filter table rows"></div>`;
    return `<figure class="table-figure"${idAttr}>${tools}` +
      `<table class="geml-table">${thead}<tbody>\n${bodyRows}\n</tbody>${tfoot}</table>${cap}</figure>`;
  }
}

// ---------------------------------------------------------------------------
// Charts: a ChartModel -> inline SVG (fully self-contained, no dependency)
// ---------------------------------------------------------------------------

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

// ---------------------------------------------------------------------------
// geml-code-graph (GEP-0003) — slice builder. Traverses the codemap profile's
// #calls tables from the target document's meta `entry`, across documents,
// depth-limited; the layered LAYOUT happens in the page runtime (draw time).
// ---------------------------------------------------------------------------

const CG_MAX_NODES = 400; // hairball insurance: stop expanding past this

interface CGNode { n: string; doc: string; src?: string; leaf?: boolean; test?: boolean; more?: boolean }
interface CGData {
  start: string;
  depth: number;
  roots: string[];
  nodes: Record<string, CGNode>;
  edges: [string, string, string, string][]; // [from, to, kind, confidence|count]
  // "modules" = the index document's aggregated module graph (one node per
  // container, click navigates to <container>.html); default = method flow.
  mode?: "modules";
  module?: string;  // the container's display name (meta module=), for the breadcrumb
  dir?: "up";       // caller-direction view (GEP-0003): edges callee -> caller
  focus?: string;   // the method a callers view is anchored on
  partial?: number; // 1 = reversed in-slice edges only (static-payload fallback)
}

// Tiny posix-path helpers (no node:path dependency in the renderer).
function cgDir(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function cgJoin(dir: string, rel: string): string {
  const parts = (dir ? dir.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return out.join("/");
}

function buildCodeGraph(startRel: string, opts: RenderOptions, view?: { dir?: "up" | "down"; node?: string }): { data?: CGData; error?: string; truncated?: boolean } {
  if (!opts.loadDoc || !opts.parseDoc) return { error: "no document loader in this build (render via the geml CLI)" };
  const cache = new Map<string, Document | null>();
  const loadParsed = (rel: string): Document | null => {
    if (!cache.has(rel)) {
      const s = opts.loadDoc!(rel);
      cache.set(rel, s === null ? null : opts.parseDoc!(s));
    }
    return cache.get(rel)!;
  };
  const metaOf = (d: Document): Record<string, Value> => {
    for (const b of d.children) if (b.kind === "block" && b.type === "meta" && b.data) return b.data;
    return {};
  };
  const start = cgJoin("", startRel);
  const doc0 = loadParsed(start);
  if (!doc0) return { error: `cannot load \`${startRel}\`` };
  const meta0 = metaOf(doc0);
  const entries = String(meta0["entry"] ?? "").split(/\s+/).filter(Boolean);

  // A codemap INDEX (meta declares container=) renders the MODULE-level
  // aggregation — hundreds of methods squeezed into one canvas is a hairball;
  // the readable overview is one node per container, click = open its page.
  if (meta0["container"] !== undefined && !(view && view.node)) {
    const findTable = (d: Document, id: string) => {
      for (const b of d.children) if (b.kind === "block" && b.type === "table" && b.id === id && b.table) return b.table;
      return undefined;
    };
    const mods = findTable(doc0, "modules");
    if (mods) {
      const mi = mods.columns.indexOf("module"), di = mods.columns.indexOf("doc");
      if (mi < 0 || di < 0) return { error: "#modules table lacks module/doc columns" };
      const nodes: Record<string, CGNode> = {};
      const byName = new Map<string, string>();
      for (const r of mods.rows) {
        const name = r[mi]?.text ?? "", doc = r[di]?.text ?? "";
        if (!name || !doc) continue;
        nodes[doc] = { n: name, doc };
        byName.set(name, doc);
      }
      const edges: CGData["edges"] = [];
      const medges = findTable(doc0, "module-edges");
      if (medges) {
        const fi = medges.columns.indexOf("from"), ti = medges.columns.indexOf("to"), ci = medges.columns.indexOf("calls");
        for (const r of medges.rows) {
          const f = byName.get(r[fi]?.text ?? ""), t = byName.get(r[ti]?.text ?? "");
          if (f && t) edges.push([f, t, "call", ci >= 0 ? (r[ci]?.text ?? "") : ""]);
        }
      }
      // roots = the modules holding app entries PLUS in-degree-zero modules —
      // a merged multi-project map has clusters no app entry reaches (e.g. a
      // library consumed through its built package), and each must stay
      // layered from its own top rather than parking as unreachable.
      const roots: string[] = [];
      for (const e of entries) {
        const h = e.indexOf("#");
        if (h > 0) {
          const d = cgJoin(cgDir(start), e.slice(0, h));
          if (nodes[d] && !roots.includes(d)) roots.push(d);
        }
      }
      const hasIn = new Set(edges.map((e) => e[1]));
      for (const k of Object.keys(nodes)) if (!hasIn.has(k) && !roots.includes(k)) roots.push(k);
      if (!roots.length) roots.push(...Object.keys(nodes));
      return { data: { start, depth: 99, roots, nodes, edges, mode: "modules" } };
    }
  }

  if (!(view && view.node) && !entries.length) {
    // An entry-less container is an app's very top (nothing outside calls
    // into it — the generator writes no `entry`). Root its view at its
    // in-degree-zero methods instead of rendering nothing — symmetric with
    // the module overview's in-degree-zero fallback.
    const ids: string[] = [];
    const called = new Set<string>();
    for (const b of doc0.children) {
      if (b.kind !== "block") continue;
      if (b.type === "code" && b.id) ids.push(b.id);
      if (b.type === "table" && b.table && (b.id === "calls" || b.id === "called-by")) {
        const ti = b.table.columns.indexOf("to");
        if (ti >= 0) for (const r of b.table.rows) {
          const t = r[ti]?.text ?? "";
          if (t.startsWith("#")) called.add(t.slice(1));
        }
      }
    }
    for (const id of ids) if (!called.has(id)) entries.push(`#${id}`);
  }
  if (!(view && view.node) && !entries.length) return { error: `\`${startRel}\` declares no \`entry\` in its meta` };
  const depth = Number(meta0["graph-depth"]) > 0 ? Number(meta0["graph-depth"]) : 6;

  const resolveRef = (fromDoc: string, ref: string): { doc: string; id: string } | null => {
    const h = ref.indexOf("#");
    if (h < 0) return null;
    const id = ref.slice(h + 1);
    return { doc: h === 0 ? fromDoc : cgJoin(cgDir(fromDoc), ref.slice(0, h)), id };
  };

  const nodes: Record<string, CGNode> = {};
  const edges: CGData["edges"] = [];
  const roots: string[] = [];
  let truncated = false;

  const blockInfo = (docRel: string, id: string): CGNode => {
    const node: CGNode = { n: id, doc: docRel };
    const d = loadParsed(docRel);
    if (!d) return node;
    for (const b of d.children) {
      if (b.kind === "block" && b.id === id) {
        if (typeof b.attrs["src"] === "string") node.src = b.attrs["src"] as string;
        if (b.classes.includes("leaf")) node.leaf = true;
        if (b.classes.includes("test")) node.test = true;
        break;
      }
    }
    return node;
  };
  const callRows = (docRel: string, id: string): { to: string; kind: string; conf: string }[] => {
    const d = loadParsed(docRel);
    if (!d) return [];
    for (const b of d.children) {
      if (b.kind === "block" && b.type === "table" && b.id === "calls" && b.table) {
        const cols = b.table.columns;
        const fi = cols.indexOf("from"), ti = cols.indexOf("to"), ki = cols.indexOf("kind"), ci = cols.indexOf("confidence");
        if (fi < 0 || ti < 0) return [];
        return b.table.rows
          .filter((r) => (r[fi]?.text ?? "") === `#${id}`)
          .map((r) => ({ to: r[ti]?.text ?? "", kind: r[ki!]?.text || "call", conf: ci >= 0 ? (r[ci]?.text ?? "") : "" }));
      }
    }
    return [];
  };

  // A caller-direction view (the runtime's ⊕ handle through a live loader):
  // BFS over #called-by tables from one node. Edges are emitted REVERSED
  // (callee -> caller), so roots=[focus] lets the standard layering flow from
  // the method out to its ultimate callers — cycles fall out as back edges.
  if (view && view.node && view.dir === "up") {
    const hi = view.node.lastIndexOf("#");
    if (hi <= 0) return { error: `bad view node \`${view.node}\`` };
    const calledByRows = (docRel: string, id: string): { from: string; kind: string }[] => {
      const d = loadParsed(docRel);
      if (!d) return [];
      for (const b of d.children) {
        if (b.kind === "block" && b.type === "table" && b.id === "called-by" && b.table) {
          const cols = b.table.columns;
          const fi = cols.indexOf("from"), ti = cols.indexOf("to"), ki = cols.indexOf("kind");
          if (fi < 0 || ti < 0) return [];
          return b.table.rows
            .filter((r) => (r[ti]?.text ?? "") === `#${id}`)
            .map((r) => ({ from: r[fi]?.text ?? "", kind: r[ki!]?.text || "call" }));
        }
      }
      return [];
    };
    const focus = view.node;
    nodes[focus] = blockInfo(focus.slice(0, hi), focus.slice(hi + 1));
    roots.push(focus);
    let fr: { doc: string; id: string }[] = [{ doc: focus.slice(0, hi), id: focus.slice(hi + 1) }];
    const seenUp = new Set([focus]);
    // The caller chain is not depth-limited: its whole point is reaching the
    // app entry. The node cap (with its visible note) is the only guard.
    const upDepth = 99;
    for (let d = 0; d < upDepth && fr.length; d++) {
      const next: { doc: string; id: string }[] = [];
      for (const cur of fr) {
        const toKey = `${cur.doc}#${cur.id}`;
        for (const row of calledByRows(cur.doc, cur.id)) {
          const c = resolveRef(cur.doc, row.from);
          if (!c) continue;
          const callerKey = `${c.doc}#${c.id}`;
          if (!nodes[callerKey]) {
            if (Object.keys(nodes).length >= CG_MAX_NODES) { truncated = true; continue; }
            nodes[callerKey] = blockInfo(c.doc, c.id);
          }
          edges.push([toKey, callerKey, row.kind, ""]);
          if (!seenUp.has(callerKey)) { seenUp.add(callerKey); next.push(c); }
        }
      }
      fr = next;
    }
    return { data: { start, depth: upDepth, roots, nodes, edges, module: String(meta0["module"] ?? "") || undefined, dir: "up", focus }, truncated };
  }

  // BFS from the target document's entries, depth-limited (+1 ring of stubs so
  // the horizon is visible as "more" markers rather than silently missing).
  // A directed callee view (node-body click through a live loader) seeds from
  // that one node key instead of the meta entries.
  let frontier: { doc: string; id: string }[] = [];
  if (view && view.node) {
    const hi = view.node.lastIndexOf("#");
    if (hi <= 0) return { error: `bad view node \`${view.node}\`` };
    roots.push(view.node);
    frontier.push({ doc: view.node.slice(0, hi), id: view.node.slice(hi + 1) });
  } else for (const e of entries) {
    const r = resolveRef(start, e);
    if (!r) continue;
    const key = `${r.doc}#${r.id}`;
    roots.push(key);
    frontier.push(r);
  }
  const seen = new Set(roots);
  for (const r of frontier) nodes[`${r.doc}#${r.id}`] = blockInfo(r.doc, r.id);
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: { doc: string; id: string }[] = [];
    for (const cur of frontier) {
      const fromKey = `${cur.doc}#${cur.id}`;
      for (const row of callRows(cur.doc, cur.id)) {
        const t = resolveRef(cur.doc, row.to);
        if (!t) continue;
        const toKey = `${t.doc}#${t.id}`;
        if (!nodes[toKey]) {
          if (Object.keys(nodes).length >= CG_MAX_NODES) { truncated = true; continue; }
          nodes[toKey] = blockInfo(t.doc, t.id);
        }
        edges.push([fromKey, toKey, row.kind, row.conf]);
        if (!seen.has(toKey)) {
          seen.add(toKey);
          next.push(t);
        }
      }
    }
    frontier = next;
  }
  // Horizon markers: anything still in the frontier that has further callees.
  for (const cur of frontier) {
    if (callRows(cur.doc, cur.id).length > 0) nodes[`${cur.doc}#${cur.id}`]!.more = true;
  }

  return { data: { start, depth, roots, nodes, edges, module: String(meta0["module"] ?? "") || undefined }, truncated };
}

function chartSvg(m: ChartModel, title?: string): string {
  if (m.type === "pie") return pieSvg(m, title);
  if (m.type === "scatter") return scatterSvg(m, title);
  return cartesianSvg(m, title); // bar | line | area
}

function svgFrame(title: string | undefined, W: number, H: number, body: string): string {
  const t = title ? `<text x="${W / 2}" y="22" text-anchor="middle" class="c-title">${esc(title)}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="geml-chart" role="img" aria-label="${escAttr(title ?? "chart")}">${t}${body}</svg>`;
}

function legend(names: string[], x: number, y: number): string {
  return names.map((n, i) => {
    const yy = y + i * 18;
    return `<rect x="${x}" y="${yy}" width="11" height="11" rx="2" fill="${PALETTE[i % PALETTE.length]}"></rect>` +
      `<text x="${x + 16}" y="${yy + 10}" class="c-legend">${esc(n)}</text>`;
  }).join("");
}

function cartesianSvg(m: ChartModel, title?: string): string {
  const W = 760, H = 380;
  const top = title ? 40 : 22, right = 20, bottom = 64, left = 56;
  const pw = W - left - right, ph = H - top - bottom;
  const cats = m.dataset.categories;
  const series = m.y;
  const vals = series.map((s) => m.dataset.numbers[s] ?? []);
  const flat = vals.flat();
  const dataMax = Math.max(0, ...flat);
  const dataMin = Math.min(0, ...flat);
  const yMax = niceMax(dataMax);
  const yMin = dataMin < 0 ? -niceMax(-dataMin) : 0;
  const range = yMax - yMin || 1;
  const yOf = (v: number) => top + ph * (1 - (v - yMin) / range);
  const n = Math.max(1, cats.length);
  const band = pw / n;
  const cx = (i: number) => left + band * (i + 0.5);

  // y grid + ticks
  const ticks = 5;
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + (range * i) / ticks;
    const y = yOf(v);
    grid += `<line x1="${left}" y1="${y}" x2="${left + pw}" y2="${y}" class="c-grid"></line>`;
    grid += `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="c-tick">${fmtNum(v)}</text>`;
  }
  // x labels
  let xlab = "";
  cats.forEach((c, i) => {
    xlab += `<text x="${cx(i)}" y="${top + ph + 18}" text-anchor="middle" class="c-tick">${esc(trunc(c, 12))}</text>`;
  });

  let marks = "";
  if (m.type === "bar") {
    const groupW = band * 0.8;
    const bw = groupW / series.length;
    series.forEach((s, si) => {
      (m.dataset.numbers[s] ?? []).forEach((v, i) => {
        const x = cx(i) - groupW / 2 + si * bw;
        const y0 = yOf(0), y1 = yOf(v);
        const y = Math.min(y0, y1), h = Math.abs(y1 - y0);
        marks += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.92).toFixed(1)}" height="${h.toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}"><title>${esc(s)} · ${esc(cats[i] ?? "")}: ${fmtNum(v)}</title></rect>`;
      });
    });
  } else {
    // line / area
    series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      const pts = (m.dataset.numbers[s] ?? []).map((v, i) => `${cx(i).toFixed(1)},${yOf(v).toFixed(1)}`);
      if (pts.length === 0) return;
      if (m.type === "area") {
        const base = yOf(Math.max(yMin, 0));
        marks += `<polygon points="${cx(0).toFixed(1)},${base} ${pts.join(" ")} ${cx(cats.length - 1).toFixed(1)},${base}" fill="${color}" fill-opacity="0.18"></polygon>`;
      }
      marks += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"></polyline>`;
      (m.dataset.numbers[s] ?? []).forEach((v, i) => {
        marks += `<circle cx="${cx(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(s)} · ${esc(cats[i] ?? "")}: ${fmtNum(v)}</title></circle>`;
      });
    });
  }

  const axis = `<line x1="${left}" y1="${yOf(Math.max(yMin, 0))}" x2="${left + pw}" y2="${yOf(Math.max(yMin, 0))}" class="c-axis"></line>`;
  const leg = series.length > 1 ? legend(series, left + 8, top + 4) : "";
  return svgFrame(title, W, H, grid + axis + marks + xlab + leg);
}

function pieSvg(m: ChartModel, title?: string): string {
  const W = 760, H = 380, top = title ? 40 : 22;
  const cx = 250, cy = top + (H - top) / 2, r = Math.min(140, (H - top) / 2 - 16);
  const col = m.y[0]!;
  const data = m.dataset.numbers[col] ?? [];
  const total = data.reduce((a, b) => a + b, 0) || 1;
  let a0 = -Math.PI / 2;
  let slices = "";
  data.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    slices += `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}"><title>${esc(m.dataset.categories[i] ?? "")}: ${fmtNum(v)} (${((v / total) * 100).toFixed(1)}%)</title></path>`;
    a0 = a1;
  });
  const leg = legend(m.dataset.categories, 470, top + 16);
  return svgFrame(title, W, H, slices + leg);
}

function scatterSvg(m: ChartModel, title?: string): string {
  const W = 760, H = 380;
  const top = title ? 40 : 22, right = 20, bottom = 64, left = 56;
  const pw = W - left - right, ph = H - top - bottom;
  const yCol = m.y[0]!;
  const ys = m.dataset.numbers[yCol] ?? [];
  // x: parse the category text as a number; fall back to the row index.
  const xs = m.dataset.categories.map((c, i) => { const v = parseFloat(c); return Number.isFinite(v) ? v : i; });
  const sizes = m.size ? (m.dataset.numbers[m.size] ?? []) : [];
  const xMax = niceMax(Math.max(1, ...xs)), xMin = Math.min(0, ...xs);
  const yMax = niceMax(Math.max(1, ...ys)), yMin = Math.min(0, ...ys);
  const xr = xMax - xMin || 1, yr = yMax - yMin || 1;
  const xOf = (v: number) => left + pw * ((v - xMin) / xr);
  const yOf = (v: number) => top + ph * (1 - (v - yMin) / yr);
  const sMax = Math.max(1, ...sizes);
  const rOf = (i: number) => m.size ? 4 + 14 * Math.sqrt((sizes[i] ?? 0) / sMax) : 5;

  let grid = "";
  for (let i = 0; i <= 5; i++) {
    const v = yMin + (yr * i) / 5, y = yOf(v);
    grid += `<line x1="${left}" y1="${y}" x2="${left + pw}" y2="${y}" class="c-grid"></line>`;
    grid += `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="c-tick">${fmtNum(v)}</text>`;
  }
  let pts = "";
  ys.forEach((v, i) => {
    pts += `<circle cx="${xOf(xs[i] ?? 0).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="${rOf(i).toFixed(1)}" fill="${PALETTE[0]}" fill-opacity="0.7"><title>${esc(m.dataset.categories[i] ?? "")}: (${fmtNum(xs[i] ?? 0)}, ${fmtNum(v)})</title></circle>`;
  });
  const axis = `<line x1="${left}" y1="${top + ph}" x2="${left + pw}" y2="${top + ph}" class="c-axis"></line>`;
  return svgFrame(title, W, H, grid + axis + pts);
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US");
  return String(parseFloat(v.toPrecision(4)));
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Page shell, inline CSS, inline interactivity JS
// ---------------------------------------------------------------------------

const CSS = `
:root { --fg:#1f2328; --muted:#656d76; --bd:#d0d7de; --bg:#fff; --accent:#2563eb; --code-bg:#f6f8fa; }
* { box-sizing: border-box; }
body { margin:0; color:var(--fg); background:#fafbfc; font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,"PingFang SC","Microsoft Yahei",sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 48px 24px 96px; background:var(--bg); }
h1,h2,h3,h4,h5,h6 { line-height:1.25; margin:1.6em 0 .6em; scroll-margin-top:16px; }
h1 { font-size:2em; border-bottom:1px solid var(--bd); padding-bottom:.3em; }
h2 { font-size:1.5em; border-bottom:1px solid var(--bd); padding-bottom:.3em; }
h3 { font-size:1.25em; } h4 { font-size:1em; }
p { margin:.7em 0; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
code { background:var(--code-bg); padding:.15em .35em; border-radius:6px; font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
pre { background:var(--code-bg); padding:14px 16px; border-radius:8px; overflow:auto; }
pre code { background:none; padding:0; font-size:.85em; }
pre.output { background:#0d1117; color:#e6edf3; }
pre.output code { color:inherit; }
ul,ol { padding-left:1.6em; } li { margin:.2em 0; }
ul.task-list { list-style:none; padding-left:.2em; }
li.task input[type=checkbox] { appearance:none; -webkit-appearance:none; width:1.1em; height:1.1em; margin:0 .5em 0 0; vertical-align:-.2em; border:1.5px solid #c8ccd0; border-radius:4px; background:#fff; position:relative; opacity:1; cursor:default; box-sizing:border-box; }
li.task input[type=checkbox]:checked { background-color:#1f883d; border-color:#1f883d; }
li.task input[type=checkbox]:checked::after { content:"✓"; position:absolute; top:0; right:0; bottom:0; left:0; display:flex; align-items:center; justify-content:center; color:#fff; font-size:.8em; line-height:1; font-weight:700; }
aside.callout { border-left:4px solid var(--accent); background:#f0f6ff; padding:.4em 16px; border-radius:0 8px 8px 0; margin:1em 0; }
aside.aside { border-left-color:#8b949e; background:#f6f8fa; }
aside.warning { border-left-color:#d97706; background:#fff8f0; }
aside.callout > :first-child { margin-top:0; } aside.callout > :last-child { margin-bottom:0; }
figure { margin:1.2em 0; }
figcaption { color:var(--muted); font-size:.86em; text-align:center; margin-top:.5em; }
table.geml-table { border-collapse:collapse; width:100%; font-size:.92em; }
table.geml-table th, table.geml-table td { border:1px solid var(--bd); padding:6px 12px; }
table.geml-table thead th { background:var(--code-bg); cursor:pointer; user-select:none; white-space:nowrap; }
table.geml-table thead th::after { content:" \\2195"; color:var(--muted); font-size:.8em; }
table.geml-table thead th.asc::after { content:" \\2191"; color:var(--accent); }
table.geml-table thead th.desc::after { content:" \\2193"; color:var(--accent); }
table.geml-table tbody tr:nth-child(2n) { background:#fafbfc; }
table.geml-table td.computed { color:#0a7c52; }
table.geml-table tfoot td { background:var(--code-bg); font-weight:600; border-top:2px solid var(--bd); }
.table-tools { margin-bottom:6px; } .table-filter { width:240px; max-width:100%; padding:5px 9px; border:1px solid var(--bd); border-radius:7px; font-size:.85em; }
.geml-chart { width:100%; height:auto; background:var(--bg); border:1px solid var(--bd); border-radius:8px; }
.c-title { font-size:15px; font-weight:600; fill:var(--fg); }
.c-grid { stroke:#eaecef; } .c-axis { stroke:#aab1b8; } .c-tick { font-size:11px; fill:var(--muted); } .c-legend { font-size:12px; fill:var(--fg); }
.media { max-width:100%; border-radius:8px; }
.diagram-src { color:var(--muted); } .render-error { color:#cf222e; }
.math-block { overflow-x:auto; padding:.4em 0; }
sup.fn a { font-size:.75em; }
.geml-footer { max-width:860px; margin:0 auto; padding:16px 24px 40px; color:var(--muted); font-size:.82em; }
.geml-footer code { font-size:.95em; }
.code-graph { margin:1.4em 0; }
.cg-mount { border:1px solid var(--bd); border-radius:8px; padding:10px 12px; background:var(--bg); }
.cg-scroll { overflow:auto; max-height:72vh; }
.cg-svg { display:block; }
.cg-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:.82em; color:var(--muted); margin-bottom:6px; }
.cg-bar button { font:inherit; padding:1px 8px; border:1px solid var(--bd); border-radius:5px; background:transparent; cursor:pointer; }
.cg-crumb .cg-seg { border:0; border-radius:0; padding:0; background:none; color:var(--accent); cursor:pointer; font:inherit; }
.cg-crumb .cg-seg:hover { text-decoration:underline; }
.cg-frame { display:block; width:100%; height:72vh; border:0; background:var(--bg); }
.cg-flash { color:#b42318; }
.cg-legend { display:flex; gap:14px; align-items:center; justify-content:space-between; flex-wrap:wrap; font-size:.75em; color:var(--muted); margin-top:6px; }
.cg-upbtn circle { fill:#fff; stroke:#94a3b8; }
.cg-upbtn text { font-size:11px; fill:#57606a; }
.cg-upbtn:hover circle { stroke:var(--accent); }
.cg-upbtn:hover text { fill:var(--accent); }
.cg-groups { display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:6px; font-size:.75em; color:var(--muted); }
.cg-chip { display:inline-flex; align-items:center; gap:4px; }
.cg-chip i { width:10px; height:10px; border-radius:2px; border:1px solid #94a3b8; display:inline-block; }
.cg-note { font-size:.8em; color:#9a6700; }
.cg-n rect { fill:#eef2f7; stroke:#94a3b8; }
.cg-n text { font-size:12px; fill:var(--fg); font-family:ui-monospace,Consolas,monospace; }
.cg-n { cursor:pointer; }
.cg-n.root rect { fill:#dbeafe; stroke:#2563eb; stroke-width:2; }
.cg-n.leaf { opacity:.45; }
.cg-n.test rect { stroke-dasharray:3 2; }
.cg-e { fill:none; stroke:#94a3b8; stroke-width:1.2; }
.cg-e.cand { stroke-dasharray:2 3; }
.cg-e.back { stroke:#dc2626; stroke-dasharray:5 3; }
.cg-e.soft { opacity:.55; }
`;

const JS = `
(function () {
  function cmp(a, b) {
    var na = a.dataset.sort, nb = b.dataset.sort;
    if (na !== undefined && nb !== undefined) return parseFloat(na) - parseFloat(nb);
    return (a.textContent || "").localeCompare(b.textContent || "");
  }
  document.querySelectorAll("table.geml-table").forEach(function (table) {
    var tbody = table.tBodies[0];
    if (!tbody) return;
    // Sort on header click.
    var ths = table.tHead ? table.tHead.rows[0].cells : [];
    Array.prototype.forEach.call(ths, function (th, col) {
      th.addEventListener("click", function () {
        var dir = th.classList.contains("asc") ? "desc" : "asc";
        Array.prototype.forEach.call(ths, function (h) { h.classList.remove("asc", "desc"); });
        th.classList.add(dir);
        var rows = Array.prototype.slice.call(tbody.rows);
        rows.sort(function (r1, r2) {
          var c = cmp(r1.cells[col], r2.cells[col]);
          return dir === "asc" ? c : -c;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      });
    });
    // Filter rows.
    var fig = table.closest(".table-figure");
    var input = fig ? fig.querySelector(".table-filter") : null;
    if (input) input.addEventListener("input", function () {
      var q = input.value.toLowerCase();
      Array.prototype.forEach.call(tbody.rows, function (r) {
        r.style.display = (r.textContent || "").toLowerCase().indexOf(q) >= 0 ? "" : "none";
      });
    });
  });
})();
`;

// geml-code-graph runtime: layered layout AT DRAW TIME (GEP-0003 / v2-D8) so
// clicking a node re-roots the view inside the embedded slice. Algorithm as
// specified: BFS slice from roots -> DFS back-edge marking -> longest-path
// layering over forward edges -> stable in-layer order. O(V+E) per redraw.
//
// ONE implementation, two consumers: the CLI inlines `codeGraphRuntime`
// verbatim (Function.prototype.toString) into the self-contained HTML; the
// browser extension / playground import it and call it after their async
// upgrade step has attached data-graph payloads. Browser-only code — it must
// stay self-contained (no captured module-scope identifiers).
export function codeGraphRuntime(root: { querySelectorAll(sel: string): ArrayLike<Element> }): void {
  function h(tag: string, attrs: Record<string, string | number>) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
  }
  // Arrow-marker ids must be unique per drawn svg — several mounts share one
  // document, and duplicate ids would make every graph point at the first.
  var arrowSeq = 0;
  Array.prototype.forEach.call(root.querySelectorAll(".cg-mount"), function (mount: Element) {
    var payload = mount.getAttribute("data-graph");
    if (!payload) return; // not (yet) upgraded, or its build failed
    var data0 = JSON.parse(payload);
    var data: any, out: any;
    function setData(d: any) {
      data = d;
      out = {};
      data.edges.forEach(function (e: any) { (out[e[0]] = out[e[0]] || []).push(e); });
    }
    setData(data0);
    // scale null = fit-to-width on first draw. Left-right is the default —
    // call flow reads with the text; the toggle persists per reader.
    var state: any = { roots: data.roots.slice(), trail: [], scale: null, dir: "LR", frame: null };
    // Direction survives module -> container navigation (each page is a fresh
    // document); best-effort only — file:// or the DOM stub may lack storage.
    try { var sd = window.localStorage.getItem("geml-cg-dir"); if (sd === "TB" || sd === "LR") state.dir = sd; } catch (e) { /* no storage */ }

    function slice(roots: any) {
      var keep: any = {}, layer: any = {}, q: any = [], qi = 0;
      roots.forEach(function (r: any) { if (data.nodes[r] && !(r in keep)) { keep[r] = 1; layer[r] = 0; q.push([r, 0]); } });
      while (qi < q.length) {
        var cur = q[qi][0], d = q[qi][1]; qi++;
        if (d >= data.depth) continue;
        (out[cur] || []).forEach(function (e: any) {
          var t = e[1];
          if (data.nodes[t] && !(t in keep)) { keep[t] = 1; layer[t] = d + 1; q.push([t, d + 1]); }
        });
      }
      // Module overview: every module stays visible — the ones unreachable
      // from the roots (vendored deps etc.) park on one extra bottom layer.
      if (data.mode === "modules") {
        var park = 0;
        for (var kk in keep) if (layer[kk] > park) park = layer[kk];
        for (var nk in data.nodes) if (!(nk in keep)) { keep[nk] = 1; layer[nk] = park + 1; }
      }
      var color: any = {}, back: any = {};
      function dfs(u: any) {
        color[u] = 1;
        (out[u] || []).forEach(function (e: any) {
          var v = e[1]; if (!keep[v]) return;
          if (color[v] === 1) back[e[0] + ">" + e[1]] = 1;
          else if (!color[v]) dfs(v);
        });
        color[u] = 2;
      }
      roots.forEach(function (r: any) { if (keep[r] && !color[r]) dfs(r); });
      var changed = true, guard = 0;
      while (changed && guard++ < 80) {
        changed = false;
        data.edges.forEach(function (e: any) {
          if (!keep[e[0]] || !keep[e[1]] || back[e[0] + ">" + e[1]]) return;
          if (layer[e[0]] + 1 > layer[e[1]]) { layer[e[1]] = layer[e[0]] + 1; changed = true; }
        });
      }
      return { keep: keep, layer: layer, back: back };
    }

    // Nested-browser view (static pages): the clicked document's pre-rendered
    // sibling .html shown INSIDE the graph area — an in-mount iframe, never a
    // whole-page navigation. "back" restores the graph exactly as it was.
    function drawFrame() {
      mount.replaceChildren();
      var bar = document.createElement("div");
      bar.className = "cg-bar";
      var crumb = document.createElement("span");
      crumb.className = "cg-crumb";
      var backBtn: any = document.createElement("button");
      backBtn.className = "cg-seg";
      backBtn.textContent = "◂ back";
      backBtn.onclick = function () { state.frame = null; draw(); };
      crumb.appendChild(backBtn);
      var sp = document.createElement("span");
      sp.textContent = " / " + String(state.frame.rel).replace(/\.geml$/, "");
      crumb.appendChild(sp);
      bar.appendChild(crumb);
      var open = document.createElement("a");
      open.href = state.frame.html;
      open.textContent = "open standalone ↗";
      bar.appendChild(open);
      mount.appendChild(bar);
      var fr: any = document.createElement("iframe");
      fr.className = "cg-frame";
      fr.setAttribute("src", state.frame.html);
      fr.setAttribute("title", state.frame.rel);
      mount.appendChild(fr);
    }

    function draw() {
      if (state.frame) { drawFrame(); return; }
      var s = slice(state.roots);
      // The callers view reads in TRUE call order — app entry first, the
      // focused method at the far end. Its slice is built from the focus
      // outward (edges callee -> caller), so flip the layers and swap edge
      // endpoints at draw time: call direction stays left->right (top->down)
      // in every view.
      var isUp = data.dir === "up";
      if (isUp) {
        var maxL = 0, fk: any;
        for (fk in s.layer) if (s.layer[fk] > maxL) maxL = s.layer[fk];
        for (fk in s.layer) s.layer[fk] = maxL - s.layer[fk];
      }
      // Group tint: front-end and back-end (and any other top-level module)
      // stopped being distinguishable once merged into one map — colour by
      // top path segment (module overview) / owning document (method view).
      var PALETTE = ["#e3f2fd", "#e8f5e9", "#fff3e0", "#f3e5f5", "#e0f7fa", "#fce4ec", "#f1f8e9", "#ede7f6", "#fff8e1", "#e0f2f1", "#efebe9", "#f9fbe7"];
      function groupOf(k: any) {
        return (data.mode === "modules" ? String(data.nodes[k].n).split("/")[0] : String(k).split("#")[0]) || "";
      }
      var gnames: any = [];
      Object.keys(s.keep).forEach(function (k) { var gn = groupOf(k); if (gnames.indexOf(gn) < 0) gnames.push(gn); });
      gnames.sort();
      var rows: any = [];
      Object.keys(s.keep).forEach(function (k) {
        (rows[s.layer[k]] = rows[s.layer[k]] || []).push(k);
      });
      rows = rows.filter(function (r: any) { return r && r.length; });
      // In-layer order: group first (same-tint nodes sit together), name
      // second — and the layout leaves a small extra gap where the group
      // changes, so the colour runs read as blocks.
      rows.forEach(function (r: any) {
        r.sort(function (a: any, b: any) {
          var ga = groupOf(a), gb = groupOf(b);
          if (ga !== gb) return ga < gb ? -1 : 1;
          return data.nodes[a].n < data.nodes[b].n ? -1 : 1;
        });
      });
      var NH = 26, GY = 44, GX = 14, GYL = 12, GXL = 70, GG = 22, pos: any = {}, W = 320, H = 0;
      var LR = state.dir === "LR";
      var isMethod = data.mode !== "modules";
      // Box width follows the DISPLAYED label, and the label is truncated to
      // fit the box — long dir-path module names used to overflow their 220px
      // cap and stack onto their neighbours. Modules keep the TAIL (the
      // informative end of a path), methods keep the head. Method boxes carry
      // a ⊕ callers handle inside their left edge, hence the extra width.
      function label(k: any) {
        var n = data.nodes[k];
        var full = n.n + (n.more ? " ›" : "");
        if (full.length <= 32) return full;
        return data.mode === "modules" ? "…" + full.slice(full.length - 31) : full.slice(0, 31) + "…";
      }
      // The ⊕ callers handle sits only on the current view's ROOTS: a
      // mid-graph node's callers are already drawn as its in-edges — the
      // entry is the one place the upstream is invisible. In the callers
      // view the focused method (far end) carries the mirrored handle that
      // flips back to its callee chain.
      function hasUp(k: any) { return isMethod && !isUp && state.roots.indexOf(k) >= 0; }
      function hasDown(k: any) { return isUp && k === data.focus; }
      function bw(k: any) { return Math.max(56, label(k).length * 7.2 + 18) + (hasUp(k) || hasDown(k) ? 16 : 0); }
      if (!LR) {
        rows.forEach(function (r: any, ri: any) {
          var x = 0;
          r.forEach(function (k: any, i: any) {
            if (i > 0 && groupOf(r[i - 1]) !== groupOf(k)) x += GG;
            var w = bw(k);
            pos[k] = { x: x, y: ri * (NH + GY), w: w };
            x += w + GX;
          });
          W = Math.max(W, x - GX);
        });
        rows.forEach(function (r: any) {
          var rw = pos[r[r.length - 1]].x + pos[r[r.length - 1]].w;
          var off = (W - rw) / 2;
          r.forEach(function (k: any) { pos[k].x += off; });
        });
        H = rows.length * (NH + GY) - GY;
      } else {
        // Left-to-right: layers become columns, flow reads with the text.
        var cx = 0, colHs: any = [];
        rows.forEach(function (r: any, ci: any) {
          var cw = 0, y = 0;
          r.forEach(function (k: any, i: any) {
            if (i > 0 && groupOf(r[i - 1]) !== groupOf(k)) y += GG;
            var w = bw(k);
            pos[k] = { x: cx, y: y, w: w };
            y += NH + GYL;
            if (w > cw) cw = w;
          });
          colHs[ci] = y - GYL;
          if (colHs[ci] > H) H = colHs[ci];
          cx += cw + GXL;
        });
        W = Math.max(320, cx - GXL);
        rows.forEach(function (r: any, ci: any) {
          var off = (H - colHs[ci]) / 2;
          r.forEach(function (k: any) { pos[k].y += off; });
        });
      }
      var svg = h("svg", { viewBox: "0 0 " + W + " " + (H + 8), class: "cg-svg", role: "img" });
      // Small arrowheads, always pointing at the CALLEE — two fixed markers
      // (normal grey, back-edge red) rather than context-stroke, which not
      // every engine paints yet.
      var arrId = "cg-arr-" + arrowSeq++;
      var defs = h("defs", {});
      [["", "#94a3b8"], ["-b", "#dc2626"]].forEach(function (mdef: any) {
        var mk = h("marker", { id: arrId + mdef[0], viewBox: "0 0 10 10", refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" });
        mk.appendChild(h("path", { d: "M0 1.2 L8.5 5 L0 8.8 z", fill: mdef[1] }));
        defs.appendChild(mk);
      });
      svg.appendChild(defs);
      data.edges.forEach(function (e: any) {
        var a = pos[isUp ? e[1] : e[0]], b = pos[isUp ? e[0] : e[1]];
        if (!a || !b) return;
        var isBack = s.back[e[0] + ">" + e[1]] || (e[0] === e[1]);
        var cls = "cg-e" + (e[2] === "candidate" ? " cand" : "") + (isBack ? " back" : "") + (e[3] === "medium" || e[3] === "low" ? " soft" : "");
        var p;
        if (e[0] === e[1]) {
          p = LR
            ? "M" + (a.x + 8) + " " + (a.y + NH) + " c 0 16 16 16 16 0"
            : "M" + (a.x + a.w) + " " + (a.y + 8) + " c 18 0 18 " + (NH - 16) + " 0 " + (NH - 16);
        } else if (isBack) {
          if (LR) {
            var yb = Math.max(a.y, b.y) + NH + 24;
            p = "M" + (a.x + a.w / 2) + " " + (a.y + NH) + " C " + (a.x + a.w / 2) + " " + yb + " " + (b.x + b.w / 2) + " " + yb + " " + (b.x + b.w / 2) + " " + (b.y + NH);
          } else {
            var xr = Math.max(a.x + a.w, b.x + b.w) + 22;
            p = "M" + (a.x + a.w) + " " + (a.y + NH / 2) + " C " + xr + " " + (a.y + NH / 2) + " " + xr + " " + (b.y + NH / 2) + " " + (b.x + b.w) + " " + (b.y + NH / 2);
          }
        } else if (LR) {
          var lx1 = a.x + a.w, ly1 = a.y + NH / 2, lx2 = b.x, ly2 = b.y + NH / 2;
          p = "M" + lx1 + " " + ly1 + " C " + (lx1 + GXL / 2) + " " + ly1 + " " + (lx2 - GXL / 2) + " " + ly2 + " " + lx2 + " " + ly2;
        } else {
          var x1 = a.x + a.w / 2, y1 = a.y + NH, x2 = b.x + b.w / 2, y2 = b.y;
          p = "M" + x1 + " " + y1 + " C " + x1 + " " + (y1 + GY / 2) + " " + x2 + " " + (y2 - GY / 2) + " " + x2 + " " + y2;
        }
        var pathEl = h("path", { d: p, class: cls, "marker-end": "url(#" + arrId + (isBack ? "-b" : "") + ")" });
        if (data.mode === "modules" && e[3]) {
          var et = h("title", {});
          et.textContent = e[3] + " call(s)";
          pathEl.appendChild(et);
        }
        svg.appendChild(pathEl);
      });
      Object.keys(s.keep).forEach(function (k) {
        var n = data.nodes[k], a = pos[k];
        var g = h("g", { class: "cg-n" + (n.leaf ? " leaf" : "") + (n.test ? " test" : "") + (state.roots.indexOf(k) >= 0 ? " root" : ""), "data-k": k, transform: "translate(" + a.x + "," + a.y + ")" });
        g.appendChild(h("rect", { width: a.w, height: NH, rx: 6, style: "fill:" + PALETTE[gnames.indexOf(groupOf(k)) % PALETTE.length] }));
        var t = h("text", { x: hasUp(k) ? a.w / 2 + 8 : hasDown(k) ? a.w / 2 - 8 : a.w / 2, y: NH / 2 + 4, "text-anchor": "middle" });
        t.textContent = label(k);
        g.appendChild(t);
        var tip = h("title", {});
        tip.textContent = data.mode === "modules"
          ? n.n + "\nclick: open this module"
          : k + (n.src ? "\n" + n.src : "")
            + (hasUp(k) ? "\nclick = callees · ⊕ = full caller chain"
              : hasDown(k) ? "\n⊕ = back to its callee chain"
              : "\nclick = its callee chain");
        g.appendChild(tip);
        if (hasUp(k) || hasDown(k)) {
          // The ⊕ handle (GEP-0003 caller direction) — inside the box edge so
          // it never collides with a neighbour: on the LEFT of a callee-view
          // entry (expand callers), mirrored to the RIGHT of the callers-view
          // focus (flip back down).
          var ub = h("g", { class: "cg-upbtn", "data-k": k, "data-act": hasUp(k) ? "up" : "down", transform: "translate(" + (hasUp(k) ? 11 : a.w - 11) + "," + NH / 2 + ")" });
          ub.appendChild(h("circle", { r: 6.5 }));
          var ut = h("text", { x: 0, y: 3.5, "text-anchor": "middle" });
          ut.textContent = "+";
          ub.appendChild(ut);
          g.appendChild(ub);
        }
        svg.appendChild(g);
      });
      // Natural pixel size; only the inner .cg-scroll pane scrolls, so the
      // toolbar (crumb/zoom/back) and the footer stay visible however big the
      // canvas gets. Squeezing a 16,000px canvas into the column made 1px
      // text — never again.
      svg.setAttribute("width", String(W));
      svg.setAttribute("height", String(H + 8));
      // Rendered pages sit next to their codemap documents: a live mount
      // (viewer/playground) carries data-src, a CLI embed carries the src
      // path in data.start — either directory anchors doc-relative links.
      var navBase = String(mount.getAttribute("data-src") || data.start || "").replace(/[^\/]*$/, "");
      // A live mount (viewer/playground) navigates IN PLACE over the geml
      // documents through this loader; only static CLI pages fall back to
      // their pre-rendered sibling .html pages.
      var live: any = (mount as any)._cgView;
      mount.replaceChildren();
      var bar = document.createElement("div");
      bar.className = "cg-bar";
      // Breadcrumb: modules / <container> / <state> — the hierarchy is
      // entry -> module -> method view, and both upper levels are clickable.
      var crumb = document.createElement("span");
      crumb.className = "cg-crumb";
      function seg(txt: string, fn: any) {
        var el: any = document.createElement(fn ? "button" : "span");
        if (fn) { el.className = "cg-seg"; el.onclick = fn; }
        el.textContent = txt;
        crumb.appendChild(el);
      }
      function sepEl() { var sp = document.createElement("span"); sp.textContent = " / "; crumb.appendChild(sp); }
      // A transient in-bar error — the "don't jump, say why" half of the
      // contract: an unloadable target reports here and the view stays put.
      function flash(msg: string) {
        var f = document.createElement("span");
        f.className = "cg-flash";
        f.textContent = msg;
        bar.appendChild(f);
        try { setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 5000); } catch (e) { /* stub */ }
      }
      function openDoc(rel: string) {
        if (live) {
          Promise.resolve(live({ doc: rel })).then(
            function (nd: any) { if (nd) pushView(nd); else flash("cannot load " + rel); },
            function () { flash("cannot load " + rel); },
          );
          return;
        }
        var html = rel.replace(/\.geml$/, ".html");
        // Inside the nested frame the frame IS the browser — navigate it
        // plainly instead of stacking frame-in-frame.
        var framed = false;
        try { framed = window.self !== window.top; } catch (e) { /* no window: top */ }
        if (framed) { window.location.href = html; return; }
        function embed() { state.frame = { rel: rel, html: html }; draw(); }
        // Served over http(s): probe first, so a missing page reports in
        // place and nothing navigates. file:// cannot probe (fetch is
        // blocked) — embed directly; the frame contains any error itself.
        try {
          if (/^https?:$/.test(window.location.protocol)) {
            fetch(html, { method: "HEAD" }).then(function (r: any) {
              if (r.ok) embed(); else flash("page missing: " + html + " — re-run the codemap render");
            }).catch(function () { flash("cannot reach " + html); });
            return;
          }
        } catch (e) { /* no fetch/location — treat like file:// */ }
        embed();
      }
      if (data.mode === "modules") {
        seg("modules", null);
      } else {
        seg("modules", function () { openDoc(navBase + "index.geml"); });
        sepEl();
        var modName = String(data.module || String(data.start || "").replace(/^.*\//, "").replace(/\.geml$/, "") || "container");
        seg(modName, function () {
          if (live) openDoc(String(data.start));
          else { state.trail = []; setData(data0); state.roots = data0.roots.slice(); draw(); }
        });
        sepEl();
        seg(
          data.dir === "up"
            ? "callers of " + (data.nodes[data.focus] ? data.nodes[data.focus].n : "") + (data.partial ? " (in-slice)" : "")
            : state.trail.length ? "root: " + state.roots.map(function (k: any) { return data.nodes[k].n; }).join(", ")
            : "roots: entry",
          null,
        );
      }
      bar.appendChild(crumb);
      var scroller = document.createElement("div");
      scroller.className = "cg-scroll";
      scroller.appendChild(svg);
      function fitScale() {
        var mw = scroller.clientWidth || mount.clientWidth || 0;
        // A collapsed pane (mid-layout measure) must not produce a negative
        // width — invalid CSS silently keeps the previous size.
        return mw > 60 && W ? Math.min(1, (mw - 26) / W) : 1;
      }
      function applyScale() {
        svg.style.width = Math.round(W * state.scale) + "px";
        svg.style.height = Math.round((H + 8) * state.scale) + "px";
        svg.style.maxWidth = "none";
      }
      function zoomBtn(label: string, fn: any) {
        var b = document.createElement("button");
        b.textContent = label;
        b.onclick = function () { fn(); applyScale(); };
        bar.appendChild(b);
      }
      zoomBtn("−", function () { state.scale = Math.max(0.1, state.scale * 0.75); });
      zoomBtn("+", function () { state.scale = Math.min(4, state.scale / 0.75); });
      zoomBtn("fit", function () { state.scale = fitScale(); });
      zoomBtn("1:1", function () { state.scale = 1; });
      var dirBtn = document.createElement("button");
      dirBtn.textContent = LR ? "top-down" : "left-right";
      dirBtn.onclick = function () {
        state.dir = LR ? "TB" : "LR";
        try { window.localStorage.setItem("geml-cg-dir", state.dir); } catch (e) { /* no storage */ }
        draw();
      };
      bar.appendChild(dirBtn);
      if (state.trail.length) {
        var backBtn = document.createElement("button");
        backBtn.textContent = "back";
        backBtn.onclick = function () { var tr = state.trail.pop(); setData(tr.data); state.roots = tr.roots; draw(); };
        bar.appendChild(backBtn);
        var resetBtn = document.createElement("button");
        resetBtn.textContent = "reset";
        resetBtn.onclick = function () { state.trail = []; setData(data0); state.roots = data0.roots.slice(); draw(); };
        bar.appendChild(resetBtn);
      }
      mount.appendChild(bar);
      mount.appendChild(scroller);
      if (state.scale === null) state.scale = fitScale();
      applyScale();
      if (isUp) {
        // The focused method sits at the FAR end of the callers chain —
        // scroll it into view instead of opening on the app-entry end.
        if (LR) scroller.scrollLeft = 1e6; else scroller.scrollTop = 1e6;
      }
      // Footer: live facts, not a static cheat-sheet (navigation lives in
      // the breadcrumb above).
      var footer = document.createElement("div");
      footer.className = "cg-legend";
      var info = document.createElement("span");
      info.textContent = data.mode === "modules"
        ? Object.keys(s.keep).length + " modules · " + data.edges.length + " edges · click a module to open it"
        : Object.keys(s.keep).length + "/" + Object.keys(data.nodes).length + " methods in view · click = callees · " + (isUp ? "⊕ at the end = back to callees" : "⊕ on an entry = full caller chain");
      footer.appendChild(info);
      mount.appendChild(footer);
      // Colour key — one chip per group (skip when it would be noise).
      if (gnames.length > 1 && gnames.length <= 14) {
        var chips = document.createElement("div");
        chips.className = "cg-groups";
        gnames.forEach(function (gn: any) {
          var chip = document.createElement("span");
          chip.className = "cg-chip";
          var sw = document.createElement("i");
          sw.style.background = PALETTE[gnames.indexOf(gn) % PALETTE.length] || "";
          chip.appendChild(sw);
          var lbl = document.createElement("span");
          lbl.textContent = gn || "(root)";
          chip.appendChild(lbl);
          chips.appendChild(chip);
        });
        mount.appendChild(chips);
      }
      function pushView(nd: any) {
        state.trail.push({ data: data, roots: state.roots });
        setData(nd);
        state.roots = nd.roots.slice();
        draw();
      }
      // Caller direction (GEP-0003): a live mount rebuilds through its
      // document loader (mount._cgView, attached by the upgrade step); a
      // static CLI page reverses its in-slice edges — partial but honest,
      // and labelled as such in the crumb.
      function showCallers(k: any) {
        if (live) {
          Promise.resolve(live({ dir: "up", node: k })).then(function (nd: any) { if (nd) pushView(nd); });
          return;
        }
        var rin: any = {};
        data0.edges.forEach(function (e: any) { (rin[e[1]] = rin[e[1]] || []).push(e[0]); });
        var keep: any = {}; keep[k] = 1; var q: any = [k], qi = 0;
        while (qi < q.length) {
          var c = q[qi++];
          (rin[c] || []).forEach(function (p: any) { if (!keep[p]) { keep[p] = 1; q.push(p); } });
        }
        var nodes: any = {}, edges: any = [];
        for (var nk in keep) nodes[nk] = data0.nodes[nk];
        data0.edges.forEach(function (e: any) { if (keep[e[0]] && keep[e[1]]) edges.push([e[1], e[0], e[2], e[3]]); });
        pushView({ start: data0.start, depth: 99, roots: [k], nodes: nodes, edges: edges, dir: "up", focus: k, partial: 1 });
      }
      function showCallees(k: any) {
        if (live) {
          Promise.resolve(live({ dir: "down", node: k })).then(function (nd: any) { if (nd) pushView(nd); });
          return;
        }
        pushView({ start: data0.start, depth: data0.depth, roots: [k], nodes: data0.nodes, edges: data0.edges });
      }
      svg.addEventListener("click", function (ev) {
        var tgt: any = ev.target;
        var ub = tgt && tgt.closest ? tgt.closest(".cg-upbtn") : null;
        if (ub) {
          if (ub.getAttribute("data-act") === "down") {
            // The mirrored handle flips back to the callee chain — the up
            // view was pushed from there, so this is exactly one step back.
            if (state.trail.length) { var tr0 = state.trail.pop(); setData(tr0.data); state.roots = tr0.roots; draw(); }
            else showCallees(ub.getAttribute("data-k"));
          } else showCallers(ub.getAttribute("data-k"));
          return;
        }
        var g = tgt && tgt.closest ? tgt.closest(".cg-n") : null;
        if (!g) return;
        var k = g.getAttribute("data-k");
        if (data.mode === "modules") {
          var doc = data.nodes[k] && data.nodes[k].doc;
          if (doc) openDoc(navBase + String(doc));
          return;
        }
        // In the callers view a node-body click flips back to its callee
        // chain; in the callee view it re-roots — the two directions toggle.
        if (data.dir === "up") { showCallees(k); return; }
        if (state.roots.length === 1 && state.roots[0] === k) return;
        state.trail.push({ data: data, roots: state.roots });
        state.roots = [k];
        draw();
      });
    }
    draw();
  });
}

// CLI inlining: the compiled runtime function, verbatim, run against document.
const CODE_GRAPH_JS = `(${codeGraphRuntime.toString()})(document);`;

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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
${mathHead}${mermaidHead}</head>
<body>
<main>
${body}
</main>
${footer}
<script>${JS}</script>
${ctx.usedCodeGraph ? `<script>${CODE_GRAPH_JS}</script>\n` : ""}</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export { buildCodeGraph };

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
    body = ctx.codeGraphFigure(opts.source, "", `<figcaption>${cap}</figcaption>`) + "\n" + body;
  }
  const title = opts.title ?? ctx.docTitle() ?? "GEML document";
  return page(title, body, ctx, opts.source);
}
