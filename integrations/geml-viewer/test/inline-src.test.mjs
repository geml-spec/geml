// Tests for render-time src= table inlining (§6). Pure: fetch/URL are injected,
// so no browser is needed. Verifies that inlined data flows through a normal
// parse — data, compute, and chart resolution all work on it.
import { parse } from "../../../geml-parser/dist/geml.js";
import { hasSrcTable, inlineSrcTables, looksTabular } from "../src/inline-src.js";
import { strict as assert } from "node:assert";

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

await test("hasSrcTable detects a src table, ignores inline ones", () => {
  assert.equal(hasSrcTable('=== table {#t format=csv src="d.csv"}\n===\n'), true);
  assert.equal(hasSrcTable('=== table {#t format=csv}\nA\n1\n===\n'), false);
});

await test("an UNQUOTED src= is a src table too — §4 makes both forms a string", () => {
  // The parser reads `src=d.csv` and `src="d.csv"` into the identical model, so
  // matching only the quoted form left a legal document rendering its data
  // through the CLI and a "Data not loaded" placeholder in the browser.
  assert.equal(hasSrcTable("=== table {#t format=csv src=d.csv}\n===\n"), true);
  assert.equal(hasSrcTable("=== table {#t src=d.csv format=csv}\n===\n"), true, "src not last");
});

await test("inlining strips the src attribute in either form, keeping the rest", async () => {
  const csv = "A, B\n1, 2\n";
  for (const written of ['src="d.csv"', "src=d.csv"]) {
    const raw = `=== table {#t format=csv header=1 ${written}}\n===\n`;
    const out = await inlineSrcTables(raw, (s) => s, async () => csv);
    assert.equal(out.split("\n")[0], "=== table {#t format=csv header=1}",
      `${written}: the fence keeps every other attribute and closes cleanly`);
    const t = parse(out).children.find((b) => b.table).table;
    assert.equal(t.src, undefined, `${written}: inlined, no longer external`);
    assert.deepEqual(t.columns, ["A", "B"]);
  }
});

await test("the resolved src VALUE is the same either way", async () => {
  const seen = [];
  for (const written of ['src="sub/d.csv"', "src=sub/d.csv"]) {
    await inlineSrcTables(`=== table {#t ${written}}\n===\n`,
      (s) => { seen.push(s); return s; }, async () => "A\n1\n");
  }
  assert.deepEqual(seen, ["sub/d.csv", "sub/d.csv"]);
});

await test("inlineSrcTables fetches, inlines, and parses with data + compute", async () => {
  // GEP-0012: the fetched rows are the table's, the derived column is a view's,
  // and inlining still has to leave both usable.
  const raw = '# Doc\n\n=== table {#facts format=csv src="d.csv"}\n===\n\n=== view {#fy src=#facts compute="S = A + B"}\n===\n';
  const out = await inlineSrcTables(raw, (s) => s, async () => "A, B\n1, 2\n3, 4\n");
  const doc = parse(out);
  assert.equal(doc.children.find((b) => b.type === "table").table.src, undefined); // inlined → no longer external
  const t = doc.children.find((b) => b.type === "view").table;
  assert.deepEqual(t.columns, ["A", "B", "S"]);
  assert.equal(t.rows[0][2].value, 3);     // S = 1 + 2
  assert.equal(t.rows[1][2].value, 7);     // S = 3 + 4
});

await test("inlineSrcTables gives a `view` over a data file a sibling facts table", async () => {
  // GEP-0012: a view may derive from a `.csv`, but it takes NO body, so it
  // cannot be inlined the way a table is. Without the sibling it rendered EMPTY
  // in the browser — the parse has no filesystem, so it warned and published a
  // relation with no columns while the CLI rendered the same document in full.
  const csv = "Seg, N\na, 1\nb, 5\n";
  const out = await inlineSrcTables(
    '=== view {#big src="rows.csv" where="N > 1" compute="D = N * 2"}\n===\n',
    (s) => s,
    async () => csv,
  );
  assert.match(out, /=== table \{#big-src format=csv header=1\}/, "the facts land in a table named after the view");
  assert.match(out, /=== view \{#big where="N > 1" compute="D = N \* 2" src=#big-src\}/, "and the view is repointed at it, keeping its own id first");
  const doc = parse(out);
  assert.deepEqual(doc.diagnostics.filter((d) => d.severity === "error"), []);
  const view = doc.children.find((b) => b.type === "view");
  assert.deepEqual(view.table.columns, ["Seg", "N", "D"]);
  assert.deepEqual(view.table.rows.map((r) => r.map((c) => c.text)), [["b", "5", "10"]], "where and compute both ran");

  // A body-describing attribute the author wrote on the view goes to the table,
  // with the body it describes — and the value must not eat the closing `}`.
  const tsv = await inlineSrcTables('=== view {#t src=rows.tsv format=tsv}\n===\n', (s) => s, async () => "Seg\tN\na\t1\n");
  assert.match(tsv, /=== table \{#t-src format=tsv\}/);
  assert.deepEqual(parse(tsv).diagnostics.filter((d) => d.severity === "error"), []);

  // A `src=` naming a BLOCK is the parser's own job and is left alone.
  const block = await inlineSrcTables('=== table {#f format=csv}\nSeg, N\na, 1\n===\n\n=== view {#v src=#f}\n===\n', (s) => s, async () => csv);
  assert.match(block, /=== view \{#v src=#f\}/, "untouched");
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
  const raw = '=== table {#facts format=csv src="d.csv"}\n===\n\n=== view {#fy src=#facts compute="X = Nope * 2"}\n===\n';
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

await test("src= inside a QUOTED value is prose, not the attribute", async () => {
  // `caption="see src=x.csv"` must neither mark the table as external nor be
  // mangled by the strip — the only attributes here are #t, caption, format.
  const raw = '=== table {#t caption="see src=x.csv" format=csv}\nA\n1\n===\n';
  assert.equal(hasSrcTable(raw), false);
  const out = await inlineSrcTables(raw, (s) => s, async () => "B\n2\n");
  assert.equal(out, raw, "document must pass through unchanged");
});

await test("a real src= after a quoted value still inlines (quote parity, not position)", async () => {
  const raw = '=== table {#t caption="just a caption" src=d.csv format=csv header=1}\n===\n';
  assert.equal(hasSrcTable(raw), true);
  const out = await inlineSrcTables(raw, (s) => s, async () => "A\n1\n");
  assert.equal(out.split("\n")[0], '=== table {#t caption="just a caption" format=csv header=1}');
});

await test("an attribute merely ENDING in src (data-src=) is not src=", () => {
  assert.equal(hasSrcTable("=== table {#t data-src=d.csv format=csv}\nA\n1\n===\n"), false);
});

await test("a data block's src= inlines and the value verifies (GEP-0005)", async () => {
  const raw = '=== data {#cfg src=cfg.json}\n===\n';
  assert.equal(hasSrcTable(raw), true, "the gate sees data src= too");
  const out = await inlineSrcTables(raw, (s) => s, async () => '{"a": 1}');
  const doc = parse(out);
  assert.equal(doc.diagnostics.length, 0);
  assert.deepEqual(doc.children[0].value, { a: 1 });
});

await test("a .jsonl src= gets format=jsonl injected on inlining, so verification matches", async () => {
  const raw = '=== data {#log src=log.jsonl}\n===\n\n=== diagram {#c format=geml-chart data=#log type=bar x=t y=v}\n===\n';
  const out = await inlineSrcTables(raw, (s) => s, async () => '{"t":"a","v":1}\n{"t":"b","v":2}\n');
  assert.match(out.split("\n")[0], /format=jsonl/);
  const doc = parse(out);
  assert.equal(doc.diagnostics.length, 0);
  assert.ok(doc.children.find((b) => b.type === "diagram").chart, "chart drew from the inlined records");
});

await test("a fetched body the data engine rejects leaves the block external", async () => {
  const raw = '=== data {#cfg src=cfg.json}\n===\n';
  const out = await inlineSrcTables(raw, (s) => s, async () => "<html>500</html>");
  assert.equal(out, raw, "unchanged — renderer shows the placeholder");
});

await test("a src= naming a BLOCK is left alone — it is not a file", async () => {
  // `src=A.geml#fy` used to be fetched as a URL. HTTP drops the fragment, so
  // the whole of A.geml came back, looksTabular said yes (text, and starting
  // with neither `<` nor `{`), and the entire document — meta block, headings
  // and all — was inlined as that table's body. A same-document `src=#id` is
  // the parser's job and a cross-document one needs a resolver this module
  // does not have; both must pass through untouched.
  const wholeDoc = ['=== meta', 'title = "A"', '===', '', '=== table {#fy format=csv header=1}', 'Seg, Q1', 'Cloud, 8', '==='].join("\n");
  for (const written of ['src=A.geml#fy', 'src="A.geml#fy"', 'src=#fy']) {
    const raw = `=== table {#t ${written}}\n===\n`;
    assert.equal(hasSrcTable(raw), false, `${written}: not a file source`);
    let fetches = 0;
    const out = await inlineSrcTables(raw, (u) => u, async () => { fetches++; return wholeDoc; });
    assert.equal(out, raw, `${written}: passed through unchanged`);
    assert.equal(fetches, 0, `${written}: nothing was fetched`);
  }
});

await test("a file source still inlines when a block source sits beside it", async () => {
  const raw = [
    '=== table {#a src=#other}',
    '===',
    '',
    '=== table {#b format=csv header=1 src=d.csv}',
    '===',
  ].join("\n") + "\n";
  const out = await inlineSrcTables(raw, (u) => u, async () => "A, B\n1, 2\n");
  assert.match(out, /=== table \{#a src=#other\}/, "the block source is untouched");
  assert.match(out, /1, 2/, "the file source is inlined");
});

console.log(`\n${passed} test(s) passed.`);
