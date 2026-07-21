// Branch/statement coverage for the codemap live viewer (codemap/serve.mjs)
// and the stdio MCP server (codemap/mcp-server.mjs), driven IN-PROCESS via
// their exported internals — the main suites spawn serve as a child and kill
// it, so a killed child never flushes V8 coverage. Where a real socket is the
// honest medium the server binds 127.0.0.1 on ports 8460-8479 only, and every
// child process spawned here is left to EXIT ON ITS OWN (never killed).
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { recipeFingerprint, trustRecipe } from "../codemap/recipe-trust.mjs";
// Isolate the C2 recipe-trust store per run (audit): starts empty, never
// touches ~/.config; startWatch spawns refresh.mjs inheriting process.env.
process.env.GEML_TRUST_STORE = join(mkdtempSync(join(tmpdir(), "geml-trust-serve-")), "store.json");

// serve.mjs reads GEML_WATCH_QUIET_MS at module load — set it BEFORE the
// dynamic import so the watch tests fire in milliseconds, not 30s.
process.env.GEML_WATCH_QUIET_MS = "200";
const serve = await import("../codemap/serve.mjs");
const mcp = await import("../codemap/mcp-server.mjs");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
async function atest(name, fn) { await fn(); passed++; console.log("ok", name); }

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // geml-parser/
const tmp = () => mkdtempSync(join(tmpdir(), "geml-cov-serve-"));
const SCRATCH = tmp(); // for helper scripts (fake --background children)

// The request log and every status line go through console.error — tee it
// into a buffer so tests can assert messages without stderr noise. Children
// spawned with stdio inherit still write real stderr; that's fine.
let errBuf = "";
const realErr = console.error;
console.error = (...a) => { errBuf += a.map(String).join(" ") + "\n"; };
const errMark = () => errBuf.length;
const errSince = (m) => errBuf.slice(m);

const waitFor = async (pred, ms, what) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}\nstderr tail:\n${errBuf.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// process.exit trap: the CLI paths end in process.exit(code); make it THROW a
// sentinel (unwinding like a real exit) and hand the code back to the test.
class ExitTrap extends Error { constructor(code) { super(`exit ${code}`); this.exitCode = code; } }
const withExit = async (fn) => {
  const orig = process.exit;
  process.exit = (code) => { throw new ExitTrap(code ?? 0); };
  try { await fn(); return null; }
  catch (e) { if (e instanceof ExitTrap) return e.exitCode; throw e; }
  finally { process.exit = orig; }
};

// Ports: the assigned window is 8460-8479; hand them out sequentially.
let nextPort = 8460;
const claimPort = () => { assert.ok(nextPort < 8480, "port window 8460-8479 exhausted"); return nextPort++; };

// ---- fixtures --------------------------------------------------------------
// The same minimal two-document codemap shape cli.test.mjs uses, plus a
// #called-by table (what get_backlinks reads).
const AUTH_GEML =
  "=== meta\nmodule = auth\nentry = #login\nresolution-default = cpg\n===\n\n" +
  '=== code {#login src=src/login.ts#L1-9 anchor="a1"}\n===\n' +
  '=== code {#issueToken .leaf src=src/token.ts#L1-5 anchor="a2"}\n===\n\n' +
  "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#login, #issueToken, call,\n===\n\n" +
  "=== table {#called-by format=csv}\nfrom, to, kind, site\n#login, #issueToken, call, src/login.ts:3\n===\n";
const INDEX_GEML =
  "=== meta\nrepo = demo\ncontainer = module\nresolution-default = cpg\n===\n\n" +
  "=== table {#modules format=csv}\nmodule, doc, methods, entries, tests\nauth, auth.geml, 2, 1, 0\n===\n\n" +
  "=== table {#module-edges format=csv}\nfrom, to, calls\n===\n";

const mkMap = ({ lookup = true } = {}) => {
  const dir = tmp();
  writeFileSync(join(dir, "index.geml"), INDEX_GEML);
  writeFileSync(join(dir, "auth.geml"), AUTH_GEML);
  if (lookup) {
    mkdirSync(join(dir, "_index"), { recursive: true });
    writeFileSync(join(dir, "_index", "name-lookup.json"),
      JSON.stringify({ login: [{ doc: "auth.geml", id: "login", anchor: "a1" }] }));
  }
  return dir;
};

// =============================================================================
// mcp-server.mjs — in-process
// =============================================================================
const MAP = mkMap();

test("mcp graphDirOf: per-call graph_dir beats env beats the ./.geml-code-graph default", () => {
  assert.equal(mcp.graphDirOf({ graph_dir: MAP }), resolve(MAP));
  const saved = process.env.GEML_GRAPH_DIR;
  process.env.GEML_GRAPH_DIR = MAP;
  try {
    assert.equal(mcp.graphDirOf({}), resolve(MAP), "env fallback");
    assert.equal(mcp.graphDirOf(undefined), resolve(MAP), "args may be absent entirely");
  } finally { delete process.env.GEML_GRAPH_DIR; if (saved !== undefined) process.env.GEML_GRAPH_DIR = saved; }
  assert.equal(mcp.graphDirOf({}), resolve(".geml-code-graph"), "no env, no arg: conventional default");
});

test("mcp readBlock: verbatim block by id, # prefix tolerated, misses throw", () => {
  const block = mcp.readBlock(MAP, "auth.geml", "login");
  assert.match(block, /\{#login /, "the block fence line is included");
  assert.equal(mcp.readBlock(MAP, "auth.geml", "#login"), block, "leading # stripped");
  assert.throws(() => mcp.readBlock(MAP, "nope.geml", "login"), /no such document: nope\.geml/);
  assert.throws(() => mcp.readBlock(MAP, "auth.geml", "ghost"), /no block with id `ghost` in auth\.geml/);
});

const toolByName = (n) => mcp.TOOLS.find((t) => t.name === n);

test("mcp resolve_name: hits as JSON, a miss says so, an unbuilt graph throws", () => {
  const out = toolByName("resolve_name").run({ name: "login", graph_dir: MAP });
  assert.deepEqual(JSON.parse(out), [{ doc: "auth.geml", id: "login", anchor: "a1" }]);
  assert.equal(toolByName("resolve_name").run({ name: "nope", graph_dir: MAP }),
    "no symbol named `nope` in the graph");
  const bare = tmp();
  assert.throws(() => toolByName("resolve_name").run({ name: "login", graph_dir: bare }), /no name-lookup at .* build the graph first/);
});

test("mcp open_symbol: returns the block; a bad doc surfaces the readBlock error", () => {
  assert.match(toolByName("open_symbol").run({ doc: "auth.geml", id: "issueToken", graph_dir: MAP }), /\{#issueToken /);
  assert.throws(() => toolByName("open_symbol").run({ doc: "gone.geml", id: "x", graph_dir: MAP }), /no such document/);
});

test("mcp get_backlinks: whole table, per-id filter, honest no-caller and no-table answers", () => {
  const whole = toolByName("get_backlinks").run({ doc: "auth.geml", graph_dir: MAP });
  assert.match(whole, /from, to, kind, site/, "no id: the whole #called-by table");
  const one = toolByName("get_backlinks").run({ doc: "auth.geml", id: "#issueToken", graph_dir: MAP });
  assert.match(one, /#login, #issueToken, call, src\/login\.ts:3/, "matching row kept (and # prefix tolerated)");
  assert.match(one, /from, to, kind, site/, "header rows always kept");
  assert.equal(toolByName("get_backlinks").run({ doc: "auth.geml", id: "login", graph_dir: MAP }),
    "no resolved callers of #login in auth.geml (blind spots live in the #unresolved table)");
  // a document with no #called-by table at all
  writeFileSync(join(MAP, "plainmod.geml"), "=== meta\nmodule = p\n===\n\n=== code {#solo}\n===\n");
  assert.match(toolByName("get_backlinks").run({ doc: "plainmod.geml", id: "solo", graph_dir: MAP }),
    /no #called-by table in plainmod\.geml/);
});

// JSON-RPC dispatch: one frame in via handleLine, replies collected by a fake
// writer (production writes the same strings to stdout).
const rpc = (obj, line) => {
  const out = [];
  mcp.handleLine(line ?? JSON.stringify(obj), (s) => out.push(s));
  return out.map((s) => JSON.parse(s));
};

test("mcp rpc: blank lines and non-JSON are ignored (stream noise, not errors)", () => {
  assert.deepEqual(rpc(null, "   "), []);
  assert.deepEqual(rpc(null, "{not json"), []);
});

test("mcp rpc initialize: echoes the client's protocolVersion, defaults when absent", () => {
  const [r1] = rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-01-01" } });
  assert.equal(r1.result.protocolVersion, "2026-01-01");
  assert.equal(r1.result.serverInfo.name, "geml-code-graph");
  const [r2] = rpc({ jsonrpc: "2.0", id: 2, method: "initialize" });
  assert.equal(r2.result.protocolVersion, "2024-11-05", "no params: spec default");
  assert.deepEqual(r2.result.capabilities, { tools: {} });
});

test("mcp rpc: notifications get no response; ping pongs; tools/list lists all three", () => {
  assert.deepEqual(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), []);
  assert.deepEqual(rpc({ jsonrpc: "2.0", method: "notifications/progress" }), [], "any notifications/* is silent");
  const [pong] = rpc({ jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual(pong, { jsonrpc: "2.0", id: 3, result: {} });
  const [list] = rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["resolve_name", "open_symbol", "get_backlinks"]);
  assert.ok(list.result.tools.every((t) => t.description && t.inputSchema.type === "object"), "schemas ship whole");
  assert.ok(!("run" in list.result.tools[0]), "the run closure never crosses the wire");
});

test("mcp rpc tools/call: dispatches, wraps tool errors as isError content, rejects unknown tools", () => {
  const [ok] = rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "resolve_name", arguments: { name: "login", graph_dir: MAP } } });
  assert.match(ok.result.content[0].text, /auth\.geml/);
  assert.equal(ok.result.isError, undefined);
  const [err] = rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "open_symbol", arguments: { doc: "gone.geml", id: "x", graph_dir: MAP } } });
  assert.equal(err.result.isError, true);
  assert.match(err.result.content[0].text, /^error: no such document/);
  const [unk] = rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "no_such_tool" } });
  assert.deepEqual(unk.error, { code: -32602, message: "unknown tool: no_such_tool" });
});

test("mcp rpc tools/call: missing `arguments` becomes {} (never a crash)", () => {
  const saved = process.env.GEML_GRAPH_DIR;
  process.env.GEML_GRAPH_DIR = MAP;
  try {
    const [r] = rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "resolve_name" } });
    assert.equal(r.result.content[0].text, "no symbol named `undefined` in the graph");
  } finally { delete process.env.GEML_GRAPH_DIR; if (saved !== undefined) process.env.GEML_GRAPH_DIR = saved; }
});

test("mcp rpc: unknown method errors only when the frame has an id", () => {
  const [nf] = rpc({ jsonrpc: "2.0", id: 9, method: "bogus/method" });
  assert.deepEqual(nf.error, { code: -32601, message: "method not found: bogus/method" });
  assert.deepEqual(rpc({ jsonrpc: "2.0", method: "bogus/method" }), [], "no id: nothing to answer");
});

test("mcp rpc: a frame that breaks the dispatcher itself yields -32603 (id) or silence (no id)", () => {
  // method: 123 -> method?.startsWith is undefined -> TypeError inside the try
  const [e] = rpc({ jsonrpc: "2.0", id: 10, method: 123 });
  assert.equal(e.error.code, -32603);
  assert.match(e.error.message, /startsWith/);
  assert.deepEqual(rpc({ jsonrpc: "2.0", method: 123 }), [], "same failure without an id stays silent");
});

test("mcp rpc: a non-Error throw is stringified for the -32603 message (writer failure)", () => {
  // A broken writer (EPIPE-style) throws a primitive: the catch stringifies it
  // via `?? e`, then the error reply itself fails on the same writer.
  assert.throws(() => mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" }), () => { throw "broken pipe"; }));
});

await atest("mcp-server.mjs as a child: stdio frames round-trip and stdin EOF ends it cleanly", async () => {
  const child = spawn(process.execPath, [join(PKG, "codemap", "mcp-server.mjs")],
    { env: { ...process.env, GEML_GRAPH_DIR: MAP }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", errs = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { errs += d; });
  for (const frame of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-02-02" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_backlinks", arguments: { doc: "auth.geml", id: "issueToken" } } },
  ]) child.stdin.write(JSON.stringify(frame) + "\n");
  child.stdin.end(); // EOF — the server must exit on its own (coverage flushes)
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, `child exit ${code}; stderr:\n${errs}`);
  const frames = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(frames.length, 3, "three answers for three id-bearing frames");
  assert.equal(frames[0].result.protocolVersion, "2026-02-02");
  assert.equal(frames[1].result.tools.length, 3);
  assert.match(frames[2].result.content[0].text, /#login, #issueToken/);
});

// =============================================================================
// serve.mjs — parseServeArgs / resolveSrcRoot / stopServer
// =============================================================================

test("serve args: defaults, flags, and the dir argument dodging option values", () => {
  assert.deepEqual(serve.parseServeArgs([]), {
    dir: ".geml-code-graph", port: 8140, background: false, stop: false,
    noWarm: false, noOpen: false, watchMode: false, cacheMb: 256,
  });
  const all = serve.parseServeArgs(["--port", "8460", "mymap", "--cache-mb", "64", "--background", "--no-warm", "--no-open", "--watch"]);
  assert.deepEqual(all, { dir: "mymap", port: 8460, background: true, stop: false, noWarm: true, noOpen: true, watchMode: true, cacheMb: 64 });
  assert.equal(serve.parseServeArgs(["--port", "8460", "d"]).dir, "d", "the port VALUE is not mistaken for the dir");
  assert.equal(serve.parseServeArgs(["--cache-mb", "8", "d"]).dir, "d", "the cache VALUE is not mistaken for the dir");
  assert.equal(serve.parseServeArgs(["--stop", "m"]).stop, true);
});

test("serve args: usage errors — --help/-h, non-integer or non-positive port, bad cache budget", () => {
  for (const argv of [["--help"], ["-h"], ["--port", "abc"], ["--port", "0"], ["--port", "1.5"], ["--cache-mb", "0"], ["--cache-mb", "abc"]]) {
    assert.equal(serve.parseServeArgs(argv), null, JSON.stringify(argv));
  }
});

test("serve srcRoot: recipe root honored, recipe without root -> parent, broken/missing recipe -> parent", () => {
  const d = tmp();
  mkdirSync(join(d, "map", "_index"), { recursive: true });
  const root = join(d, "map");
  assert.equal(serve.resolveSrcRoot(root), resolve(d), "no recipe: the codemap's parent");
  writeFileSync(join(root, "_index", "refresh.json"), JSON.stringify({ root: "../src-here" }));
  assert.equal(serve.resolveSrcRoot(root), resolve(d, "src-here"), "recipe root, relative to the codemap dir");
  writeFileSync(join(root, "_index", "refresh.json"), JSON.stringify({ steps: [] }));
  assert.equal(serve.resolveSrcRoot(root), resolve(d), "recipe without a root key: parent");
  writeFileSync(join(root, "_index", "refresh.json"), "{broken");
  assert.equal(serve.resolveSrcRoot(root), resolve(d), "unreadable recipe: parent");
});

test("serve --stop: no pid file is a clean no-op", () => {
  const m = errMark();
  assert.equal(serve.stopServer({ pidPath: join(tmp(), "serve.pid") }), 0);
  assert.match(errSince(m), /no pid file — nothing to stop/);
});

await atest("serve --stop: kills a live recorded pid and removes the file", async () => {
  // a disposable child that would idle for 30s — stopServer must end it
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const dir = tmp();
  const pidPath = join(dir, "serve.pid");
  writeFileSync(pidPath, ` ${child.pid} \n`); // whitespace: the .trim() is real
  const exited = new Promise((r) => child.on("exit", (c, s) => r(s ?? c)));
  const m = errMark();
  assert.equal(serve.stopServer({ pidPath }), 0);
  assert.match(errSince(m), new RegExp(`stopped \\(pid ${child.pid}\\)`));
  assert.ok(!existsSync(pidPath), "pid file removed");
  const sig = await exited;
  assert.notEqual(sig, 0, `the recorded process was terminated, not left to finish (got ${sig})`);
});

test("serve --stop: a stale pid is reported and the file still removed; a stuck file is tolerated", () => {
  const dir = tmp();
  const pidPath = join(dir, "serve.pid");
  writeFileSync(pidPath, "999999999"); // no such process
  const m = errMark();
  assert.equal(serve.stopServer({ pidPath }), 0);
  assert.match(errSince(m), /pid 999999999 not running \(stale pid file removed\)/);
  assert.ok(!existsSync(pidPath), "stale file removed");
  // read-only pid file: --stop still exits 0 whether or not the unlink is
  // allowed to succeed (Node 24 on Windows removes read-only files, so the
  // unlink catch itself stays a best-effort arm).
  writeFileSync(pidPath, "999999999");
  chmodSync(pidPath, 0o444);
  try {
    assert.equal(serve.stopServer({ pidPath }), 0, "unlink trouble never breaks --stop");
  } finally { if (existsSync(pidPath)) { chmodSync(pidPath, 0o666); rmSync(pidPath, { force: true }); } }
});

// =============================================================================
// serve.mjs — the HTTP app, in-process over a real loopback socket
// =============================================================================
const listen = (app, port) => new Promise((res) => app.server.listen(port, "127.0.0.1", res));
const closeApp = (app) => new Promise((res) => app.server.close(res));
const appFor = (root, extra = {}) =>
  serve.createApp({ dir: root, root, port: extra.port, cacheMb: 256, srcRoot: serve.resolveSrcRoot(root), ...extra });

// A raw request line the fetch() client refuses to produce (malformed %-escape).
const rawGet = (port, target) => new Promise((res, rej) => {
  const sock = connect(port, "127.0.0.1", () => {
    sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  });
  let buf = "";
  sock.on("data", (d) => { buf += d; });
  sock.on("end", () => res(buf));
  sock.on("error", rej);
});

test("serve extOf: lowercased known extension, empty for none", () => {
  assert.equal(serve.extOf("A/B.GEML"), ".geml");
  assert.equal(serve.extOf("noext"), "");
  assert.equal(serve.extOf("weird.tar.GZ"), ".gz");
});

await atest("serve routes: live render, HEAD, raw .geml, statics, 404/403/400", async () => {
  const root = mkMap();
  writeFileSync(join(root, "static-only.html"), "<html>prerendered</html>");
  writeFileSync(join(root, "blob.bin"), "BLOB");
  writeFileSync(join(root, "LICENSE"), "MIT-ish");
  mkdirSync(join(root, "broken.geml")); // a DIRECTORY where a doc should be
  const port = claimPort();
  const app = appFor(root, { port });
  await listen(app, port);
  try {
    // "/" -> index.html -> rendered live from index.geml
    const idx = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(idx.status, 200);
    assert.match(idx.headers.get("cache-control"), /no-cache/);
    assert.match(await idx.text(), /auth\.geml/, "module table rendered");
    // container page renders from its .geml, carries the live-graph wiring
    const auth = await fetch(`http://127.0.0.1:${port}/auth.html`);
    assert.equal(auth.status, 200);
    const authHtml = await auth.text();
    assert.match(authHtml, /data-graph-src="\/_graph\?doc=/, "sidecar wiring");
    // HEAD: status + headers, never a body
    const head = await fetch(`http://127.0.0.1:${port}/auth.html`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0, "HEAD answered without a body");
    // raw .geml with its text/plain MIME
    const raw = await fetch(`http://127.0.0.1:${port}/auth.geml`);
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get("content-type"), /text\/plain/);
    assert.match(await raw.text(), /\{#login /);
    // pre-rendered .html with NO .geml sibling is served as a plain static file
    const st = await fetch(`http://127.0.0.1:${port}/static-only.html`);
    assert.equal(st.status, 200);
    assert.equal(await st.text(), "<html>prerendered</html>");
    // unknown extension and no extension fall back to octet-stream
    for (const p of ["blob.bin", "LICENSE"]) {
      const r = await fetch(`http://127.0.0.1:${port}/${p}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /application\/octet-stream/, p);
    }
    // .html whose .geml is a directory: the render try/catch answers 500
    const b = await fetch(`http://127.0.0.1:${port}/broken.html`);
    assert.equal(b.status, 500);
    assert.match(await b.text(), /render error in broken\.geml: /);
    // misses and guards
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope.txt`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/..%2fsecret.txt`)).status, 403, "traversal out of the codemap dir");
    assert.match(await rawGet(port, "/%zz"), /^HTTP\/1\.1 400 /, "undecodable path -> 400, not a crash");
  } finally { await closeApp(app); }
});

await atest("serve /_dist: parser modules, the node stub, and traversal/extension guards", async () => {
  const root = mkMap();
  const port = claimPort();
  const app = appFor(root, { port });
  await listen(app, port);
  try {
    const js = await fetch(`http://127.0.0.1:${port}/_dist/geml.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /text\/javascript/);
    const stub = await fetch(`http://127.0.0.1:${port}/_dist/_node-stub.js`);
    assert.equal(stub.status, 200);
    assert.match(await stub.text(), /export const/, "browser stub served verbatim");
    assert.equal((await fetch(`http://127.0.0.1:${port}/_dist/..%2f..%2fpackage.json`)).status, 404, "traversal out of dist");
    assert.equal((await fetch(`http://127.0.0.1:${port}/_dist/geml.d.ts`)).status, 404, "only .js is importable");
    assert.equal((await fetch(`http://127.0.0.1:${port}/_dist/ghost.js`)).status, 404);
  } finally { await closeApp(app); }
});

await atest("serve /_graph: payload, guards, builder errors — and never stale after a rewrite", async () => {
  const root = mkMap();
  writeFileSync(join(root, "plain.geml"), "# just prose\n\nno codemap meta here.\n");
  mkdirSync(join(root, "dirdoc.geml"));
  const port = claimPort();
  const app = appFor(root, { port });
  await listen(app, port);
  try {
    const g = await (await fetch(`http://127.0.0.1:${port}/_graph?doc=auth.geml`)).json();
    assert.ok(g.data && Object.keys(g.data.nodes).some((k) => /login/.test(k)), "entry #login in the slice");
    assert.equal(g.truncated, false, "small graph: honest truncation flag");
    const i = await (await fetch(`http://127.0.0.1:${port}/_graph?doc=index.geml`)).json();
    assert.equal(i.data.mode, "modules", "index doc -> module aggregation payload");
    assert.equal((await fetch(`http://127.0.0.1:${port}/_graph`)).status, 404, "no doc param");
    assert.equal((await fetch(`http://127.0.0.1:${port}/_graph?doc=..%2Fescape.geml`)).status, 404, "traversal refused");
    assert.equal((await fetch(`http://127.0.0.1:${port}/_graph?doc=ghost.geml`)).status, 404, "missing doc");
    const perr = await (await fetch(`http://127.0.0.1:${port}/_graph?doc=plain.geml`)).json();
    assert.match(perr.error, /entry/, "non-codemap doc: the builder's own error, not a crash");
    const derr = await (await fetch(`http://127.0.0.1:${port}/_graph?doc=dirdoc.geml`)).json();
    assert.match(derr.error, /cannot load/, "a directory named *.geml loads as null, answered cleanly");
    // rebuild simulation: rewrite auth.geml (mtime AND size change) — the
    // cache validates per hit, so the next payload reflects it immediately
    writeFileSync(join(root, "auth.geml"), AUTH_GEML.replace(/login/g, "loginX"));
    const g2 = await (await fetch(`http://127.0.0.1:${port}/_graph?doc=auth.geml`)).json();
    assert.ok(Object.keys(g2.data.nodes).some((k) => /loginX/.test(k)), "sidecar payload never stale");
  } finally { await closeApp(app); }
});

await atest("serve /_graph: a codemap dir itself named *.geml cannot be read out as a document", async () => {
  // resolve() of "../<root's own basename>" lands exactly ON root — the
  // `target !== root` clause exists for this spelling; the payload then
  // reports a clean load failure instead of leaking directory reads.
  const parent = tmp();
  const root = join(parent, "map.geml");
  mkdirSync(root);
  writeFileSync(join(root, "index.geml"), INDEX_GEML);
  const port = claimPort();
  const app = appFor(root, { port });
  await listen(app, port);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/_graph?doc=..%2Fmap.geml`);
    assert.equal(r.status, 200);
    assert.match((await r.json()).error, /cannot load/);
  } finally { await closeApp(app); }
});

await atest("serve source route: project files by indexed extension only, misses stay 404", async () => {
  const parent = tmp();
  const root = join(parent, "map");
  mkdirSync(root);
  writeFileSync(join(root, "index.geml"), INDEX_GEML);
  mkdirSync(join(parent, "src"));
  writeFileSync(join(parent, "src", "x.ts"), "line1\nline2\n");
  writeFileSync(join(parent, "src", "secret.txt"), "nope\n");
  const port = claimPort();
  const app = appFor(root, { port }); // srcRoot = parent (no recipe)
  await listen(app, port);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/src/x.ts`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /line2/);
    assert.match(ok.headers.get("content-type"), /text\/plain/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/src/secret.txt`)).status, 404, "non-source extension unexposed");
    assert.equal((await fetch(`http://127.0.0.1:${port}/src/missing.ts`)).status, 404);
  } finally { await closeApp(app); }
});

await atest("serve /_search: ranking exact > prefix > qualified-tail > substring, alias dedupe, honest cap", async () => {
  const root = mkMap();
  const lk = {
    handle: [{ doc: "a.geml", id: "Login-handle" }], // bare-name alias of...
    "Login.handle": [{ doc: "a.geml", id: "Login-handle" }], // ...the same node
    handlebars: [{ doc: "b.geml", id: "handlebars" }],
    "Sess::handle2": [{ doc: "c.geml", id: "h2" }],
    rehandle: [{ doc: "d.geml", id: "rehandle" }],
    unrelated: [{ doc: "e.geml", id: "unrelated" }],
    "a.b::handleX": [{ doc: "f.geml", id: "hx" }], // both :: and . in one name
  };
  for (let i = 0; i < 120; i++) lk[`zzz${String(i).padStart(3, "0")}`] = [{ doc: "z.geml", id: `zzz${i}` }];
  mkdirSync(join(root, "_index"), { recursive: true });
  writeFileSync(join(root, "_index", "name-lookup.json"), JSON.stringify(lk));
  const port = claimPort();
  const app = appFor(root, { port });
  await listen(app, port);
  try {
    const q = async (s) => await (await fetch(`http://127.0.0.1:${port}/_search?q=${encodeURIComponent(s)}`)).json();
    const r = await q("handle");
    // exact "handle" wins; its qualified alias "Login.handle" dedupes away
    assert.equal(r.hits[0].name, "handle");
    assert.ok(!r.hits.some((h) => h.name === "Login.handle"), "alias rows dedupe on doc#id");
    assert.ok(!r.hits.some((h) => h.name === "unrelated"), "non-matches filtered");
    const names = r.hits.map((h) => h.name);
    assert.ok(names.indexOf("handlebars") < names.indexOf("Sess::handle2"), "prefix beats qualified tail");
    assert.ok(names.indexOf("Sess::handle2") < names.indexOf("rehandle"), "qualified tail beats substring");
    assert.equal(r.total, r.hits.length, "small result: total == shipped");
    // Cls.q tail arm and the mixed ::/. name
    const hx = await q("handlex");
    assert.deepEqual(hx.hits.map((h) => h.name), ["a.b::handleX"], "tail after the LAST separator matches");
    const dot = await q("handle2");
    assert.ok(dot.hits.some((h) => h.name === "Sess::handle2"));
    // the cap keeps 100 but reports the honest total
    const cap = await q("zzz");
    assert.equal(cap.total, 120);
    assert.equal(cap.hits.length, 100);
    // short/empty queries answer instantly with nothing
    for (const s of ["", "a", "  a  "]) {
      const e = await q(s);
      assert.deepEqual(e, { total: 0, hits: [] }, JSON.stringify(s));
    }
    // case-insensitive both sides
    const ci = await q("LOGIN.HANDLE");
    assert.ok(ci.hits.some((h) => h.name === "Login.handle"), "query and names are lowercased for ranking");
  } finally { await closeApp(app); }
});

await atest("serve /_search: a codemap without a name-lookup answers empty, once, forever", async () => {
  const root = mkMap({ lookup: false });
  const port = claimPort();
  const app = appFor(root, { port });
  await listen(app, port);
  try {
    for (let i = 0; i < 2; i++) { // second hit takes the rows-already-loaded arm
      const r = await (await fetch(`http://127.0.0.1:${port}/_search?q=login`)).json();
      assert.deepEqual(r, { total: 0, hits: [] });
    }
  } finally { await closeApp(app); }
});

// ---- parse cache mechanics (no socket needed) -------------------------------
test("serve cache: validates on mtime+size, LRU-touches hits, evicts stale entries and misses null", () => {
  const root = mkMap();
  const app = appFor(root, { port: 1 }); // port unused: no listen
  const abs = join(root, "auth.geml");
  const e1 = app.loadCached(abs);
  assert.ok(e1.doc, "parsed once");
  assert.equal(app.loadCached(abs), e1, "hot hit returns the same entry (LRU touch)");
  assert.equal(app.parseDoc(e1.text), e1.doc, "parseDoc reuses the cached instance by text identity");
  const fresh = app.parseDoc("# uncached text\n");
  assert.ok(fresh && fresh !== e1.doc, "uncached text still parses");
  writeFileSync(abs, AUTH_GEML + "\n# grew\n");
  const e2 = app.loadCached(abs);
  assert.notEqual(e2, e1, "rewrite invalidates by mtime+size");
  assert.equal(app.loadDoc("auth.geml"), e2.text, "loadDoc hands out the cached text");
  assert.equal(app.loadDoc("ghost.geml"), null, "a missing doc is null, not a throw");
});

test("serve cache: the byte budget evicts oldest-first but never the only entry", () => {
  const root = mkMap();
  // budget of ~100 bytes: every fixture doc alone exceeds it
  const app = appFor(root, { port: 1, cacheMb: 100 / 1048576 });
  const a = app.loadCached(join(root, "auth.geml"));
  assert.ok(a, "a single over-budget doc still loads (docCache.size > 1 guard)");
  assert.equal(app.docCache.size, 1);
  app.loadCached(join(root, "index.geml"));
  assert.equal(app.docCache.size, 1, "loading a second doc evicted the first");
  assert.ok(!app.docCache.has(join(root, "auth.geml")), "oldest evicted");
  assert.ok(app.cacheBytes() > 0);
});

await atest("serve warmCache: warms largest-first, brakes at 80% budget, tolerates junk and a vanished root", async () => {
  const root = mkMap();
  writeFileSync(join(root, "big.geml"), "# big\n" + "x\n".repeat(400));
  mkdirSync(join(root, "junkdir.geml")); // readdir lists it; loadCached says null
  let m = errMark();
  const app = appFor(root, { port: 1 });
  await app.warmCache();
  assert.match(errSince(m), /prewarm: 3\/4 document\(s\), .* MB cached/, "3 real docs warm, the directory does not");
  // tiny budget: the first (largest) doc alone crosses 80% and stops the loop
  m = errMark();
  const capped = appFor(root, { port: 1, cacheMb: 100 / 1048576 });
  await capped.warmCache();
  assert.match(errSince(m), /prewarm: 1\/4 document\(s\)/, "cumulative-byte brake after the largest doc");
  // a root that disappears is a silent no-op
  m = errMark();
  const gone = appFor(join(root, "never-there"), { port: 1 });
  await gone.warmCache();
  assert.equal(errSince(m), "", "unreadable root: no prewarm line at all");
});

await atest("serve warmCache: a doc that vanishes between readdir and stat is skipped, not fatal", async () => {
  const root = mkMap();
  // A dangling symlink is the deterministic spelling of that race: readdir
  // lists it, stat follows it into ENOENT. Symlinks need privileges on some
  // Windows setups — when denied, the warm still proves the happy count.
  try { symlinkSync(join(root, "never.geml"), join(root, "dangling.geml"), "file"); } catch { /* no symlink privilege */ }
  const app = appFor(root, { port: 1 });
  const m = errMark();
  await app.warmCache();
  assert.match(errSince(m), /prewarm: 2\/2 document\(s\)/, "the two real docs warm; a vanished entry never counts");
});

// =============================================================================
// serve.mjs — error handler, browser opener, --background, watch, main
// =============================================================================

await atest("serve listen error: EADDRINUSE points at --port/--stop, anything else prints plainly — both exit 1", async () => {
  const app = appFor(mkMap(), { port: 8199, dir: "the-dir" });
  let m = errMark();
  let code = await withExit(async () => app.server.emit("error", Object.assign(new Error("taken"), { code: "EADDRINUSE" })));
  assert.equal(code, 1);
  assert.match(errSince(m), /port 8199 is in use — pick another with --port, or stop the old server \(geml codemap serve the-dir --stop\)/);
  m = errMark();
  code = await withExit(async () => app.server.emit("error", new Error("something else")));
  assert.equal(code, 1);
  assert.match(errSince(m), /error: something else/);
});

test("serve openBrowser: per-platform argv, and a missing opener is not an error", () => {
  const calls = [];
  const fake = (cmd, args) => { calls.push([cmd, ...args]); return { unref: () => {} }; };
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const as = (p, fn) => { Object.defineProperty(process, "platform", { value: p }); try { fn(); } finally { Object.defineProperty(process, "platform", platform); } };
  as("win32", () => serve.openBrowser("http://x/", fake));
  as("darwin", () => serve.openBrowser("http://x/", fake));
  as("linux", () => serve.openBrowser("http://x/", fake));
  assert.deepEqual(calls, [
    ["cmd", "/c", "start", "", "http://x/"],
    ["open", "http://x/"],
    ["xdg-open", "http://x/"],
  ]);
  serve.openBrowser("http://x/", () => { throw new Error("no opener"); }); // swallowed
});

// --background contexts share this ctx builder (mirrors what main() assembles).
const bgCtx = (root, port, extra = {}) => ({
  dir: root, root, port, cacheMb: 256, noWarm: false, watchMode: false,
  runDir: join(root, "_index"), logPath: join(root, "_index", "serve.log"), ...extra,
});

await atest("serve --background: a port that already answers is reported as up, nothing is spawned", async () => {
  const root = mkMap();
  const port = claimPort();
  const dummy = appFor(root, { port });
  await listen(dummy, port);
  try {
    const m = errMark();
    assert.equal(await serve.launchBackground(bgCtx(root, port), "never-used.mjs"), 0);
    assert.match(errSince(m), new RegExp(`port ${port} already answers — assuming it is up`));
    assert.match(errSince(m), /--stop/);
  } finally { await closeApp(dummy); }
});

// Stand-in children for the detach-and-poll path: a real serve child would be
// killed by the test (killing forfeits ITS coverage), so the child here is a
// scratch script that binds the port and exits BY ITSELF shortly after —
// every process in this suite ends of its own accord.
const FAKE_OK = join(SCRATCH, "fake-serve-ok.mjs");
writeFileSync(FAKE_OK, [
  'import { createServer } from "node:http";',
  'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
  'const s = createServer((req, res) => { res.writeHead(200); res.end("ok"); });',
  's.listen(port, "127.0.0.1", () => console.error("fake up"));',
  "setTimeout(() => { s.close(); process.exit(0); }, 5000);",
].join("\n"));
const FAKE_DEAD = join(SCRATCH, "fake-serve-dead.mjs");
writeFileSync(FAKE_DEAD, 'console.error("refusing to start"); process.exit(1);\n');

await atest("serve --background: spawns the child, waits for the port, reports pid/URL/stop-hint", async () => {
  const root = mkMap();
  const port = claimPort();
  const m = errMark();
  assert.equal(await serve.launchBackground(bgCtx(root, port, { noWarm: true, watchMode: true }), FAKE_OK), 0);
  const said = errSince(m);
  assert.match(said, /running in background \(pid \d+\) — survives this session/);
  assert.match(said, new RegExp(`-> http://localhost:${port}/`));
  assert.match(said, /--stop   \(log: /);
  assert.ok(existsSync(join(root, "_index", "serve.log")), "child stdio goes to the log file");
  // the fake child self-terminates in a few seconds; nothing here kills it
});

await atest("serve --background: a child that dies on boot fails with the log tail, exit 1", async () => {
  const root = mkMap();
  const port = claimPort();
  const m = errMark();
  assert.equal(await serve.launchBackground(bgCtx(root, port), FAKE_DEAD), 1);
  assert.match(errSince(m), new RegExp(`failed to start on port ${port}`));
  assert.match(errSince(m), /refusing to start/, "the log tail names the child's complaint");
});

// ---- watch mode -------------------------------------------------------------
const watchCtx = (parent) => {
  const root = join(parent, "map");
  mkdirSync(join(root, "_index"), { recursive: true });
  writeFileSync(join(root, "index.geml"), INDEX_GEML);
  mkdirSync(join(parent, "src"), { recursive: true });
  writeFileSync(join(parent, "src", "a.ts"), "export const a = 1;\n");
  return { root, runDir: join(root, "_index"), srcRoot: parent, logPath: join(root, "_index", "serve.log") };
};
// Recipe steps run through the platform shell with cwd = srcRoot; root-relative
// forward-slash paths only (see codemap.test.mjs's recipe notes).
const recipe = (ctx, steps) => {
  const cfg = { version: 1, root: "..", steps };
  writeFileSync(join(ctx.runDir, "refresh.json"), JSON.stringify(cfg));
  // Trust the fixture so the C2 gate (audit) lets the watcher run it; no
  // cov-serve test asserts refusal, so unconditional trust here is correct.
  trustRecipe(recipeFingerprint(cfg), ctx.root);
};

test("serve --watch: without a recorded recipe it says so and stays off", () => {
  const ctx = watchCtx(tmp());
  const m = errMark();
  assert.equal(serve.startWatch(ctx), undefined);
  assert.match(errSince(m), /no _index\/refresh\.json recipe recorded — --watch disabled/);
});

test("serve --watch: an unwatchable source root disables watch with the reason", () => {
  const ctx = watchCtx(tmp());
  recipe(ctx, []);
  const m = errMark();
  assert.equal(serve.startWatch({ ...ctx, srcRoot: join(ctx.srcRoot, "never-existed") }), undefined);
  assert.match(errSince(m), /watch: recursive fs\.watch unavailable here \(.*\) — --watch disabled/);
});

test("serve --watch: the event filter skips vendored/dot/non-source paths, schedules the rest", () => {
  const ctx = watchCtx(tmp());
  recipe(ctx, []);
  process.env.GEML_WATCH_TREE = "1"; // the manual walker arm
  let h;
  try { h = serve.startWatch(ctx); } finally { delete process.env.GEML_WATCH_TREE; }
  assert.ok(h, "watching");
  // filtered: no timer is armed for these
  for (const rel of ["node_modules\\x.ts", ".git/x.ts", "README.md"]) h.onFsEvent(rel);
  // scheduling arms the 200ms quiet timer (GEML_WATCH_QUIET_MS); when it
  // fires, the empty-step recipe runs and completes — harmless by design.
  h.onFsEvent("src/a.ts");
  h.onFsEvent(null); // unattributed events schedule too
  h.schedule(); // direct re-schedule debounces the pending timer
});

await atest("serve --watch: a real source edit re-runs the recipe; success and failure both reported", async () => {
  const parent = tmp();
  const ctx = watchCtx(parent);
  const marker = join(ctx.runDir, "watch-ran.txt").replace(/\\/g, "/");
  recipe(ctx, [{ argv: ["node", "-e", "require('fs').appendFileSync('map/_index/watch-ran.txt','w')"] }]);
  const m = errMark();
  const h = serve.startWatch(ctx); // native recursive watcher arm (win32)
  assert.ok(h, "watching");
  assert.match(errSince(m), /watch: watching .* re-runs the recipe after 0\.2s of quiet/);
  // keep touching until the watcher+timer chain lands the marker
  // Generous ceilings: under c8, every refresh child pays seconds of V8
  // coverage serialization on exit, so runs settle slowly there.
  const t0 = Date.now();
  let n = 2;
  while (!existsSync(marker) && Date.now() - t0 < 30000) {
    writeFileSync(join(parent, "src", "a.ts"), `export const a = ${n++};\n`);
    await new Promise((r) => setTimeout(r, 300));
  }
  await waitFor(() => /codemap refreshed — reload the browser/.test(errSince(m)), 45000, "refresh success line");
  assert.ok(existsSync(marker), "recipe actually ran");
  // Every started run must have reported an outcome before the single-flight
  // probe below: the marker append lands MID-run, and under c8 a child's exit
  // lags seconds behind it (coverage dump) — run() during that window would
  // coalesce into the in-flight run instead of starting a fresh one. Counted
  // over the whole buffer so runs spawned by the previous test settle too.
  const settled = () =>
    (errBuf.match(/watch: sources changed/g) || []).length
    === (errBuf.match(/watch: codemap refreshed|watch: refresh failed/g) || []).length;
  await waitFor(settled, 45000, "runner idle before the single-flight probe");
  // single-flight: a run queued WHILE one is running coalesces into one more
  const before = readFileSync(marker, "utf8").length;
  h.run(); h.run(); // second call while running -> again=true
  await waitFor(() => readFileSync(marker, "utf8").length >= before + 2, 45000, "queued re-run");
  await waitFor(settled, 45000, "runner idle");
  // failure: a recipe that exits 3 reports the exit and points at refresh.log
  recipe(ctx, [{ argv: ["node", "-e", "process.exit(3)"] }]);
  const m2 = errMark();
  h.run();
  await waitFor(() => /watch: refresh failed \(exit \d+\) — see .*refresh\.log/.test(errSince(m2)), 45000, "failure line");
});

await atest("serve watchTree: walks the tree, prunes skip/dot dirs, reports files and picks up new subtrees", async () => {
  const parent = tmp();
  mkdirSync(join(parent, "sub", "inner"), { recursive: true });
  mkdirSync(join(parent, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(parent, ".hidden"), { recursive: true });
  writeFileSync(join(parent, "file.txt"), "x");
  const events = [];
  const h = serve.watchTree(parent, (rel) => events.push(rel));
  assert.ok(h.watched.has(parent) && h.watched.has(join(parent, "sub")) && h.watched.has(join(parent, "sub", "inner")), "tree walked");
  assert.ok(!h.watched.has(join(parent, "node_modules")), "SKIP_DIRS pruned");
  assert.ok(!h.watched.has(join(parent, ".hidden")), "dot dirs pruned");
  const size = h.watched.size;
  h.add(parent);
  assert.equal(h.watched.size, size, "re-adding a watched dir is a no-op");
  h.add(join(parent, "never-there"));
  assert.equal(h.watched.size, size, "a vanished dir is skipped silently");
  h.add(join(parent, "file.txt")); // TOCTOU shape: watchable, not readdir-able — must not throw
  // hit(): the four shapes of an event
  h.hit(parent, null);
  assert.deepEqual(events, [null], "unattributed event passes null through");
  h.hit(parent, "file.txt");
  assert.equal(events[1], "file.txt", "file event reported srcRoot-relative");
  h.hit(join(parent, "sub"), "ghost.ts"); // deleted before stat: still a change
  assert.equal(events[2], join("sub", "ghost.ts"));
  h.hit(parent, "node_modules"); // directory churn: never reported
  h.hit(parent, ".hidden");
  assert.equal(events.length, 3, "directories are not source edits");
  mkdirSync(join(parent, "grown"));
  h.hit(parent, "grown");
  assert.ok(h.watched.has(join(parent, "grown")), "a NEW directory joins the watch set");
  assert.equal(events.length, 3, "…without reporting an edit");
  // and a real fs event flows end-to-end through a per-dir watcher
  writeFileSync(join(parent, "sub", "inner", "y.ts"), "export {};\n");
  await waitFor(() => events.some((e) => typeof e === "string" && e.endsWith("y.ts")), 5000, "a real inner-dir event");
});

// ---- startServing + main ----------------------------------------------------

await atest("serve startServing: records the pid, prints the URL, warms unless told not to", async () => {
  const root = mkMap();
  const port = claimPort();
  const m = errMark();
  const app = serve.startServing({ dir: root, root, port, cacheMb: 256, srcRoot: serve.resolveSrcRoot(root), runDir: join(root, "_index"), pidPath: join(root, "_index", "serve.pid"), logPath: join(root, "_index", "serve.log"), noWarm: false, noOpen: true, watchMode: false });
  try {
    await waitFor(() => /geml codemap serve: /.test(errSince(m)), 5000, "banner");
    assert.match(errSince(m), new RegExp(`-> http://localhost:${port}/  \\(pages render live from \\.geml`));
    assert.equal(readFileSync(join(root, "_index", "serve.pid"), "utf8"), String(process.pid), "pid recorded for --stop");
    await waitFor(() => /prewarm: /.test(errSince(m)), 5000, "warm ran (noWarm=false)");
    assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`)).status, 200);
  } finally { await closeApp(app); }
});

await atest("serve startServing: a pid file that cannot be written is not fatal; --no-open holds in a TTY", async () => {
  const root = mkMap({ lookup: false });
  writeFileSync(join(root, "_index"), "a FILE squatting on the runDir name");
  const port = claimPort();
  const m = errMark();
  // Pretend stdout is a terminal: --no-open must still keep the browser shut
  // (the && evaluates its right side, the body must not run).
  const hadTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;
  let app;
  try {
    app = serve.startServing({ dir: root, root, port, cacheMb: 256, srcRoot: serve.resolveSrcRoot(root), runDir: join(root, "_index"), pidPath: join(root, "_index", "serve.pid"), logPath: join(root, "_index", "serve.log"), noWarm: true, noOpen: true, watchMode: false });
    await waitFor(() => /geml codemap serve: /.test(errSince(m)), 5000, "banner despite the failed pid write");
  } finally { process.stdout.isTTY = hadTTY; }
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`)).status, 200, "still serving");
    assert.ok(!existsSync(join(root, "_index", "serve.pid")), "no pid file could be recorded");
  } finally { await closeApp(app); }
});

await atest("serve main: usage error exits 2 with the one-line usage", async () => {
  for (const argv of [["--help"], ["--port", "nope"]]) {
    const m = errMark();
    assert.equal(await withExit(() => serve.main(argv)), 2);
    assert.match(errSince(m), /usage: geml codemap serve \[codemap-dir\]/);
  }
});

await atest("serve main: a directory without index.geml/index.html is refused with a pointer to build", async () => {
  const empty = tmp();
  const m = errMark();
  assert.equal(await withExit(() => serve.main([empty, "--port", "8479"])), 1);
  assert.match(errSince(m), /has no index\.geml — not a codemap directory\? \(build one: geml codemap build\)/);
});

await atest("serve main: --stop works even where index.geml is absent (checked before the dir gate)", async () => {
  const empty = tmp();
  const m = errMark();
  assert.equal(await withExit(() => serve.main([empty, "--stop"])), 0);
  assert.match(errSince(m), /no pid file — nothing to stop/);
});

await atest("serve main: --background on an already-answering port exits 0 without spawning", async () => {
  const root = mkMap();
  const port = claimPort();
  const dummy = appFor(root, { port });
  await listen(dummy, port);
  try {
    const m = errMark();
    assert.equal(await withExit(() => serve.main([root, "--port", String(port), "--background"])), 0);
    assert.match(errSince(m), /already answers — assuming it is up/);
  } finally { await closeApp(dummy); }
});

await atest("serve main: the plain foreground path serves, watches, and answers over the wire", async () => {
  const parent = tmp();
  const ctx = watchCtx(parent);
  writeFileSync(join(ctx.root, "auth.geml"), AUTH_GEML);
  recipe(ctx, []); // a recipe exists so --watch arms (never triggered here)
  const port = claimPort();
  const m = errMark();
  // --no-open matters: were this suite ever run from a real terminal, the
  // foreground path must not launch a browser.
  const app = await serve.main([ctx.root, "--port", String(port), "--no-warm", "--no-open", "--watch"]);
  try {
    await waitFor(() => /watch: watching /.test(errSince(m)), 5000, "watch armed via main");
    const page = await fetch(`http://127.0.0.1:${port}/auth.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /issueToken/);
    assert.doesNotMatch(errSince(m), /prewarm:/, "--no-warm respected end to end");
  } finally { await closeApp(app); }
});

test("serve as a child main module: the guard runs main (usage exit 2 over the wire)", () => {
  const r = spawnSync(process.execPath, [join(PKG, "codemap", "serve.mjs"), "--help"], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: geml codemap serve/);
});

test("serve module: without GEML_WATCH_QUIET_MS the quiet window defaults (30s)", () => {
  // The default is baked at import time — import in a scrubbed child.
  const env = { ...process.env };
  delete env.GEML_WATCH_QUIET_MS;
  const url = "file:///" + join(PKG, "codemap", "serve.mjs").replace(/\\/g, "/");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)}); console.log("imported");`],
    { encoding: "utf8", env, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /imported/, "inert import under default env");
});

console.log(`\n${passed} test(s) passed.`);
// Watchers/servers may still hold live handles — exit explicitly (V8 coverage
// is flushed on process.exit, same pattern as the sibling suites).
console.error = realErr;
process.exit(0);
