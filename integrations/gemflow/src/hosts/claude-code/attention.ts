// What the band says before the person's next prompt: the one thing that needs
// them now, or nothing. Read from the assistant's last reply (what it asks, the
// step it leaves to them, work it says is not committed) and from the
// repository (commits not pushed, an open pull request all green or failing).
// Pure and Node-free: the hooks module keeps the memory between turns, and the
// replay benchmark (`.bench/providers/live.mjs`) runs this same code over past
// sessions.
//
// In order, the first that holds:
//   定       what this reply asks — several asks as one set, one ask with its likely answers; a reply that asks
//            nothing new but re-asks an older question asks it this turn
//   坏了     a failing check on an open pull request, new to the person
//   只差你   a step only they can take, new to them: a pull request all green, commits not pushed, a step the reply
//            leaves to them, work the reply says is not committed
//   (silent) otherwise
// Coming back after fifteen minutes, what became of the last thing they asked for leads, unless this turn asks.
// A standing condition leads once; after that it is a step still owed at the end of the line, for a few turns, and
// then only on the board. A line never leads twice running. The whole fits one row.
import type { Pressable } from "./actions.js";
import type { BoardRow } from "./board.js";
import { ZH, type T } from "./text.js";

/** What the repository says, for the steps only the person can take. */
export interface AttentionFacts {
  /** Local branches with commits their upstream does not have; `newestAt`, the newest of those commits. */
  ahead: { branch: string; ahead: number; newestAt?: string }[];
  /** Open pull requests: `green` when every check passed, `failing` the checks that failed. */
  prs: { number: number; branch: string; green: boolean; failing: string[] }[];
  /** Something changed that takes a reload to see (the plugin's own folder, while it is being developed). */
  reload?: boolean;
}
export const NO_FACTS: AttentionFacts = { ahead: [], prs: [] };

/** What the band remembers between turns. */
export interface AttentionMemory {
  /** Standing conditions that already led. */
  shown: string[];
  /** Turns each standing condition has held. */
  age: Record<string, number>;
  /** The line that led last turn. */
  lastLead: string;
  /** Older asks the replies still remind of. */
  backlog: string[];
}
export const NO_MEMORY: AttentionMemory = { shown: [], age: {}, lastLead: "", backlog: [] };

export type LeadKind = "ask" | "broken" | "you" | "back";
export interface Lead { key: string; kind: LeadKind; text: string; options: string[] }
export interface Standing { key: string; kind: "broken" | "you"; short: string; text: string; options: string[]; quiet?: boolean }
export interface BandLine { text: string; options: string[]; lead: LeadKind | null }

/** A standing condition rides at the end of the line for this many turns, then only the board shows it. */
export const FADE = 3;
/** The band's room, in cells (a CJK character takes two). */
export const WIDTH = 90;
/** Away this long, the band says what became of the last request. */
export const AWAY_MS = 15 * 60_000;
/** Commits younger than this do not lead: they are about to be pushed. */
const YOUNG_MS = 10 * 60_000;

// ---- the reply's sentences

/** Short enough for its room: emphasis, code marks, a heading's or quote's lead come off ("#32" stays). */
export const clip = (s: string, n: number): string => {
  const t = s.replace(/\*\*|`/g, "").replace(/^\s*(?:#{1,6}\s+|>\s*)/, "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** Lines first (a list item is its own sentence), then sentence ends within each. */
export const sentences = (text: string): string[] =>
  text.split(/\n+/).flatMap((line) => line.replace(/\s+/g, " ").split(/(?<=[。？?！!])\s*/)).map((s) => s.trim()).filter((s) => s !== "");
/** A sentence fit to show: no table rows or code. */
const prose = (s: string): boolean => !/\||```|^\s*[-*]\s*$/.test(s);
/** Only a list marker comes off — "- ", "* ", "1. ", "2、", "3) " — not a number a sentence starts with ("25 个码…"). */
const bare = (s: string): string => s.replace(/^\s*(?:[-*]\s+|\d+[.、)]\s*)/, "").replace(/\*\*/g, "").trim();
const isItem = (s: string): boolean => /^\s*(?:[-*]|\d+[.、)])\s*/.test(s);
const ASKING = /[？?]|要不要|你定|你选|批了我|可以的话/;
const HEADS_ASKS = /(要|等)你(定|决定|回复|点头)[^。]*[：:]$/;
const REMINDER = /(还|仍|都)(在)?等你|还没定|上一条里|上一个问题/;

/**
 * This reply's own asks (not its reminders of older ones), from its last part,
 * where a turn ends asking. A short ask ("推吗？") takes the sentence before
 * it, which says what it is about; a line that heads a list ("还有两处要你定：")
 * stands for the list's items.
 */
export function asksOf(reply: string): string[] {
  const raw = sentences(reply.slice(-1500));
  const ss = raw.map(bare);
  const out: string[] = [];
  const taken = new Set<number>(); // items a head already stands for
  ss.forEach((s, i) => {
    if (taken.has(i)) return;
    if (!ASKING.test(s) && !HEADS_ASKS.test(s)) return;
    if (REMINDER.test(s) || !prose(s) || s === "") return;
    if (/[：:]$/.test(s)) {
      const items: string[] = [];
      for (let j = i + 1; j < raw.length && isItem(raw[j] as string); j++) {
        taken.add(j);
        if (prose(ss[j] as string)) items.push(ss[j] as string);
      }
      if (items.length > 0) { out.push(...items); return; }
    }
    out.push(s.length < 8 && i > 0 ? `${clip(ss[i - 1] as string, 40)} ${s}` : s);
  });
  return [...new Set(out)];
}

/** The answers an ask likely takes, as buttons: the first is the one it leans to. */
export function optionsFor(ask: string, t: T = ZH): string[] {
  if (/要不要/.test(ask)) return [t("要"), t("不要")];
  if (/批不批|批吗|批了我/.test(ask)) return [t("批"), t("先不")];
  const either = /([^，,：:。]{1,12})还是([^？?，,。]{1,12})[？?]/.exec(ask);
  if (either) return [clip((either[1] as string).replace(/^(是|要|你|往后的改动|提交到)/, ""), 12), clip(either[2] as string, 12)];
  // The action nearest the question mark, in the last clause: "…已合并，要我清掉吗？" asks about 清掉.
  const clause = ask.split(/[，,。；;：:]/).filter((c) => /[吗么][？?]/.test(c)).at(-1) ?? "";
  const verbs = [...clause.matchAll(/推送|推|合并|提交|清掉|删掉|删|发布|发|打开|开|改|修|做|同步|重写/g)];
  const verb = verbs.at(-1)?.[0];
  if (verb !== undefined) return [verb, t("先不")];
  if (/可以吗|行吗|对吗|好吗|这样吗/.test(ask)) return [t("可以"), t("先不")];
  return [t("好"), t("先不")];
}

/** A sentence the pick finds, or — when it heads a list — that list's first two items. */
function withItems(reply: string, pick: (s: string) => boolean): string | undefined {
  const raw = sentences(reply.slice(-800));
  const i = raw.findIndex((s) => pick(bare(s)));
  if (i < 0) return undefined;
  const s = bare(raw[i] as string);
  if (!/[：:]$/.test(s)) return s;
  const items = raw.slice(i + 1).filter(isItem).slice(0, 2).map(bare);
  return items.length > 0 ? items.join("；") : undefined;
}

/** The older asks a reply says still wait. */
export const remindersOf = (reply: string): string[] => sentences(reply.slice(-600)).filter((s) => REMINDER.test(s));

/** What became of a request: the reply's first whole sentence. A reply cut from the front starts at its first whole line. */
export function outcomeOf(reply: string, cutFromFront = false): string | undefined {
  const whole = cutFromFront ? reply.slice(reply.indexOf("\n") + 1) : reply;
  return sentences(whole).map(bare).find((s) => prose(s) && s.length >= 6);
}

// ---- the standing conditions

/** The steps only the person can take now: from the repository, and from what the reply leaves to them. */
export function standingOf(reply: string, facts: AttentionFacts, now: number, t: T = ZH): Standing[] {
  const out: Standing[] = [];
  for (const p of facts.prs) {
    if (p.failing.length > 0) {
      const checks = p.failing.join("、");
      out.push({ key: `fail:${p.number}:${p.failing.join(",")}`, kind: "broken", short: t("#{0} {1}失败", p.number, checks), text: t("✗ #{0} 的 {1} 失败", p.number, checks), options: [t("看日志"), t("修")] });
    }
  }
  if (facts.reload === true) out.push({ key: "reload", kind: "you", short: t("重载插件"), text: t("只差你 插件改过了，重载才看得到"), options: [t("重载插件")] });
  for (const p of facts.prs) {
    if (p.green) out.push({ key: `green:${p.number}`, kind: "you", short: t("合并 #{0}", p.number), text: t("只差你 #{0} 全绿，可以合并", p.number), options: [t("合并")] });
  }
  for (const a of facts.ahead) {
    if (a.ahead <= 0) continue;
    const young = a.newestAt !== undefined && now - Date.parse(a.newestAt) < YOUNG_MS;
    out.push({ key: `unpushed:${a.branch}`, kind: "you", ...(young ? { quiet: true } : {}), short: t("推送 {0}", a.branch), text: t("只差你 {0} 有 {1} 个提交没推送", a.branch, a.ahead), options: [t("推送"), t("先不")] });
  }
  const step = withItems(reply, (s) => prose(s) && /你(手动|自己)(做|点|发|触发|去)|要你(在|去|点|手动)|还剩你|留给你(来)?做|你在 Actions/.test(s));
  if (step !== undefined) {
    const what = step.replace(/^(还剩|还有)?你手动做的几件[：:]?/, "");
    out.push({ key: `step:${clip(step, 30)}`, kind: "you", short: clip(what, 16), text: t("只差你 {0}", clip(what, 56)), options: [t("知道了")] });
  }
  const uncommitted = sentences(reply.slice(-800)).map(bare).find((s) => prose(s) && /(还没|没有|尚未|未)提交|等你(看过|确认|点头)(后|再)?(再)?提交/.test(s));
  if (uncommitted !== undefined) out.push({ key: `uncommitted:${clip(uncommitted, 30)}`, kind: "you", short: t("提交改动"), text: t("只差你 改动还没提交"), options: [t("提交"), t("先不")] });
  return out;
}

// ---- what leads

/** This turn's lead: the reply's asks, then a failure new to the person, then a new step only they can take. */
export function leadOf(o: { reply: string; standing: readonly Standing[]; memory: AttentionMemory; t?: T }): Lead | null {
  const t = o.t ?? ZH;
  const asks = asksOf(o.reply);
  let ask = asks;
  if (ask.length === 0) {
    // A reply that asks nothing new but re-asks an older question asks it this turn.
    const line = sentences(o.reply.slice(-300)).map(bare).filter((s) => REMINDER.test(s) && prose(s)).at(-1);
    const again = line === undefined ? undefined : withItems(o.reply, (x) => x === line) ?? line;
    if (again !== undefined) ask = [again.replace(/^(上一个问题|上一条里的事)?(还|仍|都)?(在)?等你(定|批)?[：:，,]?/, "")];
  }
  let lead: Lead | null = null;
  if (ask.length >= 2) lead = { key: `ask:${ask.join("|")}`, kind: "ask", text: t("定 {0} 件：{1}", ask.length, ask.map((a) => clip(a, 18)).join(" · ")), options: [t("按推荐"), t("逐个定")] };
  else if (ask.length === 1) lead = { key: `ask:${ask[0]}`, kind: "ask", text: t("定 {0}", clip(ask[0] as string, 60)), options: optionsFor(ask[0] as string, t) };
  if (lead === null) {
    const fresh = o.standing.filter((s) => !o.memory.shown.includes(s.key) && s.quiet !== true);
    const s = fresh.find((x) => x.kind === "broken") ?? fresh.find((x) => x.kind === "you");
    if (s !== undefined) lead = { key: s.key, kind: s.kind, text: s.text, options: s.options };
  }
  // Not the same line twice running.
  return lead !== null && lead.text === o.memory.lastLead ? null : lead;
}

/** The memory after a turn whose lead was `lead`: what led, how long each condition has held, the asks still reminded of. */
export function remember(memory: AttentionMemory, o: { reply: string; standing: readonly Standing[]; lead: Lead | null }): AttentionMemory {
  const keys = new Set(o.standing.map((s) => s.key));
  const shown = memory.shown.filter((k) => keys.has(k));
  if (o.lead !== null && o.lead.kind !== "ask" && o.lead.kind !== "back" && !shown.includes(o.lead.key)) shown.push(o.lead.key);
  const age: Record<string, number> = {};
  for (const k of keys) age[k] = (memory.age[k] ?? 0) + 1;
  const backlog = [...memory.backlog];
  for (const s of remindersOf(o.reply)) if (!backlog.includes(s)) backlog.push(s);
  return { shown, age, lastLead: o.lead?.text ?? "", backlog: backlog.slice(-6) };
}

/** The person's own words end the oldest ask still reminded of, when they read as an answer (short). */
export function answered(memory: AttentionMemory, said: string): AttentionMemory {
  return memory.backlog.length > 0 && said.trim().length <= 40 ? { ...memory, backlog: memory.backlog.slice(1) } : memory;
}

// ---- the line

const cells = (s: string): number => [...s].reduce((w, c) => w + (/[ᄀ-￿]/.test(c) ? 2 : 1), 0);
const cut = (s: string, w: number): string => {
  let out = "";
  for (const c of s) { if (cells(out + c) > w - 1) return `${out}…`; out += c; }
  return out;
};
const awayWords = (ms: number, t: T): string => (ms >= 3_600_000 ? t("{0} 小时", Math.round(ms / 3_600_000)) : t("{0} 分钟", Math.round(ms / 60_000)));

/**
 * The band's line: the lead (or, back after a while, what became of the last
 * request), the steps still owed, the asks still waiting; fitted to one row by
 * dropping the away note, then counting the owed steps instead of naming them,
 * then shortening the lead. Nothing to say, no line.
 */
export function bandLine(o: {
  lead: Lead | null; standing: readonly Standing[]; memory: AttentionMemory; reply: string;
  /** Milliseconds since the reply; null when unknown. */
  awayMs: number | null;
  /** The prompt the reply answered. */
  asked?: string;
  /** The reply was cut from the front (a replay keeping only its end). */
  cutFromFront?: boolean;
  t?: T; width?: number;
}): BandLine | null {
  const t = o.t ?? ZH;
  const width = o.width ?? WIDTH;
  let lead = o.lead;
  const back = o.awayMs !== null && o.awayMs >= AWAY_MS;
  const outcome = outcomeOf(o.reply, o.cutFromFront === true);
  if (back && (lead === null || lead.kind !== "ask") && o.asked !== undefined && o.asked.trim() !== "" && outcome !== undefined) {
    // What became of it is news, not a question: no button of its own.
    lead = { key: "back", kind: "back", text: t("你走前让我「{0}」：{1}", clip(o.asked.replace(/<!--[^>]*-->|>[^\n]*\n?/g, ""), 10), clip(outcome, 40)), options: [] };
  }
  // A standing condition rides along for its first turns; back after a while, the ones about the work itself come
  // back once (a pull request left green for days stays faded: it was seen, and left on purpose).
  const workItself = (s: Standing): boolean => s.kind === "broken" || /^(unpushed|uncommitted):/.test(s.key);
  const owed = o.standing.filter((s) => s.key !== lead?.key && ((o.memory.age[s.key] ?? 0) <= FADE || (back && workItself(s)))).map((s) => s.short);
  const waiting = o.memory.backlog.length;
  const options = lead !== null && lead.options.length > 0 ? lead.options : owed.length + waiting > 0 ? [t("看看")] : [];
  const awayNote = back && (lead !== null || waiting > 0 || owed.length > 0) && o.awayMs !== null ? t("你离开了 {0}", awayWords(o.awayMs, t)) : "";
  const tail = (named: boolean): string[] => [
    owed.length === 0 ? "" : named ? t("还差你：{0}", owed.join("、")) : t("还差你 {0} 步", owed.length),
    waiting > 0 ? t("还有 {0} 件待定", waiting) : "",
  ];
  const build = (a: string, named: boolean, l: string): string => [a, l, ...tail(named)].filter((x) => x !== "").join(" · ");
  const room = width - cells(options.map((x) => `[${x}]`).join(" ")) - 1;
  const kind = lead?.kind ?? null;
  for (const [a, named] of [[awayNote, true], ["", true], ["", false]] as const) {
    const line = build(a, named, lead?.text ?? "");
    if (cells(line) <= room) return line === "" ? null : { text: line, options, lead: kind };
  }
  const leadRoom = Math.max(12, room - cells(build("", false, "")) - 3);
  const line = build("", false, cut(lead?.text ?? "", leadRoom));
  return line === "" ? null : { text: cells(line) <= room ? line : cut(line, room), options, lead: kind };
}

/** What happened since the last reply that the model should hear of, so the person need not say it. */
export function newsOf(before: AttentionFacts | null, now: AttentionFacts, t: T = ZH): string[] {
  const out: string[] = [];
  const was = new Map((before?.prs ?? []).map((p) => [p.number, p]));
  for (const p of now.prs) {
    const w = was.get(p.number);
    if (p.failing.length > 0 && (w === undefined || w.failing.join() !== p.failing.join())) out.push(t("#{0} 的 {1} 失败", p.number, p.failing.join("、")));
    if (p.green && w !== undefined && !w.green) out.push(t("#{0} 全绿", p.number));
  }
  for (const w of before?.prs ?? []) if (!now.prs.some((p) => p.number === w.number)) out.push(t("#{0} 已不再开着（合并或关闭）", w.number));
  return out;
}

// ---- presses and the board

/**
 * What a band button does: an answer or a step is sent as the person's own
 * words — whole, so "合并" on a green pull request says which one; "看看" opens
 * the board; a reload is copied, since only the person can run it.
 */
export function pressablesFor(lead: Lead | null, options: readonly string[], t: T = ZH): Pressable[] {
  const key = lead?.key ?? "";
  const said = (label: string): string => {
    let m: RegExpExecArray | null;
    if ((m = /^green:(\d+)$/.exec(key)) && label === t("合并")) return t("合并 #{0}", m[1] as string);
    if ((m = /^unpushed:(.+)$/.exec(key)) && label === t("推送")) return t("推送 {0}", m[1] as string);
    if ((m = /^fail:(\d+):(.*)$/.exec(key))) {
      if (label === t("看日志")) return t("看下 #{0} 失败的 {1} 日志", m[1] as string, (m[2] as string).split(",").join("、"));
      if (label === t("修")) return t("修 #{0} 失败的 {1}", m[1] as string, (m[2] as string).split(",").join("、"));
    }
    if (key.startsWith("uncommitted:") && label === t("提交")) return t("提交改动");
    return label;
  };
  // Merging and pushing cannot be taken back: the press asks first.
  const confirmOf = (text: string): { question: string; yes: string } | undefined => {
    let m: RegExpExecArray | null;
    if ((m = /^合并 #(\d+)$/.exec(text)) || (m = /^Merge #(\d+)$/.exec(text))) return { question: t("合并 #{0}？合进去就撤不回。", m[1] as string), yes: t("合并") };
    if ((m = /^推送 (.+)$/.exec(text)) || (m = /^Push (.+)$/.exec(text))) return { question: t("推送 {0}？推上去的提交别人就看得到。", m[1] as string), yes: t("推送") };
    return undefined;
  };
  return options.map((label, i): Pressable => {
    const text = said(label);
    const confirm = confirmOf(text);
    const action = label === t("看看") ? { op: "open-board" as const, tab: "items" as const }
      : label === t("重载插件") ? { op: "command" as const, command: "reload-plugins" }
      : { op: "say" as const, text, ...(confirm !== undefined ? { confirm } : {}) };
    return { key: `attention-${i}-${label}`, label, ...(i === 0 && label !== t("先不") && label !== t("看看") ? { primary: true } : {}), action };
  });
}

/** A step the person pressed, by what it says (`合并 #32`, `/reload-plugins`): queued until the session is idle, then entered and being done. */
export interface Queued { text: string; entered: boolean }

/** What a press says into the session: the words of a `say`, the typed form of a `command`; nothing for a press that acts on the board. */
export function spokenOf(action: Pressable["action"]): string | undefined {
  return action.op === "say" ? action.text : action.op === "command" ? `/${action.command}` : undefined;
}

/** The press among these that was already made, if one was: its queue entry. */
export function pressedOf(actions: readonly Pressable[], queued: readonly Queued[]): Queued | undefined {
  for (const a of actions) {
    const said = spokenOf(a.action);
    const q = said === undefined ? undefined : queued.find((x) => x.text === said);
    if (q !== undefined) return q;
  }
  return undefined;
}

/** What a pressed step shows in place of its buttons. */
export function pendingNote(q: Queued, t: T = ZH): string {
  return q.entered ? t("进行中 {0}", q.text) : t("排队中 {0}", q.text);
}

/**
 * The board's 此刻 rows, at the top of the work items: everything the band has
 * room for one of — the reply's asks with their answers, every step only the
 * person can take, the older asks still waiting.
 */
export function nowRows(o: { reply: string; standing: readonly Standing[]; memory: AttentionMemory; queued?: readonly Queued[]; t?: T }): BoardRow[] {
  const t = o.t ?? ZH;
  const rows: BoardRow[] = [];
  // A step already pressed says what became of it instead of offering its buttons again.
  const settle = (actions: Pressable[]): { actions: Pressable[]; detail: string[] } => {
    const q = pressedOf(actions, o.queued ?? []);
    return q === undefined ? { actions, detail: [] } : { actions: [], detail: [pendingNote(q, t)] };
  };
  const asks = asksOf(o.reply);
  asks.forEach((a, i) => {
    const lead: Lead = { key: `ask:${a}`, kind: "ask", text: a, options: optionsFor(a, t) };
    rows.push({ kind: "card", key: `now-ask-${i}`, icon: "ask", verb: t("定"), title: clip(a, 80), ...settle(pressablesFor(lead, lead.options, t)) });
  });
  for (const s of o.standing) {
    const lead: Lead = { key: s.key, kind: s.kind, text: s.text, options: s.options };
    rows.push({ kind: "card", key: `now-${s.key}`, icon: s.kind === "broken" ? "warn" : s.key.startsWith("green:") ? "done" : "ask", verb: s.kind === "broken" ? t("坏了") : t("只差你"), title: s.text.replace(/^(只差你|✗)\s*/, ""), ...settle(pressablesFor(lead, s.options, t)) });
  }
  o.memory.backlog.forEach((b, i) => rows.push({ kind: "card", key: `now-backlog-${i}`, icon: "ask", verb: t("还等你"), title: clip(b.replace(/^(上一个问题|上一条里的事)?(还|仍|都)?(在)?等你(定|批)?[：:，,]?/, ""), 80), detail: [], actions: [] }));
  return rows.length === 0 ? [] : [{ kind: "section", key: "now", text: t("此刻") }, ...rows];
}
