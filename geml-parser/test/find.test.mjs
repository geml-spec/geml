// `geml find` — the argument paths, which the happy case never reaches.
//
// find is how an agent locates anything now, so its handling of what a caller
// gets wrong is on the hot path: no pattern at all, no path (meaning "here"),
// a directory to walk, and something unreadable sitting in the middle of it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as presolve } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const CLI = presolve("dist/geml.js");
function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function ws() {
  return mkdtempSync(join(tmpdir(), "geml-find-"));
}

test("no pattern prints the usage rather than searching for nothing", () => {
  const r = run(["find"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: geml find/);
});

test("no path means the current directory", () => {
  const dir = ws();
  writeFileSync(join(dir, "a.geml"), "# A {#a}\n\nfindable phrase\n");
  const r = run(["find", "findable phrase"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /a\.geml\t#a/);
  rmSync(dir, { recursive: true, force: true });
});

test("a directory is walked, and what cannot be read is stepped over", () => {
  // A directory wearing a `.geml` name is unreadable. The walk has to report
  // the real hits and not die on it — a search that stops at the first oddity
  // is a search nobody can trust on a real tree.
  const dir = ws();
  mkdirSync(join(dir, "sub"), { recursive: true });
  mkdirSync(join(dir, "trap.geml"), { recursive: true });
  writeFileSync(join(dir, "sub", "b.geml"), "# B {#b}\n\nneedle here\n");
  writeFileSync(join(dir, "c.geml"), "# C {#c}\n\nnothing to see\n");
  const r = run(["find", "needle", dir]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /b\.geml\t#b/);
  assert.doesNotMatch(r.out, /c\.geml/, "a file without the phrase is not a hit");
  rmSync(dir, { recursive: true, force: true });
});

test("--json carries the same rows, and --head adds the matching line", () => {
  const dir = ws();
  const f = join(dir, "a.geml");
  writeFileSync(f, "# A {#a}\n\n=== note {#n}\nneedle in a note\n===\n");
  const j = run(["find", "needle", f, "--json"]);
  assert.equal(j.code, 0, j.err);
  const rows = JSON.parse(j.out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, "#n");
  const h = run(["find", "needle", f, "--head"]);
  assert.match(h.out, /needle in a note/);
  rmSync(dir, { recursive: true, force: true });
});

test("--case makes the search exact, and no match is exit 1 in every mode", () => {
  const dir = ws();
  const f = join(dir, "a.geml");
  writeFileSync(f, "# A {#a}\n\nNeedle capitalised\n");
  assert.equal(run(["find", "needle", f]).code, 0, "insensitive by default");
  const exact = run(["find", "needle", f, "--case"]);
  assert.equal(exact.code, 1, "--case makes it miss");
  const json = run(["find", "needle", f, "--case", "--json"]);
  assert.equal(json.code, 1);
  assert.equal(json.out.trim(), "[]", "--json still prints an empty array");
  rmSync(dir, { recursive: true, force: true });
});

test("a file you NAME is searched whatever its extension; a directory still walks *.geml only", () => {
  const dir = ws();
  const md = join(dir, "notes.md");
  const geml = join(dir, "a.geml");
  writeFileSync(md, "# Title\n\n## Section\n\nthe needle lives here\n");
  writeFileSync(geml, "# A {#a}\n\nnothing here\n");

  // Named explicitly: searched, and the address is one `geml get` can use.
  const named = run(["find", "needle", md]);
  assert.equal(named.code, 0, `a named .md must be searched: ${named.err}`);
  const [file, address] = named.out.trim().split("\t");
  assert.equal(file, md);
  const back = run(["get", md, address]);
  assert.equal(back.code, 0, `the address must round-trip through get: ${back.err}`);
  assert.match(back.out, /the needle lives here/);

  // Same file reached by walking a directory: skipped, or every source tree in
  // the repository would go through the parser on a bare `geml find`.
  assert.equal(run(["find", "needle", dir]).code, 1, "a directory walk stays *.geml only");
  rmSync(dir, { recursive: true, force: true });
});

console.log(`find: ${passed} passed`);
