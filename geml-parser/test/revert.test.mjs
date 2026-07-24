// `geml revert` / `geml history log` — restore ONE block to a past revision,
// and list revisions with the `--rev` selector that picks each. Builds a small
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
  // timeout: a blocked CLI must fail loudly, not hang the job (see cli.test).
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dir = mkdtempSync(join(tmpdir(), "geml-revert-"));
const geml = join(dir, "doc.geml");
const hist = join(dir, "doc.gemlhistory");
const p = (n) => join(dir, n);
const read = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// #n1 changes every commit; #occ changes only V1->V2 (then stays); #keep never
// changes. So on the tip: `--rev -1` is a no-op for #occ, but `--changed` skips
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

test("revert #id (default --rev -1) restores the previous commit's block", () => {
  reset();
  const r = run(["revert", geml, "#n1"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(read(geml).includes("=== note {#n1}\ntwo\n==="), "n1 -> V2");
  assert.ok(read(geml).includes('print("keep")'), "other blocks untouched");
  assert.match(r.err, /reverted #n1 to /);
});

test("revert --rev -2 goes two revisions back", () => {
  reset();
  assert.equal(run(["revert", geml, "#n1", "--rev", "-2"]).code, 0);
  assert.ok(read(geml).includes("=== note {#n1}\none\n==="), "n1 -> V1");
});

test("revert --rev <id> targets a specific revision exactly", () => {
  reset();
  assert.equal(run(["revert", geml, "#n1", "--rev", id1]).code, 0);
  assert.ok(read(geml).includes("=== note {#n1}\none\n==="));
});

test("revert is a no-op (exit 0, no write) when the block is unchanged at the target", () => {
  reset();
  const before = read(geml);
  const r = run(["revert", geml, "#occ", "--rev", "-1"]);   // #occ unchanged V2->V3
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
  const r = run(["revert", geml, "#n1", "--rev", "-1", "--dry-run"]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("=== note {#n1}\ntwo\n==="));
  assert.equal(read(geml), before, "file not written");
});

test("-o redirects the output, leaving the source untouched", () => {
  reset();
  const before = read(geml);
  const dest = p("out.geml");
  const r = run(["revert", geml, "#n1", "--rev", "-1", "-o", dest]);
  assert.equal(r.code, 0, r.err);
  assert.ok(read(dest).includes("=== note {#n1}\ntwo\n==="));
  assert.equal(read(geml), before, "source untouched with -o");
});

test("an out-of-range offset exits 1 with a clean message", () => {
  reset();
  const r = run(["revert", geml, "#n1", "--rev", "-9"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /out of range/);
  assert.doesNotMatch(r.err, /node:|at Object/);
});

test("revert on an id absent from both the doc and the target exits 1 cleanly", () => {
  reset();
  const r = run(["revert", geml, "#nope"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /exists in neither the document nor /);
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

test("revert on a heading id rewinds its whole SECTION", () => {
  reset();
  // #top's section spans the entire document (no later same-level heading), so
  // reverting it to -1 restores every block to the previous commit at once.
  const r = run(["revert", geml, "#top", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(read(geml), V2);
});

test("revert a section against a history whose old revision had different boundaries", () => {
  const g = p("sec.geml"), h = p("sec.gemlhistory");
  writeFileSync(g, "# A {#a}\n\nold a prose\n\nshared tail\n");            // no # B yet
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(4) });
  writeFileSync(g, "# A {#a}\n\nnew a prose\n\n# B {#b}\nb prose\n");      // # B added later
  commit({ gemlPath: g, historyPath: h, summary: "v2", author: "t", at: at(5) });
  const r = run(["revert", g, "#a", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  // The old #a is extracted by the NEW rule on OLD content (it ran to old-EOF)
  // and splices into the current #a span; the later-born #b section survives.
  assert.equal(read(g), "# A {#a}\n\nold a prose\n\nshared tail\n# B {#b}\nb prose\n");
});

test("revert --head rewinds only the head line; the section body keeps the tip's text", () => {
  const g = p("hl.geml"), h = p("hl.gemlhistory");
  writeFileSync(g, "# Old {#t}\nold body\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(6) });
  writeFileSync(g, "# New {#t}\nnew body\n");
  commit({ gemlPath: g, historyPath: h, summary: "v2", author: "t", at: at(7) });
  const r = run(["revert", "--head", g, "#t", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(read(g), "# Old {#t}\nnew body\n"); // heading from v1, body still v2
});

// -- resurrect / remove (the new reconcile cells) --------------------------

test("resurrect: a deleted block returns between its surviving neighbours", () => {
  const g = p("res.geml"), h = p("res.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n\n=== note {#c}\nccc\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(8) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#c}\nccc\n===\n");   // delete #b
  const r = run(["revert", g, "#b", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  const s = read(g);
  assert.ok(s.includes("=== note {#b}\nbbb\n==="), "#b resurrected");
  assert.ok(s.indexOf("#a") < s.indexOf("#b") && s.indexOf("#b") < s.indexOf("#c"), "between #a and #c");
  assert.match(r.err, /resurrected #b .* at after #a/);
});

test("resurrect: no preceding anchor falls back to the following one", () => {
  const g = p("res2.geml"), h = p("res2.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(9) });
  writeFileSync(g, "=== note {#b}\nbbb\n===\n");   // delete #a (the first block)
  const r = run(["revert", g, "#a", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(read(g).indexOf("#a") < read(g).indexOf("#b"), "#a before #b");
  assert.match(r.err, /at before #b/);
});

test("resurrect: all anchors gone -> append at end + warn", () => {
  const g = p("res3.geml"), h = p("res3.gemlhistory");
  writeFileSync(g, "=== note {#x}\nxxx\n===\n\n=== note {#y}\nyyy\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(10) });
  writeFileSync(g, "=== note {#z}\nzzz\n===\n");   // x and y gone, z is new
  const r = run(["revert", g, "#x", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /anchors for #x are gone; appended at end/);
  assert.ok(read(g).indexOf("#z") < read(g).indexOf("#x"), "#x appended after #z");
});

test("resurrect: --after overrides the inferred position", () => {
  const g = p("res4.geml"), h = p("res4.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n\n=== note {#c}\nccc\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(11) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#c}\nccc\n===\n");   // delete #b
  const r = run(["revert", g, "#b", "--rev", "-1", "--after", "#c"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(read(g).indexOf("#c") < read(g).indexOf("#b"), "#b after #c (override)");
});

test("remove: reverting an added block deletes it (undo add)", () => {
  const g = p("rem.geml"), h = p("rem.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(12) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#new}\nnnn\n===\n");   // add #new (uncommitted)
  const r = run(["revert", g, "#new", "--rev", "-1"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!read(g).includes("#new"), "#new removed");
  assert.ok(read(g).includes("=== note {#a}\naaa\n==="), "#a untouched");
  assert.match(r.err, /removed #new \(absent at /);
});

test("--dry-run resurrect prints the block and writes nothing", () => {
  const g = p("dr.geml"), h = p("dr.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(13) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n");
  const before = read(g);
  const r = run(["revert", g, "#b", "--rev", "-1", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("=== note {#b}\nbbb\n==="));
  assert.equal(read(g), before, "file not written");
});

test("--head cannot resurrect a deleted block (usage error)", () => {
  const g = p("hd.geml"), h = p("hd.gemlhistory");
  writeFileSync(g, "=== note {#a}\naaa\n===\n\n=== note {#b}\nbbb\n===\n");
  commit({ gemlPath: g, historyPath: h, summary: "v1", author: "t", at: at(14) });
  writeFileSync(g, "=== note {#a}\naaa\n===\n");
  const r = run(["revert", "--head", g, "#b", "--rev", "-1"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--head only applies/);
});

// -- history log -----------------------------------------------------------

test("history log lists revisions newest-first with their --rev selectors", () => {
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
