// Load a `geml-agent/v1` statechart from GEML text and check it statically.
// Pure: text in, model + diagnostics out. The host reads the file.
import { createHash } from "node:crypto";
import { parse, unitSpans, sliceUnit, type Block, type Diagnostic } from "@geml/geml";
import { assertSchema, SchemaError, type Schema } from "./schema.js";

export interface State {
  id: string; line: number;
  initial: boolean; final: boolean; pause: boolean; rollbackOnError: boolean;
  /** Global tool names visible here; undefined = inherit the document default. */
  tools?: string[];
  /** Variables the model may set here; undefined = all. */
  vars?: string[];
  /** The body, byte for byte, without the trailing newline. */
  body: string;
}
export interface Transition {
  id: string; line: number; from: string; to: string;
  requiresId?: string; requires?: Schema; approval: boolean; body: string;
}
export interface Statechart {
  file: string; hash: string; initial: string;
  states: Map<string, State>; transitions: Transition[];
  vars?: Schema; defaultTools?: string[];
}
export type AgentCode =
  | "agent-no-initial" | "agent-many-initial" | "agent-bad-ref" | "agent-final-outgoing" | "agent-dup-edge"
  | "agent-vars-schema" | "agent-requires-schema" | "agent-unknown-var"
  | "agent-unreachable" | "agent-dead-end" | "agent-unknown-tool";
export interface AgentDiagnostic { severity: "error" | "warning"; code: string; message: string; line: number }

type Typed = Extract<Block, { kind: "block" }>;

export function hashText(text: string): string {
  return "sha256:" + createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}

export function hasErrors(diagnostics: readonly AgentDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** Every typed block, depth first — a state may sit inside a flow body. */
function typedBlocks(blocks: readonly Block[], out: Typed[] = []): Typed[] {
  for (const b of blocks) {
    if (b.kind !== "block") continue;
    out.push(b);
    if (b.children) typedBlocks(b.children, out);
  }
  return out;
}

/** `tools="a b"` → ["a","b"]; `tools=none` → []; absent → undefined. Same for `vars`. */
function nameList(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  if (s === "none") return [];
  return s.split(/\s+/).filter((x) => x.length > 0);
}

function refId(v: unknown): string | undefined {
  return typeof v === "string" && v.startsWith("#") && v.length > 1 ? v.slice(1) : undefined;
}

/** Line numbers: the parser does not put one on a block, so recover it from the span layer. */
function lineIndex(source: string): Map<string, { line: number; body: string }> {
  const out = new Map<string, { line: number; body: string }>();
  for (const u of unitSpans(source)) {
    if (u.kind !== "block" || u.id === undefined) continue;
    out.set(u.id, { line: u.span.start + 1, body: sliceUnit(source, u.span, "body").replace(/\r?\n$/, "") });
  }
  return out;
}

export function loadStatechart(source: string, file: string, opts: { knownTools?: readonly string[] } = {}): { statechart?: Statechart; diagnostics: AgentDiagnostic[] } {
  // Normalize once, up front, and use `src` for everything below: a raw body
  // slice must never carry a `\r` that `hashText` (which normalizes) would
  // silently swallow — two checkouts of one file must produce identical bytes.
  const src = source.replace(/\r\n?/g, "\n");
  const doc = parse(src);
  const diagnostics: AgentDiagnostic[] = doc.diagnostics.map((d: Diagnostic) => ({ severity: d.severity, code: d.code, message: d.message, line: d.line }));
  const err = (code: AgentCode, message: string, line: number) => diagnostics.push({ severity: "error", code, message, line });
  const warn = (code: AgentCode, message: string, line: number) => diagnostics.push({ severity: "warning", code, message, line });
  if (hasErrors(diagnostics)) return { diagnostics };

  const where = lineIndex(src);
  const at = (id: string | undefined) => (id ? where.get(id)?.line ?? 1 : 1);
  const bodyOf = (id: string | undefined) => (id ? where.get(id)?.body ?? "" : "");
  const blocks = typedBlocks(doc.children);
  const byId = new Map<string, Typed>();
  for (const b of blocks) if (b.id) byId.set(b.id, b);

  // meta defaults
  let defaultTools: string[] | undefined;
  for (const b of blocks) {
    if (b.type === "meta" && b.data && "tools" in b.data) { defaultTools = nameList(b.data["tools"]); break; }
  }

  // variables
  let vars: Schema | undefined;
  const varBlocks = blocks.filter((b) => b.type === "agent-vars");
  if (varBlocks.length > 1) err("agent-vars-schema", `more than one agent-vars block (${varBlocks.map((b) => "#" + (b.id ?? "?")).join(", ")})`, at(varBlocks[1]?.id));
  else if (varBlocks.length === 1) {
    const b = varBlocks[0]!;
    try {
      const raw: unknown = JSON.parse((b.raw ?? []).join("\n"));
      const s = assertSchema(raw);
      if (s.type !== "object") throw new SchemaError(["$: agent-vars must have type object"]);
      vars = s;
    } catch (e) {
      const text = e instanceof SchemaError ? e.violations.join("; ") : e instanceof Error ? e.message : String(e);
      err("agent-vars-schema", `agent-vars #${b.id ?? "?"}: ${text}`, at(b.id));
    }
  }
  const varNames = new Set(Object.keys(vars?.properties ?? {}));

  // states
  const states = new Map<string, State>();
  for (const b of blocks.filter((x) => x.type === "agent-state")) {
    if (!b.id) { err("agent-bad-ref", "agent-state without an id", 1); continue; }
    const a = b.attrs;
    const st: State = {
      id: b.id, line: at(b.id),
      initial: a["initial"] === true, final: a["final"] === true, pause: a["pause"] === true,
      rollbackOnError: a["rollback-on-error"] === true,
      body: bodyOf(b.id),
    };
    const tools = nameList(a["tools"]); if (tools !== undefined) st.tools = tools;
    const vs = nameList(a["vars"]); if (vs !== undefined) st.vars = vs;
    for (const v of vs ?? []) if (!varNames.has(v)) err("agent-unknown-var", `state #${st.id}: vars= names "${v}", which agent-vars does not declare`, st.line);
    states.set(st.id, st);
  }
  const initials = [...states.values()].filter((s) => s.initial);
  if (initials.length === 0) err("agent-no-initial", "no state carries `initial`", 1);
  if (initials.length > 1) err("agent-many-initial", `more than one initial state: ${initials.map((s) => "#" + s.id).join(", ")}`, initials[1]!.line);

  // transitions
  const transitions: Transition[] = [];
  const edges = new Set<string>();
  for (const b of blocks.filter((x) => x.type === "agent-transition")) {
    const id = b.id ?? `transition@${at(b.id)}`;
    const line = at(b.id);
    const from = refId(b.attrs["from"]), to = refId(b.attrs["to"]);
    let bad = false;
    for (const [key, val] of [["from", from], ["to", to]] as const) {
      if (val === undefined) { err("agent-bad-ref", `transition #${id}: ${key}= must be #id of an agent-state`, line); bad = true; }
      else if (!states.has(val)) { err("agent-bad-ref", `transition #${id}: ${key}=#${val} is not an agent-state`, line); bad = true; }
    }
    const t: Transition = { id, line, from: from ?? "", to: to ?? "", approval: b.attrs["approval"] === true, body: bodyOf(b.id) };
    if (b.attrs["requires"] !== undefined) {
      const rid = refId(b.attrs["requires"]);
      const target = rid ? byId.get(rid) : undefined;
      if (!rid || !target || target.type !== "data") { err("agent-bad-ref", `transition #${id}: requires= must be #id of a data block`, line); bad = true; }
      else {
        try { t.requires = assertSchema(target.value); t.requiresId = rid; }
        catch (e) { err("agent-requires-schema", `transition #${id}: #${rid}: ${e instanceof SchemaError ? e.violations.join("; ") : String(e)}`, line); bad = true; }
      }
    }
    if (bad) continue;
    if (states.get(t.from)!.final) err("agent-final-outgoing", `transition #${id} leaves the final state #${t.from}`, line);
    const key = `${t.from}->${t.to}`;
    if (edges.has(key)) err("agent-dup-edge", `transition #${id} duplicates the edge #${t.from} → #${t.to}`, line);
    edges.add(key);
    transitions.push(t);
  }

  if (hasErrors(diagnostics)) return { diagnostics };

  // reachability and dead ends
  const initial = initials[0]!.id;
  const seen = new Set<string>([initial]);
  const queue = [initial];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const t of transitions) if (t.from === cur && !seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
  }
  for (const s of states.values()) {
    if (!seen.has(s.id)) warn("agent-unreachable", `state #${s.id} is not reachable from #${initial}`, s.line);
    if (!s.final && !transitions.some((t) => t.from === s.id)) warn("agent-dead-end", `state #${s.id} is not final and has no outgoing transition`, s.line);
  }
  if (opts.knownTools) {
    const known = new Set(opts.knownTools);
    for (const s of states.values()) {
      for (const name of s.tools ?? defaultTools ?? []) if (!known.has(name)) warn("agent-unknown-tool", `state #${s.id}: tool "${name}" is not registered`, s.line);
    }
  }

  const sc: Statechart = { file, hash: hashText(src), initial, states, transitions };
  if (vars) sc.vars = vars;
  if (defaultTools !== undefined) sc.defaultTools = defaultTools;
  return { statechart: sc, diagnostics };
}

export function outgoing(sc: Statechart, stateId: string): Transition[] {
  return sc.transitions.filter((t) => t.from === stateId);
}

export function effectiveTools(sc: Statechart, state: State): string[] | undefined {
  return state.tools ?? sc.defaultTools;
}

export function allowedVars(sc: Statechart, state: State): string[] {
  return state.vars ?? Object.keys(sc.vars?.properties ?? {});
}
