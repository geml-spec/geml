// One run of one statechart: the history, the three actions, the ledger text
// each produces, and coming back from a ledger. Everything here is pure —
// no file ever opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "@geml/geml";
import { loadStatechart } from "../dist/core/statechart.js";
import { startRun, resumeRun } from "../dist/core/run.js";
import { readLedger, verifyLedger } from "../dist/core/ledger.js";

const src = readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8");
const sc = loadStatechart(src, "refund.geml").statechart;
const T0 = "2026-09-15T00:00:00Z";
const meta = { session: "s1", statechart: "refund.geml", statechartHash: sc.hash, created: T0 };
const m = (call) => (call === undefined ? { at: T0 } : { at: T0, call });

test("startRun opens at the initial state and yields a head plus revision 0", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  assert.equal(run.snapshot.rev, 0);
  assert.equal(run.snapshot.state, "intake");
  assert.equal(run.history.length, 1);
  assert.match(head, /^=== meta\n/);
  assert.match(block, /^=== agent-snapshot \{#rev-0 rev=0 state=#intake cause=enter/);
  assert.deepEqual(parse(head + block).diagnostics, []);
});

test("a refused action leaves the run untouched and still yields a block to append", () => {
  const { run } = startRun(sc, meta, T0);
  const r = run.transition("review", m("c1"));
  assert.equal(r.ok, false);
  assert.equal(run.snapshot.rev, 0, "rev must not move");
  assert.equal(run.history.length, 1);
  assert.match(r.block, /^=== agent-refused \{#refused-1 rev=0 .*tool=agent_transition call=c1/);
  assert.equal(run.refusals, 1);
  const again = run.transition("review", m("c2"));
  assert.match(again.block, /#refused-2/, "refusal numbering keeps counting");
});

test("a full run: set, transition, error-rollback — history and blocks agree", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  let text = head + block;
  for (const step of [
    () => run.set({ order: "A-17", amount: 120 }, m("c1")),
    () => run.transition("review", m("c2")),
    () => run.set({ approved: true }, m("c3")),
    () => run.transition("pay", m("c4")),
  ]) {
    const r = step();
    assert.equal(r.ok, true, JSON.stringify(r));
    text += r.block;
  }
  assert.equal(run.snapshot.state, "pay");
  assert.equal(run.snapshot.rev, 4);

  const back = run.errorRollback(m("c5"));
  assert.equal(back.ok, true);
  assert.equal(back.snapshot.cause, "error-rollback");
  assert.equal(back.snapshot.state, "pay", "error-rollback returns to this state's entry");
  assert.equal(back.snapshot.restores, 4);
  text += back.block;

  const ledger = readLedger(text);
  assert.deepEqual(ledger.diagnostics, []);
  assert.deepEqual(verifyLedger(ledger, sc), []);
  assert.deepEqual(ledger.snapshots.map((s) => s.rev), [0, 1, 2, 3, 4, 5]);
});

test("resumeRun restores the last revision and keeps appending from there", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  let text = head + block;
  text += run.set({ order: "A-17", amount: 120 }, m("c1")).block;
  text += run.transition("review", m("c2")).block;

  const r = resumeRun(sc, text);
  assert.equal(r.ok, true);
  assert.equal(r.run.snapshot.rev, 2);
  assert.equal(r.run.snapshot.state, "review");
  assert.equal(r.run.history.length, 3, "the whole history comes back — rollback needs it");
  const next = r.run.set({ approved: true }, m("c3"));
  assert.equal(next.ok, true);
  assert.equal(next.snapshot.rev, 3);
  assert.equal(next.snapshot.parent, r.run.history[2].hash);
});

test("resumeRun carries the refusal count so numbering does not restart", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  let text = head + block;
  text += run.transition("review", m("c1")).block; // refused-1
  const r = resumeRun(sc, text);
  assert.equal(r.ok, true);
  assert.equal(r.run.refusals, 1);
  assert.match(r.run.transition("review", m("c2")).block, /#refused-2/);
});

test("resumeRun refuses a ledger that does not verify", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  const text = (head + block + run.set({ order: "A-17", amount: 120 }, m("c1")).block)
    .replace('"amount":120', '"amount":999');
  const r = resumeRun(sc, text);
  assert.equal(r.ok, false);
  assert.match(r.reason, /hash does not match/);
});

test("resumeRun refuses an empty ledger", () => {
  const { head } = startRun(sc, meta, T0);
  const r = resumeRun(sc, head);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no revision/);
});

test("resumeRun refuses when the statechart no longer has the current state", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  let text = head + block;
  text += run.set({ order: "A-17", amount: 120 }, m("c1")).block;
  text += run.transition("review", m("c2")).block;

  const other = loadStatechart(
    '=== meta\nprofile = "geml-agent/v1"\n===\n\n=== agent-state {#intake initial final}\nx\n===\n',
    "other.geml",
  ).statechart;
  const gone = resumeRun(other, text);
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /#review/);
});

test("resumeRun notes a changed statechart but still resumes", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  let text = head + block;
  text += run.set({ order: "A-17", amount: 120 }, m("c1")).block;
  text += run.transition("review", m("c2")).block;

  const edited = loadStatechart(src.replace("Do not judge yet.", "Do not judge yet. (edited)"), "refund.geml").statechart;
  const changed = resumeRun(edited, text);
  assert.equal(changed.ok, true);
  assert.match(changed.note, /statechart changed/);
  assert.equal(changed.run.snapshot.state, "review");
});

test("reenter (a cleared session) goes back to the initial state on the same chain", () => {
  const { run } = startRun(sc, meta, T0);
  run.set({ order: "A-17", amount: 120 }, m("c1"));
  const re = run.reenter(T0);
  assert.equal(re.snapshot.state, "intake");
  assert.equal(re.snapshot.rev, 2);
  assert.equal(re.snapshot.from, "intake");
  assert.deepEqual(re.snapshot.vars, { amount: 0, approved: false });
  assert.match(re.block, /cause=enter/);
  assert.equal(run.snapshot.rev, 2, "the run moved with it");
});

test("rollback to an explicit revision, and a refused rollback", () => {
  const { run } = startRun(sc, meta, T0);
  run.set({ order: "A-17", amount: 120 }, m("c1"));
  run.transition("review", m("c2"));
  const back = run.rollback(0, m("c3"));
  assert.equal(back.ok, true);
  assert.equal(back.snapshot.state, "intake");
  assert.equal(back.snapshot.restores, 0);
  assert.deepEqual(back.snapshot.vars, { amount: 0, approved: false });

  const nope = run.rollback(99, m("c4"));
  assert.equal(nope.ok, false);
  assert.equal(nope.refusal.tool, "agent_rollback");
  assert.match(nope.block, /#refused-1/);
});
