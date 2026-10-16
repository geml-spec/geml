import { test } from "node:test";
import assert from "node:assert/strict";
import { agoText, between, dayText, durationText, hhmm, waitedText } from "../dist/hosts/claude-code/time.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const t = wordsFor("zh");
const NOW = "2026-10-12T14:52:00Z";

test("durations and ages in words, in each language", () => {
  assert.equal(durationText(12 * 60_000, t), "12 分钟");
  assert.equal(durationText(2 * 3_600_000, t), "2 小时");
  assert.equal(durationText(3_600_000 + 48 * 60_000, t), "1 小时 48 分");
  assert.equal(durationText(26 * 3_600_000, t), "1 天 2 小时");
  assert.equal(durationText(30_000, t), "30 秒");
  assert.equal(durationText(-5, t), "0 秒");
  assert.equal(durationText(NaN, wordsFor("en")), "0 s");
  assert.equal(agoText("2026-10-12T14:51:30Z", NOW, t), "刚刚");
  assert.equal(agoText("2026-10-12T14:40:00Z", NOW, t), "12 分钟前");
  assert.equal(agoText("2026-10-12T12:40:00Z", NOW, t), "2 小时前");
  assert.equal(agoText("2026-10-11T14:00:00Z", NOW, t), "昨天");
  assert.equal(agoText("2026-10-01T14:00:00Z", NOW, wordsFor("ja")), "11 日前");
  assert.equal(agoText("nope", NOW, t), "");
  assert.equal(waitedText("2026-10-12T14:40:00Z", NOW, t), "等了 12 分钟");
  assert.equal(waitedText("2026-10-12T14:40:00Z", NOW, wordsFor("en")), "waited 12 min");
  assert.equal(between("2026-10-12T14:40:00Z", NOW), 12 * 60_000);
  assert.match(hhmm(NOW), /^\d\d:\d\d$/);
  assert.equal(hhmm("x"), "x");
});

test("a day as a heading: today, yesterday, else its month and day, in the host's local time", () => {
  const local = (y, m, day, h) => new Date(y, m - 1, day, h).toISOString();
  const now = local(2026, 10, 12, 9);
  assert.equal(dayText(local(2026, 10, 12, 0), now, wordsFor("zh")), "今天");
  assert.equal(dayText(local(2026, 10, 11, 23), now, wordsFor("zh")), "昨天");
  assert.equal(dayText(local(2026, 10, 9, 12), now, wordsFor("zh")), "10 月 9 日");
  assert.equal(dayText(local(2026, 10, 9, 12), now, wordsFor("en")), "10/9");
  assert.equal(dayText("nope", now, wordsFor("zh")), "");
});
