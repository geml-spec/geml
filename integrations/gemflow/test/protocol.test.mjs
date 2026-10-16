import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, decodeRequest, decodeResponse, encodeRequest, unreadableText } from "../dist/hosts/claude-code/protocol.js";

test("requests: one JSON line; the CLI refuses what it cannot run", () => {
  const req = { v: 1, root: "/r", op: "before", tool: "Bash", callId: "c1", input: { command: "ls" }, cwd: "/r/sub" };
  assert.equal(encodeRequest(req), `${JSON.stringify(req)}\n`);
  assert.deepEqual(decodeRequest(encodeRequest(req)), req);
  assert.deepEqual(decodeRequest("nope"), { error: "the request is not JSON" });
  assert.deepEqual(decodeRequest('{"v":2,"root":"/r","op":"status"}'), { error: "protocol version 2; this CLI speaks 1" });
  assert.deepEqual(decodeRequest('{"v":1,"op":"status"}'), { error: "root is required" });
  assert.deepEqual(decodeRequest('{"v":1,"root":"/r","op":"nope"}'), { error: "unknown op nope" });
  assert.deepEqual(decodeRequest('{"v":1,"root":"/r","op":"before","tool":"Bash"}'), { error: "op before: missing or mistyped fields" });
  assert.deepEqual(decodeRequest('{"v":1,"root":"/r","op":"verb","name":"rm","args":{}}'), { error: "op verb: missing or mistyped fields" });
});

test("before and after carry the directory the call starts in; one that has none starts at the root", () => {
  const before = { v: 1, root: "/r", op: "before", tool: "Bash", callId: "c1", input: { command: "ls" }, cwd: "/r/.claude/worktrees/w" };
  assert.deepEqual(decodeRequest(encodeRequest(before)), before);
  const after = { v: 1, root: "/r", op: "after", tool: "Bash", callId: "c1", input: { command: "ls" }, isError: false, exitCode: 0, gitOperation: false, cwd: "/r/sub" };
  assert.deepEqual(decodeRequest(encodeRequest(after)), after);
  const { cwd: _b, ...bare } = before;
  assert.deepEqual(decodeRequest(JSON.stringify(bare)), { ...bare, cwd: "/r" });
  const { cwd: _a, ...plain } = after;
  assert.deepEqual(decodeRequest(JSON.stringify(plain)), { ...plain, cwd: "/r" });
  assert.equal(decodeRequest(JSON.stringify({ v: 1, root: "/r", op: "status" })).cwd, undefined, "only a tool call starts somewhere");
  for (const cwd of [42, "", null]) {
    assert.deepEqual(decodeRequest(JSON.stringify({ ...before, cwd })), { error: "op before: missing or mistyped fields" }, JSON.stringify(cwd));
    assert.deepEqual(decodeRequest(JSON.stringify({ ...after, cwd })), { error: "op after: missing or mistyped fields" }, JSON.stringify(cwd));
  }
});

test("answers: the last line that parses as this protocol's version", () => {
  const ok = { v: PROTOCOL_VERSION, ok: true, shell: { status: null, policy: null, contextKey: null } };
  assert.deepEqual(decodeResponse(`noise\n${JSON.stringify(ok)}\n`), ok);
  assert.equal(decodeResponse('{"v":9,"ok":true}\n'), undefined);
  assert.equal(decodeResponse(""), undefined);
});

test("an answer that did not parse: stderr's error line, and the build to run when a module is missing", () => {
  const missing = "node:internal/modules/cjs/loader:1479\n  throw err;\n  ^\n\nError: Cannot find module '/plugin/dist/gemflow.mjs'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1476:15)\n";
  assert.equal(unreadableText(1, missing, "/plugin"),
    "gemflow：桥接没有构建 — 在 /plugin 运行 npm run build（Error: Cannot find module '/plugin/dist/gemflow.mjs'）");
  assert.equal(unreadableText(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@geml/geml' imported from /plugin/dist/gemflow.mjs\n", "/plugin"),
    "gemflow：桥接没有构建 — 在 /plugin 运行 npm run build（Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@geml/geml' imported from /plugin/dist/gemflow.mjs）");
  assert.equal(unreadableText(1, "file:///plugin/dist/gemflow.mjs:3\n    at x\nTypeError: x is not a function\n", "/plugin"),
    "gemflow：桥接的应答无法解析（退出码 1：TypeError: x is not a function）");
  assert.equal(unreadableText(134, "Aborted\n", "/plugin"), "gemflow：桥接的应答无法解析（退出码 134：Aborted）", "no error line: the first line");
  assert.equal(unreadableText(0, "", "/plugin"), "gemflow：桥接的应答无法解析（退出码 0）");
});
