import { test } from "node:test";
import assert from "node:assert/strict";
import { answered, asksOf, bandLine, leadOf, newsOf, NO_FACTS, NO_MEMORY, nowRows, optionsFor, outcomeOf, picksText, pressablesFor, remember, spokenOf, standingOf, stepPressables, WIDTH } from "../dist/hosts/claude-code/attention.js";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const cells = (s) => [...s].reduce((w, c) => w + (/[ᄀ-￿]/.test(c) ? 2 : 1), 0);

test("asks: a reply's own questions, from its end; a short one takes the sentence before it; a list's head stands for its items", () => {
  assert.deepEqual(asksOf("改好了。\n\n要强推覆盖 origin 上的 feat/x。推吗？"), ["要强推覆盖 origin 上的 feat/x。 推吗？"]);
  assert.deepEqual(asksOf("做完了。\n还有两处要你定：\n- 副标题要不要改？\n- 图标换不换？"), ["副标题要不要改？", "图标换不换？"]);
  assert.deepEqual(asksOf("还有两处要你定：\n- 副标题要不要改\n- 图标换不换"), [], "items that ask nothing, under a head that asks nothing: no question");
  assert.deepEqual(asksOf("**页签栏单独画**：只看你选中了哪个页签，所以点了一定能切。"), [], "a statement that mentions a choice is no question");
  assert.deepEqual(asksOf("眼下等你定的只有一件事：0.2.33 还没提交。"), [], "nor one that mentions a decision");
  // A question in other scripts: its own question mark, or a Japanese sentence ending in か; a semicolon is no question.
  for (const q of ["هل أدفع التغييرات؟", "プッシュしてもよろしいですか。", "Να το στείλω\u037E", "¿Lo subo?", "Ship it‽", "Push now﹖"]) assert.deepEqual(asksOf(`Done.
${q}`), [q], q);
  assert.deepEqual(asksOf("Done; tests pass; nothing else to do;"), [], "a semicolon ends no question");
  assert.deepEqual(asksOf("上一条里的事还等你定：文档稿批不批。"), [], "a reminder of an older ask is not this reply's ask");
  assert.deepEqual(asksOf("| 原型 | 现在？ |\n|---|---|"), [], "a table row is no question");
  assert.deepEqual(asksOf("全部做完了，测试都过。"), []);
});

test("answers: the ones an ask leans to, the action nearest its question mark", () => {
  assert.deepEqual(optionsFor("要不要把全局那份也同步过去？"), ["要", "不要"]);
  assert.deepEqual(optionsFor("公共分支已合并，要我清掉吗？"), ["清掉", "暂不"], "not 合并, which the clause before names");
  assert.deepEqual(optionsFor("文档稿批不批？"), ["批", "暂不"]);
  assert.deepEqual(optionsFor("这样可以吗？"), ["可以", "暂不"]);
  assert.deepEqual(optionsFor("下一段讲什么？"), ["同意", "暂不"]);
  assert.deepEqual(optionsFor("先做这个，还是先做第三步「产物」？"), ["先做这个", "先做第三步「产物」"], "A, 还是 B: the two choices, never yes or no");
  // Several things to settle: asked one by one, each with its own answers; the answers kept, then said together.
  const reply = "做完了。\n还有两处要你定：\n- 副标题要不要改？\n- 图标换不换？";
  const asked = [{ question: "副标题要不要改？", options: ["要", "不要"] }, { question: "图标换不换？", options: ["换", "不换"] }];
  const guess = leadOf({ reply, standing: [], memory: NO_MEMORY });
  assert.deepEqual([guess.kind, guess.text, guess.options], ["maybe", "可能待决定：副标题要不要改？", []], "not registered: a grey hint, nothing to press");
  const first = leadOf({ reply, standing: [], memory: NO_MEMORY, asked });
  assert.deepEqual([first.text, first.options, first.step], ["决定 1/2：副标题要不要改？", ["要", "不要"], { index: 0, of: 2 }]);
  assert.deepEqual(pressablesFor(first, first.options).map((p) => [p.label, p.action, p.primary ?? false]), [["要", { op: "pick", index: 0, answer: "要" }, true], ["不要", { op: "pick", index: 0, answer: "不要" }, false]]);
  const second = leadOf({ reply, standing: [], memory: NO_MEMORY, picks: ["要", null], asked });
  assert.deepEqual([second.text, second.options], ["决定 2/2：图标换不换？", ["换", "不换"]]);
  assert.equal(leadOf({ reply, standing: [], memory: NO_MEMORY, picks: ["要", "不换"], asked }), null, "all answered: nothing leads");
  assert.equal(picksText(["副标题要不要改？", "图标换不换？"], ["要", "不换"]), "副标题要不要改？：要\n图标换不换？：不换");
  const cards = nowRows({ reply, standing: [], memory: NO_MEMORY, picks: ["要", null], asked }).filter((r) => r.kind === "card");
  assert.deepEqual(nowRows({ reply, standing: [], memory: NO_MEMORY }), [], "a guessed question is no card");
  assert.deepEqual(cards.map((c) => [c.title, c.detail, c.actions.map((a) => a.action)]), [
    ["副标题要不要改？", ["已选：要"], []],
    ["图标换不换？", [], [{ op: "pick", index: 1, answer: "换" }, { op: "pick", index: 1, answer: "不换" }]],
  ], "the board's cards answer each on its own, the one picked says so");
  assert.deepEqual(optionsFor("文档稿批不批？"), ["批", "暂不"], "批不批 keeps its own words");
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
  assert.equal(leadOf({ reply: "要推吗？", standing, memory: NO_MEMORY, asked: [{ question: "要推吗？", options: ["推", "暂不"] }] }).kind, "ask");
  assert.equal(leadOf({ reply: "要推吗？", standing, memory: NO_MEMORY }).kind, "maybe", "the same question, not registered: a hint");
  const broken = leadOf({ reply: "做完了。", standing: standingOf("做完了。", facts, NOW), memory: NO_MEMORY });
  assert.equal(broken.kind, "broken");
  assert.equal(leadOf({ reply: "做完了。", standing: standingOf("做完了。", facts, NOW), memory: { ...NO_MEMORY, shown: ["fail:32:scan"] } }), null, "it led once already");
  assert.equal(leadOf({ reply: "做完了。", standing: standingOf("做完了。", facts, NOW), memory: { ...NO_MEMORY, lastLead: broken.text } }), null);
  const again = leadOf({ reply: "做完了。\n\n上一个问题还在等你：要不要重写历史去掉 e44c70ba？", standing: [], memory: NO_MEMORY });
  assert.equal(again.kind, "maybe", "a reply re-asking an older question, not registered: a hint of it");
  assert.match(again.text, /^可能待决定：要不要重写历史去掉 e44c70ba/);
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

test("the line: lead, steps still owed, asks still waiting, in one row; how long the person was away and a recap of the reply are never said", () => {
  const facts = { ahead: [{ branch: "feat/gemflow", ahead: 2, newestAt: "2026-10-18T08:00:00Z" }], prs: [{ number: 32, branch: "x", green: true, failing: [] }] };
  const reply = "定了，图标那批已提交 2f501ff5，还没推送。\n\n要推到 origin 吗？";
  const standing = standingOf(reply, facts, NOW);
  const lead = leadOf({ reply, standing, memory: NO_MEMORY, asked: [{ question: "要推到 origin 吗？", options: ["推", "暂不"] }] });
  const roomy = bandLine({ lead, standing: [], memory: NO_MEMORY, reply, awayMs: 3 * 3_600_000 });
  assert.match(roomy.text, /^待决定：.*要推到 origin 吗/, "back after hours: the question, nothing about the time away");
  const line = bandLine({ lead, standing, memory: { ...NO_MEMORY, backlog: ["a"] }, reply, awayMs: 3 * 3_600_000 });
  assert.match(line.text, /^待决定：.*要推到 origin 吗/);
  assert.match(line.text, /待决定 1 项$/);
  assert.deepEqual(line.options, ["推", "暂不"]);
  assert.deepEqual(line.steps.map((x) => x.short), ["合并 #32", "推送 feat/gemflow"], "the other steps only the person takes: buttons of their own beside the answers");
  assert.doesNotMatch(line.text, /还差你/, "a step with a button is not named twice");
  assert.ok(cells(line.text) + cells([...line.options, ...line.steps.map((x) => x.short)].map((o) => `[${o}]`).join(" ")) + 1 <= WIDTH, "one row");
  assert.deepEqual(stepPressables(line.steps).map((p) => [p.label, p.action]), [
    ["合并 #32", { op: "say", text: "合并 #32", confirm: { question: "合并 #32？此操作不可撤销。", yes: "合并" } }],
    ["推送 feat/gemflow", { op: "say", text: "推送 feat/gemflow", confirm: { question: "推送 feat/gemflow？提交将对仓库的其他人可见。", yes: "推送" } }],
  ]);
  // A commit just made: its push is a button at once, though it does not lead.
  const fresh = standingOf("", { ahead: [{ branch: "feat/x", ahead: 1, newestAt: new Date(NOW - 60_000).toISOString() }], prs: [] }, NOW);
  assert.equal(leadOf({ reply: "", standing: fresh, memory: NO_MEMORY }), null, "young: it does not lead");
  assert.deepEqual(bandLine({ lead: null, standing: fresh, memory: NO_MEMORY, reply: "", awayMs: 0 }), { text: "待处理", options: [], lead: null, steps: fresh });
  // Over a remote connection a reload is named, with no button that cannot work.
  const remote = standingOf("", { ahead: [], prs: [], reload: true }, NOW, undefined, { reloadHere: false });
  assert.deepEqual([remote[0].short, remote[0].options], ["本机重载插件", []]);
  assert.deepEqual(bandLine({ lead: leadOf({ reply: "", standing: remote, memory: NO_MEMORY }), standing: remote, memory: NO_MEMORY, reply: "", awayMs: 0 }).options, []);
  assert.deepEqual(stepPressables(standingOf("", { ahead: [], prs: [], reload: true }, NOW)).map((p) => p.action), [{ op: "command", command: "reload-plugins" }]);
  assert.equal(bandLine({ lead: null, standing: [], memory: NO_MEMORY, reply: "做完了，分三个提交留在本地，没有推送。\n\n细节如下。", awayMs: 2 * 3_600_000 }), null, "back after hours with nothing to do: no line, no recap of the reply");
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
  assert.deepEqual([back.text, back.steps.map((x) => x.short)], ["待处理", ["推送 main"]], "work not pushed comes back once on return, a button");
});

test("presses: an answer or a step goes as the person's own words, whole; 看看 opens the board; a reload is copied", () => {
  const p = (lead, options) => pressablesFor(lead, options).map((x) => [x.label, x.action, x.primary === true]);
  assert.deepEqual(p({ key: "green:43", kind: "you", text: "", options: ["合并"] }, ["合并"]), [["合并", { op: "say", text: "合并 #43", confirm: { question: "合并 #43？此操作不可撤销。", yes: "合并" } }, true]], "a merge cannot be taken back: asked first");
  assert.deepEqual(p({ key: "unpushed:feat/x", kind: "you", text: "", options: [] }, ["推送", "暂不"]), [["推送", { op: "say", text: "推送 feat/x", confirm: { question: "推送 feat/x？提交将对仓库的其他人可见。", yes: "推送" } }, true], ["暂不", { op: "say", text: "暂不" }, false]]);
  assert.deepEqual(p({ key: "fail:32:scan,CI", kind: "broken", text: "", options: [] }, ["查看日志"])[0][1], { op: "say", text: "看下 #32 失败的 scan、CI 日志" });
  assert.deepEqual(p(null, ["详情"])[0][1], { op: "open-board", tab: "items" });
  assert.deepEqual(p({ key: "reload", kind: "you", text: "", options: [] }, ["重载插件"])[0][1], { op: "command", command: "reload-plugins" });
  assert.deepEqual(p({ key: "ask:q", kind: "ask", text: "", options: [], question: "用 A 方案还是 B 方案？" }, ["A 方案", "B 方案"])[1][1], { op: "say", text: "用 A 方案还是 B 方案？：B 方案" }, "the answer says what it answers");
});

test("此刻 on the board: every ask with its answers, every step, every older ask", () => {
  const facts = { ahead: [{ branch: "main", ahead: 1, newestAt: "2026-10-18T08:00:00Z" }], prs: [] };
  const reply = "还要你定两件事：\n1. 新分支要不要开 PR？\n2. #32 关不关？";
  const asked = [{ question: "新分支要不要开 PR？", options: ["要", "不要"] }, { question: "#32 关不关？", options: ["关", "不关"] }];
  const rows = nowRows({ reply, standing: standingOf(reply, facts, NOW), memory: { ...NO_MEMORY, backlog: ["上一条里的事还等你定：文档稿批不批"] }, asked });
  assert.deepEqual(rows.map((r) => r.kind === "section" ? `§${r.text}` : `${r.verb} ${r.title}`), ["§此刻", "决定 新分支要不要开 PR？", "决定 #32 关不关？", " 待推送：main · 1 个提交", "待决定 文档稿批不批"]);
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
  assert.deepEqual(fresh[1].actions.map((a) => a.action), [{ op: "say", text: "合并 #32", confirm: { question: "合并 #32？此操作不可撤销。", yes: "合并" } }]);
  const queued = nowRows({ reply: "", standing, memory: NO_MEMORY, queued: [{ text: "合并 #32", entered: false }] });
  assert.deepEqual([queued[1].actions, queued[1].detail], [[], ["排队中 合并 #32"]]);
  const doing = nowRows({ reply: "", standing, memory: NO_MEMORY, queued: [{ text: "合并 #32", entered: true }] });
  assert.deepEqual(doing[1].detail, ["进行中 合并 #32"]);
  const reload = pressablesFor({ key: "reload", kind: "you", text: "重载插件", options: ["重载插件"] }, ["重载插件"]);
  assert.deepEqual(reload[0].action, { op: "command", command: "reload-plugins" });
  assert.equal(spokenOf(reload[0].action), "/reload-plugins");
});
