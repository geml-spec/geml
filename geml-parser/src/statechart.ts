// geml-statechart/v1 — a statechart in one `diagram` block
// (spec/profiles/geml-statechart/geml-statechart-profile.md).
//
// The core keeps a diagram body raw (§7). This module is what a processor that
// recognizes the vocabulary reads the body WITH: it turns the JSON into one
// model the checks, the renderer and the Markdown projection all share, and
// names what is wrong with it in the vocabulary's own codes (profile §3). It
// imports no node:* module — the viewer bundles it — and reads no file: a
// caller resolves `data=` and the `#id` guards and hands the values in.
import { type Value } from "./attrs.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type StatechartCode =
  | "statechart-body"
  | "statechart-initial"
  | "statechart-state"
  | "statechart-transition"
  | "statechart-guard"
  | "statechart-actions"
  | "statechart-vars"
  | "statechart-current"
  | "statechart-final"
  | "statechart-unreachable"
  | "statechart-dead-end";

/** Profile §3: every code and its severity — the table a second implementation copies. */
export const STATECHART_SEVERITY: Record<StatechartCode, "error" | "warning"> = {
  "statechart-body": "error",
  "statechart-initial": "error",
  "statechart-state": "error",
  "statechart-transition": "error",
  "statechart-guard": "error",
  "statechart-actions": "error",
  "statechart-vars": "error",
  "statechart-current": "error",
  "statechart-final": "error",
  "statechart-unreachable": "warning",
  "statechart-dead-end": "warning",
};

export interface StatechartDiagnostic { severity: "error" | "warning"; code: StatechartCode; message: string }

export interface StateNode {
  id: string;
  /** `title`, or the id when none is written. */
  title: string;
  description?: string;
  /** `final: true`: a state the chart ends in, with no transition out (profile §2.1). */
  final: boolean;
  /** Every other key: the program's, shown as written. */
  attrs: JsonObject;
}
export interface VarDef { name: string; default: JsonValue; attrs: JsonObject }
/** The three ways to write a guard (profile §2.3). */
export type Guard =
  | { kind: "schema"; schema: JsonObject }
  | { kind: "ref"; ref: string; schema: JsonObject | null }
  | { kind: "text"; text: string };
export interface Transition {
  index: number;
  from: string;
  to: string;
  /** `from→to`, with `[n]` when the pair has several transitions (profile §2.2). */
  name: string;
  guard?: Guard;
  actions: JsonValue[];
  /** The variables `reset` actions return to their default. */
  resets: string[];
  /** The variables a schema or reference guard reads. */
  reads: string[];
  attrs: JsonObject;
}
export interface StatechartModel {
  initial: string;
  current?: string;
  states: StateNode[];
  vars: VarDef[];
  transitions: Transition[];
  /** The states marked `final`. */
  finals: string[];
  /** The top-level keys that are not the format's. */
  attrs: JsonObject;
}

export interface StatechartInput {
  /** The block's body, verbatim. */
  body: string;
  attrs: Record<string, Value>;
  /**
   * The value of the `data` block `data=` names, when the caller resolved it.
   * Left out when `data=` is absent; `null` when it names nothing readable.
   */
  dataValue?: JsonValue | null;
  /** A `#id` or `doc.geml#id` guard reference → the named `data` block's value, or `undefined`. */
  resolveRef?: (ref: string) => JsonValue | undefined;
}
export interface StatechartResult { model: StatechartModel | null; diagnostics: StatechartDiagnostic[] }

const NAME = /^[\p{L}\p{N}_-]+$/u;
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: Value | undefined): string | undefined => (v === undefined ? undefined : typeof v === "string" ? v : String(v));
/** Profile §2.5: a `#id`, or `doc.geml#id`. */
export const isReference = (s: string): boolean => s.startsWith("#") || /^[^#\s]+\.geml#./.test(s);

export function buildStatechart(input: StatechartInput): StatechartResult {
  const diagnostics: StatechartDiagnostic[] = [];
  const report = (code: StatechartCode, message: string) => diagnostics.push({ severity: STATECHART_SEVERITY[code], code, message });
  const fail = (): StatechartResult => ({ model: null, diagnostics });

  // ---- the definition: the body, or the data block `data=` names (§2.8) ----
  let def: unknown;
  const hasBody = input.body.trim() !== "";
  if (input.attrs["data"] !== undefined) {
    if (hasBody) { report("statechart-body", "the definition is in the body and in `data=` at once; write it in one place"); return fail(); }
    if (!isObject(input.dataValue)) { report("statechart-body", `\`data=${str(input.attrs["data"])}\` does not name a \`data\` block whose value is an object`); return fail(); }
    def = input.dataValue;
  } else {
    try { def = JSON.parse(input.body); } catch (e) { report("statechart-body", `the body is not JSON: ${(e as Error).message}`); return fail(); }
    if (!isObject(def)) { report("statechart-body", "the body is not a JSON object"); return fail(); }
  }
  const root = def as JsonObject;

  // ---- states ----------------------------------------------------------------
  const states: StateNode[] = [];
  const rawStates = root["states"];
  if (!isObject(rawStates)) {
    report("statechart-state", "`states` is missing or is not an object");
  } else {
    for (const [id, s] of Object.entries(rawStates)) {
      if (!NAME.test(id)) { report("statechart-state", `state id ${JSON.stringify(id)} is not a NAME (letters, digits, \`_\`, \`-\`)`); continue; }
      if (!isObject(s)) { report("statechart-state", `state \`${id}\` is not an object`); continue; }
      for (const k of ["states", "regions", "initial"]) {
        if (k in s) report("statechart-state", `state \`${id}\` carries \`${k}\`, which v1 reserves for v2 (hierarchy and parallel regions)`);
      }
      const title = s["title"];
      const description = s["description"];
      const final = s["final"];
      if (title !== undefined && typeof title !== "string") report("statechart-state", `state \`${id}\`: \`title\` is not a string`);
      if (description !== undefined && typeof description !== "string") report("statechart-state", `state \`${id}\`: \`description\` is not a string`);
      if (final !== undefined && typeof final !== "boolean") report("statechart-state", `state \`${id}\`: \`final\` is not a boolean`);
      const attrs: JsonObject = {};
      for (const [k, v] of Object.entries(s)) if (!["title", "description", "final", "states", "regions", "initial"].includes(k)) attrs[k] = v;
      const node: StateNode = { id, title: typeof title === "string" ? title : id, final: final === true, attrs };
      if (typeof description === "string") node.description = description;
      states.push(node);
    }
  }
  const stateIds = new Set(states.map((s) => s.id));

  // ---- initial, current --------------------------------------------------------
  const initial = root["initial"];
  if (typeof initial !== "string") report("statechart-initial", "`initial` is missing or is not a string");
  else if (isObject(rawStates) && !stateIds.has(initial)) report("statechart-initial", `\`initial\` names \`${initial}\`, which is not a state`);
  const current = str(input.attrs["current"]);
  if (current !== undefined && isObject(rawStates) && !stateIds.has(current)) report("statechart-current", `\`current=${current}\` is not a state`);

  // ---- vars ----------------------------------------------------------------------
  const vars: VarDef[] = [];
  const rawVars = root["vars"];
  if (rawVars !== undefined) {
    if (!isObject(rawVars)) report("statechart-vars", "`vars` is not an object");
    else {
      for (const [name, v] of Object.entries(rawVars)) {
        if (!NAME.test(name)) { report("statechart-vars", `variable name ${JSON.stringify(name)} is not a NAME`); continue; }
        if (!isObject(v)) { report("statechart-vars", `variable \`${name}\` is not an object`); continue; }
        if (!("default" in v)) { report("statechart-vars", `variable \`${name}\` has no \`default\``); continue; }
        const attrs: JsonObject = {};
        for (const [k, val] of Object.entries(v)) if (k !== "default") attrs[k] = val;
        vars.push({ name, default: v["default"] as JsonValue, attrs });
      }
    }
  }
  const varNames = new Set(vars.map((v) => v.name));
  const varsKnown = rawVars === undefined || isObject(rawVars);

  // ---- transitions -----------------------------------------------------------
  const transitions: Transition[] = [];
  const rawTransitions = root["transitions"];
  if (!Array.isArray(rawTransitions)) {
    report("statechart-transition", "`transitions` is missing or is not an array");
  } else {
    const perPair = new Map<string, number>();
    rawTransitions.forEach((t, index) => {
      if (!isObject(t)) { report("statechart-transition", `transition ${index + 1} is not an object`); return; }
      const from = t["from"];
      const to = t["to"];
      let ok = true;
      for (const [k, v] of [["from", from], ["to", to]] as const) {
        if (typeof v !== "string") { report("statechart-transition", `transition ${index + 1}: \`${k}\` is missing`); ok = false; }
        else if (isObject(rawStates) && !stateIds.has(v)) { report("statechart-transition", `transition ${index + 1}: \`${k}\` names \`${v}\`, which is not a state`); ok = false; }
      }
      if ("event" in t) { report("statechart-transition", `transition ${index + 1} carries \`event\`, which v1 reserves for v2`); ok = false; }
      if (!ok) return;
      const pair = `${from as string}→${to as string}`;
      const n = (perPair.get(pair) ?? 0) + 1;
      perPair.set(pair, n);
      const name = n === 1 ? pair : `${pair}[${n}]`;

      // the guard (§2.3)
      let guard: Guard | undefined;
      let reads: string[] = [];
      const g = t["guard"];
      if (g !== undefined) {
        if (isObject(g)) {
          const problems = schemaProblems(g, "guard");
          for (const p of problems) report("statechart-guard", `${name}: ${p}`);
          if (problems.length === 0) { guard = { kind: "schema", schema: g }; reads = readsOf(g); }
        } else if (typeof g === "string" && isReference(g)) {
          const target = input.resolveRef?.(g);
          if (target === undefined) { report("statechart-guard", `${name}: \`${g}\` does not resolve to a \`data\` block`); guard = { kind: "ref", ref: g, schema: null }; }
          else if (!isObject(target)) { report("statechart-guard", `${name}: \`${g}\` is not a \`data\` block whose value is an object`); guard = { kind: "ref", ref: g, schema: null }; }
          else {
            const problems = schemaProblems(target, g);
            for (const p of problems) report("statechart-guard", `${name}: ${p}`);
            guard = { kind: "ref", ref: g, schema: problems.length === 0 ? target : null };
            if (problems.length === 0) reads = readsOf(target);
          }
        } else if (typeof g === "string") {
          guard = { kind: "text", text: g };
        } else {
          report("statechart-guard", `${name}: \`guard\` is neither an object nor a string`);
        }
        if (varsKnown) for (const v of reads) if (!varNames.has(v)) report("statechart-guard", `${name}: the guard reads \`${v}\`, which is not in \`vars\``);
      }

      // the actions (§2.4)
      const resets: string[] = [];
      let actions: JsonValue[] = [];
      const a = t["actions"];
      if (a !== undefined) {
        if (!Array.isArray(a)) report("statechart-actions", `${name}: \`actions\` is not an array`);
        else {
          actions = a;
          for (const item of a) {
            if (!isObject(item)) continue;
            if ("set" in item) report("statechart-actions", `${name}: an action with \`set\` is reserved for v2`);
            if ("reset" in item) {
              const r = item["reset"];
              if (!Array.isArray(r) || !r.every((x) => typeof x === "string")) { report("statechart-actions", `${name}: \`reset\` is not an array of names`); continue; }
              for (const v of r as string[]) {
                if (varsKnown && !varNames.has(v)) report("statechart-actions", `${name}: \`reset\` names \`${v}\`, which is not in \`vars\``);
                else resets.push(v);
              }
            }
          }
        }
      }

      const attrs: JsonObject = {};
      for (const [k, v] of Object.entries(t)) if (!["from", "to", "guard", "actions", "event"].includes(k)) attrs[k] = v;
      const tr: Transition = { index, from: from as string, to: to as string, name, actions, resets, reads, attrs };
      if (guard !== undefined) tr.guard = guard;
      transitions.push(tr);
    });
  }

  // ---- final states have no way out -----------------------------------------------
  const finalIds = new Set(states.filter((s) => s.final).map((s) => s.id));
  for (const t of transitions) if (finalIds.has(t.from)) report("statechart-final", `${t.name}: \`${t.from}\` is marked final, and a final state has no transition out`);

  if (diagnostics.some((d) => d.severity === "error")) return fail();

  // ---- reachability (warning), finals --------------------------------------------
  const start = initial as string;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const s = queue.shift() as string;
    for (const t of transitions) if (t.from === s && !seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
  }
  for (const s of states) if (!seen.has(s.id)) report("statechart-unreachable", `state \`${s.id}\` cannot be reached from \`${start}\``);
  const hasOut = new Set(transitions.map((t) => t.from));
  for (const s of states) if (!s.final && !hasOut.has(s.id)) report("statechart-dead-end", `state \`${s.id}\` has no transition out and is not marked final`);
  const finals = states.filter((s) => s.final).map((s) => s.id);

  const attrs: JsonObject = {};
  for (const [k, v] of Object.entries(root)) if (!["initial", "states", "vars", "transitions"].includes(k)) attrs[k] = v;
  const model: StatechartModel = { initial: start, states, vars, transitions, finals, attrs };
  if (current !== undefined) model.current = current;
  return { model, diagnostics };
}

// ---- the JSON Schema subset (profile §4) -----------------------------------------
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYWORDS = new Set(["type", "oneOf", "anyOf", "properties", "required", "additionalProperties", "items", "enum", "const", "title", "description", "default", "examples"]);
const isScalar = (v: unknown): boolean => v === null || ["string", "number", "boolean"].includes(typeof v);
function fits(v: unknown, type: string | undefined): boolean {
  if (type === undefined) return true;
  if (v === null) return type === "null";
  if (type === "integer") return typeof v === "number" && Number.isInteger(v);
  if (type === "number") return typeof v === "number";
  return typeof v === type;
}

/** Every way `raw` steps outside the subset, as messages; empty when it is a schema of the subset. */
export function schemaProblems(raw: unknown, path: string): string[] {
  const out: string[] = [];
  if (!isObject(raw)) { out.push(`${path}: a schema must be an object`); return out; }
  for (const k of Object.keys(raw)) if (!KEYWORDS.has(k)) out.push(`${path}: unsupported keyword ${JSON.stringify(k)}`);
  const type = raw["type"];
  if (type !== undefined && (typeof type !== "string" || !TYPES.has(type))) out.push(`${path}: \`type\` must be one of ${[...TYPES].join(", ")}`);
  const t = typeof type === "string" ? type : undefined;
  const props = raw["properties"];
  if (props !== undefined) {
    if (!isObject(props)) out.push(`${path}: \`properties\` must be an object`);
    else for (const [k, v] of Object.entries(props)) out.push(...schemaProblems(v, `${path}.properties.${k}`));
  }
  const req = raw["required"];
  if (req !== undefined && (!Array.isArray(req) || !req.every((x) => typeof x === "string"))) out.push(`${path}: \`required\` must be an array of names`);
  const ap = raw["additionalProperties"];
  if (ap !== undefined && typeof ap !== "boolean") out.push(`${path}: \`additionalProperties\` must be a boolean`);
  if (raw["items"] !== undefined) out.push(...schemaProblems(raw["items"], `${path}.items`));
  const en = raw["enum"];
  if (en !== undefined) {
    if (!Array.isArray(en) || en.length === 0 || !en.every(isScalar)) out.push(`${path}: \`enum\` must be a non-empty array of scalars`);
    else if (!en.every((v) => fits(v, t))) out.push(`${path}: an \`enum\` value does not fit \`type\``);
  }
  if ("const" in raw) {
    if (!isScalar(raw["const"])) out.push(`${path}: \`const\` must be a scalar`);
    else if (!fits(raw["const"], t)) out.push(`${path}: \`const\` does not fit \`type\``);
  }
  for (const k of ["oneOf", "anyOf"]) {
    const branches = raw[k];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length < 2) { out.push(`${path}: \`${k}\` needs at least two branches`); continue; }
    branches.forEach((b, i) => out.push(...schemaProblems(b, `${path}.${k}[${i}]`)));
  }
  for (const k of ["title", "description"]) if (raw[k] !== undefined && typeof raw[k] !== "string") out.push(`${path}: \`${k}\` must be a string`);
  return out;
}

/** The variable names a guard reads: its root `properties` and `required`, through every `anyOf` / `oneOf` branch. */
export function readsOf(schema: JsonObject): string[] {
  const out = new Set<string>();
  const walk = (s: JsonObject): void => {
    const props = s["properties"];
    if (isObject(props)) for (const k of Object.keys(props)) out.add(k);
    const req = s["required"];
    if (Array.isArray(req)) for (const r of req) if (typeof r === "string") out.add(r);
    for (const k of ["anyOf", "oneOf"]) {
      const branches = s[k];
      if (Array.isArray(branches)) for (const b of branches) if (isObject(b)) walk(b);
    }
  };
  walk(schema);
  return [...out].sort();
}

/** Does the instance — variable name → value — satisfy the subset schema? */
export function holds(schema: JsonObject, instance: JsonValue): boolean {
  const type = schema["type"];
  if (typeof type === "string" && !fits(instance, type)) return false;
  if ("const" in schema && !same(schema["const"] as JsonValue, instance)) return false;
  const en = schema["enum"];
  if (Array.isArray(en) && !en.some((v) => same(v, instance))) return false;
  const props = schema["properties"];
  if (isObject(props)) {
    if (!isObject(instance)) return false;
    for (const [k, sub] of Object.entries(props)) if (k in instance && isObject(sub) && !holds(sub, instance[k] as JsonValue)) return false;
  }
  const req = schema["required"];
  if (Array.isArray(req)) {
    if (!isObject(instance)) return false;
    for (const r of req) if (typeof r === "string" && !(r in instance)) return false;
  }
  if (schema["additionalProperties"] === false && isObject(instance)) {
    const allowed = isObject(props) ? new Set(Object.keys(props)) : new Set<string>();
    for (const k of Object.keys(instance)) if (!allowed.has(k)) return false;
  }
  const items = schema["items"];
  if (isObject(items)) {
    if (!Array.isArray(instance)) return false;
    for (const it of instance) if (!holds(items, it)) return false;
  }
  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf) && !anyOf.some((b) => isObject(b) && holds(b, instance))) return false;
  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf) && oneOf.filter((b) => isObject(b) && holds(b, instance)).length !== 1) return false;
  return true;
}
const same = (a: JsonValue, b: JsonValue): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---- for people: the edge label and the guard read out (§2.6) ----------------------
/** What the picture writes on the edge: the variables a machine guard reads, a reference's id, a sentence as written. */
export function edgeLabel(t: Transition): string {
  const g = t.guard;
  if (g === undefined) return "";
  if (g.kind === "text") return g.text;
  if (g.kind === "ref") return g.ref.slice(g.ref.indexOf("#") + 1);
  return t.reads.join(", ");
}

/** A schema guard in words: `reviewed = true and approvals ∈ {2, 3}`. */
export function guardText(g: Guard): string {
  if (g.kind === "text") return g.text;
  const schema = g.kind === "ref" ? g.schema : g.schema;
  if (schema === null) return g.kind === "ref" ? g.ref : "";
  const one = (s: JsonObject): string => {
    const parts: string[] = [];
    const props = s["properties"];
    if (isObject(props)) {
      for (const [k, sub] of Object.entries(props)) {
        if (!isObject(sub)) continue;
        if ("const" in sub) parts.push(`${k} = ${JSON.stringify(sub["const"])}`);
        else if (Array.isArray(sub["enum"])) parts.push(`${k} ∈ {${(sub["enum"] as JsonValue[]).map((v) => JSON.stringify(v)).join(", ")}}`);
        else if (typeof sub["type"] === "string") parts.push(`${k}: ${sub["type"]}`);
        else parts.push(k);
      }
    }
    const req = s["required"];
    if (Array.isArray(req)) for (const r of req) if (typeof r === "string" && !(isObject(props) && r in props)) parts.push(r);
    for (const k of ["anyOf", "oneOf"]) {
      const branches = s[k];
      if (Array.isArray(branches)) parts.push("(" + branches.filter(isObject).map(one).join(k === "anyOf" ? " or " : " xor ") + ")");
    }
    return parts.join(" and ");
  };
  return one(schema);
}

// ---- the Mermaid projection (§2.7) ----------------------------------------------------
const MERMAID_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A `stateDiagram-v2` of the model: GitHub draws it, the HTML renderer hands it to the page's Mermaid. */
export function mermaidOf(model: StatechartModel): string {
  const alias = new Map<string, string>();
  const lines = ["stateDiagram-v2"];
  model.states.forEach((s, i) => {
    const id = MERMAID_ID.test(s.id) ? s.id : `s${i}`;
    alias.set(s.id, id);
    if (id !== s.id || s.title !== s.id) lines.push(`    state "${s.title.replace(/"/g, "'")}" as ${id}`);
  });
  const name = (id: string): string => alias.get(id) ?? id;
  lines.push(`    [*] --> ${name(model.initial)}`);
  for (const t of model.transitions) {
    const label = edgeLabel(t).replace(/[#:\n]/g, " ").trim();
    lines.push(`    ${name(t.from)} --> ${name(t.to)}${label === "" ? "" : ` : ${label}`}`);
  }
  for (const f of model.finals) lines.push(`    ${name(f)} --> [*]`);
  return lines.join("\n");
}
