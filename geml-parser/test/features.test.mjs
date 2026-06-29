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

test("labeled close `=== #id` closes a block regardless of fence length (§3)", () => {
  assert.equal(errors(parse("=== note {#ex}\nbody\n=== #ex")).length, 0);
  // a note can wrap a code block with all length-3 fences, each closed by id
  const d = parse("=== note {#outer}\nExample:\n=== code {#snip lang=python}\nprint(1)\n=== #snip\n=== #outer");
  assert.equal(errors(d).length, 0);
  const note = d.children.find((b) => b.type === "note");
  assert.ok((note.children || []).some((c) => c.type === "code"), "code nested in the note");
});

test("unterminated block names the labeled-close option in its error (§3)", () => {
  assert.ok(errors(parse("=== note {#ex}\nbody")).some((e) => /=== #ex/.test(e.message)));
});

test("footnote definition `[^id]: text` resolves the reference (§5.2)", () => {
  const d = parse("See it.[^n]\n\n[^n]: The note text.");
  assert.equal(errors(d).length, 0, JSON.stringify(d.diagnostics));
  assert.ok(d.ids.includes("n"));
  const fn = d.children.find((b) => b.kind === "block" && b.id === "n");
  assert.ok(fn && fn.classes.includes("footnote"));
});

console.log(`\n${passed} test(s) passed.`);
