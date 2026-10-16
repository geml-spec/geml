import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContextDoc } from "../dist/core/stagehand.js";
import { bashExitCode, bridgeInput, contextOf, hasGitOperation, nodeMajor, toolArgs, touchedPath } from "../dist/hosts/claude-code/readers.js";

test("exit status (spec §5.2): Exit code n, a clean result, an interpreted one, a backgrounded one", () => {
  assert.equal(bashExitCode({ result: { stdout: "ok", stderr: "", interrupted: false }, text: "ok" }), 0);
  assert.equal(bashExitCode({ result: { stdout: "", stderr: "", interrupted: false, returnCodeInterpretation: "No matches found" } }), 1);
  assert.equal(bashExitCode({ result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b7" } }), null);
  assert.equal(bashExitCode({ isError: true, result: "Exit code 2", text: "Exit code 2\nboom" }), 2);
  assert.equal(bashExitCode({ isError: true, result: "Interrupted", text: "Interrupted by the user" }), null);
  assert.equal(bashExitCode({ deny: "refused" }), null);
});

test("exit status: an interrupted clean result has none; an errored result without text is read from its string result", () => {
  assert.equal(bashExitCode({ result: { stdout: "partial", stderr: "", interrupted: true }, text: "partial" }), null);
  assert.equal(bashExitCode({ isError: true, result: "Exit code 3\nboom" }), 3);
  assert.equal(bashExitCode({ isError: true, result: { stderr: "x" } }), null);
});

test("gitOperation is read off a clean Bash result only", () => {
  assert.equal(hasGitOperation({ result: { gitOperation: { commit: { sha: "a", kind: "committed" } } } }), true);
  assert.equal(hasGitOperation({ result: { stdout: "" } }), false);
  assert.equal(hasGitOperation({ isError: true, result: "Exit code 1", text: "Exit code 1" }), false);
});

test("the path a write touched, relative to the project; elsewhere is nothing", () => {
  assert.equal(touchedPath("Edit", { file_path: "/w/app/src/a.ts" }, "/w/app"), "src/a.ts");
  assert.equal(touchedPath("Write", { file_path: "/w/app/out/ep01.mp4" }, "/w/app/"), "out/ep01.mp4");
  assert.equal(touchedPath("NotebookEdit", { notebook_path: "/w/app/n.ipynb" }, "/w/app"), "n.ipynb");
  assert.equal(touchedPath("Write", { file_path: "/tmp/x" }, "/w/app"), undefined);
  assert.equal(touchedPath("Write", { file_path: "./episodes/ep02.geml" }, "/w/app"), "episodes/ep02.geml");
  assert.equal(touchedPath("Edit", { file_path: "C:\\w\\app\\src\\a.ts" }, "C:\\w\\app"), "src/a.ts");
  assert.equal(touchedPath("Read", { file_path: "/w/app/a" }, "/w/app"), undefined);
});

test("the path a write touched is normalised first: dot segments resolved, an escape from the root is nothing, a drive letter in any case", () => {
  assert.equal(touchedPath("Write", { file_path: "/w/app/src/../out/ep01.mp4" }, "/w/app"), "out/ep01.mp4");
  assert.equal(touchedPath("Write", { file_path: "/w/app/./src//a.ts" }, "/w/app"), "src/a.ts");
  assert.equal(touchedPath("Write", { file_path: "/w/app/../app/src/a.ts" }, "/w/app"), "src/a.ts");
  assert.equal(touchedPath("Write", { file_path: "/w/app/../etc/passwd" }, "/w/app"), undefined);
  assert.equal(touchedPath("Write", { file_path: "/w/app/src/../../app2/a" }, "/w/app"), undefined);
  assert.equal(touchedPath("Write", { file_path: "/w/application/a" }, "/w/app"), undefined);
  assert.equal(touchedPath("Write", { file_path: "/w/app" }, "/w/app"), undefined, "the root itself is no file");
  assert.equal(touchedPath("Write", { file_path: "../outside.txt" }, "/w/app"), undefined);
  assert.equal(touchedPath("Write", { file_path: "src/../../outside.txt" }, "/w/app"), undefined);
  assert.equal(touchedPath("Write", { file_path: "src/./x/../a.ts" }, "/w/app"), "src/a.ts");
  assert.equal(touchedPath("Write", { file_path: "c:\\w\\app\\src\\a.ts" }, "C:\\w\\app"), "src/a.ts");
  assert.equal(touchedPath("Write", { file_path: "C:/w/app/src/a.ts" }, "c:\\w\\app\\"), "src/a.ts");
  assert.equal(touchedPath("Write", { file_path: "C:\\w\\app\\..\\x.ts" }, "C:\\w\\app"), undefined);
  assert.equal(touchedPath("Write", { file_path: "D:\\w\\app\\a.ts" }, "C:\\w\\app"), undefined);
});

test("a call's own arguments, and the part of them the CLI is sent", () => {
  assert.deepEqual(toolArgs({ tool: "Bash", tool_use_id: "t", agentId: "a", requestMeta: {}, consent: "c", command: "ls", timeout: 5 }), { command: "ls", timeout: 5 });
  assert.deepEqual(bridgeInput({ file_path: "/a", content: "a whole file", old_string: "x" }), { file_path: "/a" });
  assert.deepEqual(bridgeInput({ command: "ls", description: "list" }), { command: "ls" });
});

test("the context document: key, item, state, rev, and the text, even with a fence-like body line", () => {
  const ctx = { state: "review", rev: 7, text: "[gemflow] stage #review · rev 7\n=== looks like a fence\nbody", included: [], truncated: [] };
  const seen = contextOf(renderContextDoc(ctx, { at: "2026-10-12T00:00:00Z", item: "feat/rate-limit" }));
  assert.deepEqual(seen, { key: "feat/rate-limit@7", item: "feat/rate-limit", state: "review", rev: 7, text: ctx.text });
  assert.equal(contextOf('=== meta\ntitle = "x"\n===\n'), undefined);
  assert.equal(contextOf('==== flow-context {#current state=#a rev=1 item="x"}\nunclosed\n'), undefined);
});

test("node --version", () => {
  assert.equal(nodeMajor("v24.15.0\n"), 24);
  assert.equal(nodeMajor("v18.0.0"), 18);
  assert.equal(nodeMajor("command not found"), undefined);
});
