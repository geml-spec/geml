import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LANGS, WORDS, fill, langOf, wordsFor } from "../dist/hosts/claude-code/text.js";

const SRC = fileURLToPath(new URL("../src/hosts/claude-code/", import.meta.url));

test("one table: every t(\"…\") the shell's pure modules draw with has an English and a Japanese line", () => {
  const used = new Set();
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith(".ts") || name === "text.ts") continue;
    const src = readFileSync(`${SRC}${name}`, "utf8");
    for (const m of src.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 80, `found ${used.size} keys`);
  const missing = [...used].filter((k) => WORDS[k] === undefined);
  assert.deepEqual(missing, [], "keys with no translation");
  for (const [key, entry] of Object.entries(WORDS)) {
    for (const lang of ["en", "ja"]) {
      assert.equal(typeof entry[lang], "string", `${key}: ${lang}`);
      assert.ok(entry[lang] !== "", `${key}: ${lang} is empty`);
      const holes = [...key.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual([...entry[lang].matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort(), holes, `${key}: ${lang} has other holes`);
    }
  }
});

test("the words function fills the holes; a key with no translation falls back to the Chinese text", () => {
  assert.equal(fill("待 {0} · {1}", ["a", 2]), "待 a · 2");
  assert.equal(fill("{0} {1}", ["a"]), "a {1}");
  assert.equal(wordsFor("zh")("还有 {0} 件", 3), "还有 3 件");
  assert.equal(wordsFor("en")("还有 {0} 件", 3), "3 more");
  assert.equal(wordsFor("ja")("还有 {0} 件", 3), "ほか 3 件");
  assert.equal(wordsFor("en")("没有这一条", 1), "没有这一条");
  assert.deepEqual(LANGS, ["zh", "en", "ja"]);
});

test("the language: an explicit choice, else the locale, else Chinese", () => {
  assert.equal(langOf("en", "zh_CN.UTF-8"), "en");
  assert.equal(langOf("system", "zh_CN.UTF-8"), "zh");
  assert.equal(langOf("system", "zh-Hant-TW"), "zh");
  assert.equal(langOf("system", "ja-JP"), "ja");
  assert.equal(langOf("system", "en-US"), "en");
  assert.equal(langOf("system", "de_DE"), "en");
  assert.equal(langOf(undefined, undefined), "zh");
  assert.equal(langOf("system", ""), "zh");
  assert.equal(langOf("ja", undefined), "ja");
});
