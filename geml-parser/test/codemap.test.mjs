// codemap toolkit tests (geml-parser/codemap): pins the two scale bugs found
// on the Ignite-3 run — (1) build.mjs merging adapter output with an
// argument-spread push blew the call stack past ~10^5 edges; (2) emit.mjs
// deduped same-name symbols with a fixed 6-hex hash, which collided once at
// that scale and now escalates per name group on demand — plus the guard that
// duplicate ANCHORS fail loudly instead of escalating forever.
import { emit } from "../codemap/emit.mjs";
import { findModuleRoots, declaredModuleRoots, discoverModuleRoots, buildNormalizer, normalizeDirs, splitSourceRoot, deriveFoldLayers, DEFAULT_SOURCE_ROOTS, DEFAULT_TEST_ROOTS } from "../codemap/normalize.mjs";
import { globToRegExp, gitIgnored, makeExcluder } from "../codemap/exclude.mjs";
import { detectLanguages, indexerCommand, collectSourceFiles, isSourcePath } from "../codemap/detect.mjs";
import { extract as scipExtract, nameOf as scipNameOf } from "../codemap/adapters/scip.mjs";
import { parseFoldings, serializeFoldings, defaultFoldings, loadOrSeedFoldings } from "../codemap/foldings.mjs";
import { detectEntries } from "../codemap/entries.mjs";
import { recipeFingerprint, trustRecipe } from "../codemap/recipe-trust.mjs";
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
// Isolate the C2 recipe-trust store per run (audit): starts empty, never
// touches ~/.config; children (spawned serve inherits process.env) see it too.
process.env.GEML_TRUST_STORE = join(mkdtempSync(join(tmpdir(), "geml-trust-cm-")), "store.json");

// The toolkit logs progress on stderr (stdout stays clean for data): run a
// tool, assert exit 0, and hand back both streams for content checks.
const runTool = (script, ...args) => {
  // timeout: a wedged tool must fail loudly, not hang the job in silence.
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr || r.stdout}`);
  return (r.stdout || "") + (r.stderr || "");
};

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // geml-parser/
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const tmp = () => mkdtempSync(join(tmpdir(), "geml-codemap-"));

// Minimal exchange-format records (docs/DESIGN-geml-code-graph.md §3 shapes).
const fn = (name, anchor, file = "src/a.ts", line = 1) => ({
  anchor, lang: "typescript", kind: "Function", name,
  file, line_start: line, line_end: line + 3, resolution: "cpg",
});
const fileSym = (file = "src/a.ts") => ({
  anchor: `file:${file}`, lang: "typescript", kind: "File",
  name: file.split("/").pop(), file, resolution: "cpg",
});
const runEmit = (symbols, edges = [], extra = {}) => {
  const dir = tmp();
  const out = join(dir, "map"), build = join(dir, "build");
  mkdirSync(out, { recursive: true });
  mkdirSync(build, { recursive: true });
  const stats = emit({ symbols, edges, outDir: out, buildDir: build, repoName: "t", container: "dir", commit: "t0", ...extra });
  return { dir, out, stats, doc: (n = "src.geml") => readFileSync(join(out, n), "utf8") };
};

// Build a codemap into `<tmp>/.geml-code-graph` — the conventional location a
// tool must find by DEFAULTING when run with cwd = <tmp> and no dir argument.
const emitCodeGraph = (symbols, edges = []) => {
  const dir = tmp();
  const out = join(dir, ".geml-code-graph"), build = join(dir, "build");
  mkdirSync(out, { recursive: true });
  mkdirSync(build, { recursive: true });
  emit({ symbols, edges, outDir: out, buildDir: build, repoName: "t", container: "dir", commit: "t0" });
  return { dir, out };
};
// Like runTool, but with an explicit cwd — needed to exercise the
// ./.geml-code-graph default, which resolves against the current directory.
const runToolIn = (cwd, script, ...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr || r.stdout}`);
  return (r.stdout || "") + (r.stderr || "");
};

// Two distinct strings whose sha256 hex prefixes collide at `len` chars —
// found by brute force at test time (24 bits: a few thousand hashes).
function collidePair(len = 6) {
  const seen = new Map();
  for (let i = 0; ; i++) {
    const a = `ts:src/a.ts#dup(sig${i})`;
    const p = sha(a).slice(0, len);
    const hit = seen.get(p);
    if (hit !== undefined) return [hit, a];
    seen.set(p, a);
  }
}

test("emit ids: unique names stay bare — no hash suffix", () => {
  const { doc, dir } = runEmit([fn("alpha", "t:a#alpha"), fn("beta", "t:a#beta"), fileSym()]);
  const d = doc();
  assert.match(d, /\{#alpha /, "bare id for a unique name");
  assert.match(d, /\{#beta /, "bare id for a unique name");
  assert.doesNotMatch(d, /#alpha-[0-9a-f]/, "no hash when the name is unique");
  rmSync(dir, { recursive: true, force: true });
});

test("emit ids: same-name symbols get the 6-hex suffix (exact algorithm pin)", () => {
  const a1 = "ts:src/a.ts#dup(int)", a2 = "ts:src/a.ts#dup(str)";
  const { doc, dir } = runEmit([fn("dup", a1), fn("dup", a2, "src/a.ts", 10), fileSym()]);
  const d = doc();
  assert.match(d, new RegExp(`\\{#dup-${sha(a1).slice(0, 6)} `), "id = name-<sha256(anchor)[0..6)>");
  assert.match(d, new RegExp(`\\{#dup-${sha(a2).slice(0, 6)} `), "id = name-<sha256(anchor)[0..6)>");
  rmSync(dir, { recursive: true, force: true });
});

test("emit ids: a 6-hex collision escalates the WHOLE name group to 8 (on demand, not globally)", () => {
  const [c1, c2] = collidePair(6);
  assert.equal(sha(c1).slice(0, 6), sha(c2).slice(0, 6), "engineered collision holds");
  assert.notEqual(sha(c1).slice(0, 8), sha(c2).slice(0, 8), "distinct again at 8");
  const { doc, dir } = runEmit([
    fn("dup", c1), fn("dup", c2, "src/a.ts", 10), fn("dup", "ts:src/a.ts#dup(third)", "src/a.ts", 20),
    // a second, non-colliding group in the same doc must KEEP the short hash
    fn("other", "t:a#other(x)", "src/a.ts", 30), fn("other", "t:a#other(y)", "src/a.ts", 40),
    fileSym(),
  ]);
  const d = doc();
  for (const a of [c1, c2, "ts:src/a.ts#dup(third)"]) {
    assert.match(d, new RegExp(`\\{#dup-${sha(a).slice(0, 8)} `), "colliding group escalates uniformly to 8");
  }
  assert.match(d, new RegExp(`\\{#other-${sha("t:a#other(x)").slice(0, 6)} `), "unaffected group keeps 6");
  const ids = [...d.matchAll(/\{#(dup-[0-9a-f]+) /g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, 3, "all three dup ids distinct");
  rmSync(dir, { recursive: true, force: true });
});

test("emit ids: duplicate anchors fail loudly — never an endless hash escalation", () => {
  assert.throws(
    () => runEmit([fn("dup", "t:same"), fn("dup", "t:same", "src/a.ts", 10), fileSym()]),
    /duplicate anchors/,
    "identical anchors can never hash apart; the old code would loop forever",
  );
});

test("emit output: collision-escalated doc parses clean and verify passes end-to-end", () => {
  const [c1, c2] = collidePair(6);
  const { out, dir, doc } = runEmit(
    [fn("dup", c1), fn("dup", c2, "src/a.ts", 10), fileSym()],
    [{ kind: "calls", from: c1, to: c2, resolution: "cpg", confidence: "high", site: { file: "src/a.ts", line: 2 } }],
  );
  const model = parse(doc());
  assert.equal(model.diagnostics.filter((x) => x.severity === "error").length, 0, "geml-clean container doc");
  const outText = runTool(join(PKG, "codemap", "verify.mjs"), out);
  assert.match(outText, /pass geml check/, "verify.mjs exits 0 and reports passing docs");
  assert.match(doc(), /#calls/, "edge table present so references were actually checked");
  rmSync(dir, { recursive: true, force: true });
});

test("emit output: byte-identical across runs (id assignment is deterministic)", () => {
  const [c1, c2] = collidePair(6);
  const symbols = [fn("dup", c1), fn("dup", c2, "src/a.ts", 10), fn("solo", "t:a#solo", "src/a.ts", 20), fileSym()];
  const r1 = runEmit(symbols), r2 = runEmit(symbols);
  assert.equal(r1.doc(), r2.doc(), "same input, same bytes");
  rmSync(r1.dir, { recursive: true, force: true });
  rmSync(r2.dir, { recursive: true, force: true });
});

test("emit attrs: a newline inside anchor/name stays on one header line — id registers, refs resolve", () => {
  // The next.js repro: scip's anonymous-type-literal symbols embed the
  // literal's multi-line text — an unsanitized anchor truncated the block
  // header, the #id never registered, and both edges to it dangled.
  const littered = {
    anchor: "ts:src/a.ts#recursiveCopy().(`{\n  filter\n}`)member.",
    lang: "typescript", kind: "Function", name: ")typeLiteral8:\nfilter",
    file: "src/a.ts", line_start: 19, line_end: 19, resolution: "cpg",
  };
  const { out, dir, doc } = runEmit(
    [littered, fn("caller", "t:a#caller", "src/a.ts", 9), fileSym()],
    [{ kind: "calls", from: "t:a#caller", to: littered.anchor, resolution: "cpg", confidence: "high", site: { file: "src/a.ts", line: 10 } }],
  );
  const text = doc();
  assert.doesNotMatch(text, /anchor="[^"]*\n/, "no newline survives inside an attribute value");
  const model = parse(text);
  assert.equal(model.diagnostics.filter((x) => x.severity === "error").length, 0, "doc parses clean");
  const outText = runTool(join(PKG, "codemap", "verify.mjs"), out);
  assert.match(outText, /all resolve/, "the edge to the type-literal member resolves (was: 2 dangling)");
  rmSync(dir, { recursive: true, force: true });
});

test("build.mjs: merging 200k adapter edges completes (spread-push stack-overflow regression)", () => {
  // A synthetic Joern export: two methods, 200_000 call records — an edge
  // count where `edges.push(...r.edges)` used to blow the call stack.
  const dir = tmp();
  const raw = join(dir, "raw"), out = join(dir, "map"), build = join(dir, "build");
  mkdirSync(raw, { recursive: true });
  const m = (name, ls) => JSON.stringify({ fullName: `C.${name}`, signature: "s()", file: "src/big.c", name, lineStart: ls, lineEnd: ls + 5 });
  writeFileSync(join(raw, "methods.jsonl"), `${m("caller", 1)}\n${m("callee", 10)}\n`);
  const call = JSON.stringify({
    callerFullName: "C.caller", callerSignature: "s()", callerFile: "src/big.c", line: 3,
    name: "callee", callees: [{ fullName: "C.callee", signature: "s()", file: "src/big.c" }],
  });
  writeFileSync(join(raw, "calls.jsonl"), (call + "\n").repeat(200000));
  const outText = runTool(
    join(PKG, "codemap", "build.mjs"),
    "--adapter", "joern", "--raw", raw, "--root", raw, "--out", out, "--build", build,
  );
  assert.match(outText, /geml-code-graph|containers|files written/i, "build reported completion");
  // `src/big.c` -> container `src` (the source root) collapses to the repo
  // name once normalisation strips it: single-container module = repoName.
  const d = readFileSync(join(out, "raw.geml"), "utf8");
  assert.match(d, /\{#C-caller /, "caller emitted, class-qualified (C.caller -> id C-caller)");
  assert.ok(d.split("\n").length > 200000, "all 200k call rows made it through the merge");
  rmSync(dir, { recursive: true, force: true });
});

test("build.mjs source: no argument-spread push over adapter arrays (pattern lock)", () => {
  const src = readFileSync(join(PKG, "codemap", "build.mjs"), "utf8");
  assert.doesNotMatch(src, /\.push\(\.\.\./, "spread-push re-introduction would crash at scale");
});

async function atest(name, fn) { await fn(); passed++; console.log("ok", name); }

test("emit name-lookup: class-qualified names are also findable by the bare member name", () => {
  const { out, dir } = runEmit([fn("Login.handle", "t:a#Login.handle"), fn("Session.handle", "t:a#Session.handle"), fileSym()]);
  const lookup = JSON.parse(readFileSync(join(out, "_index", "name-lookup.json"), "utf8"));
  assert.ok(lookup["Login.handle"], "qualified key present");
  assert.match(readFileSync(join(out, "src.geml"), "utf8"), /\{#Login-handle name="Login\.handle" /,
    "sanitised id carries the display name for renderers");
  assert.equal((lookup["handle"] || []).length, 2, "bare member name aliases BOTH classes' methods");
  assert.deepEqual(lookup["handle"].map((e) => e.anchor).sort(), ["t:a#Login.handle", "t:a#Session.handle"]);
  rmSync(dir, { recursive: true, force: true });
});

test("render-all.mjs: batch render (shared parse cache) produces every page", () => {
  const { out, dir } = runEmit([fn("alpha", "t:a#alpha"), fileSym()]);
  const outText = runTool(join(PKG, "codemap", "render-all.mjs"), out);
  assert.match(outText, /rendered \d+ page/, "batch completion reported");
  const html = readFileSync(join(out, "src.html"), "utf8");
  assert.match(html, /alpha/, "container page rendered");
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /Code map/, "index page rendered");
  rmSync(dir, { recursive: true, force: true });
});

test("verify.mjs: no dir argument defaults to ./.geml-code-graph (cwd = its parent)", () => {
  const { dir } = emitCodeGraph([fn("alpha", "t:a#alpha"), fileSym()]);
  const outText = runToolIn(dir, join(PKG, "codemap", "verify.mjs")); // NO dir arg
  assert.match(outText, /pass geml check/, "defaulted to ./.geml-code-graph and verified it");
  assert.match(outText, /all resolve/, "profile reference pass ran against the defaulted dir");
  rmSync(dir, { recursive: true, force: true });
});

test("verify.mjs: an explicit dir path still works (regression)", () => {
  const { dir, out } = emitCodeGraph([fn("alpha", "t:a#alpha"), fileSym()]);
  // run from an unrelated cwd so only the explicit absolute path can locate it
  const outText = runToolIn(tmpdir(), join(PKG, "codemap", "verify.mjs"), out);
  assert.match(outText, /pass geml check/, "explicit path verified regardless of cwd");
  rmSync(dir, { recursive: true, force: true });
});

test("render-all.mjs: no dir argument defaults to ./.geml-code-graph (cwd = its parent)", () => {
  const { dir, out } = emitCodeGraph([fn("alpha", "t:a#alpha"), fileSym()]);
  const outText = runToolIn(dir, join(PKG, "codemap", "render-all.mjs")); // NO dir arg
  assert.match(outText, /rendered \d+ page/, "batch render ran against the defaulted dir");
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /Code map/, "index page rendered into ./.geml-code-graph");
  rmSync(dir, { recursive: true, force: true });
});

await atest("serve.mjs: parse cache serves hot requests, and a rewritten document is picked up (never stale)", async () => {
  const { out, dir } = runEmit([fn("alphaOne", "t:a#one"), fileSym()]);
  const port = 21000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(PKG, "codemap", "serve.mjs"), out, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`serve not ready:\n${buf}`)), 15000);
      const onData = (d) => { buf += d; if (buf.includes(`:${port}`)) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`serve exited ${c}:\n${buf}`)); });
    });
    const url = `http://127.0.0.1:${port}/src.html`;
    const firstResp = await fetch(url);
    assert.match(firstResp.headers.get("cache-control") ?? "", /no-cache/, "never-stale extends to the browser — no heuristic caching");
    const first = await firstResp.text();
    assert.match(first, /alphaOne/, "first request renders the document");
    assert.match(first, /\/_dist\/geml\.js/, "served pages carry the live module script");
    assert.match(first, /data-graph-src="\/_graph\?doc=/, "graph payload is a sidecar, not inline");
    assert.doesNotMatch(first, /data-graph="/, "no multi-MB inline attribute");
    assert.match(await (await fetch(url)).text(), /alphaOne/, "hot request (cache hit) serves the same content");
    // the sidecar route computes the payload on demand
    const graph = await fetch(`http://127.0.0.1:${port}/_graph?doc=src.geml`);
    assert.equal(graph.status, 200, "sidecar route answers");
    const gj = await graph.json();
    assert.ok(gj.data && gj.data.nodes && Object.keys(gj.data.nodes).length > 0, "payload carries the slice");
    assert.equal((await fetch(`http://127.0.0.1:${port}/_graph?doc=../package.json`)).status, 404, "sidecar traversal refused");
    // the live script's imports actually resolve over this server
    const dist = await fetch(`http://127.0.0.1:${port}/_dist/render.js`);
    assert.equal(dist.status, 200, "parser dist served under /_dist/");
    assert.match(await dist.text(), /codeGraphWaves/, "wave builder importable in the page");
    assert.equal((await fetch(`http://127.0.0.1:${port}/_dist/..%2f..%2fpackage.json`)).status, 404, "traversal out of dist refused");
    assert.equal((await fetch(`http://127.0.0.1:${port}/src.geml`)).status, 200, "raw .geml fetchable — the live loader's data source");
    // a plain non-codemap document: the sidecar answers with a clean {error}
    writeFileSync(join(out, "plain.geml"), "# just prose\n\nno codemap meta here.\n");
    const errJson = await (await fetch(`http://127.0.0.1:${port}/_graph?doc=plain.geml`)).json();
    assert.match(errJson.error ?? "", /entry/, "non-codemap document yields the builder's error, not a crash");
    // rebuild simulation: rewrite the .geml (mtime AND size change)
    const p = join(out, "src.geml");
    writeFileSync(p, readFileSync(p, "utf8").replace(/alphaOne/g, "alphaTwoX"));
    const after = await (await fetch(url)).text();
    assert.match(after, /alphaTwoX/, "rewritten document served fresh — the cache validated against mtime+size");
    const g2 = await (await fetch(`http://127.0.0.1:${port}/_graph?doc=src.geml`)).json();
    assert.ok(Object.keys(g2.data.nodes).some((k) => /alphaTwoX/.test(k)), "the sidecar payload reflects the rewrite too — never stale end to end");
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200)); // let the process release the dir on Windows
    rmSync(dir, { recursive: true, force: true });
  }
});

await atest("serve.mjs: a method's src path resolves to the project source (read-only route)", async () => {
  const { out, dir } = runEmit([fn("alphaOne", "t:a#one"), fileSym()]);
  // Project root = the codemap dir's parent (no refresh.json in the fixture):
  // plant a source file and a non-source secret beside the codemap.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "x.ts"), "line1\nline2\nline3\n");
  writeFileSync(join(dir, "src", "secret.txt"), "nope\n");
  const port = 21000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(PKG, "codemap", "serve.mjs"), out, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`serve not ready:\n${buf}`)), 15000);
      const onData = (d) => { buf += d; if (buf.includes(`:${port}`)) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`serve exited ${c}:\n${buf}`)); });
    });
    const ok = await fetch(`http://127.0.0.1:${port}/src/x.ts`);
    assert.equal(ok.status, 200, "source file served from the project root");
    assert.match(await ok.text(), /line2/, "…with its content");
    assert.equal((await fetch(`http://127.0.0.1:${port}/src/secret.txt`)).status, 404, "non-source extensions stay unexposed");
    assert.equal((await fetch(`http://127.0.0.1:${port}/src/missing.ts`)).status, 404, "a missing source file is a plain 404");
    assert.equal((await fetch(`http://127.0.0.1:${port}/..%2fsrc%2fx.ts`)).status, 403, "traversal out of the codemap dir stays forbidden");
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200)); // let the process release the dir on Windows
    rmSync(dir, { recursive: true, force: true });
  }
});

await atest("serve.mjs: --watch re-runs the recorded recipe when a source file changes", async () => {
  const { out, dir } = runEmit([fn("alphaOne", "t:a#one"), fileSym()]);
  // Recipe whose only step appends to a marker — proves the watcher kicked it.
  const marker = join(out, "_index", "watch-ran.txt");
  mkdirSync(join(out, "_index"), { recursive: true });
  const watchCfg = {
    version: 1,
    root: "..",
    // Structured step { argv:[...] } (R2-1): refresh execs argv directly (POSIX
    // shell:false / win32 per-element-quoted), so no shell metachar surprises.
    // A root-relative forward-slash path in the -e source works everywhere.
    steps: [{ argv: ["node", "-e", "require('fs').appendFileSync('map/_index/watch-ran.txt','w')"] }],
  };
  writeFileSync(join(out, "_index", "refresh.json"), JSON.stringify(watchCfg));
  // Trust the fixture so the C2 gate (audit) lets the watcher run it — done
  // in-process (no exec), so `assert.ok(existsSync(marker))` still proves the
  // watcher itself ran the recipe.
  trustRecipe(recipeFingerprint(watchCfg), out);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  const port = 21000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(PKG, "codemap", "serve.mjs"), out, "--port", String(port), "--watch"],
    // GEML_WATCH_TREE=1: exercise the manual tree walker (the path Linux uses
    // in production) on every platform — the native recursive watcher is
    // Node-core-proven, the walker is ours to prove.
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GEML_WATCH_QUIET_MS: "250", GEML_WATCH_TREE: "1" } });
  let buf = ""; // everything serve says — the assert message needs it on failure
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve not ready:\n${buf}`)), 15000);
      const onData = (d) => { buf += d; if (buf.includes("watch: watching")) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`serve exited ${c}:\n${buf}`)); });
    });
    // Keep touching the file while polling: a watcher still arming when the
    // first edit lands would miss it — re-touching converges once armed,
    // while a dead watcher still times out.
    const t0 = Date.now();
    let n = 2;
    while (!existsSync(marker) && Date.now() - t0 < 15000) {
      writeFileSync(join(dir, "src", "a.ts"), `export const a = ${n++};\n`); // the edit
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.ok(existsSync(marker), `a source edit re-ran the recipe after the quiet window; serve said:\n${buf}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200)); // let the process release the dir on Windows
    rmSync(dir, { recursive: true, force: true });
  }
});

await atest("serve.mjs: boot prewarm fills the parse cache in the background (largest-first, budget-capped)", async () => {
  const { out, dir } = runEmit([fn("alpha", "t:a#alpha"), fileSym()]);
  const port = 21000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(PKG, "codemap", "serve.mjs"), out, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const warmLine = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`no prewarm line:\n${buf}`)), 15000);
      const onData = (d) => {
        buf += d;
        const m = /prewarm: (\d+)\/(\d+) document\(s\)/.exec(buf);
        if (m) { clearTimeout(timer); resolve(m); }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`serve exited ${c}:\n${buf}`)); });
    });
    assert.equal(warmLine[1], warmLine[2], "the tiny fixture warms completely");
    assert.ok(Number(warmLine[2]) >= 2, "index + container both warmed");
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh.mjs: recipe runs, short-circuits on an unchanged commit, and --force overrides", () => {
  const dir = tmp();
  const cm = join(dir, "map"), idx = join(cm, "_index");
  mkdirSync(idx, { recursive: true });
  // a git repo as the "code" root, so the up-to-date check has a commit to pin
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q");
  // repo-local identity: refresh --commit runs a bare `git commit` itself
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c0");
  const marker = join(idx, "ran.txt");
  const indexDoc = join(cm, "index.geml");
  // The recipe emulates a real build: bump the marker AND stamp index.geml's
  // meta with the current commit — the baseline refresh reads back (refresh
  // itself never writes refresh.json; the graph carries its own provenance).
  const cfgFile = join(idx, "refresh.json");
  writeFileSync(cfgFile, JSON.stringify({
    version: 1,
    root: "..",
    // Structured step { argv:[...] } (R2-1): the JS body is one discrete argv
    // element, execed directly — root-relative forward-slash paths inside.
    steps: [{ argv: ["node", "-e", `const f=require('fs'),c=require('child_process');f.appendFileSync('map/_index/ran.txt','x');const s=c.execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim();f.writeFileSync('map/index.geml',['=== meta','commit = '+s,'===',''].join(String.fromCharCode(10)))`] }],
  }));
  const cfgBytes = readFileSync(cfgFile, "utf8");
  const runRefresh = (...extra) => runTool(join(PKG, "codemap", "refresh.mjs"), cm, ...extra);
  runRefresh("--trust");
  assert.equal(readFileSync(marker, "utf8"), "x", "recipe step executed");
  const again = runRefresh();
  assert.match(again, /up to date/, "unchanged commit short-circuits");
  assert.equal(readFileSync(marker, "utf8"), "x", "…without re-running the steps");
  runRefresh("--force");
  assert.equal(readFileSync(marker, "utf8"), "xx", "--force rebuilds despite the unchanged commit");
  // A commit that touches NO indexed source file (docs/config only) must not
  // rebuild — the graph can't have changed (and the skip writes nothing).
  writeFileSync(join(dir, "NOTES.md"), "# notes\n");
  g("add", "-A"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "docs only");
  assert.match(runRefresh(), /no source files changed/, "doc-only commit is skipped");
  assert.equal(readFileSync(marker, "utf8"), "xx", "…without re-running the steps");
  // A commit that changes a source file DOES rebuild.
  writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
  g("add", "-A"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "code");
  runRefresh();
  assert.equal(readFileSync(marker, "utf8"), "xxx", "a source-file change rebuilds");
  // --commit: the refreshed codemap lands as its own surgical follow-up
  // commit, and the chain provably stops (the follow-up commit changes no
  // source file, so the refresh it triggers takes the skip and writes nothing).
  writeFileSync(join(dir, "app.ts"), "export const x = 2;\n");
  g("add", "-A"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "code2");
  assert.match(runRefresh("--commit"), /committed as/, "--commit lands a follow-up commit");
  assert.equal(readFileSync(marker, "utf8"), "xxxx", "…after actually rebuilding");
  const subject = g("log", "-1", "--pretty=%s").stdout.trim();
  assert.match(subject, /^chore\(codemap\): refresh for /, "follow-up commit message names the trigger");
  const inCommit = g("show", "--name-only", "--pretty=format:", "HEAD").stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(inCommit.length > 0 && inCommit.every((f) => f.startsWith("map/")), "commit touches ONLY the codemap dir");
  assert.ok(!inCommit.some((f) => /_index\/refresh\.log$/.test(f)), "runtime log excluded from the commit");
  assert.equal(g("status", "--porcelain").stdout.trim(), "M map/_index/refresh.log",
    "only the run log stays uncommitted (runtime noise, excluded on purpose)");
  assert.match(runRefresh("--commit"), /no source files changed/, "the follow-up commit itself is skipped");
  assert.equal(g("log", "-1", "--pretty=%s").stdout.trim(), subject, "no further commit — the chain stops");
  assert.equal(g("status", "--porcelain").stdout.trim(), "M map/_index/refresh.log", "skip adds no churn beyond the log");
  assert.equal(readFileSync(cfgFile, "utf8"), cfgBytes, "refresh.json is a pure recipe — the tool never rewrites it");
  rmSync(dir, { recursive: true, force: true });
});

await atest("serve.mjs: --no-warm skips the boot prewarm; --cache-mb caps it (the 80% brake stops early)", async () => {
  // Fat fixture: three containers of ~100 symbols each, so a tiny byte budget
  // cannot hold them all.
  const symbols = [];
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 100; i++) symbols.push(fn(`fn${i}`, `t:src${d}/a.ts#fn${i}`, `src${d}/a.ts`, i * 5 + 1));
    symbols.push(fileSym(`src${d}/a.ts`));
  }
  const { out, dir } = runEmit(symbols);
  // A budget of HALF the map (before the 80% brake) provably cannot hold all
  // four documents, and the brake fires only after at least one loads.
  const totalBytes = readdirSync(out).filter((f) => f.endsWith(".geml"))
    .reduce((s, f) => s + statSync(join(out, f)).size, 0);
  const cappedMb = String(totalBytes / 2 / 0.8 / 1048576);

  const boot = (extra) => {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [join(PKG, "codemap", "serve.mjs"), out, "--port", String(port), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const onData = (d) => { buf += d; };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    return { child, port, output: () => buf };
  };
  const until = async (pred, ms) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100)); };

  // budget = half the map: the warm loop must stop before the whole map
  const capped = boot(["--cache-mb", cappedMb]);
  try {
    await until(() => /prewarm: \d+\/\d+/.test(capped.output()), 15000);
    const m = /prewarm: (\d+)\/(\d+) document\(s\)/.exec(capped.output());
    assert.ok(m, `prewarm line missing:\n${capped.output()}`);
    assert.ok(Number(m[1]) < Number(m[2]), `budget brake stopped early (${m[1]}/${m[2]})`);
    assert.ok(Number(m[1]) >= 1, "…but warmed at least the largest document");
  } finally { capped.child.kill(); }

  // --no-warm: server answers, and no prewarm line appears
  const cold = boot(["--no-warm"]);
  try {
    await until(() => /http:\/\/localhost:\d+/.test(cold.output()), 15000);
    const page = await fetch(`http://127.0.0.1:${cold.port}/index.html`);
    assert.equal(page.status, 200, "server healthy without prewarm");
    await new Promise((r) => setTimeout(r, 800));
    assert.doesNotMatch(cold.output(), /prewarm:/, "--no-warm skips the warm loop");
  } finally {
    cold.child.kill();
    await new Promise((r) => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- container-path normalisation (GEP-0003 §4) -----------------------
test("normalize: strips each module's shared ceremony prefix, keeps a real fork", () => {
  const roots = ["magic-api", "deps/proto"].sort((a, b) => b.length - a.length);
  const dirs = [
    "magic-api/src/main/java/org/x/app/core/config",
    "magic-api/src/main/java/org/x/app/backup/model",
    "magic-api/src/main/java/org/x/app",              // root package: a prefix of its siblings
    "deps/proto/src/main/java/com/n/core",            // vendored: two group-ids, short common prefix
    "deps/proto/src/main/java/io/n/util",
  ];
  const m = normalizeDirs(dirs, roots);
  assert.equal(m.get("magic-api/src/main/java/org/x/app/core/config"), "magic-api/core/config");
  assert.equal(m.get("magic-api/src/main/java/org/x/app/backup/model"), "magic-api/backup/model");
  assert.equal(m.get("magic-api/src/main/java/org/x/app"), "magic-api", "root package collapses to the module root");
  assert.equal(m.get("deps/proto/src/main/java/com/n/core"), "deps/proto/com/n/core", "multi group-id keeps its fork");
  assert.equal(m.get("deps/proto/src/main/java/io/n/util"), "deps/proto/io/n/util");
});

test("normalize: dir outside any module root is left untouched; (root) sentinel passes through", () => {
  const m = normalizeDirs(["loose/a", "(root)"], []);
  assert.equal(m.get("loose/a"), "loose/a"); // module "" group, single member -> itself
  assert.equal(m.has("(root)"), false, "(root) is not normalised");
});

test("normalize: source roots stripped, tests to a test/ branch, single module wears repoName", () => {
  const dirs = [
    "src/main/java/com/mp/agent",
    "src/main/java/com/mp/agent/config",
    "src/main/java/com/mp/agent/log",
    "src/test/java/com/mp/agent/config",
    "src/test/java/com/mp/agent/log",
  ];
  const m = normalizeDirs(dirs, [], "MethodProbe"); // single module: root pom -> no module roots
  assert.equal(m.get("src/main/java/com/mp/agent"), "MethodProbe", "root package -> the module node itself");
  assert.equal(m.get("src/main/java/com/mp/agent/config"), "MethodProbe/config", "src/main/java + shared pkg stripped");
  assert.equal(m.get("src/main/java/com/mp/agent/log"), "MethodProbe/log");
  assert.equal(m.get("src/test/java/com/mp/agent/config"), "test/MethodProbe/config", "tests collect under a test/ branch");
  assert.equal(m.get("src/test/java/com/mp/agent/log"), "test/MethodProbe/log");
  // main and test normalise INDEPENDENTLY (different package roots must not
  // fight); two containers per side so the common prefix leaves a real tail.
  const mixed = normalizeDirs(
    ["m/src/main/java/org/a/core", "m/src/main/java/org/a/util",
     "m/src/test/java/org/b/core", "m/src/test/java/org/b/util"], ["m"], "repo");
  assert.equal(mixed.get("m/src/main/java/org/a/core"), "m/core", "main strips org/a");
  assert.equal(mixed.get("m/src/test/java/org/b/core"), "test/m/core", "test strips org/b under test/");
});

test("splitSourceRoot: maven main/test, bare TS src, top-level & colocated test dirs", () => {
  assert.deepEqual(splitSourceRoot("src/main/java/org/x/Y", { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS }), { kind: "main", tail: "org/x/Y" });
  assert.deepEqual(splitSourceRoot("src/test/kotlin/org/x/Y", { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS }), { kind: "test", tail: "org/x/Y" });
  assert.deepEqual(splitSourceRoot("src/scripts/parsing", { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS }), { kind: "main", tail: "scripts/parsing" }, "bare src (TS)");
  assert.deepEqual(splitSourceRoot("tests/unit/foo", { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS }), { kind: "test", tail: "unit/foo" }, "top-level tests/");
  assert.deepEqual(splitSourceRoot("spec/models", { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS }), { kind: "test", tail: "models" }, "top-level spec/");
  assert.deepEqual(splitSourceRoot("src/__tests__/util", { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS }), { kind: "test", tail: "util" }, "colocated src/__tests__ -> test branch");
  assert.deepEqual(splitSourceRoot("src/components/test-utils", { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS }), { kind: "main", tail: "components/test-utils" }, "'test-utils' is not a test dir");
  assert.deepEqual(splitSourceRoot("com/x/Y", { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS }), { kind: "main", tail: "com/x/Y" }, "no source root -> untouched");
  assert.deepEqual(splitSourceRoot("src/main/scala/x/Y", { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS }), { kind: "main", tail: "x/Y" }, "src/main/* matches any language dir");
});

test("normalize: file-mode container paths are normalised too (src stripped, repoName wrap)", () => {
  const dirs = ["geml-parser/src/render.ts", "geml-parser/src/table.ts", "geml-viewer/src/chart.js"];
  const m = normalizeDirs(dirs, ["geml-parser", "geml-viewer"], "geml", true); // fileMode
  assert.equal(m.get("geml-parser/src/render.ts"), "geml-parser/render.ts", "bare src stripped, filename kept");
  assert.equal(m.get("geml-viewer/src/chart.js"), "geml-viewer/chart.js", "single file NOT collapsed to the module");
  const flat = normalizeDirs(["src/a.c", "src/net/b.c"], [], "valkey", true); // no manifest -> repo root module
  assert.equal(flat.get("src/a.c"), "valkey/a.c", "single-module repo wraps files under repoName");
  assert.equal(flat.get("src/net/b.c"), "valkey/net/b.c");
});

test("normalize: fold-prefixes strip a leading ceremony run (single and multi-segment)", () => {
  const roots = ["integrations/geml-viewer", "libs/vendor/auth"];
  const m = normalizeDirs(
    ["integrations/geml-viewer/src/x", "integrations/geml-viewer/src/y",
     "libs/vendor/auth/src/p", "libs/vendor/auth/src/q"], roots, "repo", false,
    { foldPrefixes: ["integrations", "libs/vendor"] });
  assert.equal(m.get("integrations/geml-viewer/src/x"), "geml-viewer/x", "single-segment fold prefix");
  assert.equal(m.get("integrations/geml-viewer/src/y"), "geml-viewer/y");
  assert.equal(m.get("libs/vendor/auth/src/p"), "auth/p", "multi-segment fold prefix");
  assert.equal(m.get("libs/vendor/auth/src/q"), "auth/q");
});

test("normalize: fold collision reverts BOTH sides to full paths", () => {
  const roots = ["crates/util", "util"];
  const m = normalizeDirs(
    ["crates/util/src/io", "crates/util/src/fmt", "util/src/a", "util/src/b"], roots, "repo", false,
    { foldPrefixes: ["crates"] });
  assert.equal(m.get("crates/util/src/io"), "crates/util/io", "collision -> keep full path");
  assert.equal(m.get("crates/util/src/fmt"), "crates/util/fmt");
  assert.equal(m.get("util/src/a"), "util/a", "the real util keeps its own name");
  assert.equal(m.get("util/src/b"), "util/b");
});

test("normalize: stripSharedPrefix:false keeps the group-id prefix", () => {
  const m = normalizeDirs(
    ["m/src/main/java/com/co/a", "m/src/main/java/com/co/b"], ["m"], "repo", false,
    { stripSharedPrefix: false });
  assert.equal(m.get("m/src/main/java/com/co/a"), "m/com/co/a");
});

test("normalize: non-default sourceRoots are honoured (config is threaded, not ignored)", () => {
  // `app/` is a non-standard source root; configuring it strips it just like
  // `src/` normally would. A sibling container keeps this a 2-member group,
  // so the common-prefix step alone can't strip "app" by coincidence — only
  // recognizing it as a configured sourceRoot does.
  const dirs = ["m/app/foo", "m/other/bar"];
  const custom = normalizeDirs(dirs, ["m"], "repo", false, { sourceRoots: ["app"], testRoots: [] });
  assert.equal(custom.get("m/app/foo"), "m/foo", "custom sourceRoot 'app' stripped");
  const dflt = normalizeDirs(dirs, ["m"], "repo", false, {});
  assert.equal(dflt.get("m/app/foo"), "m/app/foo", "default config does NOT strip 'app'");
});

test("findModuleRoots: manifest dirs, deepest first, skips node_modules & dotdirs", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "mod-a/src/main/java"), { recursive: true });
    writeFileSync(join(dir, "mod-a/pom.xml"), "");
    mkdirSync(join(dir, "mod-a/sub"), { recursive: true });
    writeFileSync(join(dir, "mod-a/sub/package.json"), "{}");
    mkdirSync(join(dir, "mod-a/node_modules/dep"), { recursive: true });
    writeFileSync(join(dir, "mod-a/node_modules/dep/package.json"), "{}"); // must be skipped
    const roots = findModuleRoots(dir);
    assert.deepEqual(roots, ["mod-a/sub", "mod-a"], "deepest first, node_modules pruned, repo root filtered");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- module-root detection: three layers (Gradle/agrona under-segmentation) --

// Layer 1: the manifest set is not JVM/JS/Rust-only. Python (pyproject/setup),
// C/C++ (CMakeLists/meson) and Bazel (BUILD) mark module roots too — without
// this a Python or CMake repo collapses to a single repoName module.
test("findModuleRoots: Python/CMake/meson/Bazel manifests also mark a module (layer 1)", () => {
  const dir = tmp();
  try {
    for (const [d, f] of [["pkg-a", "pyproject.toml"], ["pkg-b", "setup.py"],
      ["lib-c", "CMakeLists.txt"], ["lib-d", "meson.build"], ["pkg-e", "BUILD.bazel"]]) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, f), "");
    }
    assert.deepEqual(findModuleRoots(dir).sort(), ["lib-c", "lib-d", "pkg-a", "pkg-b", "pkg-e"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Layer 2: centralized declarations — a Gradle `settings.gradle include` and a
// Maven root `pom.xml <modules>` name submodules that carry NO manifest of their
// own (agrona's shape). declaredModuleRoots is pure (inject the file reader).
test("declaredModuleRoots: Gradle settings.gradle `include` -> submodule dirs (layer 2)", () => {
  const src =
    "include ':agrona', ':agrona-agent', 'agrona-benchmarks'\n" +
    "include ':nested:child'\n" +
    "// include ':commented-out'\n" +
    "includeBuild 'some-other-build'\n";        // must NOT be read as a subproject
  const readFile = (p) => (basename(p) === "settings.gradle" ? src : (() => { throw new Error("ENOENT"); })());
  assert.deepEqual(
    declaredModuleRoots("/r", { readFile }).sort(),
    ["agrona", "agrona-agent", "agrona-benchmarks", "nested/child"],
  );
});

test("declaredModuleRoots: Maven root pom.xml <modules> -> module dirs (layer 2)", () => {
  const pom = "<project><modules><module>svc</module>\n<module>web/app</module></modules></project>";
  const readFile = (p) => (basename(p) === "pom.xml" ? pom : (() => { throw new Error("ENOENT"); })());
  assert.deepEqual(declaredModuleRoots("/r", { readFile }).sort(), ["svc", "web/app"]);
});

test("discoverModuleRoots: unions manifest dirs with centrally-declared ones, deepest first", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "settings.gradle"), "include ':core', ':agent'\n");
    for (const m of ["core", "agent"]) mkdirSync(join(dir, m, "src/main/java"), { recursive: true });
    mkdirSync(join(dir, "buildSrc"), { recursive: true });
    writeFileSync(join(dir, "buildSrc", "build.gradle"), ""); // fs manifest
    const roots = discoverModuleRoots(dir);
    assert.deepEqual(roots.slice().sort(), ["agent", "buildSrc", "core"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildNormalizer: agrona shape (central include, no per-module manifest) -> each submodule its own module", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "settings.gradle"), "include ':agrona', ':agrona-agent'\n");
    mkdirSync(join(dir, "agrona/src/main/java/org/agrona"), { recursive: true });
    mkdirSync(join(dir, "agrona-agent/src/main/java/org/agrona/agent"), { recursive: true });
    const m = buildNormalizer(dir,
      ["agrona/src/main/java/org/agrona", "agrona-agent/src/main/java/org/agrona/agent"],
      { repoName: "agrona" });
    assert.equal(m.get("agrona-agent/src/main/java/org/agrona/agent").split("/")[0], "agrona-agent",
      "the agent submodule is no longer folded under the repo-default module");
    assert.equal(m.get("agrona/src/main/java/org/agrona").split("/")[0], "agrona");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Layer 3: foldings.geml `## module-roots` — a manual escape hatch for layouts
// no build tool declares (or the tool cannot parse). It is unioned into the set.
test("parseFoldings: a `## module-roots` section is read (layer 3)", () => {
  const cfg = parseFoldings(['=== meta', 'title = "x"', '===', '', '## module-roots', '', '- svc/a', '- svc/b', ''].join("\n"));
  assert.deepEqual(cfg.moduleRoots, ["svc/a", "svc/b"]);
});

test("foldings round-trip: module-roots survives serialize -> parse", () => {
  const base = defaultFoldings({ moduleRoots: [], languages: [] });
  assert.deepEqual(base.moduleRoots, [], "defaults carry an empty module-roots list");
  const txt = serializeFoldings({ ...base, moduleRoots: ["svc/a"] });
  assert.match(txt, /## module-roots/);
  assert.deepEqual(parseFoldings(txt).moduleRoots, ["svc/a"]);
});

test("buildNormalizer: a user-declared module root (config.moduleRoots) folds its containers under it (layer 3)", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "weird/place/src"), { recursive: true });
    // Two containers so the shared-prefix strip leaves a tail — proving the
    // module SEGMENT is the declared root (without it, both would sit under "proj").
    const m = buildNormalizer(dir, ["weird/place/src/a", "weird/place/src/b"], { repoName: "proj", config: { moduleRoots: ["weird/place"] } });
    assert.equal(m.get("weird/place/src/a"), "weird/place/a", "declared root becomes the module segment");
    assert.equal(m.get("weird/place/src/b"), "weird/place/b");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- source exclusion (.gitignore + --exclude) ------------------------
test("exclude: globToRegExp — ** spans separators, * stays within a segment", () => {
  assert.ok(globToRegExp("deps/**").test("deps/a/b/C.java"));
  assert.ok(!globToRegExp("deps/**").test("app/a.java"));
  assert.ok(globToRegExp("**/magic-script/**").test("bin/x/magic-script/y/Z.java"));
  assert.ok(globToRegExp("*.ts").test("a.ts"));
  assert.ok(!globToRegExp("*.ts").test("a/b.ts"), "* does not cross a path separator");
});

test("exclude: gitIgnored parses check-ignore, tolerates exit 1/128", () => {
  const hit = gitIgnored("/r", ["a.java", "bin/x"], () => "bin/x\n");
  assert.deepEqual([...hit], ["bin/x"]);
  const none = gitIgnored("/r", ["a.java"], () => { throw new Error("exit 1: nothing ignored"); });
  assert.equal(none.size, 0, "exit 1 (no match) is not a failure");
  const gitless = gitIgnored("/r", ["a.java"], () => { throw Object.assign(new Error("not a repo"), { stdout: "" }); });
  assert.equal(gitless.size, 0, "git absent -> ignore nothing");
  assert.equal(gitIgnored("/r", []).size, 0, "empty file list short-circuits");
});

test("exclude: makeExcluder combines gitignore hits with explicit globs", () => {
  const ex = makeExcluder({
    root: "/r", globs: ["vendor/**"], gitignore: true,
    files: ["src/A.java", "bin/B.java", "vendor/C.java"],
    exec: () => "bin/B.java\n",
  });
  assert.ok(!ex("src/A.java"), "tracked source kept");
  assert.ok(ex("bin/B.java"), "gitignored path excluded");
  assert.ok(ex("vendor/C.java"), "glob-matched path excluded");
  const off = makeExcluder({ root: "/r", globs: [], gitignore: false, files: ["bin/B.java"], exec: () => "bin/B.java\n" });
  assert.ok(!off("bin/B.java"), "--no-gitignore disables the git-driven half");
});

// ---- language auto-detection (detect.mjs) -----------------------------
// Fixtures are tiny real dirs under the temp root — detectLanguages walks
// them; no scip/joern is ever invoked here.
const fixture = (fileMap) => {
  const dir = tmp();
  for (const [rel, content] of Object.entries(fileMap)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content ?? "");
  }
  return dir;
};

test("collectSourceFiles: repo-relative POSIX source + manifest paths, skip dirs pruned", () => {
  const fx = fixture({ "tsconfig.json": "{}", "src/a.ts": "x", "dist/bundle.js": "y", "node_modules/d/i.js": "z" });
  const { files, manifests } = collectSourceFiles(fx);
  assert.ok(files.includes("src/a.ts"), "source file collected, POSIX-relative");
  assert.ok(!files.some((f) => f.startsWith("dist/") || f.includes("node_modules")), "build/vendor dirs pruned");
  assert.deepEqual(manifests, ["tsconfig.json"]);
  rmSync(fx, { recursive: true, force: true });
});

test("detect: tsconfig.json -> a single scip (TypeScript) job", () => {
  const fx = fixture({ "tsconfig.json": "{}", "src/index.ts": "export const x = 1;\n" });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 1, "one job");
  assert.equal(jobs[0].indexer, "scip");
  assert.equal(jobs[0].language, "TypeScript");
  assert.equal(jobs[0].gemlLang, undefined, "scip carries no Joern frontend");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: pom.xml -> a single joern JAVASRC job (manifest signal)", () => {
  const fx = fixture({ "pom.xml": "<project/>" });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].indexer, "joern");
  assert.equal(jobs[0].gemlLang, "JAVASRC");
  assert.equal(jobs[0].signal, "pom.xml");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: .java files with no manifest -> joern JAVASRC (extension signal)", () => {
  const fx = fixture({ "A.java": "class A {}", "pkg/B.java": "class B {}" });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].indexer, "joern");
  assert.equal(jobs[0].gemlLang, "JAVASRC");
  assert.equal(jobs[0].signal, ".java");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: mixed tsconfig.json + pom.xml -> BOTH scip and joern JAVASRC", () => {
  const fx = fixture({ "tsconfig.json": "{}", "web/app.ts": "x", "pom.xml": "<project/>", "svc/A.java": "class A {}" });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 2, "one job per language");
  const byLang = Object.fromEntries(jobs.map((j) => [j.language, j]));
  assert.equal(byLang.TypeScript.indexer, "scip");
  assert.equal(byLang.Java.indexer, "joern");
  assert.equal(byLang.Java.gemlLang, "JAVASRC");
  assert.equal(jobs[0].indexer, "scip", "scip is ordered before joern");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: .c/.h -> joern NEWC", () => {
  const fx = fixture({ "main.c": "int main(){return 0;}", "inc/util.h": "#pragma once" });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].language, "C");
  assert.equal(jobs[0].gemlLang, "NEWC");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: node_modules / .git pruned — a vendored .java adds no Joern job", () => {
  const fx = fixture({
    "tsconfig.json": "{}", "src/index.ts": "x",
    "node_modules/dep/Vendor.java": "class Vendor {}",
    ".git/hooks/pre-commit.py": "print(1)",
  });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 1, "only TypeScript detected");
  assert.equal(jobs[0].indexer, "scip");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: an excluded (gitignored) source file does not trigger its language", () => {
  const fx = fixture({ "tsconfig.json": "{}", "src/index.ts": "x", "gen/Big.java": "class Big {}" });
  const jobs = detectLanguages(fx, { excluder: (f) => f.startsWith("gen/") });
  assert.deepEqual(jobs.map((j) => j.language), ["TypeScript"], "the java file was excluded before counting");
  rmSync(fx, { recursive: true, force: true });
});

test("indexerCommand: scip job (tsconfig signal) -> npx args, no inferred config", () => {
  const cmd = indexerCommand({ indexer: "scip", signal: "tsconfig.json" }, { root: "/r", buildDir: "/r/.geml-code-graph/_build", scriptPath: "/x/joern-export.sc" });
  assert.equal(cmd.adapter, "scip");
  assert.deepEqual(cmd.argv.slice(0, 5), ["npx", "--yes", "@sourcegraph/scip-typescript", "index", "--output"]);
  assert.ok(!cmd.argv.includes("--infer-tsconfig"), "a real tsconfig means no inferred one");
  assert.equal(cmd.argv.at(-1), cmd.raw, "the --output value IS the adapter raw");
  assert.equal(basename(cmd.raw), "index.scip");
  assert.match(cmd.raw.replace(/\\/g, "/"), /_build\/index\.scip$/);
  assert.equal(cmd.env, undefined);
  assert.equal(cmd.cwd, "/r");
});

test("indexerCommand: scip job never infers a config (tsconfig-less groups are dropped in detect)", () => {
  // We no longer synthesize a config with --infer-tsconfig: a group without a
  // tsconfig (and not an SFC app) is loose files, not a project, and never
  // becomes a scip job. So the scip argv carries no --infer-tsconfig, ever.
  const cmd = indexerCommand({ indexer: "scip", signal: ".ts" }, { root: "/r", buildDir: "/r/.geml-code-graph/_build", scriptPath: "/x/joern-export.sc" });
  assert.deepEqual(cmd.argv.slice(0, 4), ["npx", "--yes", "@sourcegraph/scip-typescript", "index"]);
  assert.ok(!cmd.argv.includes("--infer-tsconfig"), "no config is ever inferred");
  assert.equal(cmd.argv.at(-1), cmd.raw);
});

test("detect: multi-package TS -> a scip job only for tsconfig-bearing groups; config-less ones are dropped", () => {
  // A group indexes only if it's a real project (has a tsconfig, or is an SFC
  // app). apps/b has a tsconfig -> indexed. apps/a (package.json only) and the
  // root loose group (no tsconfig, not SFC) are loose files, not projects ->
  // dropped, with no --infer-tsconfig fallback sweeping the tree.
  const jobs = detectLanguages("/r", {
    files: ["apps/a/src/x.ts", "apps/a/src/y.js", "apps/b/z.ts", "tests/e2e/t.ts"],
    manifests: ["apps/b/tsconfig.json"],
    pkgs: ["package.json", "apps/a/package.json"],
  });
  const ts = jobs.filter((j) => j.language === "TypeScript");
  assert.deepEqual(ts.map((j) => j.subroot ?? ""), ["apps/b"], "only the tsconfig-bearing project is a scip job");
  assert.equal(ts[0].signal, "apps/b/tsconfig.json");
  const cb = indexerCommand(ts[0], { root: "/r", buildDir: "/b", scriptPath: "/s" });
  assert.equal(cb.cwd.replace(/\\/g, "/"), "/r/apps/b", "indexer runs IN the app dir");
  assert.ok(!cb.argv.includes("--infer-tsconfig"), "no inferred config");
  assert.match(cb.raw.replace(/\\/g, "/"), /index-apps-b\.scip$/, "distinct raw per project");
});

test("indexerCommand: joern job -> GEML_SRC/OUT/LANG env, script path, raw dir", () => {
  const cmd = indexerCommand({ indexer: "joern", gemlLang: "JAVASRC" }, { root: "/r", buildDir: "/r/.geml-code-graph/_build", scriptPath: "/x/joern-export.sc" });
  assert.equal(cmd.adapter, "joern");
  assert.deepEqual(cmd.argv, ["joern", "--script", "/x/joern-export.sc"]);
  assert.equal(cmd.env.GEML_SRC, "/r");
  assert.equal(cmd.env.GEML_LANG, "JAVASRC");
  assert.equal(cmd.env.GEML_OUT, cmd.raw, "GEML_OUT is the adapter raw dir");
  assert.equal(basename(cmd.raw), "joern-javasrc");
  // Joern writes its CPG workspace to <cwd>/workspace/. Running IN the build dir
  // keeps that cache inside .geml-code-graph/_build/ instead of scattering a
  // `workspace/` at the repo root. GEML_SRC/OUT are absolute, so cwd is free to move.
  assert.equal(cmd.cwd.replace(/\\/g, "/"), "/r/.geml-code-graph/_build", "joern runs in the build dir, not the repo root");
});

test("detect: nested tsconfig in a Java monorepo -> the scip job carries the tsconfig's dir (flink shape)", () => {
  const fx = fixture({
    "pom.xml": "<project/>", "svc/A.java": "class A {}",
    "web/dashboard/tsconfig.json": "{}", "web/dashboard/src/app.ts": "export const x = 1;",
  });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 2, "one scip + one joern job");
  assert.equal(jobs[0].indexer, "scip");
  assert.equal(jobs[0].subroot, "web/dashboard", "scip must run inside the tsconfig project, not the repo root");
  assert.equal(jobs[0].signal, "web/dashboard/tsconfig.json", "the plan line names WHERE TypeScript was detected");
  assert.equal(jobs[1].gemlLang, "JAVASRC");
  const cmd = indexerCommand(jobs[0], { root: "/r", buildDir: "/b", scriptPath: "/x/joern-export.sc" });
  assert.equal(cmd.cwd.replace(/\\/g, "/"), "/r/web/dashboard", "the indexer runs IN the nested project");
  assert.equal(basename(cmd.raw), "index-web-dashboard.scip", "raw name is project-unique");
  assert.ok(!cmd.argv.includes("--infer-tsconfig"), "a real tsconfig exists — no inference");
  rmSync(fx, { recursive: true, force: true });
});

test("scip adapter: a subproject index re-anchors document paths to the repo root (file:// URL keeps its unix slash)", () => {
  // Hand-encoded minimal SCIP protobuf: metadata.project_root names a
  // SUBDIRECTORY of --root (what scip-typescript writes when run inside a
  // nested tsconfig project), one document with one function definition.
  const pbVarint = (n) => { const out = []; let x = n; do { let b = x & 0x7f; x >>>= 7; if (x) b |= 0x80; out.push(b); } while (x); return Buffer.from(out); };
  const pbLen = (no, payload) => Buffer.concat([pbVarint((no << 3) | 2), pbVarint(payload.length), payload]);
  const pbStr = (no, s) => pbLen(no, Buffer.from(s, "utf8"));
  const pbInt = (no, v) => Buffer.concat([pbVarint(no << 3), pbVarint(v)]);
  const dir = tmp();
  const rootPosix = dir.replace(/\\/g, "/");
  const projectRootUrl = "file://" + (rootPosix.startsWith("/") ? "" : "/") + rootPosix + "/web/dashboard";
  const scip = Buffer.concat([
    pbLen(1, pbStr(3, projectRootUrl)), // metadata.project_root
    pbLen(2, Buffer.concat([            // document
      pbStr(1, "src/app.ts"),           //   relative_path (project-relative!)
      pbLen(2, Buffer.concat([          //   occurrence: greet() definition
        pbLen(1, Buffer.concat([pbVarint(0), pbVarint(0), pbVarint(5)])), // range
        pbStr(2, "x/`app.ts`/greet()."), pbInt(3, 1),                     // symbol, roles=DEFINITION
      ])),
    ])),
  ]);
  const p = join(dir, "index.scip");
  writeFileSync(p, scip);
  const r = scipExtract({ raw: p, root: dir });
  const def = r.symbols.find((s) => s.kind === "Function");
  assert.equal(def.file, "web/dashboard/src/app.ts", "project-relative path re-anchored to the repo root");
  rmSync(dir, { recursive: true, force: true });
});

test("build.mjs auto: Joern absent -> install instructions and non-zero exit", () => {
  const fx = fixture({ "pom.xml": "<project/>" });
  const r = spawnSync(process.execPath,
    [join(PKG, "codemap", "build.mjs"), "--root", fx, "--out", join(fx, ".geml-code-graph")],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000, env: { ...process.env, GEML_JOERN: "geml-no-such-joern-xyz" } });
  const outText = (r.stdout || "") + (r.stderr || "");
  assert.notEqual(r.status, 0, `expected non-zero exit; got ${r.status}: ${outText}`);
  assert.match(outText, /docs\.joern\.io\/installation/, "names the Joern install docs URL");
  assert.match(outText, /Joern is required for Java/, "names the language that needs Joern");
  rmSync(fx, { recursive: true, force: true });
});

test("build.mjs auto: no supported language -> clear error, non-zero exit", () => {
  const fx = fixture({ "README.md": "# hi", "notes.txt": "x" });
  const r = spawnSync(process.execPath,
    [join(PKG, "codemap", "build.mjs"), "--root", fx, "--out", join(fx, ".geml-code-graph")],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  const outText = (r.stdout || "") + (r.stderr || "");
  assert.notEqual(r.status, 0, `expected non-zero exit; got ${r.status}`);
  assert.match(outText, /could not auto-detect a supported language/);
  rmSync(fx, { recursive: true, force: true });
});

// ---- Rust via rust-analyzer scip ---------------------------------------
// Everything below is offline-safe except the final e2e, which is gated on
// rust-analyzer being installed (CI has no Rust toolchain): with it present
// the real-crate build runs; without it the install-hint path runs instead.
const raProbe = process.platform === "win32"
  ? spawnSync("rust-analyzer --version", { shell: true, stdio: "ignore" })
  : spawnSync("rust-analyzer", ["--version"], { stdio: "ignore" });
const hasRustAnalyzer = !raProbe.error && raProbe.status === 0;

test("detect: Cargo.toml -> a single scip (Rust) job", () => {
  const fx = fixture({ "Cargo.toml": "[package]\nname = \"x\"\n", "src/lib.rs": "pub fn f() {}\n" });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 1, "one job");
  assert.equal(jobs[0].indexer, "scip");
  assert.equal(jobs[0].adapter, "scip", "rust rides the SAME scip adapter");
  assert.equal(jobs[0].language, "Rust");
  assert.equal(jobs[0].gemlLang, undefined, "scip carries no Joern frontend");
  assert.equal(jobs[0].signal, "Cargo.toml");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: .rs files with no manifest -> scip Rust (extension signal)", () => {
  const fx = fixture({ "a.rs": "fn a() {}", "sub/b.rs": "fn b() {}" });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].indexer, "scip");
  assert.equal(jobs[0].language, "Rust");
  assert.equal(jobs[0].signal, ".rs");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: mixed tsconfig.json + Cargo.toml -> two scip jobs, distinct raw outputs", () => {
  const fx = fixture({ "tsconfig.json": "{}", "web/app.ts": "x", "Cargo.toml": "[package]\nname = \"x\"\n", "src/lib.rs": "pub fn f() {}\n" });
  const jobs = detectLanguages(fx);
  assert.equal(jobs.length, 2, "one job per language");
  const byLang = Object.fromEntries(jobs.map((j) => [j.language, j]));
  assert.equal(byLang.TypeScript.indexer, "scip");
  assert.equal(byLang.Rust.indexer, "scip");
  const raws = jobs.map((j) => basename(indexerCommand(j, { root: "/r", buildDir: "/b", scriptPath: "/x.sc" }).raw));
  assert.deepEqual(raws.sort(), ["index.scip", "rust.scip"], "rust.scip never collides with index.scip");
  rmSync(fx, { recursive: true, force: true });
});

test("indexerCommand: rust job -> rust-analyzer argv and a raw rust.scip under _build", () => {
  const cmd = indexerCommand({ indexer: "scip", language: "Rust" }, { root: "/r", buildDir: "/r/.geml-code-graph/_build", scriptPath: "/x/joern-export.sc" });
  assert.equal(cmd.adapter, "scip");
  assert.deepEqual(cmd.argv.slice(0, 4), ["rust-analyzer", "scip", ".", "--output"]);
  assert.equal(cmd.argv.at(-1), cmd.raw, "the --output value IS the adapter raw");
  assert.equal(basename(cmd.raw), "rust.scip");
  assert.match(cmd.raw.replace(/\\/g, "/"), /_build\/rust\.scip$/);
  assert.equal(cmd.env, undefined);
  assert.equal(cmd.cwd, "/r");
});

test("detect: a Cargo crate OUTSIDE the root workspace gets its own rust job (mustapi cli shape)", () => {
  // Root workspace lists crates/* only; cli/ opted out with its own [workspace]
  // table. The root `rust-analyzer scip .` run never loads cli, so detect must
  // emit a second run in cli's own directory.
  const fx = fixture({
    "Cargo.toml": '[workspace]\nmembers = [\n    "crates/a",\n]\nresolver = "2"\n',
    "crates/a/Cargo.toml": '[package]\nname = "a"\n', "crates/a/src/lib.rs": "pub fn f() {}\n",
    "cli/Cargo.toml": '[package]\nname = "mustctl"\n\n[workspace]\n', "cli/src/main.rs": "fn main() {}\n",
  });
  const rust = detectLanguages(fx).filter((j) => j.language === "Rust");
  assert.deepEqual(rust.map((j) => j.subroot ?? ""), ["cli", ""], "standalone crate job (deepest first) + the root sweep; member crates need none");
  assert.equal(rust[0].signal, "cli/Cargo.toml", "the plan names WHICH crate manifest");
  const c = indexerCommand(rust[0], { root: "/r", buildDir: "/b", scriptPath: "/s" });
  assert.deepEqual(c.argv.slice(0, 3), ["rust-analyzer", "scip", "."]);
  assert.equal(c.cwd.replace(/\\/g, "/"), "/r/cli", "rust-analyzer runs IN the crate dir");
  assert.equal(basename(c.raw), "rust-cli.scip", "raw name is crate-unique");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: workspace exclude + member globs — excluded crates run standalone, members don't", () => {
  const fx = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["tools/*"]\nexclude = ["tools/legacy"]\n',
    "tools/x/Cargo.toml": '[package]\nname = "x"\n', "tools/x/src/lib.rs": "pub fn f() {}\n",
    "tools/legacy/Cargo.toml": '[package]\nname = "legacy"\n', "tools/legacy/src/lib.rs": "pub fn g() {}\n",
  });
  const rust = detectLanguages(fx).filter((j) => j.language === "Rust");
  assert.deepEqual(rust.map((j) => j.subroot ?? "").sort(), ["", "tools/legacy"],
    "glob-matched member is covered by the root run; the excluded crate gets its own");
  rmSync(fx, { recursive: true, force: true });
});

test("detect: no root Cargo.toml -> each top-level crate runs in its own dir, no root sweep", () => {
  const fx = fixture({
    "tools/x/Cargo.toml": '[package]\nname = "x"\n', "tools/x/src/lib.rs": "pub fn f() {}\n",
  });
  const rust = detectLanguages(fx).filter((j) => j.language === "Rust");
  assert.deepEqual(rust.map((j) => j.subroot), ["tools/x"], "no rootless sweep that would load nothing");
  assert.equal(rust[0].signal, "tools/x/Cargo.toml");
  rmSync(fx, { recursive: true, force: true });
});

test("scip nameOf: rust-analyzer symbol grammar (scip-typescript forms unchanged)", () => {
  // scip-typescript — pinned, byte-identical to the pre-Rust adapter
  assert.equal(scipNameOf("scip-typescript npm @geml/geml 1.0.0 src/`geml.ts`/parse()."), "parse");
  assert.equal(scipNameOf("scip-typescript npm @geml/geml 1.0.0 src/`render.ts`/RenderCtx#block()."), "RenderCtx.block");
  assert.equal(scipNameOf("scip-typescript npm p 1.0.0 src/`a.ts`/Cls#`<constructor>`()."), "Cls.new");
  // rust-analyzer — crate-root fn (the version token must NOT bleed into the name)
  assert.equal(scipNameOf("rust-analyzer cargo spike_crate 0.1.0 main()."), "main");
  assert.equal(scipNameOf("rust-analyzer cargo spike_crate 0.1.0 describe()."), "describe");
  // module fn: module path lives in the file, the name stays bare
  assert.equal(scipNameOf("rust-analyzer cargo spike_crate 0.1.0 util/multiply()."), "multiply");
  // inherent impl method: impl#[SelfType]
  assert.equal(scipNameOf("rust-analyzer cargo spike_crate 0.1.0 impl#[Widget]new()."), "Widget::new");
  // trait impl in an external crate: impl#[SelfType][`TraitRef`], URL version slot
  assert.equal(scipNameOf("rust-analyzer cargo core https://github.com/rust-lang/rust/library/core ops/arith/impl#[u32][`Mul<Self>`]mul()."), "u32::mul");
  // trait method declaration: Trait#method
  assert.equal(scipNameOf("rust-analyzer cargo spike_crate 0.1.0 shapes/Area#area()."), "Area::area");
});

// Minimal SCIP protobuf writer — just enough of the wire format to feed the
// adapter's reader (Index.documents / Document.occurrences) without shipping
// a binary fixture or a rust toolchain.
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

test("scip extract: rust-analyzer index -> lang rust, resolved cross-file calls, rust to_text", () => {
  const RA = "rust-analyzer cargo spike 0.1.0 ";
  const MUL = "rust-analyzer cargo core https://github.com/rust-lang/rust/library/core ops/arith/impl#[u32][`Mul<Self>`]mul().";
  const bytes = Buffer.from([
    ...scipDoc("src/main.rs", [
      scipOcc({ range: [2, 3, 2, 7], symbol: RA + "main().", roles: 1, enclosing: [2, 0, 6, 1] }),
      scipOcc({ range: [4, 12, 4, 20], symbol: RA + "describe()." }),
    ]),
    ...scipDoc("src/lib.rs", [
      scipOcc({ range: [17, 7, 17, 15], symbol: RA + "describe().", roles: 1, enclosing: [17, 0, 20, 1] }),
      scipOcc({ range: [12, 11, 12, 15], symbol: RA + "impl#[Widget]area().", roles: 1, enclosing: [12, 4, 14, 5] }),
      scipOcc({ range: [18, 19, 18, 23], symbol: RA + "impl#[Widget]area()." }),
      scipOcc({ range: [13, 20, 13, 28], symbol: MUL }),
    ]),
  ]);
  const dir = tmp();
  const raw = join(dir, "rust.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });

  const fns = r.symbols.filter((s) => s.kind === "Function");
  assert.deepEqual(fns.map((s) => s.name).sort(), ["Widget::area", "describe", "main"]);
  assert.ok(r.symbols.every((s) => s.lang === "rust"), "every symbol (functions AND files) is lang rust");
  const main = fns.find((s) => s.name === "main");
  assert.equal(main.entry, true, "rust main is an app entry");
  assert.deepEqual([main.line_start, main.line_end], [3, 7], "enclosing_range drives the span");

  const resolved = r.edges.filter((e) => e.to).map((e) => `${scipNameOf(e.from)}->${scipNameOf(e.to)}`).sort();
  assert.deepEqual(resolved, ["describe->Widget::area", "main->describe"], "cross-file rust calls resolve high");
  assert.ok(r.edges.filter((e) => e.to).every((e) => e.confidence === "high"));
  const unresolved = r.edges.find((e) => e.to_text);
  assert.equal(unresolved.to_text, "u32::mul", "external (std) call lands unresolved, readably named");
  assert.equal(unresolved.confidence, "low");
  rmSync(dir, { recursive: true, force: true });
});

test("scip extract: a macro-erased rust fn is recovered from its source signature", () => {
  // workers-rs #[event(fetch)] (and #[tokio::main]-style macros) rewrite the
  // item: the fn emits NO occurrence at all — not even its name token — while
  // the body's call references survive, orphaned. Before this fix the whole
  // function and every edge it makes silently vanished. The recovery reads
  // the SOURCE inside the orphan region and synthesizes the fn the macro
  // consumed, named from the source (`async fn main` comes back as `main`).
  const RA = "rust-analyzer cargo w 0.1.0 ";
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.rs"), [
    "use worker::*;",            // L1 (0-based 0)
    "",
    "fn helper() {",             // 0-based 2 — admitted (has enclosing)
    "    let x = 1;",
    "}",                         // 0-based 4
    "",
    "// ─── Worker entry point ───",
    "",
    "#[event(fetch)]",           // 0-based 8
    "async fn main(req: Request, env: Env) -> Result<Response> {", // 0-based 9
    "    helper();",             // 0-based 10 — orphan call
    "    let y = 2;",
    "    other();",              // 0-based 12 — orphan call, unresolved
    "}",
  ].join("\n"));
  const bytes = Buffer.from([
    ...scipDoc("src/lib.rs", [
      scipOcc({ range: [2, 3, 2, 9], symbol: RA + "helper().", roles: 1, enclosing: [2, 0, 4, 1] }),
      // the erased fn's body — its own name token is GONE:
      scipOcc({ range: [10, 4, 10, 10], symbol: RA + "helper()." }),
      scipOcc({ range: [12, 4, 12, 9], symbol: RA + "other()." }),
    ]),
  ]);
  const raw = join(dir, "x.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });
  const rec = r.symbols.find((s) => s.name === "main");
  assert.ok(rec, "the erased fn is reconstructed, named from the source");
  assert.equal(rec.resolution, "heuristic", "reconstruction is labelled, never passed off as cpg");
  assert.equal(rec.entry, true, "recovered `main` is an app entry again");
  assert.deepEqual([rec.line_start, rec.line_end], [10, 13], "span runs from the source signature to the last orphan call");
  const out = r.edges.filter((e) => e.from === rec.anchor);
  assert.equal(out.length, 2, "the orphan body's calls belong to the recovered fn");
  assert.ok(out.some((e) => e.to === RA + "helper()." && e.confidence === "high"), "resolved callee");
  assert.ok(out.some((e) => e.to_text === "other"), "unresolved callee stays honest to_text");
  rmSync(dir, { recursive: true, force: true });
});

test("scip extract: erased-fn recovery refuses when the source shows no fn signature", () => {
  const RA = "rust-analyzer cargo w 0.1.0 ";
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  // The orphan region holds no `fn` signature — macro-generated call sites
  // with no source witness must NOT invent a function.
  writeFileSync(join(dir, "src", "lib.rs"), [
    "fn helper() {", "    let x = 1;", "}", "",
    "// only comments and macro invocations below",
    "some_macro! {", "    helper()", "}",
  ].join("\n"));
  const bytes = Buffer.from([
    ...scipDoc("src/lib.rs", [
      scipOcc({ range: [0, 3, 0, 9], symbol: RA + "helper().", roles: 1, enclosing: [0, 0, 2, 1] }),
      scipOcc({ range: [6, 4, 6, 10], symbol: RA + "helper()." }), // orphan, but no fn sig in region
    ]),
  ]);
  const raw = join(dir, "x.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });
  assert.deepEqual(r.symbols.filter((s) => s.kind === "Function").map((s) => s.name), ["helper"],
    "no synthesized fn without a source signature");
  rmSync(dir, { recursive: true, force: true });
});

test("build.mjs auto: rust-analyzer absent -> install hint and non-zero exit", () => {
  if (hasRustAnalyzer) {
    console.log("   (rust-analyzer present on this host — the install-hint path is exercised where it is absent)");
    return;
  }
  const fx = fixture({ "Cargo.toml": "[package]\nname = \"x\"\n", "src/main.rs": "fn main() {}\n" });
  const r = spawnSync(process.execPath,
    [join(PKG, "codemap", "build.mjs"), "--root", fx, "--out", join(fx, ".geml-code-graph")],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  const outText = (r.stdout || "") + (r.stderr || "");
  assert.notEqual(r.status, 0, `expected non-zero exit; got ${r.status}: ${outText}`);
  assert.match(outText, /rust-analyzer is required for Rust/, "names the language that needs rust-analyzer");
  assert.match(outText, /rustup component add rust-analyzer/, "gives the rustup install hint");
  assert.match(outText, /github\.com\/rust-lang\/rust-analyzer\/releases/, "names the releases page");
  rmSync(fx, { recursive: true, force: true });
});

test("e2e: cargo crate -> auto-detected rust build + verify (needs rust-analyzer)", () => {
  if (!hasRustAnalyzer) {
    console.log("   (rust-analyzer not on PATH — skipping the real-crate rust e2e)");
    return;
  }
  const fx = fixture({
    "Cargo.toml": "[package]\nname = \"spike_crate\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    "src/lib.rs": [
      "pub mod util;",
      "",
      "pub struct Widget { pub w: u32, pub h: u32 }",
      "",
      "impl Widget {",
      "    pub fn new(w: u32, h: u32) -> Self { Widget { w, h } }",
      "    pub fn area(&self) -> u32 { util::multiply(self.w, self.h) }",
      "}",
      "",
      "pub fn describe(widget: &Widget) -> String {",
      "    let a = widget.area();",
      "    util::format_area(a)",
      "}",
      "",
    ].join("\n"),
    "src/util.rs": "pub fn multiply(a: u32, b: u32) -> u32 { a * b }\n\npub fn format_area(a: u32) -> String { format!(\"area={}\", a) }\n",
    "src/main.rs": "use spike_crate::{describe, Widget};\n\nfn main() {\n    let w = Widget::new(3, 4);\n    println!(\"{}\", describe(&w));\n}\n",
  });
  const out = join(fx, ".geml-code-graph");
  // rust-analyzer runs `cargo metadata`, which may touch the network once —
  // give the whole build a generous ceiling, not runTool's 120s.
  const r = spawnSync(process.execPath,
    [join(PKG, "codemap", "build.mjs"), "--root", fx, "--out", out],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  const outText = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 0, `exit ${r.status}: ${outText}`);
  assert.match(outText, /detected: Rust \(Cargo\.toml\) -> scip/, "auto-detect names the rust job");
  assert.ok(existsSync(join(out, "_build", "rust.scip")), "the rust index landed under _build");
  runTool(join(PKG, "codemap", "verify.mjs"), out);
  const lookup = JSON.parse(readFileSync(join(out, "_index", "name-lookup.json"), "utf8"));
  for (const key of ["multiply", "describe", "Widget::area", "area", "main"]) {
    assert.ok(lookup[key]?.length, `name-lookup answers for '${key}'`);
  }
  const recipe = JSON.parse(readFileSync(join(out, "_index", "refresh.json"), "utf8"));
  assert.ok(recipe.steps.some((s) => s.argv?.slice(0, 4).join(" ") === "rust-analyzer scip . --output"),
    "the recorded recipe replays the rust indexer");
  rmSync(fx, { recursive: true, force: true });
});

// ---- React / JSX via scip-typescript -----------------------------------
// test/fixtures/react-app/ is a realistic mini React app (function + arrow
// components, JSX render tree, callback props, custom hook + reducer,
// context). Its index.scip is PRE-BAKED and committed — produced by
//   cd test/fixtures/react-app && npm install --no-package-lock
//   npx --yes @sourcegraph/scip-typescript index --output index.scip
// — so these tests run offline: no npx, no node_modules at test time.
// (Re-bake with those two commands after editing the fixture sources.)

test("detect: react app (tsconfig.json + .tsx) -> a single scip TypeScript job", () => {
  const jobs = detectLanguages(join(PKG, "test", "fixtures", "react-app"));
  assert.equal(jobs.length, 1, "one job");
  assert.equal(jobs[0].indexer, "scip");
  assert.equal(jobs[0].language, "TypeScript");
  assert.equal(jobs[0].signal, "tsconfig.json");
});

test("scip nameOf: term symbols — arrow components and class-property arrows", () => {
  assert.equal(scipNameOf("scip-typescript npm react-fixture 0.1.0 src/components/`Logo.tsx`/Logo."), "Logo");
  assert.equal(scipNameOf("scip-typescript npm p 1.0.0 src/`a.tsx`/Widget#onClick."), "Widget.onClick");
});

test("scip extract: arrow-fn rule — term def WITH enclosing_range is a function; without, data (synthetic)", () => {
  const TS = "scip-typescript npm p 1.0.0 ";
  const bytes = Buffer.from([
    ...scipDoc("src/App.tsx", [
      scipOcc({ range: [0, 9, 0, 12], symbol: TS + "src/`App.tsx`/App().", roles: 1, enclosing: [0, 0, 9, 1] }),
      scipOcc({ range: [2, 5, 2, 9], symbol: TS + "src/`Logo.tsx`/Logo." }),          // <Logo /> inside App
      scipOcc({ range: [3, 5, 3, 8], symbol: TS + "src/`config.ts`/cfg." }),          // property read inside App
      scipOcc({ range: [11, 0, 11, 4], symbol: TS + "src/`Logo.tsx`/Logo." }),        // module-scope (import) ref
    ]),
    ...scipDoc("src/Logo.tsx", [
      // const Logo = () => …: TERM descriptor, but the definition carries an
      // enclosing_range — scip-typescript's function-like signal.
      scipOcc({ range: [1, 13, 1, 17], symbol: TS + "src/`Logo.tsx`/Logo.", roles: 1, enclosing: [1, 20, 4, 1] }),
    ]),
    ...scipDoc("src/config.ts", [
      // const cfg = { … }: TERM definition with NO enclosing_range — data.
      scipOcc({ range: [0, 13, 0, 16], symbol: TS + "src/`config.ts`/cfg.", roles: 1 }),
    ]),
    ...scipDoc("src/main.rs", [
      // rust term def with an enclosing range: the promotion is gated OFF for
      // rust-analyzer symbols (rust closures are locals; const semantics differ).
      scipOcc({ range: [0, 6, 0, 7], symbol: "rust-analyzer cargo c 0.1.0 K.", roles: 1, enclosing: [0, 0, 2, 1] }),
    ]),
  ]);
  const dir = tmp();
  const raw = join(dir, "index.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir });
  const fns = r.symbols.filter((s) => s.kind === "Function");
  assert.deepEqual(fns.map((s) => s.name).sort(), ["App", "Logo"], "arrow fn promoted; object const and rust term are NOT");
  const logo = fns.find((s) => s.name === "Logo");
  assert.deepEqual([logo.line_start, logo.line_end], [2, 5], "enclosing_range drives the arrow component's span");
  assert.equal(r.edges.length, 1, "exactly one edge — no phantom property-read call, no module-scope import edge");
  assert.deepEqual(
    [scipNameOf(r.edges[0].from), scipNameOf(r.edges[0].to), r.edges[0].confidence],
    ["App", "Logo", "high"],
    "the in-component term reference resolves as a call",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("scip extract: React fixture — JSX render tree + hook/reducer wiring resolve; indirect dispatch stays absent", () => {
  const fxRoot = join(PKG, "test", "fixtures", "react-app");
  const r = scipExtract({ raw: join(fxRoot, "index.scip"), root: fxRoot });
  assert.ok(r.symbols.every((s) => s.lang === "typescript"), "scip-typescript index -> lang typescript");

  const fns = new Map(r.symbols.filter((s) => s.kind === "Function").map((s) => [s.name, s]));
  for (const n of ["App", "Header", "Logo", "ThemeToggle", "TodoItem", "TodoList", "ThemeProvider", "useTheme", "useTodos", "todosReducer"]) {
    assert.ok(fns.has(n), `component/hook node '${n}'`);
  }
  assert.ok(fns.get("App").line_end > fns.get("App").line_start, "function component span from enclosing_range");
  assert.ok(fns.get("Logo").line_end > fns.get("Logo").line_start, "arrow component span from enclosing_range");
  // memo()-wrapped component: the const is initialized with a CALL (no
  // enclosing_range) and the inner function expression is a scip local —
  // invisible. A documented limitation, pinned so a scip-typescript upgrade
  // that fixes it gets noticed.
  assert.ok(!fns.has("Footer"), "memo()-wrapped component is NOT a node (known gap)");
  assert.ok(!fns.has("appConfig"), "object-literal const stays data, never a Function node");

  const resolved = new Set(r.edges.filter((e) => e.to).map((e) => `${scipNameOf(e.from)}->${scipNameOf(e.to)}`));
  for (const edge of [
    "App->Header",              // <Header count={…} /> — plain JSX render edge
    "TodoList->TodoItem",       // JSX inside todos.map(…) — attributed through the arrow to the component
    "Header->Logo",             // JSX rendering an ARROW component (the term+enclosing rule)
    "App->useTodos",            // custom hook call
    "ThemeToggle->useTheme",    // custom hook call
    "useTodos->todosReducer",   // reducer passed to useReducer — the wiring edge
    "useTodos->toggleTodo",     // action creator called inside useCallback(…)
    "formatDate->truncate",     // plain util -> util sanity
  ]) assert.ok(resolved.has(edge), `resolved edge ${edge}`);
  assert.ok(r.edges.filter((e) => e.to).every((e) => e.confidence === "high"), "project-internal react edges resolve high");

  // react's own hooks are EXTERNAL symbols: honest #unresolved rows, readably named.
  const unresolved = new Set(r.edges.filter((e) => e.to_text).map((e) => `${scipNameOf(e.from)}->${e.to_text}`));
  assert.ok(unresolved.has("useTheme->useContext"), "external react hook lands unresolved");
  assert.ok(unresolved.has("App->useState"), "external react hook lands unresolved");

  // The dynamic-dispatch blind spots are fully ABSENT — silently (the hop goes
  // through a scip local / interface member, which never surfaces as a call):
  const all = [...resolved, ...unresolved];
  assert.ok(!all.some((e) => e.startsWith("TodoItem->") && /toggle/i.test(e)), "callback-prop call (onToggle) leaves NO edge");
  assert.ok(!all.some((e) => e.startsWith("ThemeToggle->") && /^ThemeToggle->toggle/.test(e)), "context-injected fn call leaves NO edge");
  assert.ok([...resolved].filter((e) => e.endsWith("->todosReducer")).every((e) => e === "useTodos->todosReducer"),
    "dispatch() -> reducer hop invisible: only the useReducer wiring edge reaches the reducer");
  assert.ok(!all.some((e) => e.endsWith("->App")), "module-scope render in main.tsx attributes NO caller to App");
});

// ---- SFC virtualization (detect flag, indexer command, adapter remap) -------

test("detect: .vue + vue dependency -> the TS job carries sfc:'vue'", () => {
  const jobs = detectLanguages("/r", {
    files: ["app/src/main.ts", "app/src/App.vue", "app/src/pages/Home.vue"],
    manifests: [],
    pkgs: ["app/package.json"],
    readJson: (p) => {
      assert.match(p.replace(/\\/g, "/"), /\/r\/app\/package\.json$/, "reads the GROUP's package.json");
      return { dependencies: { vue: "^3.5.0" }, devDependencies: {} };
    },
  });
  const ts = jobs.find((j) => j.language === "TypeScript");
  assert.equal(ts.sfc, "vue");
  assert.equal(ts.subroot, "app");
  assert.match(ts.signal, /\+vue-sfc/, "the plan line says the SFC mode out loud");
  assert.ok(isSourcePath("src/App.vue"), "a .vue edit must trigger refresh");
  assert.ok(isSourcePath("src/W.svelte"));
});

test("detect: svelte devDependency -> sfc:'svelte'; both frameworks join", () => {
  const readJson = () => ({ devDependencies: { svelte: "^4.0.0", vue: "^3.0.0" } });
  const sv = detectLanguages("/r", {
    files: ["web/a.ts", "web/W.svelte"], manifests: [], pkgs: ["web/package.json"], readJson,
  }).find((j) => j.language === "TypeScript");
  assert.equal(sv.sfc, "svelte", "only the PRESENT extension counts, not every declared dep");
  const both = detectLanguages("/r", {
    files: ["web/a.ts", "web/W.svelte", "web/A.vue"], manifests: [], pkgs: ["web/package.json"], readJson,
  }).find((j) => j.language === "TypeScript");
  assert.equal(both.sfc, "svelte,vue");
});

test("detect: no sfc flag without the framework dep, without SFC files, or without a package.json", () => {
  // Each group carries a tsconfig so it stays a real (indexed) project — the
  // point here is the sfc flag, which must be undefined in every case below.
  // .vue present but the group's package.json never installed vue
  const noDep = detectLanguages("/r", {
    files: ["app/a.ts", "app/A.vue"], manifests: ["app/tsconfig.json"], pkgs: ["app/package.json"],
    readJson: () => ({ dependencies: { react: "^18.0.0" } }),
  }).find((j) => j.language === "TypeScript");
  assert.equal(noDep.sfc, undefined);
  assert.doesNotMatch(noDep.signal, /-sfc/);
  // vue dep declared but no .vue files anywhere
  const noFiles = detectLanguages("/r", {
    files: ["app/a.ts"], manifests: ["app/tsconfig.json"], pkgs: ["app/package.json"],
    readJson: () => ({ dependencies: { vue: "^3.5.0" } }),
  }).find((j) => j.language === "TypeScript");
  assert.equal(noFiles.sfc, undefined);
  // .vue files grouped under a tsconfig-only subroot: no package.json to read
  const noPkg = detectLanguages("/r", {
    files: ["lib/a.ts", "lib/A.vue"], manifests: ["lib/tsconfig.json"], pkgs: [],
    readJson: () => { throw new Error("must not be called without a package.json dir"); },
  }).find((j) => j.language === "TypeScript");
  assert.equal(noPkg.sfc, undefined);
});

test("detect: a .vue-only app still detects TypeScript (extension family)", () => {
  const jobs = detectLanguages("/r", {
    files: ["app/App.vue", "app/pages/a.vue", "app/pages/b.vue"],
    manifests: [], pkgs: ["app/package.json"],
    readJson: () => ({ dependencies: { vue: "^3.5.0" } }),
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].language, "TypeScript");
  assert.equal(jobs[0].sfc, "vue");
});

test("indexerCommand: sfc job -> virtualizer pre-step, scip runs IN the virtual dir", () => {
  const cmd = indexerCommand(
    { indexer: "scip", language: "TypeScript", signal: "apps/web/package.json +vue-sfc", subroot: "apps/web", sfc: "vue" },
    { root: "/r", buildDir: "/b", scriptPath: "/s/joern-export.sc", sfcScript: "/s/sfc-virtualize.mjs" },
  );
  assert.equal(cmd.adapter, "scip");
  assert.match(cmd.remapDir.replace(/\\/g, "/"), /\/b\/virtual-apps-web$/, "one virtual dir per project");
  assert.deepEqual(cmd.pre.argv, ["npx", "-y", "-p", "@vue/language-core", "-p", "typescript@5", "node", "/s/sfc-virtualize.mjs"],
    "hermetic npx -p set; typescript pinned @5");
  assert.equal(cmd.pre.env.GEML_SRC.replace(/\\/g, "/"), "/r/apps/web");
  assert.equal(cmd.pre.env.GEML_OUT, cmd.remapDir);
  assert.equal(cmd.cwd, cmd.remapDir, "scip indexes the synthetic tsconfig");
  assert.ok(!cmd.argv.includes("--infer-tsconfig"), "the virtual dir HAS a tsconfig");
  assert.match(cmd.raw.replace(/\\/g, "/"), /\/index-apps-web\.scip$/);
  // svelte pulls svelte2tsx + svelte; a root-level project gets virtual-root
  const sv = indexerCommand(
    { indexer: "scip", language: "TypeScript", signal: "package.json +svelte-sfc", sfc: "svelte" },
    { root: "/r", buildDir: "/b", sfcScript: "/s/v.mjs" },
  );
  assert.deepEqual(sv.pre.argv.slice(0, 6), ["npx", "-y", "-p", "svelte2tsx", "-p", "svelte"]);
  assert.match(sv.remapDir.replace(/\\/g, "/"), /\/b\/virtual-root$/);
  // and a plain TS job still has no pre step (regression)
  const plain = indexerCommand({ indexer: "scip", signal: "tsconfig.json" }, { root: "/r", buildDir: "/b", scriptPath: "/s" });
  assert.equal(plain.pre, undefined);
  assert.equal(plain.remapDir, undefined);
});

test("scip extract remap: shadows -> original .vue/.svelte, template nodes, local admission", () => {
  const dir = tmp(); // the repo root
  const vdir = join(dir, ".geml-code-graph", "_build", "virtual-root");
  mkdirSync(join(vdir, "src"), { recursive: true });
  writeFileSync(join(vdir, "sfc-manifest.json"), JSON.stringify({
    version: 1, src: dir.replace(/\\/g, "/"),
    files: [
      { shadow: "src/App.vue.ts", original: "src/App.vue", map: "src/App.vue.ts.map.json" },
      { shadow: "src/Widget.svelte.ts", original: "src/Widget.svelte", map: "src/Widget.svelte.ts.map.json" },
    ],
  }));
  writeFileSync(join(vdir, "src", "App.vue.ts.map.json"), JSON.stringify({
    version: 1, original: "src/App.vue", framework: "vue", component: "App",
    lines: [[3, 2], [4, 3], [5, 4], [20, 9]], // generated -> original, 1-based
    regions: [{ name: "template", start: 8, end: 11 }],
  }));
  writeFileSync(join(vdir, "src", "Widget.svelte.ts.map.json"), JSON.stringify({
    version: 1, original: "src/Widget.svelte", framework: "svelte", component: "Widget",
    lines: [[6, 3], [12, 7]],
    regions: [{ name: "template", start: 7, end: 7 }],
  }));
  // local admission reads the svelte shadow TEXT: name at the def range, span
  // from the brace scan (bump is one line -> encl stays on it)
  writeFileSync(join(vdir, "src", "Widget.svelte.ts"), [
    "import { helper } from './helper';",                             // 1
    "",                                                               // 2
    "function $$render() {",                                          // 3
    "",                                                               // 4
    "  let count = 0;",                                               // 5
    "  function bump() { helper(); count++; }",                       // 6
    "",                                                               // 7
    "async () => {",                                                  // 8
    "", "", "",                                                       // 9-11
    ' { svelteHTML.createElement("button", { "on:click": bump }); }', // 12
    "};",                                                             // 13
    "return {};",                                                     // 14
    "}",                                                              // 15
  ].join("\n"));

  const TS = "scip-typescript npm t 1.0.0 ";
  const bytes = Buffer.from([
    ...scipDoc("src/App.vue.ts", [
      // def save: generated lines 4-5 map to original 3-4 (verbatim script)
      scipOcc({ range: [3, 9, 13], symbol: TS + "src/`App.vue.ts`/save().", roles: 1, enclosing: [3, 0, 4, 1] }),
      scipOcc({ range: [3, 20, 26], symbol: TS + "src/`helper.ts`/helper()." }),      // call inside save
      scipOcc({ range: [19, 1, 5], symbol: TS + "src/`App.vue.ts`/save()." }),        // template usage ref (gen 20 -> orig 9)
      scipOcc({ range: [25, 0, 10], symbol: TS + "src/`App.vue.ts`/save()." }),       // UNMAPPED generated echo
      scipOcc({ range: [19, 6, 30], symbol: TS + "types/`h.d.ts`/__VLS_asFunctionalElement()." }), // machinery
    ]),
    ...scipDoc("src/Widget.svelte.ts", [
      scipOcc({ range: [2, 9, 17], symbol: TS + "src/`Widget.svelte.ts`/$$render().", roles: 1, enclosing: [2, 0, 14, 1] }),
      scipOcc({ range: [5, 11, 15], symbol: "local 3", roles: 1 }),                   // def bump (name from shadow text)
      scipOcc({ range: [5, 22, 28], symbol: TS + "src/`helper.ts`/helper()." }),      // call inside bump
      scipOcc({ range: [11, 53, 57], symbol: "local 3" }),                            // markup ref (gen 12 -> orig 7)
    ]),
    ...scipDoc("../../../src/helper.ts", [
      scipOcc({ range: [1, 16, 22], symbol: TS + "src/`helper.ts`/helper().", roles: 1, enclosing: [1, 0, 3, 1] }),
    ]),
    ...scipDoc("svelte-shims.d.ts", [
      scipOcc({ range: [0, 8, 30], symbol: TS + "`svelte-shims.d.ts`/__sveltets_2_any().", roles: 1, enclosing: [0, 0, 0] }),
    ]),
  ]);
  const raw = join(dir, "index.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir, remapDir: vdir });

  const fns = Object.fromEntries(r.symbols.filter((s) => s.kind === "Function").map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(fns).sort(), ["App.template", "Widget.template", "bump", "helper", "save"],
    "user + template symbols only: $$render, __VLS_*, __sveltets_* and shims never surface");
  assert.equal(fns.save.file, "src/App.vue");
  assert.deepEqual([fns.save.line_start, fns.save.line_end], [3, 4], "definition span maps line-for-line");
  assert.equal(fns.bump.file, "src/Widget.svelte");
  assert.equal(fns.bump.line_start, 3);
  assert.equal(fns["App.template"].file, "src/App.vue");
  assert.deepEqual([fns["App.template"].line_start, fns["App.template"].line_end], [8, 11], "template node spans the block");
  assert.equal(fns.helper.file, "src/helper.ts", "../-relative real files re-anchor repo-relative");
  assert.ok(r.symbols.some((s) => s.anchor === "file:src/App.vue"), "file symbol wears the original path");
  assert.ok(!r.symbols.some((s) => s.file.includes("virtual-root") || s.file.includes("svelte-shims")),
    "no shadow paths and no scaffolding leak into the symbol space");

  const nameOfAnchor = new Map(r.symbols.map((s) => [s.anchor, s.name]));
  const edges = r.edges.map((e) => `${nameOfAnchor.get(e.from)}->${e.to ? nameOfAnchor.get(e.to) : e.to_text}@${e.site.file}:${e.site.line}`).sort();
  assert.deepEqual(edges, [
    "App.template->save@src/App.vue:9",
    "Widget.template->bump@src/Widget.svelte:7",
    "bump->helper@src/Widget.svelte:3",
    "save->helper@src/App.vue:3",
  ], "template edges via the region rescue; generated echoes and machinery calls dropped");
  rmSync(dir, { recursive: true, force: true });
});

test("scip extract remap: without a manifest the remapDir is inert (plain index)", () => {
  const dir = tmp();
  const TS = "scip-typescript npm t 1.0.0 ";
  const bytes = Buffer.from([...scipDoc("src/a.ts", [
    scipOcc({ range: [1, 9, 12], symbol: TS + "src/`a.ts`/foo().", roles: 1, enclosing: [1, 0, 3, 1] }),
  ])]);
  const raw = join(dir, "index.scip");
  writeFileSync(raw, bytes);
  const r = scipExtract({ raw, root: dir, remapDir: join(dir, "nonexistent-virtual") });
  assert.equal(r.symbols.filter((s) => s.kind === "Function").length, 1, "extraction proceeds unremapped");
  assert.equal(r.symbols[0].file, "src/a.ts");
  rmSync(dir, { recursive: true, force: true });
});

test("sfc-virtualize smoke: real Volar projection end-to-end (needs npx; skips offline)", () => {
  const probe = spawnSync("npx --version", { shell: true, encoding: "utf8", timeout: 60_000 });
  if (probe.error || probe.status !== 0) {
    console.log("   (npx unavailable — skipping the virtualizer smoke)");
    return;
  }
  const fx = fixture({
    "package.json": JSON.stringify({ name: "smoke", version: "1.0.0", dependencies: { vue: "^3.5.0" } }),
    "src/App.vue": '<script setup lang="ts">\nimport { helper } from \'./helper\'\nfunction save() { helper() }\n</script>\n\n<template>\n  <button @click="save">Go</button>\n</template>\n',
    "src/helper.ts": "export function helper(): number {\n  return 1;\n}\n",
  });
  const vout = join(fx, "virtual");
  const script = join(PKG, "codemap", "sfc-virtualize.mjs");
  const r = spawnSync(
    `npx -y -p @vue/language-core -p typescript@5 node "${script}"`,
    { shell: true, encoding: "utf8", timeout: 240_000, env: { ...process.env, GEML_SRC: fx, GEML_OUT: vout } },
  );
  const outText = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0 && /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRE|network|registry\.npmjs/i.test(outText)) {
    console.log("   (npx cannot reach the registry — skipping the virtualizer smoke)");
    rmSync(fx, { recursive: true, force: true });
    return;
  }
  assert.equal(r.status, 0, `sfc-virtualize exit ${r.status}: ${outText}`);
  const shadow = readFileSync(join(vout, "src", "App.vue.ts"), "utf8");
  assert.match(shadow, /import { helper } from '\.\/helper'/, "script block copied verbatim");
  const map = JSON.parse(readFileSync(join(vout, "src", "App.vue.ts.map.json"), "utf8"));
  assert.equal(map.original, "src/App.vue");
  assert.equal(map.framework, "vue");
  assert.equal(map.component, "App");
  assert.equal(map.regions[0]?.name, "template");
  assert.ok(map.regions[0].start >= 5 && map.regions[0].end >= map.regions[0].start, "region points into the template block");
  assert.ok(map.lines.some(([, orig]) => orig >= map.regions[0].start && orig <= map.regions[0].end),
    "the template projection maps back into the template block — @click coverage is real");
  const tsconfig = JSON.parse(readFileSync(join(vout, "tsconfig.json"), "utf8"));
  assert.ok(tsconfig.files.includes("src/App.vue.ts"), "shadow listed");
  assert.ok(tsconfig.files.some((f) => f.endsWith("src/helper.ts")), "the project's real TS rides along");
  assert.equal(tsconfig.compilerOptions.rootDirs.length, 2, "virtual and real trees merged for relative imports");
  rmSync(fx, { recursive: true, force: true });
});

// Fake indexers on PATH for the auto-mode failure tests: `npx` always fails
// (scip down / no tsconfig), `joern` answers --version and writes a minimal
// export. Logic lives in one node script; sh + .cmd wrappers cover both unix
// and Windows spawn paths.
const fakeIndexerBin = () => {
  const bin = tmp();
  writeFileSync(join(bin, "fake-joern.cjs"), [
    'const { mkdirSync, writeFileSync } = require("node:fs");',
    'const { join } = require("node:path");',
    'if (process.argv.includes("--version")) { console.log("9.9.9"); process.exit(0); }',
    "const out = process.env.GEML_OUT;",
    "mkdirSync(out, { recursive: true });",
    'writeFileSync(join(out, "methods.jsonl"), JSON.stringify({ fullName: "A.run", signature: "s()", file: "svc/A.java", name: "run", lineStart: 1, lineEnd: 3 }) + "\\n");',
    'writeFileSync(join(out, "calls.jsonl"), "");',
  ].join("\n"));
  writeFileSync(join(bin, "joern"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-joern.cjs" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "joern.cmd"), `@"${process.execPath}" "%~dp0fake-joern.cjs" %*\r\n`);
  writeFileSync(join(bin, "npx"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(bin, "npx.cmd"), "@exit /b 1\r\n");
  return bin;
};
const runBuildWithFakes = (bin, fx) => spawnSync(process.execPath,
  [join(PKG, "codemap", "build.mjs"), "--root", fx, "--out", join(fx, ".geml-code-graph")],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    env: { ...process.env, PATH: bin + delimiter + process.env.PATH, GEML_JOERN: "" } });

test("build.mjs auto: one indexer failing does not sink the others (partial map + warning, exit 0)", () => {
  const fx = fixture({
    "pom.xml": "<project/>", "svc/A.java": "class A { void run() {} }",
    "web/tsconfig.json": "{}", "web/src/app.ts": "export const x = 1;",
  });
  const bin = fakeIndexerBin();
  const r = runBuildWithFakes(bin, fx);
  const outText = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 0, `expected the Java half to survive scip's failure: ${outText}`);
  assert.match(outText, /indexer failed for TypeScript at web \(scip\)/, "the failure names the project dir");
  assert.match(outText, /continuing WITHOUT TypeScript/, "partiality is called out, not silent");
  assert.match(outText, /geml-code-graph: .*1 methods/, "the Joern extraction still merged");
  const recipe = JSON.parse(readFileSync(join(fx, ".geml-code-graph", "_index", "refresh.json"), "utf8"));
  assert.ok(!recipe.steps.some((s) => JSON.stringify(s).includes("scip-typescript")), "the failed indexer is not recorded for replay");
  // The joern step must replay IN the build dir (so refresh, too, keeps Joern's
  // workspace under _build/): cwd recorded relative to root, GEML_SRC/OUT re-based
  // on that cwd (root is two levels up; the raw dir is a sibling under _build).
  const jstep = recipe.steps.find((s) => Array.isArray(s.argv) && s.argv.includes("joern"));
  assert.ok(jstep, "a joern step is recorded");
  assert.equal(jstep.cwd, ".geml-code-graph/_build", "joern replays in the build dir");
  assert.equal(jstep.env.GEML_SRC, "../..", "GEML_SRC points back to the repo root from the build dir");
  assert.equal(jstep.env.GEML_OUT, "joern-javasrc", "GEML_OUT is relative to the build-dir cwd");
  assert.equal(jstep.env.GEML_LANG, "JAVASRC");
  // The build drops a .gitignore so its transient _build/ (incl. Joern's
  // workspace cache) is never committed, while the .geml graph + _index stay committable.
  const ignore = readFileSync(join(fx, ".geml-code-graph", ".gitignore"), "utf8");
  assert.match(ignore, /^_build\/$/m, "_build/ is git-ignored");
  rmSync(fx, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

test("build.mjs auto: every indexer failing -> non-zero exit, clear error", () => {
  const fx = fixture({ "web/tsconfig.json": "{}", "web/src/app.ts": "export const x = 1;" });
  const bin = fakeIndexerBin();
  const r = runBuildWithFakes(bin, fx);
  const outText = (r.stdout || "") + (r.stderr || "");
  assert.notEqual(r.status, 0, `expected non-zero exit; got ${r.status}: ${outText}`);
  assert.match(outText, /every indexer failed/);
  rmSync(fx, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

test("build.mjs auto: --root defaults to the current directory when omitted", () => {
  // No --root, no --adapter: the build roots at cwd and RUNS auto-detect (here
  // it finds no supported language and says so) — it must NOT fall back to the
  // old "--root required" usage and exit 2.
  const fx = fixture({ "notes.txt": "just prose, no source here" });
  const r = spawnSync(process.execPath, [join(PKG, "codemap", "build.mjs")],
    { cwd: fx, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  const outText = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 1, `expected auto-detect exit 1, got ${r.status}: ${outText}`);
  assert.match(outText, /could not auto-detect a supported language/, "root defaulted to cwd and auto-detect ran");
  assert.doesNotMatch(outText, /usage: geml codemap build/, "no usage error — --root is optional now");
  rmSync(fx, { recursive: true, force: true });
});

test("build.mjs: --help prints usage to stdout and exits 0", () => {
  const r = spawnSync(process.execPath, [join(PKG, "codemap", "build.mjs"), "--help"],
    { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, `--help must exit 0, got ${r.status}`);
  assert.match(r.stdout, /usage: geml codemap build \[--root <repo-root>\]/, "help goes to stdout, marks --root optional");
});

// ---- foldings.geml schema (parse + serialize) --------------------------
test("foldings: serialize -> parse round-trips the five fields", () => {
  const cfg = {
    foldPrefixes: ["integrations", "crates", "libs/vendor"],
    sourceRoots: ["src/main/*", "src/main", "src"],
    testRoots: ["src/test/*", "test"],
    moduleRoots: ["svc/a", "svc/b"],
    stripSharedPrefix: true,
  };
  const text = serializeFoldings(cfg);
  assert.equal(parse(text).diagnostics.filter((d) => d.severity === "error").length, 0, "seeded file is clean GEML");
  assert.deepEqual(parseFoldings(text), cfg);
});

test("foldings: options strip-shared-prefix off is read as false; missing sections default empty/true", () => {
  const text = "## options\n\n- strip-shared-prefix: off\n";
  const cfg = parseFoldings(text);
  assert.equal(cfg.stripSharedPrefix, false);
  assert.deepEqual(cfg.foldPrefixes, []);
  assert.deepEqual(cfg.sourceRoots, []);
  assert.deepEqual(cfg.testRoots, []);
});

test("deriveFoldLayers: top-level non-module ancestors are ceremony; module roots are not", () => {
  assert.deepEqual(deriveFoldLayers(["integrations/geml-viewer", "integrations/obsidian", "geml-parser"]), ["integrations"]);
  assert.deepEqual(deriveFoldLayers(["crates/core", "crates/util"]), ["crates"]);
  assert.deepEqual(deriveFoldLayers(["core", "web"]), [], "flat multi-module: nothing is ceremony");
  assert.deepEqual(deriveFoldLayers(["modules/core", "modules/web"]), ["modules"]);
});

test("defaultFoldings: structural ∪ language prefixes; source/test-root defaults", () => {
  const cfg = defaultFoldings({ moduleRoots: ["crates/core"], languages: ["Rust"] });
  assert.deepEqual(cfg.foldPrefixes, ["crates"]);
  assert.deepEqual(cfg.sourceRoots, ["src/main/*", "src/main", "src"]);
  assert.ok(cfg.testRoots.includes("src/test/*") && cfg.testRoots.includes("test"));
  assert.equal(cfg.stripSharedPrefix, true);
});

test("loadOrSeedFoldings: seeds _index/foldings.geml when absent, does not overwrite when present", () => {
  const out = mkdtempSync(join(tmpdir(), "fold-io-"));
  const r1 = loadOrSeedFoldings({ outDir: out, moduleRoots: ["integrations/geml-viewer"], languages: ["TypeScript"] });
  assert.equal(r1.seeded, true);
  const p = join(out, "_index", "foldings.geml");
  assert.ok(existsSync(p), "file written");
  assert.deepEqual(r1.config.foldPrefixes, ["integrations"]);
  // user edits the file
  writeFileSync(p, "## fold-prefixes\n\n- myceremony\n");
  const r2 = loadOrSeedFoldings({ outDir: out, moduleRoots: ["integrations/geml-viewer"], languages: [] });
  assert.equal(r2.seeded, false, "existing file left untouched");
  assert.deepEqual(r2.config.foldPrefixes, ["myceremony"], "user edit honoured");
  rmSync(out, { recursive: true, force: true });
});

test("loadOrSeedFoldings: a malformed file falls back to the DEFAULTS (not a silent empty rule set)", () => {
  const out = mkdtempSync(join(tmpdir(), "fold-bad-"));
  mkdirSync(join(out, "_index"), { recursive: true });
  writeFileSync(join(out, "_index", "foldings.geml"), "=== note\nunterminated block"); // GEML error diagnostic
  const r = loadOrSeedFoldings({ outDir: out, moduleRoots: ["crates/core"], languages: ["Rust"] });
  assert.deepEqual(r.config, defaultFoldings({ moduleRoots: ["crates/core"], languages: ["Rust"] }),
    "a broken edit must degrade to the built-in defaults, not drop every rule");
  assert.ok(r.config.foldPrefixes.includes("crates") && r.config.sourceRoots.length > 0,
    "defaults keep the seeded fold prefix AND the source roots — source-root stripping is NOT silently lost");
  rmSync(out, { recursive: true, force: true });
});

test("parseFoldings: an intentionally empty file is the off-switch (empty rules, no throw)", () => {
  // Distinct from a malformed file: no error diagnostics -> empty config, not defaults.
  const cfg = parseFoldings("");
  assert.deepEqual(cfg, { foldPrefixes: [], sourceRoots: [], testRoots: [], moduleRoots: [], stripSharedPrefix: true });
});

test("build.mjs auto: seeds _index/foldings.geml and folds an above-root ceremony dir", () => {
  // A Java module nested under a ceremony dir `modules/`. The fake joern
  // SUCCEEDS, so the build reaches the merge/emit stage where foldings is
  // seeded+applied (a fixture whose only indexer fails would exit at "every
  // indexer failed" before seeding). Seeding keys on findModuleRoots(fixture),
  // which sees modules/svc from its pom.xml, independent of the indexer output.
  const fx = fixture({
    "modules/svc/pom.xml": "<project/>",
    "modules/svc/src/main/java/com/co/svc/A.java": "class A { void run() {} }",
  });
  const bin = fakeIndexerBin();
  runBuildWithFakes(bin, fx);
  const p = join(fx, ".geml-code-graph", "_index", "foldings.geml");
  assert.ok(existsSync(p), "foldings.geml seeded");
  const cfg = parseFoldings(readFileSync(p, "utf8"));
  assert.ok(cfg.foldPrefixes.includes("modules"), "the above-root ceremony dir is seeded as a fold prefix");
  rmSync(fx, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

test("codemap find: substring match prints name, doc#id and src; no false matches", () => {
  const out = mkdtempSync(join(tmpdir(), "find-"));
  mkdirSync(join(out, "_index"), { recursive: true });
  writeFileSync(join(out, "_index", "name-lookup.json"), JSON.stringify({
    "ApiDef::validate": [{ anchor: "a1", doc: "core.geml", id: "ApiDef-validate" }],
    "other": [{ anchor: "a2", doc: "core.geml", id: "other" }],
  }));
  writeFileSync(join(out, "core.geml"), '=== code {#ApiDef-validate name="ApiDef::validate" src=src/registry.rs#L59-116 anchor="a1"}\n===\n');
  const r = spawnSync(process.execPath, [join(PKG, "codemap", "find.mjs"), "valid", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ApiDef::validate\tcore\.geml#ApiDef-validate\tsrc\/registry\.rs#L59-116$/m, "name, doc#id and unquoted src");
  assert.doesNotMatch(r.stdout, /other/, "substring 'valid' must not match 'other'");
  rmSync(out, { recursive: true, force: true });
});

test("emit: a compact _index/search-index.js is written (anchor-free, script-loadable)", () => {
  const out = mkdtempSync(join(tmpdir(), "sidx-"));
  emit({
    symbols: [{ anchor: "x", kind: "Function", name: "doThing", file: "src/a.ts", line_start: 1, line_end: 2 }],
    edges: [], outDir: out, repoName: "r",
  });
  const js = readFileSync(join(out, "_index", "search-index.js"), "utf8");
  assert.match(js, /^window\.__gemlSearch=\[/, "assigns a JS global (loadable via <script src> from file://)");
  assert.match(js, /"doThing"/, "carries the symbol name");
  assert.doesNotMatch(js, /anchor/, "anchors dropped — keeps it small at scale");
  rmSync(out, { recursive: true, force: true });
});

await atest("serve.mjs /_search: ranked hits, alias-deduped, honest total", async () => {
  const out = mkdtempSync(join(tmpdir(), "srch-"));
  mkdirSync(join(out, "_index"), { recursive: true });
  writeFileSync(join(out, "index.geml"), "# code map\n");
  writeFileSync(join(out, "_index", "name-lookup.json"), JSON.stringify({
    "Api::open": [{ anchor: "a2", doc: "api.geml", id: "Api-open" }],
    open: [{ anchor: "a2", doc: "api.geml", id: "Api-open" }], // bare-name alias, SAME node
    reopen_all: [{ anchor: "a3", doc: "z.geml", id: "reopen_all" }],
    zebra: [{ anchor: "a1", doc: "z.geml", id: "zebra" }],
  }));
  const port = 21000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(PKG, "codemap", "serve.mjs"), out, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`serve not ready:\n${buf}`)), 15000);
      const onData = (d) => { buf += d; if (buf.includes(`:${port}`)) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`serve exited ${c}:\n${buf}`)); });
    });
    const r = await (await fetch(`http://127.0.0.1:${port}/_search?q=open`)).json();
    assert.equal(r.total, 2, "alias rows dedupe to distinct nodes");
    assert.deepEqual(r.hits.map((h) => h.id), ["Api-open", "reopen_all"], "exact bare name outranks the substring hit");
    assert.equal(r.hits[0].name, "open", "the kept alias row is the best-ranked one");
    const empty = await (await fetch(`http://127.0.0.1:${port}/_search?q=o`)).json();
    assert.deepEqual(empty, { total: 0, hits: [] }, "sub-2-char query returns the empty well-formed shape");
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 150)); // let the process release the dir (Windows EBUSY)
    rmSync(out, { recursive: true, force: true });
  }
});

test("entries: rust signals — src/main.rs, [[bin]] path, workers #[event] handlers", () => {
  const texts = {
    "/r/cli/Cargo.toml": '[package]\nname="c"\n[[bin]]\nname = "tool"\npath = "src/tools/t.rs"\n',
    "/r/cli/src/main.rs": "fn main() {}\n",
    "/r/w/Cargo.toml": '[package]\nname="w"\n',
    "/r/w/src/lib.rs": "#[event(fetch)]\nasync fn main(req: Request) {}\n#[event(scheduled)]\nasync fn tick() {}\n",
  };
  const hints = detectEntries("/r", {
    files: ["cli/src/main.rs", "cli/src/tools/t.rs", "w/src/lib.rs"],
    manifests: ["cli/Cargo.toml", "w/Cargo.toml"],
    readText: (p) => { const t = texts[p.replace(/\\/g, "/")]; if (t === undefined) throw new Error("no " + p); return t; },
  });
  const key = (h) => `${h.file}|${h.via}|${h.name ?? ""}`;
  assert.ok(hints.some((h) => key(h) === "cli/src/main.rs|cargo-bin|main"), "default bin");
  assert.ok(hints.some((h) => key(h) === "cli/src/tools/t.rs|cargo-bin|main"), "[[bin]] path target");
  assert.ok(hints.some((h) => key(h) === "w/src/lib.rs|worker-fetch|main"), "#[event(fetch)] names the SOURCE fn");
  assert.ok(hints.some((h) => key(h) === "w/src/lib.rs|worker-scheduled|tick"));
});

test("entries: js/ts + python + spring signals; hints never point outside indexed files", () => {
  const texts = {
    "/r/app/package.json": JSON.stringify({ bin: { x: "./src/cli.js" }, dependencies: { vue: "^3" } }),
    "/r/app/src/main.ts": 'import { createApp } from "vue";\ncreateApp(App).mount("#app");\n',
    "/r/nx/package.json": JSON.stringify({ dependencies: { nuxt: "^3" } }),
    "/r/srv/package.json": JSON.stringify({ name: "srv", bin: "./dist/srv.js" }),
    "/r/srv/src/server.js": "const app = express();\napp.listen(3000);\n",
    "/r/py/app.py": 'from flask import Flask\napp = Flask(__name__)\n',
    "/r/j/src/DemoApplication.java": "@SpringBootApplication\npublic class DemoApplication { public static void main(String[] a) {} }\n",
  };
  const hints = detectEntries("/r", {
    files: ["app/src/main.ts", "app/src/cli.js", "nx/app.vue", "srv/src/server.js",
      "py/manage.py", "py/pkg/__main__.py", "py/app.py", "j/src/DemoApplication.java"],
    pkgs: ["app/package.json", "nx/package.json", "srv/package.json"],
    readText: (p) => { const t = texts[p.replace(/\\/g, "/")]; if (t === undefined) throw new Error("no " + p); return t; },
  });
  const key = (h) => `${h.file}|${h.via}|${h.name ?? ""}`;
  assert.ok(hints.some((h) => key(h) === "app/src/cli.js|pkg-bin|"), "package.json bin");
  assert.ok(hints.some((h) => key(h) === "app/src/main.ts|vue-mount|"), "createApp().mount marker");
  assert.ok(hints.some((h) => key(h) === "nx/app.vue|nuxt-app|"), "nuxt app shell");
  assert.ok(hints.some((h) => key(h) === "srv/src/server.js|server-listen|"), ".listen marker");
  assert.ok(!hints.some((h) => h.file.includes("dist/")), "a bin pointing at dist/ (not indexed) emits NO hint");
  assert.ok(hints.some((h) => key(h) === "py/manage.py|django-manage|"));
  assert.ok(hints.some((h) => key(h) === "py/pkg/__main__.py|py-main|"));
  assert.ok(hints.some((h) => key(h) === "py/app.py|wsgi-app|"));
  assert.ok(hints.some((h) => key(h) === "j/src/DemoApplication.java|spring-boot|main"));
});

test("emit: entry hints mark methods (.app-entry + via) and file-level entries land in meta", () => {
  const { out, stats, doc } = runEmit(
    [fn("boot", "t:a#boot"), fn("helper", "t:a#helper"), fn("page", "t:b#page", "web/app.vue", 3), fileSym(), fileSym("web/app.vue")],
    [],
    { entryHints: [
      { file: "src/a.ts", name: "boot", via: "vue-mount" },   // named -> marks the method
      { file: "web/app.vue", via: "nuxt-app" },                // file-level: app.vue has ONE method -> marks it
      { file: "web/boot.ts", via: "pkg-bin" },                 // file with NO fn symbols in an existing container -> meta note
      { file: "nowhere/x.ts", via: "pkg-bin" },                // container never grew -> dropped, never invented
    ] },
  );
  const d = doc();
  assert.match(d, /\{#boot \.app-entry[^}]*entry-via="vue-mount"/, "named hint marks its method with class + via");
  assert.doesNotMatch(d, /#helper \.app-entry/, "unhinted sibling untouched");
  assert.match(d, /app-entry = #boot \(vue-mount\)/, "doc meta lists the app entry with its via");
  const w = doc("web.geml");
  assert.match(w, /\{#page \.app-entry[^}]*entry-via="nuxt-app"/, "file-level hint with a single method marks it");
  assert.match(w, /app-entry-file = web\/boot\.ts \(pkg-bin\)/, "no-symbol entry file lands as a doc-level note");
  const idx = readFileSync(join(out, "index.geml"), "utf8");
  assert.match(idx, /entry = src\.geml#boot web\.geml#page/, "index entry= carries the method-level app entries");
  assert.match(idx, /app-entry-docs = web\.geml/, "file-level entry docs listed under their own key");
  assert.equal(stats.entries, 3, "two method entries + one file-level note");
});

console.log(`\n${passed} test(s) passed.`);
// Exit explicitly — same Linux live-handle hazard as cli.test.mjs (this file
// spawns servers and watchers); V8 coverage is still flushed on process.exit.
process.exit(0);
