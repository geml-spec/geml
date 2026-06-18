// M2 conformance checks: inline parsing (§5) and reference validation (§8).
// Run with `npm test` (after `npm run build`).
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok", name);
}

const types = (inlines) => inlines.map((n) => n.type);
const errors = (d) => d.diagnostics.filter((x) => x.severity === "error");

test("inline element kinds (§5.1)", () => {
  const d = parse("Hello **bold** and *em* and `x=1` and ~~no~~ and $a^2$.");
  const t = types(d.children[0].inlines);
  for (const k of ["strong", "emph", "code", "strike", "math"]) assert.ok(t.includes(k), `missing ${k}`);
});

test("code/math bodies are kept raw (§5.3)", () => {
  const d = parse("`*not emphasis*` and $*not either*$");
  const [code, , math] = d.children[0].inlines;
  assert.equal(code.value, "*not emphasis*");
  assert.equal(math.value, "*not either*");
});

test("hard break and escapes (§5.1)", () => {
  const d = parse("a\\\nb \\* literal");
  const t = types(d.children[0].inlines);
  assert.ok(t.includes("break"));
  assert.ok(d.children[0].inlines.some((n) => n.type === "text" && n.value.includes("* literal")));
});

test("media embed with as= (§5.1)", () => {
  const img = parse("![pic](a.png){as=image}").children[0].inlines[0];
  assert.equal(img.type, "image");
  assert.equal(img.src, "a.png");
  assert.equal(img.as, "image");
});

test("media kind inferred from src extension when `as` omitted (§5.1)", () => {
  const kind = (src) => parse(`![x](${src})`).children[0].inlines[0].as;
  assert.equal(kind("a.png"), "image");
  assert.equal(kind("a.mp4"), "video");
  assert.equal(kind("a.mp3?x=1"), "audio");
  assert.equal(kind("https://h/x"), undefined); // no extension -> left to renderer
  assert.equal(parse("![x](a.png){as=video}").children[0].inlines[0].as, "video"); // explicit wins
});

test("resolved internal/auto/footnote refs are clean (§5.2)", () => {
  const d = parse("# Title {#sec}\n\nSee [text](#sec) and [[#sec]] and [^sec].");
  assert.equal(d.diagnostics.length, 0, JSON.stringify(d.diagnostics));
});

test("unresolved refs are errors (§8.3)", () => {
  const d = parse("See [x](#missing) and [[#nope]] and [^gone].");
  assert.equal(errors(d).length, 3, JSON.stringify(d.diagnostics));
});

test("duplicate id is an error (§4)", () => {
  const d = parse("# A {#dup}\n\n# B {#dup}");
  assert.ok(d.diagnostics.some((x) => /duplicate id/.test(x.message)));
});

test("cross-doc ref: warns without resolver, validates with one (§8.4)", () => {
  assert.ok(parse("[a](o.geml#x).").diagnostics.some((x) => x.severity === "warning"));
  assert.equal(parse("[a](o.geml#x).", { resolveDoc: () => "# H {#x}" }).diagnostics.length, 0);
  assert.ok(parse("[a](o.geml#x).", { resolveDoc: () => "# H {#y}" }).diagnostics.some((x) => /unresolved reference/.test(x.message)));
  assert.ok(parse("[a](gone.geml#x).", { resolveDoc: () => null }).diagnostics.some((x) => /cannot resolve document/.test(x.message)));
});

test("task list items carry `checked`; the marker is stripped (§5)", () => {
  const items = parse("- [ ] open\n- [x] done\n- [X] also done\n- plain\n").children[0].items;
  assert.deepEqual(items.map((i) => i.checked), [false, true, true, undefined]);
  assert.equal(items[0].text, "open");           // `[ ]` removed from text
  assert.equal(items[1].inlines[0].value, "done"); // inline parsed without marker
  assert.equal(items[3].checked, undefined);       // a plain item is not a task
});

console.log(`\n${passed} test(s) passed.`);
