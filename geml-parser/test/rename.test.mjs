// `geml rename #old #new` — rewrite an id's declaration and every reference,
// id-boundary safe, skipping raw block bodies. Spawns the built CLI.
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

const dir = mkdtempSync(join(tmpdir(), "geml-rn-"));
const p = (name) => join(dir, name);
const write = (name, s) => { const f = p(name); writeFileSync(f, s); return f; };
const read = (f) => readFileSync(f, "utf8");

// #a is declared, referenced two ways, referenced from another flow block, has a
// look-alike neighbour #ab, and appears as literal text inside a raw code body.
const DOC =
  "# Doc {#doc}\n\nSee [[#a]] and [the note](#a).\n\n" +
  "=== note {#a}\nalpha\n===\n\n" +
  "=== note {#ab}\nrefers [[#a]] too\n===\n\n" +
  "=== code {#c}\n#a is literal code, not a ref\n===\n";

test("rename rewrites declaration + all references; doc stays valid", () => {
  const f = write("r1.geml", DOC);
  const r = run(["rename", f, "#a", "#z"]);
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.match(after, /=== note \{#z\}/, "declaration renamed");
  assert.match(after, /See \[\[#z\]\] and \[the note\]\(#z\)/, "both prose refs renamed");
  assert.match(after, /refers \[\[#z\]\] too/, "ref inside another flow block renamed");
  assert.doesNotMatch(after, /=== note \{#a\}/, "the #a declaration is gone (renamed to #z)");
  assert.equal(run(["check", f]).code, 0, "valid");
});

test("id-boundary safe: a look-alike id #ab is untouched", () => {
  const f = write("r2.geml", DOC);
  run(["rename", f, "#a", "#z"]);
  const after = read(f);
  assert.match(after, /=== note \{#ab\}/, "#ab declaration intact");
});

test("raw block body is skipped: literal #a in code is not rewritten", () => {
  const f = write("r3.geml", DOC);
  run(["rename", f, "#a", "#z"]);
  assert.match(read(f), /#a is literal code, not a ref/, "code body text untouched");
});

test("renaming to an existing id is refused (exit 1, nothing written)", () => {
  const f = write("r4.geml", DOC);
  const before = read(f);
  const r = run(["rename", f, "#a", "#ab"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists/);
  assert.equal(read(f), before, "unchanged");
});

test("renaming a missing id errors (exit 1)", () => {
  const f = write("r5.geml", DOC);
  const r = run(["rename", f, "#nope", "#x"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `nope`/);
});

test("#old == #new is a usage error (exit 2)", () => {
  const f = write("r6.geml", DOC);
  assert.equal(run(["rename", f, "#a", "#a"]).code, 2);
});

test("footnote id: [^n] ref and [^n]: definition both renamed", () => {
  const f = write("r7.geml", "# H {#h}\n\nclaim here[^n]\n\n[^n]: the footnote body\n");
  const r = run(["rename", f, "#n", "#m"]);
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.match(after, /claim here\[\^m\]/, "footnote ref renamed");
  assert.match(after, /\[\^m\]: the footnote body/, "footnote definition renamed");
  assert.equal(run(["check", f]).code, 0);
});

test("stdin -> stdout (rename supports piping; no sidecar needed)", () => {
  const r = run(["rename", "-", "#a", "#z"], DOC);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== note \{#z\}/);
  assert.match(r.out, /\[\[#z\]\]/);
});

test("-o - writes to stdout, file untouched", () => {
  const f = write("r8.geml", DOC);
  const before = read(f);
  const r = run(["rename", f, "#a", "#z", "-o", "-"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== note \{#z\}/);
  assert.equal(read(f), before, "-o - leaves the file untouched");
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
