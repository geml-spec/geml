// scene-lib.test.mjs —— 场景公共件里不碰 DOM 的部分。
import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp, lerp, prog, typed, mix, hl, C } from "../../scenes/lib.js";

test("prog 夹在 0..1，端点精确，单调", () => {
  assert.equal(prog(-1, 0, 2), 0);
  assert.equal(prog(0, 0, 2), 0);
  assert.equal(prog(2, 0, 2), 1);
  assert.equal(prog(9, 0, 2), 1);
  let last = -1;
  for (let t = 0; t <= 2; t += 0.05) { const p = prog(t, 0, 2); assert.ok(p >= last); last = p; }
});

test("typed 按码点切，汉字不劈半", () => {
  assert.equal(typed("黑色长发", 0.99, 0, 2), "黑");
  assert.equal(typed("黑色长发", 1.0, 0, 2), "黑色");
  assert.equal(typed("abc", -1, 0, 10), "");
  assert.equal(typed("abc", 99, 0, 10), "abc");
});

test("mix 在两色之间插值并夹住 p", () => {
  assert.equal(mix("#000000", "#ffffff", 0), "#000000");
  assert.equal(mix("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#000000", "#ffffff", 7), "#ffffff");
  assert.equal(clamp(3), 1);
  assert.equal(lerp(10, 20, 0.25), 12.5);
});

const LINE = "=== media-clip {#c01 track=video src=lib.geml#s01 in=0 out=4}";

test("hl 的词元拼回去就是原文，一个字都不多不少", () => {
  for (const l of [LINE, '=== media-text {#x .line title="a b"}', "a < b & c", "====", ""]) {
    assert.equal(hl(l).map(([s]) => s).join(""), l);
  }
});

test("hl 给围栏、类型、#id、键、值各上各的色；相邻同色合并", () => {
  const toks = hl(LINE);
  const has = (s, c) => toks.some(([x, y]) => x === s && y === c);
  assert.ok(has("===", C.dim));
  assert.ok(has("media-clip", C.accent));
  assert.ok(has("#c01", C.id));
  assert.ok(has("track", C.key) && has("video", C.str));
  assert.ok(has("lib.geml#s01", C.str));
  for (let i = 1; i < toks.length; i++) assert.notEqual(toks[i][1], toks[i - 1][1], `第 ${i} 个词元没合并`);
  assert.deepEqual(hl("plain"), [["plain", C.code]]);
});

test("tr 按语言取文案；缺了就抛错，不悄悄回落到另一种语言", async () => {
  const { tr } = await import("../../scenes/lib.js");
  assert.equal(tr("en", { zh: "甲", en: "A" }), "A");
  assert.equal(tr("zh", { zh: "甲", en: "A" }), "甲");
  assert.throws(() => tr("en", { zh: "甲" }), /en/);
});

test("hasId 只认这个 id，不认以它开头的别的 id", async () => {
  const { hasId } = await import("../../scenes/lib.js");
  assert.ok(hasId("=== media-text {#look}", "look"));
  assert.ok(hasId("=== media-text {#look .x}", "look"));
  assert.ok(!hasId("# 风格板 {#look-board}", "look"));
  assert.ok(!hasId("=== media-text {#hero-look .look}", "look"));
});
