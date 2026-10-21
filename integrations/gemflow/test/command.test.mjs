import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_HINT, COMMAND_USAGE, addText, boardFailure, boardText, commandText, parseCommand, statusText, usageText } from "../dist/hosts/claude-code/command.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const status = {
  workflow: { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程" },
  item: { kind: "item", id: "feat/x" },
  state: { id: "review", title: "评审", rev: 7, uses: ["edit", "test"] },
  vars: { "tests-pass": true, "pr-merged": false, "ci-pass": false },
  sources: { "tests-pass": "tool:test", "pr-merged": "git:pr-merged", "ci-pass": "git:ci-success" },
  next: [
    { name: "review→build", to: "build", judge: "model", approval: false, guard: "review 要求改动", reads: [], missing: [], holds: true, note: "" },
    { name: "review→deploy", to: "deploy", judge: "machine", approval: false, guard: "pr-merged = true and ci-pass = true", reads: ["pr-merged", "ci-pass"], missing: ["pr-merged", "ci-pass"], holds: false, note: "" },
  ],
  refusals: 1, paused: false, gh: { available: false, reason: "gh is not installed" },
};
const shell = { status, policy: { relevant: ["pr-merged", "ci-pass"] }, contextKey: "feat/x@7" };

test("the argument string becomes one intent", () => {
  assert.deepEqual(parseCommand(""), { kind: "status" });
  assert.deepEqual(parseCommand("  board "), { kind: "board" });
  assert.deepEqual(parseCommand("use dev"), { kind: "use", workflow: "dev" });
  assert.deepEqual(parseCommand("add"), { kind: "add" });
  assert.deepEqual(parseCommand("add dev"), { kind: "add", workflow: "dev" });
  assert.deepEqual(parseCommand("help"), { kind: "help" });
  assert.deepEqual(parseCommand("use"), { kind: "help", reason: "不认识的用法：/gemflow use" });
  assert.deepEqual(parseCommand("board items"), { kind: "board", tab: "items" });
  assert.deepEqual(parseCommand("board pending"), { kind: "help", reason: "不认识的用法：/gemflow board pending" }, "the pending tab is the work items tab's top group now");
  assert.deepEqual(parseCommand("board sessions"), { kind: "board", tab: "sessions" });
  assert.deepEqual(parseCommand("board nope"), { kind: "help", reason: "不认识的用法：/gemflow board nope" });
  assert.deepEqual(parseCommand("pause"), { kind: "pause" });
  assert.deepEqual(parseCommand("resume"), { kind: "resume" });
  assert.equal(COMMAND_HINT, "[board [标签] | pause | resume | use <流程> | add [流程]]");
  assert.match(COMMAND_USAGE, /\/gemflow pause/);
});

test("/gemflow prints where the work stands: the stage with its uses, each variable with its source, the ways out", () => {
  assert.equal(statusText(shell), [
    "流程 dev（开发流程）",
    "工作项 feat/x · 阶段 #review 评审 · rev 7",
    "工具：edit test",
    "变量：tests-pass ✓（tool:test） · pr-merged ✗（git:pr-merged） · ci-pass ✗（git:ci-success）",
    "下一步：→ #build 手动；→ #deploy 自动 · 待 pr-merged ci-pass",
    "git 证据不可用：gh is not installed",
    "1 次拒绝",
  ].join("\n"));
  assert.equal(statusText(shell, wordsFor("en")), [
    "workflow dev (开发流程)",
    "work item feat/x · stage #review 评审 · rev 7",
    "tools: edit test",
    "variables: tests-pass ✓（tool:test） · pr-merged ✗（git:pr-merged） · ci-pass ✗（git:ci-success）",
    "next: → #build manual; → #deploy auto · waiting for pr-merged ci-pass",
    "git evidence unavailable: gh is not installed",
    "1 refusals",
  ].join("\n"), "the words follow the language; the workflow's own title stays");
  assert.equal(statusText({ status: null, policy: null, contextKey: null, problem: { text: "no workflow here: run `gemflow init`", quiet: true } }), "这个项目还没有流程。用 /gemflow add 选一个内置流程。");
  assert.equal(statusText({ status: null, policy: null, contextKey: null, problem: { text: "no workflow here", quiet: true }, suggest: { workflow: "coding", by: "code", file: "Cargo.toml" } }), "这个项目还没有流程。建议 coding（Cargo.toml）：/gemflow add coding；/gemflow add 列出全部。");
  assert.equal(statusText({ ...shell, status: { ...status, item: { kind: "inactive", reason: "main · not tracked (work items are branches)" } } }), "流程 dev（开发流程）\nmain · not tracked (work items are branches)");
  const bare = { ...status, state: { id: "done", title: "done", rev: 9, uses: [] }, vars: {}, sources: {}, next: [], gh: { available: true } };
  assert.equal(statusText({ ...shell, status: bare }).split("\n").slice(2).join("\n"), "工具：没有声明用途\n变量：无\n下一步：无（终点）\n1 次拒绝");
});

test("the + menu lists, then copies; use names the active workflow", () => {
  assert.equal(addText({ v: 1, ok: true, shell, workflows: ["coding", "dev", "matter"], installed: ["dev"] }), "内置流程：coding、dev（已在本项目）、matter\n用 /gemflow add <流程> 把一个写入 .geml/workflows/。");
  assert.equal(addText({ v: 1, ok: true, shell, added: { name: "dev", activated: true } }), "已把内置流程 dev 写入 .geml/workflows/dev.geml，并设为当前流程。");
  assert.equal(addText({ v: 1, ok: true, shell, added: { name: "matter", activated: false } }), "已把内置流程 matter 写入 .geml/workflows/matter.geml。用 /gemflow use matter 让它成为当前流程。");
  assert.match(commandText({ kind: "use", workflow: "dev" }, { v: 1, ok: true, shell }, null), /^默认流程：dev\n流程 dev/);
});

test("pause and resume answer with the stage after them", () => {
  const held = { ...shell, status: { ...status, paused: true } };
  assert.match(commandText({ kind: "pause" }, { v: 1, ok: true, shell: held }, null), /^已暂停。\n流程 dev（开发流程）\n工作项 feat\/x · 阶段 #review 评审 · rev 7 · 已暂停\n/);
  assert.match(commandText({ kind: "resume" }, { v: 1, ok: true, shell, entered: ["deploy"] }, null), /^已继续 · 进了 #deploy\n/);
  assert.match(commandText({ kind: "resume" }, { v: 1, ok: true, shell, entered: [] }, null), /^已继续。\n/);
  assert.equal(commandText({ kind: "pause" }, { v: 1, ok: false, error: "the work item is already paused" }, null), "gemflow：the work item is already paused");
});

test("use names the new default; a work item on another workflow than the default names both", () => {
  assert.equal(commandText({ kind: "use", workflow: "matter" }, { v: 1, ok: true, shell }, null), `默认流程：matter\n${statusText(shell)}`);
  const kept = { ...shell, status: { ...status, workflow: { ...status.workflow, default: "matter" } } };
  assert.match(statusText(kept), /^流程 dev（开发流程）· 默认流程 matter\n工作项 feat\/x/);
});

test("help, a bridge that did not answer, an error answer, the board", () => {
  assert.equal(commandText({ kind: "help" }, undefined, null), COMMAND_USAGE);
  assert.match(usageText(wordsFor("en")), /^\/gemflow {17}the work item, the stage, its variables and the next step\n/);
  assert.equal(commandText({ kind: "status" }, undefined, null, wordsFor("ja")), "gemflow：ブリッジが使えません");
  assert.equal(commandText({ kind: "help", reason: "不认识的用法：/gemflow x" }, undefined, null), `不认识的用法：/gemflow x\n${COMMAND_USAGE}`);
  assert.equal(commandText({ kind: "status" }, undefined, "gemflow：找不到 node — 请安装 Node ≥ 22"), "gemflow：找不到 node — 请安装 Node ≥ 22");
  assert.equal(commandText({ kind: "use", workflow: "nope" }, { v: 1, ok: false, error: "no workflow .geml/workflows/nope/flow.geml" }, null), "gemflow：no workflow .geml/workflows/nope/flow.geml");
  assert.equal(boardText(undefined), "已打开 Gemflow 看板。");
  assert.equal(boardText("terminal is 100 columns; 144 needed"), "看板已打开，终端够宽时显示（terminal is 100 columns; 144 needed）。");
});

test("why the board did not load: no answer, an error answer, a project with no workflow or a broken one", () => {
  const board = { states: [], transitions: [], fences: [], tools: [], backlog: null, items: [], timeline: [] };
  assert.equal(boardFailure({ v: 1, ok: true, shell, board }, null), undefined);
  assert.equal(boardFailure(undefined, "gemflow：桥接没有应答（timed out after 45000 ms）"), "gemflow：桥接没有应答（timed out after 45000 ms）");
  assert.equal(boardFailure(undefined, null), "gemflow：桥接不可用");
  assert.equal(boardFailure({ v: 1, ok: false, error: "gemflow: journal.geml.lock is held by another process" }, null), "gemflow：journal.geml.lock is held by another process");
  assert.equal(boardFailure({ v: 1, ok: true, shell: { status: null, policy: null, contextKey: null, problem: { text: "no workflow here", quiet: true } } }, null),
    "这个项目还没有流程。用 /gemflow add 选一个内置流程。");
  assert.equal(boardFailure({ v: 1, ok: true, shell: { status: null, policy: null, contextKey: null, problem: { text: "flow.geml: statechart-initial", quiet: false } } }, null),
    "gemflow：flow.geml: statechart-initial");
  assert.equal(boardText(undefined, "这个项目还没有流程。用 /gemflow add 选一个内置流程。"), "看板打不开：这个项目还没有流程。用 /gemflow add 选一个内置流程。");
  assert.equal(boardText(undefined, "gemflow：桥接不可用"), "看板打不开：桥接不可用");
});
