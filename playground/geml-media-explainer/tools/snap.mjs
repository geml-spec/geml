#!/usr/bin/env node
// 截几帧看看：不渲整镜，不动素材库。调画面时用。
//
//   node tools/snap.mjs <输出目录> s10:zh:9.5 s10:en:9.5 …
import { startServer } from "./lib/server.mjs";
import { openBrowser } from "./lib/chrome.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { ROOT } from "./lib/geml.mjs";
const [out, ...specs] = process.argv.slice(2);   // 镜头:语言:秒
mkdirSync(out, { recursive: true });
const s = await startServer(ROOT); const p = await openBrowser();
for (const spec of specs) {
  const [scene, lang, t] = spec.split(":");
  await p.goto(`${s.url}/scenes/stage.html?scene=${scene}&lang=${lang}`);
  await p.evaluate(`__seek(${t})`);
  writeFileSync(`${out}/${scene}-${lang}-${t}.png`, await p.screenshot());
  if (p.errors.length) console.log(spec, p.errors);
}
await p.close(); await s.close();
