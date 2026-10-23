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

/** A Claude home with one session of a few turns (three by default), each a prompt and its answer. */
function home(texts = ["把测试补上", "顺手部署一下", "界面呢？"]) {
  const dir = mkdtempSync(join(tmpdir(), "gf-split-"));
  const project = join(dir, "projects", "C--work-app");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(dir, "desktop"));
  const recs = [];
  let parent = null;
  texts.forEach((text, n) => {
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

const records = async (file) => (await import("node:fs")).readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("split-session splits turns apart into one new session: in their order there, each run hanging off the one before; each gap in the original closed onto what came before it", async () => {
  const h = home(["甲一", "乙", "甲二", "甲三", "丙"]);
  const r = run(h, ["split", "--turns", "1,3-4", "--title", "甲", "--session", ID]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.turns.map((t) => t.n), [1, 3, 4]);
  const moved = (await records(join(h.project, `${out.created.cliId}.jsonl`))).filter((x) => x.uuid);
  assert.deepEqual(moved.map((x) => [x.uuid, x.parentUuid]), [["u0", null], ["a0", "u0"], ["u2", "a0"], ["a2", "u2"], ["u3", "a2"], ["a3", "u3"]], "one conversation: the second run follows the first");
  const kept = (await records(join(h.project, `${ID}.jsonl`))).filter((x) => x.uuid);
  assert.deepEqual(kept.map((x) => [x.uuid, x.parentUuid]), [["u1", null], ["a1", "u1"], ["u4", "a1"], ["a4", "u4"]], "each gap closed onto the turn before its run");
});

test("split-session picks turns by their prompt's record id, in their order whatever the order given; an id it cannot find says so and writes nothing", () => {
  const h = home(["甲一", "乙", "甲二", "甲三", "丙"]);
  const listed = JSON.parse(run(h, ["list", "--json", "--session", ID]).stdout);
  assert.deepEqual(listed.turns.map((t) => t.uuid), ["u0", "u1", "u2", "u3", "u4"], "list says each turn's id");
  const dry = run(h, ["split", "--uuids", "u3,u0,u2", "--title", "甲", "--session", ID, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).turns.map((t) => t.n), [1, 3, 4]);
  const missing = run(h, ["split", "--uuids", "zzzzzzzz-gone", "--title", "甲", "--session", ID]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), "错误：找不到这一轮：zzzzzzzz。先 list 看看，它可能已经拆走或删掉了。");
  assert.ok(!existsSync(join(h.dir, "session-split-backups")), "nothing written, not even a backup");
});

test("split-session remove takes turns apart in one go, each gap closed", async () => {
  const h = home();
  const r = run(h, ["remove", "--turns", "1,3", "--session", ID]);
  assert.equal(r.status, 0, r.stderr);
  const kept = (await records(join(h.project, `${ID}.jsonl`))).filter((x) => x.uuid);
  assert.deepEqual(kept.map((x) => [x.uuid, x.parentUuid]), [["u1", null], ["a1", "u1"]]);
});

/** A session whose first turn has a message typed while it ran: u0 a0 q0 a0b, then u1 a1. */
function withQueued() {
  const dir = mkdtempSync(join(tmpdir(), "gf-split-q-"));
  const project = join(dir, "projects", "C--work-app");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(dir, "desktop"));
  const at = (m) => `2026-10-16T01:${String(m).padStart(2, "0")}:00.000Z`;
  const recs = [
    { type: "user", uuid: "u0", parentUuid: null, sessionId: ID, timestamp: at(0), message: { role: "user", content: "改看板" } },
    { type: "assistant", uuid: "a0", parentUuid: "u0", sessionId: ID, timestamp: at(1), message: { role: "assistant", content: [{ type: "text", text: "在改" }] } },
    { type: "attachment", uuid: "q0", parentUuid: "a0", sessionId: ID, timestamp: at(2), attachment: { type: "queued_command", prompt: "顺便看下记忆", timestamp: at(2), origin: { kind: "human" } } },
    { type: "assistant", uuid: "a0b", parentUuid: "q0", sessionId: ID, timestamp: at(3), message: { role: "assistant", content: [{ type: "text", text: "改好了" }] } },
    { type: "user", uuid: "u1", parentUuid: "a0b", sessionId: ID, timestamp: at(4), message: { role: "user", content: "提交" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: ID, timestamp: at(5), message: { role: "assistant", content: [{ type: "text", text: "已提交" }] } },
  ];
  writeFileSync(join(project, `${ID}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { dir, project };
}

test("a message typed mid-turn, picked without its turn, moves alone: the new session's own message; the turn's answer stays, its gap closed", async () => {
  const h = withQueued();
  const listed = JSON.parse(run(h, ["list", "--json", "--session", ID]).stdout);
  assert.deepEqual(listed.messages.map((m) => [m.uuid, m.prompt, m.turn]), [["q0", "顺便看下记忆", 1]], "list names the message and its turn");
  const r = run(h, ["split", "--uuids", "q0", "--title", "记忆", "--session", ID]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.turns, out.messages], [[], [{ turn: 1, prompt: "顺便看下记忆" }]]);
  const moved = (await records(join(h.project, `${out.created.cliId}.jsonl`))).filter((x) => x.uuid);
  assert.deepEqual(moved.map((x) => [x.uuid, x.type, x.parentUuid, x.message?.content]), [["q0", "user", null, "顺便看下记忆"]], "only the message, now the person's own");
  assert.equal(moved[0].attachment, undefined);
  const kept = (await records(join(h.project, `${ID}.jsonl`))).filter((x) => x.uuid);
  assert.deepEqual(kept.map((x) => [x.uuid, x.parentUuid]), [["u0", null], ["a0", "u0"], ["a0b", "a0"], ["u1", "a0b"], ["a1", "u1"]], "the answer after it stays, hung on what came before the message");
});

test("a mid-turn message with a later turn goes into one session in order; inside a picked turn it goes with the turn; remove takes the message alone", async () => {
  const h = withQueued();
  const both = JSON.parse(run(h, ["split", "--uuids", "u1,q0", "--title", "x", "--session", ID]).stdout);
  const moved = (await records(join(h.project, `${both.created.cliId}.jsonl`))).filter((x) => x.uuid);
  assert.deepEqual(moved.map((x) => [x.uuid, x.parentUuid]), [["q0", null], ["u1", "q0"], ["a1", "u1"]]);
  const kept = (await records(join(h.project, `${ID}.jsonl`))).filter((x) => x.uuid);
  assert.deepEqual(kept.map((x) => [x.uuid, x.parentUuid]), [["u0", null], ["a0", "u0"], ["a0b", "a0"]]);
  const g = withQueued();
  const withTurn = JSON.parse(run(g, ["split", "--uuids", "u0,q0", "--title", "x", "--session", ID, "--dry-run"]).stdout);
  assert.deepEqual([withTurn.turns.map((t) => t.n), withTurn.messages], [[1], undefined], "inside its picked turn: no loose message");
  const k = withQueued();
  assert.equal(run(k, ["remove", "--uuids", "q0", "--session", ID]).status, 0);
  const left = (await records(join(k.project, `${ID}.jsonl`))).filter((x) => x.uuid);
  assert.deepEqual(left.map((x) => x.uuid), ["u0", "a0", "a0b", "u1", "a1"]);
  assert.equal(left.find((x) => x.uuid === "a0b").parentUuid, "a0");
});
