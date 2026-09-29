// lay-cut.test.mjs —— 时间线的派生规则。用假时长，不碰真素材。
import { test } from "node:test";
import assert from "node:assert/strict";
import { layCut, LEAD, GAP } from "../lay-cut.mjs";
import { spans } from "../check-timing.mjs";

const shots = [{ id: "s07", duration: 14 }, { id: "s08", duration: 10 }];
const lines = { "s07:zh": [["vo-s07-zh-1", 4], ["vo-s07-zh-2", 6.5]], "s08:zh": [["vo-s08-zh-1", 3]] };
const src = { shots, lines: (shot, lang) => lines[`${shot}:${lang}`] ?? [], hasBgm: false };

test("主轨顺排；旁白与字幕同锚、同 offset；第二句接在第一句后面", () => {
  const out = layCut("zh", src);
  assert.match(out, /=== media-clip \{#v-s07 track=video src=library\.geml#shot-s07-zh in=0 out=14\}/);
  assert.match(out, /=== media-clip \{#v-s08 track=video src=library\.geml#shot-s08-zh in=0 out=10\}/);
  assert.ok(out.indexOf("#v-s07") < out.indexOf("#v-s08"));
  assert.match(out, new RegExp(`#n-s07-1 track=narration src=library\\.geml#voice-s07-zh-1 over=#v-s07 offset=${LEAD}\\}`));
  assert.match(out, new RegExp(`#t-s07-1 track=subtitle src=script\\.geml#vo-s07-zh-1 over=#v-s07 offset=${LEAD} duration=4\\}`));
  const second = Number((LEAD + 4 + GAP).toFixed(3));
  assert.match(out, new RegExp(`#n-s07-2 [^}]*offset=${second}\\}`));
  assert.match(out, new RegExp(`#t-s07-2 [^}]*offset=${second} duration=6\\.5\\}`));
});

test("没有配乐素材就不放 music 片段；有就铺满全片", () => {
  assert.doesNotMatch(layCut("zh", src), /track=music/);
  assert.match(layCut("zh", { ...src, hasBgm: true }),
    /=== media-clip \{#music track=music src=library\.geml#bgm over=#v-s07 in=0 out=24 gain=-20dB fade-in=1 fade-out=3\}/);
});

test("英文 cut 的画面指向英文版镜头", () => {
  assert.match(layCut("en", src), /#v-s07 track=video src=library\.geml#shot-s07-en /);
  assert.doesNotMatch(layCut("en", src), /shot-s07-zh/);
});

test("同一输入两次输出逐字相同", () => {
  assert.equal(layCut("en", src), layCut("en", src));
});

test("spans：算出每镜旁白的结束时刻，超了就标出来", () => {
  const r = spans("zh", src);
  assert.deepEqual(r.find((x) => x.shot === "s07"), { shot: "s07", lang: "zh", end: Number((LEAD + 4 + GAP + 6.5).toFixed(3)), limit: 14, over: false });
  assert.equal(spans("zh", { ...src, lines: () => [["x", 20]] })[0].over, true);
});

test("成片镜：放这一集自己的声音，配乐在它前面淡出、后面接着原来的位置淡入", () => {
  const withEp = {
    shots: [{ id: "s08", duration: 8, voice: "旁白" }, { id: "s09", duration: 38, voice: "成片" }, { id: "s10", duration: 10, voice: "旁白" }],
    lines: () => [], hasBgm: true,
  };
  const out = layCut("zh", withEp);
  assert.match(out, /#ep-audio-s09 track=narration src=library\.geml#ep-audio over=#v-s09 offset=1\}/);
  assert.match(out, /#music-1 track=music src=library\.geml#bgm over=#v-s08 in=0 out=8 gain=-20dB fade-in=1 fade-out=1\.5\}/);
  assert.match(out, /#music-2 track=music src=library\.geml#bgm over=#v-s10 in=46 out=56 gain=-20dB fade-in=1\.5 fade-out=3\}/);
  assert.doesNotMatch(out, /#music track=/);
});
