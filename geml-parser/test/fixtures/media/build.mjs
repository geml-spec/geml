// 夹具生成器：把设计记录 §3 的那一集用 geml-media/v1 的词汇写出来。
//
//   node test/fixtures/media/build.mjs
//
// 提示词的哈希**必须由解析器算**，不能手工拼字符串：角色卡里的 `**银灰短发齐耳**`
// 展开后是纯文本，没有星号，拼接的人会把标记一起算进去。所以这里先写角色库与剧本，
// 再用 promptTextOf 展开取哈希，最后写素材库 —— 和检查器走同一个实现。
//
// 素材是几十字节的真文件：本机没有生成器也没有 ffmpeg，要验的是文档这一层。
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promptTextOf } from "../../../dist/media-check.js";
import { mediaIoFor } from "../../../dist/host-fs.js";

const R = dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const w = (rel, body) => { mkdirSync(dirname(join(R, rel)), { recursive: true }); writeFileSync(join(R, rel), body); };

const bytes = {
  "ep01/assets/hero-sheet.png": "SHEET:hero",
  "ep01/assets/s01-key.png": "KEY:s01",
  "ep01/assets/s01-take3.mp4": "TAKE:s01-3",
  "ep01/assets/s03-take2.mp4": "TAKE:s03-2",
  "ep01/assets/s03-l1-vo.wav": "VO:s03-l1",
  "ep01/assets/s03-take2-lips.mp4": "LIPS:s03-2",
};
const H = {};
for (const [rel, body] of Object.entries(bytes)) { w(rel, body); H[rel] = sha(body); }
const A = (p) => H["ep01/assets/" + p];

const look = "二十六岁女性，**银灰短发齐耳**，左眉一道旧疤，红色长风衣。";
const sisterLook = "二十三岁女性，栗色长卷发，白色连衣裙。";
const style = "2D 手绘赛璐璐风，冷色调，蓝紫主色。";
const l1 = "姐……你怎么会……";

w("characters.geml",
  '=== meta\ntitle = "《重生之夜》角色库"\nprofile = "geml-media/v1"\n===\n\n'
  + "# 演员表 {#cast}\n\n=== table {#cast-table}\n| id | 角色 | 定位 |\n|---|---|---|\n| #hero | 林夏 | 女主 |\n| #sister | 林岚 | 反派 |\n===\n\n"
  + `# 林夏 {#hero}\n\n=== media-text {#hero-look .look}\n${look}\n===\n\n`
  + `# 林岚 {#sister}\n\n=== media-text {#sister-look .look}\n${sisterLook}\n===\n\n`
  + `# 风格板 {#look-board}\n\n=== media-text {#look}\n${style}\n===\n`);

w("ep01/ep01-script.geml",
  '=== meta\ntitle = "EP01"\nprofile = "geml-media/v1"\nepisode = 1\naspect = "9:16"\n===\n\n'
  + "# 分镜表 {#board}\n\n=== table {#shots}\n| 镜号 | 时长 | 角色 |\n|---|---|---|\n| s01 | 4 | #hero |\n| s03 | 6 | #sister #hero |\n===\n\n"
  + "# 镜头 {#shot-blocks}\n\n"
  + "=== media-text {#s01-prompt .prompt shot=s01}\n![[../characters.geml#look]] ![[../characters.geml#hero-look]] 特写，从闭眼开始，猛然睁开。\n===\n\n"
  + "=== media-text {#s03-prompt .prompt shot=s03}\n![[../characters.geml#look]] 中景双人。左：![[../characters.geml#sister-look]] 右：![[../characters.geml#hero-look]]\n===\n\n"
  + `=== media-text {#s03-l1 .line speaker=../characters.geml#sister to=../characters.geml#hero emotion=假哭}\n${l1}\n===\n`);

// 展开后的真实文本，由解析器给。
const io = mediaIoFor(R);
const P = (id) => {
  const t = promptTextOf(`ep01/ep01-script.geml#${id}`, "", io);
  if (t === null) throw new Error("展不开 " + id);
  return sha(Buffer.from(t, "utf8"));
};
const REF = (id, text) => ({ ref: `../characters.geml#${id}`, sha256: sha(Buffer.from(text, "utf8")) });
// 投射源的现值同样按展开取：`**…**` 在展开后没有星号。
const plain = (id) => {
  const t = promptTextOf(`characters.geml#${id}`, "", io);
  if (t === null) throw new Error("展不开 " + id);
  return { ref: `../characters.geml#${id}`, sha256: sha(Buffer.from(t, "utf8")) };
};
const refLook = plain("look"), refHero = plain("hero-look"), refSis = plain("sister-look");

const rec = (o) => JSON.stringify(o);
w("ep01/ep01-library.geml",
  '=== meta\ntitle = "EP01 素材库"\nprofile = "geml-media/v1"\n===\n\n'
  + "# 共享素材 {#shared}\n\n"
  + `=== media-asset {#hero-sheet src=assets/hero-sheet.png sha256=${A("hero-sheet.png")} kind=image origin=generated of=../characters.geml#hero role=sheet}\n===\n\n`
  + "# 本集产出 {#local}\n\n"
  + `=== media-asset {#s01-key src=assets/s01-key.png sha256=${A("s01-key.png")} kind=image origin=generated}\n===\n\n`
  + `=== media-asset {#s01-take3 src=assets/s01-take3.mp4 sha256=${A("s01-take3.mp4")} kind=video duration=5 origin=generated}\n===\n\n`
  + `=== media-asset {#s03-take2 src=assets/s03-take2.mp4 sha256=${A("s03-take2.mp4")} kind=video duration=6 origin=generated}\n===\n\n`
  + `=== media-asset {#s03-l1-vo src=assets/s03-l1-vo.wav sha256=${A("s03-l1-vo.wav")} kind=audio duration=2.1 origin=generated}\n===\n\n`
  + `=== media-asset {#s03-take2-lips src=assets/s03-take2-lips.mp4 sha256=${A("s03-take2-lips.mp4")} kind=video duration=6 origin=generated}\n===\n\n`
  + "# 生成日志 {#gen}\n\n=== data {#gen-log .gen-log format=jsonl}\n"
  + [
    { output: "#s01-key", "output-sha256": A("s01-key.png"), model: "jimeng-4.5", mode: "t2i", seed: 20481,
      prompt: "ep01-script.geml#s01-prompt", "prompt-sha256": P("s01-prompt"), "prompt-refs": [refLook, refHero],
      inputs: [{ ref: "#hero-sheet", sha256: A("hero-sheet.png"), role: "sheet" }], at: "2026-09-15T09:12:03Z" },
    { output: "#s01-take3", "output-sha256": A("s01-take3.mp4"), model: "seedance-2.0", mode: "i2v", seed: 88213,
      prompt: "ep01-script.geml#s01-prompt", "prompt-sha256": P("s01-prompt"), "prompt-refs": [refLook, refHero],
      inputs: [{ ref: "#s01-key", sha256: A("s01-key.png"), role: "first-frame" }], at: "2026-09-15T09:20:41Z" },
    { output: "#s03-take2", "output-sha256": A("s03-take2.mp4"), model: "seedance-2.0", mode: "t2v", seed: 41007,
      prompt: "ep01-script.geml#s03-prompt", "prompt-sha256": P("s03-prompt"), "prompt-refs": [refLook, refSis, refHero],
      inputs: [{ ref: "#hero-sheet", sha256: A("hero-sheet.png"), role: "sheet" }], at: "2026-09-15T10:02:55Z" },
    { output: "#s03-l1-vo", "output-sha256": A("s03-l1-vo.wav"), model: "cosyvoice-3", mode: "tts",
      prompt: "ep01-script.geml#s03-l1", "prompt-sha256": P("s03-l1"), "prompt-refs": [],
      inputs: [], params: { emotion: "假哭" }, at: "2026-09-15T10:11:40Z" },
    { output: "#s03-take2-lips", "output-sha256": A("s03-take2-lips.mp4"), model: "sekotalk-2.0", mode: "lipsync",
      inputs: [{ ref: "#s03-take2", sha256: A("s03-take2.mp4") }, { ref: "#s03-l1-vo", sha256: A("s03-l1-vo.wav") }],
      params: { speakers: 1 }, at: "2026-09-15T10:20:31Z" },
  ].map(rec).join("\n") + "\n===\n");

w("ep01/ep01-cut.geml",
  '=== meta\ntitle = "EP01 粗剪"\nprofile = "geml-media/v1"\nfps = 24\ntracks = "video:video dialogue:audio subtitle:prose"\nprimary = "video"\n===\n\n'
  + "# 第一场 {#sc01}\n\n"
  + "=== media-clip {#c01 track=video src=ep01-library.geml#s01-take3 in=0 out=4}\n===\n\n"
  + "=== media-clip {#c03 track=video src=ep01-library.geml#s03-take2-lips in=0 out=6 transition-in=cut}\n===\n\n"
  + "=== media-clip {#vo-s03-l1 track=dialogue src=ep01-library.geml#s03-l1-vo over=#c03 offset=0.4 gain=0dB}\n===\n\n"
  + "=== media-clip {#sub-s03-l1 track=subtitle src=ep01-script.geml#s03-l1 over=#c03 offset=0.4 duration=2.1}\n===\n");

console.log("夹具写好：6 个素材 + 4 份文档，提示词哈希由解析器展开后算");
