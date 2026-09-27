// The three agent_* tools' model-facing shape, recomputed from (statechart,
// snapshot). These specs are what makes gate 2 true by construction: the
// transition tool cannot name a target the current state has no edge to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition } from "../dist/core/snapshot.js";
import { transitionSpec, setSpec, rollbackSpec, toParamEntry } from "../dist/core/tools.js";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-15T00:00:00Z";
const m = () => ({ at: T0 });
const at = (state) => {
  let s = initialSnapshot(sc, T0);
  if (state === "intake") return s;
  s = applyPatch(sc, s, { order: "A-17", amount: 120 }, m()).next;
  s = applyTransition(sc, s, "review", m()).next;
  if (state === "review") return s;
  s = applyPatch(sc, s, { approved: true }, m()).next;
  return applyTransition(sc, s, "pay", m()).next;
};

test("every object schema carries an explicit additionalProperties (DSH refuses otherwise)", () => {
  const walk = (node, path) => {
    if (node === null || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(typeof node.additionalProperties, "boolean", `${path}: needs an explicit additionalProperties`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  for (const spec of [transitionSpec(sc, at("review")), setSpec(sc, at("intake")), rollbackSpec()]) {
    assert.ok(spec);
    walk(spec.parameters, "parameters");
    walk(spec.output.schema, "output.schema");
  }
});

test("agent_transition's to enum is exactly the current state's outgoing targets", () => {
  assert.deepEqual(transitionSpec(sc, at("review")).parameters.to.enum, ["pay", "wait-human"]);
  assert.deepEqual(transitionSpec(sc, at("intake")).parameters.to.enum, ["review"]);
  assert.equal(transitionSpec(sc, { ...at("intake"), state: "done" }), null, "a final state offers no transition tool");
});

test("agent_transition's description names each edge, its guard and its approval gate", () => {
  const d = transitionSpec(sc, at("review")).description;
  assert.match(d, /#to-pay → #pay/);
  assert.match(d, /requires #is-approved/);
  assert.match(d, /needs approval/);
  assert.match(d, /#to-wait → #wait-human/);
  assert.match(d, /The amount is above the threshold/, "the edge's own prose reaches the model");
});

test("agent_set exposes only the variables this state may write, with their own types", () => {
  const spec = setSpec(sc, at("intake"));
  assert.deepEqual(Object.keys(spec.parameters).sort(), ["amount", "order"]);
  assert.equal(spec.parameters.amount.type, "number");
  assert.equal(spec.parameters.order.type, "string");
  assert.equal(spec.parameters.order.required, undefined, "a patch is partial — nothing is required");
  assert.equal(spec.parameters.order.description, "Order id", "the variable's own description carries through");
  assert.deepEqual(Object.keys(setSpec(sc, at("review")).parameters), ["approved"]);
  assert.equal(setSpec(sc, at("pay")), null, "vars=none registers no tool");
});

test("setSpec is null when the statechart declares no variables at all", () => {
  const bare = loadStatechart(
    '=== meta\nprofile = "geml-agent/v1"\n===\n\n=== agent-state {#a initial final}\nx\n===\n',
    "bare.geml",
  ).statechart;
  assert.equal(setSpec(bare, initialSnapshot(bare, T0)), null);
});

test("toParamEntry carries enum and description through, and defaults the description", () => {
  assert.deepEqual(toParamEntry("kind", { type: "string", enum: ["full", "partial"], description: "Kind" }),
    { type: "string", description: "Kind", enum: ["full", "partial"] });
  assert.equal(toParamEntry("x", { type: "boolean" }).description, "the x variable");
  assert.equal(toParamEntry("x", {}).type, "string", "an untyped variable reaches the model as a string");
  const obj = toParamEntry("o", { type: "object", properties: { a: { type: "string" } } });
  assert.equal(obj.additionalProperties, false, "an object variable must close itself for DSH");
  assert.deepEqual(obj.properties, { a: { type: "string" } });
  const arr = toParamEntry("xs", { type: "array", items: { type: "number" } });
  assert.deepEqual(arr.items, { type: "number" });
});

test("agent_rollback takes a revision number or the checkpoint marker", () => {
  const spec = rollbackSpec();
  assert.equal(spec.name, "agent_rollback");
  assert.equal(spec.parameters.to.required, true);
  assert.equal(spec.parameters.to.type, "string");
  assert.match(spec.parameters.to.description, /checkpoint/);
  assert.match(spec.description, /cannot undo an effect/, "the model is told what a rollback does not reach");
});
