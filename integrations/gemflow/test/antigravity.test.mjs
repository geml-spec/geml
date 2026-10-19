// The Antigravity editor's adapter (src/antigravity.ts): its transcript read for the prompt and the answer, its hook
// events into the project's shared session record, the install, and the MCP server finding the project the hooks saw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeOf, answerOf, installAntigravity, promptsAfter, requestOf, runAntigravity } from "../dist/antigravity.js";
import { logName, parseLog } from "../dist/core/session-log.js";
import { recordDecisions, recordPrompt, sessionsDirOf } from "../dist/session-store.js";
import { BUNDLE, gitRepo } from "./helpers/repo.mjs";

const step = (i, type, extra) => JSON.stringify({ step_index: i, source: type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL", type, status: "DONE", created_at: "2026-10-19T05:55:51Z", ...extra });
const ask = (i, text) => step(i, "USER_INPUT", { content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-19T13:55:51+08:00.\n</ADDITIONAL_METADATA>` });

test("the transcript: the prompt inside <USER_REQUEST>, the prompts after a step, the turn's answer the last model words since the prompt", () => {
  assert.equal(requestOf("<USER_REQUEST>\n列一下文件\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"), "列一下文件");
  assert.equal(requestOf("  plain  "), "plain");
  const steps = [ask(0, "第一句"), step(1, "PLANNER_RESPONSE", { tool_calls: [{ name: "run_command", args: {} }] }), step(2, "GENERIC", { content: "output" }), step(3, "PLANNER_RESPONSE", { content: "答第一句" }), ask(4, "第二句"), step(5, "PLANNER_RESPONSE", { content: "答第二句" })].map((l) => JSON.parse(l));
  assert.deepEqual(promptsAfter(steps, -1).map((p) => [p.step, p.text]), [[0, "第一句"], [4, "第二句"]]);
  assert.deepEqual(promptsAfter(steps, 0).map((p) => p.step), [4]);
  assert.equal(answerOf(steps), "答第二句");
  assert.equal(answerOf(steps.slice(0, 3)), "", "no words since the prompt yet");
});

test("the hooks into the project's record: a session's log and its note tool told; a prompt as a turn with the other sessions' decisions beside it; a file, a commit and the answer", () => {
  const home = mkdtempSync(join(tmpdir(), "gemflow-agy-home-"));
  const root = gitRepo();
  const transcript = join(home, "transcript_full.jsonl");
  const ev = (extra = {}) => JSON.stringify({ conversationId: "conv-1", workspacePaths: [root.split("\\").join("/")], transcriptPath: transcript, modelName: "m", ...extra });
  const log = () => parseLog(readFileSync(join(sessionsDirOf(root), logName("antigravity", "conv-1")), "utf8"));

  const start = JSON.parse(runAntigravity("SessionStart", ev(), home).stdout);
  assert.match(start.injectSteps[0].systemMessage.systemMessage, /`note` tool of the gemflow MCP server/);
  assert.deepEqual(log().map((e) => [e.t, e.host]), [["session", "antigravity"]]);
  assert.deepEqual(activeOf(home), { conversationId: "conv-1", root, at: activeOf(home).at }, "the pointer the MCP server reads");

  recordPrompt(root, "codex", "cx1", "问一句");
  recordDecisions(root, "codex", "cx1", ["合并前先跑三平台 CI"]);
  writeFileSync(transcript, `${ask(0, "接 Antigravity")}\n`);
  const pre = JSON.parse(runAntigravity("PreInvocation", ev({ invocationNum: 0 }), home).stdout);
  assert.match(pre.injectSteps[0].ephemeralMessage, /- 合并前先跑三平台 CI（Codex · feat\/x，\d\d:\d\d）/);
  assert.equal(runAntigravity("PreInvocation", ev({ invocationNum: 1 }), home).stdout, "", "the same prompt again: nothing new");

  runAntigravity("PostToolUse", ev({ toolCall: { name: "write_to_file", args: { TargetFile: join(root, "src", "agy.ts") } }, error: "" }), home);
  runAntigravity("PostToolUse", ev({ toolCall: { name: "write_to_file", args: { TargetFile: join(tmpdir(), "elsewhere.ts") } }, error: "" }), home);
  writeFileSync(join(root, "agy.txt"), "x");
  spawnSync("git", ["-C", root, "add", "agy.txt"]);
  spawnSync("git", ["-C", root, "commit", "-q", "-m", "agy commit"], { env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() + 60_000).toISOString() } });
  runAntigravity("PostToolUse", ev({ toolCall: { name: "run_command", args: { CommandLine: "git commit -m 'agy commit'", Cwd: root } }, error: "" }), home);
  writeFileSync(transcript, `${ask(0, "接 Antigravity")}\n${step(1, "PLANNER_RESPONSE", { content: "接好了。" })}\n`);
  runAntigravity("Stop", ev({ fullyIdle: true, terminationReason: "NO_TOOL_CALL", error: "" }), home);
  assert.deepEqual(log().map((e) => [e.t, e.text ?? e.path ?? e.subject ?? e.host]), [
    ["session", "antigravity"], ["prompt", "接 Antigravity"], ["file", "src/agy.ts"], ["answer", "接好了。"], ["commit", "agy commit"],
  ], "a file outside the project is not the project's");
  assert.equal(runAntigravity("Stop", "not json", home).stdout, "");
});

test("install: the adapter's hooks under its own name in the global hooks file, the probe taken out and every other hook kept; the MCP server added beside the others", () => {
  const home = mkdtempSync(join(tmpdir(), "gemflow-agy-home-"));
  const dir = join(home, ".gemini", "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hooks.json"), JSON.stringify({ "gemflow-probe": { Stop: [] }, "my-linter": { PostToolUse: [] } }));
  writeFileSync(join(dir, "mcp_config.json"), JSON.stringify({ mcpServers: { pencil: { command: "p" } } }));
  installAntigravity("/opt/gemflow/dist/gemflow.mjs", home);
  const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks).sort(), ["gemflow", "my-linter"]);
  assert.deepEqual(Object.keys(hooks.gemflow), ["SessionStart", "PreInvocation", "PostToolUse", "Stop"]);
  assert.equal(hooks.gemflow.Stop[0].command, "node /opt/gemflow/dist/gemflow.mjs antigravity Stop", "no quotes: Antigravity passes them on as they are");
  const mcp = JSON.parse(readFileSync(join(dir, "mcp_config.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ["gemflow", "pencil"]);
  assert.deepEqual(mcp.mcpServers.gemflow.args, ["/opt/gemflow/dist/gemflow.mjs", "mcp", "--host", "antigravity"]);
});

test("the MCP server for Antigravity, started outside the project: note writes to the conversation the hooks last saw, in its project", () => {
  const home = mkdtempSync(join(tmpdir(), "gemflow-agy-home-"));
  const root = gitRepo();
  runAntigravity("SessionStart", JSON.stringify({ conversationId: "conv-9", workspacePaths: [root], transcriptPath: join(home, "t.jsonl") }), home);
  const r = spawnSync(process.execPath, [BUNDLE, "mcp", "--host", "antigravity"], {
    cwd: tmpdir(), encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: home, USERPROFILE: home },
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "note", arguments: { decisions: ["Antigravity 也记进来"] } } })}\n`,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout.trim()).result.content[0].text, /^Recorded 1 decision/);
  const e = parseLog(readFileSync(join(sessionsDirOf(root), logName("antigravity", "conv-9")), "utf8"));
  assert.deepEqual(e.filter((x) => x.t === "decision").map((x) => x.text), ["Antigravity 也记进来"]);
});
