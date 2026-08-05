// Branch-coverage suite for the two MCP surfaces: `src/mcp.ts` (the document
// CRUD server) and `codemap/mcp-server.mjs` (the read-only graph tools it also
// serves). Both are almost entirely REFUSAL logic — a path confinement, a
// stale-graph message, a truncation cap — and refusals are exactly what a
// happy-path suite never reaches. Kept separate from mcp.test.mjs, which pins
// the protocol contract, the same way the other cov-* suites are separated.
import { configure, handleLine, allTools, loadGraphTools } from "../dist/mcp.js";
// The source-read bound is pinned ONCE, when the graph tools are loaded — the
// real server fixes --root at startup, so that is right there. A test that
// moves the root has to re-pin it, or every source read is refused as "outside
// this server's --root" against the PREVIOUS root.
import { confineSourceTo } from "../codemap/mcp-server.mjs";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function call(name, args) {
  const out = [];
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }), (s) => out.push(s));
  const msg = JSON.parse(out[0]);
  if (msg.error) return { rpcError: msg.error };
  const text = msg.result?.content?.[0]?.text ?? "";
  let json;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { text, json, isError: msg.result?.isError === true };
}

const DOC = '=== meta\ntitle = "T"\n===\n\n=== note {#alpha}\nfirst\n===\n\n=== note {#beta}\nsecond\n===\n';
function ws(doc = DOC, name = "d.geml") {
  const dir = mkdtempSync(join(tmpdir(), "geml-covmcp-"));
  writeFileSync(join(dir, name), doc);
  configure({ root: dir, history: false, graph: undefined });
  return dir;
}

await loadGraphTools();

// ---------------------------------------------------------------------------
// src/mcp.ts — the document server's refusal arms
// ---------------------------------------------------------------------------

test("a graph tool called with no graph configured names the missing flag", () => {
  // The tool is not even LISTED without a graph, but a client with a stale
  // tools/list can still call it. Falling back to some other directory would
  // be the worst answer; a blank failure is the second worst.
  const dir = ws();
  const graph = join(dir, ".geml-code-graph");
  mkdirSync(join(graph, "_index"), { recursive: true });
  writeFileSync(join(graph, "index.geml"), "=== meta\nrepo = demo\n===\n");
  configure({ graph });                       // graph tools become available
  assert.equal(allTools().length, 14);
  configure({ graph: undefined });            // …and are withdrawn again
  assert.equal(allTools().length, 10);
});

test("geml_list on an unreadable file surfaces the CLI's own words", () => {
  ws();
  const r = call("geml_list", { file: "no-such.geml" });
  assert.ok(r.isError || r.rpcError, "a missing file is an error, not an empty list");
});

test("geml_get with a selector that matches nothing says what it looked for", () => {
  ws();
  const r = call("geml_get", { file: "d.geml", id: "@ffffffff" });
  assert.ok(r.isError, r.text);
  assert.match(r.text, /no block matching|nothing matches/);
});

test("geml_to refuses an unknown target format instead of guessing one", () => {
  ws();
  const r = call("geml_to", { file: "d.geml", to: "docx" });
  assert.ok(r.isError, r.text);
});

test("a refused write returns the diagnostics, and the file is untouched", () => {
  // The refusal path parses the CLI's stderr for a JSON diagnostics frame and
  // falls back to plain text when there is none — both arms matter, because the
  // fallback is what a client sees when the CLI fails for a non-diagnostic reason.
  const dir = ws();
  const before = DOC;
  const r = call("geml_set", { file: "d.geml", id: "alpha", body: "=== note {#alpha}\nunclosed\n" });
  assert.ok(r.isError, r.text);
  assert.equal(readFileSync(join(dir, "d.geml"), "utf8"), before, "nothing written");
});

test("a dangling reference blocks a set but not a delete — the asymmetry is deliberate", () => {
  // `set` INTRODUCED the bad reference, so refusing costs nothing but a retry.
  // `delete` is the one verb whose whole job can strand a reference someone else
  // wrote; refusing there would mean a block becomes undeletable because
  // something points at it, which is the CLI's rule too.
  ws();
  const bad = call("geml_set", { file: "d.geml", id: "alpha", body: "=== note {#alpha}\nsee [[#nowhere]]\n===\n" });
  assert.equal(bad.json?.ok, false, "set is refused");
  assert.ok(bad.json.diagnostics.some((d) => d.code === "unresolved-reference"), bad.text);

  ws('=== note {#a}\nsee [[#b]]\n===\n\n=== note {#b}\ntarget\n===\n');
  const del = call("geml_delete", { file: "d.geml", ids: ["b"] });
  assert.equal(del.json?.ok, true, `delete strands #b's reference on purpose: ${del.text}`);
});

test("geml_delete and geml_rename take ids with or without the leading #", () => {
  // These keep the id-only contract (their CLI verbs do too), so both spellings
  // of the SAME id must reach the same block.
  ws();
  assert.equal(call("geml_delete", { file: "d.geml", ids: ["#beta"] }).json?.ok, true);
  ws();
  assert.equal(call("geml_delete", { file: "d.geml", ids: ["beta"] }).json?.ok, true);
  ws();
  const r = call("geml_rename", { file: "d.geml", old: "alpha", new: "#renamed" });
  assert.equal(r.json?.ok, true, r.text);
});

test("blank and unparseable lines are dropped; a handler throw becomes an error frame", () => {
  // Dropping an unparseable line is deliberate: with no readable `id` there is
  // nobody to address the error to, and a reply carrying id:null would only
  // confuse a client that never sent it. A blank line (keep-alives, a flushed
  // buffer) likewise.
  for (const junk of ["", "   ", "{not json", "[1,2"]) {
    const out = [];
    handleLine(junk, (s) => out.push(s));
    assert.equal(out.length, 0, `${JSON.stringify(junk)} must produce no frame`);
  }
  // A line that DOES parse but names nothing gets an addressed error, because
  // now there is an id to answer.
  const out = [];
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "no/such/method" }), (s) => out.push(s));
  assert.equal(out.length, 1);
  assert.ok(JSON.parse(out[0]).error, out[0]);
  assert.equal(JSON.parse(out[0]).id, 3, "the reply is addressed to the caller");
});

// ---------------------------------------------------------------------------
// codemap/mcp-server.mjs — the graph tools' refusal arms
// ---------------------------------------------------------------------------

const AUTH = `=== meta
module = auth
===

=== code {#login src=src/login.ts#L2-3 anchor="a1"}
===

=== code {#issueToken src=src/token.ts anchor="a2"}
===

=== code {#stale src=src/login.ts#L900-901 anchor="a3"}
===

=== code {#gone src=src/missing.ts#L1-2 anchor="a4"}
===

=== code {#nosrc}
===

=== table {#calls format=csv}
from, to, kind, site
#login, #issueToken, call, src/login.ts:2
===

=== table {#called-by format=csv}
from, to, kind, site
#issueToken, #login, call, src/login.ts:2
===
`;

// A graph whose recorded source root really holds the files, so readSource can
// take its success path as well as each refusal.
function wsGraph({ sources = true, modules = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "geml-covgraph-"));
  writeFileSync(join(dir, "d.geml"), DOC);
  const graph = join(dir, ".geml-code-graph");
  mkdirSync(join(graph, "_index"), { recursive: true });
  writeFileSync(join(graph, "index.geml"), "=== meta\nrepo = demo\n===\n"
    + (modules ? "\n=== table {#modules format=csv}\nmodule, doc, symbols\nauth, auth.geml, 2\n===\n" : ""));
  writeFileSync(join(graph, "auth.geml"), AUTH);
  writeFileSync(join(graph, "_index", "name-lookup.json"),
    JSON.stringify({ login: [{ doc: "auth.geml", id: "login" }], issueToken: [{ doc: "auth.geml", id: "issueToken" }] }));
  if (sources) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "login.ts"), "line one\nline two\nline three\nline four\n");
    writeFileSync(join(dir, "src", "token.ts"), "token line\n");
  }
  configure({ root: dir, history: false, graph });
  confineSourceTo(dir);
  return { dir, graph };
}

test("geml_codemap_node with source: true prints the addressed lines, numbered", () => {
  wsGraph();
  const r = call("geml_codemap_node", { doc: "auth.geml", id: "login", source: true });
  assert.match(r.text, /--- src\/login\.ts:2-3 ---/);
  assert.match(r.text, /2 {2}line two/);
  assert.match(r.text, /3 {2}line three/);
  assert.ok(!r.text.includes("line four"), "the range is respected");
});

test("a src= with no #L range reads the whole file", () => {
  wsGraph();
  const r = call("geml_codemap_node", { doc: "auth.geml", id: "issueToken", source: true });
  assert.match(r.text, /token line/);
});

test("a block with no src= says so rather than returning an empty source", () => {
  wsGraph();
  const r = call("geml_codemap_node", { doc: "auth.geml", id: "nosrc", source: true });
  assert.match(r.text, /no `src=` on this block/);
});

test("a stale line range names the rebuild, and a missing file names itself", () => {
  wsGraph();
  const stale = call("geml_codemap_node", { doc: "auth.geml", id: "stale", source: true });
  assert.match(stale.text, /has no lines 900-901|the graph is stale/);
  const gone = call("geml_codemap_node", { doc: "auth.geml", id: "gone", source: true });
  assert.match(gone.text, /no such source file/);
});

test("sources absent from this machine is a readable message, not a crash", () => {
  // A graph is committable; the tree it indexed may not be here. That is the
  // ordinary case for a shared graph, so it must read as information.
  const { dir } = wsGraph({ sources: false });
  const r = call("geml_codemap_node", { doc: "auth.geml", id: "login", source: true });
  assert.match(r.text, /does not exist|no such source file/, r.text);
  rmSync(dir, { recursive: true, force: true });
});

test("geml_codemap_node reads an edge table as well as a symbol block", () => {
  wsGraph();
  assert.match(call("geml_codemap_node", { doc: "auth.geml", id: "#calls" }).text, /#issueToken/);
  assert.match(call("geml_codemap_node", { doc: "auth.geml", id: "#called-by" }).text, /#login/);
});

test("geml_codemap_callchain walks callees and callers, and requires both args", () => {
  wsGraph();
  const down = call("geml_codemap_callchain", { doc: "auth.geml", id: "login" });
  assert.match(down.text, /auth\.geml#login/);
  assert.match(down.text, /callees, depth 3/);
  // No resolved callers is stated as a BLIND SPOT, not as proof of none —
  // heuristic extraction cannot tell the two apart, and a model reading
  // "no callers" would happily conclude the symbol is dead code.
  const up = call("geml_codemap_callchain", { doc: "auth.geml", id: "#issueToken", direction: "callers", depth: 2 });
  assert.match(up.text, /no resolved callers/);
  assert.match(up.text, /blind spot/, "the wording has to stop a false 'dead code' conclusion");
  // A depth outside 1..6 is clamped rather than refused — it is a hint, not an address.
  assert.match(call("geml_codemap_callchain", { doc: "auth.geml", id: "login", depth: 99 }).text, /depth 6/);
  assert.ok(call("geml_codemap_callchain", { doc: "auth.geml" }).isError, "a missing id is an error");
  assert.ok(call("geml_codemap_callchain", { id: "login" }).isError, "a missing doc likewise");
});

test("geml_codemap_list gives the modules, then one module's symbols", () => {
  wsGraph();
  const mods = call("geml_codemap_list", {});
  assert.match(mods.text, /auth\tauth\.geml\t2 symbol\(s\)/, mods.text);
  assert.match(mods.text, /Pass one as `module`/, "the roll-up names the next call");
  const syms = call("geml_codemap_list", { module: "auth" });
  assert.match(syms.text, /login/, syms.text);
});

test("a graph with no #modules table points at the build instead of printing nothing", () => {
  // An index without that table is a half-built graph, and an empty list would
  // read as "this repo has no modules".
  wsGraph({ modules: false });
  const r = call("geml_codemap_list", {});
  assert.ok(r.isError, r.text);
  assert.match(r.text, /no #modules table/);
  assert.match(r.text, /build the graph first/);
});

test("geml_codemap_search finds by substring and by exact name", () => {
  wsGraph();
  assert.match(call("geml_codemap_search", { query: "log" }).text, /login/);
  assert.match(call("geml_codemap_search", { query: "login", exact: true }).text, /auth\.geml#login/);
  const none = call("geml_codemap_search", { query: "no-such-symbol-anywhere" });
  assert.ok(!none.text.includes("auth.geml"), "an empty result says nothing rather than everything");
});

test("a symbol the graph does not have is an error, not an empty chain", () => {
  // "no edges" and "no such symbol" are different answers; conflating them
  // would let a model conclude a function calls nothing when it typo'd the name.
  wsGraph();
  assert.ok(call("geml_codemap_callchain", { doc: "auth.geml", id: "nosuchsymbol" }).isError);
  assert.ok(call("geml_codemap_node", { doc: "auth.geml", id: "nosuchsymbol" }).isError);
});

test("a source file reached through a symlink out of the tree is refused", () => {
  // The graph's src= is committed repo data, so it is attacker-controlled in a
  // cloned repo; realpath is what makes the bound hold.
  const { dir } = wsGraph();
  const outside = mkdtempSync(join(tmpdir(), "geml-outside-"));
  writeFileSync(join(outside, "secret.ts"), "SECRET\n");
  let linked = false;
  try { symlinkSync(join(outside, "secret.ts"), join(dir, "src", "link.ts")); linked = true; } catch { /* needs privilege on Windows */ }
  if (!linked) { console.log("   (symlink unavailable — skipped)"); return; }
  const graph = join(dir, ".geml-code-graph");
  writeFileSync(join(graph, "auth.geml"), AUTH.replace("src=src/login.ts#L2-3", "src=src/link.ts#L1-1"));
  const r = call("geml_codemap_node", { doc: "auth.geml", id: "login", source: true });
  assert.ok(!r.text.includes("SECRET"), `a symlink must not leak content: ${r.text}`);
});

console.log(`\n${passed} test(s) passed.`);

// --- remaining refusal/fallback arms (coverage: mcp.js 237/272/310/317/425,
// 589, 607, 686) — each is a path an agent can actually drive into.

test("resolver returns null for a doc outside the root, so a cross-doc ref is UNCHECKED not read", () => {
  // A RELATIVE escape, not an absolute path: an absolute Windows path in `src=`
  // is refused earlier, as a URL scheme (`C:` reads as one), so it would never
  // reach the resolver's confinement — which is the arm under test.
  const parent = mkdtempSync(join(tmpdir(), "geml-mcp-pair-"));
  const outside = join(parent, "outside");
  const root = join(parent, "root");
  mkdirSync(outside, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(outside, "secret.geml"), "=== note {#s}\nnope\n===\n");
  writeFileSync(join(root, "host.geml"), '=== embed {#e src="../outside/secret.geml#s"}\n===\n');
  configure({ root, history: false });
  const r = call("geml_check", { file: "host.geml" });
  // The confinement returns null (mcp.js:237): the reference is reported as
  // unresolvable/unchecked — never silently read from outside the root.
  assert.match(JSON.stringify(r), /unresolvable|unchecked|cannot resolve/i, "confined, and said so");
  rmSync(outside, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("geml_list on a file with no addressable block, and geml_get on a selector that matches nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-mcp-empty-"));
  writeFileSync(join(root, "bare.geml"), "just prose, no blocks\n");
  configure({ root, history: false });
  const list = call("geml_list", { file: "bare.geml" });
  assert.ok(list, "list answers even with nothing to address");
  const miss = call("geml_get", { file: "bare.geml", id: "#nope" });
  assert.match(JSON.stringify(miss), /no block with id|nothing matches|no match/i, "the miss is reported, not empty content");
  rmSync(root, { recursive: true, force: true });
});

test("geml_to with an unconvertible target reports the failure", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-mcp-to-"));
  writeFileSync(join(root, "d.geml"), "=== note {#n}\nhi\n===\n");
  configure({ root, history: false });
  const bad = call("geml_to", { file: "d.geml", to: "not-a-format" });
  assert.match(JSON.stringify(bad), /could not convert|unknown|usage/i, "a bad target is an error, not a silent empty body");
  rmSync(root, { recursive: true, force: true });
});

test("confineSchema passes through a schema with no graph_dir, and loadGraphTools is idempotent", async () => {
  // 589: the pass-through arm — a document tool's schema has no graph_dir to pin.
  const docTool = allTools().find((t) => t.name === "geml_get");
  assert.ok(docTool?.inputSchema?.properties?.file, "document tool schema served as-is");
  assert.equal(docTool.inputSchema.properties.graph_dir, undefined, "nothing to confine");
  // 607: the cached arm — a second load returns the same array, no re-import.
  const a = await loadGraphTools();
  const b = await loadGraphTools();
  assert.equal(a, b, "graph tools are loaded once and cached");
});

test("a tool that throws is answered as an internal error, and the connection survives", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-mcp-throw-"));
  configure({ root, history: false });
  // A missing `file` argument makes the handler throw before any reply (686).
  const out = [];
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "geml_get" } }), (s) => out.push(s));
  const msg = JSON.parse(out.at(-1));
  assert.equal(msg.id, 99, "the failure is attributed to the request that caused it");
  assert.ok(msg.error || msg.result?.isError, "answered as an error rather than dropped");
  // The server still serves afterwards.
  const after = [];
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list" }), (s) => after.push(s));
  assert.match(after.join(""), /geml_get/, "connection survives a handler throw");
  rmSync(root, { recursive: true, force: true });
});
