// geml-media/v1 的歌单组件：同一条时间线，按主轨的文档顺序逐首播放。
import { parse } from "../../../geml-parser/dist/geml.js";
import { playlist, drivePlaylist } from "../src/media-playlist.js";
import { MEDIA_COMPONENTS } from "../src/media.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const MIX = `=== meta
profile = "geml-media/v1"
===

==== media {#mix tracks="music:audio notes:prose"}

=== media-clip {#t1 track=music src=lib.geml#night}
===

=== media-clip {#t2 track=music src=lib.geml#rain in=10 out=40}
===

=== media-clip {#n1 track=notes src=lib.geml#night over=#t1 duration=2}
===

=== media-clip {#t3 track=music src=lib.geml#dawn}
===

====
`;
// 一首写了说明（标题取它的第一行），两首没写（取文件名）；都不写 duration。
const LIB = `=== meta
profile = "geml-media/v1"
===

=== media-asset {#night src=music/01-night-train.mp3 kind=audio}
Night Train — The Quiet Hours
recorded live, 2025
===

=== media-asset {#rain src=music/02-rain.mp3 kind=audio}
===

=== media-asset {#dawn src=music/03-dawn.ogg kind=audio}
===
`;
const PAGE = "https://site.test/radio/index.geml";

function build(mix = MIX, lib = LIB, docUrl = PAGE, params = {}) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const corpus = [{ path: "mix.geml", doc: parse(mix) }, { path: "lib.geml", doc: parse(lib) }];
  return { el: playlist(null, params, { dom: document, corpus, docUrl }), document };
}

const titles = (el) => [...el.querySelectorAll(".geml-playlist-item")].map((b) => b.textContent);

test("主轨上的片段按文档顺序成一份歌单；别的轨不进来，也不需要 duration", () => {
  const { el } = build();
  assert.deepEqual([...el.querySelectorAll("li")].map((li) => li.getAttribute("data-clip")), ["t1", "t2", "t3"]);
  assert.deepEqual(titles(el), ["Night Train — The Quiet Hours", "02-rain", "03-dawn"]);
  assert.equal(el.querySelectorAll("audio").length, 1, "一个媒体元素，换首换 src");
  assert.equal(el.querySelector("audio").getAttribute("preload"), "none");
  assert.equal(el.querySelector('[data-clip="t1"]').getAttribute("data-src"), "https://site.test/radio/music/01-night-train.mp3");
  const t2 = el.querySelector('[data-clip="t2"]');
  assert.deepEqual([t2.getAttribute("data-in"), t2.getAttribute("data-out")], ["10", "40"]);
});

test("component=playlist 注册在媒体组件里，和 player 并列", () => {
  assert.equal(typeof MEDIA_COMPONENTS.playlist, "function");
  assert.equal(typeof MEDIA_COMPONENTS.player, "function");
});

test("素材过同一道同源闸：别处的、带 scheme 的、含反斜杠的不进歌单", () => {
  const lib = LIB.replace("src=music/02-rain.mp3", "src=https://evil.test/rain.mp3").replace("src=music/03-dawn.ogg", 'src="..\\\\dawn.ogg"');
  assert.deepEqual(titles(build(MIX, lib).el), ["Night Train — The Quiet Hours"]);
});

test("没有可播的曲目，就说没有", () => {
  const { el } = build('=== meta\nprofile = "geml-media/v1"\n===\n\n==== media {#mix tracks="notes:prose"}\n\n=== media-clip {#n track=notes src=lib.geml#night duration=1}\n===\n\n====\n');
  assert.match(el.className, /geml-playlist-empty/);
  assert.match(el.textContent, /没有可播的曲目/);
});

function driven(params = {}, random) {
  const { el, document } = build(MIX, LIB, PAGE, params);
  const media = el.querySelector("audio");
  const played = [];
  // 像浏览器那样：play() 之后元素发一个 play 事件。
  media.play = () => { played.push(media.getAttribute("src")); media.dispatchEvent(new document.defaultView.Event("play")); return Promise.resolve(); };
  media.paused = false;
  media.pause = () => { media.paused = true; };
  drivePlaylist(el, random);
  const fire = (target, type) => target.dispatchEvent(new document.defaultView.Event(type));
  const current = () => el.querySelector('li[aria-current="true"]')?.getAttribute("data-clip");
  return { el, media, played, fire, current };
}

// 可复现的随机源（线性同余），只给测试用。
const seeded = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

test("打开时选上第一首、什么也不取；点哪首放哪首", () => {
  const { el, media, played, fire, current } = driven();
  assert.equal(current(), "t1");
  assert.equal(media.getAttribute("preload"), "none");
  assert.deepEqual(played, []);
  fire(el.querySelectorAll(".geml-playlist-item")[2], "click");
  assert.equal(current(), "t3");
  assert.deepEqual(played, ["https://site.test/radio/music/03-dawn.ogg"]);
});

test("放完接下一首，最后一首放完就停；上一首、下一首", () => {
  const { el, media, played, fire, current } = driven();
  fire(media, "ended");
  assert.equal(current(), "t2");
  fire(el.querySelector(".geml-next"), "click");
  assert.equal(current(), "t3");
  fire(media, "ended");
  assert.equal(current(), "t3", "最后一首放完不绕回");
  fire(el.querySelector(".geml-prev"), "click");
  assert.equal(current(), "t2");
  assert.equal(played.length, 3);
});

test("片段的 out 到了就接下一首；最后一首到了 out 就停", () => {
  const { el, media, fire, current } = driven();
  fire(el.querySelectorAll(".geml-playlist-item")[1], "click");
  media.currentTime = 39;
  fire(media, "timeupdate");
  assert.equal(current(), "t2");
  media.currentTime = 40;
  fire(media, "timeupdate");
  assert.equal(current(), "t3");

  const last = build(MIX.replace("src=lib.geml#dawn}", "src=lib.geml#dawn in=5 out=9}"));
  const m = last.el.querySelector("audio");
  let paused = 0;
  m.play = () => Promise.resolve();
  m.pause = () => { paused++; };
  drivePlaylist(last.el);
  last.el.querySelectorAll(".geml-playlist-item")[2].dispatchEvent(new last.document.defaultView.Event("click"));
  m.currentTime = 9;
  m.dispatchEvent(new last.document.defaultView.Event("timeupdate"));
  assert.equal(paused, 1);
});

test("drivePlaylist 只接一次", () => {
  const { el, played, fire, current } = driven();
  drivePlaylist(el);
  fire(el.querySelector(".geml-next"), "click");
  assert.equal(current(), "t2");
  assert.equal(played.length, 1, "第二次接线不会让一次点击跳两首");
});

test("随机与重复的初始状态来自样式表参数；不认识的值就是关", () => {
  const on = build(MIX, LIB, PAGE, { shuffle: "on", repeat: "one" }).el;
  assert.deepEqual([on.getAttribute("data-shuffle"), on.getAttribute("data-repeat")], ["on", "one"]);
  const odd = build(MIX, LIB, PAGE, { shuffle: "yes", repeat: "forever" }).el;
  assert.deepEqual([odd.getAttribute("data-shuffle"), odd.getAttribute("data-repeat")], ["off", "off"]);
  assert.ok(on.querySelector(".geml-shuffle") && on.querySelector(".geml-repeat"), "面板上有两个开关");
});

test("重复按钮：关 → 全部 → 单曲 → 关", () => {
  const { el, fire } = driven();
  const b = el.querySelector(".geml-repeat");
  const seen = [];
  for (let k = 0; k < 4; k++) {
    seen.push([b.getAttribute("data-mode"), b.getAttribute("aria-pressed"), b.getAttribute("aria-label")]);
    fire(b, "click");
  }
  assert.deepEqual(seen, [["off", "false", "不重复"], ["all", "true", "全部重复"], ["one", "true", "单曲重复"], ["off", "false", "不重复"]]);
});

test("全部重复：最后一首放完绕回第一首，第一首上按上一首到最后一首", () => {
  const { el, media, fire, current } = driven({ repeat: "all" });
  fire(el.querySelectorAll(".geml-playlist-item")[2], "click");
  fire(media, "ended");
  assert.equal(current(), "t1");
  fire(el.querySelector(".geml-prev"), "click");
  assert.equal(current(), "t3");
});

test("单曲重复：放完从这一段的入点再放，不换首；手按下一首照样换", () => {
  const { el, media, played, fire, current } = driven({ repeat: "one" });
  fire(el.querySelectorAll(".geml-playlist-item")[1], "click");
  media.currentTime = 40;
  fire(media, "timeupdate");
  assert.equal(current(), "t2");
  assert.equal(media.currentTime, 10, "回到 in=10");
  assert.equal(played.length, 2);
  fire(el.querySelector(".geml-next"), "click");
  assert.equal(current(), "t3");
});

test("随机：每首正好放一次，放完最后一首就停", () => {
  const { el, media, fire, current } = driven({ shuffle: "on" }, seeded(7));
  fire(media, "play");   // 第一首是听的人在控件上按的播放
  const seen = [current()];
  for (let k = 0; k < 2; k++) { fire(media, "ended"); seen.push(current()); }
  assert.deepEqual([...seen].sort(), ["t1", "t2", "t3"]);
  fire(media, "ended");
  assert.equal(current(), seen[2], "不重复就停在最后一首");
  assert.equal(media.paused, true);
  // 种子定了，顺序就定了：同一个种子再来一次是同一份。
  const again = driven({ shuffle: "on" }, seeded(7));
  again.fire(again.media, "play");
  const order = [again.current()];
  for (let k = 0; k < 2; k++) { again.fire(again.media, "ended"); order.push(again.current()); }
  assert.deepEqual(order, seen);
});

test("打开随机时当前这首排第一；关掉随机，下一首回到文档顺序", () => {
  const { el, fire, current } = driven({}, seeded(3));
  fire(el.querySelectorAll(".geml-playlist-item")[1], "click");
  fire(el.querySelector(".geml-shuffle"), "click");
  assert.equal(el.querySelector(".geml-shuffle").getAttribute("aria-pressed"), "true");
  assert.equal(current(), "t2");
  fire(el.querySelector(".geml-shuffle"), "click");
  fire(el.querySelector(".geml-next"), "click");
  assert.equal(current(), "t3");
});

test("手按的上一首/下一首不看重复：一直能点，到了头就绕回去", () => {
  const { el, played, fire, current } = driven();
  const seq = [];
  for (let k = 0; k < 5; k++) { fire(el.querySelector(".geml-next"), "click"); seq.push(current()); }
  assert.deepEqual(seq, ["t2", "t3", "t1", "t2", "t3"]);
  const back = [];
  for (let k = 0; k < 4; k++) { fire(el.querySelector(".geml-prev"), "click"); back.push(current()); }
  assert.deepEqual(back, ["t2", "t1", "t3", "t2"]);
  assert.equal(played.length, 9, "每一下都换首并开播");
});

test("随机时连点下一首也不会卡住：每一下都换一首，所有曲目都轮得到", () => {
  const { el, fire, current } = driven({ shuffle: "on" }, seeded(11));
  const seen = new Set([current()]);
  let last = current();
  for (let k = 0; k < 12; k++) {
    fire(el.querySelector(".geml-next"), "click");
    assert.notEqual(current(), last, `click ${k + 1}`);
    last = current();
    seen.add(last);
  }
  assert.equal(seen.size, 3);
});

test("点得快了，入点跳的也是当时选着的那一首", () => {
  const { el, media, fire, current } = driven();
  fire(el.querySelectorAll(".geml-playlist-item")[1], "click");   // t2: in=10
  fire(el.querySelectorAll(".geml-playlist-item")[2], "click");   // 元数据还没到就换成 t3
  media.currentTime = 0;
  fire(media, "loadedmetadata");
  assert.equal(current(), "t3");
  assert.equal(media.currentTime, 0, "t3 没有入点，不能跳到 t2 的 10 秒");
  fire(el.querySelectorAll(".geml-playlist-item")[1], "click");
  fire(media, "loadedmetadata");
  assert.equal(media.currentTime, 10);
});

test("随机时手按到了顺序的哪里，放完也接这一轮还没放过的，全放过了才停", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { el, media, fire, current } = driven({ shuffle: "on" }, seeded(seed));
    fire(media, "play");
    const seen = new Set([current()]);               // 先放的那首也算放过了
    fire(el.querySelector(".geml-prev"), "click");   // 绕到这份顺序的最后一首
    for (let k = 0; k < 5; k++) {
      seen.add(current());
      if (media.paused) break;
      fire(media, "ended");
    }
    assert.equal(seen.size, 3, `seed ${seed}: ${[...seen]}`);
    assert.equal(media.paused, true, `seed ${seed}: 每首都放过了就停`);
  }
});

test("随机时点了哪一首，就从它起重新洗：其余的每首还会放到", () => {
  for (let seed = 1; seed <= 20; seed++) {
    for (let pick = 0; pick < 3; pick++) {
      const { el, media, fire, current } = driven({ shuffle: "on" }, seeded(seed));
      fire(el.querySelectorAll(".geml-playlist-item")[pick], "click");
      const seen = new Set([current()]);
      fire(media, "ended");
      seen.add(current());
      fire(media, "ended");
      seen.add(current());
      assert.equal(seen.size, 3, `seed ${seed}, picked track ${pick + 1}: ${[...seen]}`);
    }
  }
});

test("随机 + 全部重复：新一轮重洗，第一首不是刚放完的那首", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { media, fire, current } = driven({ shuffle: "on", repeat: "all" }, seeded(seed));
    fire(media, "play");
    fire(media, "ended");
    fire(media, "ended");
    const last = current();
    fire(media, "ended");
    assert.notEqual(current(), last, `seed ${seed}`);
  }
});

test("放完停下之后再按播放：从头再放一遍；随机就洗新的一轮", () => {
  const OUT = MIX.replace("src=lib.geml#dawn}", "src=lib.geml#dawn in=5 out=9}");
  for (const shuffle of ["off", "on"]) {
    const { el, document } = build(OUT, LIB, PAGE, { shuffle });
    const media = el.querySelector("audio");
    const fire = (t, type) => t.dispatchEvent(new document.defaultView.Event(type));
    media.play = () => { media.paused = false; fire(media, "play"); return Promise.resolve(); };
    media.pause = () => { media.paused = true; };
    drivePlaylist(el, seeded(5));
    const current = () => el.querySelector('li[aria-current="true"]').getAttribute("data-clip");
    // 放到底：点第三首，到 out 停下；随机的话一路放完。
    if (shuffle === "off") fire(el.querySelectorAll(".geml-playlist-item")[2], "click");
    else fire(media, "play");
    for (let k = 0; k < 6 && !media.paused; k++) {
      media.currentTime = current() === "t3" ? 9 : 0;
      fire(media, current() === "t3" ? "timeupdate" : "ended");
    }
    assert.equal(media.paused, true, `${shuffle}: 放完停下了`);
    const last = current();
    media.currentTime = 9;
    media.paused = false;
    fire(media, "play");                      // 听的人在控件上按了播放
    if (shuffle === "off") assert.equal(current(), "t1", "不随机：从第一首再来");
    else assert.notEqual(current(), last, "随机：新的一轮，不从刚放完的那首起");
    assert.equal(media.paused, false, `${shuffle}: 在放`);
  }
});

test("播放位置已经过了这一段的 out，按播放就从这一段的入点放", () => {
  const { el, media, fire, current } = driven();
  fire(el.querySelectorAll(".geml-playlist-item")[1], "click");   // t2: in=10 out=40
  media.currentTime = 55;
  fire(media, "play");
  assert.equal(current(), "t2");
  assert.equal(media.currentTime, 10);
});

test("随机 + 全部重复：每一轮四首各放一遍，一轮接一轮，交界处不重复", () => {
  const MIX4 = MIX.replace("====\n", "=== media-clip {#t4 track=music src=lib.geml#harbor}\n===\n\n====\n");
  const LIB4 = LIB + "\n=== media-asset {#harbor src=music/04-harbor.ogg kind=audio}\n===\n";
  for (let seed = 1; seed <= 30; seed++) {
    const { el, document } = build(MIX4, LIB4, PAGE, { shuffle: "on", repeat: "all" });
    const media = el.querySelector("audio");
    const fire = (t, type) => t.dispatchEvent(new document.defaultView.Event(type));
    media.play = () => { media.paused = false; fire(media, "play"); return Promise.resolve(); };
    media.pause = () => { media.paused = true; };
    drivePlaylist(el, seeded(seed));
    const current = () => el.querySelector('li[aria-current="true"]').getAttribute("data-clip");
    fire(media, "play");
    const seq = [current()];
    for (let k = 1; k < 20; k++) { fire(media, "ended"); seq.push(current()); }
    assert.equal(media.paused, false, `seed ${seed}: 全部重复不停`);
    for (let r = 0; r < 5; r++) {
      assert.deepEqual([...seq.slice(r * 4, r * 4 + 4)].sort(), ["t1", "t2", "t3", "t4"], `seed ${seed} 第 ${r + 1} 轮: ${seq.join(" ")}`);
      if (r > 0) assert.notEqual(seq[r * 4], seq[r * 4 - 1], `seed ${seed}: 第 ${r + 1} 轮开头重复了上一轮的末尾`);
    }
  }
});

// 四首、随机、各种按法混着来：手按的上一首/下一首每一下都换首；下一首接着上一首
// 回到原处；放完自动停下的时候，打开随机以来四首都放过了。
test("随机，四首，随便怎么按：一直能点，退得回去，停下时每首都放过", () => {
  const MIX4 = MIX.replace("====\n", "=== media-clip {#t4 track=music src=lib.geml#harbor}\n===\n\n====\n");
  const LIB4 = LIB + "\n=== media-asset {#harbor src=music/04-harbor.ogg kind=audio}\n===\n";
  for (let seed = 1; seed <= 50; seed++) {
    const r = seeded(seed);
    const { el, document } = build(MIX4, LIB4, PAGE, { shuffle: "on" });
    const media = el.querySelector("audio");
    const fire = (t, type) => t.dispatchEvent(new document.defaultView.Event(type));
    media.play = () => { media.paused = false; fire(media, "play"); return Promise.resolve(); };
    media.pause = () => { media.paused = true; };
    drivePlaylist(el, seeded(seed * 7919));
    const current = () => el.querySelector('li[aria-current="true"]').getAttribute("data-clip");
    const heard = new Set();
    media.addEventListener("play", () => heard.add(current()));
    fire(media, "play");
    let lastOp = null, before = null;
    for (let k = 0; k < 30; k++) {
      const op = Math.floor(r() * 4);
      const was = current();
      if (op === 0) fire(el.querySelector(".geml-next"), "click");
      else if (op === 1) fire(el.querySelector(".geml-prev"), "click");
      else if (op === 2) fire(el.querySelectorAll(".geml-playlist-item")[Math.floor(r() * 4)], "click");
      else { media.paused = false; fire(media, "ended"); }
      const now = current();
      if (op <= 1) assert.notEqual(now, was, `seed ${seed} op ${k}: ${op ? "上一首" : "下一首"} 没换首`);
      if (op === 1 && lastOp === 0) assert.equal(now, before, `seed ${seed} op ${k}: 下一首之后的上一首没回到原处`);
      if (op === 3 && media.paused) assert.equal(heard.size, 4, `seed ${seed} op ${k}: 停下时只放过 ${[...heard]}`);
      lastOp = op; before = was;
    }
  }
});

console.log(`\n${passed} test(s) passed.`);
