import { test } from "node:test";
import assert from "node:assert/strict";
import { answered, asksOf, bandLine, leadOf, newsOf, NO_FACTS, NO_MEMORY, nowRows, optionsFor, outcomeOf, picksText, pressablesFor, remember, spokenOf, standingOf, WIDTH } from "../dist/hosts/claude-code/attention.js";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const cells = (s) => [...s].reduce((w, c) => w + (/[ᄀ-￿]/.test(c) ? 2 : 1), 0);

test("asks: a reply's own questions, from its end; a short one takes the sentence before it; a list's head stands for its items", () => {
  assert.deepEqual(asksOf("改好了。\n\n要强推覆盖 origin 上的 feat/x。推吗？"), ["要强推覆盖 origin 上的 feat/x。 推吗？"]);
  assert.deepEqual(asksOf("做完了。\n还有两处要你定：\n- 副标题要不要改\n- 图标换不换"), ["副标题要不要改", "图标换不换"]);
  assert.deepEqual(asksOf("上一条里的事还等你定：文档稿批不批。"), [], "a reminder of an older ask is not this reply's ask");
  assert.deepEqual(asksOf("| 原型 | 现在？ |\n|---|---|"), [], "a table row is no question");
  assert.deepEqual(asksOf("全部做完了，测试都过。"), []);
});

test("answers: the ones an ask leans to, the action nearest its question mark", () => {
  assert.deepEqual(optionsFor("要不要把全局那份也同步过去？"), ["要", "不要"]);
  assert.deepEqual(optionsFor("公共分支已合并，要我清掉吗？"), ["清掉", "先不"], "not 合并, which the clause before names");
  assert.deepEqual(optionsFor("文档稿批不批？"), ["批", "先不"]);
  assert.deepEqual(optionsFor("这样可以吗？"), ["可以", "先不"]);
  assert.deepEqual(optionsFor("下一段讲什么？"), ["好", "先不"]);
  assert.deepEqual(optionsFor("先做这个，还是先做第三步「产物」？"), ["先做这个", "先做第三步「产物」"], "A, 还是 B: the two choices, never yes or no");
  // Several things to settle: asked one by one, each with its own answers; the answers kept, then said together.
  const reply = "做完了。\n还有两处要你定：\n- 副标题要不要改\n- 图标换不换";
  const first = leadOf({ reply, standing: [], memory: NO_MEMORY });
  assert.deepEqual([first.text, first.options, first.step], ["定 1/2：副标题要不要改", ["要", "不要"], { index: 0, of: 2 }]);
  assert.deepEqual(pressablesFor(first, first.options).map((p) => [p.label, p.action, p.primary ?? false]), [["要", { op: "pick", index: 0, answer: "要" }, true], ["不要", { op: "pick", index: 0, answer: "不要" }, false]]);
  const second = leadOf({ reply, standing: [], memory: NO_MEMORY, picks: ["要", null] });
  assert.deepEqual([second.text, second.options], ["定 2/2：图标换不换", ["换", "不换"]]);
  assert.equal(leadOf({ reply, standing: [], memory: NO_MEMORY, picks: ["要", "不换"] }), null, "all answered: nothing leads");
  assert.equal(picksText(["副标题要不要改", "图标换不换"], ["要", "不换"]), "副标题要不要改：要\n图标换不换：不换");
  const cards = nowRows({ reply, standing: [], memory: NO_MEMORY, picks: ["要", null] }).filter((r) => r.kind === "card");
  assert.deepEqual(cards.map((c) => [c.title, c.detail, c.actions.map((a) => a.action)]), [
    ["副标题要不要改", ["已选：要"], []],
    ["图标换不换", [], [{ op: "pick", index: 1, answer: "换" }, { op: "pick", index: 1, answer: "不换" }]],
  ], "the board's cards answer each on its own, the one picked says so");
  assert.deepEqual(optionsFor("文档稿批不批？"), ["批", "先不"], "批不批 keeps its own words");
  assert.deepEqual(optionsFor("用 jsonl 还是 json 块？"), ["用 jsonl", "json 块"], "the blanks around 还是 are not part of either");
  assert.deepEqual(optionsFor("提交到 main 还是新开分支？"), ["main", "新开分支"]);
});

test("standing: a failing check, a green pull request, commits not pushed (quiet while minutes old), a step the reply leaves, work not committed", () => {
  const facts = {
    ahead: [{ branch: "feat/a", ahead: 2, newestAt: "2026-10-18T09:00:00Z" }, { branch: "feat/b", ahead: 1, newestAt: "2026-10-18T09:58:00Z" }],
    prs: [{ number: 32, branch: "feat/a", green: false, failing: ["scan"] }, { number: 43, branch: "feat/c", green: true, failing: [] }],
  };
  const s = standingOf("改动等你看过再提交。\n还剩你手动做的几件：\n- 在 Actions 里发 npm\n- 上传 CWS", facts, NOW);
  assert.deepEqual(s.map((x) => x.key), ["fail:32:scan", "green:43", "unpushed:feat/a", "unpushed:feat/b", "step:在 Actions 里发 npm；上传 CWS", "uncommitted:改动等你看过再提交。"]);
  assert.equal(s.find((x) => x.key === "unpushed:feat/b").quiet, true, "a commit two minutes old is about to be pushed");
  assert.equal(standingOf("", NO_FACTS, NOW).length, 0);
});

test("lead: this reply's asks first; then a failure new to the person, then a new step; never the same line twice running", () => {
  const facts = { ahead: [], prs: [{ number: 32, branch: "feat/a", green: false, failing: ["scan"] }] };
  const standing = standingOf("要推吗？", facts, NOW);
  assert.equal(leadOf({ reply: "要推吗？", standing, memory: NO_MEMORY }).kind, "ask");
  const broken = leadOf({ reply: "做完了。", standing: standingOf("做完了。", facts, NOW), memory: NO_MEMORY });
  assert.equal(broken.kind, "broken");
  assert.equal(leadOf({ reply: "做完了。", standing: standingOf("做完了。", facts, NOW), memory: { ...NO_MEMORY, shown: ["fail:32:scan"] } }), null, "it led once already");
  assert.equal(leadOf({ reply: "做完了。", standing: standingOf("做完了。", facts, NOW), memory: { ...NO_MEMORY, lastLead: broken.text } }), null);
  const again = leadOf({ reply: "做完了。\n\n上一个问题还在等你：要不要重写历史去掉 e44c70ba。", standing: [], memory: NO_MEMORY });
  assert.equal(again.kind, "ask", "a reply re-asking an older question asks it this turn");
  assert.match(again.text, /要不要重写历史去掉 e44c70ba/);
});

test("memory: what led is shown, each condition ages, reminders wait; a short answer ends the oldest", () => {
  const standing = standingOf("做完了。", { ahead: [{ branch: "main", ahead: 1, newestAt: "2026-10-18T08:00:00Z" }], prs: [] }, NOW);
  const lead = leadOf({ reply: "做完了。", standing, memory: NO_MEMORY });
  let m = remember(NO_MEMORY, { reply: "做完了。上一条里的事还等你定：文档稿批不批。", standing, lead });
  assert.deepEqual(m.shown, ["unpushed:main"]);
  assert.deepEqual(m.age, { "unpushed:main": 1 });
  assert.equal(m.backlog.length, 1);
  m = answered(m, "批");
  assert.equal(m.backlog.length, 0);
  assert.equal(answered({ ...m, backlog: ["x"] }, "这是一段很长的新任务说明，跟上一个问题没有关系，需要你把整个模块重写一遍再跑完整测试，然后整理提交并写清楚说明").backlog.length, 1);
});

test("the line: lead, steps still owed, asks still waiting, in one row; back after a while, what became of the last request", () => {
  const facts = { ahead: [{ branch: "feat/gemflow", ahead: 2, newestAt: "2026-10-18T08:00:00Z" }], prs: [{ number: 32, branch: "x", green: true, failing: [] }] };
  const reply = "定了，图标那批已提交 2f501ff5，还没推送。\n\n要推到 origin 吗？";
  const standing = standingOf(reply, facts, NOW);
  const lead = leadOf({ reply, standing, memory: NO_MEMORY });
  const roomy = bandLine({ lead, standing: [], memory: NO_MEMORY, reply, awayMs: 3 * 3_600_000, asked: "提交" });
  assert.match(roomy.text, /^你离开了 3 小时 · 定 .*要推到 origin 吗/, "room for it: the away note leads");
  const line = bandLine({ lead, standing, memory: { ...NO_MEMORY, backlog: ["a"] }, reply, awayMs: 3 * 3_600_000, asked: "提交" });
  assert.match(line.text, /^定 .*要推到 origin 吗/, "crowded: the away note goes first");
  assert.match(line.text, /还差你：.*推送 feat\/gemflow/);
  assert.match(line.text, /还有 1 件待定$/);
  assert.deepEqual(line.options, ["推", "先不"]);
  assert.ok(cells(line.text) + cells(line.options.map((o) => `[${o}]`).join(" ")) + 1 <= WIDTH, "one row");
  const back = bandLine({ lead: null, standing: [], memory: NO_MEMORY, reply: "做完了，分三个提交留在本地，没有推送。\n\n细节如下。", awayMs: 2 * 3_600_000, asked: "一起改完再跑全测吧" });
  assert.match(back.text, /你走前让我「一起改完再跑全测吧」：做完了，分三个提交留在本地，没有推送/, "what became of the request leads (the away note gives way to it in one row)");
  assert.equal(back.lead, "back");
  assert.equal(bandLine({ lead: null, standing: [], memory: NO_MEMORY, reply: "", awayMs: 0 }), null, "nothing to say, no line");
});

test("the line fades: a condition rides along for its first turns, then only the board has it, unless the person comes back to it", () => {
  const facts = { ahead: [], prs: [{ number: 32, branch: "x", green: true, failing: [] }] };
  const standing = standingOf("", facts, NOW);
  const aged = { ...NO_MEMORY, shown: ["green:32"], age: { "green:32": 9 } };
  assert.equal(bandLine({ lead: null, standing, memory: aged, reply: "", awayMs: 0 }), null, "seen and left: faded");
  assert.equal(bandLine({ lead: null, standing, memory: aged, reply: "", awayMs: 5 * 3_600_000 }), null, "a green pull request left for days stays faded, back or not");
  const unpushed = standingOf("", { ahead: [{ branch: "main", ahead: 1, newestAt: "2026-10-18T01:00:00Z" }], prs: [] }, NOW);
  const back = bandLine({ lead: null, standing: unpushed, memory: { ...NO_MEMORY, shown: ["unpushed:main"], age: { "unpushed:main": 9 } }, reply: "", awayMs: 5 * 3_600_000 });
  assert.match(back.text, /还差你：推送 main/, "work not pushed comes back once on return");
});

test("presses: an answer or a step goes as the person's own words, whole; 看看 opens the board; a reload is copied", () => {
  const p = (lead, options) => pressablesFor(lead, options).map((x) => [x.label, x.action, x.primary === true]);
  assert.deepEqual(p({ key: "green:43", kind: "you", text: "", options: ["合并"] }, ["合并"]), [["合并", { op: "say", text: "合并 #43", confirm: { question: "合并 #43？合进去就撤不回。", yes: "合并" } }, true]], "a merge cannot be taken back: asked first");
  assert.deepEqual(p({ key: "unpushed:feat/x", kind: "you", text: "", options: [] }, ["推送", "先不"]), [["推送", { op: "say", text: "推送 feat/x", confirm: { question: "推送 feat/x？推上去的提交别人就看得到。", yes: "推送" } }, true], ["先不", { op: "say", text: "先不" }, false]]);
  assert.deepEqual(p({ key: "fail:32:scan,CI", kind: "broken", text: "", options: [] }, ["看日志"])[0][1], { op: "say", text: "看下 #32 失败的 scan、CI 日志" });
  assert.deepEqual(p(null, ["看看"])[0][1], { op: "open-board", tab: "items" });
  assert.deepEqual(p({ key: "reload", kind: "you", text: "", options: [] }, ["重载插件"])[0][1], { op: "command", command: "reload-plugins" });
});

test("此刻 on the board: every ask with its answers, every step, every older ask", () => {
  const facts = { ahead: [{ branch: "main", ahead: 1, newestAt: "2026-10-18T08:00:00Z" }], prs: [] };
  const reply = "还要你定两件事：\n1. 新分支要不要开 PR\n2. #32 关不关";
  const rows = nowRows({ reply, standing: standingOf(reply, facts, NOW), memory: { ...NO_MEMORY, backlog: ["上一条里的事还等你定：文档稿批不批"] } });
  assert.deepEqual(rows.map((r) => r.kind === "section" ? `§${r.text}` : `${r.verb} ${r.title}`), ["§此刻", "定 新分支要不要开 PR", "定 #32 关不关", "只差你 main 有 1 个提交没推送", "还等你 文档稿批不批"]);
  assert.deepEqual(nowRows({ reply: "", standing: [], memory: NO_MEMORY }), []);
});

test("news for the model: a check that started failing, a pull request gone green or gone", () => {
  const before = { ahead: [], prs: [{ number: 32, branch: "a", green: false, failing: [] }, { number: 41, branch: "b", green: true, failing: [] }] };
  const now = { ahead: [], prs: [{ number: 32, branch: "a", green: false, failing: ["scan"] }, { number: 43, branch: "c", green: true, failing: [] }] };
  assert.deepEqual(newsOf(before, now), ["#32 的 scan 失败", "#41 已不再开着（合并或关闭）"]);
  assert.deepEqual(newsOf(now, now), []);
});

test("what became of a request: the reply's first whole sentence, past a line cut from the front", () => {
  assert.equal(outcomeOf("已提交到 feat/gemflow：2f501ff5。\n\n细节如下。"), "已提交到 feat/gemflow：2f501ff5。");
  assert.equal(outcomeOf("个码，每个后面是它\n25 个码全部归并好了。", true), "25 个码全部归并好了。");
});

test("a step already pressed shows what became of it, not its buttons; 重载插件 runs the command", () => {
  const standing = [{ key: "green:32", kind: "you", short: "合并 #32", text: "只差你 #32 全绿，可以合并", options: ["合并"] }];
  const fresh = nowRows({ reply: "", standing, memory: NO_MEMORY });
  assert.deepEqual(fresh[1].actions.map((a) => a.action), [{ op: "say", text: "合并 #32", confirm: { question: "合并 #32？合进去就撤不回。", yes: "合并" } }]);
  const queued = nowRows({ reply: "", standing, memory: NO_MEMORY, queued: [{ text: "合并 #32", entered: false }] });
  assert.deepEqual([queued[1].actions, queued[1].detail], [[], ["排队中 合并 #32"]]);
  const doing = nowRows({ reply: "", standing, memory: NO_MEMORY, queued: [{ text: "合并 #32", entered: true }] });
  assert.deepEqual(doing[1].detail, ["进行中 合并 #32"]);
  const reload = pressablesFor({ key: "reload", kind: "you", text: "重载插件", options: ["重载插件"] }, ["重载插件"]);
  assert.deepEqual(reload[0].action, { op: "command", command: "reload-plugins" });
  assert.equal(spokenOf(reload[0].action), "/reload-plugins");
});
