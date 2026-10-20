import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { decide, keysOf } from "../dist/core/dictionary.js";
import { readDictionary } from "../dist/core/dictionary-file.js";
import { scopeIn } from "../dist/core/policy.js";
import { CLAUDE_CODE_TOOLS, PI_TOOLS } from "../dist/core/host-tools.js";
import { validate } from "../dist/core/schema.js";
import { blockText } from "../dist/core/blocks.js";
import { readJournal, verifyJournal } from "../dist/core/journal.js";
import { BUNDLE, gitRepo, hook } from "./helpers/repo.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FLOW = fileURLToPath(new URL("../workflows/matter/flow.geml", import.meta.url));
const GUIDE = readFileSync(new URL("../workflows/matter/guide.geml", import.meta.url), "utf8");
const sc = () => loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml").statechart;
const dict = () => readDictionary(readFileSync(new URL("../workflows/matter/tools.geml", import.meta.url), "utf8"), sc());
/** The dictionary's decision on one call in `state`, keyed as the host keys it. */
const judged = (state, tool, input, tools = CLAUDE_CODE_TOOLS) => decide(dict(), scopeIn(sc(), state), keysOf(tool, input, tools.run, tools.write));

test("the matter workflow and its dictionary check with no diagnostics, and every prompt resolves to a guide block", () => {
  const r = spawnSync(process.execPath, [CLI, "check", FLOW], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^ok: no diagnostics$/m);
  const resolveRef = (ref) => ref.startsWith("./guide.geml#") && blockText(GUIDE, ref.slice("./guide.geml#".length)) !== undefined;
  assert.deepEqual(loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml", { resolveRef }).diagnostics, []);
  assert.deepEqual(dict().diagnostics, []);
});

test("a matter is a file under .geml/matters/; six states, a person's buttons wherever the work waits on one, and editing only in #doing", () => {
  const s = sc();
  assert.deepEqual(s.unit, { kind: "file", glob: ".geml/matters/*.geml", stateKey: "state" });
  assert.deepEqual([...s.states.values()].map((x) => [x.id, x.uses]), [
    ["noted", ["note"]], ["deciding", ["note"]], ["doing", ["note", "edit", "check"]], ["checking", ["note"]], ["parked", ["note"]], ["done", []],
  ]);
  assert.deepEqual([...s.vars.values()].map((v) => [v.name, v.source]), [["check-pass", { kind: "tool", use: "check" }], ["accept-now", { kind: "human" }]]);
  assert.deepEqual(s.transitions.map((t) => [t.name, t.judge, t.approval]), [
    ["noted→deciding", "model", false], ["noted→doing", "none", true], ["noted→parked", "none", true],
    ["deciding→doing", "none", true], ["deciding→noted", "none", true], ["deciding→parked", "none", true],
    ["doing→checking", "machine", false], ["checking→done", "none", true], ["checking→doing", "none", true], ["parked→noted", "none", true],
  ]);
  assert.deepEqual(s.transitions.filter((t) => t.approval).map((t) => [t.name, t.label]), [
    ["noted→doing", "直接做"], ["noted→parked", "先放着"], ["deciding→doing", "按方案做"], ["deciding→noted", "换个方向"], ["deciding→parked", "先放着"],
    ["checking→done", "通过"], ["checking→doing", "要改"], ["parked→noted", "重新打开"],
  ], "every way out a person takes has its button's words");
  const guard = s.transitions.find((t) => t.name === "doing→checking").guard.schema;
  const holds = (vars) => validate(guard, { "check-pass": false, "accept-now": false, ...vars }).length === 0;
  assert.deepEqual([holds({}), holds({ "check-pass": true }), holds({ "accept-now": true })], [false, true, true], "a passing check, or a person's direct acceptance");
});

test("writing a matter is note everywhere; writing anything else is edit, and only #doing declares it — on Claude Code and on pi", () => {
  for (const state of ["noted", "deciding", "checking", "parked"]) {
    assert.deepEqual(judged(state, "Edit", { file_path: "/w/app/.geml/matters/band.geml" }), { kind: "allow", uses: ["note"], unknown: [] }, state);
    assert.deepEqual(judged(state, "edit", { path: ".geml/matters/band.geml" }, PI_TOOLS), { kind: "allow", uses: ["note"], unknown: [] }, `${state} on pi`);
    assert.match(judged(state, "Write", { file_path: "C:\\w\\app\\src\\a.ts" }).reasons[0], /^Write is edit, which is used only in #doing; the workflow is in #/, state);
    assert.match(judged(state, "write", { path: "src/a.ts" }, PI_TOOLS).reasons[0], /^write is edit, which is used only in #doing/, `${state} on pi`);
  }
  assert.deepEqual(judged("doing", "Edit", { file_path: "/w/app/src/a.ts" }), { kind: "allow", uses: ["edit"], unknown: [] });
  assert.deepEqual(judged("doing", "Bash", { command: "npm test" }), { kind: "allow", uses: ["check"], unknown: [] });
  assert.deepEqual(judged("noted", "Bash", { command: "rg -n band src" }), { kind: "allow", uses: [], unknown: ["Bash(rg -n band src)"] }, "a command no row takes runs, unasked");
});

test("end to end through the bridge: a matter is written, decided by a person, done, checked and accepted", () => {
  const root = gitRepo();
  const init = spawnSync(process.execPath, [BUNDLE, "init", "--template", "matter"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  mkdirSync(join(root, ".geml", "matters"));
  const matter = ".geml/matters/band-entry.geml";
  writeFileSync(join(root, matter), '=== meta\ntitle = "状态带随时打开看板的入口"\n===\n\n# 现象 {#symptom}\n\n看板只能从「待处理」进去。\n');
  const at = { lastFile: matter };
  const opened = hook(root, { op: "status", ...at });
  assert.deepEqual([opened.shell.status.item, opened.shell.status.state.id], [{ kind: "item", id: ".geml/matters/band-entry" }, "noted"]);
  const edit = (file, callId) => hook(root, { op: "before", tool: "Edit", callId, input: { file_path: join(root, file) }, ...at });
  assert.equal(edit(matter, "e1").refusal, undefined, "the matter itself: note");
  assert.match(edit("src/band.ts", "e2").refusal, /^Edit is edit, which is used only in #doing; the workflow is in #noted/);

  assert.equal(hook(root, { op: "verb", name: "move", args: { to: "deciding" }, callId: "v1", ...at }).isError, undefined);
  assert.equal(hook(root, { op: "verb", name: "move", args: { to: "doing" }, callId: "v2", ...at }).text.startsWith("refused: deciding→doing needs a person"), true);
  assert.deepEqual(hook(root, { op: "advance", to: "doing", ...at }).entered, ["doing"]);
  const file = () => readFileSync(join(root, matter), "utf8");
  assert.ok(file().startsWith('=== meta\ntitle = "状态带随时打开看板的入口"\nstate = "doing"\n===\n'), "the state goes into the matter's meta");
  assert.equal(edit("src/band.ts", "e3").refusal, undefined);
  const checked = hook(root, { op: "after", tool: "Bash", callId: "t1", input: { command: "npm test" }, isError: false, exitCode: 0, gitOperation: false, ...at });
  assert.deepEqual(checked.entered, ["checking"]);
  assert.ok(file().includes('\nstate = "checking"\n'));
  assert.equal(hook(root, { op: "status", ...at }).shell.status.vars["check-pass"], true, "writing the state back is no change of the matter: the check stays");
  assert.match(edit("src/band.ts", "e4").refusal, /used only in #doing; the workflow is in #checking/);
  assert.deepEqual(hook(root, { op: "advance", to: "done", ...at }).entered, ["done"]);
  assert.ok(file().includes('\nstate = "done"\n'));
  assert.ok(file().endsWith("# 现象 {#symptom}\n\n看板只能从「待处理」进去。\n"), "the rest of the matter as it was");
});

test("the board names every matter by its title and carries the ways out waiting on the person; one is taken on its own file", () => {
  const root = gitRepo();
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "matter"], { cwd: root, encoding: "utf8" }).status, 0);
  mkdirSync(join(root, ".geml", "matters"));
  const band = { lastFile: ".geml/matters/band.geml" };
  const pi = { lastFile: ".geml/matters/pi.geml" };
  writeFileSync(join(root, band.lastFile), '=== meta\ntitle = "状态带随时打开看板的入口"\n===\n');
  writeFileSync(join(root, pi.lastFile), '=== meta\ntitle = "pi 和 DSH 也记下写过的文件吗"\n===\n\n# 现象 {#symptom}\n\n- 现在只有 Claude Code 和 Codex 记。\n');
  hook(root, { op: "status", ...pi });
  hook(root, { op: "status", ...band });
  hook(root, { op: "advance", to: "doing", ...band });
  const items = () => hook(root, { op: "board", ...band }).board.items.map((i) => [i.id, i.title, i.state, (i.asks ?? []).map((a) => [a.to, a.label, a.final])]);
  assert.deepEqual(items(), [
    [".geml/matters/band", "状态带随时打开看板的入口", "doing", []],
    [".geml/matters/pi", "pi 和 DSH 也记下写过的文件吗", "noted", []],
  ], "a matter just noted is the model's to look into: nothing waits on the person yet");
  assert.equal(hook(root, { op: "verb", name: "move", args: { to: "deciding" }, callId: "v1", ...pi }).isError, undefined);
  assert.deepEqual(items()[1], [".geml/matters/pi", "pi 和 DSH 也记下写过的文件吗", "deciding", [["doing", "按方案做", false], ["noted", "换个方向", false], ["parked", "先放着", false]]]);
  assert.equal(hook(root, { op: "board", ...band }).board.items[1].gist, "现在只有 Claude Code 和 Codex 记。", "without a result, the text's first line; the heading and the list mark left out");
  assert.deepEqual(hook(root, { op: "advance", to: "parked", ...pi }).entered, ["parked"], "a press on another matter's card names its file");
  assert.deepEqual(items()[1], [".geml/matters/pi", "pi 和 DSH 也记下写过的文件吗", "parked", []], "put aside, it only reopens: nothing waits");
  assert.equal(hook(root, { op: "status", ...band }).shell.status.item.id, ".geml/matters/band", "the current matter stays the shell's");
});

test("the files a matter's work writes go into its journal, once per file per stage entry; the matter file itself does not", () => {
  const root = gitRepo();
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "matter"], { cwd: root, encoding: "utf8" }).status, 0);
  mkdirSync(join(root, ".geml", "matters"));
  mkdirSync(join(root, "src"));
  const at = { lastFile: ".geml/matters/band.geml" };
  writeFileSync(join(root, at.lastFile), '=== meta\ntitle = "band"\n===\n');
  hook(root, { op: "status", ...at });
  hook(root, { op: "advance", to: "doing", ...at });
  const wrote = (file, callId) => {
    writeFileSync(join(root, file), "x\n");
    hook(root, { op: "after", tool: "Edit", callId, input: { file_path: join(root, file) }, isError: false, gitOperation: false, wrotePath: join(root, file), ...at });
  };
  wrote("src/band.ts", "e1");
  wrote("src/band.ts", "e2");
  wrote("src/board.ts", "e3");
  wrote(at.lastFile, "e4");
  hook(root, { op: "mark", variable: "accept-now", checked: true, ...at });
  hook(root, { op: "advance", to: "doing", ...at });
  wrote("src/band.ts", "e5");
  const journal = readJournal(readFileSync(join(root, ".geml", "journals", ".geml", "matters", "band.geml"), "utf8"));
  assert.deepEqual(journal.writes.map((w) => [w.n, w.tool, w.call, w.path]), [[1, "Edit", "e1", "src/band.ts"], [2, "Edit", "e3", "src/board.ts"], [3, "Edit", "e5", "src/band.ts"]]);
  assert.deepEqual(verifyJournal(journal), []);
});

test("the board shows what a matter's work made: its result section, the files it wrote, and the commits of its window that touched them", () => {
  const root = gitRepo();
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "matter"], { cwd: root, encoding: "utf8" }).status, 0);
  mkdirSync(join(root, ".geml", "matters"));
  mkdirSync(join(root, "src"));
  const at = { lastFile: ".geml/matters/band.geml" };
  writeFileSync(join(root, at.lastFile), '=== meta\ntitle = "band"\n===\n\n# 现象 {#symptom}\n\n看板只能从「待处理」进去。\n\n# 结果 {#result}\n\n状态带加了看板按钮。\n\n- 检查通过\n');
  hook(root, { op: "status", ...at });
  hook(root, { op: "advance", to: "doing", ...at });
  writeFileSync(join(root, "src", "band.ts"), "x\n");
  hook(root, { op: "after", tool: "Write", callId: "w1", input: { file_path: join(root, "src", "band.ts") }, isError: false, gitOperation: false, wrotePath: join(root, "src", "band.ts"), ...at });
  const git = (...a) => assert.equal(spawnSync("git", ["-C", root, ...a], { encoding: "utf8" }).status, 0);
  git("add", "src/band.ts"); git("commit", "-qm", "feat: band entry");
  writeFileSync(join(root, "README.md"), "r\n");
  git("add", "README.md"); git("commit", "-qm", "docs: unrelated");
  const board = hook(root, { op: "board", ...at }).board;
  assert.equal(board.unit, "file");
  assert.equal(board.items[0].gist, "状态带加了看板按钮。", "the gist is the result's first line");
  const p = board.artifacts;
  assert.deepEqual([p.item, p.file, p.result], [".geml/matters/band", ".geml/matters/band.geml", "状态带加了看板按钮。\n\n- 检查通过"]);
  assert.deepEqual(p.written.map((w) => [w.path, w.tool]), [["src/band.ts", "Write"]]);
  // git keeps whole seconds: the repository's first commit may share the journal's first second.
  assert.deepEqual(p.commits.filter((c) => c.subject !== "init").map((c) => [c.subject, c.files, c.ours]), [["docs: unrelated", ["README.md"], false], ["feat: band entry", ["src/band.ts"], true]]);
});

test("on a machine the journal never reached, a matter starts where its file says it stands; a state the workflow lacks starts it at #noted", () => {
  const root = gitRepo();
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "matter"], { cwd: root, encoding: "utf8" }).status, 0);
  mkdirSync(join(root, ".geml", "matters"));
  const write = (name, state) => writeFileSync(join(root, ".geml", "matters", `${name}.geml`), `=== meta\ntitle = "${name}"\nstate = "${state}"\n===\n`);
  write("carried", "deciding");
  write("stale", "nowhere");
  const carried = hook(root, { op: "status", lastFile: ".geml/matters/carried.geml" });
  assert.equal(carried.shell.status.state.id, "deciding");
  hook(root, { op: "refresh", lastFile: ".geml/matters/carried.geml" });
  const journal = join(root, ".geml", "journals", ".geml", "matters", "carried.geml");
  const verified = spawnSync(process.execPath, [BUNDLE, "verify", journal], { cwd: root, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.equal(hook(root, { op: "status", lastFile: ".geml/matters/stale.geml" }).shell.status.state.id, "noted");
});

test("a person's direct acceptance takes a matter to #checking without a check; sending it back clears both", () => {
  const root = gitRepo();
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "matter"], { cwd: root, encoding: "utf8" }).status, 0);
  mkdirSync(join(root, ".geml", "matters"));
  const at = { lastFile: ".geml/matters/copy.geml" };
  writeFileSync(join(root, at.lastFile), '=== meta\ntitle = "首页文案"\n===\n');
  hook(root, { op: "status", ...at });
  assert.deepEqual(hook(root, { op: "advance", to: "doing", ...at }).entered, ["doing"], "a small matter: straight to doing");
  hook(root, { op: "mark", variable: "accept-now", checked: true, ...at });
  assert.equal(hook(root, { op: "status", ...at }).shell.status.state.id, "checking");
  assert.deepEqual(hook(root, { op: "advance", to: "doing", ...at }).entered, ["doing"]);
  const vars = hook(root, { op: "status", ...at }).shell.status.vars;
  assert.deepEqual([vars["check-pass"], vars["accept-now"]], [false, false]);
});
