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
  '=== table {#t format=csv header=1 compute="Tot [%.0f] = A + B" summary="A = sum(A); B = sum(B); Tot [%.0f] = sum(Tot)"}',
  "Name, A, B",
  "Row1, 1, 2",
  "Row2, 3, 4",
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

console.log(`\n${passed} test(s) passed.`);
