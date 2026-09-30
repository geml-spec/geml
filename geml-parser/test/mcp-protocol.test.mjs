// The two eras of MCP on one dispatcher (mcp-core.ts `dispatch`).
//
// Revision 2026-07-28 removed the `initialize` handshake: a "modern" request
// carries its protocol version and the client's capabilities in `params._meta`,
// servers implement `server/discover`, and every result says
// `resultType: "complete"`. Everything before it ("legacy", 2025-11-25 and
// earlier) still opens with `initialize`. The spec lets one server serve both,
// per message — this pins that both shapes are answered, that the legacy
// envelopes did not move, and that the HTTP status a transport should use
// travels with each outcome (stdio ignores it).
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LEGACY_VERSIONS, MODERN_VERSIONS, dispatch, eraOf, inlineHost, toolsFor, createHandler } from "../dist/mcp-core.js";

const TOOLS = toolsFor(inlineHost());
const tools = () => TOOLS;
const DOC = "# T {#t}\n\n=== note {#a}\nfirst\n===\n";
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const modern = (method, params = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } });
const legacy = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

test("era: a request is modern when its _meta carries a protocol version, legacy otherwise", () => {
  assert.equal(eraOf(modern("tools/list")), "modern");
  assert.equal(eraOf(legacy("initialize", { protocolVersion: "2025-06-18" })), "legacy");
  assert.equal(eraOf(legacy("tools/list")), "legacy");
  assert.equal(eraOf({ jsonrpc: "2.0", id: 1, method: "x", params: { _meta: { "io.modelcontextprotocol/protocolVersion": 7 } } }), "legacy");
});

test("legacy: initialize echoes a supported version, falls back to the newest, and the envelopes are unchanged", () => {
  const init = dispatch(legacy("initialize", { protocolVersion: "2025-11-25" }), tools);
  assert.equal(init.status, 200);
  assert.equal(init.reply.result.protocolVersion, "2025-11-25");
  assert.deepEqual(init.reply.result.serverInfo.name, "geml");
  assert.equal(dispatch(legacy("initialize", { protocolVersion: "1999-01-01" }), tools).reply.result.protocolVersion, LEGACY_VERSIONS[LEGACY_VERSIONS.length - 1]);
  assert.equal(dispatch(legacy("initialize", {}), tools).reply.result.protocolVersion, "2024-11-05", "no version asked: the oldest, as before");
  const list = dispatch(legacy("tools/list"), tools).reply.result;
  assert.equal(list.tools.length, 9);
  assert.equal(list.resultType, undefined, "a legacy result carries no modern fields");
  assert.deepEqual(dispatch(legacy("ping"), tools).reply.result, {});
  const call = dispatch(legacy("tools/call", { name: "geml_list", arguments: { source: DOC } }), tools).reply.result;
  assert.equal(call.content[0].type, "text");
  assert.equal(call.resultType, undefined);
  const unknown = dispatch(legacy("resources/list"), tools);
  assert.equal(unknown.reply.error.code, -32601);
  assert.equal(unknown.status, 200, "legacy HTTP never used 404 for an unknown method");
});

test("modern: server/discover advertises the modern versions, tools and identity", () => {
  const d = dispatch(modern("server/discover"), tools);
  assert.equal(d.status, 200);
  const r = d.reply.result;
  assert.equal(r.resultType, "complete");
  assert.deepEqual(r.supportedVersions, MODERN_VERSIONS);
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.equal(r._meta["io.modelcontextprotocol/serverInfo"].name, "geml");
  assert.equal(typeof r.instructions, "string");
  assert.equal(typeof r.ttlMs, "number");
  assert.equal(r.cacheScope, "public");
});

test("modern: tools/list and tools/call carry resultType, cache hints and serverInfo", () => {
  const list = dispatch(modern("tools/list"), tools).reply.result;
  assert.equal(list.resultType, "complete");
  assert.equal(list.tools.length, 9);
  assert.equal(list.ttlMs, 3600000);
  assert.equal(list.cacheScope, "public");
  assert.equal(list._meta["io.modelcontextprotocol/serverInfo"].name, "geml");
  const call = dispatch(modern("tools/call", { name: "geml_get", arguments: { source: DOC, id: "a" } }), tools).reply.result;
  assert.equal(call.resultType, "complete");
  assert.equal(call.content[0].text, "=== note {#a}\nfirst\n===\n");
  assert.equal(call.isError, undefined);
  const refused = dispatch(modern("tools/call", { name: "geml_set", arguments: { source: DOC, id: "a", body: "=== note {#a}\n[[#nope]]\n===\n" } }), tools).reply.result;
  assert.equal(refused.isError, true);
  assert.equal(refused.resultType, "complete", "a refused write is still a complete result");
  const missingTool = dispatch(modern("tools/call", { name: "geml_nope", arguments: {} }), tools);
  assert.equal(missingTool.reply.error.code, -32602);
  assert.equal(missingTool.status, 200);
});

test("modern: an unsupported version, a missing _meta field, and an unknown method each get their code and HTTP status", () => {
  const bad = dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2030-01-01" } } }, tools);
  assert.equal(bad.status, 400);
  assert.equal(bad.reply.error.code, -32022);
  assert.deepEqual(bad.reply.error.data, { supported: MODERN_VERSIONS, requested: "2030-01-01" });
  const noCaps = dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, tools);
  assert.equal(noCaps.status, 400);
  assert.equal(noCaps.reply.error.code, -32602);
  assert.match(noCaps.reply.error.message, /clientCapabilities/);
  const unknown = dispatch(modern("initialize", { protocolVersion: "2026-07-28" }), tools);
  assert.equal(unknown.status, 404, "initialize is not a modern method");
  assert.equal(unknown.reply.error.code, -32601);
  assert.match(unknown.reply.error.message, /2026-07-28/, "the versions this server speaks are named for a legacy client with no fall-forward");
  assert.equal(dispatch(modern("ping"), tools).status, 404, "ping was removed in 2026-07-28");
});

test("notifications get no reply in either era; a malformed message is an invalid request", () => {
  assert.deepEqual(dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }, tools), { status: 202 });
  assert.deepEqual(dispatch({ jsonrpc: "2.0", method: "notifications/cancelled", params: { _meta: META } }, tools), { status: 202 });
  const bad = dispatch({ jsonrpc: "2.0", id: 3 }, tools);
  assert.equal(bad.status, 400);
  assert.equal(bad.reply.error.code, -32600);
});

test("both eras interleave on one handler — the stdio server is dual-era for free", () => {
  const out = [];
  const handle = createHandler(tools);
  handle(JSON.stringify(legacy("initialize", { protocolVersion: "2025-06-18" })), (s) => out.push(JSON.parse(s)));
  handle(JSON.stringify(modern("server/discover", {}, 2)), (s) => out.push(JSON.parse(s)));
  handle(JSON.stringify(legacy("tools/list", undefined, 3)), (s) => out.push(JSON.parse(s)));
  assert.equal(out[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(out[1].result.supportedVersions, MODERN_VERSIONS);
  assert.equal(out[2].result.tools.length, 9);
});
