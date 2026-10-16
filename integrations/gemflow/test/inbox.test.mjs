import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxItems, othersWaiting, pendingList, shortReason, stageEntryOf } from "../dist/hosts/claude-code/inbox.js";
import { waitsOnPerson } from "../dist/core/turn.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const t = wordsFor("zh");
const NOW = "2026-10-12T09:20:00Z";
const LABELS = { deploy: "部署", build: "构建", skip: "跳过", done: "完成", doing: "实施" };
const next = (over) => ({ judge: "machine", approval: false, reads: [], missing: [], holds: true, note: "", toFinal: false, toStart: false, ...over, label: over.label ?? LABELS[over.to] ?? over.to });
const status = (over = {}) => ({
  workflow: { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程" }, item: { kind: "item", id: "feat/rate-limit" },
  state: { id: "review", title: "评审", rev: 7, uses: ["edit"], final: false, since: "2026-10-12T09:00:00Z" },
  vars: { "pr-merged": true, "ci-pass": true, "review-ready": false },
  sources: { "pr-merged": "git:pr-merged", "ci-pass": "git:ci-success", "review-ready": "human" },
  next: [
    next({ name: "review→deploy", to: "deploy", approval: true, guard: "pr-merged = true and ci-pass = true", reads: ["pr-merged", "ci-pass"] }),
    next({ name: "review→build", to: "build", judge: "model", guard: "review 要求改动", toStart: true }),
    next({ name: "review→skip", to: "skip", reads: ["review-ready"], missing: ["review-ready"], holds: false }),
  ],
  refusals: 3, paused: false, gh: { available: true }, ...over,
});
const ROWS = [{ tool: "Bash(wrangler deploy*--env staging)", for: "deploy-staging", allow: [], deny: [], default: true, row: 1 }, { tool: "WebFetch", allow: [], deny: ["review"], default: false, row: 2 }];
const shell = (st = status(), relevant = ["pr-merged", "ci-pass", "review-ready"]) => ({ status: st, policy: { relevant, rows: ROWS }, contextKey: "feat/rate-limit@7" });
const refused = (n, at, key, reason = `"npm run deploy:staging" is deploy-staging, which is used only in #deploy; the workflow is in #review; switching the work item is always allowed: git switch <branch>`) =>
  ({ kind: "refused", n, rev: 7, at, tool: "Bash", reason, key });
const TIMELINE = [
  { kind: "snapshot", rev: 6, at: "2026-10-12T08:50:00Z", state: "build", cause: "patch", by: "signal", signal: "tests-pass" },
  { kind: "snapshot", rev: 7, at: "2026-10-12T09:00:00Z", state: "review", cause: "transition", by: "signal", signal: "tests-pass", from: "build" },
  refused(1, "2026-10-12T09:11:00Z", "Bash(wrangler deploy*--env staging)"),
  refused(2, "2026-10-12T09:12:00Z", "Bash(wrangler deploy*--env staging)"),
  refused(3, "2026-10-12T09:13:00Z", "Bash(wrangler deploy*--env staging)"),
];
const items = (over = {}) => inboxItems({ shell: shell(), timeline: TIMELINE, problem: null, now: NOW, t, ...over });

test("a work item whose way out waits on a person is one item: 定 or 验收, its name, and every way out they may take as an option", () => {
  const [approve] = items().filter((i) => i.kind === "approve");
  assert.deepEqual([approve.verb, approve.title, approve.detail, approve.since], ["定", "feat/rate-limit", ["评审"], "2026-10-12T09:00:00Z"]);
  assert.deepEqual(approve.actions.map((a) => [a.key, a.label, a.primary ?? false, a.action]), [
    ["approve-deploy", "部署", true, { op: "advance", to: "deploy", say: "部署：feat/rate-limit" }],
    ["approve-build", "构建", false, { op: "advance", to: "build", say: "构建：feat/rate-limit" }],
  ], "the ways out waiting on the person first, then one the model would judge, each on its own label, saying what was chosen");
  assert.equal(approve.closes, undefined);
  const checking = status({
    title: "看板显示每件事做出来的东西", state: { id: "checking", title: "待验收", rev: 9, uses: [], final: false, since: "2026-10-12T09:00:00Z" },
    next: [next({ name: "checking→done", to: "done", approval: true, label: "通过", toFinal: true, note: "人验收通过。" }), next({ name: "checking→doing", to: "doing", approval: true, label: "要改" })],
  });
  const accept = items({ shell: shell(checking) }).find((i) => i.kind === "approve");
  assert.deepEqual([accept.verb, accept.title, accept.detail, accept.actions.map((a) => a.label)], ["验收", "看板显示每件事做出来的东西", ["待验收", "通过：人验收通过。"], ["通过", "要改"]], "a way out into a final state makes it 验收");
  assert.equal(accept.closes, true);
  assert.equal(accept.actions[0].action.say, "通过：看板显示每件事做出来的东西");
  const closed = items({ shell: shell(status({ vars: { "pr-merged": false, "ci-pass": true, "review-ready": false }, next: [next({ name: "review→deploy", to: "deploy", approval: true, reads: ["pr-merged", "ci-pass"], missing: ["pr-merged"], holds: false })] })) });
  assert.deepEqual(closed.filter((i) => i.kind === "approve"), [], "a guard that does not hold asks nothing of a person");
});

test("whose turn it is: the person's, when a way on is theirs alone — an approval that holds, or a condition only they tick — and nobody else has one", () => {
  const way = (over) => ({ judge: "machine", approval: false, holds: false, reads: [], toStart: false, ...over });
  const sources = { "check-pass": "tool:check", "accept-now": "human", "review-ready": "human" };
  const deciding = [way({ approval: true, holds: true }), way({ approval: true, holds: true, toStart: true })];
  const checking = [way({ approval: true, holds: true, judge: "none" }), way({ approval: true, holds: true })];
  const noted = [way({ judge: "model" }), way({ approval: true, holds: true })];
  const doing = [way({ reads: ["check-pass", "accept-now"] })];
  const parked = [way({ approval: true, holds: true, toStart: true })];
  const gate = [way({ reads: ["review-ready"] }), way({ judge: "model", toStart: true })];
  const evidence = [way({ approval: true, holds: false, reads: ["check-pass"] })];
  assert.deepEqual([deciding, checking, noted, doing, parked, gate, evidence].map((n) => waitsOnPerson(n, sources)), [true, true, false, false, false, true, false],
    "deciding and checking wait; the model's turn while it writes the plan; the evidence's while the work is checked; a matter put aside only reopens; a tick alone gates; an approval waits for its evidence");
});

test("a variable a person ticks, read by a guard of this state's edges, is asked for while the way on is theirs", () => {
  const [tick] = items().filter((i) => i.kind === "tick");
  assert.deepEqual([tick.verb, tick.title, tick.detail, tick.since], ["勾", "feat/rate-limit", ["勾上 review-ready，才走「跳过」"], "2026-10-12T09:00:00Z"]);
  const evidence = status({ next: [next({ name: "doing→checking", to: "checking", reads: ["check-pass", "review-ready"], holds: false })], sources: { "check-pass": "tool:check", "review-ready": "human" } });
  assert.deepEqual(items({ shell: shell(evidence) }).filter((i) => i.kind === "tick" || i.kind === "approve"), [], "the check can move it: ticking is a shortcut, not something waiting");
  assert.deepEqual(tick.actions.map((a) => [a.label, a.action]), [["勾上", { op: "mark", variable: "review-ready", checked: true }]]);
  assert.deepEqual(items({ shell: shell(status({ vars: { "pr-merged": true, "ci-pass": true, "review-ready": true } })) }).filter((i) => i.kind === "tick"), [], "ticked already");
});

test("repeated refusals of one key since the stage was entered are 'stuck': allow once, allow here when the dictionary denied it, see the journal", () => {
  const [stuck] = items().filter((i) => i.kind === "stuck");
  assert.deepEqual([stuck.verb, stuck.title], ["被拦", "Bash(wrangler deploy*--env staging)"]);
  assert.deepEqual(stuck.detail, ['"npm run deploy:staging" is deploy-staging, which is used only in #deploy; the workflow is in #review', "9 分钟内 3 次"]);
  assert.equal(stuck.since, "2026-10-12T09:11:00Z");
  assert.deepEqual(stuck.actions.map((a) => [a.key, a.label, a.action]), [
    ["pass-Bash(wrangler deploy*--env staging)", "放行一次", { op: "pass-once", keys: ["Bash(wrangler deploy*--env staging)"] }],
    ["journal-Bash(wrangler deploy*--env staging)", "看记录", { op: "tab", tab: "journal" }],
  ], "a use the workflow fences is not allowed here from the board");
  const denied = items({ timeline: [...TIMELINE.slice(0, 2), refused(1, "2026-10-12T09:18:00Z", "WebFetch", "you denied WebFetch in #review; switching the work item is always allowed: x"), refused(2, "2026-10-12T09:19:00Z", "WebFetch", "you denied WebFetch in #review; switching the work item is always allowed: x")] });
  assert.deepEqual(denied.find((i) => i.kind === "stuck").actions.map((a) => a.label), ["放行一次", "在 #review 也允许", "看记录"]);
  assert.deepEqual(items({ timeline: [...TIMELINE.slice(0, 2), TIMELINE[2]] }).filter((i) => i.kind === "stuck"), [], "one refusal is not stuck");
  assert.deepEqual(items({ now: "2026-10-12T11:00:00Z" }).filter((i) => i.kind === "stuck"), [], "refusals long ago are not stuck now");
  const earlier = [refused(1, "2026-10-12T08:40:00Z", "WebFetch"), refused(2, "2026-10-12T08:41:00Z", "WebFetch"), ...TIMELINE];
  assert.deepEqual(items({ timeline: earlier.map((e, i) => (e.kind === "refused" && i < 2 ? { ...e, rev: 5, at: "2026-10-12T09:15:00Z" } : e)) }).filter((i) => i.kind === "stuck" && i.title.includes("WebFetch")), [], "refusals before this stage's entry do not count");
  assert.equal(stageEntryOf(TIMELINE), 7);
  assert.equal(shortReason("x is y; switching the work item is always allowed: git switch <branch>"), "x is y");
});

test("a broken bridge comes first, with retry", () => {
  const all = items({ problem: "gemflow：桥接没有应答（timed out after 15000 ms）" });
  assert.deepEqual(all.map((i) => i.kind), ["broken", "approve", "tick", "stuck"]);
  const broken = all[0];
  assert.deepEqual([broken.title, broken.detail, broken.actions.map((a) => a.action)], ["gemflow：桥接没有应答（timed out after 15000 ms）", ["调用照常执行，什么都不记"], [{ op: "retry" }]]);
});

test("a paused item, no item, or no shell asks for nothing but the bridge", () => {
  assert.deepEqual(items({ shell: shell(status({ paused: true })) }).map((i) => i.kind), []);
  assert.deepEqual(items({ shell: shell(status({ item: { kind: "inactive", reason: "main" } })) }), []);
  assert.deepEqual(items({ shell: null, problem: "x" }).map((i) => i.kind), ["broken"]);
});

test("the other work items waiting on the person: 定 or 验收, the stage as a tag, each option taken on its file; the pending list reads the current work item's decision first", () => {
  const board = {
    states: [{ id: "noted", title: "记下" }, { id: "deciding", title: "待你定" }, { id: "checking", title: "待验收" }],
    items: [
      { id: "m/cur", state: "deciding", rev: 1, at: NOW, paused: false, file: "m/cur.geml", asks: [{ to: "doing", label: "按方案做", note: "", final: false }] },
      { id: "m/pi", state: "deciding", rev: 2, at: NOW, paused: false, file: "m/pi.geml", title: "pi 也记写入吗", asks: [{ to: "doing", label: "按方案做", note: "人选定了方案。", final: false }, { to: "parked", label: "先放着", note: "", final: false }] },
      { id: "feat/y", state: "checking", rev: 3, at: NOW, paused: false, asks: [{ to: "done", label: "通过", note: "", final: true }] },
      { id: "m/quiet", state: "noted", rev: 1, at: NOW, paused: false, file: "m/quiet.geml" },
    ],
  };
  const others = othersWaiting(board, "m/cur", t);
  assert.deepEqual(others.map((i) => [i.key, i.verb, i.title, i.tag, i.detail, i.closes ?? false, i.actions.map((a) => [a.label, a.primary ?? false, a.action])]), [
    ["asks-m/pi", "定", "pi 也记写入吗", "待你定", ["按方案做：人选定了方案。"], false, [
      ["按方案做", true, { op: "advance", to: "doing", file: "m/pi.geml", say: "按方案做：pi 也记写入吗" }],
      ["先放着", false, { op: "advance", to: "parked", file: "m/pi.geml", say: "先放着：pi 也记写入吗" }],
    ]],
    ["asks-feat/y", "验收", "feat/y", "待验收", [], true, []],
  ], "the current one is the inbox's; one with no file is shown without options");
  assert.deepEqual(othersWaiting(null, undefined, t), []);
  assert.equal(othersWaiting({ ...board, items: [{ ...board.items[1], about: "tools" }] }, "m/cur", t)[0].tag, "建议 · 工具", "a suggestion says what it is about, not its stage");
  const said = othersWaiting({ ...board, items: [{ ...board.items[1], gist: "现在只有 Claude Code 和 Codex 记。", asks: [{ to: "parked", label: "先放着", note: "先放着。", final: false }] }] }, "m/cur", t);
  assert.deepEqual(said[0].detail, ["现在只有 Claude Code 和 Codex 记。"], "what the work item says of itself, rather than what its options mean");
  assert.deepEqual(othersWaiting({ ...board, items: [{ ...board.items[1], asks: [{ to: "parked", label: "先放着", note: "先放着。", final: false }] }] }, "m/cur", t)[0].detail, ["先放着。"], "a note that starts with the button's words is not said twice");
  assert.deepEqual(pendingList(items(), others).map((i) => i.key), ["approve-review", "asks-m/pi", "asks-feat/y", "tick-review-ready", "stuck-Bash(wrangler deploy*--env staging)"]);
});

test("a work item whose dependencies are all done since it last moved is to come back to: its flow, what was done, a press that makes it current and says so", () => {
  const board = {
    states: [{ id: "noted", title: "记下" }],
    items: [
      { id: "m/styles", state: "noted", rev: 1, at: "2026-10-15T09:30:00Z", paused: false, file: "m/styles.geml", title: "样式：画布换上新标志", flow: "开发流程", depends: [{ id: "m/logo", title: "gemflow 标志", done: true, at: "2026-10-15T11:18:00Z" }] },
      { id: "m/early", state: "noted", rev: 1, at: "2026-10-15T12:00:00Z", paused: false, file: "m/early.geml", depends: [{ id: "m/logo", done: true, at: "2026-10-15T11:18:00Z" }] },
      { id: "m/still", state: "noted", rev: 1, at: "2026-10-15T09:00:00Z", paused: false, file: "m/still.geml", depends: [{ id: "m/x", done: false }] },
      { id: "m/logo", state: "done", rev: 9, at: "2026-10-15T11:18:00Z", paused: false, file: "m/logo.geml", final: true },
    ],
  };
  const [back, ...rest] = othersWaiting(board, "m/logo", t);
  assert.deepEqual(rest, [], "one that moved since, and one still waiting, are not offered back");
  assert.deepEqual([back.kind, back.verb, back.title, back.tag, back.detail], ["resume", "回到", "样式：画布换上新标志", "开发流程", ["「gemflow 标志」完成了"]]);
  assert.deepEqual(back.actions.map((a) => [a.label, a.action]), [["继续", { op: "switch-file", file: "m/styles.geml", say: "继续：样式：画布换上新标志" }]]);
  assert.deepEqual(othersWaiting(board, "m/styles", t), [], "the current one is not offered back to itself");
});
