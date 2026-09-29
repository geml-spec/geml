#!/usr/bin/env node
// 场景模块 → 逐帧截图 → 每镜一个 mp4 → 登记进素材库并追加一条生成记录。
//
//   node tools/render-scenes.mjs            只渲过期的镜头（问 geml check）
//   node tools/render-scenes.mjs --all      全渲
//   node tools/render-scenes.mjs s10 s11    只渲这几个
//
// 每镜按每种语言各渲一遍（画面带步骤标题，设计 §3）。生成记录的输入是场景模块本身，
// 加上场景 `export const uses = [...]` 声明的图片素材：换一张图，只有用到它的镜头过期。
//
// 前置：ffmpeg / ffprobe（或 FFMPEG / FFPROBE 指过去）；本机有 Chromium（见 lib/chrome.mjs）。
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, FFMPEG, LANGS, shotTable, registerFile, logGen, needsRegen, blockAttrs } from "./lib/geml.mjs";
import { startServer } from "./lib/server.mjs";
import { openBrowser } from "./lib/chrome.mjs";

export const FPS = 30;
const LIB = "library.geml";

/** 场景声明用到的素材 id，与可选的画中画。场景模块顶层不碰 DOM，所以 node 能直接 import 它。 */
async function sceneOf(id) {
  return import(pathToFileURL(join(ROOT, "scenes", `${id}.js`)).href);
}
export async function usesOf(id) {
  const mod = await sceneOf(id);
  return [...(mod.uses ?? []), ...(mod.overlay ? [mod.overlay.src] : [])];
}

export async function renderShot(page, base, shot, lang, outFile) {
  // 截图经管道直接喂给 ffmpeg，一帧都不落盘：换成真图之后每帧 PNG 有几 MB，一整镜先写进
  // 临时目录再编码，在这台只剩几个 GB 的机器上放不下。
  //
  // 画中画：场景 `export const overlay = { src, at, x, y, w, h }` 时，把那段视频原样缩放后叠在
  // 画面的 (x, y)，从第 at 秒开始放——不经过浏览器截图，画质与帧率都是原片的。
  const ov = (await sceneOf(shot.id)).overlay;
  const inputs = ["-f", "image2pipe", "-c:v", "png", "-framerate", String(FPS), "-i", "-"];
  const vf = [];
  if (ov !== undefined) {
    inputs.push("-i", join(ROOT, blockAttrs("library.geml", ov.src).src));
    vf.push("-filter_complex", `[1:v]scale=${ov.w}:${ov.h},setpts=PTS-STARTPTS+${ov.at}/TB[ov];[0:v][ov]overlay=${ov.x}:${ov.y}:eof_action=pass[v]`, "-map", "[v]", "-an");
  }
  const ff = spawn(FFMPEG, ["-loglevel", "error", "-y", ...inputs, ...vf,
    "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-t", String(shot.duration), outFile], { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  ff.stderr.on("data", (d) => { err += d; });
  const done = new Promise((ok) => ff.once("close", ok));
  const write = (buf) => new Promise((ok, fail) => {
    ff.stdin.write(buf, (e) => (e ? fail(new Error(`ffmpeg 收帧失败：${e.message}\n${err}`)) : ok()));
  });
  try {
    await page.goto(`${base}/scenes/stage.html?scene=${shot.id}&lang=${lang}`);
    const n = Math.round(shot.duration * FPS);
    for (let f = 0; f < n; f++) {
      await page.evaluate(`window.__seek(${f / FPS})`);
      await write(await page.screenshot());
    }
    if (page.errors.length > 0) throw new Error(`${shot.id}（${lang}）渲染时页面报错：\n${page.errors.join("\n")}`);
  } catch (e) {
    ff.kill();
    throw e;
  } finally {
    ff.stdin.end();
  }
  const code = await done;
  if (code !== 0) throw new Error(`ffmpeg 编码 ${shot.id}（${lang}）失败：\n${err}`);
}

async function main(argv) {
  const all = argv.includes("--all");
  const only = argv.filter((a) => /^s\d\d$/.test(a));
  const shots = shotTable().filter((s) => only.length === 0 || only.includes(s.id));
  // 先把场景模块的哈希刷成现值：改过的模块这时变成新哈希，
  // 用它渲出来的镜头在 check 眼里就「过期」了 —— 下一行问的正是这个。
  for (const s of shots) registerFile(LIB, `scene-${s.id}`, `scenes/${s.id}.js`, { kind: "other", role: "workflow", of: s.concept });
  const todo = shots.flatMap((s) => LANGS.map((lang) => ({ ...s, lang })))
    .filter((s) => all || only.length > 0 || needsRegen(LIB, `shot-${s.id}-${s.lang}`));
  if (todo.length === 0) { console.log("没有过期的镜头；要全渲加 --all"); return; }

  mkdirSync(join(ROOT, "assets"), { recursive: true });
  const server = await startServer(ROOT);
  const page = await openBrowser();
  try {
    for (const s of todo) {
      const t0 = Date.now();
      const id = `shot-${s.id}-${s.lang}`;
      const file = `assets/${id}.mp4`;
      await renderShot(page, server.url, s, s.lang, join(ROOT, file));
      registerFile(LIB, id, file, { kind: "video", role: "take", of: s.concept });
      logGen(LIB, { output: id, model: "render-scenes", mode: "code2v", inputs: [`scene-${s.id}`, ...(await usesOf(s.id))] });
      console.log(`${s.id} ${s.lang}  ${s.duration}s  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${file}`);
    }
  } finally {
    await page.close();
    await server.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
