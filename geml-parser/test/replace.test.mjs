// `geml replace` — a literal swap that is addressed, checked and reported.
//
// EXPERIMENTAL: the verb may be withdrawn. These tests pin the contract while it
// is here, and the first of them pins the warning itself — if the verb ever
// stops being experimental, this test is the reminder to say so.
//
// The point of the verb is not that it replaces text; `sed` does that. It is
// the three things `sed -i` cannot do at the same cost: refuse a write that
// breaks the document, name the blocks it touched, and leave something to
// revert. Most of what follows tests those, not the substitution.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const CLI = "dist/geml.js";
function run(args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args], { input: input ?? "", encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const DOC = "=== meta\ntitle = \"t\"\n===\n\n# Top {#top}\n\nship v1.2.0 today\n\n"
  + "=== table {#t1}\n| a | v1.2.0 |\n| :- | :- |\n| x | v1.2.0 |\n===\n\n=== note {#n}\nv1.2.0 here too\n===\n";

function ws(doc = DOC) {
  const dir = mkdtempSync(join(tmpdir(), "geml-replace-"));
  const f = join(dir, "d.geml");
  writeFileSync(f, doc);
  return { dir, f };
}

test("the verb announces that it is experimental, at both help levels", () => {
  assert.match(run(["--help"]).out, /geml replace .*EXPERIMENTAL/);
  assert.match(run(["replace"]).err, /MAY BE WITHDRAWN/);
});

test("a replacement names the blocks it touched", () => {
  const { dir, f } = ws();
  const r = run(["replace", f, "v1.2.0", "v1.2.1", "-o", f]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /replaced 4 occurrences/);
  for (const id of ["#top", "#t1", "#n"]) assert.ok(r.err.includes(id), `${id} named: ${r.err}`);
  assert.doesNotMatch(readFileSync(f, "utf8"), /v1\.2\.0/);
  rmSync(dir, { recursive: true, force: true });
});

test("--within narrows the swap, and may match several blocks", () => {
  // Unlike `set`, which writes ONE block and refuses an ambiguous selector,
  // "in every table" is the useful reading here and is allowed.
  const { dir, f } = ws();
  const r = run(["replace", f, "v1.2.0", "v1.2.1", "--within", "=== table", "-o", f]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /replaced 2 occurrences in #t1/);
  const after = readFileSync(f, "utf8");
  assert.match(after, /ship v1\.2\.0 today/, "outside the scope is untouched");
  assert.match(after, /v1\.2\.0 here too/);
  rmSync(dir, { recursive: true, force: true });
});

test("nothing matched is exit 1, so a shell `if` means what it looks like", () => {
  const { dir, f } = ws();
  const before = readFileSync(f, "utf8");
  const r = run(["replace", f, "no such text", "x", "-o", f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /does not occur/);
  assert.equal(readFileSync(f, "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("an id is not text — a swap that would rename one is refused, and points at rename", () => {
  // This is the failure `sed -i` cannot see: changing `#top` in the heading
  // silently cuts every reference to it. `geml rename` fixes the references
  // too, so the message sends the caller there rather than just saying no.
  const { dir, f } = ws();
  const before = readFileSync(f, "utf8");
  const r = run(["replace", f, "top", "apex", "-o", f]);
  assert.equal(r.code, 2);
  assert.match(r.err, /an id is not text/);
  assert.match(r.err, /geml rename/);
  assert.equal(readFileSync(f, "utf8"), before, "nothing written");
  rmSync(dir, { recursive: true, force: true });
});

test("a swap that would break the document is refused with the diagnostic that refused it", () => {
  const { dir, f } = ws("=== meta\ntitle = \"t\"\n===\n\n# H {#h}\n\n=== note {#n}\nbody\n===\n");
  const before = readFileSync(f, "utf8");
  const r = run(["replace", f, "===\n", "XX\n", "--within", "#n", "-o", f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /would break the document/);
  assert.match(r.err, /unterminated/);
  assert.equal(readFileSync(f, "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("a swap that removes a block does it and names it, as `set` does", () => {
  // One rule for destructive edits across every verb: carry it out, say what it
  // cost, and leave `revert` as the way back.
  const { dir, f } = ws();
  const r = run(["replace", f, "=== table {#t1}", "prose now", "-o", f]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /dropped `#t1`/);
  assert.match(r.err, /geml revert/);
  rmSync(dir, { recursive: true, force: true });
});

test("an empty search string is a usage error, not a match at every position", () => {
  const { dir, f } = ws();
  const r = run(["replace", f, "", "x", "-o", f]);
  assert.equal(r.code, 2);
  assert.match(r.err, /empty/);
  rmSync(dir, { recursive: true, force: true });
});

test("--within a selector that matches nothing writes nothing", () => {
  const { dir, f } = ws();
  const before = readFileSync(f, "utf8");
  const r = run(["replace", f, "v1.2.0", "v1.2.1", "--within", "#nope", "-o", f]);
  assert.notEqual(r.code, 0);
  assert.equal(readFileSync(f, "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("a CRLF document is still CRLF after a replacement", () => {
  const { dir, f } = ws(DOC.replace(/\n/g, "\r\n"));
  assert.equal(run(["replace", f, "v1.2.0", "v1.2.1", "-o", f]).code, 0);
  const after = readFileSync(f, "utf8");
  assert.match(after, /v1\.2\.1/);
  assert.equal((after.match(/(?<!\r)\n/g) ?? []).length, 0, "not one lone LF may be introduced");
  rmSync(dir, { recursive: true, force: true });
});

test("stdin is a document like any other, and the report says so", () => {
  // `-` is the shape a pipeline uses, and it takes a different path through
  // every message and every guard: there is no filename to name.
  const doc = "# Top {#top}\n\nship v1.2.0\n";
  const ok = run(["replace", "-", "v1.2.0", "v1.2.1"], doc);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /v1.2.1/, "the result goes to stdout");
  assert.match(ok.err, /replaced 1 occurrence in #top/);
  const miss = run(["replace", "-", "absent", "x"], doc);
  assert.equal(miss.code, 1);
  assert.match(miss.err, /in stdin/, "stdin is named as stdin, not as an empty path");
});

test("--within that matches a block the text is not in reports the scope, not the file", () => {
  const { dir, f } = ws();
  const before = readFileSync(f, "utf8");
  const r = run(["replace", f, "v1.2.0", "v1.2.1", "--within", "#n2", "-o", f]);
  assert.notEqual(r.code, 0);
  assert.equal(readFileSync(f, "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`replace: ${passed} passed`);
