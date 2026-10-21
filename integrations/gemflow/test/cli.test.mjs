import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition } from "../dist/core/snapshot.js";
import { readJournal, renderJournalHead, renderSnapshotBlock } from "../dist/core/journal.js";
import { flowDoc } from "./helpers/flow.mjs";
import { GITIGNORE } from "../dist/project-home.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
// A GEMFLOW_STATECHART in the developer's shell would pick the workflow for the verbs that open a project.
const { GEMFLOW_STATECHART: _unset, ...ENV } = process.env;
function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const ws = () => mkdtempSync(join(tmpdir(), "gemflow-"));
const USAGE = /usage: gemflow <check\|snapshot\|verify\|export\|init\|use\|migrate\|status\|mark\|unmark\|advance\|pause\|resume\|rollback\|run\|hook\|mcp>/;

test("no verb prints usage and exits 2", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.err, USAGE);
});

test("check: a clean workflow exits 0 and says so", () => {
  const r = run(["check", FIX]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^ok: no diagnostics$/m);
});

test("check: errors exit 1 with code-tagged lines; the dictionary beside the workflow is checked against it; an old flag is a usage error", () => {
  const dir = ws();
  writeFileSync(join(dir, "bad.geml"), '=== meta\nprofile = "geml-statechart/v1"\n===\n');
  const r = run(["check", "bad.geml"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /^error: flow-statechart: no `diagram \{format=geml-statechart\}` block: a workflow is one statechart \(line 1\)$/m);
  assert.match(r.err, /1 error\(s\), 0 warning\(s\)/);
  mkdirSync(join(dir, "w"));
  writeFileSync(join(dir, "w", "flow.geml"), flowDoc({ initial: "a", states: { a: { tools: ["test"] }, b: {} }, vars: { t: { default: false, source: { tool: "test" } } }, transitions: [{ from: "a", to: "b", guard: { properties: { t: { const: true } } } }] }));
  writeFileSync(join(dir, "w", "tools.geml"), "=== table {#tools}\n| tool | for | allow | deny | default | params |\n|---|---|---|---|---|---|\n| Read | | zz | | | |\n| Bash(npm test) | deploy | | | yes | |\n===\n");
  const d = run(["check", "w/flow.geml"], dir);
  assert.equal(d.code, 1);
  assert.match(d.err, /^error: flow-tools: tools\.geml: #tools row 1: allow names zz, which is not a state of the workflow/m);
  assert.match(d.err, /^warning: flow-source: tools\.geml: #tools row 2: the use `deploy` is declared by no state/m);
  for (const args of [["--host", "pi"], ["--tools", "read,grep"]]) {
    const w = run(["check", FIX, ...args]);
    assert.equal(w.code, 2, args.join(" "));
    assert.match(w.err, /^gemflow check: unknown option --/m);
  }
  rmSync(dir, { recursive: true, force: true });
});

function journalIn(dir) {
  const sc = loadStatechart(readFileSync(FIX, "utf8"), "refund.geml").statechart;
  const T0 = "2026-09-14T12:00:00Z";
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, { at: T0, call: "call_01" }).next;
  const s2 = applyTransition(sc, s1, "review", { at: T0, call: "call_02" }).next;
  const text = renderJournalHead({ item: "s1", workflow: FIX, workflowHash: sc.hash, created: T0 })
    + renderSnapshotBlock(s0) + renderSnapshotBlock(s1) + renderSnapshotBlock(s2);
  writeFileSync(join(dir, "journal.geml"), text);
  return { s2 };
}

test("snapshot prints the last revision, --json gives the object", () => {
  const dir = ws();
  const { s2 } = journalIn(dir);
  const r = run(["snapshot", "journal.geml"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^rev 2 · state #review · cause transition · from #intake/m);
  const j = run(["snapshot", "journal.geml", "--json"], dir);
  assert.deepEqual(JSON.parse(j.out), s2);
  rmSync(dir, { recursive: true, force: true });
});

test("verify: clean chain exits 0; a tampered one exits 1 listing the errors", () => {
  const dir = ws();
  journalIn(dir);
  assert.equal(run(["verify", "journal.geml", "--workflow", FIX], dir).code, 0);
  const p = join(dir, "journal.geml");
  writeFileSync(p, readFileSync(p, "utf8").replace('"amount":120', '"amount":1'));
  const r = run(["verify", "journal.geml"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /#rev-1: hash does not match its content/);
  rmSync(dir, { recursive: true, force: true });
});

test("a flag with no value is a usage error, not a silently weaker run", () => {
  const dir = ws();
  journalIn(dir);
  const v = run(["verify", "journal.geml", "--workflow"], dir);
  assert.equal(v.code, 2);
  assert.match(v.err, /--workflow needs a value/);
  rmSync(dir, { recursive: true, force: true });
});

test("export --to md renders a revision table with per-step diffs", () => {
  const dir = ws();
  journalIn(dir);
  const r = run(["export", "journal.geml", "--to", "md"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\| rev \| at \| cause \| state \| call \| changes \|$/m);
  assert.match(r.out, /\| 1 \| 2026-09-14T12:00:00Z \| patch \| #intake \| call_01 \| amount: 0 → 120; order: "" → "A-17" \|/);
  assert.match(r.out, /\| 2 \| .* \| transition \| #review \| call_02 \| — \|/);
  rmSync(dir, { recursive: true, force: true });
});

// ---- the project verbs: init, use, status, mark, unmark, advance, rollback ----------

const shipped = (name) => fileURLToPath(new URL(`../workflows/${name}/flow.geml`, import.meta.url));
const lf = (s) => s.replace(/\r\n/g, "\n");

/** A git repository on branch feat/x with one commit on main: a work item exists. */
function repo() {
  const d = ws();
  const git = (...a) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-qb", "feat/x");
  return d;
}

/** Write a workflow into a project's .geml/workflows and make it the active one. */
function installWorkflow(dir, name, text) {
  mkdirSync(join(dir, ".geml", "workflows", name), { recursive: true });
  writeFileSync(join(dir, ".geml", "workflows", name, "flow.geml"), text);
  writeFileSync(join(dir, ".geml", "gemflow.geml"), `=== meta\nprofile = "geml-statechart/v1"\nflow-workflow = "${name}"\n===\n`);
}

// a -> b by hand; b -> c on its own once a person ticks `ok`.
const ABC = flowDoc({
  title: "ABC", initial: "a",
  states: { a: { description: "Start here." }, b: { description: "Wait for the check." }, c: { description: "Done." } },
  vars: { ok: { default: false, source: "human" } },
  transitions: [{ from: "a", to: "b", note: "Begin." }, { from: "b", to: "c", guard: { properties: { ok: { const: true } } }, note: "Checked." }],
});

test("init writes a workflow as one file, its tools into the project's dictionary, records it as active, and keeps gemflow's own files out of git", () => {
  const d = repo();
  const r = run(["init", "--template", "coding"], d);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "wrote .geml/workflows/coding.geml (active)");
  // Under .geml/, not at the repo root: a project root is contested space.
  assert.equal(existsSync(join(d, "agent.geml")), false, "nothing lands at the root");
  const written = readFileSync(join(d, ".geml", "workflows", "coding.geml"), "utf8");
  assert.equal(written, lf(readFileSync(shipped("coding"), "utf8")), "a workflow with no guide is its flow file as it is");
  assert.ok(existsSync(join(d, ".geml", "tools.geml")), "the dictionary's rows are the project's");
  // What a repository gets: the claims the workflow is there to make.
  assert.match(written, /"explore"/);
  assert.match(written, /"implement"/);
  assert.match(readFileSync(join(d, ".geml", "project.geml"), "utf8"), /flow-workflow = "coding"/);
  assert.equal(readFileSync(join(d, ".geml", ".gitignore"), "utf8"), GITIGNORE);
  assert.equal(run(["check", ".geml/workflows/coding.geml"], d).code, 0);
  const again = run(["init", "--template", "coding"], d);
  assert.equal(again.code, 1, "refuses to overwrite");
  assert.match(again.err, /already exists/);
  rmSync(d, { recursive: true, force: true });
});

test("init is coding by default, activates the workflow it writes, and leaves an existing .gitignore alone", () => {
  const d = ws();
  mkdirSync(join(d, ".geml"));
  writeFileSync(join(d, ".geml", ".gitignore"), "mine\n");
  assert.equal(run(["init"], d).code, 0);
  assert.ok(existsSync(join(d, ".geml", "workflows", "coding.geml")));
  assert.equal(readFileSync(join(d, ".geml", ".gitignore"), "utf8"), "mine\n");
  // A second workflow becomes the active one unless --no-activate says otherwise.
  assert.equal(run(["init", "--template", "dev"], d).code, 0);
  assert.match(readFileSync(join(d, ".geml", "project.geml"), "utf8"), /flow-workflow = "dev"/);
  rmSync(d, { recursive: true, force: true });
});

test("init --no-activate writes the workflow and no config; init [dir] and an unknown template", () => {
  const d = ws();
  const r = run(["init", "sub", "--template", "coding", "--no-activate"], d);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "wrote sub/.geml/workflows/coding.geml");
  assert.equal(lf(readFileSync(join(d, "sub", ".geml", "workflows", "coding.geml"), "utf8")), lf(readFileSync(shipped("coding"), "utf8")));
  assert.equal(existsSync(join(d, "sub", ".geml", "project.geml")), false);
  assert.equal(readFileSync(join(d, "sub", ".geml", ".gitignore"), "utf8"), GITIGNORE);

  const bad = run(["init", "--template", "nonsense"], ws());
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown template "nonsense"; expected coding or dev or matter or video/);
  rmSync(d, { recursive: true, force: true });
});

test("status prints the stage; --json prints the workspace status", () => {
  const d = repo();
  run(["init", "--template", "coding"], d);
  const s = run(["status", "--json"], d);
  assert.equal(s.code, 0, s.err);
  const j = JSON.parse(s.out);
  assert.deepEqual(j.item, { kind: "item", id: "feat/x" });
  assert.equal(j.state.id, "explore");
  assert.deepEqual(j.sources, { "tests-pass": "tool:test" });
  assert.match(run(["status"], d).out, /^feat\/x · #explore\n  command = ""\n/);
  rmSync(d, { recursive: true, force: true });
});

test("status lists the variables with their sources and the next steps, one per line", () => {
  const d = repo();
  installWorkflow(d, "abc", ABC);
  run(["advance", "b"], d);
  const s = run(["status"], d);
  assert.equal(s.code, 0, s.err);
  assert.equal(s.out, "feat/x · #b\n  ok = false  (human)\n  → #c  on its own  when ok = true (missing ok)\n");
  run(["mark", "ok"], d);
  assert.equal(run(["status"], d).out, "feat/x · #c\n  ok = true  (human)\n");
  rmSync(d, { recursive: true, force: true });
});

test("status says why there is no work item; with no workflow it is one clean line and exit 1", () => {
  const d = repo();
  run(["init"], d);
  spawnSync("git", ["-C", d, "checkout", "-q", "main"]);
  const s = run(["status"], d);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /main · not tracked/);
  assert.equal(JSON.parse(run(["status", "--json"], d).out).item.kind, "inactive");

  const bare = ws();
  const none = run(["status"], bare);
  assert.equal(none.code, 1);
  assert.match(none.err, /^gemflow: no workflow here: run `gemflow init`$/m);
  assert.doesNotMatch(none.err, /\n\s+at /);
  rmSync(d, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

test("a journal that fails verification is one clean line and exit 1, not a stack trace", () => {
  const d = repo();
  run(["init"], d);
  assert.equal(run(["status"], d).code, 0);
  const p = join(d, ".geml", "journals", "feat", "x.geml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/"hash":"sha256:[0-9a-f]+"/, '"hash":"sha256:0000"'));
  for (const args of [["status"], ["mark", "x"], ["advance", "plan"], ["rollback"]]) {
    const r = run(args, d);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /^gemflow: /m, args.join(" "));
    assert.doesNotMatch(r.err, /\n\s+at /, args.join(" "));
  }
  rmSync(d, { recursive: true, force: true });
});

test("advance moves the workflow as a person; mark takes only a variable whose source is a person", () => {
  const d = repo();
  installWorkflow(d, "refund", readFileSync(FIX, "utf8"));
  const a = run(["advance", "nowhere"], d);
  assert.equal(a.code, 1);
  assert.match(a.err, /no transition intake→nowhere/);
  const m = run(["mark", "nope"], d);
  assert.equal(m.code, 1);
  assert.match(m.err, /no variable "nope" in the workflow/);
  const model = run(["mark", "order"], d);
  assert.equal(model.code, 1);
  assert.match(model.err, /order is the model's to set, not a person's to tick/);
  assert.equal(run(["mark"], d).code, 2, "mark needs a variable");
  assert.equal(run(["unmark"], d).code, 2, "unmark needs a variable");
  assert.equal(run(["advance"], d).code, 2, "advance needs a state");
  rmSync(d, { recursive: true, force: true });
});

test("advance, mark and rollback report the states they entered, and the journal says who did it", () => {
  const d = repo();
  installWorkflow(d, "abc", ABC);
  const adv = run(["advance", "b"], d);
  assert.equal(adv.code, 0, adv.err);
  assert.equal(adv.out.trim(), "entered #b");
  const mark = run(["mark", "ok"], d);
  assert.equal(mark.code, 0, mark.err);
  assert.equal(mark.out.trim(), "marked ok · entered #c", "the machine-judged transition followed");
  assert.equal(JSON.parse(run(["status", "--json"], d).out).state.id, "c");
  const un = run(["unmark", "ok"], d);
  assert.equal(un.code, 0, un.err);
  assert.equal(un.out.trim(), "unmarked ok");
  const back = run(["rollback", "1"], d);
  assert.equal(back.code, 0, back.err);
  assert.equal(back.out.trim(), "rev 5 restores rev 1 · state #b");
  const journal = readJournal(readFileSync(join(d, ".geml", "journals", "feat", "x.geml"), "utf8"));
  assert.deepEqual(journal.snapshots.map((s) => [s.state, s.by ?? "", s.signal ?? ""]), [
    ["a", "", ""], ["b", "human", ""], ["b", "signal", "ok"], ["c", "signal", "ok"], ["c", "signal", "ok"], ["b", "human", ""],
  ]);
  // The context document follows the stage.
  assert.match(readFileSync(join(d, ".geml", "context.geml"), "utf8"), /"state":"b"/);
  const bad = run(["advance", "a"], d);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^gemflow: no transition b→a$/m);
  assert.equal(run(["rollback", "x"], d).code, 2);
  rmSync(d, { recursive: true, force: true });
});

test("use switches the active workflow", () => {
  const d = repo();
  run(["init", "--template", "coding"], d);
  run(["init", "--template", "dev", "--no-activate"], d);
  assert.match(readFileSync(join(d, ".geml", "project.geml"), "utf8"), /flow-workflow = "coding"/);
  const u = run(["use", "dev"], d);
  assert.equal(u.code, 0, u.err);
  assert.match(readFileSync(join(d, ".geml", "project.geml"), "utf8"), /flow-workflow = "dev"/);
  assert.match(run(["status"], d).out, /feat\/x · #build/);
  const nope = run(["use", "nope"], d);
  assert.equal(nope.code, 1);
  assert.match(nope.err, /^gemflow: no workflow "nope" in \.geml\/workflows \(have: coding, dev\)$/m);
  // A name is a workflow in .geml/workflows, not a path out of it.
  assert.equal(run(["use", "../workflows/coding"], d).code, 1);
  assert.equal(run(["use"], d).code, 2);
  assert.match(readFileSync(join(d, ".geml", "project.geml"), "utf8"), /flow-workflow = "dev"/);
  rmSync(d, { recursive: true, force: true });
});

test("use changes the default only: a work item with a journal goes on under its own workflow, a new one starts under the default", () => {
  const d = repo();
  run(["init", "--template", "coding"], d);
  assert.equal(run(["status"], d).code, 0, "the journal of feat/x is started under coding");
  run(["init", "--template", "dev", "--no-activate"], d);
  const u = run(["use", "dev"], d);
  assert.equal(u.code, 0, u.err);
  assert.equal(u.out.trim(), "default workflow: dev (a work item with a journal keeps its own)");
  assert.equal(u.err, "", "nothing to warn about");
  const s = run(["status"], d);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /^feat\/x · #explore · workflow coding \(default dev\)$/m);
  spawnSync("git", ["-C", d, "checkout", "-qb", "feat/y"]);
  assert.match(run(["status"], d).out, /^feat\/y · #build$/m, "a new work item starts under the default");
  rmSync(d, { recursive: true, force: true });
});

test("check resolves a state's prompt: ./ from the workflow, the rest from the project root, never outside it", () => {
  const outer = ws();
  const d = join(outer, "proj");
  const dev = join(d, ".geml", "workflows", "dev");
  mkdirSync(join(d, ".geml", "workflows"), { recursive: true });
  cpSync(fileURLToPath(new URL("./fixtures/ws-dev/", import.meta.url)), dev, { recursive: true });
  mkdirSync(join(d, "docs"));
  writeFileSync(join(d, "docs", "rules.md"), "# Rules\n\n## Build\n\nRun the tests.\n");
  writeFileSync(join(outer, "secret.geml"), "=== data {#x}\nhidden\n===\n");
  const flow = join(dev, "flow.geml");
  const base = readFileSync(flow, "utf8");
  const withRef = (ref) => writeFileSync(flow, base.replace('"prompt": "./guide.geml#build"', `"prompt": ${JSON.stringify(ref)}`));
  const rel = ".geml/workflows/dev/flow.geml";

  const ok = run(["check", rel], d);
  assert.equal(ok.code, 0, ok.err);
  // The project root is where .geml/workflows/<name>/flow.geml says it is, wherever the shell stands.
  withRef("docs/rules.md#build");
  const fromDocs = run(["check", join(flow)], join(d, "docs"));
  assert.equal(fromDocs.code, 0, fromDocs.err);

  for (const [ref, why] of [
    ["./guide.geml#nope", /`prompt` \.\/guide\.geml#nope does not resolve/],
    ["./no-such.geml#build", /`prompt` \.\/no-such\.geml#build does not resolve/],
    ["docs/rules.md#absent", /`prompt` docs\/rules\.md#absent does not resolve/],
    ["docs/missing.md#build", /does not resolve/],
    ["./../../../../secret.geml#x", /`prompt` \.\/\.\.\/\.\.\/\.\.\/\.\.\/secret\.geml#x could not be resolved: .*outside the project/],
    ["../secret.geml#x", /`prompt` \.\.\/secret\.geml#x could not be resolved: .*outside the project/],
  ]) {
    withRef(ref);
    const r = run(["check", rel], d);
    assert.equal(r.code, 1, ref);
    assert.match(r.err, /^error: flow-attr: state build: /m, ref);
    assert.match(r.err, why, ref);
  }
  rmSync(outer, { recursive: true, force: true });
});

test("check on a workflow outside .geml/workflows resolves root-relative prompts from the working directory", () => {
  const d = ws();
  mkdirSync(join(d, "docs"));
  writeFileSync(join(d, "docs", "rules.md"), "# Rules\n\n## Build\n\nRun the tests.\n");
  const flow = (ref) => flowDoc({ initial: "a", states: { a: { prompt: ref } } });
  writeFileSync(join(d, "flow.geml"), flow("docs/rules.md#build"));
  assert.equal(run(["check", "flow.geml"], d).code, 0);
  writeFileSync(join(d, "flow.geml"), flow("docs/rules.md#gone"));
  const r = run(["check", "flow.geml"], d);
  assert.equal(r.code, 1);
  assert.match(r.err, /flow-attr: state a: `prompt` docs\/rules\.md#gone does not resolve/);
  rmSync(d, { recursive: true, force: true });
});

test("a missing file is one clean line and exit 1, not a stack trace", () => {
  for (const verb of ["check", "snapshot", "verify"]) {
    const r = run([verb, "no-such-file.geml"]);
    assert.equal(r.code, 1, `${verb}: exit code`);
    assert.match(r.err, /^gemflow: cannot read .*no-such-file\.geml \(ENOENT\)$/m, `${verb}: message`);
    assert.doesNotMatch(r.err, /\n\s+at /, `${verb}: no stack trace`);
  }
  const e = run(["export", "no-such-file.geml", "--to", "md"]);
  assert.equal(e.code, 1);
  assert.match(e.err, /cannot read .*no-such-file\.geml \(ENOENT\)/);
});

test("run without a task is a usage error, and the verb is listed", () => {
  const r = run(["run"]);
  assert.equal(r.code, 2);
  assert.match(r.err, USAGE);
  assert.match(r.err, /run \[--profile name\] <task>/);
});

test("pause holds the work item: evidence lands, nothing moves; resume lets it go and takes the edge that holds; the model cannot run either", () => {
  const d = repo();
  installWorkflow(d, "abc", ABC);
  assert.equal(run(["advance", "b"], d).code, 0);
  const held = run(["pause"], d);
  assert.equal(held.code, 0, held.err);
  assert.equal(held.out.trim(), "paused");
  assert.match(run(["pause"], d).err, /^gemflow: the work item is already paused$/m);
  assert.equal(run(["status"], d).out.includes("paused"), true);
  const mark = run(["mark", "ok"], d);
  assert.equal(mark.out.trim(), "marked ok", "the machine-judged transition waits");
  assert.match(run(["advance", "c"], d).err, /^gemflow: the work item is paused/m);
  const resumed = run(["resume"], d);
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(resumed.out.trim(), "resumed · entered #c");
  assert.match(run(["resume"], d).err, /^gemflow: the work item is not paused$/m);
  assert.equal(run(["pause", "x"], d).code, 2, "pause takes no argument");
  const journal = readJournal(readFileSync(join(d, ".geml", "journals", "feat", "x.geml"), "utf8"));
  assert.deepEqual(journal.snapshots.map((s) => [s.cause, s.by ?? ""]).slice(1), [["transition", "human"], ["pause", "human"], ["patch", "signal"], ["resume", "human"], ["transition", "human"]]);
  rmSync(d, { recursive: true, force: true });
});
