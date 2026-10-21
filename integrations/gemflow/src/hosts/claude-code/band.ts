// The line above the prompt (spec §8.1), as text and buttons. Pure and
// Node-free: the hooks module lays these segments out with the surface's
// elements, so the terminal and the desktop draw the same words.
import type { JsonValue } from "../../core/schema.js";
import type { NextStep } from "../../workspace.js";
import type { Pressable } from "./actions.js";
import type { InboxItem } from "./inbox.js";
import { TODO_CAP, type ShellStatus, type TimelineEntry, type TodoCount } from "./protocol.js";
import { ZH, type T } from "./text.js";
import { between, waitedText } from "./time.js";

export type Tone = "normal" | "dim" | "success" | "warning" | "error" | "brand";
export interface Segment { text: string; tone: Tone }

/** Drawn, dim, between two segments. */
export const SEP = " · ";

/** Gemflow's red, the lower half of its mark: the mark where a surface draws no picture. Nothing else is red. */
export const BRAND_RED = "#ef3b3f";

/** The mark where a surface draws no picture (the terminal): Gemflow's one-character sign. */
export const MARK: Segment = { text: "»", tone: "brand" };

/** Gemflow's mark, sea blue over bright red, for a surface that draws pictures. */
export const MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="17.5 17 66 66"><polygon points="27,20 55,20 79,50 67,50 48,30 35,30 51,50 39,50 22,30 22,25" fill="#0077be"/><polygon points="27,80 55,80 79,50 67,50 48,70 35,70 51,50 39,50 22,70 22,75" fill="#ef3b3f"/></svg>';

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

/** Terminal cells a string takes: East Asian wide and fullwidth characters two; joiners, combining marks and variation selectors none. */
export function cellWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x200d || (c >= 0x300 && c <= 0x36f) || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    width += WIDE.some(([a, b]) => c >= a && c <= b) ? 2 : 1;
  }
  return width;
}

/** At most `max` cells, ending in `…` when cut; never half of a wide character. */
export function truncate(text: string, max: number): string {
  if (cellWidth(text) <= max) return text;
  if (max <= 0) return "";
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = cellWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/** Whole segments while they fit in `columns`, separators counted; the first that does not is cut, the rest dropped. */
export function fitSegments(segments: readonly Segment[], columns: number): Segment[] {
  const out: Segment[] = [];
  let used = 0;
  for (const s of segments) {
    const sep = out.length > 0 ? cellWidth(SEP) : 0;
    const width = cellWidth(s.text);
    if (used + sep + width <= columns) {
      out.push(s);
      used += sep + width;
      continue;
    }
    const room = columns - used - sep;
    if (room >= 2) out.push({ ...s, text: truncate(s.text, room) });
    break;
  }
  return out;
}

const TONE_COLOR: Readonly<Record<Tone, string | undefined>> = { normal: undefined, dim: undefined, success: "success", warning: "warning", error: "error", brand: BRAND_RED };

/** A `Text`'s props for a tone: a theme color, GEML's red in bold for the brand, or dim. */
export function toneProps(tone: Tone): { color?: string; dimColor?: true; bold?: true } {
  if (tone === "dim") return { dimColor: true };
  if (tone === "brand") return { color: BRAND_RED, bold: true };
  const color = TONE_COLOR[tone];
  return color !== undefined ? { color } : {};
}

/** Who takes a transition: a person, the machine when its guard holds, or the model (or a person) by hand. */
export const howText = (x: { judge: string; approval: boolean }, t: T = ZH): string => (x.approval ? t("需批准") : x.judge === "machine" ? t("自动") : t("手动"));

/** The way on in the flow's words: the step it leads to, and its note or who takes it. */
export function wayOnText(x: NextStep, t: T = ZH): string {
  return `${t("下一步「{0}」", x.label)}${x.note !== "" ? `：${x.note}` : `${SEP}${howText(x, t)}`}`;
}

export function nextText(x: NextStep, t: T = ZH): string {
  const waiting = x.judge === "machine" && !x.holds && x.missing.length > 0 ? `${SEP}${t("待 {0}", x.missing.join(" "))}` : "";
  return `→ #${x.to} ${howText(x, t)}${waiting}`;
}

/** A variable as the band shows it: a boolean as ✓ or ✗, anything else as its value. */
export function varSegment(name: string, value: JsonValue | undefined): Segment {
  if (typeof value === "boolean") return { text: `${name} ${value ? "✓" : "✗"}`, tone: value ? "success" : "dim" };
  return { text: `${name}=${JSON.stringify(value ?? null)}`, tone: "normal" };
}

/** A media work item's to-do count (spec §7.2), as the last refresh or board read it: display only; past the cap, `999+`. */
export function todoSegment(count: number, t: T = ZH): Segment {
  if (count <= 0) return { text: t("无待办"), tone: "success" };
  return { text: t("待办 {0} 项", count > TODO_CAP ? `${TODO_CAP}+` : count), tone: "normal" };
}

/**
 * The band's words: the bridge's problem alone when there is one; else the
 * work item, its stage, its to-do count when it is a media entry, the
 * variables the next guards read, the next step and the warnings. `setup` — a
 * tool or command the session would not register — comes last, or alone when
 * there is no stage to show. `todo` counts only for the work item it names,
 * and only while that item is in the stage it was read in.
 */
export function bandSegments(shell: ShellStatus | null, problem: string | null, setup: string | null = null, todo: TodoCount | null = null, t: T = ZH, show: { vars: boolean } = { vars: true }): Segment[] {
  if (problem !== null) return [{ text: problem, tone: "error" }];
  const tail: Segment[] = setup !== null ? [{ text: setup, tone: "error" }] : [];
  return [...stageSegments(shell, todo, t, show), ...tail];
}

function stageSegments(shell: ShellStatus | null, todo: TodoCount | null, t: T, show: { vars: boolean }): Segment[] {
  // The band is there from the start: before the bridge has answered it says so.
  if (shell === null) return [{ text: t("启动中…"), tone: "dim" }];
  const s = shell.status;
  if (s === null) {
    if (shell.problem !== undefined && !shell.problem.quiet) return [{ text: `gemflow：${shell.problem.text}`, tone: "error" }];
    // No workflow yet: say so, and which bundled one fits what the project holds.
    const out: Segment[] = [{ text: t("没有流程"), tone: "dim" }];
    if (shell.suggest !== undefined) out.push({ text: t("建议 {0}（{1}）", shell.suggest.workflow, shell.suggest.file ?? t("默认")), tone: "dim" });
    return out;
  }
  if (s.item.kind === "inactive") return [{ text: `⧗ ${s.item.reason}`, tone: "dim" }];
  const out: Segment[] = [{ text: `⧗ ${s.item.id}`, tone: "normal" }];
  // A work item started under another workflow than the default names its own.
  if (s.workflow.default !== undefined) out.push({ text: t("流程 {0}", s.workflow.name), tone: "dim" });
  out.push({ text: s.state?.id ?? "?", tone: "normal" });
  if (s.paused) {
    out.push({ text: `${t("⏸ 已暂停")}${SEP}${t("阶段不变，照常记录")}`, tone: "warning" });
    return out;
  }
  if (todo !== null && todo.item === s.item.id && todo.state === s.state?.id) out.push(todoSegment(todo.count, t));
  if (show.vars) for (const name of shell.policy?.relevant ?? []) out.push(varSegment(name, s.vars[name]));
  const edge = s.next.find((x) => x.judge === "machine" && !x.approval) ?? s.next.find((x) => x.approval) ?? s.next[0];
  if (edge !== undefined) out.push({ text: nextText(edge, t), tone: "dim" });
  else if (s.state?.final === true) out.push({ text: t("✓ 完成"), tone: "success" });
  if (s.gh !== undefined && !s.gh.available) out.push({ text: t("git 证据不可用：{0}", s.gh.reason), tone: "warning" });
  return out;
}

export interface BandInput {
  shell: ShellStatus | null;
  problem: string | null;
  setup: string | null;
  todo: TodoCount | null;
  /** The inbox, broken bridge first: its first item's actions are the band's. */
  inbox: readonly InboxItem[];
  timeline: readonly TimelineEntry[];
  now: string;
  t: T;
}

export interface BandView {
  /** What the person does with the line's one thing (定, 验收, 勾, 被拦), `已暂停`, `我在做`, or nothing. */
  verb: string;
  /** The one thing: a work item's name, a blocked tool, a problem's words. */
  title: string;
  tone: Tone;
  /** Dim words after the title: the stage while Claude works, the hold's meaning. */
  note: string;
  /** What hovering the title shows in its place: the thing whole. */
  detail: string;
  /** Its options, at most three, the main one first. */
  actions: Pressable[];
  /** The other things waiting on the person: how many, and their names for a hover. */
  more: { count: number; detail: string };
}

/** The most options the band draws for its one thing. */
const BAND_OPTIONS = 3;

/**
 * The band (spec §8.1): the one thing that is the person's now, with its
 * options, then how many more wait. A broken bridge or a setup problem comes
 * first; a held item offers `继续`; with nothing waiting, what Claude is
 * working on and in which stage.
 */
export function bandView(o: BandInput): BandView {
  const { t } = o;
  const none = { verb: "", note: "", detail: "", actions: [] as Pressable[], more: { count: 0, detail: "" } };
  const [first, ...rest] = o.inbox;
  const more = { count: rest.length, detail: rest.map((x) => `${x.verb ? `${x.verb} ` : ""}${x.title}`).join(SEP) };
  if (first?.kind === "broken") return { ...none, title: first.title, tone: "error", detail: first.detail.join(SEP), actions: first.actions.slice(0, BAND_OPTIONS), more };
  // A bridge problem the inbox has not taken up yet: its words, nothing to press into it.
  if (o.problem !== null) return { ...none, title: o.problem, tone: "error", more };
  if (o.setup !== null) return { ...none, title: o.setup, tone: "error", more };
  const shell = o.shell;
  if (shell === null) return { ...none, title: t("启动中…"), tone: "dim" };
  const s = shell.status;
  if (s === null) {
    if (shell.problem !== undefined && !shell.problem.quiet) return { ...none, title: `gemflow：${shell.problem.text}`, tone: "error" };
    const suggest = shell.suggest;
    return suggest === undefined
      ? { ...none, title: t("没有流程"), tone: "dim" }
      : {
          ...none, title: t("没有流程"), tone: "dim", note: t("建议 {0}（{1}）", suggest.workflow, suggest.file ?? t("默认")),
          actions: [{ key: "add-suggested", label: t("添加 {0}", suggest.workflow), primary: true, action: { op: "add", workflow: suggest.workflow } }, { key: "pick-workflow", label: t("选流程"), action: { op: "dialog", dialog: "settings" } }],
        };
  }
  if (s.item.kind === "inactive") return { ...none, title: s.item.reason, tone: "dim" };
  const name = s.title ?? s.item.id;
  if (s.paused) return { ...none, verb: t("已暂停"), title: name, tone: "warning", note: t("阶段不变，照常记录"), actions: [{ key: "resume", label: t("继续"), primary: true, action: { op: "resume" } }], more };
  if (first !== undefined) {
    return { verb: first.verb, title: first.title, tone: "normal", note: "", detail: first.detail.join(SEP), actions: first.actions.slice(0, BAND_OPTIONS), more };
  }
  const todo = o.todo !== null && o.todo.item === s.item.id && o.todo.state === s.state?.id ? todoSegment(o.todo.count, t).text : "";
  if (s.state?.final === true) return { ...none, title: name, tone: "normal", note: [t("✓ 完成"), todo].filter((x) => x !== "").join(SEP) };
  const waits = (s.depends ?? []).filter((d) => !d.done);
  const stage = [s.state?.title ?? "", waits.length > 0 ? t("等「{0}」完成", waits.map((d) => d.title ?? d.id).join("」「")) : ""].filter((x) => x !== "").join(SEP);
  const on = s.next.filter((x) => !x.toStart);
  const edge = on.find((x) => x.judge === "machine" && !x.approval) ?? on[0] ?? s.next[0];
  return {
    ...none, verb: t("我在做"), title: name, tone: "normal", note: [stage, todo].filter((x) => x !== "").join(SEP),
    detail: [stage, edge !== undefined ? wayOnText(edge, t) : ""].filter((x) => x !== "").join(SEP),
  };
}
