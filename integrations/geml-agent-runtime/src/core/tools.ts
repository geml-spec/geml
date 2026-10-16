// The three agent_* tools' model-facing shape, derived from (statechart,
// snapshot). Pure data: the plugin hands it to DSH's `defineTool`. Everything
// here is recomputed whenever σ changes, which is what makes gate 2 —
// "agent_transition's `to` enum = outgoing(σ)" — true by construction rather
// than by a check somewhere later.
//
// One DSH constraint is load-bearing and MEASURED, not assumed: `defineTool`
// refuses an object schema that does not state `additionalProperties`
// (UNSUPPORTED_SCHEMA, harness 0.1.5-rc.1). JSON Schema's own default is open,
// so our validator accepts such a schema and DSH does not — the divergence is
// pinned by `test/dsh-parity.test.mjs`. Every object this module emits closes
// itself, which is how the two live together without our validator drifting
// away from JSON Schema.
import type { Schema } from "./schema.js";
import type { Snapshot } from "./snapshot.js";
import { allowedVars, outgoing, type Statechart } from "./statechart.js";

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

/** The result envelope an agent_* tool returns — closed, as DSH requires. */
function outputSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties };
}

/** One variable's declared schema, projected onto DSH's parameter vocabulary. */
export function toParamEntry(name: string, schema: Schema): ParamEntry {
  const entry: ParamEntry = {
    type: schema.type ?? "string",
    description: schema.description ?? `the ${name} variable`,
  };
  if (schema.enum) entry.enum = [...schema.enum];
  if (schema.items) entry.items = schema.items;
  if (schema.type === "object") {
    entry.properties = schema.properties ?? {};
    entry.additionalProperties = schema.additionalProperties ?? false;
  }
  return entry;
}

/**
 * The transition tool for one state, or null when the state has no outgoing
 * edge — a final state offers the model no way forward, and a tool whose enum
 * would be empty is worse than an absent one.
 */
export function transitionSpec(sc: Statechart, snap: Snapshot): ToolSpec | null {
  const edges = outgoing(sc, snap.state);
  if (edges.length === 0) return null;
  const lines = edges.map((t) => {
    const notes: string[] = [];
    if (t.requiresId) notes.push(`requires #${t.requiresId}`);
    if (t.approval) notes.push("needs approval");
    return `#${t.id} → #${t.to}: ${t.body}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  });
  return {
    name: "agent_transition",
    description:
      "Move this workflow to its next state. Only the targets listed below exist right now, and the list changes with the state. A guard that does not hold refuses the move and nothing is recorded.\n" +
      lines.join("\n"),
    parameters: {
      to: {
        type: "string",
        required: true,
        description: "The target state, written without the leading #.",
        enum: edges.map((t) => t.to),
      },
    },
    output: {
      schema: outputSchema({
        from: { type: "string" },
        to: { type: "string" },
        rev: { type: "integer" },
        hash: { type: "string" },
      }),
    },
  };
}

/**
 * The variable-writing tool for one state, or null when the state may write
 * nothing (`vars=none`) or the statechart declares no variables.
 */
export function setSpec(sc: Statechart, snap: Snapshot): ToolSpec | null {
  const state = sc.states.get(snap.state);
  if (!state || !sc.vars) return null;
  const parameters: ParamSpec = {};
  for (const name of allowedVars(sc, state)) {
    const schema = sc.vars.properties?.[name];
    if (schema) parameters[name] = toParamEntry(name, schema);
  }
  if (Object.keys(parameters).length === 0) return null;
  return {
    name: "agent_set",
    description:
      "Record one or more of this workflow's variables. Send only the ones you are changing; the rest keep their values. A value that fails the workflow's schema is rejected and nothing is written.",
    parameters,
    output: {
      schema: outputSchema({
        rev: { type: "integer" },
        hash: { type: "string" },
        vars: { type: "object", additionalProperties: true },
      }),
    },
  };
}

/**
 * The rollback tool. `to` is a string rather than a number-or-literal union
 * because DSH's parameter spec gives one parameter exactly one `type`; the
 * plugin parses `"3"` and `"checkpoint"` and refuses anything else.
 */
export function rollbackSpec(): ToolSpec {
  return {
    name: "agent_rollback",
    description:
      'Undo workflow state: restore the variables and the state of an earlier revision. "checkpoint" returns to the revision at which the current state was entered. This undoes RECORDED state only — it cannot undo an effect a tool already had in the outside world.',
    parameters: {
      to: {
        type: "string",
        required: true,
        description: 'A revision number as a string (for example "3"), or "checkpoint".',
      },
    },
    output: {
      schema: outputSchema({
        rev: { type: "integer" },
        restores: { type: "integer" },
        state: { type: "string" },
        hash: { type: "string" },
      }),
    },
  };
}
