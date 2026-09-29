#!/usr/bin/env node
// 配乐：用代码合成一段 152 秒的氛围垫底音乐 → AAC → 登记为 #bgm → 生成记录（输入是本脚本）。
//
//   node tools/make-music.mjs            过期了才重做（改了这个文件，check 就说配乐过期）
//   node tools/make-music.mjs --all
//
// 不买、不下载、没有授权问题：每个采样都是这里算出来的。A 小调 i–VI–III–VII（Am F C G），80 BPM，
// 一轮 4 小节 12 秒。垫音一直在，琶音、低音、轻打击分段进出，最后只剩垫音淡出。随机的部分用
// 固定种子，同一份脚本永远生成同一串字节——哈希就是身份。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, FFMPEG, registerFile, logGen, needsRegen, shotTable } from "./lib/geml.mjs";

const LIB = "library.geml";
export const RATE = 44100;
export const BPM = 80;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

// 和弦（MIDI 音高）：垫音三到四个音，低音一个根音。
const CHORDS = [
  { pad: [57, 60, 64, 67], bass: 45 },   // Am7
  { pad: [53, 57, 60, 64], bass: 41 },   // Fmaj7
  { pad: [48, 52, 55, 59], bass: 36 },   // Cmaj7
  { pad: [55, 59, 62, 65], bass: 43 },   // G7
];
const ARP = [0, 1, 2, 3, 2, 1, 3, 2];    // 八分音符，按和弦内音的序号

const hz = (m) => 440 * 2 ** ((m - 69) / 12);

/** 各声部在第 t 秒的音量（0..1）：分段进出，段与段之间 3 秒交叉。 */
export function mixAt(t, total) {
  const ramp = (a, b) => Math.min(1, Math.max(0, (t - a) / 3)) * Math.min(1, Math.max(0, (b - t) / 3));
  return {
    pad: Math.min(1, t / 4) * Math.min(1, Math.max(0, (total - t) / 6)),
    arp: ramp(12, total - 18),
    bass: ramp(36, total - 24),
    hat: ramp(60, total - 30) * 0.8,
  };
}

// 确定的伪随机：线性同余，种子写死。
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** 合成 total 秒的立体声，返回交错的 Float32Array [L, R, L, R, …]。 */
export function synth(total) {
  const n = Math.round(total * RATE);
  const out = new Float32Array(n * 2);
  const rand = lcg(20260928);
  // 预先排好打击的触发点：每个反拍一下，音量有一点随机
  const hats = [];
  for (let b = 0.5; b * BEAT < total; b += 1) hats.push({ at: b * BEAT, amp: 0.5 + 0.5 * rand() });
  const noise = new Float32Array(4096).map(() => rand() * 2 - 1);

  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const m = mixAt(t, total);
    const bar = Math.floor(t / BAR);
    const ch = CHORDS[bar % CHORDS.length];
    const inBar = t - bar * BAR;
    // 和弦换的时候，垫音在 0.4 秒里交叉过去
    const prev = CHORDS[(bar + CHORDS.length - 1) % CHORDS.length];
    const x = Math.min(1, inBar / 0.4);
    let l = 0, r = 0;

    // 垫音：每个音两支略微走调的振荡器，少量谐波，左右各偏一支
    for (const [chord, w] of [[ch, x], [prev, 1 - x]]) {
      if (w <= 0) continue;
      for (const note of chord.pad) {
        const f = hz(note);
        const a = Math.sin(2 * Math.PI * f * 0.997 * t) + 0.25 * Math.sin(2 * Math.PI * f * 2 * 0.997 * t) + 0.08 * Math.sin(2 * Math.PI * f * 3 * t);
        const b = Math.sin(2 * Math.PI * f * 1.003 * t) + 0.25 * Math.sin(2 * Math.PI * f * 2 * 1.003 * t) + 0.08 * Math.sin(2 * Math.PI * f * 3 * t);
        l += a * w * 0.055 * m.pad;
        r += b * w * 0.055 * m.pad;
      }
    }
    // 慢速的呼吸感
    const swell = 0.85 + 0.15 * Math.sin(2 * Math.PI * t / (BAR * 2));
    l *= swell; r *= swell;

    // 琶音：八分音符，拨弦式包络，高八度
    if (m.arp > 0) {
      const step = Math.floor(inBar / (BEAT / 2));
      const since = inBar - step * (BEAT / 2);
      const note = ch.pad[ARP[step % ARP.length]] + 12;
      const f = hz(note);
      const env = Math.exp(-since * 7) * Math.min(1, since * 400);
      const v = (Math.sin(2 * Math.PI * f * since) + 0.3 * Math.sin(2 * Math.PI * f * 2 * since)) * env * 0.09 * m.arp;
      const pan = 0.5 + 0.3 * Math.sin(step * 1.7);
      l += v * (1 - pan); r += v * pan;
    }
    // 低音：根音，每拍一个柔和的起音
    if (m.bass > 0) {
      const since = inBar % BEAT;
      const env = 0.6 + 0.4 * Math.exp(-since * 4);
      const v = Math.sin(2 * Math.PI * hz(ch.bass) * t) * env * 0.12 * m.bass;
      l += v; r += v;
    }
    out[i * 2] = l;
    out[i * 2 + 1] = r;
  }
  // 打击：短促的高频噪声，叠加在对应位置
  for (const h of hats) {
    const start = Math.round(h.at * RATE);
    const len = Math.round(0.05 * RATE);
    const amp = mixAt(h.at, total).hat * h.amp * 0.05;
    if (amp <= 0) continue;
    let lp = 0;
    for (let k = 0; k < len && start + k < n; k++) {
      const s = noise[k % noise.length];
      lp = lp * 0.2 + s * 0.8;
      const v = (s - lp) * Math.exp(-k / (0.012 * RATE)) * amp;   // 减去低通 = 粗糙的高通
      out[(start + k) * 2] += v * 0.8;
      out[(start + k) * 2 + 1] += v;
    }
  }
  // 母带：软饱和，峰值归一到 -3 dBFS
  let peak = 0;
  for (let i = 0; i < out.length; i++) { out[i] = Math.tanh(out[i] * 1.2); peak = Math.max(peak, Math.abs(out[i])); }
  const g = peak > 0 ? 0.708 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/** 交错的浮点采样 → 16 位 PCM 的 WAV 字节。 */
export function wav(samples, rate = RATE, channels = 2) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function main(argv) {
  const all = argv.includes("--all");
  registerFile(LIB, "synth-bgm", "tools/make-music.mjs", { kind: "other", role: "workflow" });
  if (!all && !needsRegen(LIB, "bgm")) { console.log("配乐没有过期；要重做加 --all"); return; }
  const total = shotTable().reduce((a, s) => a + s.duration, 0) + 2;   // 比全片多 2 秒，给 out= 留余量
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "explainer-bgm-"));
  try {
    const src = join(dir, "bgm.wav");
    writeFileSync(src, wav(synth(total)));
    const file = "assets/bgm.m4a";
    const r = spawnSync(FFMPEG, ["-loglevel", "error", "-y", "-i", src, "-c:a", "aac", "-b:a", "128k",
      "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", join(ROOT, file)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg 转 AAC 失败：${r.stderr}`);
    const a = registerFile(LIB, "bgm", file, { kind: "audio", role: "take" });
    logGen(LIB, { output: "bgm", model: "make-music.mjs", mode: "code2a", inputs: ["synth-bgm"] });
    console.log(`bgm  ${a.duration}s  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
