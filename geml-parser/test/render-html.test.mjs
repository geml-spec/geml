// CLI HTML renderer (render.ts) tests: exercise the self-contained output —
// every chart type drawn as inline SVG (incl. negative values and a size
// channel), the diagram fallbacks, output/code/math blocks, tables, notes,
// lists, and inline constructs. This is the path `geml render` uses.
import { parse, renderHtml } from "../dist/geml.js";
import { buildCodeGraph, codeGraphRuntime } from "../dist/render.js";
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
    "#login, #issueToken, call,\n#login, db.geml#getUser, call, medium\n===\n",
  "db.geml":
    "=== meta\nmodule = db\nentry = #getUser\nresolution-default = cpg\n===\n\n" +
    '=== code {#getUser src=src/db.ts#L1-9 anchor="d1"}\n===\n\n' +
    // a cross-document cycle back into auth: getUser -> login (a back edge)
    "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#getUser, auth.geml#login, call,\n===\n",
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

test("code-graph runtime: layered layout, back edge, click-to-re-root (DOM stub)", () => {
  // Run the browser draw-time runtime in node against the DOM stub — this
  // pins the GEP-0003 algorithm (slice -> back-edge DFS -> longest-path
  // layering) and the re-root interaction without a browser.
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  try {
    const { data } = buildCodeGraph("auth.geml", cgOpts);
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    const root = { querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) };
    codeGraphRuntime(root);

    const svg = mount.children.find((c) => c.tag === "svg");
    assert.ok(svg, "svg drawn");
    const gs = svg.children.filter((c) => c.tag === "g");
    const paths = svg.children.filter((c) => c.tag === "path");
    assert.equal(gs.length, 3, "login + issueToken + getUser laid out");
    assert.equal(paths.filter((p) => /back/.test(p.attrs.class)).length, 1, "getUser -> login is a back edge");
    const rootG = gs.find((g) => /root/.test(g.attrs.class));
    assert.equal(rootG.attrs["data-k"], "auth.geml#login", "root node highlighted");
    const layers = new Set(gs.map((g) => g.attrs.transform.match(/,([\d.]+)\)$/)[1]));
    assert.equal(layers.size, 2, "two layers (login above its callees)");

    // click getUser -> re-root: layering now getUser(0) -> login(1) -> issueToken(2)
    const getUserG = gs.find((g) => g.attrs["data-k"] === "db.geml#getUser");
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? getUserG : null) } });
    const svg2 = mount.children.find((c) => c.tag === "svg");
    const gs2 = svg2.children.filter((c) => c.tag === "g");
    const layers2 = new Set(gs2.map((g) => g.attrs.transform.match(/,([\d.]+)\)$/)[1]));
    assert.equal(gs2.length, 3, "re-rooted slice reaches all three");
    assert.equal(layers2.size, 3, "three layers from the new root");
    const bar = mount.children.find((c) => c.attrs.class === "cg-bar");
    assert.ok(bar.children.some((b) => b.textContent === "back"), "back button appears after drill-down");
    // back -> original roots restored
    bar.children.find((b) => b.textContent === "back").listeners.click();
    const gs3 = mount.children.find((c) => c.tag === "svg").children.filter((c) => c.tag === "g");
    assert.equal(gs3.find((g) => /root/.test(g.attrs.class)).attrs["data-k"], "auth.geml#login", "back restores the entry root");
  } finally {
    globalThis.document = prevDoc;
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

    const svg = mount.children.find((c) => c.tag === "svg");
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

    // toggle to left-right: layers become columns (distinct x, not distinct y)
    const bar = mount.children.find((c) => c.attrs.class === "cg-bar");
    const dirBtn = bar.children.find((b) => b.textContent === "left-right");
    assert.ok(dirBtn, "direction toggle present");
    dirBtn.listeners.click();
    const svg2 = mount.children.find((c) => c.tag === "svg");
    const xs = new Set(), ys = new Set();
    for (const g of svg2.children.filter((c) => c.tag === "g")) {
      const m = g.attrs.transform.match(/\(([\d.]+),([\d.]+)\)/);
      xs.add(m[1]); ys.add(m[2]);
    }
    assert.equal(xs.size, 2, "LR: two columns");
    assert.equal(ys.size, 1, "LR: single-node columns align on one row");
    const bar2 = mount.children.find((c) => c.attrs.class === "cg-bar");
    assert.ok(bar2.children.some((b) => b.textContent === "top-down"), "toggle now offers top-down");
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

test("code-graph modules mode: index doc yields the module overview; click opens the container page", () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { createElementNS: (_ns, t) => fakeEl(t), createElement: (t) => fakeEl(t) };
  globalThis.window = { location: { href: "" } };
  try {
    const { data } = buildCodeGraph("index.geml", cgOpts);
    assert.equal(data.mode, "modules", "container= meta selects the module overview");
    assert.deepEqual(Object.keys(data.nodes).sort(), ["auth.geml", "db.geml"], "one node per #modules row, keyed by doc");
    assert.deepEqual(data.roots, ["auth.geml"], "no app entries -> in-degree-zero modules are roots");
    const mount = fakeEl("div");
    mount.attrs["data-graph"] = JSON.stringify(data);
    // a live mount (viewer/playground): data-src anchors relative doc names
    mount.attrs["data-src"] = "codemap/index.geml";
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    const svg = mount.children.find((c) => c.tag === "svg");
    const gs = svg.children.filter((c) => c.tag === "g");
    assert.equal(gs.length, 2, "both modules drawn");
    const authG = gs.find((g) => g.attrs["data-k"] === "auth.geml");
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? authG : null) } });
    assert.equal(globalThis.window.location.href, "codemap/auth.html",
      "doc name resolves against the mount's data-src directory");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
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
  const { data } = buildCodeGraph("idx.geml", { loadDoc: (p) => MAP[p] ?? null, parseDoc: (s) => parse(s) });
  assert.deepEqual(data.roots.slice().sort(), ["b.geml", "c.geml"], "entry module + uncalled cluster top");
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
