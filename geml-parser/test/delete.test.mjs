// `geml delete` — remove one or more blocks by id. Missing ids are skipped
// (not an error); a reference left dangling is a warning, not a refusal.
// Spawns the built CLI like get-set.test.mjs.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args, input) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dir = mkdtempSync(join(tmpdir(), "geml-del-"));
const p = (name) => join(dir, name);
const write = (name, s) => { const f = p(name); writeFileSync(f, s); return f; };
const read = (f) => readFileSync(f, "utf8");

const DOC = "# Doc {#doc}\n\n=== note {#a}\nalpha\n===\n\n=== note {#b}\nbeta\n===\n\n=== note {#c}\ngamma\n===\n";

test("delete removes one block in place, leaving the rest valid", () => {
  const f = write("d1.geml", DOC);
  const r = run(["delete", f, "#b"]);
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.doesNotMatch(after, /#b/);
  assert.match(after, /#a/); assert.match(after, /#c/);
  assert.equal(run(["check", f]).code, 0, "still valid");
});

test("delete removes multiple ids in one call", () => {
  const f = write("d2.geml", DOC);
  const r = run(["delete", f, "#a", "#c"]);
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.doesNotMatch(after, /#a/); assert.doesNotMatch(after, /#c/);
  assert.match(after, /#b/);
});

test("a missing id is skipped with a note, not an error (exit 0)", () => {
  const f = write("d3.geml", DOC);
  const r = run(["delete", f, "#a", "#ghost"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /skipped #ghost/);
  assert.doesNotMatch(read(f), /#a/);
  assert.match(read(f), /#b/, "the real block still removed, ghost skipped");
});

test("all ids missing: exit 0, doc unchanged, notes on stderr", () => {
  const f = write("d4.geml", DOC);
  const r = run(["delete", f, "#nope1", "#nope2"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /skipped #nope1/);
  assert.equal(read(f), DOC, "unchanged");
});

test("deleting a REFERENCED block warns (dangling) but still writes, exit 0", () => {
  const f = write("d5.geml", "# Doc {#doc}\n\nsee [[#a]] here\n\n=== note {#a}\nalpha\n===\n");
  const r = run(["delete", f, "#a"]);
  assert.equal(r.code, 0, r.err);         // NOT refused
  assert.match(r.err, /warning/i);        // dangling warned
  assert.doesNotMatch(read(f), /=== note \{#a\}/, "block actually removed");
  // ...and a subsequent check reports the dangling ref as an ERROR (exit 1)
  assert.equal(run(["check", f]).code, 1, "check flags the dangling ref");
});

test("deleting a heading section removes its nested block too (union of spans, no double-splice)", () => {
  const f = write("d6.geml", "# A {#a}\n\n=== note {#nested}\nx\n===\n\n# B {#b}\n\nbody\n");
  // #a's section contains #nested; delete both ids — union handles containment.
  const r = run(["delete", f, "#a", "#nested"]);
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.doesNotMatch(after, /#a/); assert.doesNotMatch(after, /#nested/);
  assert.match(after, /# B \{#b\}/);
  assert.equal(run(["check", f]).code, 0);
});

test("no id is a usage error (exit 2)", () => {
  const f = write("d7.geml", DOC);
  assert.equal(run(["delete", f]).code, 2);
});

test("output: stdin doc -> stdout; -o - -> stdout, file untouched", () => {
  const f = write("d8.geml", DOC);
  const viaStdin = run(["delete", "-", "#b"], DOC);
  assert.equal(viaStdin.code, 0, viaStdin.err);
  assert.doesNotMatch(viaStdin.out, /#b/);
  assert.match(viaStdin.out, /#a/);
  const before = read(f);
  const r = run(["delete", f, "#a", "-o", "-"]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /#a/);
  assert.equal(read(f), before, "-o - leaves the file untouched");
});

test("delete takes the blank line that separated the block, so add then delete is byte-identical", () => {
  // `add` puts one blank line between the fragment and its neighbours; delete
  // left that line behind, so every add-then-delete grew the file by a line.
  const f = write("d-sep.geml", DOC);
  for (const where of [["--after", "#a"], ["--before", "#a"], ["--append"]]) {
    assert.equal(run(["add", f, ...where], "=== note {#x}\nx\n===\n").code, 0, where.join(" "));
    assert.equal(run(["delete", f, "#x"]).code, 0, where.join(" "));
    assert.equal(read(f), DOC, where.join(" "));
  }
});

test("delete of the first and last block leaves no blank line at the document edge", () => {
  const f = write("d-edge.geml", "=== note {#a}\nalpha\n===\n\n=== note {#b}\nbeta\n===\n\n=== note {#c}\ngamma\n===\n");
  assert.equal(run(["delete", f, "#a", "#c"]).code, 0);
  assert.equal(read(f), "=== note {#b}\nbeta\n===\n");
});

test("delete of two neighbouring blocks takes both separators", () => {
  // The separator the first run takes sits right before the second run; it
  // must not hide where the second run starts.
  const f = write("d-pair.geml", "=== note {#a}\nalpha\n===\n\n=== note {#b}\nbeta\n===\n\n=== note {#c}\ngamma\n===\n");
  assert.equal(run(["delete", f, "#a", "#b"]).code, 0);
  assert.equal(read(f), "=== note {#c}\ngamma\n===\n");
});

test("delete removes one separator, not the author's extra spacing", () => {
  // Two blank lines on each side: one goes with the block, three stay.
  const f = write("d-wide.geml", "=== note {#a}\nalpha\n===\n\n\n=== note {#b}\nbeta\n===\n\n\n=== note {#c}\ngamma\n===\n");
  assert.equal(run(["delete", f, "#b"]).code, 0);
  assert.equal(read(f), "=== note {#a}\nalpha\n===\n\n\n\n=== note {#c}\ngamma\n===\n");
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
