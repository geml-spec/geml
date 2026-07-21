// Security-regression tests for the codemap toolchain (branch sec/audit-fixes).
// The security FIXES already landed; these tests pin the SECURE behavior so the
// holes cannot silently reopen, and exercise the new security-critical branches.
// Tests only — no product code is touched.
//
//   C2  the recipe TRUST GATE (RCE): geml codemap refresh refuses to run an
//       untrusted recipe's shell steps (codemap/recipe-trust.mjs + refresh.mjs)
//   H3/L4  command injection: build/verify quote indexer args so a source/doc
//       name full of shell metacharacters is handled literally, never executed
//   L5  scip adapter confines document paths to the root and never throws on a
//       malformed .scip
//   M3  the MCP server confines the client-supplied `doc` to the graph dir and
//       escapes regex metacharacters in `get_backlinks` ids (no ReDoS)
//
// Children are spawned as real processes and always exit on their own (V8
// coverage flushes on clean exit) — never killed. No servers, no ports.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, delimiter, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  recipeFingerprint, trustStorePath, readTrustStore, isRecipeTrusted, trustRecipe,
} from "../codemap/recipe-trust.mjs";
import { extract as scipExtract } from "../codemap/adapters/scip.mjs";
import * as mcp from "../codemap/mcp-server.mjs";

// CRITICAL (audit): isolate the C2 trust store per run — a fresh EMPTY store, so
// every "is refused" assertion below runs against a store that trusts NOTHING.
// A stale trusted fingerprint from a real ~/.config store would make the refuse
// assertions silently pass — a fake green on a security control. run()'s child
// processes inherit process.env, so refresh.mjs children see this same store.
const STORE = join(mkdtempSync(join(tmpdir(), "geml-sectrust-")), "store.json");
process.env.GEML_TRUST_STORE = STORE;

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // geml-parser/
const tmp = () => mkdtempSync(join(tmpdir(), "geml-sec-"));

// Spawn a codemap script exactly like `geml codemap <sub>`; capture everything.
const run = (script, args = [], opts = {}) => {
  const r = spawnSync(process.execPath, [join(PKG, "codemap", script), ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000, ...opts,
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "", all: (r.stdout ?? "") + (r.stderr ?? "") };
};

// A recipe fixture: <dir>/map/_index/refresh.json. `root: ".."` makes the
// project root = <dir>, so a step's cwd is <dir>.
const recipeFixture = (cfg) => {
  const dir = tmp();
  const cm = join(dir, "map");
  const idx = join(cm, "_index");
  mkdirSync(idx, { recursive: true });
  writeFileSync(join(idx, "refresh.json"), JSON.stringify(cfg));
  return { dir, cm, idx };
};
// A step that writes a MARKER — its presence is the witness that the recipe ran.
// `tag` keeps each fixture's recipe fingerprint DISTINCT: the trust store is
// shared across this process's children, so trusting one recipe (C2(b)) must
// not accidentally trust another test's identical-looking recipe.
const markerStep = (tag) => `node -e "require('fs').writeFileSync('MARKER.txt','${tag}')"`;

// ---------------------------------------------------------------------------
// C2 — the recipe TRUST GATE (the RCE fix; MOST IMPORTANT)
// ---------------------------------------------------------------------------

test("C2(a) an untrusted recipe is REFUSED (exit 3), its steps shown, marker NOT written", () => {
  const { dir, cm } = recipeFixture({ root: "..", steps: [markerStep("a")] });
  const r = run("refresh.mjs", [cm]); // empty store => not trusted
  assert.equal(r.status, 3, r.all);
  assert.match(r.err, /REFUSING to run an untrusted recipe/);
  assert.match(r.err, /\$ node -e/, "the exact steps are printed for review");
  assert.ok(!existsSync(join(dir, "MARKER.txt")), "the untrusted recipe never executed");
  rmSync(dir, { recursive: true, force: true });
});

test("C2(b) --trust runs it (marker written); the trust is remembered across processes", () => {
  const { dir, cm } = recipeFixture({ root: "..", steps: [markerStep("b")] });
  const marker = join(dir, "MARKER.txt");
  const t = run("refresh.mjs", [cm, "--trust"]);
  assert.equal(t.status, 0, t.all);
  assert.match(t.err, /recipe trusted/);
  assert.ok(existsSync(marker), "an explicitly trusted recipe executes");
  rmSync(marker, { force: true });
  // A SECOND, plain run in a fresh process re-runs it: trust persisted in the
  // store (content-addressed by fingerprint), not just in the first process.
  const again = run("refresh.mjs", [cm]);
  assert.equal(again.status, 0, again.all);
  assert.match(again.err, /done \(1 step/);
  assert.ok(existsSync(marker), "remembered as trusted across a separate process");
  rmSync(dir, { recursive: true, force: true });
});

test("C2(c) forging index.geml's commit cannot bypass the gate (still exit 3, no marker)", () => {
  const { dir, cm } = recipeFixture({ root: "..", steps: [markerStep("c")] });
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c0");
  // The up-to-date guard reads `commit = <sha>` from index.geml; forge it. HEAD
  // != deadbeef so the skip does not fire, and `git diff deadbeef HEAD` fails on
  // the bogus ref — so execution reaches the gate. The gate is INDEPENDENT of
  // the commit check: forging the stamp only changes which skip is (not) taken,
  // never whether an untrusted recipe may exec.
  writeFileSync(join(cm, "index.geml"), "=== meta\ncommit = deadbeef\n===\n");
  const r = run("refresh.mjs", [cm]);
  assert.equal(r.status, 3, r.all);
  assert.match(r.err, /REFUSING to run an untrusted recipe/);
  assert.ok(!existsSync(join(dir, "MARKER.txt")), "the gate fires regardless of the commit check");
  rmSync(dir, { recursive: true, force: true });
});

test("C2(d) --hook with an untrusted recipe is a warn+no-op (exit 0, never blocks a commit)", () => {
  const { dir, cm } = recipeFixture({ root: "..", steps: [markerStep("d")] });
  // A real git-commit PostToolUse payload: matches the commit trigger, so the
  // hook does NOT early-exit — it reaches the not-trusted arm and no-ops.
  const r = run("refresh.mjs", [cm, "--hook"],
    { input: JSON.stringify({ tool_input: { command: "git commit -m x" } }) });
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /not trusted — skipping/);
  assert.ok(!existsSync(join(dir, "MARKER.txt")), "hook mode does not execute an untrusted recipe");
  rmSync(dir, { recursive: true, force: true });
});

test("C2(e) recipe-trust units: store-path resolution, defensive reads, write failure, stable fingerprint", () => {
  const savedStore = process.env.GEML_TRUST_STORE; // == STORE
  const savedXdg = process.env.XDG_CONFIG_HOME;
  // --- trustStorePath: explicit override > XDG_CONFIG_HOME > ~/.config ---
  try {
    process.env.GEML_TRUST_STORE = "X:/explicit/store.json";
    assert.equal(trustStorePath(), "X:/explicit/store.json", "GEML_TRUST_STORE wins");
    delete process.env.GEML_TRUST_STORE;
    process.env.XDG_CONFIG_HOME = join(tmpdir(), "xdg-sec");
    assert.equal(trustStorePath(), join(tmpdir(), "xdg-sec", "geml", "trusted-recipes.json"), "XDG fallback");
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(trustStorePath(), join(homedir(), ".config", "geml", "trusted-recipes.json"), "homedir fallback");
  } finally {
    if (savedStore === undefined) delete process.env.GEML_TRUST_STORE; else process.env.GEML_TRUST_STORE = savedStore;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  }
  // --- readTrustStore is DEFENSIVE: broken store => nothing trusted ---
  const gdir = tmp();
  const garbage = join(gdir, "garbage.json");
  try {
    process.env.GEML_TRUST_STORE = garbage;
    writeFileSync(garbage, "{ not json at all ");
    assert.deepEqual(readTrustStore(), { version: 1, recipes: {} }, "malformed store trusts nothing");
    assert.equal(isRecipeTrusted("anything"), false, "so nothing is trusted");
    writeFileSync(garbage, JSON.stringify({ recipes: "not-an-object" }));
    assert.deepEqual(readTrustStore(), { version: 1, recipes: {} }, "wrong-shape store trusts nothing");
    writeFileSync(garbage, JSON.stringify([1, 2, 3]));
    assert.deepEqual(readTrustStore(), { version: 1, recipes: {} }, "array store trusts nothing");
    // sanity: a well-formed store IS read back
    writeFileSync(garbage, JSON.stringify({ version: 2, recipes: { abc: { addedAt: 1 } } }));
    const ok = readTrustStore();
    assert.equal(ok.version, 2);
    assert.equal(isRecipeTrusted("abc"), true);
  } finally { process.env.GEML_TRUST_STORE = savedStore; }
  // --- trustRecipe THROWS when the store path is unwritable (parent is a FILE) ---
  const bdir = tmp();
  const fileNotDir = join(bdir, "iam-a-file");
  writeFileSync(fileNotDir, "x");
  try {
    process.env.GEML_TRUST_STORE = join(fileNotDir, "store.json"); // dirname is a file => mkdir throws
    assert.throws(() => trustRecipe("deadbeef", "/graph"), "an unwritable store surfaces as a throw, not a false success");
  } finally { process.env.GEML_TRUST_STORE = savedStore; }
  // --- recipeFingerprint: deterministic, key-order independent, string-coerced ---
  const fpA = recipeFingerprint({ root: "..", steps: ["a", "b"] });
  assert.equal(recipeFingerprint({ steps: ["a", "b"], root: ".." }), fpA, "independent of object key order");
  assert.equal(recipeFingerprint({ root: "..", steps: ["a", "b"] }), fpA, "stable across calls");
  assert.equal(recipeFingerprint({ root: "..", steps: [1] }), recipeFingerprint({ root: "..", steps: ["1"] }), "steps coerced to strings");
  assert.equal(recipeFingerprint({ steps: ["x"] }), recipeFingerprint({ root: "", steps: ["x"] }), "absent root == empty root");
  assert.notEqual(recipeFingerprint({ root: "..", steps: ["a"] }), recipeFingerprint({ root: ".", steps: ["a"] }), "root participates in identity");
  assert.notEqual(fpA, recipeFingerprint({ root: "..", steps: ["b", "a"] }), "step order participates in identity");
  rmSync(gdir, { recursive: true, force: true });
  rmSync(bdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scip protobuf wire builders (same shape as test/cov-adapters.test.mjs)
// ---------------------------------------------------------------------------
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
const TS = "scip-typescript npm t 1.0.0 ";

// ---------------------------------------------------------------------------
// L5 — scip adapter: path confinement + malformed-input DoS safety
// ---------------------------------------------------------------------------

test("L5 scip: docs whose relative_path escapes the root are dropped; in-root works; garbage never throws", () => {
  const dir = tmp();
  const scip = join(dir, "index.scip");
  writeFileSync(scip, Buffer.from([
    ...scipDoc("src/ok.ts", [scipOcc({ range: [1, 9, 12], symbol: TS + "src/`ok.ts`/foo().", roles: 1, enclosing: [1, 0, 3, 1] })]),
    ...scipDoc("../../../evil.ts", [scipOcc({ range: [1, 9, 12], symbol: TS + "esc/`evil.ts`/evil().", roles: 1, enclosing: [1, 0, 3, 1] })]),
    ...scipDoc("/abs/evil2.ts", [scipOcc({ range: [1, 9, 12], symbol: TS + "abs/`evil2.ts`/evil2().", roles: 1, enclosing: [1, 0, 3, 1] })]),
  ]));
  const r = scipExtract({ raw: scip, root: dir });
  const files = r.symbols.map((s) => s.file);
  assert.ok(files.includes("src/ok.ts"), "the in-root document is seeded");
  assert.ok(r.symbols.some((s) => s.kind === "Function" && s.name === "foo"), "its function is present");
  assert.ok(!files.some((f) => f.includes("evil")), "no symbol seeded from a `..` or absolute path");
  assert.ok(!files.some((f) => f.startsWith("..") || isAbsolute(f)), "nothing lands outside the root");
  assert.ok(r.edges.every((e) => !String(e.from).includes("evil") && !String(e.to ?? "").includes("evil")), "no edge from/to an escaping doc");
  // A truncated protobuf (a documents field claiming more bytes than exist)
  // must degrade to a clean empty result, not an uncaught throw.
  writeFileSync(scip, Buffer.from([(2 << 3) | 2, 0x0a]));
  assert.deepEqual(scipExtract({ raw: scip, root: dir }), { symbols: [], edges: [] }, "truncated -> clean empty");
  // Pure garbage (an over-long varint): the reader stops, does not throw.
  writeFileSync(scip, Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  const gg = scipExtract({ raw: scip, root: dir });
  assert.deepEqual({ s: gg.symbols.length, e: gg.edges.length }, { s: 0, e: 0 }, "garbage -> nothing, no throw");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// M3 — MCP server: doc confinement + regex-metachar id escaping
// ---------------------------------------------------------------------------
const AUTH_GEML =
  "=== meta\nmodule = auth\n===\n\n" +
  '=== code {#login src=src/login.ts#L1-9 anchor="a1"}\n===\n' +
  '=== code {#issueToken src=src/token.ts#L1-5 anchor="a2"}\n===\n\n' +
  "=== table {#called-by format=csv}\nfrom, to, kind, site\n#login, #issueToken, call, src/login.ts:3\n===\n";

test("M3 mcp: a `doc` that escapes the graph dir is refused; an in-graph doc resolves", () => {
  const parent = tmp();
  const dir = join(parent, "graph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.geml"), "=== meta\nrepo = demo\n===\n");
  writeFileSync(join(dir, "auth.geml"), AUTH_GEML);
  writeFileSync(join(parent, "secret.txt"), "top secret"); // a real file OUTSIDE the graph dir
  // legit: an in-graph document resolves to its block
  assert.match(mcp.readBlock(dir, "auth.geml", "login"), /\{#login /);
  // a `../` doc that resolves to a real file outside the graph dir is refused
  assert.throws(() => mcp.readBlock(dir, "../secret.txt", "x"), /escapes the graph dir/);
  // a `../` doc that does not exist is the ordinary "no such document" miss
  assert.throws(() => mcp.readBlock(dir, "../../nope-nowhere.geml", "x"), /no such document/);
  rmSync(parent, { recursive: true, force: true });
});

test("M3 mcp get_backlinks: regex-metachar ids match literally (no widening, no ReDoS)", () => {
  const parent = tmp();
  const dir = join(parent, "graph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.geml"), AUTH_GEML);
  const gbl = mcp.TOOLS.find((t) => t.name === "get_backlinks");
  // a real id returns its backlink row
  assert.match(gbl.run({ doc: "auth.geml", id: "issueToken", graph_dir: dir }), /#login, #issueToken, call/);
  // `.*` is escaped -> matched literally -> matches nothing, cannot widen
  assert.match(gbl.run({ doc: "auth.geml", id: ".*", graph_dir: dir }), /no resolved callers of #\.\*/);
  // a catastrophic-backtracking pattern returns promptly and matches nothing
  const t0 = Date.now();
  const evil = gbl.run({ doc: "auth.geml", id: "(a+)+$", graph_dir: dir });
  assert.ok(Date.now() - t0 < 1000, "an escaped id cannot cause ReDoS");
  assert.match(evil, /no resolved callers of #\(a\+\)\+\$/);
  rmSync(parent, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// H3 / L4 — command injection through shell-metachar names
// ---------------------------------------------------------------------------

test("H3/L4 verify: a .geml filename full of shell metachars is passed literally, never executed", () => {
  const work = tmp();
  const cm = join(work, "cm");
  mkdirSync(cm, { recursive: true });
  // If the filename reached cmd.exe unquoted, `& copy nul INJECTED &` would run
  // and create INJECTED in the cwd. shq must quote it into one literal token.
  writeFileSync(join(cm, "a& copy nul INJECTED &b.geml"), "# doc\n");
  // A .cmd launcher forces verify's shell branch (the built .js path never
  // shells); the shim just exits 0, so INJECTED can only appear via a hole.
  const shim = join(work, "check-ok.cmd");
  writeFileSync(shim, "@exit 0\r\n");
  const r = run("verify.mjs", ["--geml", shim, cm], { cwd: work });
  assert.ok(!existsSync(join(work, "INJECTED")), "shq neutralised the metachars — the injected command never ran");
  assert.match(r.err, /documents pass geml check/, "verify handled the metachar filename literally and completed");
  rmSync(work, { recursive: true, force: true });
});

// A fake scip indexer (npx shim -> helper.cjs) so build reaches the real spawn
// without any toolchain or network — same approach as test/cov-scripts.test.mjs.
const tsScipBytes = Buffer.from([
  ...scipDoc("src/a.ts", [scipOcc({ range: [1, 9, 12], symbol: TS + "src/`a.ts`/foo().", roles: 1, enclosing: [1, 0, 3, 1] })]),
]);
const makeTsShim = () => {
  const shim = mkdtempSync(join(tmpdir(), "geml-sec-shim-"));
  writeFileSync(join(shim, "ts.scip.fixture"), tsScipBytes);
  writeFileSync(join(shim, "helper.cjs"), [
    'const fs = require("node:fs"), path = require("node:path");',
    "const [, ...rest] = process.argv.slice(2);", // argv: helper.cjs ts <indexer args>
    'if (rest.includes("--version")) process.exit(0);',
    'const oi = rest.indexOf("--output");',
    "if (oi >= 0) {",
    "  const out = rest[oi + 1];",
    "  fs.mkdirSync(path.dirname(out), { recursive: true });",
    '  fs.copyFileSync(path.join(__dirname, "ts.scip.fixture"), out);',
    "  process.exit(0);",
    "}",
    "process.exit(9);",
  ].join("\n"));
  writeFileSync(join(shim, "npx.bat"), `@echo off\r\n"${process.execPath}" "%~dp0helper.cjs" ts %*\r\n`);
  return shim;
};
const shimEnv = (shim) => ({
  ...process.env, // GEML_TRUST_STORE (and NODE_V8_COVERAGE) must survive into the child
  PATH: shim + delimiter + process.env.PATH,
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
});

test("H3/L4 build: a metachar in the indexer --output path is quoted, not executed", () => {
  const base = tmp();
  const fx = join(base, "proj");
  mkdirSync(join(fx, "src"), { recursive: true });
  writeFileSync(join(fx, "tsconfig.json"), "{}");
  writeFileSync(join(fx, "src", "a.ts"), "export const x = 1;\n");
  const shim = makeTsShim();
  // The --build path carries a cmd.exe injection; build must quote the derived
  // --output argument so `& copy nul INJECTED &` stays one literal token.
  const buildDir = join(base, "b& copy nul INJECTED &d");
  const r = run("build.mjs", ["--root", fx, "--out", join(fx, "map"), "--build", buildDir],
    { env: shimEnv(shim), cwd: fx });
  assert.ok(!existsSync(join(fx, "INJECTED")), "arg quoting neutralised the metachars in the build spawn");
  assert.equal(r.status, 0, r.all);
  assert.match(r.err, /input scip: \d+ symbols/, "the fake indexer's output was consumed literally");
  rmSync(base, { recursive: true, force: true });
  rmSync(shim, { recursive: true, force: true });
});

console.log(passed + " test(s) passed.");
