// geml-media/v1 的检查器（profile 文档 §7）。诊断码属于 profile，不进规范 Appendix A；
// 它们按**地址**报（文档 + 块 id）而不是按行号 —— 这是 profile 自己的选择，和这个
// 项目"id 优于行号"的立场一致，也因为跨文档的诊断没有单一的行号可言。
import { checkMedia } from "../dist/media-check.js";
import { importKindOf, parseCues, importSubtitles, idsTaken, assetBlockFor } from "../dist/media-verbs.js";
import { profileIoFor } from "../dist/host-fs.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

/** 在临时目录里搭一个项目，返回它的根。 */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), "geml-media-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof body === "string" ? body : body, typeof body === "string" ? "utf8" : undefined);
  }
  return root;
}
const META = '=== meta\nprofile = "geml-media/v1"\n===\n\n';
const codes = (ds) => ds.map((d) => d.code).sort();

test("干净的一份素材库没有诊断", () => {
  const root = project({
    "lib.geml": META + '=== media-asset {#a src=a.txt sha256=' + "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" + ' kind=other}\n===\n',
    "a.txt": "",
  });
  const ds = checkMedia("lib.geml", profileIoFor(root));
  assert.deepEqual(ds, [], JSON.stringify(ds));
  rmSync(root, { recursive: true, force: true });
});

test("哈希不符是 error，文件缺失是 warning，没哈希是 warning", () => {
  const root = project({
    "lib.geml": META
      + "=== media-asset {#wrong src=a.txt sha256=aaaa kind=other}\n===\n\n"
      + "=== media-asset {#gone src=nope.txt sha256=bbbb kind=other}\n===\n\n"
      + "=== media-asset {#bare src=a.txt kind=other}\n===\n",
    "a.txt": "",
  });
  const ds = checkMedia("lib.geml", profileIoFor(root));
  assert.deepEqual(codes(ds), ["media-asset-unhashed", "media-file-missing", "media-hash-mismatch"], JSON.stringify(ds));
  const mismatch = ds.find((d) => d.code === "media-hash-mismatch");
  assert.equal(mismatch.severity, "error");
  assert.equal(mismatch.id, "wrong", "诊断要点名是哪个块");
  rmSync(root, { recursive: true, force: true });
});

test("轨道：名字缺种类、种类不认识、片段没有 track=", () => {
  const root = project({
    "cut.geml": '=== meta\nprofile = "geml-media/v1"\n===\n\n==== media {#tl tracks="video:video bare subtitle:caption"}\n\n'
      + "=== media-clip {#c1 src=#x}\n===\n\n====\n",
  });
  const ds = checkMedia("cut.geml", profileIoFor(root));
  const c = codes(ds);
  assert.ok(c.includes("media-track-kind-missing"), JSON.stringify(ds));
  assert.ok(c.includes("media-track-kind-unknown"), JSON.stringify(ds));
  assert.ok(c.includes("media-track-missing"), JSON.stringify(ds));
  rmSync(root, { recursive: true, force: true });
});

// ---- 血缘：过期与传播 -------------------------------------------------------

import { createHash } from "node:crypto";
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** 一个最小的血缘项目：角色卡 → 提示词 → 素材 → 片段。 */
function lineageProject(look = "银灰短发齐耳。") {
  const asset = "TAKE-BYTES";
  const promptText = look + " 特写，缓推。";
  return {
    files: {
      "a.mp4": asset,
      "script.geml": META
        + `=== media-text {#look .look}\n${look}\n===\n\n`
        + "=== media-text {#p .prompt shot=s01}\n![[#look]] 特写，缓推。\n===\n",
      "lib.geml": META
        + `=== media-asset {#take src=a.mp4 sha256=${sha(asset)} kind=video duration=5}\n===\n\n`
        + '=== data {#gen-log .gen-log format=jsonl}\n'
        + JSON.stringify({
            output: "#take", "output-sha256": sha(asset), model: "m", mode: "t2v",
            prompt: "script.geml#p", "prompt-sha256": sha(promptText),
            "prompt-refs": [{ ref: "script.geml#look", sha256: sha(look) }],
            at: "2026-09-15T00:00:00Z",
          }) + "\n===\n",
      "cut.geml": '=== meta\nprofile = "geml-media/v1"\n===\n\n==== media {#tl tracks="video:video"}\n\n'
        + "=== media-clip {#c1 track=video src=lib.geml#take in=0 out=5}\n===\n\n====\n",
    },
  };
}

test("血缘：源头没动时，没有过期", () => {
  const root = project(lineageProject().files);
  const ds = checkMedia("cut.geml", profileIoFor(root));
  assert.deepEqual(ds, [], JSON.stringify(ds));
  rmSync(root, { recursive: true, force: true });
});

test("血缘：改角色卡一个词 —— 记录过期，用它的片段跟着过期，且诊断点名是哪个源", () => {
  const p = lineageProject();
  p.files["script.geml"] = p.files["script.geml"].replace("银灰短发齐耳。", "银灰短发及肩。");
  const root = project(p.files);
  const ds = checkMedia("cut.geml", profileIoFor(root));
  const gen = ds.find((d) => d.code === "media-stale-generation");
  const clip = ds.find((d) => d.code === "media-stale-clip");
  assert.ok(gen, "记录该过期: " + JSON.stringify(ds));
  assert.match(gen.message, /#look/, "消息要点名变了的那个投射源，而不是只说提示词变了");
  assert.ok(clip, "用它的片段该跟着过期");
  assert.equal(clip.id, "c1");
  rmSync(root, { recursive: true, force: true });
});

test("血缘：日志缺必需字段是 media-gen-schema，点名记录序号与字段", () => {
  const root = project({
    "lib.geml": META + '=== data {#gen-log .gen-log format=jsonl}\n{"output":"#x","model":"m"}\n===\n',
  });
  const ds = checkMedia("lib.geml", profileIoFor(root));
  const d = ds.find((x) => x.code === "media-gen-schema");
  assert.ok(d, JSON.stringify(ds));
  assert.match(d.message, /\[0\]/, "要点名是第几条记录");
  assert.match(d.message, /mode|at/, "要点名缺的是哪个字段");
  rmSync(root, { recursive: true, force: true });
});

test("片段：src 悬空、指错类型、缺 dur、轨道没声明", () => {
  const root = project({
    "lib.geml": META + "=== media-text {#line .line speaker=#who}\n台词\n===\n\n"
      + "=== media-asset {#still src=s.png kind=image}\n===\n\n"
      + "=== media-text {#who}\n角色\n===\n",
    "s.png": "PNG",
    "cut.geml": '=== meta\nprofile = "geml-media/v1"\n===\n\n==== media {#tl tracks="video:video sub:prose"}\n\n'
      + "=== media-clip {#gone track=video src=lib.geml#nope}\n===\n\n"
      + "=== media-clip {#wrong track=video src=lib.geml#line}\n===\n\n"
      + "=== media-clip {#nodur track=video src=lib.geml#still}\n===\n\n"
      + "=== media-clip {#odd track=ghost src=lib.geml#still duration=2}\n===\n\n====\n",
  });
  const c = codes(checkMedia("cut.geml", profileIoFor(root)));
  for (const want of ["media-src-unresolved", "media-src-not-asset", "media-duration-required", "media-track-undeclared"]) {
    assert.ok(c.includes(want), want + " 没报出: " + c.join(","));
  }
  rmSync(root, { recursive: true, force: true });
});

test("散文轨：src 必须指 media-text，且必须有 dur", () => {
  const root = project({
    "lib.geml": META + "=== media-asset {#a src=a.txt kind=other}\n===\n\n=== media-text {#l .line speaker=#w}\n台词\n===\n\n=== media-text {#w}\n人\n===\n",
    "a.txt": "",
    "cut.geml": '=== meta\nprofile = "geml-media/v1"\n===\n\n==== media {#tl tracks="sub:prose"}\n\n'
      + "=== media-clip {#bad track=sub src=lib.geml#a duration=1}\n===\n\n"
      + "=== media-clip {#nodur track=sub src=lib.geml#l}\n===\n\n====\n",
  });
  const c = codes(checkMedia("cut.geml", profileIoFor(root)));
  assert.ok(c.includes("media-src-not-asset"), c.join(","));
  assert.ok(c.includes("media-duration-required"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("台词与素材的引用：speaker 必填、speaker/to/of 悬空各自报出", () => {
  const root = project({
    "lib.geml": META
      + "=== media-text {#a .line}\n没有说话人\n===\n\n"
      + "=== media-text {#b .line speaker=#ghost to=#alsogone}\n有，但指不到\n===\n\n"
      + "=== media-asset {#x src=x.txt kind=other of=#nobody}\n===\n",
    "x.txt": "",
  });
  const ds = checkMedia("lib.geml", profileIoFor(root));
  const c = codes(ds);
  assert.ok(c.includes("media-line-no-speaker"), c.join(","));
  assert.equal(ds.filter((d) => d.code === "media-speaker-unresolved").length, 2, "speaker 与 to 各一条");
  assert.ok(c.includes("media-of-unresolved"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("血缘：现在的字节没有任何记录认领 —— media-orphan-record", () => {
  const p = lineageProject();
  p.files["a.mp4"] = "DIFFERENT-BYTES";      // 文件换了，日志没跟上
  const root = project(p.files);
  const c = codes(checkMedia("lib.geml", profileIoFor(root)));
  assert.ok(c.includes("media-orphan-record"), c.join(","));
  assert.ok(c.includes("media-hash-mismatch"), "素材块声明的哈希也对不上了: " + c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("血缘：过期沿 DAG 向下传播 —— 上游的 take 变了，吃它的合成也过期", () => {
  const base = "TAKE";
  const comp = "COMPOSITE";
  const root = project({
    "a.mp4": base,
    "b.mp4": comp,
    "lib.geml": META
      + `=== media-asset {#take src=a.mp4 sha256=${sha(base)} kind=video duration=5}\n===\n\n`
      + `=== media-asset {#lips src=b.mp4 sha256=${sha(comp)} kind=video duration=5}\n===\n\n`
      + '=== data {#gen-log .gen-log format=jsonl}\n'
      + JSON.stringify({ output: "#take", "output-sha256": sha(base), model: "m", mode: "t2v",
          inputs: [{ ref: "#seed", sha256: "0000" }], at: "2026-09-15T00:00:00Z" }) + "\n"
      + JSON.stringify({ output: "#lips", "output-sha256": sha(comp), model: "m", mode: "lipsync",
          inputs: [{ ref: "#take", sha256: sha(base) }], at: "2026-09-15T01:00:00Z" }) + "\n===\n\n"
      + `=== media-asset {#seed src=a.mp4 sha256=${sha(base)} kind=video duration=5}\n===\n`,
  });
  const ds = checkMedia("lib.geml", profileIoFor(root));
  const stale = ds.filter((d) => d.code === "media-stale-generation").map((d) => d.id).sort();
  assert.deepEqual(stale, ["lips", "take"], "take 因输入哈希对不上而过期，lips 因上游过期而过期: " + JSON.stringify(ds));
  assert.match(ds.find((d) => d.id === "lips").message, /上游过期/);
  rmSync(root, { recursive: true, force: true });
});
// ---- 夹具：设计记录 §3 的那一集，用 geml-media/v1 的词汇写成 -----------------
//
// 验收（§14 P1）：四份文档 check 干净；每处故意改坏，各得到对应的那一条诊断。
// 夹具本身由 test/fixtures/media/build.mjs 生成，哈希是真算的。

import { cpSync, readFileSync as read, writeFileSync as write } from "node:fs";
import { fileURLToPath } from "node:url";

const FIX = fileURLToPath(new URL("./fixtures/media", import.meta.url));
/** 把夹具复制到临时目录再改，committed 的那份永远不动。 */
function fixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), "geml-fix-"));
  cpSync(FIX, root, { recursive: true });
  if (mutate) mutate({
    root,
    edit: (rel, from, to) => write(join(root, rel), read(join(root, rel), "utf8").replace(from, to)),
    put: (rel, body) => write(join(root, rel), body),
  });
  return root;
}

test("夹具：四份文档的 profile check 干净", () => {
  const root = fixture();
  for (const entry of ["ep01/ep01-cut.geml", "ep01/ep01-library.geml", "characters.geml", "ep01/ep01-script.geml"]) {
    assert.deepEqual(checkMedia(entry, profileIoFor(root)), [], entry + " 应干净");
  }
  rmSync(root, { recursive: true, force: true });
});

test("夹具：改角色卡一个词 —— 三条记录过期、两个片段过期，诊断点名 #hero-look", () => {
  const root = fixture(({ edit }) => edit("characters.geml", "银灰短发齐耳", "银灰短发及肩"));
  const ds = checkMedia("ep01/ep01-cut.geml", profileIoFor(root));
  const gens = ds.filter((d) => d.code === "media-stale-generation").map((d) => d.id).sort();
  assert.deepEqual(gens, ["s01-key", "s01-take3", "s03-take2", "s03-take2-lips"], JSON.stringify(ds));
  assert.match(ds.find((d) => d.id === "s01-key").message, /#hero-look/, "要点名是哪个投射源变了");
  const clips = ds.filter((d) => d.code === "media-stale-clip").map((d) => d.id).sort();
  assert.deepEqual(clips, ["c01", "c03"]);
  rmSync(root, { recursive: true, force: true });
});

test("夹具：换掉一个素材文件的字节 —— 哈希不符 + 来历不明", () => {
  const root = fixture(({ put }) => put("ep01/assets/s03-take2.mp4", "REGENERATED"));
  const c = codes(checkMedia("ep01/ep01-library.geml", profileIoFor(root)));
  assert.ok(c.includes("media-hash-mismatch"), c.join(","));
  assert.ok(c.includes("media-orphan-record"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("夹具：删掉一个素材文件 —— media-file-missing", () => {
  const root = fixture(({ edit }) => edit("ep01/ep01-library.geml", "src=assets/s01-key.png", "src=assets/gone.png"));
  const c = codes(checkMedia("ep01/ep01-library.geml", profileIoFor(root)));
  assert.ok(c.includes("media-file-missing"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("夹具：台词去掉 speaker= —— media-line-no-speaker", () => {
  const root = fixture(({ edit }) => edit("ep01/ep01-script.geml", " speaker=../characters.geml#sister", ""));
  const c = codes(checkMedia("ep01/ep01-script.geml", profileIoFor(root)));
  assert.ok(c.includes("media-line-no-speaker"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("夹具：把 of= 指错 —— media-of-unresolved", () => {
  const root = fixture(({ edit }) => edit("ep01/ep01-library.geml", "of=../characters.geml#hero", "of=../characters.geml#nobody"));
  const c = codes(checkMedia("ep01/ep01-library.geml", profileIoFor(root)));
  assert.ok(c.includes("media-of-unresolved"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("夹具：视频轨的片段指向台词块 —— media-src-not-asset", () => {
  const root = fixture(({ edit }) => edit("ep01/ep01-cut.geml", "src=ep01-library.geml#s01-take3", "src=ep01-script.geml#s03-l1"));
  const c = codes(checkMedia("ep01/ep01-cut.geml", profileIoFor(root)));
  assert.ok(c.includes("media-src-not-asset"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});


// ---- 动词：时间模型、导出、todo、report、import、log -------------------------

import { layout, layoutsOf } from "../dist/media-timeline.js";
import { parse } from "../dist/geml.js";
import { todo, report, exportTimeline, lay, buildPlan, appendLog, importPlan } from "../dist/media-verbs.js";

test("时间模型：主轨顺序摆放，其余轨锚在主轨上", () => {
  const root = fixture();
  const io = profileIoFor(root);
  const dur = { "ep01-library.geml#s01-take3": 5, "ep01-library.geml#s03-take2-lips": 6, "ep01-library.geml#s03-l1-vo": 2.1 };
  const tl = layout(read(join(root, "ep01/ep01-cut.geml"), "utf8"), { durationOf: (r) => dur[r] });
  const at = (id) => tl.clips.find((c) => c.id === id);
  assert.equal(at("c01").start, 0);
  assert.equal(at("c01").duration, 4, "out=4 决定时长，不是素材的 5 秒");
  assert.equal(at("c03").start, 4, "主轨第二个接在第一个的终点");
  assert.equal(at("vo-s03-l1").start, 4.4, "锚在 #c03 起点 + offset 0.4");
  assert.equal(at("sub-s03-l1").start, 4.4);
  assert.equal(tl.duration, 10);
  assert.deepEqual(tl.problems, []);
  rmSync(root, { recursive: true, force: true });
});

test("时间模型：dissolve 的重叠量从前一个的终点往回借", () => {
  const root = fixture(({ edit }) => edit("ep01/ep01-cut.geml",
    "src=ep01-library.geml#s03-take2-lips in=0 out=6 transition-in=cut",
    "src=ep01-library.geml#s03-take2-lips in=0 out=6 transition-in=dissolve transition-duration=0.5"));
  const tl = layout(read(join(root, "ep01/ep01-cut.geml"), "utf8"), { durationOf: () => undefined });
  assert.equal(tl.clips.find((c) => c.id === "c03").start, 3.5, "4 - 0.5");
  rmSync(root, { recursive: true, force: true });
});

test("export：srt 的时码来自时间模型，preview 的 #t= 来自入出点", () => {
  const root = fixture();
  const io = profileIoFor(root);
  const srt = exportTimeline("ep01/ep01-cut.geml", "srt", io);
  assert.match(srt, /00:00:04,400 --> 00:00:06,500/, srt);
  assert.match(srt, /姐……你怎么会……/, "字幕文本取自台词块，不复制");
  const html = exportTimeline("ep01/ep01-cut.geml", "preview", io);
  assert.match(html, /#t=0\.00,4\.00/, "preview 用 W3C Media Fragments 逐段播放");
  assert.ok(!/<script/i.test(html), "预览是零依赖的静态页，不含脚本");
  const otio = JSON.parse(exportTimeline("ep01/ep01-cut.geml", "otio", io));
  assert.equal(otio.OTIO_SCHEMA, "Timeline.1");
  assert.ok(otio.tracks.children.length >= 2, "视频与音频各一条轨");
  rmSync(root, { recursive: true, force: true });
});

test("todo：日志齐全时没有待办；删掉一条记录，那件事就回到清单上", () => {
  const clean = fixture();
  const all = ["characters.geml", "ep01/ep01-script.geml", "ep01/ep01-library.geml", "ep01/ep01-cut.geml"];
  assert.deepEqual(todo(all, profileIoFor(clean)), []);
  rmSync(clean, { recursive: true, force: true });

  const root = fixture(({ root: r }) => {
    const f = join(r, "ep01/ep01-library.geml");
    write(f, read(f, "utf8").split(/\r?\n/).filter((l) => !l.includes('"output":"#s03-l1-vo"')).join("\n"));
  });
  const items = todo(all, profileIoFor(root));
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].kind, "voice");
  assert.match(items[0].address, /#s03-l1$/);
  assert.match(items[0].prompt ?? "", /姐……/, "待办带的是展开后的文本，发给模型的那串字");
  rmSync(root, { recursive: true, force: true });
});

test("report：stats 按提示词统计生成次数与模型分布", () => {
  const root = fixture();
  const csv = report("ep01/ep01-library.geml", "stats", profileIoFor(root));
  assert.match(csv, /#s01-prompt,2,/, "同一条提示词生成了两次");
  assert.match(csv, /jimeng-4\.5×1 seedance-2\.0×1/);
  rmSync(root, { recursive: true, force: true });
});

test("import：按哈希去重 —— 同一个文件不会被建成第二个素材块", () => {
  const root = fixture();
  const io = profileIoFor(root);
  const plan = importPlan("ep01/ep01-library.geml", [
    { file: "assets/s01-key.png", model: "m", mode: "t2i" },
  ], io);
  assert.equal(plan.newAssets.length, 0, "这个文件已经有素材块了");
  assert.equal(plan.records.length, 1);
  assert.match(plan.notes.join(" "), /复用/);
  rmSync(root, { recursive: true, force: true });
});

test("log：追加记录的同时把素材块的 sha256 改成现值", () => {
  const src = '=== meta\nprofile = "geml-media/v1"\n===\n\n'
    + "=== media-asset {#a src=a.mp4 sha256=OLD kind=video}\n===\n\n"
    + '=== data {#gen-log .gen-log format=jsonl}\n===\n';
  const out = appendLog(src, { output: "#a", "output-sha256": "NEW", model: "m", mode: "t2v", at: "z" },
    { id: "a", sha256: "NEW", duration: 4.2 });
  assert.match(out, /sha256=NEW/, "素材块要跟着更新，否则下一次 check 是 hash-mismatch");
  assert.match(out, /duration=4\.2/);
  assert.ok(!/sha256=OLD/.test(out));
  assert.match(out, /"output":"#a"/);
});

test("build：ffmpeg 的参数由时间模型决定，字幕另出不烧进画面", () => {
  const root = fixture();
  const plan = buildPlan("ep01/ep01-cut.geml", "out.mp4", profileIoFor(root));
  assert.equal(Math.round(plan.duration * 100) / 100, 10);
  const joined = plan.args.join(" ");
  assert.match(joined, /trim=start=0\.000:end=4\.000/, "第一个片段的入出点进了 trim");
  assert.match(joined, /adelay=4400:all=1/, "配音按起点延迟；all=1 不必知道源是单声道还是立体声");
  // 音频要贯穿全长：一条 4.4s 才开始、6.5s 就结束的配音，会让交织器停在 4.35s 等下去，
  // 整条 10s 的片子卡死在那里。实测撞到过，所以静音底是断言的一部分，不是实现细节。
  assert.match(joined, /anullsrc=[^ ]*d=10.000/, "静音底与时间线等长");
  assert.match(joined, /amix=inputs=2:duration=first/, "配音混在静音底上，以底为准");
  assert.match(joined, /concat=n=2/);
  assert.ok(plan.srt !== null, "有字幕轨就出 srt 边车");
  assert.ok(!/subtitles=/.test(joined), "不烧字：烧字要 libass 与一份中文字体");
  rmSync(root, { recursive: true, force: true });
});
test("时间模型：时码按 meta.fps 换算；fps 缺失时带帧的时码无意义", () => {
  const root = fixture(({ edit }) => edit("ep01/ep01-cut.geml",
    "src=ep01-library.geml#s01-take3 in=0 out=4",
    "src=ep01-library.geml#s01-take3 in=00:00:00:12 out=00:00:04:00"));
  const tl = layout(read(join(root, "ep01/ep01-cut.geml"), "utf8"), { durationOf: () => undefined });
  const c = tl.clips.find((x) => x.id === "c01");
  assert.equal(c.in, 0.5, "12 帧 @24fps = 0.5 秒");
  assert.equal(c.duration, 3.5);
  rmSync(root, { recursive: true, force: true });
});

test("时间模型：at= 是逃生口，写了它锚定被忽略", () => {
  const root = fixture(({ edit }) => edit("ep01/ep01-cut.geml", "over=#c03 offset=0.4 gain=0dB", "at=7 gain=0dB"));
  const tl = layout(read(join(root, "ep01/ep01-cut.geml"), "utf8"),
    { durationOf: (r) => (r.endsWith("#s03-l1-vo") ? 2.1 : undefined) });
  assert.equal(tl.clips.find((c) => c.id === "vo-s03-l1").start, 7);
  rmSync(root, { recursive: true, force: true });
});

test("时间模型：算不出时长、锚不到主轨，都记成 problems 而不是静默", () => {
  const src = '=== meta\nprofile = "geml-media/v1"\n===\n\n==== media {#tl tracks="video:video vo:audio" primary=video}\n\n'
    + "=== media-clip {#a track=video src=lib.geml#x}\n===\n\n"
    + "=== media-clip {#b track=vo src=lib.geml#y over=#nope}\n===\n\n====\n";
  const tl = layout(src, { durationOf: () => undefined });
  // #b 两条都真：既算不出时长，又锚不到主轨。
  assert.equal(tl.problems.length, 3, JSON.stringify(tl.problems));
  assert.match(tl.problems.join(" "), /算不出时长/);
  assert.match(tl.problems.join(" "), /不是主轨上的片段/);
});

test("lay：按配音时长顺排，给出 offset 的初值", () => {
  const root = fixture();
  const s = lay("ep01/ep01-cut.geml", "#c03", profileIoFor(root), 0.3);
  assert.equal(s.length, 2, JSON.stringify(s));
  assert.equal(s[0].offset, 0);
  assert.equal(s[1].offset, 2.4, "第一条 2.1 秒 + 0.3 间隙");
  assert.ok(s.some((x) => x.dur !== undefined), "字幕片段要给 dur");
  rmSync(root, { recursive: true, force: true });
});

test("export：edl 带片段名，json 就是时间线本身", () => {
  const root = fixture();
  const io = profileIoFor(root);
  const edl = exportTimeline("ep01/ep01-cut.geml", "edl", io);
  assert.match(edl, /FROM CLIP NAME: ep01\/assets\/s01-take3\.mp4/, edl.slice(0, 200));
  const tl = JSON.parse(exportTimeline("ep01/ep01-cut.geml", "json", io));
  assert.equal(tl.duration, 10);
  assert.equal(tl.primary, "video");
  rmSync(root, { recursive: true, force: true });
});

test("report：cast 列出每句台词的说话人", () => {
  const root = fixture();
  const csv = report("ep01/ep01-script.geml", "cast", profileIoFor(root));
  assert.match(csv, /#sister/, csv);
  rmSync(root, { recursive: true, force: true });
});

test("import：清单里读不到的文件被跳过并说明，不静默", () => {
  const root = fixture();
  const plan = importPlan("ep01/ep01-library.geml", [{ file: "assets/nope.png", model: "m", mode: "t2i" }], profileIoFor(root));
  assert.equal(plan.records.length, 0);
  assert.match(plan.notes.join(" "), /读不到/);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// import 按后缀分派（profile 文档 §6）—— 调用者手上有什么就给什么
// ---------------------------------------------------------------------------

test("importKindOf：按后缀分派，NLE 时间线单独认出来而不是混进 unknown", () => {
  assert.equal(importKindOf("a/b/manifest.json"), "manifest");
  assert.equal(importKindOf("x.SRT"), "subtitles");
  assert.equal(importKindOf("x.vtt"), "subtitles");
  assert.equal(importKindOf("shot.mp4"), "asset");
  assert.equal(importKindOf("vo.wav"), "asset");
  assert.equal(importKindOf("cut.otio"), "timeline");
  assert.equal(importKindOf("cut.fcpxml"), "timeline");
  assert.equal(importKindOf("notes.txt"), "unknown");
  assert.equal(importKindOf("README"), "unknown");
});

test("parseCues：srt 与 vtt 同一个解析器，末尾时刻后跟的定位参数不影响时间", () => {
  const srt = "1\n00:00:00,500 --> 00:00:02,000\n第一句\n\n2\n00:00:04,600 --> 00:00:06,200\n第二句\n";
  const a = parseCues(srt);
  assert.equal(a.skipped, 0);
  assert.deepEqual(a.cues.map((c) => [c.start, c.end, c.text]),
    [[0.5, 2, "第一句"], [4.6, 6.2, "第二句"]]);
  const vtt = "WEBVTT\n\n00:00.500 --> 00:02.000 line:90%\n第一句\n";
  const b = parseCues(vtt);
  assert.equal(b.skipped, 0);
  assert.deepEqual(b.cues, [{ start: 0.5, end: 2, text: "第一句" }]);
});

test("parseCues：读不出时间或没有正文的条目被跳过并计数，不猜", () => {
  const r = parseCues("1\n乱七八糟\n正文\n\n2\n00:00:01,000 --> 00:00:02,000\n\n\n3\n00:00:03,000 --> 00:00:04,000\n好的\n");
  assert.equal(r.cues.length, 1);
  assert.equal(r.skipped, 2);
});

test("importSubtitles：每条字幕锚到那一刻在播的主轨片段上，用 over/offset 而不是绝对时间", () => {
  const root = fixture();
  const io = profileIoFor(root);
  const srt = "1\n00:00:00,500 --> 00:00:02,000\n第一句\n\n2\n00:00:04,600 --> 00:00:06,200\n第二句\n";
  const r = importSubtitles(srt, { idPrefix: "imp", srcDoc: "ep01-script.geml", cutEntry: "ep01/ep01-cut.geml" }, io);
  // #c01 是 0–4s，#c03 从 4s 起 —— 0.5s 落在前者，4.6s 落在后者。
  assert.match(r.clips, /#sub-imp1 track=subtitle src=ep01-script\.geml#imp1 over=#c01 offset=0\.5 duration=1\.5/, r.clips);
  assert.match(r.clips, /#sub-imp2 track=subtitle src=ep01-script\.geml#imp2 over=#c03 offset=0\.6 duration=1\.6/, r.clips);
  assert.equal(r.clips.includes("at="), false, "落在主轨内的字幕不该用绝对时间");
  rmSync(root, { recursive: true, force: true });
});

test("importSubtitles：落在主轨之外的字幕退回 at=，并且说出来", () => {
  const root = fixture();
  const r = importSubtitles("1\n00:00:59,000 --> 00:01:01,000\n片外\n", { idPrefix: "x", srcDoc: "s.geml", cutEntry: "ep01/ep01-cut.geml" }, profileIoFor(root));
  assert.match(r.clips, /at=59\.000 duration=2/, r.clips);
  assert.match(r.notes.join(" "), /主轨之外/);
  rmSync(root, { recursive: true, force: true });
});

test("importSubtitles：没给说话人就不写成 .line —— srt 不带这个信息，编一个不如不写", () => {
  const root = fixture();
  const io = profileIoFor(root);
  const srt = "1\n00:00:00,500 --> 00:00:02,000\n第一句\n";
  const bare = importSubtitles(srt, { idPrefix: "a", srcDoc: "s.geml", cutEntry: null }, io);
  assert.equal(bare.lines.includes(".line"), false, bare.lines);
  assert.match(bare.notes.join(" "), /没给 --speaker/);
  const named = importSubtitles(srt, { idPrefix: "a", srcDoc: "s.geml", cutEntry: null, speaker: "../characters.geml#hero" }, io);
  assert.match(named.lines, /\.line speaker=\.\.\/characters\.geml#hero/, named.lines);
  rmSync(root, { recursive: true, force: true });
});

test("importSubtitles：没给 cut 就只出台词块，不编一套时间", () => {
  const root = fixture();
  const r = importSubtitles("1\n00:00:00,500 --> 00:00:02,000\n第一句\n", { idPrefix: "a", srcDoc: "", cutEntry: null }, profileIoFor(root));
  assert.equal(r.clips, null);
  assert.match(r.notes.join(" "), /没给 --cut/);
  rmSync(root, { recursive: true, force: true });
});

test("idsTaken：往别人的文档里写之前查重，撞了要报出来", () => {
  const doc = "=== media-text {#s03-l1 .line speaker=x}\n话\n===\n";
  assert.deepEqual(idsTaken(doc, ["s03-l1", "imp1"]), ["s03-l1"]);
  assert.deepEqual(idsTaken(doc, ["imp1"]), []);
});

test("assetBlockFor：读不到时长就不写 duration=，不填 0", () => {
  assert.equal(assetBlockFor("assets/a.mp4", "a", "abc", 3.14159),
    "=== media-asset {#a src=assets/a.mp4 sha256=abc kind=video duration=3.142 origin=generated}\n===\n");
  assert.equal(assetBlockFor("assets/a.wav", "a", null).includes("duration="), false);
  assert.match(assetBlockFor("assets/a.wav", "a", null), /kind=audio/);
});

test("build：默认不烧字幕，滤镜链里没有 subtitles", () => {
  const root = fixture();
  const plan = buildPlan("ep01/ep01-cut.geml", "out.mp4", profileIoFor(root));
  const fc = plan.args[plan.args.indexOf("--filter_complex") + 1] ?? plan.args.join(" ");
  assert.equal(fc.includes("subtitles="), false, fc);
  assert.equal(plan.args[plan.args.indexOf("-map") + 1], "[vout]");
  assert.notEqual(plan.srt, null, "字幕仍然另出成 srt");
  rmSync(root, { recursive: true, force: true });
});

test("build --burn-subs：字幕接在画面链末尾，force_style 加引号不逐个转义逗号", () => {
  const root = fixture();
  const plan = buildPlan("ep01/ep01-cut.geml", "out.mp4", profileIoFor(root),
    { burn: { file: "out.srt", style: "FontName=Microsoft YaHei,FontSize=18" } });
  const fc = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.match(fc, /\[vout\]subtitles=filename=out\.srt:force_style='FontName=Microsoft YaHei,FontSize=18'\[vsub\]/, fc);
  // 出去的是烧过字的那一路，不是原始画面 —— 接错了就是字幕静默丢失。
  assert.equal(plan.args[plan.args.indexOf("-map") + 1], "[vsub]");
  rmSync(root, { recursive: true, force: true });
});

test("build --burn-subs：文件名里的冒号逗号按 filtergraph 转义，样式里的单引号被去掉", () => {
  const root = fixture();
  const plan = buildPlan("ep01/ep01-cut.geml", "out.mp4", profileIoFor(root),
    { burn: { file: "a,b:c.srt", style: "FontName=It's" } });
  const fc = plan.args[plan.args.indexOf("-filter_complex") + 1];
  // 反斜杠写成 fromCharCode：这份断言经过 shell 和 heredoc，字面反斜杠被吃掉一次
  // 就会变成"匹配逗号"从而假绿。
  const B = String.fromCharCode(92);
  assert.ok(fc.includes("filename=a" + B + ",b" + B + ":c.srt"), fc);
  assert.ok(fc.includes("force_style='FontName=Its'"), fc);
  rmSync(root, { recursive: true, force: true });
});

test("build：gain 与 fade 真的施加在音频链上 —— 不然浏览器小声、出片原声", () => {
  const root = fixture(({ edit }) => edit("ep01/ep01-cut.geml", "gain=0dB", "gain=-14dB fade-in=0.3 fade-out=0.5"));
  const fc = buildPlan("ep01/ep01-cut.geml", "out.mp4", profileIoFor(root)).args[
    buildPlan("ep01/ep01-cut.geml", "out.mp4", profileIoFor(root)).args.indexOf("-filter_complex") + 1];
  assert.match(fc, /volume=-14dB/, fc);
  assert.match(fc, /afade=t=in:st=0:d=0\.3/, fc);
  // 淡出从**片段内**的 duration-0.5 起算，不是时间线绝对时刻。
  assert.match(fc, /afade=t=out:st=1\.600:d=0\.5/, fc);
  // 顺序：裁剪 → 电平 → 淡 → 延迟。延迟摆在最后，否则淡出会落在错的地方。
  assert.ok(fc.indexOf("afade=t=out") < fc.indexOf("adelay="), fc);
  rmSync(root, { recursive: true, force: true });
});

test("build：gain=0dB 不生成 volume 滤镜 —— 零增益不该多一道处理", () => {
  const root = fixture();
  const plan = buildPlan("ep01/ep01-cut.geml", "out.mp4", profileIoFor(root));
  const fc = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.equal(fc.includes("volume="), false, fc);
  rmSync(root, { recursive: true, force: true });
});

test("export --to player：一个能播的面，零 ffmpeg —— 时间原样来自时间线", () => {
  const root = fixture();
  const html = exportTimeline("ep01/ep01-cut.geml", "player", profileIoFor(root));
  // 画面轨是 video、声音轨是 audio，散文轨不进舞台而是进字幕表。
  assert.equal((html.match(/<video /g) ?? []).length, 2, html.slice(0, 400));
  assert.equal((html.match(/<audio /g) ?? []).length, 1);
  assert.match(html, /data-clip="c01"[^>]*data-start="0\.000"[^>]*data-end="4\.000"/);
  assert.match(html, /data-clip="vo-s03-l1"[^>]*data-start="4\.400"/);
  assert.match(html, /data-captions="[^"]*姐/, "散文轨成了字幕表");
  // 画面轨静音：声音走声音轨，画面轨再出声就是两份。
  assert.match(html, /<video [^>]*data-clip="c01"[^>]*muted/);
  // 时钟的源码内联进来了，页面自己能跑，不依赖 viewer。
  assert.match(html, /function drivePlayer/);
  assert.equal(html.includes("geml-viewer"), false, "不该引用 viewer");
  rmSync(root, { recursive: true, force: true });
});

test("export --to player 与 --to preview 是两件事：成片 vs 联系表", () => {
  const root = fixture();
  const io = profileIoFor(root);
  const preview = exportTimeline("ep01/ep01-cut.geml", "preview", io);
  const player = exportTimeline("ep01/ep01-cut.geml", "player", io);
  // 联系表每刀一个带 controls 的独立播放器；成片一个时钟推所有元素，没有 controls。
  assert.match(preview, /<video controls/);
  assert.equal(player.includes("<video controls"), false, player.slice(0, 300));
  assert.match(player, /class="geml-transport"/);
  rmSync(root, { recursive: true, force: true });
});

const doc = (...lines) => lines.join(String.fromCharCode(10)) + String.fromCharCode(10);

test("形状：有体又有 src= 说不清算哪种；两样都没有则什么也不指", () => {
  const root = project({
    "cut.geml": META + doc(
      '==== media {#both tracks="video:video" src=lib.geml#a}', "",
      "=== media-clip {#c1 track=video src=lib.geml#a in=0 out=2}", "===", "",
      "====", "",
      '=== media {#neither tracks="video:video"}', "==="),
    "lib.geml": META + doc("=== media-asset {#a src=a.mp4 kind=video duration=9}", "==="),
  });
  const c = codes(checkMedia("cut.geml", profileIoFor(root)));
  assert.ok(c.includes("media-shape-ambiguous"), c.join(","));
  assert.ok(c.includes("media-shape-empty"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("不在任何 media 里的片段被点名 —— 它不属于任何一条时间线", () => {
  const root = project({
    "cut.geml": META + doc("=== media-clip {#loose track=video src=lib.geml#a in=0 out=2}", "==="),
    "lib.geml": META + doc("=== media-asset {#a src=a.mp4 kind=video duration=9}", "==="),
  });
  const c = codes(checkMedia("cut.geml", profileIoFor(root)));
  assert.ok(c.includes("media-clip-unassembled"), c.join(","));
  rmSync(root, { recursive: true, force: true });
});

test("一份文档装两条时间线，各按各的轨道表算", () => {
  const root = fixture();
  const extra = read(join(root, "ep01/ep01-cut.geml"), "utf8").trimEnd() + doc("", "",
    '==== media {#teaser tracks="video:video"}', "",
    "=== media-clip {#t1 track=video src=ep01-library.geml#s01-take3 in=0 out=2}", "===", "",
    "====");
  const all = layoutsOf(parse(extra), { durationOf: () => undefined });
  assert.deepEqual(all.map((t) => t.id), ["ep01", "teaser"]);
  assert.equal(all[1].duration, 2);
  rmSync(root, { recursive: true, force: true });
});

test("单源 media：无体加 src=，就是只有一个片段的时间线", () => {
  const src = META + doc("=== media {#one src=ep01-library.geml#s01-take3 in=1 out=3}", "===");
  const tl = layout(src, { durationOf: () => 9, kindOf: () => "video" });
  assert.equal(tl.clips.length, 1);
  assert.equal(tl.duration, 2);
  assert.equal(tl.clips[0].in, 1);
  assert.equal(tl.clips[0].kind, "video", "种类从被引素材来，不在 media 上重说");
});

// ---- 合成（设计记录 §16）：立绘、母版、comp 与 compose ------------------------

import * as verbs from "../dist/media-verbs.js";
import { promptTextOf } from "../dist/media-check.js";

/** 一个最小的分层项目：一张母版、一张立绘、一个两层的 comp。 */
function compProject({ x = 300 } = {}) {
  const BG = "BGPNG", HERO = "HEROPNG", VID = "VIDBYTES";
  return {
    "assets/bg.png": BG, "assets/hero.png": HERO, "clip.mp4": VID,
    "lib.geml": META
      + `=== media-asset {#bg src=assets/bg.png sha256=${sha(BG)} kind=image role=master}\n===\n\n`
      + `=== media-asset {#hero src=assets/hero.png sha256=${sha(HERO)} kind=image role=stand}\n===\n\n`
      + `=== media-asset {#vid src=clip.mp4 sha256=${sha(VID)} kind=video duration=1}\n===\n\n`
      + "=== data {#gen-log .gen-log format=jsonl}\n===\n",
    "script.geml": META
      + "==== media-comp {#s05-comp shot=s05 size=720x1280}\n\n"
      + "=== media-layer {#s05-bg src=lib.geml#bg xywh=0,200,720,1280}\n===\n\n"
      + `=== media-layer {#s05-hero src=lib.geml#hero x=${x} y=340 w=480 flip=h}\n===\n\n`
      + "====\n",
  };
}

test("合成：comp 与 layer 是登记过的类型，键拼错会被查出来，干净的 comp 没有 profile 诊断", () => {
  const root = project(compProject());
  const ds = checkMedia("script.geml", profileIoFor(root));
  assert.deepEqual(ds, [], JSON.stringify(ds));
  const doc = parse(read(join(root, "script.geml"), "utf8"));
  assert.deepEqual(doc.diagnostics.filter((d) => d.code === "unknown-block-type"), [], JSON.stringify(doc.diagnostics));
  const typo = parse(META + "==== media-comp {#c size=1x1}\n\n=== media-layer {#l src=#a flp=h}\n===\n\n====\n");
  assert.ok(typo.diagnostics.some((d) => d.code === "unknown-attribute" && /flp/.test(d.message)), JSON.stringify(typo.diagnostics));
  rmSync(root, { recursive: true, force: true });
});

test("合成：层不在 comp 里、comp 没 size、comp 空、层指到非图片、层 src 悬空 —— 各自点名", () => {
  const f = compProject();
  f["script.geml"] = META
    + "=== media-layer {#loose src=lib.geml#bg}\n===\n\n"
    + "==== media-comp {#nosize}\n\n=== media-layer {#l1 src=lib.geml#bg}\n===\n\n====\n\n"
    + "==== media-comp {#empty size=720x1280}\n\n====\n\n"
    + "==== media-comp {#bad size=720x1280}\n\n=== media-layer {#l2 src=lib.geml#vid}\n===\n\n=== media-layer {#l3 src=lib.geml#nope}\n===\n\n=== media-layer {#nosrc}\n===\n\n====\n";
  const root = project(f);
  const ds = checkMedia("script.geml", profileIoFor(root));
  const by = (code) => ds.filter((d) => d.code === code).map((d) => d.id).sort();
  assert.deepEqual(by("media-layer-unassembled"), ["loose"], JSON.stringify(ds));
  assert.deepEqual(by("media-comp-size-missing"), ["nosize"], JSON.stringify(ds));
  assert.deepEqual(by("media-comp-empty"), ["empty"], JSON.stringify(ds));
  assert.deepEqual(by("media-layer-not-image"), ["l2"], JSON.stringify(ds));
  assert.deepEqual(by("media-src-unresolved"), ["l3", "nosrc"], JSON.stringify(ds));
  for (const d of ds) assert.equal(d.severity, "error", d.code);
  rmSync(root, { recursive: true, force: true });
});

test("合成：comp 是分层写的提示词 —— promptTextOf 给规范化文本，改一个数字记录就过期，todo 不再列它", () => {
  const root = project(compProject());
  const io = profileIoFor(root);
  const text = promptTextOf("script.geml#s05-comp", "lib.geml", io);
  assert.ok(text !== null, "comp 也该有可哈希的文本");
  assert.match(text, /^media-comp #s05-comp .*size=720x1280/m);
  assert.match(text, /^media-layer #s05-hero .*x=300/m);
  const OUT = "KEYPNG";
  write(join(root, "assets/s05-key.png"), OUT);
  const rec = JSON.stringify({
    output: "#s05-key", "output-sha256": sha(OUT), model: "ffmpeg-overlay", mode: "composite",
    prompt: "script.geml#s05-comp", "prompt-sha256": sha(text),
    inputs: [{ ref: "#bg", sha256: sha("BGPNG") }, { ref: "#hero", sha256: sha("HEROPNG") }],
    at: "2026-09-29T00:00:00Z",
  });
  write(join(root, "lib.geml"), read(join(root, "lib.geml"), "utf8")
    .replace("=== data {#gen-log", `=== media-asset {#s05-key src=assets/s05-key.png sha256=${sha(OUT)} kind=image role=first-frame}\n===\n\n=== data {#gen-log`)
    .replace("format=jsonl}\n===", "format=jsonl}\n" + rec + "\n==="));
  assert.deepEqual(checkMedia("lib.geml", io), []);
  assert.deepEqual(verbs.todo(["script.geml", "lib.geml"], io).filter((x) => x.kind === "composite"), [], "有记录认领的 comp 不是待办");
  write(join(root, "script.geml"), read(join(root, "script.geml"), "utf8").replace("x=300", "x=340"));
  const ds = checkMedia("lib.geml", io);
  const st = ds.find((d) => d.code === "media-stale-generation");
  assert.ok(st, JSON.stringify(ds));
  assert.equal(st.id, "s05-key");
  assert.match(st.message, /s05-comp/, "消息要点名是 comp 变了");
  rmSync(root, { recursive: true, force: true });
});

test("血缘：记录的 output 指不到任何素材块 —— media-gen-output-not-asset，点名记录序号与引用", () => {
  const root = project({
    "lib.geml": META + '=== data {#gen-log .gen-log format=jsonl}\n'
      + JSON.stringify({ output: "#gone", "output-sha256": "ab", model: "m", mode: "t2i", at: "2026-09-29T00:00:00Z" }) + "\n===\n",
  });
  const ds = checkMedia("lib.geml", profileIoFor(root));
  const d = ds.find((x) => x.code === "media-gen-output-not-asset");
  assert.ok(d, JSON.stringify(ds));
  assert.equal(d.severity, "error");
  assert.match(d.message, /\[0\].*#gone/, "要点名是第几条记录、指的是谁");
  rmSync(root, { recursive: true, force: true });
});

test("todo：没有记录认领的 comp 是一件 composite 待办，各层素材是它的 refs", () => {
  const root = project(compProject());
  const items = verbs.todo(["script.geml", "lib.geml"], profileIoFor(root));
  const c = items.find((x) => x.kind === "composite");
  assert.ok(c, JSON.stringify(items));
  assert.equal(c.address, "script.geml#s05-comp");
  assert.equal(c.mode, "composite");
  assert.equal(c.prompt, null, "comp 没有要发给模型的文字");
  assert.deepEqual(c.refs, [{ ref: "lib.geml#bg", role: "master" }, { ref: "lib.geml#hero", role: "stand" }]);
  rmSync(root, { recursive: true, force: true });
});

test("compose：filtergraph 由层决定 —— 裁、缩、翻、放，顺序固定，画布透明", () => {
  const root = project(compProject());
  const plan = verbs.composePlan("script.geml#s05-comp", "out/s05-key.png", profileIoFor(root));
  assert.deepEqual(plan.notes, []);
  assert.deepEqual(plan.layers.map((l) => l.ref), ["lib.geml#bg", "lib.geml#hero"]);
  assert.deepEqual(plan.args, [
    "-y",
    "-f", "lavfi", "-i", "color=c=black@0.0:s=720x1280:d=1",
    "-i", "assets/bg.png",
    "-i", "assets/hero.png",
    "-filter_complex",
    "[0:v]format=rgba[b0];"
      + "[1:v]crop=720:1280:0:200,format=rgba[l0];[b0][l0]overlay=0:0[b1];"
      + "[2:v]scale=480:-1,hflip,format=rgba[l1];[b1][l1]overlay=300:340[b2]",
    "-map", "[b2]", "-frames:v", "1", "-update", "1",
    "out/s05-key.png",
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("compose：comp 找不到、没有 size、层没有文件 —— 说出来，不出命令", () => {
  const f = compProject();
  f["script.geml"] += "\n==== media-comp {#nosize}\n\n=== media-layer {#n1 src=lib.geml#bg}\n===\n\n====\n"
    + "\n==== media-comp {#nofile size=10x10}\n\n=== media-layer {#n2 src=lib.geml#nope}\n===\n\n====\n";
  const root = project(f);
  const io = profileIoFor(root);
  assert.deepEqual(verbs.composePlan("script.geml#nope", "o.png", io).args, []);
  assert.match(verbs.composePlan("script.geml#nope", "o.png", io).notes.join(" "), /nope/);
  assert.deepEqual(verbs.composePlan("script.geml#nosize", "o.png", io).args, []);
  assert.match(verbs.composePlan("script.geml#nosize", "o.png", io).notes.join(" "), /size/);
  const p = verbs.composePlan("script.geml#nofile", "o.png", io);
  assert.deepEqual(p.args, [], "一层都摆不上就没有命令");
  assert.match(p.notes.join(" "), /n2/);
  rmSync(root, { recursive: true, force: true });
});

// ---- 互动（设计记录 §16.8）：点、连接、序列 ---------------------------------------

const blocksOfDoc = (doc) => { const out = []; const walk = (bs) => { for (const b of bs) if (b.kind === "block") { out.push(b); if (b.children) walk(b.children); } }; walk(doc.children); return out; };

/**
 * 递碗：母版、林岚（已放好）、碗（自由）、林夏（自由）。i1 把碗放到林岚手上，i2 把林夏的手
 * 放到碗的另一侧把手上，i3 是对视 —— 林夏已经被 i2 定了位置，i3 只验，而两人眼睛差了三百多像素。
 */
function interProject() {
  const PNG = "PNGBYTES";
  const asset = (id, extra) => `=== media-asset {#${id} src=${id}.png sha256=${sha(PNG)} kind=image ${extra}}\n===\n\n`;
  return {
    "bg.png": PNG, "sister.png": PNG, "bowl.png": PNG, "hero.png": PNG, "nosize.png": PNG,
    "chars.geml": META
      + '# 林岚 {#sister points="hand eyes feet"}\n\n# 林夏 {#hero points="hand eyes"}\n\n'
      + '=== media-text {#bedroom .look points="floor bed-edge"}\n清晨的卧室。\n===\n',
    "lib.geml": META
      + asset("bg", 'role=master of=chars.geml#bedroom size=720x1280 points="floor:0,1180 bed-edge:300,900"')
      + asset("sister", 'role=stand of=chars.geml#sister size=720x1280 points="hand:562,522 eyes:290,300 feet:250,1240"')
      + asset("bowl", 'role=prop size=400x240 points="left-grip:40,120 right-grip:360,120"')
      + asset("hero", 'role=stand of=chars.geml#hero size=720x1280 points="hand:200,900 eyes:360,240 chin:360,400"')
      + asset("nosize", 'role=stand of=chars.geml#hero points="hand:1,1"')
      + "=== data {#gen-log .gen-log format=jsonl}\n===\n",
    "script.geml": META
      + "==== media-comp {#c shot=s05 size=720x1280}\n\n"
      + "=== media-layer {#L-bg src=lib.geml#bg}\n===\n\n"
      + "=== media-layer {#L-sister src=lib.geml#sister x=-90 y=370 w=560}\n===\n\n"
      + "=== media-layer {#L-bowl src=lib.geml#bowl w=180}\n===\n\n"
      + "=== media-layer {#L-hero src=lib.geml#hero w=520}\n===\n\n"
      + "=== media-interaction {#i1 a=#L-sister:hand b=#L-bowl:left-grip kind=contact}\n林岚双手端着碗，递到林夏面前。\n===\n\n"
      + "=== media-interaction {#i2 a=#L-bowl:right-grip b=#L-hero:hand kind=contact}\n===\n\n"
      + "=== media-interaction {#i3 a=#L-sister:eyes b=#L-hero:eyes kind=gaze}\n===\n\n"
      + "====\n",
  };
}

test("互动：media-interaction 是登记过的散文类型，points / at / a b kind 都是放行的键", () => {
  const root = project(interProject());
  const doc = parse(read(join(root, "script.geml"), "utf8"));
  assert.deepEqual(doc.diagnostics.filter((d) => d.code === "unknown-block-type" || d.code === "unknown-attribute"), [], JSON.stringify(doc.diagnostics));
  const i1 = blocksOfDoc(doc).find((b) => b.id === "i1");
  assert.equal(i1.prose, true, "body 是散文：这一步发生了什么，人读、模型读、按步检索");
  assert.equal(promptTextOf("script.geml#i1", "lib.geml", profileIoFor(root)), "林岚双手端着碗，递到林夏面前。");
  const lib = parse(read(join(root, "lib.geml"), "utf8"));
  assert.deepEqual(lib.diagnostics.filter((d) => d.code === "unknown-attribute"), [], "素材上的 points= 放行");
  const at = parse(META + "==== media-comp {#k1 shot=s07 at=0.6 size=1x1}\n\n=== media-layer {#l src=#a}\n===\n\n====\n");
  assert.deepEqual(at.diagnostics.filter((d) => d.code === "unknown-attribute"), [], "comp 上的 at= 放行");
  const chars = parse(read(join(root, "chars.geml"), "utf8"));
  assert.deepEqual(chars.diagnostics.filter((d) => d.code === "unknown-attribute"), [], ".look 上的 points= 放行");
  rmSync(root, { recursive: true, force: true });
});

test("互动：递碗的 comp 干净，只有对视那条只验不动、且两人眼睛不齐 —— media-interaction-apart", () => {
  const root = project(interProject());
  const ds = checkMedia("script.geml", profileIoFor(root));
  assert.deepEqual(ds.map((d) => d.code), ["media-interaction-apart"], JSON.stringify(ds));
  assert.equal(ds[0].id, "i3");
  assert.equal(ds[0].severity, "warning");
  assert.match(ds[0].message, /30[0-9]/, "消息说出差了多少像素");
  rmSync(root, { recursive: true, force: true });
});

test("互动：解算 —— 接触把后面的层放到前面层的点上，compose 的 overlay 用解出来的坐标", () => {
  const root = project(interProject());
  const plan = verbs.composePlan("script.geml#c", "o.png", profileIoFor(root));
  assert.deepEqual(plan.notes, [], plan.notes.join(" "));
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  // 林岚 x=-90 y=370 w=560 → 比例 560/720，手 (562,522) 落在画布 (347.1, 776.0)
  assert.match(graph, /\[b1\]\[l1\]overlay=-90:370\[b2\]/, graph);
  // 碗 w=180 / 400 → 0.45，左把手 (40,120) 要落到手上：x = 347.1 − 18 = 329，y = 776 − 54 = 722
  assert.match(graph, /\[b2\]\[l2\]overlay=329:722\[b3\]/, graph);
  // 林夏 w=520 / 720，手 (200,900) 落到右把手 (491.1, 776.0)：x = 491.1 − 144.4 = 347，y = 776 − 650 = 126
  assert.match(graph, /\[b3\]\[l3\]overlay=347:126\[b4\]/, graph);
  rmSync(root, { recursive: true, force: true });
});

test("互动：对视只动 y；dx dy 是微调；后放的层自由，先放的不动", () => {
  const f = interProject();
  f["script.geml"] = META
    + "==== media-comp {#g size=720x1280}\n\n"
    + "=== media-layer {#A src=lib.geml#sister x=0 y=100 w=720}\n===\n\n"
    + "=== media-layer {#B src=lib.geml#hero x=300 w=360 dy=10}\n===\n\n"
    + "=== media-interaction {#eyes a=#A:eyes b=#B:eyes kind=gaze}\n===\n\n"
    + "====\n";
  const root = project(f);
  assert.deepEqual(checkMedia("script.geml", profileIoFor(root)), []);
  const graph = verbs.composePlan("script.geml#g", "o.png", profileIoFor(root)).args.find((a) => a.includes("overlay"));
  // A 的眼睛 y = 100 + 300 = 400；B 比例 0.5，眼睛 (360,240) → y = 400 − 120 + dy 10 = 290；x 保留 300
  assert.match(graph, /\[b1\]\[l1\]overlay=300:290\[b2\]/, graph);
  rmSync(root, { recursive: true, force: true });
});

test("互动：引不到层、层上没那个点、点名不在角色声明里、两端同一层、不在 comp 里、位置冲突、缺 size、同镜同时刻 —— 各自点名", () => {
  const f = interProject();
  f["script.geml"] = META
    + "=== media-interaction {#loose a=#x:hand b=#y:hand kind=contact}\n===\n\n"
    + "==== media-comp {#d size=720x1280}\n\n"
    + "=== media-layer {#s src=lib.geml#sister x=0 y=0 w=720}\n===\n\n"
    + "=== media-layer {#h src=lib.geml#hero x=5 y=5 w=720}\n===\n\n"
    + "=== media-layer {#n src=lib.geml#nosize w=100}\n===\n\n"
    + "=== media-layer {#h2 src=lib.geml#hero w=720}\n===\n\n"
    + "=== media-interaction {#nolayer a=#s:hand b=#zz:hand kind=contact}\n===\n\n"
    + "=== media-interaction {#nopoint a=#s:hand b=#h:nose kind=contact}\n===\n\n"
    + "=== media-interaction {#undeclared a=#s:hand b=#h2:chin kind=contact}\n===\n\n"
    + "=== media-interaction {#same a=#s:hand b=#s:eyes kind=contact}\n===\n\n"
    + "=== media-interaction {#conflict a=#s:hand b=#h:hand kind=contact}\n===\n\n"
    + "=== media-interaction {#nosize a=#s:hand b=#n:hand kind=contact}\n===\n\n"
    + "=== media-interaction {#badkind a=#s:hand b=#h2:hand kind=hug}\n===\n\n"
    + "====\n\n"
    + "==== media-comp {#k1 shot=s07 at=0 size=1x1}\n\n=== media-layer {#k1l src=lib.geml#bg}\n===\n\n====\n\n"
    + "==== media-comp {#k2 shot=s07 at=0 size=1x1}\n\n=== media-layer {#k2l src=lib.geml#bg}\n===\n\n====\n";
  const root = project(f);
  const ds = checkMedia("script.geml", profileIoFor(root));
  const by = (code) => ds.filter((d) => d.code === code).map((d) => d.id).sort();
  assert.deepEqual(by("media-interaction-unassembled"), ["loose"], JSON.stringify(ds));
  assert.deepEqual(by("media-interaction-unresolved"), ["badkind", "loose", "nolayer", "nopoint"], JSON.stringify(ds));
  assert.deepEqual(by("media-interaction-point-undeclared"), ["undeclared"], JSON.stringify(ds));
  assert.deepEqual(by("media-interaction-same-layer"), ["same"], JSON.stringify(ds));
  assert.deepEqual(by("media-layer-position-conflict"), ["h"], "h 写了 x y 又被 #conflict 定位：" + JSON.stringify(ds));
  assert.deepEqual(by("media-asset-size-required"), ["n"], JSON.stringify(ds));
  assert.deepEqual(by("media-comp-at-duplicate"), ["k2"], JSON.stringify(ds));
  for (const d of ds) if (d.code !== "media-interaction-apart") assert.equal(d.severity, "error", d.code);
  rmSync(root, { recursive: true, force: true });
});

test("互动：comp 的规范化文本带上解析后用到的点坐标 —— 素材上的 points= 一改，合成就过期", () => {
  const root = project(interProject());
  const io = profileIoFor(root);
  const text = promptTextOf("script.geml#c", "lib.geml", io);
  assert.match(text, /^media-interaction #i1 a=#L-sister:hand@562,522 b=#L-bowl:left-grip@40,120 kind=contact$/m, text);
  write(join(root, "o.png"), "OUT");
  write(join(root, "lib.geml"), read(join(root, "lib.geml"), "utf8")
    .replace("=== data {#gen-log", `=== media-asset {#o src=o.png sha256=${sha("OUT")} kind=image role=first-frame}\n===\n\n=== data {#gen-log`)
    .replace("format=jsonl}\n===", "format=jsonl}\n" + JSON.stringify({ output: "#o", "output-sha256": sha("OUT"), model: "ffmpeg-overlay", mode: "composite", prompt: "script.geml#c", "prompt-sha256": sha(text), at: "2026-09-29T00:00:00Z" }) + "\n==="));
  assert.deepEqual(checkMedia("lib.geml", io).filter((d) => d.code !== "media-interaction-apart"), []);
  write(join(root, "lib.geml"), read(join(root, "lib.geml"), "utf8").replace("hand:562,522", "hand:570,522"));
  const st = checkMedia("lib.geml", io).find((d) => d.code === "media-stale-generation");
  assert.ok(st, "点挪了 8 像素，合成该过期");
  assert.equal(st.id, "o");
  rmSync(root, { recursive: true, force: true });
});

console.log(String.fromCharCode(10) + passed + " passed");
