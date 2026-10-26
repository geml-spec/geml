import { test, after as afterAll } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadWorkspace, openWorkspace, resolvePromptRef, resolveWorkflow } from "../dist/workspace.js";
import { CLAUDE_CODE_TOOLS, NO_TOOLS } from "../dist/core/host-tools.js";
import { readJournal, verifyJournal } from "../dist/core/journal.js";
import { readContextDoc } from "../dist/core/stagehand.js";
import { readDictionary } from "../dist/core/dictionary-file.js";
import { dictDoc, flowDoc, twoStates } from "./helpers/flow.mjs";

const FIX = new URL("./fixtures/ws-dev/", import.meta.url);
const made = [];
afterAll(() => { for (const d of made) try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a scratch directory left behind is harmless */ } });

const GUIDE = (ref) => (ref === "./guide.geml#build" ? "Run npm test before you push." : undefined);
/** A dictionary for the small workflows of this file: reading and editing allowed everywhere, the test command bound to `test`. */
const SMALL_TOOLS = dictDoc([{ tool: "Read", allow: ["*"] }, { tool: "Edit", allow: ["*"] }, { tool: "Write", allow: ["*"] }, { tool: "Bash(npm test)", for: "test", default: true }, { tool: "Bash(*)", allow: ["*"] }]);
const NPM_TEST = { tool: "Bash", callId: "c1", isError: false, input: { command: "npm test" }, exitCode: 0 };

/**
 * A project with the ws-dev workflow (or `flow`, written as the workflow's
 * flow.geml, with `tools` as its dictionary) active. `open` opens a fresh
 * workspace on it, as a new process would.
 */
function project({ branch = "feat/x", pr, flow, tools, getPrompt = GUIDE, git, hostTools = CLAUDE_CODE_TOOLS } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gemflow-ws-"));
  made.push(root);
  const dir = join(root, ".geml", "workflows", "dev");
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(FIX, dir, { recursive: true });
  if (flow !== undefined) writeFileSync(join(dir, "flow.geml"), flow);
  if (tools !== undefined || flow !== undefined) writeFileSync(join(dir, "tools.geml"), tools ?? SMALL_TOOLS);
  writeFileSync(join(root, ".geml", "gemflow.geml"), '=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "dev"\n===\n');
  let now = 0;
  const open = (extra = {}) => openWorkspace({
    root, tools: hostTools,
    now: () => `2026-10-11T00:${String(Math.floor(now / 60)).padStart(2, "0")}:${String(now++ % 60).padStart(2, "0")}Z`,
    git: git ?? (() => ({ branch, defaultBranch: "main", committed: true })),
    gh: () => (pr === undefined ? { available: false, reason: "gh is not installed" } : { available: true, prOpen: pr, prMerged: false, ci: [] }),
    ...(getPrompt ? { getPrompt } : {}),
    ...extra,
  });
  const journal = (item = "feat/x") => join(root, ".geml", "journals", ...item.split("/")) + ".geml";
  const read = (item) => readJournal(readFileSync(journal(item), "utf8"));
  const context = () => readContextDoc(readFileSync(join(root, ".geml", "context.geml"), "utf8"));
  return { root, dir, open, journal, read, context };
}

test("open: the workflow, the item, and a fresh journal and context on first use", () => {
  const p = project();
  const o = p.open();
  assert.equal(o.ok, true);
  const s = o.ws.status();
  assert.equal(s.workflow.name, "dev");
  assert.deepEqual(s.item, { kind: "item", id: "feat/x" });
  assert.equal(s.state.id, "build");
  assert.ok(existsSync(join(p.root, ".geml", "journals", "feat", "x.geml")));
  const ctx = p.context();
  assert.equal(ctx.state, "build");
  assert.match(ctx.text, /Run npm test before you push\./);
  assert.match(ctx.text, /Tools here:\n  edit: Edit\n  test: Bash\(npm test\)\n  pr: Bash\(gh pr create\)/, "the uses with the dictionary's preferred tools");
});

test("on the default branch nothing is tracked", () => {
  const o = project({ branch: "main" }).open();
  assert.equal(o.ok, true);
  assert.deepEqual(o.ws.status().item, { kind: "inactive", reason: "main · not tracked (work items are branches)" });
  assert.equal(o.ws.before("Edit", "c1", {}), undefined, "an inactive workspace never refuses");
});

test("after: a test run and a PR advance the workflow, and the context follows", () => {
  const p = project({ pr: true });
  const ws = p.open().ws;
  const r1 = ws.after(NPM_TEST);
  assert.deepEqual(r1.entered, []);
  const r2 = ws.refresh();
  assert.deepEqual(r2.entered, ["review"]);
  assert.match(r2.context, /\[gemflow\] stage review/);
  const j = p.read();
  assert.deepEqual(j.snapshots.map((s) => [s.state, s.by ?? "", s.signal ?? ""]), [
    ["build", "", ""], ["build", "signal", "tests-pass"], ["build", "signal", "pr-open"], ["review", "signal", "pr-open"],
  ]);
  assert.equal(p.context().state, "review");
});

test("a second workspace on the same project sees the first one's writes", () => {
  const p = project({ pr: true });
  p.open().ws.after(NPM_TEST);
  const s = p.open().ws.status();
  assert.equal(s.vars["tests-pass"], true);
});

test("the context document holds the variables as a data block: evidence inside the stage rewrites #vars, and geml get reads one value", () => {
  const p = project();
  const ws = p.open().ws;
  assert.equal(p.context().vars["tests-pass"], false);
  ws.after(NPM_TEST);
  assert.equal(p.context().vars["tests-pass"], true);
  const geml = fileURLToPath(new URL("../node_modules/@geml/geml/dist/geml.js", import.meta.url));
  const r = spawnSync(process.execPath, [geml, "get", join(p.root, ".geml", "context.geml"), '#vars["tests-pass"]'], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "true");
});

test("evidence expiry: a value a tool variable took returns to its default once the work item's content changes, in one expire snapshot", () => {
  let tree = "sha256:one";
  const p = project();
  const open = () => p.open({ tree: () => tree }).ws;
  open().after(NPM_TEST);
  assert.equal(open().status().vars["tests-pass"], true, "the same content: the evidence stands");
  tree = "sha256:two";
  const ws = open();
  assert.equal(ws.status().vars["tests-pass"], false, "the content changed: the next operation expires it");
  const j = p.read();
  assert.deepEqual(j.snapshots.slice(-2).map((s) => [s.cause, s.by, s.signal, s.tree]), [["patch", "signal", "tests-pass", "sha256:one"], ["expire", "signal", "tests-pass", undefined]]);
  assert.deepEqual(verifyJournal(j, ws.sc), []);
  ws.after({ ...NPM_TEST, callId: "c2" });
  assert.equal(open().status().vars["tests-pass"], true, "a test run on the new content is evidence again");
});

test("mark and advance are a person's; a machine-judged transition is not the model's to move", () => {
  const p = project({ pr: true });
  const ws = p.open().ws;
  ws.after(NPM_TEST);
  ws.refresh();
  assert.deepEqual(ws.mark("review-ready", true).ok, true);
  assert.deepEqual(ws.advance("build"), { ok: true, entered: ["build"], context: ws.context() });
  assert.equal(ws.status().vars["tests-pass"], false, "the way back reset the evidence");
  const auto = ws.verb("move", { to: "review" }, "v1");
  assert.equal(auto.ok, false);
  assert.match(auto.reason, /build→review is taken on its own/);
});

test("status lists the variables with their sources and the next transitions with whether their guard holds", () => {
  const ws = project({ pr: false }).open().ws;
  const s = ws.status();
  assert.deepEqual(s.sources, { "tests-pass": "tool:test", "pr-open": "git:pr-open", "pr-merged": "git:pr-merged", "ci-pass": "git:ci-success", "review-ready": "human", "deployed-staging": "tool:deploy-staging", "deployed-prod": "tool:deploy-prod" });
  assert.deepEqual(s.next, [{
    name: "build→review", to: "review", judge: "machine", approval: false,
    guard: "(tests-pass = true and pr-open = true or pr-merged = true or review-ready = true)",
    reads: ["pr-merged", "pr-open", "review-ready", "tests-pass"], missing: ["pr-merged", "pr-open", "review-ready", "tests-pass"], holds: false,
    note: "测试通过且 PR 已开；或 PR 已合并；或有人勾选了 review-ready。", label: "评审", toFinal: false, toStart: false,
  }]);
  assert.equal(s.gh.available, true);
});

test("status reads; it appends nothing to an existing journal", () => {
  const p = project();
  const ws = p.open().ws;
  const before = readFileSync(p.journal(), "utf8");
  const s = ws.status();
  assert.deepEqual(s.workflow, { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程" });
  assert.deepEqual(s.state, { id: "build", title: "构建", rev: 0, uses: ["edit", "test", "pr"], final: false, since: s.state.since });
  assert.match(s.state.since, /^\d{4}-/);
  assert.equal(readFileSync(p.journal(), "utf8"), before);
});

test("mark refuses a variable whose source is not a person, and an unknown one, without writing", () => {
  const p = project();
  const ws = p.open().ws;
  const before = readFileSync(p.journal(), "utf8");
  assert.deepEqual(ws.mark("tests-pass", true), { ok: false, reason: 'tests-pass reads its value from the use test; only a variable whose source is "human" is ticked' });
  assert.equal(ws.mark("nope", true).ok, false);
  assert.equal(readFileSync(p.journal(), "utf8"), before);
});

// --- Stagehand reads the prompt in process -------------------------------------

const PROMPT_FLOW = (ref) => flowDoc({ initial: "build", states: { build: { description: "Build.", prompt: ref }, done: { description: "Done." } }, transitions: [{ from: "build", to: "done", note: "Shipped." }] });

test("by default a state's prompt is read in process: ./ from the workflow's directory, anything else from the project root, Markdown included; outside the project is not read", () => {
  const p = project({ getPrompt: null, flow: PROMPT_FLOW("docs/CONTRIBUTING.md#testing") });
  mkdirSync(join(p.root, "docs"));
  writeFileSync(join(p.root, "docs", "CONTRIBUTING.md"), "# Contributing\r\n\r\n## Testing\r\n\r\nRun npm test.\r\n\r\n## Other\r\n\r\nx\r\n");
  assert.equal(p.open().ok, true);
  const text = p.context().text;
  assert.match(text, /--- docs\/CONTRIBUTING\.md#testing ---\n## Testing\n\nRun npm test\.$/);
  assert.doesNotMatch(text, /\r/);
  const q = project({ getPrompt: null, flow: PROMPT_FLOW("./guide.geml#build") });
  assert.equal(q.open().ok, true);
  assert.match(q.context().text, /--- \.\/guide\.geml#build ---\n# 构建 \{#build\}\n/);
  const missing = project({ getPrompt: null, flow: PROMPT_FLOW("docs/CONTRIBUTING.md#nope") });
  missing.open();
  assert.match(missing.context().text, /--- docs\/CONTRIBUTING\.md#nope ---\n\(not found\)$/);
  const out = project({ getPrompt: null });
  const outside = `${basename(out.root)}-outside.geml`;
  writeFileSync(join(out.root, "..", outside), "# X {#x}\n\nOutside the project.\n");
  made.push(join(out.root, "..", outside));
  writeFileSync(join(out.dir, "flow.geml"), PROMPT_FLOW(`../${outside}#x`));
  out.open();
  assert.ok(out.context().text.endsWith(`--- ../${outside}#x ---\n(not found)`), "a block outside the project is not read");
});

// --- a person's transition and the model's verbs ------------------------------------

const APPROVAL_FLOW = flowDoc({
  initial: "draft", states: { draft: { description: "Draft." }, live: { description: "Live." }, done: { description: "Done." } },
  vars: { n: { default: 0 } },
  transitions: [{ from: "draft", to: "live", approval: true, note: "Publishing needs a person." }, { from: "live", to: "done", note: "Closed." }],
});

test("verb: a transition that needs a person is refused to the model and recorded; a person takes it, and the context follows", () => {
  const p = project({ flow: APPROVAL_FLOW });
  const ws = p.open().ws;
  const r = ws.verb("move", { to: "live" }, "v1");
  assert.deepEqual(r, { ok: false, reason: "draft→live needs a person: they approve it on the Gemflow board or with `gemflow advance live`" });
  let j = p.read();
  assert.deepEqual(j.refusals.map((x) => [x.n, x.tool, x.call, x.reason]), [[1, "move", "v1", r.reason]]);
  assert.deepEqual(j.snapshots.map((s) => s.state), ["draft"]);
  const a = ws.advance("live");
  assert.deepEqual([a.ok, a.entered], [true, ["live"]]);
  j = p.read();
  assert.deepEqual(j.snapshots.map((s) => [s.state, s.by ?? "", s.call ?? ""]), [["draft", "", ""], ["live", "human", ""]]);
  assert.equal(p.context().state, "live");
  assert.match(a.context, /^\[gemflow\] stage live · rev 1\n/, "the person's move carries the new stage text");
  assert.equal(a.context, ws.context());
  const same = ws.verb("set", { n: 2 }, "v3");
  assert.equal(same.ok, true);
  assert.equal(same.context, undefined, "a verb that leaves the stage as it was carries none");
  const closed = ws.verb("move", { to: "done" }, "v4");
  assert.equal(closed.ok, true);
  assert.match(closed.context, /^\[gemflow\] stage done · rev 3\n/, "the model's move carries it too");
});

test("verb on an inactive workspace says why", () => {
  const r = project({ branch: "main" }).open().ws.verb("set", { "tests-pass": true }, "v1");
  assert.deepEqual(r, { ok: false, reason: "main · not tracked (work items are branches)" });
});

test("after: a call before refused never ran, so its exit status writes no evidence; the same line under another call id does", () => {
  const p = project();
  const line = "gemflow mark x && npm test";
  assert.match(p.open().ws.before("Bash", "c1", { command: line }), /is for a person/);
  p.open().ws.after({ tool: "Bash", callId: "c1", isError: false, input: { command: line }, exitCode: 0 });
  assert.equal(p.open().ws.status().vars["tests-pass"], false, "the refused call wrote nothing");
  p.open().ws.after({ tool: "Bash", callId: "c2", isError: false, input: { command: line }, exitCode: 0 });
  assert.equal(p.open().ws.status().vars["tests-pass"], true);
});

test("after: a refusal with no call id excuses nothing", () => {
  const p = project();
  const ws = p.open().ws;
  assert.match(ws.before("Bash", undefined, { command: "gemflow mark x" }), /is for a person/);
  assert.equal(p.read().refusals[0].call, undefined);
  ws.after({ tool: "Bash", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.equal(ws.status().vars["tests-pass"], true);
});

test("after: evidence belongs to the state that declares the use — a test run in a state without `test` runs (no rule fences it) and writes nothing", () => {
  const p = project({ pr: true });
  const ws = p.open().ws;
  ws.after(NPM_TEST);
  ws.refresh();
  ws.mark("review-ready", true);
  const deploy = project({ flow: twoStates({ a: { tools: ["edit"] }, b: { tools: ["test"] }, vars: { t: { default: false, source: { tool: "test" } } } }) });
  const w = deploy.open().ws;
  assert.equal(w.before("Bash", "c0", { command: "npm test" }), undefined, "test is no rule: it runs in #a too");
  w.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.equal(w.status().vars.t, false, "#a declares no test");
  assert.equal(w.advance("b").ok, true);
  w.after({ tool: "Bash", callId: "c2", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.equal(w.status().vars.t, true);
});

// --- numbers come from the journal on disk ----------------------------------

test("two workspaces taking turns on one journal number refusals and revisions as one", () => {
  const p = project({ pr: true });
  const a = p.open().ws, b = p.open().ws;
  assert.match(a.before("Bash", "c1", { command: "wrangler deploy --env production" }), /is deploy-prod, which is used only in #release/);
  assert.match(b.before("Bash", "c2", { command: "gemflow mark reviewed" }), /is for a person/);
  assert.equal(b.before("Read", "c3", {}), undefined);
  assert.equal(b.verb("set", { "tests-pass": true }, "v1").ok, false, "evidence is not the model's");
  a.after({ tool: "Bash", callId: "c6", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.deepEqual(b.refresh().entered, ["review"]);
  assert.deepEqual(a.mark("review-ready", true).ok, true);
  assert.deepEqual(b.advance("build").entered, ["build"]);
  const j = p.read();
  assert.deepEqual(verifyJournal(j), []);
  assert.deepEqual(j.snapshots.map((s) => s.rev), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(j.refusals.map((r) => [r.n, r.tool]), [[1, "Bash"], [2, "Bash"], [3, "set"]]);
  assert.equal(a.status().refusals, 3);
});

// --- work items ---------------------------------------------------------------

test("a repository with no commits yet tracks nothing, and says so", () => {
  const ws = project({ git: () => ({ noCommits: true }) }).open().ws;
  const s = ws.status();
  assert.deepEqual(s.item, { kind: "inactive", reason: "no commits yet" });
  assert.deepEqual(s.gh, { available: false, reason: "no commits yet" });
  assert.deepEqual(project({ git: () => ({}) }).open().ws.status().item, { kind: "inactive", reason: "not a git repository" });
});

test("a branch name that cannot name a journal tracks nothing, and nothing is written", () => {
  const p = project({ branch: "feat/../../escape" });
  const o = p.open();
  assert.equal(o.ok, true);
  assert.equal(o.ws.status().item.kind, "inactive");
  assert.match(o.ws.status().item.reason, /not a safe work item id/);
  assert.equal(existsSync(join(p.root, ".geml", "journals")), false);
});

const FILE_UNIT = (glob) => readFileSync(new URL("flow.geml", FIX), "utf8").replace('profile = "geml-statechart/v1"', `profile = "geml-statechart/v1"\nflow-unit = "file:${glob}"`);
const DEV_TOOLS = readFileSync(new URL("tools.geml", FIX), "utf8");

test("a file work item: the file written last, remembered by the context document for the next process", () => {
  const p = project({ flow: FILE_UNIT("episodes/*.md"), tools: DEV_TOOLS, git: () => ({}) });
  mkdirSync(join(p.root, "episodes"));
  writeFileSync(join(p.root, "episodes", "ep02.md"), "# Ep 2\n");
  assert.deepEqual(p.open().ws.item, { kind: "inactive", reason: "no work item yet: edit a file matching episodes/*.md" });
  assert.deepEqual(p.open({ lastFile: "episodes/ep02.md" }).ws.item, { kind: "item", id: "episodes/ep02" });
  assert.equal(p.context().item, "episodes/ep02");
  assert.deepEqual(p.open().ws.item, { kind: "item", id: "episodes/ep02" }, "remembered");
  rmSync(join(p.root, "episodes", "ep02.md"));
  assert.equal(p.open().ws.item.kind, "inactive", "a remembered file that is gone is no work item");
});

test("lastFile is read as a project path: absolute or relative, either separator; under .geml, .git or node_modules it names nothing", () => {
  const p = project({ flow: FILE_UNIT("**/*.md"), tools: DEV_TOOLS, git: () => ({}) });
  mkdirSync(join(p.root, "episodes"));
  writeFileSync(join(p.root, "episodes", "ep02.md"), "# Ep 2\n");
  assert.deepEqual(p.open({ lastFile: join(p.root, "episodes", "ep02.md") }).ws.item, { kind: "item", id: "episodes/ep02" });
  assert.deepEqual(p.open({ lastFile: "episodes\\ep02.md" }).ws.item, { kind: "item", id: "episodes/ep02" });
  for (const ignored of [".geml/notes.md", "node_modules/x/README.md", join(p.root, ".git", "x.md"), "../elsewhere.md"]) {
    assert.deepEqual(p.open({ lastFile: ignored }).ws.item, { kind: "item", id: "episodes/ep02" }, `${ignored}: the remembered item stands`);
  }
});

test("a unit whose glob names .geml/ outright takes its files there as work items, and keeps their journals apart", () => {
  const p = project({ flow: FILE_UNIT(".geml/matters/*.geml"), tools: DEV_TOOLS, git: () => ({}) });
  mkdirSync(join(p.root, ".geml", "matters"), { recursive: true });
  writeFileSync(join(p.root, ".geml", "matters", "band-entry.geml"), "# Band entry\n");
  const o = p.open({ lastFile: join(p.root, ".geml", "matters", "band-entry.geml") });
  assert.deepEqual(o.ws.item, { kind: "item", id: ".geml/matters/band-entry" });
  assert.equal(o.ws.itemFileOf(".geml/matters/band-entry.geml"), ".geml/matters/band-entry.geml");
  assert.equal(o.ws.itemFileOf(".geml/journals/x.geml"), undefined);
});

test("a file unit without flow-state-key leaves its item files as the person wrote them", () => {
  const p = project({ flow: FILE_UNIT("episodes/*.md"), tools: DEV_TOOLS, git: () => ({}) });
  mkdirSync(join(p.root, "episodes"));
  const ep = join(p.root, "episodes", "ep01.md");
  writeFileSync(ep, "# Ep 1\n");
  const ws = p.open({ lastFile: ep }).ws;
  assert.deepEqual(ws.item, { kind: "item", id: "episodes/ep01" });
  ws.after({ tool: "Bash", callId: "t1", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.equal(ws.status().vars["tests-pass"], true, "the operation recorded its evidence");
  assert.equal(readFileSync(ep, "utf8"), "# Ep 1\n");
});

// --- nothing slow under a lock --------------------------------------------------

test("git, gh and the stage's prompt are read while no lock is held", () => {
  const locks = [];
  let p;
  const held = () => [".geml/journals/feat/x.geml.lock", ".geml/context.geml.lock"].filter((l) => existsSync(join(p.root, l)));
  p = project({
    getPrompt: (ref) => { locks.push(["prompt", held()]); return GUIDE(ref); },
    git: () => ({ branch: "feat/x", defaultBranch: "main", committed: true }),
  });
  const ws = p.open({ gh: () => { locks.push(["gh", held()]); return { available: true, prOpen: true, prMerged: false, ci: [] }; } }).ws;
  ws.after(NPM_TEST);
  ws.refresh();
  ws.status();
  ws.after({ tool: "Bash", callId: "c2", isError: false, input: { command: "git push" }, exitCode: 0 });
  assert.ok(locks.some(([what]) => what === "prompt") && locks.some(([what]) => what === "gh"));
  assert.deepEqual(locks.filter(([, l]) => l.length > 0), []);
});

test("gh is not asked off a branch: a detached HEAD, no repository", () => {
  const never = () => { throw new Error("gh asked"); };
  const detached = project({ git: () => ({ branch: "HEAD", defaultBranch: "main" }) }).open({ gh: never }).ws;
  const s = detached.status();
  assert.deepEqual(s.item, { kind: "inactive", reason: "detached HEAD · not tracked" });
  assert.deepEqual(s.gh, { available: false, reason: "detached HEAD" });
  assert.deepEqual(project({ git: () => ({}) }).open({ gh: never }).ws.status().gh, { available: false, reason: "not a git repository" });
});

test("a repository with no commits yet is told apart from no repository by the default git facts", () => {
  const root = mkdtempSync(join(tmpdir(), "gemflow-ws-git-"));
  made.push(root);
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(FIX, join(root, ".geml", "workflows", "dev"), { recursive: true });
  const open = () => openWorkspace({ root, tools: CLAUDE_CODE_TOOLS, gh: () => { throw new Error("gh asked"); }, getPrompt: GUIDE });
  assert.deepEqual(open().ws.item, { kind: "inactive", reason: "not a git repository" });
  assert.equal(spawnSync("git", ["init", "-q", "-b", "main", root], { encoding: "utf8" }).status, 0);
  assert.deepEqual(open().ws.item, { kind: "inactive", reason: "no commits yet" });
  assert.deepEqual(open().ws.status().gh, { available: false, reason: "no commits yet" });
});

const FILE_VAR_FLOW = flowDoc({
  initial: "cut", states: { cut: { description: "Cut." }, done: { description: "Done." } },
  vars: { rendered: { default: false, source: { file: "**/*.mp4" } } },
  transitions: [{ from: "cut", to: "done", guard: { properties: { rendered: { const: true } } }, note: "Rendered." }],
});

test("after: a write under .geml, .git or node_modules is no file variable's; a write elsewhere re-reads them", () => {
  const p = project({ flow: FILE_VAR_FLOW });
  const ws = p.open().ws;
  mkdirSync(join(p.root, "node_modules", "x"), { recursive: true });
  writeFileSync(join(p.root, "node_modules", "x", "a.mp4"), "");
  assert.deepEqual(ws.after({ tool: "Write", callId: "w1", isError: false, wrotePath: "node_modules/x/a.mp4" }).entered, []);
  mkdirSync(join(p.root, "out"));
  writeFileSync(join(p.root, "out", "ep01.mp4"), "");
  assert.deepEqual(ws.after({ tool: "Write", callId: "w2", isError: false, wrotePath: join(p.root, ".geml", "notes.geml") }).entered, [], "a write under .geml is not looked at");
  assert.deepEqual(p.read().snapshots.length, 1);
  assert.deepEqual(ws.after({ tool: "Write", callId: "w3", isError: false, wrotePath: join(p.root, "out", "ep01.mp4") }).entered, ["done"]);
});

// --- the context document ------------------------------------------------------

test("the context document is host-neutral: the uses and the tools bound to them are the dictionary's, whichever host wrote it", () => {
  const p = project();
  p.open();
  assert.match(p.context().text, /\nTools here:\n  edit: Edit\n/);
  const q = project({ hostTools: NO_TOOLS });
  q.open();
  assert.equal(q.context().text, p.context().text);
});

const THREE_STAGES = flowDoc({
  initial: "a",
  states: { a: { description: "A.", prompt: "./guide.geml#build" }, b: { description: "B.", prompt: "./guide.geml#build" }, c: { description: "C.", prompt: "./guide.geml#build" } },
  transitions: [{ from: "a", to: "b", note: "x" }, { from: "b", to: "c", note: "x" }],
});

test("the context document: an older stage never overwrites a later one, and the later one's text is what comes back", () => {
  let other;
  let reentered = false;
  const p = project({
    flow: THREE_STAGES,
    getPrompt: (ref) => {
      // While the first process reads its stage's prompt, a second one moves the workflow on.
      if (other && !reentered) { reentered = true; assert.deepEqual(other.advance("c").entered, ["c"]); }
      return GUIDE(ref);
    },
  });
  const ws = p.open().ws;
  other = p.open().ws;
  const r = ws.advance("b");
  assert.deepEqual(r.entered, ["b"]);
  assert.match(r.context, /^\[gemflow\] stage c · rev 2/);
  assert.deepEqual([p.context().state, p.context().rev], ["c", 2]);
  assert.equal(ws.context(), r.context);
});

test("the context document follows a journal started over, whatever revision it had reached", () => {
  const p = project({ pr: true });
  const ws = p.open().ws;
  ws.after(NPM_TEST);
  ws.refresh();
  assert.deepEqual([p.context().state, p.context().rev], ["review", 3]);
  rmSync(p.journal());
  p.open();
  assert.deepEqual([p.context().state, p.context().rev], ["build", 0]);
});

test("the context document is not rewritten when only its line ends differ", () => {
  const p = project();
  const path = join(p.root, ".geml", "context.geml");
  const fixed = { now: () => "2026-10-11T00:00:00Z" };
  p.open(fixed);
  const crlf = readFileSync(path, "utf8").replace(/\n/g, "\r\n");
  writeFileSync(path, crlf);
  rmSync(p.journal());
  p.open(fixed);
  assert.equal(readFileSync(path, "utf8"), crlf);
});

test("the context document follows the work item: an operation on another item rewrites it, and context() answers only for its own", () => {
  let branch = "feat/y";
  const p = project({ pr: true, git: () => ({ branch, defaultBranch: "main", committed: true }) });
  const y = p.open().ws;
  y.after(NPM_TEST);
  y.refresh();
  assert.deepEqual([p.context().item, p.context().state, p.context().rev], ["feat/y", "review", 3]);
  branch = "feat/x";
  p.open();
  assert.deepEqual([p.context().item, p.context().state], ["feat/x", "build"], "a new item's journal starts its document");
  branch = "feat/y";
  p.open();
  assert.deepEqual([p.context().item, p.context().state, p.context().rev], ["feat/y", "review", 3], "back on feat/y: its stage, not feat/x's");
  branch = "feat/x";
  p.open();
  assert.equal(p.context().item, "feat/x");
  y.before("Read", "c2", {});
  assert.deepEqual([p.context().item, p.context().state, p.context().rev], ["feat/y", "review", 3], "any operation brings the document back to its item");
  p.open();
  assert.equal(p.context().item, "feat/x");
  assert.match(y.context(), /^\[gemflow\] stage review · rev 3\n/, "context() never answers with another item's stage");
  assert.equal(p.context().item, "feat/y");
  branch = "main";
  assert.equal(p.open().ws.context(), undefined, "no work item, no stage");
});

test("file work items taking turns: the document speaks for the item operated on last, and that is the one remembered", () => {
  const p = project({ flow: FILE_UNIT("episodes/*.md"), tools: DEV_TOOLS, git: () => ({}) });
  mkdirSync(join(p.root, "episodes"));
  writeFileSync(join(p.root, "episodes", "ep01.md"), "# 1\n");
  writeFileSync(join(p.root, "episodes", "ep02.md"), "# 2\n");
  const a = p.open({ lastFile: "episodes/ep01.md" }).ws;
  p.open({ lastFile: "episodes/ep02.md" });
  assert.equal(p.context().item, "episodes/ep02");
  a.status();
  assert.equal(p.context().item, "episodes/ep01");
  assert.deepEqual(p.open().ws.item, { kind: "item", id: "episodes/ep01" });
});

test("a context document that cannot be written: the operation stands, its result carries no context, and the next operation writes it", () => {
  const p = project({ flow: APPROVAL_FLOW });
  const ws = p.open().ws;
  const doc = join(p.root, ".geml", "context.geml");
  rmSync(doc);
  mkdirSync(doc); // nothing can be read or written there
  const r = ws.advance("live");
  assert.deepEqual(r, { ok: true, entered: ["live"] });
  assert.deepEqual(ws.verb("move", { to: "done" }, "v1"), { ok: true, result: { from: "live", to: "done", state: "done", entered: [], rev: 2, hash: p.read().snapshots.at(-1).hash } });
  assert.deepEqual(p.read().snapshots.map((s) => s.state), ["draft", "live", "done"], "both are recorded");
  rmSync(doc, { recursive: true });
  ws.status();
  assert.deepEqual([p.context().state, p.context().rev], ["done", 2]);
});

// --- symbolic links ---------------------------------------------------------------

/** A directory link to `target`: a junction on Windows (no privilege needed), a symbolic link elsewhere. */
function link(target, path) {
  symlinkSync(target, path, "junction");
  made.push(path);
  return path;
}

test("symbolic links: a root reached through a link and a path reported through the real one name the same project file", () => {
  const p = project({ flow: FILE_VAR_FLOW });
  const via = link(p.root, join(tmpdir(), `gemflow-link-${basename(p.root)}`));
  const real = realpathSync.native(p.root);
  mkdirSync(join(p.root, "out"));
  writeFileSync(join(p.root, "out", "a.mp4"), "");
  const ws = p.open({ root: via }).ws;
  assert.deepEqual(ws.after({ tool: "Write", callId: "w1", isError: false, wrotePath: join(real, "out", "a.mp4") }).entered, ["done"]);
});

test("symbolic links: lastFile given through the real path names the work item when the root is a link, and the other way round", () => {
  const p = project({ flow: FILE_UNIT("episodes/*.md"), tools: DEV_TOOLS, git: () => ({}) });
  mkdirSync(join(p.root, "episodes"));
  writeFileSync(join(p.root, "episodes", "ep02.md"), "# Ep 2\n");
  const via = link(p.root, join(tmpdir(), `gemflow-link-${basename(p.root)}`));
  const real = realpathSync.native(p.root);
  assert.deepEqual(p.open({ root: via, lastFile: join(real, "episodes", "ep02.md") }).ws.item, { kind: "item", id: "episodes/ep02" });
  rmSync(join(p.root, ".geml", "context.geml")); // nothing remembered: the path alone names the item
  assert.deepEqual(p.open({ root: real, lastFile: join(via, "episodes", "ep02.md") }).ws.item, { kind: "item", id: "episodes/ep02" });
});

test("a prompt that a symbolic link carries outside the project is not read", () => {
  const p = project({ getPrompt: null, flow: PROMPT_FLOW("docs/secret.md#s") });
  const outside = mkdtempSync(join(tmpdir(), "gemflow-outside-"));
  made.push(outside);
  writeFileSync(join(outside, "secret.md"), "# S {#s}\n\nOUTSIDE THE PROJECT\n");
  link(outside, join(p.root, "docs"));
  assert.equal(p.open().ok, true);
  assert.match(p.context().text, /--- docs\/secret\.md#s ---\n\(not found\)/);
  assert.doesNotMatch(p.context().text, /OUTSIDE THE PROJECT/);
  const dir = p.dir;
  assert.deepEqual(resolvePromptRef("docs/secret.md#s", join(dir, "flow.geml"), p.root), { kind: "outside" });
  assert.equal(resolvePromptRef("./guide.geml#build", join(dir, "flow.geml"), p.root).kind, "found");
  assert.match(resolvePromptRef("./guide.geml#build", join(dir, "flow.geml"), p.root).text, /^# 构建 \{#build\}\n/);
  assert.match(resolvePromptRef("./guide.geml", join(dir, "flow.geml"), p.root).text, /^=== meta\n/, "a whole document");
  assert.deepEqual(resolvePromptRef("./guide.geml#nope", join(dir, "flow.geml"), p.root), { kind: "missing" });
  assert.deepEqual(resolvePromptRef("./missing.geml#x", join(dir, "flow.geml"), p.root), { kind: "missing" });
  assert.deepEqual(resolvePromptRef("../elsewhere.geml#x", join(dir, "flow.geml"), p.root), { kind: "outside" });
});

test("a workflow directory linked in from elsewhere still reads its own ./ references", () => {
  const p = project({ getPrompt: null });
  const shared = mkdtempSync(join(tmpdir(), "gemflow-shared-"));
  made.push(shared);
  cpSync(p.dir, shared, { recursive: true });
  rmSync(p.dir, { recursive: true });
  link(shared, p.dir);
  assert.equal(p.open().ok, true);
  assert.match(p.context().text, /--- \.\/guide\.geml#build ---\n# 构建 \{#build\}\n/);
});

// --- evidence after a run, git and gh ------------------------------------------------

test("after: a run tool re-reads the file variables too — a render made by a shell command writes them", () => {
  const p = project({ flow: FILE_VAR_FLOW });
  const ws = p.open().ws;
  mkdirSync(join(p.root, "out"));
  writeFileSync(join(p.root, "out", "ep.mp4"), "");
  assert.deepEqual(ws.after({ tool: "Bash", callId: "b1", isError: false, input: { command: "ffmpeg -i x out/ep.mp4" }, exitCode: 0 }).entered, ["done"]);
  assert.equal(ws.status().state.id, "done");
});

test("after: a command that runs git or gh anywhere in the line re-reads the git facts", () => {
  let asked = 0;
  const p = project();
  const ws = p.open({ gh: () => { asked++; return { available: true, prOpen: true, prMerged: false, ci: [] }; } }).ws;
  ws.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "echo git push" }, exitCode: 0 });
  assert.equal(asked, 0, "naming git is not running it");
  ws.after({ tool: "Bash", callId: "c2", isError: false, input: { command: "cd app && git push -u origin HEAD" }, exitCode: 0 });
  assert.equal(asked, 1);
  assert.equal(ws.status().vars["pr-open"], true);
});

const COMMITTED_FLOW = flowDoc({
  initial: "work", states: { work: { description: "Work." }, done: { description: "Done." } },
  vars: { c: { default: false, source: "committed" } },
  transitions: [{ from: "work", to: "done", note: "Finished." }],
});

test("refresh re-reads git's facts; once HEAD is on another branch they say nothing about this item", () => {
  let facts = { branch: "feat/x", defaultBranch: "main", committed: false };
  const never = () => { throw new Error("gh asked"); };
  const p = project({ flow: COMMITTED_FLOW, git: () => facts });
  const ws = p.open({ gh: never }).ws;
  ws.refresh();
  assert.equal(ws.status().vars.c, false);
  facts = { ...facts, committed: true };
  ws.refresh();
  assert.equal(ws.status().vars.c, true, "the commit made since the workspace opened is seen");
  facts = { branch: "feat/y", defaultBranch: "main", committed: false };
  ws.refresh();
  assert.equal(ws.status().vars.c, true, "feat/y's facts are not feat/x's");
});

test("gh is asked only when a variable reads it, status included; git only for a branch unit or a git variable", () => {
  const never = (what) => () => { throw new Error(`${what} asked`); };
  const committedOnly = project({ flow: COMMITTED_FLOW }).open({ gh: never("gh") }).ws;
  assert.equal(committedOnly.status().gh, undefined);
  committedOnly.refresh();
  committedOnly.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "git commit -m x" }, exitCode: 0 });
  const files = project({ flow: FILE_VAR_FLOW.replace('profile = "geml-statechart/v1"', 'profile = "geml-statechart/v1"\nflow-unit = "file:**/*.mp4"') });
  mkdirSync(join(files.root, "out"));
  writeFileSync(join(files.root, "out", "a.mp4"), "");
  const o = files.open({ git: never("git"), gh: never("gh"), lastFile: "out/a.mp4" });
  assert.equal(o.ok, true);
  const s = o.ws.status();
  assert.deepEqual(s.item, { kind: "item", id: "out/a" });
  assert.equal(s.gh, undefined);
  o.ws.refresh();
  o.ws.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "git push" }, exitCode: 0 });
});

// --- refusals and reused call ids --------------------------------------------------

const REENTER_FLOW = flowDoc({
  initial: "work", states: { work: { description: "Work.", tools: ["test"] }, rest: { description: "Rest." } },
  vars: { n: { default: 0 }, t: { default: false, source: { tool: "test" } } },
  transitions: [{ from: "work", to: "rest", note: "x" }, { from: "rest", to: "work", note: "x" }],
});

test("after: a refusal from an earlier entry of the stage does not excuse a call now, though its call id came round again", () => {
  const p = project({ flow: REENTER_FLOW });
  const ws = p.open().ws;
  assert.match(ws.before("Bash", "call_1", { command: "gemflow mark x && npm test" }), /is for a person/);
  ws.advance("rest");
  ws.advance("work");
  assert.equal(ws.verb("set", { n: 5 }, "v1").ok, true);
  ws.after({ tool: "Bash", callId: "call_1", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.deepEqual(p.read().snapshots.map((s) => [s.cause, s.vars.n, s.vars.t]), [["enter", 0, false], ["transition", 0, false], ["transition", 0, false], ["patch", 5, false], ["patch", 5, true]]);
});

test("the context document is written once per stage entry: work inside the stage leaves the stage block alone; a document from an earlier entry is rewritten", () => {
  const p = project({ flow: REENTER_FLOW });
  const ws = p.open().ws;
  const doc = join(p.root, ".geml", "context.geml");
  const first = readFileSync(doc, "utf8");
  ws.before("Read", "c1", {});
  assert.equal(ws.verb("set", { n: 1 }, "v1").ok, true);
  ws.status();
  const was = readContextDoc(first), now = p.context();
  assert.deepEqual([now.state, now.rev, now.at, now.text], [was.state, was.rev, was.at, was.text], "a patch inside the stage leaves the stage block as it was");
  assert.deepEqual([was.vars.n, now.vars.n], [0, 1], "and the #vars view beside it follows the patch");
  rmSync(doc);
  mkdirSync(doc); // the next two stage changes cannot be written
  ws.advance("rest");
  ws.advance("work");
  rmSync(doc, { recursive: true });
  writeFileSync(doc, first); // #work as it was at rev 0: the right state, an earlier entry
  ws.before("Read", "c2", {});
  assert.deepEqual([p.context().state, p.context().rev], ["work", 3]);
});

// --- a journal that cannot be resumed ----------------------------------------------

test("a journal that cannot be resumed does not open: the reason names the journal and the way out", () => {
  const p = project({ pr: true });
  p.open().ws.after(NPM_TEST);
  const text = readFileSync(p.journal(), "utf8");
  writeFileSync(p.journal(), text.slice(0, text.length - 40));
  const truncated = p.open();
  assert.equal(truncated.ok, false);
  assert.equal(truncated.kind, "journal");
  assert.match(truncated.reason, /^\.geml\/journals\/feat\/x\.geml cannot be resumed: /);
  assert.match(truncated.reason, /Move it aside \(rename or delete it\) to start feat\/x over\.$/);

  const q = project();
  q.open();
  const flow = join(q.dir, "flow.geml");
  writeFileSync(flow, readFileSync(flow, "utf8").replaceAll('"build"', '"make"'));
  const renamed = q.open();
  assert.equal(renamed.ok, false);
  assert.match(renamed.reason, /^\.geml\/journals\/feat\/x\.geml cannot be resumed: the statechart no longer has state build\. Move it aside/);
  rmSync(q.journal());
  assert.equal(q.open().ok, true, "moved aside, the item starts over");
});

test("loadWorkspace starts nothing: no journal, no context document; a lazy workspace starts the journal only when something is recorded", () => {
  const p = project();
  const o = loadWorkspace({ root: p.root, tools: NO_TOOLS, git: () => ({ branch: "feat/x", defaultBranch: "main" }) });
  assert.equal(o.ok, true);
  assert.equal(o.ws.journalWorkflow(), undefined);
  assert.equal(existsSync(p.journal()), false);
  assert.equal(existsSync(join(p.root, ".geml", "context.geml")), false);
  const lazy = loadWorkspace({ root: p.root, tools: CLAUDE_CODE_TOOLS, lazy: true, git: () => ({ branch: "feat/x", defaultBranch: "main" }), getPrompt: GUIDE }).ws;
  assert.equal(lazy.before("Read", "c1", {}), undefined);
  assert.deepEqual(lazy.after({ tool: "Bash", callId: "c2", isError: true, input: { command: "npm test" }, exitCode: 1 }).entered, []);
  assert.equal(existsSync(p.journal()), false, "nothing recorded: no journal");
  lazy.after(NPM_TEST);
  assert.ok(existsSync(p.journal()), "evidence recorded: the journal starts");
  assert.equal(lazy.startedJournal, true);
});

test("a work item keeps the workflow its journal was started under, a new one starts under the default, and a workflow file that is gone names the way out", () => {
  const p = project();
  p.open();
  cpSync(p.dir, join(p.root, ".geml", "workflows", "other"), { recursive: true });
  writeFileSync(join(p.root, ".geml", "gemflow.geml"), '=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "other"\n===\n');
  assert.deepEqual(p.open().ws.status().workflow, { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程", default: "other" });
  const y = p.open({ git: () => ({ branch: "feat/y", defaultBranch: "main", committed: true }) }).ws;
  assert.deepEqual(y.status().workflow, { name: "other", path: ".geml/workflows/other/flow.geml", title: "开发流程" });
  rmSync(p.dir, { recursive: true });
  const gone = p.open();
  assert.deepEqual([gone.ok, gone.kind], [false, "journal"]);
  assert.equal(gone.reason, ".geml/journals/feat/x.geml was started under .geml/workflows/dev/flow.geml, which is not there: restore that file, or move the journal aside (rename or delete it) to start feat/x over under other.");
});

// --- the dictionary ------------------------------------------------------------

test("the dictionary is read afresh for every operation, and a person's word is written into it under its lock", () => {
  const p = project();
  const ws = p.open().ws;
  assert.equal(ws.dictionary().rows.length, 24);
  assert.equal(ws.before("WebFetch", "c1", {}), undefined, "a tool no row takes goes through, unasked");
  ws.learn([{ kind: "deny", key: "WebFetch", where: "build" }, { kind: "use", key: "mcp__img__*", use: "edit" }]);
  const dict = readDictionary(readFileSync(join(p.dir, "tools.geml"), "utf8"), ws.sc);
  assert.deepEqual(dict.rows.slice(-2).map((r) => [r.tool, r.for, r.deny, r.default]), [["WebFetch", undefined, ["build"], false], ["mcp__img__*", "edit", [], false]]);
  assert.match(ws.before("WebFetch", "c2", {}), /you denied WebFetch in #build/, "the same workspace reads the lesson");
  assert.equal(p.open().ws.before("mcp__img__generate", "c3", { prompt: "x" }), undefined, "and so does a new one: image is edit, which #build declares");
  assert.match(readFileSync(join(p.dir, "tools.geml"), "utf8"), /^%% 开发流程的起步词典/m, "what the person wrote around the table stays");
});

// --- which workflow ----------------------------------------------------------

function bare() {
  const root = mkdtempSync(join(tmpdir(), "gemflow-wf-"));
  made.push(root);
  const add = (name) => { mkdirSync(join(root, ".geml", "workflows", name), { recursive: true }); cpSync(FIX, join(root, ".geml", "workflows", name), { recursive: true }); };
  const config = (text) => writeFileSync(join(root, ".geml", "gemflow.geml"), text);
  return { root, add, config };
}

test("resolveWorkflow: the environment, then the config document, then the only workflow; a failure says which kind it is", () => {
  const w = bare();
  assert.deepEqual(resolveWorkflow(w.root, {}), { error: "no workflow here: run `gemflow init`", kind: "none" });
  w.add("dev");
  assert.deepEqual(resolveWorkflow(w.root, {}), { name: "dev", path: join(w.root, ".geml", "workflows", "dev", "flow.geml") });
  w.add("film");
  assert.deepEqual(resolveWorkflow(w.root, {}), { error: "several workflows (dev, film): choose one with `gemflow use <name>`", kind: "ambiguous" });
  w.config('=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "film"\n===\n');
  assert.deepEqual(resolveWorkflow(w.root, {}), { name: "film", path: join(w.root, ".geml", "workflows", "film", "flow.geml") });
  w.config('=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "gone"\n===\n');
  assert.deepEqual(resolveWorkflow(w.root, {}), { error: ".geml/gemflow.geml names workflow \"gone\", but .geml/workflows has no gone.geml", kind: "invalid" });
  w.config('=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "../dev"\n===\n');
  assert.deepEqual(resolveWorkflow(w.root, {}), { error: ".geml/gemflow.geml names workflow \"../dev\", which is not the name of a workflow in .geml/workflows", kind: "invalid" });
  const env = { GEMFLOW_STATECHART: ".geml/workflows/dev/flow.geml" };
  assert.deepEqual(resolveWorkflow(w.root, env), { name: ".geml/workflows/dev", path: join(w.root, ".geml", "workflows", "dev", "flow.geml") });
  assert.deepEqual(resolveWorkflow(w.root, { GEMFLOW_STATECHART: "nope.geml" }), { error: "GEMFLOW_STATECHART names nope.geml, which does not exist", kind: "invalid" });
});

test("openWorkspace passes the kind of a failure on: none, ambiguous, invalid", () => {
  const w = bare();
  const open = () => openWorkspace({ root: w.root, tools: CLAUDE_CODE_TOOLS, git: () => ({}), gh: () => ({ available: false, reason: "x" }) });
  assert.deepEqual(open(), { ok: false, reason: "no workflow here: run `gemflow init`", kind: "none" });
  w.add("dev"); w.add("film");
  assert.equal(open().kind, "ambiguous");
  w.config('=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "gone"\n===\n');
  assert.equal(open().kind, "invalid");
});

test("openWorkspace: a workflow with errors does not open, and says where", () => {
  const p = project({ flow: '=== meta\nprofile = "geml-statechart/v1"\n===\n' });
  const o = p.open();
  assert.equal(o.ok, false);
  assert.equal(o.kind, "invalid");
  assert.match(o.reason, /^\.geml\/workflows\/dev\/flow\.geml: flow-statechart: /);
});

test("NO_TOOLS: the CLI sees no tool calls, so a command is keyed by its tool name alone", () => {
  assert.deepEqual(NO_TOOLS, { run: [], write: [] });
  assert.ok(Object.isFrozen(NO_TOOLS));
  const p = project({ hostTools: NO_TOOLS, pr: true });
  const ws = p.open().ws;
  assert.deepEqual(ws.mark("review-ready", true).ok, true);
  assert.equal(ws.status().vars["review-ready"], true);
  ws.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.equal(ws.status().vars["tests-pass"], false, "Bash is not a run tool here: its exit status is no evidence");
});

test("elapsed evidence: the clock is read whenever the work item is opened or a writing operation begins; the machine moves on; entering a state starts the count again", () => {
  const flow = flowDoc({
    initial: "a",
    states: { a: {}, b: {}, c: { final: true } },
    vars: { waited: { default: false, source: { elapsed: "PT1H" } } },
    transitions: [
      { from: "a", to: "b", guard: { properties: { waited: { const: true } } } },
      { from: "b", to: "a", guard: "do it again" },
      { from: "b", to: "c", approval: true },
    ],
  });
  const p = project({ flow });
  let clock = Date.parse("2026-10-11T00:00:00Z");
  const open = () => p.open({ now: () => new Date(clock).toISOString() }).ws;
  const at = () => { const s = open().status(); return [s.state.id, s.vars.waited]; };
  assert.deepEqual(at(), ["a", false], "entered #a at 00:00");
  clock += 30 * 60_000;
  assert.deepEqual(at(), ["a", false], "half an hour is not an hour");
  clock += 31 * 60_000;
  assert.deepEqual(at(), ["b", false], "an hour in: opening the work item reads the clock, waited is written, a→b is taken on its own, and entering #b starts the count again");
  const written = p.read().snapshots.find((s) => s.signal === "waited" && s.cause === "patch");
  assert.deepEqual([written.by, written.vars.waited, written.at, written.state], ["signal", true, "2026-10-11T01:01:00.000Z", "a"]);
  assert.deepEqual(p.read().snapshots.find((s) => s.cause === "transition").vars, { waited: false }, "the transition's own revision returns it to false");
  clock += 59 * 60_000;
  assert.deepEqual(at(), ["b", false], "59 minutes in #b");
  clock += 2 * 60_000;
  assert.deepEqual(at(), ["b", true], "an hour in #b: written; no machine-judged edge reads it here, so the stage stays");
  // the model goes back to #a: the transition returns waited to false; an hour later it moves on again
  assert.equal(open().verb("move", { to: "a" }, "v1").ok, true);
  assert.deepEqual(at(), ["a", false]);
  clock += 61 * 60_000;
  assert.deepEqual(at(), ["b", false]);
  // a person approves #c, which is final: nothing is evaluated there
  assert.equal(open().advance("c").ok, true);
  clock += 5 * 60 * 60_000;
  assert.deepEqual(at(), ["c", false], "closed: the clock is not read in a final state");
});
