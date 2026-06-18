// M3 conformance checks: tables (§6) and diagram renderer registry (§7).
// Run with `npm test` (after `npm run build`).
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const table = (src) => parse(src).children[0].table;
const errors = (d) => d.diagnostics.filter((x) => x.severity === "error");

test("visual form: header, alignment, numeric cells (§6a)", () => {
  const t = table("=== table {caption=\"c\"}\n| Plan | N |\n|------|--:|\n| Org | 1 |\n| Adoc | 2 |\n===");
  assert.deepEqual(t.columns, ["Plan", "N"]);
  assert.equal(t.header, true);
  assert.equal(t.align[1], "right");
  assert.equal(t.caption, "c");
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][1].value, 1);
});

test("data form: csv + per-row compute (§6b)", () => {
  const t = table("=== table {format=csv compute=\"Sub = M * R\"}\nName, M, R\nOrg, 1, 30\nAdoc, 2, 30\n===");
  assert.deepEqual(t.columns, ["Name", "M", "R", "Sub"]);
  assert.equal(t.rows[0][3].text, "30");
  assert.equal(t.rows[1][3].value, 60);
  assert.equal(t.rows[1][3].computed, true);
});

test("compute by column letter and aggregate (§6)", () => {
  const t = table("=== table {format=csv compute=\"T = sum(B)\"}\nName, V\na, 10\nb, 20\n===");
  assert.equal(t.rows[0][2].value, 30);
  assert.equal(t.rows[1][2].value, 30);
});

test("compute precedence and parentheses", () => {
  const t = table("=== table {format=csv compute=\"X = (A + B) * 2\"}\nA, B\n1, 2\n===");
  assert.equal(t.rows[0][2].value, 6);
});

test("compute over unknown column is an error", () => {
  const d = parse("=== table {format=csv compute=\"X = nope * 2\"}\nA\n1\n===");
  assert.ok(errors(d).some((e) => /unknown column/.test(e.message)));
});

test("span declaration attaches to target cell (§6)", () => {
  const t = table("=== table {format=csv span=\"r1c1:2x1\"}\nName, V\na, 10\nb, 20\n===");
  assert.deepEqual(t.rows[0][0].span, { rows: 2, cols: 1 });
});

test("headerless visual form uses letter columns", () => {
  const t = table("=== table\n| a | b |\n| c | d |\n===");
  assert.deepEqual(t.columns, ["A", "B"]);
  assert.equal(t.header, false);
});

test("compute: ;-separated formulas, [printf] format, ref to earlier column (§6)", () => {
  const t = table("=== table {format=csv compute=\"FY [%.1f] = Q1 + Q2; Half [%.0f] = FY / 2\"}\nSeg, Q1, Q2\nA, 1.25, 2.25\n===");
  assert.deepEqual(t.columns, ["Seg", "Q1", "Q2", "FY", "Half"]);
  assert.equal(t.rows[0][3].value, 3.5);
  assert.equal(t.rows[0][3].text, "3.5");
  assert.equal(t.rows[0][4].text, "2"); // 1.75 -> %.0f
});

test("compute: quoted column name with spaces (§6)", () => {
  const t = table("=== table {format=csv compute=\"Tot = 'Unit Price' * Qty\"}\nUnit Price, Qty\n3, 4\n===");
  assert.equal(t.rows[0][2].value, 12);
});

test("compute: default rendering drops float noise (§6)", () => {
  const t = table("=== table {format=csv compute=\"S = A + B\"}\nA, B\n0.1, 0.2\n===");
  assert.equal(t.rows[0][2].text, "0.3");
});

test("format: %% renders a literal percent (§6)", () => {
  const t = table("=== table {format=csv compute=\"P [%.1f%%] = Q1\"}\nQ1\n12.34\n===");
  assert.equal(t.rows[0][1].text, "12.3%");
});

test("summary: label + aggregate + arithmetic over aggregates (§6)", () => {
  const t = table("=== table {format=csv compute=\"FY = Q1 + Q2\" summary=\"Seg = 'Total'; Q1 = sum(Q1); FY = sum(FY) - sum(Q1)\"}\nSeg, Q1, Q2\nA, 1, 2\nB, 3, 4\n===");
  assert.equal(t.summary[0].text, "Total");
  assert.equal(t.summary[1].value, 4);  // sum(Q1)=1+3
  assert.equal(t.summary[3].value, 6);  // sum(FY)=3+7 minus sum(Q1)=4 -> 6
});

test("summary: a bare (non-aggregated) column reference is an error (§6)", () => {
  const d = parse("=== table {format=csv compute=\"FY = Q1 + Q2\" summary=\"FY = FY\"}\nSeg, Q1, Q2\nA, 1, 2\n===");
  assert.ok(errors(d).some((e) => /aggregate/.test(e.message)));
});

test("unknown diagram format warns, known one is clean (§7)", () => {
  assert.ok(parse("=== diagram {format=bogus}\nx\n===").diagnostics.some((x) => x.severity === "warning"));
  assert.equal(parse("=== diagram {format=mermaid}\ngraph LR\n===").diagnostics.length, 0);
});

console.log(`\n${passed} test(s) passed.`);
