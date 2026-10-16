import { test } from "node:test";
import assert from "node:assert/strict";
import { SEP, bandSegments, bandView, cellWidth, fitSegments, nextText, toneProps, truncate, varSegment } from "../dist/hosts/claude-code/band.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const NOW = "2026-10-14T08:00:00.000Z";

const edge = (over) => ({ judge: "machine", approval: false, reads: [], missing: [], holds: true, note: "", toStart: false, ...over, label: over.label ?? ({ build: "构建", deploy: "部署" })[over.to] ?? over.to });
const status = (over = {}) => ({
  workflow: { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程" },
  item: { kind: "item", id: "feat/rate-limit" },
  state: { id: "review", title: "评审", rev: 7, uses: ["edit", "test"] },
  vars: { "tests-pass": true, "ci-pass": true, "pr-merged": false },
  sources: { "tests-pass": "tool:test", "ci-pass": "git:ci-success", "pr-merged": "git:pr-merged" },
  next: [
    edge({ name: "review→build", to: "build", judge: "model" }),
    edge({ name: "review→deploy", to: "deploy", guard: "pr-merged = true and ci-pass = true", reads: ["pr-merged", "ci-pass"], missing: ["pr-merged"], holds: false }),
  ],
  refusals: 0, gh: { available: true }, ...over,
});
const shell = (s, policy = {}) => ({ status: s, policy: { relevant: ["ci-pass", "pr-merged"], ...policy }, contextKey: "feat/rate-limit@7" });
const texts = (segs) => segs.map((x) => x.text);

test("item, state, the variables the next guards read, and the next step (spec §8.1)", () => {
  const segs = bandSegments(shell(status()), null);
  assert.deepEqual(texts(segs), ["⧗ feat/rate-limit", "review", "ci-pass ✓", "pr-merged ✗", "→ #deploy 自动 · 待 pr-merged"]);
  assert.deepEqual(segs.map((x) => x.tone), ["normal", "normal", "success", "dim", "dim"]);
});

test("a work item on another workflow than the default names its own after the item", () => {
  const segs = bandSegments(shell(status({ workflow: { name: "video", path: ".geml/workflows/video/flow.geml", title: "视频流程", default: "dev" } })), null);
  assert.deepEqual(texts(segs).slice(0, 3), ["⧗ feat/rate-limit", "流程 video", "review"]);
});

test("unavailable git evidence is yellow; a non-boolean variable shows its value; the final state says so", () => {
  const warned = bandSegments(shell(status({ gh: { available: false, reason: "gh is not installed" } })), null);
  assert.deepEqual(warned.at(-1), { text: "git 证据不可用：gh is not installed", tone: "warning" });
  assert.deepEqual(varSegment("order", "A-17"), { text: 'order="A-17"', tone: "normal" });
  assert.deepEqual(varSegment("n", undefined), { text: "n=null", tone: "normal" });
  assert.deepEqual(texts(bandSegments(shell(status({ state: { id: "done", title: "完成", rev: 9, uses: [], final: true }, next: [] }), { relevant: [] }), null)), ["⧗ feat/rate-limit", "done", "✓ 完成"]);
});

test("no work item, no workflow, a broken workflow, a broken bridge", () => {
  assert.deepEqual(bandSegments(shell(status({ item: { kind: "inactive", reason: "main · not tracked (work items are branches)" } })), null),
    [{ text: "⧗ main · not tracked (work items are branches)", tone: "dim" }]);
  assert.deepEqual(bandSegments({ status: null, policy: null, contextKey: null, problem: { text: "no workflow here: run `gemflow init`", quiet: true } }, null), [{ text: "没有流程", tone: "dim" }], "no workflow: the band says so instead of vanishing");
  assert.deepEqual(bandSegments({ status: null, policy: null, contextKey: null, problem: { text: "no workflow here", quiet: true }, suggest: { workflow: "dev", by: "deploy", file: "wrangler.toml" } }, null),
    [{ text: "没有流程", tone: "dim" }, { text: "建议 dev（wrangler.toml）", tone: "dim" }], "and names the bundled workflow that fits what the project holds");
  assert.deepEqual(bandSegments({ status: null, policy: null, contextKey: null, problem: { text: "no workflow here", quiet: true }, suggest: { workflow: "dev", by: "default" } }, null, null, null, wordsFor("en")),
    [{ text: "no workflow", tone: "dim" }, { text: "suggested: dev (default)", tone: "dim" }]);
  assert.deepEqual(bandSegments({ status: null, policy: null, contextKey: null, problem: { text: "flow.geml: statechart-initial: …", quiet: false } }, null),
    [{ text: "gemflow：flow.geml: statechart-initial: …", tone: "error" }]);
  assert.deepEqual(bandSegments(shell(status()), "gemflow：找不到 node — 请安装 Node ≥ 22"), [{ text: "gemflow：找不到 node — 请安装 Node ≥ 22", tone: "error" }]);
  assert.deepEqual(bandSegments(null, null), [{ text: "启动中…", tone: "dim" }], "before the bridge answers the band is already there");
});

test("no workflow: the band offers the suggested workflow with one press and the settings dialog for the rest; a bridge problem takes the offer away", () => {
  const shell = { status: null, policy: null, contextKey: null, problem: { text: "no workflow here", quiet: true }, suggest: { workflow: "coding", by: "code", file: "package.json" } };
  const input = (over = {}) => ({ shell, problem: null, setup: null, todo: null, inbox: [], timeline: [], now: NOW, t: wordsFor("zh"), ...over });
  const v = bandView(input());
  assert.deepEqual([v.verb, v.title, v.note], ["", "没有流程", "建议 coding（package.json）"]);
  assert.deepEqual(v.actions, [
    { key: "add-suggested", label: "添加 coding", primary: true, action: { op: "add", workflow: "coding" } },
    { key: "pick-workflow", label: "选流程", action: { op: "dialog", dialog: "settings" } },
  ]);
  assert.deepEqual(bandView(input({ problem: "gemflow：桥接没有应答（timed out）" })).actions, [], "the bridge is down: nothing to press into it");
  assert.deepEqual(bandView(input({ shell: { ...shell, suggest: undefined } })).actions, [], "an older CLI that suggests nothing: no offer");
});

test("the band's one thing: the first item waiting on the person, with its verb, its options and how many more wait", () => {
  const input = (over = {}) => ({ shell: shell(status()), problem: null, setup: null, todo: null, inbox: [], timeline: [], now: NOW, t: wordsFor("zh"), ...over });
  const option = (key, label, primary) => ({ key, label, ...(primary ? { primary: true } : {}), action: { op: "advance", to: key } });
  const inbox = [
    { kind: "approve", key: "a", verb: "验收", title: "看板显示每件事做出来的东西", detail: ["待验收", "通过：人验收通过。"], actions: [option("done", "通过", true), option("doing", "要改"), option("parked", "不通过"), option("noted", "重来")] },
    { kind: "tick", key: "t", verb: "勾", title: "accept-now", detail: [], actions: [] },
    { kind: "stuck", key: "s", verb: "被拦", title: "Bash(wrangler deploy)", detail: [], actions: [] },
  ];
  const v = bandView(input({ inbox }));
  assert.deepEqual([v.verb, v.title, v.detail], ["验收", "看板显示每件事做出来的东西", "待验收 · 通过：人验收通过。"]);
  assert.deepEqual(v.actions.map((a) => a.label), ["通过", "要改", "不通过"], "three options at most, the main one first");
  assert.deepEqual(v.more, { count: 2, detail: "勾 accept-now · 被拦 Bash(wrangler deploy)" });
  const working = bandView(input());
  assert.deepEqual([working.verb, working.title, working.note, working.actions, working.more.count], ["我在做", "feat/rate-limit", "评审", [], 0], "nothing waits on the person: what is being worked on, and in which stage");
  assert.equal(working.detail, "评审 · 下一步「部署」 · 自动", "the hover says the way on in the flow's words: no state id, no variable");
  const noted = bandView(input({ shell: shell(status({ next: [edge({ name: "review→deploy", to: "deploy", note: "已合并，CI 通过。", reads: ["pr-merged"], holds: false })] })) }));
  assert.equal(noted.detail, "评审 · 下一步「部署」：已合并，CI 通过。");
  const named = bandView(input({ shell: shell(status({ title: "状态带随时打开看板的入口" })) }));
  assert.equal(named.title, "状态带随时打开看板的入口", "a work item with a title goes by it");
  const held = bandView(input({ shell: shell(status({ paused: true })), inbox }));
  assert.deepEqual([held.verb, held.actions.map((a) => a.label), held.more.count], ["已暂停", ["继续"], 2], "a held item offers only 继续, and the rest still count");
  const done = bandView(input({ shell: shell(status({ state: { id: "done", title: "完成", rev: 9, uses: [], final: true } })) }));
  assert.deepEqual([done.verb, done.note], ["", "✓ 完成"]);
  const broken = bandView(input({ inbox: [{ kind: "broken", key: "broken", verb: "", title: "gemflow：桥接没有应答", detail: ["调用照常执行，什么都不记"], actions: [{ key: "retry", label: "重试", primary: true, action: { op: "retry" } }] }, ...inbox] }));
  assert.deepEqual([broken.title, broken.tone, broken.actions.map((a) => a.label), broken.more.count], ["gemflow：桥接没有应答", "error", ["重试"], 3], "a broken bridge comes first");
});

test("a media work item's to-do count shows for that item, in the stage it was read in, only (spec §7.2)", () => {
  const s = status({
    item: { kind: "item", id: "episodes/ep02" },
    state: { id: "assets", title: "素材", rev: 4, uses: ["image", "todo-check"] },
    vars: { "assets-done": false },
    sources: { "assets-done": "tool:todo-check" },
    next: [edge({ name: "assets→cut", to: "cut", reads: ["assets-done"], missing: ["assets-done"], holds: false })],
  });
  const sh = shell(s, { relevant: ["assets-done"] });
  assert.deepEqual(texts(bandSegments(sh, null, null, { item: "episodes/ep02", state: "assets", count: 7 })), ["⧗ episodes/ep02", "assets", "待办 7 项", "assets-done ✗", "→ #cut 自动 · 待 assets-done"]);
  assert.deepEqual(bandSegments(sh, null, null, { item: "episodes/ep02", state: "assets", count: 0 })[2], { text: "无待办", tone: "success" });
  assert.deepEqual(bandSegments(sh, null, null, { item: "episodes/ep02", state: "assets", count: 999 })[2], { text: "待办 999 项", tone: "normal" });
  assert.deepEqual(bandSegments(sh, null, null, { item: "episodes/ep02", state: "assets", count: 1000 })[2], { text: "待办 999+ 项", tone: "normal" }, "counted past the cap");
  const bare = ["⧗ episodes/ep02", "assets", "assets-done ✗", "→ #cut 自动 · 待 assets-done"];
  assert.deepEqual(texts(bandSegments(sh, null, null, { item: "episodes/ep01", state: "assets", count: 7 })), bare, "another item's count is not this one's");
  assert.deepEqual(texts(bandSegments(sh, null, null, { item: "episodes/ep02", state: "script", count: 7 })), bare, "a count read in another stage is stale here");
  assert.deepEqual(texts(bandSegments(sh, null)), bare);
  const cut = shell(status({ item: { kind: "item", id: "episodes/ep02" }, state: { id: "cut", title: "剪辑", rev: 6, uses: ["lay", "stale-check"] }, vars: { "no-stale": false }, sources: { "no-stale": "tool:stale-check" },
    next: [edge({ name: "cut→render", to: "render", reads: ["no-stale"], missing: ["no-stale"], holds: false })] }), { relevant: [] });
  assert.deepEqual(texts(bandSegments(cut, null, null, { item: "episodes/ep02", state: "assets", count: 0 })), ["⧗ episodes/ep02", "cut", "→ #render 自动 · 待 no-stale"], "the stage left #assets: the count read there goes");
});

test("cell widths: CJK and fullwidth punctuation take two cells; combining marks none", () => {
  assert.equal(cellWidth("review"), 6);
  assert.equal(cellWidth("流程"), 4);
  assert.equal(cellWidth("⧗ 评审：x"), 9);
  assert.equal(cellWidth("é"), 1);
});

test("truncate cuts on cells and never inside a wide character", () => {
  assert.equal(truncate("登录接口加限流", 14), "登录接口加限流");
  assert.equal(truncate("登录接口加限流", 7), "登录接…");
  assert.equal(truncate("登录接口加限流", 6), "登录…");
  assert.equal(truncate("abc", 0), "");
});

test("fitSegments keeps whole segments while they fit and cuts the first that does not", () => {
  const segs = [{ text: "⧗ feat/x", tone: "normal" }, { text: "review", tone: "normal" }, { text: "登录接口加限流", tone: "dim" }];
  assert.deepEqual(texts(fitSegments(segs, 20)), ["⧗ feat/x", "review"]);
  assert.deepEqual(texts(fitSegments(segs, 26)), ["⧗ feat/x", "review", "登录…"]);
  const all = fitSegments(segs, 200);
  assert.equal(all.reduce((w, s, i) => w + cellWidth(s.text) + (i > 0 ? cellWidth(SEP) : 0), 0), 8 + 3 + 6 + 3 + 14);
});

test("the next step's words: who takes it, and what a machine guard still waits for; each tone's drawing props", () => {
  assert.equal(nextText(edge({ to: "release", approval: true })), "→ #release 需批准");
  assert.equal(nextText(edge({ to: "build", judge: "model" })), "→ #build 手动");
  assert.equal(nextText(edge({ to: "b", judge: "none" })), "→ #b 手动");
  assert.equal(nextText(edge({ to: "review" })), "→ #review 自动");
  assert.equal(nextText(edge({ to: "review", reads: ["ready"], missing: ["ready"], holds: false })), "→ #review 自动 · 待 ready");
  assert.deepEqual([toneProps("dim"), toneProps("warning"), toneProps("normal")], [{ dimColor: true }, { color: "warning" }, {}]);
});

test("a registration that failed is said after the stage, and alone when there is no stage", () => {
  const setup = "gemflow：没有注册上 mcp__gemflow__status（a tool named status is already registered）";
  const segs = bandSegments(shell(status()), null, setup);
  assert.deepEqual(segs.at(-1), { text: setup, tone: "error" });
  assert.deepEqual(texts(segs).slice(0, 2), ["⧗ feat/rate-limit", "review"]);
  assert.deepEqual(bandSegments(null, null, setup), [{ text: "启动中…", tone: "dim" }, { text: setup, tone: "error" }]);
  assert.deepEqual(bandSegments({ status: null, policy: null, contextKey: null, problem: { text: "no workflow here", quiet: true } }, null, setup), [{ text: "没有流程", tone: "dim" }, { text: setup, tone: "error" }]);
  assert.deepEqual(bandSegments(shell(status()), "gemflow：桥接没有应答（timed out）", setup), [{ text: "gemflow：桥接没有应答（timed out）", tone: "error" }], "the bridge's problem first");
});
