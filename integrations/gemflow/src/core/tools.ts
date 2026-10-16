// The verbs' model-facing shape for a host that registers tools per state
// (dsh), derived from (statechart, snapshot). Pure data. Everything here is
// recomputed whenever the state changes, which is what makes "`move`'s `to`
// enum = the transitions the model may take" true by construction.
//
// One DSH constraint is load-bearing and MEASURED: `defineTool` refuses an
// object schema that does not state `additionalProperties`; every object this
// module emits closes itself (test/dsh-parity.test.mjs pins it).
import type { Schema } from "./schema.js";
import type { Snapshot } from "./snapshot.js";
import { modelVars, outgoing, type Statechart } from "./statechart.js";
import { describeTransitions } from "./prompt.js";

/** One parameter as DSH's parameter spec spells it. */
export interface ParamEntry {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
  required?: true;
  description: string;
  enum?: (string | number | boolean | null)[];
  items?: unknown;
  properties?: unknown;
  additionalProperties?: boolean;
}
export type ParamSpec = Record<string, ParamEntry>;

/** Everything the plugin needs to register one tool. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: ParamSpec;
  output: { schema: Record<string, unknown> };
}

const entered = (): Record<string, unknown> => ({ type: "array", items: { type: "string" } });

function outputSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties };
}

/** One variable's declared schema, projected onto DSH's parameter vocabulary. */
export function toParamEntry(name: string, schema: Schema): ParamEntry {
  const entry: ParamEntry = { type: schema.type ?? "string", description: schema.description ?? `the ${name} variable` };
  if (schema.enum) entry.enum = [...schema.enum];
  if (schema.items) entry.items = schema.items;
  if (schema.type === "object") {
    entry.properties = schema.properties ?? {};
    entry.additionalProperties = schema.additionalProperties ?? false;
  }
  return entry;
}

export function statusSpec(): ToolSpec {
  return {
    name: "gemflow_status",
    description: "Where the workflow stands: the state, the variables, the ways out and whether their guards hold. Read-only.",
    parameters: {},
    output: { schema: outputSchema({ text: { type: "string" } }) },
  };
}

/**
 * The move tool for one state, or null when the model may take no transition
 * out of it — a machine-judged one is taken on its own, one with approval by
 * a person, and a tool whose enum would be empty is worse than an absent one.
 */
export function moveSpec(sc: Statechart, snap: Snapshot): ToolSpec | null {
  const edges = outgoing(sc, snap.state).filter((t) => !t.approval && t.judge !== "machine");
  if (edges.length === 0) return null;
  return {
    name: "gemflow_move",
    description: `Take a transition out of ${snap.state}:\n${describeTransitions(sc, snap.state)}`,
    parameters: { to: { type: "string", required: true, description: "The target state.", enum: edges.map((t) => t.to) } },
    output: { schema: outputSchema({ from: { type: "string" }, to: { type: "string" }, state: { type: "string" }, entered: entered(), rev: { type: "integer" }, hash: { type: "string" } }) },
  };
}

/** The set tool: one parameter per variable the model may write; null when there is none. */
export function setSpec(sc: Statechart, snap: Snapshot): ToolSpec | null {
  const names = modelVars(sc);
  if (names.length === 0) return null;
  const parameters: ParamSpec = {};
  for (const name of names) {
    const schema = sc.varsSchema.properties?.[name];
    if (schema) parameters[name] = toParamEntry(name, schema);
  }
  return {
    name: "gemflow_set",
    description: `Record workflow variables in ${snap.state}: ${names.join(", ")}. Variables with a source are evidence and not yours.`,
    parameters,
    output: { schema: outputSchema({ rev: { type: "integer" }, hash: { type: "string" }, state: { type: "string" }, entered: entered(), vars: { type: "object", additionalProperties: true } }) },
  };
}
