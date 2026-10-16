// Loading a workflow: the parser reads the geml-statechart block, this module
// hangs Gemflow's keys on it (spec §4.2) and reports the flow-* codes (§4.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  declaredUses, hasErrors, hashText, loadStatechart, modelVars, outgoing, sourceLabel, statesDeclaring, varsBySource, DEFAULT_CONTEXT_BUDGET,
} from "../dist/core/statechart.js";
import { flowDoc, twoStates } from "./helpers/flow.mjs";

const refund = readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8");
const codes = (r) => r.diagnostics.map((d) => `${d.severity}:${d.code}`);

test("the refund workflow loads clean: states with their keys, variables, transitions with their judges", () => {
  const r = loadStatechart(refund, "refund.geml");
  assert.deepEqual(r.diagnostics, []);
  const sc = r.statechart;
  assert.equal(sc.initial, "intake");
  assert.deepEqual([...sc.states.keys()], ["intake", "review", "pay", "wait-human", "done"]);
  assert.deepEqual(sc.states.get("review").prompt, "#policy");
  assert.equal(sc.states.get("review").description, "Check the order against the refund policy; set approved, then move on.");
  assert.deepEqual(sc.states.get("pay").uses, ["refund"]);
  assert.deepEqual(sc.states.get("intake").uses, []);
  assert.equal(sc.states.get("done").final, true);
  assert.equal(sc.states.get("pay").final, false);
  assert.deepEqual([...sc.vars.keys()], ["order", "amount", "approved"]);
  assert.deepEqual(sc.vars.get("order"), { name: "order", default: "", note: "Order id" });
  assert.deepEqual(modelVars(sc), ["order", "amount", "approved"], "no variable has a source: every one is the model's");
  assert.deepEqual(sc.varsSchema, { type: "object", additionalProperties: false, properties: { order: { type: "string", default: "", description: "Order id" }, amount: { type: "integer", default: 0 }, approved: { type: "boolean", default: false } } });
  assert.deepEqual(sc.transitions.map((t) => [t.name, t.judge, t.approval, t.reads]), [
    ["intake→review", "model", false, []],
    ["review→pay", "machine", true, ["approved"]],
    ["review→wait-human", "model", false, []],
    ["wait-human→pay", "machine", false, ["approved"]],
    ["pay→done", "none", false, []],
  ]);
  assert.equal(sc.transitions[1].note, "Policy allows the refund; a person approves this step.");
  assert.deepEqual(sc.transitions[0].guard, { kind: "text", text: "the order id and the amount are known" });
  assert.deepEqual(outgoing(sc, "review").map((t) => t.to), ["pay", "wait-human"]);
  assert.deepEqual(outgoing(sc, "done"), []);
  assert.deepEqual(sc.unit, { kind: "branch" });
  assert.equal(sc.contextBudget, DEFAULT_CONTEXT_BUDGET);
  assert.equal(sc.hash, hashText(refund));
  assert.match(sc.hash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(sc.model.states.length === 5, "the parser's model rides along");
});

test("sources: the six forms, the labels, and which states a use is fenced to", () => {
  const src = flowDoc({
    initial: "a",
    states: { a: { tools: ["test", "pr"] }, b: { tools: ["test"] }, c: { final: true } },
    vars: {
      t: { default: false, source: { tool: "test" } },
      f: { default: false, source: { file: "out/*.mp4" } },
      g: { default: false, source: "pr-open" },
      c: { default: false, source: "committed" },
      h: { default: false, source: "human", note: "a person says so" },
      e: { default: false, source: { elapsed: "P1DT2H30M" } },
      n: { default: "", note: "the model's notebook" },
    },
    transitions: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  });
  const r = loadStatechart(src, "s.geml");
  assert.deepEqual(r.diagnostics, []);
  const sc = r.statechart;
  assert.deepEqual([...sc.signalVars], ["t", "f", "g", "c", "h", "e"]);
  assert.deepEqual(modelVars(sc), ["n"]);
  assert.deepEqual(varsBySource(sc, "tool").map((v) => v.source.use), ["test"]);
  assert.deepEqual(varsBySource(sc, "git").map((v) => v.source.fact), ["pr-open", "committed"]);
  assert.deepEqual(varsBySource(sc, "file").map((v) => v.source.glob), ["out/*.mp4"]);
  assert.deepEqual(varsBySource(sc, "human").map((v) => v.name), ["h"]);
  assert.deepEqual(varsBySource(sc, "elapsed").map((v) => [v.name, v.source.iso, v.source.ms]), [["e", "P1DT2H30M", (26 * 60 + 30) * 60_000]]);
  assert.deepEqual([...sc.vars.values()].filter((v) => v.source).map((v) => sourceLabel(v.source)), ["tool:test", "file:out/*.mp4", "git:pr-open", "git:committed", "human", "elapsed:P1DT2H30M"]);
  assert.equal(sc.vars.get("h").note, "a person says so");
  assert.deepEqual([...declaredUses(sc)], ["test", "pr"]);
  assert.deepEqual(statesDeclaring(sc, "test"), ["a", "b"]);
  assert.deepEqual(statesDeclaring(sc, "pr"), ["a"]);
  assert.deepEqual(statesDeclaring(sc, "deploy"), []);
});

test("flow-attr: a prompt that does not resolve, skills and tools that are not string arrays, approval that is not true, a bad source, a non-false default on evidence, a note or a label that is not a string", () => {
  const one = (states, vars = {}, edge = {}, opts) => codes(loadStatechart(twoStates({ a: states, vars, edge }), "t", opts));
  assert.deepEqual(one({ prompt: "#nope" }, {}, {}, { resolveRef: () => false }), ["error:flow-attr"]);
  assert.deepEqual(one({ prompt: "#yes" }, {}, {}, { resolveRef: (ref) => ref === "#yes" }), []);
  assert.deepEqual(one({ prompt: "#nope" }), [], "without a resolver, prompts are not checked");
  assert.deepEqual(one({ prompt: 3 }), ["error:flow-attr"]);
  assert.deepEqual(one({ skills: "tdd" }), ["error:flow-attr"]);
  assert.deepEqual(one({ tools: ["edit", "no spaces"] }), ["error:flow-attr"]);
  assert.deepEqual(one({ tools: "edit" }), ["error:flow-attr"]);
  assert.deepEqual(one({}, {}, { approval: "yes" }), ["error:flow-attr"]);
  assert.deepEqual(one({}, {}, { approval: false }), ["error:flow-attr"]);
  assert.deepEqual(one({}, {}, { note: 7 }), ["error:flow-attr"]);
  assert.deepEqual(one({}, {}, { label: 7 }), ["error:flow-attr"]);
  assert.deepEqual(one({}, {}, { label: "  " }), ["error:flow-attr"], "a label says something");
  assert.deepEqual(one({}, { v: { default: false, source: "webhook" } }), ["error:flow-attr"]);
  assert.deepEqual(one({}, { v: { default: false, source: { tool: "a", file: "b" } } }), ["error:flow-attr"]);
  assert.deepEqual(one({}, { v: { default: false, source: 5 } }), ["error:flow-attr"]);
  assert.deepEqual(one({}, { v: { default: true, source: "human" } }), ["error:flow-attr"], "evidence defaults to false");
  assert.deepEqual(one({}, { v: { default: false, source: "human", note: 1 } }), ["error:flow-attr"]);
  const r = loadStatechart(twoStates({ a: { tools: ["edit"], skills: ["tdd"] }, edge: { approval: true, note: "a person says yes", label: " 通过 " } }), "t");
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual([r.statechart.states.get("a").skills, r.statechart.transitions[0].approval, r.statechart.transitions[0].note, r.statechart.transitions[0].label], [["tdd"], true, "a person says yes", "通过"]);
});

test("flow-source warns when a tool variable's use is declared by no state: the variable can never be set", () => {
  const r = loadStatechart(twoStates({ vars: { t: { default: false, source: { tool: "test" } } } }), "t");
  assert.deepEqual(codes(r), ["warning:flow-source"]);
  assert.ok(r.statechart, "a warning does not refuse");
  assert.match(r.diagnostics[0].message, /the use `test`, which no state declares/);
  assert.deepEqual(codes(loadStatechart(twoStates({ b: { tools: ["test"] }, vars: { t: { default: false, source: { tool: "test" } } } }), "t")), []);
});

test("flow-dup-edge: a second transition between the same pair; the journal names a transition by its pair", () => {
  const r = loadStatechart(flowDoc({ initial: "a", states: { a: {}, b: { final: true } }, transitions: [{ from: "a", to: "b" }, { from: "a", to: "b", guard: "again" }] }), "t");
  assert.deepEqual(codes(r), ["error:flow-dup-edge"]);
  assert.match(r.diagnostics[0].message, /a→b\[2\]: a second transition between a and b/);
});

test("flow-auto-ambiguous: at most one machine-judged, approval-free transition leaves a state; an approval edge does not count", () => {
  const vars = { x: { default: false }, y: { default: false } };
  const g = (name) => ({ properties: { [name]: { const: true } } });
  const two = loadStatechart(flowDoc({ initial: "a", states: { a: {}, b: { final: true }, c: { final: true } }, vars, transitions: [{ from: "a", to: "b", guard: g("x") }, { from: "a", to: "c", guard: g("y") }] }), "t");
  assert.deepEqual(codes(two), ["error:flow-auto-ambiguous"]);
  assert.match(two.diagnostics[0].message, /state a has 2 machine-judged transitions out \(a→b, a→c\)/);
  const ok = loadStatechart(flowDoc({ initial: "a", states: { a: {}, b: { final: true }, c: { final: true } }, vars, transitions: [{ from: "a", to: "b", guard: g("x") }, { from: "a", to: "c", guard: g("y"), approval: true }] }), "t");
  assert.deepEqual(codes(ok), []);
  const ref = loadStatechart(flowDoc({ initial: "a", states: { a: {}, b: { final: true }, c: { final: true } }, vars, transitions: [{ from: "a", to: "b", guard: "#gx" }, { from: "a", to: "c", guard: g("y") }], extra: '=== data {#gx format=json}\n{"properties":{"x":{"const":true}}}\n===\n' }), "t");
  assert.deepEqual(codes(ref), ["error:flow-auto-ambiguous"], "a reference guard is machine-judged too");
});

test("flow-auto-cycle warns, naming the ring; the workflow still loads", () => {
  const g = { properties: { x: { const: true } } };
  const r = loadStatechart(flowDoc({
    initial: "a", states: { a: {}, b: {}, c: {}, d: { final: true } }, vars: { x: { default: false } },
    transitions: [{ from: "a", to: "b" }, { from: "b", to: "c", guard: g }, { from: "c", to: "b", guard: g }, { from: "c", to: "d", approval: true }],
  }), "t");
  assert.deepEqual(codes(r), ["warning:flow-auto-cycle"]);
  assert.ok(r.statechart);
  assert.match(r.diagnostics[0].message, /b → c → b/);
});

test("flow-unit: branch, file:<glob>, or an error; the default is branch", () => {
  const unit = (u) => loadStatechart(twoStates({ unit: u }), "t");
  assert.deepEqual(unit("branch").statechart.unit, { kind: "branch" });
  assert.deepEqual(unit("file:episodes/*.geml").statechart.unit, { kind: "file", glob: "episodes/*.geml" });
  assert.deepEqual(codes(unit("file:")), ["error:flow-unit"]);
  assert.deepEqual(codes(unit("worktree")), ["error:flow-unit"]);
  assert.deepEqual(loadStatechart(twoStates(), "t").statechart.unit, { kind: "branch" });
});

test("flow-state-key: a file unit keeps its state under that meta key; on a branch unit, or not a key name, it is an error", () => {
  const withKey = (u, key) => loadStatechart(twoStates({ unit: u }).replace(`flow-unit = "${u}"`, `flow-unit = "${u}"\nflow-state-key = "${key}"`), "t");
  assert.deepEqual(withKey("file:.geml/matters/*.geml", "state").statechart.unit, { kind: "file", glob: ".geml/matters/*.geml", stateKey: "state" });
  assert.deepEqual(codes(withKey("branch", "state")), ["error:flow-unit"]);
  assert.match(withKey("branch", "state").diagnostics[0].message, /only a file unit keeps its state in the item file/);
  assert.deepEqual(codes(withKey("file:a/*.geml", "the state")), ["error:flow-unit"]);
});

test("flow-statechart: no block, or two; the format's own codes come through with the block's line", () => {
  const none = loadStatechart('=== meta\nprofile = "geml-statechart/v1"\n===\n\nJust prose.\n', "t");
  assert.deepEqual(codes(none), ["error:flow-statechart"]);
  assert.match(none.diagnostics[0].message, /a workflow is one statechart/);
  const two = loadStatechart(twoStates() + '\n=== diagram {#second format=geml-statechart}\n{"initial":"x","states":{"x":{}},"transitions":[]}\n===\n', "t");
  assert.deepEqual(codes(two), ["error:flow-statechart"]);
  const bad = loadStatechart('=== meta\nprofile = "geml-statechart/v1"\n===\n\n=== diagram {#flow format=geml-statechart}\n{"initial":"zz","states":{"a":{}},"transitions":[{"from":"a","to":"q"}]}\n===\n', "t");
  assert.ok(codes(bad).includes("error:statechart-initial"));
  assert.ok(codes(bad).includes("error:statechart-transition"));
  assert.equal(bad.statechart, undefined);
  assert.ok(bad.diagnostics.every((d) => d.line === 5), "a statechart diagnostic points at the block");
});

test("a guard that reads a variable with no default type: the parser's codes refuse it; a reference guard in another document resolves through readDoc", () => {
  const unknown = loadStatechart(twoStates({ edge: { guard: { properties: { nope: { const: true } } } } }), "t");
  assert.ok(codes(unknown).includes("error:statechart-guard"));
  const docs = { "guards.geml": '=== data {#ok format=json}\n{"properties":{"x":{"const":true}}}\n===\n' };
  const r = loadStatechart(twoStates({ vars: { x: { default: false } }, edge: { guard: "guards.geml#ok" } }), "t", { readDoc: (rel) => docs[rel] ?? null });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.statechart.transitions[0].reads, ["x"]);
  assert.equal(r.statechart.transitions[0].judge, "machine");
  const missing = loadStatechart(twoStates({ vars: { x: { default: false } }, edge: { guard: "guards.geml#ok" } }), "t", { readDoc: () => null });
  assert.ok(codes(missing).includes("error:statechart-guard"));
});

test("a core geml error refuses the document and is passed through", () => {
  const r = loadStatechart(twoStates({ extra: "See [[#nowhere]].\n" }), "t");
  assert.equal(r.statechart, undefined);
  assert.ok(codes(r).some((c) => c.startsWith("error:unresolved")), codes(r).join());
  assert.equal(hasErrors(r.diagnostics), true);
});

test("a CRLF checkout hashes the same as an LF one", () => {
  const lf = twoStates({ a: { description: "line one" } });
  const a = loadStatechart(lf, "t.geml").statechart;
  const b = loadStatechart(lf.replace(/\n/g, "\r\n"), "t.geml").statechart;
  assert.equal(b.hash, a.hash);
  assert.equal(b.states.get("a").description, "line one");
});

test("resets name the variables a transition returns to their defaults; a reset of an unknown variable is the format's error", () => {
  const ok = loadStatechart(twoStates({ vars: { x: { default: false }, y: { default: "" } }, edge: { actions: [{ reset: ["x", "y"] }] } }), "t");
  assert.deepEqual(ok.diagnostics, []);
  assert.deepEqual(ok.statechart.transitions[0].resets, ["x", "y"]);
  const bad = loadStatechart(twoStates({ vars: { x: { default: false } }, edge: { actions: [{ reset: ["zz"] }] } }), "t");
  assert.ok(codes(bad).includes("error:statechart-actions"));
});
