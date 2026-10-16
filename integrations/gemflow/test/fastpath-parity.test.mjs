// The fast path against what it stands in for. For every call in a fixed
// matrix: beforeDecision and afterNeeded on the policy a shell holds, and what
// the bridge's `before` and `after` would do — a Workspace opened afresh per
// request, with Claude Code's tools, and the call attributed as the bridge
// attributes it. A "pass" must never skip a call `before` refuses or
// records; a skipped `after` must never be one that would change the status, the policy or the
// journal. `before` is exact both ways; an `after` asked for nothing costs a
// spawn and is allowed. The policy is the session's work item's, so the fast
// path may decide from it only for a call the bridge attributes to the
// session's checkout: every call the hooks module does not find elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace } from "../dist/workspace.js";
import { Attribution, Places, callPlace } from "../dist/attribution.js";
import { CLAUDE_CODE_TOOLS } from "../dist/core/host-tools.js";
import { commandDirs, switchesWorkItemOnly } from "../dist/core/command-line.js";
import { afterNeeded, beforeDecision, checkoutProbe } from "../dist/hosts/claude-code/fastpath.js";
import { bridgeInput } from "../dist/hosts/claude-code/readers.js";
import { gitRepo } from "./helpers/repo.mjs";

const FX = fileURLToPath(new URL("./fixtures/parity/", import.meta.url));
const git = { branch: "feat/x", committed: false };

function project() {
  const root = mkdtempSync(join(tmpdir(), "gemflow-parity-"));
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(FX, join(root, ".geml", "workflows", "par"), { recursive: true });
  writeFileSync(join(root, ".geml", "gemflow.geml"), '=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "par"\n===\n');
  return root;
}
const open = (root) => {
  const o = openWorkspace({
    root, tools: CLAUDE_CODE_TOOLS,
    git: () => ({ branch: git.branch, defaultBranch: "main", committed: git.committed }),
    gh: () => ({ available: false, reason: "parity" }),
  });
  if (!o.ok) throw new Error(o.reason);
  return o.ws;
};
/** Into `state` from #build: build→lock is the model's (a person may take it too); lock→release needs `ready` ticked and a person. */
const setup = (root, state) => {
  const step = (fn) => { const r = fn(open(root)); if (!r.ok) throw new Error(r.reason); };
  if (state === "lock" || state === "release") step((ws) => ws.advance("lock"));
  if (state === "release") { step((ws) => ws.mark("ready", true)); step((ws) => ws.advance("release")); }
};
const view = (root) => open(root).view();
/** The bridge's attribution over a workspace: every call here starts at the root. */
const attributed = (ws) => new Attribution(ws, () => undefined, CLAUDE_CODE_TOOLS);
/** What the hooks module finds for a call starting at `cwd`: checkoutProbe, then a `.git` entry on the way up to the root. */
const elsewhereOf = (call, cwd, root) => {
  const probe = checkoutProbe(call, cwd, root);
  return probe.elsewhere || probe.dirs.some((d) => existsSync(join(d, ".git")));
};
const strip = (v) => JSON.stringify({ ...v, status: { ...v.status, gh: undefined } });
const journals = (root) => {
  const dir = join(root, ".geml", "journals");
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8")).join("\n---\n");
};

const bash = (command) => ({ tool: "Bash", input: { command } });
const T = (tool, input = {}) => ({ tool, input });
const monitor = (command) => T("Monitor", { command, description: "watch", timeout_ms: 1000 });

const STATES = ["build", "lock", "release"];
const CALLS = [
  T("Read"), T("Edit", { file_path: "/x/a" }), T("Write"), T("NotebookEdit"), T("Grep"), T("Glob"), T("WebFetch"), T("WebSearch"),
  T("TodoWrite"), T("Agent"), T("Skill"), T("EnterWorktree"), T("mcp__github__create_pr"), T("mcp__img__generate", { prompt: "x" }),
  // gemflow's own three, as Claude Code lists them and bare; another tool under the prefix is not one of them
  T("mcp__gemflow__status"), T("mcp__gemflow__move", { to: "done" }), T("set"), T("mcp__gemflow__other"),
  // any tool with a command string meets the hard refusals
  monitor("gemflow mark reviewed"), monitor("wrangler deploy --env production"), monitor("sudo sh -c 'gemflow mark r'"), monitor("rg foo"),
  bash("ls"), bash("npm test"), bash("pnpm test"), bash("npm test && ls"), bash("ls && npm test"),
  // person-only
  bash("gemflow mark reviewed"), bash("cd x && gemflow advance release"), bash("npx -y @geml/gemflow mark reviewed"),
  bash('bash -c "gemflow unmark reviewed"'), bash("G=gemflow; $G mark reviewed"), bash("env FOO=1 gemflow mark reviewed"),
  bash("echo gemflow mark reviewed"), bash("node node_modules/@geml/gemflow/dist/cli.js advance done"), bash("GEMFLOW Mark reviewed"),
  bash("./node_modules/.bin/gemflow advance done"), bash("$(echo gemflow) mark reviewed"), bash("gemflow $V reviewed"),
  bash('sh -c "sh -c \\"gemflow mark r\\""'), bash("time -p gemflow mark r"), bash("{ gemflow mark r; }"), bash("if true; then gemflow mark r; fi"),
  bash("python3 -c \"import subprocess; subprocess.run(['gemflow','mark','r'])\""), bash("npm exec @geml/gemflow -- mark r"),
  bash("pnpm dlx @geml/gemflow mark r"), bash("yarn dlx @geml/gemflow mark r"), bash("gemflow 'mark' r"), bash("gem''flow mark r"),
  // person-only through a launcher that hands a string to a shell, and through PowerShell
  bash("sudo sh -c 'gemflow mark r'"), bash("env bash -c 'gemflow mark r'"), bash("nohup bash -c 'gemflow mark r'"), bash("timeout 5 bash -c 'gemflow mark r'"),
  bash("exec bash -c 'gemflow mark r'"), bash("npx -c 'gemflow mark r'"), bash("npm exec -c 'gemflow advance done'"),
  bash('pwsh -c "gemflow mark r"'), bash('powershell -Command "gemflow mark r"'), bash("pwsh -NoProfile -c gemflow advance done"),
  // a fenced use's command pattern, anywhere in the line
  bash("wrangler deploy --env production"), bash("npx wrangler deploy --env production"), bash('wran"gler" deploy  --env production'),
  bash("wrangler  deploy --env production"), bash("wrangler\tdeploy --env production"), bash("w\\rangler deploy --env production"),
  bash("wrangler deploy --env=production"), bash("echo 'wrangler deploy --env production'"), bash("WRANGLER deploy --env production"),
  bash("wrangler deploy \\\n--env production"), bash("bash -c 'wrangler deploy'"),
  // searches and reads through Bash
  bash("rg -n foo src"), bash("grep -rn foo . | head -5"), bash("find . -name '*.ts'"), bash("ls -la && wc -l a b"), bash("tree -L 2"),
  bash("fd -e ts"), bash("rg foo | wc -l"), bash("grep foo a 2>/dev/null"),
  bash("find . -name x -delete"), bash("find . -exec rm {} \\;"), bash("fd -x rm"), bash("rg foo > out.txt"), bash("rg foo; rm -rf x"),
  bash("rg --pre ./x foo"), bash("cat a"), bash("FOO=1 rg x"), bash('rg "$(rm -rf x)"'), bash("head -n 5 a || rm x"), bash("tail -f log &"),
  { tool: "Bash", input: { command: 42 } }, { tool: "Bash", input: {} },
  // switching the work item, the way out of every state; a bare checkout is the CLI's to check
  bash("git switch feat/y"), bash("git switch -c feat/new main"), bash("git checkout -b feat/new"), bash("git checkout feat/y"),
  bash("git worktree add -b feat/w ../wt"), bash("cd sub && git switch feat/y"), bash("git switch --discard-changes feat/y"), bash("git -C x switch feat/y"),
];

test("before: every call the workspace refuses or records is consulted, and nothing else but what only git can settle", (t) => {
  const templates = new Map();
  t.after(() => { for (const dir of templates.values()) rmSync(dir, { recursive: true, force: true }); });
  const templateFor = (state) => {
    if (!templates.has(state)) {
      const root = project();
      setup(root, state);
      templates.set(state, root);
    }
    return templates.get(state);
  };
  const wrong = [];
  for (const state of STATES) {
    for (const call of CALLS) {
      const root = mkdtempSync(join(tmpdir(), "gemflow-parity-"));
      try {
        cpSync(templateFor(state), root, { recursive: true });
        const elsewhere = elsewhereOf(call, root, root);
        const fast = beforeDecision(view(root).policy, call, elsewhere);
        const bv = attributed(open(root)).before(call.tool, "c1", bridgeInput(call.input), root);
        const label = `[${state}] ${call.tool} ${JSON.stringify(call.input.command ?? call.input.file_path ?? "")}`;
        const matters = bv.refusal !== undefined || bv.recorded;
        // A bare `git checkout <name>` switches the work item only when <name> is a branch, which git alone can say.
        const command = call.input.command;
        const needsGit = typeof command === "string" && switchesWorkItemOnly(command, () => true) && !switchesWorkItemOnly(command);
        if ((fast.kind === "pass" || fast.kind === "prefer") && matters) wrong.push(`${fast.kind}, but ${bv.refusal !== undefined ? `refused: ${bv.refusal.slice(0, 80)}` : "recorded"} ${label}`);
        // A call that may act elsewhere is the bridge's to judge, whatever it then finds.
        else if (fast.kind === "consult" && !matters && !elsewhere && !needsGit) wrong.push(`consult, but nothing to refuse or record ${label}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
  assert.deepEqual(wrong, []);
});

const OUT = (r) => { mkdirSync(join(r, "out"), { recursive: true }); writeFileSync(join(r, "out", "ep.txt"), "x"); };
const AFTER = [
  { name: "npm test exit 0", state: "build", call: bash("npm test"), o: { exitCode: 0 } },
  { name: "npm test exit 1", state: "build", call: bash("npm test"), o: { exitCode: 1, isError: true } },
  { name: "chain with assignment", state: "build", call: bash("cd . && CI=1 npm test"), o: { exitCode: 0 } },
  { name: "npm test | tee", state: "build", call: bash("npm test | tee log"), o: { exitCode: 0 } },
  { name: "npm test backgrounded", state: "build", call: bash("npm test"), o: { exitCode: null } },
  { name: "npm test where test is not a use", state: "lock", call: bash("npm test"), o: { exitCode: 0 } },
  { name: "ls, the file variables read again", state: "build", call: bash("ls"), o: { exitCode: 0 } },
  { name: "a build via Bash makes out/ep.txt", state: "build", call: bash("make out/ep.txt"), o: { exitCode: 0 }, world: OUT },
  { name: "a backgrounded build makes out/ep.txt", state: "build", call: bash("make out/ep.txt"), o: { exitCode: null }, world: OUT },
  { name: "rm via Bash removes out/ep.txt", state: "build", call: bash("rm out/ep.txt"), o: { exitCode: 0 }, pre: OUT, world: (r) => rmSync(join(r, "out", "ep.txt")) },
  { name: "Write touches out/ep.txt", state: "build", call: T("Write"), o: { wrotePath: "out/ep.txt" }, world: OUT },
  { name: "git commit with gitOperation", state: "build", call: bash("git commit -m x"), o: { exitCode: 0, gitOperation: true }, world: () => { git.committed = true; } },
  { name: "git reset --hard (no gitOperation)", state: "build", call: bash("git reset --hard main"), o: { exitCode: 0 },
    pre: () => { git.committed = true; }, world: () => { git.committed = false; } },
  { name: "cd . && git reset (no gitOperation)", state: "build", call: bash("cd . && git reset --hard main"), o: { exitCode: 0 },
    pre: () => { git.committed = true; }, world: () => { git.committed = false; } },
  { name: "git checkout another item (no gitOperation)", state: "build", call: bash("git checkout feat/y"), o: { exitCode: 0 },
    pre: (r) => { git.branch = "feat/y"; setup(r, "lock"); git.branch = "feat/x"; }, world: () => { git.branch = "feat/y"; } },
  { name: "git switch another item, behind sudo", state: "build", call: bash("sudo git switch feat/y"), o: { exitCode: 0 },
    pre: (r) => { git.branch = "feat/y"; setup(r, "lock"); git.branch = "feat/x"; }, world: () => { git.branch = "feat/y"; } },
  { name: "on main: git checkout -b (no gitOperation)", state: null, call: bash("git checkout -b feat/new"), o: { exitCode: 0 },
    pre: () => { git.branch = "main"; }, world: () => { git.branch = "feat/new"; } },
  { name: "on main: git switch -c in a shell string", state: null, call: bash("bash -c 'git switch -c feat/new'"), o: { exitCode: 0 },
    pre: () => { git.branch = "main"; }, world: () => { git.branch = "feat/new"; } },
  { name: "on main: checkout -b && commit (gitOperation)", state: null, call: bash("git checkout -b feat/new && git commit --allow-empty -m x"), o: { exitCode: 0, gitOperation: true },
    pre: () => { git.branch = "main"; }, world: () => { git.branch = "feat/new"; git.committed = true; } },
  { name: "a read that fails", state: "lock", call: T("Read"), o: { isError: true } },
  { name: "a tool bound to a use no variable reads fails", state: "build", call: T("mcp__img__generate", { prompt: "x" }), o: { isError: true } },
  { name: "make fails", state: "build", call: bash("make"), o: { isError: true, exitCode: 2 } },
  { name: "another tool under gemflow's prefix fails", state: "build", call: T("mcp__gemflow__other"), o: { isError: true } },
  { name: "gemflow's own tool fails", state: "build", call: T("mcp__gemflow__set"), o: { isError: true } },
  { name: "Edit src/a.ts", state: "build", call: T("Edit"), o: { wrotePath: "src/a.ts" } },
];

test("after: no call is skipped whose after would change the status, the policy or the journal", () => {
  const wrong = [];
  for (const c of AFTER) {
    git.branch = "feat/x"; git.committed = false;
    const root = project();
    try {
      c.pre?.(root);
      if (c.state) setup(root, c.state); else open(root).view();
      open(root).refresh();
      const stored = view(root);
      const before = journals(root);
      c.world?.(root);
      const o = { isError: false, gitOperation: false, consulted: false, ...c.o };
      const need = afterNeeded(stored.policy, c.call, o, elsewhereOf(c.call, root, root));
      const ws = open(root);
      attributed(ws).after({
        tool: c.call.tool, callId: "a1", isError: o.isError, input: bridgeInput(c.call.input), gitOperation: o.gitOperation,
        ...(o.exitCode !== undefined ? { exitCode: o.exitCode } : {}), ...(o.wrotePath !== undefined ? { wrotePath: o.wrotePath } : {}),
      }, root);
      const answer = ws.view();
      if (!need && (strip(answer) !== strip(stored) || journals(root) !== before)) {
        const item = (v) => v.status.item.id ?? v.status.item.reason;
        wrong.push(`skipped, but changes: ${c.name} :: vars ${JSON.stringify(stored.status.vars)} -> ${JSON.stringify(answer.status.vars)}; item ${item(stored)} -> ${item(answer)}; state ${stored.policy.state || "-"} -> ${answer.policy.state || "-"}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  git.branch = "feat/x"; git.committed = false;
  assert.deepEqual(wrong, []);
});

test("elsewhere: every call the hooks module keeps on the session's policy, the bridge attributes to the session's checkout, as a whole and command by command", (t) => {
  // The workflow committed; a worktree of the repository inside the project, where Claude Code puts an isolated
  // subagent's; a repository of its own with no workflow inside the project; and a directory outside it.
  const root = gitRepo("feat/x");
  const outside = mkdtempSync(join(tmpdir(), "gemflow-parity-out-"));
  t.after(() => { for (const d of [root, outside]) rmSync(d, { recursive: true, force: true }); });
  const g = (cwd, ...a) => { const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(FX, join(root, ".geml", "workflows", "par"), { recursive: true });
  writeFileSync(join(root, ".geml", "gemflow.geml"), '=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "par"\n===\n');
  g(root, "add", ".geml");
  g(root, "commit", "-q", "-m", "workflow");
  const wt = join(root, ".claude", "worktrees", "w");
  g(root, "worktree", "add", "-q", "-b", "w", wt);
  const lib = join(root, "vendor", "lib");
  mkdirSync(lib, { recursive: true });
  g(lib, "init", "-q");
  for (const d of [join(root, "src"), join(wt, "src")]) mkdirSync(d, { recursive: true });

  const places = new Places(root);
  const cwds = [root, join(root, "src"), join(root, "vendor"), wt, join(wt, "src"), lib, join(lib, "x"), outside];
  const calls = [
    bash("npm test"), bash("ls"), bash("CI=1 npm test && npm test"), bash("npm test | tee log"), bash("make; npm test"), bash("echo cd x && npm test"),
    bash("cd src && npm test"), bash("cd .claude/worktrees/w && npm test"), bash(`cd "${wt}" && npm test`), bash(`cd "${outside}" && ls`), bash("cd $HOME && ls"),
    bash("(cd src && make)"), bash("pushd src && make && popd"),
    T("Write", { file_path: join(root, "a.ts") }), T("Write", { file_path: join(wt, "src", "a.ts") }), T("Edit", { file_path: join(lib, "a.c") }),
    T("Edit", { file_path: join(outside, "a.ts") }), T("Write", { file_path: "src/b.ts" }), T("NotebookEdit", { notebook_path: join(root, "n.ipynb") }),
    T("Read", { file_path: join(wt, "a.ts") }), T("WebFetch"), T("Agent"), monitor("tail -f log"),
  ];
  const wrong = [];
  let kept = 0;
  for (const cwd of cwds) {
    for (const call of calls) {
      // What the hooks module does: the probe, then $.fs.stat of each directory's .git.
      const probe = checkoutProbe(call, cwd, root);
      if (probe.elsewhere || probe.dirs.some((d) => existsSync(join(d, ".git")))) continue;
      kept++;
      const whole = callPlace(call.tool, call.input, cwd, places);
      const command = typeof call.input.command === "string" ? call.input.command : undefined;
      const each = command === undefined ? [] : (commandDirs(command, cwd) ?? []).map((d) => places.of(d));
      if (whole.kind !== "session" || each.some((p) => p.kind !== "session")) {
        wrong.push(`kept on the session's policy, but attributed to ${[whole, ...each].map((p) => p.kind).join("/")}: ${call.tool} ${JSON.stringify(call.input)} from ${cwd}`);
      }
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(kept > 40, `the matrix keeps ${kept} calls on the policy`);
  // And what the hooks module sends on, the bridge does take elsewhere.
  assert.deepEqual(callPlace("Bash", { command: "npm test" }, wt, places), { kind: "other", root: realpathSync.native(wt) });
  assert.deepEqual(callPlace("Bash", { command: "cd .claude/worktrees/w && npm test" }, root, places), { kind: "other", root: realpathSync.native(wt) });
  assert.equal(callPlace("Bash", { command: "npm test" }, lib, places).kind, "elsewhere", "a repository with no workflow");
  assert.equal(callPlace("Bash", { command: "ls" }, outside, places).kind, "elsewhere");
  assert.equal(callPlace("Bash", { command: "cd $HOME && ls" }, root, places).kind, "unknown");
  assert.equal(callPlace("Bash", { command: "npm test && cd .claude/worktrees/w && npm test" }, root, places).kind, "unknown", "commands in two checkouts");
  assert.equal(callPlace("Write", { file_path: join(wt, "a.ts") }, root, places).kind, "other");
});
