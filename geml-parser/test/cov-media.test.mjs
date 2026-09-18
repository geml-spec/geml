// geml-media 的没走到的那些臂：时间模型里「答不上来」的每一种，以及动词里的退路。
// 和别的 cov-* 套件一样，这里覆盖的是**拒绝与退化**，不是功能 —— 功能在 media.test.mjs
// 里对着真项目跑，这里对着最小文档跑，一条分支一条分支地钉。
import { layout, layoutsOf, timecodeToSeconds } from "../dist/media-timeline.js";
import { exportTimeline, buildPlan, lay, importSubtitles, importPlan, todo, idFromFile, parseCues } from "../dist/media-verbs.js";
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const META = '=== meta\nprofile = "geml-media/v1"\n===\n\n';
/** 时间模型不碰文件系统：源有多长、是什么种类，都由调用方答。 */
const opts = (dur = {}, kind) => ({
  durationOf: (r) => dur[r],
  ...(kind === undefined ? {} : { kindOf: (r) => kind[r] }),
});
const tl = (src, o = opts()) => layout(META + src, o);
const at = (t, id) => t.clips.find((c) => c.id === id);

// ---------------------------------------------------------------------------
// 时码
// ---------------------------------------------------------------------------

test("时码：帧数要有 fps 才有意义，没有基准就答不上来", () => {
  assert.equal(timecodeToSeconds("00:00:04", 24), 4, "不带帧的时码不需要 fps");
  assert.equal(timecodeToSeconds("00:00:04", undefined), 4);
  assert.equal(timecodeToSeconds("00:01:02:12", 24), 62.5, "12 帧 @24fps = 半秒");
  assert.equal(timecodeToSeconds("01:00:00:00", undefined), 3600, "帧数是 0，没有 fps 也算得出来");
  assert.equal(timecodeToSeconds("00:00:01:12", undefined), undefined, "有帧数却没 fps：不猜");
  assert.equal(timecodeToSeconds("00:00:01:12", 0), undefined, "fps 是 0 同理");
  assert.equal(timecodeToSeconds("00:00:01:12", -24), undefined, "负 fps 同理");
  assert.equal(timecodeToSeconds("  00:00:02  ", 24), 2, "两头的空白不算数");
  assert.equal(timecodeToSeconds("4", 24), undefined, "不是时码就不是时码");
  assert.equal(timecodeToSeconds("00:0:04", 24), undefined, "位数不对也不是");
});

test("片段上的时码走同一条换算，坏值退回默认", () => {
  const t = tl('==== media {#m fps=25 tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x in=00:00:00:00 out=00:00:02:00}\n===\n\n"
    + "====\n");
  assert.equal(at(t, "a").duration, 2, "时码按 fps=25 换算");
  assert.equal(t.fps, 25);
});

test("fps 写不成数就当没写", () => {
  const t = tl('==== media {#m fps=每秒二十五帧 tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x duration=1}\n===\n\n====\n");
  assert.equal(t.fps, 0, "算不出 fps 的时间线报 0");
});

// ---------------------------------------------------------------------------
// 单源：无体 + src= 就是「只有一个片段的时间线」
// ---------------------------------------------------------------------------

test("单源：out= 决定时长，种类从被引的素材读", () => {
  const t = tl("=== media {#one src=#clip in=1 out=4}\n===\n", opts({}, { "#clip": "audio" }));
  assert.equal(t.clips.length, 1);
  assert.equal(t.duration, 3, "out - in");
  assert.equal(at(t, "one").in, 1);
  assert.equal(at(t, "one").kind, "audio", "kindOf 说了算");
  assert.equal(t.primary, "main");
  assert.deepEqual(t.tracks, [{ name: "main", kind: "audio" }]);
  assert.deepEqual(t.problems, []);
});

test("单源：没有 kindOf 就当视频", () => {
  const t = tl("=== media {#one src=#clip out=2}\n===\n");
  assert.equal(at(t, "one").kind, "video");
});

test("单源：没有 out= 就退到 duration=，再退到源的固有时长", () => {
  assert.equal(tl("=== media {#one src=#clip duration=5}\n===\n").duration, 5);
  const fromSrc = tl("=== media {#one src=#clip in=2}\n===\n", opts({ "#clip": 9 }));
  assert.equal(fromSrc.duration, 7, "固有时长减去入点");
});

test("单源：三条路都答不上来就是 0 秒，并且说出来", () => {
  const t = tl("=== media {#one src=#clip}\n===\n");
  assert.equal(t.duration, 0);
  assert.equal(t.problems.length, 1);
  assert.match(t.problems[0], /`one` 算不出时长/);
});

test("单源：out 比 in 还小不会算出负数", () => {
  assert.equal(tl("=== media {#one src=#clip in=5 out=2}\n===\n").duration, 0);
  assert.equal(tl("=== media {#one src=#clip in=9}\n===\n", opts({ "#clip": 4 })).duration, 0);
});

// ---------------------------------------------------------------------------
// 轨道表与主轨
// ---------------------------------------------------------------------------

test("轨道表里没写种类的条目不算一条轨", () => {
  const t = tl('==== media {#m tracks="v:video bare a:audio"}\n\n'
    + "=== media-clip {#c track=v src=#x duration=1}\n===\n\n====\n");
  assert.deepEqual(t.tracks, [{ name: "v", kind: "video" }, { name: "a", kind: "audio" }]);
  assert.equal(t.primary, "v", "主轨缺省是声明的第一条");
});

test("primary= 写了就听它的，哪怕不是第一条", () => {
  const t = tl('==== media {#m tracks="v:video a:audio" primary=a}\n\n'
    + "=== media-clip {#c track=a src=#x duration=1}\n===\n\n====\n");
  assert.equal(t.primary, "a");
  assert.equal(at(t, "c").kind, "audio");
});

test("一条轨都没声明时主轨是空名，没写 track= 的片段就落在它上面", () => {
  const t = tl("==== media {#m}\n\n"
    + "=== media-clip {#c src=#x duration=1}\n===\n\n====\n");
  assert.equal(t.primary, "");
  assert.deepEqual(t.tracks, []);
  assert.equal(at(t, "c").start, 0);
  assert.equal(at(t, "c").kind, "video", "查不到种类的轨当视频");
});

// ---------------------------------------------------------------------------
// 片段时长：speed、退路、以及算不出来
// ---------------------------------------------------------------------------

test("speed 把时长按比例压缩，写成 0 当 1 用", () => {
  const two = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x out=4 speed=2}\n===\n\n====\n");
  assert.equal(at(two, "a").duration, 2);
  const zero = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x out=4 speed=0}\n===\n\n====\n");
  assert.equal(at(zero, "a").duration, 4, "除以 0 是没意义的，退回原速");
  const byDur = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x duration=6 speed=3}\n===\n\n====\n");
  assert.equal(at(byDur, "a").duration, 2, "duration= 也过 speed");
  const bySrc = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x speed=2}\n===\n\n====\n", opts({ "#x": 10 }));
  assert.equal(at(bySrc, "a").duration, 5, "固有时长也过 speed");
});

test("片段算不出时长就报出来，并且按 0 秒摆在那儿", () => {
  const t = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x}\n===\n\n====\n");
  assert.equal(at(t, "a").duration, 0);
  assert.equal(t.problems.length, 1);
  assert.match(t.problems[0], /片段 #a 算不出时长/);
});

// ---------------------------------------------------------------------------
// 转场重叠
// ---------------------------------------------------------------------------

test("只有 dissolve 和 crossfade 借重叠，cut 与 fade 不借", () => {
  const doc = (trans) => tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x out=4}\n===\n\n"
    + `=== media-clip {#b track=v src=#x out=4 transition-in=${trans} transition-duration=0.5}\n===\n\n====\n`);
  assert.equal(at(doc("crossfade"), "b").start, 3.5);
  assert.equal(at(doc("dissolve"), "b").start, 3.5);
  assert.equal(at(doc("fade"), "b").start, 4, "fade 不重叠");
  assert.equal(at(doc("cut"), "b").start, 4);
});

test("dissolve 没写时长就借 0，第一刀永远从 0 起", () => {
  const t = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x out=4 transition-in=dissolve transition-duration=99}\n===\n\n"
    + "=== media-clip {#b track=v src=#x out=4 transition-in=dissolve}\n===\n\n====\n");
  assert.equal(at(t, "a").start, 0, "第一刀不往回借，哪怕写了重叠");
  assert.equal(at(t, "b").start, 4, "没写 transition-duration 就是 0");
});

test("重叠借过头也不会退到负数", () => {
  const t = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x out=1}\n===\n\n"
    + "=== media-clip {#b track=v src=#x out=4 transition-in=dissolve transition-duration=99}\n===\n\n====\n");
  assert.equal(at(t, "b").start, 0);
});

// ---------------------------------------------------------------------------
// 锚定轨
// ---------------------------------------------------------------------------

test("锚定：over= 带不带 # 都认，offset 缺省是 0", () => {
  const t = tl('==== media {#m tracks="v:video s:caption"}\n\n'
    + "=== media-clip {#a track=v src=#x out=4}\n===\n\n"
    + "=== media-clip {#b track=v src=#x out=4}\n===\n\n"
    + "=== media-clip {#s1 track=s src=#t duration=1 over=#b offset=0.4}\n===\n\n"
    + "=== media-clip {#s2 track=s src=#t duration=1 over=b}\n===\n\n====\n");
  assert.equal(at(t, "s1").start, 4.4);
  assert.equal(at(t, "s2").start, 4, "没有 offset 就正对着锚点");
  assert.equal(at(t, "s1").kind, "caption");
});

test("锚定：at= 是逃生口，写了它就不看 over=", () => {
  const t = tl('==== media {#m tracks="v:video s:caption"}\n\n'
    + "=== media-clip {#a track=v src=#x out=4}\n===\n\n"
    + "=== media-clip {#s1 track=s src=#t duration=1 at=2 over=#nowhere offset=9}\n===\n\n====\n");
  assert.equal(at(t, "s1").start, 2, "at= 说了算，坏的 over= 也不追究");
  assert.deepEqual(t.problems, []);
});

test("锚定：over= 指不到主轨上的片段，这一条就落不下来", () => {
  const t = tl('==== media {#m tracks="v:video s:caption"}\n\n'
    + "=== media-clip {#a track=v src=#x out=4}\n===\n\n"
    + "=== media-clip {#s1 track=s src=#t duration=1 over=#nowhere}\n===\n\n"
    + "=== media-clip {#s2 track=s src=#t duration=1}\n===\n\n====\n");
  assert.equal(at(t, "s1"), undefined, "摆不下就不摆");
  assert.equal(at(t, "s2"), undefined);
  assert.equal(t.problems.length, 2);
  assert.match(t.problems[0], /over=#nowhere 不是主轨上的片段/);
  assert.match(t.problems[1], /over=\(缺\) 不是主轨上的片段/, "连 over= 都没写时说清楚是缺");
});

test("同一起点的两条按轨名排，顺序才是稳的", () => {
  const t = tl('==== media {#m tracks="v:video b:audio a:caption"}\n\n'
    + "=== media-clip {#c track=v src=#x out=4}\n===\n\n"
    + "=== media-clip {#bb track=b src=#t duration=1 over=#c}\n===\n\n"
    + "=== media-clip {#aa track=a src=#t duration=1 over=#c}\n===\n\n====\n");
  assert.deepEqual(t.clips.map((c) => c.track), ["a", "b", "v"], "同起点按轨名");
  assert.equal(t.clips[0].start, 0);
});

// ---------------------------------------------------------------------------
// 只认秒数的位上写了别的
// ---------------------------------------------------------------------------

test("时码写在只认秒数的位上等于没写，各自退回默认", () => {
  // duration= / speed= / transition-duration= / offset= 都走同一个读数器，
  // 它认得出时码的形状，但这些位上时码没有意义 —— 所以答 undefined，让默认值接手。
  const t = tl('==== media {#m tracks="v:video s:caption"}\n\n'
    + "=== media-clip {#a track=v src=#x duration=00:00:02:00 speed=00:00:01}\n===\n\n"
    + "=== media-clip {#b track=v src=#x out=4 transition-in=dissolve transition-duration=00:00:01}\n===\n\n"
    + "=== media-clip {#s track=s src=#t duration=1 over=#a offset=00:00:01}\n===\n\n====\n",
    opts({ "#x": 3 }));
  assert.equal(at(t, "a").duration, 3, "duration= 读不出来就退到固有时长，speed 退回原速");
  assert.equal(at(t, "b").start, 3, "transition-duration 读不出来，重叠就是 0");
  assert.equal(at(t, "s").start, 0, "offset 读不出来就是 0");
});

test("读不成数的值同样退回默认", () => {
  const t = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x out=4 speed=飞快}\n===\n\n====\n");
  assert.equal(at(t, "a").duration, 4, "speed 退回 1");
});

test("speed=0 在三条算长度的路上都退回原速", () => {
  const byDur = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x duration=6 speed=0}\n===\n\n====\n");
  assert.equal(at(byDur, "a").duration, 6);
  const bySrc = tl('==== media {#m tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x speed=0}\n===\n\n====\n", opts({ "#x": 8 }));
  assert.equal(at(bySrc, "a").duration, 8);
});

test("片段没写 src= 就按空引用算，位置照摆", () => {
  const t = tl('==== media {#m tracks="v:video s:caption"}\n\n'
    + "=== media-clip {#a track=v duration=2}\n===\n\n"
    + "=== media-clip {#s track=s duration=1 over=#a}\n===\n\n====\n");
  assert.equal(at(t, "a").src, "");
  assert.equal(at(t, "s").src, "", "锚定轨上同理");
});

test("没有 id 的 media 块照算，只是报不出名字", () => {
  const one = tl("=== media {src=#x}\n===\n");
  assert.equal(one.id, "");
  assert.equal(one.clips[0].id, "");
  assert.match(one.problems[0], /`\?` 算不出时长/, "报问题时用 ? 顶替缺掉的名字");
  const many = tl('==== media {tracks="v:video"}\n\n'
    + "=== media-clip {#a track=v src=#x duration=1}\n===\n\n====\n");
  assert.equal(many.id, "");
  assert.equal(many.duration, 1);
});

// ---------------------------------------------------------------------------
// 一份文档里的多条时间线
// ---------------------------------------------------------------------------

test("没有子块的块不下钻", () => {
  const doc = parse(META + "=== code {#c lang=sh}\necho hi\n===\n\n=== media {#one src=#x out=1}\n===\n");
  assert.deepEqual(layoutsOf(doc, opts()).map((t) => t.id), ["one"]);
});

test("每个 media 块各是一条时间线，嵌在别的块里也找得到", () => {
  const doc = parse(META
    + "=== media {#one src=#x out=2}\n===\n\n"
    + "==== note {#g}\n\n"
    + "=== media {#two src=#y out=3}\n===\n\n"
    + "====\n");
  const all = layoutsOf(doc, opts());
  assert.deepEqual(all.map((t) => t.id), ["one", "two"], "下钻到嵌套块里，但不钻进 media 自己");
  assert.equal(all[1].duration, 3);
});

test("一个 media 块都没有的文档给出一条空时间线", () => {
  const t = tl("=== note {#n}\n没有片子\n===\n");
  assert.deepEqual(t, { id: "", fps: 0, primary: "", tracks: [], clips: [], duration: 0, problems: [] });
});

// ---------------------------------------------------------------------------
// 动词：宿主接口只有三个方法，所以这里的"项目"整个活在内存里 —— 不落盘，也就没有
// 临时目录要收。media.test.mjs 对着真项目跑功能，这里跑的是它走不到的那些臂。
// ---------------------------------------------------------------------------

const sha = (s) => createHash("sha256").update(Buffer.from(s)).digest("hex");
const memIo = (files) => ({
  readDoc: (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null),
  hashText: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
  hashFile: (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? sha(files[rel]) : null),
});

const SOLO_FILES = {
  "lib.geml": META + `=== media-asset {#clip src=clip.mp4 sha256=${sha("VIDEO")} kind=video duration=6}\n===\n`,
  "cut.geml": META + "=== media {#solo src=lib.geml#clip out=3}\n===\n",
  "clip.mp4": "VIDEO",
};

// 单源那条路是唯一会问"这个源是什么种类"的路 —— 装配件的种类写在轨道表上。四个动词
// 各自把那个回调递给时间模型，所以四个都要走一趟单源，否则那段代码没人碰过。
test("单源文档走得通每一个动词，种类回调才有人问", () => {
  const io = memIo(SOLO_FILES);
  const tl = JSON.parse(exportTimeline("cut.geml", "json", io));
  assert.equal(tl.clips.length, 1);
  assert.equal(tl.clips[0].kind, "video", "种类是问素材块要的");

  const plan = buildPlan("cut.geml", "out.mp4", io);
  assert.ok(plan.args.length > 0, "出片计划排得出来");

  assert.deepEqual(lay("cut.geml", "solo", io), [], "单源上没有锚定片段可摆");
  assert.deepEqual(lay("cut.geml", "nobody", io), [], "锚点不存在就是空建议");

  const sub = importSubtitles(
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    { idPrefix: "l", srcDoc: "", cutEntry: "cut.geml", track: "s" },
    io,
  );
  assert.match(sub.lines, /你好/);
  assert.deepEqual(sub.ids, ["l1", "sub-l1"], "给了时间线就同时出台词块和字幕片段");
});

test("读不到的入口不炸，动词各自给空结果", () => {
  const io = memIo({});
  assert.deepEqual(lay("nope.geml", "x", io), []);
});

test("字幕：读不出时间或没有正文的那几条被跳过并计数", () => {
  const { cues, skipped } = parseCues([
    "1", "00:00:00,000 --> 00:00:01,000", "留下", "",
    "2", "这一行不是时间", "丢掉", "",
    "3", "呃呃呃 --> 啊啊啊", "时间读不出来", "",
    "4", "00:00:02,000 --> 00:00:03,000", "", "",
  ].join("\n"));
  assert.deepEqual(cues.map((c) => c.text), ["留下"]);
  assert.equal(skipped, 3, "三条都被跳过：没有时间行、时间读不出、正文是空的");
});

test("一条都读不出来的字幕说得明白，而不是交一份空文档", () => {
  const r = importSubtitles("整个文件都不是 srt\n", { idPrefix: "l", srcDoc: "", cutEntry: null }, memIo({}));
  assert.equal(r.lines, "");
  assert.equal(r.clips, null);
  assert.deepEqual(r.ids, []);
  assert.ok(r.notes.some((n) => /没有解析出任何字幕/.test(n)), JSON.stringify(r.notes));
});

test("文件名变 id 与 importPlan 用的是同一条规则", () => {
  assert.equal(idFromFile("shots/s01 take 3.final.mp4"), "s01-take-3-final");
  assert.equal(idFromFile("plain"), "plain");
  assert.equal(idFromFile("a/b/c.png"), "c");
});

// --- importPlan 的每一条退路 ------------------------------------------------

const IMPORT_FILES = () => ({
  "lib.geml": META
    + `=== media-asset {#old src=old.png sha256=${sha("SAME")} kind=image}\n===\n\n`
    + "=== media-text {#p .prompt}\n一只猫\n===\n",
  "old.png": "SAME",
  "dupe.png": "SAME",          // 与 #old 同内容 —— 哈希撞上，应当复用
  "fresh.png": "NEW",
});

test("import：清单里读不到的文件跳过并说出来", () => {
  const io = memIo(IMPORT_FILES());
  const plan = importPlan("lib.geml", [{ file: "ghost.png", model: "m", mode: "t2i" }], io);
  assert.deepEqual(plan.newAssets, []);
  assert.ok(plan.notes.some((n) => /ghost\.png 读不到/.test(n)), JSON.stringify(plan.notes));
});

test("import：哈希撞上既有素材就复用，不新建第二个块", () => {
  const io = memIo(IMPORT_FILES());
  const plan = importPlan("lib.geml", [{ file: "dupe.png", model: "m", mode: "t2i" }], io);
  assert.deepEqual(plan.newAssets, [], "没有新素材");
  assert.ok(plan.notes.some((n) => /复用它而不新建/.test(n)), JSON.stringify(plan.notes));
  assert.equal(plan.records[0].output, "#old", "记录指向既有的那个");
});

test("import：新文件按文件名起 id，种类从扩展名来", () => {
  const io = memIo(IMPORT_FILES());
  const plan = importPlan("lib.geml", [
    { file: "fresh.png", model: "m", mode: "t2i" },
    { file: "fresh.png", model: "m", mode: "t2i" },
  ], io);
  assert.equal(plan.newAssets.length, 1, "同一份内容在一次导入里也只建一个");
  assert.equal(plan.newAssets[0].id, "fresh");
  assert.equal(plan.newAssets[0].kind, "image");
});

test("import：展不开的提示词照样落记录，只是没有提示词哈希", () => {
  const io = memIo(IMPORT_FILES());
  const ok = importPlan("lib.geml", [{ file: "fresh.png", model: "m", mode: "t2i", prompt: "lib.geml#p" }], io);
  assert.ok(typeof ok.records[0]["prompt-sha256"] === "string", "展得开就带哈希");
  const bad = importPlan("lib.geml", [{ file: "fresh.png", model: "m", mode: "t2i", prompt: "lib.geml#nowhere" }], io);
  assert.equal(bad.records[0]["prompt-sha256"], undefined);
  assert.ok(bad.notes.some((n) => /展不开提示词/.test(n)), JSON.stringify(bad.notes));
});

test("import：输入项补上被引块的哈希，指不到的原样留着", () => {
  const io = memIo(IMPORT_FILES());
  const plan = importPlan("lib.geml", [{
    file: "fresh.png", model: "m", mode: "t2i",
    inputs: [{ ref: "lib.geml#old", role: "sheet" }, { ref: "lib.geml#nowhere" }],
  }], io);
  const inputs = plan.records[0].inputs;
  assert.equal(inputs[0].sha256, sha("SAME"), "查得到就补上哈希");
  assert.equal(inputs[0].role, "sheet", "原有的字段留着");
  assert.equal(inputs[1].sha256, undefined, "查不到就原样");
});

test("import：seed / params / cost / error 原样带进记录，at 缺省是此刻", () => {
  const io = memIo(IMPORT_FILES());
  const plan = importPlan("lib.geml", [{
    file: "fresh.png", model: "m", mode: "t2i",
    seed: 7, params: { cfg: 4 }, cost: 0.02, error: "偶尔会花",
  }], io);
  const r = plan.records[0];
  assert.equal(r.seed, 7);
  assert.deepEqual(r.params, { cfg: 4 });
  assert.equal(r.cost, 0.02);
  assert.equal(r.error, "偶尔会花");
  assert.match(String(r.at), /^\d{4}-\d\d-\d\dT/, "没给时间就记此刻");
  const fixed = importPlan("lib.geml", [{ file: "fresh.png", model: "m", mode: "t2i", at: "2026-01-01T00:00:00Z" }], io);
  assert.equal(fixed.records[0].at, "2026-01-01T00:00:00Z", "给了就用给的");
});

// --- todo 的参考图与配音候选 ------------------------------------------------

const TODO_LIB = META
  + `=== media-asset {#sheet src=s.png sha256=${sha("S")} kind=image role=sheet of=lib.geml#hero}\n===\n\n`
  + `=== media-asset {#lora src=l.safetensors sha256=${sha("L")} kind=model role=lora}\n===\n\n`
  + `=== media-asset {#master src=m.png sha256=${sha("M")} kind=image role=master}\n===\n\n`
  + `=== media-asset {#plain src=p.png sha256=${sha("P")} kind=image role=ref}\n===\n\n`
  + `=== media-asset {#v-hero src=v1.wav sha256=${sha("V1")} kind=audio role=voice of=lib.geml#hero}\n===\n\n`
  + `=== media-asset {#v-noof src=v2.wav sha256=${sha("V2")} kind=audio role=voice}\n===\n\n`
  + `=== media-asset {#v-other src=v3.wav sha256=${sha("V3")} kind=audio role=voice of=lib.geml#villain}\n===\n\n`
  + "=== media-text {#p .prompt}\n一只猫\n===\n\n"
  + "=== media-text {#l1 .line speaker=lib.geml#hero}\n你好\n===\n";

test("todo：没产出的提示词带上参考图，只认 sheet / lora / master", () => {
  const items = todo("lib.geml", memIo({ "lib.geml": TODO_LIB }));
  const gen = items.find((i) => i.kind === "generate");
  assert.ok(gen !== undefined, JSON.stringify(items));
  assert.deepEqual(gen.refs.map((r) => r.role).sort(), ["lora", "master", "sheet"]);
  assert.ok(gen.refs.every((r) => r.ref.startsWith("lib.geml#")), "参考图按地址给");
  assert.ok(!gen.refs.some((r) => r.ref.endsWith("#plain")), "role=ref 的不是参考图");
});

test("todo：配音候选要 of= 真的指向这句话的说话人", () => {
  const items = todo("lib.geml", memIo({ "lib.geml": TODO_LIB }));
  const voice = items.find((i) => i.kind === "voice");
  assert.ok(voice !== undefined, JSON.stringify(items));
  assert.deepEqual(voice.refs.map((r) => r.ref), ["lib.geml#v-hero"],
    "没写 of= 的、以及 of= 指着别人的，都不是这句的候选");
});

// --- buildPlan 的跳过 -------------------------------------------------------

test("build：源落不到文件上的片段被跳过，并且逐条说出来", () => {
  const io = memIo({
    "cut.geml": META + '==== media {#m tracks="v:video a:audio"}\n\n'
      + "=== media-clip {#c1 track=v src=#ghost duration=2}\n===\n\n"
      + "=== media-clip {#a1 track=a src=#ghost2 duration=2 over=#c1}\n===\n\n====\n",
  });
  const plan = buildPlan("cut.geml", "out.mp4", io);
  assert.ok(plan.notes.some((n) => /#c1 的源没有文件路径，跳过/.test(n)), JSON.stringify(plan.notes));
  assert.ok(plan.notes.some((n) => /#a1 的源没有文件路径，跳过/.test(n)), JSON.stringify(plan.notes));
});

test("import：种类按扩展名分到 model 和 other", () => {
  const io = memIo({
    "lib.geml": META + "=== media-text {#p .prompt}\n一只猫\n===\n",
    "w.safetensors": "WEIGHTS",
    "notes.txt": "TEXT",
  });
  const plan = importPlan("lib.geml", [
    { file: "w.safetensors", model: "m", mode: "train" },
    { file: "notes.txt", model: "m", mode: "misc" },
  ], io);
  assert.deepEqual(plan.newAssets.map((a) => a.kind), ["model", "other"]);
});

console.log(`\n${passed} test(s) passed.`);
