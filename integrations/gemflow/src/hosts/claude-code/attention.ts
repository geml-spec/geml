// What the band says before the person's next prompt: the one thing that needs
// them now, or nothing. Read from the assistant's last reply (what it asks, the
// step it leaves to them, work it says is not committed) and from the
// repository (commits not pushed, an open pull request all green or failing).
// Pure and Node-free: the hooks module keeps the memory between turns, and the
// replay benchmark (`.bench/providers/live.mjs`) runs this same code over past
// sessions.
//
// In order, the first that holds:
//   待决定   what this reply asks — several asks as one set, one ask with its likely answers; a reply that asks
//            nothing new but re-asks an older question asks it this turn
//   出错     a failing check on an open pull request, new to the person
//   待处理   a step only they can take, new to them: a pull request all green, commits not pushed, a step the reply
//            leaves to them, work the reply says is not committed
//   (silent) otherwise
// Coming back after a while says nothing of the time away: only the steps about the work itself come back.
// A standing condition leads once; after that it is a step still owed at the end of the line, for a few turns, and
// then only on the board. A line never leads twice running. The whole fits one row.
import type { Pressable } from "./actions.js";
import type { Asked } from "../../core/ask-tool.js";
import type { BoardRow } from "./board.js";
import { ZH, type T } from "./text.js";
import { isDeferral } from "../../core/session-log.js";

/** What the repository says, for the steps only the person can take. */
export interface AttentionFacts {
  /** Local branches with commits their upstream does not have; `newestAt`, the newest of those commits. */
  ahead: { branch: string; ahead: number; newestAt?: string }[];
  /** Open pull requests: `green` when every check passed, `failing` the checks that failed. */
  prs: { number: number; branch: string; green: boolean; failing: string[] }[];
  /** The lists the repository could not be asked for (git or gh failed): empty above, and no hold on them is let go. */
  unread?: ("ahead" | "prs")[];
  /** Something changed that takes a reload to see (the plugin's own folder, while it is being developed). */
  reload?: boolean;
  /** The version the session runs and the one its folder holds, when they differ: what the reload brings. */
  versions?: { running: string; synced: string };
  /** A version bumped in the checkout (a package.json or plugin.json) and not committed: the band keeps a step for it until it is. */
  bump?: { version: string; path: string };
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

/** `maybe`: a question guessed from the reply, not registered — a grey hint with no answers. */
export type LeadKind = "ask" | "broken" | "you" | "maybe";
/** `step`: one of several asks in one reply, settled one by one — which, of how many. */
/** `full`: an ask's line with the whole question, where `text` may be cut to fit; `question`: a registered question, which its answers are said with. */
export interface Lead { key: string; kind: LeadKind; text: string; options: string[]; step?: { index: number; of: number }; full?: string; question?: string }
export interface Standing { key: string; kind: "broken" | "you"; short: string; text: string; options: string[]; quiet?: boolean }
/** `steps`: the other steps only the person can take now, each a button of its own beside the lead's options. `full`: a question led, whole, for a band that wraps it. */
export interface BandLine { text: string; options: string[]; lead: LeadKind | null; steps: Standing[]; full?: string }

/** A standing condition rides at the end of the line for this many turns, then only the board shows it. */
export const FADE = 3;
/** The band's room, in cells (a CJK character takes two). */
export const WIDTH = 90;
/** Away this long, the band says what became of the last request. */
export const AWAY_MS = 15 * 60_000;
/** The most of a question kept whole: past it, the band's three rows end in "…" and the card holds this much. */
const WHOLE = 4000;
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
  text.split(/\n+/).flatMap((line) => line.replace(/\s+/g, " ").split(/(?<=[。？?！!؟﹖‽⁇⁈⁉፧\u037E])\s*/)).map((s) => s.trim()).filter((s) => s !== "");
/** A sentence fit to show: no table rows or code. */
const prose = (s: string): boolean => !/\||```|^\s*[-*]\s*$/.test(s);
/** Only a list marker comes off — "- ", "* ", "1. ", "2、", "3) " — not a number a sentence starts with ("25 个码…"). */
const bare = (s: string): string => s.replace(/^\s*(?:[-*]\s+|\d+[.、)]\s*)/, "").replace(/\*\*/g, "").trim();
const isItem = (s: string): boolean => /^\s*(?:[-*]|\d+[.、)])\s*/.test(s);
/** A question: a sentence that ends asking, closing marks aside. A statement that mentions a choice ("只看你选中了哪个") is none. */
const isQuestion = (s: string): boolean => {
  const end = s.replace(/[)）」』"'”’*`\s]+$/, "");
  // A question mark in any script — fullwidth, small, Arabic, Greek (U+037E), Ethiopic, the interrobangs — or, in
  // Japanese, a sentence ending in the particle か with or without its full stop ("よろしいですか。").
  return /[？?﹖؟\u037E‽⁇⁈⁉፧]$/.test(end) || /か[。．.]?$/.test(end);
};
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
    const head = HEADS_ASKS.test(s);
    if (!isQuestion(s) && !head) return;
    if (REMINDER.test(s) || !prose(s) || s === "") return;
    if (/[：:]$/.test(s)) {
      // A line that heads a list stands for the list's questions, and only for those.
      const items: string[] = [];
      for (let j = i + 1; j < raw.length && isItem(raw[j] as string); j++) {
        taken.add(j);
        if (prose(ss[j] as string) && isQuestion(ss[j] as string)) items.push(ss[j] as string);
      }
      if (items.length > 0) { out.push(...items); return; }
      if (!isQuestion(s)) return;
    }
    out.push(s.length < 8 && i > 0 ? `${clip(ss[i - 1] as string, 40)} ${s}` : s);
  });
  return [...new Set(out)];
}

/** The answers an ask likely takes, as buttons: the first is the one it leans to. */
export function optionsFor(ask: string, t: T = ZH): string[] {
  if (/要不要/.test(ask)) return [t("要"), t("不要")];
  const either2 = /(\p{Script=Han})不\1/u.exec(ask);
  if (either2 && either2[1] !== "批") return [either2[1] as string, `不${either2[1]}`];
  if (/批不批|批吗|批了我/.test(ask)) return [t("批"), t("暂不")];
  // "A 还是 B？", the A half ending where 还是 starts or at a comma before it ("先做这个，还是先做第三步？").
  const either = /([^，,：:。？?]{1,16})[，,]?\s*还是\s*([^？?，,。]{1,16})[？?]/.exec(ask);
  if (either) return [clip((either[1] as string).trim().replace(/^(是|要|你|往后的改动|提交到)/, ""), 12), clip((either[2] as string).trim(), 12)];
  // The action nearest the question mark, in the last clause: "…已合并，要我清掉吗？" asks about 清掉.
  const clause = ask.split(/[，,。；;：:]/).filter((c) => /[吗么][？?]/.test(c)).at(-1) ?? "";
  const verbs = [...clause.matchAll(/推送|推|合并|提交|清掉|删掉|删|发布|发|打开|开|改|修|做|同步|重写/g)];
  const verb = verbs.at(-1)?.[0];
  if (verb !== undefined) return [verb, t("暂不")];
  if (/可以吗|行吗|对吗|好吗|这样吗/.test(ask)) return [t("可以"), t("暂不")];
  return [t("同意"), t("暂不")];
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

/** A local branch ahead of its upstream, and an open pull request, as the repository facts carry them. */
export type AheadFact = AttentionFacts["ahead"][number];
export type PrFact = AttentionFacts["prs"][number];

/**
 * What the person holds back — a 暂不 on a 待推送 card put
 * `unpushed:<branch>` in the project's dismissed list, one on a 可合并 card
 * `green:<number>` — and is still there: the branches still ahead, the pull
 * requests still open, red or green (by number); and that list without the
 * holds whose branch is no longer ahead (pushed, or gone) or whose pull
 * request is no longer open (merged, or closed), so the next time it comes up
 * it is asked about again. A list the repository could not be asked for lets
 * nothing go.
 */
export function heldSteps(dismissed: readonly string[], facts: AttentionFacts): { branches: AheadFact[]; prs: PrFact[]; dismissed: string[] } {
  const ahead = facts.ahead.filter((a) => a.ahead > 0);
  const unread = facts.unread ?? [];
  const stays = (k: string): boolean =>
    k.startsWith("unpushed:") ? unread.includes("ahead") || ahead.some((a) => `unpushed:${a.branch}` === k)
      : k.startsWith("green:") ? unread.includes("prs") || facts.prs.some((p) => `green:${p.number}` === k)
        : true;
  return {
    branches: ahead.filter((a) => dismissed.includes(`unpushed:${a.branch}`)),
    prs: facts.prs.filter((p) => dismissed.includes(`green:${p.number}`)).sort((a, b) => a.number - b.number),
    dismissed: dismissed.filter(stays),
  };
}

/** The steps only the person can take now: from the repository, and from what the reply leaves to them. */
export function standingOf(reply: string, facts: AttentionFacts, now: number, t: T = ZH, o: { reloadHere?: boolean } = {}): Standing[] {
  const out: Standing[] = [];
  for (const p of facts.prs) {
    if (p.failing.length > 0) {
      const checks = p.failing.join("、");
      out.push({ key: `fail:${p.number}:${p.failing.join(",")}`, kind: "broken", short: t("#{0} {1}失败", p.number, checks), text: t("✗ #{0} 的 {1} 失败", p.number, checks), options: [t("查看日志"), t("修复")] });
    }
  }
  if (facts.reload === true) {
    // Which version a reload brings, and which runs now, where both are known.
    const v = facts.versions;
    out.push(o.reloadHere === false
      ? { key: "reload", kind: "you", short: t("本机重载插件"), text: v !== undefined ? t("待重载：{0}（运行 {1}）· 需在本机", v.synced, v.running) : t("插件已更新，需在本机重载"), options: [] }
      : { key: "reload", kind: "you", short: t("重载插件"), text: v !== undefined ? t("待重载：{0}（运行 {1}）", v.synced, v.running) : t("插件已更新，重载后生效"), options: [t("重载插件")] });
  }
  for (const p of facts.prs) {
    if (p.green) out.push({ key: `green:${p.number}`, kind: "you", short: t("合并 #{0}", p.number), text: t("可合并：#{0}（检查全部通过）", p.number), options: [t("合并"), t("暂不")] });
  }
  for (const a of facts.ahead) {
    if (a.ahead <= 0) continue;
    const young = a.newestAt !== undefined && now - Date.parse(a.newestAt) < YOUNG_MS;
    out.push({ key: `unpushed:${a.branch}`, kind: "you", ...(young ? { quiet: true } : {}), short: t("推送 {0}", a.branch), text: t("待推送：{0} · {1} 个提交", a.branch, a.ahead), options: [t("推送"), t("暂不")] });
  }
  const step = withItems(reply, (s) => prose(s) && /你(手动|自己)(做|点|发|触发|去)|要你(在|去|点|手动)|还剩你|留给你(来)?做|你在 Actions/.test(s));
  if (step !== undefined) {
    const what = step.replace(/^(还剩|还有)?你手动做的几件[：:]?/, "");
    out.push({ key: `step:${clip(step, 30)}`, kind: "you", short: clip(what, 16), text: t("待处理：{0}", clip(what, 56)), options: [t("知道了")] });
  }
  // A version bumped and not committed: the fact, over the reply's words; a step that rides along (never leads) until the commit.
  if (facts.bump !== undefined) out.push({ key: `uncommitted:v:${facts.bump.version}`, kind: "you", quiet: true, short: t("提交改动"), text: t("待提交：{0}", facts.bump.version), options: [t("提交"), t("暂不")] });
  const uncommitted = facts.bump !== undefined ? undefined : sentences(reply.slice(-800)).map(bare).find((s) => prose(s) && /(还没|没有|尚未|未)提交|等你(看过|确认|点头)(后|再)?(再)?提交/.test(s));
  if (uncommitted !== undefined) out.push({ key: `uncommitted:${clip(uncommitted, 30)}`, kind: "you", short: t("提交改动"), text: t("待提交：改动"), options: [t("提交"), t("暂不")] });
  return out;
}

// ---- what leads

/** This turn's lead: the reply's asks, then a failure new to the person, then a new step only they can take. */
export function leadOf(o: { reply: string; standing: readonly Standing[]; memory: AttentionMemory; picks?: readonly (string | null)[]; asked?: readonly Asked[]; t?: T }): Lead | null {
  const t = o.t ?? ZH;
  // The questions the model registered lead, with the answers it gave, shown whole.
  if (o.asked !== undefined && o.asked.length > 0) {
    const asked = o.asked;
    const i = asked.length >= 2 ? asked.findIndex((_, n) => (o.picks?.[n] ?? null) === null) : 0;
    if (i >= 0) {
      const q = asked[i] as Asked;
      const step = asked.length >= 2 ? { index: i, of: asked.length } : undefined;
      const label = (cutTo: number): string => (step !== undefined ? t("决定 {0}/{1}：{2}", i + 1, asked.length, clip(q.question, cutTo)) : t("待决定：{0}", clip(q.question, cutTo)));
      return { key: `ask:${asked.map((x) => x.question).join("|")}#${i}`, kind: "ask", text: label(60), full: label(WHOLE), options: [...q.options], question: q.question, ...(step !== undefined ? { step } : {}) };
    }
  }
  const asks = asksOf(o.reply);
  let ask = asks;
  if (ask.length === 0) {
    // A reply that asks nothing new but re-asks an older question asks it this turn.
    const line = sentences(o.reply.slice(-300)).map(bare).filter((s) => REMINDER.test(s) && prose(s)).at(-1);
    const again = line === undefined ? undefined : withItems(o.reply, (x) => x === line) ?? line;
    if (again !== undefined && isQuestion(again)) ask = [again.replace(/^(上一个问题|上一条里的事)?(还|仍|都)?(在)?等你(定|批)?[：:，,]?/, "")];
  }
  let lead: Lead | null = null;
  // A question the model did not register: a grey hint, one row, with no answers to press.
  if (ask.length > 0 && (o.asked === undefined || o.asked.length === 0)) lead = { key: `maybe:${ask[0]}`, kind: "maybe", text: t("可能待决定：{0}", clip(ask[0] as string, 120)), options: [] };
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
  if (o.lead !== null && o.lead.kind !== "ask" && o.lead.kind !== "maybe" && !shown.includes(o.lead.key)) shown.push(o.lead.key);
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
  t?: T; width?: number;
}): BandLine | null {
  const t = o.t ?? ZH;
  const width = o.width ?? WIDTH;
  const lead = o.lead;
  // How long the person was away is not news, nor a recap of the reply they can read: back after a while, only the steps about the work itself come back.
  const back = o.awayMs !== null && o.awayMs >= AWAY_MS;
  // A standing condition rides along for its first turns; back after a while, the ones about the work itself come
  // back once (a pull request left green for days stays faded: it was seen, and left on purpose).
  const workItself = (s: Standing): boolean => s.kind === "broken" || /^(unpushed|uncommitted):/.test(s.key);
  // A version bump not committed stays on the band until it is: the fact does not fade.
  const riding = o.standing.filter((s) => s.key !== lead?.key && ((o.memory.age[s.key] ?? 0) <= FADE || /^uncommitted:v:/.test(s.key) || (back && workItself(s))));
  const steps = riding.filter(isStepButton).slice(0, 3);
  const owed = riding.filter((s) => !steps.includes(s)).map((s) => s.short);
  const waiting = o.memory.backlog.length;
  const options = lead !== null && lead.options.length > 0 ? lead.options : steps.length === 0 && owed.length + waiting > 0 ? [t("详情")] : [];
  const tail = (named: boolean): string[] => [
    owed.length === 0 ? "" : named ? t("待处理：{0}", owed.join("、")) : t("待处理 {0} 项", owed.length),
    waiting > 0 ? t("待决定 {0} 项", waiting) : "",
  ];
  // Nothing leads and nothing else is named: one step says itself (what a reload brings, how many commits a push
  // sends); several, what their buttons are.
  const build = (named: boolean, l: string): string => {
    const parts = [l, ...tail(named)].filter((x) => x !== "");
    return parts.length === 0 && steps.length > 0 ? (steps.length === 1 ? (steps[0] as Standing).text : t("待处理")) : parts.join(" · ");
  };
  const room = width - cells([...options, ...steps.map((x) => x.short)].map((x) => `[${x}]`).join(" ")) - 1;
  const kind = lead?.kind ?? null;
  for (const named of [true, false]) {
    const line = build(named, lead?.text ?? "");
    if (cells(line) <= room) return line === "" && steps.length === 0 ? null : { text: line, options, lead: kind, steps, ...(lead?.full !== undefined ? { full: lead.full } : {}) };
  }
  const leadRoom = Math.max(12, room - cells(build(false, "")) - 3);
  const line = build(false, cut(lead?.text ?? "", leadRoom));
  return line === "" && steps.length === 0 ? null : { text: cells(line) <= room ? line : cut(line, room), options, lead: kind, steps, ...(lead?.full !== undefined ? { full: lead.full } : {}) };
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
 * words — whole, so "合并" on a green pull request says which one and "暂不"
 * which step it puts off; "详情" opens the board; a reload is copied, since
 * only the person can run it.
 */
export function pressablesFor(lead: Lead | null, options: readonly string[], t: T = ZH): Pressable[] {
  const key = lead?.key ?? "";
  const said = (label: string): string => {
    let m: RegExpExecArray | null;
    if ((m = /^green:(\d+)$/.exec(key)) && label === t("合并")) return t("合并 #{0}", m[1] as string);
    if ((m = /^unpushed:(.+)$/.exec(key)) && label === t("推送")) return t("推送 {0}", m[1] as string);
    // Two steps' 暂不 must say two things: a press is known by what it says. A branch's is a hold until the person says.
    if ((m = /^unpushed:(.+)$/.exec(key)) && label === t("暂不")) return t("先不推送 {0}，等我说再推。", m[1] as string);
    if ((m = /^green:(\d+)$/.exec(key)) && label === t("暂不")) return t("先不合并 #{0}，等我说再合。", m[1] as string);
    if (key.startsWith("uncommitted:") && label === t("暂不")) return t("先不提交，改动先留着。");
    if ((m = /^fail:(\d+):(.*)$/.exec(key))) {
      if (label === t("查看日志")) return t("看下 #{0} 失败的 {1} 日志", m[1] as string, (m[2] as string).split(",").join("、"));
      if (label === t("修复")) return t("修 #{0} 失败的 {1}", m[1] as string, (m[2] as string).split(",").join("、"));
    }
    if (key.startsWith("uncommitted:") && label === t("提交")) return t("提交改动");
    if (lead?.question !== undefined) return `${lead.question}：${label}`;
    return label;
  };
  // Merging and pushing cannot be taken back: the press asks first.
  const confirmOf = (text: string): { question: string; yes: string } | undefined => {
    let m: RegExpExecArray | null;
    if ((m = /^合并 #(\d+)$/.exec(text)) || (m = /^Merge #(\d+)$/.exec(text))) return { question: t("合并 #{0}？此操作不可撤销。", m[1] as string), yes: t("合并") };
    if ((m = /^推送 (.+)$/.exec(text)) || (m = /^Push (.+)$/.exec(text))) return { question: t("推送 {0}？提交将对仓库的其他人可见。", m[1] as string), yes: t("推送") };
    return undefined;
  };
  // One of several asks: the answer is kept, not said yet.
  const step = lead?.step;
  if (step !== undefined) return options.map((label, i): Pressable => ({ key: `attention-${step.index}-${i}-${label}`, label, ...(i === 0 ? { primary: true } : {}), action: { op: "pick", index: step.index, answer: label } }));
  return options.map((label, i): Pressable => {
    const text = said(label);
    const confirm = confirmOf(text);
    // 暂不 on a branch or a green pull request puts its card away until it is gone (heldSteps), and says where it went.
    const pr = /^green:(\d+)$/.exec(key)?.[1];
    const held = label !== t("暂不") ? undefined : pr !== undefined ? `#${pr}` : /^unpushed:(.+)$/.exec(key)?.[1];
    const action = label === t("详情") ? { op: "open-board" as const, tab: "items" as const }
      : label === t("重载插件") ? { op: "command" as const, command: "reload-plugins" }
      : { op: "say" as const, text, ...(confirm !== undefined ? { confirm } : {}), ...(held !== undefined ? { dismiss: key, toast: t("已暂缓 {0}，可在看板「已暂缓」里恢复", held) } : {}),
          // An answer to a registered question is a decision the person made: recorded as such when pressed (a deferral is none).
          ...(lead?.question !== undefined && !isDeferral(label) ? { decisions: [text] } : {}) };
    return { key: `attention-${i}-${label}`, label, ...(i === 0 && label !== t("暂不") && label !== t("详情") ? { primary: true } : {}), action };
  });
}

/** A step that is a button beside the lead: one the person takes in a press — merge, push, commit, reload. */
function isStepButton(s: Standing): boolean {
  return s.options.length > 0 && /^(green|unpushed|uncommitted):|^reload$/.test(s.key);
}

/** The steps beside the lead as presses: said as the person's words (merging and pushing ask first), a reload run as the command. */
export function stepPressables(steps: readonly Standing[], t: T = ZH): Pressable[] {
  return steps.map((s): Pressable => {
    if (s.key === "reload") return { key: "step-reload", label: s.short, action: { op: "command", command: "reload-plugins" } };
    const m = /^green:(\d+)$/.exec(s.key);
    const confirm = m !== null ? { question: t("合并 #{0}？此操作不可撤销。", m[1] as string), yes: t("合并") }
      : s.key.startsWith("unpushed:") ? { question: t("推送 {0}？提交将对仓库的其他人可见。", s.key.slice("unpushed:".length)), yes: t("推送") }
      : undefined;
    return { key: `step-${s.key}`, label: s.short, action: { op: "say", text: s.short, ...(confirm !== undefined ? { confirm } : {}) } };
  });
}

/** Several asks' answers as one prompt, one line each: the ask, then what was picked. */
export function picksText(asks: readonly string[], picks: readonly (string | null)[]): string {
  return asks.map((a, i) => `${a}：${picks[i] ?? ""}`).join("\n");
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
export function nowRows(o: { reply: string; standing: readonly Standing[]; memory: AttentionMemory; queued?: readonly Queued[]; picks?: readonly (string | null)[]; asked?: readonly Asked[]; t?: T }): BoardRow[] {
  const t = o.t ?? ZH;
  const rows: BoardRow[] = [];
  // A step already pressed says what became of it instead of offering its buttons again.
  const settle = (actions: Pressable[]): { actions: Pressable[]; detail: string[] } => {
    const q = pressedOf(actions, o.queued ?? []);
    return q === undefined ? { actions, detail: [] } : { actions: [], detail: [pendingNote(q, t)] };
  };
  const asked = o.asked ?? [];
  asked.forEach((a, i) => {
    // Of several, each is answered on its own card and kept; the last answer says them all.
    const step = asked.length >= 2 ? { index: i, of: asked.length } : undefined;
    const lead: Lead = { key: `ask:${a.question}`, kind: "ask", text: a.question, options: [...a.options], question: a.question, ...(step !== undefined ? { step } : {}) };
    const picked = step !== undefined ? o.picks?.[i] ?? null : null;
    rows.push({ kind: "card", key: `now-ask-${i}`, icon: "ask", verb: t("决定"), title: clip(a.question, WHOLE), ...(picked !== null ? { actions: [], detail: [t("已选：{0}", picked)] } : settle(pressablesFor(lead, lead.options, t))) });
  });
  for (const s of o.standing) {
    const lead: Lead = { key: s.key, kind: s.kind, text: s.text, options: s.options };
    rows.push({ kind: "card", key: `now-${s.key}`, icon: s.kind === "broken" ? "warn" : s.key.startsWith("green:") ? "done" : "ask", verb: s.kind === "broken" ? t("出错") : "", title: s.text.replace(/^✗\s*/, ""), ...settle(pressablesFor(lead, s.options, t)) });
  }
  o.memory.backlog.forEach((b, i) => rows.push({ kind: "card", key: `now-backlog-${i}`, icon: "ask", verb: t("待决定"), title: clip(b.replace(/^(上一个问题|上一条里的事)?(还|仍|都)?(在)?等你(定|批)?[：:，,]?/, ""), 80), detail: [], actions: [] }));
  return rows.length === 0 ? [] : [{ kind: "section", key: "now", text: t("此刻") }, ...rows];
}
