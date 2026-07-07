// codemap toolkit tests (geml-parser/codemap): pins the two scale bugs found
// on the Ignite-3 run — (1) build.mjs merging adapter output with an
// argument-spread push blew the call stack past ~10^5 edges; (2) emit.mjs
// deduped same-name symbols with a fixed 6-hex hash, which collided once at
// that scale and now escalates per name group on demand — plus the guard that
// duplicate ANCHORS fail loudly instead of escalating forever.
import { emit } from "../codemap/emit.mjs";
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";

// The toolkit logs progress on stderr (stdout stays clean for data): run a
// tool, assert exit 0, and hand back both streams for content checks.
const runTool = (script, ...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
const runEmit = (symbols, edges = []) => {
  const dir = tmp();
  const out = join(dir, "map"), build = join(dir, "build");
  mkdirSync(out, { recursive: true });
  mkdirSync(build, { recursive: true });
  const stats = emit({ symbols, edges, outDir: out, buildDir: build, repoName: "t", container: "dir", commit: "t0" });
  return { dir, out, stats, doc: (n = "src.geml") => readFileSync(join(out, n), "utf8") };
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
  const d = readFileSync(join(out, "src.geml"), "utf8");
  assert.match(d, /\{#caller /, "caller emitted");
  assert.ok(d.split("\n").length > 200000, "all 200k call rows made it through the merge");
  rmSync(dir, { recursive: true, force: true });
});

test("build.mjs source: no argument-spread push over adapter arrays (pattern lock)", () => {
  const src = readFileSync(join(PKG, "codemap", "build.mjs"), "utf8");
  assert.doesNotMatch(src, /\.push\(\.\.\./, "spread-push re-introduction would crash at scale");
});

async function atest(name, fn) { await fn(); passed++; console.log("ok", name); }

test("render-all.mjs: batch render (shared parse cache) produces every page", () => {
  const { out, dir } = runEmit([fn("alpha", "t:a#alpha"), fileSym()]);
  const outText = runTool(join(PKG, "codemap", "render-all.mjs"), out);
  assert.match(outText, /rendered \d+ page/, "batch completion reported");
  const html = readFileSync(join(out, "src.html"), "utf8");
  assert.match(html, /alpha/, "container page rendered");
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /Code map/, "index page rendered");
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
    const first = await (await fetch(url)).text();
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
    // rebuild simulation: rewrite the .geml (mtime AND size change)
    const p = join(out, "src.geml");
    writeFileSync(p, readFileSync(p, "utf8").replace(/alphaOne/g, "alphaTwoX"));
    const after = await (await fetch(url)).text();
    assert.match(after, /alphaTwoX/, "rewritten document served fresh — the cache validated against mtime+size");
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200)); // let the process release the dir on Windows
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} test(s) passed.`);
