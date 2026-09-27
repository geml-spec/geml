// The JSON Schema subset the runtime enforces — deliberately the same subset
// the DeepSeek Harness tool registry enforces (dsh-tools/json-schema), so the
// `agent_set` parameters the model sees and the values we validate live under
// one rule. Anything outside the subset is refused, never ignored: `minimum`
// silently doing nothing would be worse than an error.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Scalar = string | number | boolean | null;
export type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface Schema {
  type?: SchemaType;
  oneOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: Scalar[];
  const?: Scalar;
  title?: string;
  description?: string;
  default?: JsonValue;
  examples?: JsonValue;
}

const TYPES: ReadonlySet<string> = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYWORDS: ReadonlySet<string> = new Set([
  "type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const",
  "title", "description", "default", "examples",
]);

export class SchemaError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(violations.join("\n"));
    this.name = "SchemaError";
    this.violations = violations;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isJsonValue(v: unknown): v is JsonValue {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJsonValue);
  if (isRecord(v)) return Object.values(v).every(isJsonValue);
  return false;
}

/** The JSON type name of a value, for messages: `typeOf(3.5)` is `number`, `typeOf(null)` is `null`. */
function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function scalarText(v: Scalar): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

function scalarFits(v: Scalar, type: SchemaType | undefined): boolean {
  if (type === undefined) return true;
  if (type === "integer") return typeof v === "number" && Number.isInteger(v);
  if (type === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOf(v) === type;
}

function collect(raw: unknown, path: string, out: string[]): void {
  if (!isRecord(raw)) { out.push(`${path}: schema must be an object`); return; }
  for (const k of Object.keys(raw)) {
    if (!KEYWORDS.has(k)) out.push(`${path}: unsupported keyword ${JSON.stringify(k)}`);
  }
  const type = raw["type"];
  if (type !== undefined && (typeof type !== "string" || !TYPES.has(type))) {
    out.push(`${path}: unknown type ${JSON.stringify(type)}`);
  }
  const t = typeof type === "string" && TYPES.has(type) ? (type as SchemaType) : undefined;
  if (raw["oneOf"] !== undefined) {
    const branches = raw["oneOf"];
    if (!Array.isArray(branches) || branches.length < 2) out.push(`${path}: oneOf needs at least two branches`);
    else branches.forEach((b, i) => collect(b, `${path}.oneOf[${i}]`, out));
  }
  const props = raw["properties"];
  if (props !== undefined) {
    if (t !== undefined && t !== "object") out.push(`${path}: properties needs type object`);
    if (!isRecord(props)) out.push(`${path}: properties must be an object`);
    else for (const [name, sub] of Object.entries(props)) collect(sub, `${path}.properties.${name}`, out);
  }
  const required = raw["required"];
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) out.push(`${path}: required must be an array of names`);
    else if (isRecord(props)) for (const name of required as string[]) {
      if (!(name in props)) out.push(`${path}: required names undeclared property ${JSON.stringify(name)}`);
    }
  }
  if (raw["additionalProperties"] !== undefined && typeof raw["additionalProperties"] !== "boolean") {
    out.push(`${path}: additionalProperties must be a boolean`);
  }
  if (raw["items"] !== undefined) {
    if (t !== undefined && t !== "array") out.push(`${path}: items needs type array`);
    collect(raw["items"], `${path}.items`, out);
  }
  const en = raw["enum"];
  if (en !== undefined) {
    if (!Array.isArray(en) || en.length === 0) out.push(`${path}: enum must be a non-empty array`);
    else for (const v of en) {
      if (!(v === null || ["string", "number", "boolean"].includes(typeof v))) out.push(`${path}: enum values must be scalars`);
      else if (!scalarFits(v as Scalar, t)) out.push(`${path}: enum value ${scalarText(v as Scalar)} is not a ${t}`);
    }
  }
  const c = raw["const"];
  if (c !== undefined) {
    if (!(c === null || ["string", "number", "boolean"].includes(typeof c))) out.push(`${path}: const must be a scalar`);
    else if (!scalarFits(c as Scalar, t)) out.push(`${path}: const value ${scalarText(c as Scalar)} is not a ${t}`);
  }
  for (const k of ["title", "description"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") out.push(`${path}: ${k} must be a string`);
  }
  for (const k of ["default", "examples"] as const) {
    if (raw[k] !== undefined && !isJsonValue(raw[k])) out.push(`${path}: ${k} must be lossless JSON`);
  }
}

/** Assert `raw` is a schema in the subset; every violation is reported, not just the first. */
export function assertSchema(raw: unknown, path = "$"): Schema {
  const violations: string[] = [];
  collect(raw, path, violations);
  if (violations.length) throw new SchemaError(violations);
  return raw as Schema;
}

/** Validate `value` against an asserted schema. Total: never throws on any value. */
export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const out: string[] = [];
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((b) => validate(b, value, path).length === 0).length;
    if (hits !== 1) out.push(`${path}: matched ${hits} of ${schema.oneOf.length} oneOf branches`);
    return out;
  }
  if (schema.type !== undefined) {
    if ((schema.type === "number" || schema.type === "integer") && typeof value === "number" && !Number.isFinite(value)) {
      out.push(`${path}: expected ${schema.type}, got non-finite number`);
      return out;
    }
    const ok = schema.type === "integer" ? typeof value === "number" && Number.isInteger(value) : typeOf(value) === schema.type;
    if (!ok) { out.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`); return out; }
  }
  if (schema.const !== undefined && value !== schema.const) {
    out.push(`${path}: expected const ${scalarText(schema.const)}, got ${isJsonValue(value) && !isRecord(value) && !Array.isArray(value) ? scalarText(value as Scalar) : typeOf(value)}`);
  }
  if (schema.enum && !schema.enum.includes(value as Scalar)) {
    const got = isJsonValue(value) && !isRecord(value) && !Array.isArray(value) ? scalarText(value as Scalar) : typeOf(value);
    out.push(`${path}: expected one of ${schema.enum.map(scalarText).join(", ")}, got ${got}`);
  }
  if (isRecord(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) out.push(`${path}: missing required property ${JSON.stringify(name)}`);
    }
    for (const [name, v] of Object.entries(value)) {
      const sub = schema.properties?.[name];
      if (sub) out.push(...validate(sub, v, `${path}.${name}`));
      else if (schema.additionalProperties === false) out.push(`${path}: unexpected property ${JSON.stringify(name)}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => out.push(...validate(schema.items as Schema, v, `${path}[${i}]`)));
  }
  return out;
}

/** The `default` of each declared property, for an object-rooted schema. */
export function defaultsOf(schema: Schema): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    if (sub.default !== undefined) out[name] = sub.default;
  }
  return out;
}
