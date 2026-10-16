// One run of one workflow: the history, the actions, the journal text each
// produces, and coming back from a journal. Everything here is pure — no file
// ever opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "@geml/geml";
import { loadStatechart } from "../dist/core/statechart.js";
import { startRun, resumeRun } from "../dist/core/run.js";
import { readJournal, verifyJournal } from "../dist/core/journal.js";
import { twoStates } from "./helpers/flow.mjs";

const src = readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8");
const sc = loadStatechart(src, "refund.geml").statechart;
const T0 = "2026-09-15T00:00:00Z";
const meta = { item: "s1", workflow: "refund.geml", workflowHash: sc.hash, created: T0 };
const m = (call) => (call === undefined ? { at: T0 } : { at: T0, call });

test("startRun opens at the initial state and yields a head plus revision 0", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  assert.equal(run.snapshot.rev, 0);
  assert.equal(run.snapshot.state, "intake");
  assert.equal(run.history.length, 1);
  assert.match(head, /^=== meta\n/);
  assert.match(block, /^=== data \{#rev-0 format=json\}\n/);
  assert.deepEqual(parse(head + block).diagnostics, []);
});

test("a refused action leaves the run untouched and still yields a block to append; refusals are numbered across every source", () => {
  const { run } = startRun(sc, meta, T0);
  const r = run.transition("done", m("c1"));
  assert.equal(r.ok, false);
  assert.match(r.block, /^=== data \{#refused-1 format=json\}\n/);
  assert.equal(run.snapshot.rev, 0);
  assert.equal(run.refusals, 1);
  const hostRefusal = run.refuse({ tool: "Bash", reason: "fenced", diagnostics: [] }, m("c2"));
  assert.match(hostRefusal, /#refused-2/);
  assert.deepEqual(run.refusalLog, [{ n: 1, rev: 0, call: "c1" }, { n: 2, rev: 0, call: "c2" }]);
});

test("the actions chain revisions and their blocks make a journal that resumes to the same place", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  const blocks = [block];
  const push = (a) => { blocks.push(a.block); return a; };
  assert.equal(push(run.set({ order: "A", amount: 50 }, m("c1"))).ok, true);
  assert.equal(push(run.transition("review", m("c2"))).ok, true);
  assert.equal(push(run.set({ approved: true }, m("c3"))).ok, true);
  assert.equal(push(run.rollback("checkpoint", m("c4"))).ok, true);
  assert.deepEqual(run.history.map((s) => [s.rev, s.state, s.cause]), [[0, "intake", "enter"], [1, "intake", "patch"], [2, "review", "transition"], [3, "review", "patch"], [4, "review", "rollback"]]);
  const text = head + blocks.join("");
  assert.deepEqual(verifyJournal(readJournal(text), sc), []);
  const resumed = resumeRun(sc, text);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.note, undefined);
  assert.deepEqual(resumed.run.snapshot, run.snapshot);
  assert.equal(resumed.run.history.length, 5);
});

test("resumeRun refuses a journal that contradicts itself, or whose state the workflow no longer has; a changed workflow is a note", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  const a = run.set({ order: "A" }, m("c1"));
  const text = head + block + a.block;
  const tampered = resumeRun(sc, text.replace('"order":"A"', '"order":"B"'));
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /hash does not match/);
  const gone = resumeRun(loadStatechart(twoStates(), "t").statechart, text);
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /no longer has state intake/);
  const moved = resumeRun(sc, text.replace(/"workflow-hash":"sha256:[0-9a-f]+"/, '"workflow-hash":"sha256:0000"'));
  assert.equal(moved.ok, true);
  assert.match(moved.note, /workflow changed: sha256:0000 →/);
});

test("evidence, expiry and re-entry go through the run too", () => {
  const ev = loadStatechart(twoStates({ b: { tools: ["test"] }, vars: { t: { default: false, source: { tool: "test" } } }, edge: { guard: { properties: { t: { const: true } } } } }), "ev").statechart;
  const { run } = startRun(ev, { ...meta, workflowHash: ev.hash }, T0);
  const w = run.signal("t", true, m("c1"), "tree-1");
  assert.equal(w.ok, true);
  assert.equal(run.signal("t", true, m("c2"), "tree-1"), null, "already held: no revision");
  assert.equal(run.expire("tree-1", m()), null);
  const x = run.expire("tree-2", m());
  assert.deepEqual([x.snapshot.cause, x.snapshot.vars.t], ["expire", false]);
  const re = run.reenter(T0);
  assert.deepEqual([re.snapshot.cause, re.snapshot.state, re.snapshot.rev], ["enter", "a", 3]);
  assert.match(run.signal("nope", true, m("c3")).block, /#refused-1/, "a bad name is a journaled refusal, not a throw");
});
