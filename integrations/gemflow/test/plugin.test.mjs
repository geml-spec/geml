// The supervisor on a real DeepSeek Harness agent. Every gate of spec §5.3 is
// asserted here against the actual tool pipeline, with no model in the loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { world } from "./helpers/harness.mjs";
import { attach } from "../dist/hosts/dsh/plugin.js";
import { readJournal, verifyJournal } from "../dist/core/journal.js";
import { loadStatechart } from "../dist/core/statechart.js";
import { dictDoc, flowDoc } from "./helpers/flow.mjs";

const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
const REFUND_TOOLS = readFileSync(new URL("./fixtures/refund-tools.geml", import.meta.url), "utf8");
const sc = loadStatechart(readFileSync(FIX, "utf8"), "flow.geml").statechart;

// A GEMFLOW_STATECHART in the developer's shell would pick the workflow for every test here.
delete process.env.GEMFLOW_STATECHART;

/** Write a workflow and its dictionary into a project the way `gemflow init` lays them out; returns the flow file. */
function putWorkflow(dir, name = "refund", text = readFileSync(FIX, "utf8"), tools = REFUND_TOOLS) {
  const file = join(dir, ".geml", "workflows", name, "flow.geml");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  writeFileSync(join(dirname(file), "tools.geml"), tools);
  return file;
}

async function attached(opts = {}) {
  const w = await world(opts);
  putWorkflow(w.dir);
  const config = { journalDir: join(w.dir, "journals"), onMissing: "skip" };
  const a = attach(w.ctx, w.agent, "startup", config);
  return { ...w, a, config };
}

/** Walk the fixture's happy path up to (not into) #pay. */
async function toReview(w) {
  await w.call("gemflow_set", { order: "A-17", amount: 120 });
  await w.call("gemflow_move", { to: "review" });
  await w.call("gemflow_set", { approved: true });
}
const VERBS = ["gemflow_move", "gemflow_set", "gemflow_status"];

test("no workflow in cwd: onMissing skip leaves the agent completely alone", async () => {
  const w = await world();
  const a = attach(w.ctx, w.agent, "startup", { journalDir: join(w.dir, "l"), onMissing: "skip" });
  assert.equal(a, null);
  assert.deepEqual(w.visible(), ["grep", "pay_refund", "read"]);
  await w.dispose();
});

/** Capture every gemflow log line of a world's context, whatever its level. */
function captureLog(w) {
  const lines = [];
  w.ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { if (m.name === "gemflow") lines.push(`${m.type}: ${m.args.join(" ")}`); } });
  return lines;
}

test("loading the refund fixture logs no warning", async () => {
  const w = await world();
  const lines = captureLog(w);
  putWorkflow(w.dir);
  attach(w.ctx, w.agent, "startup", { journalDir: join(w.dir, "journals"), onMissing: "skip" });
  assert.deepEqual(lines.filter((l) => /^(warn|error):/.test(l)), []);
  await w.dispose();
});

test("the verbs are registered beside the agent's own tools; move and set follow the state", async () => {
  const w = await attached();
  assert.deepEqual(w.visible(), [...VERBS, "grep", "pay_refund", "read"]);
  assert.deepEqual(w.schemaOf("gemflow_move").parameters.properties.to.enum, ["review"], "intake→review is the model's");
  assert.deepEqual(Object.keys(w.schemaOf("gemflow_set").parameters.properties).sort(), ["amount", "approved", "order"]);
  await w.call("gemflow_set", { order: "A-17", amount: 120 });
  await w.call("gemflow_move", { to: "review" });
  assert.deepEqual(w.schemaOf("gemflow_move").parameters.properties.to.enum, ["wait-human"], "review→pay needs a person");
  await w.call("gemflow_move", { to: "wait-human" });
  assert.deepEqual(w.visible(), ["gemflow_set", "gemflow_status", "grep", "pay_refund", "read"], "wait-human→pay is the machine's: no move to offer");
  await w.call("gemflow_set", { approved: true });
  assert.equal(w.a.run.snapshot.state, "pay", "the write opened the guard, and the transition was taken on its own");
  assert.deepEqual(w.schemaOf("gemflow_move").parameters.properties.to.enum, ["done"]);
  await w.dispose();
});

test("the gate: a tool bound to a use the state does not declare is denied before dispatch, with a reason the model can read", async () => {
  const w = await attached();
  const r = await w.call("pay_refund");
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /pay_refund is refund, which is used only in #pay; the workflow is in #intake/);
  const journal = readJournal(readFileSync(w.a.journalPath, "utf8"));
  assert.deepEqual(journal.refusals.map((x) => x.tool), ["pay_refund"], "exactly one refusal, naming the tool");
  assert.equal((await w.call("read")).isError, false, "allowed in every state");
  await w.dispose();
});

test("the gate: a tool no row takes goes through; nothing is asked, refused or learned", async () => {
  const w = await attached({ tools: ["read", "grep", "pay_refund", "web_fetch"] });
  const r = await w.call("web_fetch");
  assert.equal(r.isError, false);
  const journal = readJournal(readFileSync(w.a.journalPath, "utf8"));
  assert.deepEqual(journal.refusals, []);
  assert.doesNotMatch(readFileSync(join(w.dir, ".geml", "workflows", "refund", "tools.geml"), "utf8"), /web_fetch/);
  await w.dispose();
});

test("set writes, move moves, and both land in the journal", async () => {
  const w = await attached();
  assert.equal((await w.call("gemflow_set", { order: "A-17", amount: 120 })).isError, false);
  const t = await w.call("gemflow_move", { to: "review" });
  assert.equal(t.isError, false, JSON.stringify(t.content));
  assert.equal(w.a.run.snapshot.state, "review");
  const journal = readJournal(readFileSync(w.a.journalPath, "utf8"));
  assert.deepEqual(journal.diagnostics, []);
  assert.deepEqual(journal.snapshots.map((s) => s.rev), [0, 1, 2]);
  assert.deepEqual(verifyJournal(journal, sc), []);
  await w.dispose();
});

test("a transition that needs a person is not in move's enum, so dsh's own validator refuses it before the verb; a machine-judged one is taken on its own", async () => {
  const w = await attached();
  await toReview(w);
  const r = await w.call("gemflow_move", { to: "pay" });
  assert.equal(r.isError, true);
  assert.match(r.content.map((c) => c.text).join(""), /"to" must be one of \["wait-human"\]/);
  assert.equal(w.a.run.snapshot.state, "review", "a refused move must not move the run");
  await w.call("gemflow_move", { to: "wait-human" });
  assert.equal(w.a.run.snapshot.state, "pay", "approved already held, so wait-human→pay was taken on its own");
  const journal = readJournal(readFileSync(w.a.journalPath, "utf8"));
  assert.deepEqual(journal.refusals, [], "a call the host's validator turned away never reached the supervisor");
  assert.deepEqual(journal.snapshots.map((s) => [s.state, s.by]), [["intake", undefined], ["intake", "model"], ["review", "model"], ["review", "model"], ["wait-human", "model"], ["pay", "model"]]);
  await w.dispose();
});

test("set of a value of the wrong type is refused by dsh's own validator, and the run does not move", async () => {
  const w = await attached();
  const r = await w.call("gemflow_set", { amount: "lots" });
  assert.equal(r.isError, true);
  assert.match(r.content.map((c) => c.text).join(""), /"amount" must be an integer/);
  assert.equal(w.a.run.snapshot.rev, 0);
  const journal = readJournal(readFileSync(w.a.journalPath, "utf8"));
  assert.equal(journal.snapshots.length, 1, "nothing reached the verb");
  await w.dispose();
});

test("resume: a second attach on the same journal comes back at the last revision", async () => {
  const w = await attached();
  await w.call("gemflow_set", { order: "A-17", amount: 120 });
  await w.call("gemflow_move", { to: "review" });
  const path = w.a.journalPath;
  w.a.dispose();

  const again = attach(w.ctx, w.agent, "resume", w.config);
  assert.ok(again);
  assert.equal(again.journalPath, path, "the same session resumes the same journal");
  assert.equal(again.run.snapshot.rev, 2);
  assert.equal(again.run.snapshot.state, "review");
  assert.deepEqual(w.visible(), [...VERBS, "grep", "pay_refund", "read"]);
  await w.dispose();
});

test("the model is given the state's instruction and a snapshot, scoped to this agent", async () => {
  const w = await attached();
  const assembly = await w.ctx.systemPrompt.assemble({ scope: w.agent });
  const section = assembly.sections.find((s) => s.name === "gemflow:state");
  assert.ok(section, "the state's instruction is a prompt section");
  assert.match(section.text, /Collect the order id/);
  const snap = assembly.contexts.find((c) => c.name === "gemflow:snapshot");
  assert.match(snap.text, /\[gemflow\] state intake · rev 0/);

  const global = await w.ctx.systemPrompt.assemble();
  assert.equal(global.sections.some((s) => s.name === "gemflow:state"), false, "another agent must not see it");
  await w.dispose();
});

test("the prompt follows the state", async () => {
  const w = await attached();
  await w.call("gemflow_set", { order: "A-17", amount: 120 });
  await w.call("gemflow_move", { to: "review" });
  const assembly = await w.ctx.systemPrompt.assemble({ scope: w.agent });
  assert.match(assembly.sections.find((s) => s.name === "gemflow:state").text, /refund policy/);
  assert.match(assembly.contexts.find((c) => c.name === "gemflow:snapshot").text, /state review · rev 2/);
  await w.dispose();
});

test("dispose gives the agent its whole tool set back", async () => {
  const w = await attached();
  w.a.dispose();
  assert.deepEqual(w.visible(), ["grep", "pay_refund", "read"]);
  await w.dispose();
});

test("apply(): mounted as a Cordis plugin, an agent is supervised the moment it is published", async () => {
  // The path production takes. Every other test drives `attach` directly; this
  // one proves the `agent/session-start` listener reaches it — and that it does
  // so SYNCHRONOUSLY, before the loop could run a step unsupervised (the event
  // is an `emit`, so nothing awaits our listener).
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
  for (const name of ["read", "grep", "pay_refund"]) {
    ctx.tools.register(defineTool({
      name, description: `The ${name} tool.`,
      parameters: { x: { type: "string", description: "anything" } },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      execute: async () => `${name} ok`,
    }));
  }

  const dir = mkdtempSync(join(tmpdir(), "gemflow-apply-"));
  putWorkflow(dir);
  ctx.plugin(plugin, { journalDir: join(dir, "journals"), onMissing: "skip" });

  const agent = await harness.create(SessionId("apply-1"), {}, { cwd: dir });
  assert.deepEqual(
    ctx.tools.schemas(agent).map((s) => s.name).sort(),
    [...VERBS, "gemflow_note", "grep", "pay_refund", "read"].sort(),
    "supervised with no await in between",
  );

  await ctx.root.fiber.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// -- the workflow is resolved like the CLI resolves it -----------------------

test("several workflows and no choice: unsupervised; .geml/gemflow.geml names the one in force", async () => {
  const w = await world();
  const config = { journalDir: join(w.dir, "journals"), onMissing: "skip" };
  putWorkflow(w.dir, "refund");
  putWorkflow(w.dir, "other");
  const lines = captureLog(w);
  assert.equal(attach(w.ctx, w.agent, "startup", config), null, "two workflows: the CLI would ask for `gemflow use`, and so does this");
  assert.deepEqual(lines, ["warn: several workflows (other, refund): choose one with `gemflow use <name>`; leaving this agent unsupervised"], "a choice left unmade is worth a warning");

  writeFileSync(join(w.dir, ".geml", "gemflow.geml"), '=== meta\nflow-workflow = "refund"\n===\n');
  const a = attach(w.ctx, w.agent, "startup", config);
  assert.ok(a, "the config document chooses");
  assert.match(readJournal(readFileSync(a.journalPath, "utf8")).meta.workflow.replace(/\\/g, "/"), /\.geml\/workflows\/refund\/flow\.geml$/);
  await w.dispose();
});

test("the statechart option, when set, is used before any resolution", async () => {
  const w = await world();
  putWorkflow(w.dir, "refund");
  putWorkflow(w.dir, "other");
  const a = attach(w.ctx, w.agent, "startup", { statechart: ".geml/workflows/refund/flow.geml", journalDir: join(w.dir, "journals"), onMissing: "skip" });
  assert.ok(a, "two workflows would not resolve, but the option names one");
  assert.equal(a.run.snapshot.state, "intake");
  await w.dispose();
});

test("GEMFLOW_STATECHART names the workflow, as it does for the CLI", async () => {
  const w = await world();
  const file = putWorkflow(w.dir, "anywhere");
  putWorkflow(w.dir, "refund");
  const previous = process.env.GEMFLOW_STATECHART;
  process.env.GEMFLOW_STATECHART = file;
  try {
    const a = attach(w.ctx, w.agent, "startup", { journalDir: join(w.dir, "journals"), onMissing: "skip" });
    assert.ok(a);
    assert.equal(readJournal(readFileSync(a.journalPath, "utf8")).meta.workflow, file);
  } finally {
    if (previous === undefined) delete process.env.GEMFLOW_STATECHART;
    else process.env.GEMFLOW_STATECHART = previous;
  }
  await w.dispose();
});

test("an unresolved workflow leaves the agent alone and the log says why", async () => {
  const w = await world();
  const lines = captureLog(w);
  assert.equal(attach(w.ctx, w.agent, "startup", { journalDir: join(w.dir, "journals"), onMissing: "skip" }), null);
  assert.deepEqual(lines, ["debug: no workflow here: run `gemflow init`; leaving this agent unsupervised"]);
  assert.deepEqual(w.visible(), ["grep", "pay_refund", "read"]);

  const named = captureLog(w);
  attach(w.ctx, w.agent, "startup", { statechart: "nope.geml", journalDir: join(w.dir, "journals"), onMissing: "skip" });
  assert.match(named.join("\n"), /no workflow at .*nope\.geml; leaving this agent unsupervised/);
  await w.dispose();
});

test("a workflow the configuration names wrongly is a warning; no workflow at all stays a debug line", async () => {
  const w = await world();
  putWorkflow(w.dir, "refund");
  writeFileSync(join(w.dir, ".geml", "gemflow.geml"), '=== meta\nflow-workflow = "gone"\n===\n');
  const lines = captureLog(w);
  assert.equal(attach(w.ctx, w.agent, "startup", { journalDir: join(w.dir, "journals"), onMissing: "skip" }), null);
  assert.deepEqual(lines, ['warn: .geml/gemflow.geml names workflow "gone", but .geml/workflows has no gone.geml; leaving this agent unsupervised']);
  await w.dispose();
});

test("onMissing fail: an unresolved workflow fails the session's startup with the resolution error", async () => {
  const w = await world();
  assert.throws(() => attach(w.ctx, w.agent, "startup", { journalDir: join(w.dir, "journals"), onMissing: "fail" }),
    /gemflow: no workflow here: run `gemflow init`/);
  assert.throws(() => attach(w.ctx, w.agent, "startup", { statechart: "nope.geml", journalDir: join(w.dir, "journals"), onMissing: "fail" }),
    /gemflow: no workflow at .*nope\.geml/);
  await w.dispose();
});

// -- the gate reads the command of a run tool's call, and its exit status is evidence ----

const SHELLS = flowDoc({
  initial: "work", states: { work: { description: "Work." }, ship: { description: "Ship.", rules: ["deploy"] }, done: { description: "Done." } },
  vars: { d: { default: false, source: { tool: "deploy" } } },
  transitions: [{ from: "work", to: "ship", note: "x" }, { from: "ship", to: "done", guard: { properties: { d: { const: true } } }, note: "Deployed." }],
});
const SHELLS_TOOLS = dictDoc([{ tool: "read", allow: ["*"] }, { tool: "pwsh", allow: ["*"] }, { tool: "Bash(*)", allow: ["*"] }, { tool: "Bash(wrangler deploy)", for: "deploy", default: true }]);

async function withShells(opts = {}) {
  const w = await world({ tools: ["read", "bash", "pwsh"], ...opts });
  putWorkflow(w.dir, "shells", SHELLS, SHELLS_TOOLS);
  const a = attach(w.ctx, w.agent, "startup", { journalDir: join(w.dir, "journals"), onMissing: "skip" });
  const journal = () => readJournal(readFileSync(a.journalPath, "utf8"));
  return { ...w, a, journal };
}

test("bash: the call's command reaches the gate, so a fenced use and a person's command are refused, one refusal per call; a clean exit in the use's state is evidence", async () => {
  const w = await withShells();
  const deploy = await w.call("bash", { command: "npx wrangler deploy" });
  assert.equal(deploy.isError, true);
  assert.match(JSON.stringify(deploy.content), /is deploy, which is used only in #ship/);
  const mark = await w.call("bash", { command: "gemflow mark d" });
  assert.equal(mark.isError, true);
  assert.match(JSON.stringify(mark.content), /for a person/);
  assert.equal((await w.call("bash", { command: "npm test" })).isError, false, "any other command runs");
  assert.deepEqual(w.journal().refusals.map((r) => [r.tool, r.call]), [["bash", "c1"], ["bash", "c2"]]);
  await w.a.whenSettled();
  assert.equal(w.a.run.snapshot.vars.d, false);
  await w.call("gemflow_move", { to: "ship" });
  assert.equal((await w.call("bash", { command: "wrangler deploy" })).isError, false, "#ship is where deploy belongs");
  await w.a.whenSettled();
  assert.deepEqual([w.a.run.snapshot.vars.d, w.a.run.snapshot.state], [true, "done"], "the exit status is evidence, and the guard it opened was taken");
  await w.dispose();
});

test("bash: a command that fails writes its evidence false", async () => {
  const w = await withShells({ failing: ["bash"] });
  await w.call("gemflow_move", { to: "ship" });
  assert.equal((await w.call("bash", { command: "wrangler deploy" })).isError, true);
  await w.a.whenSettled();
  assert.deepEqual([w.a.run.snapshot.vars.d, w.a.run.snapshot.state], [false, "ship"]);
  assert.deepEqual(w.journal().refusals, [], "a tool that ran and failed is no refusal");
  await w.dispose();
});

test("pwsh: a fenced command pattern anywhere in the command text is refused, whatever PowerShell does to the text", async () => {
  // The scanners that read a command line assume POSIX sh; PowerShell quotes
  // and escapes differently (a backtick escapes), so for `pwsh` the only rule
  // is the loose one: the pattern anywhere in the text, with quotes, escapes
  // and line continuations taken out. Fail-safe: it may refuse a command that
  // only mentions the pattern.
  const w = await withShells();
  const commands = [
    "wrangler deploy",
    "Set-Location app; wrangler deploy --env prod",
    "& 'wrangler' deploy",
    "wr`angler deploy",
    "wrangler `\n  deploy",
    'Write-Output "x" | wrangler  deploy',
  ];
  for (const command of commands) {
    const r = await w.call("pwsh", { command });
    assert.equal(r.isError, true, command);
    assert.match(JSON.stringify(r.content), /is deploy, which is used only in #ship/, command);
  }
  assert.deepEqual(w.journal().refusals.map((r) => r.tool), commands.map(() => "pwsh"), "one refusal per denied call");
  assert.equal((await w.call("pwsh", { command: "Get-ChildItem" })).isError, false);
  assert.equal((await w.call("pwsh", {})).isError, false, "no command text, nothing to read");
  assert.equal(w.journal().refusals.length, commands.length);
  await w.dispose();
});

test("pwsh: where the state declares the use, the command runs, and no evidence is written for it", async () => {
  const w = await withShells();
  await w.call("gemflow_move", { to: "ship" });
  assert.equal((await w.call("pwsh", { command: "wrangler deploy" })).isError, false);
  await w.a.whenSettled();
  assert.deepEqual(w.journal().refusals, []);
  assert.equal(w.a.run.snapshot.vars.d, false, "a PowerShell line cannot be split into commands: its exit status is credited to none");
  await w.dispose();
});

test("pwsh: a command that holds gemflow and a person's verb as words is refused, whatever PowerShell does to the text", async () => {
  const w = await withShells();
  const commands = [
    "gemflow mark deploy",
    "& gemflow ADVANCE ship",
    "npx @geml/gemflow unmark deploy",
    "gem`flow mark deploy",
    "& 'gemflow' 'mark' deploy",
    'Write-Output "gemflow mark deploy"',
  ];
  for (const command of commands) {
    const r = await w.call("pwsh", { command });
    assert.equal(r.isError, true, command);
    assert.match(JSON.stringify(r.content), /is for a person, not the model/, command);
  }
  assert.deepEqual(w.journal().refusals.map((r) => r.tool), commands.map(() => "pwsh"), "one refusal per denied call");
  for (const command of ["gemflow status", "Get-Content mark.txt", "Get-GemflowStatus -advance"]) {
    assert.equal((await w.call("pwsh", { command })).isError, false, command);
  }
  await w.dispose();
});

test("the project's session record on DeepSeek Harness: the agent opens a log, gemflow_note writes the decisions, the other sessions' recent decisions are in its context", async () => {
  const { recordSession } = await import("../dist/hosts/dsh/plugin.js");
  const { logName, parseLog } = await import("../dist/core/session-log.js");
  const { recordDecisions, recordPrompt, sessionsDirOf } = await import("../dist/session-store.js");
  const w = await world();
  recordSession(w.agent);
  const file = join(sessionsDirOf(w.dir), logName("dsh", String(w.agent.id)));
  assert.deepEqual(parseLog(readFileSync(file, "utf8")).map((e) => [e.t, e.host]), [["session", "dsh"]]);
  assert.ok(w.visible().includes("gemflow_note"), "the note tool is the agent's");
  await w.call("gemflow_note", { decisions: ["每会话一个文件"] });
  assert.deepEqual(parseLog(readFileSync(file, "utf8")).filter((e) => e.t === "decision").map((e) => e.text), ["每会话一个文件"]);
  recordPrompt(w.dir, "codex", "cx1", "问一句");
  recordDecisions(w.dir, "codex", "cx1", ["合并前先跑三平台 CI"]);
  const assembly = await w.ctx.systemPrompt.assemble({ scope: w.agent });
  assert.match(assembly.contexts.find((c) => c.name === "gemflow:shared-decisions").text, /- 合并前先跑三平台 CI（Codex，\d\d:\d\d）/);
  assert.doesNotMatch(assembly.contexts.find((c) => c.name === "gemflow:shared-decisions").text, /每会话一个文件/, "never its own");
  assert.match(assembly.sections.find((s) => s.name === "gemflow:sessions").text, /`gemflow_note` tool/);
  await w.dispose();
});
