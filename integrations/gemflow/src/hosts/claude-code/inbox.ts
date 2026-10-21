// The inbox (spec §8.2, 待处理): everything only a person can do, each with its
// actions, from the shell's status and the journal's timeline. Pure and
// Node-free: the hooks module draws the items and runs the actions.
import type { Lesson } from "../../core/dictionary.js";
import { waitsOnPerson } from "../../core/turn.js";
import type { Pressable } from "./actions.js";
import type { BoardData, ShellStatus, TimelineEntry } from "./protocol.js";
import type { T } from "./text.js";
import { between, waitedText } from "./time.js";

export type InboxKind = "approve" | "resume" | "suggest" | "tick" | "stuck" | "broken";

export interface InboxItem {
  kind: InboxKind;
  key: string;
  /** What the person does with it, drawn before the title: 定, 验收, 勾, 被拦; empty for a broken bridge. */
  verb: string;
  title: string;
  /** A word beside the title: the stage another work item waits in. */
  tag?: string;
  detail: string[];
  /** Its main option closes the work item: the person is to accept the work. */
  closes?: true;
  /** Since when it has waited, ISO; absent when unknown. */
  since?: string;
  actions: Pressable[];
}

export interface InboxInput {
  shell: ShellStatus | null;
  timeline: readonly TimelineEntry[];
  /** Why the bridge is unavailable, when it is. */
  problem: string | null;
  now: string;
  t: T;
  /** Refusals of one key this close together, and this many, are "stuck": default 30 minutes, 2. */
  stuckWindowMs?: number;
  stuckCount?: number;
}

/** A broken bridge first: nothing else is trustworthy until it is back. */
const KIND_ORDER: readonly InboxKind[] = ["broken", "approve", "resume", "suggest", "tick", "stuck"];

/** A way out's note under its button's words; a note that already starts with them, as it is. */
const noteOf = (label: string, note: string, t: T): string => (note.startsWith(label) ? note : t("{0}：{1}", label, note));

/** The revision at which the current stage was entered, as the timeline shows it: the last entry, a transition, or a rollback into another state. */
export function stageEntryOf(timeline: readonly TimelineEntry[]): number {
  let prevState: string | undefined;
  let entry = 0;
  for (const e of timeline) {
    if (e.kind !== "snapshot") continue;
    if (e.cause === "enter" || e.cause === "transition" || (e.cause === "rollback" && prevState !== e.state)) entry = e.rev;
    prevState = e.state;
  }
  return entry;
}

/** The reason without the way-out tail every refusal carries. */
export const shortReason = (reason: string): string => reason.replace(/;\s*switching the work item is always allowed:.*$/s, "");

export function inboxItems(o: InboxInput): InboxItem[] {
  const { t } = o;
  const items: InboxItem[] = [];
  if (o.problem !== null) {
    items.push({ kind: "broken", key: "broken", verb: "", title: o.problem, detail: [t("调用照常执行，不做记录")], actions: [{ key: "retry", label: t("重试"), primary: true, action: { op: "retry" } }] });
  }
  const s = o.shell?.status ?? null;
  const policy = o.shell?.policy ?? null;
  const lastAt = [...o.timeline].reverse().find((e) => e.kind === "snapshot")?.at;
  if (s !== null && s.item.kind === "item" && s.state !== undefined && !s.paused) {
    const state = s.state.id;
    const title = s.title ?? s.item.id;
    // Only when the way on is the person's alone: while the model or the evidence can move the work, nothing waits on them.
    const turn = waitsOnPerson(s.next, s.sources) && !(s.depends ?? []).some((d) => !d.done);
    // One item for the work item: every way out a person may take now is one of its options, the ones waiting on them first.
    const waiting = turn ? s.next.filter((x) => x.approval && x.holds) : [];
    if (waiting.length > 0) {
      const others = s.next.filter((x) => !x.approval && x.holds && x.judge === "model");
      const actions: Pressable[] = [...waiting, ...others].map((edge, i) => ({
        key: `approve-${edge.to}`, label: edge.label, ...(i === 0 ? { primary: true } : {}), action: { op: "advance", to: edge.to, say: t("{0}：{1}", edge.label, title) },
      }));
      const closes = waiting.some((edge) => edge.toFinal);
      const notes = waiting.filter((edge) => edge.note !== "").map((edge) => noteOf(edge.label, edge.note, t));
      items.push({
        kind: "approve", key: `approve-${state}`, verb: closes ? t("验收") : t("决定"), ...(closes ? { closes: true as const } : {}),
        title,
        detail: [s.state.title, ...notes],
        ...(lastAt !== undefined ? { since: lastAt } : {}), actions,
      });
    }
    for (const name of turn ? policy?.relevant ?? [] : []) {
      if (s.sources[name] !== "human" || s.vars[name] === true) continue;
      const ways = s.next.filter((x) => x.reads.includes(name)).map((x) => x.label);
      if (ways.length === 0) continue;
      items.push({
        kind: "tick", key: `tick-${name}`, verb: t("勾"), title,
        detail: [t("勾上 {0}，才走「{1}」", name, ways.join("」「"))],
        ...(s.state.since !== undefined ? { since: s.state.since } : {}),
        actions: [{ key: `mark-${name}`, label: t("勾选"), primary: true, action: { op: "mark", variable: name, checked: true } }],
      });
    }
    const since = stageEntryOf(o.timeline);
    const window = o.stuckWindowMs ?? 30 * 60_000;
    const least = o.stuckCount ?? 2;
    const groups = new Map<string, { key?: string; reason: string; tool: string; at: string[] }>();
    for (const e of o.timeline) {
      if (e.kind !== "refused" || e.rev < since) continue;
      const id = e.key ?? shortReason(e.reason);
      const g = groups.get(id) ?? { ...(e.key !== undefined ? { key: e.key } : {}), reason: shortReason(e.reason), tool: e.tool, at: [] };
      g.at.push(e.at);
      groups.set(id, g);
    }
    for (const g of groups.values()) {
      const recent = g.at.filter((at) => { const ms = between(at, o.now); return Number.isFinite(ms) && ms <= window; });
      if (recent.length < least) continue;
      const first = recent[0] as string;
      const span = between(first, o.now);
      const what = g.key ?? g.tool;
      const actions: Pressable[] = [];
      if (g.key !== undefined) actions.push({ key: `pass-${g.key}`, label: t("放行一次"), primary: true, action: { op: "pass-once", keys: [g.key] } });
      // A key the dictionary denied in this state (not one fenced by the workflow) can be allowed here.
      const row = g.key !== undefined ? policy?.rows.find((r) => r.tool === g.key) : undefined;
      if (g.key !== undefined && row !== undefined && row.for === undefined) {
        const lessons: Lesson[] = [{ kind: "allow", key: g.key, where: state }];
        actions.push({ key: `allow-${g.key}`, label: t("在 #{0} 也允许", state), action: { op: "learn", lessons } });
      }
      actions.push({ key: `journal-${what}`, label: t("看记录"), action: { op: "tab", tab: "journal" } });
      items.push({
        kind: "stuck", key: `stuck-${what}`, verb: t("被拦"), title: what,
        // Within a minute there is no span worth naming: they came one after another.
        detail: [g.reason, Number.isFinite(span) && span < 60_000 ? t("连续 {0} 次", recent.length) : t("{0}内 {1} 次", Number.isFinite(span) ? waitedText(first, o.now, t).replace(/^.*?(\d)/, "$1") : "", recent.length)],
        since: first, actions,
      });
    }
  }
  return items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.since ?? "~").localeCompare(b.since ?? "~"));
}

/**
 * Every other work item whose way on is the person's (the board's `asks`):
 * one item each, 定 or 验收, its options taken on its file and saying what was
 * chosen; one with no file (another checkout's branch) is shown, and taken
 * there.
 */
export function othersWaiting(board: BoardData | null, current: string | undefined, t: T): InboxItem[] {
  if (board === null) return [];
  const states = new Map(board.states.map((s) => [s.id, s.title]));
  return [...comebacks(board, current, t), ...board.items.filter((i) => i.id !== current && (i.asks?.length ?? 0) > 0).map((i): InboxItem => {
    const asks = i.asks ?? [];
    const title = i.title ?? i.id;
    const closes = asks.some((a) => a.final);
    return {
      kind: "approve", key: `asks-${i.id}`, verb: closes ? t("验收") : t("决定"), ...(closes ? { closes: true as const } : {}), title,
      // Its stage in its own flow's words: the board's states are the current flow's, and a matter beside a branch is in another.
      tag: i.about !== undefined ? t("建议 · {0}", aboutWords(i.about, t)) : i.flow !== undefined && i.workflow !== undefined ? `${i.flow} · ${i.stateTitle ?? states.get(i.state) ?? i.state}` : i.stateTitle ?? states.get(i.state) ?? i.state,
      // What the work item says of itself; without it, what its options mean.
      detail: i.gist !== undefined ? [i.gist] : asks.filter((a) => a.note !== "").map((a) => noteOf(a.label, a.note, t)),
      actions: i.file === undefined ? [] : asks.map((a, n): Pressable => ({
        key: `asks-${i.id}-${a.to}`, label: a.label, ...(n === 0 ? { primary: true } : {}), action: { op: "advance", to: a.to, file: i.file, say: t("{0}：{1}", a.label, title) },
      })),
    };
  })];
}

/**
 * The work items whose dependencies are all done since they last moved: each
 * is to come back to — its flow, what was done, and a press that makes it the
 * current one again and says so in the conversation.
 */
function comebacks(board: BoardData, current: string | undefined, t: T): InboxItem[] {
  return board.items.flatMap((i): InboxItem[] => {
    const deps = i.depends ?? [];
    if (i.id === current || i.file === undefined || i.final === true || deps.length === 0 || deps.some((d) => !d.done)) return [];
    const doneAt = Math.max(...deps.map((d) => (d.at !== undefined ? Date.parse(d.at) : 0)));
    if (!(doneAt > Date.parse(i.at))) return [];
    const title = i.title ?? i.id;
    return [{
      kind: "resume", key: `resume-${i.id}`, verb: t("回到"), title, ...(i.flow !== undefined ? { tag: i.flow } : {}),
      detail: [t("「{0}」已完成", deps.map((d) => d.title ?? d.id).join("」「"))],
      actions: [{ key: `resume-${i.id}`, label: t("继续"), primary: true, action: { op: "switch-file", file: i.file, say: t("继续：{0}", title) } }],
    }];
  });
}

/** What a suggestion is about, in words: the workflow, the tools, or as its author wrote it. */
export const aboutWords = (about: string, t: T): string => (about === "flow" ? t("流程") : about === "tools" ? t("工具") : about);

/** What waits on the person, in the order they read it: a broken bridge, the current work item's decision, the other work items', a tick, a block. */
export function pendingList(inbox: readonly InboxItem[], others: readonly InboxItem[]): InboxItem[] {
  return [...inbox, ...others].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** The item the band acts on: the first in the inbox, broken bridge first. */
export const urgent = (items: readonly InboxItem[]): InboxItem | undefined => items[0];
