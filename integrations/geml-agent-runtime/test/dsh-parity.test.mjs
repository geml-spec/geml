// Design §4.4 promises that our JSON Schema subset agrees with the one the
// DeepSeek Harness tool registry enforces. This is the test that keeps the
// promise — and, just as importantly, the one place the KNOWN divergences are
// written down, because each of them is a rule our generated schemas have to
// obey even though our own validator would let it pass.
//
// The rule for reading a divergence: never bend `core/schema.ts` to match DSH.
// That module validates statechart variables against JSON Schema, and JSON
// Schema is what a statechart author reasonably expects. What must bend is what
// `core/tools.ts` EMITS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSupportedJsonSchema, defineTool } from "@deepseek-ai/dsh-tools";
import { assertSchema } from "../dist/core/schema.js";
import { rollbackSpec, setSpec, transitionSpec } from "../dist/core/tools.js";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot } from "../dist/core/snapshot.js";
import { readFileSync } from "node:fs";

const ours = (schema) => { try { assertSchema(schema); return true; } catch { return false; } };
const theirs = (schema) => { try { assertSupportedJsonSchema(schema); return true; } catch { return false; } };

const AGREE = [
  { type: "string" },
  { type: "integer" },
  { type: "null" },
  { type: "object", additionalProperties: false, properties: { a: { type: "string" } }, required: ["a"] },
  { type: "object", additionalProperties: true, properties: {} },
  { type: "array", items: { type: "number" } },
  { type: "string", enum: ["a", "b"] },
  { type: "boolean", const: true },
  { oneOf: [{ type: "string" }, { type: "number" }] },
  {},
  // Both must REJECT these.
  { type: "number", minimum: 0 },
  { type: "sting" },
  { oneOf: [{ type: "string" }] },
  { type: "string", enum: [] },
];

test("our subset and DSH's agree on every schema shape in the common vocabulary", () => {
  for (const schema of AGREE) {
    assert.equal(ours(schema), theirs(schema),
      `disagreement on ${JSON.stringify(schema)}: ours=${ours(schema)} dsh=${theirs(schema)}`);
  }
});

test("known divergence 1: an open object passes both checkers but not defineTool", () => {
  // JSON Schema's default for `additionalProperties` is open, and both
  // validators agree it is a legal schema. `defineTool`'s OUTPUT compiler is
  // stricter than either and demands the word — a third rule, in a third place,
  // which is exactly why this file exists rather than a note in a comment.
  // `core/tools.ts` closes every object it emits, so all three are satisfied.
  const open = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(ours(open), true, "JSON Schema's default is open");
  assert.equal(theirs(open), true, "assertSupportedJsonSchema accepts it too");
  assert.throws(
    () => defineTool({
      name: "probe",
      description: "d",
      parameters: { x: { type: "string", description: "x" } },
      output: { schema: open, render: () => [{ type: "text", text: "" }] },
      execute: async () => ({}),
    }),
    /additionalProperties must be explicitly true or false/,
    "defineTool's output compiler is the strict one",
  );
});

test("known divergence 2: DSH's parameter spec accepts `required` only as true", () => {
  // Not a schema rule but a parameter-spec rule, and it bites the same way: a
  // parameter that is not required omits the key rather than setting it false.
  const build = (required) => () => defineTool({
    name: "probe",
    description: "d",
    parameters: { x: { type: "string", ...(required === undefined ? {} : { required }), description: "x" } },
    output: { schema: { type: "string" }, render: () => [{ type: "text", text: "" }] },
    execute: async () => "ok",
  });
  assert.doesNotThrow(build(undefined), "omitting required is how a parameter is optional");
  assert.doesNotThrow(build(true));
  assert.throws(build(false), /required must be true when present/);
});

test("every schema this package generates is one DSH accepts", () => {
  // The end the two tests above serve: whatever the divergences are, the specs
  // we hand to `defineTool` pass its own checker.
  const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
  const snap = initialSnapshot(sc, "2026-09-15T00:00:00Z");
  for (const spec of [transitionSpec(sc, snap), setSpec(sc, snap), rollbackSpec()]) {
    assert.ok(spec);
    assert.doesNotThrow(() => assertSupportedJsonSchema(spec.output.schema), `${spec.name}: output schema`);
    assert.doesNotThrow(() => defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: { schema: spec.output.schema, render: () => [{ type: "text", text: "" }] },
      execute: async () => ({}),
    }), `${spec.name}: defineTool`);
  }
});
