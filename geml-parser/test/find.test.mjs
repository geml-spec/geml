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

test("a file you NAME is searched whatever its extension; a directory walks .geml AND .md", () => {
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

  // Same file reached by walking a directory: found too. `list`, `get` and
  // `set` all take a `.md`; a walk that refused to FIND one answered "no
  // matches" about a directory whose every page held the word.
  const walked = run(["find", "needle", dir]);
  assert.equal(walked.code, 0, `a directory walk must reach .md: ${walked.err}`);
  assert.match(walked.out, /notes\.md\t#section/, "and report it by address");
  rmSync(dir, { recursive: true, force: true });
});

test("the directory walk filters: a source tree does not go through the parser", () => {
  const dir = ws();
  writeFileSync(join(dir, "keep.md"), "# Keep\n\nthe needle lives here\n");
  writeFileSync(join(dir, "app.ts"), "// the needle lives here\n");
  writeFileSync(join(dir, "data.json"), '{"note": "the needle lives here"}\n');

  const r = run(["find", "needle", dir]);
  assert.equal(r.code, 0);
  const files = r.out.trim().split("\n").map((line) => line.split("\t")[0]);
  assert.deepEqual([...new Set(files)], [join(dir, "keep.md")],
    "only the formats the parser reads from a path are walked");
  rmSync(dir, { recursive: true, force: true });
});

test("a .gemlhistory sidecar stays out of the walk", () => {
  const dir = ws();
  writeFileSync(join(dir, "page.md"), "# Page\n\nplain body\n");
  // The sidecar holds past revisions, so it holds the word too. Reporting it
  // would answer a search about the document with a hit in its own undo log.
  writeFileSync(join(dir, "page.md.gemlhistory"), "# Page\n\nthe needle lives here\n");

  assert.equal(run(["find", "needle", dir]).code, 1, "sidecars are not documents");
  rmSync(dir, { recursive: true, force: true });
});

test("the walk matches the extension case-insensitively", () => {
  // A vault authored on a case-insensitive filesystem hands readdir back the
  // name as stored — `NOTES.MD` is a file the user can see, so a search that
  // skipped it would be the same silent "no" this walk used to give Markdown.
  const dir = ws();
  writeFileSync(join(dir, "NOTES.MD"), "# Title\n\nthe needle lives here\n");
  const r = run(["find", "needle", dir]);
  assert.equal(r.code, 0, `an uppercase extension must still be walked: ${r.err}`);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`find: ${passed} passed`);
