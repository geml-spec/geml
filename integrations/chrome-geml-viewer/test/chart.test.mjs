// geml-chart SVG rendering (src/chart.js). The render suite only exercised the
// default BAR path, leaving every other chart type — line, area, pie, scatter —
// plus the legend and the long-form `series=` reshape uncovered. Charts are the
// one place the viewer builds geometry from document-supplied numbers, so each
// type gets a shape assertion (and the degenerate inputs must not throw).
//
// Pure: parse() from the reference parser + linkedom for a document, exactly
// like render.test.mjs. No KaTeX/Mermaid/network.
import { parse } from "../../../geml-parser/dist/geml.js";
import { renderDocument } from "../src/render.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function render(src) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  return renderDocument(parse(src), document);
}

// One wide table; each chart below binds to it with a different `type`.
const DATA = `=== table {#fy format=csv header=1}
Segment, Q1, Q2, Size
Cloud, 10, 20, 5
Hardware, 30, 40, 9
Edge, 19, 23, 2
===
`;
const chart = (attrs) => `${DATA}\n=== diagram {#c format=geml-chart data=#fy ${attrs}}\n===\n`;

// A chart that failed to draw emits the "chart could not be drawn" text via
// renderChart's catch; assert we never land there.
function svgOf(root) {
  const svg = root.querySelector(".geml-chart svg");
  assert.ok(svg, "chart rendered an <svg>");
  assert.doesNotMatch(svg.textContent || "", /could not be drawn/, "chart drew without throwing");
  return svg;
}

test("chart line: one stroked path per series, a marker per point, plus axes", () => {
  const svg = svgOf(render(chart("type=line x=Segment y=Q1,Q2")));
  const paths = [...svg.querySelectorAll("path")];
  assert.equal(paths.length, 2, "one path per series (Q1, Q2)");
  // A line path is stroked, not filled, and carries one L-command per extra point.
  assert.equal(paths[0].getAttribute("fill"), "none", "line path is stroked, not filled");
  assert.equal((paths[0].getAttribute("d").match(/L/g) || []).length, 2, "3 categories → M + 2 L commands");
  assert.equal(svg.querySelectorAll("circle").length, 6, "a point marker per (series, category)");
  assert.ok(svg.querySelectorAll("line").length > 0, "axes drawn");
});

test("chart area: adds a filled path under the stroked line", () => {
  const svg = svgOf(render(chart("type=area x=Segment y=Q1")));
  const paths = [...svg.querySelectorAll("path")];
  assert.equal(paths.length, 2, "one filled area + one stroked line for the single series");
  const fills = paths.map((p) => p.getAttribute("fill"));
  assert.ok(fills.includes("none"), "the line itself is stroked (fill=none)");
  assert.ok(fills.some((f) => f && f !== "none"), "the area under it is filled with a colour");
  // The area path closes back to the baseline.
  const areaD = paths.find((p) => p.getAttribute("fill") !== "none").getAttribute("d");
  assert.match(areaD, /Z$/, "area path is closed");
});

test("chart pie: one wedge path per category, and the legend names the categories", () => {
  const root = render(chart("type=pie x=Segment y=Q1"));
  const svg = svgOf(root);
  assert.equal(svg.querySelectorAll("path").length, 3, "one wedge per category");
  const legend = root.querySelector(".geml-chart")?.textContent || "";
  for (const cat of ["Cloud", "Hardware", "Edge"]) {
    assert.ok(legend.includes(cat), `legend lists ${cat}`);
  }
});

test("chart scatter: a circle per numeric x, sized by `size=` when given", () => {
  const svg = svgOf(render(chart("type=scatter x=Q1 y=Q2 size=Size")));
  const circles = [...svg.querySelectorAll("circle")];
  assert.equal(circles.length, 3, "one point per row");
  const radii = circles.map((c) => parseFloat(c.getAttribute("r")));
  assert.ok(radii.every((r) => r > 0), "every radius is positive");
  assert.ok(new Set(radii).size > 1, "`size=` varies the radius (not all equal)");
});

test("chart scatter without size=: uniform radius, still one circle per row", () => {
  const svg = svgOf(render(chart("type=scatter x=Q1 y=Q2")));
  const radii = [...svg.querySelectorAll("circle")].map((c) => c.getAttribute("r"));
  assert.equal(radii.length, 3);
  assert.equal(new Set(radii).size, 1, "no size column → one uniform radius");
});

test("chart legend: multi-series bar names each series; single-series adds no legend", () => {
  const multi = render(chart("type=bar x=Segment y=Q1,Q2"));
  const single = render(chart("type=bar x=Segment y=Q1"));
  const txt = (r) => (r.querySelector(".geml-chart")?.textContent || "");
  assert.ok(txt(multi).includes("Q1") && txt(multi).includes("Q2"), "both series named in the legend");
  assert.equal(svgOf(multi).querySelectorAll("rect").length, 6, "2 series x 3 categories = 6 bars");
  // Only the multi-series chart appends the legend div after the svg.
  assert.ok(multi.querySelector(".geml-chart").children.length > 1, "legend appended alongside the svg");
  assert.equal(single.querySelector(".geml-chart").children.length, 1, "single series: svg only, no legend");
});

// Long-form input: one row per (category, series) with `series=` naming the
// column to pivot on — the tabulate() branch that builds seriesOf/uniq/get.
test("chart series=: long-form rows are pivoted into one line per series value", () => {
  const long = `=== table {#lg format=csv header=1}
Month, Kind, V
Jan, a, 1
Jan, b, 4
Feb, a, 2
Feb, b, 5
===

=== diagram {#c2 format=geml-chart data=#lg type=line x=Month y=V series=Kind}
===
`;
  const root = render(long);
  const svg = svgOf(root);
  assert.equal(svg.querySelectorAll("path").length, 2, "one line path per distinct series value (a, b)");
  const txt = root.querySelector(".geml-chart")?.textContent || "";
  assert.ok(txt.includes("a") && txt.includes("b"), "legend lists the pivoted series values");
});

// Degenerate data must take the same paths without throwing (renderChart's
// catch would otherwise swallow a real bug into "could not be drawn").
test("chart: degenerate data (single row, flat values, non-numeric x) never throws", () => {
  const one = `=== table {#o format=csv header=1}\nK, V\nonly, 7\n===\n\n=== diagram {#c3 format=geml-chart data=#o type=line x=K y=V}\n===\n`;
  svgOf(render(one));
  const flat = `=== table {#f2 format=csv header=1}\nK, V\na, 5\nb, 5\n===\n\n=== diagram {#c4 format=geml-chart data=#f2 type=area x=K y=V}\n===\n`;
  svgOf(render(flat));
  // scatter with a NON-numeric x column: points are skipped, axes still drawn.
  const nonNum = `=== table {#f3 format=csv header=1}\nK, V\na, 5\nb, 6\n===\n\n=== diagram {#c5 format=geml-chart data=#f3 type=scatter x=K y=V}\n===\n`;
  const svg = svgOf(render(nonNum));
  assert.equal(svg.querySelectorAll("circle").length, 0, "non-numeric x yields no plotted points");
});

console.log(`\n${passed} test(s) passed.`);
