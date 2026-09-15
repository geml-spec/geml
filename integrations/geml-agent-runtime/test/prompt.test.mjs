import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition } from "../dist/core/snapshot.js";
import { describeTransitions, renderContext, visibleTools } from "../dist/core/prompt.js";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-14T12:00:00Z";

test("describeTransitions lists each edge with its guard and approval flag", () => {
  assert.equal(describeTransitions(sc, "review"),
    "#to-pay → #pay: Policy allows the refund. A human must approve this step. (requires #is-approved; needs approval)\n"
    + "#to-wait → #wait-human: The amount is above the threshold; hand over to a human.");
  assert.equal(describeTransitions(sc, "done"), "(none — this is a final state)");
});

test("renderContext is small and says where we are, what we hold, where we can go", () => {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, { at: T0 }).next;
  const s2 = applyTransition(sc, s1, "review", { at: T0 }).next;
  const text = renderContext(sc, s2);
  assert.equal(text,
    `[geml-agent] state #review · rev 2 · ${s2.hash.slice(0, 19)}…\n`
    + 'vars: {"amount":120,"approved":false,"order":"A-17"}\n'
    + "transitions: #to-pay → #pay (requires #is-approved, needs approval) · #to-wait → #wait-human\n"
    + "tools here: read_file grep · settable vars: approved");
  assert.ok(Buffer.byteLength(text, "utf8") < 400);
});

test("renderContext spells out none / unrestricted / final", () => {
  const pay = { ...initialSnapshot(sc, T0), state: "pay" };
  assert.match(renderContext(sc, pay), /tools here: pay_refund · settable vars: none/);
  const done = { ...initialSnapshot(sc, T0), state: "done" };
  assert.match(renderContext(sc, done), /transitions: \(none — this is a final state\)/);
  const open = loadStatechart('=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a initial final}\nx\n===\n', "t").statechart;
  assert.match(renderContext(open, initialSnapshot(open, T0)), /tools here: \(unrestricted\)/);
});

test("visibleTools intersects the state's list with what is registered", () => {
  assert.deepEqual(visibleTools(sc, sc.states.get("intake"), ["grep", "bash", "read_file"]), { kind: "allow", names: ["read_file", "grep"] });
  assert.deepEqual(visibleTools(sc, sc.states.get("pay"), ["grep"]), { kind: "allow", names: [] });
  const open = loadStatechart('=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a initial final}\nx\n===\n', "t").statechart;
  assert.deepEqual(visibleTools(open, open.states.get("a"), ["grep"]), { kind: "unrestricted" });
});

test("describeTransitions and renderContext both say \"(none)\" for a dead end that is not final", () => {
  const deadEnd = loadStatechart(
    '=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a initial}\nx\n===\n=== agent-state {#b tools=none}\nx\n===\n',
    "t",
  ).statechart;
  assert.equal(describeTransitions(deadEnd, "a"), "(none)");
  assert.match(renderContext(deadEnd, initialSnapshot(deadEnd, T0)), /transitions: \(none\)\n/);
});

test("renderContext handles a snapshot whose state is not in the statechart: unrestricted tools, no vars", () => {
  const ghost = { ...initialSnapshot(sc, T0), state: "ghost" };
  const text = renderContext(sc, ghost);
  assert.match(text, /tools here: \(unrestricted\) · settable vars: none/);
  assert.match(text, /transitions: \(none\)/);
});

test("renderContext spells out an explicit empty tools list as \"none\", not \"(unrestricted)\"", () => {
  const noTools = loadStatechart('=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a initial final tools=none}\nx\n===\n', "t").statechart;
  assert.match(renderContext(noTools, initialSnapshot(noTools, T0)), /tools here: none ·/);
});
