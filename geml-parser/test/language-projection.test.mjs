// GEP 0010 — a translated document as a PROJECTION along the language axis.
//
// Three things are under test and they are separable on purpose:
//   1. prose runs get addresses (span layer, no specification change);
//   2. a reference — in this document or another — resolves one (normative);
//   3. what a translation may and may not touch.
//
// The addresses in (1) are not invented here: the proposal publishes a worked
// example with its `geml list` output, and this suite reproduces that document so
// the implementation is checked against the document that specified it.
import { parse, addressedUnits, proseRunTargets, translateBlocks, gemlToMd } from "../dist/geml.js";
import { shortestAddress } from "../dist/selector.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const errors = (d) => d.diagnostics.filter((x) => x.severity === "error");

// The proposal's worked example, verbatim in shape.
const PUB = `=== meta
title = "Publishing"
===

# Publishing {#pub}

Cut the release from a clean tree.

=== code {#cmd lang=sh}
npm publish
===

Then confirm it landed.

## Verify {#verify}

Check each artifact.

=== table {#checks format=csv header=1}
artifact, where
parser, npm
===

Anything red, stop.
`;

test("§GEP-0010: the four run shapes are exactly the proposal's worked example", () => {
  const listed = addressedUnits(PUB).map((a) => [shortestAddress(a, addressedUnits(PUB)), a.unit.kind]);
  assert.deepEqual(listed, [
    ["=== meta", "block"],
    ["#pub", "heading"],
    ["#pub-before-cmd", "run"],          // P absent -> #C-before-N
    ["#cmd", "block"],
    ["#cmd-between-verify", "run"],      // both present -> #P-between-N
    ["#verify", "heading"],
    ["#verify-before-checks", "run"],
    ["#checks", "block"],
    ["#verify-after-checks", "run"],     // N absent -> #C-after-P
  ]);
});

// The relation word is DETERMINED by structure, so each shape has exactly one
// spelling and no convention has to be agreed on top of the rule.
test("§GEP-0010: a run spans every non-anchor block between two anchors", () => {
  const src = "# Sec {#sec}\n\nFirst.\n\nSecond.\n\n- one\n- two\n\n=== code {#c lang=sh}\nx\n===\n";
  const runs = proseRunTargets(parse(src).children);
  const run = runs.get("sec-before-c");
  assert.ok(run !== undefined, `expected #sec-before-c, got ${[...runs.keys()].join(", ")}`);
  assert.deepEqual(run.map((b) => b.kind), ["paragraph", "paragraph", "list"],
    "a run is not one paragraph — it is everything between the anchors");
});

test("§GEP-0010: a container holding only prose IS the container, and gets no run address", () => {
  const runs = proseRunTargets(parse("# Only {#only}\n\njust prose.\n").children);
  assert.deepEqual([...runs.keys()], [], "both anchors absent — `#only` already names it");
});

test("§GEP-0010: an explicit id shadows the run address it would collide with", () => {
  const src = "# A {#a}\n\nprose.\n\n=== note {#a-before-b}\nI am a real block.\n===\n\n=== code {#b lang=sh}\nx\n===\n";
  const d = parse(src);
  assert.equal(errors(d).length, 0);
  const hit = addressedUnits(src).find((u) => u.unit.id === "a-before-b");
  assert.equal(hit.unit.kind, "block", "the declared block wins; the run goes unnamed");
});

test("§GEP-0010: a reference resolves a run address, in this document and across one", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-proj-"));
  writeFileSync(join(dir, "pub.geml"), PUB);

  // Cross-document, which is the form a projection actually uses.
  const cn = `=== meta
title = "x"
profile = "geml-translator/v1"
===

=== embed {src=pub.geml#pub-before-cmd}
===
`;
  writeFileSync(join(dir, "cn.geml"), cn);
  const resolveDoc = (p) => (p === "pub.geml" ? PUB : null);
  assert.equal(errors(parse(cn, { resolveDoc })).length, 0, "a run address is not an unresolved reference");

  // And a typo still is — the point of addressing them at all is that a miss is loud.
  const bad = cn.replace("#pub-before-cmd", "#pub-before-nope");
  const e = errors(parse(bad, { resolveDoc })).map((x) => x.code);
  assert.deepEqual(e, ["unresolved-cross-document-reference"]);
});

test("§GEP-0010: `lang=`/`translator=`/`except=` need the profile, and are clean with it", () => {
  const withOut = parse('=== embed {src=a.geml#b lang=zh-cn translator=none}\n===\n');
  const warn = withOut.diagnostics.filter((x) => x.code === "unknown-attribute").map((x) => x.message);
  assert.equal(warn.length, 2, `expected lang and translator to warn, got ${warn.join(" | ")}`);

  const withIt = parse('=== meta\nprofile = "geml-translator/v1"\n===\n\n=== embed {src=a.geml#b lang=zh-cn translator=none except="#x"}\n===\n');
  assert.equal(withIt.diagnostics.filter((x) => x.code === "unknown-attribute").length, 0);
});

// What a translation may touch. The policy is per TYPE, and the inline type makes
// the second half fall out: text says something, a link target names something.
const shout = (s) => (s.trim() === "" ? s : `«${s.trim()}»`);

test("§GEP-0010: prose is translated; a code span and a link target are not", () => {
  const d = parse("# Title {#t}\n\nRun `npm publish` and [read the docs](https://example.com/a).\n");
  const out = translateBlocks(d.children, "xx", shout);
  const md = gemlToMd({ ...d, children: out }).md;
  assert.match(md, /«Title»/, "heading text");
  assert.match(md, /`npm publish`/, "a code span is a verbatim atom");
  assert.doesNotMatch(md, /«npm publish»/);
  assert.match(md, /\(https:\/\/example\.com\/a\)/, "a link href names a target");
  assert.match(md, /«read the docs»/, "but its label says something");
});

test("§GEP-0010: a code body is never translated, a table's cells are", () => {
  const d = parse(PUB);
  const md = gemlToMd({ ...d, children: translateBlocks(d.children, "xx", shout) }).md;
  assert.match(md, /npm publish/);
  assert.doesNotMatch(md, /«npm publish»/, "a code body is the value, not a sentence about one");
  assert.match(md, /«artifact»/, "a table of prose is the case body mode gets wrong");
  assert.match(md, /«parser»/);
});

test("§GEP-0010: translating never mutates the source blocks", () => {
  const d = parse("para.\n");
  const before = d.children[0].text;
  translateBlocks(d.children, "xx", shout);
  assert.equal(d.children[0].text, before, "the caller's blocks come from a parse cache others read");
});

console.log(`\n${passed} test(s) passed.`);
