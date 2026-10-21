// The board on DeepSeek Harness (spec §8.10): a session's supervision drawn as
// the rows the Claude Code board draws, served to the browser half over
// /api/gemflow; a press is a person's transition, a tick, a hold, or a lesson
// into tools.geml. Five tabs: dsh keeps its own sessions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { readDictionary } from "../dist/core/dictionary-file.js";
import { readDictionaryFile } from "../dist/dictionary-io.js";
import { DSH_TOOLS } from "../dist/core/host-tools.js";
import { readJournal } from "../dist/core/journal.js";
import { statusOf } from "../dist/core/status.js";
import { loadStatechart } from "../dist/core/statechart.js";
import { openRun, Supervisor } from "../dist/core/supervisor.js";
import { actOnSession, boardReply, DSH_TABS, readQuery, sessionBoard, sessionShell } from "../dist/hosts/dsh/board.js";
import { attach, boardApi } from "../dist/hosts/dsh/plugin.js";
import { world } from "./helpers/harness.mjs";

const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
const FLOW = readFileSync(FIX, "utf8");
const TOOLS = readFileSync(new URL("./fixtures/refund-tools.geml", import.meta.url), "utf8");
const DEV = { flow: readFileSync(new URL("./fixtures/ws-dev/flow.geml", import.meta.url), "utf8"), tools: readFileSync(new URL("./fixtures/ws-dev/tools.geml", import.meta.url), "utf8"), name: "dev" };
const NOW = "2026-10-13T10:00:00.000Z";
delete process.env.GEMFLOW_STATECHART;

/** A session's supervision in memory: the refund workflow, a fresh run, the journal as its blocks read back. */
function supervision(item = "session:s1", w = { flow: FLOW, tools: TOOLS, name: "refund" }) {
  const sc = loadStatechart(w.flow, "flow.geml").statechart;
  const dictionary = readDictionary(w.tools, sc);
  const opened = openRun({ sc, item, workflowFile: "flow.geml", journalText: null, source: "startup", now: NOW });
  assert.equal(opened.ok, true);
  const blocks = [opened.head, ...opened.blocks];
  const sup = new Supervisor(sc, opened.run, { append: (b) => blocks.push(b), now: () => NOW, tools: DSH_TOOLS, dictionary });
  const s = { sc, sup, dictionary, item, workflow: { name: w.name, path: "flow.geml", title: w.name }, journal: null, root: "/p" };
  const fresh = () => ({ ...s, journal: readJournal(blocks.join("")) });
  return { s: fresh(), fresh, sc, sup };
}

test("the query: a tab and a filter the board knows, else their defaults; an empty expanded is none; the sessions tab is not on this host", () => {
  assert.deepEqual(readQuery(new URLSearchParams("session=s1&tab=flow&filter=refusals&expanded=rev-2&lang=en")), { session: "s1", tab: "flow", filter: "refusals", expanded: "rev-2", lang: "en" });
  assert.deepEqual(readQuery(new URLSearchParams("tab=nope&filter=x&expanded=")), { session: "", tab: "items", filter: "all", expanded: null });
  assert.deepEqual(DSH_TABS, ["items", "journal", "flow", "tools"]);
  assert.equal(readQuery(new URLSearchParams("tab=sessions")).tab, "items");
});

test("a session's status, shell and board come from the same functions as a work item's: the initial state, its ways out, the dictionary, the one item, the journal's timeline", () => {
  const { s, sc } = supervision();
  const shell = sessionShell(s, "zh-CN", { gemflow: "0.1.0", parser: "1.12.5" });
  assert.equal(shell.contextKey, null, "no context document on this host");
  assert.equal(shell.status.item.id, "session:s1");
  assert.equal(shell.status.state.id, sc.initial);
  assert.equal(shell.status.workflow.name, "refund");
  assert.ok(shell.status.next.length > 0, "the initial state has a way out");
  assert.deepEqual(shell.status, statusOf(sc, { workflow: s.workflow, item: { kind: "item", id: "session:s1" } }, s.sup.run));
  assert.equal(shell.policy.active, true);
  assert.equal(shell.policy.state, sc.initial);
  const board = sessionBoard(s, shell.status, shell.policy);
  assert.equal(board.states.length, sc.states.size);
  assert.equal(board.transitions.length, sc.transitions.length);
  assert.deepEqual(board.items, [{ id: "session:s1", state: sc.initial, rev: 0, at: NOW, paused: false }]);
  assert.equal(board.backlog, null);
  assert.equal(board.timeline.length, 1, "the journal's first revision");
  assert.equal(board.tools.length, shell.policy.rows.length);
});

test("the reply: five tabs in the browser's language, the header, one tab's rows, and only the presses this host runs", () => {
  const { s } = supervision();
  const zh = boardReply(s, readQuery(new URLSearchParams("session=s1&tab=flow&lang=zh")), NOW, "zh-CN", { gemflow: "0.1.0", parser: "1.12.5" });
  assert.deepEqual(zh.tabs.map((x) => x.id), ["items", "journal", "flow", "tools"]);
  assert.equal(zh.tabs[0].label, "工作项");
  assert.equal(zh.header.item, "session:s1");
  assert.equal(zh.header.workflow, "refund");
  assert.equal(zh.header.state.id, s.sc.initial);
  assert.equal(zh.header.version, "0.1.0");
  const picture = zh.rows.find((r) => r.kind === "flow");
  assert.equal(zh.rows[0].text, `${s.workflow.title}  ${s.workflow.name}`, "the flow tab opens on its title, then the picture");
  assert.equal(picture.ranks.flat().find((x) => x.current)?.id, s.sc.initial, "the current state marked");
  assert.ok(picture.svg.includes(`class="node initial cur" data-state="${s.sc.initial}"`), "drawn with the session's state laid over it");
  const en = boardReply(s, readQuery(new URLSearchParams("session=s1&tab=items&lang=en")), NOW);
  assert.equal(en.tabs[0].label, "Items");
  assert.ok(en.rows.some((r) => r.kind === "text" && r.text.includes("session:s1")), "the items tab lists the session");
  assert.deepEqual(en.rows.filter((r) => r.kind === "text" && r.tone === "dim" && /^(Pending|In progress|Merged|Closed|Dropped)/.test(r.text)).map((r) => r.text), ["Pending", "In progress · 1", "Merged · 0", "Closed · 0", "Dropped · 0"], "the work items tab's headings, as lines the browser half draws: the session is its one work item, being worked on");
  assert.ok(en.rows.every((r) => ["text", "button", "buttons", "link", "input", "flow"].includes(r.kind)), "no row of a kind the browser half has no drawing of");
  assert.ok(!zh.rows.some((r) => r.kind === "link"), "the flow is not a file to open from the board");
  assert.equal(typeof zh.pending, "number");
  const ops = (rows) => rows.flatMap((r) => r.kind === "button" ? [r.action.op] : r.kind === "buttons" ? r.items.map((b) => b.action.op) : []);
  const journal = boardReply(s, readQuery(new URLSearchParams("session=s1&tab=journal")), NOW);
  assert.ok(!ops(journal.rows).includes("export"), "an export is not on this host, so its button is not drawn");
  assert.ok(ops(journal.rows).includes("filter"), "the filters stay");
  const tools = boardReply(s, readQuery(new URLSearchParams("session=s1&tab=tools")), NOW);
  assert.ok(tools.rows.some((r) => r.kind === "input" && r.field === "add-tool"), "the add-tool field is on this host");
  // A tool's menu is Claude Code's: here the rows are lines, and a lesson is the add-tool field's.
  const dev = boardReply(supervision("session:s1", DEV).s, readQuery(new URLSearchParams("session=s1&tab=tools")), NOW);
  assert.ok(!ops(dev.rows).includes("tool-menu"), "no menu this host cannot open");
  assert.ok(dev.rows.some((r) => r.kind === "text" && r.text.startsWith("npm test  跑测试（首选）")), "the dictionary's rows, with their uses, as lines");
  assert.ok(!dev.rows.some((r) => r.kind === "buttons" && r.items.length === 0), "no empty button row is left behind");
});

test("a press: a hold and its release, a tick a person may not make, a transition that is not there, a lesson and a typed line into tools.geml, and what the host cannot do", () => {
  const { sup, sc, fresh } = supervision();
  const workflowDir = mkdtempSync(join(tmpdir(), "gemflow-dsh-board-"));
  try {
    writeFileSync(join(workflowDir, "tools.geml"), TOOLS);
    const workflowFile = join(workflowDir, "flow.geml");
    const s = { sup, sc, workflowFile };
    assert.deepEqual(actOnSession(s, { op: "pause" }, NOW), { ok: true });
    assert.equal(sup.paused, true);
    assert.equal(fresh().journal.snapshots.at(-1).cause, "pause", "journaled");
    assert.deepEqual(actOnSession(s, { op: "resume" }, NOW), { ok: true });
    assert.equal(sup.paused, false);
    const tick = actOnSession(s, { op: "mark", variable: "amount", checked: true }, NOW);
    assert.equal(tick.ok, false);
    const move = actOnSession(s, { op: "advance", to: "nowhere" }, NOW);
    assert.equal(move.ok, false);
    assert.deepEqual(actOnSession(s, { op: "learn", lessons: [{ kind: "default", key: "pay_refund", use: "refund" }] }, NOW), { ok: true });
    assert.equal(readDictionaryFile(workflowFile, sc).rows.find((r) => r.tool === "pay_refund").default, true, "the lesson is in the file the Supervisor reads afresh");
    assert.deepEqual(actOnSession(s, { op: "input", field: "add-tool", value: " Bash(make) | refund " }, NOW), { ok: true });
    assert.equal(readDictionaryFile(workflowFile, sc).rows.find((r) => r.tool === "Bash(make)").for, "refund", "a typed line is a lesson");
    assert.equal(actOnSession(s, { op: "input", field: "add-tool", value: "   " }, NOW).ok, false, "an empty line adds nothing");
    assert.deepEqual(actOnSession(s, { op: "input", field: "import-workflow", value: "/x" }, NOW), { ok: false, error: "import-workflow is not on this host" });
    assert.deepEqual(actOnSession(s, { op: "export", session: "own" }, NOW), { ok: false, error: "export is not on this host" });
  } finally {
    rmSync(workflowDir, { recursive: true, force: true });
  }
});

/** One request to the board's routes, the way node:http would hand it over. */
function request(api, method, url, body) {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { method, url, headers: {} });
    let code = 0;
    let text = "";
    const res = { writeHead: (c) => { code = c; }, end: (t) => { text += t ?? ""; resolve({ code, body: JSON.parse(text) }); } };
    void api(req, res);
  });
}

test("on a real agent: the routes answer the session's board, run a press, and refuse what is not there", async () => {
  const w = await world();
  try {
    const file = join(w.dir, ".geml", "workflows", "refund", "flow.geml");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, FLOW);
    writeFileSync(join(dirname(file), "tools.geml"), TOOLS);
    const a = attach(w.ctx, w.agent, "startup", { journalDir: join(w.dir, "journals"), onMissing: "skip" });
    assert.ok(a !== null);
    const id = String(w.agent.id);
    const api = boardApi(new Map([[id, a]]));
    const board = await request(api, "GET", `/api/gemflow/board?session=${encodeURIComponent(id)}&tab=flow&lang=zh`);
    assert.equal(board.code, 200);
    assert.equal(board.body.ok, true);
    assert.equal(board.body.header.item, `session:${id}`);
    assert.equal(board.body.header.workflow, "refund");
    assert.ok(board.body.rows.length > 3);
    assert.ok(board.body.rows.some((r) => r.kind === "flow"), "the picture travels with the rows");
    const tools = await request(api, "GET", `/api/gemflow/board?session=${encodeURIComponent(id)}&tab=tools&lang=zh`);
    assert.ok(tools.body.rows.some((r) => r.kind === "text" && r.text.startsWith("pay_refund")), "the dictionary's rows, as lines");
    const paused = await request(api, "POST", "/api/gemflow/act", JSON.stringify({ session: id, action: { op: "pause" } }));
    assert.deepEqual(paused, { code: 200, body: { ok: true } });
    const again = await request(api, "GET", `/api/gemflow/board?session=${encodeURIComponent(id)}`);
    assert.equal(again.body.header.paused, true);
    await request(api, "POST", "/api/gemflow/act", JSON.stringify({ session: id, action: { op: "resume" } }));
    const bad = await request(api, "POST", "/api/gemflow/act", JSON.stringify({ session: id, action: { op: "advance", to: "nowhere" } }));
    assert.equal(bad.code, 400);
    assert.equal(bad.body.ok, false);
    assert.equal((await request(api, "GET", "/api/gemflow/board?session=nobody")).code, 404);
    assert.equal((await request(api, "POST", "/api/gemflow/act", "not json")).code, 400);
    assert.equal((await request(api, "POST", "/api/gemflow/act", JSON.stringify({ session: id, action: 7 }))).code, 400);
    assert.equal((await request(api, "GET", "/api/gemflow/other")).code, 404);
    a.dispose();
  } finally {
    w.dispose();
  }
});
