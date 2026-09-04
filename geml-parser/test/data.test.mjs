// The `data` block (GEP-0005): format engines and their diagnostics, the
// schema= reference check, chart binding over record arrays (local and
// cross-document), the table/data boundary, canonical serialization, the
// HTML preview (head for json, TAIL for jsonl), md export, and the
// blind-append property. Conformance pins the projection; this suite pins
// everything diagnostics-shaped, which the projection cannot see.
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, renderHtml, serialize } from "../dist/geml.js";
import { gemlToMd } from "../dist/to-md.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const errs = (doc) => doc.diagnostics.filter((d) => d.severity === "error");
const warns = (doc) => doc.diagnostics.filter((d) => d.severity === "warning");

test("json is the default format; the parsed value lands on the block", () => {
  const doc = parse('=== data {#c}\n{"a": [1, 2], "b": {"c": true}}\n===\n');
  assert.equal(doc.diagnostics.length, 0);
  const b = doc.children.find((x) => x.kind === "block" && x.type === "data");
  assert.deepEqual(b.value, { a: [1, 2], b: { c: true } });
});

test("a malformed json body is data-parse, naming the body line", () => {
  const doc = parse('# T\n\n=== data {#bad}\n{\n  "a": 1,,\n}\n===\n');
  const e = errs(doc);
  assert.equal(e.length, 1);
  assert.equal(e[0].code, "data-parse");
  // open fence is doc line 3; the bad token sits on body line 2 -> doc line 5
  assert.equal(e[0].line, 5);
});

test("jsonl: per-line values, blank lines ignored, per-line failure named", () => {
  const ok = parse('=== data {#l format=jsonl}\n{"n":1}\n\n{"n":2}\n===\n');
  assert.equal(ok.diagnostics.length, 0);
  assert.deepEqual(ok.children[0].value, [{ n: 1 }, { n: 2 }]);

  const bad = parse('=== data {#l format=jsonl}\n{"n":1}\nnot json\n===\n');
  const e = errs(bad);
  assert.equal(e.length, 1);
  assert.equal(e[0].code, "data-parse");
  assert.match(e[0].message, /line 2/);
  assert.equal(e[0].line, 3); // open fence line 1 + body line 2
  assert.equal(bad.children[0].value, undefined, "a failed jsonl body carries no value");
});

test("a reserved format with no engine here warns, keeps the body and carries no value", () => {
  for (const [fmt, code] of [["toml", "data-format-no-engine"], ["hocon", "unknown-data-format"]]) {
    const doc = parse(`=== data {#d format=${fmt}}\nkey: value\n===\n`);
    assert.equal(errs(doc).length, 0, fmt);
    const w = warns(doc);
    assert.equal(w.length, 1, fmt);
    assert.equal(w[0].code, code, fmt);
    assert.equal(doc.children[0].value, undefined, fmt);
    assert.deepEqual(doc.children[0].raw, ["key: value"], fmt);
  }
  // `yaml` is reserved by the same sentence, and this processor HAS an engine
  // for it: reserving the name is the spec's business, having the engine is the
  // processor's. The subset it reads is pinned in yaml.test.mjs.
  const y = parse("=== data {#d format=yaml}\nkey: value\n===\n");
  assert.equal(y.diagnostics.length, 0, "yaml parses here");
  assert.deepEqual(y.children[0].value, { key: "value" });
});

test("schema= is reference-checked: #id and doc.geml[#id] pass shape, junk is bad-data-schema", () => {
  const good = parse('=== data {#s}\n{"x": 1}\n===\n\n=== data {#c schema=#s}\n{"x": 2}\n===\n');
  assert.equal(good.diagnostics.length, 0);

  const dangling = parse('=== data {#c schema=#nope}\n{}\n===\n');
  assert.ok(errs(dangling).some((d) => d.code === "unresolved-reference"), "a dangling schema id rots loudly");

  const junk = parse('=== data {#c schema=schema.json}\n{}\n===\n');
  assert.ok(errs(junk).some((d) => d.code === "bad-data-schema"), "a non-geml path is refused");
});

test("chart over a local record-array data block resolves; misshapes are chart-data-not-records", () => {
  const ok = parse('=== data {#log format=jsonl}\n{"t":"a","v":1}\n{"t":"b","v":2}\n===\n\n=== diagram {#c format=geml-chart data=#log type=bar x=t y=v}\n===\n');
  assert.equal(ok.diagnostics.length, 0);
  assert.ok(ok.children.find((b) => b.type === "diagram").chart, "chart model built");

  const notRecords = parse('=== data {#o}\n{"a":1}\n===\n\n=== diagram {format=geml-chart data=#o type=bar x=k y=v}\n===\n');
  assert.ok(errs(notRecords).some((d) => d.code === "chart-data-not-records" && /record array/.test(d.message)));

  const nonScalar = parse('=== data {#l format=jsonl}\n{"x":1,"y":{"n":2}}\n===\n\n=== diagram {format=geml-chart data=#l type=bar x=x y=y}\n===\n');
  assert.ok(errs(nonScalar).some((d) => d.code === "chart-data-not-records" && /record 1/.test(d.message)));
});

test("cross-document: a chart may target a remote data block; a table src= may NOT", () => {
  const remote = '=== data {#log format=jsonl}\n{"t":"a","v":1}\n===\n';
  const resolveDoc = (p) => (p === "b.geml" ? remote : null);
  const chart = parse('=== diagram {format=geml-chart data=b.geml#log type=bar x=t y=v}\n===\n', { resolveDoc });
  assert.equal(chart.diagnostics.length, 0);

  const tableSrc = parse('=== table {#t src=b.geml#log}\n===\n', { resolveDoc });
  assert.ok(errs(tableSrc).some((d) => d.code === "table-source-not-a-table"),
    "the column algebra a borrowing table implies has no meaning over a value tree");
});

test("duplicate data ids: the first definition wins for chart binding (matching tables)", () => {
  const doc = parse('=== data {#d format=jsonl}\n{"x":"a","y":1}\n===\n\n=== data {#d format=jsonl}\n{"x":"z","y":9}\n===\n\n=== diagram {format=geml-chart data=#d type=bar x=x y=y}\n===\n');
  assert.ok(errs(doc).some((d) => d.code === "duplicate-id"));
  const chart = doc.children.find((b) => b.type === "diagram").chart;
  assert.ok(chart, "chart still binds to the surviving (first) definition");
});

test("serialize canonicalizes json (2-space) and jsonl (compact per line), idempotently", () => {
  const doc = parse('=== data {#c}\n{"b":1,   "a":[1,2]}\n===\n\n=== data {#l format=jsonl}\n{ "n" : 1 }\n\n{"n":2}\n===\n');
  const once = serialize(doc);
  assert.match(once, /  "b": 1/, "pretty json");
  assert.match(once, /\n\{"n":1\}\n\{"n":2\}\n/, "compact jsonl, blank line dropped");
  assert.equal(serialize(parse(once)), once, "canonical form is a fixed point");
});

test("an engine-less body is byte-preserved by serialize (the open line is canonical)", () => {
  const out = serialize(parse("=== data {#y format=toml}\nkey =   'value'   # spacing kept\n===\n"));
  assert.match(out, /\nkey =   'value'   # spacing kept\n/, "body bytes untouched");
  assert.ok(warns(parse(out)).some((d) => d.code === "data-format-no-engine"),
    "round-trips as the same reserved-format block");
});

test("html: json opens from the head, jsonl opens on the TAIL, and NEITHER loses a line", () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(JSON.stringify({ n: i }));
  const doc = parse(`=== data {#log format=jsonl}\n${lines.join("\n")}\n===\n`);
  const html = renderHtml(doc, { tableRows: 10 });
  assert.match(html, /\{"n":29\}/, "the newest line is the one that is open");
  assert.match(html, /\{"n":0\}/, "and the oldest is still in the page — folded, not dropped");
  assert.match(html, /<details class="data-more"><summary>20 earlier lines of 30<\/summary>/,
    "a log folds its earlier lines ABOVE the open tail");
  assert.ok(html.indexOf('<details class="data-more">') < html.indexOf('{"n":29}'), "fold precedes the open tail");

  const jdoc = parse(`=== data {#big}\n[\n${lines.join(",\n")}\n]\n===\n`);
  const jhtml = renderHtml(jdoc, { tableRows: 10 });
  assert.match(jhtml, /<details class="data-more"><summary>22 more lines of 32<\/summary>/, "json folds below");
  assert.match(jhtml, /\{"n":29\}/, "the last record of a json value is in the page");
  assert.ok(jhtml.indexOf('{"n":0}') < jhtml.indexOf('<details class="data-more">'), "json reads from the top");
});

test("a hidden data block renders nothing but still feeds a chart", () => {
  const doc = parse('=== data {#src hidden format=jsonl}\n{"t":"a","v":1}\n===\n\n=== diagram {format=geml-chart data=#src type=bar x=t y=v}\n===\n');
  assert.equal(doc.diagnostics.length, 0);
  const html = renderHtml(doc);
  assert.doesNotMatch(html, /data-src/, "hidden: no preview figure");
  assert.match(html, /<svg/, "the chart drew from it");
});

test("md export projects a data block as a fenced code block in its format", () => {
  const { md } = gemlToMd(parse('=== data {#l format=jsonl}\n{"a":1}\n===\n'));
  assert.match(md, /```jsonl\n\{"a":1\}\n```/);
});

test("blind append: a complete data block concatenated at EOF is a valid continuation", () => {
  const base = '# Log {#top}\n\n=== data {#r-1 format=jsonl}\n{"n":1}\n===\n';
  const appended = base + '\n=== data {#r-2 format=jsonl}\n{"n":2}\n===\n';
  const doc = parse(appended);
  assert.equal(doc.diagnostics.length, 0);
  assert.deepEqual(doc.ids.filter((i) => i.startsWith("r-")), ["r-1", "r-2"]);
});

test("a torn append degrades to one unterminated-block error, body kept (jsonl analogue of a lost last line)", () => {
  const torn = '=== data {#r-1 format=jsonl}\n{"n":1}\n===\n\n=== data {#r-2 format=jsonl}\n{"n":2}\n';
  const doc = parse(torn);
  const e = errs(doc);
  assert.ok(e.some((d) => d.code === "unterminated-block"));
  assert.deepEqual(doc.children.find((b) => b.id === "r-2").value, [{ n: 2 }], "the tail's data still parsed");
});

test("src= loads external json/jsonl at build; format= wins over the extension", () => {
  const files = {
    "cfg.json": '{"a": 1}',
    "log.jsonl": '{"t":"a","v":1}\n{"t":"b","v":2}\n',
    "odd.json": '{"n":1}\n{"n":2}\n', // jsonl content behind a .json name
  };
  const resolveDoc = (p) => files[p] ?? null;
  const doc = parse('=== data {#c src=cfg.json}\n===\n\n=== data {#l src=log.jsonl}\n===\n\n=== data {#o src=odd.json format=jsonl}\n===\n\n=== diagram {#ch format=geml-chart data=#l type=bar x=t y=v}\n===\n', { resolveDoc });
  assert.equal(doc.diagnostics.length, 0);
  assert.deepEqual(doc.children[0].value, { a: 1 });
  assert.deepEqual(doc.children[1].value, [{ t: "a", v: 1 }, { t: "b", v: 2 }]);
  assert.deepEqual(doc.children[2].value, [{ n: 1 }, { n: 2 }], "explicit format beat the .json extension");
  assert.ok(doc.children[3].chart, "chart binds to the src-loaded records");
});

test("src= loads a `.yaml`/`.yml` file too — the shape most config on disk has", () => {
  // `src=` exists so the file stays the source of truth and the document is
  // its verified, addressable view. Admitting the format but not the file it
  // normally lives in would have left the engine reachable only by pasting a
  // config INTO the document, which is the fork `src=` avoids.
  const files = {
    "cfg.yaml": "service: geml\nports:\n  - 8080\n  - 9090\n",
    "hosts.yml": "- a\n- b\n",
    "flow.yaml": "a: [1, 2]\n",                 // outside the subset
    "notes.json": "service: geml\n",             // yaml content behind a .json name
  };
  const resolveDoc = (p) => files[p] ?? null;
  const doc = parse("=== data {#c src=cfg.yaml}\n===\n\n=== data {#h src=hosts.yml}\n===\n", { resolveDoc });
  assert.equal(doc.diagnostics.length, 0);
  assert.deepEqual(doc.children[0].value, { service: "geml", ports: [8080, 9090] }, "the extension named the format");
  assert.deepEqual(doc.children[1].value, ["a", "b"]);

  const outside = parse("=== data {#f src=flow.yaml}\n===\n", { resolveDoc });
  assert.ok(errs(outside).some((d) => d.code === "data-parse" && /flow collection/.test(d.message)),
    "a construct outside the subset fails the build rather than being guessed at");

  const wrongExt = parse("=== data {#n src=notes.json}\n===\n", { resolveDoc });
  assert.ok(errs(wrongExt).some((d) => d.code === "data-parse" && /valid JSON/.test(d.message)),
    "the extension decides, not the bytes — declared, never sniffed");
  assert.deepEqual(parse("=== data {#n src=notes.json format=yaml}\n===\n", { resolveDoc }).children[0].value,
    { service: "geml" }, "and an explicit format= still wins over it");
});

test("src= discipline: XOR with body, extension gate, unresolvable, bad scheme, no resolver", () => {
  const both = parse('=== data {#x src=cfg.json}\n{"inline": true}\n===\n');
  assert.ok(errs(both).some((d) => d.code === "data-src-and-body"));
  assert.deepEqual(both.children[0].value, { inline: true }, "the body wins");

  const ext = parse('=== data {#x src=secrets.env}\n===\n', { resolveDoc: () => "" });
  assert.ok(errs(ext).some((d) => d.code === "bad-data-source"), "the loader cannot be pointed at a non-data file");

  const missing = parse('=== data {#x src=gone.json}\n===\n', { resolveDoc: () => null });
  assert.ok(errs(missing).some((d) => d.code === "unresolvable-data-source"));

  const scheme = parse('=== data {#x src=ftp://h/d.json}\n===\n');
  assert.ok(errs(scheme).some((d) => d.code === "unresolvable-data-source" && /scheme/.test(d.message)));

  const unchecked = parse('=== data {#x src=d.json}\n===\n');
  assert.equal(errs(unchecked).length, 0);
  assert.ok(warns(unchecked).some((d) => d.code === "unchecked-cross-document-reference"));
});

test("an http(s) src defers: no error, the chart over it defers, the renderer shows a placeholder", () => {
  const doc = parse('=== data {#h src=https://x.example/d.jsonl}\n===\n\n=== diagram {format=geml-chart data=#h type=bar x=t y=v}\n===\n');
  assert.equal(doc.diagnostics.length, 0);
  assert.match(renderHtml(doc), /external data .*loaded at render time/);
});

test("serialize never inlines src= content; a chart may name a local jsonl directly", () => {
  const resolveDoc = (p) => (p === "log.jsonl" ? '{"t":"a","v":1}\n' : null);
  const doc = parse('=== data {#l src=log.jsonl}\n===\n', { resolveDoc });
  assert.match(serialize(doc), /=== data \{#l src="?log\.jsonl"?\}\n===\n/, "the file stays the source of truth");

  const sugar = parse('=== diagram {#c format=geml-chart data=log.jsonl type=bar x=t y=v}\n===\n', { resolveDoc });
  assert.equal(sugar.diagnostics.length, 0);
  assert.ok(sugar.children[0].chart, "data=log.jsonl desugars like data=rows.csv");
});

test("a stray size= on a bar chart over records is the table-source behaviour: a warning, not an error", () => {
  const doc = parse('=== data {#l format=jsonl}\n{"t":"a","v":1}\n===\n\n=== diagram {format=geml-chart data=#l type=bar x=t y=v size=missing}\n===\n');
  assert.equal(errs(doc).length, 0, "no chart-data-not-records for a channel the type never reads");
  assert.ok(warns(doc).some((d) => d.code === "chart-unused-channel"));
  assert.ok(doc.children.find((b) => b.type === "diagram").chart);
});

test("CLI: get --json returns the node with value; --to geml canonicalizes in place of the raw body", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-data-"));
  const file = join(dir, "d.geml");
  try {
    writeFileSync(file, '=== data {#cfg}\n{"b":1,"a":2}\n===\n');
    const get = spawnSync(process.execPath, ["dist/geml.js", "get", file, "#cfg", "--json"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(get.status, 0, get.stderr);
    assert.deepEqual(JSON.parse(get.stdout).value, { b: 1, a: 2 });
    const to = spawnSync(process.execPath, ["dist/geml.js", file, "--to", "geml"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(to.status, 0, to.stderr);
    assert.match(to.stdout, /"b": 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// geml-chart over a FILE data source (dist/geml.js resolveCharts, the
// hash-less `data=` arm): every diagnostic route plus both format engines.
// ---------------------------------------------------------------------------

test("chart data=<file.jsonl>: unchecked without a resolver, charted with one", () => {
  const src = "=== diagram {format=geml-chart data=log.jsonl type=bar x=t y=v}\n===";
  const blind = parse(src);
  assert.deepEqual(blind.diagnostics.map((d) => d.code), ["unchecked-cross-document-reference"]);
  const rd = (p) => (p === "log.jsonl" ? '{"t":"a","v":1}\n{"t":"b","v":2}' : null);
  const seen = parse(src, { resolveDoc: rd });
  assert.deepEqual(seen.diagnostics, []);
  assert.deepEqual(seen.children[0].chart.dataset.categories, ["a", "b"]);
});

test("chart data=<file.json>: a json record array charts like a jsonl one", () => {
  const d = parse("=== diagram {format=geml-chart data=vals.json type=bar x=t y=v}\n===",
    { resolveDoc: (p) => (p === "vals.json" ? '[{"t":"a","v":1}]' : null) });
  assert.deepEqual(d.diagnostics, []);
  assert.deepEqual(d.children[0].chart.dataset.numbers.v, [1]);
});

test("chart data=<file>: unresolvable, unparseable, and non-record sources each say so", () => {
  const gone = parse("=== diagram {format=geml-chart data=gone.jsonl type=bar x=t y=v}\n===",
    { resolveDoc: () => null });
  assert.deepEqual(gone.diagnostics.map((d) => d.code), ["unresolvable-data-source"]);
  const bad = parse("=== diagram {format=geml-chart data=log.jsonl type=bar x=t y=v}\n===",
    { resolveDoc: () => "not json" });
  assert.deepEqual(bad.diagnostics.map((d) => d.code), ["data-parse"]);
  const nonrec = parse("=== diagram {format=geml-chart data=log.jsonl type=bar x=t y=v}\n===",
    { resolveDoc: () => "[1,2]" });
  assert.deepEqual(nonrec.diagnostics.map((d) => d.code), ["chart-data-not-records"]);
});

test("chart: a row with an EMPTY y cell contributes no data point — skipped, not an error", () => {
  const d = parse("=== table {#t format=csv header=1}\nx,v\na,1\nb,\nc,2\n===\n\n=== diagram {format=geml-chart data=#t type=bar x=x y=v}\n===");
  assert.deepEqual(d.diagnostics, []);
  assert.deepEqual(d.children[1].chart.dataset.categories, ["a", "c"], "the empty row is absent");
  assert.deepEqual(d.children[1].chart.dataset.numbers.v, [1, 2]);
});

test("chart: an empty series cell labels its point with the empty string", () => {
  const d = parse("=== table {#t format=csv header=1}\nx,v,g\na,1,\n===\n\n=== diagram {format=geml-chart data=#t type=bar x=x y=v series=g}\n===");
  assert.deepEqual(d.diagnostics, []);
  assert.deepEqual(d.children[1].chart.dataset.seriesOf, [""]);
});

test("chart data=<https url>: a remote json source needs a named data block to defer on", () => {
  const d = parse("=== diagram {format=geml-chart data=https://x.com/y.json type=bar x=t y=v}\n===");
  assert.deepEqual(d.diagnostics.map((x) => x.code), ["bad-data-source"]);
});

test("schema= may name another document, with or without a fragment (§3.2)", () => {
  for (const s of ["other.geml", "other.geml#shape"]) {
    const d = parse(`=== data {format=json schema=${s}}\n1\n===`);
    assert.deepEqual(d.diagnostics.map((x) => x.code), ["unchecked-cross-document-reference"],
      `schema=${s} is a cross-doc reference, checked when a resolver exists`);
  }
});

console.log(`\n${passed} test(s) passed.`);
