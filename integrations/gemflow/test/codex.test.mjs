// The Codex adapter: the pure reading and answering of Codex's hook events
// (src/hosts/codex/hook.ts), then `gemflow codex` through the bundle in a
// project with the dev workflow, event by event in the order Codex raises them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_TOOLS, HOST_TOOLS } from "../dist/core/host-tools.js";
import { allowCall, callOf, denyCall, exitCodeIn, isWrapped, patchPaths, readEvent, unwrapCommand, wrapCommand } from "../dist/hosts/codex/hook.js";
import { BUNDLE, fakeGh, gitRepo, hook, withWorkflow } from "./helpers/repo.mjs";

const WS_DEV = fileURLToPath(new URL("./fixtures/ws-dev/", import.meta.url));
const here = new URL(".", import.meta.url);

/** One Codex hook event through the bundle: the answer parsed, or undefined when the adapter said nothing. */
function codex(root, event, env = {}) {
  const r = spawnSync(process.execPath, [BUNDLE, "codex"], {
    cwd: root, input: JSON.stringify({ session_id: "sess-1", cwd: root, ...event }), encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000,
  });
  assert.equal(r.status, 0, `codex exit ${r.status}: ${r.stderr}`);
  return { out: r.stdout.trim() === "" ? undefined : JSON.parse(r.stdout), err: r.stderr };
}
const project = () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  return root;
};
const data = () => ({ PLUGIN_DATA: mkdtempSync(join(tmpdir(), "gemflow-codex-data-")) });

test("Codex's tools: Bash runs, apply_patch writes; the event is read from JSON with a hook_event_name", () => {
  assert.deepEqual(CODEX_TOOLS, { run: ["Bash"], write: ["apply_patch"] });
  assert.equal(HOST_TOOLS.codex, CODEX_TOOLS);
  assert.equal(readEvent("not json"), undefined);
  assert.equal(readEvent('{"session_id":"s"}'), undefined, "no event name: no event");
  assert.deepEqual(readEvent('{"hook_event_name":"PreToolUse","session_id":"s","cwd":"/p","tool_name":"Bash","tool_use_id":"c1","tool_input":{"command":"ls"},"extra":1}'), {
    hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "ls" },
  });
});

test("a wrapped command prints its own exit status last and exits with it; the status is read back from any shape of response, the last marker winning", () => {
  const wrapped = wrapCommand("npm test");
  assert.equal(wrapped, `( npm test ); __gemflow_status=$?; printf '\\n[gemflow exit %s]\\n' "$__gemflow_status"; exit $__gemflow_status`);
  assert.equal(isWrapped(wrapped), true);
  assert.equal(isWrapped("npm test"), false);
  assert.equal(unwrapCommand(wrapped), "npm test");
  assert.equal(unwrapCommand(wrapCommand("npm test && npm run lint\n# two lines")), "npm test && npm run lint\n# two lines");
  assert.equal(unwrapCommand("npm test"), "npm test", "not wrapped: itself");
  const sh = spawnSync("sh", ["-c", wrapCommand("echo hi; exit 3")], { encoding: "utf8" });
  assert.equal(sh.status, 3, "the host still sees the command's own status");
  assert.equal(sh.stdout, "hi\n\n[gemflow exit 3]\n");
  assert.equal(exitCodeIn("ok\n[gemflow exit 0]\n"), 0);
  assert.equal(exitCodeIn({ output: "...\n[gemflow exit 2]\n", metadata: { exit_code: 7 } }), 2, "the marker, never a field a host might or might not add");
  assert.equal(exitCodeIn([{ type: "text", text: "[gemflow exit 1]" }, { type: "text", text: "[gemflow exit 0]" }]), 0, "the last marker");
  assert.equal(exitCodeIn("no marker here"), null);
  assert.equal(exitCodeIn(undefined), null);
});

test("apply_patch names its files and carries no command line: a patch mentioning a fenced command is never scanned as one", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-wrangler deploy\n+gemflow mark done\n*** Add File: docs/new.md\n+hello\n*** Delete File: old.txt\n*** End Patch\n";
  assert.deepEqual(patchPaths(patch), ["src/a.ts", "docs/new.md", "old.txt"]);
  assert.deepEqual(callOf("apply_patch", { command: patch }), { tool: "apply_patch", input: { files: ["src/a.ts", "docs/new.md", "old.txt"] } });
  assert.deepEqual(callOf("Bash", { command: "ls" }), { tool: "Bash", input: { command: "ls" } });
});

test("the answers: a refusal, a rewrite, a note, nothing", () => {
  assert.deepEqual(denyCall("x is for a person"), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "gemflow: x is for a person" } });
  assert.deepEqual(allowCall({ command: "c" }), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "c" } } });
  assert.deepEqual(allowCall(undefined, "note"), { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "note" } });
  assert.equal(allowCall(), undefined);
});

test("the plugin's Codex files: the manifest keeps the package's version and points at the skills, the MCP server and the hooks; every hook runs the bundle", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", here), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../.codex-plugin/plugin.json", here), "utf8"));
  assert.equal(manifest.name, "gemflow");
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual([manifest.skills, manifest.mcpServers, manifest.hooks], ["./skills/", "./codex/mcp.json", "./codex/hooks.json"]);
  const hooks = JSON.parse(readFileSync(new URL("../codex/hooks.json", here), "utf8")).hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
  for (const [event, groups] of Object.entries(hooks)) for (const g of groups) for (const h of g.hooks) assert.equal(h.command, 'node "${PLUGIN_ROOT}/dist/gemflow.mjs" codex', event);
  const mcp = JSON.parse(readFileSync(new URL("../codex/mcp.json", here), "utf8"));
  // A hook's command has ${PLUGIN_ROOT} filled in; a server's arguments do not (0.149.0), so the server starts in the plugin's directory and each call names the project.
  assert.deepEqual(mcp.mcpServers.gemflow, { command: "node", args: ["./dist/gemflow.mjs", "mcp", "--host", "codex"], cwd: "." });
  for (const f of [".codex-plugin/plugin.json", "codex", ".codexignore"]) assert.ok(pkg.files.includes(f), `${f} ships`);
  assert.doesNotMatch(readFileSync(new URL("../.codexignore", here), "utf8"), /^dist\/?$/m, "the bundle is what the install runs");
  const market = JSON.parse(readFileSync(new URL("../../../.agents/plugins/marketplace.json", here), "utf8"));
  assert.deepEqual(market.plugins.find((p) => p.name === "gemflow").source, { source: "local", path: "./integrations/gemflow" });
});

test("gemflow codex, in event order: the stage at the start, a refused command, a wrapped test run whose status moves the stage, the new stage reaching the model once", () => {
  const root = project();
  const gh = fakeGh();
  gh.set({ pr: "OPEN" });
  const env = { ...gh.env, ...data() };
  // SessionStart: the stage text, after the git facts were read.
  const start = codex(root, { hook_event_name: "SessionStart", source: "startup" }, env);
  assert.equal(start.out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(start.out.hookSpecificOutput.additionalContext, /^\[gemflow\] stage build · rev 0/m);
  // The same stage again: the model has read it.
  assert.equal(codex(root, { hook_event_name: "UserPromptSubmit", prompt: "hi" }, env).out, undefined);
  // A person's command, and a use fenced to another state: refused with the reason.
  const person = codex(root, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "gemflow mark reviewed" } }, env);
  assert.equal(person.out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(person.out.hookSpecificOutput.permissionDecisionReason, /^gemflow: .*for a person/);
  const fenced = codex(root, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c2", tool_input: { command: "npx wrangler deploy --env production" } }, env);
  assert.match(fenced.out.hookSpecificOutput.permissionDecisionReason, /is deploy-prod, which is used only in #release; the workflow is in #build/);
  assert.equal(hook(root, { op: "status" }, env).shell.status.refusals, 2, "both refusals recorded");
  // A read tool the dictionary allows everywhere, and a tool no row takes: through, with nothing to say.
  assert.equal(codex(root, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "c3", tool_input: { file_path: "README.md" } }, env).out, undefined);
  assert.equal(codex(root, { hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_use_id: "c4", tool_input: { url: "https://x" } }, env).out, undefined);
  // A patch whose text mentions a fenced command: paths, not a command line.
  assert.equal(codex(root, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "c5", tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n+npx wrangler deploy\n*** End Patch" } }, env).out, undefined);
  // The test command's status is evidence: the call is rewritten to print it.
  const run = codex(root, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c6", tool_input: { command: "npm test" } }, env);
  const windows = process.platform === "win32";
  if (windows) assert.equal(run.out, undefined, "the wrapper is POSIX shell: on Windows the command runs as it is, and its status stays unknown");
  else {
    assert.equal(run.out.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(run.out.hookSpecificOutput.updatedInput.command, wrapCommand("npm test"));
  }
  // It ran and passed: tests-pass and the open PR take the workflow to review; the model hears of the new stage here, and not again at the next prompt.
  // (Codex reports the command as it ran it: wrapped. The marker is read wherever it appears, so the Windows run feeds one by hand.)
  const ran = codex(root, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "c6", tool_input: { command: windows ? "npm test" : wrapCommand("npm test") }, tool_response: "> test\nall green\n\n[gemflow exit 0]\n" }, env);
  assert.equal(ran.out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(ran.out.hookSpecificOutput.additionalContext, /^\[gemflow\] stage review · rev \d/m);
  const status = hook(root, { op: "status" }, env);
  assert.equal(status.shell.status.state.id, "review");
  assert.equal(status.shell.status.vars["tests-pass"], true);
  assert.equal(codex(root, { hook_event_name: "UserPromptSubmit", prompt: "next" }, env).out, undefined, "already delivered with the result");
  // A result with no marker says nothing about the status: no evidence, nothing to tell.
  assert.equal(codex(root, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "c7", tool_input: { command: "ls" }, tool_response: "a\nb\n" }, env).out, undefined);
});

test("gemflow codex says nothing, and exits 0, where there is nothing to say: no workflow, an event it does not read, no event at all", () => {
  const bare = gitRepo();
  const env = data();
  assert.equal(codex(bare, { hook_event_name: "SessionStart", source: "startup" }, env).out, undefined);
  assert.equal(codex(bare, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "gemflow mark x" } }, env).out, undefined, "no workflow: nothing is refused");
  const root = project();
  assert.equal(codex(root, { hook_event_name: "Stop", stop_hook_active: false }, env).out, undefined);
  assert.equal(codex(root, { hook_event_name: "PreToolUse", tool_name: "mcp__gemflow__status", tool_use_id: "c2", tool_input: {} }, env).out, undefined, "its own tool");
  const r = spawnSync(process.execPath, [BUNDLE, "codex"], { cwd: root, input: "not json", encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.ok(!existsSync(join(env.PLUGIN_DATA, "sess-1.json")), "nothing delivered, nothing kept");
});

test("the project's session record through Codex's hooks: the session opens a log, a prompt is a turn with the other sessions' new decisions beside it, a patch's file and the turn's answer go in", async () => {
  const { logName, parseLog } = await import("../dist/core/session-log.js");
  const { recordDecisions, recordPrompt, sessionsDirOf } = await import("../dist/session-store.js");
  const root = project();
  const env = data();
  const log = () => parseLog(readFileSync(join(sessionsDirOf(root), logName("codex", "sess-1")), "utf8"));
  codex(root, { hook_event_name: "SessionStart", source: "startup" }, env);
  assert.deepEqual(log().map((e) => [e.t, e.host]), [["session", "codex"]]);
  recordPrompt(root, "claude-code", "cc1", "另一个会话问的");
  recordDecisions(root, "claude-code", "cc1", ["合并前先跑三平台 CI"]);
  const first = codex(root, { hook_event_name: "UserPromptSubmit", prompt: "接着做 Codex 接法" }, env).out;
  assert.match(first.hookSpecificOutput.additionalContext, /\[gemflow\] 本项目其他会话记下的决定：\n- 合并前先跑三平台 CI（Claude · feat\/x，\d\d:\d\d）/);
  const again = codex(root, { hook_event_name: "UserPromptSubmit", prompt: "再来一句" }, env).out;
  assert.doesNotMatch(again?.hookSpecificOutput?.additionalContext ?? "", /本项目其他会话/, "heard once");
  codex(root, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_use_id: "p1", tool_input: { command: "*** Begin Patch\n*** Add File: src/codex-made.ts\n+x\n*** End Patch" }, tool_response: "Done" }, env);
  codex(root, { hook_event_name: "Stop", last_assistant_message: "接好了。", stop_hook_active: false }, env);
  assert.deepEqual(log().map((e) => [e.t, e.turn ?? null, e.text ?? e.path ?? e.host]), [
    ["session", null, "codex"], ["prompt", 1, "接着做 Codex 接法"], ["prompt", 2, "再来一句"], ["file", 2, "src/codex-made.ts"], ["answer", 2, "接好了。"],
  ]);
});
