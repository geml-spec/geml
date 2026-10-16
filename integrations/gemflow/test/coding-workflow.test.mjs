// The bundled coding workflow keeps the promises its own text makes: editing
// exists in #implement and nowhere else, the test command in #verify and
// nowhere else, nothing reaches #review without a recorded test result, and
// the last step is a person's. The uses are the workflow's; tools.geml beside
// it binds them to Claude Code's tools, so this file drives the shipped
// workflow through the bridge the way the Claude Code shell does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJournal } from "../dist/core/journal.js";
import { loadStatechart, statesDeclaring } from "../dist/core/statechart.js";
import { readDictionary } from "../dist/core/dictionary-file.js";
import { BUNDLE, gitRepo, hook } from "./helpers/repo.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FLOW = fileURLToPath(new URL("../workflows/coding/flow.geml", import.meta.url));
const text = readFileSync(FLOW, "utf8");
const sc = loadStatechart(text, "flow.geml").statechart;
const dict = readDictionary(readFileSync(new URL("../workflows/coding/tools.geml", import.meta.url), "utf8"), sc);

test("the workflow and its dictionary check clean; editing is #implement's use and the test command #verify's", () => {
  const r = spawnSync(process.execPath, [CLI, "check", FLOW], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(loadStatechart(text, "flow.geml").diagnostics, []);
  assert.deepEqual(dict.diagnostics, []);
  assert.deepEqual([...sc.states.values()].map((s) => [s.id, s.uses]), [["explore", []], ["plan", []], ["implement", ["edit"]], ["verify", ["test"]], ["review", []], ["done", []]]);
  assert.deepEqual(statesDeclaring(sc, "edit"), ["implement"]);
  assert.deepEqual(statesDeclaring(sc, "test"), ["verify"]);
  assert.deepEqual(dict.rows.filter((r) => r.for === "edit").map((r) => r.tool), ["Edit", "Write", "NotebookEdit", "apply_patch"]);
  assert.deepEqual(dict.rows.filter((r) => r.for === "test").map((r) => r.tool), ["Bash(npm test)", "Bash(pnpm test)", "Bash(yarn test)", "Bash(cargo test)", "Bash(pytest)", "Bash(go test)"]);
  assert.deepEqual(sc.transitions.map((t) => [t.name, t.judge, t.approval, t.resets]), [
    ["explore→plan", "model", false, []], ["plan→implement", "model", false, []], ["implement→verify", "none", false, []],
    ["verify→implement", "model", false, ["tests-pass"]], ["verify→review", "machine", false, []], ["review→done", "none", true, []], ["review→implement", "model", false, ["tests-pass"]],
  ]);
});

test("through the bridge: an edit while exploring, planning or reviewing, and a command while editing, are refused and recorded; the review needs a recorded test result and a person", () => {
  const root = gitRepo();
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "coding"], { cwd: root, encoding: "utf8" }).status, 0);
  const before = (callId, tool, input) => hook(root, { op: "before", tool, callId, input });
  const verb = (name, args, callId) => hook(root, { op: "verb", name, args, callId });
  assert.equal(hook(root, { op: "status" }).shell.status.state.id, "explore");

  const early = before("w1", "Write", { file_path: join(root, "sum.mjs") });
  assert.match(early.refusal, /Write is edit, which is used only in #implement; the workflow is in #explore/);
  assert.match(before("b1", "Bash", { command: "npm test" }).refusal, /"npm test" is test, which is used only in #verify/, "and no command while exploring");
  assert.equal(before("r1", "Read", { file_path: join(root, "sum.mjs") }).refusal, undefined);

  assert.equal(JSON.parse(verb("set", { goal: "sum should add", touched: "sum.mjs" }, "v1").text).state, "explore");
  assert.equal(JSON.parse(verb("move", { to: "plan" }, "v2").text).state, "plan");
  assert.match(before("e1", "Edit", { file_path: join(root, "sum.mjs") }).refusal, /Edit is edit, which is used only in #implement; the workflow is in #plan/, "the plan exists before the diff does");

  verb("set", { plan: "fix it, run it", command: "npm test" }, "v3");
  assert.equal(JSON.parse(verb("move", { to: "implement" }, "v4").text).state, "implement");
  assert.equal(before("e2", "Edit", { file_path: join(root, "sum.mjs") }).refusal, undefined, "#implement is where editing exists");
  assert.match(before("b2", "Bash", { command: "npm test" }).refusal, /is test, which is used only in #verify; the workflow is in #implement/);

  assert.equal(JSON.parse(verb("move", { to: "verify" }, "v5").text).state, "verify");
  assert.equal(before("b3", "Bash", { command: "npm test" }).refusal, undefined, "#verify is where the command exists");
  assert.match(before("w2", "Write", { file_path: join(root, "sum.mjs") }).refusal, /is edit, which is used only in #implement; the workflow is in #verify/);
  assert.match(verb("set", { "tests-pass": true }, "v6").text, /^refused: "tests-pass" is evidence/, "the result is the command's to write, never the model's");
  assert.match(verb("move", { to: "review" }, "v7").text, /^refused: verify→review is taken on its own when its guard holds/);
  const failed = hook(root, { op: "after", tool: "Bash", callId: "b3", input: { command: "npm test" }, isError: true, exitCode: 1, gitOperation: false });
  assert.deepEqual([failed.entered, failed.shell.status.state.id], [[], "verify"]);
  const passed = hook(root, { op: "after", tool: "Bash", callId: "b4", input: { command: "npm test" }, isError: false, exitCode: 0, gitOperation: false });
  assert.deepEqual([passed.entered, passed.shell.status.state.id], [["review"], "review"], "the exit status is the evidence");

  assert.match(before("b5", "Bash", { command: "npm test" }).refusal, /the workflow is in #review/);
  assert.match(verb("move", { to: "done" }, "v8").text, /^refused: review→done needs a person/);
  assert.deepEqual(hook(root, { op: "advance", to: "done" }).entered, ["done"]);

  const journal = readJournal(readFileSync(join(root, ".geml", "journals", "feat", "x.geml"), "utf8"));
  assert.deepEqual(journal.refusals.map((r) => r.tool), ["Write", "Bash", "Edit", "Bash", "Write", "set", "move", "Bash", "move"]);
  assert.deepEqual(journal.snapshots.map((s) => [s.state, s.by ?? ""]), [
    ["explore", ""], ["explore", "model"], ["plan", "model"], ["plan", "model"], ["implement", "model"], ["verify", "model"], ["verify", "signal"], ["review", "signal"], ["done", "human"],
  ]);
});
