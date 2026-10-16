// Stagehand (spec §5.4): when the workflow enters a state, put together what
// the model should have in front of it — the state's description, the prompt
// its `prompt` names, the skills to enable, the uses and the tools bound to
// them, the variables as they stand, and the ways out with what each still
// needs — within the byte budget. Pure: the host supplies the prompt text.
import { parse, unitSpans, type Block } from "@geml/geml";
import { guardText } from "@geml/geml/dist/statechart.js";
import { preferred, type Dictionary } from "./dictionary.js";
import type { JsonValue } from "./schema.js";
import { guardHolds, type Snapshot } from "./snapshot.js";
import { outgoing, type Statechart, type Transition } from "./statechart.js";

export interface StageContext { state: string; rev: number; text: string; included: string[]; truncated: string[] }

const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** One line per way out: what it needs, and who takes it. */
export function nextLines(sc: Statechart, snap: Snapshot): string[] {
  return outgoing(sc, snap.state).map((t) => describeNext(sc, snap, t));
}

function describeNext(sc: Statechart, snap: Snapshot, t: Transition): string {
  const note = t.note ? ` — ${t.note}` : "";
  if (t.approval) {
    const guard = t.guard === undefined ? "" : ` once ${guardText(t.guard)}`;
    return `→ ${t.to}: a person approves it${guard} (board, or gemflow advance ${t.to})${note}`;
  }
  if (t.judge === "machine" && t.guard !== undefined) {
    const holds = guardHolds(sc, t, snap.vars);
    const missing = t.reads.filter((r) => snap.vars[r] === false || snap.vars[r] === undefined || snap.vars[r] === null);
    return `→ ${t.to}: on its own when ${guardText(t.guard)}${holds ? " (holds now)" : missing.length ? ` — still missing: ${missing.join(", ")}` : ""}${note}`;
  }
  if (t.judge === "model" && t.guard?.kind === "text") return `→ ${t.to}: your call, with move, when ${t.guard.text}${note}`;
  return `→ ${t.to}: your call, with move${note}`;
}

/** The uses of a state with the tools the dictionary binds to each, for the model. */
export function toolLines(sc: Statechart, stateId: string, dict: Dictionary | undefined): string[] {
  const state = sc.states.get(stateId);
  return (state?.uses ?? []).map((use) => {
    const row = dict === undefined ? undefined : preferred(dict, use);
    if (row === undefined) return `${use}: no tool bound yet (the first one you use is asked about)`;
    const params = row.params === undefined ? "" : ` with ${JSON.stringify(row.params)}`;
    return `${use}: ${row.tool}${params}`;
  });
}

/**
 * The stage text. The description, skills, tools, variables and ways out are
 * never cut; the prompt gets the bytes that remain, and when it does not fit
 * the text says where to read it.
 */
export function buildStageContext(sc: Statechart, snap: Snapshot, getPrompt: (ref: string) => string | undefined, dict?: Dictionary): StageContext {
  const state = sc.states.get(snap.state);
  const vars = [...sc.vars.values()].map((v) => `${v.name}=${JSON.stringify(snap.vars[v.name] ?? v.default)}${v.source === undefined ? " (yours to set)" : ""}`);
  const lines = [
    `[gemflow] stage ${snap.state} · rev ${snap.rev}`,
    state === undefined ? "" : `${state.title}${state.description ? ` — ${state.description}` : ""}`,
    "",
    ...(state?.skills.length ? [`Skills: ${state.skills.join(", ")}`] : []),
    ...(state?.uses.length ? ["Tools here:", ...toolLines(sc, snap.state, dict).map((l) => `  ${l}`)] : ["Tools here: none declared; what you use is asked about"]),
    `Variables: ${vars.length ? vars.join(" · ") : "none"}`,
    "Next:",
    ...(outgoing(sc, snap.state).length ? nextLines(sc, snap).map((l) => `  ${l}`) : ["  nothing — this is the final stage"]),
  ];
  let text = lines.join("\n");
  const included: string[] = [];
  const truncated: string[] = [];
  const ref = state?.prompt;
  if (ref !== undefined) {
    const note = `\n\n(the prompt ${ref} was left out to stay within ${sc.contextBudget} bytes — read it with geml get)`;
    const body = getPrompt(ref);
    const piece = `\n\n--- ${ref} ---\n${(body ?? "(not found)").replace(/\r\n?/g, "\n")}`;
    if (bytes(text) + bytes(piece) <= sc.contextBudget) { text += piece; included.push(ref); }
    else { text += note; truncated.push(ref); }
  }
  return { state: snap.state, rev: snap.rev, text, included, truncated };
}

/**
 * `.geml/context.geml` (spec §5.4): `text {#current}` is the stage text, fenced
 * wider than any `=`-run that starts a line of it; `data {#stage}` says which
 * item, state and revision it speaks for; `data {#vars}` is the variables as
 * they stand — a view to read, never a way to write them.
 */
export function renderContextDoc(ctx: StageContext, o: { at: string; item: string; vars?: Record<string, JsonValue> }): string {
  const longest = Math.max(0, ...ctx.text.split("\n").map((l) => l.match(/^=+/)?.[0].length ?? 0));
  const fence = "=".repeat(Math.max(3, longest + 1));
  return [
    "=== meta",
    'title = "Gemflow — current stage"',
    "===",
    "",
    `${fence} text {#current}`,
    ctx.text,
    fence,
    "",
    "=== data {#stage format=json}",
    JSON.stringify({ item: o.item, state: ctx.state, rev: ctx.rev, at: o.at }),
    "===",
    "",
    ...(o.vars === undefined ? [] : ["=== data {#vars format=json}", JSON.stringify(o.vars, null, 2), "===", ""]),
  ].join("\n");
}

type Typed = Extract<Block, { kind: "block" }>;

export interface ContextDoc { state: string; rev: number; at: string; item: string; text: string; vars?: Record<string, JsonValue> }

export function readContextDoc(source: string): ContextDoc | undefined {
  const src = source.replace(/\r\n?/g, "\n");
  const doc = parse(src);
  const typed = (type: string, id: string) => doc.children.find((x): x is Typed => x.kind === "block" && x.type === type && x.id === id);
  // The stage text is the block's lines as written: a `text` body is parsed, and the prompt in it may hold fences of its own.
  const current = unitSpans(src).find((u) => u.kind === "block" && u.type === "text" && u.id === "current");
  const stage = typed("data", "stage")?.value;
  if (!current || typeof stage !== "object" || stage === null || Array.isArray(stage)) return undefined;
  const s = stage as Record<string, JsonValue>;
  const v = typed("data", "vars")?.value;
  return {
    state: String(s["state"] ?? ""),
    rev: typeof s["rev"] === "number" ? s["rev"] : -1,
    at: String(s["at"] ?? ""),
    item: String(s["item"] ?? ""),
    text: src.split("\n").slice(current.span.start + 1, current.span.end - 1).join("\n"),
    ...(v !== null && typeof v === "object" && !Array.isArray(v) ? { vars: v as Record<string, JsonValue> } : {}),
  };
}
