// Hidden blocks/lines (§4), metadata interpolation (§4), and `=== output` (§3).
// Run with `npm test`.
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const errors = (d) => d.diagnostics.filter((x) => x.severity === "error");

test("`{hidden}` block: flagged, still in the model & referenceable (§4)", () => {
  const d = parse(
    "=== table {#fy25 hidden format=csv header=1 compute=\"FY [%.1f] = Q1 + Q2\"}\nSegment, Q1, Q2\nCloud, 8, 10\n===\n\n" +
    "=== diagram {format=geml-chart data=#fy25 type=bar x=Segment y=FY}\n===",
  );
  const tbl = d.children.find((b) => b.type === "table");
  assert.equal(tbl.hidden, true);
  assert.ok(d.ids.includes("fy25"));            // id still registered
  assert.equal(errors(d).length, 0);            // chart resolves the hidden table
});

test("`{hidden}` on a heading sets the flag", () => {
  const h = parse("# Secret {hidden}").children[0];
  assert.equal(h.hidden, true);
});

test("`%%` line: own hidden node, raw, not reference-checked (§4)", () => {
  const d = parse("%% TODO check [x](#nope)\n\nvisible para");
  const h = d.children.find((b) => b.kind === "hidden");
  assert.equal(h.text, "TODO check [x](#nope)");
  assert.equal(errors(d).length, 0);            // a scratch note cannot break the build
});

test("metadata interpolation `{{key}}` from `=== meta` (§4)", () => {
  const d = parse("=== meta\nproduct = \"Acme\"\nversion = \"1.0-draft\"\n===\n\n# {{product}} manual\n\nFor {{product}} {{version}}.");
  assert.equal(d.children[1].text, "Acme manual");
  assert.equal(d.children[2].text, "For Acme 1.0-draft.");
});

test("an unknown `{{key}}` is a build error (§4)", () => {
  assert.ok(errors(parse("text {{nope}} here")).some((e) => /unknown metadata reference/.test(e.message)));
});

test("`=== output {of=#id}` is reference-checked (§3)", () => {
  assert.equal(errors(parse("=== code {#load lang=python}\nx\n===\n=== output {of=#load}\nresult\n===")).length, 0);
  assert.ok(errors(parse("=== output {of=#missing}\nx\n===")).some((e) => /unresolved reference/.test(e.message)));
});

console.log(`\n${passed} test(s) passed.`);
