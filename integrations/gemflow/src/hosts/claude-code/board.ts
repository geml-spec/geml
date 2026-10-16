// The board's six tabs (spec §8.2) as rows of text, buttons, links and
// fields. Pure and Node-free: the hooks module lays the rows out with the
// surface's elements and runs a button's action.
import { bindingOf, type DictRow } from "../../core/dictionary.js";
import type { Status } from "../../workspace.js";
import type { BoardAction, BoardTab, JournalFilter, Pressable } from "./actions.js";
import { howText, truncate, varSegment, type Tone } from "./band.js";
import { othersWaiting, pendingList, shortReason, type InboxItem } from "./inbox.js";
import type { BoardData, BoardItem, Products, ShellStatus, TimelineEntry } from "./protocol.js";
import { promptLine, promptTail, type PromptRecord } from "./sessions.js";
import { ZH, type T } from "./text.js";
import { agoText, between, dayText, durationText, hhmm, waitedText } from "./time.js";
import { groupOf, guessUse, keyWords, type ToolGroup } from "./usage.js";

export const BOARD_ID = "gemflow-board";
export const DIALOG_ID = "gemflow-dialog";

export const TAB_IDS: readonly BoardTab[] = ["sessions", "flow", "items", "journal", "tools"];

/** The tab the board opens on: the work items, what waits on the person on top. */
export const HOME_TAB: BoardTab = "items";

/** The tabs in order, labelled. */
export function tabs(t: T = ZH): { id: BoardTab; label: string }[] {
  const label = (id: BoardTab): string => {
    switch (id) {
      case "sessions": return t("会话");
      case "flow": return t("流程");
      case "items": return t("工作项");
      case "journal": return t("记录");
      case "tools": return t("工具");
    }
  };
  return TAB_IDS.map((id) => ({ id, label: label(id) }));
}

/** What a field's text means when submitted. */
export type InputField = "add-tool" | "import-workflow" | "tool-search" | "new-use";

export type BoardRow =
  | { kind: "text"; text: string; tone: Tone }
  | { kind: "button"; key: string; label: string; action: BoardAction; primary?: boolean }
  /** Several buttons on one line. */
  | { kind: "buttons"; items: Pressable[] }
  | { kind: "link"; key: string; href: string; label: string }
  /** A field: what it is for, the key it acts on (a tool, for a new use), and for a search its text so far, read as typed. */
  | { kind: "input"; key: string; placeholder: string; field: InputField; target?: string; value?: string }
  /**
   * The flow picture (spec §8.2): the states by rank, each with what the
   * runtime knows of it, and every way out with its words — one a person may
   * take now carries its number on the picture and its press. `svg` is the
   * same picture as markup, for a surface that inlines it.
   */
  | { kind: "flow"; key: string; ranks: FlowStateRow[][]; edges: FlowEdgeRow[]; svg: string }
  /** A group's heading: its words, how many it holds when that is worth saying, and a press that lists or folds it. */
  | { kind: "section"; key: string; text: string; count?: number; fold?: Pressable }
  /**
   * One thing waiting on the person (the work items tab's top group): the icon
   * for what it asks, its verb and name, a tag (what the work made, or the
   * stage it waits in), its detail, and its options.
   */
  | { kind: "card"; key: string; icon: Icon; verb: string; title: string; tag?: string; detail: string[]; actions: Pressable[] }
  /** A picture where the surface draws one (the about dialog's lockup); its words elsewhere. */
  | { kind: "image"; key: string; svg: string; alt: string; width?: number }
  /** A page's own heading: its words, a dim word beside them, and a press at its end. */
  | { kind: "heading"; key: string; text: string; sub: string; action?: Pressable }
  /** A work item in a list: its name, a tag, and the press that makes it the current one, when it can be. */
  | { kind: "entry"; key: string; title: string; tag: string; tone: Tone; action?: BoardAction }
  /**
   * Something that happened to the work item (the journal tab): its time, what
   * kind (产物, 凭据, 阶段变更, 被拦, 开始), what, why, which turn caused it, and
   * the press that opens its menu; `detail` is its evidence, shown when `open`.
   */
  | { kind: "event"; key: string; at: string; glyph: Glyph; label: string; text: string; why: string; turn: string; tone: Tone; detail: string[]; open: boolean; action: BoardAction }
  /** A tool of the dictionary or one that ran (the tools tab): its name, its use, what it looks like when it has none, how often it ran, and the press that opens its menu. */
  | { kind: "tool"; key: string; name: string; use: string; guess: string; count: string; tone: Tone; action?: BoardAction }
  /** A work item's way through its flow: each state in order, passed or not, the current one marked. */
  | { kind: "steps"; key: string; steps: { title: string; passed: boolean; current: boolean }[] }
  /** A prompt of the session (the sessions tab): its time, its first line, what its turn did, and the press that opens or closes its menu. */
  | { kind: "turn"; key: string; at: string; text: string; did: string; open: boolean; action: BoardAction };

/** What a card asks of the person: to decide, to accept the work, or to see why something is blocked. */
export type Icon = "ask" | "done" | "warn";
export const ICON_TONE: Readonly<Record<Icon, Tone>> = { ask: "warning", done: "success", warn: "error" };
/** The icons as characters, for a surface that draws no pictures. */
export const ICON_CHAR: Readonly<Record<Icon, string>> = { ask: "?", done: "✓", warn: "!" };
const ICON_COLOR: Readonly<Record<Icon, string>> = { ask: "#c98a1b", done: "#2e9e5b", warn: "#d6453d" };
const ICON_MARK: Readonly<Record<Icon, string>> = { ask: "M9.6 9.3a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5V14M12 17h.01", done: "M8.5 12.2l2.4 2.4 4.6-5", warn: "M12 7.5v5.5M12 16.5h.01" };
const iconSvg = (k: Icon): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${ICON_COLOR[k]}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="${ICON_MARK[k]}"/></svg>`;
/** The icons as line drawings: a circle and its mark, in a colour that reads on a light and a dark ground alike. */
export const ICON_SVG: Readonly<Record<Icon, string>> = { ask: iconSvg("ask"), done: iconSvg("done"), warn: iconSvg("warn") };

/**
 * The pane's line icons, drawn as the design draws them (docs/design/ui/2026-10-13-gemflow-ui): a tab's, a dialog's,
 * and each kind of journal entry's. Only where the surface draws pictures; elsewhere the words stand alone.
 */
export type Glyph = BoardTab | "share" | "settings" | "upgrade" | "about" | "product" | "evidence" | "move" | "refused" | "start" | "waits" | "done" | "board";
const GLYPH_PATH: Readonly<Record<Glyph, string>> = {
  sessions: '<path d="M4 5h16v11H9l-5 4z"/>',
  flow: '<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M6.5 8v5h11v3"/>',
  items: '<path d="M10 6h10M10 12h10M10 18h10M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
  journal: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  tools: '<path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 15V3M8 7l4-4 4 4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  upgrade: '<circle cx="12" cy="12" r="9"/><path d="M12 16V8M8.5 11.5 12 8l3.5 3.5"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  product: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  evidence: '<path d="M6 3h8l4 4v14H6z"/><path d="M9.5 14l2 2 3.5-4"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  refused: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  start: '<circle cx="12" cy="12" r="8.5"/><path d="M10.5 9l4 3-4 3z"/>',
  waits: '<circle cx="12" cy="12" r="8.5"/><path d="M10 9v6M14 9v6"/>',
  done: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/>',
};
/** A glyph's stroke by its tone: one grey that reads on a light and a dark ground, the accent for what is chosen, the tone's own colour otherwise. */
const GLYPH_COLOR: Readonly<Record<Tone | "active", string>> = {
  normal: "#8a8986", dim: "#8a8986", active: "#0077be", success: "#2e9e5b", warning: "#c98a1b", error: "#d6453d", brand: "#ef3b3f",
};
/** A glyph as a line drawing in its tone's colour. */
export function glyphSvg(g: Glyph, tone: Tone | "active" = "dim"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${GLYPH_COLOR[tone]}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${GLYPH_PATH[g]}</svg>`;
}
/** The glyph of a journal entry, by what made it. */
export function entryGlyph(e: TimelineEntry): Glyph {
  if (e.kind === "refused") return "refused";
  switch (e.cause) {
    case "enter": return "start";
    case "patch":
    case "expire": return "evidence";
    case "pause": return "waits";
    default: return "move";
  }
}

export interface FlowStateRow {
  id: string;
  title: string;
  initial: boolean;
  final: boolean;
  current: boolean;
  /** The work items standing here, when worth a badge: none for the current state's one item. */
  count: number;
  uses: string[];
}
export interface FlowEdgeRow {
  name: string;
  from: string;
  to: string;
  /** To the next rank; over or back across ranks; or to its own state. */
  kind: "forward" | "lane" | "self";
  /** A lane that goes back to an earlier rank, as against over one. */
  back: boolean;
  /** The way out in words: who takes it, and its condition. */
  text: string;
  /** Whether a machine-judged condition holds now; absent for a person's sentence or no condition. */
  holds?: boolean;
  approval: boolean;
  /** The transition last taken. */
  taken: boolean;
  /** A way out a person may take now: its number on the picture (the hotkey), and the press. */
  press?: { n: number; action: BoardAction };
}

const BLANK = " ";
const text = (s: string, columns: number, tone: Tone = "normal"): BoardRow => ({ kind: "text", text: truncate(s, columns), tone });
const button = (key: string, label: string, columns: number, action: BoardAction, primary?: boolean): BoardRow => ({ kind: "button", key, label: truncate(label, columns), action, ...(primary ? { primary } : {}) });
const buttons = (items: Pressable[]): BoardRow => ({ kind: "buttons", items });

/**
 * What a field's text does: a search narrows the tools tab (empty, to all);
 * a new use is a `use` lesson for its tool; `tool | use` a `use` lesson and
 * `tool` alone an allow everywhere; a path imports a workflow. Empty, nothing.
 */
export function inputAction(field: InputField, typed: string, target?: string): BoardAction | undefined {
  if (field === "tool-search") return { op: "tool-search", query: typed };
  const s = typed.trim();
  if (s === "") return undefined;
  if (field === "import-workflow") return { op: "import", path: s };
  if (field === "new-use") return target === undefined ? undefined : { op: "learn", lessons: [{ kind: "use", key: target, use: s }] };
  const [tool, use] = s.split("|").map((x) => x.trim());
  if (tool === undefined || tool === "") return undefined;
  return { op: "learn", lessons: use !== undefined && use !== "" ? [{ kind: "use", key: tool, use }] : [{ kind: "allow", key: tool, where: "*" }] };
}

export interface PaneInput {
  board: BoardData | null;
  /** Why the board could not be read again; null when it could. */
  problem: string | null;
  shell: ShellStatus | null;
  tab: BoardTab;
  columns: number;
  maxRows: number;
  t: T;
  now: string;
  /** The project root, for the links to the workflow's files. */
  root: string;
  inbox: readonly InboxItem[];
  filter: JournalFilter;
  /** The journal entry whose menu is open (its row key), or null. */
  expanded: string | null;
  /** The journal entry whose evidence shows (its row key), or null. */
  evidence: string | null;
  prompts: readonly PromptRecord[];
  /** The prompt whose menu is open (its id), or null. */
  menu: string | null;
  /** The flow the sessions tab shows (its title), or null for all; the runs of another flow's turns unfolded (their first prompt's id). */
  sessionFlow: string | null;
  sessionRuns: readonly string[];
  /** Whether the work items tab lists the finished work items, or only counts them. */
  doneOpen: boolean;
  /** The state the flow tab shows below its picture, or null for the current one. */
  flowState: string | null;
  /** Whether the flow tab lists the workflows to switch to; and those workflows, once read. */
  switching: boolean;
  workflows: { bundled: string[]; installed: string[] } | null;
  /** How often each key ran these two days; the suggestions put away; the tools tab's search, open menu, new-use field and listed groups. */
  usage: Readonly<Record<string, number>>;
  dismissed: readonly string[];
  toolQuery: string;
  toolMenu: string | null;
  toolNaming: string | null;
  toolsOpen: readonly string[];
}

/**
 * The pane's rows under its tabs: the tab's rows, under the reason the board
 * could not be read again when it could not (the last board stays); the
 * reason alone when there is no board yet, and a wait line before the first.
 * The sessions tab needs no board, and the work items tab shows what waits on
 * the person before it has one.
 */
export function paneRows(o: PaneInput): BoardRow[] {
  const { t, columns } = o;
  const head = o.problem !== null ? [text(o.problem, columns, "error")] : [];
  const status = o.shell?.status ?? null;
  const wait = o.board === null && head.length === 0 ? [text(t("正在读取看板…"), columns, "dim")] : [];
  if (o.tab === "sessions") return [...head, ...sessionRows(o.prompts, o.menu, o.board?.products?.commits ?? [], t, columns, o.now, { flow: o.sessionFlow, runs: o.sessionRuns, current: status?.workflow.title })];
  const suggestions = o.board !== null ? [...toolSuggestions(o.board, o.usage, o.dismissed, t), ...ciSuggestions(o.board, o.shell?.units ?? [], o.dismissed, t)] : [];
  if (o.tab === "items") return [...head, ...itemRows({ board: o.board, status, inbox: o.inbox, columns, t, now: o.now, doneOpen: o.doneOpen, suggestions }), ...wait];
  if (o.board === null) return head.length > 0 ? head : wait;
  if (o.tab === "flow") return [...head, ...flowRows({ board: o.board, status, columns, t, ...(o.now !== undefined ? { now: o.now } : {}), selected: o.flowState, switching: o.switching, workflows: o.workflows })];
  if (o.tab === "tools") return [...head, ...toolRows({ board: o.board, columns, t, usage: o.usage, suggestions, query: o.toolQuery, menu: o.toolMenu, naming: o.toolNaming, open: o.toolsOpen })];
  return [...head, ...journalRows({ board: o.board, status, filter: o.filter, menu: o.expanded, evidence: o.evidence, prompts: o.prompts, columns, maxRows: Math.max(1, o.maxRows - head.length), t, now: o.now })];
}

// ---- flow -----------------------------------------------------------------------

/** Common uses in words; a use the table does not know goes by its own name. */
const USE_WORDS: Readonly<Record<string, string>> = {
  edit: "改文件", test: "跑测试", pr: "开 PR", check: "检查", note: "写事项", "deploy-staging": "部署到 staging", "deploy-prod": "部署到 production",
  image: "出图", video: "出视频", voice: "配音", render: "渲染", "todo-check": "查待办", "stale-check": "查过期片段", refund: "退款",
};
export const useWords = (use: string, t: T = ZH): string => (USE_WORDS[use] !== undefined ? t(USE_WORDS[use] as string) : use);

/** What a tool key looks like in a list: `Bash(npm test)` as the command it matches. */
const toolWords = (key: string): string => key.replace(/^Bash\((.*)\)$/s, "$1");

export interface FlowInput {
  board: BoardData;
  status: Status | null;
  columns: number;
  t: T;
  now?: string;
  /** The state shown below the picture; null, the current one (else the first). */
  selected: string | null;
  switching: boolean;
  workflows: { bundled: string[]; installed: string[] } | null;
}

/**
 * The flow tab: the work item's workflow by its title, with the workflows to
 * switch to on a press (the installed ones to use, the bundled ones to add,
 * a path to import); the suggestions about it waiting on the person; the
 * picture; a row of its states; and the one picked — its description, the
 * uses it declares with the tools bound to them, the ones it does not, what
 * runs everywhere, and on the current state what the person may tick.
 */
export function flowRows(o: FlowInput): BoardRow[] {
  const { board, status, columns, t } = o;
  const current = status?.state?.id;
  const acting = status?.item.kind === "item" && status.paused !== true;
  const next = new Map((status?.next ?? []).map((x) => [x.name, x]));
  const rows: BoardRow[] = [];
  const name = status?.workflow.default ?? status?.workflow.name;
  if (status !== null) {
    rows.push({ kind: "heading", key: "flow-title", text: status.workflow.title, sub: status.workflow.name, action: { key: "flow-switch", label: o.switching ? t("收起") : t("换一个 ▾"), action: { op: "flow-switch", open: !o.switching } } });
  }
  if (o.switching) {
    if (o.workflows === null) rows.push(text(t("正在读取…"), columns, "dim"));
    else {
      rows.push(buttons([
        ...o.workflows.installed.map((w): Pressable => ({ key: `use-${w}`, label: w, ...(w === name ? { primary: true } : {}), action: { op: "use", workflow: w } })),
        ...o.workflows.bundled.filter((w) => !o.workflows?.installed.includes(w)).map((w): Pressable => ({ key: `add-${w}`, label: t("添加 {0}", w), action: { op: "add", workflow: w } })),
      ]));
      rows.push(text(t("换了以后，新的工作项走它；已经开始的照旧。"), columns, "dim"));
    }
    rows.push({ kind: "input", key: "import-workflow", placeholder: t("导入：流程目录或 flow.geml 的路径"), field: "import-workflow" });
  }
  // Who waits on the current work item: their flow, their stage, and that they come back after it.
  const me = status?.item.kind === "item" ? status.item.id : undefined;
  for (const w of board.items.filter((i) => (i.depends ?? []).some((d) => d.id === me && !d.done))) {
    rows.push(text(`${w.flow ?? ""} · ${w.stateTitle ?? w.state} · ${t("等「{0}」", status?.title ?? me ?? "")}`, columns, "dim"));
    rows.push(text(t("从「{0}」跳进来，完成后回到「{0}」。", w.title ?? w.id), columns, "dim"));
  }
  // The suggestions about the workflow, waiting on the person: the same cards as the work items tab's.
  for (const i of othersWaiting(board, status?.item.kind === "item" ? status.item.id : undefined, t).filter((x) => board.items.find((b) => `asks-${b.id}` === x.key)?.about === "flow")) {
    rows.push({ kind: "card", key: `flow-${i.key}`, icon: "ask", verb: i.verb, title: i.title, ...(i.tag !== undefined ? { tag: i.tag } : {}), detail: i.detail, actions: i.actions });
  }
  rows.push(flowRow(board, current, acting, next, t));
  const order = board.picture.flow.ranks.flat().filter((id) => board.states.some((s) => s.id === id));
  const pick = o.selected !== null && board.states.some((s) => s.id === o.selected) ? o.selected : current ?? order[0];
  rows.push(buttons(order.map((id): Pressable => {
    const s = board.states.find((x) => x.id === id);
    return { key: `state-${id}`, label: s?.title ?? id, ...(id === pick ? { primary: true } : {}), action: { op: "flow-state", id } };
  })));
  const state = board.states.find((s) => s.id === pick);
  if (state === undefined) return rows;
  rows.push({ kind: "heading", key: "state-title", text: state.title, sub: state.id === current ? t("此刻在这里") : "" });
  if (state.description !== "") rows.push(text(state.description, columns, "dim"));
  const bound = (use: string): string => board.tools.filter((r) => r.for === use).map((r) => toolWords(r.tool)).join(" · ");
  const everywhere = board.tools.filter((r) => r.for === undefined && r.allow.includes("*")).map((r) => toolWords(r.tool));
  const denied = board.tools.filter((r) => r.for === undefined && (r.deny.includes(state.id) || r.deny.includes("*"))).map((r) => toolWords(r.tool));
  rows.push({ kind: "section", key: "uses-here", text: t("这里能用") });
  for (const use of state.uses) rows.push({ kind: "entry", key: `use-${use}`, title: useWords(use, t), tag: bound(use) || t("没有绑工具"), tone: "normal" });
  if (everywhere.length > 0) rows.push({ kind: "entry", key: "use-everywhere", title: t("哪里都能用"), tag: everywhere.join(" · "), tone: "normal" });
  if (state.uses.length === 0 && everywhere.length === 0) rows.push(text(`  ${t("没有")}`, columns, "dim"));
  const elsewhere = board.fences.filter((f) => !f.states.includes(state.id));
  if (elsewhere.length > 0 || denied.length > 0) {
    rows.push({ kind: "section", key: "uses-not-here", text: t("这里不能用") });
    for (const f of elsewhere) rows.push({ kind: "entry", key: `fence-${f.use}`, title: useWords(f.use, t), tag: f.states.length > 0 ? t("只在{0}", f.states.map((id) => board.states.find((s) => s.id === id)?.title ?? id).join("、")) : t("哪一格都没有"), tone: "dim" });
    for (const d of denied) rows.push({ kind: "entry", key: `deny-${d}`, title: d, tag: t("词典里拒绝"), tone: "dim" });
  }
  rows.push(text(t("没归类的工具哪里都照常能用。"), columns, "dim"));
  // On the current state, what the person may tick: the variables only they set, read by its ways out.
  if (state.id === current && status !== null) {
    const ticks = [...new Set(status.next.flatMap((x) => x.reads))].filter((v) => status.sources[v] === "human");
    if (ticks.length > 0 && acting) {
      rows.push({ kind: "section", key: "ticks", text: t("你来勾") });
      rows.push(buttons(ticks.map((v): Pressable => {
        const on = status.vars[v] === true;
        return { key: `mark-${v}`, label: `${on ? "[x]" : "[ ]"} ${v}`, action: { op: "mark", variable: v, checked: !on } };
      })));
    }
    if (board.clocks.length > 0 && o.now !== undefined) {
      const since = status.state?.since;
      for (const c of board.clocks) {
        const held = since !== undefined ? between(since, o.now) : NaN;
        const left = Number.isFinite(held) ? (c.ms - held > 0 ? t("还有 {0}", durationText(c.ms - held, t)) : t("已到")) : "";
        rows.push(text(`${t("{0}：停留满 {1}", c.name, c.iso)}${left ? `  ${left}` : ""}`, columns, "dim"));
      }
    }
  }
  return rows;
}

/**
 * The picture's row: the parser's ranks and edges joined with the board's
 * words for each state and way out, and the runtime's overlay. The ways out
 * of the current state a person may take now (the condition holds, nobody
 * holds the work) are numbered in the picture's order; the number is the
 * button's hotkey.
 */
function flowRow(board: BoardData, current: string | undefined, acting: boolean, next: ReadonlyMap<string, { holds: boolean }>, t: T): BoardRow {
  const { flow, overlay } = board.picture;
  const states = new Map(board.states.map((s) => [s.id, s]));
  const trans = new Map(board.transitions.map((x) => [x.name, x]));
  const rankOf = new Map<string, number>();
  flow.ranks.forEach((ids, r) => { for (const id of ids) rankOf.set(id, r); });
  const ranks: FlowStateRow[][] = flow.ranks.map((ids) => ids.flatMap((id) => {
    const s = states.get(id);
    if (s === undefined) return [];
    const here = id === current;
    const n = overlay.counts?.[id] ?? 0;
    return [{ id, title: s.title, initial: s.initial, final: s.final, current: here, count: here && n === 1 ? 0 : n, uses: s.uses }];
  }));
  const taken = new Set(overlay.taken ?? []);
  let n = 0;
  const edges: FlowEdgeRow[] = flow.edges.flatMap((e) => {
    const x = trans.get(e.name);
    if (x === undefined) return [];
    const here = e.from === current;
    const step = here ? next.get(e.name) : undefined;
    const blocked = step !== undefined && !step.holds;
    const guard = x.guard !== undefined ? `  ${x.judge === "model" ? t("当") : t("要求")} ${x.guard}${blocked ? t("（未满足）") : ""}` : "";
    const row: FlowEdgeRow = {
      name: e.name, from: e.from, to: e.to, kind: e.kind, back: e.kind === "lane" && (rankOf.get(e.to) ?? 0) < (rankOf.get(e.from) ?? 0),
      text: `${howText(x, t)}${guard}`, approval: x.approval, taken: taken.has(e.name),
    };
    const holds = overlay.holds?.[e.name];
    if (holds !== undefined) row.holds = holds;
    // A person's advance needs the condition too: a way out whose condition does not hold is drawn, not offered.
    if (here && acting && !blocked) row.press = { n: ++n, action: { op: "advance", to: e.to } };
    return [row];
  });
  return { kind: "flow", key: "flow-picture", ranks, edges, svg: board.picture.svg };
}

/** A `file:` URL for a project-relative path. */
export function fileHref(root: string, rel: string): string {
  const base = root.split("\\").join("/").replace(/\/+$/, "");
  const path = `${base}/${rel.split("\\").join("/")}`;
  return `file://${path.startsWith("/") ? "" : "/"}${path.split("/").map((seg) => encodeURIComponent(seg)).join("/")}`;
}

// ---- items ----------------------------------------------------------------------

/** The current work item's way through its flow: the states in the picture's order, the ones its journal entered passed, the one it is in marked. */
export function stepsOf(board: BoardData, current: string): { title: string; passed: boolean; current: boolean }[] {
  const entered = new Set(board.timeline.flatMap((e) => (e.kind === "snapshot" ? [e.state] : [])));
  return board.picture.flow.ranks.flat().flatMap((id) => {
    const s = board.states.find((x) => x.id === id);
    return s === undefined ? [] : [{ title: s.title, passed: entered.has(id) && id !== current, current: id === current }];
  });
}

/** What the work made, in a word: its one commit, how many commits, or how many files it wrote; nothing when it made none yet. */
export function productsTag(p: Products | undefined, t: T = ZH): string | undefined {
  if (p === undefined) return undefined;
  const ours = p.commits.filter((c) => c.ours);
  if (ours.length === 1) return (ours[0] as Products["commits"][number]).sha.slice(0, 8);
  if (ours.length > 1) return t("{0} 个提交", ours.length);
  return p.written.length > 0 ? t("{0} 个文件", p.written.length) : undefined;
}

export interface ItemsInput {
  board: BoardData | null;
  status: Status | null;
  inbox: readonly InboxItem[];
  columns: number;
  t: T;
  now?: string;
  doneOpen: boolean;
  /** The suggestions about the tools waiting on the person (toolSuggestions). */
  suggestions?: readonly InboxItem[];
}

/**
 * The work items tab: what waits on the person on top, one card each with its
 * options — the current work item's things as the inbox has them, then every
 * other work item whose way out is theirs to take; then the work items queued,
 * the current one first; then the finished ones, counted, listed on a press;
 * then the backlog when the project keeps one.
 */
export function itemRows(o: ItemsInput): BoardRow[] {
  const { board, status, t, columns } = o;
  const current = status?.item.kind === "item" ? status.item.id : undefined;
  const states = new Map((board?.states ?? []).map((s) => [s.id, s]));
  const nameOf = (i: BoardItem): string => i.title ?? i.id;
  const stateTitle = (id: string): string => states.get(id)?.title ?? id;
  const made = board?.products !== undefined && board.products.item === current ? productsTag(board.products, t) : undefined;
  const rows: BoardRow[] = [{ kind: "section", key: "waiting", text: t("待处理") }];
  const others = othersWaiting(board, current, t);
  const gist = board?.items.find((i) => i.id === current)?.gist;
  for (const i of pendingList(o.inbox, [...others, ...(o.suggestions ?? [])])) {
    const mine = i.kind === "approve" && i.tag === undefined;
    const tag = i.tag ?? (mine ? made : undefined);
    rows.push({
      kind: "card", key: i.key, icon: i.kind === "stuck" || i.kind === "broken" ? "warn" : i.closes || i.kind === "resume" ? "done" : "ask", verb: i.verb, title: i.title,
      ...(tag !== undefined ? { tag } : {}), detail: mine && gist !== undefined ? [gist] : i.detail, actions: i.actions,
    });
  }
  if (rows.length === 1) rows.push(text(t("没有要你做的事"), columns, "dim"));
  if (board === null) return rows;
  const items = board.items;
  const waiting = new Set([...items.filter((i) => i.id !== current && (i.asks?.length ?? 0) > 0).map((i) => i.id), ...(current !== undefined && o.inbox.some((i) => i.kind === "approve") ? [current] : [])]);
  const recent = (a: BoardItem, b: BoardItem): number => b.at.localeCompare(a.at);
  // Done by its own flow when the board knows it, else by the current flow's states.
  const isDone = (i: BoardItem): boolean => i.final === true || (i.since === undefined && states.get(i.state)?.final === true);
  const stageOf = (i: BoardItem): string => i.stateTitle ?? stateTitle(i.state);
  const queued = items.filter((i) => !isDone(i) && !waiting.has(i.id)).sort((a, b) => Number(b.id === current) - Number(a.id === current) || recent(a, b));
  const done = items.filter(isDone).sort(recent);
  // The current work item another waits for: where it came from, and its steps so far.
  const me = items.find((i) => i.id === current);
  const waitingOnMe = items.filter((i) => (i.depends ?? []).some((d) => d.id === current && !d.done));
  if (me !== undefined && waitingOnMe.length > 0) {
    rows.push({ kind: "section", key: "jumped", text: `${me.flow ?? ""} · ${nameOf(me)}` });
    rows.push({ kind: "steps", key: "steps", steps: stepsOf(board, me.state) });
    for (const w of waitingOnMe) rows.push(text(t("{0} 从{1}「{2}」跳进来，做完回去。", me.since !== undefined ? hhmm(me.since) : "", w.flow ?? "", nameOf(w)).trim(), columns, "dim"));
  }
  // The queue, by flow when more than one is in play: the current work item's flow first.
  const flowsInPlay = [...new Set(queued.map((i) => i.flow ?? ""))];
  const byFlow = flowsInPlay.length > 1
    ? [me?.flow ?? "", ...flowsInPlay.filter((f) => f !== (me?.flow ?? ""))].filter((f, n, all) => all.indexOf(f) === n && queued.some((i) => (i.flow ?? "") === f))
    : [""];
  for (const f of byFlow) {
    const group = flowsInPlay.length > 1 ? queued.filter((i) => (i.flow ?? "") === f) : queued;
    rows.push({ kind: "section", key: `queued-${f}`, text: flowsInPlay.length > 1 && f !== "" ? t("排着 · {0}", f) : t("排着") });
    if (group.length === 0) rows.push(text(`  ${t("没有")}`, columns, "dim"));
    for (const i of group) {
      const here = i.id === current;
      const waits = (i.depends ?? []).filter((d) => !d.done).map((d) => d.title ?? d.id);
      const tag = [i.by === "model" ? t("我的") : i.by === "gemflow" ? t("gemflow 记的") : "", here ? t("在做") : "", stageOf(i), i.paused ? t("已暂停") : "", waits.length > 0 ? t("⏳ 等「{0}」完成", waits.join("」「")) : "", here ? made ?? "" : ""].filter((x) => x !== "").join(" · ");
      rows.push({ kind: "entry", key: `item-${i.id}`, title: nameOf(i), tag, tone: i.paused ? "warning" : "normal", ...(!here && i.file !== undefined ? { action: { op: "switch-file", file: i.file } } : {}) });
    }
  }
  rows.push({
    kind: "section", key: "done", text: t("做完了"), count: done.length,
    ...(done.length > 0 ? { fold: { key: "fold-done", label: o.doneOpen ? t("收起") : t("展开"), action: { op: "fold", what: "done", open: !o.doneOpen } } } : {}),
  });
  if (o.doneOpen) for (const i of done) rows.push({ kind: "entry", key: `item-${i.id}`, title: nameOf(i), tag: o.now !== undefined ? agoText(i.at, o.now, t) : stateTitle(i.state), tone: "dim" });
  const backlog = board.backlog;
  if (backlog !== null) {
    const loose = backlog.items.filter((i) => i.target === "");
    const stateOf = new Map(items.map((i) => [i.id, `#${i.state}`]));
    rows.push({ kind: "section", key: "backlog", text: t("待办与进行中") });
    const boundHere = current !== undefined && backlog.items.some((i) => i.target === current);
    for (const i of backlog.items) {
      if (i.target !== "") {
        const state = stateOf.get(i.target);
        rows.push(text(`  ${i.id}  ${i.title} → ${i.target}${state !== undefined ? ` · ${state}` : ""}`, columns, i.target === current ? "success" : "normal"));
      }
    }
    if (loose.length > 0) {
      rows.push(text(t("backlog 还没绑到工作项的 {0} 项", loose.length), columns, "dim"));
      for (const i of loose) {
        rows.push(current !== undefined && !boundHere
          ? button(`bind-${i.id}`, t("绑定 {0}（{1}）到 {2}", i.id, i.title, current), columns, { op: "bind", id: i.id })
          : text(`  ${i.id}  ${i.title}${t("（待办）")}`, columns, "dim"));
      }
    }
  }
  return rows;
}

// ---- tools ----------------------------------------------------------------------

/** The row that takes a key: of exactly that key, else the one whose pattern (`*` any text) matches it whole, the longest literal first. */
export function rowFor(key: string, rows: readonly DictRow[]): DictRow | undefined {
  return bindingOf({ rows: [...rows], diagnostics: [] }, key);
}

/** The uses a tool may be classified as: the flow's, and the dictionary's own. */
function knownUses(board: BoardData): string[] {
  return [...new Set([...board.fences.map((f) => f.use), ...board.tools.flatMap((r) => (r.for !== undefined ? [r.for] : []))])];
}

/**
 * A suggestion to note CI that failed on the branch's head as a matter, when
 * a flow beside takes matters (a file unit `<dir>/*.geml`): one per head, not
 * once it is noted or put away.
 */
export function ciSuggestions(board: BoardData, units: readonly string[], dismissed: readonly string[], t: T = ZH): InboxItem[] {
  const ci = board.ci;
  const dir = units.map((g) => g.match(/^(.+)\/\*\.geml$/)?.[1]).find((d): d is string => d !== undefined);
  if (ci === undefined || dir === undefined) return [];
  const short = ci.head.slice(0, 8);
  const key = `ci-${short}`;
  const path = `${dir}/${key}.geml`;
  if (dismissed.includes(key) || board.items.some((i) => i.file === path)) return [];
  const title = t("CI 挂了：{0}", ci.failed.join("、"));
  return [{
    kind: "suggest", key: `suggest-${key}`, verb: t("定"), title, tag: t("建议 · {0}", t("事项")),
    detail: [t("在 {0} 上；记成一件事项，修好再验收。", short)],
    actions: [
      { key: `note-${key}`, label: t("记成事项"), primary: true, action: { op: "new-item", path, title, text: `# 现象 {#symptom}\n\n${ci.failed.join("、")} ${t("在 {0} 上失败。", short)}`, dismiss: key } },
      { key: `dismiss-${key}`, label: t("不用"), action: { op: "dismiss", key } },
    ],
  }];
}

/** How many runs make a guess worth asking about. */
const SUGGEST_AFTER = 3;

/**
 * The suggestions about the tools (the work items tab's 待处理, with the
 * tools tab's own): a command that ran these two days with no row to take it,
 * looking like the flow's test or check use — counting it as that is the
 * person's to say; one put away is not asked again.
 */
export function toolSuggestions(board: BoardData, usage: Readonly<Record<string, number>>, dismissed: readonly string[], t: T = ZH): InboxItem[] {
  const uses = knownUses(board);
  return Object.entries(usage).flatMap(([key, n]): InboxItem[] => {
    if (n < SUGGEST_AFTER || dismissed.includes(key) || rowFor(key, board.tools) !== undefined) return [];
    const use = guessUse(key, uses);
    if (use === undefined) return [];
    const name = keyWords(key);
    return [{
      kind: "suggest", key: `suggest-${key}`, verb: t("定"), title: t("{0} 算作{1}", name, useWords(use, t)), tag: t("建议 · {0}", t("工具")),
      detail: [t("这两天跑了 {0} 次，一次都没记成{1}。", n, useWords(use, t))],
      actions: [
        { key: `count-${key}`, label: t("算"), primary: true, action: { op: "learn", lessons: [{ kind: "use", key, use }] } },
        { key: `dismiss-${key}`, label: t("不算"), action: { op: "dismiss", key } },
      ],
    }];
  }).sort((a, b) => a.key.localeCompare(b.key));
}

/** The most run tools a group lists before it folds the rest. */
const TOOLS_SHOWN = 8;

const GROUPS: readonly { id: ToolGroup; label: string }[] = [
  { id: "cli", label: "命令行" }, { id: "file", label: "文件" }, { id: "mcp", label: "MCP" }, { id: "skill", label: "Skill" }, { id: "web", label: "网页请求" }, { id: "model", label: "模型服务" }, { id: "other", label: "其他" },
];

export interface ToolsInput {
  board: BoardData;
  columns: number;
  t: T;
  usage: Readonly<Record<string, number>>;
  suggestions: readonly InboxItem[];
  query: string;
  menu: string | null;
  naming: string | null;
  open: readonly string[];
}

/**
 * The tools tab: a search, the suggestions about the tools, then every tool
 * the dictionary names or that ran these two days, by kind — command line,
 * files, MCP, skills, web requests, model services — each with its use (or
 * none, and the use it looks like), how often it ran, the ones that ran
 * first; the ones that did not, folded. A press opens a row's menu: classify
 * it as a use (a new one by name), make it its use's preferred tool, or take
 * its row out of the dictionary.
 */
export function toolRows(o: ToolsInput): BoardRow[] {
  const { board, t, columns } = o;
  const rows: BoardRow[] = [{ kind: "input", key: "tool-search", placeholder: t("找工具"), field: "tool-search", value: o.query }];
  for (const i of o.suggestions) rows.push({ kind: "card", key: `tools-${i.key}`, icon: "ask", verb: i.verb, title: i.title, ...(i.tag !== undefined ? { tag: i.tag } : {}), detail: i.detail, actions: i.actions });
  const uses = knownUses(board);
  // Every key: the dictionary's rows, and what ran without a row of its own to take it.
  const counts = new Map<string, number>(board.tools.map((r) => [r.tool, 0]));
  for (const [key, n] of Object.entries(o.usage)) {
    const row = rowFor(key, board.tools);
    const at = row?.tool ?? key;
    counts.set(at, (counts.get(at) ?? 0) + n);
  }
  const query = o.query.trim().toLowerCase();
  const quiet: string[] = [];
  for (const g of GROUPS) {
    const keys = [...counts.keys()].filter((k) => groupOf(k) === g.id).filter((k) => {
      if (query === "") return true;
      const row = board.tools.find((r) => r.tool === k);
      return [k, keyWords(k), row?.for !== undefined ? useWords(row.for, t) : ""].some((s) => s.toLowerCase().includes(query));
    });
    if (keys.length === 0) { if (query === "" && (g.id === "skill" || g.id === "web" || g.id === "model")) quiet.push(t(g.label)); continue; }
    const row = (k: string): DictRow | undefined => board.tools.find((r) => r.tool === k);
    const byRuns = keys.filter((k) => (counts.get(k) ?? 0) > 0).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
    const open = o.open.includes(g.id) || query !== "";
    // The most run first: every classified one, and a handful of the others; the rest of them fold with the ones that did not run.
    const loose = byRuns.filter((k) => row(k)?.for === undefined).slice(0, TOOLS_SHOWN);
    const ran = open ? byRuns : byRuns.filter((k) => row(k)?.for !== undefined || loose.includes(k));
    const preferred = keys.filter((k) => (counts.get(k) ?? 0) === 0 && row(k)?.default === true);
    const idle = [...byRuns.slice(ran.length), ...keys.filter((k) => (counts.get(k) ?? 0) === 0 && row(k)?.default !== true)];
    if (ran.length === 0 && preferred.length === 0 && !open) { if (g.id === "skill" || g.id === "web" || g.id === "model") { quiet.push(t(g.label)); continue; } }
    rows.push({ kind: "section", key: `group-${g.id}`, text: t(g.label) });
    for (const k of [...ran, ...preferred, ...(open ? idle : [])]) {
      const r = row(k);
      const own = k.startsWith("mcp__gemflow__");
      const n = counts.get(k) ?? 0;
      const guess = r === undefined ? guessUse(k, uses) : undefined;
      const menuOpen = o.menu === k;
      rows.push({
        kind: "tool", key: `tool-${k}`, name: keyWords(k),
        use: own ? t("gemflow 自己的") : r?.for !== undefined ? `${useWords(r.for, t)}${r.default ? t("（首选）") : ""}` : r !== undefined && r.allow.includes("*") ? t("哪里都能用") : t("没归类"),
        guess: guess !== undefined ? t("像{0}？", useWords(guess, t)) : "", count: n > 0 ? t("{0} 次", n) : "0", tone: n > 0 ? "normal" : "dim",
        ...(own ? {} : { action: { op: "tool-menu", key: menuOpen ? null : k } }),
      });
      if (menuOpen) {
        rows.push(text(`  ${t("归类为")}`, columns, "dim"));
        rows.push(buttons([
          ...uses.map((u): Pressable => ({ key: `classify-${k}-${u}`, label: useWords(u, t), ...(r?.for === u ? { primary: true } : {}), action: { op: "learn", lessons: [{ kind: "use", key: k, use: u }] } })),
          { key: `name-${k}`, label: t("新用途…"), action: { op: "tool-name", key: o.naming === k ? null : k } },
        ]));
        if (o.naming === k) rows.push({ kind: "input", key: `new-use-${k}`, placeholder: t("{0} 的新用途", keyWords(k)), field: "new-use", target: k });
        rows.push(buttons([
          ...(r?.for !== undefined && !r.default ? [{ key: `prefer-${k}`, label: t("设为同类首选"), action: { op: "learn", lessons: [{ kind: "default", key: k, use: r.for }] } } as Pressable] : []),
          ...(r !== undefined ? [{ key: `forget-${k}`, label: t("删掉这一行"), action: { op: "learn", lessons: [{ kind: "forget", key: k }] } } as Pressable] : []),
          { key: `close-${k}`, label: t("取消"), action: { op: "tool-menu", key: null } },
        ]));
      }
    }
    if (!open && idle.length > 0) {
      const names = idle.slice(0, 5).map((k) => keyWords(k)).join(" / ");
      const label = idle.some((k) => (counts.get(k) ?? 0) > 0) ? t("另有 {0} 等 {1} 条 ▸", names, idle.length) : t("另有 {0} 等 {1} 条没用过 ▸", names, idle.length);
      rows.push({ kind: "button", key: `unfold-${g.id}`, label, action: { op: "tool-fold", group: g.id, open: true } });
    } else if (o.open.includes(g.id) && (idle.length > 0 || byRuns.length > TOOLS_SHOWN)) {
      rows.push({ kind: "button", key: `fold-${g.id}`, label: t("收起 ▴"), action: { op: "tool-fold", group: g.id, open: false } });
    }
  }
  if (quiet.length > 0) rows.push({ kind: "section", key: "group-quiet", text: quiet.join(" · ") }, text(t("这两天都没用过"), columns, "dim"));
  if (query !== "" && rows.length === 1 + o.suggestions.length) rows.push(text(t("没有对得上的工具"), columns, "dim"));
  rows.push(text(t("次数是这两天真实用过的。没归类的工具在每个阶段都照常能用；点一行可以给它归类。"), columns, "dim"));
  return rows;
}

// ---- journal --------------------------------------------------------------------

/** The lines under an entry whose evidence shows: on what, which call, on which content, whether it still counts. */
export function entryDetail(e: TimelineEntry, board: BoardData, t: T = ZH): string[] {
  if (e.kind === "refused") return [e.reason, ...(e.call !== undefined ? [t("哪次调用：{0}", e.call)] : [])];
  const out: string[] = [];
  const changed = e.changed ?? {};
  if (Object.keys(changed).length > 0) out.push(t("凭什么：{0}", Object.entries(changed).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")));
  if (e.call !== undefined) out.push(t("哪次调用：{0}", e.call));
  if (e.tree !== undefined) out.push(t("在哪份内容上：{0}", e.tree.length > 24 ? `${e.tree.slice(0, 24)}…` : e.tree), board.tree === undefined ? "" : board.tree === e.tree ? t("之后没改过，还算数") : t("内容变了，过期"));
  return out.filter((x) => x !== "");
}

const rowKey = (e: TimelineEntry): string => (e.kind === "refused" ? `refused-${e.n}` : `rev-${e.rev}`);

/** Where a variable's value came from, in words: a use's result, git or gh, a file, the person, the clock. */
export function sourceWords(source: string | undefined, t: T = ZH): string {
  if (source === undefined) return t("模型写的");
  if (source === "human") return t("你勾的");
  const [kind, what = ""] = source.split(/:(.*)/s);
  switch (kind) {
    case "tool": return t("跑 {0} 得来", what);
    case "git": return what === "committed" || what === "pushed" ? t("git 查到的") : t("gh 查到的");
    case "file": return t("文件 {0} 有了", what);
    case "elapsed": return t("时间到了");
    default: return source;
  }
}

/** A variable's value in words: a person's tick as ticked or not, a boolean as ✓ or ✗, anything else as its value. */
function valueWords(name: string, value: unknown, sources: Readonly<Record<string, string>>, t: T): string {
  if (sources[name] === "human" && typeof value === "boolean") return value ? t("{0} 被勾上", name) : t("{0} 被取消", name);
  if (typeof value === "boolean") return `${name} ${value ? "✓" : "✗"}`;
  return `${name}=${JSON.stringify(value ?? null)}`;
}

/** What a journal entry says: its kind, what happened, and why — in the flow's words. */
export function entryWords(e: TimelineEntry, board: BoardData, sources: Readonly<Record<string, string>>, t: T = ZH): { label: string; text: string; why: string; tone: Tone } {
  const title = (id: string | undefined): string => (id === undefined ? "" : board.states.find((s) => s.id === id)?.title ?? id);
  if (e.kind === "refused") return { label: t("被拦"), text: e.key ?? e.tool, why: shortReason(e.reason), tone: "error" };
  const changed = e.changed ?? {};
  const names = Object.keys(changed);
  switch (e.cause) {
    case "enter": return { label: t("开始"), text: t("进入{0}", title(e.state)), why: "", tone: "normal" };
    case "transition": {
      const x = board.transitions.find((tr) => tr.from === e.from && tr.to === e.state);
      const who = e.by === "signal" ? t("自动") : e.by === "human" ? t("你") : x?.judge === "model" && x.guard !== undefined ? t("模型判「{0}」", x.guard) : t("模型");
      const why = e.signal !== undefined ? t("凭：{0}", valueWords(e.signal, changed[e.signal] ?? true, sources, t)) : "";
      return { label: t("阶段变更"), text: `${title(e.from)} → ${title(e.state)} · ${who}`, why, tone: "normal" };
    }
    case "rollback": return { label: t("阶段变更"), text: `${t("回到{0}", title(e.state))} · ${t("你")}`, why: e.restores !== undefined ? t("恢复第 {0} 条修订", e.restores) : "", tone: "normal" };
    case "pause": return { label: t("阶段变更"), text: t("你暂停了"), why: "", tone: "warning" };
    case "resume": return { label: t("阶段变更"), text: t("你继续了"), why: "", tone: "normal" };
    case "patch": {
      const what = names.map((n) => valueWords(n, changed[n], sources, t)).join("、");
      if (e.by === "signal" && e.signal !== undefined) return { label: t("凭据"), text: valueWords(e.signal, changed[e.signal], sources, t), why: sourceWords(sources[e.signal], t), tone: "normal" };
      return { label: t("凭据"), text: what, why: e.by === "human" ? t("你勾的") : t("模型写的"), tone: "normal" };
    }
    case "expire": return { label: t("凭据"), text: t("{0} 过期了", names.join("、")), why: t("内容变了"), tone: "dim" };
    default: return { label: e.cause, text: title(e.state), why: "", tone: "normal" };
  }
}

const KIND_OF: Readonly<Record<string, JournalFilter>> = { enter: "moves", transition: "moves", rollback: "moves", pause: "moves", resume: "moves", patch: "evidence", expire: "evidence" };

export interface JournalInput {
  board: BoardData;
  status: Status | null;
  filter: JournalFilter;
  /** The entry whose menu is open, and the one whose evidence shows. */
  menu: string | null;
  evidence: string | null;
  prompts: readonly PromptRecord[];
  columns: number;
  maxRows: number;
  t: T;
  now?: string;
}

/**
 * The journal tab: the filters (all, products, evidence, stage changes,
 * blocks) and the export; the work item and its flow; then what happened,
 * newest first under its day — each commit of the work (a product, grouped by
 * the turn that made it), each revision and each refusal — saying what, why,
 * and which turn caused it. A press opens an entry's menu: go to its turn, see
 * its evidence, go back to before it.
 */
export function journalRows(o: JournalInput): BoardRow[] {
  const { board, t, columns } = o;
  const rows: BoardRow[] = [];
  const filters: { id: JournalFilter; label: string }[] = [
    { id: "all", label: t("全部") }, { id: "products", label: t("产物") }, { id: "evidence", label: t("凭据") }, { id: "moves", label: t("阶段变更") }, { id: "refusals", label: t("被拦") },
    // Dependencies appear once the work item has any.
    ...((o.status?.depends ?? []).length > 0 ? [{ id: "depends" as const, label: t("依赖") }] : []),
  ];
  rows.push(buttons([
    ...filters.map((f): Pressable => ({ key: `filter-${f.id}`, label: f.label, ...(f.id === o.filter ? { primary: true } : {}), action: { op: "filter", filter: f.id } })),
    { key: "export-journal", label: t("导出"), action: { op: "export", kind: "journal", format: "geml" } },
  ]));
  const s = o.status;
  if (s !== null && s.item.kind === "item") rows.push(text(`${s.title ?? s.item.id} · ${s.workflow.title}`, columns, "dim"));
  // The turn something happened in: the last prompt sent before it.
  const turnOf = (at: string): PromptRecord | undefined => [...o.prompts].reverse().find((p) => Date.parse(p.at) <= Date.parse(at));
  const turnWords = (p: PromptRecord | undefined): string => (p === undefined ? "" : t("那一轮 {0}「{1}」", hhmm(p.at), promptLine(p.text, 14)));
  type Line = { at: string; row: Omit<Extract<BoardRow, { kind: "event" }>, "at" | "open" | "action" | "detail">; detail: string[]; rev?: number; turn?: PromptRecord };
  const lines: Line[] = [];
  const wanted = (kind: JournalFilter): boolean => o.filter === "all" || o.filter === kind;
  if (wanted("products") && board.products !== undefined) {
    // A turn's commits are one product; without the session's prompts, each commit is.
    const groups = new Map<string, { turn?: PromptRecord; commits: Products["commits"] }>();
    for (const c of [...board.products.commits].filter((c) => c.ours).reverse()) {
      const turn = turnOf(c.at);
      const id = turn?.id ?? c.sha;
      const g = groups.get(id) ?? { ...(turn !== undefined ? { turn } : {}), commits: [] };
      g.commits.push(c);
      groups.set(id, g);
    }
    for (const g of groups.values()) {
      const last = g.commits[g.commits.length - 1] as Products["commits"][number];
      const files = [...new Set(g.commits.flatMap((c) => c.files))];
      lines.push({
        at: last.at, ...(g.turn !== undefined ? { turn: g.turn } : {}),
        row: { kind: "event", key: `product-${last.sha.slice(0, 12)}`, glyph: "product", label: t("产物"), text: `${g.commits.map((c) => c.sha.slice(0, 8)).join(" ")} ${last.subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")}`, why: files.length > 0 ? t("{0} 个文件", files.length) : "", turn: turnWords(g.turn), tone: "normal" },
        detail: files.slice(0, 12),
      });
    }
  }
  // What it waits for: put aside when the other began, the other done (and what it brought back), taken up again after.
  if (wanted("depends") && s !== null && s.item.kind === "item") {
    const name = s.title ?? s.item.id;
    for (const d of s.depends ?? []) {
      const other = d.title ?? d.id;
      if (d.since !== undefined) {
        const turn = turnOf(d.since);
        lines.push({ at: d.since, ...(turn !== undefined ? { turn } : {}), row: { kind: "event", key: `waits-${d.id}`, glyph: "waits", label: t("挂起"), text: t("{0}，等「{1}」", name, other), why: d.flow !== undefined ? t("另开{0}，工作项 {1}", d.flow, other) : "", turn: turnWords(turn), tone: "normal" }, detail: [] });
      }
      if (d.done && d.at !== undefined) {
        const names = d.wrote.slice(0, 6).map((p) => p.replace(/^.*\//, ""));
        lines.push({ at: d.at, row: { kind: "event", key: `done-${d.id}`, glyph: "done", label: t("依赖完成"), text: `${d.flow !== undefined ? `${d.flow}` : ""}「${other}」${t("完成")}`, why: names.length > 0 ? t("带回来：{0}", names.join(" · ")) : "", turn: "", tone: "success" }, detail: d.wrote });
        const back = board.timeline.find((e) => e.kind === "snapshot" && Date.parse(e.at) > Date.parse(d.at as string));
        if (back !== undefined) {
          const turn = turnOf(back.at);
          lines.push({ at: back.at, ...(turn !== undefined ? { turn } : {}), row: { kind: "event", key: `back-${d.id}`, glyph: "move", label: t("恢复"), text: name, why: "", turn: turnWords(turn), tone: "normal" }, detail: [] });
        }
      }
    }
  }
  for (const e of board.timeline) {
    if (!wanted(e.kind === "refused" ? "refusals" : KIND_OF[e.cause] ?? "moves")) continue;
    const words = entryWords(e, board, s?.sources ?? {}, t);
    const turn = e.kind === "snapshot" && (e.by === "signal" || e.cause === "enter") && e.call === undefined ? undefined : turnOf(e.at);
    lines.push({
      at: e.at, ...(e.kind === "snapshot" ? { rev: e.rev } : {}), ...(turn !== undefined ? { turn } : {}),
      row: { kind: "event", key: rowKey(e), glyph: entryGlyph(e), ...words, turn: turnWords(turn) }, detail: entryDetail(e, board, t),
    });
  }
  if (lines.length === 0) return [...rows, text(board.timeline.length === 0 ? t("这个工作项还没有记录") : t("没有这一类的记录"), columns, "dim")];
  lines.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let day = "";
  let room = Math.max(1, o.maxRows - rows.length);
  for (const l of lines) {
    const heading = o.now !== undefined ? dayText(l.at, o.now, t) : "";
    // A day's heading comes with its first entry, or not at all.
    if (room < (heading !== day ? 2 : 1)) break;
    if (heading !== day) { rows.push({ kind: "section", key: `day-${l.row.key}`, text: heading }); day = heading; room--; }
    const open = o.menu === l.row.key;
    const shown = o.evidence === l.row.key;
    rows.push({ ...l.row, at: hhmm(l.at), detail: l.detail, open: shown, action: { op: "expand", entry: open ? null : l.row.key } });
    room--;
    if (open) {
      const menu: Pressable[] = [];
      if (l.turn !== undefined) menu.push({ key: `turn-${l.row.key}`, label: t("看是哪一轮"), action: { op: "locate", id: l.turn.id } });
      if (l.detail.length > 0) menu.push({ key: `evidence-${l.row.key}`, label: shown ? t("收起凭据") : t("看凭据"), action: { op: "evidence", entry: shown ? null : l.row.key } });
      if (l.rev !== undefined && l.rev > 0) menu.push({ key: `rollback-${l.row.key}`, label: t("回到这一步之前"), action: { op: "rollback", rev: l.rev - 1 } });
      menu.push({ key: `close-${l.row.key}`, label: t("取消"), action: { op: "expand", entry: null } });
      rows.push(buttons(menu));
      room--;
    }
  }
  const others = board.products !== undefined && wanted("products") ? board.products.commits.filter((c) => !c.ours).length : 0;
  if (others > 0) rows.push(text(t("同期另有 {0} 个提交没碰这些文件", others), columns, "dim"));
  return rows;
}

// ---- sessions -------------------------------------------------------------------

/**
 * The sessions tab: every prompt of the session, newest first under its day,
 * with what its turn did — the commits made while it ran, and the first
 * sentence of its answer (while it runs, what it has done so far). A press
 * opens the row's menu under it: scroll to the prompt, move it and what
 * follows into a new session, take its turn out, or close the menu. Then the
 * session's export.
 */
/** How many turns in a row in another flow fold into one line. */
const RUN_FOLDS = 3;

export function sessionRows(prompts: readonly PromptRecord[], menu: string | null, commits: readonly { sha: string; at: string }[], t: T = ZH, columns: number, now?: string, by: { flow: string | null; runs: readonly string[]; current?: string } = { flow: null, runs: [] }): BoardRow[] {
  if (prompts.length === 0) return [text(t("还没有 prompt"), columns, "dim")];
  const rows: BoardRow[] = [];
  // With turns in more than one flow: a filter by flow.
  const flows = [...new Set(prompts.flatMap((p) => (p.flow !== undefined ? [p.flow] : [])))];
  if (flows.length > 1) {
    rows.push(buttons([
      { key: "flow-all", label: t("全部"), ...(by.flow === null ? { primary: true } : {}), action: { op: "session-flow", flow: null } },
      ...flows.map((f): Pressable => ({ key: `flow-${f}`, label: f, ...(by.flow === f ? { primary: true } : {}), action: { op: "session-flow", flow: f } })),
    ]));
  }
  const shown = by.flow === null ? prompts : prompts.filter((p) => p.flow === by.flow);
  let day = "";
  for (let i = shown.length - 1; i >= 0; i--) {
    const p = shown[i] as PromptRecord;
    const heading = now !== undefined ? dayText(p.at, now, t) : "";
    if (heading !== day) { rows.push({ kind: "section", key: `day-${p.id}`, text: heading }); day = heading; }
    // A run of turns in a flow other than the current one folds into one line, unfolded on a press.
    if (by.flow === null && by.current !== undefined && p.flow !== undefined && p.flow !== by.current) {
      let j = i;
      while (j > 0 && (shown[j - 1] as PromptRecord).flow === p.flow) j--;
      const run = shown.slice(j, i + 1);
      const key = (run[0] as PromptRecord).id;
      if (run.length >= RUN_FOLDS) {
        const open = by.runs.includes(key);
        const first = run[0] as PromptRecord;
        rows.push({
          kind: "turn", key: `run-${key}`, at: `${hhmm(first.at)}–${hhmm(p.at)}`,
          text: t("{0} · {1} · {2} 条提示词", p.flow, p.itemTitle ?? p.item ?? "", run.length), did: "", open,
          action: { op: "session-run", id: key, open: !open },
        });
        if (open) for (let k = run.length - 1; k >= 0; k--) rows.push(...turnRows(run[k] as PromptRecord, shown[j + k + 1]?.at, commits, menu, t, columns));
        i = j;
        continue;
      }
    }
    rows.push(...turnRows(p, shown[i + 1]?.at ?? prompts[prompts.indexOf(p) + 1]?.at, commits, menu, t, columns));
  }
  rows.push({ kind: "section", key: "export", text: t("导出本会话") });
  rows.push(buttons([
    { key: "export-session-geml", label: t("GEML（带 journal）"), action: { op: "export", kind: "session", format: "geml" } },
    { key: "export-session-md", label: "Markdown", action: { op: "export", kind: "session", format: "md" } },
    { key: "export-session-json", label: "JSON", action: { op: "export", kind: "session", format: "json" } },
  ]));
  return rows;
}

/** One prompt's line, what its turn did (the commits made while it ran, its answer's first sentence), and its menu when open. */
function turnRows(p: PromptRecord, until: string | undefined, commits: readonly { sha: string; at: string }[], menu: string | null, t: T, columns: number): BoardRow[] {
  const made = commits.filter((c) => Date.parse(c.at) >= Date.parse(p.at) && (until === undefined || Date.parse(c.at) < Date.parse(until))).map((c) => c.sha.slice(0, 8)).reverse();
  const did = [...made, p.did ?? (promptTail(p, t) || (until === undefined ? t("进行中…") : ""))].filter((x) => x !== "").join(" ");
  const open = menu === p.id;
  const rows: BoardRow[] = [{ kind: "turn", key: `prompt-${p.id}`, at: hhmm(p.at), text: promptLine(p.text, Math.max(12, columns - 8)), did, open, action: { op: "turn-menu", id: open ? null : p.id } }];
  if (open) rows.push(buttons([
    { key: `locate-${p.id}`, label: t("跳转"), action: { op: "locate", id: p.id } },
    { key: `split-${p.id}`, label: t("拆成新会话"), action: { op: "split", id: p.id } },
    { key: `remove-${p.id}`, label: t("删除本轮会话"), action: { op: "remove", id: p.id } },
    { key: `close-${p.id}`, label: t("取消"), action: { op: "turn-menu", id: null } },
  ]));
  return rows;
}
