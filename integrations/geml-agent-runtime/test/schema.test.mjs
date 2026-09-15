import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSchema, validate, defaultsOf, isJsonValue, SchemaError } from "../dist/core/schema.js";

const vars = {
  type: "object", additionalProperties: false,
  properties: {
    order: { type: "string", description: "Order id" },
    amount: { type: "number", default: 0 },
    approved: { type: "boolean", default: false },
    kind: { type: "string", enum: ["full", "partial"] },
    tags: { type: "array", items: { type: "string" } },
  },
};

test("assertSchema accepts the whole subset and returns the same object", () => {
  assert.equal(assertSchema(vars), vars);
  assert.deepEqual(assertSchema({}), {});
  assert.ok(assertSchema({ oneOf: [{ type: "integer" }, { const: "checkpoint" }] }));
});

test("assertSchema lists every violation, path-qualified", () => {
  const bad = { type: "object", properties: { a: { type: "number", minimum: 0 }, b: { type: "sting" } }, required: ["zzz"] };
  assert.throws(() => assertSchema(bad), (e) => {
    assert.ok(e instanceof SchemaError);
    assert.deepEqual(e.violations, [
      '$.properties.a: unsupported keyword "minimum"',
      '$.properties.b: unknown type "sting"',
      '$: required names undeclared property "zzz"',
    ]);
    return true;
  });
});

test("assertSchema rejects a oneOf with fewer than two branches and an enum that disagrees with type", () => {
  assert.throws(() => assertSchema({ oneOf: [{ type: "string" }] }), /\$: oneOf needs at least two branches/);
  assert.throws(() => assertSchema({ type: "number", enum: ["a"] }), /\$: enum value "a" is not a number/);
});

test("validate: types, required, additionalProperties, enum, const, items", () => {
  assert.deepEqual(validate(vars, { order: "A-17", amount: 120, approved: false, kind: "full", tags: ["x"] }), []);
  assert.deepEqual(validate(vars, { amount: "120" }), ["$.amount: expected number, got string"]);
  assert.deepEqual(validate(vars, { extra: 1 }), ['$: unexpected property "extra"']);
  assert.deepEqual(validate(vars, { kind: "half" }), ['$.kind: expected one of "full", "partial", got "half"']);
  assert.deepEqual(validate(vars, { tags: ["ok", 2] }), ["$.tags[1]: expected string, got number"]);
  assert.deepEqual(validate({ type: "object", required: ["approved"], properties: { approved: { const: true } } }, { approved: false }),
    ["$.approved: expected const true, got false"]);
  assert.deepEqual(validate({ type: "object", required: ["order", "amount"] }, { order: "x" }), ['$: missing required property "amount"']);
});

test("validate: integer is a number without a fraction; null is its own type; oneOf wants exactly one", () => {
  assert.deepEqual(validate({ type: "integer" }, 3), []);
  assert.deepEqual(validate({ type: "integer" }, 3.5), ["$: expected integer, got number"]);
  assert.deepEqual(validate({ type: "null" }, null), []);
  const target = { oneOf: [{ type: "integer" }, { const: "checkpoint" }] };
  assert.deepEqual(validate(target, 7), []);
  assert.deepEqual(validate(target, "checkpoint"), []);
  assert.deepEqual(validate(target, "later"), ["$: matched 0 of 2 oneOf branches"]);
});

test("defaultsOf collects property defaults and nothing else", () => {
  assert.deepEqual(defaultsOf(vars), { amount: 0, approved: false });
  assert.deepEqual(defaultsOf({ type: "object" }), {});
});

test("non-finite numbers are not JSON and never validate as number or integer", () => {
  assert.deepEqual(validate({ type: "number" }, NaN), ["$: expected number, got non-finite number"]);
  assert.deepEqual(validate({ type: "integer" }, Infinity), ["$: expected integer, got non-finite number"]);
  assert.throws(() => assertSchema({ type: "number", enum: [NaN] }), /\$: enum value NaN is not a number/);
  assert.throws(() => assertSchema({ type: "number", const: Infinity }), /\$: const value Infinity is not a number/);
});

test("isJsonValue recurses into arrays and records, and rejects what JSON cannot hold", () => {
  assert.equal(isJsonValue([1, "a", null, [true]]), true);
  assert.equal(isJsonValue({ a: 1, b: [true, { c: "x" }] }), true);
  assert.equal(isJsonValue([1, undefined]), false, "an array holding a non-JSON element is not JSON");
  assert.equal(isJsonValue({ a: () => {} }), false, "a record holding a non-JSON value is not JSON");
  assert.equal(isJsonValue(() => {}), false, "a bare function is nothing JSON recognizes");
});

test("assertSchema: a non-object root, and every remaining collect() violation", () => {
  assert.throws(() => assertSchema("nope"), /\$: schema must be an object/);
  assert.throws(() => assertSchema([1, 2]), /\$: schema must be an object/);
  assert.throws(() => assertSchema({ type: "array", items: "nope" }), /\$\.items: schema must be an object/);
  assert.throws(() => assertSchema({ type: "string", properties: { a: { type: "string" } } }), /\$: properties needs type object/);
  assert.throws(() => assertSchema({ properties: "nope" }), /\$: properties must be an object/);
  assert.throws(() => assertSchema({ type: "object", required: "nope" }), /\$: required must be an array of names/);
  assert.throws(() => assertSchema({ additionalProperties: "yes" }), /\$: additionalProperties must be a boolean/);
  assert.throws(() => assertSchema({ type: "object", items: { type: "string" } }), /\$: items needs type array/);
  assert.throws(() => assertSchema({ enum: [] }), /\$: enum must be a non-empty array/);
  assert.throws(() => assertSchema({ enum: "nope" }), /\$: enum must be a non-empty array/);
  assert.throws(() => assertSchema({ enum: [{}] }), /\$: enum values must be scalars/);
  assert.throws(() => assertSchema({ const: {} }), /\$: const must be a scalar/);
  assert.throws(() => assertSchema({ title: 123 }), /\$: title must be a string/);
  assert.throws(() => assertSchema({ type: "number", default: NaN }), /\$: default must be lossless JSON/);
});

test("assertSchema: integer enum members are checked against Number.isInteger, not just typeof", () => {
  assert.ok(assertSchema({ type: "integer", enum: [1, 2] }));
  assert.throws(() => assertSchema({ type: "integer", enum: [1.5] }), /\$: enum value 1\.5 is not a integer/);
});

test("required is independent of properties — the design's own guards rely on it", () => {
  const guard = { type: "object", required: ["order", "amount"] };
  assert.equal(assertSchema(guard), guard, "a guard with no properties is a valid schema");
  assert.deepEqual(validate(guard, { order: "A-17", amount: 120 }), []);
  assert.deepEqual(validate(guard, { order: "A-17" }), ['$: missing required property "amount"']);
  // With properties present, required must still name a declared one.
  assert.throws(() => assertSchema({ type: "object", properties: { a: { type: "string" } }, required: ["b"] }),
    /required names undeclared property "b"/);
});

test("validate: a const/enum mismatch against an object or array value reports the type, not a scalar spelling", () => {
  assert.deepEqual(validate({ const: "x" }, { some: "object" }), ['$: expected const "x", got object']);
  assert.deepEqual(validate({ enum: ["x"] }, [1, 2]), ['$: expected one of "x", got array']);
});
