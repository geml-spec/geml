// Load a Gemflow workflow (a `geml-statechart/v1` document) from GEML text and
// check it statically.
// Pure: text in, model + diagnostics out. The host reads the files.
//
// A workflow is one `diagram {format=geml-statechart}` block (spec §4): the
// parser's statechart module reads the block and reports the format's own
// `statechart-*` codes; this module hangs Gemflow's keys on the model —
// `prompt`, `skills` and `tools` (the uses) on a state, `source` on a
// variable, `approval` on a transition — and reports the `flow-*` codes of
// spec §4.3.
import { createHash } from "node:crypto";
import { parse, unitSpans, type Diagnostic } from "@geml/geml";
import { statechartsOf } from "@geml/geml/dist/statechart-check.js";
import type { Guard, JsonValue, StatechartModel } from "@geml/geml/dist/statechart.js";
import type { Schema } from "./schema.js";

export type { Guard };

export interface State {
  id: string;
  /** `title`, or the id. */
  title: string;
  /** `description`: the one line people and the model both read. */
  description: string;
  line: number;
  /** The prompt loaded on entry: a section (`#id`, `doc.geml#id`) or a whole document (`./guide.geml`). */
  prompt?: string;
  /** Skill names, handed to the host. */
  skills: string[];
  /** The uses this state declares: `edit`, `test`, `deploy-prod`… The dictionary binds them to tools. */
  uses: string[];
  /** The uses this state declares as rules (`rules`): each is fenced to the states that declare it; the rest run anywhere. */
  rules: string[];
  /** No outgoing transition. */
  final: boolean;
}

/** Three guards, three judges (spec §4.2). */
export type Judge = "machine" | "model" | "none";

export interface Transition {
  index: number;
  /** `from→to`, numbered when the pair has several transitions — the name messages and the journal use. */
  name: string;
  line: number;
  from: string;
  to: string;
  guard?: Guard;
  /** Who judges the guard: a schema (object or reference) the machine, a sentence the model, none when there is no guard. */
  judge: Judge;
  /** The variables a machine guard reads. */
  reads: string[];
  /** Taken only by a person; a guard written beside it must hold too. */
  approval: boolean;
  /** Variables returned to their default when the transition is taken, by anyone. */
  resets: string[];
  /** What the model is told about the transition; empty when none. */
  note: string;
  /** The words on a person's button for it ("通过", "要改"); absent, the target state's title. */
  label?: string;
}

export type GitFact = "committed" | "pr-open" | "pr-merged" | "ci-success";
export const GIT_FACTS: readonly GitFact[] = ["committed", "pr-open", "pr-merged", "ci-success"];

/** Where a variable's value comes from (spec §4.2). A variable without one is the model's to `set`. */
export type Source =
  | { kind: "tool"; use: string }
  | { kind: "file"; glob: string }
  | { kind: "git"; fact: GitFact }
  | { kind: "human" }
  /** The clock: true once the current state has been held at least `ms` (spec §3.6). `iso` is the duration as written. */
  | { kind: "elapsed"; iso: string; ms: number };

export interface Var {
  name: string;
  default: JsonValue;
  source?: Source;
  note: string;
}

/** `stateKey`: the meta key a file unit's item file keeps its state under (`flow-state-key`); absent, the file is not written. */
export type Unit = { kind: "branch" } | { kind: "file"; glob: string; stateKey?: string };

export const DEFAULT_CONTEXT_BUDGET = 16384;

export interface Statechart {
  file: string;
  hash: string;
  initial: string;
  states: Map<string, State>;
  transitions: Transition[];
  vars: Map<string, Var>;
  /** The variables as one object schema, for `validate` and `defaultsOf`: each typed by its default. */
  varsSchema: Schema;
  /** The variables with a `source`: evidence the model cannot write. */
  signalVars: Set<string>;
  /** The uses some state declares as a rule: only these are refused outside the states that declare them. */
  rules: Set<string>;
  unit: Unit;
  contextBudget: number;
  /** The parser's model, for the renderer and the board. */
  model: StatechartModel;
}

export type FlowCode =
  | "flow-statechart" | "flow-attr" | "flow-source" | "flow-dup-edge" | "flow-auto-ambiguous" | "flow-auto-cycle" | "flow-unit" | "flow-tools";
export interface FlowDiagnostic { severity: "error" | "warning" | "info"; code: string; message: string; line: number }

export function hashText(text: string): string {
  return "sha256:" + createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}

export function hasErrors(diagnostics: readonly FlowDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

const NAME = /^[\p{L}\p{N}_-]+$/u;
const isObject = (v: unknown): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The JSON type of a default, as the variable's schema type. */
function typeOfDefault(v: JsonValue): Schema["type"] {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v as Schema["type"];
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * An ISO 8601 duration of days, hours, minutes and seconds (`PT2H`, `P1DT12H`,
 * `PT30M`), in milliseconds; undefined for any other text, and for zero.
 * Months and years are not durations a clock can add, so they are not read.
 */
export function parseDuration(text: string): number | undefined {
  const m = text.match(DURATION);
  if (!m || text === "P" || text.endsWith("T")) return undefined;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x)));
  const ms = (((d! * 24 + h!) * 60 + min!) * 60 + s!) * 1000;
  return ms > 0 ? ms : undefined;
}

/** A `source` value as the model wrote it, or why it is none of the forms. */
function readSource(v: JsonValue): Source | string {
  if (typeof v === "string") {
    if (v === "human") return { kind: "human" };
    if ((GIT_FACTS as readonly string[]).includes(v)) return { kind: "git", fact: v as GitFact };
    return `"${v}" is not "human" or a git fact (${GIT_FACTS.join(", ")})`;
  }
  if (isObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v["tool"] === "string" && NAME.test(v["tool"])) return { kind: "tool", use: v["tool"] };
    if (keys.length === 1 && typeof v["file"] === "string" && v["file"].trim() !== "") return { kind: "file", glob: v["file"] };
    if (keys.length === 1 && typeof v["elapsed"] === "string") {
      const ms = parseDuration(v["elapsed"]);
      return ms === undefined ? `"${v["elapsed"]}" is not an ISO 8601 duration of days, hours, minutes and seconds above zero (PT2H, P1DT12H, PT30M)` : { kind: "elapsed", iso: v["elapsed"], ms };
    }
    return 'an object source is { "tool": "<use>" }, { "file": "<glob>" } or { "elapsed": "<ISO 8601 duration>" }';
  }
  return "a source is a string or an object";
}

export interface LoadOptions {
  /** Whether a state's `prompt` resolves (a section or a whole document); absent, prompts are not checked. */
  resolveRef?: (ref: string) => boolean;
  /** Another document the statechart refers to (a guard's `doc.geml#id`), relative to the workflow's directory; null when there is none. */
  readDoc?: (rel: string) => string | null;
}

export function loadStatechart(source: string, file: string, opts: LoadOptions = {}): { statechart?: Statechart; diagnostics: FlowDiagnostic[] } {
  // Normalize once, up front: two checkouts of one file must hash the same.
  const src = source.replace(/\r\n?/g, "\n");
  const doc = parse(src);
  const diagnostics: FlowDiagnostic[] = doc.diagnostics.map((d: Diagnostic) => ({ severity: d.severity, code: d.code, message: d.message, line: d.line }));
  const err = (code: FlowCode, message: string, line: number) => diagnostics.push({ severity: "error", code, message, line });
  const warn = (code: FlowCode, message: string, line: number) => diagnostics.push({ severity: "warning", code, message, line });
  if (hasErrors(diagnostics)) return { diagnostics };

  // Line numbers: the parser does not put one on a block; the span layer does.
  const lines = new Map<string, number>();
  for (const u of unitSpans(src)) if (u.kind === "block" && u.id !== undefined) lines.set(u.id, u.span.start + 1);
  const lineOf = (id: string | undefined) => (id === undefined ? 1 : lines.get(id) ?? 1);

  // meta: flow-unit, and for a file unit flow-state-key
  let unit: Unit = { kind: "branch" };
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  if (meta?.kind === "block" && meta.data && "flow-unit" in meta.data) {
    const u = String(meta.data["flow-unit"]).trim();
    const m = u.match(/^file:(.+)$/);
    if (u === "branch") unit = { kind: "branch" };
    else if (m && m[1]!.trim().length > 0) unit = { kind: "file", glob: m[1]!.trim() };
    else err("flow-unit", `meta flow-unit = "${u}": expected branch or file:<glob>`, 1);
  }
  if (meta?.kind === "block" && meta.data && "flow-state-key" in meta.data) {
    const k = String(meta.data["flow-state-key"]).trim();
    if (unit.kind !== "file") err("flow-unit", `meta flow-state-key = "${k}": only a file unit keeps its state in the item file`, 1);
    else if (!/^[A-Za-z][\w-]*$/.test(k)) err("flow-unit", `meta flow-state-key = "${k}": expected a meta key name`, 1);
    else unit = { ...unit, stateKey: k };
  }

  // the statechart block, read by the parser's module
  const charts = statechartsOf(doc, file, (rel) => opts.readDoc?.(rel) ?? null);
  if (charts.length !== 1) {
    err("flow-statechart", charts.length === 0 ? "no `diagram {format=geml-statechart}` block: a workflow is one statechart" : `${charts.length} statechart blocks: a workflow is one`, 1);
    return { diagnostics };
  }
  const { block, result } = charts[0]!;
  const blockLine = lineOf(block.id);
  for (const d of result.diagnostics) diagnostics.push({ severity: d.severity, code: d.code, message: d.message, line: blockLine });
  if (result.model === null || hasErrors(diagnostics)) return { diagnostics };
  const m = result.model;

  // states and Gemflow's keys on them
  const states = new Map<string, State>();
  const declaredUses = new Set<string>();
  for (const s of m.states) {
    const st: State = { id: s.id, title: s.title, description: s.description ?? "", line: blockLine, skills: [], uses: [], rules: [], final: s.final };
    const a = s.attrs;
    if (a["prompt"] !== undefined) {
      if (typeof a["prompt"] !== "string" || a["prompt"].trim() === "") err("flow-attr", `state ${s.id}: \`prompt\` is not a reference`, blockLine);
      else if (opts.resolveRef) {
        // A resolver that throws says why the reference cannot be read at all (a path outside the project).
        let found: boolean | string;
        try { found = opts.resolveRef(a["prompt"]); } catch (e) { found = e instanceof Error ? e.message : String(e); }
        if (found === true) st.prompt = a["prompt"];
        else if (found === false) err("flow-attr", `state ${s.id}: \`prompt\` ${a["prompt"]} does not resolve`, blockLine);
        else err("flow-attr", `state ${s.id}: \`prompt\` ${a["prompt"]} could not be resolved: ${found}`, blockLine);
      } else st.prompt = a["prompt"];
    }
    if (a["skills"] !== undefined) {
      if (!isStringList(a["skills"])) err("flow-attr", `state ${s.id}: \`skills\` is not an array of strings`, blockLine);
      else st.skills = a["skills"];
    }
    if (a["tools"] !== undefined) {
      if (!isStringList(a["tools"]) || a["tools"].some((u) => !NAME.test(u))) err("flow-attr", `state ${s.id}: \`tools\` is not an array of use names`, blockLine);
      else { st.uses = [...new Set(a["tools"])]; for (const u of st.uses) declaredUses.add(u); }
    }
    // A rule is a use too: declared here, and fenced to the states that declare it.
    if (a["rules"] !== undefined) {
      if (!isStringList(a["rules"]) || a["rules"].some((u) => !NAME.test(u))) err("flow-attr", `state ${s.id}: \`rules\` is not an array of use names`, blockLine);
      else { st.rules = [...new Set(a["rules"])]; st.uses = [...new Set([...st.uses, ...st.rules])]; for (const u of st.rules) declaredUses.add(u); }
    }
    states.set(s.id, st);
  }

  // variables and their sources
  const vars = new Map<string, Var>();
  const properties: Record<string, Schema> = {};
  for (const v of m.vars) {
    const entry: Var = { name: v.name, default: v.default, note: "" };
    const a = v.attrs;
    if (a["source"] !== undefined) {
      const s = readSource(a["source"]);
      if (typeof s === "string") err("flow-attr", `variable ${v.name}: \`source\` ${s}`, blockLine);
      else {
        entry.source = s;
        if (v.default !== false) err("flow-attr", `variable ${v.name}: a variable with a \`source\` is evidence; its default must be false`, blockLine);
        if (s.kind === "tool" && !declaredUses.has(s.use)) warn("flow-source", `variable ${v.name}: its source is the use \`${s.use}\`, which no state declares in \`tools\`, so it can never be set`, blockLine);
      }
    }
    if (a["note"] !== undefined) {
      if (typeof a["note"] !== "string") err("flow-attr", `variable ${v.name}: \`note\` is not a string`, blockLine);
      else entry.note = a["note"];
    }
    vars.set(v.name, entry);
    const p: Schema = { type: typeOfDefault(v.default), default: v.default };
    if (entry.note !== "") p.description = entry.note;
    properties[v.name] = p;
  }

  // transitions and Gemflow's keys on them
  const transitions: Transition[] = [];
  const pairs = new Set<string>();
  for (const t of m.transitions) {
    const tr: Transition = {
      index: t.index, name: t.name, line: blockLine, from: t.from, to: t.to,
      judge: t.guard === undefined ? "none" : t.guard.kind === "text" ? "model" : "machine",
      reads: t.reads, approval: false, resets: t.resets, note: "",
    };
    if (t.guard !== undefined) tr.guard = t.guard;
    const a = t.attrs;
    if (a["approval"] !== undefined) {
      if (a["approval"] !== true) err("flow-attr", `${t.name}: \`approval\` is not true`, blockLine);
      else tr.approval = true;
    }
    if (a["note"] !== undefined) {
      if (typeof a["note"] !== "string") err("flow-attr", `${t.name}: \`note\` is not a string`, blockLine);
      else tr.note = a["note"];
    }
    if (a["label"] !== undefined) {
      if (typeof a["label"] !== "string" || a["label"].trim() === "") err("flow-attr", `${t.name}: \`label\` is not a non-empty string`, blockLine);
      else tr.label = a["label"].trim();
    }
    const pair = `${t.from}→${t.to}`;
    if (pairs.has(pair)) err("flow-dup-edge", `${t.name}: a second transition between ${t.from} and ${t.to}; the journal names a transition by its pair`, blockLine);
    pairs.add(pair);
    transitions.push(tr);
  }

  // one machine-judged, approval-free transition out of a state at most; cycles of them warn
  const autoFrom = new Map<string, Transition[]>();
  for (const t of transitions) if (t.judge === "machine" && !t.approval) autoFrom.set(t.from, [...(autoFrom.get(t.from) ?? []), t]);
  for (const [from, ts] of autoFrom) if (ts.length > 1) err("flow-auto-ambiguous", `state ${from} has ${ts.length} machine-judged transitions out (${ts.map((t) => t.name).join(", ")}); at most one may leave a state on its own`, blockLine);
  if (hasErrors(diagnostics)) return { diagnostics };
  const walked = new Set<string>();
  for (const start of states.keys()) {
    const path: Transition[] = [];
    const position = new Map<string, number>();
    for (let cur: string | undefined = start; cur !== undefined && !walked.has(cur); ) {
      position.set(cur, path.length);
      const t: Transition | undefined = autoFrom.get(cur)?.[0];
      if (!t) break;
      path.push(t);
      const lap = position.get(t.to);
      if (lap !== undefined) {
        const ring = path.slice(lap);
        warn("flow-auto-cycle", `machine-judged transitions form a cycle: ${ring.map((x) => x.from).join(" → ")} → ${ring[0]!.from}; if their guards ever hold together, the supervisor stops at the first state it would enter twice`, blockLine);
        break;
      }
      cur = t.to;
    }
    for (const id of position.keys()) walked.add(id);
  }

  const sc: Statechart = {
    file, hash: hashText(src), initial: m.initial, states, transitions, vars,
    varsSchema: { type: "object", properties, additionalProperties: false },
    signalVars: new Set([...vars.values()].filter((v) => v.source !== undefined).map((v) => v.name)),
    rules: new Set([...states.values()].flatMap((st) => st.rules)),
    unit, contextBudget: DEFAULT_CONTEXT_BUDGET, model: m,
  };
  return { statechart: sc, diagnostics };
}

export function outgoing(sc: Statechart, stateId: string): Transition[] {
  return sc.transitions.filter((t) => t.from === stateId);
}

/** The variables the model may `set`: those without a source. */
export function modelVars(sc: Statechart): string[] {
  return [...sc.vars.values()].filter((v) => v.source === undefined).map((v) => v.name);
}

/** The variables whose source is `kind`. */
export function varsBySource<K extends Source["kind"]>(sc: Statechart, kind: K): (Var & { source: Extract<Source, { kind: K }> })[] {
  return [...sc.vars.values()].filter((v): v is Var & { source: Extract<Source, { kind: K }> } => v.source?.kind === kind);
}

/** A source as the status and the board name it: `tool:test`, `file:out/*.mp4`, `git:pr-open`, `human`, `elapsed:PT2H`. */
export function sourceLabel(s: Source): string {
  switch (s.kind) {
    case "tool": return `tool:${s.use}`;
    case "file": return `file:${s.glob}`;
    case "git": return `git:${s.fact}`;
    case "human": return "human";
    case "elapsed": return `elapsed:${s.iso}`;
  }
}

/** The states that declare `use`; a use declared anywhere is usable only in them (spec §4.2). */
export function statesDeclaring(sc: Statechart, use: string): string[] {
  return [...sc.states.values()].filter((s) => s.uses.includes(use)).map((s) => s.id);
}

/** Every use some state declares. */
export function declaredUses(sc: Statechart): Set<string> {
  return new Set([...sc.states.values()].flatMap((s) => s.uses));
}
