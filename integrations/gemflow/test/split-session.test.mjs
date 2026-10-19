// The bundled split-session script, run on a sample session: what it prints names no place by its absolute path and
// no value read from the environment — the session as its record on disk names it, places from Claude's home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../skills/split-session/split-session.mjs", import.meta.url));
const ID = "0f6a2c1e-3b7d-4e55-9a10-6c2d8e4f1b23";

/** A Claude home with one session of three turns, each a prompt and its answer. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), "gf-split-"));
  const project = join(dir, "projects", "C--work-app");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(dir, "desktop"));
  const recs = [];
  let parent = null;
  ["把测试补上", "顺手部署一下", "界面呢？"].forEach((text, n) => {
    const at = `2026-10-16T0${n + 1}:00:00.000Z`;
    const ask = { type: "user", uuid: `u${n}`, parentUuid: parent, sessionId: ID, timestamp: at, message: { role: "user", content: text } };
    const answer = { type: "assistant", uuid: `a${n}`, parentUuid: ask.uuid, sessionId: ID, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: `好：${text}` }] } };
    recs.push(ask, answer);
    parent = answer.uuid;
  });
  writeFileSync(join(project, `${ID}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { dir, project };
}

const run = (h, args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args, "--projects-dir", join(h.dir, "projects"), "--desktop-dir", join(h.dir, "desktop")], {
  encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CLAUDE_CONFIG_DIR: h.dir, ...env },
});

test("split-session lists the session this runs in by the id its record has on disk", () => {
  const h = home();
  const r = run(h, ["list"], { CLAUDE_CODE_SESSION_ID: ID });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^会话：\\(无标题\\)  ${ID}  \\[当前会话\\]$`, "m"));
  assert.match(r.stdout, /^#3  .*界面呢？  \[当前这一轮，不可拆\]$/m);
});

test("split-session names the backup from Claude's home, never by its absolute path", () => {
  const h = home();
  const r = run(h, ["split", "--turns", "1", "--title", "补测试", "--session", ID]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.backup, /^\$CLAUDE_CONFIG_DIR\/session-split-backups\/\d{8}-\d{6}-0f6a2c1e$/);
  assert.equal(out.source.cliId, ID);
  assert.ok(!r.stdout.includes(h.dir) && !r.stdout.includes(JSON.stringify(h.dir).slice(1, -1)), "no absolute path in what it prints");
  assert.equal(readdirSync(join(h.dir, "session-split-backups")).length, 1, "the backup is where it says");
  assert.ok(existsSync(join(h.project, `${out.created.cliId}.jsonl`)), "the new session's record");
});

test("split-session's error names what --session said, and only that", () => {
  const h = home();
  const missing = run(h, ["list"], { CLAUDE_CODE_SESSION_ID: "aaaaaaaa-0000-4000-8000-000000000000" });
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), "错误：找不到当前会话的记录文件。");
  const given = run(h, ["list", "--session", "bbbbbbbb-0000-4000-8000-000000000000"]);
  assert.equal(given.stderr.trim(), "错误：找不到会话 bbbbbbbb-0000-4000-8000-000000000000 的记录文件。");
});

test("split-session remove: the turn is gone from the session, the next one joined to the one before, the backup keeps it, and no new session is made", async () => {
  const { readFileSync } = await import("node:fs");
  const h = home();
  const before = readdirSync(h.project).sort();
  const r = run(h, ["remove", "--turns", "2", "--session", ID]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.removed, true);
  assert.equal(out.created, undefined, "no new session");
  assert.deepEqual(readdirSync(h.project).sort(), before, "no new record beside the session's");
  const recs = readFileSync(join(h.project, `${ID}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((x) => x.uuid), ["u0", "a0", "u2", "a2"], "turn 2 is gone");
  assert.equal(recs.find((x) => x.uuid === "u2").parentUuid, "a0", "the next turn joined to the one before");
  const backups = readdirSync(join(h.dir, "session-split-backups"));
  assert.equal(backups.length, 1);
  const manifest = JSON.parse(readFileSync(join(h.dir, "session-split-backups", backups[0], "manifest.json"), "utf8"));
  assert.deepEqual([manifest.removed, manifest.files.newJsonl, manifest.files.newDir], [true, null, null]);
  assert.ok(readFileSync(join(h.dir, "session-split-backups", backups[0], `${ID}.jsonl`), "utf8").includes("顺手部署一下"), "the backup keeps the turn");
  assert.equal(run(h, ["remove", "--turns", "2", "--session", ID, "--dry-run"]).status, 0, "a dry run writes nothing");
});
