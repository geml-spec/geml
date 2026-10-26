// The supervisor with no host at all: a recording double in place of one.
//
// The adapter tests prove the wiring. This one pins the POLICY (spec §5.1,
// §5.3), which is the part that must not differ between hosts: if a gate's
// answer is asserted here, no adapter is free to invent its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { metaFor, openRun, Supervisor, VERBS, WAY_OUT } from "../dist/core/supervisor.js";
import { readJournal, verifyJournal } from "../dist/core/journal.js";
import { CLAUDE_CODE_TOOLS, PI_TOOLS } from "../dist/core/host-tools.js";
import { dict, flowDoc, twoStates } from "./helpers/flow.mjs";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const AT = "2026-09-18T00:00:00.000Z";
const REFUND_ROWS = [{ tool: "read", allow: ["*"] }, { tool: "grep", allow: ["*"] }, { tool: "pay_refund", for: "refund", default: true }];

/** A host that records instead of acting. */
function host({ rows = REFUND_ROWS, tools = PI_TOOLS, tree, isBranch } = {}) {
  const blocks = [];
  let changes = 0;
  const port = {
    append: (block) => blocks.push(block),
    now: () => AT,
    changed: () => { changes += 1; },
    tools,
    dictionary: dict(rows),
    ...(tree !== undefined ? { tree } : {}),
    ...(isBranch !== undefined ? { isBranch } : {}),
  };
  return { blocks, port, journal: () => blocks.join(""), changes: () => changes, refusals: () => readJournal(blocks.join("")).refusals, snapshots: () => readJournal(blocks.join("")).snapshots };
}

/** Open a supervisor on a fresh run (or the journal given) over `chart`, with the host's rows. */
function open({ journalText = null, source = "startup", chart = sc, ...opts } = {}) {
  const opened = openRun({ sc: chart, item: "s-1", workflowFile: "refund.geml", journalText, source, now: AT });
  assert.equal(opened.ok, true, opened.reason);
  const h = host(opts);
  if (journalText === null) h.blocks.push(opened.head);
  const sup = new Supervisor(chart, opened.run, h.port);
  sup.setNotice(opened.notice);
  for (const block of opened.blocks) h.port.append(block);
  return { sup, h, opened };
}

const meta = (call) => metaFor(AT, call);

test("openRun on nothing: revision 0, a head, one block; on a journal it resumes and appends nothing; a cleared session re-enters on the same chain", () => {
  const fresh = openRun({ sc, item: "s-1", workflowFile: "refund.geml", journalText: null, source: "startup", now: AT });
  assert.equal(fresh.ok, true);
  assert.deepEqual([fresh.run.snapshot.rev, fresh.run.snapshot.state, fresh.blocks.length, fresh.notice], [0, "intake", 1, ""]);
  assert.match(fresh.head, /#journal format=json/);
  const { sup, h } = open();
  sup.invoke("set", { order: "A-17", amount: 120 }, meta("c1"));
  sup.invoke("move", { to: "review" }, meta("c2"));
  const again = openRun({ sc, item: "s-1", workflowFile: "refund.geml", journalText: h.journal(), source: "resume", now: AT });
  assert.deepEqual([again.ok, again.blocks, again.run.snapshot.rev], [true, [], 2], "resuming is not an event");
  const cleared = openRun({ sc, item: "s-1", workflowFile: "refund.geml", journalText: h.journal(), source: "clear", now: AT });
  assert.deepEqual([cleared.blocks.length, cleared.run.snapshot.state, cleared.run.snapshot.rev, cleared.run.snapshot.cause], [1, "intake", 3, "enter"]);
});

test("openRun refuses a journal that contradicts itself, and notices a workflow that changed under a run", () => {
  const { sup, h } = open();
  sup.invoke("set", { order: "A-17", amount: 120 }, meta("c1"));
  const tampered = openRun({ sc, item: "s-1", workflowFile: "refund.geml", journalText: h.journal().replace('"amount":120', '"amount":999'), source: "resume", now: AT });
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /hash/);
  const moved = openRun({ sc, item: "s-1", workflowFile: "refund.geml", journalText: h.journal().replace(/"workflow-hash":"[^"]+"/, '"workflow-hash":"sha256:0000"'), source: "resume", now: AT });
  assert.equal(moved.ok, true, "the current state still exists, so the run continues");
  assert.match(moved.note, /workflow changed/);
  assert.match(moved.notice, /the workflow changed since this run started/);
});

test("the gate (spec §5.3): own tools pass; a person-only command is refused; switching the work item passes; a fenced use is refused; the dictionary decides the rest", () => {
  const { sup, h } = open({ isBranch: (n) => n === "feat/y" });
  for (const name of ["status", "move", "set", "gemflow_move", "mcp__gemflow__set"]) assert.deepEqual(sup.gate(name, "c"), { kind: "allow", uses: [] }, name);
  assert.equal(sup.owns("mcp__gemflow__other"), false);
  const person = sup.gate("bash", "c1", { command: "gemflow mark approved" });
  assert.equal(person.kind, "refuse");
  assert.match(person.reason, /for a person/);
  for (const command of ["git switch feat/a", "git checkout -b feat/b", "git checkout feat/y", "git worktree add -b feat/w ../wt && cd ../wt"]) {
    assert.deepEqual(sup.gate("bash", `s-${command}`, { command }), { kind: "allow", uses: [] }, command);
  }
  assert.deepEqual(sup.gate("read", "c2", { file_path: "x" }), { kind: "allow", uses: [] });
  const fenced = sup.gate("pay_refund", "c3", { x: 1 });
  assert.equal(fenced.kind, "refuse");
  assert.match(fenced.reason, /pay_refund is refund, which is used only in #pay; the workflow is in #intake; switching the work item/);
  assert.ok(fenced.reason.endsWith(WAY_OUT));
  assert.deepEqual(sup.gate("web_fetch", "c4", {}), { kind: "allow", uses: [], unknown: ["web_fetch"] }, "a tool no row takes goes through, unasked, named as unknown");
  assert.deepEqual(h.refusals().map((r) => [r.tool, r.call]), [["bash", "c1"], ["pay_refund", "c3"]], "refusals are recorded; an unknown call is no refusal");
  assert.equal(sup.deny("web_fetch", "c5", {}), undefined, "nor does a host with nobody to ask refuse it");
  assert.equal(h.refusals().length, 2);
});

test("the gate reads any tool whose input has a command string; a fenced command pattern is found anywhere in the line", () => {
  const rows = [...REFUND_ROWS, { tool: "Bash(wrangler deploy)", for: "deploy", default: true }];
  const chart = loadStatechart(twoStates({ a: { tools: ["edit"] }, b: { rules: ["deploy"] } }), "d.geml").statechart;
  const { sup, h } = open({ chart, rows, tools: CLAUDE_CODE_TOOLS });
  assert.match(sup.gate("Monitor", "m1", { command: "gemflow mark ok" }).reason, /for a person/);
  assert.match(sup.gate("Monitor", "m2", { command: "npx wrangler deploy" }).reason, /is deploy, which is used only in #b/);
  assert.match(sup.gate("Bash", "b1", { command: "bash -c 'wrangler deploy'" }).reason, /is deploy/);
  assert.deepEqual(sup.gate("Monitor", "m3", { command: ["gemflow", "mark"] }), { kind: "allow", uses: [], unknown: ["Monitor"] }, "a command that is not a string is no command line: the tool is judged by its name");
  assert.deepEqual(h.refusals().map((r) => r.call), ["m1", "m2", "b1"]);
});

test("move: a model-judged or guardless transition is the model's; a machine-judged one is taken on its own; an approval one is a person's", () => {
  const { sup, h } = open();
  const toReview = sup.invoke("move", { to: "review" }, meta("c1"));
  assert.deepEqual(toReview, { ok: true, result: { from: "intake", to: "review", state: "review", entered: [], rev: 1, hash: sup.snapshot.hash } });
  const approval = sup.invoke("move", { to: "pay" }, meta("c2"));
  assert.equal(approval.ok, false);
  assert.match(approval.reason, /review→pay needs a person: they approve it on the Gemflow board or with `gemflow advance pay`/);
  sup.invoke("move", { to: "wait-human" }, meta("c3"));
  const auto = sup.invoke("move", { to: "pay" }, meta("c4"));
  assert.equal(auto.ok, false);
  assert.match(auto.reason, /wait-human→pay is taken on its own when its guard holds \(approved\); it is not yours to take/);
  const none = sup.invoke("move", { to: "done" }, meta("c5"));
  assert.match(none.reason, /no transition wait-human→done/);
  assert.deepEqual(h.refusals().map((r) => [r.tool, r.call]), [["move", "c2"], ["move", "c4"]], "a refusal of a transition that exists is recorded; no such transition is only answered");
  assert.deepEqual(h.snapshots().slice(1).map((s) => [s.state, s.by]), [["review", "model"], ["wait-human", "model"]]);
  assert.equal(h.changes(), 2);
});

test("set: the model's variables, typed by their defaults; evidence is refused; a write that opens a machine guard takes the transition by=model", () => {
  const { sup, h } = open();
  sup.invoke("move", { to: "review" }, meta("c1"));
  sup.invoke("move", { to: "wait-human" }, meta("c2"));
  const bad = sup.invoke("set", { amount: "lots" }, meta("c3"));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not of the variable's type/);
  const ok = sup.invoke("set", { approved: true }, meta("c4"));
  assert.deepEqual(ok, { ok: true, result: { rev: 4, hash: sup.snapshot.hash, vars: { order: "", amount: 0, approved: true }, state: "pay", entered: ["pay"] } });
  assert.deepEqual(h.snapshots().slice(-2).map((s) => [s.cause, s.by, s.state]), [["patch", "model", "wait-human"], ["transition", "model", "pay"]]);
  const ev = loadStatechart(twoStates({ b: { tools: ["test"] }, vars: { t: { default: false, source: { tool: "test" } } } }), "ev").statechart;
  const e = open({ chart: ev });
  const refused = e.sup.invoke("set", { t: true }, meta("c5"));
  assert.match(refused.reason, /"t" is evidence/);
  assert.deepEqual(e.h.refusals().map((r) => r.tool), ["set"]);
  assert.match(sup.invoke("teleport", {}, meta("c6")).reason, /does not own the tool teleport/);
});

const EVIDENCE = loadStatechart(flowDoc({
  initial: "build",
  states: { build: { tools: ["test"] }, review: {}, gate: {}, done: {} },
  vars: { t: { default: false, source: { tool: "test" } }, m: { default: false, source: "human" }, note: { default: "" } },
  transitions: [
    { from: "build", to: "review", guard: { properties: { t: { const: true } } } },
    { from: "review", to: "gate", guard: { properties: { t: { const: true } } } },
    { from: "gate", to: "build" },
    { from: "gate", to: "done", guard: { properties: { m: { const: true } } }, approval: true },
  ],
}), "auto.geml").statechart;
const ROWS = [{ tool: "Bash(npm test)", for: "test", default: true }, { tool: "Read", allow: ["*"] }];
const GREEN = { command: "npm test", exitCode: 0 };

test("a command's exit status writes its evidence and the machine-judged transitions chain while they hold, by=signal", () => {
  const { sup, h } = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  assert.deepEqual(sup.observeCommand(GREEN, meta("c1")), { wrote: ["t"], entered: ["review", "gate"] });
  assert.equal(sup.snapshot.state, "gate");
  assert.deepEqual(h.snapshots().slice(1).map((s) => [s.cause, s.by, s.signal, s.state]), [
    ["patch", "signal", "t", "build"], ["transition", "signal", "t", "review"], ["transition", "signal", "t", "gate"],
  ]);
  assert.deepEqual(sup.observeCommand(GREEN, meta("c2")), { wrote: [], entered: [] }, "no change, no revision");
  assert.deepEqual(sup.observeCommand({ command: "npm test", exitCode: null }, meta("c3")), { wrote: [], entered: [] }, "no exit status, no evidence");
  assert.deepEqual(verifyJournal(readJournal(h.journal()), EVIDENCE), []);
});

test("evidence belongs to the state that declares the use; another tool's success is evidence by its name", () => {
  const { sup } = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  sup.observeCommand(GREEN, meta("c1"));
  assert.equal(sup.snapshot.state, "gate");
  assert.deepEqual(sup.observeCommand({ command: "npm test", exitCode: 1 }, meta("c2")), { wrote: [], entered: [] }, "#gate does not declare test: the run is not its evidence");
  const img = loadStatechart(twoStates({ a: { tools: ["image"] }, vars: { i: { default: false, source: { tool: "image" } } }, edge: { guard: { properties: { i: { const: true } } } } }), "img").statechart;
  const { sup: s2 } = open({ chart: img, rows: [{ tool: "mcp__img__*", for: "image" }], tools: CLAUDE_CODE_TOOLS });
  assert.deepEqual(s2.observeCall("mcp__img__generate", { prompt: "x" }, true, meta("c3")), { wrote: ["i"], entered: ["b"] });
  assert.deepEqual(s2.observeCall("mcp__gemflow__status", {}, false, meta("c4")), { wrote: [], entered: [] }, "own tools are never evidence");
});

test("an approval transition is never taken on its own; a person takes it, and the transitions that follow are the person's", () => {
  const { sup, h } = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  sup.observeCommand(GREEN, meta("c1"));
  assert.deepEqual(sup.mark("m", true, meta()), { ok: true, wrote: ["m"], entered: [] });
  assert.equal(sup.snapshot.state, "gate");
  assert.deepEqual(sup.humanTransition("done", meta()), { ok: true, entered: ["done"] });
  assert.equal(h.snapshots().at(-1).by, "human");
  const back = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  back.sup.observeCommand(GREEN, meta("c1"));
  assert.deepEqual(back.sup.humanTransition("build", meta()), { ok: true, entered: ["build", "review", "gate"] }, "tests still green, so the chain runs again");
  assert.deepEqual(back.h.snapshots().slice(-3).map((s) => [s.state, s.cause, s.by]), [["build", "transition", "human"], ["review", "transition", "human"], ["gate", "transition", "human"]]);
});

test("a person's transition needs the guard too; mark takes only a variable whose source is a person; a missing transition is refused", () => {
  const { sup } = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  sup.observeCommand(GREEN, meta("c1"));
  const closed = sup.humanTransition("done", meta());
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /gate→done: the guard does not hold \(m=false\)/);
  assert.deepEqual(sup.mark("t", true, meta()), { ok: false, reason: "t reads its value from the use test; only a variable whose source is \"human\" is ticked" });
  assert.deepEqual(sup.mark("note", true, meta()), { ok: false, reason: "note is the model's to set, not a person's to tick" });
  assert.deepEqual(sup.mark("zz", true, meta()), { ok: false, reason: 'no variable "zz" in the workflow' });
  assert.match(sup.humanTransition("review", meta()).reason, /no transition gate→review/);
});

test("rollback restores a revision's state and variables, by=human, and the machine-judged transitions that hold there follow", () => {
  const { sup, h } = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  sup.observeCommand(GREEN, meta("c1"));
  const r = sup.rollback(1, meta());
  assert.deepEqual(r, { ok: true, rev: 6, restores: 1, state: "gate", entered: ["review", "gate"] }, "revision 1 is build with the guard open: the chain runs again");
  assert.deepEqual(h.snapshots().slice(-3).map((s) => [s.cause, s.by, s.state]), [["rollback", "human", "build"], ["transition", "human", "review"], ["transition", "human", "gate"]]);
  assert.match(sup.rollback(99, meta()).reason, /revision 99 does not exist/);
});

test("tool evidence expires when the work item's content changes: the variables return to their defaults in one revision, then the chain is judged again", () => {
  const { sup, h } = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS, tree: "tree-1" });
  sup.observeCommand(GREEN, meta("c1"));
  assert.equal(h.snapshots()[1].tree, "tree-1");
  assert.deepEqual(sup.expire(meta()), { expired: false, entered: [] });
  const resumed = openRun({ sc: EVIDENCE, item: "s-1", workflowFile: "auto.geml", journalText: h.journal(), source: "resume", now: AT });
  const h2 = host({ rows: ROWS, tools: CLAUDE_CODE_TOOLS, tree: "tree-2" });
  const again = new Supervisor(EVIDENCE, resumed.run, h2.port);
  assert.deepEqual(again.expire(meta()), { expired: true, entered: [] });
  assert.deepEqual([again.snapshot.cause, again.snapshot.vars.t, again.snapshot.state], ["expire", false, "gate"]);
  const noTree = new Supervisor(EVIDENCE, resumed.run, host({ rows: ROWS, tools: CLAUDE_CODE_TOOLS }).port);
  assert.deepEqual(noTree.expire(meta()), { expired: false, entered: [] }, "no fingerprint, nothing expires");
});

const cycle = (transitions, extra = {}) => loadStatechart(flowDoc({
  initial: "a", states: { a: {}, b: {}, c: {}, d: {} }, vars: { x: { default: true }, ...extra },
  transitions,
}), "cycle.geml").statechart;
const GX = { properties: { x: { const: true } } };

test("a chain of machine-judged transitions is cut where it would enter a state it has been in, and a self-loop is never taken", () => {
  const lap = cycle([{ from: "a", to: "b" }, { from: "b", to: "c", guard: GX }, { from: "c", to: "d", guard: GX }, { from: "d", to: "b", guard: GX }]);
  const { sup, h } = open({ chart: lap, rows: [] });
  const out = sup.invoke("move", { to: "b" }, meta("v1"));
  assert.deepEqual([out.result.state, out.result.entered], ["d", ["c", "d"]], "d → b would re-enter b");
  assert.equal(sup.snapshot.rev, 3);
  assert.deepEqual(verifyJournal(readJournal(h.journal()), lap), []);
  const self = cycle([{ from: "a", to: "a", guard: GX }, { from: "a", to: "b" }]);
  const s = open({ chart: self, rows: [] });
  assert.equal(s.sup.snapshot.rev, 0, "entering the initial state took no self-loop");
  assert.deepEqual(s.sup.invoke("set", { x: true }, meta("v2")).result.entered, []);
});

test("a transition's first machine-judged step never goes straight back to the state it left; a later change takes it normally", () => {
  const rework = loadStatechart(flowDoc({
    initial: "a", states: { a: { tools: ["test"] }, b: {} }, vars: { t: { default: false, source: { tool: "test" } } },
    transitions: [{ from: "a", to: "b", guard: { properties: { t: { const: true } } } }, { from: "b", to: "a" }],
  }), "rework.geml").statechart;
  const { sup } = open({ chart: rework, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  assert.deepEqual(sup.observeCommand(GREEN, meta("c1")), { wrote: ["t"], entered: ["b"] });
  assert.deepEqual(sup.humanTransition("a", meta()), { ok: true, entered: ["a"] }, "the guard still holds, but b is where the person just left");
  assert.equal(sup.snapshot.state, "a");
  assert.deepEqual(sup.observeCommand({ command: "npm test", exitCode: 1 }, meta("c2")), { wrote: ["t"], entered: [] });
  assert.deepEqual(sup.observeCommand(GREEN, meta("c3")), { wrote: ["t"], entered: ["b"] });
  const m = open({ chart: rework, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  m.sup.observeCommand(GREEN, meta("c1"));
  assert.deepEqual(m.sup.invoke("move", { to: "a" }, meta("v1")).result.entered, [], "the model's move back stays too");
});

test("a reset returns a variable to its default in the transition's own revision, whoever takes it, before the next guard is read", () => {
  const rs = loadStatechart(flowDoc({
    initial: "a", states: { a: { tools: ["test"] }, b: {}, c: {} }, vars: { t: { default: false, source: { tool: "test" } }, u: { default: false } },
    transitions: [{ from: "a", to: "b", guard: { properties: { t: { const: true } } }, actions: [{ reset: ["u"] }] }, { from: "b", to: "c", guard: { properties: { u: { const: true } } } }, { from: "b", to: "a", actions: [{ reset: ["t"] }] }],
  }), "rs").statechart;
  const { sup } = open({ chart: rs, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  assert.equal(sup.invoke("set", { u: true }, meta("v1")).ok, true);
  assert.deepEqual(sup.observeCommand(GREEN, meta("c1")), { wrote: ["t"], entered: ["b"] }, "a→b reset u to its default, so b→c does not hold");
  assert.deepEqual([sup.snapshot.vars.t, sup.snapshot.vars.u], [true, false]);
  assert.deepEqual(sup.humanTransition("a", meta()), { ok: true, entered: ["a"] });
  assert.equal(sup.snapshot.vars.t, false, "the way back cleared the evidence");
});

test("entering the initial state takes a machine-judged transition whose guard already holds", () => {
  const chart = cycle([{ from: "a", to: "b", guard: GX }, { from: "b", to: "c" }]);
  const opened = openRun({ sc: chart, item: "t", workflowFile: "w", journalText: null, source: "startup", now: AT });
  assert.deepEqual(opened.run.history.map((s) => [s.state, s.cause]), [["a", "enter"], ["b", "transition"]]);
  assert.equal(opened.blocks.length, 2);
});

test("specs follow the state: move offers the model's transitions only, set the model's variables; status is always there", () => {
  const { sup } = open();
  assert.deepEqual(sup.specs().move.parameters.to.enum, ["review"]);
  assert.deepEqual(Object.keys(sup.specs().set.parameters).sort(), ["amount", "approved", "order"]);
  assert.equal(sup.specs().status.name, "gemflow_status");
  sup.invoke("move", { to: "review" }, meta("c1"));
  assert.deepEqual(sup.specs().move.parameters.to.enum, ["wait-human"], "review→pay needs a person");
  sup.invoke("move", { to: "wait-human" }, meta("c2"));
  assert.equal(sup.specs().move, null, "wait-human→pay is the machine's");
  const ev = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  assert.deepEqual(Object.keys(ev.sup.specs().set.parameters), ["note"]);
  const none = open({ chart: loadStatechart(twoStates(), "n").statechart, rows: [] });
  assert.equal(none.sup.specs().set, null);
});

test("the per-step context: the state's description, the variables, the transitions with their judges, the uses with their tools; and the notice", () => {
  const { sup } = open();
  assert.match(sup.instruction(), /^Intake — Collect the order id/);
  assert.match(sup.context(), /^\[gemflow\] state intake · rev 0 · sha256:/);
  assert.match(sup.context(), /transitions: intake→review \(when the order id and the amount are known\)/);
  assert.match(sup.context(), /tools here: \(none declared\) · settable vars: order amount approved/);
  sup.setNotice("[gemflow] something to know");
  assert.match(sup.context(), /something to know$/);
  sup.invoke("move", { to: "review" }, meta("c1"));
  sup.invoke("set", { approved: true }, meta("c2"));
  sup.humanTransition("pay", meta());
  assert.match(sup.context(), /tools here: refund: pay_refund/);
  assert.match(sup.context(), /transitions: pay→done/);
});

test("usesOfCall and fencedRefusal, for hosts that read a command themselves; VERBS; metaFor omits the call id rather than leaving it undefined", () => {
  const { sup } = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  assert.deepEqual(sup.usesOfCall("Bash", { command: "cd x && npm test" }), ["test"]);
  assert.deepEqual(sup.usesOfCall("Read", { file_path: "x" }), []);
  const d = open({ chart: loadStatechart(twoStates({ b: { rules: ["deploy"] } }), "d").statechart, rows: [{ tool: "Bash(wrangler deploy)", for: "deploy" }] });
  assert.match(d.sup.fencedRefusal("pwsh -c 'wrangler deploy'"), /is deploy, which is used only in #b/);
  assert.equal(d.sup.fencedRefusal("ls"), undefined);
  assert.deepEqual([...VERBS], ["move", "set"]);
  assert.deepEqual(metaFor(AT), { at: AT });
  assert.deepEqual(metaFor(AT, "c1"), { at: AT, call: "c1" });
  assert.deepEqual(metaFor(AT, 7), { at: AT, call: "7" });
});

test("pause (spec §5.5): evidence is still recorded, no transition is taken by anyone; resume takes the machine-judged edge that holds by now, as the person's", () => {
  const { sup, h } = open({ chart: EVIDENCE, rows: ROWS, tools: CLAUDE_CODE_TOOLS });
  assert.equal(sup.paused, false);
  assert.deepEqual(sup.pause(meta()), { ok: true });
  assert.equal(sup.paused, true);
  assert.deepEqual(h.snapshots().at(-1) && [h.snapshots().at(-1).cause, h.snapshots().at(-1).by, h.snapshots().at(-1).state], ["pause", "human", "build"]);
  assert.match(sup.pause(meta()).reason, /already paused/);
  // Evidence is written; the transitions it opens wait.
  assert.deepEqual(sup.observeCommand(GREEN, meta("c1")), { wrote: ["t"], entered: [] });
  assert.equal(sup.snapshot.state, "build");
  const move = sup.invoke("move", { to: "review" }, meta("c2"));
  assert.equal(move.ok, false);
  assert.match(move.reason, /build→review: the work item is paused; a person resumes it on the Gemflow board or with `gemflow resume`/);
  assert.deepEqual(sup.humanTransition("review", meta()), { ok: false, reason: "the work item is paused; a person resumes it on the Gemflow board or with `gemflow resume`" });
  assert.deepEqual(h.refusals().map((r) => [r.tool, r.call]), [["pause", undefined], ["move", "c2"]], "the model's move is recorded; a person's refused advance is only answered");
  assert.match(sup.context(), /\[gemflow\] paused: the work item is paused/);
  assert.deepEqual(sup.resume(meta()), { ok: true, entered: ["review", "gate"] });
  assert.equal(sup.paused, false);
  assert.deepEqual(h.snapshots().slice(-3).map((s) => [s.cause, s.by, s.state]), [["resume", "human", "build"], ["transition", "human", "review"], ["transition", "human", "gate"]]);
  assert.match(sup.resume(meta()).reason, /not paused/);
  assert.doesNotMatch(sup.context(), /paused/);
  assert.deepEqual(verifyJournal(readJournal(h.journal()), EVIDENCE), []);
});
