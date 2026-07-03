// CLI HTML renderer (render.ts) tests: exercise the self-contained output —
// every chart type drawn as inline SVG (incl. negative values and a size
// channel), the diagram fallbacks, output/code/math blocks, tables, notes,
// lists, and inline constructs. This is the path `geml render` uses.
import { parse, renderHtml } from "../dist/geml.js";
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
    '=== code {#getUser src=src/db.ts#L1-9 anchor="d1"}\n===\n',
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
