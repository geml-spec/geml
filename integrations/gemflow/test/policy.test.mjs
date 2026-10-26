// The policy snapshot a host shell decides from (core/policy.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStatechart } from "../dist/core/statechart.js";
import { policyOf, relevantVars, scopeIn, scopeOf } from "../dist/core/policy.js";
import { startRun } from "../dist/core/run.js";
import { dict, flowDoc } from "./helpers/flow.mjs";

const sc = loadStatechart(flowDoc({
  initial: "build",
  states: { build: { tools: ["edit", "test"] }, release: { tools: ["deploy", "test"] }, done: {} },
  vars: {
    t: { default: false, source: { tool: "test" } }, d: { default: false, source: { tool: "deploy" } },
    f: { default: false, source: { file: "out/*.mp4" } }, p: { default: false, source: "pr-open" }, h: { default: false, source: "human" }, n: { default: "" },
  },
  transitions: [
    { from: "build", to: "release", guard: { anyOf: [{ properties: { t: { const: true } } }, { properties: { h: { const: true } } }] } },
    { from: "release", to: "done", guard: { properties: { d: { const: true }, p: { const: true } } } },
  ],
  unit: "file:episodes/*.geml",
}), "p.geml").statechart;
const D = dict([{ tool: "Read", allow: ["*"] }, { tool: "Bash(npm test)", for: "test", default: true }]);

test("policyOf: the unit, the state and its uses, every use's states, the rows, the file globs, whether git is read, the relevant variables, the evidence uses", () => {
  const run = startRun(sc, { item: "ep01", workflow: "p.geml", workflowHash: sc.hash, created: "t" }, "t").run;
  const p = policyOf(sc, D, run);
  assert.deepEqual(p, {
    active: true, unit: { kind: "file", glob: "episodes/*.geml" }, state: "build", uses: ["edit", "test"],
    fences: { edit: ["build"], test: ["build", "release"], deploy: ["release"] }, rules: [],
    rows: D.rows, files: ["out/*.mp4"], git: true, relevant: ["h", "t"], evidence: ["test", "deploy"], written: [],
  });
  const inactive = policyOf(sc, D, undefined);
  assert.deepEqual([inactive.active, inactive.state, inactive.uses, inactive.relevant, inactive.fences], [false, "", [], [], p.fences]);
});

test("policyOf: the files recorded as written since the stage was entered, and none once another stage is entered", () => {
  const run = startRun(sc, { item: "ep01", workflow: "p.geml", workflowHash: sc.hash, created: "t" }, "t").run;
  run.wrote("Edit", "src/a.ts", { at: "t" });
  run.wrote("Write", "out/ep01.mp4", { at: "t" });
  assert.deepEqual(policyOf(sc, D, run).written, ["src/a.ts", "out/ep01.mp4"]);
  run.signal("t", true, { at: "t" });
  run.transition("release", { at: "t" });
  assert.equal(policyOf(sc, D, run).state, "release");
  assert.deepEqual(policyOf(sc, D, run).written, []);
  assert.deepEqual(policyOf(sc, D, undefined).written, []);
});

test("relevantVars: what a machine guard out of the state reads, each once", () => {
  assert.deepEqual(relevantVars(sc, "build"), ["h", "t"]);
  assert.deepEqual(relevantVars(sc, "release"), ["d", "p"]);
  assert.deepEqual(relevantVars(sc, "done"), []);
});

test("scopeOf and scopeIn agree: the state, its uses, and which states declare a use", () => {
  const run = startRun(sc, { item: "ep01", workflow: "p.geml", workflowHash: sc.hash, created: "t" }, "t").run;
  const a = scopeOf(policyOf(sc, D, run));
  const b = scopeIn(sc, "build");
  assert.deepEqual([a.state, a.uses, a.declaring("test"), a.declaring("nope")], [b.state, b.uses, b.declaring("test"), b.declaring("nope")]);
  assert.deepEqual(a.declaring("test"), ["build", "release"]);
});
