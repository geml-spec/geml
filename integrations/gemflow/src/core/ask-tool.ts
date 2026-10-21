// The tool the model registers a question with (MCP `ask`): what the status
// band asks the person, with the answers the model gives. A question in the
// reply the model did not register is only a grey hint, with no buttons.
// Pure, and free of @geml/geml: the hooks module imports it.

/** A question the model registered: the whole question, its answers (the recommended one first), and which it recommends. */
export interface Asked { question: string; options: string[]; recommended?: string }

/** The most answers a question offers. */
const MOST_OPTIONS = 4;

export const ASK_TOOL = {
  name: "ask",
  description: "Register a question this turn ends with, for the person to answer from the status band: the question in full, its real answers (two to four, short, in the reply's language), and the one you recommend. Call it once per question, before the turn ends, whenever the reply asks the person to decide something; several questions are asked one by one. Do not register a question you answered yourself or one that needs no answer.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, whole, as the person should read it." },
      options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: MOST_OPTIONS, description: "The answers the person can give, each a few words." },
      recommended: { type: "string", description: "The answer you recommend: one of options." },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
} as const;

/** What the model is told once, in the system prompt, about registering its questions. */
export const ASK_PROMPT = "Gemflow: when a turn ends asking the person to decide something, register each question with the gemflow `ask` tool before the turn ends: the question in full, its real answers (two to four, short, in the reply's language) and the one you recommend. The status band shows a registered question with its answers as buttons; a question you do not register shows only as a grey hint with no buttons.";

/** A tool call's input as a question, or why it is none. */
export function askedOf(input: Readonly<Record<string, unknown>>): Asked | { error: string } {
  const question = typeof input["question"] === "string" ? input["question"].trim() : "";
  if (question === "") return { error: "question is empty" };
  const given = Array.isArray(input["options"]) ? (input["options"] as unknown[]).filter((o): o is string => typeof o === "string").map((o) => o.trim()).filter((o) => o !== "") : [];
  const options = [...new Set(given)];
  if (options.length < 2 || options.length > MOST_OPTIONS) return { error: `options are two to ${MOST_OPTIONS} answers` };
  const recommended = typeof input["recommended"] === "string" ? input["recommended"].trim() : "";
  if (recommended !== "" && !options.includes(recommended)) return { error: "recommended is one of options" };
  // The recommended answer comes first: the band draws the first as the main button.
  const ordered = recommended === "" ? options : [recommended, ...options.filter((o) => o !== recommended)];
  return { question, options: ordered, ...(recommended !== "" ? { recommended } : {}) };
}
