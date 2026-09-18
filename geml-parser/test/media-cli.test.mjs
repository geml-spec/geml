// `geml media …` —— profile 自己的动词在命令行上的那一层。动词本身在 media.test.mjs
// 和 cov-media.test.mjs 里按函数测；这里测的是**命令行**：参数怎么认、根怎么定、产物
// 写到哪、以及每一条拒绝。整块 runMedia 此前一行都没跑过。
//
// ffmpeg 是可选依赖，装没装决定 build 走哪条路。为了让这套测试在三个平台上都得出
// 同一个答案，spawn 的时候把 PATH 清空 —— 于是 whichBin 必定找不到，build 必定走
// 「打印出本该执行的命令」那一条。node 自己是用 execPath 起的，不经过 PATH。
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const NO_PATH = { ...process.env, PATH: "", Path: "" };
function run(args) {
  const r = spawnSync(process.execPath, ["dist/geml.js", "media", ...args], {
    encoding: "utf8", timeout: 60_000, env: NO_PATH,
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const sha = (s) => createHash("sha256").update(Buffer.from(s)).digest("hex");
const META = '=== meta\nprofile = "geml-media/v1"\n===\n\n';
const CLIP = "VIDEOBYTES";
const VO = "AUDIOBYTES";

/** 每个会写盘的测试都要一份新的项目。 */
function project() {
  const root = mkdtempSync(join(tmpdir(), "geml-media-cli-"));
  const w = (rel, body) => { const p = join(root, rel); mkdirSync(join(p, "..").replace(/[\\/][^\\/]*$/, "") || root, { recursive: true }); writeFileSync(p, body); };
  writeFileSync(join(root, "clip.mp4"), CLIP);
  writeFileSync(join(root, "vo.wav"), VO);
  writeFileSync(join(root, "lib.geml"), META
    + `=== media-asset {#clip src=clip.mp4 sha256=${sha(CLIP)} kind=video duration=6}\n===\n\n`
    + `=== media-asset {#vo src=vo.wav sha256=${sha(VO)} kind=audio duration=2 role=voice of=lib.geml#hero}\n===\n\n`
    + "=== media-text {#p .prompt}\n一只猫坐在窗台上\n===\n\n"
    + "=== data {#gen-log .gen-log format=jsonl}\n===\n");
  writeFileSync(join(root, "script.geml"), META
    + "=== media-text {#l1 .line speaker=lib.geml#hero}\n你好\n===\n");
  writeFileSync(join(root, "cut.geml"), META
    + '==== media {#tl tracks="v:video a:audio s:prose"}\n\n'
    + "=== media-clip {#c1 track=v src=lib.geml#clip in=0 out=4}\n===\n\n"
    + "=== media-clip {#c2 track=v src=lib.geml#clip in=0 out=3}\n===\n\n"
    + "=== media-clip {#vo1 track=a src=lib.geml#vo duration=2 over=#c1 offset=0.5}\n===\n\n"
    + "=== media-clip {#sub1 track=s src=script.geml#l1 duration=1.5 over=#c1 offset=0.2}\n===\n\n"
    + "====\n");
  writeFileSync(join(root, "manifest.json"), JSON.stringify([
    { file: "shot.png", model: "jimeng-4.5", mode: "t2i", prompt: "lib.geml#p", seed: 7 },
  ]));
  writeFileSync(join(root, "shot.png"), "PNGBYTES");
  writeFileSync(join(root, "sub.srt"), "1\n00:00:00,500 --> 00:00:02,000\n第一句\n\n2\n00:00:02,500 --> 00:00:04,000\n第二句\n");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "extra.png"), "EXTRA");
  return { root, at: (rel) => join(root, rel), read: (rel) => readFileSync(join(root, rel), "utf8"), drop: () => rmSync(root, { recursive: true, force: true }) };
}
void project; // 上面的 w 只是脚手架痕迹，保留 project 本体

// ---------------------------------------------------------------------------
// 分派与帮助
// ---------------------------------------------------------------------------

test("没有动词就是错，并且把帮助一起给出来", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.err, /todo/, "错误里带着这份帮助");
  assert.match(r.err, /export/);
});

test("--help 退出 0，七个动词都在", () => {
  for (const f of ["--help", "-h"]) {
    const r = run([f]);
    assert.equal(r.code, 0, r.err);
    for (const v of ["todo", "report", "export", "build", "lay", "log", "import"]) {
      assert.match(r.out, new RegExp(v), `${f} 少了 ${v}`);
    }
  }
});

test("动词后面没有文件也是错", () => {
  const r = run(["export"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /todo/);
});

// 入口文档以前挑的是「第一个不以 - 开头、且不等于 --root/-o/--into 三者之值的参数」，
// 于是别的带值 flag 的值全在射程内：`--to json` 里的 `json` 成了入口文档名，读不到、
// 一个字都不输出、退出 0 —— 该拒绝的时候静默成功，和这一批 PR 修的是同一类毛病。
test("带值 flag 的值不会被当成入口文档，缺文档就是错", () => {
  for (const args of [
    ["export", "--to", "json"],
    ["report", "--kind", "stats"],
    ["lay", "--over", "#c1"],
    ["build", "--out", "out.mp4"],
    ["log", "--output", "#clip", "--model", "m", "--mode", "t2i"],
    ["import", "--into", "lib.geml"],
    ["todo", "--root", "somewhere"],
  ]) {
    const r = run(args);
    assert.equal(r.code, 2, `${args.join(" ")} 应当拒绝，实际 exit ${r.code}：${r.out}`);
    assert.match(r.err, /usage: geml media/, args.join(" "));
  }
});

// 等号写法读不了（flag() 只认空格分隔那一种），以前放过去就等于"没给"：--to 悄悄
// 退回 preview、--out 悄悄变成写标准输出。读不了就明说。
test("--name=value 这种写法当场说清楚，而不是悄悄退回默认值", () => {
  const p = project();
  try {
    const r = run(["export", "--to=json", p.at("cut.geml")]);
    assert.equal(r.code, 2, r.out.slice(0, 80));
    assert.match(r.err, /--to 的值要另起一个参数：写成 --to json/);
    const o = run(["export", p.at("cut.geml"), "--out=x.json"]);
    assert.equal(o.code, 2);
    assert.match(o.err, /--out 的值要另起一个参数/);
  } finally { p.drop(); }
});

test("入口文档恰好和某个 flag 的值同名也认得出来", () => {
  const p = project();
  try {
    // 旧的按值比较会把它当成 --into 的值跳过，于是又落到「没有入口文档」
    const r = run(["import", p.at("manifest.json"), "--into", p.at("manifest.json")]);
    assert.notEqual(r.code, 0, "目标是清单自己，该有话说");
    assert.doesNotMatch(r.err, /usage: geml media/, "而不是报成「没给文档」：" + r.err);
  } finally { p.drop(); }
});

test("拼错的 flag 当场拒绝，不再被默默跳过", () => {
  const p = project();
  try {
    const r = run(["export", p.at("cut.geml"), "--josn"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown flag '--josn' for 'media'/, r.err);
  } finally { p.drop(); }
});

test("每个动词的 --help 都进 stdout 并退出 0", () => {
  for (const args of [["export", "--help"], ["build", "-h"], ["import", "--help"]]) {
    const r = run(args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
    assert.match(r.out, /usage: geml media/);
  }
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

test("export：六种格式都出得来，认不出的格式当场拒绝", () => {
  const p = project();
  try {
    const j = run(["export", p.at("cut.geml"), "--to", "json"]);
    assert.equal(j.code, 0, j.err);
    const tl = JSON.parse(j.out);
    assert.equal(tl.id, "tl");
    assert.equal(tl.clips.length, 4);

    for (const to of ["preview", "player", "srt", "edl", "otio"]) {
      const r = run(["export", p.at("cut.geml"), "--to", to]);
      assert.equal(r.code, 0, `${to}: ${r.err}`);
      assert.ok(r.out.length > 0, `${to} 出了空的`);
    }
    const bad = run(["export", p.at("cut.geml"), "--to", "vhs"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--to 只能是/);
  } finally { p.drop(); }
});

test("export：不给 --to 就是 preview；-o 把产物写进文件而不是标准输出", () => {
  const p = project();
  try {
    const dflt = run(["export", p.at("cut.geml")]);
    assert.equal(dflt.code, 0, dflt.err);
    assert.match(dflt.out, /<html|<video|<!DOCTYPE/i, "缺省出的是预览页");

    const w = run(["export", p.at("cut.geml"), "--to", "json", "-o", "tl.json"]);
    assert.equal(w.code, 0, w.err);
    assert.equal(w.out, "", "写文件时标准输出是空的");
    assert.match(w.err, /wrote tl\.json/);
    assert.equal(JSON.parse(p.read("tl.json")).id, "tl");
  } finally { p.drop(); }
});

// ---------------------------------------------------------------------------
// todo / report
// ---------------------------------------------------------------------------

test("todo：默认是给人看的一行一条，--json 是给程序的", () => {
  const p = project();
  try {
    const t = run(["todo", p.at("lib.geml")]);
    assert.equal(t.code, 0, t.err);
    assert.match(t.out, /生成.*lib\.geml#p/, t.out);

    const j = run(["todo", p.at("lib.geml"), "--json"]);
    assert.equal(j.code, 0, j.err);
    const items = JSON.parse(j.out);
    assert.ok(items.some((i) => i.kind === "generate" && /#p$/.test(i.address)), j.out);
  } finally { p.drop(); }
});

test("todo：一件待办都没有时说一声，而不是空着", () => {
  const p = project();
  try {
    // 一份只有素材的库：没有提示词要产出，也没有台词要配音
    writeFileSync(p.at("bare.geml"), META
      + `=== media-asset {#only src=clip.mp4 sha256=${sha(CLIP)} kind=video duration=6}\n===\n`);
    const r = run(["todo", p.at("bare.geml")]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /没有待办/);
    assert.equal(r.out, "");
  } finally { p.drop(); }
});

test("todo：交一个目录就是交整个项目 —— 引用是有方向的", () => {
  const p = project();
  try {
    const r = run(["todo", p.root, "--json"]);
    assert.equal(r.code, 0, r.err);
    const items = JSON.parse(r.out);
    assert.ok(items.some((i) => i.kind === "voice"), "从目录出发才看得见剧本里的台词：" + r.out);
  } finally { p.drop(); }
});

test("report：cast 与 stats 都出 CSV，别的 --kind 拒绝", () => {
  const p = project();
  try {
    for (const kind of ["cast", "stats"]) {
      const r = run(["report", p.at("lib.geml"), "--kind", kind]);
      assert.equal(r.code, 0, `${kind}: ${r.err}`);
    }
    const dflt = run(["report", p.at("lib.geml")]);
    assert.equal(dflt.code, 0, dflt.err);
    const bad = run(["report", p.at("lib.geml"), "--kind", "gossip"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--kind 只能是 cast 或 stats/);
  } finally { p.drop(); }
});

// ---------------------------------------------------------------------------
// lay
// ---------------------------------------------------------------------------

test("lay：按锚点给出 offset 初值；不给 --over 就拒绝", () => {
  const p = project();
  try {
    const r = run(["lay", p.at("cut.geml"), "--over", "#c1"]);
    assert.equal(r.code, 0, r.err);
    const sug = JSON.parse(r.out);
    assert.deepEqual(sug.map((s) => s.id), ["vo1", "sub1"], "按文档顺序排，一条接一条");
    assert.equal(sug[0].offset, 0);
    assert.equal(sug[1].offset, 2.2, "前一条 2 秒，加上缺省 0.2 的间隔");
    assert.equal(sug[0].dur, undefined, "音轨只给起点");
    assert.equal(sug[1].dur, 1.5, "散文轨连时长一起给 —— 字幕要知道自己挂多久");

    const noOver = run(["lay", p.at("cut.geml")]);
    assert.equal(noOver.code, 2);
    assert.match(noOver.err, /lay 需要 --over/);
  } finally { p.drop(); }
});

test("lay：--gap 读不成数就退回缺省，不报错也不 NaN", () => {
  const p = project();
  try {
    const r = run(["lay", p.at("cut.geml"), "--over", "#c1", "--gap", "一点点"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(JSON.parse(r.out).every((s) => Number.isFinite(s.offset)), r.out);
  } finally { p.drop(); }
});

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

test("build：没有 ffmpeg 就把本该执行的命令打出来，而不是失败了事", () => {
  const p = project();
  try {
    const r = run(["build", p.at("cut.geml"), "--out", "out.mp4"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /ffmpeg 不在 PATH 上/);
    assert.match(r.out, /^ffmpeg /, r.out);
    assert.match(r.out, /out\.mp4/);
  } finally { p.drop(); }
});

test("build：字幕默认另出一个 .srt，--burn-subs 才烧进画面", () => {
  const p = project();
  try {
    const plain = run(["build", p.at("cut.geml"), "--out", "out.mp4"]);
    assert.equal(plain.code, 0, plain.err);
    assert.equal(existsSync(p.at("out.srt")), true, "字幕另出一个文件");
    assert.match(p.read("out.srt"), /你好/);
    assert.match(plain.err, /不烧进画面/, plain.err);
    assert.ok(!/subtitles=/.test(plain.out), "滤镜链里没有烧字幕这一步");

    const burn = run(["build", p.at("cut.geml"), "--out", "burned.mp4", "--burn-subs", "--font", "Noto Sans CJK SC"]);
    assert.equal(burn.code, 0, burn.err);
    assert.match(burn.err, /同时烧进画面/, burn.err);
    assert.match(burn.out, /subtitles=/, "滤镜链里带上了烧字幕");
    assert.match(burn.out, /Noto Sans CJK SC/, "--font 传进了字幕样式");
  } finally { p.drop(); }
});

test("build：没有字幕轨时 --burn-subs 说清楚没东西可烧", () => {
  const p = project();
  try {
    writeFileSync(p.at("nosub.geml"), META
      + '==== media {#tl tracks="v:video"}\n\n'
      + "=== media-clip {#c1 track=v src=lib.geml#clip in=0 out=4}\n===\n\n====\n");
    const r = run(["build", p.at("nosub.geml"), "--out", "out.mp4", "--burn-subs"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /没有字幕轨/, r.err);
  } finally { p.drop(); }
});

test("build：不给 --out 就拒绝", () => {
  const p = project();
  try {
    const r = run(["build", p.at("cut.geml")]);
    assert.equal(r.code, 2);
    assert.match(r.err, /build 需要 --out/);
  } finally { p.drop(); }
});

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

test("log：一条记录追加进库，并且把素材块的哈希一起更新", () => {
  const p = project();
  try {
    const r = run(["log", p.at("lib.geml"), "--output", "#clip", "--model", "jimeng-4.5",
      "--mode", "t2i", "--prompt", "lib.geml#p", "--input", "lib.geml#vo", "--seed", "42"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /logged #clip/);
    const lib = p.read("lib.geml");
    assert.match(lib, /gen-log/, "库里出现了日志块");
    assert.match(lib, /jimeng-4\.5/);
    assert.match(lib, new RegExp(sha(CLIP)), "记录带上了产物文件此刻的哈希");
    assert.match(lib, /"seed"\s*:\s*42|seed.*42/, lib.slice(-400));
  } finally { p.drop(); }
});

test("log：三个必填参数缺一个就拒绝", () => {
  const p = project();
  try {
    for (const args of [
      ["--model", "m", "--mode", "x"],
      ["--output", "#clip", "--mode", "x"],
      ["--output", "#clip", "--model", "m"],
    ]) {
      const r = run(["log", p.at("lib.geml"), ...args]);
      assert.equal(r.code, 2, JSON.stringify(args));
      assert.match(r.err, /log 需要 --output --model --mode/);
    }
  } finally { p.drop(); }
});

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

test("import：清单进库，新素材块与日志记录一起落下", () => {
  const p = project();
  try {
    const r = run(["import", p.at("manifest.json"), "--into", p.at("lib.geml")]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /imported 1 条记录/);
    const lib = p.read("lib.geml");
    assert.match(lib, /media-asset \{#shot /, "按文件名起的 id");
    assert.match(lib, /origin=generated/);
  } finally { p.drop(); }
});

test("import：字幕进剧本，加 --cut 连字幕片段一起", () => {
  const p = project();
  try {
    const r = run(["import", p.at("sub.srt"), "--into", p.at("script.geml"), "--cut", p.at("cut.geml")]);
    assert.equal(r.code, 0, r.err);
    assert.match(p.read("script.geml"), /第一句/);
    assert.match(p.read("cut.geml"), /media-clip \{#sub-/, "字幕片段写进了时间线");
  } finally { p.drop(); }
});

test("import：id 撞了就停，不覆盖别人的块", () => {
  const p = project();
  try {
    const once = run(["import", p.at("sub.srt"), "--into", p.at("script.geml")]);
    assert.equal(once.code, 0, once.err);
    const twice = run(["import", p.at("sub.srt"), "--into", p.at("script.geml")]);
    assert.equal(twice.code, 2);
    assert.match(twice.err, /已经有这些 id/);
  } finally { p.drop(); }
});

test("import：单个媒体文件与整个目录都进素材块", () => {
  const one = project();
  try {
    const r = run(["import", one.at("clip.mp4"), "--into", one.at("lib.geml")]);
    assert.equal(r.code, 0, r.err);
    assert.match(one.read("lib.geml"), /src=clip\.mp4/);
  } finally { one.drop(); }

  const many = project();
  try {
    const r = run(["import", many.at("assets"), "--into", many.at("lib.geml")]);
    assert.equal(r.code, 0, r.err);
    assert.match(many.read("lib.geml"), /extra/, "目录下的文件被收进来");
  } finally { many.drop(); }
});

test("import：认不出的后缀与时间线格式各有各的说法", () => {
  const p = project();
  try {
    writeFileSync(p.at("weird.bin"), "?");
    writeFileSync(p.at("old.edl"), "TITLE: x");
    const unknown = run(["import", p.at("weird.bin"), "--into", p.at("lib.geml")]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /认不出/);

    const timeline = run(["import", p.at("old.edl"), "--into", p.at("lib.geml")]);
    assert.equal(timeline.code, 2);
    assert.match(timeline.err, /只往外导|不往回读/, timeline.err);
  } finally { p.drop(); }
});

test("import：不给 --into 就拒绝", () => {
  const p = project();
  try {
    const r = run(["import", p.at("manifest.json")]);
    assert.equal(r.code, 2);
    assert.match(r.err, /import 需要 --into/);
  } finally { p.drop(); }
});

console.log(`\n${passed} test(s) passed.`);
