// Hidden blocks/lines (§4), metadata interpolation (§4), and the withdrawal of
// the `output` block type (§3).
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



test("a raw table body never interpolates — cell `{{key}}` is literal, unknown keys included (§4/§6)", () => {
  const d = parse('=== meta\nv = "1.2"\n===\n\n=== table\n| a | {{v}} |\n|---|---|\n| 1 | {{nope}} |\n===');
  assert.equal(errors(d).length, 0);            // {{nope}} in a cell cannot fail the build
  const t = d.children[1].table;
  assert.equal(t.columns[1], "{{v}}");
  assert.equal(t.rows[0][1].text, "{{nope}}");
});

test("an attribute value is never interpolated — `{{key}}` in `caption=` is literal (§4)", () => {
  const d = parse('=== meta\nv = "1.2"\n===\n\n=== note {caption="{{v}}"}\nbody {{v}}\n===');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].attrs.caption, "{{v}}");        // attribute: literal
  assert.equal(d.children[1].children[0].text, "body 1.2");  // flow body: substituted
});

test("`caption` is valid on every typed block, not just tables (§4/§7)", () => {
  for (const src of [
    '=== diagram {format=mermaid caption="Review"}\ngraph LR\n===',
    '=== math {caption="Euler"}\ne^{i\\pi}+1=0\n===',
    '=== code {lang=js caption="Snippet"}\nlet a = 1;\n===',
    '=== note {caption="Aside"}\nx\n===',
  ]) {
    const warned = parse(src).diagnostics.filter((x) => x.code === "unknown-attribute");
    assert.deepEqual(warned, [], `caption accepted: ${src.split("\n")[0]}`);
  }
});

test("a bracketed column name is not mistaken for a `[printf]` format (§6)", () => {
  const d = parse('=== table {format=csv header=1 compute="[Data] = A + B; [Data] [%.1f] = A + B"}\nA,B\n3,4\n===');
  assert.equal(errors(d).length, 0);
  const t = d.children[0].table;
  assert.equal(t.columns[2], "[Data]");        // the name kept its brackets
  assert.equal(t.columns.length, 3);           // the second formula rewrote the same column
  assert.equal(t.rows[0][2].text, "7.0");      // ... and this time with the format applied
});

test("a non-finite compute result holds no value, shows `-`, and warns (§6)", () => {
  const d = parse('=== table {format=csv header=1 compute="c = A / B" summary="c = sum(A) / (sum(B) - sum(B))"}\nA,B\n1,0\n0,0\n===');
  assert.equal(errors(d).length, 0);           // a zero denominator is data, not a broken document
  const t = d.children[0].table;
  assert.equal(t.rows[0][2].text, "-");        // +Infinity
  assert.equal(t.rows[1][2].text, "-");        // NaN (0/0)
  assert.equal(t.rows[0][2].value, undefined); // and nothing downstream can read a number here
  assert.equal(t.summary[2].text, "-");
  const nan = d.diagnostics.filter((x) => x.code === "compute-not-a-number");
  assert.equal(nan.length, 3, "two rows and the summary each say so out loud");
  assert.ok(nan.every((x) => x.severity === "warning"));
});

test("a heading auto-id derives from the raw text before substitution (§4)", () => {
  const d = parse('=== meta\nv = "1.2"\n===\n\n# Release {{v}}');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].id, "release-v"); // anchors do NOT shift when meta changes
});

test("a `%%` hidden line is never interpolated (§4)", () => {
  const d = parse("%% scratch {{nope}} note");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[0].text, "scratch {{nope}} note");
});

test("`=== text` is a registered flow container (§3): flow body, no warning", () => {
  const d = parse("=== text {#p .lead}\nA **bold** claim, see [[#q]].\n===\n\n## Q {#q}");
  assert.equal(d.diagnostics.length, 0, JSON.stringify(d.diagnostics)); // no unknown-type warning
  const t = d.children.find((b) => b.kind === "block" && b.type === "text");
  assert.equal(t.mode, "flow");
  assert.equal(t.id, "p");
  assert.deepEqual(t.classes, ["lead"]);
  const para = (t.children ?? []).find((c) => c.kind === "paragraph");
  assert.ok(para.inlines.some((n) => n.type === "strong"), "**bold** parsed");
  assert.ok(para.inlines.some((n) => n.type === "autoref" && n.anchor === "q"), "[[#q]] parsed");
});

test("a `text` body is reference-checked like any flow block (§8)", () => {
  assert.ok(errors(parse("=== text {#p}\nsee [[#nope]]\n===")).some((e) => /nope/.test(e.message)));
});

test("`=== output` is no longer a block type; it degrades like any unknown type", () => {
  // Withdrawn: a stored-result block earned a type in the registry, a render
  // path, a projection and an `of=#id` reference rule, and nothing used it. An
  // unknown type is not an error — the body is preserved and a warning says the
  // type is unrecognised — so a document that still writes one keeps its content.
  const doc = parse("=== output {of=#load}\nresult\n===");
  const warn = doc.diagnostics.find((d) => d.code === "unknown-block-type");
  assert.ok(warn, `expected unknown-block-type, got ${JSON.stringify(doc.diagnostics.map((d) => d.code))}`);
  assert.equal(warn.severity, "warning", "removing a type must not break existing documents");
  assert.deepEqual(doc.children[0].raw, ["result"], "the body is preserved verbatim");
  // `of=` was only ever checked for this type, so it is now an ordinary attribute.
  assert.equal(errors(parse("=== output {of=#missing}\nx\n===")).length, 0);
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

test("a stray labeled fence warns and names the bare close that truncated the block (§3, Appendix A)", () => {
  // The author meant `=== #x` to close the code block, but the equal-length
  // bare `===` inside the body closed it first (§3): everything after line 4
  // fell out of the block, and before this warning `check` said "ok".
  const d = parse("=== code {#x lang=geml}\n=== meta\nt\n===\n=== #x");
  assert.equal(errors(d).length, 0, "a stray labeled fence is a warning, not an error");
  const w = d.diagnostics.filter((x) => x.code === "stray-labeled-fence");
  assert.equal(w.length, 1, JSON.stringify(d.diagnostics));
  assert.equal(w[0].severity, "warning");
  assert.equal(w[0].line, 5);
  assert.ok(/#x/.test(w[0].message) && /bare fence at line 4/.test(w[0].message), w[0].message);
  assert.ok(/truncated/.test(w[0].message), w[0].message);
  // the line itself stays what it always was: paragraph text, model unchanged
  assert.ok(d.children.some((b) => b.kind === "paragraph" && b.text === "=== #x"));
});

test("a labeled-fence line naming no bare-closed block still warns, without a close line (§3)", () => {
  const d = parse("just text\n\n====== #nope");
  const w = d.diagnostics.find((x) => x.code === "stray-labeled-fence");
  assert.ok(w, JSON.stringify(d.diagnostics));
  assert.equal(w.severity, "warning");
  assert.equal(w.line, 3);
  assert.ok(/#nope/.test(w.message) && !/bare fence/.test(w.message), w.message);
});

test("stray-labeled-fence: an id made of regex metacharacters neither crashes nor mismatches", () => {
  const id = "a(b)+[c]*";
  const d = parse(`=== code {#${id}}\nbody\n===\n=== #${id}`);
  const w = d.diagnostics.filter((x) => x.code === "stray-labeled-fence");
  assert.equal(w.length, 1, JSON.stringify(d.diagnostics));
  assert.ok(w[0].message.includes("at line 3"), w[0].message);
});

test("a labeled fence that closes its block is not stray — no warning (§3)", () => {
  const d = parse("=== note {#ok}\nbody\n=== #ok");
  assert.ok(!d.diagnostics.some((x) => x.code === "stray-labeled-fence"));
});

test("a labeled-fence-shaped line inside a raw body is content, never a stray fence (§3)", () => {
  const d = parse("===== code {#doc lang=geml}\n=== note {#n}\nx\n=== #n\n=====");
  assert.ok(!d.diagnostics.some((x) => x.code === "stray-labeled-fence"));
});

test("a stray labeled fence inside a flow body warns, with document line numbers (§3)", () => {
  const d = parse("=== code {#x}\nbody\n===\n\n===== note {#n}\n=== #x\n=====");
  const w = d.diagnostics.find((x) => x.code === "stray-labeled-fence");
  assert.ok(w, JSON.stringify(d.diagnostics));
  assert.equal(w.line, 6);
  assert.ok(/bare fence at line 3/.test(w.message), w.message);
});

test("footnote reference `[^id]` resolves to any block with that id (§5.2)", () => {
  const d = parse("See it.[^n]\n\n=== note {#n}\nThe note text.\n===");
  assert.equal(errors(d).length, 0, JSON.stringify(d.diagnostics));
  assert.ok(d.ids.includes("n"));
  const fn = d.children.find((b) => b.kind === "block" && b.id === "n");
  assert.ok(fn && fn.type === "note");
});

console.log(`\n${passed} test(s) passed.`);
