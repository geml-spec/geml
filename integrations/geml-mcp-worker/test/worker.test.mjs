// The Worker's HTTP shell, driven in Node: the handler only uses Web standard
// APIs (Request, Response, URL, TextEncoder, atob), so `fetch(new Request(…))`
// exercises it without wrangler or a network. What lives in mcp-core (tools,
// write pipeline, JSON-RPC dispatch) is pinned by the parser's own suites; this
// file pins what the SHELL decides — Origin, body size, the mirrored headers of
// MCP 2026-07-28, the era routing, and the status codes both spec revisions
// prescribe.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import worker, { decodeHeaderValue, originAllowed } from "../src/worker.js";
import parserPkg from "../../../geml-parser/package.json" with { type: "json" };

const URL_ = "https://geml-mcp.example.workers.dev/mcp";
const DOC = "# T {#t}\n\n=== note {#a}\nfirst\n===\n";
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const env = {};
async function post(body, headers = {}, url = URL_) {
  const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await worker.fetch(new Request(url, init), env, {});
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}
const modern = (method, params = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } });
const modernHeaders = (method, name) => ({ "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });

test("legacy client: initialize, tools/list, a write that comes back as text", async () => {
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("content-type"), "application/json");
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  assert.equal(init.json.result.serverInfo.version, parserPkg.version, "the bundled parser's version, never the 0.0.0 fallback");
  assert.equal(init.headers.get("mcp-session-id"), null, "no session is minted");
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
  assert.equal(list.json.result.tools.length, 9);
  const set = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "geml_set", arguments: { source: DOC, id: "a", body: "=== note {#a}\nsecond\n===\n" } } });
  const result = JSON.parse(set.json.result.content[0].text);
  assert.equal(result.ok, true);
  assert.equal(result.document, DOC.replace("first", "second"));
  // A legacy request without the version header is taken as 2025-03-26; a bad one is refused.
  assert.equal((await post({ jsonrpc: "2.0", id: 4, method: "ping" })).status, 200);
  assert.equal((await post({ jsonrpc: "2.0", id: 5, method: "ping" }, { "mcp-protocol-version": "1999-01-01" })).status, 400);
  // A stale session header is ignored, never echoed.
  const stale = await post({ jsonrpc: "2.0", id: 6, method: "ping" }, { "mcp-session-id": "abc" });
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get("mcp-session-id"), null);
});

test("modern client: server/discover, tools/list with cache hints, tools/call with mirrored headers", async () => {
  const d = await post(modern("server/discover"), modernHeaders("server/discover"));
  assert.equal(d.status, 200);
  assert.deepEqual(d.json.result.supportedVersions, ["2026-07-28"]);
  const list = await post(modern("tools/list", {}, 2), modernHeaders("tools/list"));
  assert.equal(list.json.result.resultType, "complete");
  assert.equal(list.json.result.cacheScope, "public");
  const call = await post(modern("tools/call", { name: "geml_get", arguments: { source: DOC, id: "a" } }, 3), modernHeaders("tools/call", "geml_get"));
  assert.equal(call.status, 200);
  assert.equal(call.json.result.content[0].text, "=== note {#a}\nfirst\n===\n");
});

test("modern client: every mirrored-header failure is 400 HeaderMismatch; an unknown method is 404; an unsupported version is 400 -32022", async () => {
  const noVersion = await post(modern("tools/list"), { "mcp-method": "tools/list" });
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.json.error.code, -32020);
  const wrongMethod = await post(modern("tools/list"), modernHeaders("tools/call"));
  assert.equal(wrongMethod.status, 400);
  assert.equal(wrongMethod.json.error.code, -32020);
  const noName = await post(modern("tools/call", { name: "geml_list", arguments: { source: DOC } }), modernHeaders("tools/call"));
  assert.equal(noName.json.error.code, -32020);
  const wrongName = await post(modern("tools/call", { name: "geml_list", arguments: { source: DOC } }), modernHeaders("tools/call", "geml_get"));
  assert.equal(wrongName.json.error.code, -32020);
  // The name may travel Base64-encoded; it is decoded before comparing.
  const encoded = await post(modern("tools/call", { name: "geml_list", arguments: { source: DOC } }), modernHeaders("tools/call", "=?base64?Z2VtbF9saXN0?="));
  assert.equal(encoded.status, 200, encoded.text);
  const unknown = await post(modern("initialize", { protocolVersion: "2026-07-28" }), modernHeaders("initialize"));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, -32601);
  const unsupported = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2030-01-01" } } }, { "mcp-protocol-version": "2030-01-01", "mcp-method": "tools/list" });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.json.error.code, -32022);
});

test("transport rules: notification 202, array 400, bad JSON 400, GET/DELETE 405, other paths 404, root text", async () => {
  const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  assert.equal(note.text, "");
  const batch = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.equal(batch.status, 400);
  assert.equal(batch.json.error.code, -32600);
  const bad = await post("{not json");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, -32700);
  assert.equal(bad.json.id, null);
  for (const method of ["GET", "DELETE"]) {
    const r = await worker.fetch(new Request(URL_, { method }), env, {});
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("allow"), "POST, OPTIONS");
  }
  const root = await worker.fetch(new Request("https://geml-mcp.example.workers.dev/"), env, {});
  assert.equal(root.status, 200);
  assert.match(await root.text(), /geml MCP server/);
  assert.equal((await worker.fetch(new Request("https://geml-mcp.example.workers.dev/nope"), env, {})).status, 404);
});

test("Origin: absent passes, localhost passes by default, a stranger is 403, the allowlist is configurable; OPTIONS answers CORS", async () => {
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "http://localhost:6274" })).status, 200);
  const stranger = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.error.code, -32600);
  const res = await worker.fetch(new Request(URL_, { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }), { ALLOWED_ORIGINS: "https://app.example" }, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example");
  const pre = await worker.fetch(new Request(URL_, { method: "OPTIONS", headers: { origin: "http://localhost:1234", "access-control-request-method": "POST" } }), env, {});
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /MCP-Protocol-Version/i);
  assert.ok(originAllowed("http://127.0.0.1:9", env));
  assert.ok(!originAllowed("http://localhost.evil:80", env));
  assert.ok(originAllowed("https://x.example", { ALLOWED_ORIGINS: "*" }));
  assert.ok(originAllowed("https://x.example", { ALLOWED_ORIGINS: "https://x.example:443" }), "the scheme's default port matches an explicit one");
});

test("body size: over the cap is 413, by Content-Length or by counting", async () => {
  const small = { MAX_BODY_BYTES: "64" };
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "geml_list", arguments: { source: "x".repeat(200) } } });
  const r = await worker.fetch(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: big }), small, {});
  assert.equal(r.status, 413);
  const declared = await worker.fetch(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", "content-length": "999999" }, body: "{}" }), small, {});
  assert.equal(declared.status, 413);
});

test("decodeHeaderValue: plain values pass through, the Base64 sentinel is decoded as UTF-8", () => {
  assert.equal(decodeHeaderValue("geml_list"), "geml_list");
  assert.equal(decodeHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?="), "Hello, 世界");
  assert.equal(decodeHeaderValue("=?base64?not base64!?="), "=?base64?not base64!?=", "an undecodable sentinel stays literal and will simply not match");
});
