#!/usr/bin/env node
// 从零做完一集：照着 `geml media todo` 干活的 Agent 循环。
//
//   node tools/produce-episode.mjs              做完所有过期或缺失的，出片到 episode/out/ep01.mp4
//   node tools/produce-episode.mjs --until images|stands|compose|takes|voices|music|cut
//                                               只做到这一步（讲解片的证据要拍中途的状态）
//
// 每一步都问文档还差什么，只做差的那部分；中途断了重跑，已经做完的不再做：
//   1. 出图   todo 里的「生成」项 → 本机 Z-Image-Turbo（提示词是 todo 展开好的那串字）→ log
//             角色图、场景母版直接就是产出；立绘先出一张纯色背景的 take
//   2. 抠像   每张立绘的 take → ffmpeg colorkey（键色取原图角落）→ 带 alpha 的立绘，记成 other，输入是 take
//   3. 合成   分镜表每一镜：geml media compose 按剧本里的 comp 把母版与立绘叠成关键帧，--log 登记
//   4. 运镜   分镜表每一镜：关键帧 → ffmpeg 推、拉、移 → 一段视频 take，记成 i2v，输入是那张图
//   5. 配音   todo 里的「配音」项 → 按角色库的声音表挑声音 → macOS say → log
//   6. 配乐   代码合成（tools/make-music.mjs）
//   7. 剪辑   按分镜表与配音时长派生 cut.geml
//   8. 出片   geml media build → 双语字幕烧进画面（本机 ffmpeg 没有 libass，字幕层由浏览器画）
//
// 改一处只重做受影响的：改林夏的外貌 → 她的立绘和用到它们的镜头；挪一个层 → 那一镜的合成与运镜，零次出图。
//
// 前置同讲解片：ffmpeg、macOS say、Chromium，以及出图用的 mflux（见 README「画面与配乐从哪来」）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, FFMPEG, geml, blockBody, blockAttrs, registerFile, logGen, needsRegen, hasBlock } from "./lib/geml.mjs";
import { parseVoices, synth as sayTo } from "./make-voice.mjs";
import { synth as synthMusic, wav } from "./make-music.mjs";
import { openBrowser } from "./lib/chrome.mjs";

export const EP = join(ROOT, "episode");
const LIB = "library.geml";
const MFLUX = process.env.MFLUX ?? "mflux-generate-z-image-turbo";
const MODEL = "mflux-community/z-image-turbo-mflux-q8";
export const W = 720, H = 1280, FPS = 30;
export const LEAD = 0.4, GAP = 0.25;

/** 出图的种子：写死，同模型同提示词同种子出同一张图。键是产出的素材 id。 */
export const SEEDS = {
  "hero-sheet": 2601, "sister-sheet": 2602,
  "rooftop-plate": 5101, "bedroom-plate": 5102, "bedroom-door-plate": 5103,
  "hero-fall-take": 4101, "hero-wake-take": 4102, "hero-mirror-take": 4103, "hero-sit-take": 4104, "hero-refuse-take": 4105,
  "sister-door-take": 4106, "sister-hand-take": 4107, "sister-offer-take": 4108,
  "bowl-take": 4201,
};

/** 道具：和立绘一样纯色背景出图、抠成一层，但角色是 prop，归属指角色库里的道具块。 */
const PROPS = new Set(["bowl"]);
export const roleFor = (stand) => (PROPS.has(stand) ? "prop" : "stand");

/** 提示词块 → 它产出的素材 id：角色图与母版直接出图；立绘先出一张 take，抠像后才是立绘。 */
export const outputOf = (promptId) => {
  const base = promptId.replace(/-prompt$/, "");
  return /-(sheet|plate)$/.test(base) ? base : `${base}-take`;
};
/** 立绘的 take → 抠好的立绘 id。不是立绘的 take（母版、角色图）没有。 */
export const standOf = (id) => (/-take$/.test(id) ? id.replace(/-take$/, "") : null);
/** 素材画的是谁：母版归场景（去掉 -plate），其余归 id 第一段的那个角色。 */
export const ofFor = (id) => {
  const base = id.replace(/-take$/, "");
  return `characters.geml#${/-plate$/.test(base) ? base.replace(/-plate$/, "") : base.split("-")[0]}`;
};
/**
 * 抠像：只有和画面边缘连通的那片纯色才是背景。
 *
 * 单靠 colorkey 不行——银发、偏蓝的肤色和浅紫背景的色距只有几个百分点：容差松了脸变半透明，
 * 容差紧了头发里出洞。所以先用松容差把背景一色抠成 alpha=0，再从 (0,0) floodfill 把与边缘
 * 连通的那片标成 1，其余（人物内部所有像素，不管颜色多接近键色）一律补回 255，最后把 alpha
 * 柔化一像素。全是 ffmpeg，同一份输入永远出同一串字节。参数记进 KEY_PARAMS → 记录的 params。
 */
export const KEY_PARAMS = { method: "colorkey+floodfill", similarity: 0.22, feather: 1 };
export const keyArgs = (input, output, hex) => ["-loglevel", "error", "-y", "-i", input, "-filter_complex",
  `[0]colorkey=0x${hex}:${KEY_PARAMS.similarity}:0.0,format=rgba,split[c][c2];`
  + `[c]alphaextract,format=gray,floodfill=x=0:y=0:s0=0:d0=1,lut=y='if(eq(val,1),0,255)',boxblur=${KEY_PARAMS.feather}:1[a];`
  + "[c2][a]alphamerge",
  "-pix_fmt", "rgba", output];
/** 抠像参数变了就重抠：拿日志里该产出最后一条记录的 params（去掉键色）和现在的比。没记录也算变了。 */
export function keyParamsChanged(logText, stand) {
  const last = logText.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((r) => r.output === `#${stand}`).pop();
  if (last === undefined || last.params === undefined) return true;
  const { key, ...rest } = last.params;
  void key;
  return JSON.stringify(rest) !== JSON.stringify(KEY_PARAMS);
}
export const STEPS = ["images", "stands", "compose", "takes", "voices", "music", "cut", "render"];

// 出图前看磁盘。q8 模型跑起来会把别的进程挤进换页文件，换页文件在同一块盘上：实测一轮出图把
// 可用空间从 9GB 吃到 0.8GB。低于 2GB 就停，让人腾地方，不猜着往下跑。
const MIN_DISK = 2 * 1024 ** 3;
export const diskOk = (freeBytes) => freeBytes >= MIN_DISK;
export function assertDisk(freeBytes) {
  if (diskOk(freeBytes)) return;
  throw new Error(`磁盘只剩 ${(freeBytes / 1024 ** 3).toFixed(1)}GB：出图会把换页文件写满这块盘，腾出 2GB 以上再继续（已出的图都登记了，重跑接着做）`);
}
const freeDisk = (dir) => { const s = statfsSync(dir); return s.bavail * s.bsize; };

const table = (doc, id, root) => blockBody(doc, id, root).split("\n").slice(2).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));

/** 分镜表：[{ id, duration, motion, line }] */
export function shots(root = EP) {
  return table("script.geml", "shots", root).map(([id, d, motion, , line]) => ({ id, duration: Number(d), motion, line: line.replace(/^#/, "") }));
}

/** 运镜 → ffmpeg zoompan 的表达式。N = 帧数；on = 当前帧。 */
export function motionExpr(motion) {
  const p = "(on/N)";
  const center = { x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
  switch (motion) {
    case "推近": return { z: `1+0.18*${p}`, ...center };
    case "缓推": return { z: `1+0.08*${p}`, ...center };
    case "拉远": return { z: `1.22-0.22*${p}`, ...center };
    case "横移": return { z: "1.14", x: `(iw-iw/zoom)*${p}`, y: center.y };
    default: throw new Error(`不认识的运镜「${motion}」：分镜表只认 推近 / 缓推 / 拉远 / 横移`);
  }
}

/** 出图命令的参数。讲解片画面上那条命令也由它生成，和真正跑的逐字一致。 */
export const mfluxArgs = (prompt, seed, out) => ["--low-ram", "--model", MODEL, "--prompt", prompt, "--seed", String(seed),
  "--width", String(W), "--height", String(H), "--steps", "9", "--no-metadata", "--output", out];
export { MFLUX };

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"] });
  if (r.error?.code === "ENOENT") throw new Error(`找不到 ${cmd}`);
  if (r.status !== 0) throw new Error(`${what} 失败：\n${r.stderr}`);
}

const say = (s) => console.log(s);

function todo(root) {
  return JSON.parse(geml(["media", "todo", ".", "--root", ".", "--json"], { root }).stdout);
}

// 1. 出图
function images(root) {
  for (const it of todo(root).filter((x) => x.kind === "generate")) {
    const promptId = it.address.split("#")[1];
    const out = outputOf(promptId);
    if (SEEDS[out] === undefined) throw new Error(`#${out} 没有种子：先在 SEEDS 里给它一个，同模型同提示词同种子才出同一张图`);
    assertDisk(freeDisk(root));
    const file = `assets/${out}.png`;
    const t0 = Date.now();
    run(MFLUX, mfluxArgs(it.prompt.trim(), SEEDS[out], join(root, file)), `出图 #${out}`);
    const role = /-sheet$/.test(out) ? "sheet" : /-plate$/.test(out) ? "master" : "take";
    registerFile(LIB, out, file, { kind: "image", role, of: ofFor(out) }, root);
    logGen(LIB, { output: out, model: "z-image-turbo-q8", mode: "t2i", prompt: it.address, seed: SEEDS[out] }, root);
    say(`出图  #${out}  seed ${SEEDS[out]}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}

/** 原图左上角 (5,5) 那个像素的颜色，十六进制：纯色背景就是它。 */
function cornerColor(png) {
  const r = spawnSync(FFMPEG, ["-loglevel", "error", "-i", png, "-vf", "crop=1:1:5:5", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (r.status !== 0) throw new Error(`取键色失败：${r.stderr}`);
  return Buffer.from(r.stdout.subarray(0, 3)).toString("hex");
}

// 2. 抠像：立绘的 take → 带 alpha 的立绘。以后换抠图模型只换这一步，合成不动。
function stands(root) {
  const log = blockBody(LIB, "gen-log", root);
  for (const take of Object.keys(SEEDS)) {
    const stand = standOf(take);
    if (stand === null) continue;
    if (!needsRegen(LIB, stand, root) && !keyParamsChanged(log, stand)) continue;
    if (!hasBlock(LIB, take, root)) throw new Error(`#${take} 还没有图：先出图`);
    const src = join(root, blockAttrs(LIB, take, root).src);
    const hex = cornerColor(src);
    const file = `assets/${stand}.png`;
    run(FFMPEG, keyArgs(src, join(root, file), hex), `抠像 #${stand}`);
    const reg = registerFile(LIB, stand, file, { kind: "image", role: roleFor(stand), of: ofFor(stand) }, root);
    logGen(LIB, { output: stand, model: "ffmpeg-colorkey", mode: "other", inputs: [take], params: { key: `#${hex}`, ...KEY_PARAMS } }, root);
    say(`抠像  #${stand}  键色 #${hex}`);
    if (reg.dropped !== undefined) say(`      #${stand} 是新图，旧的点作废了（${reg.dropped}）：重标之后合成才会过`);
  }
}

// 3. 合成：剧本里每镜一个 comp，compose 把母版与立绘叠成关键帧并自己登记（各层就是 inputs）。
function compose(root) {
  for (const s of shots(root)) {
    const key = `${s.id}-key`;
    if (!needsRegen(LIB, key, root)) continue;
    geml(["media", "compose", `script.geml#${s.id}-comp`, "--out", `assets/${key}.png`, "--log", LIB, "--as", `#${key}`, "--root", "."], { root });
    say(`合成  #${key}`);
  }
}

// 2. 配音
function voices(root) {
  const cast = Object.fromEntries(table("characters.geml", "voices", root).map(([, id, voice]) => [`characters.geml${id}`, voice]));
  const installed = parseVoices(spawnSync("say", ["-v", "?"], { encoding: "utf8" }).stdout ?? "");
  for (const it of todo(root).filter((x) => x.kind === "voice")) {
    const line = it.address.split("#")[1];
    const speaker = blockAttrs("script.geml", line, root).speaker;
    const want = cast[speaker];
    if (want === undefined) throw new Error(`角色库的声音表里没有 ${speaker}`);
    // 同名的声音有好几个语言版本（Reed 有德语、英语、中文……）：台词是中文，先挑中文区域的那个。
    const named = installed.filter((x) => x.name === want || x.name.startsWith(`${want} (`));
    const v = named.find((x) => x.locale.startsWith("zh")) ?? named[0];
    if (v === undefined) throw new Error(`本机没有声音「${want}」`);
    const out = `${line}-vo`;
    const file = `assets/${out}.m4a`;
    sayTo(it.prompt.trim(), v.name, join(root, file));
    const a = registerFile(LIB, out, file, { kind: "audio", role: "voice", of: speaker }, root);
    logGen(LIB, { output: out, model: `say-${v.name.replace(/\s*\(.*$/, "")}-${v.locale}`, mode: "tts", prompt: it.address }, root);
    say(`配音  #${out}  ${want}  ${a.duration}s`);
  }
}

// 4. 运镜：读关键帧 #sNN-key，不知道也不必知道它是合成来的
function takes(root) {
  for (const s of shots(root)) {
    const out = `${s.id}-take`;
    if (!needsRegen(LIB, out, root)) continue;
    const key = `${s.id}-key`;
    if (!hasBlock(LIB, key, root)) throw new Error(`#${key} 还没有图：先出图`);
    const n = Math.round((s.duration + 0.5) * FPS);
    const m = motionExpr(s.motion);
    const file = `assets/${out}.mp4`;
    run(FFMPEG, ["-loglevel", "error", "-y", "-i", join(root, blockAttrs(LIB, key, root).src),
      "-vf", `scale=${W * 4}:-1,zoompan=z='${m.z.replaceAll("N", String(n))}':x='${m.x.replaceAll("N", String(n))}':y='${m.y.replaceAll("N", String(n))}':d=${n}:s=${W}x${H}:fps=${FPS}`,
      "-frames:v", String(n), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", join(root, file)], `运镜 #${out}`);
    registerFile(LIB, out, file, { kind: "video", role: "take" }, root);
    logGen(LIB, { output: out, model: "ffmpeg-zoompan", mode: "i2v", inputs: [key] }, root);
    say(`运镜  #${out}  ${s.motion}  ${s.duration}s`);
  }
}

// 4. 配乐
function music(root) {
  if (!needsRegen(LIB, "bgm", root)) return;
  const total = shots(root).reduce((a, s) => a + s.duration, 0) + 2;
  const dir = mkdtempSync(join(tmpdir(), "episode-bgm-"));
  try {
    writeFileSync(join(dir, "bgm.wav"), wav(synthMusic(total)));
    run(FFMPEG, ["-loglevel", "error", "-y", "-i", join(dir, "bgm.wav"), "-c:a", "aac", "-b:a", "128k", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", join(root, "assets/bgm.m4a")], "配乐");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  registerFile(LIB, "bgm", "assets/bgm.m4a", { kind: "audio", role: "take" }, root);
  logGen(LIB, { output: "bgm", model: "make-music.mjs", mode: "other" }, root);
  say(`配乐  #bgm  ${total}s`);
}

// 5. 剪辑
export function layCut(root = EP) {
  const r3 = (x) => Number(x.toFixed(3));
  const list = shots(root);
  const total = list.reduce((a, s) => a + s.duration, 0);
  const out = [
    "=== meta", 'title = "《重生之夜》第一集 · 时间线"', 'profile = "geml-media/v1"', 'aspect = "9:16"', "===", "",
    "%% 由 tools/produce-episode.mjs 从分镜表与配音时长派生。", "",
    '==== media {#ep01 tracks="video:video dialogue:audio music:audio sub-zh:prose sub-en:prose" primary=video fps=30}', "",
  ];
  const clip = (a) => out.push(`=== media-clip {${a}}`, "===", "");
  list.forEach((s, i) => clip(`#c${i + 1} track=video src=library.geml#${s.id}-take in=0 out=${s.duration}`));
  clip(`#music track=music src=library.geml#bgm over=#c1 in=0 out=${total} gain=-16dB fade-in=1 fade-out=2`);
  list.forEach((s, i) => {
    const dur = r3(Number(blockAttrs(LIB, `${s.line}-vo`, root).duration));
    clip(`#d-${s.line} track=dialogue src=library.geml#${s.line}-vo over=#c${i + 1} offset=${LEAD}`);
    clip(`#t-${s.line} track=sub-zh src=script.geml#${s.line} over=#c${i + 1} offset=${LEAD} duration=${dur}`);
    clip(`#e-${s.line} track=sub-en src=script.geml#${s.line}-en over=#c${i + 1} offset=${LEAD} duration=${dur}`);
  });
  out.push("====", "");
  writeFileSync(join(root, "cut.geml"), out.join("\n"));
  say(`剪辑  cut.geml  ${list.length} 镜  ${total}s`);
}

// 6. 出片：build，然后把 srt 里的中英字幕画成透明图层叠进去
const toSec = (s) => { const [h, m, r] = s.split(":"); return Number(h) * 3600 + Number(m) * 60 + Number(r.replace(",", ".")); };

// 中文与英文同锚、同时长：同一时段的两条字幕合成一组。谁是中文按内容认（含汉字），不按 srt 里的
// 先后——build 导出时同一时刻的两条并不保证哪条在前（实测第一版字幕就这样上下颠倒了）。
const CJK = /[\u3400-\u9fff]/;
export function cues(srt) {
  const out = [];
  for (const blk of srt.trim().split(/\n\s*\n/)) {
    const [, time, ...text] = blk.split("\n");
    const [a, b] = time.split(" --> ").map(toSec);
    const line = text.join(" ");
    let g = out.find((x) => x.a === a && x.b === b);
    if (g === undefined) { g = { a, b, zh: "", en: "" }; out.push(g); }
    if (CJK.test(line)) g.zh = line; else g.en = line;
  }
  return out.sort((x, y) => x.a - y.a);
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const subPage = ({ zh, en }) => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
.s{position:absolute;left:40px;right:40px;bottom:170px;text-align:center;font-family:"PingFang SC",sans-serif;color:#fff;
text-shadow:0 0 6px #000,0 2px 3px #000,0 0 2px #000}.zh{font-size:42px;font-weight:700;line-height:1.35}.en{font-size:26px;margin-top:10px;opacity:.95}</style>
<div class="s"><div class="zh">${esc(zh)}</div><div class="en">${esc(en)}</div></div><script>document.fonts.ready.then(()=>{window.__ready=true})</script>`;

async function render(root) {
  mkdirSync(join(root, "out"), { recursive: true });
  const raw = "out/ep01-raw.mp4";
  geml(["media", "build", "cut.geml", "--out", raw, "--root", "."], { root });
  const groups = cues(readFileSync(join(root, "out/ep01-raw.srt"), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "episode-subs-"));
  const page = await openBrowser({ width: W, height: H, transparent: true });
  try {
    for (const [i, g] of groups.entries()) {
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(subPage(g))}`);
      writeFileSync(join(dir, `${i}.png`), await page.screenshot());
    }
  } finally { await page.close(); }
  const args = ["-loglevel", "error", "-y", "-i", join(root, raw)];
  for (let i = 0; i < groups.length; i++) args.push("-i", join(dir, `${i}.png`));
  const chain = groups.map((g, i) => `[${i === 0 ? "0:v" : `v${i}`}][${i + 1}:v]overlay=0:0:enable='between(t,${g.a.toFixed(3)},${g.b.toFixed(3)})'[v${i + 1}]`).join(";");
  args.push("-filter_complex", chain, "-map", `[v${groups.length}]`, "-map", "0:a", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", join(root, "out/ep01.mp4"));
  try { run(FFMPEG, args, "烧字幕"); } finally { rmSync(dir, { recursive: true, force: true }); }
  say(`出片  episode/out/ep01.mp4  ${groups.length} 组双语字幕`);
}

async function main(argv) {
  const i = argv.indexOf("--until");
  const until = i >= 0 ? argv[i + 1] : "render";
  if (!STEPS.includes(until)) throw new Error(`--until 只认 ${STEPS.join(" / ")}`);
  const root = EP;
  for (const step of STEPS.slice(0, STEPS.indexOf(until) + 1)) {
    if (step === "images") images(root);
    if (step === "stands") stands(root);
    if (step === "compose") compose(root);
    if (step === "takes") takes(root);
    if (step === "voices") voices(root);
    if (step === "music") music(root);
    if (step === "cut") layCut(root);
    if (step === "render") await render(root);
  }
  const left = todo(root);
  say(left.length === 0 ? "todo: 没有待办" : `todo: 还有 ${left.length} 项`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
