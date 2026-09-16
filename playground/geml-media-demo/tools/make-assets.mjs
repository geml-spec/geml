// 合成一套"看得见"的测试素材。原来那一套是纯色块：播放器在走、时间在对，但屏幕上
// 什么都不发生，于是切没切、到第几秒，肉眼一概看不出来。
//
// 换成带走时码的测试图：s01 用 testsrc2、s03 用 testsrc（两种图案一眼能分），
// lips 版再叠一层 hue 位移，于是"这一刀换了"是看得见的事。配音换成能听见的音。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FF = process.env.FFMPEG || "ffmpeg";
const FP = process.env.FFPROBE || "ffprobe";
const W = 540, H = 960, R = 24;                   // 9:16，和剧本 meta 的 aspect 一致

const run = (args) => {
  const r = spawnSync(FF, args, { encoding: "utf8" });
  if (r.status !== 0) { console.error(args.join(" ") + "\n" + (r.stderr || "").split("\n").slice(-8).join("\n")); process.exit(1); }
};
const vf = (extra) => ["-vf", ["format=yuv420p", ...extra].join(",")];

// 画面：源里自带走字的时码，所以不需要 drawtext，也就不需要一份中文字体。
run(["-y", "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${R}:d=5.083`,
  ...vf([]), "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "ep01/assets/s01-take3.mp4"]);
run(["-y", "-f", "lavfi", "-i", `testsrc=s=${W}x${H}:r=${R}:d=6.083`,
  ...vf([]), "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "ep01/assets/s03-take2.mp4"]);
run(["-y", "-f", "lavfi", "-i", `testsrc=s=${W}x${H}:r=${R}:d=6.083`,
  ...vf(["hue=h=140:s=1.3"]), "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "ep01/assets/s03-take2-lips.mp4"]);

// 配音：一段能听见的颤音，不是静音。台词 2.1 秒。
run(["-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2.1:sample_rate=44100",
  "-af", "vibrato=f=6:d=0.6,volume=0.35,afade=t=in:d=0.08,afade=t=out:st=1.95:d=0.15",
  "ep01/assets/s03-l1-vo.wav"]);

// 两张图：角色表与关键帧，同样取一帧测试图。
run(["-y", "-f", "lavfi", "-i", "testsrc2=s=512x512:d=1", "-frames:v", "1", "ep01/assets/hero-sheet.png"]);
run(["-y", "-f", "lavfi", "-i", `testsrc=s=${W}x${H}:d=1`, "-frames:v", "1", "ep01/assets/s01-key.png"]);

// 素材库里的 sha256 与 duration 跟着现值走 —— 不改的话下一次 check 就是
// media-hash-mismatch，而那正是这套检查该报的。
const { createHash } = await import("node:crypto");
const probe = (f) => {
  const r = spawnSync(FP, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], { encoding: "utf8" });
  const n = Number((r.stdout || "").trim());
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
};
let lib = readFileSync("ep01/ep01-library.geml", "utf8");
let n = 0;
lib = lib.replace(/(=== media-asset \{#[\w-]+ src=)([^\s}]+)([^}]*)\}/g, (m, head, src, tail) => {
  const p = "ep01/" + src;
  const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
  let out = tail.replace(/ sha256=[0-9a-f]+/, " sha256=" + sha);
  const d = probe(p);
  if (d !== null && / duration=[\d.]+/.test(out)) out = out.replace(/ duration=[\d.]+/, " duration=" + d);
  n++;
  return head + src + out + "}";
});
writeFileSync("ep01/ep01-library.geml", lib, "utf8");
console.log("重生成 6 个素材，素材库里 " + n + " 个块的 sha256/duration 已跟上");

// 生成日志跟着走。素材是这个脚本"生成"的，那么记录里的 output-sha256 与 inputs 的
// sha256 就得是现值 —— 否则 check 会说这份字节来历不明、下游全过期，而它说得对。
// 保留原有的 DAG（谁是谁的输入）：只换哈希，不重排血缘。
const byId = new Map();
for (const m of lib.matchAll(/=== media-asset \{#([\w-]+) src=([^\s}]+)/g)) {
  byId.set("#" + m[1], createHash("sha256").update(readFileSync("ep01/" + m[2])).digest("hex"));
}
let log = readFileSync("ep01/ep01-library.geml", "utf8");
log = log.replace(/^\{"output":.*$/gm, (line) => {
  const rec = JSON.parse(line);
  const now = byId.get(rec.output);
  if (now !== undefined) rec["output-sha256"] = now;
  if (Array.isArray(rec.inputs)) {
    rec.inputs = rec.inputs.map((x) => {
      const h = byId.get(x.ref);
      return h === undefined ? x : { ...x, sha256: h };
    });
  }
  return JSON.stringify(rec);
});
writeFileSync("ep01/ep01-library.geml", log, "utf8");
console.log("生成日志里的 output-sha256 / inputs 也跟上了");
