#!/usr/bin/env node
// 旁白：script.geml 里每条 .line → macOS say → AAC（.m4a）→ 登记 → 生成记录（prompt 指回那条台词）。
//
// 用 AAC 不用 wav：50 句旁白 wav 是 20MB，比全部镜头还大；AAC 约十分之一。`+bitexact` 让同一段
// 输入永远编出同一串字节——哈希就是身份，编码器顺手写进去的版本号不该让它变。
//
//   node tools/make-voice.mjs            只重做过期的（台词改了字，check 会说它的配音过期）
//   node tools/make-voice.mjs --all
//   node tools/make-voice.mjs s07
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, FFMPEG, listIds, blockBody, registerFile, logGen, needsRegen, probeDuration } from "./lib/geml.mjs";

const LIB = "library.geml";
export const PREFERRED = { zh: "Tingting", en: "Samantha" };
const LOCALE = { zh: "zh_CN", en: "en_US" };

/** 解析 `say -v '?'`。名字里带全角括号的行，对齐列会被挤到只剩一个空格，所以只要求 \s+。 */
export function parseVoices(text) {
  return text.split("\n").map((l) => l.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/)).filter(Boolean)
    .map((m) => ({ name: m[1].trim(), locale: m[2] }));
}

/**
 * 首选声音在就用它，不在就用同语言的第一个。返回 { say: 传给 say -v 的完整名字, id: 进记录 model 的名字 }。
 * 完整名字不能截：「Eddy」与「Eddy (中文（中国大陆）)」是两个声音，前者读不了中文。
 */
export function pickVoice(lang, text = spawnSync("say", ["-v", "?"], { encoding: "utf8" }).stdout ?? "") {
  const voices = parseVoices(text);
  if (voices.length === 0) throw new Error("没有 say：旁白目前只支持 macOS");
  const inLocale = voices.filter((v) => v.locale === LOCALE[lang]);
  const want = PREFERRED[lang];
  const hit = inLocale.find((v) => v.name === want || v.name.startsWith(`${want} (`)) ?? inLocale[0];
  if (hit === undefined) throw new Error(`本机没有 ${LOCALE[lang]} 的声音`);
  const base = hit.name.replace(/\s*\(.*$/, "");
  return { say: hit.name, id: `${base}-${hit.locale}` };
}

export function synth(text, voice, out) {
  const aiff = out.replace(/\.m4a$/, ".aiff");
  let r = spawnSync("say", ["-v", voice, "-o", aiff, text], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`say -v ${voice} 失败：${r.stderr}`);
  r = spawnSync(FFMPEG, ["-loglevel", "error", "-y", "-i", aiff, "-ar", "44100", "-ac", "1", "-c:a", "aac", "-b:a", "96k",
    "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", out], { encoding: "utf8" });
  rmSync(aiff, { force: true });
  if (r.status !== 0) throw new Error(`ffmpeg 转 AAC 失败：${r.stderr}`);
  // say 碰到读不了的文字不报错，给一段几毫秒的空音频。宁可停下，也不把哑巴旁白登记进库。
  const d = probeDuration(out);
  if (d < 0.2) throw new Error(`声音「${voice}」读出来只有 ${d}s：它多半读不了这段文字\n  ${text}`);
}

async function main(argv) {
  const all = argv.includes("--all");
  const only = argv.filter((a) => /^s\d\d$/.test(a));
  const ids = listIds("script.geml").filter((id) => /^vo-s\d\d-(zh|en)-\d+$/.test(id))
    .filter((id) => only.length === 0 || only.includes(id.split("-")[1]));
  const voices = { zh: pickVoice("zh"), en: pickVoice("en") };
  mkdirSync(join(ROOT, "assets"), { recursive: true });
  let made = 0;
  for (const id of ids) {
    const asset = id.replace(/^vo-/, "voice-");
    if (!all && !needsRegen(LIB, asset)) continue;
    const lang = id.split("-")[2];
    const file = `assets/${asset}.m4a`;
    synth(blockBody("script.geml", id), voices[lang].say, join(ROOT, file));
    const a = registerFile(LIB, asset, file, { kind: "audio", role: "voice", of: "concepts.geml#narrator" });
    logGen(LIB, { output: asset, model: `say-${voices[lang].id}`, mode: "tts", prompt: `script.geml#${id}` });
    console.log(`${id}  ${a.duration}s  ${voices[lang].say} → ${file}`);
    made++;
  }
  if (made === 0) console.log("没有过期的旁白；要全做加 --all");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
