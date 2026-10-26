import { test } from "node:test";
import assert from "node:assert/strict";
import { OWN_TOOL_PREFIX, afterNeeded, beforeDecision, checkoutProbe, isOwnTool, matchesUnit, paramsToFill } from "../dist/hosts/claude-code/fastpath.js";

const row = (tool, over = {}) => ({ tool, allow: [], deny: [], default: false, row: 0, ...over });
/** The dev workflow's policy in #build, as the shell holds it: uses edit, test and pr; the dictionary's rows; one file variable. */
const policy = (over = {}) => ({
  active: true, unit: { kind: "branch" }, state: "build",
  uses: ["edit", "test", "pr"],
  fences: { edit: ["build", "review"], test: ["build", "review"], pr: ["build"], "deploy-prod": ["release"], image: ["build"] },
  rules: ["edit", "test", "pr", "deploy-prod", "image"],
  rows: [
    row("Read", { allow: ["*"] }), row("Grep", { allow: ["*"] }),
    row("Edit", { for: "edit", default: true }), row("Write", { for: "edit" }),
    row("Bash(npm test)", { for: "test", default: true }), row("Bash(gh pr create)", { for: "pr", default: true }),
    row("Bash(wrangler deploy)", { for: "deploy-prod", default: true }),
    row("WebFetch", { allow: ["build"], deny: ["review"] }),
    row("mcp__img__*", { for: "image", default: true, params: { ratio: "9:16" } }),
  ],
  files: ["out/*.mp4"], git: true, relevant: ["tests-pass", "pr-open"], evidence: ["test", "deploy-prod"], written: ["src/a.ts"],
  ...over,
});
const bash = (command) => ({ tool: "Bash", input: { command } });
const monitor = (command) => ({ tool: "Monitor", input: { command, description: "watch", timeout_ms: 1000 } });
const T = (tool, input = {}) => ({ tool, input });
const outcome = (over = {}) => ({ isError: false, gitOperation: false, consulted: false, ...over });
const PASS = { kind: "pass" };
const CONSULT = { kind: "consult" };

test("no policy, no work item, or gemflow's own tool: never a spawn", () => {
  assert.deepEqual(beforeDecision(null, bash("gemflow mark x")), PASS);
  assert.deepEqual(beforeDecision(policy({ active: false }), bash("gemflow mark x")), PASS);
  assert.deepEqual(beforeDecision(policy(), T(`${OWN_TOOL_PREFIX}status`)), PASS);
  assert.equal(afterNeeded(null, bash("npm test"), outcome({ exitCode: 0 })), false);
  assert.equal(afterNeeded(policy(), T(`${OWN_TOOL_PREFIX}set`), outcome({ consulted: true })), false);
});

test("the dictionary decides (spec §5.3): a use the state declares passes, a use it does not is consulted, learned allow and deny, and an unknown key is asked about", () => {
  assert.deepEqual(beforeDecision(policy(), T("Edit")), PASS);
  assert.deepEqual(beforeDecision(policy(), T("Read")), PASS, "allowed everywhere");
  assert.deepEqual(beforeDecision(policy(), T("WebFetch")), PASS, "allowed in #build");
  assert.deepEqual(beforeDecision(policy({ state: "review", uses: ["edit", "test"] }), T("WebFetch")), CONSULT, "denied in #review: the CLI refuses and records");
  assert.deepEqual(beforeDecision(policy({ state: "review", uses: ["edit", "test"] }), bash("gh pr create")), CONSULT, "pr is #build's use");
  assert.deepEqual(beforeDecision(policy(), bash("wrangler deploy --env production")), CONSULT, "deploy-prod is #release's");
  assert.deepEqual(beforeDecision(policy({ state: "release", uses: ["deploy-prod"] }), bash("wrangler deploy --env production")), PASS);
  assert.deepEqual(beforeDecision(policy(), T("TodoWrite")), PASS, "a tool no row takes passes, unasked");
  assert.deepEqual(beforeDecision(policy(), bash("npm test && ls")), PASS, "a chain is judged key by key: a key no row takes passes");
  assert.deepEqual(beforeDecision(policy({ uses: [] }), T("Edit")), CONSULT, "a use fenced to other states");
});

test("a tool bound to a use whose preferred tool is another is asked about (spec §5.3, preferences); the tools that write files are no choice between one another", () => {
  const pnpm = policy({ rows: [...policy().rows, row("Bash(pnpm test)", { for: "test" })] });
  assert.deepEqual(beforeDecision(pnpm, bash("pnpm test")), { kind: "prefer", key: "Bash(pnpm test)", use: "test", preferred: "Bash(npm test)" });
  assert.deepEqual(beforeDecision(policy({ rows: pnpm.rows.filter((r) => r.tool !== "Bash(npm test)") }), bash("pnpm test")), PASS, "the only tool of a use is its preferred one");
  assert.deepEqual(beforeDecision(policy(), T("Write")), PASS, "Edit changes a file, Write makes one: neither is asked about");
  assert.deepEqual(beforeDecision(policy(), T("Write", { file_path: "/w/app/src/a.ts" })), PASS);
  assert.deepEqual(beforeDecision(policy({ rows: policy().rows.map((r) => (r.tool === "Write" ? { ...r, default: true } : r.tool === "Edit" ? { ...r, default: false } : r)) }), T("Edit")), PASS, "nor the other way round");
  const matter = policy({ rows: [...policy().rows, row("Edit(.geml/matters/*)", { for: "edit", default: true })].map((r) => (r.tool === "Edit" ? { ...r, default: false } : r)) });
  assert.deepEqual(beforeDecision(matter, T("Write", { file_path: "/w/app/src/a.ts" })), PASS, "a write tool's row with a path is a write tool too");
});

test("a person's command and a fenced command pattern anywhere in the line are consulted; switching the work item passes", () => {
  assert.deepEqual(beforeDecision(policy(), bash("cd x && gemflow advance release")), CONSULT);
  assert.deepEqual(beforeDecision(policy(), bash('bash -c "npx -y @geml/gemflow mark reviewed"')), CONSULT, "the supervisor's own scan, shell strings included");
  assert.deepEqual(beforeDecision(policy(), bash("echo gemflow mark reviewed")), PASS, "naming a verb is not running it");
  assert.deepEqual(beforeDecision(policy(), bash("npx wrangler deploy --env production")), CONSULT, "the pattern is found inside a launcher");
  assert.deepEqual(beforeDecision(policy(), bash('wran"gler" deploy  --env production')), CONSULT, "found with the quoting removed too");
  assert.deepEqual(beforeDecision(policy(), bash("npm test")), PASS);
  for (const c of ["git switch feat/y", "git switch -c feat/new main", "git checkout -b feat/new", "git worktree add -b feat/w ../wt", "cd sub && git switch feat/y"]) {
    assert.deepEqual(beforeDecision(policy({ uses: [] }), bash(c)), PASS, c);
  }
  assert.deepEqual(beforeDecision(policy({ uses: [] }), bash("git checkout feat/y")), CONSULT, "a bare checkout needs git to say it is a branch: the CLI decides");
});

test("the hard refusals reach any tool whose input has a command string, not only Bash", () => {
  assert.deepEqual(beforeDecision(policy(), monitor("gemflow mark reviewed")), CONSULT);
  assert.deepEqual(beforeDecision(policy(), monitor("sudo sh -c 'gemflow mark reviewed'")), CONSULT);
  assert.deepEqual(beforeDecision(policy(), monitor("npx wrangler deploy --env production")), CONSULT);
  assert.deepEqual(beforeDecision(policy({ rows: [...policy().rows, row("Monitor", { allow: ["*"] })] }), monitor("ls")), PASS);
  assert.deepEqual(beforeDecision(policy({ rows: [...policy().rows, row("Monitor", { allow: ["*"] })] }), { tool: "Monitor", input: { command: ["gemflow", "mark"] } }), PASS, "a command that is not a string is no command line");
});

test("after: a command bound to an evidence use with an exit status, a git operation, a recorded before, a failing tool bound to evidence", () => {
  const p = policy({ files: [] });
  assert.equal(afterNeeded(p, bash("npm test -- --grep x"), outcome({ exitCode: 1 })), true);
  assert.equal(afterNeeded(p, bash("cd app && CI=1 npm test"), outcome({ exitCode: 0 })), true, "a simple command of an && chain, assignments dropped");
  assert.equal(afterNeeded(p, bash("npm test | tee log"), outcome({ exitCode: 0 })), false, "a pipeline's exit status says nothing about the test");
  assert.equal(afterNeeded(p, bash("echo npm test"), outcome({ exitCode: 0 })), false, "the pattern matches at the start of a simple command");
  assert.equal(afterNeeded(p, bash("npm test"), outcome({ exitCode: null })), false, "backgrounded: no exit status yet");
  assert.equal(afterNeeded(p, bash("ls"), outcome({ exitCode: 0 })), false);
  assert.equal(afterNeeded(p, bash("git commit -m x"), outcome({ exitCode: 0, gitOperation: true })), true);
  assert.equal(afterNeeded(p, T("WebFetch"), outcome({ consulted: true })), true);
  assert.equal(afterNeeded(p, bash("make"), outcome({ exitCode: 2, isError: true })), false);
  assert.equal(afterNeeded(p, T("Edit"), outcome({ isError: true })), false, "edit is no variable's evidence");
  const img = policy({ files: [], evidence: ["test", "image"] });
  assert.equal(afterNeeded(img, T("mcp__img__generate", { prompt: "x" }), outcome({})), true, "a tool bound to a use some variable reads: its success is evidence");
  assert.equal(afterNeeded(img, T("mcp__img__generate"), outcome({ isError: true })), true, "and so is its error");
});

test("after a git or gh command, a git operation or not, with or without a work item: the branch may have moved", () => {
  const p = policy({ files: [] });
  for (const c of ["git status", "git checkout -b feat/y", "git switch feat/y", "cd . && git reset --hard main", "sudo git switch feat/y", "bash -c 'git checkout -b x'", "gh pr checkout 7"]) {
    assert.equal(afterNeeded(p, bash(c), outcome({ exitCode: 0 })), true, c);
    assert.equal(afterNeeded(policy({ active: false, files: [] }), bash(c), outcome({ exitCode: 0 })), true, `${c}, on the default branch`);
  }
  assert.equal(afterNeeded(policy({ active: false, files: [] }), bash("./ship.sh"), outcome({ exitCode: 0, gitOperation: true })), true, "a git operation, whatever command made it");
  assert.equal(afterNeeded(policy({ active: false, files: [] }), bash("echo git push"), outcome({ exitCode: 0 })), false, "naming git is not running it");
  assert.equal(afterNeeded(policy({ active: false, files: [] }), monitor("git switch feat/y"), outcome({})), false, "only a run tool reads git again");
  assert.equal(afterNeeded(null, bash("git switch feat/y"), outcome({ exitCode: 0 })), false, "no workflow here");
});

test("after any Bash call while the workflow has file variables: a run makes files as surely as a write", () => {
  assert.equal(afterNeeded(policy(), bash("ffmpeg -i in.mov out/ep01.mp4"), outcome({ exitCode: 0 })), true);
  assert.equal(afterNeeded(policy(), bash("ffmpeg -i in.mov out/ep01.mp4"), outcome({ exitCode: null })), true, "backgrounded: the files are read again all the same");
  assert.equal(afterNeeded(policy(), bash("ls"), outcome({ exitCode: 0 })), true);
  assert.equal(afterNeeded(policy({ files: [] }), bash("ls"), outcome({ exitCode: 0 })), false);
  assert.equal(afterNeeded(policy({ active: false }), bash("ls"), outcome({ exitCode: 0 })), false, "no work item: nothing reads the files");
  assert.equal(afterNeeded(policy(), monitor("ls"), outcome({})), false, "not a run tool");
});

test("gemflow's own tools are its three, bare, as Claude Code lists them or as dsh and pi register them; another tool under the prefix is not one", () => {
  for (const name of ["status", "move", "set"]) {
    assert.equal(isOwnTool(name), true, name);
    assert.equal(isOwnTool(`${OWN_TOOL_PREFIX}${name}`), true, name);
    assert.equal(isOwnTool(`gemflow_${name}`), true, name);
    assert.deepEqual(beforeDecision(policy({ uses: [] }), T(name)), PASS, name);
  }
  assert.equal(isOwnTool(`${OWN_TOOL_PREFIX}other`), false);
  assert.equal(isOwnTool("mcp__other__status"), false);
  assert.deepEqual(beforeDecision(policy(), T(`${OWN_TOOL_PREFIX}other`)), PASS, "another tool under the prefix is an ordinary tool");
});

test("after a write: a file variable's glob, the file unit's glob even before there is a work item, or a file the stage has not recorded yet", () => {
  assert.equal(afterNeeded(policy(), T("Write"), outcome({ wrotePath: "out/ep01.mp4" })), true);
  assert.equal(afterNeeded(policy(), T("Write"), outcome({ wrotePath: "src/a.ts" })), false, "recorded since the stage was entered");
  assert.equal(afterNeeded(policy(), T("Write"), outcome({ wrotePath: "src/b.ts" })), true, "a new artifact");
  assert.equal(afterNeeded(policy(), T("Write"), outcome({ wrotePath: "src/b.ts", isError: true })), false, "a failed write made nothing");
  assert.equal(afterNeeded(policy({ written: undefined }), T("Write"), outcome({ wrotePath: "src/a.ts" })), true, "a policy from before the field");
  const film = policy({ active: false, unit: { kind: "file", glob: "episodes/*.geml" } });
  assert.equal(afterNeeded(film, T("Edit"), outcome({ wrotePath: "episodes/ep02.geml" })), true);
  assert.equal(afterNeeded(film, T("Edit"), outcome({ wrotePath: "notes.md" })), false);
  assert.equal(matchesUnit(film, "episodes/ep02.geml"), true);
  assert.equal(matchesUnit(policy(), "episodes/ep02.geml"), false);
  assert.equal(matchesUnit(film, undefined), false);
});

test("the parameters a dictionary row fills in: only those the call leaves out, never for a command line", () => {
  assert.deepEqual(paramsToFill(policy(), T("mcp__img__generate", { prompt: "x" })), { ratio: "9:16" });
  assert.equal(paramsToFill(policy(), T("mcp__img__generate", { prompt: "x", ratio: "1:1" })), undefined);
  assert.equal(paramsToFill(policy(), T("Edit")), undefined, "no params on the row");
  assert.equal(paramsToFill(policy({ active: false }), T("mcp__img__generate")), undefined);
  assert.equal(paramsToFill(policy(), bash("mcp__img__generate")), undefined);
  assert.equal(paramsToFill(null, T("mcp__img__generate")), undefined);
});

test("checkoutProbe: the directories between a call's directory and the root, or elsewhere outright", () => {
  const probe = (call, cwd, root = "/w/app") => checkoutProbe(call, cwd, root);
  assert.deepEqual(probe(bash("ls"), "/w/app"), { elsewhere: false, dirs: [] }, "the root's own .git is the session's");
  assert.deepEqual(probe(bash("ls"), "/w/app/a/b"), { elsewhere: false, dirs: ["/w/app/a/b", "/w/app/a"] });
  assert.deepEqual(probe(bash("ls"), "/w/app/.claude/worktrees/agent-1"), { elsewhere: false, dirs: ["/w/app/.claude/worktrees/agent-1", "/w/app/.claude/worktrees", "/w/app/.claude"] });
  assert.deepEqual(probe(bash("ls"), "/w/other"), { elsewhere: true });
  assert.deepEqual(probe(bash("ls"), "/w/application"), { elsewhere: true }, "a sibling whose name starts like the root's is not under it");
  assert.deepEqual(probe(bash("cd sub && npm test"), "/w/app"), { elsewhere: true }, "a line that moves the shell is the bridge's to follow");
  assert.deepEqual(probe(bash("make; cd .."), "/w/app"), { elsewhere: true });
  assert.deepEqual(probe(bash("echo cd x"), "/w/app"), { elsewhere: false, dirs: [] });
  // A written file's directory, whatever directory the call starts in.
  assert.deepEqual(probe({ tool: "Write", input: { file_path: "/w/app/.claude/worktrees/w/src/a.ts" } }, "/w/app"),
    { elsewhere: false, dirs: ["/w/app/.claude/worktrees/w/src", "/w/app/.claude/worktrees/w", "/w/app/.claude/worktrees", "/w/app/.claude"] });
  assert.deepEqual(probe({ tool: "Edit", input: { file_path: "src/a.ts" } }, "/w/app/x"), { elsewhere: false, dirs: ["/w/app/x/src", "/w/app/x"] });
  assert.deepEqual(probe({ tool: "NotebookEdit", input: { notebook_path: "/w/app/n.ipynb" } }, "/w/elsewhere"), { elsewhere: false, dirs: [] });
  assert.deepEqual(probe({ tool: "Write", input: { file_path: "/tmp/a.ts" } }, "/w/app"), { elsewhere: true });
  assert.deepEqual(probe({ tool: "Write", input: { file_path: "../../../x.ts" } }, "/w/app"), { elsewhere: true }, "a path that climbs out of every directory");
  // Windows spellings, and a root given with a trailing separator.
  assert.deepEqual(probe(bash("dir"), "c:\\w\\app\\sub", "C:\\w\\app"), { elsewhere: false, dirs: ["C:/w/app/sub"] });
  assert.deepEqual(probe(bash("dir"), "C:\\w\\app", "c:\\w\\app\\"), { elsewhere: false, dirs: [] });
  assert.deepEqual(probe(bash("dir"), "D:\\w\\app", "C:\\w\\app"), { elsewhere: true });
});

test("a call that may act in another checkout is the bridge's, before and after, whatever the session's policy says", () => {
  const ls = bash("ls");
  const rows = [...policy().rows, row("Bash(ls)", { allow: ["*"] })];
  assert.deepEqual(beforeDecision(policy({ rows }), ls), PASS);
  assert.deepEqual(beforeDecision(policy({ rows }), ls, true), CONSULT);
  assert.deepEqual(beforeDecision(policy({ active: false, rows }), ls, true), CONSULT, "the session has no work item; the checkout the call acts in may have one");
  assert.equal(afterNeeded(policy({ files: [] }), ls, outcome({ exitCode: 0 })), false);
  assert.equal(afterNeeded(policy({ files: [] }), ls, outcome({ exitCode: 0 }), true), true);
  assert.equal(afterNeeded(policy({ active: false, files: [] }), ls, outcome({ exitCode: null }), true), true);
  assert.deepEqual(beforeDecision(null, ls, true), PASS, "no workflow in the session: Gemflow is not in use here");
  assert.equal(afterNeeded(null, ls, outcome({ exitCode: 0 }), true), false);
  assert.deepEqual(beforeDecision(policy(), T(`${OWN_TOOL_PREFIX}status`), true), PASS);
  assert.equal(afterNeeded(policy(), T(`${OWN_TOOL_PREFIX}set`), outcome({}), true), false);
});

test("under a file unit a command's evidence is asked after with a current work item or none: the file its command names takes it", () => {
  const film = policy({
    active: false, unit: { kind: "file", glob: "episodes/*.geml" }, files: [], uses: [],
    fences: { "todo-check": ["assets"] }, rules: ["todo-check"], rows: [row("Bash(geml media todo*--check)", { for: "todo-check", default: true })], evidence: ["todo-check"],
  });
  assert.equal(afterNeeded(film, bash("geml media todo episodes/ep02.geml --check"), outcome({ exitCode: 0 })), true);
  assert.equal(afterNeeded(film, bash("geml media todo episodes/ep02.geml --check"), outcome({ exitCode: null })), false, "backgrounded: no exit status yet");
  assert.equal(afterNeeded(film, bash("ls episodes"), outcome({ exitCode: 0 })), false);
  assert.equal(afterNeeded(policy({ active: false, files: [] }), bash("npm test"), outcome({ exitCode: 0 })), false, "a branch unit with no work item takes no evidence");
});
