#!/usr/bin/env node
// 设计 §8 的检查，任一失败即非零退出。不进 CI（要 Chromium 与 macOS TTS），手动跑：
//
//   node tools/verify.mjs
//
// 1. 两份 cut 的 geml check 零诊断  2. 旁白不超镜头  3. 出片：时长与模型一致到 3 位小数、
// 有音轨、srt 条目数等于字幕片段数。场景的确定性与非空白由 tools/test/scenes.test.mjs 管。
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, FFPROBE, LANGS, geml, checkJson, shotTable, probeDuration } from "./lib/geml.mjs";

let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? "ok  " : "FAIL"}  ${what}`); if (!cond) failed++; };

for (const lang of LANGS) {
  const { core, profile } = checkJson(`cut-${lang}.geml`);
  const all = [...core, ...profile];
  ok(all.length === 0, `cut-${lang}.geml 零诊断${all.length ? "：" + JSON.stringify(all) : ""}`);
}

const timing = spawnSync(process.execPath, [join(ROOT, "tools/check-timing.mjs")], { cwd: ROOT, encoding: "utf8" });
ok(timing.status === 0, `旁白不超镜头\n${timing.stdout.trimEnd()}`);

mkdirSync(join(ROOT, "out"), { recursive: true });
const expected = shotTable().reduce((a, s) => a + s.duration, 0);
for (const lang of LANGS) {
  const mp4 = `out/explainer-${lang}.mp4`;
  const b = geml(["media", "build", `cut-${lang}.geml`, "--out", mp4, "--root", "."], { allowFail: true });
  ok(b.code === 0, `build ${mp4}${b.code ? "\n" + b.stderr + b.stdout : ""}`);
  if (b.code !== 0) continue;
  const got = probeDuration(join(ROOT, mp4));
  ok(got.toFixed(3) === expected.toFixed(3), `${mp4} 时长 ${got.toFixed(3)} = 模型 ${expected.toFixed(3)}`);
  const a = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", join(ROOT, mp4)], { encoding: "utf8" });
  ok(a.stdout.trim().split("\n").filter(Boolean).length === 1, `${mp4} 有且只有一条音轨`);
  // 一条字幕就是一行时间：`00:00:00,500 --> 00:00:02,000`。
  const cues = readFileSync(join(ROOT, mp4.replace(/\.mp4$/, ".srt")), "utf8").split(/\r?\n/)
    .filter((l) => /^\d{2}:\d{2}:\d{2},\d{3} /.test(l) && l.includes(" --> ")).length;
  const subs = (readFileSync(join(ROOT, `cut-${lang}.geml`), "utf8").match(/track=subtitle/g) ?? []).length;
  ok(cues === subs, `${lang} 字幕 ${cues} 条 = 字幕片段 ${subs} 个`);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
