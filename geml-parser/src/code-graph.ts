// `geml-code-graph` — the slice builder and the draw-time runtime.
//
// This was 58% of render.ts: 1683 of its 2894 lines, for ONE application-layer
// vocabulary (`geml-codemap/v1`, GEP-0003). `codeGraphRuntime` alone is the
// browser-side layered layout, and it is the larger half.
//
// It lives here now, and render.ts RE-EXPORTS it. The re-export is
// compatibility, not architecture, and it is spelled out so the next person
// does not mistake it for a design: four consumers take these symbols from
// `render.js` today — the viewer (`parse-entry.js`), `playground/entry.js`,
// `codemap/serve.mjs`, and a **runtime URL import inside generated HTML**
// (`render-html.ts` writes `await import("…/render.js")` into the live-graph
// script). Moving the import path is a cross-package migration with a string in
// generated output at the end of it; moving the CODE is not, and that is what
// this file does. When those four migrate, the re-export line goes.
import { type Document, type Value, nameKey } from "./geml.js";
import { type RenderOptions } from "./render.js";
import { graphStyleFromLayers, resolveStyleLayers, type GraphStyle } from "./graph-style.js";

// ---------------------------------------------------------------------------
// geml-code-graph (GEP-0003) — slice builder. Traverses the codemap profile's
// #calls tables from the target document's meta `entry`, across documents,
// depth-limited; the layered LAYOUT happens in the page runtime (draw time).
// ---------------------------------------------------------------------------

// Hard payload ceiling only — the VIEW paces itself: the runtime draws the
// first 600 by BFS order and offers "+600"/"all" to walk deeper. The data in
// the codemap documents is always complete regardless.
export const CG_MAX_NODES = 4000;

export interface CGNode {
  n: string; doc?: string; src?: string; leaf?: boolean | number; test?: boolean; acc?: boolean; more?: boolean; entry?: boolean;
  grp?: string[]; // grouped module view: a tree GROUP — click descends to this path
  ext?: number;   // grouped module view: external-dependency stub (dimmed)
}
export interface CGData {
  start: string;
  depth: number;
  roots: string[];
  nodes: Record<string, CGNode>;
  edges: [string, string, string, string, string?][]; // [from, to, kind, confidence|count, endpoint?]
  // "modules" = the index document's aggregated module graph (one node per
  // container, click navigates to <container>.html); default = method flow.
  mode?: "modules";
  module?: string;  // the container's display name (meta module=), for the breadcrumb
  dir?: "up";       // caller-direction view (GEP-0003): edges callee -> caller
  focus?: string;   // the method a callers view is anchored on
  partial?: number; // 1 = reversed in-slice edges only (static-payload fallback)
  // Grouped module navigation: the index payload ships the RAW rows; every
  // level of the grouping tree is derived in the runtime (no refetch).
  mods?: { p: string; doc: string; m?: number }[];
  medges?: [string, string, number][];
  /** 显示期旋钮，来自 `_index/style.geml`（计划 D）。运行时读它而不是字面量。 */
  style?: GraphStyle;
  entryDocs?: string[];
  gpath?: string[]; // a derived view's position in the grouping tree
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

export function buildCodeGraph(startRel: string, opts: RenderOptions, view?: { dir?: "up" | "down"; node?: string }): { data?: CGData; error?: string; truncated?: boolean } {
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
  // 显示期旋钮（计划 D）。**只经 `_index/index.geml` 这一个入口**：清单的 `#sitemap`
  // 指派或 `default-style` 说了加载哪几层，`resolveStyleLayers` 是那条规则的唯一实现，
  // 宿主和这里共用它 —— 渲染器不再自己直读 `_index/style.geml`，否则同一份 map 会有
  // 两条发现路径、两套语义。清单不在就是默认旋钮（也就是渲染器一直以来的行为）；
  // 补法是重新 build，种子会把清单写回来。
  //
  // 只读，不播种 —— 播种是 `codemap build` 的事，而且这里走的是 loadDoc 钩子，
  // 因此和其他兄弟文档一样受 CLI 设定的限制约束，不直接碰文件系统。
  // 走 loadParsed 的缓存，和其他兄弟文档一视同仁 —— 否则"定向重建完全走缓存"
  // 这条既有不变量就被一次额外 fetch 破坏了。
  //
  // 层层叠加，和 CSS 一个模型：`default-style` **命中与否都加载**，`#sitemap` 命中时
  // 那份额外叠在上面、它优先，它没写的键落回默认层。每层只读它自己写了的旋钮 ——
  // 一层写死默认值就会盖掉下层的显式值。
  //
  // 每层读的是**一跳**：那份文件里的第一条 style-rule 就是旋钮。渲染器从来不展开
  // embed（它要的是几个数字，不是一份求解过的样式表），这一点没变。
  const inIndex = (name: string): Document | null => loadParsed(cgJoin(cgDir(start), `_index/${name}`));
  const styleLayers = resolveStyleLayers(inIndex, start.slice(start.lastIndexOf("/") + 1));
  const graphStyle = graphStyleFromLayers(styleLayers.map(inIndex));
  const doc0 = loadParsed(start);
  if (!doc0) return { error: `cannot load \`${startRel}\`` };
  const meta0 = metaOf(doc0);
  const entries = String(meta0["entry"] ?? "").split(/\s+/).filter(Boolean);

  // A codemap INDEX (meta declares container=) renders the MODULE-level
  // aggregation. The payload carries the RAW module rows and module edges;
  // the runtime derives every view of the grouping tree from them (one tree
  // node's children per view, single-child chains tunnelled) — so drilling
  // through packages costs no refetch and old data needs no rebuild.
  if (meta0["container"] !== undefined && !(view && view.node)) {
    const findTable = (d: Document, id: string) => {
      for (const b of d.children) if (b.kind === "block" && b.type === "table" && b.id !== undefined && nameKey(b.id) === nameKey(id) && b.table) return b.table;
      return undefined;
    };
    const mods = findTable(doc0, "modules");
    if (mods) {
      const mi = mods.columns.indexOf("module"), di = mods.columns.indexOf("doc");
      const mc = mods.columns.indexOf("methods");
      if (mi < 0 || di < 0) return { error: "#modules table lacks module/doc columns" };
      const list: { p: string; doc: string; m: number }[] = [];
      for (const r of mods.rows) {
        const name = r[mi]?.text ?? "", doc = r[di]?.text ?? "";
        if (name && doc) list.push({ p: name, doc, m: mc >= 0 ? Number(r[mc]?.text ?? "") || 0 : 0 });
      }
      const em: [string, string, number][] = [];
      const medges = findTable(doc0, "module-edges");
      if (medges) {
        const fi = medges.columns.indexOf("from"), ti = medges.columns.indexOf("to"), ci = medges.columns.indexOf("calls");
        for (const r of medges.rows) {
          const f = r[fi]?.text ?? "", t = r[ti]?.text ?? "";
          if (f && t) em.push([f, t, ci >= 0 ? Number(r[ci]?.text ?? "") || 1 : 1]);
        }
      }
      // Containers holding app entries — every derived view marks the child
      // that contains one of these as a root.
      const entryDocs: string[] = [];
      for (const e of entries) {
        const h = e.indexOf("#");
        if (h > 0) {
          const d = cgJoin(cgDir(start), e.slice(0, h));
          if (!entryDocs.includes(d)) entryDocs.push(d);
        }
      }
      // …plus documents whose app entry is FILE-level (app-entry-docs meta:
      // top-level bootstrap code with no function symbol, e.g. a Nuxt app.vue).
      for (const t of String(meta0["app-entry-docs"] ?? "").split(/\s+/).filter(Boolean)) {
        const d = cgJoin(cgDir(start), t);
        if (!entryDocs.includes(d)) entryDocs.push(d);
      }
      return { data: { start, depth: 99, roots: [], nodes: {}, edges: [], mode: "modules", mods: list, medges: em, entryDocs, style: graphStyle } };
    }
  }

  if (!(view && view.node)) {
    // A container view roots at its meta `entry` PLUS its in-degree-zero
    // methods. `entry` = called from OUTSIDE the container; in-degree-zero =
    // NO static caller at all — a JVM/agent entry point (`premain`), an AOP
    // advice the instrumentation invokes, a reflective handler, or dead code.
    // Such framework hooks have no in-repo caller, so seeding only from
    // `entry` drops them (and everything they reach) from their OWN
    // container's view. Union keeps a container's methods visible in it —
    // symmetric with the module overview's entry ∪ in-degree-zero roots.
    const ids: string[] = [];
    const anchorOf: Record<string, string> = {};
    const leaf = new Set<string>();
    const called = new Set<string>();
    for (const b of doc0.children) {
      if (b.kind !== "block") continue;
      if (b.type === "code" && b.id) {
        ids.push(b.id);
        if (typeof b.attrs["anchor"] === "string") anchorOf[b.id] = b.attrs["anchor"] as string;
        if (b.classes.includes("leaf")) leaf.add(b.id);
      }
      if (b.type === "table" && b.table && (b.id === "calls" || b.id === "called-by")) {
        const ti = b.table.columns.indexOf("to");
        if (ti >= 0) for (const r of b.table.rows) {
          const t = r[ti]?.text ?? "";
          if (t.startsWith("#")) called.add(t.slice(1));
        }
      }
    }
    const have = new Set(entries.map((e) => e.replace(/^#/, "")));
    // Synthetic methods — constructors (`<init>`/`<clinit>`), lambdas
    // (`<lambda>`), and anonymous-class / unresolved-signature methods — are
    // implementation artifacts, never entry points. Their in-degree is zero
    // only because no static edge names them (fluent-API / reflective / lambda
    // callers go unresolved), so seeding roots from them floods the view. Keep
    // them out of the in-degree-zero roots; they still appear when a real root
    // reaches them.
    const synthetic = (id: string) => /<(?:init|clinit|lambda)>|<unresolvedSignature>/.test(anchorOf[id] || "");
    // `.leaf` = zero out-edges: an in-degree-zero leaf is an ISOLATED node (no
    // caller, nothing to expand) — a bean getter/setter, a constant, dead code.
    // As a root it is pure clutter, so it never seeds one; it still appears if a
    // real root reaches it. (An in-degree-zero method WITH out-edges — premain,
    // an AOP advice — is a genuine entry and does seed a root.)
    for (const id of ids) if (!called.has(id) && !have.has(id) && !synthetic(id) && !leaf.has(id)) entries.push(`#${id}`);
  }
  if (!(view && view.node) && !entries.length) return { error: `\`${startRel}\` declares no \`entry\` in its meta` };
  // 深度的三级优先：文档自己的 `graph-depth` > `_index/style.geml` 的 `depth` >
  // profile 记的渲染器默认 6。文档在最前是有意的 —— 一份 codemap 对自己的
  // 合适深度最有发言权，样式表是**整份图**的默认值，不该盖掉单文档的声明。
  const depth = Number(meta0["graph-depth"]) > 0 ? Number(meta0["graph-depth"]) : graphStyle.depth;

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

  // Per-document indexes, built once on first touch. The BFS re-enters the
  // same documents for every node it expands — a linear scan of a 30k-row
  // #calls table per node turns the whole walk quadratic (seconds per page
  // on a large codemap).
  const blockIdxOf = (() => {
    const cache = new Map<string, Map<string, CGNode>>();
    return (docRel: string): Map<string, CGNode> => {
      let idx = cache.get(docRel);
      if (idx) return idx;
      idx = new Map();
      const d = loadParsed(docRel);
      if (d) for (const b of d.children) {
        if (b.kind !== "block" || !b.id || idx.has(b.id)) continue;
        // Label with the real display name when the block carries one — the
        // id is the sanitised form ("RenderCtx-block" for "RenderCtx.block").
        const node: CGNode = { n: typeof b.attrs["name"] === "string" ? (b.attrs["name"] as string) : b.id, doc: docRel };
        if (typeof b.attrs["src"] === "string") node.src = b.attrs["src"] as string;
        if (b.classes.includes("leaf")) node.leaf = true;
        if (b.classes.includes("test")) node.test = true;
        if (b.classes.includes("accessor")) node.acc = true;
        if (b.classes.includes("app-entry")) node.entry = true;
        idx.set(b.id, node);
      }
      cache.set(docRel, idx);
      return idx;
    };
  })();
  const blockInfo = (docRel: string, id: string): CGNode =>
    blockIdxOf(docRel).get(id) ?? { n: id, doc: docRel };
  type CallRow = { to: string; kind: string; conf: string; endpoint?: string };
  const callIdxOf = (() => {
    const cache = new Map<string, Map<string, CallRow[]>>();
    return (docRel: string): Map<string, CallRow[]> => {
      let idx = cache.get(docRel);
      if (idx) return idx;
      idx = new Map();
      const add = (from: string, rec: CallRow) => {
        if (!from.startsWith("#")) return;
        let list = idx!.get(from.slice(1));
        if (!list) { list = []; idx!.set(from.slice(1), list); }
        list.push(rec);
      };
      // Honor only the FIRST table of each id — a crafted second #calls/#api-calls
      // must not inject edges (pinned by render-html tests).
      let sawCalls = false, sawApi = false;
      const d = loadParsed(docRel);
      if (d) for (const b of d.children) {
        if (b.kind !== "block" || b.type !== "table" || !b.table) continue;
        const cols = b.table.columns;
        const fi = cols.indexOf("from"), ti = cols.indexOf("to");
        if (fi < 0 || ti < 0) continue;
        if (b.id === "calls" && !sawCalls) {
          sawCalls = true;
          const ki = cols.indexOf("kind"), ci = cols.indexOf("confidence");
          for (const r of b.table.rows) add(r[fi]?.text ?? "", { to: r[ti]?.text ?? "", kind: r[ki!]?.text || "call", conf: ci >= 0 ? (r[ci]?.text ?? "") : "" });
        } else if (b.id === "api-calls" && !sawApi) {
          sawApi = true;
          // cross-stack link: a frontend function → its backend handler,
          // labelled with the endpoint (METHOD path). Rendered as a distinct
          // `http` edge; the handler is a boundary node (not auto-expanded).
          const ei = cols.indexOf("endpoint");
          for (const r of b.table.rows) add(r[fi]?.text ?? "", { to: r[ti]?.text ?? "", kind: "http", conf: "", endpoint: ei >= 0 ? (r[ei]?.text ?? "") : "" });
        }
      }
      cache.set(docRel, idx);
      return idx;
    };
  })();
  const callRows = (docRel: string, id: string): CallRow[] =>
    callIdxOf(docRel).get(id) ?? [];

  // A caller-direction view (the runtime's ⊕ handle through a live loader):
  // BFS over #called-by tables from one node. Edges are emitted REVERSED
  // (callee -> caller), so roots=[focus] lets the standard layering flow from
  // the method out to its ultimate callers — cycles fall out as back edges.
  if (view && view.node && view.dir === "up") {
    const hi = view.node.lastIndexOf("#");
    if (hi <= 0) return { error: `bad view node \`${view.node}\`` };
    // Same once-per-document indexing as callRows — the upward BFS crosses
    // documents through their #called-by tables just as hot.
    type CalledByRow = { from: string; kind: string; endpoint?: string };
    const calledByIdxOf = (() => {
      const cache = new Map<string, Map<string, CalledByRow[]>>();
      return (docRel: string): Map<string, CalledByRow[]> => {
        let idx = cache.get(docRel);
        if (idx) return idx;
        idx = new Map();
        const add = (to: string, rec: CalledByRow) => {
          if (!to.startsWith("#")) return;
          let list = idx!.get(to.slice(1));
          if (!list) { list = []; idx!.set(to.slice(1), list); }
          list.push(rec);
        };
        let sawCb = false, sawApi = false; // first-of-each-id only (see callIdxOf)
        const d = loadParsed(docRel);
        if (d) for (const b of d.children) {
          if (b.kind !== "block" || b.type !== "table" || !b.table) continue;
          const cols = b.table.columns;
          const fi = cols.indexOf("from"), ti = cols.indexOf("to");
          if (fi < 0 || ti < 0) continue;
          if (b.id === "called-by" && !sawCb) {
            sawCb = true;
            const ki = cols.indexOf("kind");
            for (const r of b.table.rows) add(r[ti]?.text ?? "", { from: r[fi]?.text ?? "", kind: r[ki!]?.text || "call" });
          } else if (b.id === "api-served-by" && !sawApi) {
            sawApi = true;
            // cross-stack: a backend handler ← its frontend caller.
            const ei = cols.indexOf("endpoint");
            for (const r of b.table.rows) add(r[ti]?.text ?? "", { from: r[fi]?.text ?? "", kind: "http", endpoint: ei >= 0 ? (r[ei]?.text ?? "") : "" });
          }
        }
        cache.set(docRel, idx);
        return idx;
      };
    })();
    const calledByRows = (docRel: string, id: string): CalledByRow[] =>
      calledByIdxOf(docRel).get(id) ?? [];
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
          if (row.endpoint) edges.push([toKey, callerKey, row.kind, "", row.endpoint]);
          else edges.push([toKey, callerKey, row.kind, ""]);
          // Don't expand the frontend caller's subtree into a backend-rooted
          // callers view across the http boundary; it's a boundary node.
          if (row.kind !== "http" && !seenUp.has(callerKey)) { seenUp.add(callerKey); next.push(c); }
        }
      }
      fr = next;
    }
    return { data: { start, depth: upDepth, roots, nodes, edges, module: String(meta0["module"] ?? "") || undefined, dir: "up", focus, style: graphStyle }, truncated };
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
  } else {
    const seeds = entries.map((e) => resolveRef(start, e)).filter(Boolean) as { doc: string; id: string }[];
    // A `.leaf` root has no callees to expand, so it renders as an ISOLATED dot
    // — a getter/setter/constant called from another container, or dead code.
    // Seed roots only from non-leaf entries so the view is call chains, not a
    // field of dots; a leaf still appears when a real chain reaches it. Fall
    // back to all seeds if EVERY entry is a leaf (a pure data container — a DTO
    // of getters — must not come out blank).
    const nonLeaf = seeds.filter((r) => !blockInfo(r.doc, r.id).leaf);
    for (const r of (nonLeaf.length ? nonLeaf : seeds)) { roots.push(`${r.doc}#${r.id}`); frontier.push(r); }
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
        if (row.endpoint) edges.push([fromKey, toKey, row.kind, row.conf, row.endpoint]);
        else edges.push([fromKey, toKey, row.kind, row.conf]);
        // Cross-stack `http` links reach into the OTHER tree — pull the handler
        // in as a boundary node but don't expand its (backend) subtree into a
        // frontend view; the user clicks through to open it in its own flow.
        if (row.kind !== "http" && !seen.has(toKey)) {
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

  // Drop ISOLATED nodes: a seeded root that ends up with no edge at all (no
  // resolved callee to expand, no in-view caller) is a lone dot — a getter/
  // setter/constant called only from elsewhere, or a method whose only calls
  // were unresolved. They are clutter in a flow view. Keep them only if the
  // WHOLE view is isolated dots (a pure data container mustn't come out blank).
  const touched = new Set<string>();
  for (const e of edges) { touched.add(e[0]); touched.add(e[1]); }
  const connected = roots.filter((r) => touched.has(r));
  let finalRoots = roots;
  if (connected.length) {
    for (const r of roots) if (!touched.has(r)) delete nodes[r];
    finalRoots = connected;
  }

  return { data: { start, depth, roots: finalRoots, nodes, edges, module: String(meta0["module"] ?? "") || undefined, style: graphStyle }, truncated };
}

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
  // 显示期旋钮（计划 D）：随 data-graph 一起送来，来源是 `_index/style.geml`。
  // 每个回退值逐一等于反转之前写死在这里的那个，所以**没有 style.geml 的旧页面
  // 行为不变** —— 这是不替换渲染器、只反转控制权的全部要点。
  var CG_PALETTE_FALLBACK = ["#e3f2fd", "#e8f5e9", "#fff3e0", "#f3e5f5", "#e0f7fa", "#fce4ec",
                             "#f1f8e9", "#ede7f6", "#fff8e1", "#e0f2f1", "#efebe9", "#f9fbe7"];
  var cgStyleCur: any = {};
  function cgStyle(d: any): any { if (d && d.style) cgStyleCur = d.style; return cgStyleCur || {}; }
  function cgFold(): number { return (cgStyleCur && cgStyleCur.fold) || 1; }
  function cgPalette(d: any): any { return cgStyle(d).palette || CG_PALETTE_FALLBACK; }
  function h(tag: string, attrs: Record<string, string | number>) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
  }
  // Same-origin confinement for every URL the runtime fetches or loads.
  // navBase is derived from the mount's document-controlled `data-src`, so a
  // crafted codemap doc could otherwise aim a fetch / HEAD probe / <script src>
  // at a third-party host (silent beacon, SSRF, or remote-code load) or read an
  // out-of-directory local file. Resolve the candidate against the page and
  // require the SAME origin (and, on file://, the same directory). With no
  // location context (unit tests / non-browser) there is nothing to confine to,
  // so allow — the browser/CLI callers always have one.
  function cgSameOrigin(u: any): boolean {
    try {
      var here = (typeof location !== "undefined" && location.href) ? location.href : "";
      if (!here) return true;
      var abs = new URL(String(u), here), cur = new URL(here);
      if (abs.protocol !== cur.protocol) return false;
      if (cur.protocol === "file:") return abs.pathname.indexOf(cur.pathname.replace(/[^\/]*$/, "")) === 0;
      return abs.origin === cur.origin;
    } catch (e) { return false; }
  }
  // Arrow-marker ids must be unique per drawn svg — several mounts share one
  // document, and duplicate ids would make every graph point at the first.
  var arrowSeq = 0;
  function boot(mount: Element, data0: any, gpath?: any): void {
    // 先把旋钮吃进来：deriveView 里的 first() 要用 fold，而它跑在
    // hideAcc / PALETTE 之前，不在这里播种就会读到空配置退回默认值。
    cgStyle(data0);
    var data: any, out: any;
    function setData(d: any) {
      data = d;
      out = {};
      data.edges.forEach(function (e: any) { (out[e[0]] = out[e[0]] || []).push(e); });
    }
    // Grouped module navigation (GEP-0003 §4): a SHALLOW two-tier model.
    // Tier 1 (gpath = []) is one node per top path segment — the module-ish
    // roots. Tier 2 (gpath = [seg]) is that segment's containers FLAT, labelled
    // by their intra-module path; clicking a container opens its methods. At
    // most ONE grouping level, so a method is always two clicks from the top —
    // a deep package chain (core/service/impl) reads as a flat label, never a
    // click-through. Calls leaving the subtree aggregate into dimmed external
    // stubs so no dependency is hidden.
    function deriveView(gpath: any): any {
      // 折叠到前 FOLD 段，FOLD 来自 `_index/style.geml`（计划 D）。
      // 缺省 1 时与反转之前的 `indexOf("/")` 实现逐字符等价。
      function first(p: any) {
        var parts = String(p).split("/");
        return parts.length <= cgFold() ? String(p) : parts.slice(0, cgFold()).join("/");
      }
      var pByDoc: any = {}, docByP: any = {};
      data0.mods.forEach(function (m: any) { pByDoc[m.doc] = m.p; docByP[m.p] = m.doc; });
      // A single top segment (one-module repo) is ceremony: land straight on
      // its containers, with the breadcrumb still at root — a lone top node is
      // never worth a click. `reported` keeps the crumb showing `modules`.
      var reported = gpath;
      if (!gpath.length) {
        var tops: any = {};
        data0.mods.forEach(function (m: any) { var s = first(m.p); tops[s] = (tops[s] || 0) + 1; });
        var tk = Object.keys(tops);
        if (tk.length === 1) {
          var whole = false;
          data0.mods.forEach(function (m: any) { if (m.p === tk[0]) whole = true; });
          if (!(tops[tk[0]!] === 1 && whole)) gpath = [tk[0]!]; // descend past the sole group
        }
      }
      var nodes: any = {}, keyOf: any;
      if (!gpath.length) {
        // Tier 1: one node per top segment. A segment that is a single whole
        // container (its path IS the segment) is a leaf — one click to methods.
        var segCount: any = {}, segWhole: any = {};
        data0.mods.forEach(function (m: any) {
          var s = first(m.p); segCount[s] = (segCount[s] || 0) + 1;
          if (m.p === s) segWhole[s] = m.doc;
        });
        Object.keys(segCount).sort().forEach(function (s) {
          if (segCount[s] === 1 && segWhole[s]) nodes[segWhole[s]] = { n: s, doc: segWhole[s] };
          else nodes["g:" + s] = { n: s, grp: [s] };
        });
        keyOf = function (p: any) { var s = first(p); return (segCount[s] === 1 && segWhole[s]) ? segWhole[s] : "g:" + s; };
      } else {
        // Tier 2: every container under this segment, FLAT.
        var mod = gpath.join("/"), pre = mod + "/";
        data0.mods.forEach(function (m: any) {
          if (m.p !== mod && m.p.indexOf(pre) !== 0) return;
          var label = m.p === mod ? (mod.indexOf("/") < 0 ? mod : mod.slice(mod.lastIndexOf("/") + 1)) : m.p.slice(pre.length);
          nodes[m.doc] = { n: label, doc: m.doc };
        });
        keyOf = function (p: any) {
          if (p === mod || p.indexOf(pre) === 0) return docByP[p] || null;
          return "x:" + first(p);
        };
      }
      var agg: any = {};
      data0.medges.forEach(function (e: any) {
        var a = keyOf(e[0]), b = keyOf(e[1]);
        if (!a || !b || a === b) return;
        if (a.indexOf("x:") === 0 && b.indexOf("x:") === 0) return;
        [a, b].forEach(function (kk: any) { if (kk.indexOf("x:") === 0 && !nodes[kk]) nodes[kk] = { n: "↗ " + kk.slice(2), ext: 1, leaf: 1 }; });
        agg[a + ">" + b] = (agg[a + ">" + b] || 0) + (Number(e[2]) || 1);
      });
      var edges: any = [];
      for (var ek in agg) { var i2 = ek.indexOf(">"); edges.push([ek.slice(0, i2), ek.slice(i2 + 1), "call", String(agg[ek])]); }
      // roots: nodes holding app entries, plus in-degree-zero nodes
      var roots: any = [];
      (data0.entryDocs || []).forEach(function (d: any) {
        var p = pByDoc[d]; if (!p) return;
        var kk = keyOf(p);
        if (kk && kk.indexOf("x:") !== 0) {
          if (roots.indexOf(kk) < 0) roots.push(kk);
          // Badge the module (or the group holding it): this is where the
          // program starts — the ▶ the label renderer prepends.
          if (nodes[kk]) nodes[kk].appEntry = 1;
        }
      });
      var hasIn: any = {};
      edges.forEach(function (e: any) { hasIn[e[1]] = 1; });
      for (var nk in nodes) if (!hasIn[nk] && !nodes[nk].ext && roots.indexOf(nk) < 0) roots.push(nk);
      if (!roots.length) for (var nk2 in nodes) roots.push(nk2);
      return { start: data0.start, depth: 99, mode: "modules", gpath: reported, roots: roots, nodes: nodes, edges: edges };
    }
    function homeData(): any {
      return data0.mode === "modules" && data0.mods ? deriveView([]) : data0;
    }
    setData(data0.mode === "modules" && data0.mods && gpath && gpath.length ? deriveView(gpath) : homeData());
    // scale null = fit-to-width on first draw. Left-right is the default —
    // call flow reads with the text; the toggle persists per reader.
    // autoScale mirrors the last scale the VIEW picked for itself. While
    // state.scale still equals it the zoom is ours to re-derive (entering
    // fullscreen re-fits); once the user works the zoom buttons the two
    // diverge and their choice is left alone.
    var state: any = { roots: data.roots.slice(), trail: [], scale: null, autoScale: null, dir: "LR", frame: null, cap: 600, showAcc: false };
    // Direction survives module -> container navigation (each page is a fresh
    // document); best-effort only — file:// or the DOM stub may lack storage.
    try { var sd = window.localStorage.getItem("geml-cg-dir"); if (sd === "TB" || sd === "LR") state.dir = sd; } catch (e) { /* no storage */ }

    // Fullscreen — the graph takes the viewport instead of its 84vh slot in the
    // reading column. Native Fullscreen API when the browser grants it (browser
    // chrome goes away, Esc is handled for us); a fixed overlay when it does not
    // — a sandboxed iframe or a denied permission still gets the space. Both
    // paths flip the SAME .cg-full class, so the stylesheet and the pane
    // measurement never have to ask which one is in force.
    var fullBtnEl: any = null;
    function isFull() { return !!(mount.classList && mount.classList.contains("cg-full")); }
    // The canvas was scaled for the old pane; after the class flips it must be
    // refitted to the new one. draw() publishes the hook (drawFrame's iframe
    // needs none and clears it), and layout has to settle before the pane can
    // be measured — hence the frame delay.
    function refit() { var f = (mount as any)._cgRefit; if (typeof f === "function") f(); }
    function scheduleRefit() { if (typeof requestAnimationFrame === "function") requestAnimationFrame(refit); else refit(); }
    function syncFullBtn() {
      if (!fullBtnEl) return;
      fullBtnEl.textContent = isFull() ? "⛶ exit fullscreen" : "⛶ fullscreen";
      fullBtnEl.title = isFull() ? "leave fullscreen (Esc)" : "fill the viewport with the graph";
    }
    function setFull(on: boolean) {
      if (mount.classList && mount.classList.toggle) mount.classList.toggle("cg-full", !!on);
      syncFullBtn();
      scheduleRefit();
    }
    function nativeFullEl(): any {
      try { return document.fullscreenElement || (document as any).webkitFullscreenElement || null; } catch (e) { return null; }
    }
    function toggleFull() {
      if (isFull()) {
        if (nativeFullEl() === mount) {
          var exit = document.exitFullscreen || (document as any).webkitExitFullscreen;
          // The class follows in the fullscreenchange handler.
          if (exit) { try { exit.call(document); return; } catch (e) { /* fall through to the overlay */ } }
        }
        setFull(false);
        return;
      }
      var req = mount.requestFullscreen || (mount as any).webkitRequestFullscreen;
      if (req) {
        try {
          var p = req.call(mount);
          // A rejected promise means permission denied (sandboxed frame,
          // permissions policy): take the overlay rather than nothing.
          if (p && typeof p.catch === "function") p.catch(function () { setFull(true); });
          setFull(true);
          return;
        } catch (e) { /* no native fullscreen — overlay below */ }
      }
      setFull(true);
    }
    // Esc leaves the OVERLAY fallback; native fullscreen handles its own Esc and
    // reports through fullscreenchange. The listeners are document-wide because
    // focus may sit on a node, the search box, or nothing at all.
    try {
      document.addEventListener("keydown", function (ev: any) { if (ev.key === "Escape" && isFull() && !nativeFullEl()) setFull(false); });
      var syncFull = function () {
        var el = nativeFullEl();
        if (!el && isFull()) setFull(false);                // left via Esc / F11 / browser UI
        else if (el === mount && !isFull()) setFull(true);
        else if (el === mount) scheduleRefit();             // class truthful, geometry still changed
      };
      document.addEventListener("fullscreenchange", syncFull);
      document.addEventListener("webkitfullscreenchange", syncFull);
    } catch (e) { /* no document listeners (fake-DOM runtime test) */ }
    // Built into whichever toolbar is drawing — the graph view and the nested
    // iframe view both get one.
    function fullBtn(bar: any) {
      var b: any = document.createElement("button");
      b.onclick = toggleFull;
      fullBtnEl = b;
      syncFullBtn();
      bar.appendChild(b);
    }

    function slice(roots: any) {
      var keep: any = {}, layer: any = {}, q: any = [], qi = 0, order: any = [];
      // Accessor noise (bean get/set/is leaves, .accessor) is hidden unless
      // toggled on; the walk COUNTS what it hides so the toolbar can say so.
      var hideAcc = data.mode !== "modules" && !state.showAcc && cgStyle(data).hideAccessors !== false;
      var accSeen: any = {}, accHidden = 0;
      roots.forEach(function (r: any) { if (data.nodes[r] && !(r in keep)) { keep[r] = 1; layer[r] = 0; q.push([r, 0]); order.push(r); } });
      while (qi < q.length) {
        var cur = q[qi][0], d = q[qi][1]; qi++;
        if (d >= data.depth) continue;
        (out[cur] || []).forEach(function (e: any) {
          var t = e[1];
          if (!data.nodes[t] || (t in keep) || accSeen[t]) return;
          if (hideAcc && data.nodes[t].acc) { accSeen[t] = 1; accHidden++; return; }
          keep[t] = 1; layer[t] = d + 1; q.push([t, d + 1]); order.push(t);
        });
      }
      // The VIEW paces itself: draw the first `cap` in BFS order, tell the
      // reader how much is beyond, let +400/all walk deeper. Data is complete.
      var total = order.length, capped = 0;
      if (data.mode !== "modules" && total > state.cap) {
        for (var oi = state.cap; oi < total; oi++) delete keep[order[oi]];
        capped = total - state.cap;
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
      return { keep: keep, layer: layer, back: back, accHidden: accHidden, total: total, capped: capped };
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
      // The iframe is height:auto/flex in fullscreen, so it needs no refit —
      // drop the previous view's hook rather than leave a stale canvas one.
      (mount as any)._cgRefit = null;
      fullBtn(bar);
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
      var PALETTE = cgPalette(data);
      function groupOf(k: any) {
        return (data.mode === "modules"
          ? (data.nodes[k].tg || String(data.nodes[k].n).split("/")[0])
          : String(k).split("#")[0]) || "";
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
      // informative end of a path), methods keep the head. The ⊕ direction
      // handle is now its OWN node beside the box (drawn below), so the box
      // width no longer reserves room for it.
      function label(k: any) {
        var n = data.nodes[k];
        // ▶ = this module (or group) holds an app entry — where the program
        // starts, from index meta entry= / app-entry-docs.
        var full = (n.appEntry || n.entry ? "▶ " : "") + n.n + (n.more ? " ›" : "");
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
      function bw(k: any) { return Math.max(56, label(k).length * 7.2 + 18); }
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
      // The standalone ⊕ node sits just OUTSIDE the box on the direction it
      // points — reserve a margin so it never clips the canvas edge or a
      // neighbour. It rides the caller side of a callee-view entry (left in
      // LR, top in TB) and the callee side of the callers-view focus (right /
      // bottom). Only one side is ever active in a given view.
      var UBOFF = 17, UBPAD = 24;
      var anyUp = false, anyDown = false;
      Object.keys(s.keep).forEach(function (k) { if (hasUp(k)) anyUp = true; else if (hasDown(k)) anyDown = true; });
      var padL = anyUp && LR ? UBPAD : 0, padT = anyUp && !LR ? UBPAD : 0;
      var padR = anyDown && LR ? UBPAD : 0, padB = anyDown && !LR ? UBPAD : 0;
      if (padL || padT) for (var pk in pos) { pos[pk].x += padL; pos[pk].y += padT; }
      W += padL + padR; H += padT + padB;
      var svg = h("svg", { viewBox: "0 0 " + W + " " + (H + 8), class: "cg-svg", role: "img" });
      // Small arrowheads, always pointing at the CALLEE — two fixed markers
      // (normal grey, back-edge red) rather than context-stroke, which not
      // every engine paints yet.
      var arrId = "cg-arr-" + arrowSeq++;
      var defs = h("defs", {});
      [["", "#94a3b8"], ["-b", "#dc2626"]].forEach(function (mdef: any) {
        var mk = h("marker", { id: arrId + mdef[0], viewBox: "0 0 10 10", refX: 8.5, refY: 5, markerWidth: 5.5, markerHeight: 5.5, orient: "auto" });
        mk.appendChild(h("path", { d: "M0 1.2 L8.5 5 L0 8.8 z", fill: mdef[1] }));
        defs.appendChild(mk);
      });
      svg.appendChild(defs);
      // Hover: light up the CALLER CONE of the node under the pointer —
      // every upstream node and edge in the current view — and dim the rest.
      // upAdj maps each node to its callers within the drawn slice (in the
      // callers view the data edges already point callee -> caller).
      var upAdj: any = {};
      var nodeEls: any = {}, nodeBase: any = {};
      var edgeEls: any = {}, edgeBase: any = {};
      data.edges.forEach(function (e: any) {
        var a = pos[isUp ? e[1] : e[0]], b = pos[isUp ? e[0] : e[1]];
        if (!a || !b) return;
        var isBack = s.back[e[0] + ">" + e[1]] || (e[0] === e[1]);
        var cls = "cg-e" + (e[2] === "candidate" ? " cand" : "") + (e[2] === "http" ? " http" : "") + (isBack ? " back" : "") + (e[3] === "medium" || e[3] === "low" ? " soft" : "");
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
        if (e[2] === "http" && e[4]) { var tt = h("title", {}); tt.textContent = e[4]; pathEl.appendChild(tt); } // endpoint on hover
        var ek = e[0] + ">" + e[1];
        edgeEls[ek] = pathEl;
        edgeBase[ek] = cls;
        var callee = isUp ? e[0] : e[1], caller = isUp ? e[1] : e[0];
        (upAdj[callee] = upAdj[callee] || []).push({ n: caller, k: ek });
        if (data.mode === "modules" && e[3]) {
          var et = h("title", {});
          et.textContent = e[3] + " call(s)";
          pathEl.appendChild(et);
        }
        svg.appendChild(pathEl);
      });
      Object.keys(s.keep).forEach(function (k) {
        var n = data.nodes[k], a = pos[k];
        var ncls = "cg-n" + (n.leaf ? " leaf" : "") + (n.test ? " test" : "") + (n.grp ? " grp" : "") + (state.roots.indexOf(k) >= 0 ? " root" : "");
        var g = h("g", { class: ncls, "data-k": k, transform: "translate(" + a.x + "," + a.y + ")" });
        nodeEls[k] = g;
        nodeBase[k] = ncls;
        g.appendChild(h("rect", { width: a.w, height: NH, rx: 6, style: "fill:" + PALETTE[gnames.indexOf(groupOf(k)) % PALETTE.length] }));
        var t = h("text", { x: hasUp(k) ? a.w / 2 + 8 : hasDown(k) ? a.w / 2 - 8 : a.w / 2, y: NH / 2 + 4, "text-anchor": "middle" });
        t.textContent = label(k);
        g.appendChild(t);
        var tip = h("title", {});
        tip.textContent = data.mode === "modules"
          ? (n.grp ? (n.grp.join("/") + "\nclick: open this group")
            : n.ext ? ("external dependency: " + n.n.replace(/^↗ /, ""))
            : n.n + "\nclick: open this module")
          : k + (n.src ? "\n" + n.src : "") + "\nclick = view source";
        g.appendChild(tip);
        svg.appendChild(g);
        if (hasUp(k) || hasDown(k)) {
          // The ⊕ handle (GEP-0003 caller direction) is now its OWN node
          // beside the box — no longer a child glued inside the box edge.
          // Same data-k / data-act / click: it focuses this node and TOGGLES
          // direction. It sits on the LEFT of a callee-view entry (expand
          // callers) and mirrors to the RIGHT of the callers-view focus (flip
          // back down); in top-down those become above / below. The reserved
          // margin above keeps it clear of the canvas edge and neighbours.
          var up = hasUp(k), ubx, uby;
          if (up) { if (LR) { ubx = a.x - UBOFF; uby = a.y + NH / 2; } else { ubx = a.x + a.w / 2; uby = a.y - UBOFF; } }
          else { if (LR) { ubx = a.x + a.w + UBOFF; uby = a.y + NH / 2; } else { ubx = a.x + a.w / 2; uby = a.y + NH + UBOFF; } }
          // Dashed connector ties the handle to its node and shows which way
          // the hidden chain flows: callers flow INTO the node (⊕ -> box),
          // callees flow OUT of it (box -> ⊕). Same grey + arrowhead as real
          // edges; dashed = "not expanded yet"; never a click target.
          var R = 6.5, TIP = 1.5, lx1, ly1, lx2, ly2;
          if (up) {
            if (LR) { lx1 = ubx + R; ly1 = uby; lx2 = a.x - TIP; ly2 = uby; }
            else { lx1 = ubx; ly1 = uby + R; lx2 = ubx; ly2 = a.y - TIP; }
          } else if (LR) { lx1 = a.x + a.w + TIP; ly1 = uby; lx2 = ubx - R - TIP; ly2 = uby; }
          else { lx1 = ubx; ly1 = a.y + NH + TIP; lx2 = ubx; ly2 = uby - R - TIP; }
          svg.appendChild(h("path", { class: "cg-uplink", d: "M" + lx1 + " " + ly1 + " L" + lx2 + " " + ly2, "marker-end": "url(#" + arrId + ")" }));
          var ub = h("g", { class: "cg-upbtn", "data-k": k, "data-act": up ? "up" : "down", transform: "translate(" + ubx + "," + uby + ")" });
          ub.appendChild(h("circle", { r: 6.5 }));
          var ut = h("text", { x: 0, y: 3.5, "text-anchor": "middle" });
          ut.textContent = "+";
          ub.appendChild(ut);
          var utip = h("title", {});
          utip.textContent = up ? "⊕ expand the full caller chain" : "⊕ back to its callee chain";
          ub.appendChild(utip);
          svg.appendChild(ub);
        }
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
      // navBase prefixes EVERY url this view reaches for — the breadcrumb's
      // `location.href`, the search-index `<script src>`, a hit's jump target.
      // Both of its inputs are page data (a DOM attribute, the embedded graph
      // JSON), so a document that carried `data-src="javascript:…"` would turn
      // a breadcrumb click into script execution, and a `//host/` or
      // `https://host/` value would pull the search index off another origin.
      // A base is a doc-relative DIRECTORY and nothing else: anything bearing a
      // scheme or a network-path prefix is refused outright and links resolve
      // against the current page instead.
      // Everything this view navigates to or loads is built from page data, so
      // every such string is filtered here first: keep it if it is a
      // document-RELATIVE path, drop it to "" if it carries a scheme
      // (`javascript:`, `data:`) or a `//host` network-path prefix.
      //
      // DECIDE ON THE STRING THE BROWSER WILL SEE, NOT THE ONE WE WERE HANDED.
      // Before navigating, a browser strips leading and trailing C0 controls and
      // spaces and ignores TAB/CR/LF anywhere inside the scheme. Testing the raw
      // bytes let the whole classic bypass family through — ` javascript:…`,
      // `\tjavascript:…`, `java<TAB>script:…`, `\x01javascript:…`,
      // ` data:text/html,…`, ` //evil.host/` — each of which fails the scheme
      // test as written and then executes once the browser normalises it.
      // Normalise first, judge second, and return the NORMALISED value: handing
      // the sink the raw string would give it bytes that were never checked.
      function relOnly(u: any): string {
        var raw = String(u == null ? "" : u).replace(/[\t\n\r]/g, "");
        // Trim C0-and-space by scan, not by /^[\x00-\x20]+|[\x00-\x20]+$/ — an
        // end-anchored run is the very quadratic shape this file's fence
        // scanners were just cured of.
        var a = 0, b = raw.length;
        while (a < b && raw.charCodeAt(a) <= 0x20) a++;
        while (b > a && raw.charCodeAt(b - 1) <= 0x20) b--;
        var s = raw.slice(a, b);
        if (!s) return "";
        return /^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(s) || s.slice(0, 2) === "//" ? "" : s;
      }
      var navBase = relOnly(String(mount.getAttribute("data-src") || data.start || "").replace(/[^\/]*$/, ""));
      // A live mount (viewer/playground/served page) navigates IN PLACE over
      // the geml documents through this loader; only truly static pages fall
      // back to their pre-rendered sibling .html pages. Read LAZILY on every
      // use: a served page attaches the hook from an async module script that
      // loads after the first draw, and late binding must still take effect
      // on the very next interaction — no redraw, no lost state.
      var live = function (): any { return (mount as any)._cgView; };
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
      function openDoc(rel0: string, gpath?: any) {
        // The target can come from a node's own data (a `data-k` key), not just
        // from a breadcrumb we built — so it goes through the same relative-path
        // filter as navBase. An absolute or scheme-bearing target says why it
        // was refused rather than navigating.
        var rel = relOnly(rel0);
        if (!rel) { flash("refusing to open " + String(rel0) + " — not a document-relative path"); return; }
        var lv = live();
        if (lv) {
          Promise.resolve(lv({ doc: rel })).then(
            function (nd: any) {
              if (!nd) { flash("cannot load " + rel); return; }
              // A module index ships RAW rows — its nodes come from deriveView,
              // which is bound to a document's own data0. Re-boot on the loaded
              // payload so its grouping tree derives; pushView alone would draw
              // the empty raw payload (nodes come out {}).
              if (nd.mode === "modules" && nd.mods) boot(mount, nd, gpath);
              else pushView(nd);
            },
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
            if (!cgSameOrigin(html)) { flash("cannot reach " + html + " (cross-origin blocked)"); return; }
            fetch(html, { method: "HEAD", credentials: "omit" }).then(function (r: any) {
              if (r.ok) embed(); else flash("page missing: " + html + " — re-run the codemap render");
            }).catch(function () { flash("cannot reach " + html); });
            return;
          }
        } catch (e) { /* no fetch/location — treat like file:// */ }
        embed();
      }
      if (data.mode === "modules") {
        // Breadcrumb over the grouping tree. Tunnelled runs (levels with a
        // single child — Java package ceremony) merge into ONE hop, labelled
        // first/…/last, so the crumb shows only the steps a reader chose.
        var gp: any = data.gpath || [];
        seg("modules", gp.length ? function () { pushView(deriveView([])); } : null);
        var hops: any = [];
        var cur: any = [];
        for (var hi = 0; hi < gp.length; hi++) {
          var hpre = hi === 0 ? "" : gp.slice(0, hi).join("/") + "/";
          var seen: any = {}, branches = 0;
          data0.mods.forEach(function (m: any) {
            if (hpre && m.p.indexOf(hpre) !== 0) return;
            var rest = m.p.slice(hpre.length);
            var c = rest.indexOf("/");
            var s2 = c < 0 ? rest : rest.slice(0, c);
            if (!seen[s2]) { seen[s2] = 1; branches++; }
          });
          if (branches > 1 || hi === 0) { if (cur.length) hops.push(cur); cur = [hi]; }
          else cur.push(hi);
        }
        if (cur.length) hops.push(cur);
        hops.forEach(function (hop: any, oi: any) {
          sepEl();
          var lbl = hop.length === 1 ? gp[hop[0]]
            : hop.length === 2 ? gp[hop[0]] + "/" + gp[hop[hop.length - 1]]
            : gp[hop[0]] + "/…/" + gp[hop[hop.length - 1]];
          var endIdx = hop[hop.length - 1];
          seg(lbl, oi < hops.length - 1 ? function () { pushView(deriveView(gp.slice(0, endIdx + 1))); } : null);
        });
      } else {
        seg("modules", function () { openDoc(navBase + "index.geml"); });
        sepEl();
        var modName = String(data.module || String(data.start || "").replace(/^.*\//, "").replace(/\.geml$/, "") || "container");
        // The middle crumb reads as the OVERVIEW level ("modules / <module>"),
        // so clicking it goes THERE — the module tier listing this container's
        // siblings — not a reload of the page you are already on.
        seg(modName, function () {
          if (live()) openDoc(navBase + "index.geml", [modName.split("/")[0]]);
          else { state.trail = []; setData(homeData()); state.roots = data.roots.slice(); draw(); }
        });
        sepEl();
        seg(
          data.dir === "up"
            ? "callers of " + (data.nodes[data.focus] ? data.nodes[data.focus].n : "") + (data.partial ? " (in-slice)" : "") + (Object.keys(data.nodes).length <= 1 ? " — none recorded" : "")
            : state.trail.length && state.roots.length === 1 ? "root: " + (data.nodes[state.roots[0]] || {}).n
            // Many roots = this IS the module's own view (its whole entry
            // list) — the methods are already on the graph; naming them all
            // here just makes a paragraph-long crumb.
            : state.trail.length ? "roots: entry"
            : "roots: entry",
          null,
        );
      }
      bar.appendChild(crumb);
      var scroller = document.createElement("div");
      scroller.className = "cg-scroll";
      scroller.appendChild(svg);
      // The graph and the source panel sit side by side in a flex stage; the
      // panel is empty (hidden) until a method node is clicked, so the graph
      // uses the full width until then.
      var srcPanel = document.createElement("div");
      srcPanel.className = "cg-src";
      srcPanel.style.display = "none";
      var stage = document.createElement("div");
      stage.className = "cg-stage";
      stage.appendChild(scroller);
      stage.appendChild(srcPanel);
      // The scroll pane is capped at 84vh by CSS (keep the 0.84 here in step with
      // it); before first layout its clientHeight is the unconstrained content
      // height, so derive the cap from the viewport. In fullscreen the pane is a
      // flex child with a real measured height, so trust clientHeight there and
      // fall back to nearly the whole viewport. Guards keep a collapsed pane
      // (mid-layout measure) from producing a negative or zero scale — invalid
      // CSS would silently keep the previous size.
      function paneSize() {
        var mw = scroller.clientWidth || mount.clientWidth || 0;
        var mh = 0;
        try {
          mh = isFull()
            ? Math.max(120, scroller.clientHeight || Math.floor(window.innerHeight * 0.92))
            : Math.floor(window.innerHeight * 0.84);
        } catch (e) { /* no window (stub) */ }
        return { w: mw, h: mh };
      }
      // The fit BUTTON: whole-graph preview, both axes visible, no floor.
      function fitScale() {
        var p = paneSize(), s = 1;
        if (p.w > 60 && W) s = Math.min(s, (p.w - 26) / W);
        if (p.h > 60 && H) s = Math.min(s, (p.h - 10) / (H + 8));
        return Math.max(s, 0.05);
      }
      // The INITIAL view fits the CROSS axis only — height in left-right,
      // width in top-down; the reading axis is meant to scroll — clamped to
      // [2/3, 1] so text never drops below ~8px. Small and medium graphs
      // land on exactly 1:1; the overview stays one "fit" click away.
      function initialScale() {
        var p = paneSize(), s = 1;
        if (LR) { if (p.h > 60 && H) s = (p.h - 10) / (H + 8); }
        else if (p.w > 60 && W) s = (p.w - 26) / W;
        return Math.min(1, Math.max(2 / 3, s));
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
      // Entering or leaving fullscreen resizes the pane under a canvas that was
      // scaled for the old one. Re-derive the SAME kind of scale the view opens
      // with (cross-axis fit, floored at 2/3 so text stays readable) — not
      // "fit", which would shrink a tall graph to a stamp exactly when the user
      // asked for more room. A hand-picked zoom is never overridden.
      // applyScale/initialScale are per-draw closures over THIS canvas, so
      // republish the hook on every draw.
      (mount as any)._cgRefit = function () {
        if (state.scale !== state.autoScale) return;
        state.autoScale = state.scale = initialScale();
        applyScale();
      };
      fullBtn(bar);
      var dirBtn = document.createElement("button");
      dirBtn.textContent = LR ? "top-down" : "left-right";
      dirBtn.onclick = function () {
        state.dir = LR ? "TB" : "LR";
        try { window.localStorage.setItem("geml-cg-dir", state.dir); } catch (e) { /* no storage */ }
        draw();
      };
      bar.appendChild(dirBtn);
      // Accessor noise: hidden by default, one honest button to bring it back.
      if (s.accHidden > 0 || state.showAcc) {
        var accBtn = document.createElement("button");
        accBtn.textContent = state.showAcc ? "hide accessors" : s.accHidden + " accessors hidden";
        accBtn.onclick = function () { state.showAcc = !state.showAcc; draw(); };
        bar.appendChild(accBtn);
      }
      // View pacing: the slice beyond the cap is one click away, never lost.
      if (s.capped > 0) {
        var capInfo = document.createElement("span");
        capInfo.className = "cg-note";
        capInfo.textContent = "showing " + (s.total - s.capped) + " of " + s.total + " reachable";
        bar.appendChild(capInfo);
        var moreBtn = document.createElement("button");
        moreBtn.textContent = "+600";
        moreBtn.onclick = function () { state.cap += 600; draw(); };
        bar.appendChild(moreBtn);
        var allBtn = document.createElement("button");
        allBtn.textContent = "all";
        allBtn.onclick = function () { state.cap = 1e9; draw(); };
        bar.appendChild(allBtn);
      }
      if (state.trail.length) {
        var backBtn = document.createElement("button");
        backBtn.textContent = "back";
        backBtn.onclick = function () { var tr = state.trail.pop(); setData(tr.data); state.roots = tr.roots; draw(); };
        bar.appendChild(backBtn);
        var resetBtn = document.createElement("button");
        resetBtn.textContent = "reset";
        resetBtn.onclick = function () { state.trail = []; setData(homeData()); state.roots = data.roots.slice(); draw(); };
        bar.appendChild(resetBtn);
      }
      // Find a method by name -> jump to its node. Data source: a served page
      // (http) queries the /_search endpoint (top matches only — a huge index
      // never ships); a static page (file://) lazy-loads the compact
      // _index/search-index.js via <script> (fetch is CORS-blocked on file://,
      // a script tag is not). Picking a hit opens its FOCUSED call graph (B)
      // in place on a served page; on a static page (no live loader) it
      // navigates to the node's document (A). Alt-click always just locates.
      if (typeof location !== "undefined") { // browser only — skipped in the fake-DOM runtime test
      var searchWrap = document.createElement("span");
      searchWrap.className = "cg-search-wrap";
      var searchBox = document.createElement("input");
      searchBox.type = "search"; searchBox.className = "cg-search";
      searchBox.placeholder = "find a method…";
      searchBox.setAttribute("aria-label", "Find a method by name");
      var searchMenu = document.createElement("div");
      searchMenu.className = "cg-search-menu"; searchMenu.hidden = true;
      searchWrap.appendChild(searchBox); searchWrap.appendChild(searchMenu);
      bar.appendChild(searchWrap);
      var srvSearch = /^https?:$/.test(location.protocol);
      function withIndex(cb: any) {
        if ((window as any).__gemlSearch) return cb((window as any).__gemlSearch);
        if (!cgSameOrigin(navBase + "_index/search-index.js")) { cb([]); return; }
        var s = document.createElement("script");
        s.src = navBase + "_index/search-index.js";
        s.onload = function () { cb((window as any).__gemlSearch || []); };
        s.onerror = function () { cb([]); };
        document.head.appendChild(s);
      }
      // Rank exactly like serve's /_search (exact > prefix > qualified-tail
      // prefix > substring), so both data paths order hits the same way.
      function hitScore(n: string, q: string) {
        if (n === q) return 0;
        if (n.indexOf(q) === 0) return 1;
        var c2 = n.lastIndexOf("::"), d = n.lastIndexOf(".");
        var cut = Math.max(c2 >= 0 ? c2 + 2 : 0, d >= 0 ? d + 1 : 0);
        if (cut > 0 && n.slice(cut).indexOf(q) === 0) return 2;
        return n.indexOf(q) >= 0 ? 3 : -1;
      }
      function candidates(q: string, cb: any) {
        q = q.trim().toLowerCase();
        if (q.length < 2) return cb({ total: 0, hits: [] });
        if (srvSearch) {
          fetch("/_search?q=" + encodeURIComponent(q))
            .then(function (r) { return r.ok ? r.json() : { total: 0, hits: [] }; })
            .then(function (a) { cb(a && a.hits ? a : { total: 0, hits: [] }); })
            .catch(function () { cb({ total: 0, hits: [] }); });
        } else {
          withIndex(function (rows: any) {
            var ranked = [];
            for (var i = 0; i < rows.length; i++) {
              var s = hitScore(String(rows[i][0]).toLowerCase(), q);
              if (s >= 0) ranked.push({ s: s, name: rows[i][0], doc: rows[i][1], id: rows[i][2] });
            }
            ranked.sort(function (a: any, b: any) { return a.s - b.s || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
            // The lookup aliases bare member names to the same node — dedupe
            // on doc#id, keeping the best-ranked row.
            var seen: any = {}, hits = [];
            for (var j = 0; j < ranked.length; j++) {
              var rj: any = ranked[j];
              var k = rj.doc + "#" + rj.id;
              if (seen[k]) continue;
              seen[k] = 1;
              hits.push(rj);
            }
            cb({ total: hits.length, hits: hits.slice(0, 100) });
          });
        }
      }
      function gotoHit(doc0: string, id: string, locate: boolean) {
        searchMenu.hidden = true;
        // `doc` is a row from the loaded search index — page data, same as any
        // other target, so it gets the same relative-path filter.
        var doc = relOnly(doc0);
        if (!doc) { flash("refusing to open " + String(doc0) + " — not a document-relative path"); return; }
        if (live() && !locate) { showCallees(doc + "#" + id); return; }
        location.href = navBase + doc.replace(/\.geml$/, ".html") + "#" + encodeURIComponent(id);
      }
      var searchSeq = 0, searchTop: any = null; // best-ranked hit — Enter opens it
      searchBox.addEventListener("input", function () {
        var my = ++searchSeq, qv = searchBox.value;
        candidates(qv, function (res: any) {
          if (my !== searchSeq) return; // a newer keystroke already fired
          searchMenu.replaceChildren();
          var hits = res.hits || [];
          searchTop = hits.length ? hits[0] : null;
          if (!hits.length) { searchMenu.hidden = true; return; }
          // Honest count first — a capped list must say so.
          var count = document.createElement("div");
          count.className = "cg-search-count";
          count.textContent = (res.total > hits.length ? "showing " + hits.length + " of " + res.total + " matches" : res.total + (res.total === 1 ? " match" : " matches")) + " · Enter opens the first";
          searchMenu.appendChild(count);
          // Group by module (document), groups in best-hit order — hits arrive
          // globally ranked, so first appearance = the group's best rank.
          var order: any = [], byDoc: any = {};
          hits.forEach(function (c: any) {
            if (!byDoc[c.doc]) { byDoc[c.doc] = []; order.push(c.doc); }
            byDoc[c.doc].push(c);
          });
          order.forEach(function (doc: any) {
            var hd = document.createElement("div");
            hd.className = "cg-search-grp";
            hd.textContent = String(doc).replace(/\.geml$/, "").replace(/--/g, "/");
            searchMenu.appendChild(hd);
            byDoc[doc].forEach(function (c: any) {
              var row = document.createElement("button");
              row.className = "cg-search-row"; row.type = "button";
              var nm = document.createElement("b"); nm.textContent = c.name;
              row.appendChild(nm);
              row.onclick = function (ev: any) { gotoHit(c.doc, c.id, !!ev.altKey); };
              searchMenu.appendChild(row);
            });
          });
          searchMenu.hidden = false;
        });
      });
      searchBox.addEventListener("keydown", function (ev: any) {
        if (ev.key === "Escape") { searchMenu.hidden = true; searchBox.blur(); }
        else if (ev.key === "Enter" && searchTop) { ev.preventDefault(); gotoHit(searchTop.doc, searchTop.id, !!ev.altKey); }
      });
      document.addEventListener("click", function (ev: any) { if (!searchWrap.contains(ev.target)) searchMenu.hidden = true; });
      } // end browser-only search box
      mount.appendChild(bar);
      mount.appendChild(stage);
      if (state.scale === null) state.autoScale = state.scale = initialScale();
      applyScale();
      if (isUp) {
        // The focused method sits at the FAR end of the callers chain —
        // scroll it into view instead of opening on the app-entry end.
        if (LR) scroller.scrollLeft = 1e6; else scroller.scrollTop = 1e6;
      }
      // Centre the CROSS axis (the fit-to-pane one): the tree fans out around
      // its midline, so a big graph clamped to the 2/3 scale floor would
      // otherwise open on an empty top/left corner with every node off-screen.
      // Reading the scroll extent forces the post-applyScale reflow; when the
      // cross axis already fits, the delta is ≤0 and this is a no-op. The
      // reading axis is untouched (root start, or far-end for callers above).
      // If the view holds an app entry (▶), aim the midline at the FIRST one
      // (roots first, then any node) instead of the geometric centre — the
      // reader lands where the program starts.
      var entryK: any = null;
      state.roots.concat(Object.keys(data.nodes)).some(function (ek: any) {
        var en = data.nodes[ek];
        if (en && (en.appEntry || en.entry) && pos[ek]) { entryK = ek; return true; }
        return false;
      });
      var aim = function (full: number, pane: number, at: number) { return Math.max(0, Math.min(full - pane, at - pane / 2)); };
      if (LR) scroller.scrollTop = entryK
        ? aim(scroller.scrollHeight, scroller.clientHeight, (pos[entryK].y + NH / 2) * state.scale)
        : Math.max(0, (scroller.scrollHeight - scroller.clientHeight) / 2);
      else scroller.scrollLeft = entryK
        ? aim(scroller.scrollWidth, scroller.clientWidth, (pos[entryK].x + pos[entryK].w / 2) * state.scale)
        : Math.max(0, (scroller.scrollWidth - scroller.clientWidth) / 2);
      // Footer: live facts, not a static cheat-sheet (navigation lives in
      // the breadcrumb above).
      var footer = document.createElement("div");
      footer.className = "cg-legend";
      var info = document.createElement("span");
      info.textContent = data.mode === "modules"
        ? Object.keys(s.keep).length + " modules · " + data.edges.length + " edges · click a module to open it"
        : isUp && Object.keys(data.nodes).length <= 1
          ? "no recorded callers — framework/reflective entry points and dead code have none · ⊕ at the end = back to callees"
          : Object.keys(s.keep).length + "/" + Object.keys(data.nodes).length + " methods in view · click = view source · " + (isUp ? "⊕ at the end = back to callees" : "⊕ on an entry = full caller chain");
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
      // No recorded callers (an app/framework entry, or dead code): "up" from
      // a METHOD is its CONTAINER — one level, never the whole-repo overview
      // two levels up. From a focused/derived view that means the method's own
      // container page (the view its module node opens); already sitting on
      // that default view, say why and stay put — the "don't jump, say why"
      // contract.
      function noCallers(k: any) {
        var docRel = k.slice(0, k.lastIndexOf("#"));
        if (docRel !== data0.start) { openDoc(navBase + docRel); return; }
        if (state.trail.length) { state.trail = []; setData(homeData()); state.roots = data.roots.slice(); draw(); return; }
        flash("no recorded callers — an app/framework entry point");
      }
      function showCallers(k: any) {
        var lv = live();
        if (lv) {
          Promise.resolve(lv({ dir: "up", node: k })).then(function (nd: any) {
            if (nd && Object.keys(nd.nodes).length > 1) pushView(nd);
            else noCallers(k);
          });
          return;
        }
        var rin: any = {};
        data0.edges.forEach(function (e: any) { (rin[e[1]] = rin[e[1]] || []).push(e[0]); });
        var keep: any = {}; keep[k] = 1; var q: any = [k], qi = 0;
        while (qi < q.length) {
          var c = q[qi++];
          (rin[c] || []).forEach(function (p: any) { if (!keep[p]) { keep[p] = 1; q.push(p); } });
        }
        if (Object.keys(keep).length <= 1) { noCallers(k); return; }
        var nodes: any = {}, edges: any = [];
        for (var nk in keep) nodes[nk] = data0.nodes[nk];
        data0.edges.forEach(function (e: any) { if (keep[e[0]] && keep[e[1]]) edges.push([e[1], e[0], e[2], e[3]]); });
        pushView({ start: data0.start, depth: 99, roots: [k], nodes: nodes, edges: edges, dir: "up", focus: k, partial: 1 });
      }
      function showCallees(k: any) {
        var lv = live();
        if (lv) {
          Promise.resolve(lv({ dir: "down", node: k })).then(function (nd: any) { if (nd) pushView(nd); });
          return;
        }
        pushView({ start: data0.start, depth: data0.depth, roots: [k], nodes: data0.nodes, edges: data0.edges });
      }
      // A method node's `src` is a route (like a table's `src` / a chart's
      // `data`): "<path>#L<start>-<end>". Resolve it relative to navBase
      // (overridable via the mount's data-src-base), fetch the file, slice the
      // line range, and show it in the side panel — the graph stays live, so
      // clicking another node updates the panel. Unreachable (offline, a
      // static embed, or a server scoped away from the sources) DEGRADES to
      // the path, never throws.
      function showSource(k: any) {
        var n = data.nodes[k] || {};
        var ref = n.src ? String(n.src) : "";
        srcPanel.replaceChildren();
        srcPanel.style.display = "";
        var hd = document.createElement("div");
        hd.className = "cg-src-hd";
        var ttl = document.createElement("span");
        ttl.textContent = ref || (n.n || k);
        hd.appendChild(ttl);
        var cls = document.createElement("button");
        cls.textContent = "✕";
        cls.onclick = function () { srcPanel.style.display = "none"; srcPanel.replaceChildren(); };
        hd.appendChild(cls);
        srcPanel.appendChild(hd);
        var body = document.createElement("pre");
        body.className = "cg-src-body";
        srcPanel.appendChild(body);
        if (!ref) { body.textContent = "no source location recorded for this node"; return; }
        var hp = ref.indexOf("#");
        var path = hp < 0 ? ref : ref.slice(0, hp);
        var rng = /L(\d+)(?:-L?(\d+))?/.exec(hp < 0 ? "" : ref.slice(hp + 1));
        var a0 = rng ? parseInt(rng[1]!, 10) : 0;
        var b0 = rng && rng[2] ? parseInt(rng[2], 10) : a0;
        body.textContent = "loading " + path + " …";
        var base = mount.getAttribute("data-src-base");
        if (base === null || base === undefined) base = navBase;
        var degrade = function () {
          body.textContent = "";
          var note = document.createElement("div");
          note.className = "cg-src-note";
          note.textContent = ref + "\nsource not reachable here";
          body.appendChild(note);
        };
        var render = function (text: any) {
          var lines = String(text).split(/\r?\n/);
          var out = (a0 >= 1 && a0 <= lines.length) ? lines.slice(a0 - 1, b0 >= a0 ? b0 : a0) : lines;
          body.textContent = out.join("\n");
        };
        var fetchFn: any = (typeof fetch === "function") ? fetch : null;
        if (!fetchFn) { degrade(); return; }
        // `path` is the node's document-controlled `src=` route and `base` may
        // be empty (@self / bare-filename mounts), so an absolute or //-relative
        // src would fetch a third-party host (beacon / SSRF). Confine to the
        // page's origin and never send credentials.
        if (!cgSameOrigin(base + path)) { degrade(); return; }
        try {
          Promise.resolve(fetchFn(base + path, { credentials: "omit" })).then(function (r: any) {
            if (!r || r.ok === false) { degrade(); return null; }
            return Promise.resolve(r.text ? r.text() : r).then(render);
          }).catch(degrade);
        } catch (e) { degrade(); }
      }
      svg.addEventListener("click", function (ev) {
        var tgt: any = ev.target;
        var ub = tgt && tgt.closest ? tgt.closest(".cg-upbtn") : null;
        if (ub) {
          if (ub.getAttribute("data-act") === "down") {
            // "Back to its callee chain" must LAND on the callee chain: pop
            // the trail only when the view underneath IS this method's own
            // focused view (the search/chain path that opened these callers).
            // Arriving from anywhere wider — the module page — popping would
            // land there instead, so build the method's chain fresh.
            var k0 = ub.getAttribute("data-k");
            var top0 = state.trail[state.trail.length - 1];
            var ownChain = top0 && top0.data && top0.data.dir !== "up" && top0.roots && top0.roots.length === 1 && top0.roots[0] === k0;
            if (ownChain) { var tr0 = state.trail.pop(); setData(tr0.data); state.roots = tr0.roots; draw(); }
            else showCallees(k0);
          } else showCallers(ub.getAttribute("data-k"));
          return;
        }
        var g = tgt && tgt.closest ? tgt.closest(".cg-n") : null;
        if (!g) return;
        var k = g.getAttribute("data-k");
        if (data.mode === "modules") {
          var nd = data.nodes[k];
          if (nd && nd.grp) { pushView(deriveView(nd.grp)); return; }
          if (nd && nd.ext) return; // external stub: informational
          if (nd && nd.doc) openDoc(navBase + String(nd.doc));
          return;
        }
        // Method mode: the node body now VIEWS the method's source. All chain
        // navigation (callers / flip back) lives on the standalone ⊕ node.
        showSource(k);
      });
      // Hover highlight: BFS the caller cone over upAdj, mark nodes/edges
      // with .hl and flag the svg so everything else dims. Class strings are
      // rebuilt from the recorded bases — no classList dependency.
      function clearHl() {
        svg.setAttribute("class", "cg-svg");
        for (var nk in nodeEls) nodeEls[nk].setAttribute("class", nodeBase[nk]);
        for (var ekk in edgeEls) edgeEls[ekk].setAttribute("class", edgeBase[ekk]);
      }
      svg.addEventListener("mouseover", function (ev) {
        var tgt: any = ev.target;
        var g = tgt && tgt.closest ? tgt.closest(".cg-n") : null;
        if (!g) return;
        var k = g.getAttribute("data-k");
        var seen: any = {}; seen[k] = 1;
        var hlE: any = {};
        var q: any = [k], qi = 0;
        while (qi < q.length) {
          var cur = q[qi++];
          (upAdj[cur] || []).forEach(function (p: any) {
            hlE[p.k] = 1;
            if (!seen[p.n]) { seen[p.n] = 1; q.push(p.n); }
          });
        }
        svg.setAttribute("class", "cg-svg hl");
        for (var nk in nodeEls) nodeEls[nk].setAttribute("class", nodeBase[nk] + (seen[nk] ? " hl" : ""));
        for (var ekk in edgeEls) edgeEls[ekk].setAttribute("class", edgeBase[ekk] + (hlE[ekk] ? " hl" : ""));
      });
      svg.addEventListener("mouseout", function (ev) {
        var tgt: any = ev.target;
        if (tgt && tgt.closest && !tgt.closest(".cg-n")) return;
        clearHl();
      });
    }
    draw();
  }
  Array.prototype.forEach.call(root.querySelectorAll(".cg-mount"), function (mount: Element) {
    var payload = mount.getAttribute("data-graph");
    if (payload) { boot(mount, JSON.parse(payload)); return; }
    var side = mount.getAttribute("data-graph-src");
    if (!side) return; // not (yet) upgraded, or its build failed
    // Sidecar payload (served pages): the page shipped without the multi-MB
    // inline attribute — fetch it after first paint, then boot normally.
    fetch(side).then(function (r: any) { return r.json(); }).then(function (j: any) {
      if (!j || j.error !== undefined) {
        mount.textContent = "geml-code-graph: " + ((j && j.error) || "cannot load graph data");
        return;
      }
      if (j.truncated && (mount as any).parentNode) {
        var note = document.createElement("p");
        note.className = "cg-note";
        note.textContent = "slice truncated — narrow the entry set or lower graph-depth";
        (mount as any).parentNode.insertBefore(note, (mount as any).nextSibling);
      }
      boot(mount, j.data);
    }).catch(function () { mount.textContent = "geml-code-graph: cannot load graph data"; });
  });
}

// CLI inlining: the compiled runtime function, verbatim, run against document.
export const CODE_GRAPH_JS = `(${codeGraphRuntime.toString()})(document);`;

// Browser-side wave builder: the slice builder is synchronous with a
// synchronous loader, but a browser fetches documents asynchronously — so
// run the build in WAVES: every pass records the documents it needed but did
// not have, those are fetched, and the build re-runs (builds are
// milliseconds; the wave count is bounded by graph-depth). ONE
// implementation, two consumers: the viewer's upgrade step and the live
// module script injected into served pages.
export function codeGraphWaves(
  fetchDoc: (rel: string) => Promise<string | null>,
  parseFn: (s: string) => Document,
): {
  build: (src: string, view?: { dir?: "up" | "down"; node?: string }) => Promise<{ data?: CGData; error?: string; truncated?: boolean }>;
  seed: (name: string, text: string | null) => void;
} {
  const cache = new Map<string, string | null>();
  const failed = new Set<string>();
  return {
    seed: (name, text) => { cache.set(name, text); },
    build: async (src, view) => {
      let result;
      for (;;) {
        const pending: string[] = [];
        result = buildCodeGraph(src, {
          loadDoc: (p) => {
            if (cache.has(p)) return cache.get(p)!;
            if (!failed.has(p)) pending.push(p);
            return null;
          },
          parseDoc: parseFn,
        }, view);
        if (!pending.length) break;
        await Promise.all(pending.map(async (p) => {
          try {
            const text = await fetchDoc(p);
            cache.set(p, text);
            if (text === null) failed.add(p);
          } catch {
            cache.set(p, null);
            failed.add(p);
          }
        }));
      }
      return result;
    },
  };
}

/**
 * The page CSS this vocabulary's figures need.
 *
 * It sat inside the core renderer's own stylesheet — sixty-nine rules for one
 * application-layer vocabulary, inlined into every page whether or not it drew
 * a graph. The page shell asks for it now, and only when a renderer said the
 * page needs it (`ctx.use("code-graph")`), which is the same mechanism that
 * already carried this vocabulary's runtime script.
 */
export const CODE_GRAPH_CSS = `.code-graph { margin:1.4em 0; }
/* The graph is the widest artifact on the page: let it break out of main's
   860px reading column and take the viewport, centred, leaving the prose
   around it untouched. Negative inline margins, NOT transform — a transform
   would become the containing block for the fullscreen overlay below. */
@media (min-width:900px) { .code-graph { margin-inline: calc((100% - min(96vw, 1600px)) / 2); } }
.cg-mount { border:1px solid var(--bd); border-radius:8px; padding:10px 12px; background:var(--bg); }
.cg-scroll { overflow:auto; min-height:60vh; max-height:84vh; }
.cg-svg { display:block; }
/* Fullscreen: one class drives the layout, whether the native Fullscreen API
   took (mount is in the top layer) or we fell back to a fixed overlay. The
   :fullscreen pseudo-class is deliberately NOT in these selectors — a browser
   that doesn't know it would drop the whole rule; the runtime keeps the class
   in sync with fullscreenchange instead. Toolbar/legend keep their height,
   the stage eats the rest. */
.cg-mount.cg-full { position:fixed; inset:0; z-index:9999; margin:0; border:0; border-radius:0; padding:10px 14px; background:var(--bg); display:flex; flex-direction:column; }
.cg-mount.cg-full > .cg-bar, .cg-mount.cg-full > .cg-legend, .cg-mount.cg-full > .cg-groups { flex:0 0 auto; }
.cg-mount.cg-full .cg-stage { flex:1 1 auto; min-height:0; }
.cg-mount.cg-full .cg-scroll { min-height:0; max-height:none; height:100%; }
.cg-mount.cg-full .cg-src-body { max-height:none; }
.cg-mount.cg-full .cg-frame { flex:1 1 auto; height:auto; }
.cg-search-wrap { position:relative; display:inline-block; }
.cg-search { font:12px/1.4 inherit; padding:2px 7px; border:1px solid var(--bd); border-radius:4px; background:var(--bg); color:var(--fg); min-width:13ch; }
.cg-search-menu { position:absolute; z-index:30; top:calc(100% + 2px); left:0; min-width:24ch; max-width:52ch; max-height:52vh; overflow:auto; background:var(--bg); border:1px solid var(--bd); border-radius:6px; box-shadow:0 6px 20px rgba(0,0,0,.18); }
.cg-search-row { display:block; width:100%; text-align:left; padding:4px 9px 4px 18px; border:0; background:none; color:var(--fg); cursor:pointer; font:12px/1.4 inherit; }
.cg-search-row:hover { background:var(--bd); }
.cg-search-count { position:sticky; top:0; padding:4px 9px; font-size:11px; opacity:.65; background:var(--bg); border-bottom:1px solid var(--bd); }
.cg-search-grp { padding:6px 9px 2px; font-size:11px; font-weight:600; opacity:.7; border-top:1px solid var(--bd); }
.cg-search-grp:first-of-type { border-top:0; }
.cg-stage { display:flex; gap:10px; align-items:flex-start; }
.cg-stage .cg-scroll { flex:1 1 auto; min-width:0; }
.cg-src { flex:0 0 42%; max-width:46%; display:flex; flex-direction:column; border:1px solid var(--bd); border-radius:6px; overflow:hidden; background:var(--bg); }
.cg-src-hd { display:flex; gap:8px; align-items:center; justify-content:space-between; padding:4px 8px; border-bottom:1px solid var(--bd); color:var(--muted); font:.76em ui-monospace,Consolas,monospace; word-break:break-all; }
.cg-src-hd button { font:inherit; border:1px solid var(--bd); border-radius:5px; background:transparent; color:var(--muted); cursor:pointer; padding:0 6px; }
.cg-src-body { margin:0; padding:8px 10px; overflow:auto; max-height:84vh; color:var(--fg); font:12px/1.5 ui-monospace,Consolas,monospace; white-space:pre; }
.cg-src-note { color:var(--muted); font-style:italic; white-space:pre-wrap; }
.cg-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:.82em; color:var(--muted); margin-bottom:6px; }
.cg-bar button { font:inherit; padding:1px 8px; border:1px solid var(--bd); border-radius:5px; background:transparent; cursor:pointer; }
.cg-crumb .cg-seg { border:0; border-radius:0; padding:0; background:none; color:var(--accent); cursor:pointer; font:inherit; }
.cg-crumb .cg-seg:hover { text-decoration:underline; }
.cg-frame { display:block; width:100%; height:84vh; border:0; background:var(--bg); }
.cg-flash { color:#b42318; }
.cg-legend { display:flex; gap:14px; align-items:center; justify-content:space-between; flex-wrap:wrap; font-size:.75em; color:var(--muted); margin-top:6px; }
.cg-upbtn { cursor:pointer; }
.cg-upbtn circle { fill:#fff; stroke:#94a3b8; }
.cg-upbtn text { font-size:11px; fill:#57606a; }
.cg-upbtn:hover circle { stroke:var(--accent); stroke-width:1.6; }
.cg-upbtn:hover text { fill:var(--accent); }
.cg-uplink { fill:none; stroke:#94a3b8; stroke-dasharray:3 2.5; pointer-events:none; }
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
.cg-n.grp rect { stroke-width:1.8; }
.cg-e { fill:none; stroke:#94a3b8; stroke-width:.9; }
.cg-e.cand { stroke-dasharray:2 3; }
.cg-e.back { stroke:#dc2626; stroke-dasharray:5 3; }
.cg-e.http { stroke:#0891b2; stroke-width:1.5; stroke-dasharray:5 2; } /* cross-stack API link */
.cg-e.soft { opacity:.55; }
.cg-svg.hl .cg-n { opacity:.22; }
.cg-svg.hl .cg-e { opacity:.1; }
.cg-svg.hl .cg-n.hl { opacity:1; }
.cg-svg.hl .cg-e.hl { opacity:1; stroke-width:1.6; }`;
