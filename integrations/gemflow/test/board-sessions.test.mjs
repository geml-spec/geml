// The sessions tab after the initialization: sessions and turns read back from transcripts, marked; the rest folded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionRows, othersRows, sessionRows } from "../dist/hosts/claude-code/board.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const NOW = "2026-10-21T10:00:00Z";
const t = wordsFor("zh");
const session = (id, over = {}) => ({ id, host: "claude-code", started: "2026-10-19T08:12:00Z", last: "2026-10-19T08:12:00Z", turns: [], decisions: [], files: [], commits: [], ...over });

test("a backfilled session is tagged so and a scheduled task's names the task; its turns show the answer's first sentence where no decision was recorded", () => {
  const old = session("old", { branch: "main", backfilled: true, scheduled: "weekly-geml-docs-review", last: "2026-10-19T08:20:00Z", turns: [{ turn: 1, at: "2026-10-19T08:12:00Z", prompt: "审文档", decisions: [], gist: "审完了。", backfilled: true, kind: "scheduled" }] });
  const live = session("live", { branch: "feat/y", last: "2026-10-20T01:00:00Z", turns: [{ turn: 1, at: "2026-10-20T01:00:00Z", prompt: "推", decisions: ["先跑 CI"] }] });
  const rows = othersRows({ sessions: [old, live, session("own")], own: "own", open: "old" }, t, 100, NOW);
  const entries = rows.filter((r) => r.kind === "entry");
  assert.deepEqual(entries.map((r) => r.title), ["Claude · feat/y", "Claude · main · 定时任务 weekly-geml-docs-review"], "newest first; the task named");
  assert.doesNotMatch(entries[0].tag, /补录/);
  assert.match(entries[1].tag, /^补录 · /);
  const turns = rows.filter((r) => r.kind === "turn");
  assert.deepEqual(turns.map((r) => [r.text, r.did]), [["审文档", "审完了。"]]);
  assert.ok(rows.every((r) => r.kind !== "buttons"), "three sessions: nothing folds");
});

test("beyond eight other sessions the rest fold behind a count, and unfold on a press", () => {
  const many = Array.from({ length: 11 }, (_, i) => session(`s${i}`, { branch: `b${i}`, last: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00Z`, backfilled: true }));
  const folded = othersRows({ sessions: [...many, session("own")], own: "own", open: null }, t, 100, NOW);
  assert.equal(folded.filter((r) => r.kind === "entry").length, 8);
  assert.deepEqual(folded.find((r) => r.kind === "section" && r.key === "others").count, 11);
  const more = folded.find((r) => r.kind === "buttons");
  assert.deepEqual([more.items[0].label, more.items[0].action], ["还有 3 个会话", { op: "sessions-more", all: true }]);
  const all = othersRows({ sessions: [...many, session("own")], own: "own", open: null, all: true }, t, 100, NOW);
  assert.equal(all.filter((r) => r.kind === "entry").length, 11);
  assert.deepEqual(all.find((r) => r.kind === "buttons").items[0].action, { op: "sessions-more", all: false });
});

test("this session's own turns read back from the transcript are marked 补录 on the tab, and never 进行中", () => {
  const prompt = (id, over = {}) => ({ id, at: "2026-10-21T09:00:00Z", text: "产物不是产品，叫artifacts", tools: 0, refusals: 0, entered: [], signals: [], ...over });
  const rows = sessionRows([prompt("b-u1", { backfilled: true, did: "改好了：products 改名 artifacts。" }), prompt("b-u2", { at: "2026-10-21T09:30:00Z", text: "好", backfilled: true }), prompt("p3", { at: "2026-10-21T09:40:00Z", text: "提交改动" })], [], t, 100, NOW);
  const turns = rows.filter((r) => r.kind === "turn");
  assert.deepEqual(turns.map((r) => [r.text, r.did]), [["提交改动", "进行中…"], ["好", "补录"], ["产物不是产品，叫artifacts", "补录 · 改好了：products 改名 artifacts。"]]);
});

test("the sessions tab draws the newest thirty turns and the rest behind a count; a press draws thirty more", () => {
  const prompts = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, at: `2026-10-21T0${Math.floor(i / 10)}:${String(i % 10).padStart(2, "0")}:00Z`, text: `第 ${i} 句`, tools: 0, refusals: 0, entered: [], signals: [] }));
  const paged = sessionRows(prompts, [], t, 100, NOW, { flow: null, runs: [], limit: 30 });
  assert.equal(paged.filter((r) => r.kind === "turn").length, 30);
  assert.equal(paged.filter((r) => r.kind === "turn")[0].text, "第 39 句", "the newest first");
  const more = paged.find((r) => r.kind === "buttons" && r.items[0].key === "turns-more");
  assert.deepEqual([more.items[0].label, more.items[0].action], ["还有 10 轮", { op: "turns-more" }]);
  assert.equal(sessionRows(prompts, [], t, 100, NOW, { flow: null, runs: [], limit: 60 }).filter((r) => r.kind === "turn").length, 40, "within the limit: all, no button");
  assert.ok(!sessionRows(prompts, [], t, 100, NOW, { flow: null, runs: [], limit: 60 }).some((r) => r.kind === "buttons" && r.items[0].key === "turns-more"));
});

test("the decisions section lists the newest twenty, each whole; beyond them the rest fold behind a count and unfold on a press", () => {
  const s = session("other", { branch: "feat/y", decisions: Array.from({ length: 25 }, (_, i) => ({ turn: i + 1, at: `2026-10-${String(1 + Math.floor(i / 10)).padStart(2, "0")}T${String(i % 10).padStart(2, "0")}:00:00Z`, text: `第 ${i} 条决定，这一条写得够长，足够折成两行来看看整句是不是都在：${"字".repeat(60)}` })) });
  const folded = decisionRows({ sessions: [s, session("own")], own: "own", open: null }, t, 80, NOW);
  const notes = folded.filter((r) => r.kind === "note");
  assert.equal(notes.length, 20);
  assert.equal(notes[0].lines.join(""), s.decisions[24].text, "the newest first, shown whole");
  assert.equal(folded.find((r) => r.kind === "section" && r.key === "decisions").count, 25);
  const more = folded.find((r) => r.kind === "buttons" && r.items[0].key === "decisions-more");
  assert.deepEqual(more.items.map((b) => [b.label, b.action]), [["还有 5 条决定", { op: "decisions-more", shown: 40 }]], "a press shows twenty more");
  const next = decisionRows({ sessions: [s, session("own")], own: "own", open: null, decisionsShown: 40 }, t, 80, NOW);
  assert.equal(next.filter((r) => r.kind === "note").length, 25);
  assert.deepEqual(next.find((r) => r.kind === "buttons").items.map((b) => [b.key, b.action]), [["decisions-fold", { op: "decisions-more", shown: 20 }]], "all shown: only 收起");
  const many = session("many", { decisions: Array.from({ length: 200 }, (_, i) => ({ turn: i + 1, at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(), text: `决定 ${i}` })) });
  const page = decisionRows({ sessions: [many, session("own")], own: "own", open: null, decisionsShown: 60 }, t, 80, NOW);
  assert.equal(page.filter((r) => r.kind === "note").length, 60, "two hundred decisions: never more than the pages pressed");
  assert.deepEqual(page.find((r) => r.kind === "buttons").items.map((b) => b.label), ["还有 140 条决定", "收起"]);
});

test("整理: no box until it is pressed; then every turn but the running one has one, a press on the row toggles it; the heading says how many and offers what can be done to them, and 完成", async () => {
  const { paneRows } = await import("../dist/hosts/claude-code/board.js");
  const turn = (id, over = {}) => ({ id, at: "2026-10-21T09:00:00Z", text: `第 ${id} 轮`, tools: 0, refusals: 0, entered: [], signals: [], ...over });
  const prompts = [turn("p1", { uuid: "u1", did: "改了" }), turn("p2", { did: "插话" }), turn("p3", { uuid: "u3", did: "又改了" }), turn("p4", { uuid: "u4" })];
  const plain = sessionRows(prompts, [], t, 100, NOW, { flow: null, runs: [] });
  assert.ok(plain.filter((r) => r.kind === "turn").every((r) => r.check === undefined && r.action.op === "expand-turn"), "no box, a press unfolds");
  const rows = sessionRows(prompts, [], t, 100, NOW, { flow: null, runs: [], picked: ["p1"], tidying: true });
  const by = Object.fromEntries(rows.filter((r) => r.kind === "turn").map((r) => [r.key, r]));
  assert.deepEqual([by["prompt-p1"].check, by["prompt-p1"].action], [true, { op: "pick-turn", id: "p1", on: false }]);
  assert.deepEqual([by["prompt-p2"].check, by["prompt-p2"].action], [false, { op: "pick-turn", id: "p2", on: true }], "a message typed mid-turn can be picked on its own");
  assert.deepEqual([by["prompt-p4"].check, by["prompt-p4"].did], [null, "进行中，不能选"], "the turn still running: no box");
  assert.ok(Object.values(by).every((r) => (r.icons ?? []).length === 0 && r.open === false), "no scroll icon, nothing unfolded while picking");
  const pane = (over) => paneRows({ board: null, problem: null, shell: null, tab: "sessions", columns: 100, maxRows: 40, t, now: NOW, root: "/r", inbox: [], filter: "all", expanded: null, evidence: null, prompts, exportedFor: null, doneOpen: false, droppedOpen: false, sessionFlow: null, sessionRuns: [], flowState: null, switching: false, workflows: null, usage: {}, dismissed: [], toolQuery: "", toolMenu: null, toolNaming: null, toolsOpen: [], exported: null, ...over });
  const heading = (rows) => rows.find((r) => r.kind === "section" && r.key === "own");
  const off = heading(pane({}));
  assert.deepEqual([off.actions.map((b) => [b.label, b.action]), off.fold.key], [[["整理", { op: "tidy", on: true }]], "export-own"]);
  assert.deepEqual(heading(pane({ tidying: true, picked: [] })).actions.map((b) => b.label), ["完成"], "nothing picked yet: only 完成");
  assert.equal(heading(pane({ tidying: true, picked: [] })).note, "选要整理的轮次");
  const on = heading(pane({ tidying: true, picked: ["p1", "p2", "gone"] }));
  assert.equal(on.note, "已选 2 轮", "a picked turn no longer listed is not counted");
  assert.deepEqual(on.actions.map((b) => [b.label, b.action]), [["拆成新会话", { op: "split-picked", remove: false }], ["删除", { op: "split-picked", remove: true }], ["连同之后的", { op: "pick-after" }], ["完成", { op: "tidy", on: false }]]);
});

test("the project's memory: a filter row of 全部 and each type there is, with counts; the newest ten of what it picks, each opening to open, edit the summary, or delete", async () => {
  const { memoryRows } = await import("../dist/hosts/claude-code/board.js");
  const entry = (i, type) => ({ file: `m${i}.md`, title: `第 ${i} 条`, hook: `摘要 ${i}`, type, at: `2026-10-${String(20 - Math.floor(i / 10)).padStart(2, "0")}T0${i % 10}:00:00Z` });
  const list = { dir: "/h/memory", entries: [...Array.from({ length: 12 }, (_, i) => entry(i, "feedback")), entry(20, "project"), entry(21, "odd")] };
  const m = (over = {}) => ({ list, group: null, menu: null, edit: null, shown: 10, ...over });
  const all = memoryRows(m(), t, 100, NOW);
  assert.deepEqual([all[0].text, all[0].count], ["记忆", 14]);
  assert.deepEqual(all[1].items.map((b) => [b.label, b.primary === true, b.action]), [["全部 14", true, { op: "memory-group", group: null }], ["反馈 12", false, { op: "memory-group", group: "feedback" }], ["项目 1", false, { op: "memory-group", group: "project" }], ["其他 1", false, { op: "memory-group", group: "" }]], "only the types there are");
  assert.equal(all.filter((r) => r.kind === "entry").length, 10, "全部: the newest ten");
  assert.deepEqual(all.find((r) => r.kind === "buttons" && r.items[0].key === "memory-more").items[0].action, { op: "memory-more", shown: 20 }, "ten more a press");
  assert.equal(all.find((r) => r.kind === "buttons" && r.items[0].key === "memory-more").items[0].label, "还有 4 条");
  const paged = memoryRows(m({ shown: 20 }), t, 100, NOW);
  assert.equal(paged.filter((r) => r.kind === "entry").length, 14);
  assert.deepEqual(paged.at(-1).items.map((b) => [b.key, b.action]), [["memory-fold", { op: "memory-more", shown: 10 }]]);
  const feedback = memoryRows(m({ group: "feedback" }), t, 100, NOW);
  assert.ok(feedback[1].items.find((b) => b.key === "memory-filter-feedback").primary);
  assert.equal(feedback.find((r) => r.kind === "buttons" && r.items[0].key === "memory-more").items[0].label, "还有 2 条");
  assert.deepEqual(memoryRows(m({ list: { dir: "/h/memory", entries: [] } }), t, 100, NOW), [], "none: nothing");
  const card = memoryRows(m({ group: "feedback", menu: "m3.md", edit: "m3.md" }), t, 100, NOW);
  const input = card.find((r) => r.kind === "input");
  assert.deepEqual([input.field, input.value, input.target], ["memory-hook", "摘要 3", "m3.md"], "the summary as it is, to edit");
  assert.deepEqual(card.find((r) => r.kind === "menu").items.map((b) => [b.label, b.action]), [["打开", { op: "open-file", path: "/h/memory/m3.md" }], ["改摘要", { op: "memory-edit", file: null }], ["删除", { op: "memory-delete", file: "m3.md" }]]);
});
