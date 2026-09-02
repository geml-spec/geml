// GEP 0010, the host-translator half: the same contract translate-browser.js
// implements with Chrome's built-in model, backed instead by a translator the
// caller supplies (the VS Code extension asking the editor's language model).
//
// What matters here is that the POLICY is unchanged — the parser decides what
// may be translated — and that a translator which answers badly produces a
// refusal rather than a page that silently shows its source.
import { collectTranslatable, translateSliceWith } from "../src/translate-map.js";
import { parse } from "../src/parse-entry.js";
import { strict as assert } from "node:assert";

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const DOC = [
  "=== meta",
  'title = "Publishing"',
  "===",
  "",
  "# Publishing {#pub}",
  "",
  "Cut the release from a clean tree.",
  "",
  "=== code {#cmd lang=sh}",
  "npm publish",
  "===",
].join("\n");

const blocksOf = (src) => parse(src).children;
const flat = (blocks) => JSON.stringify(blocks);

test("the collector asks for prose, and never for code", () => {
  const wanted = collectTranslatable(blocksOf(DOC), "zh-cn");
  assert.ok(wanted.includes("Cut the release from a clean tree."), "prose is collected");
  assert.ok(wanted.includes("Publishing"), "a heading is collected");
  assert.ok(!wanted.some((t) => t.includes("npm publish")), "a code body is NOT sent to a translator");
});

test("the collector deduplicates and skips blank strings", () => {
  const twice = blocksOf(DOC + "\n\nCut the release from a clean tree.\n");
  const wanted = collectTranslatable(twice, "zh-cn");
  assert.equal(wanted.filter((t) => t === "Cut the release from a clean tree.").length, 1);
  assert.ok(!wanted.includes(""), "no empty strings reach the translator");
});

test("a translator's answers are substituted, and code is left alone", async () => {
  const asked = [];
  const upper = async (texts) => {
    asked.push(...texts);
    return Object.fromEntries(texts.map((t) => [t, t.toUpperCase()]));
  };
  const r = await translateSliceWith(upper, blocksOf(DOC), "zh-cn");
  assert.equal(r.ok, true);
  assert.match(flat(r.blocks), /CUT THE RELEASE FROM A CLEAN TREE\./);
  assert.match(flat(r.blocks), /npm publish/, "the code body still reads as it did");
  assert.ok(asked.length > 0);
});

test("a Map answers as well as an object", async () => {
  const r = await translateSliceWith(
    async (texts) => new Map(texts.map((t) => [t, "X" + t])),
    blocksOf(DOC),
    "zh-cn",
  );
  assert.equal(r.ok, true);
  assert.match(flat(r.blocks), /XCut the release/);
});

test("a partial answer keeps the source for what it skipped", async () => {
  const one = async (texts) => ({ [texts[0]]: "TRANSLATED" });
  const r = await translateSliceWith(one, blocksOf(DOC), "zh-cn");
  assert.equal(r.ok, true);
  assert.match(flat(r.blocks), /TRANSLATED/);
});

test("nothing usable back is a refusal, not a silent passthrough", async () => {
  for (const bad of [
    async () => ({}),
    async () => ({ why: "no language model available" }),
    async () => null,
    async (texts) => Object.fromEntries(texts.map((t) => [t, "   "])),
  ]) {
    const r = await translateSliceWith(bad, blocksOf(DOC), "zh-cn");
    assert.equal(r.ok, false, "must refuse");
    assert.equal(typeof r.why, "string");
    assert.ok(r.why.length > 0, "and say why");
  }
});

test("a translator that throws is reported, not propagated", async () => {
  const r = await translateSliceWith(async () => { throw new Error("consent declined"); }, blocksOf(DOC), "zh-cn");
  assert.equal(r.ok, false);
  assert.match(r.why, /consent declined/);
});

test("a document with nothing translatable never calls the translator", async () => {
  let called = false;
  const blocks = blocksOf("=== code {#c lang=sh}\nnpm publish\n===\n");
  const r = await translateSliceWith(async () => { called = true; return {}; }, blocks, "zh-cn");
  assert.equal(r.ok, true);
  assert.equal(called, false);
  assert.equal(r.blocks, blocks, "and hands back exactly what it was given");
});

for (const [name, fn] of tests) {
  await fn();
  passed++;
  console.log("ok", name);
}
console.log(`\n${passed} test(s) passed.`);
