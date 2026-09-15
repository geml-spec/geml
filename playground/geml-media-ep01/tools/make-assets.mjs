// 用 ffmpeg 生成这一集的素材。它们是**真视频真音频**（lavfi 合成的色块与正弦波），
// 不是 AI 生成的画面 —— 本机没有接任何生成器。要验的是文档这一层：寻址、投射、
// 血缘、过期传播、以及时间模型算出的总长和实际出片是否一致。
//
//   node tools/make-assets.mjs
//
// ffmpeg 不在 PATH 就退出并说清楚：可选依赖，缺了降级，不静默。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const R = join(dirname(fileURLToPath(import.meta.url)), "..");
const have = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
if (!have) { console.error("ffmpeg 不在 PATH 上，素材没有重建（现有的那份照旧可用）"); process.exit(0); }

const V = (out, color, seconds) => ["-y", "-loglevel", "error", "-f", "lavfi",
  "-i", `color=c=${color}:s=270x480:d=${seconds},format=yuv420p`, "-c:v", "libx264", "-r", "24", out];
const A = (out, freq, seconds) => ["-y", "-loglevel", "error", "-f", "lavfi",
  "-i", `sine=frequency=${freq}:duration=${seconds}`, "-ac", "1", "-ar", "16000", out];
const P = (out, color) => ["-y", "-loglevel", "error", "-f", "lavfi",
  "-i", `color=c=${color}:s=270x480:d=1,format=rgb24`, "-frames:v", "1", out];

// 竖屏 9:16，时长与文档里声明的一致。
const jobs = [
  P("ep01/assets/gen/s01-key.png", "navy"),
  V("ep01/assets/gen/s01-take3.mp4", "navy", 5),
  V("ep01/assets/gen/s01-take5.mp4", "darkblue", 5),
  V("ep01/assets/gen/s02-take1.mp4", "midnightblue", 5),
  V("ep01/assets/gen/s03-take2.mp4", "darkslateblue", 6),
  V("ep01/assets/gen/s03-take2-lips.mp4", "slateblue", 6),
  A("ep01/assets/gen/s01-l1-vo.wav", 220, 3.6),
  A("ep01/assets/gen/s03-l1-vo.wav", 330, 2.1),
  A("ep01/assets/gen/s03-l2-vo.wav", 440, 0.9),
  P("assets/hero-sheet.png", "teal"),
  P("assets/sister-sheet.png", "olive"),
  P("assets/mourning-hall.png", "dimgray"),
  A("assets/narrator-voice.wav", 200, 1),
  A("assets/hero-voice.wav", 240, 1),
  A("assets/sister-voice.wav", 300, 1),
];
mkdirSync(join(R, "ep01/assets/gen"), { recursive: true });
mkdirSync(join(R, "assets"), { recursive: true });
for (const args of jobs) {
  const out = args[args.length - 1];
  execFileSync("ffmpeg", args.map((a, i) => (i === args.length - 1 ? join(R, out) : a)), { cwd: R });
}
console.log(jobs.length + " 个素材已用 ffmpeg 生成（真视频真音频，非 AI 画面）");
