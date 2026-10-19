// The project's shared session record: every session working on a project —
// Claude Code, Codex, Gemini CLI, DeepSeek Harness, on whichever branch or
// worktree — keeps one log in the main working tree's `.geml/sessions/`, which
// no branch tracks. Each log is a GEML document whose `=== data {#events
// format=jsonl}` block holds one JSON event a line, written by its own session
// alone and read by all of them (an earlier log, plain JSON lines in a .jsonl
// file, still reads): what was asked, what was answered,
// the conclusions and decisions the model recorded, the files and commits the
// session made. Pure: the hosts read and write the files.

/** The directory under the project's shared `.geml/` that holds the logs, and the ignore file that keeps them out of git. */
export const SESSIONS_DIR = "sessions";
export const SESSIONS_GITIGNORE = "*\n";

export type SessionEvent =
  | { t: "session"; id: string; host: string; at: string; branch?: string; checkout?: string }
  | { t: "prompt"; turn: number; at: string; text: string }
  | { t: "answer"; turn: number; at: string; text: string }
  | { t: "decision"; turn: number; at: string; text: string }
  | { t: "file"; turn: number; at: string; path: string; branch?: string }
  | { t: "commit"; turn: number; at: string; sha: string; subject: string; branch?: string };

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");

/** A log's file name: the host and the session's id, neither able to leave the directory. */
export function logName(host: string, id: string): string {
  return `${safe(host)}-${safe(id)}.geml`;
}

/** The name an earlier log had (plain JSON lines): read, and carried into the GEML one when the session writes next. */
export function legacyLogName(host: string, id: string): string {
  return `${safe(host)}-${safe(id)}.jsonl`;
}

/** Whether a directory entry is a log: a GEML one, or an earlier .jsonl one with no GEML one beside it. */
export function isLogName(name: string, names: readonly string[]): boolean {
  if (name.endsWith(".geml")) return true;
  return name.endsWith(".jsonl") && !names.includes(`${name.slice(0, -".jsonl".length)}.geml`);
}

/** The fence that opens a log's events. */
const EVENTS_OPEN = "=== data {#events format=jsonl}";

function isEvent(v: unknown): v is SessionEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (typeof e["at"] !== "string") return false;
  switch (e["t"]) {
    case "session": return typeof e["id"] === "string" && typeof e["host"] === "string";
    case "prompt": case "answer": case "decision": return typeof e["turn"] === "number" && typeof e["text"] === "string";
    case "file": return typeof e["turn"] === "number" && typeof e["path"] === "string";
    case "commit": return typeof e["turn"] === "number" && typeof e["sha"] === "string" && typeof e["subject"] === "string";
    default: return false;
  }
}

/** The events of a log (its events block, or every line of an earlier log); a line that is no event (one cut short while its session wrote it) is left out. */
export function parseLog(text: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  let lines = text.split(/\r?\n/);
  const open = lines.findIndex((l) => l.trim() === EVENTS_OPEN);
  if (open >= 0) {
    const close = lines.findIndex((l, i) => i > open && l.trim() === "===");
    lines = lines.slice(open + 1, close < 0 ? undefined : close);
  }
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isEvent(v)) out.push(v);
    } catch { /* not an event */ }
  }
  return out;
}

/** A log document holding `events`, one JSON event a line in its events block. */
export function formatLog(events: readonly SessionEvent[]): string {
  return `${EVENTS_OPEN}\n${events.map((e) => `${JSON.stringify(e)}\n`).join("")}===\n`;
}

/** The log with `events` added at the end of its events (an earlier log comes out as a GEML one). */
export function appendEvents(text: string, events: readonly SessionEvent[]): string {
  return formatLog([...parseLog(text), ...events]);
}

/** The turn the next prompt opens: one past the last one the log holds. */
export function nextTurn(events: readonly SessionEvent[]): number {
  return events.reduce((n, e) => ("turn" in e && e.turn >= n ? e.turn + 1 : n), 1);
}

/** The turn now under way: the last prompt's. */
export function currentTurn(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as SessionEvent;
    if (e.t === "prompt") return e.turn;
  }
  return 0;
}

export interface SessionTurn { turn: number; at: string; prompt: string; answer?: string; decisions: string[] }

/** One session as the record holds it: who, where, when, and what it asked, decided and made. */
export interface SessionSummary {
  id: string;
  host: string;
  branch?: string;
  checkout?: string;
  started: string;
  last: string;
  turns: SessionTurn[];
  decisions: { turn: number; at: string; text: string }[];
  files: { path: string; at: string; branch?: string }[];
  commits: { sha: string; subject: string; at: string; branch?: string }[];
}

/** A log read as one session; undefined for a log with no session line. */
export function summarize(events: readonly SessionEvent[]): SessionSummary | undefined {
  const head = events.find((e): e is Extract<SessionEvent, { t: "session" }> => e.t === "session");
  if (head === undefined) return undefined;
  const s: SessionSummary = {
    id: head.id, host: head.host, ...(head.branch !== undefined ? { branch: head.branch } : {}), ...(head.checkout !== undefined ? { checkout: head.checkout } : {}),
    started: head.at, last: head.at, turns: [], decisions: [], files: [], commits: [],
  };
  const turn = (n: number, at: string): SessionTurn => {
    let found = s.turns.find((x) => x.turn === n);
    if (found === undefined) { found = { turn: n, at, prompt: "", decisions: [] }; s.turns.push(found); }
    return found;
  };
  for (const e of events) {
    if (e.at > s.last) s.last = e.at;
    switch (e.t) {
      case "session": break;
      case "prompt": turn(e.turn, e.at).prompt = e.text; break;
      case "answer": turn(e.turn, e.at).answer = e.text; break;
      case "decision": turn(e.turn, e.at).decisions.push(e.text); s.decisions.push({ turn: e.turn, at: e.at, text: e.text }); break;
      case "file": if (!s.files.some((f) => f.path === e.path)) s.files.push({ path: e.path, at: e.at, ...(e.branch !== undefined ? { branch: e.branch } : {}) }); break;
      case "commit": if (!s.commits.some((c) => c.sha === e.sha)) s.commits.push({ sha: e.sha, subject: e.subject, at: e.at, ...(e.branch !== undefined ? { branch: e.branch } : {}) }); break;
    }
  }
  s.turns.sort((a, b) => a.turn - b.turn);
  return s;
}

export interface SharedDecision { text: string; at: string; session: string; host: string; branch?: string }

/** The other sessions' decisions recorded after `since` (all of them when null), oldest first, at most `limit` (the newest kept). */
export function decisionsSince(sessions: readonly SessionSummary[], ownId: string, since: string | null, limit = 12): SharedDecision[] {
  const out: SharedDecision[] = [];
  for (const s of sessions) {
    if (s.id === ownId) continue;
    for (const d of s.decisions) if (since === null || d.at > since) out.push({ text: d.text, at: d.at, session: s.id, host: s.host, ...(s.branch !== undefined ? { branch: s.branch } : {}) });
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out.slice(-limit);
}

/** The files the sessions changed, each with the sessions that changed it; more than one is a clash to settle before merging. Newest first. */
export function filesBySession(sessions: readonly SessionSummary[]): { path: string; at: string; sessions: string[] }[] {
  const by = new Map<string, { path: string; at: string; sessions: string[] }>();
  for (const s of sessions) {
    for (const f of s.files) {
      const was = by.get(f.path);
      if (was === undefined) by.set(f.path, { path: f.path, at: f.at, sessions: [s.id] });
      else {
        if (!was.sessions.includes(s.id)) was.sessions.push(s.id);
        if (f.at > was.at) was.at = f.at;
      }
    }
  }
  return [...by.values()].sort((a, b) => (a.sessions.length !== b.sessions.length ? b.sessions.length - a.sessions.length : a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The tool every host lists for the model to record a turn's conclusions and decisions in its session's log. */
export const NOTE_TOOL = {
  name: "note",
  description: "Record this turn's conclusions and decisions in the project's shared session record, so the project's other sessions (on other branches, worktrees and tools) know them. Call it once before the turn ends when the turn reached any: each a short sentence that stands on its own. Not for progress notes or plans.",
  inputSchema: {
    type: "object",
    properties: { decisions: { type: "array", items: { type: "string" }, description: "The conclusions and decisions, one short sentence each." } },
    required: ["decisions"],
    additionalProperties: false,
  },
} as const;

/** What the model is told once, in the system prompt, about the project's other sessions. */
export const SESSIONS_PROMPT = "Gemflow: this project is worked on in several sessions at once, on other branches, worktrees and tools. When a turn reaches conclusions or decisions the other sessions should know, record them with the gemflow `note` tool before the turn ends, one short sentence each. Decisions the other sessions recorded arrive beside the person's prompts, marked [gemflow].";

/** The other sessions' decisions as the line beside a prompt says them. */
export function decisionsContext(decisions: readonly SharedDecision[], label: (d: SharedDecision) => string): string {
  return ["[gemflow] 本项目其他会话记下的决定：", ...decisions.map((d) => `- ${d.text}（${label(d)}）`)].join("\n");
}
