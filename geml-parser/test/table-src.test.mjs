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
// A block reference, in this document or another
// ---------------------------------------------------------------------------

test("a VIEW borrows another table in the same document with `#id` (GEP-0012)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), FY + "\n=== view {#copy src=#fy25}\n===\n");
  const r = cli(dir, "host.geml", "--to", "json");
  assert.equal(r.status, 0, r.stderr);
  const copy = JSON.parse(r.stdout).children.find((b) => b.id === "copy");
  assert.deepEqual(copy.table.columns, ["Segment", "Q1", "Q2"]);
  assert.equal(copy.table.rows.length, 2);
});

test("a view borrows a relation in another document", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== view {#copy src=other.geml#fy25}\n===\n");
  const r = cli(dir, "host.geml", "--to", "json");
  assert.equal(r.status, 0, r.stderr);
  const copy = JSON.parse(r.stdout).children[0];
  assert.deepEqual(copy.table.columns, ["Segment", "Q1", "Q2"]);
  assert.equal(copy.table.rows.length, 2);
});

test("borrowing an id that publishes no relation is an error", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== note {#prose}\nnot a table\n===\n\n=== view {#copy src=#prose}\n===\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /not a table or view/i);
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

test("a chart's data target is never reported as a `#` id the author did not write", () => {
  // The old message read `unresolved reference '#d.csv'` — a target that never
  // existed, the same shape of lie the cross-document form was fixed for. A data
  // file is accepted now (see the desugaring tests below), so the case that still
  // has to report well is a file that is not data.
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"),
    '=== diagram {#c format=geml-chart data="notes.rtf" type=bar x=Segment y=Q1}\n===\n');
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1, "fail-closed is right");
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /#notes\.rtf/, "a filename must not be reported as a `#` target");
  assert.match(out, /notes\.rtf/, "the message has to name what the author wrote");
});

// ---------------------------------------------------------------------------
// A chart's `data=` may name a data file, desugared to an anonymous table
// ---------------------------------------------------------------------------

test("a chart can name a data file directly, and charts it", () => {
  // Defined as sugar: `data=rows.csv` is an anonymous table with that source
  // feeding this chart. So the one source rule covers charts too, instead of a
  // chart being its exception.
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"),
    '=== diagram {#c format=geml-chart data="rows.csv" type=bar x=Segment y=Q1}\n===\n');
  const chk = cli(dir, "check", "host.geml");
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  const json = JSON.parse(cli(dir, "host.geml", "--to", "json").stdout);
  assert.ok(json.children[0].chart, "the chart model has to be built from the file");
  assert.match(cli(dir, "host.geml", "--to", "html").stdout, /<svg/);
});

test("a chart naming a .tsv gets the tsv reader, without being told", () => {
  const dir = workspace();
  writeFileSync(join(dir, "rows.tsv"), "Segment\tQ1\nCloud\t8\nPlatform\t5\n");
  writeFileSync(join(dir, "host.geml"),
    '=== diagram {#c format=geml-chart data="rows.tsv" type=bar x=Segment y=Q1}\n===\n');
  assert.equal(cli(dir, "check", "host.geml").status, 0);
});

test("`delim=` reaches a src= file and a chart's data= file alike (§6)", () => {
  // The delimiter is part of how a data body is read, so it has to travel with
  // the source: a `;`-separated export is one attribute away from usable, on a
  // table and on the chart sugar for the same thing.
  const dir = workspace();
  writeFileSync(join(dir, "euro.csv"), "Segment;Q1;Q2\nCloud;8;10\nPlatform;5;6\n");
  writeFileSync(join(dir, "host.geml"),
    '=== table {#t src="euro.csv" format=csv delim=";" header=1}\n===\n\n'
    + '=== diagram {#c format=geml-chart data="euro.csv" delim=";" type=bar x=Segment y=Q1}\n===\n');
  const chk = cli(dir, "check", "host.geml");
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  const json = JSON.parse(cli(dir, "host.geml", "--to", "json").stdout);
  assert.deepEqual(json.children[0].table.columns, ["Segment", "Q1", "Q2"],
    "without the delimiter the whole line would be one column");
  assert.equal(json.children[0].table.rows.length, 2);
  assert.ok(json.children[1].chart, "the chart has to read the same file the same way");
});

test("a chart naming a file that is neither data nor a table id is an error", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"),
    '=== diagram {#c format=geml-chart data="notes.txt" type=bar x=a y=b}\n===\n');
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /notes\.txt/);
  assert.doesNotMatch(out, /#notes\.txt/, "still never a `#` target the author did not write");
});

test("a chart naming an unresolvable data file is an error", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"),
    '=== diagram {#c format=geml-chart data="gone.csv" type=bar x=a y=b}\n===\n');
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /gone\.csv/);
});

// ---------------------------------------------------------------------------
// Source-rule paths that only the fallbacks reach
// ---------------------------------------------------------------------------

test("a table source that is not a data file is refused", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), '=== table {#t src=".env" format=csv}\n===\n');
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1, "a data source is data — not any file under the base");
  assert.match(r.stdout + r.stderr, /csv|tsv/, "the message says what a source may be");
});

test("a table source naming an http(s) URL defers to render time, per §9.4", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), '=== table {#t src="https://example.test/a.csv" format=csv}\n===\n');
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 0, `a spec-conformant document must not fail: ${r.stdout}${r.stderr}`);
});

test("a table source naming a disallowed scheme is refused", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), '=== table {#t src="javascript:alert(1)" format=csv}\n===\n');
  assert.equal(cli(dir, "check", "host.geml").status, 1);
});

test("a view borrowing an id that no block declares is an unresolved reference", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== view {#copy src=#nothing}\n===\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /nothing/);
});

test("a view borrowing from a document that cannot be resolved is an error", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== view {#copy src=gone.geml#fy25}\n===\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /gone\.geml/);
});

test("a table source is unchecked, not fatal, with no document resolver", () => {
  // The `parse()` path a library caller gets: nothing to resolve against, so the
  // target is reported as unchecked rather than failing.
  const doc = parse('=== table {#t src="rows.csv" format=csv header=1}\n===\n');
  assert.ok(doc.diagnostics.some((d) => d.code === "unchecked-cross-document-reference"));
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0);
});

test("a CROSS-DOCUMENT view source is unchecked too, with the same reasoning", () => {
  // `other.geml#rows` needs a directory to resolve from, which a library caller
  // has not given. Same answer as an external data file: a warning, not an error,
  // because the document may well be fine — this caller just cannot see it.
  const doc = parse("=== view {#t src=other.geml#rows}\n===\n");
  const d = doc.diagnostics.find((x) => x.code === "unchecked-cross-document-reference");
  assert.ok(d, JSON.stringify(doc.diagnostics));
  assert.match(d.message, /view source `other\.geml#rows` not checked/);
  assert.equal(doc.diagnostics.filter((x) => x.severity === "error").length, 0);
});

test("a chart data target is unchecked with no resolver, for both target shapes", () => {
  // Two arms, and they word themselves differently on purpose: one is a data
  // FILE the chart would have to load, the other a table in another DOCUMENT.
  const file = parse("=== diagram {#c format=geml-chart data=rows.csv type=bar x=A y=B}\n===\n");
  assert.ok(file.diagnostics.some((d) => d.code === "unchecked-cross-document-reference"),
    JSON.stringify(file.diagnostics));
  const cross = parse("=== diagram {#c format=geml-chart data=other.geml#fy type=bar x=A y=B}\n===\n");
  const d = cross.diagnostics.find((x) => x.code === "unchecked-cross-document-reference");
  assert.ok(d, JSON.stringify(cross.diagnostics));
  assert.match(d.message, /geml-chart: data target `other\.geml#fy` not checked/);
});

test("an http(s) source is left for render time, not reported as broken", () => {
  // §9.4: the build never fetches. A remote source therefore leaves the table
  // empty and says nothing — treating it as unresolved would make every
  // remote-sourced document fail `check`.
  for (const src of ["https://example.test/rows.csv", "http://example.test/rows.csv"]) {
    const doc = parse(`=== table {#t src=${src} format=csv header=1}\n===\n`);
    assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0, src);
  }
  // A chart pointed at a remote table has nothing to chart at build time either,
  // and must not invent an error for it.
  const chart = parse("=== diagram {#c format=geml-chart data=https://example.test/rows.csv type=bar x=A y=B}\n===\n");
  assert.equal(chart.diagnostics.filter((d) => d.severity === "error").length, 0,
    JSON.stringify(chart.diagnostics));
});

test("a cross-document target that is not a table names that, not `unresolved`", () => {
  // Three different failures the caller can act on differently: the document is
  // missing, the id is missing, or the id is there but is the wrong KIND.
  const dir = mkdtempSync(join(tmpdir(), "geml-tsrc-x-"));
  writeFileSync(join(dir, "other.geml"), "=== note {#rows}\nnot a table\n===\n");
  const host = join(dir, "host.geml");
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "geml.js");
  const check = (src) => {
    // GEP-0012: a block target is a view's; the three failures it can name are
    // unchanged.
    writeFileSync(host, `=== view {#t src=${src}}\n===\n`);
    const r = spawnSync(process.execPath, [cli, "check", host], { encoding: "utf8", timeout: 60_000 });
    return (r.stdout ?? "") + (r.stderr ?? "");
  };
  assert.match(check("other.geml#rows"), /is not a table or view/);
  assert.match(check("other.geml#nosuchid"), /unresolved reference/);
  assert.match(check("missing.geml#rows"), /cannot resolve document/);
});

test("a chart whose data target is the wrong kind says so in the chart's words", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-tsrc-c-"));
  writeFileSync(join(dir, "other.geml"), "=== note {#rows}\nnot a table\n===\n");
  const host = join(dir, "host.geml");
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "geml.js");
  const check = (data) => {
    writeFileSync(host, `=== diagram {#c format=geml-chart data=${data} type=bar x=A y=B}\n===\n`);
    const r = spawnSync(process.execPath, [cli, "check", host], { encoding: "utf8", timeout: 60_000 });
    return (r.stdout ?? "") + (r.stderr ?? "");
  };
  assert.match(check("other.geml#rows"), /geml-chart: data target .* is neither a table nor a data block/);
  assert.match(check("other.geml#nosuchid"), /geml-chart: unresolved reference/);
  assert.match(check("missing.geml#rows"), /geml-chart: cannot resolve document/);
});

console.log(`${passed} test(s) passed.`);
