// A Claude Code transcript read into the session record's turns (transcript.ts), and earlier turns put before a log's own (session-log.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { newTurns, readTranscript, slugOf, transcriptEvents } from "../dist/core/transcript.js";
import { parseLog, formatLog, summarize, withEarlierTurns } from "../dist/core/session-log.js";

const rec = (o) => JSON.stringify({ sessionId: "s-1", cwd: "C:\\agentProjects\\geml-spec", gitBranch: "main", isSidechain: false, ...o });
const user = (uuid, at, text, over = {}) => rec({ type: "user", uuid, timestamp: at, message: { content: text }, ...over });
const assistant = (at, content) => rec({ type: "assistant", timestamp: at, message: { content } });
const result = (at, id, text) => rec({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });

test("the slug: Claude Code's folder for a directory", () => {
  assert.equal(slugOf("C:\\agentProjects\\geml-spec"), "C--agentProjects-geml-spec");
  assert.equal(slugOf("C:\\agentProjects\\geml-spec\\.claude\\worktrees\\x-1"), "C--agentProjects-geml-spec--claude-worktrees-x-1");
  assert.equal(slugOf("/home/u/proj"), "-home-u-proj");
});

test("a transcript: the person's prompts become turns with the last answer, the files written, the page published; reminders, notifications, summaries, subagents and tool results are not turns", () => {
  const lines = [
    rec({ type: "attachment", timestamp: "2026-10-20T01:00:00Z" }),
    user("u1", "2026-10-20T01:00:01Z", "<system-reminder>x</system-reminder>\n产物不是产品，叫artifacts"),
    assistant("2026-10-20T01:00:05Z", [{ type: "text", text: "先看一下。" }, { type: "tool_use", id: "t1", name: "Write", input: { file_path: "C:\\p\\out\\a.md" } }]),
    result("2026-10-20T01:00:06Z", "t1", "ok"),
    assistant("2026-10-20T01:00:09Z", [{ type: "tool_use", id: "t2", name: "Artifact", input: { title: "Gemflow 界面示意", file_path: "C:\\p\\page.html" } }]),
    result("2026-10-20T01:00:10Z", "t2", "Published C:\\p\\page.html at https://claude.ai/artifact/Aw9u (Version 3, version id x)"),
    assistant("2026-10-20T01:00:12Z", [{ type: "text", text: "改好了：products 改名 artifacts。\n\n细节如下。" }]),
    user("u2", "2026-10-20T01:05:00Z", [{ type: "text", text: "<task-notification>done</task-notification>" }], { origin: { kind: "task-notification" } }),
    user("u3", "2026-10-20T01:06:00Z", "The summarized conversation…", { isCompactSummary: true }),
    user("u4", "2026-10-20T01:07:00Z", "<local-command-caveat>…</local-command-caveat>"),
    user("u5", "2026-10-20T01:08:00Z", "side", { isSidechain: true }),
    user("u6", "2026-10-20T01:09:00Z", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }, { type: "text", text: "这个图标好看吗" }], { gitBranch: "feat/x" }),
    assistant("2026-10-20T01:09:30Z", [{ type: "text", text: "好看。" }]),
    user("u7", "2026-10-20T01:10:00Z", "把这个修复转给 Gemflow 会话", { origin: { kind: "peer", from: "local_1" } }),
  ];
  const tr = readTranscript(lines.join("\n") + "\n");
  assert.equal(tr.id, "s-1");
  assert.equal(tr.cwd, "C:\\agentProjects\\geml-spec");
  assert.equal(tr.branch, "main");
  assert.deepEqual(tr.turns.map((t) => [t.uuid, t.kind, t.text]), [["u1", "person", "产物不是产品，叫artifacts"], ["u6", "person", "这个图标好看吗"], ["u7", "peer", "把这个修复转给 Gemflow 会话"]]);
  const [first, second] = tr.turns;
  assert.equal(first.answer, "改好了：products 改名 artifacts。\n\n细节如下。", "the last answer with words");
  assert.equal(first.answerAt, "2026-10-20T01:00:12Z");
  assert.deepEqual(first.files, ["C:\\p\\out\\a.md"]);
  assert.deepEqual(first.links, [{ url: "https://claude.ai/artifact/Aw9u", version: "3", title: "Gemflow 界面示意" }]);
  assert.deepEqual(second.uploads, [{ mediaType: "image/png", data: "iVBOR" }]);
  assert.equal(second.branch, "feat/x");
  assert.deepEqual([tr.started, tr.last], ["2026-10-20T01:00:01Z", "2026-10-20T01:10:00Z"]);
  assert.equal(readTranscript("not json\n"), undefined);
  assert.equal(readTranscript(rec({ type: "attachment", timestamp: "2026-10-20T01:00:00Z" })).turns.length, 0, "a session with no prompt: no turns");
});

test("a scheduled task's session is marked by the task's name; its events carry it, each prompt its uuid and the backfilled mark, the answer whole", () => {
  const long = "x".repeat(10_000);
  const lines = [
    user("u1", "2026-10-19T08:12:00Z", '<scheduled-task name="weekly-geml-docs-review" file="C:\\x">\n审一下文档\n</scheduled-task>'),
    assistant("2026-10-19T08:13:00Z", [{ type: "text", text: long }]),
  ];
  const tr = readTranscript(lines.join("\n"));
  assert.deepEqual([tr.turns[0].kind, tr.turns[0].scheduled], ["scheduled", "weekly-geml-docs-review"]);
  const events = transcriptEvents(tr, "claude-code", { head: true });
  assert.deepEqual(events[0], { t: "session", id: "s-1", host: "claude-code", at: "2026-10-19T08:12:00Z", branch: "main", checkout: "C:\\agentProjects\\geml-spec", backfilled: true, scheduled: "weekly-geml-docs-review" });
  assert.deepEqual(events[1], { t: "prompt", turn: 1, at: "2026-10-19T08:12:00Z", text: tr.turns[0].text, uuid: "u1", backfilled: true, kind: "scheduled" });
  assert.equal(events[2].text, long);
  // The log reads back with the marks, and summarizes with them.
  const back = parseLog(formatLog(events));
  assert.deepEqual(back, events);
  const s = summarize(back);
  assert.deepEqual([s.backfilled, s.scheduled, s.turns[0].uuid, s.turns[0].backfilled, s.turns[0].kind], [true, "weekly-geml-docs-review", "u1", true, "scheduled"]);
  // Read again: nothing new.
  assert.deepEqual(newTurns(tr, back).turns, []);
  assert.equal(transcriptEvents(newTurns(tr, back), "claude-code", { head: false, from: 2 }).length, 0);
});

test("earlier turns go before a log's own: numbered from 1, the live ones moved up; one already there (same words, minutes apart) is left out", () => {
  const own = [
    { t: "session", id: "s", host: "claude-code", at: "2026-10-21T05:00:00Z" },
    { t: "prompt", turn: 1, at: "2026-10-21T05:00:10Z", text: "提交改动" },
    { t: "decision", turn: 1, at: "2026-10-21T05:00:20Z", text: "一笔提交" },
    { t: "prompt", turn: 2, at: "2026-10-21T05:10:00Z", text: "推" },
  ];
  const earlier = [
    { t: "prompt", turn: 1, at: "2026-10-20T01:00:00Z", text: "产物不是产品", uuid: "u1", backfilled: true },
    { t: "answer", turn: 1, at: "2026-10-20T01:00:12Z", text: "改好了" },
    { t: "prompt", turn: 2, at: "2026-10-21T05:00:08Z", text: "提交改动", uuid: "u2", backfilled: true },
    { t: "prompt", turn: 3, at: "2026-10-21T04:00:00Z", text: "改吧", uuid: "u3", backfilled: true },
  ];
  const merged = withEarlierTurns(own, earlier);
  assert.deepEqual(merged.map((e) => [e.t, e.turn ?? null, e.text ?? e.id]), [
    ["session", null, "s"],
    ["prompt", 1, "产物不是产品"], ["answer", 1, "改好了"], ["prompt", 2, "改吧"],
    ["prompt", 3, "提交改动"], ["decision", 3, "一笔提交"], ["prompt", 4, "推"],
  ]);
  assert.deepEqual(withEarlierTurns(own, [earlier[2]]), own, "nothing new: the log as it was");
  assert.deepEqual(withEarlierTurns([], earlier.slice(0, 2)).map((e) => e.turn), [1, 1], "no session line: the earlier turns alone");
});
