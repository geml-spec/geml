// geml-media/v1 的播放器组件。时间不在这里算 —— 它和 `geml media build` 用同一份
// layoutDoc，所以这里验的是"那份结果有没有被原样摆成真媒体元素"。
import { parse } from "../../../geml-parser/dist/geml.js";
import { player, drivePlayer } from "../src/media-player.js";
import { renderBlock, collectLabels } from "../src/render.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const CUT = `=== meta
title = "T"
profile = "geml-media/v1"
fps = 24
tracks = "video:video dialogue:audio subtitle:prose"
primary = "video"
aspect = "9:16"
===

=== media-clip {#c01 track=video src=lib.geml#a1 in=0 out=4}
===

=== media-clip {#c02 track=video src=lib.geml#a2 in=1 out=7 transition-in=dissolve transition-dur=0.5}
===

=== media-clip {#vo track=dialogue src=lib.geml#v1 over=#c02 offset=0.4 gain=-6dB}
===

=== media-clip {#sub track=subtitle src=script.geml#l1 over=#c02 offset=0.4 dur=2.1}
===
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

function build() {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const cut = parse(CUT);
  const corpus = [
    { path: "ep01/cut.geml", doc: cut },
    { path: "ep01/lib.geml", doc: parse(LIB) },
    { path: "ep01/script.geml", doc: parse(SCRIPT) },
  ];
  const ctx = { dom: document, corpus, renderBlock, labels: collectLabels(cut.children), byId: new Map() };
  return { el: player(null, {}, ctx), document };
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

test("跨文档的 src 解析成相对根的媒体路径", () => {
  const { el } = build();
  assert.equal(el.querySelector('[data-clip="c01"]').getAttribute("src"), "ep01/assets/a1.mp4");
  assert.equal(el.querySelector('[data-clip="vo"]').getAttribute("src"), "ep01/assets/v1.wav");
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

test("画面比例从 meta 的 aspect 来，竖屏就是竖屏", () => {
  const { el } = build();
  assert.equal(el.querySelector(".geml-stage").style.aspectRatio, "9 / 16");
});

test("转场带到元素上，时钟才知道要不要淡", () => {
  const { el } = build();
  const c02 = el.querySelector('[data-clip="c02"]');
  assert.equal(c02.getAttribute("data-transition-in"), "dissolve");
  assert.equal(c02.getAttribute("data-transition-dur"), "0.5");
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

console.log(String.fromCharCode(10) + passed + " passed");
