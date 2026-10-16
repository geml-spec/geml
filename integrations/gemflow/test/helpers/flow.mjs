// Workflow and dictionary documents from their parts, for the tests: one meta
// block (the profile, `flow-unit` when given) and one geml-statechart block
// holding the JSON, with any prose or guard blocks after it.
import { renderDictionary } from "../../dist/core/dictionary-file.js";

/** A workflow document. `states`, `vars` and `transitions` are written into the block as given. */
export function flowDoc({ initial, states, vars = {}, transitions = [], unit, title = "t", extra = "" }) {
  const meta = ["=== meta", `title = ${JSON.stringify(title)}`, 'profile = "geml-statechart/v1"', ...(unit !== undefined ? [`flow-unit = ${JSON.stringify(unit)}`] : []), "===", ""];
  const body = JSON.stringify({ initial, states, vars, transitions }, null, 2);
  return [...meta, "=== diagram {#flow format=geml-statechart}", body, "===", "", extra].join("\n");
}

/** A two-state workflow, `a` initial and `b` final, with `edge` as the one transition's extra keys and `vars` as given. */
export function twoStates({ a = {}, b = {}, edge = {}, vars = {}, unit, extra } = {}) {
  return flowDoc({ initial: "a", states: { a, b: { final: true, ...b } }, vars, transitions: [{ from: "a", to: "b", ...edge }], unit, extra });
}

/** A dictionary document from rows written as `{ tool, for?, allow?, deny?, default?, params? }`. */
export function dictDoc(rows) {
  return renderDictionary(rows.map((r, i) => ({ tool: r.tool, ...(r.for !== undefined ? { for: r.for } : {}), allow: r.allow ?? [], deny: r.deny ?? [], default: r.default === true, ...(r.params !== undefined ? { params: r.params } : {}), row: i + 1 })));
}

/** A dictionary value, as the supervisor's host supplies it, from the same rows. */
export function dict(rows) {
  return { rows: rows.map((r, i) => ({ tool: r.tool, ...(r.for !== undefined ? { for: r.for } : {}), allow: r.allow ?? [], deny: r.deny ?? [], default: r.default === true, ...(r.params !== undefined ? { params: r.params } : {}), row: i + 1 })), diagnostics: [] };
}
