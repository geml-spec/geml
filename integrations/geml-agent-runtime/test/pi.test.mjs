// The supervisor on Pi. Every gate in design 1.4.2 is asserted through the
// adapter, driven by a double that runs Pi's own pipeline order and Pi's own
// argument validator (test/helpers/pi.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fakePi } from "./helpers/pi.mjs";
import gemlAgent, { everyTarget, readSettings, toTypeBox, verbSpecs } from "../dist/hosts/pi/extension.js";
import { ledgerFromEntries, SNAPSHOT_ENTRY } from "../dist/hosts/pi/ledger-entries.js";
import { readLedger, verifyLedger } from "../dist/core/ledger.js";
import { loadStatechart } from "../dist/core/statechart.js";

const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
const sc = loadStatechart(readFileSync(FIX, "utf8"), "agent.geml").statechart;

const dirs = [];
function workdir() {
  const dir = mkdtempSync(join(tmpdir(), "geml-agent-pi-"));
  copyFileSync(FIX, join(dir, "agent.geml"));
  dirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Load the extension against a statechart in `dir`, then start a session. */
async function loaded({ dir = workdir(), start = "startup", ...opts } = {}) {
  const previous = process.env.GEML_AGENT_STATECHART;
  process.env.GEML_AGENT_STATECHART = join(dir, "agent.geml");
  try {
    const w = fakePi({ dir, ...opts });
    gemlAgent(w.pi);
    if (start) await w.start(start);
    return { ...w, dir, ledgerPath: join(dir, "geml-agent", `${opts.sessionId ?? "s-1"}.geml`) };
  } finally {
    if (previous === undefined) delete process.env.GEML_AGENT_STATECHART;
    else process.env.GEML_AGENT_STATECHART = previous;
  }
}

/** The fixture's happy path up to (not into) #pay. */
async function toReviewApproved(w) {
  await w.callTool("agent_set", { order: "A-17", amount: 120 });
  await w.callTool("agent_transition", { to: "review" });
  await w.callTool("agent_set", { approved: true });
}

test("no statechart: nothing is registered and nothing is listened for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-agent-pi-bare-"));
  dirs.push(dir);
  const w = await loaded({ dir, start: false });
  assert.deepEqual(w.registered(), [], "the Pi equivalent of onMissing: skip");
  assert.equal(w.has("tool_call"), false);
  assert.equal(w.has("session_start"), false);
});

test("a statechart that does not check out reports through Pi's notifier, not the console", async () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-agent-pi-bad-"));
  dirs.push(dir);
  // `to=#nowhere` has no such state: an E-code, so the chart is refused.
  const broken = readFileSync(FIX, "utf8").replace("to=#review", "to=#nowhere");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "agent.geml"), broken);
  const w = await loaded({ dir });
  assert.deepEqual(w.registered(), []);
  assert.equal(w.notices().length, 1);
  assert.equal(w.notices()[0].type, "error");
  assert.match(w.notices()[0].message, /does not check out/);
});

test("gate 1: the active set is the state's tools plus the verbs", async () => {
  const w = await loaded();
  assert.deepEqual(w.activeTools(), ["agent_rollback", "agent_set", "agent_transition", "grep", "read_file"]);
});

test("gate 1: the active set follows the state", async () => {
  const w = await loaded();
  await toReviewApproved(w);
  await w.callTool("agent_transition", { to: "pay" });
  // #pay declares tools="pay_refund" and vars=none, so agent_set goes too: on
  // this host the verb stays registered for the whole session, so dropping it
  // from the active set is the only way gate 1 can hide it.
  assert.deepEqual(w.activeTools(), ["agent_rollback", "agent_transition", "pay_refund"]);
  assert.ok(w.registered().includes("agent_set"), "registered, but not active");
});

test("gate 1 can be traded away for the prompt cache, and gate 3 still holds", async () => {
  const w = await loaded({ dir: workdir() });
  // The default keeps the active set narrow...
  assert.ok(!w.activeTools().includes("pay_refund"));

  const previous = process.env.GEML_AGENT_VISIBILITY;
  process.env.GEML_AGENT_VISIBILITY = "guard-only";
  try {
    const g = await loaded();
    assert.ok(g.activeTools().includes("pay_refund"), "guard-only leaves the tool list alone");
    const denied = await g.callGlobal("pay_refund");
    assert.equal(denied.isError, true, "and gate 3 refuses it anyway");
    assert.match(denied.text, /not available in state #intake/);
  } finally {
    if (previous === undefined) delete process.env.GEML_AGENT_VISIBILITY;
    else process.env.GEML_AGENT_VISIBILITY = previous;
  }
});

test("gate 2: the enum is the whole statechart, and Pi's own validator enforces it", async () => {
  const w = await loaded();
  assert.deepEqual(w.schemaOf("agent_transition").properties.to.enum, everyTarget(sc));
  // Wider than sigma on this host (design 6.5) - but not open: a target that is
  // in no transition at all never reaches the verb.
  const bogus = await w.callTool("agent_transition", { to: "atlantis" });
  assert.equal(bogus.isError, true);
  // Refused by typebox against the schema we handed Pi, not by our own code:
  // a target that appears in no transition never reaches the verb at all.
  assert.match(bogus.text, /\/to enum: must be equal to one of the allowed values/);
});

test("gate 2's backstop: a real state that is not reachable from sigma is refused", async () => {
  const w = await loaded();
  const r = await w.callTool("agent_transition", { to: "done" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no transition from #intake to #done/);
});

test("gate 3: a tool outside the state is blocked before dispatch", async () => {
  const w = await loaded();
  const r = await w.callGlobal("pay_refund");
  assert.equal(r.isError, true);
  assert.match(r.text, /not available in state #intake/);
});

test("gate 4: a transition marked approval is refused when the human says no", async () => {
  const w = await loaded({ confirm: async () => false });
  await toReviewApproved(w);
  const r = await w.callTool("agent_transition", { to: "pay" });
  assert.equal(r.isError, true);
  assert.match(r.text, /approval/i);
  const ledger = readLedger(readFileSync(w.ledgerPath, "utf8"));
  assert.equal(ledger.refusals.length, 1, "a denied approval is recorded, not just logged");
});

test("gate 4: no UI is a denial - print and json modes cannot ask", async () => {
  const w = await loaded({ hasUI: false });
  await toReviewApproved(w);
  const r = await w.callTool("agent_transition", { to: "pay" });
  assert.equal(r.isError, true);
  assert.match(r.text, /approval/i);
});

test("gate 4: the same transition goes through when the human says yes", async () => {
  const w = await loaded();
  await toReviewApproved(w);
  const r = await w.callTool("agent_transition", { to: "pay" });
  assert.equal(r.isError, false, r.text);
  const last = readLedger(readFileSync(w.ledgerPath, "utf8")).snapshots.at(-1);
  assert.equal(last.state, "pay");
  assert.equal(last.vars.approved, true);
});

test("gate 5: a failed guard is refused, recorded, and the run does not move", async () => {
  const w = await loaded();
  const r = await w.callTool("agent_transition", { to: "review" });
  assert.equal(r.isError, true);
  assert.match(r.text, /missing required property/);
  const ledger = readLedger(readFileSync(w.ledgerPath, "utf8"));
  assert.equal(ledger.snapshots.length, 1, "a refusal takes no revision");
  assert.equal(ledger.refusals.length, 1);
});

test("entering a pause state terminates the batch - Pi's concludeTurn", async () => {
  const w = await loaded();
  await w.callTool("agent_set", { order: "A-17", amount: 120 });
  await w.callTool("agent_transition", { to: "review" });
  const r = await w.callTool("agent_transition", { to: "wait-human" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.terminate, true);
});

test("rollback-on-error: a failing external tool rolls the variables back", async () => {
  const w = await loaded();
  await toReviewApproved(w);
  await w.callTool("agent_transition", { to: "pay" });
  const entry = readLedger(readFileSync(w.ledgerPath, "utf8")).snapshots.at(-1).rev;

  const f = await w.callGlobal("pay_refund", { fails: true });
  assert.equal(f.isError, true);
  const after = readLedger(readFileSync(w.ledgerPath, "utf8")).snapshots.at(-1);
  assert.equal(after.cause, "error-rollback");
  assert.equal(after.restores, entry);
  assert.equal(w.messages().length, 1, "the model is told between turns");
  assert.match(w.messages()[0].content, /rolled back to revision/);
});

test("a call the gate blocked is not a failure to roll back from", async () => {
  const w = await loaded();
  await toReviewApproved(w);
  await w.callTool("agent_transition", { to: "pay" });   // #pay has rollback-on-error
  const before = readLedger(readFileSync(w.ledgerPath, "utf8")).snapshots.at(-1).rev;

  const blocked = await w.callGlobal("read_file");        // gate 3 turns it away
  assert.equal(blocked.isError, true);
  const unknown = await w.callGlobal("no_such_tool");     // never existed
  assert.equal(unknown.isError, true);

  const now = readLedger(readFileSync(w.ledgerPath, "utf8")).snapshots.at(-1).rev;
  assert.equal(now, before, "neither is a failure of a tool that ran");
});

test("the model is given the state's instruction and the snapshot, once per turn", async () => {
  const w = await loaded();
  const first = await w.prompt();
  assert.match(first, /^BASE/);
  assert.match(first, /Collect the order id/);
  assert.match(first, /\[geml-agent\] state #intake · rev 0/);

  await w.callTool("agent_set", { order: "A-17", amount: 120 });
  await w.callTool("agent_transition", { to: "review" });
  const second = await w.prompt();
  assert.match(second, /refund policy/);
  assert.match(second, /state #review · rev 2/);
  assert.equal(second.includes("Collect the order id"), false, "nothing accumulates");
});

test("the ledger is written twice and the two agree byte for byte", async () => {
  const w = await loaded();
  await toReviewApproved(w);
  const file = readFileSync(w.ledgerPath, "utf8");
  const entries = w.entries().filter((e) => e.customType === SNAPSHOT_ENTRY);
  assert.ok(entries.length >= 4, "one entry per block");
  assert.equal(ledgerFromEntries(w.entries()), file, "the branch IS the ledger");
  assert.deepEqual(verifyLedger(readLedger(file), sc), []);
});

test("resume reads the branch, not the file", async () => {
  const w = await loaded();
  await toReviewApproved(w);
  const branch = w.entries();

  // Same session id, but the file is gone: the entries alone must carry the run.
  rmSync(w.ledgerPath, { force: true });
  const again = await loaded({ dir: w.dir, branch, start: "resume" });
  const resumed = readLedger(readFileSync(again.ledgerPath, "utf8"));
  assert.equal(resumed.snapshots.at(-1).rev, 3);
  assert.equal(resumed.snapshots.at(-1).state, "review");
  assert.deepEqual(again.activeTools(), ["agent_rollback", "agent_set", "agent_transition", "grep", "read_file"]);
});

test("a fork inherits the chain and gets its own ledger with the same prefix", async () => {
  const parent = await loaded();
  await toReviewApproved(parent);
  const parentText = readFileSync(parent.ledgerPath, "utf8");

  const child = await loaded({
    dir: parent.dir,
    branch: parent.entries(),
    sessionId: "s-2",
    start: "fork",
  });
  const childText = readFileSync(child.ledgerPath, "utf8");
  assert.notEqual(child.ledgerPath, parent.ledgerPath, "a forked session has its own ledger");
  assert.equal(childText, parentText, "seeded from the inherited entries, byte for byte");

  // The chain continues on the child without touching the parent's file.
  await child.callTool("agent_transition", { to: "pay" });
  const after = readLedger(readFileSync(child.ledgerPath, "utf8"));
  assert.equal(after.snapshots.at(-1).state, "pay");
  assert.deepEqual(verifyLedger(after, sc), []);
  assert.equal(readFileSync(parent.ledgerPath, "utf8"), parentText, "the parent is untouched");
});

test("a ledger written by the other host is adopted, and becomes the first entry", async () => {
  // What a DSH-written ledger looks like to Pi: a file, no entries.
  const first = await loaded();
  await toReviewApproved(first);
  const text = readFileSync(first.ledgerPath, "utf8");

  const adopted = await loaded({ dir: first.dir, branch: [], start: "resume" });
  assert.equal(ledgerFromEntries(adopted.entries()), text, "the file became the entry");
  await adopted.callTool("agent_transition", { to: "pay" });
  assert.equal(ledgerFromEntries(adopted.entries()), readFileSync(adopted.ledgerPath, "utf8"));
});

test("a ledger that contradicts itself leaves the session unsupervised", async () => {
  const w = await loaded();
  await toReviewApproved(w);
  const tampered = w.entries().map((e) =>
    e.customType === SNAPSHOT_ENTRY ? { ...e, data: { block: e.data.block.replace('"amount":120', '"amount":999') } } : e,
  );
  const broken = await loaded({ dir: w.dir, branch: tampered, sessionId: "s-3", start: "resume" });
  assert.match(broken.notices().at(-1).message, /hash|revision|chain/i);
  const r = await broken.callTool("agent_set", { order: "X" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no statechart is supervising/);
});

test("the statechart path and the visibility mode come from the environment", () => {
  assert.equal(readSettings({}).visibility, "active-tools");
  assert.equal(readSettings({ GEML_AGENT_VISIBILITY: "guard-only" }).visibility, "guard-only");
  assert.equal(readSettings({ GEML_AGENT_VISIBILITY: "nonsense" }).visibility, "active-tools");
  assert.equal(readSettings({ GEML_AGENT_LEDGER_DIR: "/tmp/l" }).ledgerDir, "/tmp/l");
  assert.equal(readSettings({}).ledgerDir, undefined);
  assert.match(readSettings({}).statechart, /agent\.geml$/);
});

test("verbSpecs projects the statechart, not one state", () => {
  const specs = verbSpecs(sc);
  assert.deepEqual(specs.map((s) => s.name), ["agent_transition", "agent_set", "agent_rollback"]);
  // agent_set takes every declared variable; which of them sigma may write is
  // the verb's decision, not the schema's.
  assert.deepEqual(Object.keys(specs[1].parameters).sort(), ["amount", "approved", "order"]);
  const schema = toTypeBox(specs[1].parameters);
  assert.equal(schema.required, undefined, "every variable is optional: send only what changes");
});
