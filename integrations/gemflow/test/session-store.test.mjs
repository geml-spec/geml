// The project's shared session record on disk (src/session-store.ts): one directory for every checkout of a
// repository, out of git; each session's own log; the other sessions' decisions; the session an MCP server writes for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logName, parseLog } from "../dist/core/session-log.js";
import { appendSession, decisionsFor, latestSessionOf, readSessions, recordAnswer, recordDecisions, recordFile, recordPrompt, sessionsDirOf } from "../dist/session-store.js";
import { gitRepo } from "./helpers/repo.mjs";

const git = (root, ...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
const events = (root, host, id) => parseLog(readFileSync(join(sessionsDirOf(root), logName(host, id)), "utf8"));

test("one directory for every checkout: a session in a worktree writes into the main working tree's .geml/sessions/, which git does not see", () => {
  const main = gitRepo("main");
  const wt = join(mkdtempSync(join(tmpdir(), "gemflow-wt-")), "wt");
  assert.equal(git(main, "worktree", "add", "-q", "-b", "feat/y", wt).status, 0);
  recordPrompt(wt, "codex", "cx1", "在 worktree 里问的", "2026-10-19T08:00:00.000Z");
  assert.ok(existsSync(join(main, ".geml", "sessions", "codex-cx1.jsonl")), "the log is the main working tree's");
  assert.equal(readFileSync(join(main, ".geml", "sessions", ".gitignore"), "utf8"), "*\n");
  assert.equal(git(main, "status", "--porcelain").stdout.includes(".geml/sessions"), false, "git sees none of it");
  const [head, prompt] = events(wt, "codex", "cx1");
  assert.deepEqual([head.t, head.host, head.branch, prompt.t, prompt.turn, prompt.text], ["session", "codex", "feat/y", "prompt", 1, "在 worktree 里问的"]);
  assert.deepEqual(readSessions(main).map((s) => s.id), ["cx1"], "read the same from the main checkout");
});

test("a session's turn: its prompt, the decisions noted under it, a file once, the answer, and the commits a command made since the prompt", () => {
  const root = gitRepo();
  // The repository's first commit, then the prompt two seconds on, then a commit dated five seconds on: only that one is the turn's.
  const init = Date.parse(git(root, "log", "-1", "--format=%cI").stdout.trim());
  const at = (s) => new Date(init + s * 1000).toISOString();
  recordPrompt(root, "dsh", "a1", "按项目组织会话", at(2));
  assert.equal(recordDecisions(root, "dsh", "a1", ["每会话一个文件", "  "], at(3)), 1, "blank ones are not decisions");
  recordFile(root, "dsh", "a1", "src/a.ts");
  recordFile(root, "dsh", "a1", "src/a.ts");
  writeFileSync(join(root, "a.txt"), "x");
  git(root, "add", "a.txt");
  spawnSync("git", ["-C", root, "commit", "-q", "-m", "sessions"], { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: at(5), GIT_AUTHOR_DATE: at(5) } });
  recordAnswer(root, "dsh", "a1", "好了。", true, at(6));
  const e = events(root, "dsh", "a1");
  assert.deepEqual(e.map((x) => x.t), ["session", "prompt", "decision", "file", "answer", "commit"]);
  assert.ok(e.filter((x) => x.t !== "session").every((x) => x.turn === 1), "all under the turn the prompt opened");
  assert.equal(e.at(-1).subject, "sessions");
  recordAnswer(root, "dsh", "a1", "", false);
  assert.equal(events(root, "dsh", "a1").length, e.length, "an empty answer with no commit records nothing");
});

test("the other sessions' decisions, after a time; never one's own; and the session of a host that asked last", () => {
  const root = gitRepo();
  recordPrompt(root, "codex", "old", "a", "2026-10-19T07:00:00.000Z");
  recordDecisions(root, "codex", "old", ["旧的"], "2026-10-19T07:05:00.000Z");
  recordPrompt(root, "codex", "new", "b", "2026-10-19T09:00:00.000Z");
  recordDecisions(root, "codex", "new", ["新的"], "2026-10-19T09:05:00.000Z");
  recordDecisions(root, "dsh", "me", ["我自己的"], "2026-10-19T09:06:00.000Z");
  assert.deepEqual(decisionsFor(root, "me", "2026-10-19T08:00:00.000Z").map((d) => d.text), ["新的"]);
  assert.deepEqual(decisionsFor(root, "me", null, "2026-10-19T10:00:00.000Z").map((d) => d.text), ["旧的", "新的"], "no time seen: the last three days");
  assert.equal(latestSessionOf(root, "codex"), "new");
  assert.equal(latestSessionOf(root, "gemini"), undefined);
});

test("appendSession: a session line first, once; a log cut short mid-line still reads", () => {
  const root = gitRepo();
  appendSession(root, "codex", "s", () => []);
  appendSession(root, "codex", "s", () => []);
  const file = join(sessionsDirOf(root), logName("codex", "s"));
  assert.deepEqual(parseLog(readFileSync(file, "utf8")).map((e) => e.t), ["session"]);
  writeFileSync(file, `${readFileSync(file, "utf8")}{"t":"prompt","tu`);
  recordPrompt(root, "codex", "s", "继续");
  assert.deepEqual(parseLog(readFileSync(file, "utf8")).map((e) => e.t), ["session", "prompt"]);
});
