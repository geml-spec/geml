// `src=` and `data=` are one concept: where a block's data comes from.
//
// Before this, the two were unrelated and neither worked across files:
//
//   * `table src="d.csv"` was recorded in the model and then consumed by nobody.
//     The CSV was never read, the table rendered with columns=[] and rows=0, and
//     `check` reported nothing at all — a silently empty table.
//   * `data=` on a chart only ever matched an id in the SAME document, and a
//     cross-document target produced a garbled `unresolved reference
//     '#other.geml#fy25'` (it stripped one `#` and treated the rest as a local id).
//
// Now one rule resolves either attribute, on a table or on a chart, in three
// forms: an external data file, `#id` naming a table block in this document, or
// `doc.geml#id` naming one in another document. Unresolvable is an error.
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "geml.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });

const FY = [
  "=== table {#fy25 format=csv header=1}",
  "Segment, Q1, Q2",
  "Cloud, 8, 10",
  "Platform, 5, 6",
  "===",
  "",
].join("\n");

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "geml-src-"));
  writeFileSync(join(dir, "rows.csv"), "Segment,Q1,Q2\nCloud,8,10\nPlatform,5,6\n");
  writeFileSync(join(dir, "other.geml"), FY);
  return dir;
}

// ---------------------------------------------------------------------------
// An external data file is actually loaded
// ---------------------------------------------------------------------------

test("a table's `src=` CSV is loaded into the model, not left empty", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), '=== table {#t src="rows.csv" format=csv header=1}\n===\n');
  const r = cli(dir, "host.geml", "--to", "json");
  assert.equal(r.status, 0, r.stderr);
  const t = JSON.parse(r.stdout).children[0].table;
  assert.deepEqual(t.columns, ["Segment", "Q1", "Q2"], "the header row has to come from the file");
  assert.equal(t.rows.length, 2, `expected 2 rows from the CSV, got ${t.rows.length}`);
});

test("a table's `src=` CSV reaches the rendered table", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), '=== table {#t src="rows.csv" format=csv header=1}\n===\n');
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Platform/, "a row from the file has to appear");
});

test("a `src=` that cannot be resolved is an error, not a silently empty table", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), '=== table {#t src="nope.csv" format=csv header=1}\n===\n');
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1, "silence here is what let an empty table ship");
  assert.match(r.stdout + r.stderr, /nope\.csv/);
});

// ---------------------------------------------------------------------------
// `data=` and `src=` are the same attribute
// ---------------------------------------------------------------------------

test("`data=` on a table means what `src=` means", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), '=== table {#t data="rows.csv" format=csv header=1}\n===\n');
  const r = cli(dir, "host.geml", "--to", "json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).children[0].table.rows.length, 2);
});

test("both `src=` and `data=` on one block is a diagnostic, not a silent winner", () => {
  const doc = parse('=== table {#t src="a.csv" data="b.csv" format=csv header=1}\n===\n');
  assert.ok(doc.diagnostics.some((d) => d.code === "source-attr-conflict"),
    `expected source-attr-conflict, got ${JSON.stringify(doc.diagnostics.map((d) => d.code))}`);
});

// ---------------------------------------------------------------------------
// A block reference, in this document or another
// ---------------------------------------------------------------------------

test("a table can borrow another table in the same document with `#id`", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), FY + "\n=== table {#copy src=#fy25}\n===\n");
  const r = cli(dir, "host.geml", "--to", "json");
  assert.equal(r.status, 0, r.stderr);
  const copy = JSON.parse(r.stdout).children.find((b) => b.id === "copy");
  assert.deepEqual(copy.table.columns, ["Segment", "Q1", "Q2"]);
  assert.equal(copy.table.rows.length, 2);
});

test("a table can borrow a table in another document", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== table {#copy src=other.geml#fy25}\n===\n");
  const r = cli(dir, "host.geml", "--to", "json");
  assert.equal(r.status, 0, r.stderr);
  const copy = JSON.parse(r.stdout).children[0];
  assert.deepEqual(copy.table.columns, ["Segment", "Q1", "Q2"]);
  assert.equal(copy.table.rows.length, 2);
});

test("borrowing an id that is not a table is an error", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== note {#prose}\nnot a table\n===\n\n=== table {#copy src=#prose}\n===\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /not a table/i);
});

// ---------------------------------------------------------------------------
// A chart resolves its data by the same rule
// ---------------------------------------------------------------------------

test("a chart can name a table in another document (`data=doc.geml#id`)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"),
    "=== diagram {#c format=geml-chart data=other.geml#fy25 type=bar x=Segment y=Q1}\n===\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a chart naming a missing table in another document is an error, with a readable message", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"),
    "=== diagram {#c format=geml-chart data=other.geml#gone type=bar x=Segment y=Q1}\n===\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /other\.geml#gone/);
  assert.doesNotMatch(out, /#other\.geml#gone/, "the old message stripped one # and mangled the rest");
});

test("a chart over a table fed from a data file actually builds", () => {
  // The path §6 blesses, and it was broken: the chart pass ran BEFORE table
  // sources were resolved, and it also still carried a `table.src` skip written
  // for the old "loaded at render time" design. So the chart was never built,
  // `check` reported nothing, and the page said "chart could not be built (see
  // diagnostics)" — pointing at diagnostics that did not exist.
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"),
    '=== table {#t src="rows.csv" format=csv header=1}\n===\n\n'
    + "=== diagram {#c format=geml-chart data=#t type=bar x=Segment y=Q1}\n===\n");
  const chk = cli(dir, "check", "host.geml");
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  const json = JSON.parse(cli(dir, "host.geml", "--to", "json").stdout);
  assert.ok(json.children.find((b) => b.id === "c").chart, "the chart model has to be built");
  const html = cli(dir, "host.geml", "--to", "html");
  assert.doesNotMatch(html.stdout, /chart could not be built/, "no placeholder pointing at absent diagnostics");
  assert.match(html.stdout, /<svg/, "the chart renders");
});

test("a chart named a data file says what to do instead of inventing a `#` target", () => {
  // The old message read `unresolved reference '#d.csv'` — a target that never
  // existed, the same shape of lie the cross-document form was just fixed for.
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"),
    '=== diagram {#c format=geml-chart data="rows.csv" type=bar x=Segment y=Q1}\n===\n');
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1, "fail-closed is right");
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /#rows\.csv/, "a filename must not be reported as a `#` target");
  assert.match(out, /rows\.csv/, "the message has to name what the author wrote");
  assert.match(out, /table/i, "and point at the table that should hold the data");
});

console.log(`${passed} test(s) passed.`);
