import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readContextDoc } from "../dist/core/stagehand.js";
import { fakeGh, gitRepo, hook, hookProcess, withWorkflow } from "./helpers/repo.mjs";

const WS_DEV = fileURLToPath(new URL("./fixtures/ws-dev/", import.meta.url));
const NO_GH = { GEMFLOW_GH: "gh-definitely-not-installed" };
const project = () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  return root;
};
const BUILD_READS = ["pr-merged", "pr-open", "review-ready", "tests-pass"];

test("status: the shell a hooks module starts from", () => {
  const r = hook(project(), { op: "status" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.shell.status.item, { kind: "item", id: "feat/x" });
  assert.deepEqual(r.shell.status.state, { id: "build", title: "构建", rev: 0, uses: ["edit", "test", "pr"], final: false, since: r.shell.status.state.since });
  assert.match(r.shell.status.state.since, /^\d{4}-\d{2}-\d{2}T/, "when the state was entered");
  assert.equal(r.shell.status.paused, false);
  assert.deepEqual(Object.keys(r.shell.versions), ["gemflow", "parser"]);
  assert.match(r.shell.versions.gemflow, /^\d+\.\d+\.\d+/);
  assert.deepEqual(r.shell.policy.uses, ["edit", "test", "pr"]);
  assert.deepEqual(r.shell.policy.fences, { edit: ["build", "review"], test: ["build", "review"], pr: ["build"], "deploy-staging": ["deploy"], "deploy-prod": ["release"] });
  assert.equal(r.shell.policy.rows.length, 24, "the dictionary's rows travel with the policy");
  assert.deepEqual(r.shell.policy.relevant, BUILD_READS);
  assert.deepEqual(r.shell.policy.evidence, ["test", "deploy-staging", "deploy-prod"]);
  assert.equal(r.shell.contextKey, "feat/x@0");
  assert.deepEqual(r.shell.status.gh, { available: true }, "a cheap op does not ask gh");
});

test("before: a key no row takes goes through, unasked; a person's word is learned and judged from then on; a person's command is refused", () => {
  const root = project();
  const first = hook(root, { op: "before", tool: "WebFetch", callId: "c1", input: {} });
  assert.deepEqual([first.refusal, first.recorded, "ask" in first], [undefined, false, false]);
  const learned = hook(root, { op: "learn", lessons: [{ kind: "deny", key: "WebFetch", where: "build" }], tool: "WebFetch", input: {} });
  assert.equal(learned.ok, true);
  assert.ok(learned.shell.policy.rows.some((r) => r.tool === "WebFetch" && r.deny.includes("build")), "the policy carries the new row");
  const again = hook(root, { op: "before", tool: "WebFetch", callId: "c2", input: {} });
  assert.match(again.refusal, /you denied WebFetch in #build/);
  assert.match(readFileSync(join(root, ".geml", "workflows", "dev", "tools.geml"), "utf8"), /\| WebFetch\s+\|\s+\|\s+\| build\s+\|/);
  const person = hook(root, { op: "before", tool: "Bash", callId: "c3", input: { command: "gemflow mark reviewed" } });
  assert.match(person.refusal, /for a person/);
  assert.equal(person.recorded, true);
  const fenced = hook(root, { op: "before", tool: "Bash", callId: "c4", input: { command: "npx wrangler deploy --env production" } });
  assert.match(fenced.refusal, /is deploy-prod, which is used only in #release; the workflow is in #build/);
  assert.equal(hook(root, { op: "status" }).shell.status.refusals, 3, "the deny, the person's command and the fence");
});

test("through the bundled CLI, as the hooks module runs it: one request in, the same answer out as in process", () => {
  const root = project();
  const spawned = hookProcess(root, { op: "status" });
  assert.deepEqual([spawned.ok, spawned.shell.status.item, spawned.shell.status.state.id], [true, { kind: "item", id: "feat/x" }, "build"]);
  assert.deepEqual(hook(root, { op: "status" }).shell.status, spawned.shell.status);
});

test("after, refresh, advance: a test run and an open PR move the workflow; the new stage text comes back", () => {
  const root = project();
  const gh = fakeGh();
  hook(root, { op: "status" });
  const ran = hook(root, { op: "after", tool: "Bash", callId: "c1", input: { command: "npm test" }, isError: false, exitCode: 0, gitOperation: false });
  assert.deepEqual(ran.entered, []);
  assert.equal(ran.shell.status.vars["tests-pass"], true);
  assert.equal(ran.context, undefined);
  gh.set({ pr: "OPEN" });
  const review = hook(root, { op: "refresh" }, gh.env);
  assert.deepEqual(review.entered, ["review"]);
  assert.match(review.context, /^\[gemflow\] stage review/);
  assert.equal(review.shell.contextKey, "feat/x@3");
  assert.equal(hook(root, { op: "status" }).context, undefined, "an unchanged stage sends no text");
  const back = hook(root, { op: "advance", to: "build" });
  assert.deepEqual(back.entered, ["build"]);
  assert.match(back.context, /^\[gemflow\] stage build/);
  assert.equal(back.shell.status.vars["tests-pass"], false, "the way back reset the evidence");
});

test("handoff: an answer on another work item than the one the main loop last read hands it over, new or returned to", () => {
  const root = project();
  const read = hook(root, { op: "status" }).shell.contextKey;
  assert.equal(read, "feat/x@0");
  const after = (command, delivered) => hook(root, { op: "after", tool: "Bash", callId: "c1", input: { command }, isError: false, exitCode: 0, gitOperation: false, ...(delivered !== undefined ? { delivered } : {}) });
  spawnSync("git", ["-C", root, "switch", "-qc", "feat/y"]);
  const there = after("git switch -c feat/y", read);
  assert.equal(there.handoff, "[gemflow] now on feat/y · #build (new work item)");
  assert.match(there.context, /^\[gemflow\] stage build · rev 0/);
  assert.equal(there.shell.contextKey, "feat/y@0", "the document now speaks for the new item");
  assert.equal(after("ls", there.shell.contextKey).handoff, undefined, "the same item: nothing to hand over");
  spawnSync("git", ["-C", root, "switch", "-q", "feat/x"]);
  const back = after("git switch feat/x", there.shell.contextKey);
  assert.equal(back.handoff, `[gemflow] back on feat/x · #build · rev 0${BUILD_READS.map((v) => ` · ${v} ✗`).join("")}`);
  assert.match(back.context, /^\[gemflow\] stage build/);
  assert.equal(after("ls").handoff, undefined, "a subagent's call names nothing delivered: no handoff");
});

test("refresh without gh says why the git evidence is unavailable", () => {
  const r = hook(project(), { op: "refresh" }, NO_GH);
  assert.deepEqual(r.shell.status.gh, { available: false, reason: "gh is not installed" });
});

test("a context document another work item left is put right by the next request, which sends no stage text", () => {
  const root = project();
  hook(root, { op: "status" });
  const path = join(root, ".geml", "context.geml");
  writeFileSync(path, readFileSync(path, "utf8").replace('"item":"feat/x"', '"item":"feat/other"'));
  const r = hook(root, { op: "status" });
  assert.equal(readContextDoc(readFileSync(path, "utf8")).item, "feat/x");
  assert.deepEqual([r.shell.contextKey, r.context], ["feat/x@0", undefined], "the next prompt delivers it: its key differs from the one delivered");
});

test("verb: the model's tools answer in text", () => {
  const root = project();
  const status = hook(root, { op: "verb", name: "status", args: {} }).text;
  assert.match(status, /work item feat\/x · state build/);
  assert.match(status, /\n\n\[gemflow\] stage build/);
  assert.match(hook(root, { op: "verb", name: "set", args: { "tests-pass": true }, callId: "v1" }).text, /^refused: "tests-pass" is evidence/);
  assert.equal(hook(root, { op: "verb", name: "move", args: { to: "done" }, callId: "v2" }).text, "refused: no transition build→done");
  assert.match(hook(root, { op: "verb", name: "move", args: { to: "review" }, callId: "v3" }).text, /^refused: build→review is taken on its own/);
});

test("mark and advance are a person's; a missing transition is an error answer", () => {
  const root = project();
  const marked = hook(root, { op: "mark", variable: "review-ready", checked: true });
  assert.equal(marked.shell.status.vars["review-ready"], true);
  assert.deepEqual(marked.entered, ["review"], "the person's tick opened the guard");
  assert.match(marked.context, /^\[gemflow\] stage review/);
  const evidence = hook(root, { op: "mark", variable: "tests-pass", checked: true });
  assert.deepEqual([evidence.ok, evidence.error], [false, "tests-pass reads its value from the use test; only a variable whose source is \"human\" is ticked"]);
  const bad = hook(root, { op: "advance", to: "nowhere" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no transition review→nowhere/);
  const back = hook(root, { op: "rollback", rev: 0 });
  assert.deepEqual([back.ok, back.shell.status.state.id, back.shell.status.vars["review-ready"]], [true, "build", false], "a person goes back to before the tick: the recorded state and variables of revision 0");
  assert.equal(hook(root, { op: "board" }).board.timeline.at(-1).cause, "rollback");
  assert.equal(hook(root, { op: "rollback", rev: 99 }).ok, false);
});

test("board: the graph with its judges, the uses and their states, the dictionary, the work items and the journal timeline", () => {
  const root = project();
  hook(root, { op: "status" });
  const r = hook(root, { op: "board" }, NO_GH);
  assert.deepEqual(r.board.states.map((s) => [s.id, s.uses]), [["build", ["edit", "test", "pr"]], ["review", ["edit", "test"]], ["deploy", ["deploy-staging"]], ["release", ["deploy-prod"]], ["done", []]]);
  assert.deepEqual(r.board.transitions.map((t) => [t.from, t.to, t.judge, t.approval]), [["build", "review", "machine", false], ["review", "build", "model", false], ["review", "deploy", "machine", false], ["deploy", "release", "machine", true], ["release", "done", "machine", false]]);
  assert.equal(r.board.transitions[0].guard, "(tests-pass = true and pr-open = true or pr-merged = true or review-ready = true)");
  assert.deepEqual(r.board.fences.map((f) => f.use), ["edit", "test", "pr", "deploy-staging", "deploy-prod"]);
  assert.equal(r.board.tools.length, 24);
  assert.equal(r.board.backlog, null);
  assert.deepEqual(r.board.items, [{ id: "feat/x", state: "build", rev: 0, at: r.board.items[0].at, paused: false, flow: "开发流程", stateTitle: "构建", since: r.board.items[0].since, wrote: [], end: "doing", commits: 0 }], "where it ended up, by git: being worked on, no commit of its own yet, checked out in the main tree");
  const first = r.board.timeline[0];
  assert.deepEqual(first, { kind: "snapshot", rev: 0, at: first.at, state: "build", cause: "enter", changed: first.changed });
  assert.equal(first.changed["tests-pass"], false, "revision 0 sets every variable to its default");
  assert.deepEqual(r.board.clocks, []);
  assert.equal(typeof r.board.tree, "string", "the content fingerprint, for the evidence that expires");
  assert.deepEqual(r.board.artifacts, { item: "feat/x", written: [], commits: [] }, "the branch's own commits: none yet");
  assert.equal(r.board.unit, "branch");
});

test("bind: a to-do joins the current work item, one cell rewritten under the backlog's lock", () => {
  const root = project();
  const backlog = join(root, ".geml", "backlog.geml");
  writeFileSync(backlog, '=== meta\ntitle = "Backlog"\nprofile = "geml-statechart/v1"\n===\n\n=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| dark-mode | 设置页支持深色模式 | |\n===\n');
  assert.equal(hook(root, { op: "bind", id: "dark-mode" }).ok, true);
  assert.equal(readFileSync(backlog, "utf8"), '=== meta\ntitle = "Backlog"\nprofile = "geml-statechart/v1"\n===\n\n=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| dark-mode | 设置页支持深色模式 | feat/x |\n===\n');
  const again = hook(root, { op: "bind", id: "nope" });
  assert.deepEqual([again.ok, again.error], [false, "no backlog item nope"]);
});

test("add lists the bundled workflows and copies one; use switches", () => {
  const root = gitRepo("main");
  const list = hook(root, { op: "add" });
  assert.ok(list.workflows.includes("coding") && list.workflows.includes("dev"));
  assert.deepEqual(list.installed, []);
  assert.equal(list.shell.problem.quiet, true);
  const added = hook(root, { op: "add", workflow: "coding" });
  assert.deepEqual(added.added, { name: "coding", activated: true });
  assert.deepEqual(added.shell.status.item, { kind: "inactive", reason: "main · not tracked (work items are branches)" });
  assert.deepEqual(hook(root, { op: "add", workflow: "dev" }).added, { name: "dev", activated: false });
  assert.equal(hook(root, { op: "use", workflow: "dev" }).ok, true);
  assert.match(readFileSync(join(root, ".geml", "project.geml"), "utf8"), /flow-workflow = "dev"/);
  const nope = hook(root, { op: "use", workflow: "nope" });
  assert.equal(nope.ok, false);
  assert.match(nope.shell.status.workflow.name, /^dev$/, "a refused use answers with the shell as it stands");
  const twice = hook(root, { op: "add", workflow: "nope" });
  assert.deepEqual([twice.ok, twice.shell.status.workflow.name], [false, "dev"]);
});

test("use changes only the default: the current work item keeps the workflow its journal names, and the shell and the board say which is the default", () => {
  const root = project();
  hook(root, { op: "status" });
  cpSync(join(root, ".geml", "workflows", "dev"), join(root, ".geml", "workflows", "other"), { recursive: true });
  const used = hook(root, { op: "use", workflow: "other" });
  assert.equal(used.ok, true);
  assert.deepEqual([used.shell.status.workflow.name, used.shell.status.workflow.default], ["dev", "other"]);
  assert.deepEqual(hook(root, { op: "board" }).board.items.map((i) => [i.id, i.workflow]), [["feat/x", "dev"]]);
  const back = hook(root, { op: "use", workflow: "dev" });
  assert.deepEqual([back.shell.status.workflow.name, back.shell.status.workflow.default], ["dev", undefined]);
});

test("no workflow is a quiet problem; a journal that will not resume, a throw and a bad request are answers, not crashes", () => {
  const empty = gitRepo();
  const r = hook(empty, { op: "status" });
  assert.deepEqual([r.ok, r.shell.status, r.shell.problem.quiet], [true, null, true]);
  assert.deepEqual(r.shell.suggest, { workflow: "dev", by: "default" }, "no workflow: the shell names the bundled one that fits the project");
  assert.equal(hook(empty, { op: "verb", name: "status", args: {} }).ok, false);
  const root = project();
  hook(root, { op: "status" });
  writeFileSync(join(root, ".geml", "journals", "feat", "x.geml"), '=== meta\ntitle = "broken"\n===\n');
  const broken = hook(root, { op: "status" });
  assert.deepEqual([broken.ok, broken.shell.status, broken.shell.problem.quiet], [true, null, false]);
  assert.match(broken.shell.problem.text, /cannot be resumed/);
  const odd = project();
  mkdirSync(join(odd, ".geml", "journals", "feat", "x.geml"), { recursive: true });
  const thrown = hook(odd, { op: "status" });
  assert.deepEqual([thrown.ok, thrown.shell], [false, undefined], "a throw says nothing about the workflow: the hooks module keeps the policy it has");
  assert.match(thrown.error, /^gemflow: EISDIR/);
  assert.deepEqual(hook(root, { op: "nope" }), { v: 1, ok: false, error: "unknown op nope" });
  assert.deepEqual(hook(root, { op: "learn", lessons: [{ kind: "allow", key: "" }], tool: "X", input: {} }), { v: 1, ok: false, error: "op learn: missing or mistyped fields" });
});

test("pause and resume are a person's (spec §5.5): the status says so, the model's move is refused, evidence still lands, and resume takes the edge", () => {
  const root = project();
  const held = hook(root, { op: "pause" });
  assert.equal(held.ok, true);
  assert.equal(held.shell.status.paused, true);
  assert.equal(hook(root, { op: "pause" }).ok, false, "already paused");
  const move = hook(root, { op: "verb", name: "move", args: { to: "review" } });
  assert.match(move.text, /refused: build→review: the work item is paused/);
  const marked = hook(root, { op: "mark", variable: "review-ready", checked: true });
  assert.deepEqual([marked.shell.status.vars["review-ready"], marked.entered, marked.shell.status.state.id], [true, [], "build"], "evidence lands, the edge waits");
  const resumed = hook(root, { op: "resume" });
  assert.deepEqual([resumed.ok, resumed.entered, resumed.shell.status.paused, resumed.shell.status.state.id], [true, ["review"], false, "review"]);
  assert.match(resumed.context, /^\[gemflow\] stage review/);
  assert.equal(hook(root, { op: "resume" }).ok, false, "not paused");
});

test("export: the journal as GEML, Markdown or JSON, the workflow directory copied, or a text the shell built, under .geml/exports/", () => {
  const root = project();
  hook(root, { op: "status" });
  const geml = hook(root, { op: "export", kind: "journal", format: "geml" });
  assert.equal(geml.ok, true);
  assert.match(geml.exported.path, /^\.geml\/exports\/journal-feat-x-\d{8}T\d{6}Z\.geml$/);
  assert.equal(readFileSync(join(root, geml.exported.path), "utf8"), geml.exported.text);
  assert.match(geml.exported.text, /#journal format=json/);
  const md = hook(root, { op: "export", kind: "journal", format: "md", name: "mine" });
  assert.equal(md.exported.path, ".geml/exports/mine.md");
  assert.match(md.exported.text, /^# gemflow journal — feat\/x/);
  const json = hook(root, { op: "export", kind: "journal", format: "json", name: "../escape.json" });
  assert.equal(json.exported.path, ".geml/exports/escape.json", "a name is a file name, never a path");
  assert.equal(JSON.parse(json.exported.text).meta.item, "feat/x");
  const text = hook(root, { op: "export", kind: "text", format: "md", name: "share", text: `at ${root}/src/a.ts and ${root.split("/").join("\\")}\\b.ts`, strip: true });
  assert.equal(text.exported.text, "at ./src/a.ts and .\\b.ts", "strip takes the project's absolute path out, either separator");
  const wf = hook(root, { op: "export", kind: "workflow", format: "geml", name: "dev-copy" });
  assert.equal(wf.exported.path, ".geml/exports/dev-copy");
  assert.match(readFileSync(join(root, wf.exported.path, "flow.geml"), "utf8"), /geml-statechart/);
  assert.equal(wf.exported.text, readFileSync(join(root, ".geml", "workflows", "dev", "flow.geml"), "utf8"));
  assert.deepEqual(hook(root, { op: "export", kind: "text", format: "md" }), { v: 1, ok: false, error: "op export: missing or mistyped fields" }, "a text export needs its text");
});

test("export where the person said: into a folder, made when missing, or as a file ending in the format's extension; ~ is the home, a relative path the project's; outside the project the path is absolute", () => {
  const root = project();
  hook(root, { op: "status" });
  const away = mkdtempSync(join(tmpdir(), "gemflow-out-"));
  const slashed = (p) => p.split("\\").join("/");
  const folder = hook(root, { op: "export", kind: "text", format: "geml", name: "session-abc", text: "x", to: join(away, "new", "dir") });
  assert.equal(folder.exported.path, slashed(join(away, "new", "dir", "session-abc.geml")));
  assert.equal(readFileSync(join(away, "new", "dir", "session-abc.geml"), "utf8"), "x");
  hook(root, { op: "export", kind: "text", format: "geml", name: "session-abc", text: "y", to: join(away, "mine.geml") });
  assert.equal(readFileSync(join(away, "mine.geml"), "utf8"), "y", "a file path is the file");
  const home = hook(root, { op: "export", kind: "text", format: "geml", name: "session-abc", text: "z", to: "~/Downloads" }, { HOME: away, USERPROFILE: away });
  assert.equal(home.exported.path, slashed(join(away, "Downloads", "session-abc.geml")));
  assert.equal(hook(root, { op: "export", kind: "text", format: "geml", name: "s", text: "w", to: "notes" }).exported.path, "notes/s.geml", "inside the project: by its project path");
  assert.equal(hook(root, { op: "export", kind: "text", format: "geml", name: "s", text: "u", to: "notes" }).exported.path, "notes/s-2.geml", "a file there already stays: the new one is numbered, as a download is");
  assert.equal(hook(root, { op: "export", kind: "text", format: "geml", name: "s", text: "t", to: "notes/s.geml" }).exported.path, "notes/s-3.geml");
  assert.equal(hook(root, { op: "export", kind: "text", format: "geml", name: "s", text: "r", to: join(away, "x.md") }).exported.path, slashed(join(away, "x.geml")), "another extension becomes the format's");
  mkdirSync(join(away, "v1.2"));
  assert.equal(hook(root, { op: "export", kind: "text", format: "geml", name: "s", text: "q", to: join(away, "v1.2") }).exported.path, slashed(join(away, "v1.2", "s.geml")), "a folder there is a folder, whatever its name");
  assert.equal(hook(root, { op: "export", kind: "text", format: "geml", text: "v", to: 3 }).ok, false, "a place is a path");
});

test("attention: the real bridge answers the repository's facts and the machine the session runs on", () => {
  const root = project();
  const r = hook(root, { op: "attention" }, NO_GH);
  assert.equal(r.ok, true, r.error);
  assert.ok(Array.isArray(r.attention.ahead) && Array.isArray(r.attention.prs));
  assert.deepEqual(r.attention.unread, ["prs"], "gh could not be asked: its list is named, so no hold on a pull request is let go for it");
  assert.equal(r.host.name, hostname());
  assert.equal(r.host.platform, process.platform);
  assert.equal(typeof r.host.branch, "string");
});
