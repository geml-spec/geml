import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COACH_FLOWS, coachBand, coachFlowRows, coachSvg, coachText, readCoachFlow, workContext, workEvents, workItemsOf, workPrompt, workRows } from "../dist/hosts/claude-code/coach.js";
import { parseLog, summarize } from "../dist/core/session-log.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const t = wordsFor("zh");
const flows = COACH_FLOWS.map((name) => readCoachFlow(name, readFileSync(new URL(`../coach/${name}.geml`, import.meta.url), "utf8")));
const flow = (name) => flows.find((f) => f.name === name);
const item = (over) => ({ id: "a1", flow: "bugfix", title: "导出跳过不留", state: "confirm", needs: "你按一次跳过", goal: "跳过不留文件", status: "open", at: "2026-10-23T10:00:00Z", session: "s1", ...over });

test("the flows the plugin ships: 新设计, 新功能, bugfix, 优化, each its states in order, each a requirement, the way back dashed", () => {
  assert.deepEqual(flows.map((f) => [f.name, f.title]), [["design", "新设计"], ["feature", "新功能"], ["bugfix", "bugfix"], ["optimize", "优化"]]);
  assert.deepEqual(flow("bugfix").states.map((s) => [s.title, s.need, s.final]), [["复现", "版本已确认", false], ["修", "一个猜测一版", false], ["验证", "测试通过", false], ["你确认", "你按过说对", false], ["完成", "", true]]);
  assert.deepEqual(flow("bugfix").edges.filter((e) => e.back).map((e) => [e.from, e.to, e.label]), [["confirm", "reproduce", "你说没好"]]);
  assert.deepEqual(flow("design").states.map((s) => s.title), ["讨论", "出样稿", "你点头", "完成"]);
  assert.equal(readCoachFlow("x", "=== meta\ntitle = \"x\"\n===\n"), undefined, "no diagram: no flow");
  assert.equal(readCoachFlow("x", "=== diagram {#flow format=geml-statechart}\n{ not json\n===\n"), undefined);
});

test("a session's log keeps its work item events; the items as they stand are the newest event of each id, whichever session wrote it", () => {
  const log = (id, lines) => [{ t: "session", id, host: "claude-code", at: "2026-10-23T09:00:00Z" }, ...lines].map((e) => JSON.stringify(e)).join("\n");
  const ev = (at, over) => ({ t: "item", turn: 1, at, id: "a1", flow: "bugfix", title: "导出", state: "fix", needs: "", goal: "", status: "open", ...over });
  const one = summarize(parseLog(log("s1", [ev("2026-10-23T10:00:00Z", {}), ev("2026-10-23T10:05:00Z", { state: "verify" })])));
  assert.deepEqual(one.items.map((e) => e.state), ["verify"], "the newest of an id in one session");
  const two = summarize(parseLog(log("s2", [ev("2026-10-23T10:10:00Z", { state: "confirm" }), ev("2026-10-23T09:30:00Z", { id: "b2", title: "对齐", flow: "optimize", state: "change" })])));
  assert.equal(summarize(parseLog(log("s3", [{ ...ev("2026-10-23T10:00:00Z", {}), status: "maybe" }]))).items, undefined, "an event that is no item is left out");
  const items = workItemsOf([one, two]);
  assert.deepEqual(items.map((i) => [i.id, i.state, i.session]), [["a1", "confirm", "s2"], ["b2", "change", "s2"]], "newest first, across sessions");
});

test("the work tool's items: checked against the flows, a state by id or title, an update by id keeps what it does not say, a final state finishes it", () => {
  const on = [item({})];
  const r = workEvents({ items: [
    { title: "新的", flow: "feature", state: "build", needs: "一个模块", goal: "能用" },
    { id: "#a1", title: "", flow: "bugfix", state: "完成" },
    { title: "x", flow: "release", state: "a" },
    { title: "x", flow: "bugfix", state: "nowhere" },
    { id: "zz", title: "x", flow: "bugfix", state: "fix" },
    { title: " ", flow: "bugfix", state: "fix" },
  ] }, flows, on, "2026-10-23T11:00:00Z", 4, (n) => `new${n}`);
  assert.deepEqual(r.events.map((e) => [e.id, e.flow, e.title, e.state, e.needs, e.goal, e.status, e.turn]), [
    ["new0", "feature", "新的", "build", "一个模块", "能用", "open", 4],
    ["a1", "bugfix", "导出跳过不留", "done", "你按一次跳过", "跳过不留文件", "done", 4],
  ]);
  assert.deepEqual(r.errors, [
    "item 3: flow must be one of design, feature, bugfix, optimize",
    "item 4: bugfix has no state \"nowhere\" (reproduce, fix, verify, confirm, done)",
    "item 5: no work item #zz is on the way",
    "item 6 has no title",
  ]);
});

test("what the model is told: the flows once, with their states; beside each prompt the items on the way, by id", () => {
  assert.match(workPrompt(flows), /`work` tool/);
  assert.match(workPrompt(flows), /bugfix bugfix: reproduce 复现 → fix 修 → verify 验证 → confirm 你确认 → done 完成/);
  assert.deepEqual(workContext([item({}), item({ id: "b2", status: "done" })], flows), ["[gemflow] work items on the way: #a1 «导出跳过不留» (bugfix: confirm 你确认, needs 你按一次跳过)"]);
  assert.deepEqual(workContext([], flows), []);
});

test("the work items tab: a row per item on the way, its flow's word, where it stands, what it needs and ends as, the arrow to its flow", () => {
  const rows = workRows([item({}), item({ id: "b2", status: "dropped" })], flows, t);
  assert.deepEqual(rows, [{ kind: "work", key: "work-a1", flow: "bugfix", tag: "bugfix", title: "导出跳过不留", state: "你确认", detail: "还差：你按一次跳过 · 最后：跳过不留文件", go: { key: "work-go-a1", label: "看流程", action: { op: "coach-go", flow: "bugfix", id: "a1" } } }]);
});

test("the flow tab: the flows with items on the way, the focused one first; its picture, the items at each state and the state's requirement; the others in one line", () => {
  const items = [item({}), item({ id: "b2", title: "工具页对齐", at: "2026-10-23T09:00:00Z" }), item({ id: "c3", flow: "design", title: "流程改成教练", state: "mockup", needs: "你看样稿", at: "2026-10-23T11:00:00Z" })];
  const rows = coachFlowRows(items, flows, t, null);
  assert.deepEqual(rows.filter((r) => r.kind === "section").map((r) => [r.text, r.note]), [["新设计", "1 件在走"], ["bugfix", "2 件在走"]], "the one moved last first");
  assert.deepEqual(coachFlowRows(items, flows, t, { flow: "bugfix", id: "b2" }).filter((r) => r.kind === "section").map((r) => r.text), ["bugfix", "新设计"], "the focused flow first");
  const bug = coachFlowRows(items, flows, t, { flow: "bugfix", id: "b2" });
  assert.deepEqual(bug.filter((r) => r.kind === "entry" && r.key.startsWith("coach-item-")).map((r) => [r.title, r.tag, r.detail, r.current ?? false]), [
    ["导出跳过不留", "你确认", "还差：你按一次跳过", false], ["工具页对齐", "你确认", "还差：你按一次跳过", true], ["流程改成教练", "出样稿", "还差：你看样稿", false],
  ]);
  assert.ok(bug.some((r) => r.kind === "text" && r.text === "离开要求：你按过说对"));
  assert.equal(bug.at(-1).text, "现在没有事项在走：新功能 · 优化");
  assert.deepEqual(coachFlowRows([], flows, t, null), [{ kind: "text", text: "还没有在路上的工作项", tone: "dim" }]);
});

test("a flow's picture: every state's title and requirement, the state with items raised and saying who, the way back dashed with its words; in one line where no pictures are drawn", () => {
  const bug = flow("bugfix");
  const here = new Map([["confirm", [item({}), item({ id: "b2" })]]]);
  const svg = coachSvg(bug, here, t);
  for (const words of ["复现", "版本已确认", "你确认", "你按过说对", "在这：2 件", "你说没好，回到复现"]) assert.ok(svg.includes(words), words);
  assert.equal((svg.match(/stroke-dasharray/g) ?? []).length, 1, "one way back");
  assert.equal((svg.match(/<line /g) ?? []).length, 4, "four ways on");
  assert.ok(coachSvg(bug, new Map([["fix", [item({ title: "a<b" })]]]), t).includes("在这：a&lt;b"), "words escaped");
  assert.equal(coachText(bug, here), "复现 → 修 → 验证 → [你确认 ·2] → 完成");
});

test("the band's line: this session's last work item on the way, its flow, its name, what it needs", () => {
  const items = [item({ id: "x9", session: "other" }), item({})];
  assert.deepEqual(coachBand(items, flows, "s1", t), { verb: "bugfix", title: "导出跳过不留", note: "还差：你按一次跳过" });
  assert.equal(coachBand(items, flows, "nobody", t), undefined);
  assert.deepEqual(coachBand([item({ needs: "" })], flows, "s1", t)?.note, "你确认", "no needs: the state");
});
