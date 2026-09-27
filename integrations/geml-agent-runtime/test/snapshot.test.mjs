import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { canonical, hashSnapshot, initialSnapshot, reenterSnapshot, applyPatch, applyTransition, applyRollback, checkpointRev } from "../dist/core/snapshot.js";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-14T12:00:00Z";
const m = (call) => ({ at: T0, call });

test("canonical sorts keys by code point and emits no whitespace", () => {
  assert.equal(canonical({ b: 1, a: [true, null, { z: "x", y: 2 }] }), '{"a":[true,null,{"y":2,"z":"x"}],"b":1}');
});

test("canonical sorts by CODE POINT, not UTF-16 code unit", () => {
  // U+FF00 (65280) precedes U+1F600 (128512) by code point, but its UTF-16
  // lead surrogate (D83D) sorts BELOW FF00 — `<` on strings gets this backwards.
  assert.equal(canonical({ "\u{1F600}": 1, "＀": 2 }), '{"＀":2,"\u{1F600}":1}');
  assert.equal(canonical({ "b": 1, "a": 2, "A": 3 }), '{"A":3,"a":2,"b":1}');
});

test("hashSnapshot is pinned — change the algorithm and this fails on purpose", () => {
  assert.equal(
    hashSnapshot({ v: 1, rev: 0, state: "intake", vars: { amount: 0, approved: false } }),
    "sha256:" + "a8db80dc3a867ebfb48f37777aa3266bcf6462c346cd55ea295b059141eb6d22",
  );
});

test("initialSnapshot: rev 0, initial state, defaults, no parent", () => {
  const s = initialSnapshot(sc, T0);
  assert.deepEqual(s, { v: 1, rev: 0, state: "intake", vars: { amount: 0, approved: false }, cause: "enter", hash: s.hash, at: T0 });
  assert.equal(s.hash, hashSnapshot({ v: 1, rev: 0, state: "intake", vars: { amount: 0, approved: false } }));
});

test("applyPatch: allowed keys, schema-checked, chained", () => {
  const s0 = initialSnapshot(sc, T0);
  const r = applyPatch(sc, s0, { order: "A-17", amount: 120 }, m("call_01"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.next.vars, { amount: 120, approved: false, order: "A-17" });
  assert.equal(r.next.rev, 1);
  assert.equal(r.next.parent, s0.hash);
  assert.equal(r.next.cause, "patch");
  assert.equal(r.next.call, "call_01");
  assert.equal(r.next.hash, hashSnapshot({ v: 1, rev: 1, parent: s0.hash, state: "intake", vars: r.next.vars }));
});

test("applyPatch refusals: var not allowed here, unknown var, wrong type — nothing changes", () => {
  const s0 = initialSnapshot(sc, T0);
  const notHere = applyPatch(sc, s0, { approved: true }, m());
  assert.equal(notHere.ok, false);
  assert.equal(notHere.refusal.tool, "agent_set");
  assert.match(notHere.refusal.reason, /"approved" cannot be set in state #intake/);
  const unknown = applyPatch(sc, s0, { nope: 1 }, m());
  assert.match(unknown.refusal.reason, /"nope" is not a declared variable/);
  const badType = applyPatch(sc, s0, { amount: "120" }, m());
  assert.deepEqual(badType.refusal.diagnostics, ["$.amount: expected number, got string"]);
});

test("applyTransition: guard, chain, from; refusals for no edge and failed requires", () => {
  const s0 = initialSnapshot(sc, T0);
  const blocked = applyTransition(sc, s0, "review", m());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.refusal.tool, "agent_transition");
  assert.match(blocked.refusal.reason, /requires #has-order failed/);
  // #vars gives `amount` a default (0), so the initial snapshot already carries it;
  // only `order` (no default) is genuinely missing from `snap.vars` at #intake.
  assert.deepEqual(blocked.refusal.diagnostics, ['$: missing required property "order"']);
  const noEdge = applyTransition(sc, s0, "done", m());
  assert.match(noEdge.refusal.reason, /no transition from #intake to #done/);

  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, m()).next;
  const r = applyTransition(sc, s1, "review", m("call_02"));
  assert.equal(r.ok, true);
  assert.equal(r.next.state, "review");
  assert.equal(r.next.from, "intake");
  assert.equal(r.next.cause, "transition");
  assert.equal(r.next.rev, 2);
  assert.equal(r.next.parent, s1.hash);
});

test("checkpointRev and applyRollback", () => {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, m()).next;
  const s2 = applyTransition(sc, s1, "review", m()).next;
  const s3 = applyPatch(sc, s2, { approved: true }, m()).next;
  const history = [s0, s1, s2, s3];
  assert.equal(checkpointRev(history), 2, "the revision at which #review was entered");
  const back = applyRollback(sc, history, "checkpoint", m("call_09"));
  assert.equal(back.ok, true);
  assert.deepEqual(back.next.vars, s2.vars);
  assert.equal(back.next.state, "review");
  assert.equal(back.next.rev, 4);
  assert.equal(back.next.restores, 2);
  assert.equal(back.next.cause, "rollback");
  assert.equal(back.next.from, "review");
  const toZero = applyRollback(sc, history, 0, m(), "error-rollback");
  assert.equal(toZero.next.state, "intake");
  assert.equal(toZero.next.cause, "error-rollback");
  assert.equal(toZero.next.restores, 0);
  const bad = applyRollback(sc, history, 9, m());
  assert.equal(bad.ok, false);
  assert.equal(bad.refusal.tool, "agent_rollback");
  assert.match(bad.refusal.reason, /revision 9 does not exist/);
});

test("reenterSnapshot goes back to the initial state with defaults and records where it came from", () => {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, m()).next;
  const s2 = applyTransition(sc, s1, "review", m()).next;
  const re = reenterSnapshot(sc, s2, T0);
  assert.equal(re.rev, 3);
  assert.equal(re.state, "intake");
  assert.equal(re.from, "review");
  assert.equal(re.cause, "enter");
  assert.deepEqual(re.vars, { amount: 0, approved: false });
  assert.equal(re.parent, s2.hash);
});

test("canonical sorts keys in every order the comparator can be asked about", () => {
  assert.equal(canonical({ c: 1, a: 2, b: 3 }), '{"a":2,"b":3,"c":1}');
});

test("initialSnapshot and reenterSnapshot fall back to {} when the statechart declares no vars", () => {
  const noVars = loadStatechart('=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a initial final}\nx\n===\n', "t").statechart;
  assert.equal(noVars.vars, undefined);
  const s0 = initialSnapshot(noVars, T0);
  assert.deepEqual(s0.vars, {});
  const re = reenterSnapshot(noVars, s0, T0);
  assert.deepEqual(re.vars, {});
});

test("applyPatch refuses when the snapshot's own state is not in the statechart", () => {
  const ghost = { ...initialSnapshot(sc, T0), state: "ghost" };
  const r = applyPatch(sc, ghost, { order: "x" }, m());
  assert.equal(r.ok, false);
  assert.equal(r.refusal.tool, "agent_set");
  assert.match(r.refusal.reason, /current state #ghost is not in the statechart/);
});

test("applyPatch on a statechart with no agent-vars: no key is ever declared, and an empty patch skips validation", () => {
  const noVars = loadStatechart('=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a initial final}\nx\n===\n', "t").statechart;
  const s0 = initialSnapshot(noVars, T0);
  const empty = applyPatch(noVars, s0, {}, m());
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.next.vars, {});
  const nonEmpty = applyPatch(noVars, s0, { x: 1 }, m());
  assert.equal(nonEmpty.ok, false);
  assert.match(nonEmpty.refusal.reason, /"x" is not a declared variable/);
});

test("checkpointRev of an empty history is 0", () => {
  assert.equal(checkpointRev([]), 0);
});

test("applyRollback refuses on an empty history, and on a revision whose state the statechart no longer has", () => {
  const empty = applyRollback(sc, [], 0, m());
  assert.equal(empty.ok, false);
  assert.equal(empty.refusal.tool, "agent_rollback");
  assert.match(empty.refusal.reason, /no revision to roll back from/);
  const ghostHistory = [{ ...initialSnapshot(sc, T0), rev: 0, state: "ghost" }];
  const ghost = applyRollback(sc, ghostHistory, 0, m());
  assert.equal(ghost.ok, false);
  assert.match(ghost.refusal.reason, /revision 0 is in state #ghost, which the statechart no longer has/);
});
