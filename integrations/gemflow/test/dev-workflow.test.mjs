import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { commandSignals } from "../dist/core/signals.js";
import { decide, fencedRefusal, keysOf } from "../dist/core/dictionary.js";
import { readDictionary } from "../dist/core/dictionary-file.js";
import { relevantVars, scopeIn } from "../dist/core/policy.js";
import { CLAUDE_CODE_TOOLS } from "../dist/core/host-tools.js";
import { validate } from "../dist/core/schema.js";
import { blockText } from "../dist/core/blocks.js";
import { BUNDLE, fakeGh, gitRepo, hook } from "./helpers/repo.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FLOW = fileURLToPath(new URL("../workflows/dev/flow.geml", import.meta.url));
const GUIDE = readFileSync(new URL("../workflows/dev/guide.geml", import.meta.url), "utf8");
const sc = () => loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml").statechart;
const dict = () => readDictionary(readFileSync(new URL("../workflows/dev/tools.geml", import.meta.url), "utf8"), sc());
/** The gate's answer for a Bash command line in `state`, the person-only rule aside: the fenced search, then the dictionary's decision on the keys. */
const refusalOf = (s, d, state, command) => {
  const scope = scopeIn(s, state);
  const fenced = fencedRefusal(d, scope, command);
  if (fenced !== undefined) return fenced;
  const v = decide(d, scope, keysOf("Bash", { command }, CLAUDE_CODE_TOOLS.run));
  return v.kind === "refuse" ? v.reasons.join("; ") : undefined;
};

test("the dev workflow and its dictionary check with no diagnostics, and every prompt resolves to a guide block", () => {
  const r = spawnSync(process.execPath, [CLI, "check", FLOW], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^ok: no diagnostics$/m);
  const resolveRef = (ref) => ref.startsWith("./guide.geml#") && blockText(GUIDE, ref.slice("./guide.geml#".length)) !== undefined;
  assert.deepEqual(loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml", { resolveRef }).diagnostics, []);
  assert.deepEqual(dict().diagnostics, []);
});

test("five states in order on a branch unit; the uses, the variables with their sources, and the transitions with their judges", () => {
  const s = sc();
  assert.deepEqual([...s.states.keys()], ["build", "review", "deploy", "release", "done"]);
  assert.deepEqual(s.unit, { kind: "branch" });
  assert.deepEqual([...s.states.values()].map((x) => [x.prompt, x.uses]), [
    ["./guide.geml#build", ["edit", "test", "pr"]], ["./guide.geml#review", ["edit", "test"]], ["./guide.geml#deploy", ["deploy-staging"]], ["./guide.geml#release", ["deploy-prod"]], [undefined, []],
  ]);
  assert.deepEqual([...s.vars.values()].map((v) => [v.name, v.source]), [
    ["tests-pass", { kind: "tool", use: "test" }], ["pr-open", { kind: "git", fact: "pr-open" }], ["pr-merged", { kind: "git", fact: "pr-merged" }], ["ci-pass", { kind: "git", fact: "ci-success" }],
    ["review-ready", { kind: "human" }], ["deployed-staging", { kind: "tool", use: "deploy-staging" }], ["deployed-prod", { kind: "tool", use: "deploy-prod" }],
  ]);
  assert.deepEqual(s.transitions.map((t) => [t.name, t.judge, t.approval, t.resets]), [
    ["build→review", "machine", false, []], ["review→build", "model", false, ["tests-pass", "review-ready"]], ["review→deploy", "machine", false, []],
    ["deploy→release", "machine", true, []], ["release→done", "machine", false, []],
  ]);
  const d = dict();
  assert.match(refusalOf(s, d, "review", "wrangler deploy --env staging"), /is deploy-staging, which is used only in #deploy/);
  assert.equal(refusalOf(s, d, "deploy", "wrangler deploy --env staging"), undefined);
  assert.match(refusalOf(s, d, "deploy", "wrangler deploy --env production"), /is deploy-prod, which is used only in #release/);
  assert.equal(refusalOf(s, d, "release", "wrangler deploy --env production"), undefined);
});

test("end to end through the bridge: evidence advances it, deploys wait for their states, release waits for a person", () => {
  const root = gitRepo();
  const init = spawnSync(process.execPath, [BUNDLE, "init", "--template", "dev"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^wrote \.geml\/workflows\/dev\/ \(active\)$/m);
  const gh = fakeGh();
  const before = (command, callId) => hook(root, { op: "before", tool: "Bash", callId, input: { command } });
  const ran = (command, callId, extra = {}, env = {}) => hook(root, { op: "after", tool: "Bash", callId, input: { command }, isError: false, exitCode: 0, gitOperation: false, ...extra }, env);
  assert.equal(hook(root, { op: "status" }).shell.status.state.id, "build");
  assert.match(before("npx wrangler deploy --env staging", "d1").refusal, /is deploy-staging, which is used only in #deploy; the workflow is in #build/);

  ran("npm test", "t1");
  gh.set({ pr: "OPEN" });
  const review = hook(root, { op: "refresh" }, gh.env);
  assert.deepEqual(review.entered, ["review"]);
  assert.match(review.context, /PR 已开。逐条处理 review 意见/);
  assert.match(review.context, /--- \.\/guide\.geml#review ---\n# 评审 \{#review\}/, "the guide's block, read in process by the bundle");

  gh.set({ pr: "MERGED", runs: [{ name: "ci", conclusion: "success" }] });
  const merged = ran("gh pr merge 7 --squash", "g1", { gitOperation: true }, gh.env);
  assert.deepEqual(merged.entered, ["deploy"]);
  assert.equal(before("wrangler deploy --env staging", "d2").refusal, undefined);
  assert.match(before("wrangler deploy --env production", "d3").refusal, /is deploy-prod, which is used only in #release/);
  assert.equal(hook(root, { op: "advance", to: "release" }).ok, false, "a person's advance needs the guard too: nothing is deployed to staging yet");
  assert.deepEqual(ran("wrangler deploy --env staging", "s1").shell.status.vars["deployed-staging"], true);

  const model = hook(root, { op: "verb", name: "move", args: { to: "release" }, callId: "v1" });
  assert.match(model.text, /^refused: deploy→release needs a person: they approve it on the Gemflow board or with `gemflow advance release` — a person approves it on the Gemflow board/);
  assert.deepEqual(hook(root, { op: "advance", to: "release" }).entered, ["release"]);
  assert.equal(before("wrangler deploy --env production", "d4").refusal, undefined);
  assert.deepEqual(ran("wrangler deploy --env production", "p1").entered, ["done"]);
});

test("the dictionary reads the spellings people type: npx, --env=…, -e …, test arguments; npm test:claude is another script", () => {
  const s = sc(), d = dict();
  const read = (state, command, exitCode = 0) => Object.fromEntries(commandSignals(s, d, state, { command, exitCode }).map((x) => [x.id, x.value]));
  assert.deepEqual(read("build", "npm test"), { "tests-pass": true });
  assert.deepEqual(read("build", "npm test -- --watch=false", 1), { "tests-pass": false });
  assert.deepEqual(read("build", "cd integrations/gemflow && npm test"), { "tests-pass": true });
  assert.deepEqual(read("build", "npm test:claude"), {});
  assert.deepEqual(read("build", "npm run build"), {});
  assert.deepEqual(read("deploy", "npx wrangler deploy --env staging"), { "deployed-staging": true });
  assert.deepEqual(read("release", "wrangler deploy --env=production"), { "deployed-prod": true });
  assert.deepEqual(read("release", "CI=1 wrangler deploy -e production", 1), { "deployed-prod": false });
  assert.deepEqual(read("deploy", "wrangler deploy --env staging"), { "deployed-staging": true });
  assert.deepEqual(read("build", "wrangler deploy --env staging"), {}, "evidence belongs to the state that declares the use");
  for (const command of ["npx wrangler deploy --env production", "wrangler deploy --env=production", "cd app && wrangler deploy -e production", 'wran"gler"  deploy --env production']) {
    assert.match(refusalOf(s, d, "deploy", command), /is deploy-prod, which is used only in #release/, command);
    assert.equal(refusalOf(s, d, "release", command), undefined, command);
  }
  assert.match(refusalOf(s, d, "build", "npx wrangler deploy --env=staging"), /is deploy-staging, which is used only in #deploy/);
  assert.equal(refusalOf(s, d, "build", "wrangler dev"), undefined);
});

test("build→review holds on tests and an open PR, on a merged PR, or on a person's tick", () => {
  const s = sc();
  const guard = s.transitions.find((t) => t.name === "build→review").guard.schema;
  const base = { "tests-pass": false, "pr-open": false, "pr-merged": false, "review-ready": false };
  const holds = (vars) => validate(guard, { ...base, ...vars }).length === 0;
  assert.equal(holds({}), false);
  assert.equal(holds({ "tests-pass": true }), false);
  assert.equal(holds({ "pr-open": true }), false, "an open PR alone is not ready: the tests have not passed");
  assert.equal(holds({ "tests-pass": true, "pr-open": true }), true);
  assert.equal(holds({ "pr-merged": true }), true, "a PR merged before Gemflow saw it open");
  assert.equal(holds({ "review-ready": true }), true, "a person says review can start (the tests run only in CI)");
  assert.equal(holds({ "tests-pass": true, "pr-open": true, "review-ready": true }), true, "any branch, not exactly one");
  assert.deepEqual(relevantVars(s, "build"), ["pr-merged", "pr-open", "review-ready", "tests-pass"]);
});

test("a PR merged before Gemflow saw it open: one refresh walks #build → #review → #deploy when CI is green", () => {
  const root = gitRepo("feat/m");
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "dev"], { cwd: root, encoding: "utf8" }).status, 0);
  const gh = fakeGh();
  hook(root, { op: "after", tool: "Bash", callId: "t", input: { command: "npm test" }, isError: false, exitCode: 0, gitOperation: false });
  gh.set({ pr: "MERGED", runs: [{ name: "ci", conclusion: "success" }] });
  const r = hook(root, { op: "refresh" }, gh.env);
  assert.deepEqual(r.entered, ["review", "deploy"]);
  assert.equal(r.shell.status.state.id, "deploy");
  assert.match(r.context, /已合并且 CI 通过/);
});

test("merged with no local test run and CI red: #review, waiting for CI", () => {
  const root = gitRepo("feat/n");
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "dev"], { cwd: root, encoding: "utf8" }).status, 0);
  const gh = fakeGh();
  gh.set({ pr: "MERGED", runs: [{ name: "ci", conclusion: "failure" }] });
  const r = hook(root, { op: "refresh" }, gh.env);
  assert.deepEqual(r.entered, ["review"]);
  assert.equal(r.shell.status.next.find((t) => t.to === "deploy").holds, false);
});

test("tests that run only in CI: the PR is open and #build waits until a person ticks review-ready, which the model cannot", () => {
  const root = gitRepo("feat/ci");
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "dev"], { cwd: root, encoding: "utf8" }).status, 0);
  const gh = fakeGh();
  gh.set({ pr: "OPEN", runs: [{ name: "ci", conclusion: "success" }] });
  const stuck = hook(root, { op: "refresh" }, gh.env);
  assert.deepEqual(stuck.entered, []);
  assert.equal(stuck.shell.status.state.id, "build");
  assert.deepEqual([stuck.shell.status.sources["review-ready"], stuck.shell.status.vars["review-ready"]], ["human", false]);
  assert.match(hook(root, { op: "before", tool: "Bash", callId: "m1", input: { command: "gemflow mark review-ready" } }).refusal, /is for a person, not the model/);
  assert.match(hook(root, { op: "verb", name: "set", args: { "review-ready": true }, callId: "v1" }).text, /^refused: "review-ready" is evidence/);
  const marked = hook(root, { op: "mark", variable: "review-ready", checked: true });
  assert.deepEqual(marked.entered, ["review"]);
  assert.match(marked.context, /PR 已开。逐条处理 review 意见/);
  const cli = spawnSync(process.execPath, [CLI, "status"], { cwd: root, encoding: "utf8" });
  assert.match(cli.stdout, /#review/);
});

test("rework: a person's move from #review back to #build resets tests-pass and review-ready, so only a new green run goes forward again", () => {
  const root = gitRepo("feat/r");
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "dev"], { cwd: root, encoding: "utf8" }).status, 0);
  const gh = fakeGh();
  const ran = (callId, exitCode) => hook(root, { op: "after", tool: "Bash", callId, input: { command: "npm test" }, isError: exitCode !== 0, exitCode, gitOperation: false });
  ran("t1", 0);
  gh.set({ pr: "OPEN" });
  assert.equal(hook(root, { op: "refresh" }, gh.env).shell.status.state.id, "review");
  const back = hook(root, { op: "advance", to: "build" });
  assert.deepEqual([back.entered, back.shell.status.state.id], [["build"], "build"]);
  const vars = back.shell.status.vars;
  assert.deepEqual([vars["tests-pass"], vars["review-ready"], vars["pr-open"]], [false, false, true], "the transition cleared the last pass's evidence; git's facts stay");
  assert.equal(back.shell.status.next.find((t) => t.to === "review").holds, false);
  assert.equal(ran("t2", 1).shell.status.state.id, "build");
  const again = ran("t3", 0);
  assert.deepEqual([again.entered, again.shell.status.state.id], [["review"], "review"]);
});

// One row per spelling: which use the dictionary's fenced search finds in it — `prod` is deploy-prod
// (refused outside #release), `staging` is deploy-staging (refused outside #deploy), `none` is no use
// at all — and whether a key of the line is bound to that use, so a clean exit writes its evidence
// (a launcher the dictionary has no row for is fenced by the search, but credited to nothing). The
// dictionary reads the line, not what it does: a `--dry-run` deploy counts as the deploy it spells.
const SPELLINGS = [
  ["wrangler deploy --env production", "prod", true],
  ["wrangler deploy --minify --env production", "prod", true],
  ["wrangler deploy src/index.ts --env production", "prod", true],
  ["wrangler deploy -e production", "prod", true],
  ["wrangler deploy --env=production", "prod", true],
  ["wrangler deploy --env prod", "prod", true],
  ["npx wrangler deploy --env production", "prod", true],
  ["pnpm wrangler deploy --env production", "prod", true],
  ["bunx wrangler deploy --env production", "prod", true],
  ["npx wrangler deploy", "prod", true],
  ["wrangler deploy", "prod", true],
  ["wrangler deploy --minify", "prod", true],
  ["cd app && npx wrangler deploy", "prod", true],
  ["wrangler deploy --env production --dry-run", "prod", true],
  ["yarn wrangler deploy --env production", "prod", false],
  ["wrangler deploy --env staging", "staging", true],
  ["wrangler deploy -e staging", "staging", true],
  ["wrangler deploy --env=staging", "staging", true],
  ["wrangler deploy --minify --env staging", "staging", true],
  ["npx wrangler deploy --env staging", "staging", true],
  ["pnpm wrangler deploy --env staging", "staging", true],
  ["bunx wrangler deploy --env staging", "staging", true],
  ["yarn wrangler deploy --env staging", "staging", false],
  ["wrangler dev", "none", false],
  ["wrangler deployments list", "none", false],
  ["wrangler versions deploy --env production", "none", false],
  ["npx wrangler@3 deploy --env production", "none", false],
  ["npm run deploy:prod", "none", false],
];
const REFUSED = { prod: ["build", "deploy"], staging: ["build", "release"], none: [] };
const WRITES = { prod: ["release", "deployed-prod"], staging: ["deploy", "deployed-staging"] };

for (const [command, kind, bound] of SPELLINGS) {
  test(`deploy spelling (${kind}${bound ? "" : ", no key"}): ${command}`, () => {
    const s = sc(), d = dict();
    for (const state of ["build", "deploy", "release"]) {
      const refusal = refusalOf(s, d, state, command);
      if (REFUSED[kind].includes(state)) assert.match(refusal ?? "", new RegExp(`is deploy-${kind}, which is used only in`), `${state}: refused`);
      else assert.equal(refusal, undefined, `${state}: allowed`);
    }
    const writes = WRITES[kind];
    if (writes === undefined || !bound) for (const state of ["build", "deploy", "release"]) assert.deepEqual(commandSignals(s, d, state, { command, exitCode: 0 }), [], state);
    else assert.deepEqual(commandSignals(s, d, writes[0], { command, exitCode: 0 }), [{ id: writes[1], value: true }]);
  });
}

test("deploy spellings across a command line: a fenced pattern beside an allowed one is still refused; quoting and wrappers do not hide it", () => {
  const s = sc(), d = dict();
  for (const command of [
    "wrangler deploy --env staging && npx wrangler deploy",
    "npx wrangler deploy && wrangler deploy --env staging",
    "wrangler deploy --env production # --dry-run",
    "bash -c 'wrangler deploy --env production'",
    "(cd app && wrangler deploy --env production)",
    'wrangler deploy --env "production"',
    'wran"gler"  deploy --env production',
  ]) assert.match(refusalOf(s, d, "deploy", command) ?? "", /is deploy-prod/, command);
  assert.equal(refusalOf(s, d, "deploy", "wrangler deploy --env staging && wrangler deploy --env staging --dry-run"), undefined);
  assert.deepEqual(commandSignals(s, d, "deploy", { command: "npm test && npx wrangler deploy --env staging", exitCode: 0 }), [{ id: "deployed-staging", value: true }], "the test is #build's evidence, not #deploy's");
});
