import { test } from "node:test";
import assert from "node:assert/strict";
import { cellWidth } from "../dist/hosts/claude-code/band.js";
import { stepsOf, BOARD_ID, DIALOG_ID, HOME_TAB, ICON_CHAR, ICON_SVG, TAB_IDS, entryDetail, entryWords, flowRows, heldRows, inputAction, itemRows, journalRows, paneRows, projectPath, artifactsTag, rowFor, sessionRows, sourceWords, tabs, toolRows, toolSuggestions } from "../dist/hosts/claude-code/board.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const row = (tool, over = {}) => ({ tool, allow: [], deny: [], default: false, row: 0, ...over });
const ROWS = [
  row("Read", { allow: ["*"], row: 1 }),
  row("Edit", { for: "edit", default: true, row: 2 }),
  row("Bash(npm test)", { for: "test", default: true, row: 3 }),
  row("Bash(wrangler deploy)", { for: "deploy-prod", default: true, row: 4 }),
  row("WebFetch", { allow: ["build"], deny: ["review"], row: 5 }),
  row("mcp__img__*", { for: "image", default: true, params: { ratio: "9:16" }, row: 6 }),
  row("TodoWrite", { allow: ["build"], row: 7 }),
];
const NOW = "2026-10-12T09:10:00Z";
const BOARD = {
  unit: "branch",
  states: [
    { id: "build", title: "构建", description: "写代码和测试，直到测试通过。", initial: true, final: false, uses: ["edit", "test"] },
    { id: "review", title: "review", description: "", initial: false, final: false, uses: ["edit"] },
    { id: "deploy", title: "deploy", description: "", initial: false, final: false, uses: ["deploy-prod"] },
    { id: "done", title: "done", description: "", initial: false, final: true, uses: [] },
  ],
  transitions: [
    { name: "build→review", from: "build", to: "review", judge: "machine", approval: false, guard: "ready = true", note: "" },
    { name: "review→deploy", from: "review", to: "deploy", judge: "machine", approval: false, guard: "pr-merged = true and ci-pass = true", note: "" },
    { name: "review→build", from: "review", to: "build", judge: "model", approval: false, guard: "review 要求改动", note: "" },
    { name: "deploy→done", from: "deploy", to: "done", judge: "machine", approval: true, guard: "deployed = true", note: "" },
  ],
  fences: [{ use: "edit", states: ["build", "review"] }, { use: "test", states: ["build"] }, { use: "deploy-prod", states: ["deploy"] }, { use: "image", states: [] }],
  tools: ROWS,
  backlog: { key: "branch", items: [
    { id: "rate-limit", title: "登录接口加限流", target: "feat/rate-limit" },
    { id: "dark-mode", title: "设置页支持深色模式和高对比度主题", target: "" },
  ] },
  items: [{ id: "feat/rate-limit", state: "review", rev: 7, at: "2026-10-12T08:00:00Z", paused: false }, { id: "feat/x", state: "review", rev: 3, at: "2026-10-12T09:04:00Z", paused: false }],
  timeline: [
    { kind: "snapshot", rev: 0, at: "2026-10-12T09:00:00Z", state: "build", cause: "enter", changed: { "tests-pass": false, "pr-open": false } },
    { kind: "snapshot", rev: 1, at: "2026-10-12T09:01:02Z", state: "build", cause: "patch", by: "signal", signal: "tests-pass", call: "c7", tree: "tree:a1b2c3f", changed: { "tests-pass": true } },
    { kind: "refused", n: 1, rev: 1, at: "2026-10-12T09:03:00Z", tool: "Bash", reason: "`gemflow mark reviewed` is for a person", call: "c8" },
    { kind: "snapshot", rev: 3, at: "2026-10-12T09:04:00Z", state: "review", cause: "transition", by: "signal", signal: "pr-open", from: "build", changed: { "pr-open": true } },
  ],
  clocks: [{ name: "review-waited", iso: "PT2H", ms: 7_200_000 }],
  tree: "tree:a1b2c3f",
  picture: {
    flow: {
      ranks: [["build"], ["review"], ["deploy"], ["done"]],
      edges: [
        { name: "build→review", from: "build", to: "review", kind: "forward", label: "ready", sentence: false, marks: [] },
        { name: "review→deploy", from: "review", to: "deploy", kind: "forward", label: "ci-pass, pr-merged", sentence: false, marks: [] },
        { name: "review→build", from: "review", to: "build", kind: "lane", label: "review 要求改动", sentence: true, marks: [] },
        { name: "deploy→done", from: "deploy", to: "done", kind: "forward", label: "deployed", sentence: false, marks: ["approval"] },
      ],
    },
    overlay: { current: "review", holds: { "review→deploy": false }, counts: { review: 2 }, taken: ["build→review"], pressable: ["review→build"] },
    svg: "<svg/>",
  },
};
const next = (over) => ({ judge: "machine", approval: false, reads: [], missing: [], holds: true, note: "", ...over });
const status = (item = { kind: "item", id: "feat/x" }, over = {}) => ({
  workflow: { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程" }, item,
  state: { id: "review", title: "review", rev: 3, uses: ["edit"], final: false, since: "2026-10-12T09:04:00Z" },
  vars: { "review-done": false, "pr-merged": false, "ci-pass": false },
  sources: { "review-done": "human", "pr-merged": "git:pr-merged", "ci-pass": "git:ci-success" },
  next: [
    next({ name: "review→deploy", to: "deploy", guard: "pr-merged = true and ci-pass = true", reads: ["pr-merged", "ci-pass"], missing: ["pr-merged", "ci-pass"], holds: false }),
    next({ name: "review→build", to: "build", judge: "model", guard: "review 要求改动" }),
  ],
  refusals: 1, paused: false, gh: { available: true }, ...over,
});
const shell = (st) => ({ status: st, policy: { relevant: ["pr-merged", "ci-pass"] }, contextKey: "feat/x@3" });
const buttons = (rows) => rows.flatMap((r) => (r.kind === "button" ? [r] : r.kind === "buttons" ? r.items : []));
const widths = (rows) => rows.filter((r) => r.kind === "text" || r.kind === "button").map((r) => cellWidth(r.kind === "text" ? r.text : r.label));
const pane = (over = {}) => paneRows({
  board: BOARD, problem: null, shell: shell(status()), tab: "flow", columns: 100, maxRows: 20, t: wordsFor("zh"), now: NOW, root: "/w/app",
  inbox: [], filter: "all", expanded: null, evidence: null, prompts: [], menu: null, sessionFlow: null, sessionRuns: [], doneOpen: false, flowState: null, switching: false, workflows: null,
  usage: {}, dismissed: [], toolQuery: "", toolMenu: null, toolNaming: null, toolsOpen: [], ...over,
});
/** A work items tab's rows in a line each: a heading, a card, a list entry (→ when it can be pressed), a line, a button. */
const look = (rows) => rows.map((r) => r.kind === "section" ? `§ ${r.text}${r.count !== undefined ? ` ${r.count}` : ""}${r.fold !== undefined ? ` [${r.fold.label}]` : ""}`
  : r.kind === "card" ? `${r.icon} ${r.verb} ${r.title}${r.tag !== undefined ? ` (${r.tag})` : ""} | ${r.detail.join(" / ")} | ${r.actions.map((a) => a.label).join(" ")}`
  : r.kind === "entry" ? `${r.action !== undefined ? "→ " : ""}${r.title} (${r.tag})`
  : r.kind === "text" ? r.text : r.kind === "button" ? `[${r.label}]` : r.kind);
const flow = (over = {}) => flowRows({ board: BOARD, status: status(), columns: 100, t: wordsFor("zh"), now: NOW, selected: null, switching: false, workflows: null, ...over });
const pic = (rows) => rows.find((r) => r.kind === "flow");
const items = (over = {}) => itemRows({ board: BOARD, status: status(), inbox: [], columns: 80, t: wordsFor("zh"), now: NOW, doneOpen: false, ...over });

test("the board's id, the dialog's, and its five tabs in order, opening on the work items (spec §8.2)", () => {
  assert.equal(BOARD_ID, "gemflow-board");
  assert.equal(DIALOG_ID, "gemflow-dialog");
  assert.deepEqual(TAB_IDS, ["sessions", "items", "journal", "flow", "tools"]);
  assert.equal(HOME_TAB, "items");
  assert.deepEqual(tabs().map((x) => [x.id, x.label]), [["sessions", "会话"], ["items", "工作项"], ["journal", "记录"], ["flow", "流程"], ["tools", "工具"]]);
  assert.deepEqual(tabs(wordsFor("en")).map((x) => x.label), ["Session", "Items", "Journal", "Flow", "Tools"]);
});

test("流程: the flow by its title, the picture, a row of its states, and the one picked — its uses and their tools, what it may not use, what runs everywhere", () => {
  const rows = flow();
  const p = pic(rows);
  assert.equal(p.key, "flow-picture");
  assert.equal(p.svg, "<svg/>", "the markup travels for a host that inlines it");
  assert.deepEqual(p.ranks, [
    [{ id: "build", title: "构建", initial: true, final: false, current: false, count: 0, uses: ["edit", "test"] }],
    [{ id: "review", title: "review", initial: false, final: false, current: true, count: 2, uses: ["edit"] }],
    [{ id: "deploy", title: "deploy", initial: false, final: false, current: false, count: 0, uses: ["deploy-prod"] }],
    [{ id: "done", title: "done", initial: false, final: true, current: false, count: 0, uses: [] }],
  ], "the parser's ranks joined with the board's words; two items in the current state are a badge, one would not be");
  assert.deepEqual(p.edges, [
    { name: "build→review", from: "build", to: "review", kind: "forward", back: false, text: "自动  要求 ready = true", approval: false, taken: true },
    { name: "review→deploy", from: "review", to: "deploy", kind: "forward", back: false, text: "自动  要求 pr-merged = true and ci-pass = true（未满足）", holds: false, approval: false, taken: false },
    { name: "review→build", from: "review", to: "build", kind: "lane", back: true, text: "手动  当 review 要求改动", approval: false, taken: false, press: { n: 1, action: { op: "advance", to: "build" } } },
    { name: "deploy→done", from: "deploy", to: "done", kind: "forward", back: false, text: "需批准  要求 deployed = true", approval: true, taken: false },
  ], "a way out whose condition does not hold is drawn, not offered: the advance would be refused");
  const look = (rs) => rs.map((r) => r.kind === "heading" ? `# ${r.text}${r.sub ? ` (${r.sub})` : ""}${r.action ? ` [${r.action.label}]` : ""}`
    : r.kind === "section" ? `§ ${r.text}` : r.kind === "entry" ? `${r.title} | ${r.tag}` : r.kind === "buttons" ? r.items.map((b) => `${b.label}${b.primary ? "*" : ""}`).join(" ")
    : r.kind === "text" ? r.text : r.kind);
  assert.deepEqual(look(rows), [
    "# 开发流程 (dev) [换一个 ▾]",
    "flow",
    "构建 review* deploy done",
    "# review (此刻在这里)",
    "§ 这里能用",
    "改文件 | Edit",
    "哪里都能用 | Read",
    "§ 这里不能用",
    "跑测试 | 只在构建",
    "部署到 production | 只在deploy",
    "出图 | 哪一格都没有",
    "WebFetch | 词典里拒绝",
    "没归类的工具哪里都照常能用。",
    "review-waited：停留满 PT2H  还有 1 小时 54 分",
  ], "the current state is picked at first; its clock, counted from its entry");
  assert.deepEqual(rows[2].items.map((b) => b.action), ["build", "review", "deploy", "done"].map((id) => ({ op: "flow-state", id })));
  assert.deepEqual(look(flow({ selected: "build" })).slice(2, 11), [
    "构建* review deploy done", "# 构建", "写代码和测试，直到测试通过。", "§ 这里能用", "改文件 | Edit", "跑测试 | npm test", "哪里都能用 | Read", "§ 这里不能用", "部署到 production | 只在deploy",
  ], "another state, picked: its description, its uses with the commands bound to them");
  assert.equal(rows[0].action.action.op, "flow-switch");
});

test("流程: switching — the installed workflows to use, the bundled ones to add, a path to import; the suggestions about the flow on top; a person's ticks on the current state", () => {
  const look = (rs) => rs.map((r) => r.kind === "buttons" ? r.items.map((b) => `${b.label}${b.primary ? "*" : ""}`).join(" ") : r.kind === "text" ? r.text : r.kind === "input" ? `[${r.placeholder}]` : r.kind === "heading" ? `# ${r.text} [${r.action?.label}]` : r.kind);
  assert.deepEqual(look(flow({ switching: true, workflows: { bundled: ["dev", "matter", "video"], installed: ["dev", "matter"] } })).slice(0, 4), [
    "# 开发流程 [收起]", "dev* matter 添加 video", "换了以后，新的工作项走它；已经开始的照旧。", "[导入：流程文件或目录的路径]",
  ]);
  const opened = flow({ switching: true, workflows: { bundled: ["dev", "matter"], installed: ["dev"] } })[1].items.map((b) => b.action);
  assert.deepEqual(opened, [{ op: "use", workflow: "dev" }, { op: "add", workflow: "matter" }]);
  assert.deepEqual(look(flow({ switching: true })).slice(1, 3), ["正在读取…", "[导入：流程文件或目录的路径]"], "the workflows not read yet");
  const board = { ...BOARD, items: [...BOARD.items, { id: ".geml/matters/mock", state: "deciding", rev: 2, at: NOW, paused: false, file: ".geml/matters/mock.geml", title: "开发流程在构建前加一格「样稿」", about: "flow", gist: "先给你看样子，点头再实现。", asks: [{ to: "doing", label: "按方案做", note: "", final: false }] }] };
  const card = flow({ board }).find((r) => r.kind === "card");
  assert.deepEqual([card.verb, card.title, card.tag, card.detail, card.actions.map((a) => a.label)], ["决定", "开发流程在构建前加一格「样稿」", "建议 · 流程", ["先给你看样子，点头再实现。"], ["按方案做"]]);
  const gate = status(undefined, { next: [next({ name: "review→done", to: "done", reads: ["review-done"], missing: ["review-done"], holds: false })] });
  const ticks = flow({ status: gate });
  const at = ticks.findIndex((r) => r.key === "ticks");
  assert.deepEqual([ticks[at].text, ticks[at + 1].items.map((b) => [b.label, b.action])], ["你来勾", [["[ ] review-done", { op: "mark", variable: "review-done", checked: true }]]]);
  assert.ok(!flow({ status: { ...gate, paused: true } }).some((r) => r.key === "ticks"), "a held work item takes no tick");
  assert.ok(flow({ status: gate, selected: "build" }).every((r) => r.key !== "ticks"), "ticks belong to the current state");
  assert.equal(projectPath("C:\\w\\app", ".geml/workflows/dev/flow.geml"), "C:/w/app/.geml/workflows/dev/flow.geml");
  assert.equal(projectPath("/w/app", "/Users/me/Downloads/session-abc.geml"), "/Users/me/Downloads/session-abc.geml", "a path outside the project is its own");
  assert.equal(projectPath("C:\\w\\app", "D:/out/s.geml"), "D:/out/s.geml");
});

test("the flow picture: held, or no item, nothing is pressable; the words follow the language; a state the board does not know is left out", () => {
  const held = pic(flow({ status: status(undefined, { paused: true }) }));
  assert.ok(held.edges.every((e) => e.press === undefined), "a person holds the work: no way out is offered");
  const none = pic(flow({ status: null }));
  assert.ok(none.ranks.flat().every((s) => !s.current) && none.edges.every((e) => e.press === undefined));
  assert.equal(pic(flow({ t: wordsFor("en") })).edges[2].text, "manual  when review 要求改动");
  const stray = { ...BOARD, picture: { ...BOARD.picture, flow: { ranks: [["build", "ghost"], ["review"], ["deploy"], ["done"]], edges: [...BOARD.picture.flow.edges, { name: "ghost→done", from: "ghost", to: "done", kind: "lane", label: "", sentence: false, marks: [] }] } } };
  const rows = pic(flow({ board: stray }));
  assert.deepEqual(rows.ranks[0].map((s) => s.id), ["build"]);
  assert.ok(!rows.edges.some((e) => e.name === "ghost→done"));
  assert.deepEqual(flow({ board: stray }).find((r) => r.kind === "buttons").items.map((b) => b.label), ["构建", "review", "deploy", "done"], "a state the board does not know has no button");
});

test("工作项: what waits on the person on top, one card each with its options; then the work items by where they ended up — being worked on, merged, closed and dropped counted and listed on a press; then the backlog", () => {
  const approve = { kind: "approve", key: "approve-review", verb: "决定", title: "feat/x", detail: ["review · pr-merged ✓"], since: "2026-10-12T08:58:00Z", actions: [{ key: "approve-deploy", label: "部署", primary: true, action: { op: "advance", to: "deploy", say: "部署：feat/x" } }] };
  const stuck = { kind: "stuck", key: "stuck-wrangler", verb: "被拦", title: "Bash(wrangler deploy)", detail: ["x"], actions: [] };
  const board = { ...BOARD, items: [
    { id: "feat/x", state: "review", rev: 3, at: "2026-10-12T09:04:00Z", paused: false },
    { id: ".geml/matters/pi", state: "build", rev: 2, at: "2026-10-12T08:30:00Z", paused: false, file: ".geml/matters/pi.geml", title: "pi 和 DSH 也记下写过的文件吗",
      asks: [{ to: "deploy", label: "直接做", note: "小事", final: false }, { to: "review", label: "先放着", note: "", final: false }] },
    { id: "feat/other", state: "deploy", rev: 9, at: "2026-10-12T08:20:00Z", paused: false, asks: [{ to: "done", label: "通过", note: "人验收通过。", final: true }] },
    { id: "feat/rate-limit", state: "review", rev: 7, at: "2026-10-12T08:00:00Z", paused: false },
    { id: ".geml/matters/old", state: "build", rev: 1, at: "2026-10-12T07:00:00Z", paused: true, file: ".geml/matters/old.geml", by: "model" },
    { id: "feat/shipped", state: "done", rev: 12, at: "2026-10-12T08:10:00Z", paused: false },
  ] };
  const rows = items({ board, inbox: [approve, stuck] });
  assert.deepEqual(look(rows), [
    "§ 待处理",
    "ask 决定 feat/x | review · pr-merged ✓ | 部署",
    "ask 决定 pi 和 DSH 也记下写过的文件吗 (构建) | 直接做：小事 | 直接做 先放着",
    "done 验收 feat/other (deploy) | 通过：人验收通过。 | ",
    "warn 被拦 Bash(wrangler deploy) | x | ",
    "§ 在做 2",
    "feat/rate-limit (review)",
    "→ .geml/matters/old (模型提出 · 构建 · 已暂停)",
    "§ 已合并 0",
    "§ 已收尾 1 [展开]",
    "§ 放下 0",
    "§ 待办与进行中",
    "  rate-limit  登录接口加限流 → feat/rate-limit · #review",
    "backlog 中 1 项未关联工作项",
    "[绑定 dark-mode（设置页支持深色模式和高对比度主题）到 feat/x]",
  ], "the current work item waits on the person, so it is a card and not in the queue; a work item with no file is shown without options");
  const pi = rows.find((r) => r.key === "asks-.geml/matters/pi");
  assert.deepEqual(pi.actions.map((a) => [a.key, a.primary ?? false, a.action]), [
    ["asks-.geml/matters/pi-deploy", true, { op: "advance", to: "deploy", file: ".geml/matters/pi.geml", say: "直接做：pi 和 DSH 也记下写过的文件吗" }],
    ["asks-.geml/matters/pi-review", false, { op: "advance", to: "review", file: ".geml/matters/pi.geml", say: "先放着：pi 和 DSH 也记下写过的文件吗" }],
  ], "another work item's option is taken on its file, and says what was chosen");
  assert.equal(rows.find((r) => r.key === "item-.geml/matters/old").action.op, "switch-file");
  assert.equal(rows.find((r) => r.key === "item-.geml/matters/old").tone, "warning");
  const open = items({ board, inbox: [approve, stuck], doneOpen: true });
  assert.deepEqual(look(open).slice(9, 11), ["§ 已收尾 1 [收起]", "feat/shipped (done)"]);
  assert.deepEqual(open.find((r) => r.kind === "section" && r.key === "done").fold.action, { op: "fold", what: "done", open: false });
  const working = look(items({ board, inbox: [stuck] }));
  assert.deepEqual(working.slice(4, 6), ["§ 在做 3", "feat/x (当前 · review)"], "nothing of the current work item waits on the person: it heads the queue, being worked on");
  const made = { ...board, artifacts: { item: "feat/x", written: [], commits: [{ sha: "053f317c9d0e1f2a", at: NOW, subject: "feat: band", files: [], ours: true }] } };
  assert.equal(look(items({ board: made, inbox: [approve] }))[1], "ask 决定 feat/x (053f317c) | review · pr-merged ✓ | 部署", "the work the current item made, as the tag of its card");
  assert.equal(look(items({ board: made, inbox: [] })).find((x) => x.startsWith("feat/x")), "feat/x (当前 · review · 053f317c)");
  assert.deepEqual(look(items({ board: { ...board, items: [], backlog: null }, status: null })), ["§ 待处理", "暂无", "§ 在做 0", "  没有", "§ 已合并 0", "§ 已收尾 0", "§ 放下 0"]);
  assert.deepEqual(look(items({ board: null, inbox: [stuck] })), ["§ 待处理", "warn 被拦 Bash(wrangler deploy) | x | "], "before the board is read, what waits on the person still shows");
  const accept = { ...approve, verb: "验收", closes: true };
  assert.equal(items({ board, inbox: [accept] })[1].icon, "done", "accepting the work has its own icon");
  const said = { ...board, items: board.items.map((i) => (i.id === "feat/x" ? { ...i, gist: "状态带加了看板按钮。" } : i)) };
  assert.deepEqual(items({ board: said, inbox: [approve] })[1].detail, ["状态带加了看板按钮。"], "the current work item's card says what it says of itself");
});

test("what the work made, in a word: its one commit, how many, or how many files it wrote", () => {
  const commit = (sha, ours = true) => ({ sha, at: NOW, subject: "s", files: [], ours });
  assert.equal(artifactsTag({ item: "x", written: [], commits: [commit("053f317c9d0e"), commit("1111111122", false)] }), "053f317c");
  assert.equal(artifactsTag({ item: "x", written: [], commits: [commit("a"), commit("b")] }, wordsFor("en")), "2 commits");
  assert.equal(artifactsTag({ item: "x", written: [{ path: "a", rev: 1, at: NOW, tool: "Edit" }], commits: [] }), "1 个文件");
  assert.equal(artifactsTag({ item: "x", written: [], commits: [] }), undefined);
  assert.equal(artifactsTag(undefined), undefined);
});

test("the icons: a line drawing each in its own colour, and a character for a surface without pictures", () => {
  for (const k of ["ask", "done", "warn"]) assert.match(ICON_SVG[k], /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"[^>]* stroke="#[0-9a-f]{6}"[^>]*><circle /);
  assert.deepEqual(ICON_CHAR, { ask: "?", done: "✓", warn: "!" });
});

test("工具: every tool by kind, with its use and how often it ran — the ones that ran first, nothing folded; a press opens its menu", () => {
  const usage = { "Bash(node --test)": 46, "Bash(git commit)": 18, "Bash(npm test)": 7, Edit: 139, "mcp__gemflow__*": 3, "mcp__visualize__*": 11 };
  const tools = (over = {}) => toolRows({ board: BOARD, columns: 100, t: wordsFor("zh"), usage, suggestions: [], query: "", menu: null, naming: null, open: [], ...over });
  const look = (rows) => rows.map((r) => r.kind === "tool" ? [r.name, r.use, r.guess, r.count].filter((x) => x !== "").join(" | ")
    : r.kind === "section" ? `§ ${r.text}` : r.kind === "button" ? `[${r.label}]` : r.kind === "buttons" ? r.items.map((b) => `${b.label}${b.primary ? "*" : ""}`).join(" ") : r.kind === "input" ? `[${r.placeholder}]` : r.text);
  assert.deepEqual(look(tools()), [
    "[找工具]",
    "§ 命令行",
    "node --test | 没归类 | 像跑测试？ | 46 次",
    "git commit | 没归类 | 18 次",
    "npm test | 跑测试（首选） | 7 次",
    "wrangler deploy | 部署到 production（首选） | 0",
    "§ 文件",
    "Edit | 改文件（首选） | 139 次",
    "Read | 哪里都能用 | 0",
    "§ MCP",
    "visualize | 没归类 | 11 次",
    "gemflow | gemflow 自己的 | 3 次",
    "img | 出图（首选） | 0",
    "§ 网页请求",
    "WebFetch | 没归类 | 0",
    "§ 其他",
    "TodoWrite | 没归类 | 0",
    "§ Skill · 模型服务",
    "这两天都没用过",
    "次数是这两天真实用过的。没归类的工具在每个阶段都照常能用；点一行可以给它归类。",
  ], "what ran first, by how often; a use's preferred tool that did not run next; every other one after, nothing folded");
  const rows = tools();
  assert.deepEqual(rows.find((r) => r.name === "node --test").action, { op: "tool-menu", key: "Bash(node --test)" });
  assert.equal(rows.find((r) => r.name === "gemflow").action, undefined, "gemflow's own tools take no classifying");
  const menu = tools({ menu: "Bash(npm test)" });
  const at = menu.findIndex((r) => r.name === "npm test");
  assert.deepEqual(look(menu.slice(at + 1, at + 4)), ["  归类为", "改文件 跑测试* 部署到 production 出图 新用途…", "删掉这一行 取消"], "classify as any of the flow's uses or a new one; a preferred row is not made preferred again");
  assert.deepEqual(menu[at + 2].items[0].action, { op: "learn", lessons: [{ kind: "use", key: "Bash(npm test)", use: "edit" }] });
  assert.deepEqual(menu[at + 3].items[0].action, { op: "learn", lessons: [{ kind: "forget", key: "Bash(npm test)" }], confirm: { question: "删掉 Bash(npm test) 这一行？之后它按没归类的工具处理。", yes: "删掉" } }, "deleting a row asks first");
  const loose = tools({ menu: "Bash(git commit)", naming: "Bash(git commit)" });
  const lat = loose.findIndex((r) => r.name === "git commit");
  assert.deepEqual(loose[lat + 3], { kind: "input", key: "new-use-Bash(git commit)", placeholder: "git commit 的新用途", field: "new-use", target: "Bash(git commit)" });
  assert.deepEqual(look([loose[lat + 4]]), ["取消"], "a tool with no row has nothing to prefer or take out");
  assert.deepEqual(inputAction("new-use", " commit ", "Bash(git commit)"), { op: "learn", lessons: [{ kind: "use", key: "Bash(git commit)", use: "commit" }] });
  assert.deepEqual(inputAction("tool-search", "git"), { op: "tool-search", query: "git" });
  assert.deepEqual(inputAction("add-tool", " Bash(cargo test) | test "), { op: "learn", lessons: [{ kind: "use", key: "Bash(cargo test)", use: "test" }] });
  assert.deepEqual(inputAction("add-tool", "Read"), { op: "learn", lessons: [{ kind: "allow", key: "Read", where: "*" }] });
  assert.equal(inputAction("add-tool", "  "), undefined);
  const busy = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Bash(tool${i})`, 20 - i]));
  const many = look(toolRows({ board: { ...BOARD, tools: [] }, columns: 100, t: wordsFor("zh"), usage: busy, suggestions: [], query: "", menu: null, naming: null, open: [] }));
  assert.deepEqual(many.slice(2, 11), ["tool0 | 没归类 | 20 次", "tool1 | 没归类 | 19 次", "tool2 | 没归类 | 18 次", "tool3 | 没归类 | 17 次", "tool4 | 没归类 | 16 次", "tool5 | 没归类 | 15 次", "tool6 | 没归类 | 14 次", "tool7 | 没归类 | 13 次", "tool8 | 没归类 | 12 次"], "all of them, the most run first: none folded");
  assert.deepEqual(look(tools({ query: "GIT" })).slice(1, 3), ["§ 命令行", "git commit | 没归类 | 18 次"], "the search narrows to what matches, folded ones too");
  assert.equal(look(tools({ query: "nothing-like-this" })).at(-2), "没有对得上的工具");
});

test("工具: a command that ran with no row to take it, looking like the flow's test, is a suggestion to count it so; one put away is not asked again", () => {
  const usage = { "Bash(node --test)": 46, "Bash(npx vitest)": 2, "Bash(git commit)": 18, "Bash(npm test)": 7 };
  const [s, ...rest] = toolSuggestions(BOARD, usage, [], wordsFor("zh"));
  assert.deepEqual(rest, [], "two runs are not enough; a command with a row, or that looks like nothing, is no suggestion");
  assert.deepEqual([s.kind, s.verb, s.title, s.tag, s.detail], ["suggest", "决定", "node --test 算作跑测试", "建议 · 工具", ["这两天跑了 46 次，一次都没记成跑测试。"]]);
  assert.deepEqual(s.actions.map((a) => [a.label, a.action]), [["算", { op: "learn", lessons: [{ kind: "use", key: "Bash(node --test)", use: "test" }] }], ["不算", { op: "dismiss", key: "Bash(node --test)" }]]);
  assert.deepEqual(toolSuggestions(BOARD, usage, ["Bash(node --test)"], wordsFor("zh")), []);
  assert.equal(toolRows({ board: BOARD, columns: 100, t: wordsFor("zh"), usage, suggestions: [s], query: "", menu: null, naming: null, open: [] })[1].kind, "card", "the tools tab shows its own suggestions under the search");
  assert.deepEqual(look2(items({ suggestions: [s] })), "决定 node --test 算作跑测试", "the work items tab's pending group too");
  assert.equal(rowFor("Bash(wrangler deploy --env staging)", [{ tool: "Bash(wrangler deploy*--env staging)", allow: [], deny: [], default: false, row: 1 }, { tool: "Bash(wrangler deploy*)", allow: [], deny: [], default: false, row: 2 }]).row, 1, "the longest literal pattern takes it");
  assert.equal(rowFor("Bash(npm test)", BOARD.tools).tool, "Bash(npm test)");
  assert.equal(rowFor("Bash(npm run build)", BOARD.tools), undefined);
});
const look2 = (rows) => { const c = rows.find((r) => r.kind === "card"); return `${c.verb} ${c.title}`; };

test("工作项 by the outline: each with where it is and what it has; a merged one still checked out is a card to close, which asks first and can be left; the dropped listed on a press", () => {
  const board = { ...BOARD, backlog: null, items: [
    { id: "feat/x", state: "review", rev: 3, at: "2026-10-12T09:04:00Z", paused: false, end: "doing", worktree: "../geml-gemflow", commits: 36 },
    { id: "feat/runtime", state: "build", rev: 2, at: "2026-10-09T09:00:00Z", paused: false, end: "merged", worktree: "../geml-agent-runtime", commits: 13, pr: { number: 32, state: "merged" } },
    { id: "claude/try", state: "build", rev: 0, at: "2026-10-12T01:42:00Z", paused: false, end: "dropped", commits: 0 },
    { id: "feat/old", state: "deploy", rev: 9, at: "2026-10-01T08:00:00Z", paused: false, end: "closed", commits: 4 },
  ] };
  const rows = items({ board, dismissed: [] });
  assert.deepEqual(look(rows), [
    "§ 待处理",
    "done  feat/runtime 已合并 | 已合入 main（PR #32） / 收尾将删除 worktree geml-agent-runtime 及本地分支（仅当提交已全部合入 main）。 | 收尾 保留",
    "§ 在做 1",
    "feat/x (当前 · review)",
    "§ 已合并 1",
    "feat/runtime ()",
    "§ 已收尾 1 [展开]",
    "§ 放下 1 [展开]",
  ]);
  const card = rows.find((r) => r.key === "close-feat/runtime");
  assert.deepEqual(card.actions.map((a) => a.action), [{ op: "close-item", id: "feat/runtime", worktree: "../geml-agent-runtime" }, { op: "dismiss", key: "close-feat/runtime" }]);
  assert.deepEqual(rows.filter((r) => r.kind === "entry").map((r) => [r.title, r.detail, r.current ?? false]), [
    ["feat/x", "geml-gemflow · 36 个提交 · 6 分钟前", true],
    ["feat/runtime", "geml-agent-runtime · 13 个提交 · PR #32 已合并 · 3 天前", false],
  ]);
  assert.equal(look(items({ board, dismissed: ["close-feat/runtime"] }))[1], "暂无", "left as it is: not asked again");
  const open = items({ board, droppedOpen: true, dismissed: [] });
  assert.deepEqual(open.filter((r) => r.kind === "entry").at(-1), { kind: "entry", key: "item-claude/try", title: "claude/try", tag: "构建", tone: "dim", detail: "分支已删除 · 无提交 · 7 小时前" });
  assert.deepEqual(open.find((r) => r.key === "dropped").fold.action, { op: "fold", what: "dropped", open: false });
});

test("记录: the filters, the work item and its flow, then what happened newest first under its day — no evidence, no stage changes, no export", () => {
  const st = status(undefined, { sources: { "tests-pass": "tool:test", "pr-open": "git:pr-open", "review-done": "human" } });
  const prompts = [
    { id: "p1", at: "2026-10-12T09:00:30Z", text: "把测试补上", tools: 3, refusals: 1, entered: [], signals: [] },
    { id: "p2", at: "2026-10-12T09:03:30Z", text: "开 PR", tools: 1, refusals: 0, entered: [], signals: [] },
  ];
  const journal = (over = {}) => journalRows({ board: BOARD, status: st, filter: "all", menu: null, evidence: null, prompts, columns: 100, maxRows: 40, t: wordsFor("zh"), now: NOW, ...over });
  const look = (rows) => rows.map((r) => r.kind === "event" ? [r.label, r.text, r.why, r.turn.replace(/\d\d:\d\d/, "HH:MM")].filter((x) => x !== "").join(" | ")
    : r.kind === "section" ? `§ ${r.text}` : r.kind === "buttons" ? r.items.map((b) => `${b.label}${b.primary ? "*" : ""}`).join(" ") : r.kind === "text" ? r.text : r.kind);
  assert.deepEqual(look(journal()), [
    "全部* 被拦",
    "feat/x · 开发流程",
    "§ 今天",
    "被拦 | Bash | `gemflow mark reviewed` is for a person | 提示词 HH:MM「把测试补上」",
  ], "the stage's own revisions (evidence, stage changes, the start) are the journal file's, not the tab's");
  const menu = journal({ menu: "refused-1" });
  const at = menu.findIndex((r) => r.key === "refused-1");
  assert.deepEqual(menu[at + 1].items.map((b) => [b.label, b.action]), [
    ["跳到对话", { op: "locate", id: "p1" }], ["详情", { op: "evidence", entry: "refused-1" }], ["取消", { op: "expand", entry: null }],
  ], "a press opens the entry's menu under it; nothing to go back to");
  assert.deepEqual(menu[at].action, { op: "expand", entry: null });
  const shown = journal({ menu: "refused-1", evidence: "refused-1" });
  const row = shown.find((r) => r.key === "refused-1");
  assert.deepEqual([row.open, row.detail], [true, ["`gemflow mark reviewed` is for a person", "哪次调用：c8"]]);
  assert.equal(shown[shown.indexOf(row) + 1].items[1].label, "收起");
  assert.deepEqual(look(journal({ filter: "moves" })).slice(0, 1), ["全部* 被拦"], "a filter the tab no longer has shows everything");
  assert.deepEqual(look(journal({ filter: "artifacts" })).slice(0, 1), ["全部* 被拦"], "commits are git's: no 产物 filter, a kept one shows everything");
  assert.deepEqual(journalRows({ board: { ...BOARD, timeline: [] }, status: st, filter: "all", menu: null, evidence: null, prompts: [], columns: 80, maxRows: 10, t: wordsFor("zh") }).at(-1), { kind: "text", text: "暂无", tone: "dim" });
  assert.ok(journal({ maxRows: 4 }).length <= 4, "the entries fit the rows");
  assert.ok(!journal().some((r) => r.kind === "buttons" && r.items.some((b) => b.action.op === "export")), "no export here");
});

test("记录: commits are git's, so the journal lists none, whatever the work item made", () => {
  const artifacts = { item: "feat/x", written: [], commits: [{ sha: "7a38c1fd00000000", at: "2026-10-12T09:02:40Z", subject: "feat: x", files: ["src/board.ts"], ours: true }, { sha: "1111111122222222", at: "2026-10-12T09:02:20Z", subject: "docs: other", files: ["README.md"], ours: false }] };
  const rows = journalRows({ board: { ...BOARD, artifacts }, status: status(), filter: "all", menu: null, evidence: null, prompts: [], columns: 100, maxRows: 40, t: wordsFor("zh"), now: NOW });
  assert.ok(!rows.some((r) => r.kind === "event" && r.label === "产物"), "no commit entry");
  assert.ok(!rows.some((r) => r.kind === "text" && /同期另有/.test(r.text)), "no count of the other commits");
});

test("记录: where a value came from, and what an entry says, in the flow's words", () => {
  const t = wordsFor("zh");
  assert.deepEqual(["tool:test", "git:pr-open", "git:committed", "file:out/*.mp4", "human", "elapsed:PT2H", undefined].map((s) => sourceWords(s, t)), ["跑 test 得来", "gh 查到的", "git 查到的", "文件 out/*.mp4 已生成", "你勾的", "已到期", "模型写的"]);
  const words = (e, sources = { "review-ready": "human" }) => entryWords({ kind: "snapshot", rev: 5, at: NOW, ...e }, BOARD, sources, t);
  assert.deepEqual(words({ state: "review", cause: "transition", by: "signal", signal: "review-ready", from: "build", changed: { "review-ready": true } }), { label: "阶段变更", text: "构建 → review · 自动", why: "凭：review-ready 被勾上", tone: "normal" });
  assert.equal(words({ state: "build", cause: "transition", by: "model", from: "review" }).text, "review → 构建 · 模型判「review 要求改动」");
  assert.equal(words({ state: "deploy", cause: "transition", by: "human", from: "review" }).text, "review → deploy · 你");
  assert.deepEqual(words({ state: "build", cause: "rollback", by: "human", restores: 2 }), { label: "阶段变更", text: "回到构建 · 你", why: "恢复第 2 条修订", tone: "normal" });
  assert.deepEqual(words({ state: "review", cause: "patch", by: "human", changed: { "review-ready": false } }), { label: "凭据", text: "review-ready 被取消", why: "你勾的", tone: "normal" });
  assert.deepEqual(words({ state: "review", cause: "expire", changed: { "tests-pass": false } }), { label: "凭据", text: "tests-pass 已失效", why: "内容已变更", tone: "dim" });
  assert.deepEqual(entryWords({ kind: "refused", n: 2, rev: 5, at: NOW, tool: "Bash", key: "Bash(git push*)", reason: "push is release, used only in #release; switching the work item is always allowed: x" }, BOARD, {}, t), { label: "被拦", text: "Bash(git push*)", why: "push is release, used only in #release", tone: "error" });
  assert.deepEqual(entryDetail({ kind: "refused", n: 2, rev: 5, at: NOW, tool: "Bash", reason: "r", call: "c9" }, BOARD, t), ["r", "哪次调用：c9"]);
});

test("会话: every prompt newest first under its day, with what its turn did and its icons; a press unfolds it, the one unfolded before folds", () => {
  const prompts = [
    { id: "p0", at: "2026-10-11T03:10:00Z", text: "昨天的事", tools: 2, refusals: 0, entered: [], signals: [], did: "改好了。" },
    { id: "p1", at: "2026-10-12T09:00:10Z", text: "把限流中间件的测试补上，然后开 PR。\n第二行", state: "build", tools: 7, refusals: 0, entered: [], signals: [], did: "测试补上了，PR 已开。" },
    { id: "p2", at: "2026-10-12T09:03:10Z", text: "并发那个用例用 fake timer。", state: "build", tools: 4, refusals: 0, entered: ["review"], signals: ["tests-pass"] },
    { id: "p3", at: "2026-10-12T09:05:00Z", text: "顺手部署一下。", state: "review", tools: 0, refusals: 0, entered: [], signals: [] },
  ];
  const commits = [{ sha: "e18b116d00000000", at: "2026-10-12T09:04:00Z" }, { sha: "7a38c1fd00000000", at: "2026-10-12T09:02:00Z" }, { sha: "053f317c9d0e1f2a", at: "2026-10-12T09:01:00Z" }];
  const rows = sessionRows(prompts, commits, wordsFor("zh"), 100, NOW, { flow: null, runs: [], expanded: { id: "p2", answer: "用了 fake timer。" } });
  const look = rows.map((r) => r.kind === "section" ? `§ ${r.text}` : r.kind === "turn" ? `${r.text} | ${r.did}${r.open ? " ▾" : ""}` : r.kind === "prose" ? `> ${r.text}` : r.kind);
  assert.deepEqual(look, [
    "§ 今天",
    "顺手部署一下。 | 进行中…",
    "并发那个用例用 fake timer。 | e18b116d 4 次工具调用 · tests-pass ✓ · 进 #review ▾",
    "menu",
    "> 并发那个用例用 fake timer。",
    "> 用了 fake timer。",
    "把限流中间件的测试补上，然后开 PR。 | 053f317c 7a38c1fd 测试补上了，PR 已开。",
    "§ 昨天",
    "昨天的事 | 改好了。",
  ], "the commits made while a turn ran, then the first sentence of its answer; the turn still running says so; the unfolded one shows its card, its prompt and its answer whole");
  const turns = rows.filter((r) => r.kind === "turn");
  assert.deepEqual(turns.map((r) => r.action), [{ op: "expand-turn", id: "p3" }, { op: "expand-turn", id: null }, { op: "expand-turn", id: "p1" }, { op: "expand-turn", id: "p0" }], "a press unfolds a turn, or folds the unfolded one");
  assert.match(turns[0].at, /^\d\d:\d\d$/);
  assert.ok(turns.every((r) => r.fold === true), "every turn folds: a triangle says whether it is unfolded, the row's press turns it");
  assert.deepEqual(turns[1].icons.map((i) => [i.glyph, i.button.key, i.button.label, i.button.action]), [["locate", "locate-p2", "跳转", { op: "locate", id: "p2" }]], "the one icon at a row's right: the scroll to it, where the conversation scrolls");
  assert.deepEqual(rows.find((r) => r.kind === "menu").items.map((b) => [b.key, b.label, b.tone, b.action]), [
    ["split-p2", "拆成新会话", undefined, { op: "split", id: "p2" }], ["remove-p2", "删除这一轮", "danger", { op: "remove", id: "p2" }],
  ], "what can be done to a turn is a card under the unfolded one, not icons on every row");
  assert.ok(sessionRows(prompts, commits, wordsFor("zh"), 100, NOW, { flow: null, runs: [], scrolls: false, expanded: null }).filter((r) => r.kind === "turn").every((r) => r.icons.length === 0), "where nothing scrolls, a folded row carries no press but its own");
  const located = sessionRows(prompts.map((p) => ({ ...p, uuid: `row-${p.id}` })), commits, wordsFor("zh"), 100, NOW).filter((r) => r.kind === "turn")[1];
  assert.deepEqual(located.icons[0].button.action, { op: "locate", id: "p2", uuid: "row-p2" }, "跳转 carries the row, so the press scrolls before it awaits anything");
  assert.deepEqual(rows.map((r, i) => (r.kind === "menu" ? rows[i - 1].key : null)).filter((k) => k !== null), ["prompt-p2"], "one card, under the unfolded turn alone");
  assert.ok(rows.every((r) => r.kind !== "buttons"), "no export among the turns");
  assert.deepEqual(sessionRows([], [], wordsFor("zh"), 100), [{ kind: "text", text: "还没有 prompt", tone: "dim" }]);
});

test("流程: the ways out a person may take are numbered in the picture's order, one number each; a condition that holds is offered", () => {
  const board = { ...BOARD, transitions: [...BOARD.transitions, { name: "review→done", from: "review", to: "done", judge: "none", approval: true, note: "" }] };
  const st = { ...status(), next: [...status().next.map((x) => (x.to === "deploy" ? { ...x, holds: true, missing: [] } : x)), next({ name: "review→done", to: "done", judge: "none", approval: true })] };
  const picture = { ...board.picture, flow: { ...board.picture.flow, edges: [...board.picture.flow.edges, { name: "review→done", from: "review", to: "done", kind: "lane", label: "", sentence: false, marks: [] }] } };
  const rows = flow({ board: { ...board, picture }, status: st, columns: 60 });
  assert.deepEqual(pic(rows).edges.filter((e) => e.press !== undefined).map((e) => [e.name, e.press.n, e.press.action.to]), [["review→deploy", 1, "deploy"], ["review→build", 2, "build"], ["review→done", 3, "done"]], "numbered in the picture's order");
});

test("the pane: rows for the tab, a problem above them, and the reason when there is no board; the sessions tab needs none, and the work items tab shows what waits before it has one", () => {
  const wait = { kind: "text", text: "正在读取看板…", tone: "dim" };
  assert.deepEqual(pane({ board: null }), [wait]);
  assert.deepEqual(pane({ board: null, problem: "这个项目还没有流程。用 /gemflow add 选一个内置流程。" }), [{ kind: "text", text: "这个项目还没有流程。用 /gemflow add 选一个内置流程。", tone: "error" }]);
  assert.deepEqual(pane({ board: null, tab: "items" }), [{ kind: "section", key: "waiting", text: "待处理" }, { kind: "text", text: "暂无", tone: "dim" }, wait]);
  assert.deepEqual(pane({ board: null, tab: "items", problem: "x" }).at(-1), { kind: "text", text: "暂无", tone: "dim" }, "under a problem, no wait line");
  assert.deepEqual(pane({ board: null, tab: "sessions" }), [{ kind: "section", key: "own", text: "本会话", fold: { key: "export-own", label: "导出", action: { op: "export", session: "own" } } }, { kind: "text", text: "还没有 prompt", tone: "dim" }], "this session's heading carries its export even with nothing under it");
  const at = "2026-10-20T08:00:00Z";
  const one = (id, over = {}) => ({ id, host: "claude-code", started: at, last: at, turns: [], decisions: [], files: [], commits: [], ...over });
  const project = { sessions: [one("me"), one("other", { branch: "feat/y", decisions: [{ turn: 1, at, text: "先跑 CI" }] })], own: "me", open: null };
  assert.deepEqual(pane({ board: null, tab: "sessions", project }).filter((r) => r.kind === "section").map((r) => r.key), ["own", "others", "decisions"], "what was decided comes last, after the other sessions");
  assert.deepEqual(pane(), flow());
  assert.deepEqual(pane({ tab: "tools" }), toolRows({ board: BOARD, columns: 100, t: wordsFor("zh"), usage: {}, suggestions: [], query: "", menu: null, naming: null, open: [] }));
  const stale = pane({ problem: "gemflow：桥接没有应答（timed out）", tab: "items", doneOpen: true });
  assert.deepEqual(stale[0], { kind: "text", text: "gemflow：桥接没有应答（timed out）", tone: "error" }, "the last board stays, under why it is not fresh");
  assert.deepEqual(stale.slice(1), items({ columns: 100, doneOpen: true }));
  assert.ok(pane({ problem: "x", tab: "journal", maxRows: 4 }).length <= 4, "the journal fits the rows the problem leaves");
  assert.equal(pane({ problem: "x", tab: "journal", maxRows: 5 }).length, 5, "a day heading comes with its first entry");
});

test("two flows in play: the jumped-into work item's steps and where it came from; the queue by flow, the waiting one marked; the flow tab says who waits", () => {
  const logo = { id: ".geml/logo/mark", state: "review", rev: 4, at: "2026-10-15T11:03:00Z", paused: false, file: ".geml/logo/mark.geml", title: "gemflow 标志", flow: "标志设计", stateTitle: "review", since: "2026-10-15T09:30:00Z" };
  const styles = { id: ".geml/matters/styles", state: "noted", rev: 1, at: "2026-10-15T09:29:00Z", paused: false, file: ".geml/matters/styles.geml", title: "样式：画布换上新标志", flow: "开发流程", stateTitle: "记下", since: "2026-10-15T09:00:00Z", workflow: "matter", depends: [{ id: ".geml/logo/mark", title: "gemflow 标志", done: false, at: logo.at }] };
  const other = { id: ".geml/matters/lanes", state: "noted", rev: 1, at: "2026-10-15T08:00:00Z", paused: false, file: ".geml/matters/lanes.geml", title: "几条流程并排与依赖", flow: "开发流程", stateTitle: "记下", since: "2026-10-15T08:00:00Z", workflow: "matter" };
  const board = { ...BOARD, items: [logo, styles, other], backlog: null };
  const st = status({ kind: "item", id: ".geml/logo/mark" }, { title: "gemflow 标志" });
  const rows = items({ board, status: st });
  const look = (rs) => rs.map((r) => r.kind === "section" ? `§ ${r.text}` : r.kind === "steps" ? r.steps.map((s) => `${s.title}${s.passed ? " ✓" : ""}${s.current ? " ●" : ""}`).join(" → ") : r.kind === "entry" ? `${r.title} (${r.tag})` : r.kind === "text" ? r.text : r.kind);
  assert.deepEqual(look(rows).slice(2), [
    "§ 标志设计 · gemflow 标志",
    "构建 ✓ → review ● → deploy → done",
    rows[4].text,
    "§ 在做 · 标志设计",
    "gemflow 标志 (当前 · review)",
    "§ 在做 · 开发流程",
    "样式：画布换上新标志 (记下 · ⏳ 等「gemflow 标志」完成)",
    "几条流程并排与依赖 (记下)",
    "§ 已合并",
    "§ 已收尾",
    "§ 放下",
  ]);
  assert.match(rows[4].text, /^\d\d:\d\d 由开发流程「样式：画布换上新标志」转入，完成后返回。$/);
  assert.deepEqual(stepsOf(BOARD, "review").map((s) => [s.title, s.passed, s.current]), [["构建", true, false], ["review", false, true], ["deploy", false, false], ["done", false, false]], "a state the journal entered is passed, the current one marked");
  const f = flow({ board, status: st }).filter((r) => r.kind === "text").map((r) => r.text);
  assert.deepEqual(f.slice(0, 2), ["开发流程 · 记下 · 等「gemflow 标志」", "由「样式：画布换上新标志」转入，完成后返回「样式：画布换上新标志」。"]);
});

test("记录: what the current work item waits for — put aside, the other done with what it brought back, taken up again — under its own filter", () => {
  const st = status(undefined, { title: "样式：画布换上新标志", depends: [{ id: "m/logo", title: "gemflow 标志", flow: "标志设计", done: true, since: "2026-10-12T09:01:30Z", at: "2026-10-12T09:03:30Z", wrote: ["brand/gemflow_mark.svg", "brand/banner.png"] }] });
  const prompts = [{ id: "p1", at: "2026-10-12T09:01:00Z", text: "这个 logo 可能不能直接用 geml 的", tools: 1, refusals: 0, entered: [], signals: [] }];
  const rows = journalRows({ board: BOARD, status: st, filter: "depends", menu: null, evidence: null, prompts, columns: 100, maxRows: 40, t: wordsFor("zh"), now: NOW });
  assert.deepEqual(rows[0].items.map((b) => b.label), ["全部", "被拦", "依赖"], "the filter shows once there is a dependency");
  assert.deepEqual(rows.filter((r) => r.kind === "event").map((r) => [r.label, r.text, r.why, r.turn.replace(/\d\d:\d\d/, "HH:MM")]), [
    ["恢复", "样式：画布换上新标志", "", "提示词 HH:MM「这个 logo 可…」"],
    ["依赖完成", "标志设计「gemflow 标志」完成", "产物：gemflow_mark.svg · banner.png", ""],
    ["挂起", "样式：画布换上新标志，等「gemflow 标志」", "另开标志设计，工作项 gemflow 标志", "提示词 HH:MM「这个 logo 可…」"],
  ]);
  assert.ok(!journalRows({ board: BOARD, status: status(), filter: "all", menu: null, evidence: null, prompts: [], columns: 100, maxRows: 40, t: wordsFor("zh"), now: NOW })[0].items.some((b) => b.label === "依赖"), "no dependency, no such filter");
});

test("会话: with turns in more than one flow, a filter by flow; a run of three or more in another flow folds into one line, unfolded on a press", () => {
  const p = (id, at, flow, itemTitle) => ({ id, at, text: `${id} 的提示词`, flow, itemTitle, tools: 1, refusals: 0, entered: [], signals: [], did: `${id} 做了` });
  const prompts = [p("a", "2026-10-12T08:00:00Z", "开发流程", "样式"), p("b", "2026-10-12T08:10:00Z", "标志设计", "gemflow 标志"), p("c", "2026-10-12T08:20:00Z", "标志设计", "gemflow 标志"), p("d", "2026-10-12T08:30:00Z", "标志设计", "gemflow 标志"), p("e", "2026-10-12T09:00:00Z", "开发流程", "样式")];
  const look = (rows) => rows.map((r) => r.kind === "turn" ? `${r.text}${r.did ? ` | ${r.did}` : ""}` : r.kind === "buttons" ? r.items.map((b) => `${b.label}${b.primary ? "*" : ""}`).join(" ") : r.kind === "section" ? `§ ${r.text}` : r.kind);
  const folded = sessionRows(prompts, [], wordsFor("zh"), 100, NOW, { flow: null, runs: [], current: "开发流程" });
  assert.deepEqual(look(folded), ["全部* 开发流程 标志设计", "§ 今天", "e 的提示词 | e 做了", "标志设计 · gemflow 标志 · 3 条提示词", "a 的提示词 | a 做了"]);
  assert.deepEqual(folded[3].action, { op: "session-run", id: "b", open: true });
  assert.equal(folded[3].fold, true, "a run folds and unfolds: it says which");
  const open = sessionRows(prompts, [], wordsFor("zh"), 100, NOW, { flow: null, runs: ["b"], current: "开发流程" });
  assert.deepEqual(look(open).slice(3, 7), ["标志设计 · gemflow 标志 · 3 条提示词", "d 的提示词 | d 做了", "c 的提示词 | c 做了", "b 的提示词 | b 做了"]);
  const only = sessionRows(prompts, [], wordsFor("zh"), 100, NOW, { flow: "标志设计", runs: [], current: "开发流程" });
  assert.deepEqual(look(only).slice(0, 5), ["全部 开发流程 标志设计*", "§ 今天", "d 的提示词 | d 做了", "c 的提示词 | c 做了", "b 的提示词 | b 做了"]);
  const stale = sessionRows(prompts, [], wordsFor("zh"), 100, NOW, { flow: "早就改名的流程", runs: [], current: "开发流程" });
  assert.deepEqual(look(stale).slice(0, 3), ["全部* 开发流程 标志设计", "§ 今天", "e 的提示词 | e 做了"], "a filter by a flow no prompt carries shows them all, never only the export");
  const one = sessionRows(prompts.filter((x) => x.flow === "开发流程"), [], wordsFor("zh"), 100, NOW, { flow: "标志设计", runs: [], current: "开发流程" });
  assert.deepEqual(look(one).slice(0, 2), ["§ 今天", "e 的提示词 | e 做了"], "with one flow left there is no filter to clear: every prompt shows");
});

test("会话 across the project: the decisions shown whole, newest first; the other sessions after this one's turns, each with its export and a triangle saying whether it is unfolded", async () => {
  const { decisionRows, othersRows, sessionLabel } = await import("../dist/hosts/claude-code/board.js");
  const t = wordsFor("zh");
  const s = (id, host, branch, decisions, files, last) => ({ id, host, branch, started: "2026-10-12T07:00:00Z", last, turns: [{ turn: 1, at: "2026-10-12T08:00:00Z", prompt: `${id} 问的`, decisions: decisions.map(([, text]) => text) }], decisions: decisions.map(([at, text]) => ({ turn: 1, at, text })), files: files.map((path) => ({ path, at: "2026-10-12T08:30:00Z" })), commits: [] });
  const sessions = [
    s("me", "claude-code", "feat/x", [["2026-10-12T08:05:00Z", "每会话一个文件"]], ["hooks/register.tsx", "src/board.ts"], "2026-10-12T09:00:00Z"),
    s("cx", "codex", "feat/y", [["2026-10-12T08:10:00Z", "合并前先跑三平台 CI"]], ["hooks/register.tsx"], "2026-10-12T08:40:00Z"),
  ];
  const hhmm = (x) => x.replace(/\d\d:\d\d/, "hh:mm");
  const look = (rows) => rows.map((r) => r.kind === "section" ? `§ ${r.text}` : r.kind === "note" ? `${r.lines.join("⏎")} | ${r.tag}` : r.kind === "entry" ? `${r.title} | ${r.tag} ${r.open ? "▾" : "▸"}${r.extra !== undefined ? ` [${r.extra.label}]` : ""}` : r.kind === "turn" ? `> ${r.text} | ${r.did}` : r.kind);
  const exports = { button: (id) => ({ key: `export-${id}`, label: "导出", action: { op: "export", session: id } }), under: () => [] };
  const head = decisionRows({ sessions, own: "me", open: null }, t, 100, NOW);
  assert.deepEqual(look(head).map(hhmm), ["§ 决定", "合并前先跑三平台 CI | Codex · feat/y hh:mm", "每会话一个文件 | 本会话 hh:mm"]);
  assert.deepEqual(head[1].action, { op: "use-decision", text: "合并前先跑三平台 CI", from: "Codex · feat/y" }, "a press puts the decision in the prompt box");
  const tail = othersRows({ sessions, own: "me", open: null }, t, 100, NOW, exports);
  assert.deepEqual(look(tail).map(hhmm), ["§ 其他会话", "Codex · feat/y | hh:mm ▸ [导出]"]);
  assert.deepEqual(tail[1].action, { op: "session-open", id: "cx" });
  const open = othersRows({ sessions, own: "me", open: "cx" }, t, 100, NOW, exports);
  assert.deepEqual(look(open).slice(1, 3).map(hhmm), ["Codex · feat/y | hh:mm ▾ [导出]", "> cx 问的 | 合并前先跑三平台 CI"], "unfolded: its turns, each with what it decided");
  const long = decisionRows({ sessions: [{ ...sessions[0], decisions: [{ turn: 1, at: "2026-10-12T08:05:00Z", text: "一".repeat(60) }] }], own: "me", open: null }, t, 40, NOW);
  assert.deepEqual(long[1].lines.map((l) => l.length), [18, 18, 18, 6], "a long decision wraps to the width, none of it cut");
  assert.deepEqual(decisionRows({ sessions: sessions.map((x) => ({ ...x, decisions: [] })), own: "me", open: null }, t, 100, NOW), [], "nothing decided: no heading");
  assert.deepEqual(othersRows({ sessions: [sessions[0]], own: "me", open: null }, t, 100, NOW, exports), [], "alone: no other sessions");
  assert.equal(sessionLabel({ ...sessions[1], branch: undefined, checkout: ["C:", "w", "geml-agent-runtime"].join(String.fromCharCode(92)) }, "me"), "Codex · geml-agent-runtime", "a Windows checkout: its folder");
  assert.equal(sessionLabel({ ...sessions[1], branch: undefined, checkout: "/home/g/geml-agent-runtime" }, "me"), "Codex · geml-agent-runtime", "a POSIX one too");
});

test("会话 where the conversation cannot be scrolled: no 跳转 at the row; the unfolded turn shows its whole prompt, then its answer — 正在读取… until the record answers, 没有记下回答 when it holds none", () => {
  const p = { id: "p1", at: "2026-10-12T08:00:00Z", text: "把会话页改成整行可点\n第二行", tools: 1, refusals: 0, entered: [], signals: [], did: "改好了" };
  const turnOf = (rows) => rows.find((r) => r.kind === "turn");
  const desk = sessionRows([p], [], wordsFor("zh"), 100, NOW, { flow: null, runs: [], scrolls: false });
  assert.deepEqual(turnOf(desk).icons.map((i) => i.glyph), [], "a folded row carries no press but its own");
  assert.deepEqual(turnOf(sessionRows([p], [], wordsFor("zh"), 100, NOW, { flow: null, runs: [] })).icons.map((i) => i.glyph), ["locate"], "the terminal scrolls");
  const open = sessionRows([p], [], wordsFor("zh"), 100, NOW, { flow: null, runs: [], scrolls: false, expanded: { id: "p1", answer: "**改好了**，整行都能点。" } });
  assert.deepEqual([turnOf(open).open, turnOf(open).action], [true, { op: "expand-turn", id: null }]);
  assert.deepEqual(open.filter((r) => r.kind === "prose").map((r) => [r.text, r.markdown === true]), [["把会话页改成整行可点\n第二行", false], ["**改好了**，整行都能点。", true]]);
  const reading = sessionRows([p], [], wordsFor("zh"), 100, NOW, { flow: null, runs: [], scrolls: false, expanded: { id: "p1", answer: null } });
  assert.equal(reading.filter((r) => r.kind === "prose").at(-1).text, "正在读取…");
  const none = sessionRows([p], [], wordsFor("zh"), 100, NOW, { flow: null, runs: [], scrolls: false, expanded: { id: "p1", answer: "" } });
  assert.equal(none.filter((r) => r.kind === "prose").at(-1).text, "没有记下回答");
});

test("已暂缓: the pull requests and branches held back, counted together and folded; unfolded, pull requests first, each with where it stands and a press that brings its card back", () => {
  const t = wordsFor("zh");
  const branches = [{ branch: "feat/geml-agent-runtime", ahead: 96, newestAt: "2026-10-09T08:00:00Z" }, { branch: "feat/typst-pdf", ahead: 1 }];
  const prs = [{ number: 32, branch: "feat/a", green: false, failing: ["scan", "CI"] }, { number: 41, branch: "feat/c", green: true, failing: [] }, { number: 50, branch: "feat/d", green: false, failing: [] }];
  assert.deepEqual(heldRows({ branches: [], prs: [] }, false, t, NOW), [], "nothing held, nothing shown");
  assert.deepEqual(heldRows({ branches, prs }, false, t, NOW), [{ kind: "section", key: "held", text: "已暂缓", count: 5, fold: { key: "fold-held", label: "展开", action: { op: "fold", what: "held", open: true } } }]);
  const open = heldRows({ branches, prs }, true, t, NOW);
  assert.deepEqual(open[0].fold.label, "收起");
  assert.deepEqual(open.slice(1).map((r) => [r.kind, r.title, r.tag, r.extra.key, r.extra.label, r.extra.action]), [
    ["entry", "#32", "feat/a · scan、CI 失败", "restore-pr-32", "取消暂缓", { op: "undismiss", key: "green:32" }],
    ["entry", "#41", "feat/c · 检查全部通过", "restore-pr-41", "取消暂缓", { op: "undismiss", key: "green:41" }],
    ["entry", "#50", "feat/d · 检查中", "restore-pr-50", "取消暂缓", { op: "undismiss", key: "green:50" }],
    ["entry", "feat/geml-agent-runtime", "96 个提交 · 3 天前", "restore-feat/geml-agent-runtime", "取消暂缓", { op: "undismiss", key: "unpushed:feat/geml-agent-runtime" }],
    ["entry", "feat/typst-pdf", "1 个提交", "restore-feat/typst-pdf", "取消暂缓", { op: "undismiss", key: "unpushed:feat/typst-pdf" }],
  ]);
});
