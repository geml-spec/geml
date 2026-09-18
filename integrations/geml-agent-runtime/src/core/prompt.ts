// What the model is shown: the per-step context snapshot and the wording of
// the agent_transition tool. Text only; nothing here knows about DSH.
import { canonical, type Snapshot } from "./snapshot.js";
import { allowedVars, effectiveTools, outgoing, type State, type Statechart } from "./statechart.js";

function edgeTail(t: { requiresId?: string; approval: boolean }, sep: string): string {
  const notes: string[] = [];
  if (t.requiresId) notes.push(`requires #${t.requiresId}`);
  if (t.approval) notes.push("needs approval");
  return notes.length ? ` (${notes.join(sep)})` : "";
}

export function describeTransitions(sc: Statechart, stateId: string): string {
  const edges = outgoing(sc, stateId);
  if (edges.length === 0) {
    const s = sc.states.get(stateId);
    return s?.final ? "(none — this is a final state)" : "(none)";
  }
  return edges.map((t) => `#${t.id} → #${t.to}: ${t.body}${edgeTail(t, "; ")}`).join("\n");
}

export function visibleTools(sc: Statechart, state: State, globalNames: readonly string[]): { kind: "unrestricted" } | { kind: "allow"; names: string[] } {
  const wanted = effectiveTools(sc, state);
  if (wanted === undefined) return { kind: "unrestricted" };
  const known = new Set(globalNames);
  return { kind: "allow", names: wanted.filter((n) => known.has(n)) };
}

export function renderContext(sc: Statechart, snap: Snapshot): string {
  const state = sc.states.get(snap.state);
  const edges = outgoing(sc, snap.state);
  const transitions = edges.length
    ? edges.map((t) => `#${t.id} → #${t.to}${edgeTail(t, ", ")}`).join(" · ")
    : state?.final ? "(none — this is a final state)" : "(none)";
  const tools = state ? effectiveTools(sc, state) : undefined;
  const toolsText = tools === undefined ? "(unrestricted)" : tools.length ? tools.join(" ") : "none";
  const vars = state ? allowedVars(sc, state) : [];
  const varsText = vars.length ? vars.join(" ") : "none";
  return `[geml-agent] state #${snap.state} · rev ${snap.rev} · ${snap.hash.slice(0, 19)}…\n`
    + `vars: ${canonical(snap.vars)}\n`
    + `transitions: ${transitions}\n`
    + `tools here: ${toolsText} · settable vars: ${varsText}`;
}
