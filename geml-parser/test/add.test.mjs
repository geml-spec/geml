// `geml add` — insert a GEML fragment (1+ blocks and/or prose) at a position
// (--append / --before #x / --after #x). Content comes from --in F (all of F),
// --in F#src (one block), or stdin (raw); ids are kept as-is and a collision is
// refused. Spawns the built CLI like get-set.test.mjs.
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

const dir = mkdtempSync(join(tmpdir(), "geml-add-"));
const p = (name) => join(dir, name);
const write = (name, s) => { const f = p(name); writeFileSync(f, s); return f; };
const read = (f) => readFileSync(f, "utf8");
const ok = (f) => { const r = run(["check", f]); assert.equal(r.code, 0, `check failed: ${r.err}`); };

const DOC = "# Doc {#doc}\n\n=== note {#a}\nalpha\n===\n\n=== note {#b}\nbeta\n===\n";

test("--append --in F#src: block appended at end, keeps its own id, doc still valid", () => {
  const f = write("app.geml", DOC);
  write("src1.geml", "junk\n\n=== note {#extra}\nEXTRA\n===\n");
  const r = run(["add", f, "--append", "--in", `${p("src1.geml")}#extra`]);
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.match(after, /=== note \{#extra\}\nEXTRA\n===/);
  assert.match(after, /=== note \{#a\}/, "existing blocks preserved");
  ok(f);
  // appended after #b
  assert.ok(after.indexOf("#extra") > after.indexOf("#b"), "appended at end");
});

test("--after #x: fragment inserted right after #x's span", () => {
  const f = write("aft.geml", DOC);
  write("src2.geml", "=== note {#mid}\nMID\n===\n");
  const r = run(["add", f, "--after", "#a", "--in", `${p("src2.geml")}#mid`]);
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.ok(after.indexOf("#mid") > after.indexOf("#a") && after.indexOf("#mid") < after.indexOf("#b"), "between #a and #b");
  ok(f);
});

test("--before #x: fragment inserted right before #x", () => {
  const f = write("bef.geml", DOC);
  const r = run(["add", f, "--before", "#b"], "=== note {#pre}\nPRE\n===\n");
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.ok(after.indexOf("#pre") < after.indexOf("#b") && after.indexOf("#pre") > after.indexOf("#a"), "before #b, after #a");
  ok(f);
});

test("--in F (no #src): the whole multi-block file is inserted", () => {
  const f = write("multi.geml", DOC);
  write("frag.geml", "=== note {#x}\nX\n===\n\n=== note {#y}\nY\n===\n");
  const r = run(["add", f, "--append", "--in", p("frag.geml")]);
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.match(after, /#x/); assert.match(after, /#y/);
  ok(f);
});

test("stdin prose (no head) is a valid fragment — appended as a paragraph", () => {
  const f = write("prose.geml", DOC);
  const r = run(["add", f, "--append"], "just a bare paragraph, no id.\n");
  assert.equal(r.code, 0, r.err);
  assert.match(read(f), /just a bare paragraph/);
  ok(f);
});

test("an id colliding with the document is refused (exit 1, nothing written)", () => {
  const f = write("col.geml", DOC);
  const before = read(f);
  const r = run(["add", f, "--append"], "=== note {#a}\ndup\n===\n"); // #a already exists
  assert.equal(r.code, 1);
  assert.equal(read(f), before, "unchanged after refusal");
});

test("a missing anchor is an error (exit 1)", () => {
  const f = write("anc.geml", DOC);
  const r = run(["add", f, "--after", "#nope"], "=== note {#z}\nz\n===\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `nope`/);
});

test("no position, or two positions, is a usage error (exit 2)", () => {
  const f = write("pos.geml", DOC);
  assert.equal(run(["add", f], "=== note {#z}\nz\n===\n").code, 2);
  assert.equal(run(["add", f, "--append", "--after", "#a"], "=== note {#z}\nz\n===\n").code, 2);
});

test("doc from stdin needs --in (both can't be stdin)", () => {
  const r = run(["add", "-", "--append"], "=== note {#z}\nz\n===\n");
  assert.equal(r.code, 2);
});

test("output: stdin doc -> stdout; -o - -> stdout, file untouched", () => {
  const f = write("outp.geml", DOC);
  write("outsrc.geml", "=== note {#fresh}\nF\n===\n");
  // stdin doc, content via --in file (a UNIQUE block) -> whole updated doc on stdout
  const viaStdin = run(["add", "-", "--append", "--in", p("outsrc.geml") + "#fresh"], DOC);
  assert.equal(viaStdin.code, 0, viaStdin.err);
  assert.match(viaStdin.out, /#doc/);
  assert.match(viaStdin.out, /#fresh/);
  // file input with -o - -> stdout, file unchanged
  const before = read(f);
  const r = run(["add", f, "--append", "-o", "-"], "=== note {#zz}\nz\n===\n");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /#zz/);
  assert.equal(read(f), before, "-o - leaves the file untouched");
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
