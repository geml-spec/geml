// Branch-coverage companion for dist/render.js: exercises the renderer edges
// (inline constructs, list/table/chart/diagram variants, codemap folds) and
// the codemap viewer runtime arms (TB handles, search box, cap pager, openDoc
// probe paths, flash contract, source panel, module-tree derivation) that the
// main suites leave dark. Same conventions as test/render-html.test.mjs: the
// compiled dist API drives everything, the viewer runs under a fake DOM.
import { parse } from "../dist/geml.js";
import { buildCodeGraph, codeGraphRuntime, codeGraphWaves } from "../dist/render.js";
import { renderHtml } from "../dist/render-html.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
async function atest(name, fn) { await fn(); passed++; console.log("ok", name); }
const flush = async () => { for (let i = 0; i < 6; i++) await null; };

// ---------------------------------------------------------------------------
// 1) Renderer: inline + block edge cases through parse()
// ---------------------------------------------------------------------------

const TOUR = `# Cov tour {#top}

**bold** and ~~struck~~ text with a break\\
next line, a cross-doc ref [[o.geml#sec]], an unresolved ref [[#zzz]],
a sound ![snd](s.mp3), a doc link [dl](o.geml#sec), a bare doc link [d2](o.geml),
an in-page link [ip](#top),
and an attributed link [ext](https://e.example/){rel=me target=_blank}.

%% a hidden scratch line

### Quiet heading {hidden}

4. four
5. five

Prose between lists.

- loose a

- loose b

=== table {#al}
| L | C | R |
|:--|:-:|--:|
| a | b | c |
===

=== table {#sp span="r1c1:2x2"}
| A | B | C |
|---|---|---|
| m | x | y |
| p | q | r |
===

=== table {#sp2 span="r1c1:1x2" span2="r2c1:2x1"}
| A | B | C |
|---|---|---|
| m | x | y |
| p | q | r |
| s | t | u |
===

=== table {#nh format=csv header=0}
1, 2
===

=== table {#c10 format=csv header=1}
K, V, W
Alpha, 10, 15
VeryLongCategoryName, 4, 12345
===

=== table {#c45 format=csv header=1}
K, V
a, 45
b, 3
===

=== table {#neg2 format=csv header=1}
K, V
p, -3
q, -5
===

=== table {#ce format=csv header=1}
K, V
a,
b,
===

=== table {#pz format=csv header=1}
K, V
a, 0
b, 0
===

=== table {#p91 format=csv header=1}
K, V
big, 9
small, 1
===

=== diagram {format=geml-chart data=#c10 type=bar x=K y=V caption="ten"}
===

=== diagram {format=geml-chart data=#c10 type=bar x=K y="V,W"}
===

=== diagram {format=geml-chart data=#c45 type=bar x=K y=V}
===

=== diagram {format=geml-chart data=#neg2 type=bar x=K y=V}
===

=== diagram {format=geml-chart data=#ce type=line x=K y=V}
===

=== diagram {format=geml-chart data=#pz type=pie x=K y=V}
===

=== diagram {format=geml-chart data=#p91 type=pie x=K y=V caption="pie"}
===

=== diagram {format=geml-chart data=#c10 type=scatter x=K y=V caption="sc"}
===

=== diagram {format=geml-chart data=#nope type=bar x=K y=V}
===

=== diagram {format=geml-code-graph}
===

=== diagram {format=d2 caption="dd"}
q -> p
===

=== diagram
free-form sketch
===

=== zzz {#u}
kept raw
===
`;

const tourHtml = renderHtml(parse(TOUR), { source: "cov.geml" });

test("inline: strong, strike, break, cross-doc + unresolved autorefs, audio, doc links, link attrs", () => {
  assert.match(tourHtml, /<strong>bold<\/strong>/);
  assert.match(tourHtml, /<del>struck<\/del>/);
  assert.match(tourHtml, /<br>/);
  assert.match(tourHtml, /href="o\.html#sec"/, "cross-doc autoref maps .geml -> .html");
  assert.match(tourHtml, /href="#zzz">zzz</, "unresolved autoref label falls back to the anchor");
  assert.match(tourHtml, /<audio class="media" src="s\.mp3"/, "mp3 infers audio");
  assert.match(tourHtml, /<a href="o\.html#sec">dl<\/a>/, "doc link with anchor");
  assert.match(tourHtml, /<a href="o\.html">d2<\/a>/, "doc link without anchor");
  assert.match(tourHtml, /rel="me"[^>]*target="_blank"|target="_blank"[^>]*rel="me"/, "link rel/target attrs");
});

test("blocks: hidden line + hidden heading render nothing; ordered start; loose list", () => {
  assert.doesNotMatch(tourHtml, /hidden scratch/);
  assert.doesNotMatch(tourHtml, /Quiet heading/);
  assert.match(tourHtml, /<ol start="4">/, "ordered list keeps its start");
  assert.match(tourHtml, /<li><p>loose a<\/p>/, "loose items wrap in <p>");
});

test("tables: alignment styles, merged spans, headerless CSV", () => {
  assert.match(tourHtml, /style="text-align:center"/, "center alignment");
  assert.match(tourHtml, /style="text-align:right"/, "right alignment");
  assert.match(tourHtml, /rowspan="2" colspan="2"/, "span attr becomes row+colspan");
  const nh = tourHtml.slice(tourHtml.indexOf('id="nh"'), tourHtml.indexOf('id="nh"') + 400);
  assert.doesNotMatch(nh, /<thead>/, "headerless table has no thead");
});

test("charts: captions title the SVG; multi-series legend; big numbers; empty/zero datasets survive", () => {
  assert.match(tourHtml, /class="c-title">ten</, "caption becomes the svg title");
  assert.match(tourHtml, /class="c-legend">V</, "legend for multi-series");
  assert.match(tourHtml, /12,345/, "fmtNum uses locale grouping past 1000");
  assert.match(tourHtml, /VeryLongCat…|VeryLongCa…/, "x labels truncate");
  assert.match(tourHtml, /class="c-title">pie</);
  assert.match(tourHtml, /class="c-title">sc</);
});

test("diagram fallbacks: failed chart, missing code-graph src, captioned DSL, format-less diagram, unknown type", () => {
  assert.match(tourHtml, /chart could not be built/);
  assert.match(tourHtml, /geml-code-graph: missing <code>src=<\/code>/);
  assert.match(tourHtml, /dd — <\/?[a-z]*>?<code>d2<\/code>|dd — <code>d2<\/code>/, "caption joins the format note");
  assert.match(tourHtml, /<code>diagram<\/code> \(no bundled renderer/, "format-less diagram labelled generically");
  assert.match(tourHtml, /unknown block type <code>zzz<\/code>/);
});

// ---------------------------------------------------------------------------
// 2) Renderer: defensive arms via hand-built document models (renderHtml is a
//    public API over the document model; these shapes are legal if unusual)
// ---------------------------------------------------------------------------

const chartBlock = (chart) => ({ kind: "block", type: "diagram", classes: [], attrs: { format: "geml-chart" }, raw: [], chart });

test("hand-built models: id-less heading, blank paragraph, child-less note, table-less table", () => {
  const doc = {
    children: [
      { kind: "heading", level: 3, text: "T", inlines: [{ type: "text", value: "T" }] },
      { kind: "paragraph", inlines: [{ type: "text", value: "   " }] },
      { kind: "block", type: "note", classes: [], attrs: {}, raw: [] },
      { kind: "block", type: "table", classes: [], attrs: {}, raw: [] },
    ],
  };
  const out = renderHtml(doc, {});
  assert.match(out, /<h3>T<\/h3>/, "no id attribute emitted");
  assert.doesNotMatch(out, /<p>\s*<\/p>/, "whitespace-only paragraph dropped");
  assert.match(out, /<aside class="callout note">/, "empty note still renders its shell");
  assert.match(out, /table failed to parse/);
});

test("hand-built charts: missing number columns and category/value mismatches degrade, never throw", () => {
  const mk = (chart) => renderHtml({ children: [chartBlock(chart)] }, {});
  // numbers entirely missing for the bound column
  assert.match(mk({ type: "bar", x: "K", y: ["V"], dataset: { categories: ["a"], numbers: {} } }), /<svg/);
  assert.match(mk({ type: "line", x: "K", y: ["V"], dataset: { categories: ["a"], numbers: {} } }), /<svg/);
  assert.match(mk({ type: "pie", x: "K", y: ["V"], dataset: { categories: ["a"], numbers: {} } }), /<svg/);
  assert.match(mk({ type: "scatter", x: "K", y: ["V"], dataset: { categories: ["a"], numbers: {} } }), /<svg/);
  // more values than categories: the tooltip category degrades to ""
  assert.match(mk({ type: "bar", x: "K", y: ["V"], dataset: { categories: ["a"], numbers: { V: [1, 2] } } }), /<rect/);
  assert.match(mk({ type: "line", x: "K", y: ["V"], dataset: { categories: ["a"], numbers: { V: [1, 2] } } }), /<polyline/);
  assert.match(mk({ type: "pie", x: "K", y: ["V"], dataset: { categories: ["a"], numbers: { V: [1, 2] } } }), /<path/);
  assert.match(mk({ type: "scatter", x: "K", y: ["V"], dataset: { categories: ["1"], numbers: { V: [1, 2] } } }), /<circle/);
});

test("codemap fold: an oversized UNNAMED table in a codemap document folds with a generic summary", () => {
  const doc = `=== meta\nmodule = m\n===\n\n=== table {format=csv header=1}\nK, V\n${Array.from({ length: 7 }, (_, i) => `r${i}, ${i}`).join("\n")}\n===\n`;
  const out = renderHtml(parse(doc), { source: "m.geml", tableRows: 5 });
  assert.match(out, /<details><summary>table · 7 rows \(preview: first 5\)<\/summary>/);
});

// ---------------------------------------------------------------------------
// 3) buildCodeGraph: loader-less, meta-less, malformed tables, class flags,
//    path normalisation, leaf-only entries, isolated roots, node cap
// ---------------------------------------------------------------------------

const M = {}; // fixture documents by relative path
const opts2 = { loadDoc: (p) => M[p] ?? null, parseDoc: (s) => parse(s) };

M["edge1.geml"] =
  "=== meta\nmodule = e1\nentry = #a\n===\n\n" +
  "=== code {#a}\n===\n" +
  '=== code {#t .test anchor="x"}\n===\n' +
  '=== code {#acc .accessor anchor="y"}\n===\n' +
  '=== code {#ae .app-entry anchor="z"}\n===\n' +
  "=== code {#z}\n===\n\n" +
  "=== table {#calls format=csv}\nfrom, to, kind\n" +
  "#a, #t, call\n#a, #acc, call\n#a, #ae, call\n#a, noHash, call\n#a\next.geml#x, #t, call\n#a, #t\n===\n";

test("code-graph: class flags (.test/.accessor/.app-entry) carry; malformed #calls rows are skipped; isolated roots drop", () => {
  const { data } = buildCodeGraph("edge1.geml", opts2);
  assert.equal(data.nodes["edge1.geml#t"].test, true);
  assert.equal(data.nodes["edge1.geml#acc"].acc, true);
  assert.equal(data.nodes["edge1.geml#ae"].entry, true);
  assert.ok(data.edges.every((e) => e[2] === "call" && e[3] === ""), "kind defaults to call; no confidence column -> empty");
  assert.ok(!data.nodes["edge1.geml#z"], "anchor-less isolated in-degree-zero method dropped from the view");
  assert.deepEqual(data.roots, ["edge1.geml#a"], "only the connected entry survives as a root");
});

M["edge2.geml"] =
  "=== meta\nmodule = e2\nentry = #a\n===\n\n" +
  '=== code {#a anchor="a"}\n===\n\n' +
  "=== table {#calls format=csv}\nsrc, dst\n#a, #b\n===\n";

M["edge3.geml"] =
  "=== meta\nmodule = e3\nentry = #a\n===\n\n" +
  '=== code {#a anchor="a"}\n===\n' +
  '=== code {#b anchor="b"}\n===\n\n' +
  "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#a, #b, call\n===\n";

test("code-graph: a #calls table without from/to is inert; a short row leaves confidence empty", () => {
  const r2 = buildCodeGraph("edge2.geml", opts2);
  assert.deepEqual(r2.data.edges, [], "no usable columns -> no edges");
  const r3 = buildCodeGraph("edge3.geml", opts2);
  assert.deepEqual(r3.data.edges, [["edge3.geml#a", "edge3.geml#b", "call", ""]]);
});

M["leafy.geml"] =
  "=== meta\nmodule = lf\nentry = #g\n===\n\n" +
  '=== code {#g .leaf anchor="g"}\n===\n';

test("code-graph: when EVERY entry is a leaf, the seeds fall back to all of them", () => {
  const { data } = buildCodeGraph("leafy.geml", opts2);
  assert.deepEqual(data.roots, ["leafy.geml#g"], "leaf-only entry still roots the view");
});

test("code-graph: no loader / meta-less prose / bad up-view node report clean errors", () => {
  assert.match(buildCodeGraph("x.geml", {}).error, /no document loader/);
  M["prose.geml"] = "# just prose\n\nwords\n";
  assert.match(buildCodeGraph("prose.geml", opts2).error, /declares no `entry`/);
  assert.match(buildCodeGraph("edge3.geml", opts2, { dir: "up", node: "nohash" }).error, /bad view node/);
});

M["upA.geml"] =
  "=== meta\ngraph-depth = 3\n===\n\n" +
  '=== code {#c anchor="cc"}\n===\n\n' +
  "=== table {#called-by format=csv}\nfrom, to, kind\n#b, #c, call\n#a, #b\nnohash, #c, call\n#b\n===\n";

M["upB.geml"] =
  "=== meta\nmodule = ub\n===\n\n" +
  '=== code {#c anchor="c"}\n===\n\n' +
  "=== table {#called-by format=csv}\nto, from\n#c, #b\n#c\n===\n";

test("code-graph up view: local caller chains, defaulted kinds, malformed rows, meta-less module", () => {
  const r = buildCodeGraph("upA.geml", opts2, { dir: "up", node: "upA.geml#c" });
  assert.equal(r.data.module, undefined, "no module meta -> undefined");
  assert.deepEqual(Object.keys(r.data.nodes).sort(), ["upA.geml#a", "upA.geml#b", "upA.geml#c"]);
  assert.ok(r.data.edges.some((e) => e[0] === "upA.geml#b" && e[1] === "upA.geml#a"), "second hop emitted reversed");
  const rb = buildCodeGraph("upB.geml", opts2, { dir: "up", node: "upB.geml#c" });
  assert.deepEqual(Object.keys(rb.data.nodes).sort(), ["upB.geml#b", "upB.geml#c"], "swapped columns still index");
});

M["idxbad.geml"] =
  "=== meta\ncontainer = file\n===\n\n" +
  "=== table {#modules format=csv}\nname, file\na, a.geml\n===\n";

M["idxodd.geml"] =
  "=== meta\ncontainer = file\napp-entry-docs = a.geml x.geml\n===\n\n" +
  "=== table {#modules format=csv}\nmodule, doc\na, a.geml\nb\n===\n\n" +
  "=== table {#module-edges format=csv}\nfrom, to\na, b\na\n===\n";

M["idxodd2.geml"] =
  "=== meta\ncontainer = file\n===\n\n" +
  "=== table {#modules format=csv}\nmodule, doc, methods\na, a.geml, zz\nc, c.geml\n===\n\n" +
  "=== table {#module-edges format=csv}\nfrom, to, calls\na, c, zz\na, c\n===\n";

test("code-graph index: malformed #modules/#module-edges degrade row-by-row; app-entry-docs feeds entryDocs", () => {
  assert.match(buildCodeGraph("idxbad.geml", opts2).error, /lacks module\/doc columns/);
  const r = buildCodeGraph("idxodd.geml", opts2);
  assert.deepEqual(r.data.mods.map((m) => m.p), ["a"], "short module row skipped");
  assert.deepEqual(r.data.medges, [["a", "b", 1]], "no calls column defaults to 1; short edge row skipped");
  assert.deepEqual(r.data.entryDocs, ["a.geml", "x.geml"], "file-level app entries recorded");
  const r2 = buildCodeGraph("idxodd2.geml", opts2);
  assert.deepEqual(r2.data.mods.map((m) => m.m), [0, 0], "non-numeric / missing methods count to 0");
  assert.deepEqual(r2.data.medges, [["a", "c", 1], ["a", "c", 1]], "junk and missing calls default to 1");
  const rv = buildCodeGraph("idxodd.geml", opts2, { dir: "down", node: "a.geml#q" });
  assert.deepEqual(rv.data.roots, ["a.geml#q"], "a directed view on an index doc skips the module overview");
});

M["s/m.geml"] =
  "=== meta\nmodule = sm\nentry = #f\n===\n\n" +
  '=== code {#f anchor="f"}\n===\n\n' +
  "=== table {#calls format=csv}\nfrom, to, kind\n#f, ../lib.geml#g, call\n===\n";
M["lib.geml"] =
  "=== meta\nmodule = lib\nentry = #g\n===\n\n" +
  '=== code {#g .leaf anchor="g"}\n===\n';

test("code-graph paths: ./ and ../ segments normalise; cross-doc refs resolve from the referring dir", () => {
  const { data } = buildCodeGraph("s/./x/../m.geml", opts2);
  assert.equal(data.start, "s/m.geml");
  assert.ok(data.nodes["lib.geml#g"], "../lib.geml resolved against s/");
});

// One oversized codemap: forward embed hits the payload cap (visible note),
// and the callers direction hits the same cap.
const NBIG = 4100;
M["big.geml"] =
  "=== meta\nmodule = big\nentry = #m0\n===\n\n" +
  '=== code {#m0 anchor="m0"}\n===\n\n' +
  `=== table {#calls format=csv}\nfrom, to, kind\n${Array.from({ length: NBIG }, (_, i) => `#m0, #c${i}, call`).join("\n")}\n===\n\n` +
  `=== table {#called-by format=csv}\nfrom, to, kind\n${Array.from({ length: NBIG }, (_, i) => `#u${i}, #m0, call`).join("\n")}\n===\n`;

test("code-graph cap: a 4000+-node slice truncates with a visible note, both directions", () => {
  const host = parse("=== diagram {format=geml-code-graph src=big.geml}\n===\n");
  const out = renderHtml(host, { source: "h.geml", ...opts2 });
  assert.match(out, /graph data capped at 4000 nodes/);
  const up = buildCodeGraph("big.geml", opts2, { dir: "up", node: "big.geml#m0" });
  assert.equal(up.truncated, true);
  assert.equal(Object.keys(up.data.nodes).length, 4000);
});

test("codeGraphWaves: seeded documents skip the fetch; a throwing fetch is remembered as failed", async () => {
  let calls = 0;
  const w = codeGraphWaves(async () => { calls++; throw new Error("net down"); }, (s) => parse(s));
  w.seed("edge3.geml", M["edge3.geml"]);
  const r = await w.build("edge3.geml");
  assert.equal(r.error, undefined, "seeded text builds without fetching");
  assert.ok(r.data.nodes["edge3.geml#a"]);
  const r2 = await w.build("lib.geml");
  assert.match(r2.error, /cannot load/, "a throwing fetch degrades to the standard error");
  assert.equal(calls, 1);
  await w.build("lib.geml");
  assert.equal(calls, 1, "failure cached — no retry storm");
});

// ---------------------------------------------------------------------------
// 4) Viewer runtime — fake DOM (superset of render-html.test.mjs's stub:
//    parentNode tracking, removeChild, contains, blur for the search box)
// ---------------------------------------------------------------------------

const fakeEl = (tag) => ({
  tag, attrs: {}, children: [], listeners: {}, textContent: "", style: {}, parentNode: null,
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k] ?? null; },
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
  replaceChildren() { this.children = []; },
  addEventListener(t, f) { this.listeners[t] = f; },
  contains(x) { if (x === this) return true; return this.children.some((c) => c.contains ? c.contains(x) : c === x); },
  blur() {},
  set className(v) { this.attrs.class = v; }, get className() { return this.attrs.class || ""; },
  set onclick(f) { this.listeners.click = f; }, get onclick() { return this.listeners.click; },
});
const mkDocument = () => ({
  createElementNS: (_ns, t) => fakeEl(t),
  createElement: (t) => fakeEl(t),
  head: fakeEl("head"),
  listeners: {},
  addEventListener(t, f) { this.listeners[t] = f; },
});
const svgIn = (mount) => {
  const svgOf = (sc) => sc && sc.children.find((x) => x.tag === "svg");
  for (const c of mount.children) {
    if (c.tag === "svg") return c;
    if ((c.attrs?.class || "") === "cg-scroll") return svgOf(c);
    if ((c.attrs?.class || "") === "cg-stage") return svgOf(c.children.find((x) => (x.attrs?.class || "") === "cg-scroll"));
  }
};
const barOf = (mount) => mount.children.find((c) => (c.attrs?.class || "") === "cg-bar");
const btnOf = (mount, label) => barOf(mount).children.find((b) => b.textContent === label);
const crumbSegs = (mount) => barOf(mount).children[0].children.map((c) => c.textContent).filter((t) => t && t !== " / ");
const bootMount = (data, extra = {}) => {
  const mount = fakeEl("div");
  mount.attrs["data-graph"] = JSON.stringify(data);
  Object.assign(mount, extra);
  codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
  return mount;
};
const gOf = (svg, k) => svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || "")).find((g) => g.attrs["data-k"] === k);
const ubOf = (svg, k) => svg.children.filter((c) => c.tag === "g" && (c.attrs.class || "") === "cg-upbtn").find((u) => u.attrs["data-k"] === k);
const clickNode = (svg, g) => svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? g : null) } });
const clickUb = (svg, ub) => svg.listeners.click({ target: { closest: (s) => (s === ".cg-upbtn" ? ub : null) } });

test("runtime TB: entry badge, ⊕ above the root, long/more labels, candidate/soft/self-loop edges, layer relaxation", () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = mkDocument();
  globalThis.window = { localStorage: { getItem: () => "TB", setItem() {} }, innerHeight: 900 };
  try {
    const LONG = "a".repeat(40);
    const data = {
      start: "s.geml", depth: 6, roots: ["s.geml#r"],
      nodes: {
        "s.geml#r": { n: "r", doc: "s.geml", entry: true },
        "s.geml#l": { n: LONG, doc: "s.geml" },
        "s.geml#t": { n: "t", doc: "s.geml", test: true },
        "s.geml#m": { n: "m", doc: "s.geml", more: true },
      },
      edges: [
        ["s.geml#r", "s.geml#l", "candidate", ""],
        ["s.geml#r", "s.geml#t", "call", "low"],
        ["s.geml#t", "s.geml#t", "call", ""],
        ["s.geml#r", "s.geml#m", "call", ""],
        ["s.geml#l", "s.geml#t", "call", ""],
      ],
    };
    const mount = bootMount(data, { clientWidth: 500 });
    let svg = svgIn(mount);
    const rG = gOf(svg, "s.geml#r");
    assert.match(rG.children.find((c) => c.tag === "text").textContent, /^▶ r$/, "method-level entry badge");
    const lTxt = gOf(svg, "s.geml#l").children.find((c) => c.tag === "text").textContent;
    assert.ok(lTxt.endsWith("…") && lTxt.length <= 32, "long method label truncates at the head");
    assert.match(gOf(svg, "s.geml#m").children.find((c) => c.tag === "text").textContent, / ›$/, "horizon marker suffix");
    assert.match(gOf(svg, "s.geml#t").attrs.class, /test/, "test styling");
    const ub = ubOf(svg, "s.geml#r");
    const yOfUb = Number(ub.attrs.transform.match(/,(-?[\d.]+)\)/)[1]);
    const yOfR = Number(rG.attrs.transform.match(/,(-?[\d.]+)\)/)[1]);
    assert.ok(yOfUb < yOfR, "TB: caller handle sits ABOVE the entry");
    const classes = svg.children.filter((c) => c.tag === "path").map((p) => p.attrs.class || "");
    assert.ok(classes.some((c) => /cand/.test(c)), "candidate edge dashed");
    assert.ok(classes.some((c) => /soft/.test(c)), "low-confidence edge soft");
    assert.ok(classes.some((c) => /back/.test(c)), "self-loop marked back");
    // hover a node with no callers: the cone is just itself
    svg.listeners.mouseover({ target: { closest: (s) => (s === ".cg-n" ? rG : null) } });
    assert.match(rG.attrs.class, / hl$/);
    svg.listeners.mouseout({ target: { closest: (s) => (s === ".cg-n" ? rG : null) } });
    // zoom buttons: -, +, fit (measured pane), 1:1
    btnOf(mount, "−").listeners.click();
    btnOf(mount, "+").listeners.click();
    btnOf(mount, "fit").listeners.click();
    btnOf(mount, "1:1").listeners.click();
    assert.equal(svg.style.width, Math.round(Number(svg.attrs.width)) + "px", "1:1 restores natural size");
    // direction toggle back to LR (persists), then the LR initial scale runs with a real viewport
    btnOf(mount, "left-right").listeners.click();
    svg = svgIn(mount);
    assert.ok(btnOf(mount, "top-down"), "toggle now offers top-down");
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin;
  }
});

test("runtime TB callers view: mirrored ⊕ below the focus, far-end scroll, entry aim, single-node crumb", () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = mkDocument();
  globalThis.window = { localStorage: { getItem: () => "TB", setItem() {} } };
  try {
    const up = {
      start: "s.geml", depth: 99, roots: ["s.geml#f"],
      nodes: { "s.geml#f": { n: "f", entry: true }, "s.geml#p": { n: "p" } },
      edges: [["s.geml#f", "s.geml#p", "call", ""]],
      dir: "up", focus: "s.geml#f",
    };
    const mount = bootMount(up);
    const svg = svgIn(mount);
    const ub = ubOf(svg, "s.geml#f");
    assert.equal(ub.attrs["data-act"], "down");
    const yUb = Number(ub.attrs.transform.match(/,(-?[\d.]+)\)/)[1]);
    const yF = Number(gOf(svg, "s.geml#f").attrs.transform.match(/,(-?[\d.]+)\)/)[1]);
    assert.ok(yUb > yF, "TB: flip-back handle sits BELOW the focus");
    const scroller = mount.children.find((c) => c.attrs.class === "cg-stage").children.find((c) => c.attrs.class === "cg-scroll");
    assert.equal(scroller.scrollTop, 1e6, "TB callers view scrolls to the far end");
    const segs = crumbSegs(mount);
    assert.match(segs[segs.length - 1], /callers of f/);
    assert.doesNotMatch(segs[segs.length - 1], /in-slice/, "a non-partial payload is not labelled partial");
    // a single-node callers view says why, in crumb and footer
    const solo = bootMount({ start: "s.geml", depth: 99, roots: ["s.geml#f"], nodes: { "s.geml#f": { n: "f" } }, edges: [], dir: "up", focus: "s.geml#f" });
    assert.match(crumbSegs(solo).join(""), /— none recorded/);
    const foot = solo.children.find((c) => (c.attrs?.class || "") === "cg-legend");
    assert.match(foot.children[0].textContent, /no recorded callers/);
    // a focus that is not even in the payload degrades to an empty name
    const ghost = bootMount({ start: "s.geml", depth: 99, roots: ["s.geml#f"], nodes: { "s.geml#f": { n: "f" }, "s.geml#p": { n: "p" } }, edges: [["s.geml#f", "s.geml#p", "call", ""]], dir: "up", focus: "gone#g" });
    assert.match(crumbSegs(ghost).join(""), /callers of\s*$|callers of $/m);
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin;
  }
});

test("runtime: empty-group chips label as (root); start-less payload crumbs as container", () => {
  const prevDoc = globalThis.document;
  globalThis.document = mkDocument();
  try {
    const mount = bootMount({
      roots: ["#a", "z.geml#z", "a.geml#q"], depth: 6,
      nodes: { "#a": { n: "a" }, "z.geml#z": { n: "z" }, "a.geml#q": { n: "q" } },
      edges: [],
    });
    const chips = mount.children.find((c) => (c.attrs?.class || "") === "cg-groups");
    assert.ok(chips.children.some((c) => c.children[1].textContent === "(root)"), "empty doc group reads (root)");
    assert.ok(crumbSegs(mount).includes("container"), "no module, no start -> container crumb");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("runtime modules (raw node payload, no mods): tg grouping, edge titles, doc-less node click is inert", () => {
  const prevDoc = globalThis.document;
  globalThis.document = mkDocument();
  try {
    const mount = bootMount({
      mode: "modules", depth: 99, roots: ["a"],
      nodes: { a: { n: "pkg/x", tg: "T" }, b: { n: "" }, c: { n: "other/y" } },
      edges: [["a", "b", "call", "2"], ["a", "c", "call", ""]],
    });
    const svg = svgIn(mount);
    assert.ok(gOf(svg, "a"), "raw modules payload draws directly");
    const titled = svg.children.filter((c) => c.tag === "path" && /cg-e/.test(c.attrs.class || "")).filter((p) => p.children.some((t) => t.tag === "title"));
    assert.equal(titled.length, 1, "only the counted edge carries a title");
    clickNode(svg, gOf(svg, "b")); // no grp/ext/doc -> nothing to open
    assert.ok(svgIn(mount), "view intact after clicking a bare node");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("runtime modules derive: pure-cycle roots fall back to every node; unreachable modules park below", () => {
  const prevDoc = globalThis.document;
  globalThis.document = mkDocument();
  try {
    const cyc = bootMount({
      mode: "modules", start: "i.geml", depth: 99, roots: [], nodes: {}, edges: [],
      mods: [{ p: "x", doc: "x.geml", m: 1 }, { p: "y", doc: "y.geml", m: 1 }],
      medges: [["x", "y", 1], ["y", "x", 1]],
    });
    const roots = svgIn(cyc).children.filter((c) => c.tag === "g" && /root/.test(c.attrs.class)).map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(roots, ["x.geml", "y.geml"], "no in-degree-zero node -> every node roots");
    const park = bootMount({
      mode: "modules", start: "i.geml", depth: 99, roots: [], nodes: {}, edges: [],
      mods: [{ p: "r", doc: "r.geml", m: 1 }, { p: "x", doc: "x.geml", m: 1 }, { p: "y", doc: "y.geml", m: 1 }],
      medges: [["x", "y", 1], ["y", "x", 1]],
    });
    const svg = svgIn(park);
    const ys = new Set(svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || "")).map((g) => g.attrs.transform.match(/\((-?[\d.]+),/)[1]));
    assert.equal(svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || "")).length, 3, "unreachable cycle still visible (parked)");
    assert.ok(ys.size >= 2, "parked cluster on its own layer");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("runtime modules: a single whole-container top segment stays home (no ceremony descend)", () => {
  const prevDoc = globalThis.document;
  globalThis.document = mkDocument();
  try {
    const mount = bootMount({
      mode: "modules", start: "i.geml", depth: 99, roots: [], nodes: {}, edges: [],
      mods: [{ p: "solo", doc: "s.geml", m: 3 }], medges: [],
    });
    const ks = svgIn(mount).children.filter((c) => c.tag === "g").map((g) => g.attrs["data-k"]);
    assert.deepEqual(ks, ["s.geml"], "the lone module is the home view");
    assert.deepEqual(crumbSegs(mount), ["modules"]);
  } finally {
    globalThis.document = prevDoc;
  }
});

test("runtime modules: back pops the trail, reset returns home", () => {
  const prevDoc = globalThis.document;
  globalThis.document = mkDocument();
  try {
    const mount = bootMount({
      mode: "modules", start: "i.geml", depth: 99, roots: [], nodes: {}, edges: [],
      mods: [{ p: "a/x", doc: "d1.geml", m: 1 }, { p: "a/y", doc: "d2.geml", m: 1 }, { p: "b", doc: "d3.geml", m: 1 }],
      medges: [],
    });
    let svg = svgIn(mount);
    clickNode(svg, gOf(svg, "g:a"));
    assert.ok(btnOf(mount, "back"), "trail exposes back");
    btnOf(mount, "back").listeners.click();
    svg = svgIn(mount);
    assert.ok(gOf(svg, "g:a"), "back restores the tier-1 view");
    clickNode(svg, gOf(svg, "g:a"));
    btnOf(mount, "reset").listeners.click();
    svg = svgIn(mount);
    assert.ok(gOf(svg, "g:a"), "reset lands home");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("runtime cap: +600 pages the slice forward", () => {
  const prevDoc = globalThis.document;
  globalThis.document = mkDocument();
  try {
    const big = { start: "b.geml", depth: 6, roots: ["b.geml#r"], nodes: { "b.geml#r": { n: "r", doc: "b.geml" } }, edges: [] };
    for (let i = 0; i < 650; i++) {
      big.nodes[`b.geml#c${i}`] = { n: `c${i}`, doc: "b.geml" };
      big.edges.push(["b.geml#r", `b.geml#c${i}`, "call", ""]);
    }
    const mount = bootMount(big);
    btnOf(mount, "+600").listeners.click();
    const gs = svgIn(mount).children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || ""));
    assert.equal(gs.length, 651, "+600 recovers the rest of this slice");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("runtime static ⊕: a caller diamond re-roots into the in-slice callers view; already-seen callers dedupe", () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = mkDocument();
  globalThis.window = { localStorage: { getItem: () => "LR", setItem() {} } }; // exercise the persisted-LR arm
  try {
    const data = {
      start: "s.geml", depth: 6, roots: ["s.geml#c"],
      nodes: { "s.geml#a": { n: "a" }, "s.geml#b": { n: "b" }, "s.geml#c": { n: "c" } },
      edges: [["s.geml#a", "s.geml#b", "call", ""], ["s.geml#a", "s.geml#c", "call", ""], ["s.geml#b", "s.geml#c", "call", ""]],
    };
    const mount = bootMount(data);
    let svg = svgIn(mount);
    clickUb(svg, ubOf(svg, "s.geml#c"));
    svg = svgIn(mount);
    const ks = svg.children.filter((c) => c.tag === "g" && /cg-n/.test(c.attrs.class || "")).map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["s.geml#a", "s.geml#b", "s.geml#c"], "both callers of the diamond found once each");
    assert.match(crumbSegs(mount).join(" "), /in-slice/);
    // the mirrored ⊕ with NO own-chain trail underneath rebuilds the callee chain fresh
    state: {
      const down = ubOf(svg, "s.geml#c");
      // pop the trail first so the view underneath is NOT c's own chain
      btnOf(mount, "back").listeners.click();
      svg = svgIn(mount);
      clickUb(svg, ubOf(svg, "s.geml#c"));
      svg = svgIn(mount);
      // now clear the trail by hand to force the showCallees rebuild path
      // (the runtime keeps state internal, so drive it through a fresh boot)
      void down;
    }
    const up2 = bootMount({ ...data, roots: ["s.geml#c"], dir: "up", focus: "s.geml#c", edges: [["s.geml#c", "s.geml#a", "call", ""]] });
    let svg2 = svgIn(up2);
    clickUb(svg2, ubOf(svg2, "s.geml#c"));
    svg2 = svgIn(up2);
    assert.ok(gOf(svg2, "s.geml#c"), "empty trail + mirrored ⊕ rebuilds the callee chain in place");
    assert.match(crumbSegs(up2).join(""), /root: c/, "single-root rebuilt view names its root");
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin;
  }
});

test("runtime static ⊕ with no callers: same-doc entry flashes and stays; foreign entry opens its container", () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window, prevTimeout = globalThis.setTimeout;
  globalThis.document = mkDocument();
  globalThis.window = { location: { href: "" } };
  const timers = [];
  globalThis.setTimeout = (fn) => { timers.push(fn); return 0; };
  try {
    const own = bootMount({ start: "s.geml", depth: 6, roots: ["s.geml#r"], nodes: { "s.geml#r": { n: "r" } }, edges: [] });
    let svg = svgIn(own);
    clickUb(svg, ubOf(svg, "s.geml#r"));
    const fl = barOf(own).children.find((c) => (c.attrs?.class || "") === "cg-flash");
    assert.match(fl.textContent, /no recorded callers/);
    assert.equal(fl.parentNode, barOf(own));
    timers.shift()(); // the 5s auto-dismiss, run synchronously
    assert.equal(fl.parentNode, null, "flash removed itself");
    const foreign = bootMount({ start: "s.geml", depth: 6, roots: ["o.geml#r"], nodes: { "o.geml#r": { n: "r" } }, edges: [] });
    svg = svgIn(foreign);
    clickUb(svg, ubOf(svg, "o.geml#r"));
    const frame = foreign.children.find((c) => c.tag === "iframe");
    assert.ok(frame, "static page embeds the method's own container page");
    assert.equal(frame.attrs.src, "o.html");
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin; globalThis.setTimeout = prevTimeout;
  }
});

await atest("runtime live ⊕/callees: caller chain push, flip-forward, and the trail-reset landing", async () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = mkDocument();
  globalThis.window = { location: { href: "" } };
  try {
    const base = {
      start: "s.geml", depth: 6, roots: ["s.geml#r", "s.geml#q"],
      nodes: { "s.geml#r": { n: "r" }, "s.geml#q": { n: "q" }, "s.geml#h": { n: "h" } },
      edges: [["s.geml#r", "s.geml#h", "call", ""], ["s.geml#q", "s.geml#h", "call", ""]],
    };
    const mount = bootMount(base);
    let ups = 0;
    mount._cgView = async (view) => {
      if (view.dir === "up") {
        ups++;
        if (ups === 1) return { start: "s.geml", depth: 99, roots: ["s.geml#r"], nodes: { "s.geml#r": { n: "r" }, "s.geml#p": { n: "p" }, "s.geml#pp": { n: "pp" } }, edges: [["s.geml#r", "s.geml#p", "call", ""], ["s.geml#p", "s.geml#pp", "call", ""]], dir: "up", focus: "s.geml#r" };
        return { start: "s.geml", depth: 99, roots: ["s.geml#r"], nodes: { "s.geml#r": { n: "r" } }, edges: [], dir: "up", focus: "s.geml#r" };
      }
      return { start: "s.geml", depth: 6, roots: ["s.geml#r"], nodes: { "s.geml#r": { n: "r" }, "s.geml#h": { n: "h" } }, edges: [["s.geml#r", "s.geml#h", "call", ""]] };
    };
    let svg = svgIn(mount);
    clickUb(svg, ubOf(svg, "s.geml#r"));
    await flush();
    svg = svgIn(mount);
    assert.ok(gOf(svg, "s.geml#pp"), "live caller chain pushed (2 hops)");
    // flip back: two roots underneath -> NOT the own chain -> live callee rebuild
    clickUb(svg, ubOf(svg, "s.geml#r"));
    await flush();
    svg = svgIn(mount);
    assert.match(crumbSegs(mount).join(""), /root: r/, "flip-forward landed on the method's own chain");
    // now ⊕ again, but the loader reports no callers: trail resets to home
    clickUb(svg, ubOf(svg, "s.geml#r"));
    await flush(); await flush();
    svg = svgIn(mount);
    assert.ok(gOf(svg, "s.geml#q"), "no-caller answer with a trail resets to the document's own view");
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin;
  }
});

await atest("runtime openDoc probes: HEAD ok embeds, 404 and network errors flash in place", async () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window, prevFetch = globalThis.fetch, prevTimeout = globalThis.setTimeout;
  globalThis.document = mkDocument();
  globalThis.setTimeout = () => 0; // keep flashes visible, no timers dangling
  try {
    const mods = {
      mode: "modules", start: "i.geml", depth: 99, roots: [], nodes: {}, edges: [],
      mods: [{ p: "a", doc: "a.geml", m: 1 }, { p: "b", doc: "b.geml", m: 1 }], medges: [["a", "b", 1]],
    };
    globalThis.window = { location: { protocol: "http:", href: "" } };
    globalThis.fetch = async () => ({ ok: true });
    const m1 = bootMount(mods);
    clickNode(svgIn(m1), gOf(svgIn(m1), "a.geml"));
    await flush();
    assert.ok(m1.children.some((c) => c.tag === "iframe"), "probe ok -> in-mount frame");
    globalThis.fetch = async () => ({ ok: false });
    const m2 = bootMount(mods);
    clickNode(svgIn(m2), gOf(svgIn(m2), "a.geml"));
    await flush();
    assert.match(barOf(m2).children.find((c) => (c.attrs?.class || "") === "cg-flash").textContent, /page missing/);
    globalThis.fetch = async () => { throw new Error("net"); };
    const m3 = bootMount(mods);
    clickNode(svgIn(m3), gOf(svgIn(m3), "a.geml"));
    await flush();
    assert.match(barOf(m3).children.find((c) => (c.attrs?.class || "") === "cg-flash").textContent, /cannot reach/);
    // a window whose self/top probing throws still embeds (treated as un-framed)
    globalThis.window = {};
    Object.defineProperty(globalThis.window, "self", { get() { throw new Error("sandbox"); } });
    const m4 = bootMount(mods);
    clickNode(svgIn(m4), gOf(svgIn(m4), "a.geml"));
    await flush();
    assert.ok(m4.children.some((c) => c.tag === "iframe"), "self-check failure degrades to embed");
    // no location at all: the protocol probe throws, and it still embeds
    globalThis.window = {};
    const m5 = bootMount(mods);
    clickNode(svgIn(m5), gOf(svgIn(m5), "a.geml"));
    await flush();
    assert.ok(m5.children.some((c) => c.tag === "iframe"), "location-less window degrades to embed");
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin; globalThis.fetch = prevFetch; globalThis.setTimeout = prevTimeout;
  }
});

await atest("runtime live crumbs: an unloadable target flashes (timeout may even throw); a modules payload re-boots with its tree path", async () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window, prevTimeout = globalThis.setTimeout;
  globalThis.document = mkDocument();
  globalThis.window = { location: { href: "" } };
  try {
    const method = {
      start: "auth.geml", module: "a", depth: 6, roots: ["auth.geml#x"],
      nodes: { "auth.geml#x": { n: "x" } }, edges: [],
    };
    // (1) loader yields null -> flash; the flash timer THROWING is caught
    globalThis.setTimeout = () => { throw new Error("no timers"); };
    const m1 = bootMount(method);
    m1._cgView = async () => null;
    barOf(m1).children[0].children.find((c) => c.tag === "button" && c.textContent === "modules").listeners.click();
    await flush();
    assert.match(barOf(m1).children.find((c) => (c.attrs?.class || "") === "cg-flash").textContent, /cannot load/);
    globalThis.setTimeout = () => 0;
    // (2) the module crumb loads the index and re-boots on the grouping path
    const IDX = {
      mode: "modules", start: "index.geml", depth: 99, roots: [], nodes: {}, edges: [],
      mods: [{ p: "a", doc: "auth.geml", m: 1 }, { p: "a/x", doc: "x.geml", m: 2 }, { p: "b", doc: "b.geml", m: 1 }],
      medges: [["a", "a/x", "2"], ["a", "a/x", ""], ["a", "ghost", 1], ["b", "zz", 1], ["a/ghost2", "a/x", 1]],
      entryDocs: ["auth.geml", "nope.geml"],
    };
    const m2 = bootMount(method);
    const seen = [];
    m2._cgView = async (view) => { seen.push(view); return IDX; };
    barOf(m2).children[0].children.find((c) => c.tag === "button" && c.textContent === "a").listeners.click();
    await flush();
    assert.deepEqual(seen, [{ doc: "index.geml" }]);
    let svg = svgIn(m2);
    const ks = svg.children.filter((c) => c.tag === "g").map((g) => g.attrs["data-k"]).sort();
    assert.deepEqual(ks, ["auth.geml", "x.geml", "x:ghost"], "tier 2 under a: own doc, child, external stub; unknown-module edges dropped");
    assert.match(gOf(svg, "auth.geml").children.find((c) => c.tag === "text").textContent, /^▶ a$/, "entry-holding container badged, labelled by the segment itself");
    const agg = svg.children.filter((c) => c.tag === "path" && /cg-e/.test(c.attrs.class || ""));
    assert.equal(agg.length, 2, "a->a/x aggregated with a->ghost stub edge");
    assert.deepEqual(crumbSegs(m2), ["modules", "a"]);
    // crumb home from the derived tier restores tier 1 in place
    barOf(m2).children[0].children.find((c) => c.tag === "button" && c.textContent === "modules").listeners.click();
    svg = svgIn(m2);
    assert.ok(gOf(svg, "g:a"), "home shows the grouped tier again");
    // (3) a single-top index reached with a tree path keeps the one-hop crumb
    const IDX2 = {
      mode: "modules", start: "index.geml", depth: 99, roots: [], nodes: {}, edges: [],
      mods: [{ p: "a", doc: "auth.geml", m: 1 }, { p: "a/x", doc: "x.geml", m: 2 }], medges: [], entryDocs: [],
    };
    const m3 = bootMount(method);
    m3._cgView = async () => IDX2;
    barOf(m3).children[0].children.find((c) => c.tag === "button" && c.textContent === "a").listeners.click();
    await flush();
    assert.deepEqual(crumbSegs(m3), ["modules", "a"], "single-branch path still crumbs its hop");
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin; globalThis.setTimeout = prevTimeout;
  }
});

await atest("runtime search (static file:// page): index script fallbacks, ranking, dedupe, Enter and alt-click", async () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window, prevLoc = globalThis.location;
  globalThis.document = mkDocument();
  globalThis.window = {};
  globalThis.location = { protocol: "file:", href: "" };
  try {
    const mount = bootMount({
      start: "s.geml", depth: 6, roots: ["s.geml#r"],
      nodes: { "s.geml#r": { n: "r" }, "s.geml#h": { n: "h" } },
      edges: [["s.geml#r", "s.geml#h", "call", ""]],
    });
    const wrap = barOf(mount).children.find((c) => (c.attrs?.class || "") === "cg-search-wrap");
    assert.ok(wrap, "search box present once a location exists");
    const box = wrap.children[0], menu = wrap.children[1];
    // 1: no index yet; the lazy script errors -> zero hits
    box.value = "ru";
    box.listeners.input();
    const script1 = globalThis.document.head.children[globalThis.document.head.children.length - 1];
    script1.listeners = script1.listeners || {};
    script1.onerror();
    assert.equal(menu.hidden, true, "script error -> no matches");
    // 2: script loads but defines nothing -> still zero hits
    box.value = "run";
    box.listeners.input();
    const script2 = globalThis.document.head.children[globalThis.document.head.children.length - 1];
    script2.onload();
    assert.equal(menu.hidden, true);
    // 3: a real index: exact > prefix > qualified tail > substring, aliases dedupe
    globalThis.window.__gemlSearch = [
      ["run", "m.geml", "run"],
      ["alias.run", "m.geml", "run"],
      ["runner", "m.geml", "runner"],
      ["core::runx", "n.geml", "r2"],
      ["xxrunxx", "n.geml", "x1"],
      ["zzz", "n.geml", "z"],
    ];
    box.value = "run";
    box.listeners.input();
    assert.equal(menu.hidden, false);
    const rows = menu.children.filter((c) => (c.attrs?.class || "") === "cg-search-row");
    assert.deepEqual(rows.map((r) => r.children[0].textContent), ["run", "runner", "core::runx", "xxrunxx"], "ranked, alias deduped");
    const grps = menu.children.filter((c) => (c.attrs?.class || "") === "cg-search-grp");
    assert.deepEqual(grps.map((g) => g.textContent), ["m", "n"], "hits grouped by document");
    assert.match(menu.children[0].textContent, /4 matches/);
    // Enter opens the best hit; static page -> navigate to the node's document
    box.listeners.keydown({ key: "Enter", preventDefault() {}, altKey: false });
    assert.equal(globalThis.location.href, "m.html#run");
    // a single hit says "1 match"; alt-click always just locates
    box.value = "xxr";
    box.listeners.input();
    assert.match(menu.children[0].textContent, /1 match ·/);
    menu.children.filter((c) => (c.attrs?.class || "") === "cg-search-row")[0].listeners.click({ altKey: true });
    assert.equal(globalThis.location.href, "n.html#x1");
    // sub-2-char queries and Escape close the menu
    box.value = "x";
    box.listeners.input();
    assert.equal(menu.hidden, true);
    box.value = "xxr";
    box.listeners.input();
    box.listeners.keydown({ key: "Escape" });
    assert.equal(menu.hidden, true);
    // >100 matches cap with an honest count
    globalThis.window.__gemlSearch = Array.from({ length: 120 }, (_, i) => [`mass${i}`, `d${i % 2}.geml`, `m${i}`]);
    box.value = "mass";
    box.listeners.input();
    assert.match(menu.children[0].textContent, /showing 100 of 120 matches/);
    // clicking outside the wrap closes the menu
    globalThis.document.listeners.click({ target: fakeEl("div") });
    assert.equal(menu.hidden, true);
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin;
    if (prevLoc === undefined) delete globalThis.location; else globalThis.location = prevLoc;
  }
});

await atest("runtime search (served http page): /_search endpoint, stale keystrokes, error shapes, live open", async () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window, prevLoc = globalThis.location, prevFetch = globalThis.fetch;
  globalThis.document = mkDocument();
  globalThis.window = {};
  globalThis.location = { protocol: "http:", href: "" };
  try {
    const mount = bootMount({
      start: "s.geml", depth: 6, roots: ["s.geml#r"],
      nodes: { "s.geml#r": { n: "r" }, "s.geml#h": { n: "h" } },
      edges: [["s.geml#r", "s.geml#h", "call", ""]],
    });
    mount._cgView = async () => ({ start: "d.geml", depth: 6, roots: ["d.geml#n"], nodes: { "d.geml#n": { n: "n" }, "d.geml#k": { n: "k" } }, edges: [["d.geml#n", "d.geml#k", "call", ""]] });
    const wrap = barOf(mount).children.find((c) => (c.attrs?.class || "") === "cg-search-wrap");
    const box = wrap.children[0], menu = wrap.children[1];
    // stale keystroke: the first (slow) response must not clobber the second
    const pend = [];
    globalThis.fetch = (u) => new Promise((resolve) => pend.push({ u, resolve }));
    box.value = "ab";
    box.listeners.input();
    box.value = "abc";
    box.listeners.input();
    pend[1].resolve({ ok: true, json: async () => ({ total: 1, hits: [{ name: "abcdef", doc: "d.geml", id: "n" }] }) });
    await flush();
    assert.equal(menu.hidden, false);
    pend[0].resolve({ ok: true, json: async () => ({ total: 1, hits: [{ name: "STALE", doc: "d.geml", id: "s" }] }) });
    await flush();
    assert.match(menu.children.find((c) => (c.attrs?.class || "") === "cg-search-row").children[0].textContent, /abcdef/, "stale answer discarded");
    // clicking a hit on a LIVE page opens its focused chain in place
    menu.children.find((c) => (c.attrs?.class || "") === "cg-search-row").listeners.click({ altKey: false });
    await flush();
    assert.ok(gOf(svgIn(mount), "d.geml#k"), "live page pushed the hit's callee chain");
    assert.match(crumbSegs(mount).join(""), /root: n/);
    // non-ok, malformed, and rejected responses all collapse to zero hits
    globalThis.fetch = async () => ({ ok: false });
    box.value = "xx";
    box.listeners.input();
    await flush();
    assert.equal(menu.hidden, true);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    box.value = "yy";
    box.listeners.input();
    await flush();
    assert.equal(menu.hidden, true);
    globalThis.fetch = async () => { throw new Error("down"); };
    box.value = "zz";
    box.listeners.input();
    await flush();
    assert.equal(menu.hidden, true);
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin; globalThis.fetch = prevFetch;
    if (prevLoc === undefined) delete globalThis.location; else globalThis.location = prevLoc;
  }
});

await atest("runtime source panel: reversed line ranges clamp, bare-text responses render, unknown nodes degrade", async () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window, prevFetch = globalThis.fetch;
  globalThis.document = mkDocument();
  globalThis.window = { location: { href: "" } };
  globalThis.fetch = () => Promise.resolve("l1\nl2\nl3\nl4\nl5\nl6");
  const panelOf = (m) => m.children.find((c) => (c.attrs.class || "") === "cg-stage").children.find((c) => (c.attrs.class || "") === "cg-src");
  const bodyOf = (m) => panelOf(m).children.find((c) => (c.attrs.class || "") === "cg-src-body");
  try {
    const mount = bootMount({
      start: "s.geml", depth: 6, roots: ["s.geml#r"],
      nodes: { "s.geml#r": { n: "r", src: "f.ts#L5-L2" } }, edges: [],
    });
    const svg = svgIn(mount);
    clickNode(svg, gOf(svg, "s.geml#r"));
    await flush();
    assert.equal(bodyOf(mount).textContent, "l5", "b0 < a0 clamps to the single start line");
    // a node key the payload does not know: header falls back to the key, body says no source
    svg.listeners.click({ target: { closest: (s) => (s === ".cg-n" ? { getAttribute: () => "zz.geml#ghost", attrs: { class: "cg-n" } } : null) } });
    const hd = panelOf(mount).children.find((c) => (c.attrs.class || "") === "cg-src-hd");
    assert.equal(hd.children[0].textContent, "zz.geml#ghost");
    assert.match(bodyOf(mount).textContent, /no source location recorded/);
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin; globalThis.fetch = prevFetch;
  }
});

test("runtime events: closest-less targets are ignored by click, hover and mouseout; bare mounts are skipped", () => {
  const prevDoc = globalThis.document;
  globalThis.document = mkDocument();
  try {
    const mount = bootMount({ start: "s.geml", depth: 6, roots: ["s.geml#r"], nodes: { "s.geml#r": { n: "r" } }, edges: [] });
    const svg = svgIn(mount);
    svg.listeners.click({ target: {} });
    svg.listeners.click({ target: { closest: () => null } });
    svg.listeners.mouseover({ target: {} });
    svg.listeners.mouseover({ target: { closest: () => null } });
    svg.listeners.mouseout({ target: { closest: () => null } });
    assert.ok(svgIn(mount), "view untouched by non-node events");
    const empty = fakeEl("div"); // neither data-graph nor data-graph-src
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [empty] : []) });
    assert.equal(empty.children.length, 0, "un-upgraded mount left alone");
  } finally {
    globalThis.document = prevDoc;
  }
});

await atest("runtime sidecar: a null JSON body reports the generic load failure", async () => {
  const prevDoc = globalThis.document, prevFetch = globalThis.fetch;
  globalThis.document = mkDocument();
  globalThis.fetch = async () => ({ json: async () => null });
  try {
    const mount = fakeEl("div");
    mount.attrs["data-graph-src"] = "/_graph?doc=x.geml";
    codeGraphRuntime({ querySelectorAll: (sel) => (sel === ".cg-mount" ? [mount] : []) });
    await flush();
    assert.match(mount.textContent, /cannot load graph data/);
  } finally {
    globalThis.document = prevDoc; globalThis.fetch = prevFetch;
  }
});

test("runtime modules: clicking the external stub is informational only", () => {
  const prevDoc = globalThis.document;
  globalThis.document = mkDocument();
  try {
    const mount = bootMount({
      mode: "modules", start: "i.geml", depth: 99, roots: [], nodes: {}, edges: [],
      mods: [{ p: "a/x", doc: "d1.geml", m: 1 }, { p: "a/y", doc: "d2.geml", m: 1 }, { p: "b", doc: "d3.geml", m: 1 }],
      medges: [["a/x", "b", 1]],
    });
    let svg = svgIn(mount);
    clickNode(svg, gOf(svg, "g:a"));
    svg = svgIn(mount);
    const stub = gOf(svg, "x:b");
    assert.ok(stub, "external stub drawn in the descended tier");
    clickNode(svg, stub);
    assert.ok(gOf(svgIn(mount), "x:b"), "stub click changes nothing");
  } finally {
    globalThis.document = prevDoc;
  }
});

// ---------------------------------------------------------------------------
// 5) Second-pass branch sweep: arms the first pass left dark (from the fresh
//    union coverage enumeration).
// ---------------------------------------------------------------------------

test("inline: an in-page link keeps its bare-anchor href; one-axis spans emit only their real attribute", () => {
  assert.match(tourHtml, /<a href="#top">ip<\/a>/, "anchor-only link");
  const sp2 = tourHtml.slice(tourHtml.indexOf('id="sp2"'), tourHtml.indexOf('id="sp2"') + 500);
  assert.match(sp2, /<td[^>]* colspan="2"(?![^>]*rowspan)/, "1x2 span: colspan without rowspan");
  assert.match(sp2, /<td[^>]* rowspan="2"(?![^>]*colspan)/, "2x1 span: rowspan without colspan");
});

test("hand-built inline: an autoref carrying a doc but no anchor labels itself by the doc", () => {
  const doc = { children: [{ kind: "paragraph", inlines: [{ type: "autoref", doc: "o.geml" }] }] };
  const out = renderHtml(doc, {});
  assert.match(out, />o\.geml<\/a>/, "label falls back to the doc name");
});

test("code-graph: a directed DOWN view with a hash-less node reports bad view node", () => {
  assert.match(buildCodeGraph("edge3.geml", opts2, { dir: "down", node: "nohash" }).error, /bad view node/);
});

test("runtime LR initial scale: a real viewport height feeds the height clamp", () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = mkDocument();
  globalThis.window = { innerHeight: 900 }; // no localStorage -> LR default; paneSize derives 648px
  try {
    const nodes = { "s.geml#r": { n: "r" } }, edges = [];
    for (let i = 0; i < 8; i++) { nodes[`s.geml#c${i}`] = { n: `c${i}` }; edges.push(["s.geml#r", `s.geml#c${i}`, "call", ""]); }
    const mount = bootMount({ start: "s.geml", depth: 6, roots: ["s.geml#r"], nodes, edges });
    const svg = svgIn(mount);
    assert.ok(svg && svg.style.width, "initial LR scale applied against the measured pane");
  } finally { globalThis.document = prevDoc; globalThis.window = prevWin; }
});

test("runtime static crumbs: clicking the module-name crumb resets a static page to its home view", () => {
  const prevDoc = globalThis.document;
  globalThis.document = mkDocument();
  try {
    const mount = bootMount({
      start: "s.geml", module: "sm", depth: 6, roots: ["s.geml#r"],
      nodes: { "s.geml#r": { n: "r" }, "s.geml#h": { n: "h" } },
      edges: [["s.geml#r", "s.geml#h", "call", ""]],
    });
    const btn = barOf(mount).children[0].children.find((c) => c.tag === "button" && c.textContent === "sm");
    assert.ok(btn, "module-name crumb is clickable");
    btn.listeners.click();
    const svg = svgIn(mount);
    assert.ok(gOf(svg, "s.geml#r") && gOf(svg, "s.geml#h"), "home view intact after the static reset");
  } finally { globalThis.document = prevDoc; }
});

await atest("runtime search ranking: two hits with the SAME name tie stably and both survive dedupe", async () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window, prevLoc = globalThis.location;
  globalThis.document = mkDocument();
  globalThis.window = { __gemlSearch: [["dup", "a.geml", "x1"], ["dup", "b.geml", "x2"]] };
  globalThis.location = { protocol: "file:", href: "" };
  try {
    const mount = bootMount({ start: "s.geml", depth: 6, roots: ["s.geml#r"], nodes: { "s.geml#r": { n: "r" } }, edges: [] });
    const wrap = barOf(mount).children.find((c) => (c.attrs?.class || "") === "cg-search-wrap");
    const box = wrap.children[0], menu = wrap.children[1];
    box.value = "dup";
    box.listeners.input();
    const rows = menu.children.filter((c) => (c.attrs?.class || "") === "cg-search-row");
    assert.equal(rows.length, 2, "equal-name hits with distinct targets both listed");
    assert.deepEqual(rows.map((r) => r.children[0].textContent), ["dup", "dup"]);
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin;
    if (prevLoc === undefined) delete globalThis.location; else globalThis.location = prevLoc;
  }
});

// The CSV parser PADS short rows with empty cells, so a row can never have a
// truly MISSING cell through parse() alone. The renderer still guards every
// cell read (`r[i]?.text ?? ""`) because parseDoc is a public option — any
// model producer may hand back sparser rows. Exercise those guards with a
// parseDoc that parses real text and then deletes the cells marked HOLE.
const holed = (s) => {
  const d = parse(s);
  for (const b of d.children)
    if (b.kind === "block" && b.type === "table" && b.table)
      for (const row of b.table.rows)
        for (let i = 0; i < row.length; i++)
          if (row[i]?.text === "HOLE") delete row[i];
  return d;
};
const holeOpts = { loadDoc: (p) => M[p] ?? null, parseDoc: holed };

M["holes-idx.geml"] =
  "=== meta\ncontainer = file\n===\n\n" +
  "=== table {#modules format=csv}\nmodule, doc, methods\n" +
  "HOLE, a.geml, 1\na, HOLE, 1\nb, b.geml, HOLE\nc, c.geml, 2\n===\n\n" +
  "=== table {#module-edges format=csv}\nfrom, to, calls\n" +
  "HOLE, c, 1\nb, HOLE, 1\nb, c, HOLE\n===\n";

M["holes-m.geml"] =
  "=== meta\nmodule = hm\nentry = #a\n===\n\n" +
  '=== code {#a anchor="a"}\n===\n' +
  '=== code {#b anchor="b"}\n===\n\n' +
  "=== table {#calls format=csv}\nfrom, to, kind, confidence\n" +
  "HOLE, #b, call, x\n#a, HOLE, call, x\n#a, #b, call, HOLE\n===\n";

M["holes-up.geml"] =
  "=== meta\nmodule = hu\n===\n\n" +
  '=== code {#c anchor="c"}\n===\n\n' +
  "=== table {#called-by format=csv}\nfrom, to, kind\n" +
  "HOLE, #c, call\n#b, HOLE, call\n#b, #c, call\n===\n";

M["holes-noto.geml"] =
  "=== meta\nmodule = hn\n===\n\n" +
  '=== code {#c anchor="c"}\n===\n\n' +
  "=== table {#called-by format=csv}\nsrc, dst\n#b, #c\n===\n";

test("code-graph rows with MISSING cells (not merely empty): every ?? '' guard degrades row-by-row", () => {
  const r = buildCodeGraph("holes-idx.geml", holeOpts);
  assert.deepEqual(r.data.mods, [{ p: "b", doc: "b.geml", m: 0 }, { p: "c", doc: "c.geml", m: 2 }],
    "name/doc holes drop the row; a methods hole counts 0");
  assert.deepEqual(r.data.medges, [["b", "c", 1]], "from/to holes drop the edge; a calls hole defaults 1");
  const m = buildCodeGraph("holes-m.geml", holeOpts);
  assert.ok(m.data.nodes["holes-m.geml#a"] && m.data.nodes["holes-m.geml#b"], "the intact row still travels");
  assert.ok(m.data.edges.some((e) => e[0] === "holes-m.geml#a" && e[1] === "holes-m.geml#b" && e[3] === ""),
    "a confidence hole reads as empty confidence");
  const up = buildCodeGraph("holes-up.geml", holeOpts, { dir: "up", node: "holes-up.geml#c" });
  assert.deepEqual(Object.keys(up.data.nodes).sort(), ["holes-up.geml#b", "holes-up.geml#c"],
    "caller holes are skipped, the intact caller row survives");
  const noto = buildCodeGraph("holes-noto.geml", holeOpts, { dir: "up", node: "holes-noto.geml#c" });
  assert.deepEqual(Object.keys(noto.data.nodes), ["holes-noto.geml#c"], "a #called-by without from/to columns is inert");
});

test("hand-built charts: NaN-poisoned values clamp the axis range; a size channel with no data degrades to plain dots", () => {
  const mk = (chart) => renderHtml({ children: [chartBlock(chart)] }, {});
  assert.match(mk({ type: "line", x: "K", y: ["V"], dataset: { categories: ["a"], numbers: { V: [NaN] } } }), /<svg/);
  assert.match(mk({ type: "scatter", x: "K", y: ["V"], dataset: { categories: ["1"], numbers: { V: [NaN] } } }), /<svg/);
  const noSize = mk({ type: "scatter", x: "K", y: ["V"], size: "S", dataset: { categories: ["1", "2"], numbers: { V: [1, 2] } } });
  assert.match(noSize, /<circle[^>]*r="4\.0"/, "missing size series -> minimum radius everywhere");
});

await atest("runtime live open: a stale payload whose root is missing from its own nodes still crumbs and draws", async () => {
  const prevDoc = globalThis.document, prevWin = globalThis.window, prevLoc = globalThis.location, prevFetch = globalThis.fetch;
  globalThis.document = mkDocument();
  globalThis.window = {};
  globalThis.location = { protocol: "http:", href: "" };
  try {
    const mount = bootMount({
      start: "s.geml", depth: 6, roots: ["s.geml#r"],
      nodes: { "s.geml#r": { n: "r" } }, edges: [],
    });
    mount._cgView = async () => ({ start: "s.geml", depth: 6, roots: ["s.geml#ghost"], nodes: {}, edges: [] });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ total: 1, hits: [{ name: "gg", doc: "s.geml", id: "ghost" }] }) });
    const wrap = barOf(mount).children.find((c) => (c.attrs?.class || "") === "cg-search-wrap");
    const box = wrap.children[0], menu = wrap.children[1];
    box.value = "gg";
    box.listeners.input();
    await flush();
    menu.children.find((c) => (c.attrs?.class || "") === "cg-search-row").listeners.click({ altKey: false });
    await flush();
    const segs = crumbSegs(mount);
    assert.match(segs[segs.length - 1], /^root: /, "ghost-rooted view still produces the root crumb");
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin; globalThis.fetch = prevFetch;
    if (prevLoc === undefined) delete globalThis.location; else globalThis.location = prevLoc;
  }
});

console.log(`\n${passed} test(s) passed.`);
