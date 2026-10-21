// The sessions tab after the initialization: sessions and turns read back from transcripts, marked; the rest folded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectRows, sessionRows } from "../dist/hosts/claude-code/board.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const NOW = "2026-10-21T10:00:00Z";
const t = wordsFor("zh");
const session = (id, over = {}) => ({ id, host: "claude-code", started: "2026-10-19T08:12:00Z", last: "2026-10-19T08:12:00Z", turns: [], decisions: [], files: [], commits: [], ...over });

test("a backfilled session is tagged so and a scheduled task's names the task; its turns show the answer's first sentence where no decision was recorded", () => {
  const old = session("old", { branch: "main", backfilled: true, scheduled: "weekly-geml-docs-review", last: "2026-10-19T08:20:00Z", turns: [{ turn: 1, at: "2026-10-19T08:12:00Z", prompt: "审文档", decisions: [], gist: "审完了。", backfilled: true, kind: "scheduled" }] });
  const live = session("live", { branch: "feat/y", last: "2026-10-20T01:00:00Z", turns: [{ turn: 1, at: "2026-10-20T01:00:00Z", prompt: "推", decisions: ["先跑 CI"] }] });
  const rows = projectRows({ sessions: [old, live, session("own")], own: "own", open: "old" }, t, 100, NOW);
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
  const folded = projectRows({ sessions: [...many, session("own")], own: "own", open: null }, t, 100, NOW);
  assert.equal(folded.filter((r) => r.kind === "entry").length, 8);
  assert.deepEqual(folded.find((r) => r.kind === "section" && r.key === "others").count, 11);
  const more = folded.find((r) => r.kind === "buttons");
  assert.deepEqual([more.items[0].label, more.items[0].action], ["还有 3 个会话", { op: "sessions-more", all: true }]);
  const all = projectRows({ sessions: [...many, session("own")], own: "own", open: null, all: true }, t, 100, NOW);
  assert.equal(all.filter((r) => r.kind === "entry").length, 11);
  assert.deepEqual(all.find((r) => r.kind === "buttons").items[0].action, { op: "sessions-more", all: false });
});

test("this session's own turns read back from the transcript are marked 补录 on the tab, and never 进行中", () => {
  const prompt = (id, over = {}) => ({ id, at: "2026-10-21T09:00:00Z", text: "产物不是产品，叫artifacts", tools: 0, refusals: 0, entered: [], signals: [], ...over });
  const rows = sessionRows([prompt("b-u1", { backfilled: true, did: "改好了：products 改名 artifacts。" }), prompt("b-u2", { at: "2026-10-21T09:30:00Z", text: "好", backfilled: true }), prompt("p3", { at: "2026-10-21T09:40:00Z", text: "提交改动" })], null, [], t, 100, NOW);
  const turns = rows.filter((r) => r.kind === "turn");
  assert.deepEqual(turns.map((r) => [r.text, r.did]), [["提交改动", "进行中…"], ["好", "补录"], ["产物不是产品，叫artifacts", "补录 · 改好了：products 改名 artifacts。"]]);
});
