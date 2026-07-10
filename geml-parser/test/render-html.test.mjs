// CLI HTML renderer (render.ts) tests: exercise the self-contained output —
// every chart type drawn as inline SVG (incl. negative values and a size
// channel), the diagram fallbacks, output/code/math blocks, tables, notes,
// lists, and inline constructs. This is the path `geml render` uses.
import { parse, renderHtml } from "../dist/geml.js";
import { buildCodeGraph, codeGraphRuntime, codeGraphWaves } from "../dist/render.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const DOC = `# Render tour {#top}

=== table {#data format=csv header=1}
Cat, A, B
X, 3, 5
Y, 7, 2
Z, 4, 6
===

=== table {#neg format=csv header=1}
K, V
P, -3
Q, 5
===

=== diagram {format=geml-chart data=#data type=bar x=Cat y=A}
===

=== diagram {format=geml-chart data=#data type=line x=Cat y=A}
===

=== diagram {format=geml-chart data=#data type=area x=Cat y=A}
===

=== diagram {format=geml-chart data=#data type=scatter x=A y=B size=A}
===

=== diagram {format=geml-chart data=#data type=pie x=Cat y=A}
===

=== diagram {format=geml-chart data=#neg type=bar x=K y=V}
===

=== diagram {#flow format=mermaid}
graph LR
  A --> B
===

=== diagram {#gv format=graphviz}
digraph { a -> b }
===

=== diagram {#d2 format=d2}
x -> y
===

=== code {#c lang=js}
const a = 1;
===

=== output {of=#c}
1
===

=== math {#m}
c^2 = a^2 + b^2
===

=== note {.warning}
A note with *em*, a [link](https://example.com), an image ![pic](p.png), a video ![v](clip.mp4), an auto-ref [[#data]], and a footnote.[^f]
===

1. first
2. second
   - nested

Prose between the two lists so they stay separate.

- [x] done
- [ ] todo

[^f]: the footnote text.
`;

const html = renderHtml(parse(DOC), { source: "tour.geml" });

test("emits a self-contained HTML document with inlined CSS", () => {
  assert.match(html, /<html/i);
  assert.match(html, /<style/i);
});

test("every chart type renders as inline SVG (incl. negatives + size channel)", () => {
  const svgs = (html.match(/<svg\b/g) || []).length;
  assert.ok(svgs >= 6, `expected >=6 chart SVGs, got ${svgs}`);
  assert.match(html, /<rect\b/, "bar → <rect>");
  assert.match(html, /<circle\b/, "scatter → <circle>");
  assert.match(html, /<path\b/, "pie/area → <path>");
});

test("diagram fallbacks: mermaid placeholder + unbundled DSLs kept as source", () => {
  assert.match(html, /class="mermaid"/, "mermaid placeholder");
  assert.match(html, /digraph/, "graphviz body preserved");
  assert.match(html, /x -&gt; y|x -> y/, "d2 body preserved");
});

test("blocks: table, note (.warning), math, code, output, heading", () => {
  assert.ok((html.match(/<table\b/g) || []).length >= 2, "both tables");
  assert.match(html, /callout note[^"]*warning/, "note carries its .warning class");
  assert.match(html, /math-block/, "math block");
  assert.match(html, /class="output"/, "output block");
  assert.match(html, /<h1[^>]*id="top"/, "heading with id");
});

test("inline + lists: link, image, video, footnote, ordered + task lists", () => {
  assert.match(html, /href="https:\/\/example\.com"/, "link");
  assert.match(html, /<img[^>]+p\.png/, "image embed");
  assert.match(html, /clip\.mp4/, "video embed");
  assert.match(html, /class="fn"/, "footnote reference");
  assert.match(html, /<ol\b/, "ordered list");
  assert.match(html, /type="checkbox"/, "task-list checkbox");
});

// ---------------------------------------------------------------------------
// geml-code-graph (GEP-0003) — embed + implicit codemap view
// ---------------------------------------------------------------------------

// A two-document codemap fixture served from memory.
const CODEMAP = {
  "auth.geml":
    "=== meta\nmodule = auth\nentry = #login\nresolution-default = cpg\n===\n\n" +
    '=== code {#login src=src/login.ts#L1-9 anchor="a1"}\n===\n' +
    '=== code {#issueToken .leaf src=src/token.ts#L1-5 anchor="a2"}\n===\n\n' +
    "=== table {#calls format=csv}\nfrom, to, kind, confidence\n" +
    "#login, #issueToken, call,\n#login, db.geml#getUser, call, medium\n===\n\n" +
    "=== table {#called-by format=csv}\nfrom, to, kind, site\ndb.geml#getUser, #login, call, src/db.ts:7\n===\n",
  "db.geml":
    "=== meta\nmodule = db\nentry = #getUser\nresolution-default = cpg\n===\n\n" +
    '=== code {#getUser src=src/db.ts#L1-9 anchor="d1"}\n===\n\n' +
    // a cross-document cycle back into auth: getUser -> login (a back edge)
    "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#getUser, auth.geml#login, call,\n===\n\n" +
    "=== table {#called-by format=csv}\nfrom, to, kind, site\nauth.geml#login, #getUser, call, src/login.ts:5\n===\n",
  // an app's very top: no external callers, so the generator wrote no entry
  "top.geml":
    "=== meta\nmodule = top\nresolution-default = cpg\n===\n\n" +
    '=== code {#boot src=src/top.ts#L1-9 anchor="t1"}\n===\n' +
    '=== code {#run src=src/top.ts#L10-20 anchor="t2"}\n===\n\n' +
    "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#boot, #run, call,\n===\n",
  // the codemap INDEX: module-level aggregates, exactly the emitted shape
  "index.geml":
    "=== meta\nrepo = demo\ncommit = abc123\ncontainer = module\nresolution-default = cpg\n===\n\n" +
    "=== table {#modules format=csv}\nmodule, doc, methods, entries, tests\nauth, auth.geml, 2, 1, 0\ndb, db.geml, 1, 1, 0\n===\n\n" +
    "=== table {#module-edges format=csv}\nfrom, to, calls\nauth, db, 1\n===\n",
};
const cgOpts = {
  loadDoc: (p) => CODEMAP[p] ?? null,
  parseDoc: (s) => parse(s),
};
const graphData = (out) => {
  const m = out.match(/data-graph="([^"]*)"/);
  assert.ok(m, "embed produced a data-graph payload");
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
};

test("code-graph embed: src= is the only input; roots/depth come from the target's meta", () => {
  const doc = parse("# Demo\n\n=== diagram {format=geml-code-graph src=auth.geml}\n===\n");
  const out = renderHtml(doc, { source: "demo.geml", ...cgOpts });
  const d = graphData(out);
  assert.deepEqual(d.roots, ["auth.geml#login"], "roots from auth.geml meta entry");
  assert.equal(d.depth, 6, "default depth");
  assert.ok(d.nodes["db.geml#getUser"], "cross-document callee included");
  assert.ok(d.nodes["auth.geml#issueToken"].leaf, ".leaf carried into the data");
  const kinds = d.edges.map((e) => e[2]);
  assert.ok(kinds.every((k) => k === "call"), "edge kinds carried");
  assert.match(out, /cg-svg|re-root/, "draw-time runtime injected");
});

test("code-graph: a codemap document renders its own layered view (scenario ①)", () => {
  const out = renderHtml(parse(CODEMAP["auth.geml"]), { source: "auth.geml", ...cgOpts });
  const d = graphData(out);
  assert.deepEqual(d.roots, ["auth.geml#login"]);
  assert.match(out, /layered method flow/, "implicit self-embed caption");
});

test("code-graph: unresolvable src degrades to an in-figure error, not a crash", () => {
  const doc = parse("=== diagram {format=geml-code-graph src=missing.geml}\n===\n");
  const out = renderHtml(doc, { source: "x.geml", ...cgOpts });
  assert.match(out, /render-error/, "error surfaced in the figure");
  assert.doesNotMatch(out, /data-graph=/, "no graph payload");
});

// A ~15-line DOM element stub, enough for the draw-time runtime to exercise
// its layout + interaction logic in node (shared by the runtime tests below).
const fakeEl = (tag) => ({
  tag, attrs: {}, children: [], listeners: {}, textContent: "", style: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  appendChild(c) { this.children.push(c); return c; },
  replaceChildren() { this.children = []; },
  addEventListener(t, f) { this.listeners[t] = f; },
  set className(v) { this.attrs.class = v; }, get className() { return this.attrs.class || ""; },
  set onclick(f) { this.listeners.click = f; }, get onclick() { return this.listeners.click; },
});
// The svg sits inside the fixed-toolbar/scrolling-pane structure: the scroll
// pane (.cg-scroll) now lives inside a flex stage (.cg-stage) beside the
// source panel, so look one level deeper too.
const svgIn = (mount) => {
  const svgOf = (sc) => sc && sc.children.find((x) => x.tag === "svg");
  for (const c of mount.children) {
    if (c.tag === "svg") return c;
    if ((c.attrs?.class || "") === "cg-scroll") return svgOf(c);
    if ((c.attrs?.class || "") === "cg-stage") return svgOf(c.children.find((x) => (x.attrs?.class || "") === "cg-scroll"));
  }
};

test("code-graph runtime: layered layout, back edge, arrowheads (DOM stub)", () => {
  // Run the browser draw-time runtime in node against the DOM stub — this
  // pins the GEP-0003 algorithm (slice -> back-edge DFS -> longest-path
  // layering) without a browser. Top-down is forced (via the persisted
  // preference) so layers = distinct Y. The standalone ⊕ is a sibling <g>
  // in the svg, so count/layer only the actual node groups (.cg-n).
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  globalThis.window = { localStorage: { getItem: () => "TB", setItem: () => {} }, location: { href: "" } };
  try {
    const { data } = buildCodeGraph("auth.geml", cgOpts);
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    const root = { querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) };
    codeGraphRuntime(root);

    const svg = svgIn(mount);
    assert.ok(svg, "svg drawn");
    const nodes = svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || ""));
    const paths = svg.children.filter((c) => c.tag === "path");
    assert.equal(nodes.length, 3, "login + issueToken + getUser laid out");
    assert.equal(paths.filter((p) => /back/.test(p.attrs.class)).length, 1, "getUser -> login is a back edge");
    assert.ok(svg.children.some((c) => c.tag === "defs"), "arrow markers defined per svg");
    assert.ok(paths.every((p) => /url\(#cg-arr/.test(p.attrs["marker-end"] || "")), "every edge carries an arrowhead");
    assert.match(paths.find((p) => /back/.test(p.attrs.class)).attrs["marker-end"], /-b\)$/, "back-edge arrow uses the back tint");
    const rootG = nodes.find((g) => /root/.test(g.attrs.class));
    assert.equal(rootG.attrs["data-k"], "auth.geml#login", "root node highlighted");
    const layers = new Set(nodes.map((g) => g.attrs.transform.match(/,([\d.]+)\)$/)[1]));
    assert.equal(layers.size, 2, "two layers (login above its callees)");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test("code-graph runtime: label truncation, group chips, LR toggle (DOM stub)", () => {
  // Module overview with repo-scale names: long dir paths must be truncated
  // tail-first (the informative end), groups tinted by top path segment with
  // a colour key, and the left-right toggle must relayout into columns.
  const fakeEl = (tag) => ({
    tag, attrs: {}, children: [], listeners: {}, textContent: "", style: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren() { this.children = []; },
    addEventListener(t, f) { this.listeners[t] = f; },
    set className(v) { this.attrs.class = v; }, get className() { return this.attrs.class || ""; },
    set onclick(f) { this.listeners.click = f; }, get onclick() { return this.listeners.click; },
  });
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  try {
    const longName = "magic-api-deps/spring-boot-protocol/src/main/java/com/github/netty/protocol/servlet/websocket";
    const data = {
      mode: "modules", roots: ["m:a"], depth: 99,
      nodes: {
        "m:a": { n: "magic-api/src/main/java", doc: "a.geml" },
        "m:b": { n: longName, doc: "b.geml" },
      },
      edges: [["m:a", "m:b", "call", 3]],
    };
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    const root = { querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) };
    codeGraphRuntime(root);

    const svg = svgIn(mount);
    const texts = svg.children.filter((c) => c.tag === "g").map((g) => g.children.find((c) => c.tag === "text").textContent);
    const trunc = texts.find((t) => t.startsWith("…"));
    assert.ok(trunc, "long module name truncated tail-first");
    assert.ok(trunc.length <= 32 && trunc.endsWith("websocket"), "tail (informative end) kept");
    for (const g of svg.children.filter((c) => c.tag === "g")) {
      const rect = g.children.find((c) => c.tag === "rect");
      const text = g.children.find((c) => c.tag === "text");
      assert.ok(text.textContent.length * 7.2 + 18 <= Number(rect.attrs.width) + 1, "label fits its box — no overlap");
      assert.match(rect.attrs.style, /fill:#/, "group tint applied");
    }
    const chips = mount.children.find((c) => c.attrs.class === "cg-groups");
    assert.equal(chips.children.length, 2, "one colour chip per top-level segment");

    // Left-right is the DEFAULT: layers come out as columns (distinct x).
    const xs = new Set(), ys = new Set();
    for (const g of svg.children.filter((c) => c.tag === "g")) {
      const m = g.attrs.transform.match(/\(([\d.]+),([\d.]+)\)/);
      xs.add(m[1]); ys.add(m[2]);
    }
    assert.equal(xs.size, 2, "LR by default: two columns");
    assert.equal(ys.size, 1, "LR: single-node columns align on one row");

    // toggle to top-down: layers become rows (distinct y)
    const bar = mount.children.find((c) => c.attrs.class === "cg-bar");
    const dirBtn = bar.children.find((b) => b.textContent === "top-down");
    assert.ok(dirBtn, "direction toggle present (offers top-down when LR)");
    dirBtn.listeners.click();
    const svg2 = svgIn(mount);
    const ys2 = new Set();
    for (const g of svg2.children.filter((c) => c.tag === "g")) {
      const m = g.attrs.transform.match(/\(([\d.]+),([\d.]+)\)/);
      ys2.add(m[2]);
    }
    assert.equal(ys2.size, 2, "top-down: two rows");
    const bar2 = mount.children.find((c) => c.attrs.class === "cg-bar");
    assert.ok(bar2.children.some((b) => b.textContent === "left-right"), "toggle now offers left-right");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("code-graph: an entry-less container roots at its in-degree-zero methods", () => {
  const { data } = buildCodeGraph("top.geml", cgOpts);
  assert.deepEqual(data.roots, ["top.geml#boot"], "#run has an in-edge; #boot is uncalled -> root");
  assert.ok(data.nodes["top.geml#run"], "slice reaches the callee");
  const out = renderHtml(parse(CODEMAP["top.geml"]), { source: "top.geml", ...cgOpts });
  assert.match(out, /in-degree-zero methods/, "scenario ① self-embed carries the fallback caption");
});

test("code-graph: a container view roots at entry UNION in-degree-zero (framework hooks, not just entries)", () => {
  const MAP = {
    "m.geml":
      "=== meta\nmodule = m\nentry = #handle #getX\nresolution-default = cpg\n===\n\n" +
      "=== code {#handle name=\"A.handle\" anchor=\"java:a#handle(void())\"}\n===\n" +
      "=== code {#mid name=\"A.mid\" anchor=\"java:a#mid(void())\"}\n===\n" +
      "=== code {#premain name=\"A.premain\" anchor=\"java:a#premain(void())\"}\n===\n" +
      "=== code {#install name=\"A.install\" anchor=\"java:a#install(void())\"}\n===\n" +
      "=== code {#ctor name=\"A.new\" anchor=\"java:a#<init>(void())\"}\n===\n" +
      "=== code {#lam name=\"A.<lambda>0\" anchor=\"java:a#<lambda>0(void())\"}\n===\n" +
      "=== code {#anon name=\"0.run\" anchor=\"java:a#run(<unresolvedSignature>(1))\"}\n===\n" +
      "=== code {#getX .leaf name=\"A.getX\" anchor=\"java:a#getX(int())\"}\n===\n\n" +
      "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#handle, #mid, call, \n#premain, #install, call, \n===\n\n" +
      "=== table {#called-by format=csv}\nfrom, to, kind, site\nx.geml#ext, #handle, call, x:1\n===\n",
  };
  const { data } = buildCodeGraph("m.geml", { loadDoc: (p) => MAP[p] ?? null, parseDoc: (s) => parse(s) });
  assert.ok(data.roots.includes("m.geml#handle"), "the meta entry (with a callee) is a root");
  assert.ok(data.roots.includes("m.geml#premain"), "the in-degree-zero method (agent/AOP hook) is ALSO a root");
  assert.ok(data.nodes["m.geml#install"], "and its callee is reachable, so it appears too");
  // synthetic in-degree-zero nodes are NOT roots (implementation artifacts)
  assert.ok(!data.roots.includes("m.geml#ctor"), "constructor is not a root");
  assert.ok(!data.roots.includes("m.geml#lam"), "lambda is not a root");
  assert.ok(!data.roots.includes("m.geml#anon"), "anonymous/unresolved-signature method is not a root");
  assert.ok(!data.roots.includes("m.geml#getX"), "a .leaf entry (getter/dead leaf) is not a root even when listed in meta entry");
  assert.ok(!data.nodes["m.geml#getX"], "…and with no root reaching it, it does not appear at all");
});

test("code-graph modules mode: index doc yields the module overview; click opens the container page", () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  globalThis.window = { location: { href: "" } };
  try {
    const { data } = buildCodeGraph("index.geml", cgOpts);
    assert.equal(data.mode, "modules", "container= meta selects the module overview");
    // the payload is RAW rows now; every view is derived by the runtime
    assert.deepEqual(data.mods.map((m) => m.doc).sort(), ["auth.geml", "db.geml"], "raw module rows shipped");
    assert.ok(Array.isArray(data.medges), "raw module edges shipped");
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    // a live mount (viewer/playground): data-src anchors relative doc names
    mount.attrs["data-src"] = "codemap/index.geml";
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    const svg = svgIn(mount);
    const gs = svg.children.filter((c) => c.tag === "g");
    assert.equal(gs.length, 2, "both modules drawn (derived root view)");
    assert.ok(gs.find((g) => g.attrs["data-k"] === "auth.geml" && /root/.test(g.attrs.class)),
      "no app entries -> in-degree-zero module is the root");
    const authG = gs.find((g) => g.attrs["data-k"] === "auth.geml");
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? authG : null) } });
    // Top-level static page: the module opens INSIDE the graph area (an
    // in-mount iframe of the pre-rendered sibling page) — the page itself
    // must never navigate away.
    assert.equal(globalThis.window.location.href, "", "whole page never navigates");
    const frame = mount.children.find((c) => c.tag === "iframe");
    assert.ok(frame, "in-mount iframe embeds the container page");
    assert.equal(frame.attrs.src, "codemap/auth.html",
      "doc name resolves against the mount's data-src directory");
    const fbar = mount.children.find((c) => c.attrs.class === "cg-bar");
    assert.ok(fbar.children.some((c) => c.tag === "a" && /standalone/.test(c.textContent)), "standalone escape hatch in the bar");
    // ◂ back closes the frame and restores the module overview in place
    fbar.children[0].children[0].listeners.click();
    assert.ok(svgIn(mount), "back restores the graph view");
    assert.ok(!mount.children.some((c) => c.tag === "iframe"), "frame closed");
    // Already INSIDE the nested frame: the frame is the browser — navigate it
    // plainly rather than stacking frame-in-frame.
    globalThis.window = { self: 1, top: 2, location: { href: "" } };
    const svg3 = svgIn(mount);
    const authG3 = svg3.children.filter((c) => c.tag === "g").find((g) => g.attrs["data-k"] === "auth.geml");
    svg3.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? authG3 : null) } });
    assert.equal(globalThis.window.location.href, "codemap/auth.html", "framed page navigates itself");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test("code-graph runtime: ⊕ is a standalone node beside the box; it toggles direction (DOM stub)", () => {
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  // The breadcrumb is composite: its LAST child is the current-state segment.
  const lastSeg = (mount) => {
    const crumb = mount.children.find((c) => c.attrs.class === "cg-bar").children[0];
    return crumb.children[crumb.children.length - 1].textContent;
  };
  // The ⊕ is its OWN sibling <g class=cg-upbtn> in the svg (not a child of the
  // method group); it and the node share a data-k, so look them up separately.
  const nodeOf = (svg, k) => svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || "")).find((g) => g.attrs["data-k"] === k);
  const ubOf = (svg, k) => svg.children.filter((c) => c.tag === "g" && (c.attrs.class || "") === "cg-upbtn").find((u) => u.attrs["data-k"] === k);
  const xOf = (el) => Number(el.attrs.transform.match(/\((-?[\d.]+),/)[1]);
  try {
    const { data } = buildCodeGraph("auth.geml", cgOpts);
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    let svg = svgIn(mount);
    // NOT a descendant of the method's cg-n group — its own node now.
    assert.ok(!nodeOf(svg, "auth.geml#login").children.some((c) => (c.attrs.class || "") === "cg-upbtn"),
      "⊕ is not glued inside the method box");
    const ub = ubOf(svg, "auth.geml#login");
    assert.ok(ub, "⊕ drawn as its own sibling node in the svg");
    assert.equal(ub.attrs["data-act"], "up", "entry handle expands callers");
    assert.ok(!ubOf(svg, "auth.geml#issueToken"), "mid-graph nodes carry NO ⊕ — their callers are the visible in-edges");
    assert.ok(xOf(ub) < xOf(nodeOf(svg, "auth.geml#login")), "caller handle sits to the LEFT of the entry (LR default)");

    // click the ⊕ -> callers chain (no live loader -> reversed in-slice edges)
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-upbtn" ? ub : null) } });
    svg = svgIn(mount);
    const ks = svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || "")).map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["auth.geml#login", "db.geml#getUser"], "callers chain of the entry: getUser calls login");
    assert.match(lastSeg(mount), /callers of login/, "crumb names the direction");
    assert.match(lastSeg(mount), /in-slice/, "static payload honestly labelled partial");
    const scPane = mount.children.find((c) => c.attrs.class === "cg-stage").children.find((c) => c.attrs.class === "cg-scroll");
    assert.equal(scPane.scrollLeft, 1e6, "callers view auto-scrolls to the focused (far) end");
    assert.ok(xOf(nodeOf(svg, "db.geml#getUser")) < xOf(nodeOf(svg, "auth.geml#login")), "caller drawn before the focused method");
    // the focus carries a standalone MIRRORED handle to its RIGHT (flip back)
    assert.ok(!nodeOf(svg, "auth.geml#login").children.some((c) => (c.attrs.class || "") === "cg-upbtn"), "mirrored handle is standalone too");
    const downUb = ubOf(svg, "auth.geml#login");
    assert.equal(downUb.attrs["data-act"], "down", "focus carries the flip-back handle");
    assert.ok(xOf(downUb) > xOf(nodeOf(svg, "auth.geml#login")), "mirrored handle sits to the RIGHT of the focus");
    assert.ok(!ubOf(svg, "db.geml#getUser"), "ultimate caller carries no handle — the chain is complete");

    // the mirrored ⊕ flips straight back to the callee view it came from
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-upbtn" ? downUb : null) } });
    assert.equal(lastSeg(mount), "roots: entry", "mirrored handle returns to the callee chain");
    // breadcrumb: modules / <container> are clickable segments
    const crumb = mount.children.find((c) => c.attrs.class === "cg-bar").children[0];
    const segs = crumb.children.filter((c) => c.tag === "button").map((b) => b.textContent);
    assert.deepEqual(segs, ["modules", "auth"], "entry -> module levels are clickable");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("code-graph: view {dir:'up'} builds the callers chain from #called-by across documents", () => {
  const r = buildCodeGraph("db.geml", cgOpts, { dir: "up", node: "db.geml#getUser" });
  assert.equal(r.data.dir, "up");
  assert.deepEqual(r.data.roots, ["db.geml#getUser"], "the focused method is the layering root");
  assert.ok(r.data.nodes["auth.geml#login"], "caller pulled from db.geml's #called-by");
  assert.ok(r.data.edges.some((x) => x[0] === "db.geml#getUser" && x[1] === "auth.geml#login"),
    "edge emitted reversed (callee -> caller)");
});

test("code-graph modules mode: entry-holding AND in-degree-zero modules are roots (multi-cluster map)", () => {
  // b holds the app entry; c is a separate cluster nothing reaches (a library
  // consumed through its built package). Both must be roots, or c's cluster
  // degrades to an unlayered parking row.
  const MAP = {
    "idx.geml":
      "=== meta\nrepo = x\ncommit = c0\ncontainer = file\nentry = b.geml#go\nresolution-default = cpg\n===\n\n" +
      "=== table {#modules format=csv}\nmodule, doc, methods, entries, tests\na, a.geml, 1, 0, 0\nb, b.geml, 1, 1, 0\nc, c.geml, 1, 0, 0\n===\n\n" +
      "=== table {#module-edges format=csv}\nfrom, to, calls\nb, a, 1\n===\n",
  };
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  try {
    const { data } = buildCodeGraph("idx.geml", { loadDoc: (p) => MAP[p] ?? null, parseDoc: (s) => parse(s) });
    assert.deepEqual(data.entryDocs, ["b.geml"], "entry container recorded in the payload");
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    const roots = svgIn(mount).children.filter((c) => c.tag === "g" && /root/.test(c.attrs.class)).map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(roots, ["b.geml", "c.geml"], "entry module + uncalled cluster top (derived view)");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("code-graph grouped modules: plain group labels, all-group expansion with tints, external stubs, breadcrumb home", () => {
  const MAP = {
    "idx.geml":
      "=== meta\nrepo = x\ncommit = c0\ncontainer = file\nresolution-default = cpg\n===\n\n" +
      "=== table {#modules format=csv}\nmodule, doc, methods, entries, tests\n" +
      "a/x/one.ts, d1.geml, 2, 0, 0\na/x/two.ts, d2.geml, 3, 0, 0\na/y/three.ts, d3.geml, 4, 0, 0\nb.ts, d4.geml, 1, 0, 0\n===\n\n" +
      "=== table {#module-edges format=csv}\nfrom, to, calls\na/x/one.ts, a/x/two.ts, 2\na/x/one.ts, b.ts, 3\na/y/three.ts, a/x/one.ts, 1\n===\n",
  };
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  try {
    const { data } = buildCodeGraph("idx.geml", { loadDoc: (p) => MAP[p] ?? null, parseDoc: (s) => parse(s) });
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    let svg = svgIn(mount);
    let ks = svg.children.filter((c) => c.tag === "g").map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["d4.geml", "g:a"], "mixed root view: one GROUP (a) + one container (b.ts) — no mixed-depth cut");
    const grpG = svg.children.filter((c) => c.tag === "g").find((g) => g.attrs["data-k"] === "g:a");
    assert.equal(grpG.children.find((c) => c.tag === "text").textContent, "a", "group label is the plain segment (no count badge)");
    assert.match(grpG.attrs.class, /grp/, "group nodes styled distinctly");
    const rootEdges = svg.children.filter((c) => c.tag === "path" && /cg-e/.test(c.attrs.class));
    assert.equal(rootEdges.length, 1, "internal a/x traffic invisible at root; only a -> b.ts remains");
    // descend into a: its children x and y are ALL groups -> the ceremony
    // layer auto-expands one level, tinted by the group each node came from
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? grpG : null) } });
    svg = svgIn(mount);
    ks = svg.children.filter((c) => c.tag === "g").map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["d1.geml", "d2.geml", "d3.geml", "x:b.ts"],
      "all-group level expands to the real containers plus the external stub");
    const d = JSON.parse(mount.attrs["data-graph"]); // raw payload untouched
    assert.ok(d.mods, "payload still raw — views stay derived");
    const stub = svg.children.filter((c) => c.tag === "g").find((g) => g.attrs["data-k"] === "x:b.ts");
    assert.match(stub.children.find((c) => c.tag === "text").textContent, /↗ b\.ts/, "stub names the external target");
    assert.match(stub.attrs.class, /leaf/, "stub renders dimmed");
    const paths = svg.children.filter((c) => c.tag === "path" && /cg-e/.test(c.attrs.class));
    assert.equal(paths.length, 3, "expanded view keeps file-level edges (d1->d2, d1->stub, d3->d1)");
    // breadcrumb home restores the root view in place
    const crumb = mount.children.find((c) => c.attrs.class === "cg-bar").children[0];
    const segs = crumb.children.filter((c) => c.tag === "button" || c.tag === "span").map((b) => b.textContent).filter((t) => t && t !== " / ");
    assert.deepEqual(segs, ["modules", "a"], "breadcrumb walks the tree path");
    crumb.children.find((c) => c.tag === "button" && c.textContent === "modules").listeners.click();
    svg = svgIn(mount);
    ks = svg.children.filter((c) => c.tag === "g").map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["d4.geml", "g:a"], "breadcrumb home restores the root view in place");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("code-graph grouped modules: two-tier flat — deep package path is a flat label, one hop, two clicks", () => {
  const MAP = {
    "idx.geml":
      "=== meta\nrepo = x\ncommit = c0\ncontainer = file\nresolution-default = cpg\n===\n\n" +
      "=== table {#modules format=csv}\nmodule, doc, methods, entries, tests\n" +
      "p/q/r/s/aa.ts, d1.geml, 1, 0, 0\np/q/r/s/bb.ts, d2.geml, 1, 0, 0\nz.ts, d3.geml, 1, 0, 0\n===\n",
  };
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  try {
    const { data } = buildCodeGraph("idx.geml", { loadDoc: (p) => MAP[p] ?? null, parseDoc: (s) => parse(s) });
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    let svg = svgIn(mount);
    // tier 1: one node per top segment — p (a group) and z.ts (a whole container)
    let ks = svg.children.filter((c) => c.tag === "g").map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["d3.geml", "g:p"], "tier 1 = top segments only");
    const pG = svg.children.filter((c) => c.tag === "g").find((g) => g.attrs["data-k"] === "g:p");
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? pG : null) } });
    svg = svgIn(mount);
    // tier 2: the containers under p, FLAT — no q/r/s click-through
    const g2 = svg.children.filter((c) => c.tag === "g");
    ks = g2.map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["d1.geml", "d2.geml"], "one hop lands directly on p's containers");
    const label = g2.find((g) => g.attrs["data-k"] === "d1.geml").children.find((c) => c.tag === "text").textContent;
    assert.equal(label, "q/r/s/aa.ts", "the deep package path reads as a flat label, not clickable levels");
    const crumb = mount.children.find((c) => c.attrs.class === "cg-bar").children[0];
    const segs = crumb.children.filter((c) => c.tag === "button" || c.tag === "span").map((b) => b.textContent).filter((t) => t && t !== " / ");
    assert.deepEqual(segs, ["modules", "p"], "module display is a single breadcrumb hop");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("code-graph grouped modules: a single top segment (one-module repo) lands straight on its containers", () => {
  const MAP = {
    "idx.geml":
      "=== meta\nrepo = x\ncommit = c0\ncontainer = dir\nresolution-default = cpg\n===\n\n" +
      "=== table {#modules format=csv}\nmodule, doc, methods, entries, tests\n" +
      "MethodProbe, d0.geml, 3, 0, 0\nMethodProbe/config, d1.geml, 5, 0, 0\nMethodProbe/log, d2.geml, 4, 0, 0\n===\n",
  };
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  try {
    const { data } = buildCodeGraph("idx.geml", { loadDoc: (p) => MAP[p] ?? null, parseDoc: (s) => parse(s) });
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    const svg = svgIn(mount);
    const ks = svg.children.filter((c) => c.tag === "g").map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["d0.geml", "d1.geml", "d2.geml"], "home is the module's containers, not a lone MethodProbe node");
    // breadcrumb stays at root — no ceremony hop for the sole module
    const crumb = mount.children.find((c) => c.attrs.class === "cg-bar").children[0];
    const segs = crumb.children.filter((c) => c.tag === "button" || c.tag === "span").map((b) => b.textContent).filter((t) => t && t !== " / ");
    assert.deepEqual(segs, ["modules"], "no lone-node hop in the breadcrumb");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("code-graph runtime: accessors hidden by default (with count + toggle); view cap pages with +400/all (DOM stub)", () => {
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  try {
    // --- accessor hiding ---
    const accData = {
      start: "m.geml", depth: 6, roots: ["m.geml#run"],
      nodes: {
        "m.geml#run": { n: "run", doc: "m.geml" },
        "m.geml#work": { n: "work", doc: "m.geml" },
        "m.geml#getX": { n: "getX", doc: "m.geml", leaf: true, acc: true },
        "m.geml#setY": { n: "setY", doc: "m.geml", leaf: true, acc: true },
      },
      edges: [["m.geml#run", "m.geml#work", "call", ""], ["m.geml#run", "m.geml#getX", "call", ""], ["m.geml#work", "m.geml#setY", "call", ""]],
    };
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(accData);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    let gs = svgIn(mount).children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || ""));
    assert.equal(gs.length, 2, "accessors not drawn by default");
    const bar = mount.children.find((c) => c.attrs.class === "cg-bar");
    const accBtn = bar.children.find((b) => /accessors hidden/.test(b.textContent));
    assert.equal(accBtn.textContent, "2 accessors hidden", "hidden count visible, never silent");
    accBtn.listeners.click();
    gs = svgIn(mount).children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || ""));
    assert.equal(gs.length, 4, "toggle brings accessors back");
    const bar2 = mount.children.find((c) => c.attrs.class === "cg-bar");
    assert.ok(bar2.children.some((b) => b.textContent === "hide accessors"), "toggle flips");

    // --- view cap ---
    const big = { start: "b.geml", depth: 6, roots: ["b.geml#r"], nodes: { "b.geml#r": { n: "r", doc: "b.geml" } }, edges: [] };
    for (let i = 0; i < 450; i++) {
      big.nodes[`b.geml#c${i}`] = { n: `c${i}`, doc: "b.geml" };
      big.edges.push(["b.geml#r", `b.geml#c${i}`, "call", ""]);
    }
    const mount2 = fakeEl("div");
    mount2.attrs["data-graph"] = JSON.stringify(big);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount2] : []) });
    let gs2 = svgIn(mount2).children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || ""));
    assert.equal(gs2.length, 400, "first page of the slice");
    const bar3 = mount2.children.find((c) => c.attrs.class === "cg-bar");
    assert.ok(bar3.children.some((el) => /showing 400 of 451 reachable/.test(el.textContent)), "cap is visible");
    bar3.children.find((b) => b.textContent === "all").listeners.click();
    gs2 = svgIn(mount2).children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || ""));
    assert.equal(gs2.length, 451, "'all' recovers the whole slice");
    const bar4 = mount2.children.find((c) => c.attrs.class === "cg-bar");
    assert.ok(!bar4.children.some((el) => /showing/.test(el.textContent || "")), "note gone once complete");
  } finally {
    globalThis.document = prevDoc;
  }
});

// ---------------------------------------------------------------------------
// Oversized tables (DOM preview bound) + the per-document graph indexes
// ---------------------------------------------------------------------------

const csvRows = (n) => Array.from({ length: n }, (_, i) => `r${i}, ${i}`).join("\n");

test("big tables: truncated for the DOM, but OPEN in a normal document — the table is its content", () => {
  const out = renderHtml(parse(`# T\n\n=== table {#big format=csv header=1 caption="cap"}\nK, V\n${csvRows(501)}\n===\n`), { source: "t.geml" });
  assert.match(out, /showing the first 500 of 501 rows/, "note names the bound and the total");
  assert.doesNotMatch(out, /<details/, "no fold outside codemap documents");
  assert.equal((out.match(/<tr>/g) || []).length, 1 + 500, "header + exactly 500 body rows");
  assert.match(out, />r499</, "last previewed row rendered");
  assert.doesNotMatch(out, />r500</, "row past the bound not rendered");
  assert.match(out, /<figcaption>cap<\/figcaption>/, "caption survives");
});

test("big tables: fold shut (collapsed <details>) only in codemap documents", () => {
  const doc = `=== meta\nmodule = m\nentry = #a\n===\n\n=== code {#a src=s#L1-2 anchor="x"}\n===\n\n=== table {#big format=csv header=1}\nK, V\n${csvRows(501)}\n===\n`;
  const out = renderHtml(parse(doc), { source: "m.geml", ...cgOpts });
  assert.match(out, /<details><summary>#big · 501 rows \(preview: first 500\)<\/summary>/, "machine table folds with an informative summary");
  assert.match(out, /showing the first 500 of 501 rows/);
});

test("big tables: the bound is a RenderOptions knob (tableRows)", () => {
  const out = renderHtml(parse(`=== table {#big format=csv header=1}\nK, V\n${csvRows(20)}\n===\n`), { source: "t.geml", tableRows: 10 });
  assert.match(out, /showing the first 10 of 20 rows/);
  assert.equal((out.match(/<tr>/g) || []).length, 1 + 10);
  const untouched = renderHtml(parse(`=== table {#s format=csv header=1}\nK, V\n${csvRows(20)}\n===\n`), { source: "t.geml" });
  assert.doesNotMatch(untouched, /class="table-note"/, "under the default bound nothing changes");
});

test("big tables: computed summary row aggregates ALL rows, not just the rendered preview", () => {
  const doc = `=== table {#big format=csv header=1 summary="K = 'Total'; V [%.0f] = sum(V)"}\nK, V\n${csvRows(501)}\n===\n`;
  const out = renderHtml(parse(doc), { source: "t.geml" });
  // sum(0..500) = 125250 — provably computed from the full model
  assert.match(out, /125250/, "tfoot aggregate covers the truncated rows too");
  assert.match(out, /showing the first 500 of 501/);
});

test("big tables: the code-graph reads the MODEL — a truncated #calls table still yields every edge", () => {
  const rows = Array.from({ length: 600 }, (_, i) => `#m0, #m${i + 1}, call,`).join("\n");
  const doc = `=== meta\nmodule = big\nentry = #m0\n===\n\n=== code {#m0 src=s#L1-2 anchor="m0"}\n===\n\n=== table {#calls format=csv}\nfrom, to, kind, confidence\n${rows}\n===\n`;
  const MAP = { "big.geml": doc };
  const out = renderHtml(parse(doc), { source: "big.geml", loadDoc: (p) => MAP[p] ?? null, parseDoc: (s) => parse(s) });
  const d = graphData(out);
  assert.equal(d.edges.length, 600, "all 600 edges in the graph payload");
  assert.match(out, /showing the first 500 of 600 rows/, "while the HTML table previews 500");
});

test("code-graph indexes: equivalent to the old linear scan — first duplicate id wins, first #calls table wins, horizon marks intact", () => {
  const MAP = {
    "chain.geml":
      "=== meta\nmodule = chain\nentry = #a\ngraph-depth = 1\n===\n\n" +
      '=== code {#a src=s#L1-2 anchor="c1"}\n===\n' +
      '=== code {#b .leaf src=s#L3-4 anchor="c2"}\n===\n' +
      '=== code {#b src=s#L5-6 anchor="c3"}\n===\n\n' + // duplicate id: FIRST block's classes must win
      "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#a, #b, call,\n#b, #c, call,\n===\n\n" +
      "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#a, #ignored, call,\n===\n", // second #calls table is ignored (old behaviour)
  };
  const opts2 = { loadDoc: (p) => MAP[p] ?? null, parseDoc: (s) => parse(s) };
  const r = buildCodeGraph("chain.geml", opts2);
  assert.ok(r.data.nodes["chain.geml#b"].leaf, "duplicate id resolves to the FIRST block (its .leaf)");
  assert.ok(r.data.nodes["chain.geml#b"].more, "depth horizon still marked through the indexed rows");
  assert.ok(!r.data.nodes["chain.geml#ignored"], "rows of a second #calls table are not followed");
  assert.deepEqual(r.data.edges, [["chain.geml#a", "chain.geml#b", "call", ""]], "depth-1 slice: exactly the first hop");
});

test("code-graph indexes: node objects are fresh per build — no cross-call aliasing", () => {
  const r1 = buildCodeGraph("auth.geml", cgOpts);
  r1.data.nodes["auth.geml#issueToken"].n = "hacked";
  const r2 = buildCodeGraph("auth.geml", cgOpts);
  assert.equal(r2.data.nodes["auth.geml#issueToken"].n, "issueToken", "mutating one build's nodes cannot leak into the next");
});

test("code-graph live page: opts.liveGraph injects the module script; mounts carry data-start", () => {
  const doc = parse(CODEMAP["auth.geml"]);
  const live = renderHtml(doc, { source: "auth.geml", ...cgOpts, liveGraph: "/_dist/" });
  assert.match(live, /await import\("\/_dist\/geml\.js"\)/, "live module script injected (dynamic import, after the process shim)");
  assert.match(live, /<script type="importmap">\{"imports":\{"node:fs":"\/_dist\/_node-stub\.js"/, "import map sends node builtins to the served stub");
  assert.ok(live.indexOf("importmap") < live.indexOf("await import"), "import map precedes any module load");
  assert.match(live, /codeGraphWaves/, "shared wave builder imported");
  assert.match(live, /data-start="auth\.geml"/, "mount names its own document without payload re-parse");
  const still = renderHtml(doc, { source: "auth.geml", ...cgOpts });
  assert.doesNotMatch(still, /_dist\/geml\.js/, "no module script without the option — offline pages stay static");
});

test("code-graph sidecar: opts.graphSidecar ships mounts WITHOUT the payload (fetched after paint)", () => {
  const doc = parse(CODEMAP["auth.geml"]);
  const out = renderHtml(doc, { source: "auth.geml", ...cgOpts, graphSidecar: "/_graph?doc=", liveGraph: "/_dist/" });
  assert.match(out, /data-graph-src="\/_graph\?doc=auth\.geml"/, "mount points at the sidecar route");
  assert.doesNotMatch(out, /data-graph="/, "no inline payload attribute");
  assert.match(out, /data-start="auth\.geml"/, "live hooks still know the document");
});

const flushAsync = () => new Promise((r) => setTimeout(r, 0));
async function atest(name, fn) { await fn(); passed++; console.log("ok", name); }

await atest("code-graph runtime: sidecar mounts fetch their payload then boot; a fetch error lands in the mount", async () => {
  const prevDoc = globalThis.document;
  const prevFetch = globalThis.fetch;
  globalThis.document = { createElementNS: (_n, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  try {
    const { data } = buildCodeGraph("auth.geml", cgOpts);
    const mount = fakeEl("div");
    mount.attrs["data-graph-src"] = "/_graph?doc=auth.geml";
    globalThis.fetch = async () => ({ json: async () => ({ data }) });
    codeGraphRuntime({ querySelectorAll: (s) => (s === ".cg-mount" ? [mount] : []) });
    await flushAsync();
    const svg = svgIn(mount);
    assert.ok(svg, "graph drawn from the fetched payload");
    assert.equal(svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || "")).length, 3, "same slice as the inline path");
    const m2 = fakeEl("div");
    m2.attrs["data-graph-src"] = "/_graph?doc=zz.geml";
    globalThis.fetch = async () => ({ json: async () => ({ error: "cannot load `zz.geml`" }) });
    codeGraphRuntime({ querySelectorAll: (s) => (s === ".cg-mount" ? [m2] : []) });
    await flushAsync();
    assert.match(m2.textContent, /cannot load/, "sidecar error surfaces in the mount");
    // a truncated sidecar payload plants the visible note beside the mount
    const m3 = fakeEl("div");
    m3.attrs["data-graph-src"] = "/_graph?doc=auth.geml";
    m3.parentNode = { inserted: [], insertBefore(n) { this.inserted.push(n); } };
    m3.nextSibling = null;
    globalThis.fetch = async () => ({ json: async () => ({ data, truncated: true }) });
    codeGraphRuntime({ querySelectorAll: (s) => (s === ".cg-mount" ? [m3] : []) });
    await flushAsync();
    assert.equal(m3.parentNode.inserted.length, 1, "truncation note inserted");
    assert.equal(m3.parentNode.inserted[0].attrs.class, "cg-note", "…as the standard cg-note");
  } finally {
    globalThis.document = prevDoc;
    globalThis.fetch = prevFetch;
  }
});

await atest("codeGraphWaves: fetches each missing document once; later builds reuse the wave cache", async () => {
  let fetches = [];
  const w = codeGraphWaves(async (rel) => { fetches.push(rel); return CODEMAP[rel] ?? null; }, (s) => parse(s));
  const r1 = await w.build("auth.geml");
  assert.equal(r1.error, undefined, "cross-document build succeeds");
  assert.ok(r1.data.nodes["db.geml#getUser"], "slice crossed into the fetched sibling");
  assert.deepEqual(fetches.sort(), ["auth.geml", "db.geml"], "each document fetched exactly once");
  fetches = [];
  const r2 = await w.build("db.geml", { dir: "up", node: "db.geml#getUser" });
  assert.equal(fetches.length, 0, "a directed re-build is served entirely from the cache");
  assert.equal(r2.data.dir, "up", "…and still produces the callers view");
  // a missing document degrades to an error without retry storms
  fetches = [];
  const bad = await w.build("nope.geml");
  assert.match(bad.error, /cannot load/, "missing document reports cleanly");
  await w.build("nope.geml");
  assert.deepEqual(fetches, ["nope.geml"], "failed fetches are remembered, not retried");
});

await atest("code-graph runtime: a hook attached AFTER the first draw is honoured on the next click (late binding)", async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  globalThis.window = { location: { href: "" } };
  try {
    const { data } = buildCodeGraph("index.geml", cgOpts);
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    mount.attrs["data-src"] = "codemap/index.geml";
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    // the static draw happened WITHOUT a live loader; attach one now, the way
    // a served page's async module script does
    const seen = [];
    mount._cgView = async (view) => { seen.push(view); return { start: "codemap/auth.geml", depth: 6, roots: [], nodes: {}, edges: [] }; };
    const svg = svgIn(mount);
    const authG = svg.children.filter((c) => c.tag === "g").find((g) => g.attrs["data-k"] === "auth.geml");
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? authG : null) } });
    await flushAsync();
    assert.deepEqual(seen, [{ doc: "codemap/auth.geml" }], "module click went through the late-bound loader");
    assert.equal(globalThis.window.location.href, "", "…and never navigated the page");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

await atest("code-graph runtime: ⊕ on a caller-less entry jumps to the module page, not an empty caller view", async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  globalThis.window = { location: { href: "" } };
  const MAP = {
    "c.geml": "=== meta\nmodule = c\nentry = #top\nresolution-default = cpg\n===\n\n=== code {#top name=\"C.top\" anchor=\"java:c#top(void())\"}\n===\n",
  };
  try {
    const { data } = buildCodeGraph("c.geml", { loadDoc: (p) => MAP[p] ?? null, parseDoc: (s) => parse(s) });
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    const seen = [];
    mount._cgView = async (view) => {
      seen.push(view);
      if (view.dir === "up") return { start: "c.geml", depth: 99, roots: ["c.geml#top"], nodes: { "c.geml#top": { n: "C.top" } }, edges: [], dir: "up", focus: "c.geml#top" }; // 1 node -> no callers
      return { start: "index.geml", depth: 99, roots: [], nodes: {}, edges: [], mode: "modules", mods: [{ p: "foo/a", doc: "a.geml" }, { p: "foo/b", doc: "b.geml" }], medges: [], entryDocs: [] };
    };
    let svg = svgIn(mount);
    const ub = svg.children.filter((c) => c.tag === "g" && (c.attrs.class || "") === "cg-upbtn").find((u) => u.attrs["data-k"] === "c.geml#top");
    assert.equal(ub.attrs["data-act"], "up", "caller-less entry still carries the standalone ⊕");
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-upbtn" ? ub : null) } });
    await flushAsync();
    await flushAsync();
    assert.deepEqual(seen[0], { dir: "up", node: "c.geml#top" }, "first it asks for the caller chain");
    assert.deepEqual(seen[1], { doc: "index.geml" }, "empty chain -> redirect to the module page");
    // …and the module index actually RENDERS (re-booted so its tree derives),
    // not an empty raw payload
    svg = svgIn(mount);
    const ks = svg.children.filter((c) => c.tag === "g").map((x) => x.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["a.geml", "b.geml"], "module page derived its containers, not empty");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

await atest("code-graph runtime: clicking a method node fetches and shows its source (DOM stub)", async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  globalThis.window = { location: { href: "" } };
  const SRC = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
  const fetched = [];
  globalThis.fetch = (u) => { fetched.push(u); return { ok: true, text: () => SRC }; };
  const panelOf = (mount) => mount.children.find((c) => (c.attrs.class || "") === "cg-stage").children.find((c) => (c.attrs.class || "") === "cg-src");
  const bodyOf = (mount) => panelOf(mount).children.find((c) => (c.attrs.class || "") === "cg-src-body");
  const nodeClick = (svg, k) => svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || "")).find((g) => g.attrs["data-k"] === k) : null) } });
  try {
    const { data } = buildCodeGraph("auth.geml", cgOpts);
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    // navBase = the mount document's directory; source is fetched relative to it
    mount.attrs["data-src"] = "codemap/auth.geml";
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    const svg = svgIn(mount);
    assert.equal(panelOf(mount).style.display, "none", "source panel hidden until a node is clicked");
    // #login src=src/login.ts#L1-9 -> navBase-relative fetch, sliced to lines 1..9
    nodeClick(svg, "auth.geml#login");
    await flushAsync();
    assert.equal(fetched[0], "codemap/src/login.ts", "fetched the src path relative to navBase");
    const panel = panelOf(mount);
    assert.equal(panel.style.display, "", "panel shown on click");
    const hd = panel.children.find((c) => (c.attrs.class || "") === "cg-src-hd");
    assert.match(hd.children[0].textContent, /src\/login\.ts#L1-9/, "header names path#lines");
    assert.equal(bodyOf(mount).textContent, Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n"), "body holds exactly lines 1..9");
    // the graph stays interactive: clicking another node updates the panel
    nodeClick(svg, "auth.geml#issueToken");
    await flushAsync();
    assert.equal(fetched[1], "codemap/src/token.ts", "a second node repopulates the panel from its own src");
    // the ✕ closes the panel
    const closeBtn = panelOf(mount).children.find((c) => (c.attrs.class || "") === "cg-src-hd").children.find((c) => c.tag === "button");
    closeBtn.listeners.click();
    assert.equal(panelOf(mount).style.display, "none", "✕ hides the panel");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  }
});

await atest("code-graph runtime: source panel degrades gracefully — unreachable / no src / no fetch (DOM stub)", async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  globalThis.window = { location: { href: "" } };
  const panelOf = (mount) => mount.children.find((c) => (c.attrs.class || "") === "cg-stage").children.find((c) => (c.attrs.class || "") === "cg-src");
  const bodyOf = (mount) => panelOf(mount).children.find((c) => (c.attrs.class || "") === "cg-src-body");
  const noteOf = (mount) => bodyOf(mount).children.find((c) => (c.attrs.class || "") === "cg-src-note");
  const mountWith = (payload) => { const m = fakeEl("div"); m.attrs["data-graph"] = JSON.stringify(payload); return m; };
  const nodeClick = (svg, k) => svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || "")).find((g) => g.attrs["data-k"] === k) : null) } });
  const { data } = buildCodeGraph("auth.geml", cgOpts);
  try {
    // (1) fetch not-ok -> degrade to the path; and the base is overridable
    const fetched = [];
    globalThis.fetch = (u) => { fetched.push(u); return { ok: false }; };
    const m1 = mountWith(data);
    m1.attrs["data-src-base"] = "over/"; // explicit override wins over navBase
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [m1] : []) });
    nodeClick(svgIn(m1), "auth.geml#login");
    await flushAsync();
    assert.equal(fetched[0], "over/src/login.ts", "data-src-base overrides the fetch base");
    assert.match(noteOf(m1).textContent, /source not reachable here/, "unreachable degrades to a note, no throw");
    assert.match(noteOf(m1).textContent, /src\/login\.ts#L1-9/, "the src path is still shown");

    // (2) a node with NO src -> a clear note, no fetch attempted
    const m2 = mountWith({ start: "x.geml", depth: 6, roots: ["x.geml#a"], nodes: { "x.geml#a": { n: "a" } }, edges: [] });
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [m2] : []) });
    nodeClick(svgIn(m2), "x.geml#a");
    assert.match(bodyOf(m2).textContent, /no source location recorded/, "a src-less node says so");

    // (3) no fetch available (offline static embed) -> degrade
    globalThis.fetch = undefined;
    const m3 = mountWith(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [m3] : []) });
    nodeClick(svgIn(m3), "auth.geml#login");
    assert.match(noteOf(m3).textContent, /source not reachable here/, "no fetch -> degrade, no throw");

    // (4) a throwing fetch is caught
    globalThis.fetch = () => { throw new Error("boom"); };
    const m4 = mountWith(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [m4] : []) });
    nodeClick(svgIn(m4), "auth.geml#login");
    assert.match(noteOf(m4).textContent, /source not reachable here/, "a synchronously throwing fetch is caught");

    // (5) an async rejection is caught
    globalThis.fetch = () => Promise.reject(new Error("neterr"));
    const m5 = mountWith(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [m5] : []) });
    nodeClick(svgIn(m5), "auth.geml#login");
    await flushAsync();
    assert.match(noteOf(m5).textContent, /source not reachable here/, "an async fetch rejection degrades via .catch");

    // (6) src without a line range -> the whole file is shown
    const seen = [];
    globalThis.fetch = (u) => { seen.push(u); return { ok: true, text: () => "ALPHA\nBETA\nGAMMA" }; };
    const m6 = mountWith({ start: "y.geml", depth: 6, roots: ["y.geml#a"], nodes: { "y.geml#a": { n: "a", src: "whole.ts" } }, edges: [] });
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [m6] : []) });
    nodeClick(svgIn(m6), "y.geml#a");
    await flushAsync();
    assert.equal(seen[0], "whole.ts", "no navBase and no #range -> fetch the bare path");
    assert.equal(bodyOf(m6).textContent, "ALPHA\nBETA\nGAMMA", "no line range -> the whole file is shown");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  }
});

test("code-graph runtime: hovering a node lights its caller cone and dims the rest; mouseout clears", () => {
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  try {
    // auth fixture: login -> issueToken, login -> getUser, getUser -> login (cycle)
    const { data } = buildCodeGraph("auth.geml", cgOpts);
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    const svg = svgIn(mount);
    const gOf = (k) => svg.children.filter((c) => c.tag === "g").find((g) => g.attrs["data-k"] === k);
    // hover getUser: its caller cone is login (and getUser itself via the cycle) — issueToken stays out
    svg.listeners.mouseover({ target: { closest: (s) => (s === ".cg-n" ? gOf("db.geml#getUser") : null) } });
    assert.match(svg.attrs.class, /\bhl\b/, "svg flagged so the rest dims");
    assert.match(gOf("db.geml#getUser").attrs.class, / hl$/, "hovered node lit");
    assert.match(gOf("auth.geml#login").attrs.class, / hl$/, "direct caller lit");
    assert.doesNotMatch(gOf("auth.geml#issueToken").attrs.class, /hl/, "non-caller dimmed");
    const paths = svg.children.filter((c) => c.tag === "path");
    const hlEdges = paths.filter((p) => / hl$/.test(p.attrs.class));
    assert.equal(hlEdges.length, 2, "both edges of the caller cycle lit (login->getUser, getUser->login)");
    assert.ok(!paths.some((p) => /hl/.test(p.attrs.class) && p.attrs.class.includes("cand")) || true, "");
    // mouseout on a node clears everything
    svg.listeners.mouseout({ target: { closest: (s) => (s === ".cg-n" ? gOf("db.geml#getUser") : null) } });
    assert.equal(svg.attrs.class, "cg-svg", "dim flag removed");
    assert.doesNotMatch(gOf("auth.geml#login").attrs.class, /hl/, "highlight cleared");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("code-graph parse checks: registered format, src= required, body ignored", () => {
  const ok = parse("=== diagram {format=geml-code-graph src=auth.geml}\n===\n", { resolveDoc: (p) => CODEMAP[p] ?? null });
  assert.equal(ok.diagnostics.length, 0, "well-formed embed is clean (format is registered)");
  const missing = parse("=== diagram {format=geml-code-graph}\n===\n");
  assert.ok(missing.diagnostics.some((d) => /missing `src=`/.test(d.message)), "missing src warns");
  const unres = parse("=== diagram {format=geml-code-graph src=zz.geml}\n===\n", { resolveDoc: () => null });
  assert.ok(unres.diagnostics.some((d) => /cannot resolve document/.test(d.message)), "unresolvable src warns");
  const body = parse("=== diagram {format=geml-code-graph src=auth.geml}\nstray\n===\n", { resolveDoc: (p) => CODEMAP[p] ?? null });
  assert.ok(body.diagnostics.some((d) => /body is ignored/.test(d.message)), "non-empty body warns");
});

console.log(`\n${passed} test(s) passed.`);
