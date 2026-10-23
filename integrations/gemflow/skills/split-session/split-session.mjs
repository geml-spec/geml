#!/usr/bin/env node
// Move whole turns (a question plus everything answered under it) out of a
// Claude Code session into a new session of their own, and close the gap in
// the original. Works on the transcript JSONL under ~/.claude/projects and, when
// the session belongs to the desktop app, on its sidebar entry as well.
//
//   node split-session.mjs list  [--session <id>]
//   node split-session.mjs split --turns 3-5 --title "标题" [--session <id>] [--dry-run]
//   node split-session.mjs split --turns 2,5-6 --title "标题"     (turns apart: one new session)
//   node split-session.mjs split --uuids <uuid,...> --title "标题" (turns by their prompt's record id)
//
// <id> is a CLI session uuid, a desktop id (local_…), or a path to a .jsonl.
// Without --session it acts on the session it is running in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'dry-run' || key === 'json' || key === 'help') { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

function die(msg) { console.error('错误：' + msg); process.exit(1); }

if (!cmd || args.help) {
  console.log(`用法：
  node split-session.mjs list  [--session <id>]
  node split-session.mjs split --turns <N|N-M|N,M,...> --title <标题> [--session <id>] [--dry-run]
  node split-session.mjs remove --turns <N|N-M|N,M,...> [--session <id>] [--dry-run]
  --uuids <uuid,...> 代替 --turns：按每轮第一条记录（用户那条消息）的 uuid 选轮。
  选的轮不必连着：新会话里按原来的先后接起来，原会话里每个空档各自接回前一轮。

<id>：CLI 会话 uuid、桌面端 id（local_…）或 .jsonl 路径；省略时取当前会话。
测试用：--projects-dir / --desktop-dir / --backup-dir 覆盖默认位置。`);
  process.exit(cmd ? 0 : 1);
}

// ---------------------------------------------------------------- locations

const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = args['projects-dir'] || path.join(claudeHome, 'projects');
const backupRoot = args['backup-dir'] || path.join(claudeHome, 'session-split-backups');
// How the output names Claude's home: never the absolute path (it carries the user's name), never a value read from the environment.
const homeShown = process.env.CLAUDE_CONFIG_DIR ? '$CLAUDE_CONFIG_DIR' : '~/.claude';

function defaultDesktopDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude', 'claude-code-sessions');
}
const desktopDir = args['desktop-dir'] || defaultDesktopDir();

// Desktop entries live at <desktopDir>/<account>/<org>/local_<uuid>.json.
function desktopEntries() {
  const found = [];
  if (!fs.existsSync(desktopDir)) return found;
  for (const acct of fs.readdirSync(desktopDir, { withFileTypes: true })) {
    if (!acct.isDirectory()) continue;
    for (const org of fs.readdirSync(path.join(desktopDir, acct.name), { withFileTypes: true })) {
      if (!org.isDirectory()) continue;
      const dir = path.join(desktopDir, acct.name, org.name);
      for (const f of fs.readdirSync(dir)) {
        if (/^local_.*\.json$/.test(f)) found.push(path.join(dir, f));
      }
    }
  }
  return found;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The record of a session, and its name as its directory lists it: the id the output reports is the one on disk.
function findTranscript(cliId) {
  if (!fs.existsSync(projectsDir)) return null;
  const want = cliId + '.jsonl';
  for (const proj of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(projectsDir, proj.name);
    const name = fs.readdirSync(dir).find((n) => n === want);
    if (name !== undefined) return { file: path.join(dir, name), name };
  }
  return null;
}

// `given` is what --session said; without it, the session this runs in. An error names only what was given.
function resolveSession(given) {
  const current = process.env.CLAUDE_CODE_SESSION_ID;
  if (!given && !current) die('没有 --session，也不在 Claude Code 会话里（缺 CLAUDE_CODE_SESSION_ID）。');
  let cliId, found = null, desktopFile = null, desktop = null;
  if (given && given.endsWith('.jsonl')) {
    const file = path.resolve(given);
    found = { file, name: path.basename(file) };
  } else if (given && given.startsWith('local_')) {
    for (const f of desktopEntries()) {
      const m = readJson(f);
      if (m && m.sessionId === given) { desktopFile = f; desktop = m; break; }
    }
    if (!desktop) die(`桌面端找不到会话 ${given}。`);
    cliId = desktop.cliSessionId;
  } else {
    cliId = given || current;
  }
  found = found || findTranscript(cliId);
  if (!found || !fs.existsSync(found.file)) die(given ? `找不到会话 ${given} 的记录文件。` : '找不到当前会话的记录文件。');
  const jsonl = found.file;
  cliId = found.name.replace(/\.jsonl$/, '');
  if (!desktop) {
    for (const f of desktopEntries()) {
      const m = readJson(f);
      if (m && m.cliSessionId === cliId) { desktopFile = f; desktop = m; break; }
    }
  }
  const live = cliId === process.env.CLAUDE_CODE_SESSION_ID;
  return { cliId, jsonl, desktopFile, desktop, live };
}

// ---------------------------------------------------------------- transcript

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function parseJsonl(text) {
  const recs = [];
  for (const line of text.split('\n')) if (line.trim()) recs.push(JSON.parse(line));
  return recs;
}

// A live session may be halfway through appending its last line.
function readLines(file) {
  for (let attempt = 0; ; attempt++) {
    const text = fs.readFileSync(file, 'utf8');
    try { return { text, recs: parseJsonl(text) }; } catch (e) {
      if (attempt >= 10) throw e;
      sleep(200);
    }
  }
}

const isToolResult = (c) => Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');

// A line the person typed (or a slash command they ran), as opposed to tool
// results, injected context, compaction summaries and command output.
function isPrompt(o) {
  if (o.type !== 'user' || o.isMeta || o.isCompactSummary || o.isSidechain) return false;
  const c = o.message && o.message.content;
  if (isToolResult(c)) return false;
  const text = promptText(o);
  if (/^<local-command-(stdout|stderr)>/.test(text)) return false;
  return true;
}

function promptText(o) {
  const c = o.message && o.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const imgs = c.filter((b) => b.type === 'image').length;
    return (t || '') + (imgs ? ` [图片×${imgs}]` : '');
  }
  return '';
}

const parentOf = (o) => o.parentUuid || o.logicalParentUuid || null;

function analyze(recs) {
  const byId = new Map();
  recs.forEach((o, i) => { if (o.uuid) byId.set(o.uuid, { o, i }); });

  // The active branch: walk back from the last main-chain line, crossing
  // compaction boundaries through logicalParentUuid.
  let leaf = null;
  for (const o of recs) if (o.uuid && !o.isSidechain) leaf = o;
  const chain = [];
  const onChain = new Set();
  for (let cur = leaf; cur && !onChain.has(cur.uuid);) {
    chain.push(cur);
    onChain.add(cur.uuid);
    const p = parentOf(cur);
    cur = p ? byId.get(p)?.o : null;
  }
  chain.reverse();

  // Turns: each starts at a prompt and runs to the next one.
  const turns = [];
  for (let k = 0; k < chain.length; k++) {
    const o = chain[k];
    if (isPrompt(o)) turns.push({ n: turns.length + 1, start: k, end: chain.length, prompt: o });
    else if (turns.length) { /* belongs to the current turn */ }
  }
  for (let t = 0; t < turns.length - 1; t++) turns[t].end = turns[t + 1].start;

  // Lines the compaction machinery points at; moving any of them breaks resume.
  const pinned = new Set();
  for (const o of recs) {
    if (o.subtype === 'compact_boundary') {
      pinned.add(o.uuid);
      const ps = o.compactMetadata && o.compactMetadata.preservedSegment;
      if (ps) for (const k of ['headUuid', 'anchorUuid', 'tailUuid']) if (ps[k]) pinned.add(ps[k]);
    }
    if (o.isCompactSummary && o.uuid) pinned.add(o.uuid);
  }
  for (const t of turns) {
    const lines = chain.slice(t.start, t.end);
    t.lines = lines;
    t.blocked = lines.some((o) => pinned.has(o.uuid));
    t.interjections = lines.filter((o) => o.type === 'attachment' && o.attachment?.type === 'queued_command').length;
    t.subagents = lines.filter((o) => o.type === 'assistant' && Array.isArray(o.message?.content)
      && o.message.content.some((b) => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task'))).length;
  }
  return { byId, chain, onChain, turns, pinned };
}

function parseTurns(spec, max) {
  if (!spec) die('缺少 --turns。');
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) die(`--turns 写法不对：${part}`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || b > max) die(`轮次 ${part} 超出范围（1–${max}）。`);
    for (let n = a; n <= b; n++) set.add(n);
  }
  return [...set].sort((x, y) => x - y);
}

/** A message the person typed while a turn ran: an attachment record of type queued_command inside that turn. */
const isQueued = (o) => o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command' && !o.isSidechain;
/** A segment's first record's words: a prompt's, or a queued message's. */
const headText = (o) => (isQueued(o) ? String(o.attachment.prompt ?? '') : promptText(o));

/**
 * The turns and the loose messages asked for: by --uuids (a turn's prompt record, or a message typed mid-turn, its
 * queued_command attachment) or by --turns (their numbers). Turns in their order; messages in the transcript's.
 */
function pickTurns(turns, recs, onChain) {
  if (args.uuids) {
    const want = String(args.uuids).split(',').map((u) => u.trim()).filter(Boolean);
    if (!want.length) die('--uuids 是空的。');
    const found = [];
    const loose = [];
    for (const u of want) {
      const t = turns.find((x) => x.prompt.uuid === u);
      if (t) { found.push(t); continue; }
      const a = recs.find((o) => o.uuid === u && isQueued(o) && onChain.has(o.uuid));
      if (a) { loose.push(a); continue; }
      die(`找不到这一轮：${u.slice(0, 8)}。先 list 看看，它可能已经拆走或删掉了。`);
    }
    return { picked: [...new Set(found)].sort((a, b) => a.n - b.n), loose: [...new Set(loose)] };
  }
  return { picked: parseTurns(args.turns, turns.length).map((n) => turns[n - 1]), loose: [] };
}

const short = (s, n = 60) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
};
const localTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ---------------------------------------------------------------- list

function cmdList() {
  const s = resolveSession(args.session);
  const { recs } = readLines(s.jsonl);
  const { turns, onChain } = analyze(recs);
  const title = s.desktop?.title || recs.findLast?.((o) => o.type === 'custom-title')?.customTitle || '';
  if (args.json) {
    const turnOf = (u) => turns.find((t) => t.lines.some((o) => o.uuid === u))?.n ?? null;
    const messages = recs.filter((o) => isQueued(o) && onChain.has(o.uuid)).map((o) => ({ uuid: o.uuid, time: o.attachment.timestamp || o.timestamp, prompt: String(o.attachment.prompt ?? ''), turn: turnOf(o.uuid) }));
    console.log(JSON.stringify({
      session: s.cliId, desktopId: s.desktop?.sessionId || null, title, live: s.live,
      turns: turns.map((t, i) => ({
        n: t.n, uuid: t.prompt.uuid, time: t.prompt.timestamp, prompt: promptText(t.prompt), records: t.lines.length,
        blocked: t.blocked, current: s.live && i === turns.length - 1,
      })),
      messages,
    }, null, 2));
    return;
  }
  console.log(`会话：${title || '(无标题)'}  ${s.desktop?.sessionId || s.cliId}${s.live ? '  [当前会话]' : ''}`);
  turns.forEach((t, i) => {
    const flags = [];
    if (s.live && i === turns.length - 1) flags.push('当前这一轮，不可拆');
    if (t.blocked) flags.push('含压缩边界，不可拆');
    if (t.interjections) flags.push(`含插话×${t.interjections}`);
    if (t.subagents) flags.push(`子代理×${t.subagents}`);
    console.log(`#${t.n}  ${localTime(t.prompt.timestamp)}  ${short(promptText(t.prompt))}${flags.length ? '  [' + flags.join('，') + ']' : ''}`);
  });
}

// ---------------------------------------------------------------- split

function toolUseIds(lines) {
  const ids = new Set();
  for (const o of lines) {
    const c = o.message?.content;
    if (o.type === 'assistant' && Array.isArray(c)) for (const b of c) if (b.type === 'tool_use') ids.add(b.id);
  }
  return ids;
}

function rewriteSessionId(text, from, to) {
  return text.split('\n').map((line) => {
    if (!line.trim()) return line;
    const o = JSON.parse(line);
    if (o.sessionId === from) o.sessionId = to;
    return JSON.stringify(o);
  }).join('\n');
}

const toJsonl = (recs) => recs.map((o) => JSON.stringify(o)).join('\n') + '\n';

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// `remove` takes the turns out the way `split` does — backed up first, the next turn joined to the one before — and
// makes no new session: the turns are gone from the session, kept only in the backup.
function cmdSplit(removing = false) {
  const s = resolveSession(args.session);
  const title = (args.title || '').trim();
  if (!title && !removing) die('缺少 --title（新会话的标题）。');

  const first = readLines(s.jsonl);
  const { recs } = first;
  const { byId, onChain, turns, pinned } = analyze(recs);
  if (!turns.length) die('这个会话里没有可拆的轮次。');
  const { picked, loose: asked } = pickTurns(turns, recs, onChain);
  const turnOfLine = new Map();
  for (const t of turns) for (const o of t.lines) turnOfLine.set(o.uuid, t);
  // A message typed mid-turn inside a picked turn goes with that turn; one picked without its turn moves alone.
  const loose = asked.filter((a) => !picked.includes(turnOfLine.get(a.uuid)));
  if (s.live && picked.includes(turns[turns.length - 1])) die(removing ? '最后一轮是正在进行的这一轮，不能删。' : '最后一轮是正在进行的这一轮，不能拆。');
  if (s.live && loose.some((a) => turnOfLine.get(a.uuid) === turns[turns.length - 1])) die(removing ? '这条插话在正在进行的这一轮里，不能删。' : '这条插话在正在进行的这一轮里，不能拆。');
  if (loose.some((a) => pinned.has(a.uuid))) die(removing ? '这条插话跨着上下文压缩的边界，删了会话就续不上，不能删。' : '这条插话跨着上下文压缩的边界，拆了会话就续不上，不能拆。');
  const blocked = picked.filter((t) => t.blocked);
  if (blocked.length) die(removing ? `第 ${blocked.map((t) => t.n).join('、')} 轮跨着上下文压缩的边界，删了会话就续不上，不能删。` : `第 ${blocked.map((t) => t.n).join('、')} 轮跨着上下文压缩的边界，拆了会话就续不上，不能拆。`);

  // S: the picked turns, plus side branches hanging off them (abandoned retries).
  const S = new Set([...picked.flatMap((t) => t.lines.map((o) => o.uuid)), ...loose.map((a) => a.uuid)]);
  const memo = new Map();
  const hangsOffS = (o) => {
    const seen = [];
    let cur = o, verdict = false;
    while (cur) {
      if (memo.has(cur.uuid)) { verdict = memo.get(cur.uuid); break; }
      if (S.has(cur.uuid)) { verdict = true; break; }
      if (onChain.has(cur.uuid)) { verdict = false; break; }
      seen.push(cur.uuid);
      const p = parentOf(cur);
      cur = p ? byId.get(p)?.o : null;
    }
    for (const u of seen) memo.set(u, verdict);
    return verdict;
  };
  for (const o of recs) if (o.uuid && !o.isSidechain && !S.has(o.uuid) && hangsOffS(o)) S.add(o.uuid);

  // Segments: the picked turns next to each other (a run), and each loose message on its own, in the transcript's order.
  // In the original each segment's gap closes onto what came before it; in the new session each segment after the
  // first hangs off the end of the one before it.
  const runs = [];
  for (const t of picked) { const last = runs.at(-1); if (last && last.at(-1).n === t.n - 1) last.push(t); else runs.push([t]); }
  const indexOf = new Map(recs.map((o, i) => [o.uuid, i]));
  const segments = [
    ...runs.map((run) => ({ lines: run.flatMap((t) => t.lines), head: run[0].prompt, turn: true })),
    ...loose.map((a) => ({ lines: [a], head: a, turn: false })),
  ].sort((x, y) => indexOf.get(x.head.uuid) - indexOf.get(y.head.uuid));
  if (!segments.length) die('没有选中可拆的轮次。');
  const segOf = new Map();
  segments.forEach((g, i) => { for (const o of g.lines) segOf.set(o.uuid, i); });
  const runFor = (uuid) => {
    for (let cur = uuid; cur;) {
      if (segOf.has(cur)) return segOf.get(cur);
      const o = byId.get(cur)?.o;
      cur = o ? parentOf(o) : null;
    }
    return 0;
  };
  // What a segment's gap closes onto: the record before its head, past any segment that comes right before it.
  const before = segments.map((g) => {
    let p = parentOf(g.head);
    for (let guard = 0; p && S.has(p) && guard < segments.length; guard++) p = parentOf(segments[runFor(p)].head);
    return p && !S.has(p) ? p : null;
  });
  const joins = new Map(segments.slice(1).map((g, i) => [g.head.uuid, segments[i].lines.at(-1).uuid]));
  const windows = segments.filter((g) => g.turn).map((g) => [Date.parse(g.head.timestamp), Math.max(...g.lines.map((o) => Date.parse(o.timestamp) || 0))]);

  const firstPrompt = segments[0].head;
  const movedChain = recs.filter((o) => o.uuid && S.has(o.uuid));
  const t0 = Date.parse(firstPrompt.timestamp);
  const t1 = Math.max(...movedChain.map((o) => Date.parse(o.timestamp) || 0));

  // Bookkeeping lines that belong to the moved turns.
  const movesWith = (o) => {
    if (o.uuid) return S.has(o.uuid);
    if ((o.type === 'file-history-snapshot' || o.type === 'file-history-delta') && S.has(o.messageId)) return true;
    if (o.type === 'last-prompt' && S.has(o.leafUuid)) return true;
    if (o.type === 'queue-operation') {
      const ts = Date.parse(o.timestamp);
      return windows.some(([from, to]) => ts >= from - 5000 && ts <= to);
    }
    return false;
  };

  const newCli = randomUUID();
  const newDesktopId = 'local_' + randomUUID();

  // New transcript.
  const moved = [];
  for (const o of recs) {
    if (!movesWith(o) || o.type === 'last-prompt') continue; // a fresh one is appended below
    const c = structuredClone(o);
    if (c.sessionId === s.cliId) c.sessionId = newCli;
    // A loose message becomes the person's own message in the new session, the turn's answer left where it was.
    if (isQueued(c) && loose.some((a) => a.uuid === c.uuid)) {
      const said = String(c.attachment.prompt ?? '');
      const at = c.attachment.timestamp || c.timestamp;
      const origin = c.attachment.origin;
      delete c.attachment;
      Object.assign(c, { type: 'user', message: { role: 'user', content: said }, timestamp: at, ...(origin ? { origin } : {}) });
    }
    if (c.uuid === firstPrompt.uuid) { c.parentUuid = null; delete c.logicalParentUuid; }
    else if (joins.has(c.uuid)) { c.parentUuid = joins.get(c.uuid); delete c.logicalParentUuid; }
    moved.push(c);
  }
  const lastChain = moved.filter((o) => o.uuid).at(-1);
  const lastPrompt = segments.at(-1).head;
  moved.push({ type: 'custom-title', customTitle: title, sessionId: newCli });
  moved.push({ type: 'agent-name', agentName: title, sessionId: newCli });
  moved.push({ type: 'last-prompt', lastPrompt: short(headText(lastPrompt), 200), leafUuid: lastChain.uuid, sessionId: newCli });

  // Subagent transcripts started from the moved turns (and their own children).
  const srcAux = path.join(path.dirname(s.jsonl), s.cliId, 'subagents');
  const dstAux = path.join(path.dirname(s.jsonl), newCli, 'subagents');
  const subagents = [];
  if (fs.existsSync(srcAux)) {
    const metas = fs.readdirSync(srcAux).filter((f) => f.endsWith('.meta.json'));
    let ids = toolUseIds(movedChain);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of metas) {
        const base = m.slice(0, -'.meta.json'.length);
        if (subagents.includes(base)) continue;
        const meta = readJson(path.join(srcAux, m));
        if (!meta || !ids.has(meta.toolUseId)) continue;
        subagents.push(base);
        grew = true;
        const jl = path.join(srcAux, base + '.jsonl');
        if (fs.existsSync(jl)) for (const id of toolUseIds(readLines(jl).recs)) ids.add(id);
      }
    }
  }

  // Desktop sidebar entry, cloned from the source's so the new session opens
  // with the same folder, model and tools.
  let newMeta = null;
  if (s.desktop && !removing) {
    newMeta = structuredClone(s.desktop);
    for (const k of ['postTurnSummary', 'postTurnSummaryFor', 'parentSessionId', 'detached', 'startedBy',
      'name', 'prNumber', 'prState', 'prUrl', 'scheduledTaskId']) delete newMeta[k];
    Object.assign(newMeta, {
      sessionId: newDesktopId,
      cliSessionId: newCli,
      title,
      titleSource: 'user',
      titleTurn: 0,
      isArchived: false,
      createdAt: t0 || Date.now(),
      lastActivityAt: t1 || Date.now(),
      lastFocusedAt: Date.now(),
      completedTurns: picked.length + loose.length,
      lastAssistantUuid: moved.filter((o) => o.type === 'assistant').at(-1)?.uuid,
      latestUserFrameAt: Date.parse(lastPrompt.timestamp) || undefined,
      bridgeSessionIds: [],
      publishedArtifacts: [],
      writtenBranches: [],
      steeredByRemoteClient: false,
      spawnSeed: {},
    });
  }

  const summary = {
    source: { cliId: s.cliId, desktopId: s.desktop?.sessionId || null, title: s.desktop?.title || null },
    turns: picked.map((t) => ({ n: t.n, prompt: short(promptText(t.prompt), 80) })),
    ...(loose.length ? { messages: loose.map((a) => ({ turn: turnOfLine.get(a.uuid)?.n ?? null, prompt: short(headText(a), 80) })) } : {}),
    records: moved.length,
    subagents: subagents.length,
    ...(removing ? { removed: true } : { created: { cliId: newCli, desktopId: newMeta ? newDesktopId : null, title } }),
  };

  if (args['dry-run']) {
    console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2));
    return;
  }

  // Backups first.
  const backupName = `${stamp()}-${s.cliId.slice(0, 8)}`;
  const backupDir = path.join(backupRoot, backupName);
  const backupShown = args['backup-dir'] ? path.join(args['backup-dir'], backupName) : `${homeShown}/session-split-backups/${backupName}`;
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(s.jsonl, path.join(backupDir, path.basename(s.jsonl)));
  if (s.desktopFile) fs.copyFileSync(s.desktopFile, path.join(backupDir, path.basename(s.desktopFile)));

  // 1. The new session, complete, before the original is touched (none when removing: the backup keeps the turns).
  const newJsonl = removing ? null : path.join(path.dirname(s.jsonl), newCli + '.jsonl');
  if (newJsonl) fs.writeFileSync(newJsonl, toJsonl(moved));
  if (subagents.length && !removing) {
    fs.mkdirSync(dstAux, { recursive: true });
    for (const base of subagents) {
      const jl = path.join(srcAux, base + '.jsonl');
      if (fs.existsSync(jl)) fs.writeFileSync(path.join(dstAux, base + '.jsonl'), rewriteSessionId(fs.readFileSync(jl, 'utf8'), s.cliId, newCli));
      fs.copyFileSync(path.join(srcAux, base + '.meta.json'), path.join(dstAux, base + '.meta.json'));
    }
  }
  if (!removing) {
    fs.mkdirSync(path.join(path.dirname(s.jsonl), newCli), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(s.jsonl), newCli, 'custom-title.json'), JSON.stringify({ customTitle: title }));
  }
  let newMetaFile = null;
  if (newMeta) {
    newMetaFile = path.join(path.dirname(s.desktopFile), newDesktopId + '.json');
    fs.writeFileSync(newMetaFile, JSON.stringify(newMeta));
  }

  // 2. The original, without the moved lines, next turn joined to the one before.
  // A live session keeps appending, so rebuild from a fresh read until the
  // file is unchanged between read and write.
  const rebuild = (all) => {
    const kept = [];
    for (const o of all) {
      if (movesWith(o)) continue;
      if (o.parentUuid && S.has(o.parentUuid)) o.parentUuid = before[runFor(o.parentUuid)];
      if (o.logicalParentUuid && S.has(o.logicalParentUuid)) o.logicalParentUuid = before[runFor(o.logicalParentUuid)];
      kept.push(o);
    }
    return toJsonl(kept);
  };
  let written = false;
  for (let attempt = 0; attempt < 10 && !written; attempt++) {
    const { text: before, recs: all } = readLines(s.jsonl);
    const out = rebuild(all);
    if (fs.readFileSync(s.jsonl, 'utf8') === before) {
      fs.writeFileSync(s.jsonl, out);
      written = true;
    } else {
      sleep(200);
    }
  }
  if (!written) {
    die(removing ? `原会话一直在写入，没能改动它，原会话保持原样；备份在 ${backupShown}。` : `原会话一直在写入，没能改动它。新会话已经建好（${newCli}），原会话保持原样；备份在 ${backupShown}。`);
  }

  // When the moved turns were the last ones, the sidebar entry's pointer to the
  // latest reply would dangle. A live session's entry is the app's to rewrite.
  if (!s.live && s.desktop && S.has(s.desktop.lastAssistantUuid)) {
    const meta = structuredClone(s.desktop);
    const kept = readLines(s.jsonl).recs.filter((o) => o.type === 'assistant' && !o.isSidechain);
    meta.lastAssistantUuid = kept.at(-1)?.uuid;
    if (S.has(meta.postTurnSummaryFor)) { delete meta.postTurnSummary; delete meta.postTurnSummaryFor; }
    meta.completedTurns = Math.max(0, (meta.completedTurns || picked.length) - picked.length);
    fs.writeFileSync(s.desktopFile, JSON.stringify(meta));
  }
  for (const base of subagents) {
    for (const ext of ['.jsonl', '.meta.json']) {
      const f = path.join(srcAux, base + ext);
      if (fs.existsSync(f)) fs.renameSync(f, path.join(backupDir, base + ext));
    }
  }

  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
    ...summary, at: new Date().toISOString(),
    files: { original: s.jsonl, originalDesktop: s.desktopFile, newJsonl, newDesktop: newMetaFile,
      newDir: removing ? null : path.join(path.dirname(s.jsonl), newCli), subagentsBackedUp: subagents, subagentsHome: srcAux },
  }, null, 2));

  console.log(JSON.stringify({ ...summary, backup: backupShown, live: s.live }, null, 2));
}

// ---------------------------------------------------------------- main

if (cmd === 'list') cmdList();
else if (cmd === 'split') cmdSplit();
else if (cmd === 'remove') cmdSplit(true);
else die(`未知命令 ${cmd}`);
