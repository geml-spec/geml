// The host's transcripts into the shared session record and the artifacts: the bridge's backfill-list and backfill-one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitRepo, hook, withWorkflow } from "./helpers/repo.mjs";
import { slugOf } from "../dist/core/transcript.js";
import { parseLog, summarize, formatLog } from "../dist/core/session-log.js";
import { readArtifactRows } from "../dist/artifacts-store.js";

const WS_DEV = fileURLToPath(new URL("./fixtures/ws-dev/", import.meta.url));

/** A project on feat/x with the dev workflow, ignoring out/ and .geml/, and a transcripts folder with its own slug. */
function project() {
  const root = gitRepo("feat/x");
  writeFileSync(join(root, ".gitignore"), "out/\n.geml/\n");
  mkdirSync(join(root, "out"), { recursive: true });
  withWorkflow(root, WS_DEV, "dev");
  const transcripts = mkdtempSync(join(tmpdir(), "gemflow-transcripts-"));
  const slug = join(transcripts, slugOf(resolve(root)));
  mkdirSync(slug, { recursive: true });
  return { root, transcripts, slug };
}

const rec = (root, o) => JSON.stringify({ sessionId: o.sessionId ?? "s-1", cwd: root, gitBranch: "feat/x", isSidechain: false, ...o });
const user = (root, uuid, at, text, over = {}) => rec(root, { type: "user", uuid, timestamp: at, message: { content: text }, ...over });
const assistant = (root, at, content, over = {}) => rec(root, { type: "assistant", timestamp: at, message: { content }, ...over });
const result = (root, at, id, text) => rec(root, { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });

test("backfill-list names the transcripts of the project's checkouts; backfill-one writes a session's log with its turns, records its page and the file it wrote; read again, it adds nothing", () => {
  const { root, transcripts, slug } = project();
  writeFileSync(join(root, "out", "a.md"), "# made for a person\n");
  const lines = [
    user(root, "u1", "2026-10-20T01:00:01Z", "产物不是产品，叫artifacts"),
    assistant(root, "2026-10-20T01:00:05Z", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: join(root, "out", "a.md") } }]),
    result(root, "2026-10-20T01:00:06Z", "t1", "ok"),
    assistant(root, "2026-10-20T01:00:09Z", [{ type: "tool_use", id: "t2", name: "Artifact", input: { title: "Gemflow 界面示意" } }]),
    result(root, "2026-10-20T01:00:10Z", "t2", "Published x at https://claude.ai/artifact/Aw9u (Version 3, version id x)"),
    assistant(root, "2026-10-20T01:00:12Z", [{ type: "text", text: "改好了：products 改名 artifacts。" }]),
    user(root, "u2", "2026-10-20T01:05:00Z", "好"),
    assistant(root, "2026-10-20T01:05:02Z", [{ type: "text", text: "嗯。" }]),
  ];
  writeFileSync(join(slug, "s-1.jsonl"), lines.join("\n") + "\n");
  writeFileSync(join(slug, "notes.txt"), "not a transcript");
  const listed = hook(root, { op: "backfill-list", transcripts });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.backfill.sessions.map((s) => s.id), ["s-1"]);
  assert.ok(listed.backfill.sessions[0].size > 100);

  const one = hook(root, { op: "backfill-one", file: listed.backfill.sessions[0].file, transcripts });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.deepEqual(one.backfill, { id: "s-1", turns: 2, files: 1, links: 1 });
  const log = join(root, ".geml", "sessions", "claude-code-s-1.geml");
  assert.ok(existsSync(log));
  assert.ok(existsSync(join(root, ".geml", "sessions", ".gitignore")));
  const s = summarize(parseLog(readFileSync(log, "utf8")));
  assert.deepEqual([s.id, s.host, s.branch, s.backfilled, s.scheduled], ["s-1", "claude-code", "feat/x", true, undefined]);
  assert.deepEqual(s.turns.map((t) => [t.turn, t.prompt, t.answer, t.uuid, t.backfilled]), [[1, "产物不是产品，叫artifacts", "改好了：products 改名 artifacts。", "u1", true], [2, "好", "嗯。", "u2", true]]);
  assert.deepEqual(s.files.map((f) => f.path), [join(root, "out", "a.md")]);
  const rows = readArtifactRows(root);
  assert.deepEqual(rows.map((r) => [r.item, r.kind, r.name, r.version]), [["feat/x", "link", "Gemflow 界面示意", "3"], ["feat/x", "file", "out/a.md", "1"]]);

  const again = hook(root, { op: "backfill-one", file: listed.backfill.sessions[0].file, transcripts });
  assert.deepEqual(again.backfill, { id: "s-1", turns: 0, files: 0, links: 0 }, "read again: nothing new");
  assert.equal(readArtifactRows(root).length, 2);
});

test("the session asking gets its turns back and its log is not written by the bridge; a scheduled task's session is named; a session writing its own log is left alone", () => {
  const { root, transcripts, slug } = project();
  writeFileSync(join(slug, "own.jsonl"), [user(root, "u1", "2026-10-21T05:00:00Z", "提交改动", { sessionId: "own" }), assistant(root, "2026-10-21T05:00:05Z", [{ type: "text", text: "已提交。" }], { sessionId: "own" })].join("\n"));
  const own = hook(root, { op: "backfill-one", file: join(slug, "own.jsonl"), own: true, transcripts });
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(own.backfill.turns, 1);
  assert.deepEqual(own.backfill.transcript.turns.map((t) => [t.uuid, t.text, t.answer, t.uploads]), [["u1", "提交改动", "已提交。", []]]);
  assert.ok(!existsSync(join(root, ".geml", "sessions", "claude-code-own.geml")), "the hooks module writes its own log");

  writeFileSync(join(slug, "task.jsonl"), [user(root, "u1", "2026-10-19T08:12:00Z", '<scheduled-task name="weekly-geml-docs-review" file="x">\n审文档\n</scheduled-task>', { sessionId: "task" })].join("\n"));
  const task = hook(root, { op: "backfill-one", file: join(slug, "task.jsonl"), transcripts });
  assert.equal(task.ok, true, JSON.stringify(task));
  const s = summarize(parseLog(readFileSync(join(root, ".geml", "sessions", "claude-code-task.geml"), "utf8")));
  assert.deepEqual([s.scheduled, s.turns[0].kind], ["weekly-geml-docs-review", "scheduled"]);

  // A log written live a moment ago: its session is still there.
  const liveLog = join(root, ".geml", "sessions", "claude-code-live.geml");
  writeFileSync(liveLog, formatLog([{ t: "session", id: "live", host: "claude-code", at: "2026-10-21T06:00:00Z" }, { t: "prompt", turn: 1, at: "2026-10-21T06:00:01Z", text: "继续" }]));
  writeFileSync(join(slug, "live.jsonl"), [user(root, "u9", "2026-10-21T05:50:00Z", "开始", { sessionId: "live" })].join("\n"));
  const live = hook(root, { op: "backfill-one", file: join(slug, "live.jsonl"), transcripts });
  assert.deepEqual(live.backfill, { id: "live", turns: 0, files: 0, links: 0, skipped: true });
  // The same log, written long ago: the earlier turn goes before its own.
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(liveLog, old, old);
  const dead = hook(root, { op: "backfill-one", file: join(slug, "live.jsonl"), transcripts });
  assert.deepEqual(dead.backfill, { id: "live", turns: 1, files: 0, links: 0 });
  const merged = summarize(parseLog(readFileSync(liveLog, "utf8")));
  assert.deepEqual(merged.turns.map((t) => [t.turn, t.prompt, t.backfilled ?? false]), [[1, "开始", true], [2, "继续", false]]);
  assert.equal(merged.backfilled, undefined, "the session line stays the live one");

  const missing = hook(root, { op: "backfill-one", file: join(slug, "nope.jsonl"), transcripts });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /cannot read nope\.jsonl/);
});

test("turn-ids: the prompt rows a session's transcript still holds; a session with no transcript is an error", () => {
  const { root, transcripts, slug } = project();
  writeFileSync(join(slug, "s-9.jsonl"), [user(root, "u1", "2026-10-21T05:00:00Z", "a", { sessionId: "s-9" }), user(root, "u2", "2026-10-21T05:01:00Z", "b", { sessionId: "s-9" })].join("\n"));
  assert.deepEqual(hook(root, { op: "turn-ids", session: "s-9", transcripts }).backfill, { uuids: ["u1", "u2"], messages: [] }, "the prompt rows, and the messages typed mid-turn (none here)");
  assert.equal(hook(root, { op: "turn-ids", session: "s-0", transcripts }).ok, false);
  // A transcript whose last record is cut short is being written: no answer yet.
  writeFileSync(join(slug, "s-8.jsonl"), user(root, "u1", "2026-10-21T05:00:00Z", "a", { sessionId: "s-8" }) + "\n" + '{"type":"user","uuid":"u2","timesta');
  const cut = hook(root, { op: "turn-ids", session: "s-8", transcripts });
  assert.equal(cut.ok, false);
  assert.match(cut.error, /being written/);
});
