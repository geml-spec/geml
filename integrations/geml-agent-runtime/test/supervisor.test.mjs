// The supervisor with no host at all: a recording double in place of one.
//
// The two adapter tests (plugin.test.mjs, pi.test.mjs) prove the wiring. This
// one pins the POLICY, which is the part that must not differ between them -
// if a gate's answer is asserted here, neither adapter is free to invent its
// own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { metaFor, openRun, Supervisor, VERBS } from "../dist/core/supervisor.js";
import { readLedger, verifyLedger } from "../dist/core/ledger.js";

const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
const sc = loadStatechart(readFileSync(FIX, "utf8"), "agent.geml").statechart;
const AT = "2026-09-18T00:00:00.000Z";
const GLOBALS = ["read_file", "grep", "pay_refund"];

/** A host that records instead of acting. */
function host({ approve = async () => "allowed-once" } = {}) {
  const blocks = [];
  const notices = [];
  let changes = 0;
  return {
    blocks,
    notices,
    changes: () => changes,
    ledger: () => blocks.join(""),
    port: {
      append: (block) => blocks.push(block),
      approve,
      now: () => AT,
      changed: () => { changes += 1; },
      notify: (summary, body) => notices.push({ summary, body }),
    },
  };
}

/** Open a supervisor on a fresh run, or on the ledger text given. */
function open({ ledgerText = null, source = "startup", ...opts } = {}) {
  const opened = openRun({ sc, session: "s-1", statechartFile: "agent.geml", ledgerText, source, now: AT });
  assert.equal(opened.ok, true, opened.reason);
  const h = host(opts);
  const sup = new Supervisor(sc, opened.run, h.port);
  sup.setNotice(opened.notice);
  for (const block of opened.blocks) h.port.append(block);
  return { sup, h, opened };
}

const meta = (call) => metaFor(AT, call);

test("openRun on nothing: revision 0, a head, and one block to append", () => {
  const opened = openRun({ sc, session: "s-1", statechartFile: "agent.geml", ledgerText: null, source: "startup", now: AT });
  assert.equal(opened.ok, true);
  assert.equal(opened.run.snapshot.rev, 0);
  assert.equal(opened.run.snapshot.state, "intake");
  assert.equal(opened.blocks.length, 1);
  assert.match(opened.head, /profile\s+= "geml-agent\/v1"/);
  assert.equal(opened.notice, "");
});

test("openRun on a ledger resumes it and appends nothing", () => {
  const { sup, h } = open();
  sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  const text = h.ledger();

  const again = openRun({ sc, session: "s-1", statechartFile: "agent.geml", ledgerText: text, source: "resume", now: AT });
  assert.equal(again.ok, true);
  assert.deepEqual(again.blocks, [], "resuming is not an event");
  assert.equal(again.run.snapshot.rev, 1);
});

test("openRun on a cleared session re-enters the initial state on the same chain", async () => {
  const { sup, h } = open();
  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  await sup.invoke("agent_transition", { to: "review" }, meta("c2"));

  const cleared = openRun({ sc, session: "s-1", statechartFile: "agent.geml", ledgerText: h.ledger(), source: "clear", now: AT });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.blocks.length, 1, "clearing IS an event");
  assert.equal(cleared.run.snapshot.state, "intake");
  assert.equal(cleared.run.snapshot.rev, 3, "on the same chain, not a new one");
  assert.equal(cleared.run.snapshot.cause, "enter");
});

test("openRun refuses a ledger that contradicts itself", () => {
  const { sup, h } = open();
  sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  const tampered = h.ledger().replace('"amount":120', '"amount":999');
  const opened = openRun({ sc, session: "s-1", statechartFile: "agent.geml", ledgerText: tampered, source: "resume", now: AT });
  assert.equal(opened.ok, false);
  assert.match(opened.reason, /hash/);
});

test("openRun notices a statechart that changed under a run", () => {
  const { sup, h } = open();
  sup.invoke("agent_set", { order: "A-17" }, meta("c1"));
  const moved = h.ledger().replace(/statechart-hash = "[^"]+"/, 'statechart-hash = "sha256:0000"');
  const opened = openRun({ sc, session: "s-1", statechartFile: "agent.geml", ledgerText: moved, source: "resume", now: AT });
  assert.equal(opened.ok, true, "the current state still exists, so the run continues");
  assert.match(opened.note, /statechart changed/);
  assert.match(opened.notice, /the statechart changed since this run started/);
});

test("gate 1: allow, deny, and the two shapes of unrestricted", async () => {
  const { sup } = open();
  // #intake inherits the document default, tools = "read_file grep".
  assert.deepEqual(sup.allowedGlobals(GLOBALS), { kind: "allow", names: ["read_file", "grep"] });
  // The verbs are never part of the answer: they are ours, not the host's.
  assert.deepEqual(sup.allowedGlobals([...GLOBALS, ...VERBS]).names, ["read_file", "grep"]);
  // Nothing the state admits is registered -> deny every global instead of
  // allowing nothing, because an empty allow-list is a filter hosts refuse.
  assert.deepEqual(sup.allowedGlobals(["pay_refund"]), { kind: "deny", names: ["pay_refund"] });
  // No globals at all: nothing to say.
  assert.deepEqual(sup.allowedGlobals([]), { kind: "unrestricted" });
});

test("gate 1 follows sigma", async () => {
  const { sup } = open();
  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  await sup.invoke("agent_transition", { to: "review" }, meta("c2"));
  await sup.invoke("agent_set", { approved: true }, meta("c3"));
  await sup.invoke("agent_transition", { to: "pay" }, meta("c4"));
  assert.deepEqual(sup.allowedGlobals(GLOBALS), { kind: "allow", names: ["pay_refund"] });
});

test("gate 2 follows sigma: the enum is the outgoing set, nothing wider", async () => {
  const { sup } = open();
  assert.deepEqual(sup.specs().transition.parameters.to.enum, ["review"]);
  assert.deepEqual(Object.keys(sup.specs().set.parameters).sort(), ["amount", "order"]);

  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  await sup.invoke("agent_transition", { to: "review" }, meta("c2"));
  assert.deepEqual(sup.specs().transition.parameters.to.enum, ["pay", "wait-human"]);
  assert.deepEqual(Object.keys(sup.specs().set.parameters), ["approved"]);
});

test("gate 2: a state with no outgoing edge offers no transition tool, and vars=none no set tool", async () => {
  const { sup } = open();
  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  await sup.invoke("agent_transition", { to: "review" }, meta("c2"));
  await sup.invoke("agent_set", { approved: true }, meta("c3"));
  await sup.invoke("agent_transition", { to: "pay" }, meta("c4"));
  assert.equal(sup.specs().set, null, "#pay is vars=none");
  await sup.invoke("agent_transition", { to: "done" }, meta("c5"));
  assert.equal(sup.specs().transition, null, "#done is final");
  assert.ok(sup.specs().rollback, "rollback is always there");
});

test("gate 3 is deny-only, and never applies to our own verbs", () => {
  const { sup } = open();
  assert.equal(sup.deny("read_file"), undefined);
  assert.match(sup.deny("pay_refund"), /not available in state #intake/);
  for (const verb of VERBS) assert.equal(sup.deny(verb), undefined);
});

test("gate 4: a denial refuses the transition, records it, and does not move the run", async () => {
  const { sup, h } = open({ approve: async () => "denied" });
  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  await sup.invoke("agent_transition", { to: "review" }, meta("c2"));
  await sup.invoke("agent_set", { approved: true }, meta("c3"));

  const before = sup.snapshot.rev;
  const outcome = await sup.invoke("agent_transition", { to: "pay" }, meta("c4"));
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /approval was not granted/);
  assert.equal(sup.snapshot.rev, before);
  assert.equal(readLedger(h.ledger()).refusals.length, 1);
});

test("gate 4 is asked only for the edges that ask for it", async () => {
  const asked = [];
  const { sup } = open({ approve: async (req) => { asked.push(req.reason); return "allowed-once"; } });
  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  await sup.invoke("agent_transition", { to: "review" }, meta("c2"));
  assert.deepEqual(asked, [], "#to-review carries no approval");
  await sup.invoke("agent_set", { approved: true }, meta("c3"));
  await sup.invoke("agent_transition", { to: "pay" }, meta("c4"));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /#to-pay/);
});

test("gate 5: every refusal path answers in words and records a block", async () => {
  const { sup, h } = open();
  const cases = [
    [["agent_transition", { to: "done" }], /no transition from #intake to #done/],
    [["agent_transition", { to: "review" }], /missing required property/],
    [["agent_set", { approved: true }], /cannot be set in state #intake/],
    [["agent_set", { nonsense: 1 }], /not a declared variable/],
    [["agent_rollback", { to: "yesterday" }], /neither a revision number nor "checkpoint"/],
    [["agent_rollback", { to: "7" }], /revision/],
  ];
  for (const [[verb, args], expected] of cases) {
    const outcome = await sup.invoke(verb, args, meta("c"));
    assert.equal(outcome.ok, false, `${verb} ${JSON.stringify(args)} should refuse`);
    assert.match(outcome.reason, expected);
  }
  assert.equal(sup.snapshot.rev, 0, "not one of them moved the run");
  // The one that never reached the run (no such edge, unparseable revision) is
  // answered but not recorded; the rest are refusals the audit must see.
  assert.equal(readLedger(h.ledger()).refusals.length, 4);
});

test("an unknown verb is refused rather than thrown", async () => {
  const { sup } = open();
  const outcome = await sup.invoke("agent_teleport", {}, meta("c1"));
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /does not own the tool agent_teleport/);
});

test("concludesTurn is true exactly for pause and final states", async () => {
  const { sup } = open();
  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  assert.equal((await sup.invoke("agent_transition", { to: "review" }, meta("c2"))).concludesTurn, false);
  assert.equal((await sup.invoke("agent_transition", { to: "wait-human" }, meta("c3"))).concludesTurn, true);
});

test("every accepted action tells the host that sigma moved", async () => {
  const { sup, h } = open();
  assert.equal(h.changes(), 0);
  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  assert.equal(h.changes(), 1);
  await sup.invoke("agent_transition", { to: "review" }, meta("c2"));
  assert.equal(h.changes(), 2);
  await sup.invoke("agent_transition", { to: "atlantis" }, meta("c3"));
  assert.equal(h.changes(), 2, "a refusal changes nothing");
});

test("an uncontrollable failure rolls back only where the state asked for it", async () => {
  const { sup, h } = open();
  assert.equal(sup.onToolResult({ name: "read_file", callId: "x1", isError: true }, meta("x1")), null,
    "#intake does not roll back");

  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  await sup.invoke("agent_transition", { to: "review" }, meta("c2"));
  await sup.invoke("agent_set", { approved: true }, meta("c3"));
  await sup.invoke("agent_transition", { to: "pay" }, meta("c4"));
  const entry = sup.snapshot.rev;

  const rolled = sup.onToolResult({ name: "pay_refund", callId: "x2", isError: true }, meta("x2"));
  assert.deepEqual(rolled, { rev: entry + 1, restores: entry, state: "pay" });
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].body, /Recorded state is restored/);
  assert.deepEqual(verifyLedger(readLedger(h.ledger()), sc), []);
});

test("nothing rolls back for a success, one of our own verbs, or a call that never ran", async () => {
  const { sup } = open();
  await sup.invoke("agent_set", { order: "A-17", amount: 120 }, meta("c1"));
  await sup.invoke("agent_transition", { to: "review" }, meta("c2"));
  await sup.invoke("agent_set", { approved: true }, meta("c3"));
  await sup.invoke("agent_transition", { to: "pay" }, meta("c4"));
  const rev = sup.snapshot.rev;

  assert.equal(sup.onToolResult({ name: "pay_refund", callId: "s", isError: false }, meta("s")), null);
  assert.equal(sup.onToolResult({ name: "agent_set", callId: "v", isError: true }, meta("v")), null);
  assert.equal(sup.onToolResult({ name: "nope", callId: "u", isError: true, code: "UNKNOWN_TOOL" }, meta("u")), null);
  // A call gate 3 turned away: nothing ran, so there is nothing to compensate.
  assert.ok(sup.deny("read_file", "d1"));
  assert.equal(sup.onToolResult({ name: "read_file", callId: "d1", isError: true }, meta("d1")), null);
  assert.equal(sup.snapshot.rev, rev);

  // ... but the memory of that denial is spent: a second failure of the same
  // call id is a real one.
  assert.ok(sup.onToolResult({ name: "read_file", callId: "d1", isError: true }, meta("d1")));
});

test("the prompt carries the state's own bytes and the snapshot, plus any notice", async () => {
  const { sup } = open();
  assert.match(sup.instruction(), /^Collect the order id/);
  assert.match(sup.context(), /\[geml-agent\] state #intake · rev 0/);
  assert.match(sup.context(), /tools here: read_file grep · settable vars: order amount/);
  sup.setNotice("[geml-agent] something to know");
  assert.match(sup.context(), /something to know$/);
});

test("metaFor omits the call id rather than leaving it undefined", () => {
  assert.deepEqual(metaFor(AT), { at: AT });
  assert.deepEqual(metaFor(AT, "c1"), { at: AT, call: "c1" });
  assert.deepEqual(metaFor(AT, 7), { at: AT, call: "7" });
});
