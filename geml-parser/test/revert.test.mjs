// `geml revert` / `geml history log` — restore ONE block to a past revision,
// and list revisions with the `--to` selector that picks each. Builds a small
// 3-revision history with the imported commit(), then drives the built CLI like
// cli.test.mjs, in a throwaway temp dir like history.test.mjs.
import { commit } from "../dist/history.js";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args, input) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8" });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dir = mkdtempSync(join(tmpdir(), "geml-revert-"));
const geml = join(dir, "doc.geml");
const hist = join(dir, "doc.gemlhistory");
const p = (n) => join(dir, n);
const read = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// #n1 changes every commit; #occ changes only V1->V2 (then stays); #keep never
// changes. So on the tip: `--to -1` is a no-op for #occ, but `--changed` skips
// back to where it last differed.
const doc = (n1, occ) =>
  "# Roadmap {#top}\n\n" +
  `=== note {#n1}\n${n1}\n===\n\n` +
  `=== note {#occ}\n${occ}\n===\n\n` +
  '=== code {#keep lang=py}\nprint("keep")\n===\n';

const V1 = doc("one", "occ-A");
const V2 = doc("two", "occ-B");
const V3 = doc("three", "occ-B");

let id1, id2, id3;
const at = (d) => new Date(`2026-01-0${d}T00:00:00Z`);
const commitAt = (content, summary, d) => {
  writeFileSync(geml, content);
  return commit({ gemlPath: geml, historyPath: hist, summary, author: "tester", at: at(d) }).id;
};
const reset = () => writeFileSync(geml, V3);   // restore the working file to the tip

test("setup: three commits recorded", () => {
  id1 = commitAt(V1, "first", 1);
  id2 = commitAt(V2, "second", 2);
  id3 = commitAt(V3, "third", 3);
  assert.ok(id1 && id2 && id3);
  assert.notEqual(id1, id2);
});

// -- revert ----------------------------------------------------------------

test("revert #id (default --to -1) restores the previous commit's block", () => {
  reset();
  const r = run(["revert", geml, "#n1"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(read(geml).includes("=== note {#n1}\ntwo\n==="), "n1 -> V2");
  assert.ok(read(geml).includes('print("keep")'), "other blocks untouched");
  assert.match(r.err, /reverted #n1 to /);
});

test("revert --to -2 goes two revisions back", () => {
  reset();
  assert.equal(run(["revert", geml, "#n1", "--to", "-2"]).code, 0);
  assert.ok(read(geml).includes("=== note {#n1}\none\n==="), "n1 -> V1");
});

test("revert --to <id> targets a specific revision exactly", () => {
  reset();
  assert.equal(run(["revert", geml, "#n1", "--to", id1]).code, 0);
  assert.ok(read(geml).includes("=== note {#n1}\none\n==="));
});

test("revert is a no-op (exit 0, no write) when the block is unchanged at the target", () => {
  reset();
  const before = read(geml);
  const r = run(["revert", geml, "#occ", "--to", "-1"]);   // #occ unchanged V2->V3
  assert.equal(r.code, 0);
  assert.match(r.err, /unchanged at .*nothing to revert/);
  assert.equal(read(geml), before, "file left byte-identical");
});

test("--changed skips no-op revisions to the previous DISTINCT version", () => {
  reset();
  const r = run(["revert", geml, "#occ", "--changed"]);    // skip id2 (occ-B) -> id1 (occ-A)
  assert.equal(r.code, 0, r.err);
  assert.ok(read(geml).includes("=== note {#occ}\nocc-A\n==="));
});

test("--changed exits 1 when no earlier revision changed the block", () => {
  reset();
  const r = run(["revert", geml, "#keep", "--changed"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no earlier revision changes `keep`/);
});

test("--dry-run prints the block and writes nothing", () => {
  reset();
  const before = read(geml);
  const r = run(["revert", geml, "#n1", "--to", "-1", "--dry-run"]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("=== note {#n1}\ntwo\n==="));
  assert.equal(read(geml), before, "file not written");
});

test("-o redirects the output, leaving the source untouched", () => {
  reset();
  const before = read(geml);
  const dest = p("out.geml");
  const r = run(["revert", geml, "#n1", "--to", "-1", "-o", dest]);
  assert.equal(r.code, 0, r.err);
  assert.ok(read(dest).includes("=== note {#n1}\ntwo\n==="));
  assert.equal(read(geml), before, "source untouched with -o");
});

test("an out-of-range offset exits 1 with a clean message", () => {
  reset();
  const r = run(["revert", geml, "#n1", "--to", "-9"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /out of range/);
  assert.doesNotMatch(r.err, /node:|at Object/);
});

test("revert on an unknown id exits 1 with a clean error", () => {
  reset();
  const r = run(["revert", geml, "#nope"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `nope`/);
});

test("revert from stdin is a usage error (it needs a real file for the history)", () => {
  const r = run(["revert", "-", "#n1"], V3);
  assert.equal(r.code, 2);
  assert.match(r.err, /needs a real file/);
});

test("revert with no id is a usage error (exit 2)", () => {
  const r = run(["revert", geml]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: geml revert/);
});

test("revert --help prints usage to stdout, exit 0", () => {
  const r = run(["revert", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: geml revert/);
  assert.doesNotMatch(r.err, /error:/);
});

// -- history log -----------------------------------------------------------

test("history log lists revisions newest-first with their --to selectors", () => {
  const r = run(["history", "log", geml]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^latest\s+.*third/);   // the tip
  assert.match(lines[1], /^-1\s+.*second/);
  assert.match(lines[2], /^-2\s+.*first/);
  assert.ok(lines[0].includes(id3), "tip row shows the current id");
  assert.ok(lines[2].includes(id1), "oldest row shows the first id");
});

test("history log on a missing sidecar exits non-zero with a clean message", () => {
  const r = run(["history", "log", p("nope.geml")]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /cannot read history|history/);
  assert.doesNotMatch(r.err, /node:|at Object/);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
