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

test("`{{key}}` inside a code span is verbatim — no substitution, no error (§4)", () => {
  const d = parse("=== meta\nproduct = \"Acme\"\n===\n\nWrite `{{product}}` to get {{product}}.");
  assert.equal(errors(d).length, 0);
  const p = d.children[1];
  assert.deepEqual(p.inlines.find((n) => n.type === "code"), { type: "code", value: "{{product}}" });
  assert.ok(p.text.endsWith("to get Acme."));       // outside the span it still interpolates
  // an unknown key inside a code span cannot fail the build
  assert.equal(errors(parse("The syntax is `{{key}}`.")).length, 0);
});

test("`{{…}}` inside inline math is verbatim (§4)", () => {
  const d = parse("Let $x_{{n}} = 1$ hold.");
  assert.equal(errors(d).length, 0);
  assert.deepEqual(d.children[0].inlines.find((n) => n.type === "math"), { type: "math", value: "x_{{n}} = 1" });
});

test("`\\{{key}}` escapes interpolation to the literal text `{{key}}` (§4)", () => {
  const d = parse("=== meta\nv = \"1.2\"\n===\n\nType \\{{v}} to reference v.");
  assert.equal(errors(d).length, 0);
  const p = d.children[1];
  assert.equal(p.inlines.map((n) => n.value ?? "").join(""), "Type {{v}} to reference v.");
});

test("an unclosed backtick run is literal text, so interpolation still applies (§4)", () => {
  const d = parse("=== meta\nv = \"1.2\"\n===\n\na ` b {{v}}");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].text, "a ` b 1.2");
});

test("an escaped backtick opens no code span, so interpolation still applies (§4)", () => {
  const d = parse("=== meta\nv = \"1.2\"\n===\n\n\\`{{v}}\\`");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].text, "\\`1.2\\`");
});

test("an invalid key shape `{{9x}}` is literal text and no error (§4)", () => {
  const d = parse("x {{9x}} y");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[0].text, "x {{9x}} y");
});

test("a self-referential meta value does not re-interpolate (§4)", () => {
  const d = parse('=== meta\nv = "{{v}}"\n===\n\nx {{v}} y');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].text, "x {{v}} y"); // single pass: the injected {{v}} stays literal
});

test("a footnote definition's text interpolates (§4/§5.2)", () => {
  const d = parse('=== meta\nv = "1.2"\n===\n\nclaim.[^n]\n\n[^n]: uses {{v}} here');
  assert.equal(errors(d).length, 0);
  const note = d.children.find((b) => b.kind === "block" && b.type === "note");
  assert.equal(note.children[0].text, "uses 1.2 here");
});

test("a raw table body never interpolates — cell `{{key}}` is literal, unknown keys included (§4/§6)", () => {
  const d = parse('=== meta\nv = "1.2"\n===\n\n=== table\n| a | {{v}} |\n|---|---|\n| 1 | {{nope}} |\n===');
  assert.equal(errors(d).length, 0);            // {{nope}} in a cell cannot fail the build
  const t = d.children[1].table;
  assert.equal(t.columns[1], "{{v}}");
  assert.equal(t.rows[0][1].text, "{{nope}}");
});

test("a heading auto-id derives from the substituted text (§4)", () => {
  const d = parse('=== meta\nv = "1.2"\n===\n\n# Release {{v}}');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].id, "release-12"); // anchors shift when meta changes
});

test("a `%%` hidden line is never interpolated (§4)", () => {
  const d = parse("%% scratch {{nope}} note");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[0].text, "scratch {{nope}} note");
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
