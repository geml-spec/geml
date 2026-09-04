// GEP 0011: coordinates — the addresses that reach INSIDE a block. A table's
// rows, cells and columns, the reserved `[summary]` row, and a `data` block's
// value tree.
//
// Two layers are pinned here, because they fail differently: the selector's
// lexis (which decides what IS a coordinate, without touching a document) and
// the projection (which decides what a coordinate ANSWERS, from the model).
// The CLI cases at the end are the contract a reader actually pastes.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { parse } from "../dist/geml.js";
import { parseSelector, parseCoordPath } from "../dist/selector.js";
import { planCoordWrite, projectCoord } from "../dist/coord.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const dir = mkdtempSync(join(tmpdir(), "geml-coord-"));
const write = (name, s) => { const f = join(dir, name); writeFileSync(f, s); return f; };

const sel = (s) => parseSelector(s, () => undefined);
const block = (src, i = 0) => parse(src).children[i];

const FY = [
  '=== table {#fy format=csv header=1 compute="FY [%.1f] = Q1 + Q2" summary="Segment = \'Total\'; FY [%.1f] = sum(FY)"}',
  "Segment, Q1, Q2",
  "Cloud, 8, 10",
  "Edge, 3, 4",
  "===",
].join("\n");

const INTAKE = [
  "=== data {#intake format=json}",
  '{"sections": [{"title": "Account", "fields": ["email", "plan"]}], "version": "1.2.0"}',
  "===",
].join("\n");

// --- the selector's lexis ---------------------------------------------------

test("the three token species are told apart by lexis alone", () => {
  assert.deepEqual(parseCoordPath('[2]["Q1"]'), [{ kind: "index", n: 2 }, { kind: "key", name: "Q1" }]);
  assert.deepEqual(parseCoordPath("[summary]"), [{ kind: "word", name: "summary" }]);
  assert.deepEqual(parseCoordPath('["a b"]'), [{ kind: "key", name: "a b" }], "a quoted key may hold a space");
  assert.deepEqual(parseCoordPath("[ 2 ]"), [{ kind: "index", n: 2 }], "whitespace inside a step is allowed");
});

test("a coordinate selector splits into a base and a path", () => {
  const s = sel('#fy[2]["Q1"]');
  assert.equal(s.form, "coord");
  assert.equal(s.base, "#fy");
  assert.equal(s.path.length, 2);
  assert.equal(sel("#meta[\"version\"]").base, "#meta");
});

test("what is not a coordinate falls through to the id form, never to an error", () => {
  // `[` cannot occur in a conforming id (§4), so a tail that does not lex as a
  // path was never addressing a unit inside a block: the id path reports it,
  // with the message every missing id has always produced.
  for (const s of ["#fy[", "#fy[]", "#fy[2", '#fy["a]', "#fy[2]x", "#fy[-1]"]) {
    assert.equal(sel(s).form, "id", s);
  }
  assert.equal(parseCoordPath("[2]junk"), null);
  assert.equal(sel("#fy").form, "id");
  assert.equal(sel("L27").form, "line", "a position is still a position");
});

// --- projecting onto a table ------------------------------------------------

test("a row is 1-based over BODY rows, and carries the computed columns", () => {
  const r = projectCoord(block(FY), parseCoordPath("[1]"));
  assert.equal(r.ok, true);
  assert.equal(r.text, "Cloud, 8, 10, 18.0", "rejoined in the body form it was written in");
  assert.equal(r.json.length, 4);
  assert.equal(r.json[3].value, 18);
});

test("a cell answers its text, a column answers every body cell", () => {
  assert.equal(projectCoord(block(FY), parseCoordPath('[2]["Q1"]')).text, "3");
  assert.equal(projectCoord(block(FY), parseCoordPath('["FY"]')).text, "18.0\n7.0");
  assert.equal(projectCoord(block(FY), parseCoordPath('["FY"]')).json.length, 2);
});

test("[summary] is the reserved row name, and it is stable", () => {
  assert.equal(projectCoord(block(FY), parseCoordPath('[summary]["FY"]')).text, "25.0");
  const noSummary = block('=== table {#t format=csv header=1}\nA, B\n1, 2\n===');
  const r = projectCoord(noSummary, parseCoordPath("[summary]"));
  assert.equal(r.ok, false);
  assert.match(r.why, /no `summary=` foot row/);
});

test("a header-less table's letters ARE its column names — one namespace", () => {
  const b = block("=== table {#t format=csv header=0}\nCloud, 8\nEdge, 3\n===");
  assert.equal(projectCoord(b, parseCoordPath('[1]["A"]')).text, "Cloud");
  assert.equal(projectCoord(b, parseCoordPath('[2]["B"]')).text, "3");
});

test("a visual grid rejoins as a visual row, a tsv body on tabs", () => {
  const vis = block("=== table {#v}\n| Plan | N |\n|------|--:|\n| Org | 1 |\n===");
  assert.equal(projectCoord(vis, parseCoordPath("[1]")).text, "| Org | 1 |");
  const tsv = block("=== table {#t format=tsv header=1}\nA\tB\n1\t2\n===");
  assert.equal(projectCoord(tsv, parseCoordPath("[1]")).text, "1\t2");
});

test("every table refusal says which part of the coordinate has no answer", () => {
  const cases = [
    ["[0]", /starts at 1/],
    ["[9]", /2 body rows/],
    ['["Nope"]', /no column `Nope`/],
    ["[bogus]", /only reserved row name/],
    ['["FY"]["x"]', /a column takes no further step/],
    ['[1]["Q1"]["x"]', /a cell takes no further step/],
    ["[1][2]", /a step names a column/],
  ];
  for (const [path, re] of cases) {
    const r = projectCoord(block(FY), parseCoordPath(path));
    assert.equal(r.ok, false, path);
    assert.match(r.why, re, path);
  }
});

// --- projecting onto a value tree -------------------------------------------

test("a value tree walks by key and by index, and a string leaf stays raw", () => {
  const b = block(INTAKE);
  assert.equal(projectCoord(b, parseCoordPath('["version"]')).text, "1.2.0");
  assert.equal(projectCoord(b, parseCoordPath('["sections"][0]["fields"][1]')).text, "plan");
  const map = projectCoord(b, parseCoordPath('["sections"][0]'));
  assert.equal(map.text, '{"title":"Account","fields":["email","plan"]}');
  assert.equal(map.json.title, "Account");
});

test("a value tree refuses the wrong species, and says what it stepped into", () => {
  const b = block(INTAKE);
  for (const [path, re] of [
    ["[0]", /names a position, but what it steps into is a map/],
    ['["sections"]["x"]', /names a key, but what it steps into is a sequence/],
    ['["nope"]', /no key `nope` at the root/],
    ['["sections"][7]', /out of range: that sequence has 1 element/],
    ["[summary]", /no reserved names/],
  ]) {
    const r = projectCoord(b, parseCoordPath(path));
    assert.equal(r.ok, false, path);
    assert.match(r.why, re, path);
  }
});

test("a block with nothing addressable inside says so", () => {
  const r = projectCoord(block('=== code {#c lang=sh}\nls\n==='), parseCoordPath("[1]"));
  assert.equal(r.ok, false);
  assert.match(r.why, /carries no addressable units/);
});

// --- the CLI contract -------------------------------------------------------

const DOC = `=== meta\ntitle = "T"\n===\n\n${FY}\n\n${INTAKE}\n`;

test("geml get answers a coordinate, and --json answers the model node", () => {
  const f = write("d.geml", DOC);
  assert.equal(run(["get", f, '#fy[2]["Q1"]']).out, "3\n");
  assert.equal(run(["get", f, '#intake["version"]']).out, "1.2.0\n");
  const j = JSON.parse(run(["get", f, '#fy[1]["FY"]', "--json"]).out);
  assert.deepEqual(j, { text: "18.0", value: 18 });
});

test("a coordinate onto a missing block is still the missing-id error", () => {
  const f = write("d2.geml", DOC);
  const r = run(["get", f, '#nope[1]["Q1"]']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `nope`/);
});

test("a refused coordinate exits 1 and quotes the address the reader wrote", () => {
  const f = write("d3.geml", DOC);
  const r = run(["get", f, "#fy[9]"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /`#fy\[9\]`: this table has 2 body rows/);
});

test("--head and --view are usage errors on a coordinate, not silent no-ops", () => {
  const f = write("d4.geml", DOC);
  for (const flag of ["--head", "--body", "--intro"]) {
    const r = run(["get", f, "#fy[1]", flag]);
    assert.equal(r.code, 2, flag);
    assert.match(r.err, /names part of a BLOCK/, flag);
  }
  const v = run(["get", f, "#fy[1]", "--view"]);
  assert.equal(v.code, 2);
  assert.match(v.err, /--view reads THROUGH an embed/);
});

test("a command that takes a BLOCK address refuses a coordinate outright", () => {
  // `set` understands one (below); every other command acts on a block's SPAN,
  // and resolving the base and carrying on would have meant operating on the
  // whole table while the reader had named one cell of it. Refused in
  // selectUnits, so no call site can forget.
  const f = write("d5.geml", DOC);
  const r = spawnSync(
    process.execPath,
    ["dist/geml.js", "replace", f, "Cloud", "Nimbus", "--within", "#fy[1]"],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(r.status, 2, "a usage error, not a wider edit");
  assert.match(r.stderr, /addresses a unit INSIDE a block/);
  assert.match(r.stderr, /write `#fy` for the whole block/);
  assert.equal(readFileSync(f, "utf8"), DOC, "and the document is untouched");
});

// --- writing (GEP 0011) -----------------------------------------------------

const WDOC = [
  '=== table {#fy format=csv header=1 compute="FY [%.1f] = Q1 + Q2"}',
  "Segment, Q1, Q2",
  "Cloud, 8, 10",
  "Edge, 3, 4",
  "===",
  "",
  "=== table {#v}",
  "| Plan | N |",
  "|------|--:|",
  "| Org | 1 |",
  "===",
  "",
  "=== data {#cfg format=json}",
  '{"version": "1.2.0", "retries": 1}',
  "===",
  "",
  "=== table {#borrow src=#fy}",
  "===",
  "",
  "trailing prose that must not move.",
  "",
].join("\n");

function setCoord(name, selector, value) {
  const f = write(name, WDOC);
  const r = spawnSync(
    process.execPath,
    ["dist/geml.js", "set", f, selector, "-o", f],
    { input: value, encoding: "utf8", timeout: 60_000 },
  );
  return { code: r.status ?? 1, err: r.stderr ?? "", text: readFileSync(f, "utf8") };
}

test("a cell write changes one field and keeps the row's own spacing", () => {
  const r = setCoord("w1.geml", '#fy[2]["Q1"]', "9");
  assert.equal(r.code, 0, r.err);
  assert.match(r.text, /^Edge, 9, 4$/m, "the delimiter's spacing survives");
  assert.match(r.text, /^Cloud, 8, 10$/m, "the row above is untouched");
  assert.match(r.text, /trailing prose that must not move\./, "and so is the rest of the document");
});

test("a visual grid's cell write rebuilds that row and no other line", () => {
  const r = setCoord("w2.geml", '#v[1]["Plan"]', "Framework");
  assert.equal(r.code, 0, r.err);
  assert.match(r.text, /^\| Framework \| 1 \|$/m);
  assert.match(r.text, /^\|------\|--:\|$/m, "the separator row is left alone");
});

test("a whole row may be written as one line", () => {
  const r = setCoord("w3.geml", "#fy[1]", "Cloud, 80, 100");
  assert.equal(r.code, 0, r.err);
  assert.match(r.text, /^Cloud, 80, 100$/m);
  assert.match(r.text, /^Edge, 3, 4$/m);
});

test("a value-tree write re-serializes the body, and reads JSON as JSON", () => {
  const str = setCoord("w4.geml", '#cfg["version"]', "1.3.0");
  assert.equal(str.code, 0, str.err);
  assert.match(str.text, /"version": "1\.3\.0"/, "not valid JSON, so a string");
  const num = setCoord("w5.geml", '#cfg["retries"]', "5");
  assert.match(num.text, /"retries": 5/, "valid JSON, so a number");
  const made = setCoord("w6.geml", '#cfg["added"]', "true");
  assert.match(made.text, /"added": true/, "a key that did not exist is created");
});

test("every write refusal exits 1 and leaves the document byte-identical", () => {
  const cases = [
    ['#fy[1]["FY"]', "X", /produced by `compute=`/],
    ['#borrow[1]["Q1"]', "X", /arrive through `src=`/],
    ['#fy[1]["Segment"]', "a, b", /contains `,`, the delimiter/],
    ['#v[1]["Plan"]', "a|b", /contains `\|`/],
    ['#fy[summary]["Q1"]', "X", /declared in `summary=`/],
    ['#fy["Q1"]', "X", /a column is one unit per row/],
    ['#fy[9]["Q1"]', "X", /2 body rows/],
    ["#fy[1]", "one\ntwo", /a row is one line/],
  ];
  cases.forEach(([selector, value, re], i) => {
    const r = setCoord(`r${i}.geml`, selector, value);
    assert.equal(r.code, 1, `${selector}: ${r.err}`);
    assert.match(r.err, re, selector);
    assert.equal(r.text, WDOC, `${selector}: nothing was written`);
  });
});

test("--body and a coordinate are mutually exclusive, as a usage error", () => {
  const f = write("w7.geml", WDOC);
  const r = spawnSync(
    process.execPath,
    ["dist/geml.js", "set", f, "#fy[1]", "--body", "-o", f],
    { input: "X\n", encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /names part of a BLOCK/);
  assert.equal(readFileSync(f, "utf8"), WDOC);
});

// --- `#meta`, the merged namespace (GEP 0011) -------------------------------

const MDOC = [
  "=== meta",
  'title = "First"',
  'version = "1.2.0"',
  "===",
  "",
  "# H {#h}",
  "",
  "x",
  "",
  "=== meta",
  'version = "9.9.9"',
  'owner = "ops"',
  "===",
  "",
].join("\n");

function cli(args, input) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("#meta reads the merged view, first definition winning (§4)", () => {
  const f = write("m1.geml", MDOC);
  assert.equal(cli(["get", f, '#meta["version"]']).out, "1.2.0\n", "the later definition is ignored");
  assert.equal(cli(["get", f, '#meta["owner"]']).out, "ops\n", "a key only the second block defines still resolves");
  const view = JSON.parse(cli(["get", f, "#meta", "--json"]).out);
  assert.deepEqual(view, { title: "First", version: "1.2.0", owner: "ops" });
  assert.match(cli(["get", f, "#meta"]).out, /^title = "First"$/m, "and bare #meta answers the view, not bytes");
});

test("a write lands on the definition in force, and a new key on the first block", () => {
  const v = write("m2.geml", MDOC);
  assert.equal(cli(["set", v, '#meta["version"]', "-o", v], "2.0.0").code, 0);
  const after = readFileSync(v, "utf8");
  assert.match(after, /title = "First"\r?\nversion = "2\.0\.0"/, "the first block owned it");
  assert.match(after, /version = "9\.9\.9"/, "the shadowed definition is left as the author wrote it");

  const o = write("m3.geml", MDOC);
  cli(["set", o, '#meta["owner"]', "-o", o], "sre");
  assert.match(readFileSync(o, "utf8"), /owner = "sre"/);
  assert.match(readFileSync(o, "utf8"), /title = "First"/, "the first block is untouched");

  const n = write("m4.geml", MDOC);
  cli(["set", n, '#meta["draft"]', "-o", n], "true");
  const created = readFileSync(n, "utf8");
  assert.match(created, /version = "1\.2\.0"\r?\ndraft = true/, "created in the first block, and true is a boolean");
});

test("`{#meta}` is an error only where it could disagree with the view", () => {
  const two = write("m5.geml", '=== meta {#meta}\ntitle = "A"\n===\n\n=== meta\nx = 1\n===\n\n# H {#h}\n\ny\n');
  const r = cli(["check", two]);
  assert.equal(r.code, 1);
  assert.match(r.err + r.out, /`#meta` is reserved/);

  const one = write("m6.geml", '=== meta {#meta}\ntitle = "A"\n===\n\n# H {#h}\n\ny\n');
  assert.equal(cli(["check", one]).code, 0, "one meta block: the id and the view mean the same thing");
});

test("a meta coordinate takes one quoted key and nothing deeper", () => {
  const f = write("m7.geml", MDOC);
  const r = cli(["set", f, '#meta["a"]["b"]', "-o", f], "X");
  assert.equal(r.code, 1);
  assert.match(r.err, /one quoted key, and nothing deeper/);
  assert.equal(readFileSync(f, "utf8"), MDOC);
});

// --- references (GEP 0011) --------------------------------------------------

const VARS = ['=== meta', 'title = "Vars"', "===", "", "=== data {#vars format=json}", '{"version": "1.2.0"}', "===", ""].join("\n");
const RDOC = [
  "=== meta",
  'title = "Doc"',
  "===",
  "",
  "=== table {#fy format=csv header=1}",
  "Segment, Q1",
  "Cloud, 8",
  "===",
  "",
  "# H {#h}",
  "",
  'Q1 is [[#fy[1]["Q1"]]], the version is [[vars.geml#vars["version"]]], the title',
  'is [[#meta["title"]]], and projected: ![[#fy[1]["Q1"]]].',
  "",
].join("\n");

test("a coordinate reference is checked, and resolves across documents", () => {
  write("vars.geml", VARS);
  const f = write("ref.geml", RDOC);
  const r = cli(["check", "--root", dir, f]);
  assert.equal(r.code, 0, r.err + r.out);
});

test("a coordinate a reference cannot reach is a build error naming the reason", () => {
  write("vars.geml", VARS);
  for (const [anchor, re] of [
    ['#fy[9]["Q1"]', /1 body row/],
    ['#fy[1]["Nope"]', /no column `Nope`/],
    ['#nope[1]["Q1"]', /unresolved reference `#nope`/],
    ['vars.geml#vars["missing"]', /no key `missing`/],
  ]) {
    const f = write("bad.geml", RDOC.replace('#fy[1]["Q1"]]], the version', `${anchor}]], the version`));
    const r = cli(["check", "--root", dir, f]);
    assert.equal(r.code, 1, anchor);
    assert.match(r.err + r.out, re, anchor);
  }
});

test("a coordinate reference says its value and links to the block holding it", () => {
  write("vars.geml", VARS);
  const f = write("ref2.geml", RDOC);
  const md = cli([f, "--to", "md", "--root", dir]).out;
  assert.match(md, /Q1 is \[8\]\(#fy\)/, "the value is the link text, the block is the target");
  assert.match(md, /\[1\.2\.0\]\(vars\.geml#vars\)/, "across documents too");
  assert.match(md, /the title\nis Doc,/, "`#meta` is a merged view with no anchor, so it renders as text");
  assert.match(md, /projected: 8\./, "an inline projection is the value alone");
});

test("the resolved value and base reach the model, for every renderer to read", () => {
  write("vars.geml", VARS);
  const f = write("ref3.geml", RDOC);
  const doc = JSON.parse(cli([f, "--to", "json", "--root", dir]).out);
  const found = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.type === "autoref" || n.type === "project") found.push(n);
    for (const k of Object.keys(n)) walk(n[k]);
  })(doc);
  const cell = found.find((n) => n.anchor === 'fy[1]["Q1"]' && n.type === "autoref");
  assert.equal(cell.value, "8");
  assert.equal(cell.base, "fy");
  const meta = found.find((n) => n.anchor === 'meta["title"]');
  assert.equal(meta.value, "Doc");
  assert.equal(meta.base, undefined, "no block, so nothing to link to");
});

// --- the write paths a first pass left uncovered -----------------------------
// Found by reading coverage rather than by reading the code: every one of these
// is a branch a reader could reach and no test did.

test("a sequence element is written by position, and out of range is refused", () => {
  const doc = '=== data {#cfg format=json}\n{"tags": ["doc", "spec"]}\n===\n\n# H {#h}\n\nx\n';
  const f = write("s1.geml", doc);
  const ok = cli(["set", f, '#cfg["tags"][1]', "-o", f], "guide");
  assert.equal(ok.code, 0, ok.err);
  assert.match(readFileSync(f, "utf8"), /"tags": \[\s*"doc",\s*"guide"\s*\]/);

  const g = write("s2.geml", doc);
  const bad = cli(["set", g, '#cfg["tags"][7]', "-o", g], "x");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /out of range: that sequence has 2 elements/);
  assert.match(bad.err, /`set` replaces a unit, it does not append/);
  assert.equal(readFileSync(g, "utf8"), doc);
});

test("a `jsonl` body is written back one compact record per line", () => {
  const f = write("s3.geml", '=== data {#log format=jsonl}\n{"n":1}\n{"n":2}\n===\n\n# H {#h}\n\nx\n');
  const r = cli(["set", f, "#log[1][\"n\"]", "-o", f], "9");
  assert.equal(r.code, 0, r.err);
  const body = readFileSync(f, "utf8");
  assert.match(body, /^\{"n":1\}$/m, "the record it did not touch keeps its shape");
  assert.match(body, /^\{"n":9\}$/m, "and the one it did is still one line");
});

test("a `meta` block with an id of its own is written by key, like `#meta`", () => {
  const doc = '=== meta {#m}\ntitle = "A"\n===\n\n# H {#h}\n\nx\n';
  const f = write("s4.geml", doc);
  const r = cli(["set", f, '#m["title"]', "-o", f], "B");
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(f, "utf8"), /title = "B"/);

  const g = write("s5.geml", doc);
  const deep = cli(["set", g, '#m["a"]["b"]', "-o", g], "X");
  assert.equal(deep.code, 1);
  assert.match(deep.err, /one quoted key, and nothing deeper/);
  assert.equal(readFileSync(g, "utf8"), doc);
});

test("a multi-line meta value is refused, and a new key lands before the trailing blank", () => {
  const f = write("s6.geml", '=== meta {#m}\ntitle = "A"\n\n===\n\n# H {#h}\n\nx\n');
  const bad = cli(["set", f, '#m["title"]', "-o", f], "one\ntwo\n");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /a meta value is one line/);

  const ok = cli(["set", f, '#m["owner"]', "-o", f], "ops");
  assert.equal(ok.code, 0, ok.err);
  assert.match(readFileSync(f, "utf8"), /title = "A"\r?\nowner = "ops"\r?\n\r?\n===/, "appended after the last key, not after the blank");
});

test("a coordinate onto something with no units inside says which kind it was", () => {
  const f = write("s7.geml", '# Heading {#h}\n\nprose\n\n=== code {#c lang=sh}\nls\n===\n');
  const heading = cli(["get", f, "#h[1]"]);
  assert.equal(heading.code, 1);
  assert.match(heading.err, /a coordinate addresses a unit inside a table or a `data` block/);
  const code = cli(["get", f, "#c[1]"]);
  assert.equal(code.code, 1);
  assert.match(code.err, /`code` carries no addressable units/);
});

test("the projection and the plan both refuse an empty path, and a non-block", () => {
  // Unreachable through the CLI — a selector with no `[…]` step is not a
  // coordinate at all — but these are exported functions, and a caller that
  // builds a path itself deserves the sentence rather than a crash.
  assert.match(projectCoord(block(FY), []).why, /needs at least one/);
  assert.match(planCoordWrite(block(FY), [], "x", []).why, /needs at least one/);
  const heading = parse("# H {#h}\n\nx\n").children[0];
  assert.match(planCoordWrite(heading, parseCoordPath("[1]"), "x", []).why, /`heading` has none/);
});

test("`#meta` merges a `meta` block nested in flow content, as interpolation does", () => {
  // The parser's own meta merge descends into flow bodies, so this one must
  // too — otherwise `{{key}}` and `#meta["key"]` would disagree about the same
  // document.
  const f = write("m8.geml", '=== note {#n}\n=== meta\nowner = "ops"\n===\nprose\n===\n\n# H {#h}\n\nx\n');
  assert.equal(cli(["get", f, '#meta["owner"]']).out, "ops\n");
});

test("an empty `meta` block contributes nothing and breaks nothing", () => {
  const f = write("m9.geml", '=== meta\n===\n\n=== meta\ntitle = "T"\n===\n\n# H {#h}\n\nx\n');
  assert.equal(cli(["get", f, '#meta["title"]']).out, "T\n");
});

test("a value-tree WRITE refuses the same wrong turns a read does", () => {
  // The write walks to the target's parent, so every step but the last has its
  // own way of being wrong — and a refusal there must leave the file alone.
  const doc = '=== data {#cfg format=json}\n{"tags": ["doc"], "version": "1.2.0", "n": 1}\n===\n\n# H {#h}\n\nx\n';
  const cases = [
    ['#cfg["nope"]["x"]', /no key `nope` at the root/],
    ['#cfg["version"]["x"]', /names a key, but what it steps into is a string/],
    ['#cfg["tags"]["x"]', /names a key, but what it steps into is a sequence/],
    ['#cfg[0]["x"]', /names a position, but what it steps into is a map/],
    ['#cfg["tags"][9]["x"]', /out of range: that sequence has 1 element/],
    ["#cfg[summary]", /a value tree has no reserved names/],
    ['#cfg["version"][0]', /names a position, but what it steps into is a string/],
    ['#cfg["tags"]["k"]', /names a key, but what it steps into is a sequence/],
  ];
  cases.forEach(([selector, re], i) => {
    const f = write(`vw${i}.geml`, doc);
    const r = cli(["set", f, selector, "-o", f], "X");
    assert.equal(r.code, 1, `${selector}: ${r.err}`);
    assert.match(r.err, re, selector);
    assert.equal(readFileSync(f, "utf8"), doc, `${selector}: untouched`);
  });
});

test("a `data` block with no value tree says WHICH reason it has none", () => {
  // `format=` is declared, never sniffed (GEP-0005). This processor parses
  // `json` (the default), `jsonl` and `yaml`; `toml` is a reserved name it has
  // no engine for, and an unknown format is kept raw too — so those two have no
  // value tree at all, and "no addressable units" would hide which case a
  // reader is in.
  const reserved = projectCoord(block('=== data {#y format=toml}\na = 1\n==='), parseCoordPath('["a"]'));
  assert.equal(reserved.ok, false);
  assert.match(reserved.why, /declares `format=toml`, which this processor keeps raw/);

  const broken = projectCoord(block('=== data {#b format=json}\n{not json\n==='), parseCoordPath('["a"]'));
  assert.equal(broken.ok, false);
  assert.match(broken.why, /did not parse as `json`/);

  // A yaml body has a value tree like any other, so coordinates walk it.
  const cfg = block("=== data {#cfg format=yaml}\nlimits:\n  rows: 100\n===");
  assert.equal(projectCoord(cfg, parseCoordPath('["limits"]["rows"]')).text, "100");

  // A jsonl body is always a SEQUENCE, so its first step is an index.
  const log = block('=== data {#log format=jsonl}\n{"n":1}\n{"n":2}\n===');
  assert.equal(projectCoord(log, parseCoordPath('[1]["n"]')).text, "2");
  assert.match(projectCoord(log, parseCoordPath('["n"]')).why, /steps into is a sequence/);
});

test("stepping into null, a number or a boolean names what it found", () => {
  const b = block('=== data {#d format=json}\n{"nothing": null, "n": 7, "on": true, "list": [null]}\n===');
  const cases = [
    ['["nothing"]["x"]', /steps into is null/],
    ['["n"]["x"]', /steps into is a number/],
    ['["on"]["x"]', /steps into is a boolean/],
    ['["nothing"][0]', /names a position, but what it steps into is null/],
    ['["list"][0]["x"]', /steps into is null/],
  ];
  for (const [path, re] of cases) {
    const r = projectCoord(b, parseCoordPath(path));
    assert.equal(r.ok, false, path);
    assert.match(r.why, re, path);
  }
  // and the same turns, on the write path's walk
  const doc = '=== data {#d format=json}\n{"nothing": null, "n": 7}\n===\n\n# H {#h}\n\nx\n';
  const f = write("nl.geml", doc);
  const r = cli(["set", f, '#d["nothing"]["x"]', "-o", f], "X");
  assert.equal(r.code, 1);
  assert.match(r.err, /steps into is null/);
  assert.equal(readFileSync(f, "utf8"), doc);
});

test("a custom delimiter is honoured on a read and on a write", () => {
  const doc = [
    '=== table {#semi format=csv header=1 delim=";"}',
    "Segment; Q1",
    "Cloud; 8",
    "===",
    "",
    "# H {#h}",
    "",
    "x",
    "",
  ].join("\n");
  assert.equal(projectCoord(block(doc), parseCoordPath("[1]")).text, "Cloud; 8", "a row rejoins on its own delimiter");

  const f = write("s9.geml", doc);
  assert.equal(cli(["set", f, '#semi[1]["Q1"]', "-o", f], "9").code, 0);
  assert.match(readFileSync(f, "utf8"), /^Cloud; 9$/m);

  const g = write("s10.geml", doc);
  const bad = cli(["set", g, '#semi[1]["Segment"]', "-o", g], "a;b");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /contains `;`, the delimiter/);
  assert.equal(readFileSync(g, "utf8"), doc);
});

test("a `format` that is not a string parses as a visual grid, as §6 says", () => {
  // Attributes are document-controlled: `format=1` is a legal thing to write,
  // and the answer has to be "not a string" rather than a cast.
  const b = block("=== table {#t format=1}\n| A | B |\n|---|---|\n| 1 | 2 |\n===");
  assert.equal(projectCoord(b, parseCoordPath("[1]")).text, "| 1 | 2 |");
});

test("a letter addresses a column positionally, even when the table has headers", () => {
  // The one column namespace `compute=` uses is name-THEN-letter, so `["A"]`
  // reaches the first column of a headered table too. Claimed in GEP 0011 and,
  // until coverage said so, never exercised: a header-less table's letters ARE
  // its names, so the fallback had never run.
  const b = block(FY);
  assert.equal(projectCoord(b, parseCoordPath('[1]["A"]')).text, "Cloud");
  assert.equal(projectCoord(b, parseCoordPath('[2]["B"]')).text, "3");
  const past = projectCoord(b, parseCoordPath('[1]["Z"]'));
  assert.equal(past.ok, false, "a letter past the last column is still an unknown column");
});

test("a value-tree step into a scalar says what it stepped into", () => {
  const r = projectCoord(block(INTAKE), parseCoordPath('["version"]["x"]'));
  assert.equal(r.ok, false);
  assert.match(r.why, /names a key, but what it steps into is a string/);
});

test("the write path refuses a bogus reserved row and a block with no units", () => {
  const doc = FY + "\n\n=== code {#c lang=sh}\nls\n===\n\n# H {#h}\n\nx\n";
  const f = write("s8.geml", doc);
  const bogus = cli(["set", f, "#fy[bogus]", "-o", f], "X");
  assert.equal(bogus.code, 1);
  assert.match(bogus.err, /only reserved row name/);
  const code = cli(["set", f, "#c[1]", "-o", f], "X");
  assert.equal(code.code, 1);
  assert.match(code.err, /`code` carries no addressable units/);
  assert.equal(readFileSync(f, "utf8"), doc, "neither wrote anything");
});

test("every wrong turn a READ can take names what it found, and where", () => {
  // The refusal sentences ARE the interface: `geml get` prints `why` verbatim,
  // so an agent's next move is decided by this wording. Each one below was
  // reachable and unasserted, which is how a message rots into nonsense.
  const fy = block(FY);
  const intake = block(INTAKE);
  const miss = (b, p) => {
    const r = projectCoord(b, parseCoordPath(p));
    assert.equal(r.ok, false, `${p}: expected a refusal`);
    return r.why;
  };

  // A table's rows are 1-based over the BODY, so both ends say so by name.
  assert.match(miss(fy, "[0]"), /a row index starts at 1 \(the header is not a row\)/);
  assert.match(miss(fy, "[9]"), /this table has 2 body rows, so `\[9\]` addresses nothing/);
  assert.match(miss(block(FY.replace("\nEdge, 3, 4", "")), "[9]"), /has 1 body row,/, "singular for a one-row table");

  // Inside a row, only a column name means anything.
  assert.match(miss(fy, "[1][2]"), /inside a row, a step names a column: write `\["<column>"\]`/);
  assert.match(miss(fy, '[1]["Q1"]["deeper"]'), /a cell takes no further step/);
  assert.match(miss(fy, '[1]["Nope"]'), /this table has no column `Nope` \(it has `Segment`, `Q1`, `Q2`, `FY`\)/);

  // A value tree says whether the key was missing at the root or below it.
  assert.match(miss(intake, '["nope"]'), /no key `nope` at the root of this value tree/);
  assert.match(miss(intake, '["sections"][0]["nope"]'), /no key `nope` at `\["sections"\]\[0\]`/);
  assert.match(miss(intake, '["sections"][9]'), /is out of range: that sequence has 1 element$/m,
    "singular, because one element is one element");
  assert.match(miss(block('=== data {#s format=json}\n{"a": [1, 2]}\n==='), '["a"][5]'), /has 2 elements/);

  // A `data` block with NO format= is json by default, so a body that does not
  // parse says json — the name the author never wrote.
  assert.match(miss(block("=== data {#b}\n{not json\n==="), '["a"]'), /did not parse as `json`/);
});

test("every wrong turn a WRITE can take refuses BEFORE touching the body", () => {
  const plan = (b, p, v, body) => {
    const r = planCoordWrite(b, parseCoordPath(p), v, body);
    assert.equal(r.ok, false, `${p}: expected a refusal`);
    return r.why;
  };
  const fyBody = ["Segment, Q1, Q2", "Cloud, 8, 10", "Edge, 3, 4"];
  const fy = block(FY);

  assert.match(plan(fy, "[0]", "x", fyBody), /a row index starts at 1/);
  assert.match(plan(fy, "[9]", "x", fyBody), /this table has 2 body rows/);
  assert.match(plan(fy, "[1][2]", "x", fyBody), /inside a row, a step names a column/);
  assert.match(plan(fy, '[1]["Q1"]["deeper"]', "x", fyBody), /a cell takes no further step/);
  assert.match(plan(fy, '[1]["Nope"]', "x", fyBody), /this table has no column `Nope`/);

  // A delimited body splits and does nothing more — §6 does not dequote — so a
  // value carrying the delimiter would turn one cell into two and shift the
  // rest. Both delimiters are named the way a reader can see them.
  assert.match(plan(fy, '[1]["Q1"]', "8, 9", fyBody), /that value contains `,`, the delimiter this body splits on/);
  const tsv = block('=== table {#t format=tsv header=1}\nA\tB\n1\t2\n===');
  assert.match(plan(tsv, '[1]["B"]', "a\tb", ["A\tB", "1\t2"]), /that value contains a tab, the delimiter/);

  // A row shorter than the header has nothing at that column to write into,
  // even though the MODEL pads it so a read answers empty.
  const short = block("=== table {#s format=csv header=1}\nA, B, C\n1, 2\n===");
  assert.match(plan(short, '[1]["C"]', "x", ["A, B, C", "1, 2"]), /row 1 has 2 fields, so column 3 has nothing to write/);

  // A value tree's own refusals, on the last step (the read walk covers the
  // steps above it, and both must agree about what a wrong turn is called).
  const intake = block(INTAKE);
  const iBody = [INTAKE.split("\n")[1]];
  assert.match(plan(intake, '["sections"][9]', "x", iBody), /is out of range: that sequence has 1 element/);
  assert.match(plan(intake, '["version"]["deeper"]', "x", iBody), /names a key, but what it steps into is a string/);

  // A reserved format with no engine, and a format the author never wrote.
  assert.match(plan(block("=== data {#t format=toml}\na = 1\n==="), '["a"]', "2", ["a = 1"]),
    /declares `format=toml`, which this processor keeps raw/);
  const plain = block('=== data {#d}\n{"a": 1}\n===');
  const ok = planCoordWrite(plain, parseCoordPath('["a"]'), "2", ['{"a": 1}']);
  assert.equal(ok.ok, true, "and with no format= at all, json is the default it writes back");
  assert.deepEqual(ok.body, ["{", '  "a": 2', "}"]);
});

console.log(`\n${passed} test(s) passed.`);
