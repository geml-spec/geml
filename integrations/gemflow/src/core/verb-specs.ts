// The three model verbs of spec §8.5 as every tool host lists them: the Claude
// Code hooks module registers them, `gemflow mcp` serves them. The schemas are
// static — a tool list that changed with the state would invalidate the
// prompt cache — so `status` says what the current state offers.
export type VerbName = "status" | "move" | "set";

export interface FlowToolSpec {
  name: VerbName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** How Claude Code lists a tool the gemflow plugin registers: an MCP client's `mcp__<server>__<tool>`, the server being `gemflow`. */
export const OWN_TOOL_PREFIX = "mcp__gemflow__";

const NONE: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: false };

export const FLOW_TOOLS: readonly FlowToolSpec[] = [
  {
    name: "status",
    description: "Where this project's Gemflow workflow stands: the work item, the current state, every variable, each way out with whether its guard holds, and the current stage's text (.geml/context.geml #current). Read-only.",
    inputSchema: NONE,
  },
  {
    name: "move",
    description: "Take a transition out of the current state (status lists them): one whose guard is a sentence you judge, or one with no guard. A machine-judged transition is taken on its own when its guard holds; one that needs a person is theirs — they approve it on the Gemflow board or with `gemflow advance <state>`.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "The target state." } },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "set",
    description: "Record workflow variables, by name. Variables with a source (test results, PR and CI state, a person's checks) are evidence and not yours to write; a value of the wrong type writes nothing.",
    inputSchema: { type: "object", description: "The variables to record, each under its own name.", additionalProperties: true },
  },
];

const OWN_TOOL_NAMES: ReadonlySet<string> = new Set(FLOW_TOOLS.flatMap((t) => [t.name, `${OWN_TOOL_PREFIX}${t.name}`, `gemflow_${t.name}`]));

/**
 * Whether gemflow answers this tool itself: one of the three verbs, bare (as
 * `gemflow mcp` names them), as Claude Code lists them (`mcp__gemflow__move`),
 * or as dsh and pi register them (`gemflow_move`).
 */
export function isOwnTool(name: string): boolean {
  return OWN_TOOL_NAMES.has(name);
}

/** The bare verb of an own tool's name. */
export function verbOf(name: string): VerbName | undefined {
  const bare = name.startsWith(OWN_TOOL_PREFIX) ? name.slice(OWN_TOOL_PREFIX.length) : name.startsWith("gemflow_") ? name.slice("gemflow_".length) : name;
  return FLOW_TOOLS.some((t) => t.name === bare) ? (bare as VerbName) : undefined;
}
