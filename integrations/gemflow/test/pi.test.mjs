// The supervisor on Pi. Every gate of spec §5.3 is asserted through the
// adapter, driven by a double that runs Pi's own pipeline order and Pi's own
// argument validator (test/helpers/pi.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fakePi } from "./helpers/pi.mjs";
import gemflow, { everyTarget, readSettings, toTypeBox, verbSpecs } from "../dist/hosts/pi/extension.js";
import { journalFromEntries, SNAPSHOT_ENTRY } from "../dist/hosts/pi/journal-entries.js";
import { readJournal, verifyJournal } from "../dist/core/journal.js";
import { loadStatechart } from "../dist/core/statechart.js";
import { dictDoc, flowDoc } from "./helpers/flow.mjs";
import { learnInFile } from "../dist/dictionary-io.js";

const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
const REFUND_TOOLS = readFileSync(new URL("../workflows/refund/tools.geml", import.meta.url), "utf8");
const sc = loadStatechart(readFileSync(FIX, "utf8"), "flow.geml").statechart;

const dirs = [];
/** Write a workflow and its dictionary into a project the way `gemflow init` lays them out; returns the flow file. */
function putWorkflow(dir, name = "refund", text = readFileSync(FIX, "utf8"), tools = REFUND_TOOLS) {
  const file = join(dir, ".geml", "workflows", name, "flow.geml");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  writeFileSync(join(dirname(file), "tools.geml"), tools);
  return file;
}
function workdir(text, tools) {
  const dir = mkdtempSync(join(tmpdir(), "gemflow-pi-"));
  putWorkflow(dir, "refund", text, tools);
  dirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run `fn` as Pi would load the extension: started in `dir`, with `env` laid
 * over the environment. GEMFLOW_STATECHART is cleared unless `env` sets it - a
 * developer's shell must not choose the workflow for these tests.
 */
function startedIn(dir, env, fn) {
  const cwd = process.cwd();
  const saved = new Map(["GEMFLOW_STATECHART", ...Object.keys(env)].map((k) => [k, process.env[k]]));
  delete process.env.GEMFLOW_STATECHART;
  Object.assign(process.env, env);
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

/** Load the extension in a project's directory, then start a session. */
async function loaded({ dir = workdir(), start = "startup", env = {}, ...opts } = {}) {
  const w = fakePi({ dir, ...opts });
  startedIn(dir, env, () => gemflow(w.pi));
  if (start) await w.start(start);
  return { ...w, dir, journalPath: join(dir, "gemflow", `${opts.sessionId ?? "s-1"}.geml`) };
}

/** The fixture's happy path up to (not into) #pay. */
async function toReview(w) {
  await w.callTool("gemflow_set", { order: "A-17", amount: 120 });
  await w.callTool("gemflow_move", { to: "review" });
  await w.callTool("gemflow_set", { approved: true });
}
const VERBS = ["gemflow_status", "gemflow_move", "gemflow_set"];

test("no workflow: nothing is registered and nothing is listened for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gemflow-pi-bare-"));
  dirs.push(dir);
  const w = await loaded({ dir, start: false });
  assert.deepEqual(w.registered(), [], "the Pi equivalent of onMissing: skip");
  assert.equal(w.has("tool_call"), false);
  assert.equal(w.has("session_start"), false);
});

test("a workflow that does not check out reports through Pi's notifier, not the console", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gemflow-pi-bad-"));
  dirs.push(dir);
  // A transition to "nowhere" names no state: an error, so the chart is refused.
  const broken = readFileSync(FIX, "utf8").replace('"to": "review", "guard"', '"to": "nowhere", "guard"');
  putWorkflow(dir, "refund", broken);
  const w = await loaded({ dir });
  assert.deepEqual(w.registered(), []);
  assert.equal(w.notices().length, 1);
  assert.equal(w.notices()[0].type, "error");
  assert.match(w.notices()[0].message, /does not check out/);
});

test("the three verbs are registered once, for the whole session", async () => {
  const w = await loaded();
  assert.deepEqual(w.registered(), VERBS);
  assert.deepEqual(w.activeTools(), ["grep", "pay_refund", "read"], "the agent's own tools are left as they are: the dictionary decides");
});

test("move's enum is the whole workflow, and Pi's own validator enforces it; a real state that is not a transition out is refused", async () => {
  const w = await loaded();
  assert.deepEqual(w.schemaOf("gemflow_move").properties.to.enum, everyTarget(sc));
  const bogus = await w.callTool("gemflow_move", { to: "atlantis" });
  assert.equal(bogus.isError, true);
  // Refused by typebox against the schema we handed Pi, not by our own code.
  assert.match(bogus.text, /\/to enum: must be equal to one of the allowed values/);
  const r = await w.callTool("gemflow_move", { to: "done" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no transition intake→done/);
});

test("the gate: a tool bound to a use the state does not declare is blocked before dispatch and recorded", async () => {
  const w = await loaded();
  const r = await w.callGlobal("pay_refund");
  assert.equal(r.isError, true);
  assert.match(r.text, /pay_refund is refund, which is used only in #pay; the workflow is in #intake/);
  const journal = readJournal(readFileSync(w.journalPath, "utf8"));
  assert.deepEqual(journal.refusals.map((x) => x.tool), ["pay_refund"], "exactly one refusal, naming the tool");
  assert.equal((await w.callGlobal("read")).isError, false);
});

test("the gate: a tool no row takes goes through, unasked, with a UI or without", async () => {
  const asked = [];
  const w = await loaded({ tools: ["read", "grep", "web_fetch"], select: async (q) => { asked.push(q); return undefined; } });
  assert.equal((await w.callGlobal("web_fetch")).isError, false);
  assert.deepEqual(asked, [], "nobody is asked");
  assert.equal(readJournal(readFileSync(w.journalPath, "utf8")).refusals.length, 0);
  const blind = await loaded({ tools: ["read", "grep", "web_fetch"], hasUI: false });
  assert.equal((await blind.callGlobal("web_fetch")).isError, false, "nor refused where nobody could be asked");
  assert.deepEqual(readJournal(readFileSync(blind.journalPath, "utf8")).refusals, []);
});

test("a deny written into the dictionary refuses the call from then on, read afresh", async () => {
  const w = await loaded({ tools: ["read", "grep", "web_fetch"], select: async () => { throw new Error("nothing is asked"); } });
  assert.equal((await w.callGlobal("web_fetch")).isError, false);
  learnInFile(join(w.dir, ".geml", "workflows", "refund", "flow.geml"), [{ kind: "deny", key: "web_fetch", where: "intake" }]);
  const r = await w.callGlobal("web_fetch");
  assert.equal(r.isError, true);
  assert.match(r.text, /you denied web_fetch in #intake/);
});

test("a transition that needs a person is refused to the model and recorded; a machine-judged one is not its to take", async () => {
  const w = await loaded();
  await toReview(w);
  const r = await w.callTool("gemflow_move", { to: "pay" });
  assert.equal(r.isError, true);
  assert.match(r.text, /review→pay needs a person/);
  const journal = readJournal(readFileSync(w.journalPath, "utf8"));
  assert.equal(journal.refusals.length, 1, "a refused move is recorded, not just logged");
  await w.callTool("gemflow_move", { to: "wait-human" });
  assert.equal(readJournal(readFileSync(w.journalPath, "utf8")).snapshots.at(-1).state, "pay", "approved already held: wait-human→pay was taken on its own");
});

test("set of a value of the wrong type is refused by Pi's own validator, and the run does not move", async () => {
  const w = await loaded();
  const r = await w.callTool("gemflow_set", { amount: "lots" });
  assert.equal(r.isError, true);
  assert.match(r.text, /\/amount type: must be integer/);
  const journal = readJournal(readFileSync(w.journalPath, "utf8"));
  assert.equal(journal.snapshots.length, 1, "nothing reached the verb");
  assert.equal(journal.refusals.length, 0);
});

test("the model is given the state's instruction and the snapshot, once per turn", async () => {
  const w = await loaded();
  const first = await w.prompt();
  assert.match(first, /^BASE/);
  assert.match(first, /Collect the order id/);
  assert.match(first, /\[gemflow\] state intake · rev 0/);

  await w.callTool("gemflow_set", { order: "A-17", amount: 120 });
  await w.callTool("gemflow_move", { to: "review" });
  const second = await w.prompt();
  assert.match(second, /refund policy/);
  assert.match(second, /state review · rev 2/);
  assert.equal(second.includes("Collect the order id"), false, "nothing accumulates");
});

test("the journal is written twice and the two agree byte for byte", async () => {
  const w = await loaded();
  await toReview(w);
  const file = readFileSync(w.journalPath, "utf8");
  const entries = w.entries().filter((e) => e.customType === SNAPSHOT_ENTRY);
  assert.ok(entries.length >= 4, "one entry per block");
  assert.equal(journalFromEntries(w.entries()), file, "the branch IS the journal");
  assert.deepEqual(verifyJournal(readJournal(file), sc), []);
});

test("resume reads the branch, not the file", async () => {
  const w = await loaded();
  await toReview(w);
  const branch = w.entries();

  // Same session id, but the file is gone: the entries alone must carry the run.
  rmSync(w.journalPath, { force: true });
  const again = await loaded({ dir: w.dir, branch, start: "resume" });
  const resumed = readJournal(readFileSync(again.journalPath, "utf8"));
  assert.equal(resumed.snapshots.at(-1).rev, 3);
  assert.equal(resumed.snapshots.at(-1).state, "review");
});

test("a fork inherits the chain and gets its own journal with the same prefix", async () => {
  const parent = await loaded();
  await toReview(parent);
  const parentText = readFileSync(parent.journalPath, "utf8");

  const child = await loaded({
    dir: parent.dir,
    branch: parent.entries(),
    sessionId: "s-2",
    start: "fork",
  });
  const childText = readFileSync(child.journalPath, "utf8");
  assert.notEqual(child.journalPath, parent.journalPath, "a forked session has its own journal");
  assert.equal(childText, parentText, "seeded from the inherited entries, byte for byte");

  // The chain continues on the child without touching the parent's file.
  await child.callTool("gemflow_move", { to: "wait-human" });
  const after = readJournal(readFileSync(child.journalPath, "utf8"));
  assert.equal(after.snapshots.at(-1).state, "pay");
  assert.deepEqual(verifyJournal(after, sc), []);
  assert.equal(readFileSync(parent.journalPath, "utf8"), parentText, "the parent is untouched");
});

test("a journal written by the other host is adopted, and becomes the first entry", async () => {
  // What a DSH-written journal looks like to Pi: a file, no entries.
  const first = await loaded();
  await toReview(first);
  const text = readFileSync(first.journalPath, "utf8");

  const adopted = await loaded({ dir: first.dir, branch: [], start: "resume" });
  assert.equal(journalFromEntries(adopted.entries()), text, "the file became the entry");
  await adopted.callTool("gemflow_move", { to: "wait-human" });
  assert.equal(journalFromEntries(adopted.entries()), readFileSync(adopted.journalPath, "utf8"));
});

test("a journal that contradicts itself leaves the session unsupervised", async () => {
  const w = await loaded();
  await toReview(w);
  const tampered = w.entries().map((e) =>
    e.customType === SNAPSHOT_ENTRY ? { ...e, data: { block: e.data.block.replace('"amount":120', '"amount":999') } } : e,
  );
  const broken = await loaded({ dir: w.dir, branch: tampered, sessionId: "s-3", start: "resume" });
  assert.match(broken.notices().at(-1).message, /hash|revision|chain/i);
  const r = await broken.callTool("gemflow_set", { order: "X" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no workflow is supervising/);
});

test("the journal directory comes from the environment", () => {
  assert.equal(readSettings({ GEMFLOW_JOURNAL_DIR: "/tmp/l" }).journalDir, "/tmp/l");
  assert.equal(readSettings({}).journalDir, undefined);
});

test("the workflow is resolved like the CLI resolves it, from the directory pi was started in", () => {
  const dir = workdir();
  assert.deepEqual(readSettings({}, dir).workflow, { name: "refund", path: join(dir, ".geml", "workflows", "refund", "flow.geml") });
  assert.deepEqual(readSettings({ GEMFLOW_STATECHART: "x.geml" }, dir).workflow, { error: "GEMFLOW_STATECHART names x.geml, which does not exist", kind: "invalid" });
  const bare = mkdtempSync(join(tmpdir(), "gemflow-pi-bare-"));
  dirs.push(bare);
  assert.deepEqual(readSettings({}, bare).workflow, { error: "no workflow here: run `gemflow init`", kind: "none" });
});

test("several workflows: .geml/gemflow.geml names the one in force", async () => {
  const dir = workdir();
  putWorkflow(dir, "other");
  const unchosen = await loaded({ dir });
  assert.deepEqual(unchosen.registered(), [], "two workflows and no choice: unsupervised, as the CLI would ask for `gemflow use`");
  assert.equal(unchosen.has("tool_call"), false);
  assert.deepEqual(unchosen.notices(), [{ message: "gemflow: several workflows (other, refund): choose one with `gemflow use <name>`; this session is not supervised", type: "warning" }], "a choice left unmade is said, once per session");

  writeFileSync(join(dir, ".geml", "gemflow.geml"), '=== meta\nflow-workflow = "refund"\n===\n');
  const w = await loaded({ dir });
  assert.ok(w.registered().includes("gemflow_move"));
  assert.match(readJournal(readFileSync(w.journalPath, "utf8")).meta.workflow.replace(/\\/g, "/"), /\.geml\/workflows\/refund\/flow\.geml$/);
});

test("GEMFLOW_STATECHART beats the project layout, and a missing file supervises nothing", async () => {
  const dir = workdir();
  const elsewhere = join(dir, "elsewhere", "chart.geml");
  mkdirSync(dirname(elsewhere), { recursive: true });
  writeFileSync(elsewhere, readFileSync(FIX, "utf8"));
  const w = await loaded({ dir, env: { GEMFLOW_STATECHART: elsewhere } });
  assert.equal(readJournal(readFileSync(w.journalPath, "utf8")).meta.workflow, elsewhere);

  const missing = await loaded({ dir, env: { GEMFLOW_STATECHART: join(dir, "nope.geml") } });
  assert.deepEqual(missing.registered(), []);
  assert.equal(missing.has("tool_call"), false);
  assert.deepEqual(missing.notices().map((n) => [n.type, n.message.replace(/names .*nope\.geml/, "names nope.geml")]),
    [["warning", "gemflow: GEMFLOW_STATECHART names nope.geml, which does not exist; this session is not supervised"]], "a workflow named wrongly is not silent");
});

// -- the gate reads the command of a run tool's call, and its result is evidence ------

const SHELLS = flowDoc({
  initial: "work", states: { work: { description: "Work." }, ship: { description: "Ship.", tools: ["deploy"] }, done: { description: "Done." } },
  vars: { d: { default: false, source: { tool: "deploy" } } },
  transitions: [{ from: "work", to: "ship", note: "x" }, { from: "ship", to: "done", guard: { properties: { d: { const: true } } }, note: "Deployed." }],
});
const SHELLS_TOOLS = dictDoc([{ tool: "read", allow: ["*"] }, { tool: "Bash(*)", allow: ["*"] }, { tool: "Bash(wrangler deploy)", for: "deploy", default: true }]);

test("the gate gets the tool's input: a fenced use and a person's command are refused, one refusal per call; a clean result in the use's state is evidence", async () => {
  const w = await loaded({ dir: workdir(SHELLS, SHELLS_TOOLS), tools: ["read", "bash"] });
  const deploy = await w.callGlobal("bash", { input: { command: "npx wrangler deploy" } });
  assert.equal(deploy.isError, true);
  assert.match(deploy.text, /is deploy, which is used only in #ship/);
  const mark = await w.callGlobal("bash", { input: { command: "gemflow mark d" } });
  assert.equal(mark.isError, true);
  assert.match(mark.text, /for a person/);
  assert.equal((await w.callGlobal("bash", { input: { command: "npm test" } })).isError, false);
  const journal = readJournal(readFileSync(w.journalPath, "utf8"));
  assert.deepEqual(journal.refusals.map((r) => [r.tool, r.call]), [["bash", "call_1"], ["bash", "call_2"]]);

  await w.callTool("gemflow_move", { to: "ship" });
  assert.equal((await w.callGlobal("bash", { input: { command: "wrangler deploy" }, fails: true })).isError, true);
  assert.deepEqual(readJournal(readFileSync(w.journalPath, "utf8")).snapshots.at(-1).state, "ship", "a failed deploy writes the default: nothing changes");
  assert.equal((await w.callGlobal("bash", { input: { command: "npx wrangler deploy" } })).isError, false, "#ship is where deploy belongs");
  assert.equal(readJournal(readFileSync(w.journalPath, "utf8")).snapshots.at(-1).state, "ship", "found by the fenced search, but no key of the line is bound to deploy: no evidence");
  assert.equal((await w.callGlobal("bash", { input: { command: "wrangler deploy" } })).isError, false);
  const last = readJournal(readFileSync(w.journalPath, "utf8")).snapshots.at(-1);
  assert.deepEqual([last.vars.d, last.state, last.by], [true, "done", "signal"], "a clean result is evidence, and the guard it opened was taken");
});

test("verbSpecs projects the workflow, not one state", () => {
  const specs = verbSpecs(sc);
  assert.deepEqual(specs.map((s) => s.name), VERBS);
  // set takes every variable the model may write; which of them the state may
  // change is the verb's decision, not the schema's.
  assert.deepEqual(Object.keys(specs[2].parameters).sort(), ["amount", "approved", "order"]);
  const schema = toTypeBox(specs[2].parameters);
  assert.equal(schema.required, undefined, "every variable is optional: send only what changes");
});

test("a file a write tool wrote goes into the journal, once per file per stage entry; one outside the project, or a failed write, does not", async () => {
  const w = await loaded({ tools: ["read", "write", "edit"] });
  await w.callGlobal("write", { input: { path: join(w.dir, "src", "refund.ts"), content: "x" } });
  await w.callGlobal("edit", { input: { path: "src/refund.ts", oldText: "x", newText: "y" } });
  await w.callGlobal("edit", { input: { path: "README.md", oldText: "a", newText: "b" }, fails: true });
  await w.callGlobal("write", { input: { path: join(tmpdir(), "elsewhere.txt"), content: "x" } });
  const journal = readJournal(readFileSync(w.journalPath, "utf8"));
  assert.deepEqual(journal.writes.map((x) => [x.tool, x.path]), [["write", "src/refund.ts"]]);
  assert.deepEqual(verifyJournal(journal), []);
});
