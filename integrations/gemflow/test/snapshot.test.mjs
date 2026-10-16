import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { canonical, hashSnapshot, initialSnapshot, reenterSnapshot, applyPatch, applyTransition, applyRollback, applySignal, applyExpiry, applyHold, checkpointRev, isPaused, stageEntryRev, guardHolds } from "../dist/core/snapshot.js";
import { flowDoc, twoStates } from "./helpers/flow.mjs";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-14T12:00:00Z";
const m = (call) => ({ at: T0, call });
const DEFAULTS = { order: "", amount: 0, approved: false };

test("canonical sorts keys by code point and emits no whitespace", () => {
  assert.equal(canonical({ b: 1, a: [true, null, { z: "x", y: 2 }] }), '{"a":[true,null,{"y":2,"z":"x"}],"b":1}');
  assert.equal(canonical({ "\u{1F600}": 1, "＀": 2 }), '{"＀":2,"\u{1F600}":1}', "by code point, not UTF-16 code unit");
});

test("hashSnapshot is the sha256 of the canonical JSON without hash — pinned", () => {
  const s = { rev: 0, state: "intake", vars: { amount: 0, approved: false }, cause: "enter", parent: null, at: T0 };
  const expected = "sha256:" + createHash("sha256").update(canonical(s), "utf8").digest("hex");
  assert.equal(hashSnapshot(s), expected);
  assert.equal(hashSnapshot({ ...s, hash: "sha256:ignored" }), expected);
});

test("initialSnapshot: rev 0, the initial state, every variable at its default, no parent", () => {
  const s = initialSnapshot(sc, T0);
  assert.deepEqual(s, { rev: 0, state: "intake", vars: DEFAULTS, cause: "enter", parent: null, hash: s.hash, at: T0 });
  assert.equal(s.hash, hashSnapshot({ rev: 0, state: "intake", vars: DEFAULTS, cause: "enter", parent: null, at: T0 }));
});

test("applyPatch: the model's variables, typed by their defaults, chained; refusals change nothing", () => {
  const s0 = initialSnapshot(sc, T0);
  const r = applyPatch(sc, s0, { order: "A-17", amount: 120 }, m("call_01"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.next.vars, { order: "A-17", amount: 120, approved: false });
  assert.deepEqual([r.next.rev, r.next.parent, r.next.cause, r.next.call], [1, s0.hash, "patch", "call_01"]);
  assert.equal(r.next.hash, hashSnapshot({ rev: 1, parent: s0.hash, state: "intake", vars: r.next.vars, cause: "patch", at: T0, call: "call_01" }));
  const unknown = applyPatch(sc, s0, { nonsense: 1 }, m("c"));
  assert.deepEqual(unknown, { ok: false, refusal: { tool: "set", reason: '"nonsense" is not a variable of the workflow', diagnostics: [] } });
  const typed = applyPatch(sc, s0, { amount: "lots" }, m("c"));
  assert.equal(typed.ok, false);
  assert.match(typed.refusal.reason, /not of the variable's type/);
  assert.ok(typed.refusal.diagnostics.length > 0);
  assert.equal(applyPatch(sc, s0, { amount: 1.5 }, m("c")).ok, false, "an integer default types the variable as an integer");
});

test("applyPatch refuses evidence: a variable with a source is not the model's", () => {
  const ev = loadStatechart(twoStates({ vars: { t: { default: false, source: { tool: "test" } }, n: { default: "" } }, b: { tools: ["test"] } }), "t").statechart;
  const s0 = initialSnapshot(ev, T0);
  assert.match(applyPatch(ev, s0, { t: true }, m("c")).refusal.reason, /"t" is evidence \(it has a source\)/);
  assert.equal(applyPatch(ev, s0, { n: "x" }, m("c")).ok, true);
});

test("applyTransition: the guard, the chain, from; refusals for no such transition and a guard that does not hold", () => {
  const s0 = initialSnapshot(sc, T0);
  const r = applyTransition(sc, s0, "review", m("c1"));
  assert.equal(r.ok, true, "a model-judged guard is not the machine's to hold");
  assert.deepEqual([r.next.state, r.next.from, r.next.cause, r.next.rev, r.next.parent], ["review", "intake", "transition", 1, s0.hash]);
  const none = applyTransition(sc, s0, "done", m("c2"));
  assert.deepEqual(none.refusal, { tool: "move", reason: "no transition intake→done", diagnostics: [] });
  const closed = applyTransition(sc, r.next, "pay", m("c3"));
  assert.equal(closed.ok, false);
  assert.match(closed.refusal.reason, /review→pay: the guard does not hold \(approved=false\)/);
  const open = applyTransition(sc, applyPatch(sc, r.next, { approved: true }, m("c4")).next, "pay", m("c5"));
  assert.equal(open.ok, true);
});

test("applyTransition returns the reset variables to their defaults in the same revision, after the guard read them", () => {
  const rs = loadStatechart(twoStates({ vars: { x: { default: false }, n: { default: "" } }, edge: { guard: { properties: { x: { const: true } } }, actions: [{ reset: ["x"] }] } }), "t").statechart;
  const s1 = applyPatch(rs, initialSnapshot(rs, T0), { x: true, n: "kept" }, m("c1")).next;
  const r = applyTransition(rs, s1, "b", m("c2"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.next.vars, { x: false, n: "kept" });
});

test("guardHolds: a machine guard against the variables; a model-judged or absent guard always holds", () => {
  const vars = { ...DEFAULTS };
  const [intakeReview, reviewPay, , waitPay, payDone] = sc.transitions;
  assert.equal(guardHolds(sc, intakeReview, vars), true);
  assert.equal(guardHolds(sc, reviewPay, vars), false);
  assert.equal(guardHolds(sc, waitPay, { ...vars, approved: true }), true);
  assert.equal(guardHolds(sc, payDone, vars), true);
});

test("checkpointRev and applyRollback", () => {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A" }, m("c1")).next;
  const s2 = applyTransition(sc, s1, "review", m("c2")).next;
  const s3 = applyPatch(sc, s2, { approved: true }, m("c3")).next;
  assert.equal(checkpointRev([s0, s1, s2, s3]), 2);
  const back = applyRollback(sc, [s0, s1, s2, s3], "checkpoint", m("c4"));
  assert.equal(back.ok, true);
  assert.deepEqual([back.next.state, back.next.vars, back.next.cause, back.next.from, back.next.restores, back.next.rev], ["review", s2.vars, "rollback", "review", 2, 4]);
  assert.match(applyRollback(sc, [s0, s1], 7, m("c5")).refusal.reason, /revision 7 does not exist/);
  assert.match(applyRollback(sc, [], 0, m("c6")).refusal.reason, /no revision/);
});

test("stageEntryRev: the last enter or transition, a self-loop, or a rollback that restored another state; a patch stays in its stage", () => {
  const loop = loadStatechart(flowDoc({ initial: "a", states: { a: {}, b: {} }, vars: { n: { default: 0 } }, transitions: [{ from: "a", to: "b" }, { from: "b", to: "b" }] }), "t").statechart;
  const s0 = initialSnapshot(loop, T0);
  const s1 = applyTransition(loop, s0, "b", m("c1")).next;
  const s2 = applyPatch(loop, s1, { n: 1 }, m("c2")).next;
  assert.equal(stageEntryRev([s0, s1, s2]), 1);
  const s3 = applyTransition(loop, s2, "b", m("c3")).next;
  assert.equal(stageEntryRev([s0, s1, s2, s3]), 3, "a self-loop is an entry");
  const s4 = applyRollback(loop, [s0, s1, s2, s3], 2, m("c4")).next;
  assert.equal(stageEntryRev([s0, s1, s2, s3, s4]), 3, "a rollback inside the state stays in its stage");
  const s5 = applyRollback(loop, [s0, s1, s2, s3, s4], 0, m("c5")).next;
  assert.equal(stageEntryRev([s0, s1, s2, s3, s4, s5]), 5, "a rollback into another state is an entry");
});

test("reenterSnapshot goes back to the initial state with defaults on the same chain", () => {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyTransition(sc, applyPatch(sc, s0, { order: "A" }, m("c1")).next, "review", m("c2")).next;
  const s2 = reenterSnapshot(sc, s1, T0);
  assert.deepEqual([s2.rev, s2.state, s2.vars, s2.cause, s2.from, s2.parent], [3, "intake", DEFAULTS, "enter", "review", s1.hash]);
});

const EV = loadStatechart(twoStates({
  b: { tools: ["test"] },
  vars: { t: { default: false, source: { tool: "test" } }, h: { default: false, source: "human" }, n: { default: "" } },
  edge: { guard: { properties: { t: { const: true } } } },
}), "ev.geml").statechart;

test("applySignal writes evidence by=signal with the variable's name; the same value again records nothing; the model's variables are refused", () => {
  const s0 = initialSnapshot(EV, T0);
  const r = applySignal(EV, s0, "t", true, { at: T0, call: "c1", by: "model" });
  assert.equal(r.ok, true);
  assert.deepEqual([r.next.vars.t, r.next.by, r.next.signal, r.next.cause, r.next.call], [true, "signal", "t", "patch", "c1"]);
  assert.equal(applySignal(EV, r.next, "t", true, m("c2")), null);
  assert.equal(applySignal(EV, r.next, "t", false, m("c3")).next.vars.t, false);
  assert.match(applySignal(EV, s0, "n", true, m("c4")).refusal.reason, /not a variable with a source/);
  assert.equal(hashSnapshot(r.next), r.next.hash, "by and signal are in the hash like every field but the hash");
});

test("tool evidence written on a content fingerprint carries it, and expires when the content changes; human evidence does not", () => {
  const s0 = initialSnapshot(EV, T0);
  const s1 = applySignal(EV, s0, "t", true, m("c1"), "tree-1").next;
  assert.equal(s1.tree, "tree-1");
  const s2 = applySignal(EV, s1, "h", true, m("c2"), "tree-1").next;
  assert.equal(s2.tree, undefined, "only tool evidence carries the fingerprint");
  assert.equal(applyExpiry(EV, [s0, s1, s2], "tree-1", m()), null, "the same content: nothing expires");
  const expired = applyExpiry(EV, [s0, s1, s2], "tree-2", m());
  assert.deepEqual([expired.cause, expired.by, expired.signal, expired.vars], ["expire", "signal", "t", { t: false, h: true, n: "" }]);
  assert.equal(applyExpiry(EV, [s0, s1, s2, expired], "tree-3", m()), null, "already at its default");
  const unstamped = applySignal(EV, s0, "t", true, m("c3")).next;
  assert.equal(applyExpiry(EV, [s0, unstamped], "tree-9", m()), null, "evidence written without a fingerprint never expires");
});

test("applyHold: a pause or resume keeps the state and the variables, by=human; holding a held item or releasing a free one is refused; an enter lifts a hold", () => {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17" }, m("call_01")).next;
  assert.equal(isPaused([s0, s1]), false);
  const free = applyHold(sc, [s0, s1], false, m());
  assert.equal(free.ok, false);
  assert.deepEqual([free.refusal.tool, free.refusal.reason], ["resume", "the work item is not paused"]);
  const held = applyHold(sc, [s0, s1], true, m("call_02"));
  assert.equal(held.ok, true);
  assert.deepEqual([held.next.cause, held.next.by, held.next.state, held.next.vars, held.next.parent, held.next.rev], ["pause", "human", "intake", s1.vars, s1.hash, 2]);
  assert.equal(isPaused([s0, s1, held.next]), true);
  const again = applyHold(sc, [s0, s1, held.next], true, m());
  assert.deepEqual([again.ok, again.refusal.reason], [false, "the work item is already paused"]);
  const released = applyHold(sc, [s0, s1, held.next], false, m());
  assert.deepEqual([released.ok, released.next.cause, released.next.by], [true, "resume", "human"]);
  assert.equal(isPaused([s0, s1, held.next, released.next]), false);
  const cleared = reenterSnapshot(sc, held.next, T0);
  assert.equal(isPaused([s0, s1, held.next, cleared]), false, "a fresh entry lifts the hold");
  assert.equal(checkpointRev([s0, s1, held.next, released.next]), 0, "a hold is not an entry");
});
