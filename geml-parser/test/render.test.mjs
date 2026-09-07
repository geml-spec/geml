// P0 runtime: GEML document -> one self-contained, interactive HTML artifact.
// Run with `npm test` (after `tsc`).
import { parse, renderHtml } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

// A document that exercises tables (computed column + summary), a chart bound to
// that table, a hidden block, a callout, and a heading id.
const RICH = [
  "=== meta",
  'title = "Render test"',
  "===",
  "",
  "# Title {#top}",
  "",
  "=== note {.warning}",
  "Heads up: *emphasis* and `code`.",
  "===",
  "",
  // GEP-0012: the facts are the table, the computed column and the report row
  // are the view over it, and the chart below binds to the view.
  "=== table {#facts format=csv header=1}",
  "Name, A, B",
  "Row1, 1, 2",
  "Row2, 3, 4",
  "===",
  "",
  '=== view {#t src=#facts compute="Tot [%.0f] = A + B" summary="A = sum(A); B = sum(B); Tot [%.0f] = sum(Tot)"}',
  "===",
  "",
  "=== diagram {#c format=geml-chart data=#t type=bar x=Name y=Tot}",
  "===",
  "",
  "=== table {#hid hidden format=csv header=1}",
  "X, Y",
  "1, 2",
  "===",
].join("\n");

test("renders a full self-contained HTML document", () => {
  const html = renderHtml(parse(RICH), { source: "test.geml" });
  assert.ok(html.startsWith("<!doctype html>"), "has doctype");
  assert.ok(html.includes("<title>Render test</title>"), "title from meta");
  assert.ok(html.includes('<style>'), "inlines CSS");
  assert.ok(html.includes('id="top"'), "heading id");
  assert.ok(html.includes("by the GEML runtime"), "footer");
});

test("table: computed column, summary row, sortable + filterable", () => {
  const html = renderHtml(parse(RICH));
  assert.ok(html.includes('class="geml-table"'), "table");
  assert.ok(html.includes('class="table-filter"'), "filter box");
  assert.ok(html.includes('class="computed"'), "computed cell");
  assert.ok(html.includes("<tfoot>"), "summary row");
  assert.ok(html.includes('data-sort="3"'), "computed Tot for Row1 = 1+2");
  assert.ok(html.includes('data-sort="10"'), "summary Tot = sum = 10");
});

test("chart bound to a table renders inline SVG (no dependency)", () => {
  const html = renderHtml(parse(RICH));
  assert.ok(html.includes('<svg viewBox="0 0 760 380" class="geml-chart"'), "svg chart");
  assert.ok(/<rect [^>]*fill="#2563eb"/.test(html), "a bar is drawn");
});

test("a `{hidden}` block is in the model but not rendered", () => {
  const doc = parse(RICH);
  assert.ok(doc.ids.includes("hid"), "hidden table id still registered");
  const html = renderHtml(doc);
  // The hidden table's only unique header is `X, Y`; it must not appear.
  assert.ok(!html.includes("<th>X</th>"), "hidden block not rendered");
});

test("self-contained: a prose+table+chart doc pulls zero network", () => {
  const html = renderHtml(parse(RICH));
  assert.ok(!html.includes("https://"), "no external resource without math/mermaid");
  assert.ok(!html.includes("katex"), "no KaTeX when there is no math");
  assert.ok(!html.includes("mermaid"), "no Mermaid when there is no diagram DSL");
});

test("math and mermaid pull their CDN engine only when used", () => {
  const math = renderHtml(parse("text with $x^2$ inline math"));
  assert.ok(math.includes("katex"), "KaTeX loaded when math present");
  const mer = renderHtml(parse("=== diagram {format=mermaid}\ngraph LR\nA-->B\n==="));
  assert.ok(mer.includes("mermaid@11"), "Mermaid loaded when used");
  assert.ok(mer.includes('<pre class="mermaid">'), "mermaid body emitted");
});

test("render is deterministic", () => {
  assert.equal(renderHtml(parse(RICH)), renderHtml(parse(RICH)));
});

test("inline: emphasis, code, link, autoref resolve", () => {
  const html = renderHtml(parse([
    "# Budget {#b}",
    "See [[#b]] and [docs](https://example.com) with *em* and `x`.",
  ].join("\n")));
  assert.ok(html.includes("<em>em</em>"), "emphasis");
  assert.ok(html.includes('href="https://example.com"'), "external link");
  assert.ok(html.includes('href="#b">Budget</a>'), "autoref label from heading");
});

// -- author classes reach the markup, for EVERY typed block --------------------

const frag = (src) => renderHtml(parse(src), { fragment: true });

test("every typed block carries its author classes on its outermost element", () => {
  // §4 puts `{.class}` on any block, and the renderer honoured it on two types
  // out of the registry. Without a class hook a stylesheet can only address a
  // block by `#id` — one CSS rule per block, and no reuse at all.
  const html = frag([
    "=== text {#t .pane}\nprose\n===",
    "=== note {#n .warn}\nheads up\n===",
    "=== code {#c .pane lang=sh}\nls\n===",
    "=== table {#tb .decision}\n| a |\n|---|\n| 1 |\n===",
    "=== math {#m .big}\nx^2\n===",
    "=== diagram {#d .wide format=mermaid}\ngraph TD\nA-->B\n===",
    '=== data {#j .cfg format=json}\n{"a":1}\n===',
  ].join("\n\n"));
  for (const [needle, why] of [
    ['<div class="text pane" id="t"', "text"],
    ['<aside class="callout note warn" id="n"', "note"],
    ['<pre id="c" class="pane"', "code"],
    ['<figure class="table-figure decision" id="tb"', "table"],
    ['<div class="math-block big" id="m"', "math"],
    ['<figure id="d" class="wide"', "diagram"],
    ['<figure id="j" class="cfg"', "data"],
  ]) {
    assert.ok(html.includes(needle), `${why}: expected ${needle}\n${html}`);
  }
});

test("a block that declares no class renders exactly as it did — no empty attribute", () => {
  const html = frag("=== code {#c lang=sh}\nls\n===\n\n=== math {#m}\nx\n===\n");
  assert.ok(html.includes('<pre id="c">'), html);
  assert.ok(html.includes('<div class="math-block" id="m">'), html);
  assert.ok(!html.includes('class=""'), "no empty class attribute anywhere");
});

test("an author cannot wear the renderer's own chrome, on any type", () => {
  // The filter existed for `note`/`text`; opening the other types exposed the
  // rest of the renderer's class names, so they are reserved too — otherwise a
  // plain table could dress itself as the build-error box.
  const html = frag([
    "=== code {#a .table-figure}\nx\n===",
    "=== code {#b .render-error}\nx\n===",
    "=== code {#c2 .mermaid}\nx\n===",
    "=== table {#d2 .geml-table}\n| a |\n|---|\n| 1 |\n===",
    "=== math {#e .math-block}\nx\n===",
  ].join("\n\n"));
  assert.ok(html.includes('<pre id="a">'), "table-figure dropped");
  assert.ok(html.includes('<pre id="b">'), "render-error dropped");
  assert.ok(html.includes('<pre id="c2">'), "mermaid dropped");
  assert.ok(html.includes('<figure class="table-figure" id="d2"'), "geml-table dropped");
  assert.ok(html.includes('<div class="math-block" id="e"'), "math-block not doubled");
});

console.log(`\n${passed} test(s) passed.`);
