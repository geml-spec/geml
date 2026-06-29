// Tests for render-time src= table inlining (§6). Pure: fetch/URL are injected,
// so no browser is needed. Verifies that inlined data flows through a normal
// parse — data, compute, and chart resolution all work on it.
import { parse } from "../../geml-parser/dist/geml.js";
import { hasSrcTable, inlineSrcTables, looksTabular } from "../src/inline-src.js";
import { strict as assert } from "node:assert";

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

await test("hasSrcTable detects a src table, ignores inline ones", () => {
  assert.equal(hasSrcTable('=== table {#t format=csv src="d.csv"}\n===\n'), true);
  assert.equal(hasSrcTable('=== table {#t format=csv}\nA\n1\n===\n'), false);
});

await test("inlineSrcTables fetches, inlines, and parses with data + compute", async () => {
  const raw = '# Doc\n\n=== table {#fy format=csv compute="S = A + B" src="d.csv"}\n===\n';
  const out = await inlineSrcTables(raw, (s) => s, async () => "A, B\n1, 2\n3, 4\n");
  const t = parse(out).children.find((b) => b.table).table;
  assert.equal(t.src, undefined);          // inlined → no longer external
  assert.deepEqual(t.columns, ["A", "B", "S"]);
  assert.equal(t.rows[0][2].value, 3);     // S = 1 + 2
  assert.equal(t.rows[1][2].value, 7);     // S = 3 + 4
});

await test("inlineSrcTables keeps the block when fetch returns null", async () => {
  const out = await inlineSrcTables('=== table {#fy format=csv src="d.csv"}\n===\n', (s) => s, async () => null);
  const t = parse(out).children.find((b) => b.table).table;
  assert.equal(t.src, "d.csv");            // still external → renderer placeholder
});

await test("inlined src table feeds a geml-chart (column check happens now)", async () => {
  const raw = '=== table {#fy format=csv src="d.csv"}\n===\n\n=== diagram {#c format=geml-chart data=#fy type=bar x=Seg y=V}\n===\n';
  const out = await inlineSrcTables(raw, (s) => s, async () => "Seg, V\nA, 5\nB, 9\n");
  const chart = parse(out).children.find((b) => b.type === "diagram").chart;
  assert.ok(chart);                        // resolved now that data is inline
  assert.deepEqual(chart.dataset.categories, ["A", "B"]);
});

await test("inlined src table with a bad compute column surfaces an error (render-time check)", async () => {
  const raw = '=== table {#fy format=csv compute="X = Nope * 2" src="d.csv"}\n===\n';
  const out = await inlineSrcTables(raw, (s) => s, async () => "A, B\n1, 2\n");
  const errs = parse(out).diagnostics.filter((d) => d.severity === "error");
  assert.ok(errs.some((e) => /unknown column `Nope`/.test(e.message)));
});

await test("looksTabular rejects HTML/JSON error bodies, accepts CSV and plain text", () => {
  assert.equal(looksTabular("Seg, V\nA, 1\n"), true);
  assert.equal(looksTabular("  <html><body>500</body></html>"), false);
  assert.equal(looksTabular('{"error":"boom"}'), false);
  assert.equal(looksTabular("[1, 2, 3]"), false);
  assert.equal(looksTabular(""), false);
  assert.equal(looksTabular("Internal Server Error"), true); // plain text — not caught (B edge)
});

console.log(`\n${passed} test(s) passed.`);
