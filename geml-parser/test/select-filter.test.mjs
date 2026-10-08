// Attribute filters and `--within` — the two things block selectors borrowed
// from mq's query language, kept inside §2's one rule that a selector is a
// FILTER (design: docs/design/specs/2026-08-04-geml-get-set-selector-design-change.md).
//
// `{…}` holding keys other than a lone `#id` or `@<hex>` filters by them: a unit
// matches when its own attribute object carries every key given, with the same
// value. `--within <selector>` narrows get, list and find to the blocks another
// selector names, as it already narrowed `replace`.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { addressedUnits } from "../dist/geml.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args, cwd) {
  const r = spawnSync(process.execPath, [join(process.cwd(), "dist", "geml.js"), ...args], { encoding: "utf8", timeout: 60_000, ...(cwd ? { cwd } : {}) });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dir = mkdtempSync(join(tmpdir(), "geml-select-filter-"));
const write = (name, s) => { const f = join(dir, name); writeFileSync(f, s); return f; };

const DOC =
  "# 安装 {#install .guide}\n\n" +
  "运行安装脚本。\n\n" +
  "=== code {#py1 lang=py}\nprint(1)\n===\n\n" +
  "=== code {#sh1 lang=sh .run}\necho 1\n===\n\n" +
  "# 升级 {#upgrade}\n\n" +
  "=== code {lang=py .run}\nprint(2)\n===\n\n" +
  "=== note {#warn .x title=\"a b\"}\n注意\n===\n\n" +
  "=== table {#t format=csv header=1}\na\n1\n===\n";
const f = write("doc.geml", DOC);
const blocks = (out) => out.split("\n").filter((l) => /^(===|#) /.test(l) && l !== "===");

// ---------------------------------------------------------------------------
// attribute filters
// ---------------------------------------------------------------------------

test("`=== code {lang=py}` answers every py code block, in document order, and says how many", () => {
  const r = run(["get", f, "=== code {lang=py}"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(blocks(r.out), ["=== code {#py1 lang=py}", "=== code {lang=py .run}"]);
  assert.match(r.err, /2 `code` blocks/);
  assert.equal(run(["get", f, "{lang=py}"]).out, r.out, "without a type the filter reads every typed block");
});

test("every key must hold: classes, an id beside a class, a quoted value, a number", () => {
  assert.deepEqual(blocks(run(["get", f, "{.run}"]).out), ["=== code {#sh1 lang=sh .run}", "=== code {lang=py .run}"]);
  assert.deepEqual(blocks(run(["get", f, "=== code {lang=py .run}"]).out), ["=== code {lang=py .run}"], "two keys mean both");
  assert.deepEqual(blocks(run(["get", f, "{#warn .x}"]).out), ['=== note {#warn .x title="a b"}']);
  assert.equal(run(["get", f, "{#warn .nope}"]).code, 1, "the id alone is not enough");
  assert.deepEqual(blocks(run(["get", f, '{title="a b"}']).out), ['=== note {#warn .x title="a b"}'], "a value with a space is quoted, as in the document");
  assert.deepEqual(blocks(run(["get", f, "{header=1}"]).out), ["=== table {#t format=csv header=1}"], "a number compares as the number it is");
});

test("a heading carries its attributes too; a type prefix leaves headings out", () => {
  const r = run(["get", f, "{.guide}"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# 安装 \{#install \.guide\}/, "the heading answers with its whole section");
  const typed = run(["get", f, "=== note {.guide}"]);
  assert.equal(typed.code, 1);
  assert.match(typed.err, /no block matching `=== note \{\.guide\}`/);
});

test("no match is a lookup failure (exit 1); braces naming nothing are a usage error (exit 2)", () => {
  const miss = run(["get", f, "{lang=rust}"]);
  assert.equal(miss.code, 1);
  assert.match(miss.err, /no block matching `\{lang=rust\}` in .*doc\.geml/);
  const none = run(["get", f, "=== code {}"]);
  assert.equal(none.code, 2);
  assert.match(none.err, /names no key/);
});

test("set through an attribute filter: one match is written, several are refused", () => {
  const g = write("set.geml", DOC);
  const repl = write("set-new.geml", '=== note {#warn .x title="a b"}\n改过了\n===\n');
  const one = run(["set", g, "{title=\"a b\"}", "--in", repl]);
  assert.equal(one.code, 0, one.err);
  assert.match(readFileSync(g, "utf8"), /改过了/);
  const many = run(["set", g, "=== code {lang=py}", "--in", repl]);
  assert.equal(many.code, 2, many.err);
  assert.match(readFileSync(g, "utf8"), /print\(1\)[\s\S]*print\(2\)/, "nothing else was touched");
});

test("a content key beside an id is one more condition: the write goes through while the content is the one read", () => {
  const g = write("guard.geml", "=== note {#warn}\nold text\n===\n\n=== note\nother\n===\n");
  const listed = run(["list", g]).out;
  assert.match(listed, /^#warn /m);
  // The listing prints #warn by id; its content address is the one `@<hex>`
  // the CLI computes over the same span.
  const hex = addressedUnits(readFileSync(g, "utf8")).find((a) => a.unit.id === "warn").hex;
  assert.match(hex, /^[0-9a-f]{8}$/);
  const sel = `=== note@${hex} {#warn}`;
  assert.equal(run(["get", g, sel]).code, 0, "id and content both hold");
  assert.equal(run(["get", g, "=== note@deadbeef {#warn}"]).code, 1, "the id alone is not enough");
  const repl = write("guard-new.geml", "=== note {#warn}\nnew text\n===\n");
  const first = run(["set", g, sel, "--in", repl]);
  assert.equal(first.code, 0, first.err);
  const second = run(["set", g, sel, "--in", repl]);
  assert.equal(second.code, 1, "the content changed, so the same selector names nothing now");
  assert.match(second.err, /no block matching/);
});

// ---------------------------------------------------------------------------
// --within
// ---------------------------------------------------------------------------

test("get --within keeps the matches inside the named section", () => {
  assert.deepEqual(blocks(run(["get", f, "=== code", "--within", "#install"]).out), ["=== code {#py1 lang=py}", "=== code {#sh1 lang=sh .run}"]);
  assert.deepEqual(blocks(run(["get", f, "{lang=py}", "--within", "#upgrade"]).out), ["=== code {lang=py .run}"]);
  const none = run(["get", f, "=== table", "--within", "#install"]);
  assert.equal(none.code, 1);
  assert.match(none.err, /no block matching `=== table` inside `#install`/);
  const gone = run(["get", f, "=== code", "--within", "#nope"]);
  assert.equal(gone.code, 1, "a scope that names nothing fails the way that selector fails anywhere");
  assert.match(gone.err, /no block with id `nope`/);
});

test("get --within with no selector lists the scope; list --within does the same", () => {
  const listed = run(["list", f, "--within", "#install"]);
  assert.equal(listed.code, 0, listed.err);
  assert.deepEqual(listed.out.trim().split("\n").map((l) => l.split(/\s+/)[0]), ["#install-before-py1", "#py1", "#sh1"]);
  assert.equal(run(["get", f, "--within", "#install"]).out, listed.out);
  const json = JSON.parse(run(["list", f, "--json", "--within", "#upgrade"]).out);
  assert.deepEqual(json.map((r) => r.address), ["=== code@" + json[0].address.split("@")[1], "#warn", "#t"],
    "addresses stay the shortest unique ones in the WHOLE document");
  const empty = run(["list", f, "--within", "#t"]);
  assert.equal(empty.code, 0);
  assert.equal(empty.out, "");
  assert.match(empty.err, /nothing addressable inside `#t`/);
});

test("find --within searches only the lines inside the scope, prose under the heading included", () => {
  const r = run(["find", "print", f, "--within", "#install"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), `${f}\t#py1`);
  const prose = run(["find", "安装脚本", f, "--within", "#install"]);
  assert.equal(prose.out.trim().split("\t")[1], "#install-before-py1", "text written in the section's own prose is inside it");
});

test("find --within over a directory skips files the scope names nothing in, and still refuses a malformed scope", () => {
  const d = join(dir, "tree");
  mkdirSync(d);
  writeFileSync(join(d, "a.geml"), DOC);
  writeFileSync(join(d, "b.geml"), "=== code {lang=py}\nprint(3)\n===\n");
  const r = run(["find", "print", "--within", "#upgrade"], d);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "a.geml\t=== code@" + r.out.trim().split("@")[1], "b.geml has no #upgrade, so it was not searched");
  const bad = run(["find", "print", "--within", "{}"], d);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /names no key/);
});

test("--within narrows blocks: with a coordinate or `#meta` it is a usage error", () => {
  // Two `meta` blocks: `#meta` is then their merge, which no narrowing applies to.
  const m = write("meta.geml", '=== meta\ntitle = "T"\n===\n\n=== table {#fy format=csv header=1}\na\n1\n===\n\n=== meta\nn = 1\n===\n');
  const coord = run(["get", m, '#fy[1]["a"]', "--within", "#fy"]);
  assert.equal(coord.code, 2);
  assert.match(coord.err, /is a coordinate naming one unit inside a block/);
  const meta = run(["get", m, "#meta", "--within", "#fy"]);
  assert.equal(meta.code, 2);
  assert.match(meta.err, /`#meta` names a merged view rather than a block/);
});

console.log(`\n${passed} test(s) passed.`);
