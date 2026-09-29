// voice.test.mjs —— 从 `say -v '?'` 里挑声音。样本是本机的真实输出（节选）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoices, pickVoice } from "../make-voice.mjs";

const SAMPLE = [
  "Eddy (中文（中国大陆）)     zh_CN    # 你好！我叫Eddy。",
  "Eddy (英语（美国）)         en_US    # Hello! My name is Eddy.",
  "Samantha            en_US    # Hello! My name is Samantha.",
  "Tingting (中文（中国大陆）) zh_CN    # 你好！我叫婷婷。",
].join("\n");

test("全角括号挤掉对齐空格的行也认得出", () => {
  assert.deepEqual(parseVoices(SAMPLE).map((v) => v.name), ["Eddy (中文（中国大陆）)", "Eddy (英语（美国）)", "Samantha", "Tingting (中文（中国大陆）)"]);
});

test("首选在就用首选；给 say 的是完整名字，进记录的不带空格", () => {
  assert.deepEqual(pickVoice("zh", SAMPLE), { say: "Tingting (中文（中国大陆）)", id: "Tingting-zh_CN" });
  assert.deepEqual(pickVoice("en", SAMPLE), { say: "Samantha", id: "Samantha-en_US" });
});

test("首选不在就用同语言第一个，名字不截", () => {
  const noTing = SAMPLE.split("\n").filter((l) => !l.startsWith("Tingting")).join("\n");
  assert.deepEqual(pickVoice("zh", noTing), { say: "Eddy (中文（中国大陆）)", id: "Eddy-zh_CN" });
});
