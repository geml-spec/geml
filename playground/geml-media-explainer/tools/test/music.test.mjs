// music.test.mjs —— 配乐合成器：确定、归一、分段进出、WAV 头正确。
import { test } from "node:test";
import assert from "node:assert/strict";
import { synth, wav, mixAt, RATE } from "../make-music.mjs";

test("同一时长两次合成逐字节相同", () => {
  const a = wav(synth(3)), b = wav(synth(3));
  assert.ok(a.equals(b));
});

test("峰值归一到 -3 dBFS 左右，且不削波", () => {
  const s = synth(14);
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(peak - 0.708) < 0.01, `peak ${peak}`);
});

test("分段：开头只有垫音，琶音 12 秒后进，结尾只剩垫音在淡出", () => {
  const total = 152;
  assert.deepEqual(Object.fromEntries(Object.entries(mixAt(2, total)).map(([k, v]) => [k, v > 0])), { pad: true, arp: false, bass: false, hat: false });
  assert.ok(mixAt(20, total).arp > 0 && mixAt(20, total).bass === 0);
  assert.ok(mixAt(80, total).hat > 0);
  const end = mixAt(total - 2, total);
  assert.ok(end.pad > 0 && end.pad < 1 && end.arp === 0 && end.bass === 0 && end.hat === 0);
  assert.equal(mixAt(total, total).pad, 0);
});

test("WAV 头：RIFF / 16 位 / 立体声 / 采样率", () => {
  const w = wav(new Float32Array([0, 0.5, -0.5, 1]));
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.toString("ascii", 8, 12), "WAVE");
  assert.equal(w.readUInt16LE(22), 2);
  assert.equal(w.readUInt32LE(24), RATE);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.readUInt32LE(40), 8);
});
