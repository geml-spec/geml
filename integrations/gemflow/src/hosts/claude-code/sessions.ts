// The sessions tab (spec §8.2, 会话): the prompts the person sent, each under
// the stage it was sent in, with what followed it; and their export. Pure and
// Node-free: the hooks module records a prompt at `prompt.submit` and counts
// what each turn did.
import type { SessionSummary } from "../../core/session-log.js";
import type { T } from "./text.js";
import { cellWidth, truncate } from "./band.js";
import { hhmm } from "./time.js";

export interface PromptRecord {
  id: string;
  at: string;
  text: string;
  /** The row's id in the host's record, as `session.append` gave it: what locates the prompt in the transcript and names its turn to the bridge. */
  uuid?: string;
  item?: string;
  /** The work item's name and its flow's title, as the prompt was sent. */
  itemTitle?: string;
  flow?: string;
  state?: string;
  /** What the turn after it did: the first sentence of its answer, once it ended; tool calls, refusals, the states entered, the evidence written. */
  did?: string;
  tools: number;
  refusals: number;
  entered: string[];
  signals: string[];
  /** Read back from the host's transcript (a turn before gemflow loaded), not recorded as it happened. */
  backfilled?: boolean;
}

export interface PromptGroup { state?: string; from: string; to?: string; prompts: PromptRecord[] }

/** The first line of a prompt, at most `max` cells. */
export function promptLine(text: string, max = 72): string {
  const first = text.replace(/\r\n?/g, "\n").split("\n").find((l) => l.trim() !== "") ?? "";
  return truncate(first.trim(), max);
}

/** The longest gist of an answer the record keeps. */
const GIST_CHARS = 120;

/**
 * The first sentence of a turn's answer, as plain words: its first line of
 * prose (code blocks, headings, tables and rules skipped; quotes' and lists'
 * marks, emphasis, inline code and link targets left out), up to the end of
 * its first sentence; undefined for an answer with none.
 */
export function answerGist(answer: string): string | undefined {
  let fenced = false;
  for (const raw of answer.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) { fenced = !fenced; continue; }
    if (fenced || line === "" || /^(\||---|===|#{1,6}\s)/.test(line)) continue;
    const plain = line
      .replace(/^(>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (plain === "") continue;
    const end = plain.search(/[。！？](?=.)|[.!?](?=\s)/);
    const sentence = end < 0 ? plain : plain.slice(0, end + 1);
    return sentence.length > GIST_CHARS ? `${sentence.slice(0, GIST_CHARS - 1)}…` : sentence;
  }
  return undefined;
}

/** Consecutive prompts under one stage make a group, from the first's time to the last's. */
export function promptGroups(prompts: readonly PromptRecord[]): PromptGroup[] {
  const groups: PromptGroup[] = [];
  for (const p of prompts) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.state === p.state) last.prompts.push(p);
    else groups.push({ ...(p.state !== undefined ? { state: p.state } : {}), from: p.at, prompts: [p] });
  }
  return groups.map((g, i) => ({ ...g, ...(groups[i + 1] !== undefined ? { to: groups[i + 1]!.from } : {}) }));
}

/** What followed a prompt, in a few words: `7 次工具调用 · tests-pass ✓ · 自动进 #review`. */
export function promptTail(p: PromptRecord, t: T): string {
  const parts: string[] = [];
  if (p.tools > 0) parts.push(t("{0} 次工具调用", p.tools));
  if (p.refusals > 0) parts.push(t("{0} 次拒绝", p.refusals));
  for (const s of p.signals) parts.push(`${s} ✓`);
  for (const s of p.entered) parts.push(t("进 #{0}", s));
  return parts.join(" · ");
}

/** The session's prompts as a document: GEML (a `data {#session}` index, then one text block per prompt), or Markdown for the share dialog's copy. */
export function sessionExport(prompts: readonly PromptRecord[], format: "geml" | "md", session: string, t: T): string {
  if (format === "md") {
    const lines = [`# ${t("会话 {0}", session)}`, ""];
    for (const g of promptGroups(prompts)) {
      lines.push(`## ${g.state !== undefined ? `#${g.state}` : t("没有阶段")} · ${hhmm(g.from)}${g.to !== undefined ? ` – ${hhmm(g.to)}` : ""}`, "");
      for (const p of g.prompts) lines.push(`- **${hhmm(p.at)}** ${p.text.replace(/\r\n?/g, "\n").split("\n").join("\n  ")}${promptTail(p, t) ? `  \n  _${promptTail(p, t)}_` : ""}`);
      lines.push("");
    }
    return lines.join("\n");
  }
  const fence = (text: string): string => {
    let run = 3;
    for (const m of text.matchAll(/^(=+)/gm)) run = Math.max(run, m[1]!.length + 1);
    return "=".repeat(run);
  };
  const index = prompts.map((p, i) => ({ id: `prompt-${i + 1}`, at: p.at, ...(p.uuid !== undefined ? { uuid: p.uuid } : {}), ...(p.state !== undefined ? { state: p.state } : {}), ...(p.item !== undefined ? { item: p.item } : {}), tools: p.tools, refusals: p.refusals, entered: p.entered, signals: p.signals }));
  const blocks = prompts.map((p, i) => {
    const body = p.text.replace(/\r\n?/g, "\n");
    const f = fence(body);
    return `${f} text {#prompt-${i + 1}}\n${body}\n${f}\n`;
  });
  return [`=== meta\ntitle = ${JSON.stringify(t("会话 {0}", session))}\n===\n`, `=== data {#session format=json}\n${JSON.stringify({ session, prompts: index }, null, 2)}\n===\n`, ...blocks].join("\n");
}

/** The fence that holds `text`: wider than any run of `=` the text begins a line with. */
function fenceFor(text: string): string {
  let run = 3;
  for (const m of text.matchAll(/^(=+)/gm)) run = Math.max(run, m[1]!.length + 1);
  return "=".repeat(run);
}

/**
 * A session's record (session-log.ts) as a GEML document: every turn's prompt
 * and answer and the decisions it recorded, oldest first — a `data {#session}`
 * index, then a text block for each prompt and each answer. For this session
 * and for another's alike.
 */
export function logExport(s: SessionSummary, t: T): string {
  const title = t("会话 {0}", s.id);
  const turns = [...s.turns].sort((a, b) => a.turn - b.turn);
  const index = { session: s.id, host: s.host, ...(s.branch !== undefined ? { branch: s.branch } : {}), started: s.started, last: s.last, turns: turns.map((turn) => ({ turn: turn.turn, at: turn.at, decisions: turn.decisions })) };
  const blocks = turns.flatMap((turn) => {
    const prompt = turn.prompt.replace(/\r\n?/g, "\n");
    const out = [`${fenceFor(prompt)} text {#prompt-${turn.turn}}\n${prompt}\n${fenceFor(prompt)}\n`];
    if (turn.answer !== undefined) {
      const answer = turn.answer.replace(/\r\n?/g, "\n");
      out.push(`${fenceFor(answer)} text {#answer-${turn.turn}}\n${answer}\n${fenceFor(answer)}\n`);
    }
    return out;
  });
  return [`=== meta\ntitle = ${JSON.stringify(title)}\n===\n`, `=== data {#session format=json}\n${JSON.stringify(index, null, 2)}\n===\n`, ...blocks].join("\n");
}

/** Whether a line fits the pane: a guard for the tests, so the export's width rules live here. */
export const fits = (text: string, columns: number): boolean => cellWidth(text) <= columns;
