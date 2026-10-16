// Each tool call is attributed to the checkout and work item it acts in,
// through the bundled bridge: a worktree's test run is the worktree's branch's
// (in the main working tree's journals) and leaves the session's branch alone,
// whether the call starts there or `cd`s there; a run anywhere else is no work
// item's; under the video workflow a check goes to the episode it names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readJournal } from "../dist/core/journal.js";
import { gitRepo, hook, withWorkflow } from "./helpers/repo.mjs";

const WS_DEV = fileURLToPath(new URL("./fixtures/ws-dev/", import.meta.url));
const VIDEO = fileURLToPath(new URL("../workflows/video/", import.meta.url));

const git = (root, ...a) => {
  const r = spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repository on feat/a with the workflow committed, and a worktree of it on branch w inside the project, where Claude Code puts an isolated subagent's. */
function withWorktree() {
  const root = gitRepo("feat/a");
  withWorkflow(root, WS_DEV, "dev");
  writeFileSync(join(root, ".geml", ".gitignore"), "journals/\ncontext.geml\n*.lock\n");
  git(root, "add", ".geml");
  git(root, "commit", "-q", "-m", "workflow");
  const wt = join(root, ".claude", "worktrees", "w");
  git(root, "worktree", "add", "-q", "-b", "w", wt);
  hook(root, { op: "status" });
  return { root, wt };
}

const journalOf = (root, item) => join(root, ".geml", "journals", `${item}.geml`);
const lastVars = (path) => readJournal(readFileSync(path, "utf8")).snapshots.at(-1).vars;
/** The calls whose evidence a journal recorded. */
const signalled = (path) => readJournal(readFileSync(path, "utf8")).snapshots.filter((s) => s.by === "signal").map((s) => s.call);
/** Every journal under a project's journals directory, relative to it. */
const journals = (root) => {
  const dir = join(root, ".geml", "journals");
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((n) => n.endsWith(".geml")).map((n) => n.split("\\").join("/")).sort() : [];
};
const ran = (root, callId, command, exitCode, extra = {}) =>
  hook(root, { op: "after", tool: "Bash", callId, input: { command }, isError: exitCode !== 0, exitCode, gitOperation: false, ...extra });

test("a test run in a worktree is the worktree's branch's, journaled in the main working tree, and leaves the session's branch alone", () => {
  const { root, wt } = withWorktree();
  assert.equal(ran(root, "c1", "npm test", 0, { cwd: root }).shell.status.vars["tests-pass"], true);

  const failed = ran(root, "c2", "npm test", 1, { cwd: wt });
  assert.deepEqual([failed.shell.status.item.id, failed.shell.status.vars["tests-pass"], failed.routed], ["feat/a", true, undefined]);
  assert.equal(existsSync(journalOf(root, "w")), false, "a failing run writes the default: nothing is recorded, so no journal is started");

  const passed = ran(root, "c3", "npm test", 0, { cwd: wt });
  assert.deepEqual([passed.shell.status.item.id, passed.shell.status.vars["tests-pass"], passed.context], ["feat/a", true, undefined], "the shell and its stage text stay the session's");
  assert.equal(passed.routed.item, "w");
  assert.match(passed.routed.context, /^\[gemflow\] stage build/, "the worktree's work item's own stage, for the subagent working there");
  assert.equal(lastVars(journalOf(root, "w"))["tests-pass"], true);
  assert.equal(existsSync(join(wt, ".geml", "journals")), false, "a worktree keeps no journals of its own");
  assert.equal(existsSync(join(wt, ".geml", "context.geml")), true, "the context document is the worktree's own");

  assert.equal(ran(root, "c4", "npm test", 1, { cwd: wt }).shell.status.vars["tests-pass"], true);
  assert.equal(lastVars(journalOf(root, "w"))["tests-pass"], false);
  assert.deepEqual(signalled(journalOf(root, "feat/a")), ["c1"], "nothing run in the worktree reached feat/a's journal");
  assert.deepEqual(signalled(journalOf(root, "w")), ["c3", "c4"]);
});

test("cd into a worktree and run the tests there: the worktree's, whether the path is relative or absolute", () => {
  const { root, wt } = withWorktree();
  ran(root, "c1", "npm test", 0);
  const rel = ran(root, "c2", "cd .claude/worktrees/w && npm test", 1, { cwd: root });
  assert.deepEqual([rel.shell.status.item.id, rel.shell.status.vars["tests-pass"]], ["feat/a", true]);
  ran(root, "c3", `cd "${wt}" && CI=1 npm test`, 0, { cwd: root });
  assert.equal(lastVars(journalOf(root, "w"))["tests-pass"], true);
  ran(root, "c4", "cd .claude/worktrees/w && npm test", 1);
  assert.equal(lastVars(journalOf(root, "w"))["tests-pass"], false, "a request without cwd starts at the root");
  assert.deepEqual(signalled(journalOf(root, "feat/a")), ["c1"]);
  // A directory the line makes is the checkout's it is made in, there or not when the bridge looks.
  ran(root, "c5", "mkdir -p .claude/worktrees/w/build && cd .claude/worktrees/w/build && npm test", 0, { cwd: root });
  assert.equal(lastVars(journalOf(root, "w"))["tests-pass"], true);
  assert.equal(lastVars(journalOf(root, "feat/a"))["tests-pass"], true);
  // Back out of the worktree in the same line: each command where its cd took the shell.
  ran(root, "c6", "cd .claude/worktrees/w && cd ../../.. && npm test", 1, { cwd: root });
  assert.equal(lastVars(journalOf(root, "feat/a"))["tests-pass"], false);
});

test("a command run where no workflow is records nothing anywhere; one whose directory the line does not say writes no evidence", () => {
  const { root } = withWorktree();
  ran(root, "c1", "npm test", 0);
  const outside = mkdtempSync(join(tmpdir(), "gemflow-outside-"));
  const plain = gitRepo("feat/z");
  for (const [callId, command, cwd] of [
    ["c2", "npm test", outside],
    ["c3", `cd "${outside}" && npm test`, root],
    ["c4", "npm test", plain],
    ["c5", `cd "${plain}" && npm test`, root],
    ["c6", "cd ../no-such-dir && npm test", root],
    ["c7", "cd $HOME/x && npm test", root],
    ["c8", "cd ~ && npm test", root],
  ]) {
    const r = ran(root, callId, command, 1, { cwd });
    assert.deepEqual([r.shell.status.item.id, r.shell.status.vars["tests-pass"], r.routed], ["feat/a", true, undefined], command);
  }
  assert.deepEqual(journals(root), ["feat/a.geml"]);
  assert.deepEqual(journals(plain), [], "a repository with no workflow gets nothing");
  assert.equal(existsSync(join(outside, ".geml")), false);
  assert.deepEqual(signalled(journalOf(root, "feat/a")), ["c1"]);
});

test("a subagent in an isolated worktree: a call that records nothing starts no journal; a person's word about a call goes into the worktree's dictionary; its evidence is its work item's", () => {
  const { root, wt } = withWorktree();
  const before = (callId, tool, input) => hook(root, { op: "before", tool, callId, input, cwd: wt });
  const pwd = before("s1", "Bash", { command: "pwd" });
  assert.deepEqual([pwd.refusal, pwd.recorded], [undefined, false]);
  assert.deepEqual(ran(root, "s1", "pwd", 0, { cwd: wt }).routed, undefined);
  assert.equal(existsSync(journalOf(root, "w")), false, "a subagent that only ran pwd leaves no journal");
  assert.equal(existsSync(join(wt, ".geml", "context.geml")), false);

  const fetch = before("s2", "WebFetch", { url: "https://example.com" });
  assert.deepEqual([fetch.refusal, fetch.recorded], [undefined, false], "a tool no row takes goes through, unasked");
  assert.equal(hook(root, { op: "learn", lessons: [{ kind: "allow", key: "WebFetch", where: "*" }], tool: "WebFetch", input: {}, cwd: wt }).ok, true);
  assert.match(readFileSync(join(wt, ".geml", "workflows", "dev", "tools.geml"), "utf8"), /\| WebFetch /, "the worktree's workflow learned it");
  assert.doesNotMatch(readFileSync(join(root, ".geml", "workflows", "dev", "tools.geml"), "utf8"), /WebFetch/, "the session's did not");
  assert.equal(before("s3", "WebFetch", {}).recorded, false);
  assert.equal(existsSync(journalOf(root, "w")), false, "a person's word starts no journal");

  assert.equal(before("s4", "Bash", { command: "npm test" }).recorded, false);
  assert.equal(ran(root, "s4", "npm test", 0, { cwd: wt }).shell.status.vars["tests-pass"], false);
  assert.equal(lastVars(journalOf(root, "w"))["tests-pass"], true);
  // The main loop writes into the worktree: the worktree item's dictionary judges it, by the file's directory.
  const write = hook(root, { op: "before", tool: "Write", callId: "m1", input: { file_path: join(wt, "src", "a.ts") }, cwd: root });
  assert.deepEqual([write.refusal, write.recorded], [undefined, false]);
  const status = hook(root, { op: "status" });
  assert.deepEqual([status.shell.status.item.id, status.shell.status.refusals, status.shell.status.vars["tests-pass"]], ["feat/a", 0, false]);
});

test("a person's command is refused wherever it runs: recorded in the worktree's work item there, nowhere when no work item is", () => {
  const { root, wt } = withWorktree();
  const outside = mkdtempSync(join(tmpdir(), "gemflow-outside-"));
  const away = hook(root, { op: "before", tool: "Bash", callId: "p1", input: { command: "gemflow mark reviewed" }, cwd: outside });
  assert.match(away.refusal, /is for a person/);
  assert.deepEqual([away.recorded, away.shell.status.refusals], [false, 0]);
  assert.deepEqual(journals(root), ["feat/a.geml"], "no work item to record it in");
  const there = hook(root, { op: "before", tool: "Bash", callId: "p2", input: { command: "cd .claude/worktrees/w && gemflow advance done" }, cwd: root });
  assert.match(there.refusal, /is for a person/);
  assert.deepEqual([there.recorded, there.shell.status.refusals], [true, 0]);
  assert.deepEqual(readJournal(readFileSync(journalOf(root, "w"), "utf8")).refusals.map((r) => r.call), ["p2"]);
  const sub = hook(root, { op: "before", tool: "Bash", callId: "p3", input: { command: "gemflow unmark reviewed" }, cwd: wt });
  assert.match(sub.refusal, /is for a person/);
  assert.equal(hook(root, { op: "status" }).shell.status.refusals, 0);
});

test("a session in a worktree keeps its journals in the main working tree, and the board lists every checkout's work items", () => {
  const { root, wt } = withWorktree();
  const opened = hook(wt, { op: "status" });
  assert.deepEqual(opened.shell.status.item, { kind: "item", id: "w" });
  assert.ok(existsSync(journalOf(root, "w")));
  assert.equal(existsSync(join(wt, ".geml", "journals")), false);
  assert.equal(ran(wt, "c1", "npm test", 0).shell.status.vars["tests-pass"], true);
  const board = hook(wt, { op: "board" }, { GEMFLOW_GH: "gh-definitely-not-installed" }).board;
  assert.deepEqual(board.items.map((i) => i.id), ["feat/a", "w"]);
  assert.deepEqual(board.timeline.filter((e) => e.kind === "snapshot").map((e) => [e.cause, e.by ?? ""]), [["enter", ""], ["patch", "signal"]]);
  // The main tree's session sees the worktree's run on w's journal, which it never wrote.
  assert.equal(lastVars(journalOf(root, "w"))["tests-pass"], true);
});

/** A project with the video workflow active and two episodes. */
function film() {
  const root = gitRepo("main");
  withWorkflow(root, VIDEO, "video");
  mkdirSync(join(root, "episodes"));
  const ep = '=== meta\ntitle = "ep"\nprofile = "geml-media/v1"\n===\n';
  writeFileSync(join(root, "episodes", "ep02.geml"), ep);
  writeFileSync(join(root, "episodes", "ep03.geml"), ep);
  const write = (callId, file) => hook(root, { op: "after", tool: "Write", callId, input: { file_path: join(root, file) }, isError: false, gitOperation: false, wrotePath: file, lastFile: file });
  write("w1", "episodes/ep02.geml");
  write("w2", "episodes/ep03.geml");
  // Into #assets, where todo-check is a use: a person's tick on each episode.
  for (const file of ["episodes/ep02.geml", "episodes/ep03.geml"]) hook(root, { op: "mark", variable: "script-final", checked: true, lastFile: file });
  return root;
}
const doneOf = (root, ep) => {
  const path = journalOf(root, `episodes/${ep}`);
  return existsSync(path) ? lastVars(path)["assets-done"] : undefined;
};

test("video: a check goes to the episode its command names, relative to the directory it runs in, not to the one written last; evidence belongs to the state that declares the use", () => {
  const root = film();
  const checked = ran(root, "t1", "cd episodes && geml media todo ep02.geml --check", 0, { lastFile: "episodes/ep03.geml" });
  assert.deepEqual([checked.shell.status.item.id, checked.shell.status.vars["assets-done"]], ["episodes/ep03", false], "the band stays on the episode being worked on");
  assert.deepEqual([doneOf(root, "ep02"), doneOf(root, "ep03")], [true, false]);
  assert.equal(readJournal(readFileSync(journalOf(root, "episodes/ep02"), "utf8")).snapshots.at(-1).state, "cut", "the check moved ep02 on");
  const context = readFileSync(join(root, ".geml", "context.geml"), "utf8");
  assert.match(context, /"item":"episodes\/ep03"/, "the context document stays the current episode's");
  ran(root, "t2", "geml media todo episodes/ep02.geml --root . --check", 1, { lastFile: "episodes/ep03.geml" });
  assert.deepEqual([doneOf(root, "ep02"), doneOf(root, "ep03")], [true, false], "#cut declares no todo-check: a check there is no evidence of ep02's");
});

test("video: a check that names two episodes, or a glob, records nothing; one that names none goes to the episode written last", () => {
  const root = film();
  const before = () => [readFileSync(journalOf(root, "episodes/ep02"), "utf8"), readFileSync(journalOf(root, "episodes/ep03"), "utf8")];
  const was = before();
  ran(root, "t1", "geml media todo episodes/ep02.geml episodes/ep03.geml --check", 0, { lastFile: "episodes/ep03.geml" });
  ran(root, "t2", "geml media todo 'episodes/*.geml' --check", 0, { lastFile: "episodes/ep03.geml" });
  assert.deepEqual(before(), was, "neither journal moved");
  ran(root, "t3", "geml media todo --check", 0, { lastFile: "episodes/ep03.geml" });
  assert.deepEqual([doneOf(root, "ep02"), doneOf(root, "ep03")], [false, true]);
  // An episode with no journal yet starts one only for a check that records something: in #script the use is not declared, so nothing is.
  writeFileSync(join(root, "episodes", "ep04.geml"), '=== meta\ntitle = "ep"\nprofile = "geml-media/v1"\n===\n');
  ran(root, "t4", "geml media todo episodes/ep04.geml --check", 1, { lastFile: "episodes/ep03.geml" });
  assert.equal(existsSync(journalOf(root, "episodes/ep04")), false);
  ran(root, "t5", "geml media todo episodes/ep04.geml --check", 0, { lastFile: "episodes/ep03.geml" });
  assert.equal(existsSync(journalOf(root, "episodes/ep04")), false, "#script declares no todo-check: the run is no evidence of ep04's");
  hook(root, { op: "mark", variable: "script-final", checked: true, lastFile: "episodes/ep04.geml" });
  ran(root, "t6", "geml media todo episodes/ep04.geml --check", 0, { lastFile: "episodes/ep03.geml" });
  assert.equal(doneOf(root, "ep04"), true);
  assert.equal(relative(root, journalOf(root, "episodes/ep04")).split("\\").join("/"), ".geml/journals/episodes/ep04.geml");
});
