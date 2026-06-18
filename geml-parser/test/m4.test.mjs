// M4 conformance checks: chart-from-table (§7 geml-chart).
import { parse } from "../dist/geml.js";
import { buildChart } from "../dist/chart.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const errs = (ds) => ds.filter((d) => d.severity === "error");
const warns = (ds) => ds.filter((d) => d.severity === "warning");

// Build a TableModel from source for unit-testing buildChart in isolation.
const tableOf = (src) => parse(src).children.find((b) => b.table).table;
const FY = tableOf(
  "=== table {#fy format=csv header=1 compute=\"FY = Q1 + Q2\" summary=\"Segment = 'Total'; Q1 = sum(Q1); FY = sum(FY)\"}\n" +
  "Segment, Q1, Q2\nCloud, 10, 20\nHardware, 30, 40\n===");

test("buildChart: bar, single y, data rows (happy path)", () => {
  const r = buildChart({ data: "#fy", type: "bar", x: "Segment", y: "FY" }, FY);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.equal(r.model.type, "bar");
  assert.deepEqual(r.model.y, ["FY"]);
  assert.equal(r.model.rows, "data");
  assert.deepEqual(r.model.dataset.categories, ["Cloud", "Hardware"]);
  assert.deepEqual(r.model.dataset.numbers.FY, [30, 70]); // 10+20, 30+40
});

test("buildChart: wide-form multi-y becomes multiple series", () => {
  const r = buildChart({ data: "#fy", type: "line", x: "Segment", y: "Q1,Q2" }, FY);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.deepEqual(r.model.y, ["Q1", "Q2"]);
  assert.deepEqual(r.model.dataset.numbers.Q1, [10, 30]);
  assert.deepEqual(r.model.dataset.numbers.Q2, [20, 40]);
});

test("buildChart: missing type / x / y are errors", () => {
  assert.ok(errs(buildChart({ data: "#fy", x: "Segment", y: "FY" }, FY).diagnostics).some((e) => /missing `type`/.test(e.message)));
  assert.ok(errs(buildChart({ data: "#fy", type: "bar", y: "FY" }, FY).diagnostics).some((e) => /`x`/.test(e.message)));
  assert.ok(errs(buildChart({ data: "#fy", type: "bar", x: "Segment" }, FY).diagnostics).some((e) => /`y`/.test(e.message)));
});

test("buildChart: unknown type is an error mentioning vega-lite", () => {
  const r = buildChart({ data: "#fy", type: "heatmap", x: "Segment", y: "FY" }, FY);
  assert.ok(errs(r.diagnostics).some((e) => /unknown type/.test(e.message) && /vega-lite/.test(e.message)));
  assert.equal(r.model, null);
});

test("buildChart: missing column is an error", () => {
  const r = buildChart({ data: "#fy", type: "bar", x: "Segmnt", y: "FY" }, FY);
  assert.ok(errs(r.diagnostics).some((e) => /column `Segmnt` not found/.test(e.message)));
  assert.equal(r.model, null);
});

test("buildChart: rows=summary plots only the summary row", () => {
  const r = buildChart({ data: "#fy", type: "bar", rows: "summary", x: "Segment", y: "FY" }, FY);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.deepEqual(r.model.dataset.categories, ["Total"]);
  assert.deepEqual(r.model.dataset.numbers.FY, [100]); // sum(FY)=30+70
});

test("buildChart: rows=all appends the summary row as a point", () => {
  const r = buildChart({ data: "#fy", type: "bar", rows: "all", x: "Segment", y: "FY" }, FY);
  assert.deepEqual(r.model.dataset.categories, ["Cloud", "Hardware", "Total"]);
  assert.deepEqual(r.model.dataset.numbers.FY, [30, 70, 100]);
});

test("buildChart: rows=summary without a summary row is an error", () => {
  const noSum = tableOf("=== table {#t format=csv header=1}\nSeg, V\na, 1\n===");
  const r = buildChart({ data: "#t", type: "bar", rows: "summary", x: "Seg", y: "V" }, noSum);
  assert.ok(errs(r.diagnostics).some((e) => /no summary row/.test(e.message)));
  assert.equal(r.model, null);
});

test("buildChart: pie with multiple y warns and uses the first", () => {
  const r = buildChart({ data: "#fy", type: "pie", x: "Segment", y: "Q1,Q2" }, FY);
  assert.ok(warns(r.diagnostics).some((w) => /pie uses a single/.test(w.message)));
  assert.deepEqual(r.model.y, ["Q1"]);
});

test("buildChart: non-numeric y cell is an error", () => {
  const txt = tableOf("=== table {#t format=csv header=1}\nSeg, V\na, oops\n===");
  const r = buildChart({ data: "#t", type: "bar", x: "Seg", y: "V" }, txt);
  assert.ok(errs(r.diagnostics).some((e) => /non-numeric/.test(e.message)));
  assert.equal(r.model, null);
});

test("buildChart: a row mixing empty and non-numeric y cells still errors", () => {
  const t = tableOf("=== table {#m format=csv header=1}\nSeg, A, B\nx, , oops\n===");
  const r = buildChart({ data: "#m", type: "bar", x: "Seg", y: "A,B" }, t);
  assert.ok(errs(r.diagnostics).some((e) => /non-numeric/.test(e.message)));
  assert.equal(r.model, null);
});

test("buildChart: rows=all without a summary row warns and uses data rows", () => {
  const noSum = tableOf("=== table {#n format=csv header=1}\nSeg, V\na, 1\nb, 2\n===");
  const r = buildChart({ data: "#n", type: "bar", rows: "all", x: "Seg", y: "V" }, noSum);
  assert.ok(warns(r.diagnostics).some((w) => /no summary row/.test(w.message)));
  assert.deepEqual(r.model.dataset.categories, ["a", "b"]);
});

test("buildChart: series (long-form) is validated and captured", () => {
  const long = tableOf("=== table {#l format=csv header=1}\nQuarter, Dept, Rev\nQ1, Cloud, 10\nQ1, HW, 5\n===");
  const r = buildChart({ data: "#l", type: "bar", x: "Quarter", y: "Rev", series: "Dept" }, long);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.equal(r.model.series, "Dept");
  assert.deepEqual(r.model.dataset.seriesOf, ["Cloud", "HW"]);
  assert.deepEqual(r.model.dataset.numbers.Rev, [10, 5]);
});

test("buildChart: scatter size is validated and captured as numbers", () => {
  const pts = tableOf("=== table {#p format=csv header=1}\nName, X, Y, W\na, 1, 2, 9\nb, 3, 4, 8\n===");
  const r = buildChart({ data: "#p", type: "scatter", x: "X", y: "Y", size: "W" }, pts);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.equal(r.model.size, "W");
  assert.deepEqual(r.model.dataset.numbers.W, [9, 8]);
});

test("buildChart: missing series/size column is an error", () => {
  const r = buildChart({ data: "#fy", type: "bar", x: "Segment", y: "FY", series: "Nope" }, FY);
  assert.ok(errs(r.diagnostics).some((e) => /column `Nope` not found/.test(e.message)));
  assert.equal(r.model, null);
});

// --- integration through parse() ---
const DOC =
  "=== table {#fy format=csv header=1 compute=\"FY = Q1 + Q2\"}\n" +
  "Segment, Q1, Q2\nCloud, 10, 20\nHardware, 30, 40\n===\n\n" +
  "=== diagram {#c format=geml-chart data=#fy type=bar x=Segment y=FY}\n===\n";

test("parse: geml-chart attaches a chart model and is clean", () => {
  const d = parse(DOC);
  assert.equal(errs(d.diagnostics).length, 0);
  assert.equal(warns(d.diagnostics).length, 0);
  const chart = d.children.find((b) => b.type === "diagram" && b.chart).chart;
  assert.equal(chart.type, "bar");
  assert.deepEqual(chart.dataset.categories, ["Cloud", "Hardware"]);
});

test("parse: forward reference resolves (chart before table)", () => {
  const d = parse(
    "=== diagram {#c format=geml-chart data=#fy type=bar x=Segment y=FY}\n===\n\n" +
    "=== table {#fy format=csv header=1}\nSegment, FY\nCloud, 5\n===\n");
  assert.equal(errs(d.diagnostics).length, 0);
});

test("parse: dangling data=#id is an error", () => {
  const d = parse("=== diagram {#c format=geml-chart data=#nope type=bar x=a y=b}\n===\n");
  assert.ok(errs(d.diagnostics).some((e) => /unresolved|not found|cannot resolve|`nope`/.test(e.message)));
});

test("parse: data=#id pointing at a non-table is an error", () => {
  const d = parse(
    "=== note {#n}\nhi\n===\n\n" +
    "=== diagram {#c format=geml-chart data=#n type=bar x=a y=b}\n===\n");
  assert.ok(errs(d.diagnostics).some((e) => /not a table|must be a table/.test(e.message)));
});

test("parse: geml-chart with a body warns", () => {
  const d = parse(
    "=== table {#fy format=csv header=1}\nSegment, FY\nCloud, 5\n===\n\n" +
    "=== diagram {#c format=geml-chart data=#fy type=bar x=Segment y=FY}\nstray body\n===\n");
  assert.ok(warns(d.diagnostics).some((w) => /body/.test(w.message)));
});

test("parse: geml-chart does not trigger the unknown-renderer warning", () => {
  const d = parse(DOC);
  assert.ok(!d.diagnostics.some((x) => /no registered renderer/.test(x.message)));
});

test("parse: duplicate table id keeps the first table for chart resolution", () => {
  const d = parse(
    "=== table {#fy format=csv header=1}\nSegment, FY\nFirst, 1\n===\n\n" +
    "=== table {#fy format=csv header=1}\nSegment, FY\nSecond, 2\n===\n\n" +
    "=== diagram {#c format=geml-chart data=#fy type=bar x=Segment y=FY}\n===\n");
  const chart = d.children.find((b) => b.type === "diagram" && b.chart).chart;
  assert.deepEqual(chart.dataset.categories, ["First"]);
});

console.log(`\n${passed} test(s) passed.`);
