#!/usr/bin/env node
// 把《重生之夜》第一集接进讲解片：它的八张图与成片登记成讲解片的素材（镜头画它们），并从成片里
// 抽出音轨，给成片镜（S09）当声音。
//
//   node tools/link-episode.mjs        在 produce-episode 做完之后跑
//
// 素材指向 episode/ 里的原文件，不复制：这一集重做了，哈希变了，用到它的镜头就过期重渲。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, FFMPEG, registerFile, logGen, needsRegen } from "./lib/geml.mjs";

const LIB = "library.geml";
export const IMAGES = ["hero-sheet", "sister-sheet", "s01-key", "s02-key", "s03-key", "s04-key", "s05-key", "s06-key"];

async function main() {
  if (!existsSync(join(ROOT, "episode/out/ep01.mp4"))) throw new Error("这一集还没出片：先跑 node tools/produce-episode.mjs");
  for (const id of IMAGES) registerFile(LIB, `ep-${id}`, `episode/assets/${id}.png`, { kind: "image", role: "workflow" });
  registerFile(LIB, "ep-final", "episode/out/ep01.mp4", { kind: "video", role: "workflow" });
  if (needsRegen(LIB, "ep-audio")) {
    const r = spawnSync(FFMPEG, ["-loglevel", "error", "-y", "-i", join(ROOT, "episode/out/ep01.mp4"), "-vn", "-c:a", "aac", "-b:a", "128k",
      "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", join(ROOT, "assets/ep-audio.m4a")], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`抽音轨失败：${r.stderr}`);
    registerFile(LIB, "ep-audio", "assets/ep-audio.m4a", { kind: "audio", role: "take" });
    logGen(LIB, { output: "ep-audio", model: "ffmpeg", mode: "other", inputs: ["ep-final"] });
  }
  // 成片里的一帧（第六镜，字幕在画面上）：出片那一镜拿它当「成片长这样」的证据
  if (needsRegen(LIB, "ep-frame")) {
    const r = spawnSync(FFMPEG, ["-loglevel", "error", "-y", "-ss", "30.5", "-i", join(ROOT, "episode/out/ep01.mp4"), "-frames:v", "1", join(ROOT, "assets/ep-frame.png")], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`取帧失败：${r.stderr}`);
    registerFile(LIB, "ep-frame", "assets/ep-frame.png", { kind: "image", role: "take" });
    logGen(LIB, { output: "ep-frame", model: "ffmpeg", mode: "other", inputs: ["ep-final"] });
  }
  console.log(`接入：${IMAGES.length} 张图、成片、成片音轨、成片一帧`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
