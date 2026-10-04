// geml-media/v1 的播放器组件。时间不在这里算 —— 它和 `geml media build` 用同一份
// layoutDoc，所以这里验的是"那份结果有没有被原样摆成真媒体元素"。
import { parse } from "../../../geml-parser/dist/geml.js";
import { player, drivePlayer } from "../src/media-player.js";
import { timelineTrack, MAX_TICKS } from "../src/media.js";
import { renderBlock, collectLabels } from "../src/render.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const CUT = `=== meta
title = "T"
profile = "geml-media/v1"
===

==== media {#tl tracks="video:video dialogue:audio subtitle:prose" primary=video fps=24}

=== media-clip {#c01 track=video src=lib.geml#a1 in=0 out=4}
===

=== media-clip {#c02 track=video src=lib.geml#a2 in=1 out=7 transition-in=dissolve transition-duration=0.5}
===

=== media-clip {#vo track=dialogue src=lib.geml#v1 over=#c02 offset=0.4 gain=-6dB}
===

=== media-clip {#sub track=subtitle src=script.geml#l1 over=#c02 offset=0.4 duration=2.1}
===

====
`;
const LIB = `=== meta
profile = "geml-media/v1"
===

=== media-asset {#a1 src=assets/a1.mp4 kind=video duration=9}
===

=== media-asset {#a2 src=assets/a2.mp4 kind=video duration=9}
===

=== media-asset {#v1 src=assets/v1.wav kind=audio duration=2.1}
===
`;
const SCRIPT = `=== meta
profile = "geml-media/v1"
===

=== media-text {#l1 .line speaker=../characters.geml#x}
姐……你怎么会……
===
`;

// 语料里的 path 相对本页所在目录 —— 本页是 show/ 下的一页，剧集在它下面的 ep01/。
const PAGE = "https://site.test/show/index.geml";

function build(params = {}) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const cut = parse(CUT);
  const corpus = [
    { path: "ep01/cut.geml", doc: cut },
    { path: "ep01/lib.geml", doc: parse(LIB) },
    { path: "ep01/script.geml", doc: parse(SCRIPT) },
  ];
  const ctx = { dom: document, corpus, renderBlock, labels: collectLabels(cut.children), byId: new Map(), docUrl: PAGE };
  return { el: player(null, params, ctx), document };
}

test("一个片段一个媒体元素，画面轨是 video、声音轨是 audio，散文轨不进舞台", () => {
  const { el } = build();
  const ids = [...el.querySelectorAll(".geml-layer")].map((x) => x.getAttribute("data-clip"));
  assert.deepEqual(ids, ["c01", "c02", "vo"]);
  assert.equal(el.querySelectorAll("video").length, 2);
  assert.equal(el.querySelectorAll("audio").length, 1);
});

test("起点、时长、源内入点原样来自时间线，不在组件里重算", () => {
  const { el } = build();
  const at = (id) => el.querySelector(`[data-clip="${id}"]`);
  assert.equal(at("c01").getAttribute("data-start"), "0.000");
  assert.equal(at("c01").getAttribute("data-end"), "4.000");
  // 转场是从**前一刀的尾巴**借时间：c02 声明 4s 起、dissolve 0.5s，于是 3.5s 就压上来。
  // 这一条不是组件的算法，是 layoutDoc 的；摆在这里是为了它一旦变，页面会先喊。
  assert.equal(at("c02").getAttribute("data-start"), "3.500");
  assert.equal(at("c02").getAttribute("data-end"), "9.500");
  assert.equal(at("c02").getAttribute("data-in"), "1.000");   // in=1 的源内入点
  assert.equal(at("vo").getAttribute("data-start"), "3.900"); // over=#c02 offset=0.4
  assert.equal(el.getAttribute("data-duration"), "9.500");
});

test("跨文档的 src 按素材所在的文档解析，交给元素的是解析出的地址", () => {
  const { el } = build();
  assert.equal(el.querySelector('[data-clip="c01"]').getAttribute("src"), "https://site.test/show/ep01/assets/a1.mp4");
  assert.equal(el.querySelector('[data-clip="vo"]').getAttribute("src"), "https://site.test/show/ep01/assets/v1.wav");
});

test("画面轨静音 —— 声音走声音轨；gain 的 dB 换算成线性音量", () => {
  const { el } = build();
  assert.equal(el.querySelector('[data-clip="c01"]').getAttribute("muted"), "");
  assert.equal(el.querySelector('[data-clip="vo"]').hasAttribute("muted"), false);
  assert.equal(Number(el.querySelector('[data-clip="vo"]').getAttribute("data-gain")).toFixed(3), "0.501");
});

test("散文轨成了字幕表，文字取自被引的块而不是它的类型名", () => {
  const { el } = build();
  const cues = JSON.parse(el.getAttribute("data-captions"));
  assert.deepEqual(cues, [{ start: 3.9, end: 6, text: "姐……你怎么会……" }]);
});

test("画面比例只从样式表来 —— 内容文档不决定摆成竖屏还是横屏", () => {
  assert.equal(build({ aspect: "9:16" }).el.querySelector(".geml-stage").style.aspectRatio, "9 / 16");
  // 样式表没说就不设，交给 CSS 的缺省，而不是让内容文档偷偷决定。
  assert.equal(build().el.querySelector(".geml-stage").style.aspectRatio, "");
});

test("转场带到元素上，时钟才知道要不要淡", () => {
  const { el } = build();
  const c02 = el.querySelector('[data-clip="c02"]');
  assert.equal(c02.getAttribute("data-transition-in"), "dissolve");
  assert.equal(c02.getAttribute("data-transition-duration"), "0.5");
});

test("没有时间线时说出来，不给一个空播放器", () => {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const doc = parse("=== meta\ntitle = \"x\"\n===\n\n正文。\n");
  const el = player(null, {}, { dom: document, corpus: [{ path: "a.geml", doc }], renderBlock, labels: new Map(), byId: new Map() });
  assert.match(el.className, /geml-player-empty/);
  assert.match(el.textContent, /没有可播的时间线/);
});

test("drivePlayer 只接一次，重复调用不再叠一套监听", () => {
  const { el } = build();
  // linkedom 没实现媒体元素，补上时钟要用的两个方法；验的是接线本身与幂等。
  for (const l of el.querySelectorAll(".geml-layer")) {
    l.paused = true;
    l.play = () => { l.paused = false; };
    l.pause = () => { l.paused = true; };
  }
  drivePlayer(el);
  assert.equal(el.__gemlDriven, true);
  assert.equal(el.getAttribute("tabindex"), "0");
  // t=0：只有第一刀在台上，其余藏起来。
  assert.equal(el.querySelector('[data-clip="c01"]').style.visibility, "visible");
  assert.equal(el.querySelector('[data-clip="vo"]').style.visibility, "hidden");
  assert.equal(el.querySelector(".geml-clock").textContent, "0:00.0 / 0:09.5");
  drivePlayer(el);   // 第二次是空操作
  assert.equal(el.getAttribute("tabindex"), "0");
});

// Round 6 (V-2). 素材的 src= 是文档数据，<video>/<audio> 打开页面就去取它。不在本页的源上
// （file:// 下：不在本页所在目录里）的一律不进舞台 —— 带 scheme 的、`//host` 的、含 `\` 的
// （http(s) 与 file 的 URL 把 `\` 读成 `/`）、`..` 走出目录的、夹着控制字符拼回 `//` 的。
function stage(docUrl, assets) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  let cut = '=== meta\nprofile = "geml-media/v1"\n===\n\n==== media {#tl tracks="video:video" primary=video}\n\n';
  assets.forEach((_, i) => { cut += `=== media-clip {#c${i} track=video src=lib.geml#a${i} in=0 out=1}\n===\n\n`; });
  cut += "====\n";
  const lib = assets.map((src, i) => `=== media-asset {#a${i} kind=video duration=9}\n===\n`).join("\n");
  const libDoc = parse('=== meta\nprofile = "geml-media/v1"\n===\n\n' + lib);
  // 属性值原样塞进模型，免得 GEML 的引号转义规则替测试改写了 payload。
  libDoc.children.filter((b) => b.type === "media-asset").forEach((b, i) => { b.attrs.src = assets[i]; });
  const corpus = [{ path: "cut.geml", doc: parse(cut) }, { path: "lib.geml", doc: libDoc }];
  const ctx = { dom: document, corpus, renderBlock, labels: new Map(), byId: new Map(), ...(docUrl ? { docUrl } : {}) };
  return [...player(null, {}, ctx).querySelectorAll(".geml-layer")].map((m) => [m.getAttribute("data-clip"), m.getAttribute("src"), m.getAttribute("preload")]);
}
const TAB = String.fromCharCode(9);
const HOSTILE = [
  "https://evil.example/beacon.mp4", "https:/evil.example/beacon.mp4", "//evil.example/x.mp4",
  "\\\\evil.example\\share\\v.mp4", "/\\evil.example/x.mp4", "\\/evil.example/x.mp4",
  TAB + "/" + TAB + "/evil.example/x.mp4", "javascript:alert(1)", "data:video/mp4;base64,AAAA",
];

test("round 6: a media-asset src off the page's origin or directory never reaches a media element", () => {
  // file://：只认本页目录之内。根路径、`..` 走出目录的也不认。
  const file = stage("file:///Users/v/ep/cut.geml", [...HOSTILE, "../outside.mp4", "/etc/clip.mp4", "assets/ok.mp4"]);
  assert.deepEqual(file, [[`c${HOSTILE.length + 2}`, "file:///Users/v/ep/assets/ok.mp4", "metadata"]]);
  // http(s)：同源就行，`..` 留在同源里也可以；带 scheme 的哪怕指回本站也不认 —— src 是路径。
  const web = stage("https://site.test/ep/cut.geml", [...HOSTILE, "https://site.test/ep/a.mp4", "../shared/b.mp4", "c.mp4"]);
  assert.deepEqual(web, [
    [`c${HOSTILE.length + 1}`, "https://site.test/shared/b.mp4", "metadata"],
    [`c${HOSTILE.length + 2}`, "https://site.test/ep/c.mp4", "metadata"],
  ]);
  // 没有本页地址就无从判断：一个也不取。
  assert.deepEqual(stage(null, ["ok.mp4"]), []);
});

// Round 6 (V-3). 时间线的总长来自文档（out= / duration=），没有上限；尺子每秒一格就是
// out=400000 → 四十万个 <span>，一个标签页卡死。格数封顶，间隔放宽到 1、2、5 × 10ⁿ 秒。
function ruler(out) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const cut = parse(`=== meta\nprofile = "geml-media/v1"\n===\n\n==== media {#tl tracks="video:video" primary=video}\n\n` +
    out.map((o, i) => `=== media-clip {#c${i} track=video src=x.mp4 in=0 out=${o}}\n===\n\n`).join("") + "====\n");
  const el = timelineTrack(null, {}, { dom: document, corpus: [{ path: "cut.geml", doc: cut }] });
  return [...el.querySelectorAll(".geml-tick")].map((t) => t.textContent);
}

test("round 6: a timeline ruler draws at most MAX_TICKS + 1 ticks however long the document says it is", () => {
  assert.deepEqual(ruler([4]), ["0", "1", "2", "3", "4"], "a short timeline keeps a tick a second");
  const long = ruler([400000]);
  assert.ok(long.length <= MAX_TICKS + 1, `${long.length} ticks`);
  assert.deepEqual(long.slice(0, 3), ["0", "2000", "4000"], "the step is a round number of seconds");
  const t0 = Date.now();
  assert.deepEqual(ruler(["1e308", "1e308"]), [], "a length that overflows to Infinity draws no ruler");
  assert.ok(Date.now() - t0 < 2000, "and returns at once");
});

console.log(String.fromCharCode(10) + passed + " passed");
