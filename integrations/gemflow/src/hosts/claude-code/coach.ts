// The coach: the light flows a work item goes through — 新设计, 新功能, bugfix,
// 优化 — each its own statechart; the work items the model reports with the
// work tool at a turn's end, merged from every session's log; and what the
// board and the band draw of them: a row per work item on the work items tab,
// a picture per flow with items on it on the flow tab, a line for the band.
// A flow file is a `geml-statechart/v1` document; its diagram block's JSON is
// read here as it stands (the bridge's loader checks it). Pure.
import type { ItemStatus, SessionEvent, SessionSummary } from "../../core/session-log.js";
import type { BoardRow } from "./board.js";
import type { T } from "./text.js";

/** The light flows, by file name: the bundled `coach/<name>.geml`, or the project's own `.geml/coach/<name>.geml`. */
export const COACH_FLOWS = ["design", "feature", "bugfix", "optimize"] as const;

/** A state: its words, and what it needs to be left (its `description`). */
export interface CoachState { id: string; title: string; need: string; final: boolean }
/** A way between states; `back` when it does not go on to the next state in order (a way back, drawn dashed). */
export interface CoachEdge { from: string; to: string; label: string; back: boolean }
export interface CoachFlow { name: string; title: string; states: CoachState[]; edges: CoachEdge[] }

export type ItemEvent = Extract<SessionEvent, { t: "item" }>;

/** A work item as it stands: the newest event of its id, from whichever session reported it. */
export interface WorkItem { id: string; flow: string; title: string; state: string; needs: string; goal: string; status: ItemStatus; at: string; session: string }

/** Where the board looks when a work item's arrow is pressed: its flow first, the item marked. */
export interface CoachFocus { flow: string; id: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A flow file read: its states in their order, its ways; undefined for a file with no statechart diagram in it. */
export function readCoachFlow(name: string, text: string): CoachFlow | undefined {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((l) => /^===\s*diagram\b/.test(l.trim()) && l.includes("format=geml-statechart"));
  if (open < 0) return undefined;
  const close = lines.findIndex((l, i) => i > open && l.trim() === "===");
  let v: unknown;
  try { v = JSON.parse(lines.slice(open + 1, close < 0 ? undefined : close).join("\n")); } catch { return undefined; }
  if (!isObject(v) || !isObject(v["states"])) return undefined;
  const states: CoachState[] = Object.entries(v["states"]).flatMap(([id, s]) => (isObject(s)
    ? [{ id, title: str(s["title"]) || id, need: str(s["description"]), final: s["final"] === true }]
    : []));
  if (states.length === 0) return undefined;
  const at = (id: string): number => states.findIndex((s) => s.id === id);
  const edges: CoachEdge[] = (Array.isArray(v["transitions"]) ? v["transitions"] : []).flatMap((x) => {
    if (!isObject(x) || at(str(x["from"])) < 0 || at(str(x["to"])) < 0) return [];
    const from = str(x["from"]);
    const to = str(x["to"]);
    return [{ from, to, label: str(x["label"]) || str(x["guard"]), back: at(to) !== at(from) + 1 }];
  });
  const title = text.match(/^title\s*=\s*"([^"]*)"/m)?.[1] ?? lines[open]?.match(/caption="([^"]*)"/)?.[1] ?? name;
  return { name, title, states, edges };
}

/** The work items the sessions reported, the newest event of each id, newest first. */
export function workItemsOf(sessions: readonly SessionSummary[]): WorkItem[] {
  const by = new Map<string, WorkItem>();
  for (const s of sessions) {
    for (const e of s.items ?? []) {
      const was = by.get(e.id);
      if (was !== undefined && was.at >= e.at) continue;
      by.set(e.id, { id: e.id, flow: e.flow, title: e.title, state: e.state, needs: e.needs, goal: e.goal, status: e.status, at: e.at, session: s.id });
    }
  }
  return [...by.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The tool the model reports a turn's work items with. */
export const WORK_TOOL = {
  name: "work",
  description: "Report, before the turn ends, the work items this turn was about, so the board shows the person where each stands: each a thing the person wants done (a new design, a new feature, a bugfix, an optimization), the flow that fits it, the state it stands in now (a light flow may skip states), what it still needs to leave that state, and what it should be at the end. Update an item on the way by its id (listed beside the person's prompt); report a new one without an id. One turn may be about several items; a turn about none reports nothing.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "An item already on the way, by its id; leave it out for a new one." },
            title: { type: "string", description: "What the item is, in a few words of the person's language." },
            flow: { type: "string", enum: [...COACH_FLOWS], description: "design 新设计, feature 新功能, bugfix, optimize 优化." },
            state: { type: "string", description: "The state it stands in now, by the id the flow lists." },
            needs: { type: "string", description: "What it still needs to leave that state: one short phrase, in the person's language." },
            goal: { type: "string", description: "What it should be at the end: one short sentence, in the person's language." },
            status: { type: "string", enum: ["open", "done", "dropped"], description: "done once the person said it is; dropped when given up. Default open." },
          },
          required: ["title", "flow", "state"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
} as const;

/** What the model is told once about the work tool, with the flows' states. */
export function workPrompt(flows: readonly CoachFlow[]): string {
  const listed = flows.map((f) => `${f.name} ${f.title}: ${f.states.map((s) => `${s.id} ${s.title}`).join(" → ")}`).join("; ");
  return `Gemflow: before a turn ends, report the work items it was about with the gemflow \`work\` tool: the flow each belongs to, the state it stands in now, what it still needs, what it should be at the end; update one on the way by its id. The flows: ${listed}.`;
}

/** The line beside a prompt: the work items on the way, by id, so the model updates them rather than reporting them anew. */
export function workContext(items: readonly WorkItem[], flows: readonly CoachFlow[], limit = 8): string[] {
  const open = items.filter((i) => i.status === "open").slice(0, limit);
  if (open.length === 0) return [];
  const where = (i: WorkItem): string => flows.find((f) => f.name === i.flow)?.states.find((s) => s.id === i.state)?.title ?? i.state;
  return [`[gemflow] work items on the way: ${open.map((i) => `#${i.id} «${i.title}» (${i.flow}: ${i.state} ${where(i)}${i.needs !== "" ? `, needs ${i.needs}` : ""})`).join("; ")}`];
}

/**
 * The tool's items checked against the flows and the items on the way: the
 * events to write and what was wrong with the rest. A state may be named by
 * its id or its title; a final state finishes the item; an id must be one on
 * the way. `newId` names a new item.
 */
export function workEvents(args: Record<string, unknown>, flows: readonly CoachFlow[], items: readonly WorkItem[], at: string, turn: number, newId: (n: number) => string): { events: ItemEvent[]; errors: string[] } {
  const given = Array.isArray(args["items"]) ? args["items"] : [];
  const events: ItemEvent[] = [];
  const errors: string[] = [];
  given.forEach((x, n) => {
    if (!isObject(x)) { errors.push(`item ${n + 1} is not an object`); return; }
    const flow = flows.find((f) => f.name === str(x["flow"]));
    if (flow === undefined) { errors.push(`item ${n + 1}: flow must be one of ${flows.map((f) => f.name).join(", ")}`); return; }
    const named = str(x["state"]);
    const state = flow.states.find((s) => s.id === named) ?? flow.states.find((s) => s.title === named);
    if (state === undefined) { errors.push(`item ${n + 1}: ${flow.name} has no state "${named}" (${flow.states.map((s) => s.id).join(", ")})`); return; }
    const id = str(x["id"]).replace(/^#/, "");
    const was = id !== "" ? items.find((i) => i.id === id) : undefined;
    if (id !== "" && was === undefined) { errors.push(`item ${n + 1}: no work item #${id} is on the way`); return; }
    const title = str(x["title"]).trim() || was?.title || "";
    if (title === "") { errors.push(`item ${n + 1} has no title`); return; }
    const status = state.final ? "done" : x["status"] === "done" || x["status"] === "dropped" ? x["status"] : "open";
    events.push({
      t: "item", turn, at, id: was?.id ?? newId(n), flow: flow.name, title, state: state.id,
      needs: typeof x["needs"] === "string" ? x["needs"].trim() : was?.needs ?? "", goal: typeof x["goal"] === "string" ? x["goal"].trim() : was?.goal ?? "", status,
    });
  });
  return { events, errors };
}

const stateOf = (flows: readonly CoachFlow[], i: WorkItem): CoachState | undefined => flows.find((f) => f.name === i.flow)?.states.find((s) => s.id === i.state);

/** The work items tab's rows: each item on the way, its flow, where it stands, what it needs, what it ends as, and the arrow to its flow. */
export function workRows(items: readonly WorkItem[], flows: readonly CoachFlow[], t: T): BoardRow[] {
  return items.filter((i) => i.status === "open").map((i): BoardRow => {
    const flow = flows.find((f) => f.name === i.flow);
    const detail = [i.needs !== "" ? t("还差：{0}", i.needs) : "", i.goal !== "" ? t("最后：{0}", i.goal) : ""].filter((x) => x !== "").join(" · ");
    return {
      kind: "work", key: `work-${i.id}`, flow: i.flow, tag: flow?.title ?? i.flow, title: i.title, state: stateOf(flows, i)?.title ?? i.state, detail,
      go: { key: `work-go-${i.id}`, label: t("看流程"), action: { op: "coach-go", flow: i.flow, id: i.id } },
    };
  });
}

/** The items on the way in a flow, by the state they stand in. */
function standing(flow: CoachFlow, items: readonly WorkItem[]): Map<string, WorkItem[]> {
  const here = new Map<string, WorkItem[]>();
  for (const i of items) {
    if (i.status !== "open" || i.flow !== flow.name) continue;
    here.set(i.state, [...(here.get(i.state) ?? []), i]);
  }
  return here;
}

/**
 * The flow tab's rows: each flow with items on the way (the focused one
 * first, else the one moved last), its picture, then under it each state an
 * item stands in — the items and what each still needs, the state's
 * requirement — and the flows with none, in one dim line.
 */
export function coachFlowRows(items: readonly WorkItem[], flows: readonly CoachFlow[], t: T, focus: CoachFocus | null): BoardRow[] {
  const latest = (f: CoachFlow): string => items.filter((i) => i.status === "open" && i.flow === f.name).reduce((m, i) => (i.at > m ? i.at : m), "");
  const busy = flows.filter((f) => latest(f) !== "").sort((a, b) => (focus?.flow === a.name ? -1 : focus?.flow === b.name ? 1 : latest(a) < latest(b) ? 1 : -1));
  const idle = flows.filter((f) => latest(f) === "");
  if (busy.length === 0) return [{ kind: "text", text: t("还没有在路上的工作项"), tone: "dim" }];
  const rows: BoardRow[] = [];
  for (const f of busy) {
    const here = standing(f, items);
    const n = [...here.values()].reduce((k, x) => k + x.length, 0);
    rows.push({ kind: "section", key: `coach-${f.name}`, text: f.title, note: t("{0} 件在走", n) });
    rows.push({ kind: "image", key: `coach-picture-${f.name}`, svg: coachSvg(f, here, t), alt: coachText(f, here) });
    for (const s of f.states) {
      const at = here.get(s.id);
      if (at === undefined) continue;
      for (const i of at) rows.push({ kind: "entry", key: `coach-item-${i.id}`, title: i.title, tag: s.title, tone: "normal", ...(i.needs !== "" ? { detail: t("还差：{0}", i.needs) } : {}), ...(focus?.id === i.id ? { current: true } : {}) });
      if (s.need !== "") rows.push({ kind: "text", text: t("离开要求：{0}", s.need), tone: "dim" });
    }
  }
  if (idle.length > 0) rows.push({ kind: "text", text: t("现在没有事项在走：{0}", idle.map((f) => f.title).join(" · ")), tone: "dim" });
  return rows;
}

/** The band's line for this session's last work item on the way: its flow, its name, what it still needs. */
export function coachBand(items: readonly WorkItem[], flows: readonly CoachFlow[], session: string, t: T): { verb: string; title: string; note: string } | undefined {
  const i = items.find((x) => x.status === "open" && x.session === session);
  if (i === undefined) return undefined;
  const flow = flows.find((f) => f.name === i.flow);
  return { verb: flow?.title ?? i.flow, title: i.title, note: i.needs !== "" ? t("还差：{0}", i.needs) : stateOf(flows, i)?.title ?? i.state };
}

/** A flow in one line, for a surface that draws no pictures: the states in order, those with items bracketed with their count. */
export function coachText(flow: CoachFlow, here: ReadonlyMap<string, readonly WorkItem[]>): string {
  return flow.states.map((s) => { const n = here.get(s.id)?.length ?? 0; return n > 0 ? `[${s.title} ·${n}]` : s.title; }).join(" → ");
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** About how wide a line of text draws at `size`: a wide character a full size, others a little over half. */
function widthOf(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? size : size * 0.58;
  return w;
}

/** `s` cut to fit `room` at `size`, an ellipsis where it was cut. */
function fit(s: string, room: number, size: number): string {
  if (widthOf(s, size) <= room) return s;
  let out = "";
  for (const ch of s) { if (widthOf(`${out}${ch}…`, size) > room) break; out += ch; }
  return `${out}…`;
}

const GRAY = { fill: "#F1EFE8", stroke: "#888780", title: "#444441", sub: "#5F5E5A" };
const HERE = { fill: "#EEEDFE", stroke: "#534AB7", title: "#3C3489", sub: "#534AB7" };
const LINE = "#888780";

/**
 * A flow's picture: its states left to right, each box its title and its
 * requirement, a box an item stands in raised and in the accent with who is
 * there; the ways on to the next state as arrows, every other way dashed
 * underneath with its words. 680 wide; boxes share the width.
 */
export function coachSvg(flow: CoachFlow, here: ReadonlyMap<string, readonly WorkItem[]>, t: T): string {
  const n = flow.states.length;
  const gap = 14;
  const w = Math.floor((664 - (n - 1) * gap) / n);
  const x = (k: number): number => 8 + k * (w + gap);
  const at = (id: string): number => flow.states.findIndex((s) => s.id === id);
  const key = `coach-${flow.name.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const parts: string[] = [];
  flow.states.forEach((s, k) => {
    const who = here.get(s.id) ?? [];
    const c = who.length > 0 ? HERE : GRAY;
    const [top, h] = who.length > 0 ? [10, 60] : [18, 44];
    const cx = x(k) + w / 2;
    const room = w - 10;
    parts.push(`<rect x="${x(k)}" y="${top}" width="${w}" height="${h}" rx="4" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1"/>`);
    const title = `<text x="${cx}" y="${top + (s.need === "" && who.length === 0 ? 26 : 19)}" text-anchor="middle" font-size="14" font-weight="500" fill="${c.title}">${esc(fit(s.title, room, 14))}</text>`;
    parts.push(title);
    if (s.need !== "") parts.push(`<text x="${cx}" y="${top + 36}" text-anchor="middle" font-size="12" fill="${c.sub}">${esc(fit(s.need, room, 12))}</text>`);
    if (who.length > 0) {
      const there = who.length === 1 ? t("在这：{0}", (who[0] as WorkItem).title) : t("在这：{0} 件", who.length);
      parts.push(`<text x="${cx}" y="${top + 52}" text-anchor="middle" font-size="12" fill="${c.sub}">${esc(fit(there, room, 12))}</text>`);
    }
    if (k < n - 1 && flow.edges.some((e) => e.from === s.id && e.to === (flow.states[k + 1] as CoachState).id)) {
      parts.push(`<line x1="${x(k) + w}" y1="40" x2="${x(k + 1) - 2}" y2="40" stroke="${LINE}" marker-end="url(#${key}-a)"/>`);
    }
  });
  const others = flow.edges.filter((e) => e.back);
  others.forEach((e, k) => {
    const from = x(at(e.from)) + w / 2;
    const to = x(at(e.to)) + w / 2;
    const below = 96 + k * 26;
    const fromBottom = (here.get(e.from)?.length ?? 0) > 0 ? 70 : 62;
    const toBottom = (here.get(e.to)?.length ?? 0) > 0 ? 72 : 64;
    parts.push(`<path d="M${from} ${fromBottom} V${below} H${to} V${toBottom}" stroke="${LINE}" fill="none" stroke-dasharray="4 3" marker-end="url(#${key}-a)"/>`);
    const target = flow.states[at(e.to)] as CoachState;
    const words = e.label !== "" ? t("{0}，回到{1}", e.label, target.title) : t("回到{0}", target.title);
    parts.push(`<text x="${(from + to) / 2}" y="${below + 14}" text-anchor="middle" font-size="12" fill="${GRAY.sub}">${esc(words)}</text>`);
  });
  const height = others.length > 0 ? 96 + (others.length - 1) * 26 + 22 : 78;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 680 ${height}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft Yahei',sans-serif" role="img"><defs><marker id="${key}-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${LINE}"/></marker></defs>${parts.join("")}</svg>`;
}

