// GEP-0007: §5.3 phase 2 runs over the WHOLE inline sequence — emphasis pairs
// across phase-1 atoms, which are opaque units whose first/last source
// characters feed the flanking test. The conformance suite pins the projections
// (inline.json); this suite pins the model shapes, the flanking behavior at
// atom boundaries, and the integrations around the change: references inside
// emphasis are still build-checked, serialize/to-md round-trip the new trees,
// and HTML render emits real <em> where the motivating bug printed asterisks.
import { parse, serialize, gemlToMd, renderHtml } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const errors = (d) => d.diagnostics.filter((x) => x.severity === "error");
const inlines = (src) => parse(src).children[0].inlines;
const types = (ns) => ns.map((n) => n.type).join(" ");

test("em across a link is ONE emph node containing text, link, text", () => {
  const ns = inlines("*a [b](x.geml) c*");
  assert.equal(types(ns), "emph");
  const em = ns[0];
  assert.equal(types(em.children), "text link text");
  assert.equal(em.children[0].value, "a ");
  assert.equal(em.children[1].doc, "x.geml");
  assert.equal(em.children[2].value, " c");
});

test("every atom kind can sit inside emphasis", () => {
  for (const [src, inner] of [
    ["*a `c` b*", "code"],
    ["*a $m$ b*", "math"],
    ["*a ![i](p.png) b*", "image"],
    ["*a [[#t]] b*", "autoref"],
    ["*a ![[#t]] b*", "project"],
    ["*a [^t] b*", "footnote"],
  ]) {
    const em = inlines(src)[0];
    assert.equal(em.type, "emph", src);
    assert.equal(types(em.children), `text ${inner} text`, src);
  }
});

test("flanking at atom boundaries reads the atom's edge characters", () => {
  // `[` opens the link atom, `)` closes it — both punctuation, so:
  assert.equal(types(inlines("*[b](x.geml)*")), "emph"); // start-of-text opener
  const intraword = inlines("a*[b](x.geml)*a"); // letter|punct: no flank
  assert.equal(types(intraword), "text link text");
  assert.equal(intraword[0].value, "a*");
  assert.equal(intraword[2].value, "*a");
  const tail = inlines("*[b](x.geml)*word"); // punct|letter: closer cannot close
  assert.equal(types(tail), "text link text");
  assert.equal(tail[2].value, "*word");
  assert.equal(types(inlines("word *[b](x.geml)* word")), "text emph text");
});

test("emphasis spans a hard break; the break's newline is whitespace to flanking", () => {
  const ns = inlines("*a\\\nb*");
  assert.equal(types(ns), "emph");
  assert.equal(types(ns[0].children), "text break text");
  // the run after a hard break is preceded by the consumed `\n` — whitespace —
  // so it cannot close. (A lone `*` line is not a list item: no marker space.)
  const lit = inlines("*a\\\n*");
  assert.equal(types(lit), "text break text");
  assert.equal(lit[0].value, "*a");
  assert.equal(lit[2].value, "*");
});

test("escaped delimiters are content on both sides of a pairing", () => {
  const a = inlines("*foo\\*bar*");
  assert.equal(types(a), "emph");
  // the escape atom folds into ONE canonical text child, not three fragments
  assert.deepEqual(a[0].children, [{ type: "text", value: "foo*bar" }]);
  const b = inlines("\\**foo*");
  assert.equal(types(b), "text emph");
  assert.equal(b[0].value, "*");
  const c = inlines("*foo\\**");
  assert.deepEqual(c, [{ type: "emph", children: [{ type: "text", value: "foo*" }] }]);
});

test("a reference inside emphasis is still resolved; a broken one still fails", () => {
  const ok = parse("# T {#t}\n\n*see [x](#t) and [[#t]]*");
  assert.equal(errors(ok).length, 0);
  const bad = parse("*see [x](#nope)*");
  assert.ok(bad.diagnostics.some((d) => d.code === "unresolved-reference"),
    "moving the atom into emph children must not lose the build check");
});

test("emphasis inside a link label pairs inside the label only", () => {
  const em = inlines("*foo [bar *baz* qux](x.geml) end*")[0];
  assert.equal(em.type, "emph");
  const link = em.children[1];
  assert.equal(link.type, "link");
  assert.equal(types(link.children), "text emph text");
});

test("strong and em nest across atoms; rule of three intact", () => {
  const tri = inlines("***a `b` c***");
  assert.equal(types(tri), "emph");
  assert.equal(types(tri[0].children), "strong");
  const ns = inlines("**bold [b](x.geml) *and em***");
  assert.equal(types(ns), "strong");
  assert.equal(types(ns[0].children), "text link text emph");
  const deep = inlines("*a **b [c](x.geml) d** e*")[0];
  assert.equal(types(deep.children), "text strong text");
  assert.equal(types(deep.children[1].children), "text link text");
});

test("strikethrough crosses atoms; a lone tilde still does not delimit", () => {
  assert.equal(types(inlines("~~a `b` c~~")), "strike");
  assert.equal(types(inlines("~a `b` c~")), "text code text");
});

test("adjacent atoms with no text between them wrap as one span", () => {
  const em = inlines("*`a``b`*")[0];
  assert.equal(em.type, "emph");
  assert.equal(types(em.children), "code code");
  assert.equal(types(inlines("**![a](i.png)**")[0].children), "image");
});

test("delimiters INSIDE an atom never pair outward", () => {
  const em = inlines("*a `x*y` b*")[0];
  assert.equal(em.type, "emph");
  assert.equal(em.children[1].value, "x*y");
  // image alt text is raw label content — its stars are not delimiters
  const withAlt = inlines("*an ![*x*](i.png) here*")[0];
  assert.equal(types(withAlt.children), "text image text");
  assert.equal(withAlt.children[1].alt, "*x*");
});

test("serialize(parse) round-trips emphasis-wrapped atoms to the same model", () => {
  for (const src of [
    "*a [b](x.geml) c*", "**a `b` c**", "~~a $x$ b~~", "*[b](x.geml)*",
    "a*[b](x.geml)*a", "*foo\\*bar*", "*a\\\nb*", "***a `b` c***",
    "*foo [bar *baz* qux](x.geml) end*",
  ]) {
    const first = parse(src).children[0].inlines;
    const again = parse(serialize(parse(src))).children[0].inlines;
    assert.deepEqual(again, first, src);
  }
});

test("gemlToMd keeps emphasis wrapping atoms", () => {
  const { md } = gemlToMd(parse("*a [b](x.geml) c*"));
  assert.match(md, /\*a \[b\]\(x\.geml\) c\*/);
});

test("HTML render emits <em> around the <a> (the GEP-0007 motivating bug)", () => {
  const html = renderHtml(parse("*[English](x.geml) | 中文*"));
  assert.match(html, /<em><a [^>]*>English<\/a> \| 中文<\/em>/);
  // Read the content paragraph directly — the page's CSS/JS live in <style>/
  // <script>, never inside a <p>, so this needs no tag-stripping to avoid a
  // stray `*` in a CSS selector counting against us.
  const para = html.match(/<p>[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.ok(para.length > 0 && !para.includes("*"), "no literal asterisks leak into the paragraph");
});

console.log(`\nemphasis-atoms: ${passed} test(s) passed.`);
