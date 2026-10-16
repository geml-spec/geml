// What the model is shown between its turns on hosts that inject a per-step
// snapshot (dsh, pi): the state, the variables, the ways out and the tools.
// Text only; nothing here knows about any host.
import { guardText } from "@geml/geml/dist/statechart.js";
import type { Dictionary } from "./dictionary.js";
import { canonical, type Snapshot } from "./snapshot.js";
import { modelVars, outgoing, type Statechart } from "./statechart.js";
import { toolLines } from "./stagehand.js";

function edgeTail(t: { judge: string; guard?: { kind: string; text?: string }; approval: boolean }, sep: string): string {
  const notes: string[] = [];
  if (t.judge === "machine" && t.guard !== undefined) notes.push(`when ${guardText(t.guard as Parameters<typeof guardText>[0])}`);
  if (t.judge === "model" && t.guard?.kind === "text") notes.push(`when ${t.guard.text}`);
  if (t.approval) notes.push("needs a person");
  return notes.length ? ` (${notes.join(sep)})` : "";
}

/** The ways out of a state, one per line, for a tool description. */
export function describeTransitions(sc: Statechart, stateId: string): string {
  const edges = outgoing(sc, stateId);
  if (edges.length === 0) return "(none — this is the final state)";
  return edges.map((t) => `${t.name}${t.note ? `: ${t.note}` : ""}${edgeTail(t, "; ")}`).join("\n");
}

/** The per-step snapshot: a few hundred bytes. */
export function renderContext(sc: Statechart, snap: Snapshot, dict?: Dictionary): string {
  const state = sc.states.get(snap.state);
  const edges = outgoing(sc, snap.state);
  const transitions = edges.length ? edges.map((t) => `${t.name}${edgeTail(t, ", ")}`).join(" · ") : "(none — this is the final state)";
  const tools = state?.uses.length ? toolLines(sc, snap.state, dict).join(" · ") : "(none declared)";
  const settable = modelVars(sc);
  return `[gemflow] state ${snap.state} · rev ${snap.rev} · ${snap.hash.slice(0, 19)}…\n`
    + `vars: ${canonical(snap.vars)}\n`
    + `transitions: ${transitions}\n`
    + `tools here: ${tools} · settable vars: ${settable.length ? settable.join(" ") : "none"}`;
}
