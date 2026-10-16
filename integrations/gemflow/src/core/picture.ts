// The flow picture on a board (spec §8.2): the workflow's own statechart with
// what the supervisor knows now laid on top — the state the work item is in,
// which of its ways out hold, how many items stand in each state, a hold, the
// transition last taken, and the ways out a person may take now. Three parts,
// all from the parser's renderer: the topology (states by rank, edges by
// kind), the overlay, and the SVG of the two. A host that draws with its own
// elements (the Claude Code pane: boxes and buttons) paints the first two,
// so a way out a person may take is a real button; a host that inlines
// markup (dsh's web board) shows the SVG, where the same way out takes a
// click. Drawn top to bottom, since a board is a narrow pane. Pure.
import { flowOf, statechartSvg, type Overlay } from "@geml/geml/dist/statechart-svg.js";
import type { Statechart } from "./statechart.js";
import type { Status } from "./status.js";
import type { FlowPicture, TimelineEntry } from "../hosts/claude-code/protocol.js";

export interface PictureInput {
  sc: Statechart;
  status: Status | null;
  /** Every work item with a journal and the state it stands in. */
  items: readonly { id: string; state: string }[];
  /** The current work item's journal, as the board lists it. */
  timeline: readonly TimelineEntry[];
}

/** What the picture lays over the chart: the runtime's view of the current item, and the items' spread. */
export function flowOverlay(p: PictureInput): Overlay {
  const ov: Overlay = {};
  const st = p.status;
  if (st !== null && st.item.kind === "item" && st.state !== undefined) {
    ov.current = st.state.id;
    // Only a guard the machine judges holds or not; a person's sentence has no value to show.
    const holds = Object.fromEntries(st.next.filter((n) => n.reads.length > 0).map((n) => [n.name, n.holds]));
    if (Object.keys(holds).length > 0) ov.holds = holds;
    if (st.paused) ov.paused = true;
    // As the flow list offers them: a way out whose guard holds, while nobody holds the work.
    else {
      const pressable = st.next.filter((n) => n.holds).map((n) => n.name);
      if (pressable.length > 0) ov.pressable = pressable;
    }
  }
  const counts: Record<string, number> = {};
  for (const it of p.items) counts[it.state] = (counts[it.state] ?? 0) + 1;
  if (Object.keys(counts).length > 0) ov.counts = counts;
  // The transition last taken: the newest revision whose cause is a transition names where it came from.
  for (let i = p.timeline.length - 1; i >= 0; i--) {
    const e = p.timeline[i];
    if (e === undefined || e.kind !== "snapshot" || e.cause !== "transition" || e.from === undefined) continue;
    const name = `${e.from}→${e.state}`;
    const hit = p.sc.transitions.find((t) => t.name === name || t.name.startsWith(`${name}[`));
    if (hit !== undefined) ov.taken = [hit.name];
    break;
  }
  return ov;
}

/** The flow as the board draws it: the topology, the runtime laid over it, and the SVG of both, top to bottom. */
export function flowPicture(p: PictureInput): FlowPicture {
  const overlay = flowOverlay(p);
  return { flow: flowOf(p.sc.model), overlay, svg: statechartSvg(p.sc.model, { key: "flow", direction: "down", overlay }) };
}
