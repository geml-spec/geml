// The fixed bounds: each specification states every value once, in its table
// of fixed bounds (GEML §9.2, geml-media §8.1), and everything else follows the
// table — the copies of the specification, the parser and the second
// implementation, and the conformance suite's boundary cases. A value changed
// in the table and nowhere else fails here, and says where else it is owed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { parse } from "../dist/geml.js";
import * as bounds from "../dist/bounds.js";
import { DATA_DEPTH as IMPL2_DATA_DEPTH } from "./conformance/impl2.mjs";
import { expected, readBounds, SPEC, MEDIA_PROFILE } from "./conformance/_bounds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "spec");
const read = (...p) => readFileSync(join(specDir, ...p), "utf8");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const core = readBounds(readFileSync(SPEC, "utf8"));
const media = readBounds(readFileSync(MEDIA_PROFILE, "utf8"));

test("§9.2's table names the bounds this suite knows, and each has a value", () => {
  assert.deepEqual(Object.keys(core).sort(), ["chain-depth", "data-depth", "nesting-floor", "table-cells"]);
  assert.deepEqual(Object.keys(media).sort(), ["apart-tolerance", "max-time"]);
  for (const [k, v] of Object.entries({ ...core, ...media })) assert.ok(Number.isFinite(v) && v > 0, k);
});

test("the Chinese specification and the GEML copy hold the same table", () => {
  assert.deepEqual(readBounds(read("GEML-spec_CN.md")), core);
  assert.deepEqual(readBounds(read("in_geml_format", "GEML-spec.geml")), core);
  assert.deepEqual(readBounds(read("profiles", "geml-media", "geml-media-profile_CN.md")), media);
});

test("in the GEML copy the table is a table block, #fixed-bounds, and reads to the same values", () => {
  const doc = parse(read("in_geml_format", "GEML-spec.geml"));
  const all = [];
  (function walk(bs) { for (const b of bs ?? []) { all.push(b); walk(b.children); } })(doc.children);
  const table = all.find((b) => b.id === "fixed-bounds");
  assert.equal(table?.type, "table");
  const values = Object.fromEntries(table.table.rows.map(([name, value]) =>
    [name.inlines.find((n) => n.type === "code").value, typeof value.value === "number" ? value.value : Number(value.text.replaceAll(",", ""))]));
  assert.deepEqual(values, core);
});

test("no value of a table is restated in its specification's text", () => {
  const standalone = (v) => new RegExp(`(?<![\\w.:,\\-])(${v}|${v.toLocaleString("en-US")})(?![\\w.:,\\-%])`);
  const rowsOff = (text) => text.split("\n").filter((l) => !/^\|\s*`[a-z-]+`\s*\|/.test(l));
  const offenders = (text, values) => rowsOff(text).filter((l) => values.some((v) => standalone(v).test(l)));
  for (const f of [["GEML-spec.md"], ["GEML-spec_CN.md"], ["in_geml_format", "GEML-spec.geml"],
    ["profiles", "geml-style", "geml-style-profile.md"], ["profiles", "geml-style", "geml-style-profile_CN.md"]]) {
    assert.deepEqual(offenders(read(...f), Object.values(core)), [], f.join("/"));
  }
  // apart-tolerance is 2, which the text uses for everything else.
  for (const f of ["geml-media-profile.md", "geml-media-profile_CN.md"]) {
    assert.deepEqual(offenders(read("profiles", "geml-media", f), [media["max-time"]]), [], f);
  }
});

test("the parser and the second implementation hold the tables' values", () => {
  assert.equal(bounds.CHAIN_DEPTH, core["chain-depth"]);
  assert.equal(bounds.DATA_DEPTH, core["data-depth"]);
  assert.equal(bounds.TABLE_CELLS, core["table-cells"]);
  assert.ok(bounds.BLOCK_NESTING >= core["nesting-floor"] && bounds.INLINE_NESTING >= core["nesting-floor"]);
  assert.equal(bounds.MEDIA_MAX_TIME, media["max-time"]);
  assert.equal(bounds.MEDIA_APART_PX, media["apart-tolerance"]);
  assert.equal(IMPL2_DATA_DEPTH, core["data-depth"]);
});

test("the boundary cases are the ones the tables make (node test/conformance/_bounds.mjs --write)", () => {
  for (const { path, text, want } of expected(core, media)) assert.ok(text === want, `${path} holds other boundary cases`);
});

console.log(`\nbounds: ${passed} passed`);
