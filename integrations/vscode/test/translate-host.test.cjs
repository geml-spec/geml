// The prompt, and the strictness of reading the answer back.
//
// Run against out/, so this tests what actually ships rather than a re-compile
// of the sources with different settings.

const { strict: assert } = require("node:assert");
const { buildPrompt, parseTranslations, cacheKey } = require("../out/translate-host.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const TEXTS = ["Cut the release from a clean tree.", "Verify"];

test("the prompt names the target, carries the inputs as JSON, and forbids prose", () => {
  const p = buildPrompt(TEXTS, "zh-cn");
  assert.match(p, /zh-cn/);
  assert.ok(p.includes(JSON.stringify(TEXTS)), "the inputs go in as one JSON array");
  assert.match(p, /ONLY a JSON array/);
  assert.match(p, /same order/);
});

test("a clean array answer pairs by position", () => {
  const got = parseTranslations('["从干净的树上切版本。","校验"]', TEXTS);
  assert.deepEqual(got, { [TEXTS[0]]: "从干净的树上切版本。", [TEXTS[1]]: "校验" });
});

test("an answer wrapped in chatter or a code fence still reads", () => {
  const got = parseTranslations('Sure! Here you go:\n```json\n["A","B"]\n```\nHope that helps!', TEXTS);
  assert.deepEqual(got, { [TEXTS[0]]: "A", [TEXTS[1]]: "B" });
});

test("a wrong-length answer is refused, never paired up shifted", () => {
  const got = parseTranslations('["only one"]', TEXTS);
  assert.ok("why" in got, "refused");
  assert.match(got.why, /1 strings for 2/);
});

test("answers that are not a JSON array of strings are refused", () => {
  for (const reply of [
    "I cannot translate that.",
    "[",
    "[1, 2]",
    '["A", null]',
    '{"a":"b"}',
    '["A","B"',
  ]) {
    const got = parseTranslations(reply, TEXTS);
    assert.ok("why" in got, `refused: ${reply}`);
    assert.equal(typeof got.why, "string");
  }
});

test("a blank translation is dropped, so the source text stands", () => {
  const got = parseTranslations('["   ","校验"]', TEXTS);
  assert.deepEqual(got, { [TEXTS[1]]: "校验" });
});

test("the cache key separates languages and does not collide across strings", () => {
  assert.notEqual(cacheKey("a", "zh-cn"), cacheKey("a", "ja"));
  assert.notEqual(cacheKey("a b", "zh"), cacheKey("a", "b zh"));
  assert.equal(cacheKey("a", "zh-cn"), cacheKey("a", "zh-cn"));
});

console.log(`\n${passed} test(s) passed.`);
