# GEML 远端 MCP server（Cloudflare Worker）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已落地的 verbs / mcp-core 切分之上，完成设计文档 `docs/design/specs/2026-09-14-geml-mcp-worker-design.md` 剩余章节：双纪元协议层、Cloudflare Worker 无状态 HTTP 壳、CI、版本仪式、registry 占位与文档。

**Architecture:** `mcp-core.ts` 的分发按消息判纪元（legacy `initialize` 到 2025-11-25；modern 2026-07-28 的 `_meta` 自带版本），并把 HTTP 状态码作为分发结果的一部分返回，stdio 忽略它。Worker 是纯 JS ESM，直接 import `geml-parser/dist/`，只做 HTTP 壳：Origin、体积、镜像头校验、纪元路由；文档以 `source` 进、`document` 出，通过 `inlineHost()`。测试在 Node 里直接调 `fetch(new Request(...))`，不需要 wrangler。

**Tech Stack:** TypeScript（parser）、纯 JS ESM（Worker）、wrangler 4.95（本地 dev / dry-run 打包）、node:test。

## Global Constraints

- 零运行时依赖：Worker 不引官方 SDK，不引 zod；`geml-parser` 的 `dependencies` 仍为空。
- `verbs.ts`、`mcp-core.ts` 不得 import `node:*`；Worker 里 `node:fs/path/url/os/child_process/readline` 别名到 `geml-parser/codemap/browser-stub.mjs`，`node:crypto` 留给 `nodejs_compat`（`@hex` 地址要真 sha256）。
- `compatibility_date` 取 `2026-05-01`（本机 wrangler 4.95 内置 workerd 1.20260504）。
- 版本：parser **1.10.4**（八个字段：`geml-parser/package.json`、`server.json` ×2、`package-lock.json` ×2、`integrations/claude-plugin/.claude-plugin/plugin.json`、`integrations/codex-plugin/.codex-plugin/plugin.json`、`gemini-extension.json`、`integrations/grok-plugin/.grok-plugin/plugin.json`）；Worker **1.0.0**。
- 协议：`LEGACY_VERSIONS = 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25`；`MODERN_VERSIONS = 2026-07-28`。错误码：`-32020` HeaderMismatch、`-32022` UnsupportedProtocolVersion、`-32601` 未知方法（modern 走 HTTP 404）、`-32602` `_meta` 缺字段（HTTP 400）。
- 部署地址占位 `https://geml-mcp.<subdomain>.workers.dev/mcp`；`publish-mcp.yml` 只手动触发，占位不会被自动发布。
- 人读文案（README、PUBLISHING、CHANGELOG 正文）先给 diff、经批准再落；Worker 自己的 README / SECURITY 是新集成的随包文档，直接写。
- 跨平台：测试不建 symlink、不假设 CRLF/LF、路径用 `node:path`；`test/all.mjs` 是 CRLF 文件，改它用脚本不用编辑器。
- 不提交。全部改动留在工作区等 review。

---

### Task 1: mcp-core 双纪元分发

**Files:**
- Modify: `geml-parser/src/mcp-core.ts`（`createHandler` 一段改为 `dispatch` + 薄封装）
- Create: `geml-parser/test/mcp-protocol.test.mjs`
- Modify: `geml-parser/test/all.mjs`（在 `"host-fs"` 之后登记 `"mcp-protocol"`）

**Interfaces:**
- Produces:
  ```ts
  export const LEGACY_VERSIONS: readonly string[]; export const MODERN_VERSIONS: readonly string[];
  export type Era = "legacy" | "modern";
  export function eraOf(msg: unknown): Era;                       // params._meta["io.modelcontextprotocol/protocolVersion"] 为字符串即 modern
  export interface Dispatched { reply?: Record<string, unknown>; status: 200 | 202 | 400 | 404 }
  export function dispatch(msg: unknown, tools: () => Tool[]): Dispatched;   // 一条已解析的 JSON-RPC 消息进，零或一条回复出；status 供 HTTP 传输用
  export function createHandler(tools: () => Tool[]): (line: string, write: (s: string) => void) => void;  // 不变：stdio 封装
  ```
- Consumes: `Tool`、`asText`、`WriteResult`、`SERVER_VERSION`（已有）。

- [ ] **Step 1: 写失败的测试** `geml-parser/test/mcp-protocol.test.mjs`

```js
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
```

- [ ] **Step 2: 跑一遍确认失败** `node test/mcp-protocol.test.mjs` → 导入 `dispatch`/`eraOf`/`LEGACY_VERSIONS` 报 SyntaxError（不存在的导出）。

- [ ] **Step 3: 实现** 在 `mcp-core.ts` 的「newline-delimited JSON-RPC 2.0」一节，把 `createHandler` 改成如下（原 `createHandler` 整段替换）：

```ts
// ---------------------------------------------------------------------------
// JSON-RPC 2.0, in two eras
// ---------------------------------------------------------------------------

// MCP changed shape in revision 2026-07-28 (SEP-2575 / SEP-2567): no `initialize`
// handshake, no session, every request carries its protocol version and the
// client's capabilities in `params._meta`, servers implement `server/discover`,
// every result says `resultType: "complete"`. The spec names the two shapes
// "legacy" (2025-11-25 and earlier) and "modern", and allows one server to
// serve both — which this does, per message: a `_meta` protocol version makes
// a message modern; anything else, `initialize` included, is legacy and is
// answered exactly as before.
export const LEGACY_VERSIONS: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
export const MODERN_VERSIONS: readonly string[] = ["2026-07-28"];
export type Era = "legacy" | "modern";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const SERVER_INFO = { name: "geml", version: SERVER_VERSION };
/** How long a client may cache `tools/list` and `server/discover`: the roster changes only with a release. */
export const TOOLS_TTL_MS = 3_600_000;
const INSTRUCTIONS =
  "GEML documents, edited one block at a time. Call geml_list first: its addresses are what geml_get and the write tools take. " +
  "Every write is validated before it lands and refused with diagnostics when it would break the document.";

export function eraOf(msg: unknown): Era {
  const v = (msg as any)?.params?._meta?.[META_VERSION];
  return typeof v === "string" ? "modern" : "legacy";
}

export interface Dispatched {
  /** The JSON-RPC reply, absent for a notification (there is nothing to send). */
  reply?: Record<string, unknown>;
  /** What an HTTP transport answers with; stdio has no use for it. */
  status: 200 | 202 | 400 | 404;
}

const ok = (id: unknown, result: unknown, status: 200 = 200): Dispatched => ({ reply: { jsonrpc: "2.0", id, result }, status });
const err = (id: unknown, code: number, message: string, status: 200 | 400 | 404, data?: unknown): Dispatched =>
  ({ reply: { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }, status });

function callTool(name: unknown, args: unknown, tools: () => Tool[]): { result: Record<string, unknown> } | { unknown: true } {
  const tool = tools().find((t) => t.name === name);
  if (!tool) return { unknown: true };
  try {
    const out = tool.run((args as Record<string, any>) ?? {});
    // A refused write is a RESULT, not a protocol error: the model must be
    // able to read the diagnostics that refused it.
    const isError = typeof out === "object" && out !== null && (out as WriteResult).ok === false;
    return { result: { content: [{ type: "text", text: asText(out) }], ...(isError ? { isError: true } : {}) } };
  } catch (e) {
    return { result: { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true } };
  }
}

/** One parsed JSON-RPC message in; zero or one reply out, with the HTTP status a transport would use. */
export function dispatch(msg: unknown, tools: () => Tool[]): Dispatched {
  const m = msg as any;
  const id = m?.id;
  const method = m?.method;
  const params = m?.params;
  // Notifications get no response, in either era.
  if (typeof method === "string" && method.startsWith("notifications/")) return { status: 202 };
  if (typeof method !== "string") return err(id ?? null, -32600, "invalid request: `method` is required", 400);

  if (eraOf(m) === "legacy") {
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      // Echo a version this server speaks; a stranger gets the newest legacy
      // one, and no version at all keeps the oldest — the long-standing answer.
      const version = asked === undefined ? LEGACY_VERSIONS[0]
        : LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[LEGACY_VERSIONS.length - 1];
      return ok(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    if (method === "ping") return ok(id, {});
    if (method === "tools/list") return ok(id, { tools: tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === "tools/call") {
      const r = callTool(params?.name, params?.arguments, tools);
      return "unknown" in r ? err(id, -32602, `unknown tool: ${params?.name}`, 200) : ok(id, r.result);
    }
    return err(id, -32601, `method not found: ${method}`, 200);
  }

  // Modern: the request stands alone. Version and capabilities travel with it,
  // and a mismatch is answered per request — there is no session to fail.
  const requested = params._meta[META_VERSION] as string;
  if (!MODERN_VERSIONS.includes(requested)) {
    return err(id, -32022, "Unsupported protocol version", 400, { supported: MODERN_VERSIONS, requested });
  }
  const caps = params._meta[META_CAPABILITIES];
  if (typeof caps !== "object" || caps === null) {
    return err(id, -32602, `invalid params: _meta.${META_CAPABILITIES} is required on every request`, 400);
  }
  const meta = { [META_SERVER_INFO]: SERVER_INFO };
  if (method === "server/discover") {
    return ok(id, {
      resultType: "complete", supportedVersions: MODERN_VERSIONS, capabilities: { tools: {} },
      _meta: meta, instructions: INSTRUCTIONS, ttlMs: TOOLS_TTL_MS, cacheScope: "public",
    });
  }
  if (method === "tools/list") {
    return ok(id, {
      resultType: "complete",
      tools: tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      ttlMs: TOOLS_TTL_MS, cacheScope: "public", _meta: meta,
    });
  }
  if (method === "tools/call") {
    const r = callTool(params.name, params.arguments, tools);
    return "unknown" in r ? err(id, -32602, `unknown tool: ${params.name}`, 200) : ok(id, { resultType: "complete", ...r.result, _meta: meta });
  }
  // Unknown method — `initialize` and `ping` included. A legacy client that
  // somehow arrives here has no fall-forward, so name the versions we speak.
  return err(id, -32601, `method not found: ${method} (this server speaks MCP ${MODERN_VERSIONS.join(", ")}, and ${LEGACY_VERSIONS.join(", ")} via initialize)`, 404);
}

/**
 * The stdio framing: one line in, zero or one line out through `write`.
 * `tools` is asked per message, because a host may add tools after start-up
 * (the stdio server loads the code-graph tools once it knows it has a graph).
 */
export function createHandler(tools: () => Tool[]): (line: string, write: (s: string) => void) => void {
  return (line, write) => {
    line = line.trim();
    if (!line) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    try {
      const d = dispatch(msg, tools);
      if (d.reply) write(JSON.stringify(d.reply) + "\n");
    } catch (e) {
      if (msg?.id !== undefined) write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String((e as Error)?.message ?? e) } }) + "\n");
    }
  };
}
```

- [ ] **Step 4: 编译并跑** `npx tsc -p .` 然后 `node test/mcp-protocol.test.mjs`、`node test/mcp.test.mjs`、`node test/mcp-inline.test.mjs`、`node test/cov-mcp.test.mjs` → 全部 exit 0。旧测试零改动（legacy 信封逐字未变）。

- [ ] **Step 5: 登记套件** 用脚本把 `test/all.mjs` 里 `"mcp", "mcp-inline", "verbs", "host-fs",` 改成 `"mcp", "mcp-inline", "verbs", "host-fs", "mcp-protocol",`（文件是 CRLF）。

---

### Task 2: Worker 包与 HTTP 壳

**Files:**
- Create: `integrations/geml-mcp-worker/package.json`、`wrangler.jsonc`、`.gitignore`、`src/worker.js`、`src/node-stub.js`、`test/worker.test.mjs`、`README.md`、`SECURITY.md`

**Interfaces:**
- Consumes: `dispatch / eraOf / inlineHost / toolsFor / LEGACY_VERSIONS / MODERN_VERSIONS / SERVER_VERSION` from `geml-parser/dist/mcp-core.js`。
- Produces: `export default { fetch(request, env, ctx) }`；`export function handle(request, env): Promise<Response>`；`export function originAllowed(origin: string, env): boolean`；`export function decodeHeaderValue(v: string): string`（供测试直调）。

- [ ] **Step 1: 脚手架**

`package.json`
```json
{
  "name": "geml-mcp-worker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "GEML's MCP server as a stateless Cloudflare Worker: the document travels with each call, a write comes back as text. Same tools, same verbs as `geml mcp`, no files kept.",
  "scripts": {
    "test": "node --test test/",
    "check": "wrangler deploy --dry-run --outdir=.wrangler/dry",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.95.0"
  }
}
```

`wrangler.jsonc`
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "geml-mcp",
  "main": "src/worker.js",
  "compatibility_date": "2026-05-01",
  // node:crypto (a real sha256 for `@hex` content addresses) comes from here;
  // every other node:* the parser mentions is aliased to a stub below.
  "compatibility_flags": ["nodejs_compat"],
  "alias": {
    "node:fs": "./src/node-stub.js",
    "node:path": "./src/node-stub.js",
    "node:url": "./src/node-stub.js",
    "node:os": "./src/node-stub.js",
    "node:child_process": "./src/node-stub.js",
    "node:readline": "./src/node-stub.js"
  },
  // The parser's CLI hand-off guard reads process.argv[1]; there is no argv here.
  "define": { "process.argv": "[]" },
  "vars": {
    "ALLOWED_ORIGINS": "http://localhost:*,http://127.0.0.1:*",
    "MAX_BODY_BYTES": "2097152"
  },
  "observability": { "enabled": true }
}
```

`src/node-stub.js`
```js
// The parser's dist/ mentions node:fs, node:path, node:url, node:os,
// node:child_process and node:readline on paths a Worker never runs (the CLI
// hand-off, PARSER_VERSION's package.json lookup, the disk host). wrangler.jsonc
// aliases those imports here, and this forwards to the stub the parser already
// ships for its browser bundles — one stub, one more consumer.
export * from "../../../geml-parser/codemap/browser-stub.mjs";
export { default } from "../../../geml-parser/codemap/browser-stub.mjs";
```

`.gitignore`
```
node_modules/
.wrangler/
```

- [ ] **Step 2: 写失败的测试** `test/worker.test.mjs`

```js
import { test } from "node:test";
import { strict as assert } from "node:assert";
import worker, { decodeHeaderValue, originAllowed } from "../src/worker.js";

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
```

- [ ] **Step 3: 跑一遍确认失败** `node --test test/` → `../src/worker.js` 不存在。

- [ ] **Step 4: 实现** `src/worker.js`

```js
// GEML's MCP server as a stateless Cloudflare Worker.
//
// This file is only the HTTP shell. The tools, the write pipeline and the
// JSON-RPC dispatch are geml-parser's mcp-core, bound to its INLINE host: the
// document travels in `source`, a write comes back as `document`, nothing is
// kept between calls. What is decided here is what an HTTP transport has to
// decide — Origin, body size, the mirrored headers MCP 2026-07-28 requires,
// and which era a request speaks — and nothing else.
import {
  LEGACY_VERSIONS, MODERN_VERSIONS, SERVER_VERSION, dispatch, eraOf, inlineHost, toolsFor,
} from "../../../geml-parser/dist/mcp-core.js";

const TOOLS = toolsFor(inlineHost());
const tools = () => TOOLS;

const DEFAULT_ORIGINS = "http://localhost:*,http://127.0.0.1:*";
const DEFAULT_MAX_BODY = 2 * 1024 * 1024;
const README = "https://github.com/geml-spec/geml/tree/main/integrations/geml-mcp-worker";

export default {
  fetch(request, env = {}, _ctx) {
    return handle(request, env);
  },
};

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

const DEFAULT_PORT = { "http:": "80", "https:": "443" };

/** Is `origin` on the allowlist? Entries: `scheme://host`, `scheme://host:port`, `scheme://host:*`, or `*`. */
export function originAllowed(origin, env) {
  let o;
  try { o = new URL(origin); } catch { return false; }
  const list = String(env?.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
  const oPort = o.port || DEFAULT_PORT[o.protocol] || "";
  return list.some((pat) => {
    if (pat === "*") return true;
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/:]+)(?::(\*|\d+))?$/i.exec(pat);
    if (!m) return pat === origin;
    const [, scheme, host, port] = m;
    if (o.protocol !== `${scheme.toLowerCase()}:` || o.hostname.toLowerCase() !== host.toLowerCase()) return false;
    if (port === "*") return true;
    return oPort === (port ?? DEFAULT_PORT[o.protocol] ?? "");
  });
}

// ---------------------------------------------------------------------------
// Mirrored headers (MCP 2026-07-28, Streamable HTTP "Request Metadata")
// ---------------------------------------------------------------------------

/** A header value, with the `=?base64?…?=` sentinel decoded as UTF-8; anything undecodable stays literal. */
export function decodeHeaderValue(v) {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    const bin = atob(m[1]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return v;
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function cors(request, env) {
  const origin = request.headers.get("origin");
  if (!origin || !originAllowed(origin, env)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
const rpcError = (id, code, message, status, extra = {}) =>
  json({ jsonrpc: "2.0", id, error: { code, message } }, status, extra);

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

export async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  // Servers MUST validate Origin (both eras of the spec say so). No Origin is a
  // non-browser client and passes; an Origin off the allowlist is refused.
  if (origin && !originAllowed(origin, env)) {
    return rpcError(null, -32600, "origin not allowed", 403);
  }
  const extra = cors(request, env);

  if (url.pathname === "/") {
    return new Response(`geml MCP server ${SERVER_VERSION} — POST JSON-RPC to /mcp (MCP ${MODERN_VERSIONS.join(", ")}; ${LEGACY_VERSIONS.join(", ")} via initialize). ${README}\n`,
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8", ...extra } });
  }
  if (url.pathname !== "/mcp") return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain", ...extra } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: extra });
  if (request.method !== "POST") {
    // No SSE stream to open, no session to terminate: 405 is what both spec
    // revisions prescribe for GET and DELETE here.
    return new Response("method not allowed\n", { status: 405, headers: { allow: "POST, OPTIONS", "content-type": "text/plain", ...extra } });
  }

  // Body size, by declaration first and by measurement after.
  const max = Number(env?.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return rpcError(null, -32600, `request body exceeds ${max} bytes`, 413, extra);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > max) return rpcError(null, -32600, `request body exceeds ${max} bytes`, 413, extra);

  let msg;
  try { msg = JSON.parse(text); } catch { return rpcError(null, -32700, "parse error: the body is not JSON", 400, extra); }
  if (Array.isArray(msg)) return rpcError(null, -32600, "batching is not supported: send one JSON-RPC message per request", 400, extra);
  if (typeof msg !== "object" || msg === null) return rpcError(null, -32600, "invalid request", 400, extra);

  const version = request.headers.get("mcp-protocol-version");
  if (eraOf(msg) === "modern") {
    // The body is the source of truth; the headers mirror it so intermediaries
    // can route without parsing. A missing or disagreeing header is rejected.
    const bodyVersion = msg.params._meta["io.modelcontextprotocol/protocolVersion"];
    const mismatch = (what) => rpcError(msg.id ?? null, -32020, `Header mismatch: ${what}`, 400, extra);
    if (version === null) return mismatch("MCP-Protocol-Version header is required");
    if (version !== bodyVersion) return mismatch(`MCP-Protocol-Version header '${version}' does not match body value '${bodyVersion}'`);
    const method = request.headers.get("mcp-method");
    if (method === null) return mismatch("Mcp-Method header is required");
    if (method !== msg.method) return mismatch(`Mcp-Method header '${method}' does not match body value '${msg.method}'`);
    if (msg.method === "tools/call" && typeof msg.params?.name === "string") {
      const name = request.headers.get("mcp-name");
      if (name === null) return mismatch("Mcp-Name header is required on tools/call");
      const decoded = decodeHeaderValue(name);
      if (decoded !== msg.params.name) return mismatch(`Mcp-Name header '${decoded}' does not match body value '${msg.params.name}'`);
    }
  } else if (version !== null && !LEGACY_VERSIONS.includes(version)) {
    // A legacy client that omits the header (pre-2025-06-18) is taken as
    // 2025-03-26, as the spec allows; one that names a version we do not
    // speak is refused.
    return rpcError(msg.id ?? null, -32600, `unsupported protocol version '${version}' (this server speaks ${LEGACY_VERSIONS.join(", ")} via initialize, and ${MODERN_VERSIONS.join(", ")})`, 400, extra);
  }

  const d = dispatch(msg, tools);
  if (!d.reply) return new Response(null, { status: 202, headers: extra });
  return json(d.reply, d.status, extra);
}
```

- [ ] **Step 5: 跑测试** `cd integrations/geml-mcp-worker && node --test test/` → 全绿。Node 24 自带 `Request/Response/atob/TextDecoder`，不需要 wrangler。

- [ ] **Step 6: README.md 与 SECURITY.md**

`README.md` 内容要点（写成正文，不留 TODO）：是什么（无状态、免鉴权、9 个工具、文档随请求进出）；两种客户端怎么连（URL 占位；legacy 直连；modern 直连，`server/discover` 可用）；`curl` 三例（initialize、server/discover、geml_set）；工具面与 stdio 的差异表（`file` → `source`+`name`，无 history/revert/codemap，跨文档引用报 `unresolvable-document`）；配置：`ALLOWED_ORIGINS`、`MAX_BODY_BYTES`；限制：免费档 CPU 10 ms、106 KB 文档在 Node 热态约 12 ms，大文档需付费档；部署：`npm i && npx wrangler login && npm run deploy`，拿到子域后替换 `server.json` 的占位再发 registry；本地：`npm run dev`、`npm run check`。

`SECURITY.md`：照 `integrations/claude-plugin/SECURITY.md` 的样子指向仓库根 `SECURITY.md`，多加一段：本 Worker 不存文档、不写日志正文、Origin 白名单缺省仅 localhost。

---

### Task 3: 打包与本地冒烟

- [ ] **Step 1: dry-run 打包** `cd integrations/geml-mcp-worker && npm install && npm run check` → wrangler 打出 `.wrangler/dry/` 无错；确认 bundle 里 `spawnSync`、`readFileSync` 只剩 stub 版本（`grep -c "cdn.jsdelivr" .wrangler/dry/*.js` 可以非零，Worker 不受 CWS 约束）。
- [ ] **Step 2: 本地 dev** 在 `.claude/launch.json` 加 `{ "name": "geml-mcp-worker", "runtimeExecutable": "npx", "runtimeArgs": ["wrangler", "dev", "--config", "integrations/geml-mcp-worker/wrangler.jsonc", "--port", "8787"], "port": 8787 }`，用 preview_start 起，`curl` 打：
  - legacy：`curl -s -X POST localhost:8787/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'`
  - modern：带 `MCP-Protocol-Version: 2026-07-28`、`Mcp-Method: server/discover` 头发 `server/discover`
  - `geml_set` 一次往返，确认 `document` 返回
  输出留档到 scratchpad。
- [ ] **Step 3: `.wrangler/` 不入库** 确认根 `.gitignore` 或 Worker 自己的 `.gitignore` 盖住。

---

### Task 4: CI

**Files:** Modify `.github/workflows/ci.yml`（在 `logseq` job 后加）

- [ ] **Step 1: 加 job**
```yaml
  mcp-worker:
    name: mcp worker — tests + bundle
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "22"
      - name: Build the reference parser (the worker imports its dist/)
        working-directory: geml-parser
        run: npm ci && npm run build
      - name: Worker tests (Node drives the fetch handler directly)
        working-directory: integrations/geml-mcp-worker
        run: npm ci && npm test
      - name: The Worker bundle still builds (no account needed)
        working-directory: integrations/geml-mcp-worker
        run: npm run check
```
- [ ] **Step 2: 本地等价检查** `node integrations/test-all.mjs` 能发现新集成的 `test` 脚本（它自动扫描）。

---

### Task 5: 版本仪式与 registry 占位

**Files:** Modify 八个版本字段文件；`geml-parser/server.json`（加 `remotes`）；`CHANGELOG.md`（草稿，待批准）

- [ ] **Step 1: 八字段 1.10.3 → 1.10.4** 用脚本逐文件精确替换 `"version": "1.10.3"`（`package-lock.json` 只改前两处：根和 `packages[""]`）。
- [ ] **Step 2: server.json 加**
```json
  "remotes": [
    { "type": "streamable-http", "url": "https://geml-mcp.<subdomain>.workers.dev/mcp" }
  ]
```
  放在 `packages` 之后。占位 `<subdomain>` 部署后替换；`publish-mcp.yml` 手动触发，不会误发。
- [ ] **Step 3: 验证** `node test/mcp.test.mjs`（四个 vendor 清单与 package.json 一致的守卫）、`node -e "JSON.parse(require('fs').readFileSync('geml-parser/server.json','utf8'))"`。
- [ ] **Step 4: CHANGELOG 草稿**（写到 scratchpad，报告里给 diff，批准后落）：在 `## [Unreleased]` 下追加三条 —— MCP server 进程内执行、不再起子进程；stdio 与 Worker 共用 `mcp-core`，支持 MCP 2026-07-28 的 `server/discover` 与按请求 `_meta`，旧客户端不受影响；新增 `integrations/geml-mcp-worker` 无状态远端 server。并说明是否把 `[Unreleased]` 切成 `## [1.10.4] - 2026-09-14` 由用户定（同一块里还有 tree-sitter / Scala 条目）。

---

### Task 6: 文档草稿（批准门）

- [ ] **Step 1: PUBLISHING.geml `#a-worker`**（EN，写到 scratchpad）按 `#a-action` 的五段式：Lands at（`https://geml-mcp.<subdomain>.workers.dev/mcp` + registry 的 `remotes`）· Version（`integrations/geml-mcp-worker/package.json`，独立于 parser；bundle 的 parser 随构建时的 dist）· How（`npm run deploy`，前置 Cloudflare 账号 + `wrangler login`；部署后把 server.json 占位换成真实子域，再 Actions → Publish MCP Server）· Watch for（免费档 10 ms CPU；`compatibility_date` 不得超过本地 wrangler 的 workerd；占位未替换前不要发 registry）· Confirm（`curl` initialize 与 `server/discover`；registry 条目里 `remotes` 可连）。
- [ ] **Step 2: PUBLISHING_CN.geml 对应节**（中文）同结构。
- [ ] **Step 3: README 一句**：在 `### MCP Server` 节末尾加「远端：`https://geml-mcp.<subdomain>.workers.dev/mcp`，无状态，文档随调用传入 —— 见 integrations/geml-mcp-worker」。
- [ ] **Step 4: `docs/PUBLISHING.md` 由 `--to md` 再生**（批准落 `.geml` 之后）。

---

### Task 7: 全量验证与收尾

- [ ] **Step 1:** `cd geml-parser && npm run coverage:check` 跑一次，取 exit code 与末尾表格。
- [ ] **Step 2:** `cd integrations/geml-mcp-worker && npm test && npm run check` 各一次。
- [ ] **Step 3:** 更新设计文档状态行为「§3、§5、Worker 已实现；文档草稿待批准」。
- [ ] **Step 4:** 报告：改动清单、测试证据、待批准的三份文案 diff、部署后要做的两步（替换占位、发 registry）。
