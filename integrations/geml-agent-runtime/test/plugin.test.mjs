// The supervisor on a real DeepSeek Harness agent. Every gate in design §1.4.2
// is asserted here against the actual tool pipeline, with no model in the loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { world } from "./helpers/harness.mjs";
import { attach } from "../dist/hosts/dsh/plugin.js";
import { readLedger, verifyLedger } from "../dist/core/ledger.js";
import { loadStatechart } from "../dist/core/statechart.js";

const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
const sc = loadStatechart(readFileSync(FIX, "utf8"), "agent.geml").statechart;
const allow = async () => "allowed-once";
const deny = async () => "denied";

async function attached(opts = {}, gate = allow) {
  const w = await world(opts);
  copyFileSync(FIX, join(w.dir, "agent.geml"));
  const config = { statechart: "agent.geml", ledgerDir: join(w.dir, "ledgers"), onMissing: "skip" };
  const a = attach(w.ctx, w.agent, "startup", config, gate);
  return { ...w, a, config };
}

/** Walk the fixture's happy path up to (not into) #pay. */
async function toReviewApproved(w) {
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  await w.call("agent_set", { approved: true });
}

test("no statechart in cwd: onMissing skip leaves the agent completely alone", async () => {
  const w = await world();
  const a = attach(w.ctx, w.agent, "startup",
    { statechart: "agent.geml", ledgerDir: join(w.dir, "l"), onMissing: "skip" }, allow);
  assert.equal(a, null);
  assert.deepEqual(w.visible(), ["grep", "pay_refund", "read_file"]);
  await w.dispose();
});

test("gate 1: the initial state shows its own tools plus the agent_* ones", async () => {
  const w = await attached();
  assert.deepEqual(w.visible(), ["agent_rollback", "agent_set", "agent_transition", "grep", "read_file"]);
  await w.dispose();
});

test("gate 3: a tool outside the state is denied before dispatch, with a reason the model can read", async () => {
  const w = await attached();
  const r = await w.call("pay_refund");
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /not available in state #intake/);
  await w.dispose();
});

test("agent_set writes, agent_transition moves, and both land in the ledger", async () => {
  const w = await attached();
  assert.equal((await w.call("agent_set", { order: "A-17", amount: 120 })).isError, false);
  const t = await w.call("agent_transition", { to: "review" });
  assert.equal(t.isError, false, JSON.stringify(t.content));
  assert.equal(w.a.run.snapshot.state, "review");

  const ledger = readLedger(readFileSync(w.a.ledgerPath, "utf8"));
  assert.deepEqual(ledger.diagnostics, []);
  assert.deepEqual(ledger.snapshots.map((s) => s.rev), [0, 1, 2]);
  assert.deepEqual(verifyLedger(ledger, sc), []);
  await w.dispose();
});

test("the visible tool set and the transition enum follow the state", async () => {
  const w = await attached();
  await toReviewApproved(w);
  await w.call("agent_transition", { to: "pay" });
  assert.deepEqual(w.visible(), ["agent_rollback", "agent_transition", "pay_refund"], "no agent_set in a vars=none state");
  assert.deepEqual(w.schemaOf("agent_transition").parameters.properties.to.enum, ["done"]);
  await w.dispose();
});

test("a failed guard is refused and recorded, and the run does not move", async () => {
  const w = await attached();
  const r = await w.call("agent_transition", { to: "review" });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /missing required property/);
  assert.equal(w.a.run.snapshot.rev, 0);

  const ledger = readLedger(readFileSync(w.a.ledgerPath, "utf8"));
  assert.equal(ledger.refusals.length, 1);
  assert.equal(ledger.refusals[0].tool, "agent_transition");
  assert.equal(ledger.snapshots.length, 1, "a refusal takes no revision");
  await w.dispose();
});

test("gate 4: a transition marked approval is refused when the gate denies", async () => {
  const w = await attached({}, deny);
  await toReviewApproved(w);
  const r = await w.call("agent_transition", { to: "pay" });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /approval/i);
  assert.equal(w.a.run.snapshot.state, "review", "a denied approval must not move the run");
  await w.dispose();
});

test("gate 4: the same transition goes through when the gate grants", async () => {
  const w = await attached();
  await toReviewApproved(w);
  const r = await w.call("agent_transition", { to: "pay" });
  assert.equal(r.isError, false, JSON.stringify(r.content));
  assert.equal(w.a.run.snapshot.state, "pay");
  await w.dispose();
});

test("entering a pause state concludes the turn", async () => {
  const w = await attached();
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  const r = await w.call("agent_transition", { to: "wait-human" });
  assert.equal(r.isError, false);
  assert.equal(r.concludesTurn, true);
  await w.dispose();
});

test("rollback-on-error: a failing external tool rolls the variables back", async () => {
  const w = await attached({ failing: ["pay_refund"] });
  await toReviewApproved(w);
  await w.call("agent_transition", { to: "pay" });
  const entry = w.a.run.snapshot.rev;

  const f = await w.call("pay_refund");
  assert.equal(f.isError, true);
  await w.a.whenSettled();
  assert.equal(w.a.run.snapshot.cause, "error-rollback");
  assert.equal(w.a.run.snapshot.restores, entry);

  const ledger = readLedger(readFileSync(w.a.ledgerPath, "utf8"));
  assert.deepEqual(verifyLedger(ledger, sc), []);
  await w.dispose();
});

test("a state without rollback-on-error lets a tool failure stand", async () => {
  const w = await attached({ failing: ["read_file"] });
  const before = w.a.run.snapshot.rev;
  assert.equal((await w.call("read_file")).isError, true);
  await w.a.whenSettled();
  assert.equal(w.a.run.snapshot.rev, before, "#intake does not roll back");
  await w.dispose();
});

test("agent_rollback takes a revision number and the checkpoint marker", async () => {
  const w = await attached();
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  const r = await w.call("agent_rollback", { to: "0" });
  assert.equal(r.isError, false, JSON.stringify(r.content));
  assert.equal(w.a.run.snapshot.state, "intake");
  assert.deepEqual(w.visible(), ["agent_rollback", "agent_set", "agent_transition", "grep", "read_file"]);

  const bad = await w.call("agent_rollback", { to: "yesterday" });
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad.content), /revision number|checkpoint/);
  await w.dispose();
});

test("resume: a second attach on the same ledger comes back at the last revision", async () => {
  const w = await attached();
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  const path = w.a.ledgerPath;
  w.a.dispose();

  const again = attach(w.ctx, w.agent, "resume", w.config, allow);
  assert.ok(again);
  assert.equal(again.ledgerPath, path, "the same session resumes the same ledger");
  assert.equal(again.run.snapshot.rev, 2);
  assert.equal(again.run.snapshot.state, "review");
  assert.deepEqual(w.visible(), ["agent_rollback", "agent_set", "agent_transition", "grep", "read_file"]);
  await w.dispose();
});

test("the model is given the state's instruction and a snapshot, scoped to this agent", async () => {
  const w = await attached();
  const assembly = await w.ctx.systemPrompt.assemble({ scope: w.agent });
  const section = assembly.sections.find((s) => s.name === "geml-agent:state");
  assert.ok(section, "the state's instruction is a prompt section");
  assert.match(section.text, /Collect the order id/);
  const snap = assembly.contexts.find((c) => c.name === "geml-agent:snapshot");
  assert.match(snap.text, /\[geml-agent\] state #intake · rev 0/);

  const global = await w.ctx.systemPrompt.assemble();
  assert.equal(global.sections.some((s) => s.name === "geml-agent:state"), false, "another agent must not see it");
  await w.dispose();
});

test("the prompt follows the state", async () => {
  const w = await attached();
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  const assembly = await w.ctx.systemPrompt.assemble({ scope: w.agent });
  assert.match(assembly.sections.find((s) => s.name === "geml-agent:state").text, /refund policy/);
  assert.match(assembly.contexts.find((c) => c.name === "geml-agent:snapshot").text, /state #review · rev 2/);
  await w.dispose();
});

test("dispose gives the agent its whole tool set back", async () => {
  const w = await attached();
  w.a.dispose();
  assert.deepEqual(w.visible(), ["grep", "pay_refund", "read_file"]);
  await w.dispose();
});

test("apply(): mounted as a Cordis plugin, an agent is supervised the moment it is published", async () => {
  // The path production takes. Every other test drives `attach` directly; this
  // one proves the `agent/session-start` listener reaches it — and that it does
  // so SYNCHRONOUSLY, before the loop could run a step against the unrestricted
  // tool set (the event is an `emit`, so nothing awaits our listener).
  const { Context } = await import("@deepseek-ai/cordis");
  const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } =
    await import("@deepseek-ai/dsh-agent-loop-testkit");
  const { defineTool } = await import("@deepseek-ai/dsh-tools");
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const plugin = await import("../dist/hosts/dsh/plugin.js");

  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  const harness = await mountAgentLoopTestHarness(ctx);
  for (const name of ["read_file", "grep", "pay_refund"]) {
    ctx.tools.register(defineTool({
      name, description: `The ${name} tool.`,
      parameters: { x: { type: "string", description: "anything" } },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      execute: async () => `${name} ok`,
    }));
  }

  const dir = mkdtempSync(join(tmpdir(), "geml-agent-apply-"));
  copyFileSync(FIX, join(dir, "agent.geml"));
  ctx.plugin(plugin, { statechart: "agent.geml", ledgerDir: join(dir, "ledgers"), onMissing: "skip" });

  const agent = await harness.create(SessionId("apply-1"), {}, { cwd: dir });
  assert.deepEqual(
    ctx.tools.schemas(agent).map((s) => s.name).sort(),
    ["agent_rollback", "agent_set", "agent_transition", "grep", "read_file"],
    "supervised with no await in between",
  );

  await ctx.root.fiber.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("a call the gate turned away is not a failure to roll back from", async () => {
  // A guard denial and a tool body throwing look identical on `tools/result`:
  // a message, no code. Rolling back on the first would burn a revision every
  // time the supervisor did its job, and would undo variables over a call that
  // never ran.
  const w = await attached({ failing: ["pay_refund"] });
  await toReviewApproved(w);
  await w.call("agent_transition", { to: "pay" });   // #pay has rollback-on-error
  const before = w.a.run.snapshot.rev;

  const denied = await w.call("read_file");           // gate 3 turns it away
  assert.equal(denied.isError, true);
  const unknown = await w.call("no_such_tool");       // never existed
  assert.equal(unknown.isError, true);
  await w.a.whenSettled();
  assert.equal(w.a.run.snapshot.rev, before, "neither is a failure of a tool that ran");

  const failed = await w.call("pay_refund");          // a body that really failed
  assert.equal(failed.isError, true);
  await w.a.whenSettled();
  assert.equal(w.a.run.snapshot.rev, before + 1);
  assert.equal(w.a.run.snapshot.cause, "error-rollback");
  await w.dispose();
});
