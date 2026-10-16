import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE, fakeGh, gitRepo, withWorkflow } from "./helpers/repo.mjs";
import { flowDoc } from "./helpers/flow.mjs";

const WS_DEV = fileURLToPath(new URL("./fixtures/ws-dev/", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Drive `gemflow mcp` over stdio: each message (an object, or a raw string for a malformed line) on its own line; the answers in order, and by id. */
function serve(root, messages, args = [], { env = {}, bundle = BUNDLE, cwd = root } = {}) {
  const lines = messages.map((m) => (typeof m === "string" ? m : JSON.stringify(m)));
  const r = spawnSync(process.execPath, [bundle, "mcp", ...args], {
    cwd, input: `${lines.join("\n")}\n`, encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  const replies = r.stdout.trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
  return { replies, byId: new Map(replies.map((m) => [m.id, m])), stderr: r.stderr };
}
const mcp = (root, messages, args = [], opts) => serve(root, messages, args, opts).byId;
/** The line every stage text from this server ends with: this host shows Gemflow no tool calls. */
const NOTE = "(this host shows Gemflow no tool calls: nothing is refused here, and a variable whose source is a tool is never written — tell the person what you ran, so they can tick a variable the guard accepts)";
const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
/** A workflow named `name` installed in the project and made the default. */
function install(root, name, text) {
  mkdirSync(join(root, ".geml", "workflows", name), { recursive: true });
  writeFileSync(join(root, ".geml", "workflows", name, "flow.geml"), text);
  writeFileSync(join(root, ".geml", "gemflow.geml"), `=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "${name}"\n===\n`);
}

test("gemflow mcp: the handshake, the three tools, verbs over the project's workspace, errors by code", () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  const out = mcp(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    call(3, "status"),
    call(4, "set", { "review-ready": true }),
    call(5, "move", { to: "done" }),
    call(6, "geml_get"),
    { jsonrpc: "2.0", id: 7, method: "resources/list" },
  ], ["--host", "codex"]);
  assert.equal(out.size, 7, "a notification gets no answer");
  assert.equal(out.get(1).result.serverInfo.name, "gemflow");
  assert.equal(out.get(1).result.protocolVersion, "2025-06-18");
  assert.deepEqual(out.get(2).result.tools.map((t) => t.name), ["status", "move", "set"]);
  const status = out.get(3).result.content[0].text;
  assert.match(status, /work item feat\/x · state build/);
  assert.match(status, /\n\n\[gemflow\] stage build/, "the stage text follows the status");
  assert.ok(status.endsWith(`\n\n${NOTE}`), "and ends with the note");
  assert.equal(out.get(4).result.isError, true);
  assert.match(out.get(4).result.content[0].text, /^refused: "review-ready" is evidence/);
  assert.deepEqual(out.get(5).result, { content: [{ type: "text", text: "refused: no transition build→done" }], isError: true });
  assert.equal(out.get(6).error.code, -32602);
  assert.equal(out.get(7).error.code, -32601);
});

test("gemflow mcp in a project with no workflow says so in the tool result", () => {
  const out = mcp(gitRepo(), [call(1, "status")]);
  assert.equal(out.get(1).result.isError, true);
  assert.match(out.get(1).result.content[0].text, /no workflow here/);
});

test("the skill tells MCP-only hosts to read the stage every turn, that tool evidence is never written there, and to leave a person's verbs alone", () => {
  const skill = readFileSync(new URL("../skills/gemflow-mcp/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^---\r?\nname: gemflow-mcp\r?\n/); // a Windows checkout may turn the newlines into CRLF
  for (const needle of [".geml/context.geml", "`status`", "`move`", "`set`", "gemflow advance", "@geml/gemflow mcp", "shows Gemflow no tool calls", "tools.geml"]) assert.ok(skill.includes(needle), needle);
  assert.doesNotMatch(skill, /flow_status|flow_context|flow_transition|only-in|signal/);
  assert.match(skill, /guard holds for a person's `gemflow advance`/, "a guard holds for a person's advance too");
});

test("ping, protocol negotiation, a malformed line, a request with no method, and tool arguments that are not an object", () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  const { replies, byId } = serve(root, [
    { jsonrpc: "2.0", id: "a", method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    { jsonrpc: "2.0", id: 3, method: "initialize" },
    "{ this is not json",
    "",
    { jsonrpc: "2.0", id: 4 },
    [1, 2],
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "status", arguments: [1] } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: {} },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    { jsonrpc: "2.0", id: 7, method: "ping" },
  ]);
  assert.deepEqual(byId.get("a"), { jsonrpc: "2.0", id: "a", result: {} });
  assert.equal(byId.get(2).result.protocolVersion, "2025-11-25", "a version it does not know is answered with the newest it speaks");
  assert.deepEqual(byId.get(2).result.capabilities, { tools: {} });
  assert.equal(byId.get(3).result.protocolVersion, "2025-11-25");
  const parse = replies.find((m) => m.error?.code === -32700);
  assert.deepEqual(parse, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  assert.equal(byId.get(4).error.code, -32600);
  assert.equal(replies.filter((m) => m.error?.code === -32600).length, 2, "a batch array and a request with no method are invalid requests");
  assert.match(byId.get(5).result.content[0].text, /work item feat\/x/, "arguments that are not an object are no arguments");
  assert.equal(byId.get(6).error.code, -32602);
  assert.deepEqual(byId.get(7), { jsonrpc: "2.0", id: 7, result: {} }, "the server kept going after every bad line");
  assert.equal(replies.length, 9, "the blank line and the notification get no answer");
});

test("tools/list carries each tool's name, description and input schema, and nothing else", () => {
  const out = mcp(gitRepo(), [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  const [status, move, set] = out.get(1).result.tools;
  assert.deepEqual(Object.keys(status).sort(), ["description", "inputSchema", "name"]);
  assert.deepEqual(move.inputSchema.required, ["to"]);
  assert.equal(set.inputSchema.additionalProperties, true);
});

const GO = flowDoc({
  initial: "build",
  states: { build: { description: "Write the code.", prompt: "./guide.geml#build" }, review: { description: "Handle the review.", prompt: "./guide.geml#review" } },
  transitions: [{ from: "build", to: "review", guard: "the code is ready for review", note: "Ready for review." }],
});

test("a verb that changes the stage appends the new #current text, with the note; the next status says the same", () => {
  const root = gitRepo();
  install(root, "go", GO);
  writeFileSync(join(root, ".geml", "workflows", "go", "guide.geml"), '=== meta\ntitle = "Guide"\n===\n\n# Build {#build}\n\nRun the tests.\n\n# Review {#review}\n\nAnswer every comment before you ask again.\n');
  const out = mcp(root, [call(1, "status"), call(2, "move", { to: "review" }), call(3, "status"), call(4, "set", {})]);
  const before = out.get(1).result.content[0].text;
  assert.match(before, /\[gemflow\] stage build/);
  assert.match(before, /Run the tests\./);
  assert.equal(before.split(NOTE).length, 2, "the note once");
  const moved = out.get(2).result;
  assert.equal(moved.isError, undefined);
  assert.match(moved.content[0].text, /^\{/, "the result begins with the verb's own answer");
  assert.match(moved.content[0].text, /\n\n\[gemflow\] stage review · rev 1\n/, "and carries the new stage text");
  assert.match(moved.content[0].text, /Answer every comment/);
  assert.ok(moved.content[0].text.endsWith(`\n\n${NOTE}`), "which ends with the note");
  const after = out.get(3).result.content[0].text;
  assert.match(after, /state review/);
  assert.match(after, /Answer every comment/);
  assert.equal(after.split("[gemflow] stage review").length, 2, "the stage text once");
  const set = out.get(4).result.content[0].text;
  assert.match(set, /^\{/);
  assert.ok(!set.includes(NOTE), "a verb that leaves the stage as it was carries no stage text, so no note");
});

test("a throw inside a call is an error result, one line, and the server answers the next message", () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  // a directory where the journal should be: reading it throws EISDIR out of openWorkspace
  mkdirSync(join(root, ".geml", "journals", "feat", "x.geml"), { recursive: true });
  const out = mcp(root, [call(1, "status"), { jsonrpc: "2.0", id: 2, method: "ping" }]);
  assert.equal(out.get(1).result.isError, true);
  const text = out.get(1).result.content[0].text;
  assert.match(text, /^gemflow: /);
  assert.equal(text.split("\n").length, 1);
  assert.deepEqual(out.get(2).result, {});
});

test("an unknown host, or a name that is on every object, gets no tools and still serves", () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  for (const host of ["codex", "toString", "__proto__", "constructor", "hasOwnProperty"]) {
    const out = mcp(root, [call(1, "status")], ["--host", host]);
    assert.match(out.get(1).result.content[0].text, /work item feat\/x · state build/, host);
  }
  const claude = mcp(root, [call(1, "status")], ["--host", "claude"]);
  assert.match(claude.get(1).result.content[0].text, /state build/);
  const dflt = mcp(root, [call(1, "status")]);
  assert.match(dflt.get(1).result.content[0].text, /state build/, "--host defaults to mcp");
});

test("--root names the project, wherever the server is started", () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  const elsewhere = mkdtempSync(join(tmpdir(), "gemflow-mcp-cwd-"));
  const out = mcp(root, [call(1, "status")], ["--root", root], { cwd: elsewhere });
  assert.match(out.get(1).result.content[0].text, /work item feat\/x · state build/);
});

test("a misspelt option or a stray argument is a usage error, not a server", () => {
  for (const [args, said] of [[["--hots", "codex"], /^gemflow mcp: unknown option --hots/], [["extra"], /^usage: gemflow /], [["--host"], /^--host needs a value/]]) {
    const r = spawnSync(process.execPath, [BUNDLE, "mcp", ...args], { input: "", encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, said);
  }
});

test("the server reads its version when asked, so the bundle answers on its own", () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
  assert.equal(mcp(root, [init]).get(1).result.serverInfo.version, VERSION);
  const alone = mkdtempSync(join(tmpdir(), "gemflow-mcp-bundle-"));
  copyFileSync(BUNDLE, join(alone, "gemflow.mjs"));
  const out = mcp(root, [init, call(2, "status")], [], { bundle: join(alone, "gemflow.mjs") });
  assert.equal(out.get(1).result.serverInfo.version, "unknown");
  assert.match(out.get(2).result.content[0].text, /state build/);
});

/** A gh stand-in that logs each call and answers an empty list. */
function loggingGh() {
  const dir = mkdtempSync(join(tmpdir(), "gemflow-mcp-gh-"));
  const bin = join(dir, "gh.cjs"); // run with Node, on Windows too
  const log = join(dir, "calls.log");
  writeFileSync(bin, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.stdout.write("[]\\n");\n`);
  chmodSync(bin, 0o755);
  const calls = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
  return { env: { GEMFLOW_GH: bin }, calls };
}

test("gh is asked only when a variable of the workflow reads it, and only by status", () => {
  const gh = loggingGh();
  const plain = gitRepo();
  install(plain, "p", flowDoc({ initial: "build", states: { build: { tools: ["test"] } }, vars: { "tests-pass": { default: false, source: { tool: "test" } } } }));
  mcp(plain, [call(1, "status"), call(2, "set", {})], [], { env: gh.env });
  assert.deepEqual(gh.calls(), [], "no variable reads gh, so nothing asks it");

  const reads = gitRepo();
  withWorkflow(reads, WS_DEV, "dev");
  mcp(reads, [call(1, "set", {})], [], { env: gh.env });
  assert.deepEqual(gh.calls(), [], "a verb that reads no status never asks gh either");
  mcp(reads, [call(1, "status")], [], { env: gh.env });
  assert.equal(gh.calls().filter((c) => c.startsWith("pr list")).length, 1, "status asks once per call");
});

test("status reads git and the file variables afresh first: a merged PR moves the stage, and the answer reports the new one", () => {
  const root = gitRepo();
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "dev"], { cwd: root, encoding: "utf8" }).status, 0);
  const gh = fakeGh();
  gh.set({ pr: "MERGED", runs: [{ name: "ci", conclusion: "success" }] });
  const out = mcp(root, [call(1, "status"), call(2, "status")], ["--host", "codex"], { env: gh.env });
  const first = out.get(1).result.content[0].text;
  assert.match(first, /work item feat\/x · state deploy/);
  assert.match(first, /\n\n\[gemflow\] stage deploy/, "the stage changed under this call: its text follows the status");
  assert.ok(first.endsWith(`\n\n${NOTE}`), "and carries the note");
  assert.match(out.get(2).result.content[0].text, /state deploy/);
});

test("status on an MCP-only host reads a file variable written since the last call", () => {
  const root = gitRepo();
  install(root, "f", flowDoc({
    initial: "write", states: { write: { description: "Write the doc." }, done: { description: "Done." } },
    vars: { "has-doc": { default: false, source: { file: "docs/*.md" } } },
    transitions: [{ from: "write", to: "done", guard: { properties: { "has-doc": { const: true } } }, note: "The doc exists." }],
  }));
  assert.match(mcp(root, [call(1, "status")]).get(1).result.content[0].text, /state write/);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "a.md"), "# A\n");
  assert.match(mcp(root, [call(1, "status")]).get(1).result.content[0].text, /state done/);
});
