// Each turn's judgement (typing is pressing a button): whether the person's
// prompt picks one of the options waiting on them — the ways out of a work
// item, a work item to come back to. A small model reads the options, the
// last answer's first sentence and the prompt, and answers which, and how
// sure; a sure answer is taken (and can be undone), an unsure one is asked.
// Pure and Node-free: the hooks module calls the model and runs the action.
import type { BoardAction } from "./actions.js";
import type { InboxItem } from "./inbox.js";
import type { T } from "./text.js";

/** An option the judgement may pick: the thing waiting, the option's words, and what pressing it does. */
export interface JudgeOption { key: string; title: string; verb: string; label: string; action: BoardAction }

/** What the judgement found: the option picked, whether it was sure, why in a few words, and when. */
export interface Judgement {
  at: string;
  /** The prompt's first line, for the band's hover. */
  said: string;
  option: JudgeOption;
  /** When it was not sure: the other picks it found likely, at most three, likeliest first. */
  alternatives?: JudgeOption[];
  sure: boolean;
  why: string;
  /** Taken already (a sure one, or a person's 对); how to take it back, when it can be. */
  taken: boolean;
  undo?: { file?: string; rev: number };
}

/** The most options put to the model: the first ones waiting, in the order the person reads them. */
const OPTIONS_ASKED = 12;
/** The most of the prompt and of the last answer the model reads. */
const PROMPT_CHARS = 800;

/** The options the pending list offers a judgement: the ways out of a work item, and a work item to come back to. */
export function judgeOptions(pending: readonly InboxItem[]): JudgeOption[] {
  return pending.flatMap((i) => (i.kind === "approve" || i.kind === "resume" ? i.actions : [])
    .filter((a) => a.action.op === "advance" || a.action.op === "switch-file")
    .map((a): JudgeOption => ({ key: a.key, title: i.title, verb: i.verb, label: a.label, action: a.action })))
    .slice(0, OPTIONS_ASKED);
}

/** The request: a system line and the prompt, the options numbered from 1. */
export function judgeRequest(options: readonly JudgeOption[], lastAnswer: string, prompt: string): { system: string; prompt: string } {
  const cut = (s: string): string => (s.length > PROMPT_CHARS ? `${s.slice(0, PROMPT_CHARS)}…` : s);
  return {
    system: "You read one chat message a person sent to a coding assistant, and decide whether it picks one of the options a work tracker is waiting on them for. Reply with one JSON object and nothing else.",
    prompt: [
      lastAnswer !== "" ? `The assistant's last reply began: ${JSON.stringify(cut(lastAnswer))}` : "",
      "Waiting on the person:",
      ...options.map((o, n) => `${n + 1}. ${o.verb} ${JSON.stringify(o.title)} — option: ${JSON.stringify(o.label)}`),
      `The person now wrote: ${JSON.stringify(cut(prompt))}`,
      'Which option does the message choose? Reply {"option": <its number, 0 when it chooses none>, "sure": <true only when the message plainly chooses it>, "also": [<when not sure, up to three other likely numbers, likeliest first>], "why": "<what it chose, in a few words of the message\'s own language>"}.',
    ].filter((x) => x !== "").join("\n"),
  };
}

/** The model's reply read: the option it picked and how sure, or undefined for none (or a reply that is no such answer). */
export function readJudgement(reply: string, options: readonly JudgeOption[]): { option: JudgeOption; alternatives: JudgeOption[]; sure: boolean; why: string } | undefined {
  const json = reply.match(/\{[\s\S]*\}/)?.[0];
  if (json === undefined) return undefined;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return undefined; }
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const n = typeof r["option"] === "number" ? r["option"] : Number.NaN;
  const option = Number.isInteger(n) && n >= 1 ? options[n - 1] : undefined;
  if (option === undefined) return undefined;
  const sure = r["sure"] === true;
  // Not sure: the other likely picks, each once, never the first again, three at most.
  const also = !sure && Array.isArray(r["also"]) ? (r["also"] as unknown[]).filter((m): m is number => typeof m === "number" && Number.isInteger(m) && m >= 1 && m !== n) : [];
  const alternatives = [...new Set(also)].flatMap((m) => (options[m - 1] !== undefined ? [options[m - 1] as JudgeOption] : [])).slice(0, 3);
  return { option, alternatives, sure, why: typeof r["why"] === "string" ? r["why"].trim().slice(0, 80) : "" };
}

/** The request for the question the band showed: whether a typed message answers it, by one of its answers or in its own words. */
export function askJudgeRequest(question: string, options: readonly string[], prompt: string): { system: string; prompt: string } {
  const cut = (s: string): string => (s.length > PROMPT_CHARS ? `${s.slice(0, PROMPT_CHARS)}…` : s);
  return {
    system: "You read one chat message a person sent to a coding assistant, and decide whether it answers a question the assistant had asked them. Reply with one JSON object and nothing else.",
    prompt: [
      `The assistant asked: ${JSON.stringify(question)}`,
      `Its suggested answers: ${options.map((o) => JSON.stringify(o)).join(", ")}`,
      `The person now wrote: ${JSON.stringify(cut(prompt))}`,
      'Does the message answer that question, by choosing one of the suggested answers or by giving an answer of its own? A message about something else does not. Reply {"answers": true} or {"answers": false}.',
    ].join("\n"),
  };
}

/** The model's reply to askJudgeRequest: whether the message answers the question, or undefined for a reply that is no such answer. */
export function readAskJudgement(reply: string): boolean | undefined {
  const json = reply.match(/\{[\s\S]*\}/)?.[0];
  if (json === undefined) return undefined;
  try {
    const v = JSON.parse(json) as unknown;
    const answers = typeof v === "object" && v !== null ? (v as Record<string, unknown>)["answers"] : undefined;
    return typeof answers === "boolean" ? answers : undefined;
  } catch {
    return undefined;
  }
}

/** How long a judgement stands on the band. */
export const JUDGEMENT_MS = 10 * 60_000;

/** The band's line for a judgement: taken, with an undo when it has one; unsure, a question with 对 and 不是. */
export function judgementLine(j: Judgement, t: T): { title: string; note: string; actions: { key: string; label: string; primary?: true; action: BoardAction }[] } {
  if (j.taken) {
    return {
      title: t("你选了 {0}：{1}", j.option.label, j.option.title), note: j.why,
      actions: j.undo !== undefined ? [{ key: "judge-undo", label: t("撤销"), action: { op: "judge-undo" } }] : [{ key: "judge-ok", label: t("知道了"), action: { op: "judge-no" } }],
    };
  }
  const alts = j.alternatives ?? [];
  if (alts.length === 0) {
    return {
      title: t("{0}：{1}？", j.option.label, j.option.title), note: j.why,
      actions: [{ key: "judge-yes", label: t("对"), primary: true, action: { op: "judge-yes" } }, { key: "judge-no", label: t("不是"), action: { op: "judge-no" } }],
    };
  }
  // Several likely: each a press, the likeliest first, then none of them.
  const name = (o: JudgeOption): string => (o.title === j.option.title ? o.label : `${o.label}：${o.title}`);
  return {
    title: t("是哪一个？"), note: j.why,
    actions: [
      { key: "judge-yes", label: name(j.option), primary: true, action: { op: "judge-yes" } },
      ...alts.map((o, n) => ({ key: `judge-pick-${n + 1}`, label: name(o), action: { op: "judge-pick", n: n + 1 } as BoardAction })),
      { key: "judge-no", label: t("都不是"), action: { op: "judge-no" } },
    ],
  };
}
