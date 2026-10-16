// The per-step snapshot hosts without a context channel inject (core/prompt.ts), and the verbs' shapes (core/tools.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot } from "../dist/core/snapshot.js";
import { describeTransitions, renderContext } from "../dist/core/prompt.js";
import { moveSpec, setSpec, statusSpec, toParamEntry } from "../dist/core/tools.js";
import { dict, flowDoc } from "./helpers/flow.mjs";

const sc = loadStatechart(flowDoc({
  initial: "a",
  states: { a: { tools: ["test"] }, b: {}, c: {} },
  vars: { t: { default: false, source: { tool: "test" } }, h: { default: false, source: "human" }, n: { default: "" }, k: { default: 0 } },
  transitions: [
    { from: "a", to: "b", guard: { properties: { t: { const: true } } }, note: "green" },
    { from: "a", to: "c", guard: "the model says so" },
    { from: "b", to: "c", approval: true, guard: { properties: { h: { const: true } } } },
  ],
}), "p.geml").statechart;
const D = dict([{ tool: "Bash(npm test)", for: "test", default: true }]);
const T0 = "2026-10-12T00:00:00Z";

test("renderContext: the state and revision, the variables, the transitions with their judges, the uses with their tools and the settable variables", () => {
  const text = renderContext(sc, initialSnapshot(sc, T0), D);
  const lines = text.split("\n");
  assert.match(lines[0], /^\[gemflow\] state a · rev 0 · sha256:[0-9a-f]{12}…$/);
  assert.equal(lines[1], 'vars: {"h":false,"k":0,"n":"","t":false}');
  assert.equal(lines[2], "transitions: a→b (when t = true) · a→c (when the model says so)");
  assert.equal(lines[3], "tools here: test: Bash(npm test) · settable vars: n k");
  assert.match(renderContext(sc, { ...initialSnapshot(sc, T0), state: "b" }), /transitions: b→c \(when h = true, needs a person\)\ntools here: \(none declared\)/);
  assert.match(renderContext(sc, { ...initialSnapshot(sc, T0), state: "c" }), /transitions: \(none — this is the final state\)/);
});

test("describeTransitions: one per line, with the note and the judge", () => {
  assert.equal(describeTransitions(sc, "a"), "a→b: green (when t = true)\na→c (when the model says so)");
  assert.equal(describeTransitions(sc, "c"), "(none — this is the final state)");
});

test("the specs: status is static; move offers the model's transitions, null when there are none; set offers the model's variables typed by their defaults", () => {
  assert.deepEqual(statusSpec().parameters, {});
  assert.equal(statusSpec().output.schema.additionalProperties, false);
  const move = moveSpec(sc, initialSnapshot(sc, T0));
  assert.deepEqual(move.parameters.to, { type: "string", required: true, description: "The target state.", enum: ["c"] });
  assert.match(move.description, /^Take a transition out of a:\n/);
  assert.equal(moveSpec(sc, { ...initialSnapshot(sc, T0), state: "b" }), null, "b→c needs a person");
  const set = setSpec(sc, initialSnapshot(sc, T0));
  assert.deepEqual(Object.keys(set.parameters), ["n", "k"]);
  assert.deepEqual(set.parameters.k, { type: "integer", description: "the k variable" });
  assert.equal(set.output.schema.properties.vars.additionalProperties, true);
  assert.deepEqual(toParamEntry("o", { type: "object", properties: { a: { type: "string" } } }), { type: "object", description: "the o variable", properties: { a: { type: "string" } }, additionalProperties: false });
  const evOnly = loadStatechart(flowDoc({ initial: "a", states: { a: { tools: ["t"] }, b: {} }, vars: { t: { default: false, source: { tool: "t" } } }, transitions: [{ from: "a", to: "b" }] }), "e").statechart;
  assert.equal(setSpec(evOnly, initialSnapshot(evOnly, T0)), null);
});
