// Branch-coverage tests for the codemap CLI scripts (build / refresh /
// render-all / verify / find). Each test spawns the script as a real child
// (`node codemap/<script>.mjs …`) exactly like `geml codemap <sub>` does, so
// exit codes, stderr contracts and argv edge cases are pinned end to end.
// Children always exit normally (V8 coverage flushes on exit): no kills, no
// servers, no ports.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { emit } from "../codemap/emit.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
async function atest(name, fn) { await fn(); passed++; console.log("ok", name); }

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // geml-parser/
const tmp = () => mkdtempSync(join(tmpdir(), "geml-covscripts-"));
// Isolate the C2 recipe-trust store per run (audit): starts empty so untrusted
// recipes are genuinely refused, never touches ~/.config; run() inherits
// process.env so refresh children (and their detached --background copies) see it.
process.env.GEML_TRUST_STORE = join(tmp(), "trust-store.json");

// Run a codemap script; capture status/stdout/stderr regardless of exit code.
const run = (script, args = [], opts = {}) => {
  const r = spawnSync(process.execPath, [join(PKG, "codemap", script), ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000, ...opts,
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "", all: (r.stdout ?? "") + (r.stderr ?? "") };
};

// Minimal exchange-format records (docs/DESIGN-geml-code-graph.md §3 shapes).
const fnSym = (name, anchor, file = "src/a.ts", line = 1) => ({
  anchor, lang: "typescript", kind: "Function", name,
  file, line_start: line, line_end: line + 3, resolution: "cpg",
});
const fileSym = (file = "src/a.ts") => ({
  anchor: `file:${file}`, lang: "typescript", kind: "File",
  name: file.split("/").pop(), file, resolution: "cpg",
});
// Emit a tiny codemap into <tmp>/map (out) — the fixture most tests start from.
const emitMap = (symbols, edges = []) => {
  const dir = tmp();
  const out = join(dir, "map"), build = join(dir, "build");
  mkdirSync(out, { recursive: true });
  mkdirSync(build, { recursive: true });
  emit({ symbols, edges, outDir: out, buildDir: build, repoName: "t", container: "dir", commit: "t0" });
  return { dir, out };
};

// ---------------------------------------------------------------------------
// find.mjs
// ---------------------------------------------------------------------------

test("find: --help exits 0 with usage; no args exits 2", () => {
  const h = run("find.mjs", ["--help"]);
  assert.equal(h.status, 0);
  assert.match(h.err, /usage: geml codemap find/);
  const none = run("find.mjs", []);
  assert.equal(none.status, 2);
  assert.match(none.err, /usage: geml codemap find/);
});

test("find: default dir (cwd/.geml-code-graph) without a built codemap exits 1", () => {
  const dir = tmp();
  const r = run("find.mjs", ["alpha"], { cwd: dir }); // no dir arg -> default
  assert.equal(r.status, 1);
  assert.match(r.err, /no name-lookup at .*build the codemap first/s);
  rmSync(dir, { recursive: true, force: true });
});

// A hand-built lookup + docs: quoted src=, bare src=, an id the doc does not
// define, and an entry pointing at a document that does not exist at all.
const findFixture = () => {
  const dir = tmp();
  const cm = join(dir, "cm");
  mkdirSync(join(cm, "_index"), { recursive: true });
  writeFileSync(join(cm, "_index", "name-lookup.json"), JSON.stringify({
    alphaOne: [{ doc: "a.geml", id: "x", anchor: "t:a#x" }],
    alphaTwo: [{ doc: "b.geml", id: "y", anchor: "t:b#y" }],
    alphaGone: [{ doc: "a.geml", id: "zz", anchor: "t:a#zz" }],
    alphaLost: [{ doc: "missing.geml", id: "q", anchor: "t:m#q" }],
    beta: [{ doc: "a.geml", id: "x", anchor: "t:a#x" }],
  }));
  writeFileSync(join(cm, "a.geml"), '=== code {#x kind=fn src="src/a.ts#L1-4" anchor="t:a#x"}\n===\n');
  writeFileSync(join(cm, "b.geml"), "=== code {#y src=src/b.ts#L2-5}\n===\n");
  return { dir, cm };
};

test("find: no symbol matching the query exits 1", () => {
  const { dir, cm } = findFixture();
  const r = run("find.mjs", ["zzz-not-there", cm]);
  assert.equal(r.status, 1);
  assert.match(r.err, /no symbol matching "zzz-not-there"/);
  rmSync(dir, { recursive: true, force: true });
});

test("find: substring match prints doc#id with quoted/bare src, skips unreadable docs and unknown ids", () => {
  const { dir, cm } = findFixture();
  const r = run("find.mjs", ["ALPHA", cm]); // case-insensitive substring
  assert.equal(r.status, 0);
  const lines = r.out.split("\n").filter(Boolean);
  assert.deepEqual(lines.sort(), [
    "alphaGone\ta.geml#zz",                       // id not in the doc: no src column
    "alphaLost\tmissing.geml#q",                  // doc unreadable: src silently skipped
    "alphaOne\ta.geml#x\tsrc/a.ts#L1-4",          // quoted src=
    "alphaTwo\tb.geml#y\tsrc/b.ts#L2-5",          // bare src=
  ]);
  assert.match(r.err, /4 match\(es\) for "ALPHA" across 4 name\(s\)/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// render-all.mjs
// ---------------------------------------------------------------------------

test("render-all: --help exits 2 with usage", () => {
  const r = run("render-all.mjs", ["--help"]);
  assert.equal(r.status, 2);
  assert.match(r.err, /usage: geml codemap render/);
});

test("render-all: unreadable directory exits 1 with a clean error", () => {
  const r = run("render-all.mjs", [join(tmpdir(), "geml-cov-definitely-missing-dir")]);
  assert.equal(r.status, 1);
  assert.match(r.err, /cannot read directory/);
});

test("render-all: an unreadable .geml (a directory wearing the name) fails that page, renders the rest, exits 1", () => {
  const { dir, out } = emitMap([fnSym("alpha", "t:a#alpha"), fileSym()]);
  mkdirSync(join(out, "broken.geml")); // readdir lists it; readFileSync -> EISDIR
  const r = run("render-all.mjs", [out]);
  assert.equal(r.status, 1);
  assert.match(r.err, /render: broken\.geml: unreadable/);
  assert.match(r.err, /rendered 2 page\(s\).*FAILED: broken\.geml/);
  assert.match(readFileSync(join(out, "src.html"), "utf8"), /alpha/, "good pages still rendered");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// verify.mjs
// ---------------------------------------------------------------------------

test("verify: --help exits 2 with usage", () => {
  const r = run("verify.mjs", ["--help"]);
  assert.equal(r.status, 2);
  assert.match(r.err, /usage: geml codemap verify/);
});

// --geml shims: pass 1 runs an arbitrary `check` command. A non-.js cli goes
// through the shell branch; its exit code and streams drive the FAIL report.
const cmdShim = (dir, name, body) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

test("verify: --geml with a non-.js cli (shell branch) passes when the shim exits 0", () => {
  const { dir, out } = emitMap([fnSym("alpha", "t:a#alpha"), fileSym()]);
  const shim = cmdShim(dir, "check-ok.cmd", "@exit 0\r\n");
  const r = run("verify.mjs", ["--geml", shim, out]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /2\/2 documents pass geml check/);
  assert.match(r.err, /all resolve/);
  rmSync(dir, { recursive: true, force: true });
});

test("verify: a failing check with stdout-only diagnostics is reported (FAIL block, stdout fallback)", () => {
  const { dir, out } = emitMap([fnSym("alpha", "t:a#alpha"), fileSym()]);
  const shim = cmdShim(dir, "check-noisy.cmd", "@echo synthetic diagnostic on stdout\r\n@exit 1\r\n");
  const r = run("verify.mjs", ["--geml", shim, out]);
  assert.equal(r.status, 1);
  assert.match(r.err, /FAIL .*index\.geml/);
  assert.match(r.err, /synthetic diagnostic on stdout/, "stdout is the fallback diagnostic stream");
  assert.match(r.err, /0\/2 documents pass geml check/);
  rmSync(dir, { recursive: true, force: true });
});

test("verify: a silently failing check (no output at all) still FAILs cleanly", () => {
  const { dir, out } = emitMap([fnSym("alpha", "t:a#alpha"), fileSym()]);
  const shim = cmdShim(dir, "check-mute.cmd", "@exit 1\r\n");
  const r = run("verify.mjs", ["--geml", shim, out]);
  assert.equal(r.status, 1);
  assert.match(r.err, /FAIL /);
  rmSync(dir, { recursive: true, force: true });
});

test("verify: real check pass + profile pass flag every broken reference shape", () => {
  const { dir, out } = emitMap([fnSym("real", "t:x#real"), fileSym("src/x.ts")]);
  // Handcrafted document (parses clean — probe-validated): every checkRef
  // error path, nested flow-block children, and a nested markdown list whose
  // item carries children (collectIds recursion).
  writeFileSync(join(out, "bad-refs.geml"), [
    "=== meta",
    "module = bad-refs",
    "entry = #nope missing.geml#x #inner.member",
    "===",
    "",
    "# bad-refs",
    "",
    "=== note {#outer}",
    "==== code {#inner}",
    "====",
    "===",
    "",
    "- alpha",
    "  - nested",
    "",
    "=== table {#calls format=csv}",
    "from,         to,     kind",
    "#inner,       #ghost, call",
    ",             #inner, call",
    "noref,        #inner, call",
    "other.geml#z, #inner, call",
    "#inner",
    "===",
    "",
    "=== table {#called-by format=csv}",
    "a, b",
    "x, y",
    "===",
    "",
  ].join("\n"));
  const r = run("verify.mjs", [out]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.err, /documents pass geml check/);
  const refs = r.err.split("\n").filter((l) => l.startsWith("REF "));
  const expect = [
    [/#calls row 1 to: unresolved reference `#ghost`/, "unknown id"],
    [/#calls row 2 from: empty reference cell/, "empty cell"],
    [/#calls row 3 from: not a reference: `noref`/, "no #"],
    [/#calls row 4 from: cannot resolve document `other\.geml`/, "missing sibling doc"],
    [/#calls row 5 to: empty reference cell/, "ragged row pads to empty"],
    [/#called-by: missing from\/to columns/, "wrong columns"],
    [/meta entry: unresolved reference `#nope`/, "meta entry, same-doc id"],
    [/meta entry: cannot resolve document `missing\.geml`/, "meta entry, missing doc"],
  ];
  for (const [re, why] of expect) assert.ok(refs.some((l) => re.test(l)), `${why}: ${re}\n${r.err}`);
  // #inner (a NESTED block id) and the meta `#inner.member` suffix form must
  // RESOLVE — no REF error mentions them as unresolved.
  assert.ok(!refs.some((l) => /unresolved reference `#inner/.test(l)), "nested ids are collected (children recursion)");
  assert.match(r.err, /profile references: \d+ dangling/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// refresh.mjs
// ---------------------------------------------------------------------------

// A codemap dir with a recipe. `cfg` is written verbatim (missing keys are the
// point of several tests). Returns paths; caller removes `dir`.
const refreshFixture = (cfg) => {
  const dir = tmp();
  const cm = join(dir, "map"), idx = join(cm, "_index");
  mkdirSync(idx, { recursive: true });
  // Stamp the on-disk schema version so the exec-path version gate (which
  // refuses any other format) lets the recipe run; a test that wants the raw
  // cfg can still pass its own `version`.
  writeFileSync(join(idx, "refresh.json"), JSON.stringify({ version: 1, ...cfg }));
  return { dir, cm, idx, log: join(idx, "refresh.log") };
};
const gitIn = (dir) => (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const gitCommitArgs = ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q"];

test("refresh: --help exits 2 with usage", () => {
  const r = run("refresh.mjs", ["--help"]);
  assert.equal(r.status, 2);
  assert.match(r.err, /usage: geml codemap refresh/);
});

test("refresh: default dir without a recipe exits 1; --hook without a recipe exits 0 silently", () => {
  const dir = tmp();
  const plain = run("refresh.mjs", [], { cwd: dir }); // defaults to ./.geml-code-graph
  assert.equal(plain.status, 1);
  assert.match(plain.err, /refresh\.json not found/);
  const hook = run("refresh.mjs", ["--hook"], { cwd: dir, input: "{}" });
  assert.equal(hook.status, 0, "not opted in: silent success");
  assert.equal(hook.err, "");
  rmSync(dir, { recursive: true, force: true });
});

test("refresh: --hook with a recipe but a payload that is not a git commit exits 0 without refreshing", () => {
  const { dir, cm } = refreshFixture({ root: "..", steps: [] });
  // valid JSON, no tool_input at all -> optional chain + ?? "" -> no match
  const r1 = run("refresh.mjs", [cm, "--hook"], { input: '{"other":1}' });
  assert.equal(r1.status, 0);
  assert.equal(r1.all, "");
  // non-JSON stdin -> parse error swallowed -> no match
  const r2 = run("refresh.mjs", [cm, "--hook"], { input: "not json at all" });
  assert.equal(r2.status, 0);
  const r3 = run("refresh.mjs", [cm, "--hook"], { input: '{"tool_input":{"command":"ls -la"}}' });
  assert.equal(r3.status, 0, "a non-commit command does not refresh");
  rmSync(dir, { recursive: true, force: true });
});

test("refresh: a recipe without root/steps runs with the defaults (.. and no steps)", () => {
  const { dir, cm, log } = refreshFixture({}); // no root, no steps, no git repo around it
  const r = run("refresh.mjs", [cm]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /codemap refresh: done \(0 step\(s\)\)/);
  assert.match(readFileSync(log, "utf8"), /refresh @ no-git/);
  rmSync(dir, { recursive: true, force: true });
});

test("refresh: legacy last_commit in refresh.json is honored when index.geml carries no stamp", () => {
  const { dir, cm, idx } = refreshFixture({});
  const g = gitIn(dir);
  g("init", "-q");
  g(...gitCommitArgs, "--allow-empty", "-m", "c0");
  const head = g("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(idx, "refresh.json"), JSON.stringify({ root: "..", last_commit: head, steps: ["exit 9"] }));
  const r = run("refresh.mjs", [cm]); // no index.geml at all -> readFileSync throws -> fallback
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /up to date at/);
  rmSync(dir, { recursive: true, force: true });
});

test("refresh: a step that cannot even spawn (recipe root does not exist) fails with the spawn error", () => {
  const { dir, cm, log } = refreshFixture({ root: "../definitely-not-here", steps: [{ argv: ["echo", "hi"] }] });
  const r = run("refresh.mjs", [cm, "--trust"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /codemap refresh: step failed \(exit .*ENOENT/s, "status/signal are null: the error message is the exit reason");
  assert.match(readFileSync(log, "utf8"), /FAILED \(exit /);
  rmSync(dir, { recursive: true, force: true });
});

await atest("refresh: --background detaches (with --force/--commit forwarded) and the child completes on its own", async () => {
  const { dir, cm, log } = refreshFixture({ root: "..", steps: [{ argv: ["node", "-e", "require('fs').writeFileSync('marker.txt','ran')"] }] });
  const r = run("refresh.mjs", [cm, "--background", "--force", "--commit", "--trust"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /running in background \(log: /);
  // The detached child re-runs this script synchronously and exits by itself
  // (no kill — V8 coverage must flush). Wait for its log to say ok.
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (existsSync(log) && /^ok$/m.test(readFileSync(log, "utf8"))) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  assert.match(readFileSync(log, "utf8"), /^ok$/m, "background child ran the recipe to completion");
  assert.equal(readFileSync(join(dir, "marker.txt"), "utf8"), "ran", "step ran with the project root as cwd");
  await new Promise((res) => setTimeout(res, 400)); // let the child fully exit before the dir is removed
  rmSync(dir, { recursive: true, force: true });
});

test("refresh: --commit is refused when the recipe itself moved HEAD (guard), and when a merge is in progress", () => {
  // (a) HEAD moves during the refresh: the step commits.
  const a = refreshFixture({ root: "..", steps: [{ argv: ["git", ...gitCommitArgs, "--allow-empty", "-m", "mid"] }] });
  const ga = gitIn(a.dir);
  ga("init", "-q");
  ga(...gitCommitArgs, "--allow-empty", "-m", "c0");
  const ra = run("refresh.mjs", [a.cm, "--commit", "--trust"]);
  assert.equal(ra.status, 0, ra.all);
  assert.match(ra.err, /not auto-committing \(HEAD moved during the refresh\)/);
  rmSync(a.dir, { recursive: true, force: true });
  // (b) merge in progress: MERGE_HEAD exists.
  const b = refreshFixture({ root: "..", steps: [] });
  const gb = gitIn(b.dir);
  gb("init", "-q");
  gb(...gitCommitArgs, "--allow-empty", "-m", "c0");
  writeFileSync(join(b.dir, ".git", "MERGE_HEAD"), gb("rev-parse", "HEAD").stdout);
  const rb = run("refresh.mjs", [b.cm, "--commit"]);
  assert.equal(rb.status, 0, rb.all);
  assert.match(rb.err, /not auto-committing \(merge in progress\)/);
  rmSync(b.dir, { recursive: true, force: true });
});

test("refresh: --commit with an unchanged codemap reports nothing to commit", () => {
  const { dir, cm } = refreshFixture({ root: "..", steps: [] });
  const g = gitIn(dir);
  g("init", "-q");
  g("add", "-A");
  g(...gitCommitArgs, "-m", "c0"); // codemap fully committed; empty steps change nothing
  const r = run("refresh.mjs", [cm, "--commit"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /nothing to commit \(codemap unchanged\)/);
  rmSync(dir, { recursive: true, force: true });
});

test("refresh: --commit works when the codemap dir IS the repo root (pathspec collapses to .)", () => {
  const dir = tmp(); // cm == git root
  const idx = join(dir, "_index");
  mkdirSync(idx, { recursive: true });
  const g = gitIn(dir);
  g("init", "-q");
  g(...gitCommitArgs, "--allow-empty", "-m", "c0");
  writeFileSync(join(idx, "refresh.json"), JSON.stringify({ version: 1, root: ".", steps: [] }));
  const r = run("refresh.mjs", [dir, "--commit"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /committed as [0-9a-f]+/);
  const inCommit = g("show", "--name-only", "--pretty=format:", "HEAD").stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(inCommit.includes("_index/refresh.json"), `recipe committed: ${inCommit}`);
  assert.ok(!inCommit.some((f) => /refresh\.log$/.test(f)), "runtime log stays out of the commit");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// build.mjs — explicit-adapter paths
// ---------------------------------------------------------------------------

// A tiny Joern export (methods.jsonl + calls.jsonl), the cheapest real input.
const joernRaw = (dir) => {
  mkdirSync(dir, { recursive: true });
  const m = (name, file, ls) => JSON.stringify({ fullName: `C.${name}`, signature: "s()", file, name, lineStart: ls, lineEnd: ls + 3 });
  writeFileSync(join(dir, "methods.jsonl"), `${m("caller", "src/big.c", 1)}\n${m("callee", "lib/util.c", 10)}\n`);
  const call = JSON.stringify({
    callerFullName: "C.caller", callerSignature: "s()", callerFile: "src/big.c", line: 3,
    name: "callee", callees: [{ fullName: "C.callee", signature: "s()", file: "lib/util.c" }],
  });
  writeFileSync(join(dir, "calls.jsonl"), call + "\n");
};

test("build: --raw without --adapter and --remap without a group are usage errors (exit 2)", () => {
  const raw = run("build.mjs", ["--raw", "x"]);
  assert.equal(raw.status, 2);
  assert.match(raw.err, /--raw needs a preceding --adapter/);
  const remap = run("build.mjs", ["--remap", "x"]);
  assert.equal(remap.status, 2);
  assert.match(remap.err, /--remap needs a preceding --adapter/);
});

test("build: unknown adapter and crg-without-db print usage (exit 2)", () => {
  const bogus = run("build.mjs", ["--adapter", "bogus", "--raw", "x"]);
  assert.equal(bogus.status, 2);
  assert.match(bogus.err, /usage: geml codemap build/);
  const nodb = run("build.mjs", ["--adapter", "crg"]);
  assert.equal(nodb.status, 2);
  assert.match(nodb.err, /usage: geml codemap build/);
});

test("build: invalid --container is rejected after extraction (exit 2)", () => {
  const dir = tmp();
  const raw = join(dir, "raw");
  joernRaw(raw);
  const r = run("build.mjs", ["--adapter", "joern", "--raw", raw, "--root", dir, "--out", join(dir, "map"), "--build", join(dir, "b"), "--container", "bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.err, /--container must be module\|dir\|file \(got 'bogus'\)/);
  rmSync(dir, { recursive: true, force: true });
});

test("build: a bare --db keeps the historical crg default and builds from a real graph.db", () => {
  const dir = tmp();
  const dbPath = join(dir, "graph.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE nodes(id INTEGER, kind TEXT, name TEXT, qualified_name TEXT,
             file_path TEXT, line_start INTEGER, line_end INTEGER, language TEXT, is_test INTEGER);
           CREATE TABLE edges(kind TEXT, source_qualified TEXT, target_qualified TEXT, file_path TEXT, line INTEGER);`);
  const ins = db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run(1, "File", "a.ts", "src/a.ts", "src/a.ts", null, null, "typescript", 0);
  ins.run(2, "Function", "main", "src/a.ts::main", "src/a.ts", 1, 5, "typescript", 0);
  ins.run(3, "Function", "helper", "src/a.ts::helper", "src/a.ts", 7, 9, "typescript", 0);
  const ie = db.prepare("INSERT INTO edges VALUES (?,?,?,?,?)");
  ie.run("CALLS", "src/a.ts::main", "src/a.ts::helper", "src/a.ts", 2);
  ie.run("CALLS", "src/a.ts::main", "vendor/gone.ts::mystery", "src/a.ts", 3); // unresolved -> to_text
  ie.run("CONTAINS", "src/a.ts", "src/a.ts::main", "src/a.ts", 1);             // structural: dropped
  db.close();
  const out = join(dir, "map");
  const r = run("build.mjs", ["--db", dbPath, "--root", dir, "--out", out, "--build", join(dir, "b")]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /input crg: 3 symbols, 2 edges/);
  const docNames = ["src.geml", `${dir.split(/[\\/]/).pop()}.geml`];
  const doc = docNames.map((n) => join(out, n)).find(existsSync);
  assert.ok(doc, "container doc emitted");
  assert.match(readFileSync(doc, "utf8"), /#main/, "crg symbols made it into the map");
  rmSync(dir, { recursive: true, force: true });
});

test("build: --remap after an adapter group is accepted and forwarded (missing manifest = plain index)", () => {
  const dir = tmp();
  const raw = join(dir, "raw");
  joernRaw(raw);
  const r = run("build.mjs", [
    "--adapter", "joern", "--raw", raw, "--remap", join(dir, "no-manifest-here"),
    "--root", dir, "--out", join(dir, "map"), "--build", join(dir, "b"),
  ]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /input joern: 4 symbols/);
  rmSync(dir, { recursive: true, force: true });
});

test("build: --exclude drops matching symbols; gitignore-on and -off wordings both print", () => {
  const dir = tmp();
  const raw = join(dir, "raw");
  joernRaw(raw); // symbols in src/big.c and lib/util.c
  const argsFor = (out, ...extra) => [
    "--adapter", "joern", "--raw", raw, "--root", dir,
    "--out", join(dir, out), "--build", join(dir, out + "-b"),
    "--exclude", "src/**", ...extra,
  ];
  const on = run("build.mjs", argsFor("m1"));
  assert.equal(on.status, 0, on.all);
  assert.match(on.err, /excluded 2 symbol\(s\) via \.gitignore \+ 1 --exclude glob\(s\)/);
  const off = run("build.mjs", argsFor("m2", "--no-gitignore"));
  assert.equal(off.status, 0, off.all);
  assert.match(off.err, /excluded 2 symbol\(s\) via \(gitignore off\) \+ 1 --exclude glob\(s\)/);
  assert.ok(!existsSync(join(dir, "m1", "src.geml")), "excluded container not emitted");
  rmSync(dir, { recursive: true, force: true });
});

test("build: --history snapshots docs into sidecars; a rebuild with no changes rewrites nothing and skips history", () => {
  const dir = tmp();
  const raw = join(dir, "raw");
  joernRaw(raw);
  const out = join(dir, "map"), bld = join(dir, "b");
  const args = ["--adapter", "joern", "--raw", raw, "--root", dir, "--out", out, "--build", bld, "--history", "-m", "first snap"];
  const r1 = run("build.mjs", args);
  assert.equal(r1.status, 0, r1.all);
  assert.match(r1.err, /history: committed \d+ document\(s\)/);
  const sidecars = ["index.gemlhistory", "src.gemlhistory"].map((n) => join(out, n)).filter(existsSync);
  assert.ok(sidecars.length >= 1, "sidecars written");
  assert.match(readFileSync(sidecars[0], "utf8"), /first snap/, "-m message recorded");
  const r2 = run("build.mjs", args); // identical input: writeIfChanged short-circuits
  assert.equal(r2.status, 0, r2.all);
  assert.match(r2.err, /\(0 of \d+ files written\)/, "unchanged build rewrites no document");
  assert.match(r2.err, /history: committed 0 document\(s\) \(\d+ unchanged, skipped\)/);
  rmSync(dir, { recursive: true, force: true });
});

test("build: gitignore alone (no --exclude globs) drops ignored symbols", () => {
  const dir = tmp();
  const raw = join(dir, "raw");
  joernRaw(raw); // symbols in src/big.c and lib/util.c
  const g = gitIn(dir);
  g("init", "-q");
  writeFileSync(join(dir, ".gitignore"), "src/\nraw/\nmap/\nb/\n");
  const r = run("build.mjs", ["--adapter", "joern", "--raw", raw, "--root", dir, "--out", join(dir, "map"), "--build", join(dir, "b")]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /excluded 2 symbol\(s\) via \.gitignore\n/, "no glob suffix when only .gitignore drove the exclusion");
  rmSync(dir, { recursive: true, force: true });
});

test("build: a corrupt .gemlhistory sidecar fails THAT document's snapshot, not the build", () => {
  const dir = tmp();
  const raw = join(dir, "raw");
  joernRaw(raw);
  const out = join(dir, "map");
  const args = ["--adapter", "joern", "--raw", raw, "--root", dir, "--out", out, "--build", join(dir, "b"), "--history"];
  const r1 = run("build.mjs", args);
  assert.equal(r1.status, 0, r1.all);
  // Corrupt one sidecar: the doc itself is unchanged next build (not rewritten),
  // but its history tip no longer matches, so build re-targets it — and the
  // commit is refused. The build must keep going and name the casualty.
  assert.ok(existsSync(join(out, "index.gemlhistory")), "sidecar to corrupt exists");
  writeFileSync(join(out, "index.gemlhistory"), "total garbage, not a history file\n");
  const r2 = run("build.mjs", args);
  assert.equal(r2.status, 0, r2.all);
  assert.match(r2.err, /history: index\.geml: history: unknown revision/);
  assert.match(r2.err, /history: committed \d+ document\(s\).*; FAILED: index\.geml/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// build.mjs — auto-detect mode
// ---------------------------------------------------------------------------

test("build auto: an empty root cannot auto-detect (exit 1); --lang with no Joern job is called out", () => {
  const dir = tmp();
  const r = run("build.mjs", ["--root", dir, "--out", join(dir, "map"), "--lang", "FOO"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /--lang FOO: no Joern language detected to override \(ignored\)/);
  assert.match(r.err, /could not auto-detect a supported language/);
  rmSync(dir, { recursive: true, force: true });
});

test("build auto: a Java repo without Joern anywhere exits 1 with install instructions", () => {
  const dir = tmp();
  writeFileSync(join(dir, "pom.xml"), "<project/>");
  mkdirSync(join(dir, "A dir with spaces")); // --joern candidate: a DIRECTORY (spaced, so the launcher path needs quoting)
  const emptyPath = join(dir, "empty-bin");
  mkdirSync(emptyPath);
  const r = run("build.mjs", ["--root", dir, "--out", join(dir, "map"), "--lang", "JAVASRC", "--joern", join(dir, "A dir with spaces")], {
    env: { ...process.env, PATH: emptyPath, GEML_JOERN: "" }, // no joern reachable, ComSpec still resolves cmd
  });
  assert.equal(r.status, 1, r.all);
  // (the "detected:" plan line prints only after the probes pass, so the
  // missing-Joern error is the whole story here)
  assert.match(r.err, /Joern is required for Java but was not found/);
  rmSync(dir, { recursive: true, force: true });
});

test("build auto: a Rust repo without rust-analyzer exits 1 with install instructions", () => {
  const dir = tmp();
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "spike"\n');
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "main.rs"), "fn main() {}\n");
  const emptyPath = join(dir, "empty-bin");
  mkdirSync(emptyPath);
  const r = run("build.mjs", ["--root", dir, "--out", join(dir, "map")], {
    env: { ...process.env, PATH: emptyPath },
  });
  assert.equal(r.status, 1, r.all);
  assert.match(r.err, /rust-analyzer is required for Rust but was not found/);
  rmSync(dir, { recursive: true, force: true });
});

// ---- fake indexers ----------------------------------------------------------
// Minimal SCIP protobuf writer (copied from test/codemap.test.mjs) — enough of
// the wire format for the adapter's reader, so the fake `npx`/`rust-analyzer`
// shims can hand build.mjs a REAL index without any network or toolchain.
const vint = (n) => { const b = []; do { const x = n & 0x7f; n = Math.floor(n / 128); b.push(n ? x | 0x80 : x); } while (n); return b; };
const lenField = (no, bytes) => [...vint((no << 3) | 2), ...vint(bytes.length), ...bytes];
const intField = (no, v) => [...vint(no << 3), ...vint(v)];
const strField = (no, s) => lenField(no, [...Buffer.from(s, "utf8")]);
const packedField = (no, ints) => lenField(no, ints.flatMap(vint));
const scipOcc = ({ range, symbol, roles = 0, enclosing }) => lenField(2, [
  ...packedField(1, range), ...strField(2, symbol),
  ...(roles ? intField(3, roles) : []),
  ...(enclosing ? packedField(7, enclosing) : []),
]);
const scipDoc = (path, occs) => lenField(2, [...strField(1, path), ...occs.flat()]);

const TSY = "scip-typescript npm p 1.0.0 ";
const RA = "rust-analyzer cargo spike 0.1.0 ";
const tsScipBytes = Buffer.from([
  ...scipDoc("src/a.ts", [
    scipOcc({ range: [1, 9, 12], symbol: TSY + "src/`a.ts`/foo().", roles: 1, enclosing: [1, 0, 3, 1] }),
    scipOcc({ range: [2, 2, 5], symbol: TSY + "src/`a.ts`/bar()." }),
    scipOcc({ range: [5, 9, 12], symbol: TSY + "src/`a.ts`/bar().", roles: 1, enclosing: [5, 0, 7, 1] }),
  ]),
]);
const rustScipBytes = Buffer.from([
  ...scipDoc("src/main.rs", [
    scipOcc({ range: [2, 3, 2, 7], symbol: RA + "main().", roles: 1, enclosing: [2, 0, 6, 1] }),
  ]),
]);

// Shim dir: npx.bat / rust-analyzer.bat -> helper.cjs. The helper answers
// --version probes, plants a fixture .scip for index runs (or fails the `bad`
// project), and stands in for the SFC virtualizer pre-step (fails for vue1,
// succeeds for vue2).
const makeShims = () => {
  const shim = mkdtempSync(join(tmpdir(), "geml-cov-shim-"));
  writeFileSync(join(shim, "ts.scip.fixture"), tsScipBytes);
  writeFileSync(join(shim, "rust.scip.fixture"), rustScipBytes);
  writeFileSync(join(shim, "helper.cjs"), [
    'const fs = require("node:fs"), path = require("node:path");',
    "const [mode, ...rest] = process.argv.slice(2);",
    'if (rest.includes("--version")) process.exit(0);',
    'const oi = rest.indexOf("--output");',
    "if (oi >= 0) {",
    "  const out = rest[oi + 1];",
    "  if (process.env.GEML_FAKE_FAIL_ALL) process.exit(3);",
    '  if (path.basename(out).includes("index-bad")) process.exit(3);',
    "  fs.mkdirSync(path.dirname(out), { recursive: true });",
    '  fs.copyFileSync(path.join(__dirname, mode === "rust" ? "rust.scip.fixture" : "ts.scip.fixture"), out);',
    "  process.exit(0);",
    "}",
    "if (process.env.GEML_OUT) { // the SFC virtualizer pre-step",
    '  if (String(process.env.GEML_SRC).includes("vue1")) process.exit(7);',
    "  fs.mkdirSync(process.env.GEML_OUT, { recursive: true });",
    "  process.exit(0);",
    "}",
    "process.exit(9);",
  ].join("\n"));
  writeFileSync(join(shim, "npx.bat"), `@echo off\r\n"${process.execPath}" "%~dp0helper.cjs" ts %*\r\n`);
  writeFileSync(join(shim, "rust-analyzer.bat"), `@echo off\r\n"${process.execPath}" "%~dp0helper.cjs" rust %*\r\n`);
  return shim;
};
const shimEnv = (shim) => ({
  ...process.env, // NODE_V8_COVERAGE must survive into every child
  PATH: shim + delimiter + process.env.PATH,
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
});

test("build auto: full pipeline — 15 jobs, one indexer fails, SFC fallback + remap, recipe recorded", () => {
  const fx = tmp();
  const shim = makeShims();
  // Rust at the root + 14 TS projects: 11 healthy, one whose indexer dies,
  // one whose virtualizer dies (falls back to plain TS), one that remaps.
  writeFileSync(join(fx, "Cargo.toml"), '[package]\nname = "spike"\n');
  mkdirSync(join(fx, "src"));
  writeFileSync(join(fx, "src", "main.rs"), "fn main() {}\n");
  const tsProj = (name) => {
    mkdirSync(join(fx, name, "src"), { recursive: true });
    writeFileSync(join(fx, name, "tsconfig.json"), "{}");
    writeFileSync(join(fx, name, "src", "a.ts"), "export const x = 1;\n");
  };
  for (let i = 1; i <= 11; i++) tsProj(`good${i}`);
  tsProj("bad");
  const vueProj = (name) => {
    mkdirSync(join(fx, name, "src"), { recursive: true });
    writeFileSync(join(fx, name, "package.json"), JSON.stringify({ name, dependencies: { vue: "^3.0.0" } }));
    writeFileSync(join(fx, name, "src", "App.vue"), "<template><div/></template>\n");
  };
  vueProj("vue1");
  vueProj("vue2");
  const out = join(fx, ".geml-code-graph");
  const r = run("build.mjs", ["--root", fx, "--out", out, "--container", "file", "--history", "--exclude", "zzz/**"],
    { env: shimEnv(shim) });
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /detected: 15 jobs \(Rust, TypeScript×14\) — e\.g\. /, "job wall summarized past 10");
  assert.match(r.err, /sfc virtualizer failed for TypeScript\[vue1\] \(exit 7\).*falling back to plain TS indexing/s);
  assert.match(r.err, /indexer failed for TypeScript at bad \(scip\): exit 3/);
  assert.match(r.err, /WARNING: continuing WITHOUT TypeScript/);
  assert.match(r.err, /duplicate anchors dropped/, "identical project indexes deduped by anchor");
  assert.match(r.err, /history: committed \d+ document\(s\)/);
  assert.match(r.err, /recorded build recipe/);
  const cfg = JSON.parse(readFileSync(join(out, "_index", "refresh.json"), "utf8"));
  assert.equal(cfg.root, "..");
  // Structured steps { cwd?, env?, argv:[...] } (R2-1) — assert on the shape.
  const stepsJson = cfg.steps.map((s) => JSON.stringify(s)).join("\n");
  assert.ok(cfg.steps.some((s) => s.cwd === "good1" && s.argv.join(" ").includes("npx --yes @sourcegraph/scip-typescript index --output")),
    "subrooted scip replay step");
  assert.ok(cfg.steps.some((s) => s.argv?.slice(0, 4).join(" ") === "rust-analyzer scip . --output"), "rust replay step");
  assert.ok(cfg.steps.some((s) => s.env?.GEML_SRC === "vue2"), "successful virtualizer pre-step recorded");
  assert.match(stepsJson, /--remap.*\.geml-code-graph\/_build\/virtual-vue2/, "remap forwarded into the replay build");
  assert.ok(cfg.steps.some((s) => s.argv?.includes("--container") && s.argv.includes("file") && s.argv.includes("--history")),
    "the build step records --container file --history");
  assert.deepEqual(cfg.steps.at(-1), { argv: ["geml", "codemap", "verify", ".geml-code-graph"] });
  assert.ok(!cfg.steps.some((s) => s.env?.GEML_SRC === "vue1"), "failed virtualizer left NO pre-step (only its fallback index run)");
  rmSync(fx, { recursive: true, force: true });
  rmSync(shim, { recursive: true, force: true });
});

test("build auto: every indexer failing means nothing to build (exit 1)", () => {
  const fx = tmp();
  const shim = makeShims();
  mkdirSync(join(fx, "src")); // ROOT-level project: the failure names the bare language, no subroot
  writeFileSync(join(fx, "tsconfig.json"), "{}");
  writeFileSync(join(fx, "src", "a.ts"), "export const x = 1;\n");
  const r = run("build.mjs", ["--root", fx, "--out", join(fx, "map")],
    { env: { ...shimEnv(shim), GEML_FAKE_FAIL_ALL: "1" } });
  assert.equal(r.status, 1, r.all);
  assert.match(r.err, /indexer failed for TypeScript \(scip\): exit 3/, "no subroot: the language alone names the job");
  assert.match(r.err, /every indexer failed — nothing to build\./);
  rmSync(fx, { recursive: true, force: true });
  rmSync(shim, { recursive: true, force: true });
});

test("build auto: a ROOT-level SFC project whose virtualizer fails falls back without a subroot tag", () => {
  const base = tmp();
  const fx = join(base, "vue1root"); // "vue1" substring makes the shim's virtualizer fail
  const shim = makeShims();
  mkdirSync(join(fx, "src"), { recursive: true });
  writeFileSync(join(fx, "package.json"), JSON.stringify({ name: "v", dependencies: { vue: "^3.0.0" } }));
  writeFileSync(join(fx, "src", "App.vue"), "<template><div/></template>\n");
  const r = run("build.mjs", ["--root", fx, "--out", join(fx, "map")], { env: shimEnv(shim) });
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /sfc virtualizer failed for TypeScript \(exit 7\)/, "no [subroot] suffix for the root project");
  assert.match(r.err, /geml-code-graph: /, "fallback plain-TS index still built the map");
  rmSync(base, { recursive: true, force: true });
  rmSync(shim, { recursive: true, force: true });
});

test("build auto: --out equal to --root works; recipe paths collapse to . (root recorded as ..)", () => {
  const fx = tmp();
  const shim = makeShims();
  writeFileSync(join(fx, "tsconfig.json"), "{}");
  mkdirSync(join(fx, "src"));
  writeFileSync(join(fx, "src", "a.ts"), "export const x = 1;\n");
  const r = run("build.mjs", ["--root", fx, "--out", fx], { env: shimEnv(shim) });
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /detected: TypeScript \(tsconfig\.json\) -> scip/);
  const cfg = JSON.parse(readFileSync(join(fx, "_index", "refresh.json"), "utf8"));
  assert.ok(cfg.steps.some((s) => s.argv?.includes("--out") && s.argv[s.argv.indexOf("--out") + 1] === "."), "out collapses to .");
  // out==root: relative(out, root) is "", now recorded as "." (was ".." — a
  // bug that ran refresh in the PARENT of the project root; audit bug#3).
  assert.equal(cfg.root, ".");
  rmSync(fx, { recursive: true, force: true });
  rmSync(shim, { recursive: true, force: true });
});

console.log(passed + " test(s) passed.");
