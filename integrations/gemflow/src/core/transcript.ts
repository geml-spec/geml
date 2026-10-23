// A Claude Code transcript — ~/.claude/projects/<slug>/<session>.jsonl, one
// JSON record a line — read into the turns the project's shared session record
// keeps (session-log.ts): what the person asked, what was answered, the files
// written, the pages published, what they gave with a prompt. Pure: the bridge
// reads the file and writes the log.
import { publishedLink } from "./artifact-tool.js";
import type { SessionEvent } from "./session-log.js";

/** One turn of a transcript: a prompt and what followed it before the next. */
export interface TranscriptTurn {
  /** The prompt record's uuid: what makes a turn the same one when the transcript is read again. */
  uuid: string;
  at: string;
  text: string;
  /** Who asked: the person; a scheduled task (`scheduled` names it); another session's message. */
  kind: "person" | "scheduled" | "peer";
  scheduled?: string;
  branch?: string;
  cwd?: string;
  /** The last answer with words before the next prompt, and when. */
  answer?: string;
  answerAt?: string;
  /** The files Write, Edit and NotebookEdit wrote, in order, once each. */
  files: string[];
  /** The pages the Artifact tool published. */
  links: { url: string; version?: string; title?: string }[];
  /** Pictures and documents the person gave with the prompt: their bytes as the transcript holds them. */
  uploads: { name?: string; mediaType?: string; data: string }[];
}

export interface Transcript {
  id: string;
  cwd?: string;
  branch?: string;
  started: string;
  last: string;
  turns: TranscriptTurn[];
}

/** The folder under ~/.claude/projects that holds a directory's transcripts: every character but letters, digits and `-` becomes `-`. */
export function slugOf(path: string): string {
  return path.replace(/[^A-Za-z0-9-]/g, "-");
}

type Block = { type?: unknown; text?: unknown; name?: unknown; id?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; source?: unknown };
type Rec = {
  type?: unknown; uuid?: unknown; timestamp?: unknown; cwd?: unknown; gitBranch?: unknown; sessionId?: unknown;
  isSidechain?: unknown; isMeta?: unknown; isCompactSummary?: unknown; origin?: { kind?: unknown } | null;
  message?: { content?: unknown } | null;
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? content.filter((b): b is Block => typeof b === "object" && b !== null) : []);
const textOf = (content: unknown): string => (typeof content === "string" ? content : blocksOf(content).filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n"));
const resultText = (b: Block): string => (typeof b.content === "string" ? b.content : blocksOf(b.content).filter((x) => x.type === "text").map((x) => str(x.text) ?? "").join("\n"));

/** The words of a prompt the person sees: the host's reminders and notices stripped; nothing when only those were there. */
function promptWords(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<artifact-content-authored-by-others\/>/g, "").trim();
}

/** What a user record is: a prompt (and whose), a tool result, or nothing the record keeps. */
function promptKind(o: Rec, words: string): TranscriptTurn["kind"] | undefined {
  if (o.isSidechain === true || o.isMeta === true || o.isCompactSummary === true) return undefined;
  const origin = o.origin?.kind;
  if (origin === "task-notification") return undefined;
  if (words === "" || /^<(local-command|command-name|task-notification)/.test(words)) return undefined;
  if (/^The summarized conversation/.test(words) || /^<command-message>/.test(words)) return undefined;
  if (/^<scheduled-task\b/.test(words)) return "scheduled";
  if (origin === "peer") return "peer";
  return "person";
}

/** A message the person typed while a turn ran: its record's uuid, its words, when it was sent. */
export interface QueuedMessage { uuid: string; text: string; at: string }

/** The messages the person typed while a turn ran: attachment records of type queued_command, in order. */
export function queuedMessages(text: string): QueuedMessage[] {
  const out: QueuedMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("queued_command")) continue;
    let o: { type?: unknown; uuid?: unknown; timestamp?: unknown; isSidechain?: unknown; attachment?: { type?: unknown; prompt?: unknown; timestamp?: unknown } };
    try { o = JSON.parse(line) as typeof o; } catch { continue; }
    if (o.type !== "attachment" || o.isSidechain === true || o.attachment?.type !== "queued_command") continue;
    const uuid = str(o.uuid);
    const words = str(o.attachment.prompt);
    const at = str(o.attachment.timestamp) ?? str(o.timestamp);
    if (uuid !== undefined && words !== undefined && at !== undefined) out.push({ uuid, text: words, at });
  }
  return out;
}

/** The transcript's turns; undefined when the text holds no session. */
export function readTranscript(text: string): Transcript | undefined {
  let id: string | undefined;
  let started: string | undefined;
  let last: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  const turns: TranscriptTurn[] = [];
  /** The tool calls whose results are still to come: which turn, what the call was. */
  const pending = new Map<string, { turn: TranscriptTurn; tool: string; input: Record<string, unknown> }>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let o: Rec;
    try { o = JSON.parse(line) as Rec; } catch { continue; }
    if (typeof o !== "object" || o === null) continue;
    const at = str(o.timestamp);
    if (at !== undefined) { started ??= at; last = at; }
    id ??= str(o.sessionId);
    const current = turns[turns.length - 1];
    if (o.type === "user") {
      if (o.isSidechain === true) continue;
      const content = o.message?.content;
      const results = blocksOf(content).filter((b) => b.type === "tool_result");
      if (results.length > 0) {
        for (const r of results) {
          const call = pending.get(str(r.tool_use_id) ?? "");
          if (call === undefined) continue;
          pending.delete(str(r.tool_use_id) ?? "");
          if (call.tool === "Artifact") {
            const link = publishedLink(resultText(r));
            const title = str(call.input["title"]);
            if (link !== undefined && !call.turn.links.some((l) => l.url === link.url && l.version === link.version)) call.turn.links.push({ ...link, ...(title !== undefined ? { title } : {}) });
          }
        }
        continue;
      }
      const words = promptWords(textOf(content));
      const kind = promptKind(o, words);
      if (kind === undefined || at === undefined) continue;
      const uuid = str(o.uuid) ?? `${at}#${turns.length}`;
      const scheduled = kind === "scheduled" ? /<scheduled-task\b[^>]*\bname="([^"]*)"/.exec(words)?.[1] : undefined;
      const uploads = blocksOf(content).filter((b) => b.type === "image" || b.type === "document").flatMap((b) => {
        const source = b.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
        const data = str(source?.data);
        return source?.type === "base64" && data !== undefined && data !== "" ? [{ ...(str(source.media_type) !== undefined ? { mediaType: str(source.media_type) as string } : {}), data }] : [];
      });
      const turn: TranscriptTurn = {
        uuid, at, text: words, kind, ...(scheduled !== undefined ? { scheduled } : {}),
        ...(str(o.gitBranch) !== undefined ? { branch: str(o.gitBranch) as string } : {}), ...(str(o.cwd) !== undefined ? { cwd: str(o.cwd) as string } : {}),
        files: [], links: [], uploads,
      };
      cwd ??= turn.cwd;
      branch ??= turn.branch;
      turns.push(turn);
      continue;
    }
    if (o.type === "assistant" && current !== undefined && o.isSidechain !== true) {
      const blocks = blocksOf(o.message?.content);
      const words = blocks.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n").trim();
      if (words !== "") { current.answer = words; if (at !== undefined) current.answerAt = at; }
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        const tool = str(b.name) ?? "";
        const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
        if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
          const path = str(input["file_path"]) ?? str(input["notebook_path"]);
          if (path !== undefined && !current.files.includes(path)) current.files.push(path);
        } else if (tool === "Artifact" && str(b.id) !== undefined) {
          pending.set(str(b.id) as string, { turn: current, tool, input });
        }
      }
    }
  }
  if (turns.length === 0 && id === undefined) return undefined;
  const first = turns[0]?.at ?? started;
  if (first === undefined) return undefined;
  return { id: id ?? "", ...(cwd !== undefined ? { cwd } : {}), ...(branch !== undefined ? { branch } : {}), started: first, last: last ?? first, turns };
}

/**
 * A transcript as the session record's events, turns numbered from `from`:
 * a session line first when `head` is wanted, then each turn's prompt (its
 * uuid kept, marked backfilled), its answer, and the files it wrote.
 */
export function transcriptEvents(tr: Transcript, host: string, o: { head: boolean; from?: number }): SessionEvent[] {
  const out: SessionEvent[] = [];
  const scheduled = tr.turns[0]?.kind === "scheduled" ? tr.turns[0].scheduled ?? "" : undefined;
  if (o.head) out.push({ t: "session", id: tr.id, host, at: tr.started, ...(tr.branch !== undefined ? { branch: tr.branch } : {}), ...(tr.cwd !== undefined ? { checkout: tr.cwd } : {}), backfilled: true, ...(scheduled !== undefined ? { scheduled } : {}) });
  let n = o.from ?? 1;
  for (const turn of tr.turns) {
    out.push({ t: "prompt", turn: n, at: turn.at, text: turn.text, uuid: turn.uuid, backfilled: true, ...(turn.kind !== "person" ? { kind: turn.kind } : {}) });
    if (turn.answer !== undefined) out.push({ t: "answer", turn: n, at: turn.answerAt ?? turn.at, text: turn.answer });
    for (const path of turn.files) out.push({ t: "file", turn: n, at: turn.at, path, ...(turn.branch !== undefined ? { branch: turn.branch } : {}) });
    n += 1;
  }
  return out;
}

/** The turns of `tr` whose prompt uuid no event of `events` carries: what a transcript read again still adds. */
export function newTurns(tr: Transcript, events: readonly SessionEvent[]): Transcript {
  const seen = new Set(events.flatMap((e) => (e.t === "prompt" && e.uuid !== undefined ? [e.uuid] : [])));
  return { ...tr, turns: tr.turns.filter((turn) => !seen.has(turn.uuid)) };
}
