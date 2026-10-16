// geml-statechart — the picture (profile §2.6), drawn as inline SVG the way
// `geml-chart` draws a chart: no runtime, the same markup in `--to html`, the
// viewer and the playground, and a file a slide can take as it is. A state's
// rank is the longest path from `initial` over the edges that do not close a
// cycle; ranks run left to right (`direction: "right"`, a page or a slide) or
// top to bottom (`"down"`, a narrow pane), the states of one rank side by
// side. An edge to the next rank runs straight; one that skips a rank or goes
// back runs in a lane beyond the ranks; a self-transition loops beside its
// state. On each edge a pill says what the guard reads — the variables of a
// schema guard, the id of a reference, the sentence of a text guard (amber: prose
// the format does not evaluate; who judges it is the program's to say) — and a transition's flags and numbers follow as pills of
// their own (`approval` for a true flag, `key: value` for a number; a string
// is prose, left to the tooltip and the list below). The `current=` state is
// filled and ringed, the initial state has the start dot, a final state a
// double border.
//
// A program that runs the chart overlays what it knows (`overlay`): the state
// it is in now, which guards hold (green) and which do not (grey), how many
// work items stand in each state (a badge), whether the run is on hold, the
// transition last taken (drawn in the accent), and the transitions the host
// lets the viewer take now (the accent with a pointer; a host that inlines the picture
// catches the click on the group's `data-to`). Motion lives in the SVG's own
// <style>, so the exported file animates where SVG animates and is still just
// a picture where it does not: dashes travel along each edge in the arrow's
// direction, the ring breathes; both stop under prefers-reduced-motion.
// Depends on the model alone, so every host bundles it.
import { edgeLabel, guardText, type JsonValue, type StatechartModel, type Transition } from "./statechart.js";

const PAD = 24;
const NODE_H = 64;
const NODE_MIN_W = 120;
const ROW_GAP = 36;
const COL_GAP = 28;
const RANK_GAP_MIN = 88;
const RANK_GAP_DOWN = 76;
const PILL_H = 24;
const PILL_LINE = 14;
const PILL_CHARS = 24;
const PILL_GAP = 6;
const LANE_GAP = 40;
const START = 36;
const LABEL_MAX = 28;

const SANS = `-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,"PingFang SC","Microsoft Yahei",sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");
const r1 = (n: number): string => String(Math.round(n * 10) / 10);
const CJK = /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-￯]/;

/** A label's rendered width at `size` px: a CJK character is a square, a Latin one a little over half; a monospace glyph is 0.62 em. */
export function textWidth(s: string, size: number, mono = false): number {
  let w = 0;
  for (const ch of s) w += CJK.test(ch) ? size : size * (mono ? 0.62 : 0.56);
  return w;
}

const clip = (s: string, max = LABEL_MAX): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A guard label on one line, or two when it is long: broken at a comma or a space, the rest clipped. */
export function wrapLabel(label: string): string[] {
  if (label.length <= PILL_CHARS) return [label];
  const cut = Math.max(label.lastIndexOf(", ", PILL_CHARS), label.lastIndexOf(" ", PILL_CHARS));
  const at = cut > 6 ? cut : PILL_CHARS;
  const first = label.slice(0, at).replace(/,\s*$/, "");
  const rest = label.slice(at).replace(/^[,\s]+/, "");
  return [first, clip(rest, PILL_CHARS)];
}

export type Direction = "right" | "down";

/** What a program that runs the chart knows now, drawn over the picture. */
export interface Overlay {
  /** The state the work is in; wins over the block's `current=`. */
  current?: string;
  /** By transition name: whether its guard holds for the variables as they stand. */
  holds?: Record<string, boolean>;
  /** By state id: how many work items stand there. */
  counts?: Record<string, number>;
  /** The run is on hold, whoever holds it. */
  paused?: boolean;
  /** The transitions last taken, by name. */
  taken?: string[];
  /**
   * The transitions the host lets the viewer take now, by name: drawn in the accent with
   * a pointer, a wide invisible stroke to hit, `data-from` and `data-to` on
   * the group for the host that catches the click.
   */
  pressable?: string[];
}

export interface SvgOptions {
  /** A title drawn inside the picture, so the exported file carries it. */
  title?: string;
  /** Prefixes the marker ids: several pictures on one page must not share them. */
  key?: string;
  direction?: Direction;
  overlay?: Overlay;
}

export interface Pill { lines: string[]; kind: "guard" | "sentence" | "attr"; mono: boolean; w: number; h: number }
export interface LaidNode { id: string; rank: number; x: number; y: number; w: number; h: number }
export type EdgeKind = "forward" | "lane" | "self";
export interface LaidEdge { t: Transition; kind: EdgeKind; d: string; pills: Pill[]; px: number; py: number }
export interface Layout {
  nodes: Map<string, LaidNode>;
  edges: LaidEdge[];
  width: number;
  height: number;
  top: number;
  direction: Direction;
  /** How far everything is moved right so that a pill wider than its column still starts inside the picture. */
  shiftX: number;
}

/** Ranks by longest path from `initial` over the edges that do not close a cycle; a state the start cannot reach is walked from its own first appearance. */
export function ranksOf(model: StatechartModel): Map<string, number> {
  const ids = model.states.map((s) => s.id);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const t of model.transitions) if (t.from !== t.to && out.has(t.from) && out.has(t.to)) out.get(t.from)?.push(t.to);
  const back = new Set<string>();
  const seen = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    seen.set(id, 1);
    for (const to of out.get(id) ?? []) {
      const s = seen.get(to);
      if (s === 1) back.add(`${id}\u0000${to}`);
      else if (s === undefined) visit(to);
    }
    seen.set(id, 2);
  };
  if (out.has(model.initial)) visit(model.initial);
  for (const id of ids) if (!seen.has(id)) visit(id);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const fwd = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, tos] of out) for (const to of tos) if (!back.has(`${from}\u0000${to}`)) { fwd.get(from)?.push(to); indeg.set(to, (indeg.get(to) ?? 0) + 1); }
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const to of fwd.get(id) ?? []) {
      rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(id) ?? 0) + 1));
      const left = (indeg.get(to) ?? 1) - 1;
      indeg.set(to, left);
      if (left === 0) queue.push(to);
    }
  }
  return rank;
}

const show = (v: JsonValue): string => (typeof v === "string" ? v : JSON.stringify(v));

/** The pills an edge carries: the guard first, then the transition's flags and numbers. */
export function pillsOf(t: Transition): Pill[] {
  const pills: Pill[] = [];
  const g = t.guard;
  if (g !== undefined) {
    const label = edgeLabel(t);
    if (label !== "") {
      const sentence = g.kind === "text";
      pills.push({ lines: wrapLabel(label), kind: sentence ? "sentence" : "guard", mono: !sentence, w: 0, h: 0 });
    }
  }
  for (const [k, v] of Object.entries(t.attrs)) {
    const text = v === true ? k : typeof v === "number" ? `${k}: ${String(v)}` : null;
    if (text !== null) pills.push({ lines: [text], kind: "attr", mono: true, w: 0, h: 0 });
    if (pills.length >= 4) break;
  }
  for (const p of pills) {
    p.w = Math.ceil(Math.max(...p.lines.map((l) => textWidth(l, 11.5, p.mono)))) + 20;
    p.h = p.lines.length > 1 ? PILL_H + PILL_LINE * (p.lines.length - 1) : PILL_H;
  }
  return pills;
}

/** One edge of the flow, no pixels: what a host that lays the chart out with its own elements needs. */
export interface FlowEdge {
  name: string;
  from: string;
  to: string;
  /** To the next rank; over or back across ranks (a lane below in the SVG); or to its own state. */
  kind: EdgeKind;
  /** The guard's short label (`edgeLabel`): the variables a schema guard reads, the id of a reference, or the sentence; empty without one. */
  label: string;
  /** The guard is a sentence: prose the format does not evaluate. */
  sentence: boolean;
  /** The transition's true flags and numbers, as the pills after the guard show them. */
  marks: string[];
}
/**
 * The chart's topology: the states by rank (longest path from the start),
 * each rank in the model's order, and every edge with its kind. A host that
 * paints with its own elements (a pane of boxes and buttons) starts here;
 * `layoutOf` adds the geometry the SVG needs.
 */
export interface Flow { ranks: string[][]; edges: FlowEdge[] }

export function flowOf(model: StatechartModel): Flow {
  const rank = ranksOf(model);
  const ranks: string[][] = [];
  for (const s of model.states) {
    const r = rank.get(s.id) ?? 0;
    while (ranks.length <= r) ranks.push([]);
    ranks[r]?.push(s.id);
  }
  const edges: FlowEdge[] = [];
  for (const t of model.transitions) {
    if (!rank.has(t.from) || !rank.has(t.to)) continue;
    const kind: EdgeKind = t.from === t.to ? "self" : (rank.get(t.to) ?? 0) === (rank.get(t.from) ?? 0) + 1 ? "forward" : "lane";
    edges.push({ name: t.name, from: t.from, to: t.to, kind, label: edgeLabel(t), sentence: t.guard?.kind === "text", marks: pillsOf(t).filter((p) => p.kind === "attr").map((p) => p.lines.join(" ")) });
  }
  return { ranks, edges };
}

const pillsWidth = (pills: Pill[]): number => pills.reduce((a, p) => a + p.w, 0) + PILL_GAP * Math.max(0, pills.length - 1);
const pillsHeight = (pills: Pill[]): number => Math.max(PILL_H, ...pills.map((p) => p.h));

/** Where everything goes. */
export function layoutOf(model: StatechartModel, opts: { title?: string; direction?: Direction } = {}): Layout {
  const dir: Direction = opts.direction ?? "right";
  const right = dir === "right";
  const rank = ranksOf(model);
  const top = PAD + (opts.title !== undefined && opts.title !== "" ? 44 : 0);
  const byRank = new Map<number, LaidNode[]>();
  const nodes = new Map<string, LaidNode>();
  for (const s of model.states) {
    const r = rank.get(s.id) ?? 0;
    const w = Math.max(NODE_MIN_W, Math.ceil(textWidth(s.title, 16)) + 40, Math.ceil(textWidth(`#${s.id} · current`, 11, true)) + 28);
    const n: LaidNode = { id: s.id, rank: r, x: 0, y: 0, w, h: NODE_H };
    nodes.set(s.id, n);
    const col = byRank.get(r) ?? [];
    col.push(n);
    byRank.set(r, col);
  }
  const rankCount = Math.max(-1, ...byRank.keys()) + 1;
  // A rank's thickness along the flow, and its spread across it.
  const thick: number[] = [];
  const spread: number[] = [];
  for (let r = 0; r < rankCount; r++) {
    const col = byRank.get(r) ?? [];
    thick.push(right ? Math.max(0, ...col.map((n) => n.w)) : NODE_H);
    spread.push(right ? col.reduce((a, n) => a + n.h, 0) + ROW_GAP * Math.max(0, col.length - 1) : col.reduce((a, n) => a + n.w, 0) + COL_GAP * Math.max(0, col.length - 1));
  }
  const maxSpread = Math.max(0, ...spread);

  // Left to right, a pill sits above the node band, centred on its gap, so a
  // gap is as wide as its pills need to stay clear of the neighbouring gaps'
  // pills. Top to bottom, a pill sits on its edge, between the ranks, so a gap
  // is as tall as its pills.
  const pillsFor = new Map<number, Pill[]>();
  const gap: number[] = new Array(Math.max(0, rankCount - 1)).fill(right ? RANK_GAP_MIN : RANK_GAP_DOWN);
  let pillBand = PILL_H;
  for (const t of model.transitions) {
    const a = nodes.get(t.from);
    const b = nodes.get(t.to);
    if (a === undefined || b === undefined) continue;
    const pills = pillsOf(t);
    pillsFor.set(t.index, pills);
    if (t.from !== t.to && b.rank === a.rank + 1) {
      const need = right ? pillsWidth(pills) + 24 - ((thick[a.rank] ?? 0) + (thick[b.rank] ?? 0)) / 2 : pillsHeight(pills) + 32;
      gap[a.rank] = Math.max(gap[a.rank] ?? 0, need);
      pillBand = Math.max(pillBand, pillsHeight(pills));
    }
  }
  const along: number[] = [];
  let pos = right ? PAD + START : top + START;
  for (let r = 0; r < rankCount; r++) { along.push(pos); pos += (thick[r] ?? 0) + (gap[r] ?? 0); }
  for (let r = 0; r < rankCount; r++) {
    const col = byRank.get(r) ?? [];
    if (right) {
      let y = top + pillBand + 16 + (maxSpread - (spread[r] ?? 0)) / 2;
      for (const n of col) { n.x = (along[r] ?? 0) + ((thick[r] ?? 0) - n.w) / 2; n.y = y; y += n.h + ROW_GAP; }
    } else {
      let x = PAD + (maxSpread - (spread[r] ?? 0)) / 2;
      for (const n of col) { n.x = x; n.y = along[r] ?? 0; x += n.w + COL_GAP; }
    }
  }
  // The band the ranks occupy: lanes run beyond its far side across the flow,
  // past whatever pill reaches furthest that way.
  const band = right ? top + pillBand + 16 + maxSpread : PAD + maxSpread;
  let far = band;
  let minX = PAD;
  let maxX = 0;
  let maxY = 0;
  const reach = (x: number, y: number): void => { maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const n of nodes.values()) reach(n.x + n.w, n.y + n.h);
  const place = (px: number, py: number, pills: Pill[]): void => {
    reach(px + pillsWidth(pills) / 2, py + pillsHeight(pills) / 2);
    minX = Math.min(minX, px - pillsWidth(pills) / 2);
  };

  const edges: LaidEdge[] = [];
  let lanes = 0;
  const pairSeen = new Map<string, number>();
  const laid: { t: Transition; a: LaidNode; b: LaidNode; k: number; pills: Pill[] }[] = [];
  for (const t of model.transitions) {
    const a = nodes.get(t.from);
    const b = nodes.get(t.to);
    if (a === undefined || b === undefined) continue;
    const key = `${t.from}\u0000${t.to}`;
    const k = pairSeen.get(key) ?? 0;
    pairSeen.set(key, k + 1);
    laid.push({ t, a, b, k, pills: pillsFor.get(t.index) ?? [] });
  }
  // The edges within the band first — their pills decide where the lanes start — then the lanes.
  for (const { t, a, b, k, pills } of laid) {
    const acx = a.x + a.w / 2;
    const acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2;
    const bcy = b.y + b.h / 2;
    if (t.from === t.to) {
      let d: string;
      let px: number;
      let py: number;
      if (right) {
        const y0 = a.y + a.h;
        d = `M${r1(acx - 14)} ${r1(y0)} V${r1(y0 + 22 + k * 12)} H${r1(acx + 14)} V${r1(y0 + 1)}`;
        px = acx;
        py = y0 + 34 + k * 12 + (pillsHeight(pills) - PILL_H) / 2;
      } else {
        const x0 = a.x + a.w;
        d = `M${r1(x0)} ${r1(acy - 14)} H${r1(x0 + 22 + k * 12)} V${r1(acy + 14)} H${r1(x0 + 1)}`;
        px = x0 + 30 + k * 12 + pillsWidth(pills) / 2;
        py = acy + 22 + (pillsHeight(pills) - PILL_H) / 2;
      }
      edges.push({ t, kind: "self", d, pills, px, py });
      place(px, py, pills);
      far = Math.max(far, right ? py + pillsHeight(pills) / 2 : px + pillsWidth(pills) / 2);
      continue;
    }
    if (b.rank === a.rank + 1) {
      let d: string;
      let px: number;
      let py: number;
      if (right) {
        const ax = a.x + a.w;
        const ay = acy + k * 10;
        const bx = b.x;
        const by = bcy + k * 10;
        const straight = Math.abs(ay - by) < 1;
        d = straight ? `M${r1(ax)} ${r1(ay)} H${r1(bx)}` : `M${r1(ax)} ${r1(ay)} C${r1((ax + bx) / 2)} ${r1(ay)} ${r1((ax + bx) / 2)} ${r1(by)} ${r1(bx)} ${r1(by)}`;
        px = (ax + bx) / 2;
        // Above the node band for a straight edge (pills may overhang the nodes beside them); on the curve's midpoint otherwise.
        py = straight ? Math.min(a.y, b.y) - 12 - pillsHeight(pills) / 2 - k * (PILL_H + PILL_GAP) : (ay + by) / 2;
      } else {
        const ax = acx + k * 10;
        const ay = a.y + a.h;
        const bx = bcx + k * 10;
        const by = b.y;
        const straight = Math.abs(ax - bx) < 1;
        d = straight ? `M${r1(ax)} ${r1(ay)} V${r1(by)}` : `M${r1(ax)} ${r1(ay)} C${r1(ax)} ${r1((ay + by) / 2)} ${r1(bx)} ${r1((ay + by) / 2)} ${r1(bx)} ${r1(by)}`;
        px = (ax + bx) / 2 + (k > 0 ? pillsWidth(pills) / 2 + 8 : 0);
        py = (ay + by) / 2;
      }
      edges.push({ t, kind: "forward", d, pills, px, py });
      place(px, py, pills);
      if (!right) far = Math.max(far, px + pillsWidth(pills) / 2);
    }
  }
  for (const { t, a, b, pills } of laid) {
    if (t.from === t.to || b.rank === a.rank + 1) continue;
    const acx = a.x + a.w / 2;
    const acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2;
    const bcy = b.y + b.h / 2;
    const lane = lanes++;
    let d: string;
    let px: number;
    let py: number;
    if (right) {
      const laneY = far + 28 + lane * LANE_GAP;
      const s = bcx < acx ? -1 : 1;
      d = `M${r1(acx)} ${r1(a.y + a.h)} V${r1(laneY - 10)} Q${r1(acx)} ${r1(laneY)} ${r1(acx + 10 * s)} ${r1(laneY)} H${r1(bcx - 10 * s)} Q${r1(bcx)} ${r1(laneY)} ${r1(bcx)} ${r1(laneY - 10)} V${r1(b.y + b.h + 1)}`;
      px = (acx + bcx) / 2;
      py = laneY;
    } else {
      const laneX = far + 28 + lane * LANE_GAP;
      const s = bcy < acy ? -1 : 1;
      d = `M${r1(a.x + a.w)} ${r1(acy)} H${r1(laneX - 10)} Q${r1(laneX)} ${r1(acy)} ${r1(laneX)} ${r1(acy + 10 * s)} V${r1(bcy - 10 * s)} Q${r1(laneX)} ${r1(bcy)} ${r1(laneX - 10)} ${r1(bcy)} H${r1(b.x + b.w + 1)}`;
      px = laneX;
      py = (acy + bcy) / 2;
    }
    edges.push({ t, kind: "lane", d, pills, px, py });
    place(px, py, pills);
    reach(right ? 0 : px, right ? py : 0);
  }
  // A pill wider than its column may start left of the picture: move everything right by that much.
  const shiftX = Math.max(0, PAD - minX);
  return { nodes, edges, width: Math.ceil(maxX + shiftX + PAD), height: Math.ceil(maxY + PAD), top, direction: dir, shiftX };
}

/** The diagram as one standalone `<svg>`. */
export function statechartSvg(model: StatechartModel, opts: SvgOptions = {}): string {
  const L = layoutOf(model, { ...(opts.title !== undefined ? { title: opts.title } : {}), ...(opts.direction !== undefined ? { direction: opts.direction } : {}) });
  const right = L.direction === "right";
  const ov = opts.overlay ?? {};
  const current = ov.current ?? model.current;
  const taken = new Set(ov.taken ?? []);
  const pressable = new Set(ov.pressable ?? []);
  const key = (opts.key ?? "sc").replace(/[^A-Za-z0-9_-]/g, "_");
  const arr = `${key}-arr`;
  const arrA = `${key}-arr-a`;
  const out: string[] = [];
  out.push(`<style>` +
    `.sc{font-family:${SANS}}` +
    `.sc .ttl{font-size:17px;font-weight:600;fill:#1f2328}` +
    `.sc .box{fill:#fff;stroke:#8c959f;stroke-width:1.2}` +
    `.sc .name{font-size:16px;font-weight:600;fill:#1f2328}` +
    `.sc .sid{font-size:11px;fill:#656d76;font-family:${MONO}}` +
    `.sc .cur .box{fill:#eaf2ff;stroke:#2563eb;stroke-width:2}.sc .cur .name{fill:#0c447c}` +
    `.sc .inner{fill:none;stroke:#8c959f;stroke-width:1}` +
    `.sc .ring{fill:none;stroke:#2563eb;stroke-width:2;animation:sc-pulse 2.4s ease-in-out infinite}` +
    `.sc .badge circle{fill:#2563eb}.sc .badge text{font-size:11px;font-weight:600;fill:#fff;font-family:${MONO}}` +
    `.sc .edge{fill:none;stroke:#8c959f;stroke-width:1.6}` +
    `.sc .taken .edge{stroke:#2563eb;stroke-width:2.2}` +
    `.sc .can{cursor:pointer}.sc .can .edge{stroke:#2563eb}.sc .can .pill rect{stroke:#2563eb}.sc .can:hover .edge{stroke-width:3}.sc .can:hover .pill rect{fill:#eaf2ff}` +
    `.sc .hit{fill:none;stroke:transparent;stroke-width:16}` +
    `.sc .flow{fill:none;stroke:#2563eb;stroke-width:2.4;stroke-linecap:round;stroke-dasharray:3 11;animation:sc-flow 1.1s linear infinite}` +
    `.sc .flow.lane{stroke:#9a6700;animation-duration:2.2s}` +
    `.sc .pill rect{fill:#fff;stroke:#d0d7de}.sc .pill text{font-size:11.5px;fill:#424a53;font-family:${MONO}}` +
    `.sc .pill.sentence rect{fill:#fff8c5;stroke:#d4a72c}.sc .pill.sentence text{font-family:${SANS};fill:#7d4e00}` +
    `.sc .pill.attr rect{fill:#f6f8fa;stroke:#d0d7de}.sc .pill.attr text{fill:#656d76}` +
    `.sc .pill.ok rect{fill:#dafbe1;stroke:#4ac26b}.sc .pill.ok text{fill:#116329}` +
    `.sc .pill.no rect{fill:#f6f8fa;stroke:#d0d7de;stroke-dasharray:3 2}.sc .pill.no text{fill:#8c959f}` +
    `@keyframes sc-flow{to{stroke-dashoffset:-28}}@keyframes sc-pulse{0%,100%{stroke-opacity:.12}50%{stroke-opacity:.7}}` +
    `@media (prefers-reduced-motion:reduce){.sc .flow,.sc .ring{animation:none}}` +
    `</style>`);
  const marker = (id: string, fill: string): string => `<marker id="${escAttr(id)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M1 1L9 5L1 9z" fill="${fill}"/></marker>`;
  out.push(`<defs>${marker(arr, "#8c959f")}${marker(arrA, "#2563eb")}</defs>`);
  out.push(`<g class="sc"${L.shiftX > 0 ? ` transform="translate(${r1(L.shiftX)} 0)"` : ""}>`);
  if (opts.title !== undefined && opts.title !== "") out.push(`<text class="ttl" x="${PAD}" y="${PAD + 18}">${esc(opts.title)}</text>`);

  const init = L.nodes.get(model.initial);
  if (init !== undefined) {
    const cx = init.x + init.w / 2;
    const cy = init.y + init.h / 2;
    out.push(right
      ? `<g class="start"><circle cx="${r1(init.x - 32)}" cy="${r1(cy)}" r="6" fill="#1f2328"/><path class="edge" d="M${r1(init.x - 25)} ${r1(cy)} H${r1(init.x - 2)}" marker-end="url(#${escAttr(arr)})"/></g>`
      : `<g class="start"><circle cx="${r1(cx)}" cy="${r1(init.y - 30)}" r="6" fill="#1f2328"/><path class="edge" d="M${r1(cx)} ${r1(init.y - 23)} V${r1(init.y - 2)}" marker-end="url(#${escAttr(arr)})"/></g>`);
  }
  const tip = (t: Transition): string => {
    const g = t.guard === undefined ? "" : ` — ${guardText(t.guard)}`;
    const extra = Object.entries(t.attrs).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k}: ${show(v)}`);
    return [`${t.name}${g}`, ...extra].join("\n");
  };
  for (const e of L.edges) {
    const lane = e.kind !== "forward";
    const was = taken.has(e.t.name);
    const can = pressable.has(e.t.name);
    out.push(`<g class="tr ${e.kind}${was ? " taken" : ""}${can ? " can" : ""}" data-transition="${escAttr(e.t.name)}"${can ? ` data-from="${escAttr(e.t.from)}" data-to="${escAttr(e.t.to)}" role="button"` : ""}><title>${esc(tip(e.t))}${can ? "\n— press to take" : ""}</title>` +
      (can ? `<path class="hit" d="${e.d}"/>` : "") +
      `<path class="edge" d="${e.d}" marker-end="url(#${escAttr(was || can ? arrA : arr)})"/><path class="flow${lane ? " lane" : ""}" d="${e.d}"/>`);
    if (e.pills.length > 0) {
      const holds = ov.holds?.[e.t.name];
      let x = e.px - pillsWidth(e.pills) / 2;
      for (const p of e.pills) {
        const state = p.kind === "guard" && holds !== undefined ? (holds ? " ok" : " no") : "";
        const y0 = e.py - (p.lines.length - 1) * PILL_LINE / 2;
        out.push(`<g class="pill ${p.kind}${state}"><rect x="${r1(x)}" y="${r1(e.py - p.h / 2)}" width="${r1(p.w)}" height="${r1(p.h)}" rx="12"/>` +
          `<text x="${r1(x + p.w / 2)}" y="${r1(y0)}" text-anchor="middle" dominant-baseline="central">${p.lines.map((l, i) => i === 0 ? esc(l) : `<tspan x="${r1(x + p.w / 2)}" dy="${PILL_LINE}">${esc(l)}</tspan>`).join("")}</text></g>`);
        x += p.w + PILL_GAP;
      }
    }
    out.push(`</g>`);
  }
  for (const s of model.states) {
    const n = L.nodes.get(s.id);
    if (n === undefined) continue;
    const cur = s.id === current;
    const cls = ["node", s.id === model.initial ? "initial" : "", s.final ? "final" : "", cur ? "cur" : ""].filter(Boolean).join(" ");
    const sub = `#${s.id}${cur ? (ov.paused ? " · paused" : " · current") : s.final ? " · final" : ""}`;
    const count = ov.counts?.[s.id] ?? 0;
    const badge = count > 0 && !(count === 1 && cur)
      ? `<g class="badge"><circle cx="${r1(n.x + n.w - 2)}" cy="${r1(n.y + 2)}" r="10"/><text x="${r1(n.x + n.w - 2)}" y="${r1(n.y + 2)}" text-anchor="middle" dominant-baseline="central">${String(count)}</text></g>`
      : "";
    out.push(`<g class="${cls}" data-state="${escAttr(s.id)}"><title>${esc(s.description !== undefined ? `${s.title} — ${s.description}` : s.title)}</title>` +
      (cur ? `<rect class="ring" x="${r1(n.x - 6)}" y="${r1(n.y - 6)}" width="${r1(n.w + 12)}" height="${r1(n.h + 12)}" rx="18"/>` : "") +
      `<rect class="box" x="${r1(n.x)}" y="${r1(n.y)}" width="${r1(n.w)}" height="${r1(n.h)}" rx="14"/>` +
      (s.final ? `<rect class="inner" x="${r1(n.x + 4)}" y="${r1(n.y + 4)}" width="${r1(n.w - 8)}" height="${r1(n.h - 8)}" rx="11"/>` : "") +
      `<text class="name" x="${r1(n.x + n.w / 2)}" y="${r1(n.y + 27)}" text-anchor="middle">${esc(s.title)}</text>` +
      `<text class="sid" x="${r1(n.x + n.w / 2)}" y="${r1(n.y + 50)}" text-anchor="middle">${esc(sub)}</text>${badge}</g>`);
  }
  out.push(`</g>`);
  const label = `${opts.title !== undefined && opts.title !== "" ? `${opts.title}: ` : ""}${model.states.map((s) => s.title).join(", ")}`;
  return `<svg class="geml-statechart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" width="100%" style="max-width:${L.width}px;height:auto;display:block;margin:0 auto" role="img" aria-label="${escAttr(label)}">${out.join("")}</svg>`;
}

/** A `data:` URL of the picture, for a download link that needs no script. */
export function statechartSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
