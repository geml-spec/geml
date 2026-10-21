import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITIGNORE, addWorkflow, bundledWorkflows, configText, projectWorkflows, suggestWorkflow, useWorkflow } from "../dist/project.js";
import { FLOW_TOOLS, OWN_TOOL_PREFIX } from "../dist/core/verb-specs.js";
import { CLAUDE_CODE_TOOLS } from "../dist/core/host-tools.js";
import { runVerb, statusForModel } from "../dist/verbs.js";
import { openWorkspace } from "../dist/workspace.js";

const tmp = () => mkdtempSync(join(tmpdir(), "gemflow-project-"));

test("bundled workflows are the directories under workflows/, sorted", () => {
  const names = bundledWorkflows();
  assert.deepEqual(names, ["coding", "dev", "matter", "video"]);
  assert.deepEqual(names, [...names].sort());
});

test("suggestWorkflow reads the project's top level: a media project is video, a deploy configuration dev, a build manifest coding, nothing recognisable dev", () => {
  const root = tmp();
  assert.deepEqual(suggestWorkflow(root), { workflow: "dev", by: "default" });
  writeFileSync(join(root, "package.json"), "{}");
  assert.deepEqual(suggestWorkflow(root), { workflow: "coding", by: "code", file: "package.json" });
  writeFileSync(join(root, "wrangler.toml"), 'name = "x"\n');
  assert.deepEqual(suggestWorkflow(root), { workflow: "dev", by: "deploy", file: "wrangler.toml" }, "shipping outranks code");
  writeFileSync(join(root, "show.geml"), '=== meta\ntitle = "x"\nprofile = "geml-media/v1"\n===\n');
  assert.deepEqual(suggestWorkflow(root), { workflow: "video", by: "media", file: "show.geml" }, "a geml-media document outranks both");
  mkdirSync(join(root, "episodes"));
  assert.deepEqual(suggestWorkflow(root), { workflow: "video", by: "media", file: "episodes/" });
  assert.deepEqual(suggestWorkflow(join(root, "nowhere")), { workflow: "dev", by: "default" }, "a root that cannot be read");
  for (const s of [suggestWorkflow(root), suggestWorkflow(tmp())]) assert.ok(bundledWorkflows().includes(s.workflow), "every suggestion is a bundled workflow");
});

test("addWorkflow writes the workflow as one file and its rows into the project's dictionary, keeps gemflow's files out of git, and activates only when asked", () => {
  const root = tmp();
  assert.deepEqual(addWorkflow(root, "coding", { activate: true }), { ok: true, name: "coding", target: join(root, ".geml", "workflows", "coding.geml"), activated: true });
  assert.ok(existsSync(join(root, ".geml", "workflows", "coding.geml")));
  assert.ok(existsSync(join(root, ".geml", "tools.geml")), "the dictionary's rows come with the workflow");
  assert.equal(readFileSync(join(root, ".geml", ".gitignore"), "utf8"), GITIGNORE);
  assert.equal(readFileSync(join(root, ".geml", "project.geml"), "utf8"), configText("coding"));
  assert.equal(addWorkflow(root, "dev", { activate: false }).activated, false);
  assert.equal(readFileSync(join(root, ".geml", "project.geml"), "utf8"), configText("coding"));
  assert.deepEqual(projectWorkflows(root), ["coding", "dev"]);
  const again = addWorkflow(root, "coding", { activate: true });
  assert.deepEqual([again.ok, again.code, again.reason], [false, 1, ".geml/workflows/coding.geml already exists; not overwriting"]);
  const unknown = addWorkflow(root, "nope", { activate: true });
  assert.deepEqual([unknown.ok, unknown.code], [false, 2]);
  assert.match(unknown.reason, /^unknown template "nope"; expected coding or /);
});

test("useWorkflow names an installed workflow and refuses any other", () => {
  const root = tmp();
  addWorkflow(root, "dev", { activate: false });
  assert.deepEqual(useWorkflow(root, "dev"), { ok: true });
  assert.match(readFileSync(join(root, ".geml", "project.geml"), "utf8"), /flow-workflow = "dev"/);
  assert.deepEqual(useWorkflow(root, "coding"), { ok: false, reason: 'no workflow "coding" in .geml/workflows (have: dev)' });
  assert.equal(useWorkflow(root, "../x").ok, false);
});

test("the three verb specs are static: names, and objects that close where they take arguments", () => {
  assert.deepEqual(FLOW_TOOLS.map((t) => t.name), ["status", "move", "set"]);
  for (const t of FLOW_TOOLS) assert.equal(t.inputSchema.type, "object", t.name);
  assert.deepEqual(FLOW_TOOLS.find((t) => t.name === "move").inputSchema.required, ["to"]);
  assert.equal(FLOW_TOOLS.find((t) => t.name === "set").inputSchema.additionalProperties, true);
  assert.equal(OWN_TOOL_PREFIX, "mcp__gemflow__");
});

function devWorkspace(branch, pr) {
  const root = tmp();
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(new URL("./fixtures/ws-dev/", import.meta.url), join(root, ".geml", "workflows", "dev"), { recursive: true });
  writeFileSync(join(root, ".geml", "gemflow.geml"), configText("dev"));
  return openWorkspace({
    root, tools: CLAUDE_CODE_TOOLS,
    git: () => ({ branch, defaultBranch: "main", committed: false }),
    gh: () => (pr === undefined ? { available: false, reason: "gh is not installed" } : { available: true, prOpen: pr, prMerged: false, ci: [] }),
  }).ws;
}

test("runVerb answers in text the model reads: status carries the stage text; evidence is not the model's to set", () => {
  const ws = devWorkspace("feat/x");
  const status = runVerb(ws, "status", {});
  assert.equal(status.ok, true);
  assert.match(status.text, /^\[gemflow\] workflow dev \(\.geml\/workflows\/dev\/flow\.geml\)\nwork item feat\/x · state build · rev 0\n/);
  assert.match(status.text, /\nvariables: ci-pass=false \(git:ci-success\), .*review-ready=false \(human\), tests-pass=false \(tool:test\)\n/);
  assert.match(status.text, /\ngit evidence unavailable: gh is not installed\n/);
  assert.match(status.text, /\n\n\[gemflow\] stage build · rev 0\n/, "the stage text follows the status");
  assert.equal(status.context, undefined);
  const set = runVerb(ws, "set", { "review-ready": true }, "v1");
  assert.equal(set.ok, false);
  assert.match(set.text, /^refused: "review-ready" is evidence/);
  assert.deepEqual(runVerb(ws, "move", { to: "done" }, "v2"), { ok: false, text: "refused: no transition build→done" });
  const approval = runVerb(devWorkspace("feat/y"), "move", { to: "review" }, "v3");
  assert.match(approval.text, /^refused: build→review is taken on its own when its guard holds/);
});

test("a verb that moves the stage carries the new stage text", () => {
  const ws = devWorkspace("feat/x", true);
  ws.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.deepEqual(ws.refresh().entered, ["review"]);
  const back = runVerb(ws, "move", { to: "build" }, "v1");
  assert.equal(back.ok, true, back.text);
  assert.match(back.context, /^\[gemflow\] stage build/);
  assert.equal(runVerb(ws, "status", {}).context, undefined);
});

test("statusForModel on the default branch says nothing is tracked", () => {
  assert.match(statusForModel(devWorkspace("main").status()), /\nnot tracking: main · not tracked \(work items are branches\)$/);
});
