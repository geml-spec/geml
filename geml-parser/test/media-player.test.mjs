// 播放器时钟（`src/media-player-runtime.ts`）。它住在解析器里是因为时间是解析器算的，
// 而它跑在浏览器里 —— 所以这一套测试给它一个**假 DOM 和假时钟**，像 cov-render 给
// code-graph 运行时的那套一样。
//
// 三个宿主共用这份源码：viewer 的组件直接调、`geml media export --to player` 把源码
// 原样内联、演示页的生成脚本走后者。内联那条路意味着它不能引用模块作用域里的任何东西，
// 所以这里**只 import 这一个函数**，不给它任何别的依赖。
//
// 覆盖的是它真正会错的地方：元素时间漂了要不要拽回来、转场的不透明度、增益和淡入淡出
// 怎么叠、字幕跟不跟得上、进度条有焦点时不能被抢、以及自动播放解锁那一趟。
import { drivePlayer } from "../dist/media-player-runtime.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

// --- 假时钟 ---------------------------------------------------------------
// 运行时用 setInterval + performance.now() 的差值报时（rAF 在后台标签页停摆，而
// <video> 照放，那是第一版真踩过的坑）。两样都换成受控的。
const prevPerf = globalThis.performance, prevSet = globalThis.setInterval, prevClear = globalThis.clearInterval;
let nowMs = 0;
let timers = [];
function installClock() {
  nowMs = 0;
  timers = [];
  globalThis.performance = { now: () => nowMs };
  globalThis.setInterval = (fn) => { timers.push(fn); return timers.length; };
  globalThis.clearInterval = (id) => { if (id) timers[id - 1] = null; };
}
function restoreClock() {
  globalThis.performance = prevPerf; globalThis.setInterval = prevSet; globalThis.clearInterval = prevClear;
}
/** 推进假时钟并让所有活着的 interval 各跑一拍。 */
const advance = (ms) => { nowMs += ms; for (const f of timers.slice()) if (f) f(); };
const liveTimers = () => timers.filter(Boolean).length;

// --- 假元素 ---------------------------------------------------------------
// `play()` 的返回值是有讲究的：运行时对 thenable 和非 thenable 走两条不同的路
// （解锁那一趟要挂 .then，paint 里只挂 .catch），所以它是每个元素自己的旋钮。
const syncThenable = () => {
  const o = { then(cb) { cb(); return o; }, catch() { return o; } };
  return o;
};

function layer(attrs, opts = {}) {
  const el = {
    attrs: { ...attrs },
    style: {},
    currentTime: 0,
    volume: 1,
    muted: !!opts.muted,
    paused: true,
    playCalls: 0,
    pauseCalls: 0,
    play() { this.playCalls++; this.paused = false; return opts.thenable ? syncThenable() : undefined; },
    pause() { this.pauseCalls++; this.paused = true; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
  };
  if (opts.timeThrows) {
    let held = 0;
    Object.defineProperty(el, "currentTime", {
      get() { return held; },
      // loadedmetadata 之前浏览器真的会抛；运行时把它吞掉，画面等下一拍。
      set() { throw new Error("no metadata yet"); },
      configurable: true,
    });
    Object.defineProperty(el, "_held", { get: () => held, set: (v) => { held = v; }, configurable: true });
  }
  return el;
}

function control() {
  return {
    attrs: {}, style: {}, value: "", textContent: "", listeners: {},
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(t, f) { this.listeners[t] = f; },
  };
}

function mkRoot({ duration = 10, captions, layers = [], cap = null, btn = null, seek = null, clock = null } = {}) {
  const attrs = { "data-duration": String(duration) };
  if (captions !== undefined) attrs["data-captions"] = captions;
  return {
    attrs, listeners: {}, layers, cap, btn, seek, clock,
    ownerDocument: { activeElement: null },
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(t, f) { this.listeners[t] = f; },
    querySelectorAll(sel) { return sel === ".geml-layer" ? this.layers : []; },
    querySelector(sel) {
      if (sel === ".geml-caption") return this.cap;
      if (sel === ".geml-play") return this.btn;
      if (sel === ".geml-seek") return this.seek;
      if (sel === ".geml-clock") return this.clock;
      return null;
    },
  };
}

/** 一个有两刀、字幕和全套控件的常规文档。 */
function standard(opts = {}) {
  const a = layer({ "data-start": "0", "data-end": "4", "data-in": "0" }, opts.a);
  const b = layer({
    "data-start": "4", "data-end": "10", "data-in": "2",
    "data-transition-in": "dissolve", "data-transition-out": "fade", "data-transition-duration": "1",
  }, opts.b);
  const cap = control(), btn = control(), seek = control(), clock = control();
  const root = mkRoot({
    duration: 10,
    captions: JSON.stringify([{ start: 0, end: 2, text: "hello" }, { start: 5, end: 6, text: "world" }]),
    layers: [a, b], cap, btn, seek, clock,
  });
  return { root, a, b, cap, btn, seek, clock };
}

/** 把时间挪到 `to`：运行时只通过进度条暴露这个能力。 */
const seekTo = (d, to) => { d.seek.value = String(to); d.seek.listeners.input(); };

// ---------------------------------------------------------------------------

test("第一拍就把每一刀摆好：当期的可见并对时，其余隐藏", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    assert.equal(d.a.style.visibility, "visible", "t=0 落在第一刀里");
    assert.equal(d.a.style.opacity, "1");
    assert.equal(d.b.style.visibility, "hidden", "第二刀还没到");
    assert.equal(d.clock.textContent, "0:00.0 / 0:10.0");
    assert.equal(d.seek.value, "0");
    assert.equal(d.cap.textContent, "hello", "第一条字幕当期");
    assert.equal(d.cap.style.visibility, "visible");
    // 没在播，谁都不该被 play()
    assert.equal(d.a.playCalls, 0);
    assert.equal(d.b.playCalls, 0);
    // 运行时给容器上键盘焦点，空格才接得住
    assert.equal(d.root.getAttribute("tabindex"), "0");
  } finally { restoreClock(); }
});

test("已经驱动过的容器不会被驱动第二次", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    const first = d.root.listeners.keydown;
    d.cap.textContent = "改过了";
    drivePlayer(d.root); // 第二次应当原地返回，不重绘也不重挂
    assert.equal(d.cap.textContent, "改过了", "没有重绘");
    assert.equal(d.root.listeners.keydown, first, "没有重挂监听");
  } finally { restoreClock(); }
});

test("元素时间漂出容差才拽回来，漂在容差内不动它", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    // 第二刀 in=2，t=5 时应当在 2 + (5-4) = 3
    d.b.currentTime = 0;
    seekTo(d, 5);
    assert.equal(d.b.currentTime, 3, "漂了 3 秒，拽回去");
    // 已经对上了就别碰：把它挪到容差内，再绘一次仍是原值
    d.b.currentTime = 3.1;
    seekTo(d, 5);
    assert.equal(d.b.currentTime, 3.1, "0.1 秒在容差内，不动");
  } finally { restoreClock(); }
});

test("loadedmetadata 之前写 currentTime 会抛，这一拍照常画完", () => {
  installClock();
  try {
    // data-in=5 让目标时间和元素当前时间差出容差，写才会真的发生 —— 不然抛不出来。
    const a = layer({ "data-start": "0", "data-end": "4", "data-in": "5" }, { timeThrows: true });
    const clock = control(), seek = control();
    const root = mkRoot({ duration: 4, layers: [a], clock, seek });
    drivePlayer(root); // 抛在 try 里，不该冒出来
    assert.equal(a.style.visibility, "visible");
    assert.equal(clock.textContent, "0:00.0 / 0:04.0", "时钟照走");
  } finally { restoreClock(); }
});

test("淡入淡出按转场时长斜坡，cut 不碰不透明度", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    seekTo(d, 4.25);            // 进第二刀 0.25 秒，dissolve 时长 1
    assert.equal(d.b.style.opacity, "0.25");
    seekTo(d, 9.5);             // 距离结束 0.5 秒，fade 出
    assert.equal(d.b.style.opacity, "0.5");
    seekTo(d, 6);               // 中段，两头都够不着
    assert.equal(d.b.style.opacity, "1");
    // 第一刀没写转场：整段都是 1
    seekTo(d, 0.1);
    assert.equal(d.a.style.opacity, "1", "cut 不动不透明度");
  } finally { restoreClock(); }
});

test("增益与淡入淡出相乘落到 volume 上，静音的那刀不碰", () => {
  installClock();
  try {
    const a = layer({ "data-start": "0", "data-end": "10", "data-in": "0", "data-gain": "0.5", "data-fade-in": "2", "data-fade-out": "2" });
    const m = layer({ "data-start": "0", "data-end": "10", "data-in": "0", "data-gain": "0.5" }, { muted: true });
    const seek = control();
    const root = mkRoot({ duration: 10, layers: [a, m], seek });
    drivePlayer(root);
    const to = (v) => { seek.value = String(v); seek.listeners.input(); };
    to(1);                       // 淡入过半：0.5 * (1/2)
    assert.equal(a.volume, 0.25);
    to(9);                       // 淡出过半：0.5 * (1/2)
    assert.equal(a.volume, 0.25);
    to(5);                       // 两头都够不着，只剩增益
    assert.equal(a.volume, 0.5);
    assert.equal(m.volume, 1, "静音的那刀 volume 一直没被写过");
  } finally { restoreClock(); }
});

test("字幕跟着时钟走，空档清空", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    assert.equal(d.cap.textContent, "hello");
    seekTo(d, 3);                 // 两条字幕之间
    assert.equal(d.cap.textContent, "");
    assert.equal(d.cap.style.visibility, "hidden");
    seekTo(d, 5.5);
    assert.equal(d.cap.textContent, "world");
    assert.equal(d.cap.style.visibility, "visible");
  } finally { restoreClock(); }
});

test("data-captions 是坏 JSON 就当没有字幕，不炸", () => {
  installClock();
  try {
    const cap = control(), seek = control();
    const a = layer({ "data-start": "0", "data-end": "4", "data-in": "0" });
    const root = mkRoot({ duration: 4, captions: "{not json", layers: [a], cap, seek });
    drivePlayer(root);
    assert.equal(cap.textContent, "");
    assert.equal(cap.style.visibility, "hidden");
  } finally { restoreClock(); }
});

test("进度条握着焦点时不被回写，松开焦点才跟随", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    d.root.ownerDocument.activeElement = d.seek;   // 用户正在拖
    d.seek.value = "7";
    d.seek.listeners.input();
    assert.equal(d.seek.value, "7", "拖动中的值没有被这一拍覆盖");
    assert.equal(d.clock.textContent, "0:07.0 / 0:10.0", "但时间确实走到了 7");
    d.root.ownerDocument.activeElement = null;     // 松手
    d.seek.value = "2";
    d.seek.listeners.input();
    assert.equal(d.seek.value, "2");
  } finally { restoreClock(); }
});

test("播起来时钟前进，走到片尾自动停住", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    d.btn.listeners.click();
    assert.equal(d.btn.textContent, "⏸", "按钮变成暂停");
    assert.equal(liveTimers(), 1, "起了一个时钟");
    advance(1000);
    assert.equal(d.clock.textContent, "0:01.0 / 0:10.0");
    advance(2000);
    assert.equal(d.clock.textContent, "0:03.0 / 0:10.0");
    assert.equal(d.a.playCalls > 0, true, "当期那刀在播");
    advance(60_000);            // 冲过片尾
    assert.equal(d.clock.textContent, "0:10.0 / 0:10.0", "停在总时长上，不越界");
    assert.equal(d.btn.textContent, "▶", "按钮回到播放");
    assert.equal(liveTimers(), 0, "时钟已经收掉");
    assert.equal(d.a.paused, true);
    assert.equal(d.b.paused, true);
  } finally { restoreClock(); }
});

test("停在片尾后再按播放，从头开始", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    d.btn.listeners.click();
    advance(60_000);
    assert.equal(d.clock.textContent, "0:10.0 / 0:10.0");
    d.btn.listeners.click();     // 片尾再按
    assert.equal(d.clock.textContent, "0:00.0 / 0:10.0", "回到开头");
  } finally { restoreClock(); }
});

test("第一次播放解锁每一刀，不当期的随即按回去", () => {
  installClock();
  try {
    // a 的 play() 返回 thenable（解锁回调那条路），b 的返回 undefined（另一条）
    const d = standard({ a: { thenable: true }, b: { thenable: false } });
    drivePlayer(d.root);
    d.btn.listeners.click();
    assert.equal(d.a.playCalls >= 1, true, "当期的被解锁并留在播放");
    assert.equal(d.b.playCalls >= 1, true, "不当期的也要先播一下才解得开");
    assert.equal(d.b.paused, true, "解锁后立刻按回去，它还没到");
    assert.equal(d.b.style.visibility, "hidden");
    const unlockCalls = d.b.playCalls;
    // 第二次播放不再解锁：暂停再播，不当期的那刀不该又被 play 一遍
    d.btn.listeners.click();
    d.btn.listeners.click();
    assert.equal(d.b.playCalls, unlockCalls, "解锁只做一次");
  } finally { restoreClock(); }
});

test("暂停时当期那刀被按停，切走的那刀也被按停", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    d.btn.listeners.click();
    advance(1000);
    assert.equal(d.a.paused, false, "播着");
    d.btn.listeners.click();     // 暂停
    assert.equal(d.a.paused, true);
    assert.equal(d.btn.textContent, "▶");
    assert.equal(liveTimers(), 0);
    // 当期但没在播：元素自己跑起来了也要被按回去
    d.a.paused = false;
    seekTo(d, 1);
    assert.equal(d.a.paused, true, "当期却在停止态下自己播的那刀被按回去");
    // 切到第二刀的区间：第一刀已经不当期，必须停
    d.a.paused = false;
    seekTo(d, 6);
    assert.equal(d.a.paused, true, "不当期的那刀被按停");
  } finally { restoreClock(); }
});

test("空格和 k 切换播放，别的键不管", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    let prevented = 0;
    const key = (k) => d.root.listeners.keydown({ key: k, preventDefault() { prevented++; } });
    key(" ");
    assert.equal(d.btn.textContent, "⏸", "空格起播");
    key("k");
    assert.equal(d.btn.textContent, "▶", "k 暂停");
    assert.equal(prevented, 2, "两次都拦掉了页面滚动");
    key("j");
    assert.equal(d.btn.textContent, "▶", "别的键不动它");
    assert.equal(prevented, 2);
  } finally { restoreClock(); }
});

// 解锁那一趟对 `play()` 的返回值分两条路走：thenable 的挂回调，非 thenable 的就地判断。
// 两条路各自都要再分「这刀当期吗」，所以这里摆三刀把四种组合凑齐。
test("解锁对 thenable 和非 thenable 一视同仁，不当期的都按回去", () => {
  installClock();
  try {
    const vis = layer({ "data-start": "0", "data-end": "5", "data-in": "0" }, { thenable: false });
    const hidThen = layer({ "data-start": "5", "data-end": "10", "data-in": "0" }, { thenable: true });
    const hidPlain = layer({ "data-start": "5", "data-end": "10", "data-in": "0" }, { thenable: false });
    const btn = control();
    const root = mkRoot({ duration: 10, layers: [vis, hidThen, hidPlain], btn });
    drivePlayer(root);
    btn.listeners.click();
    assert.equal(vis.paused, false, "当期那刀留在播放");
    assert.equal(hidThen.paused, true, "thenable 的那刀在回调里被按回去");
    assert.equal(hidPlain.paused, true, "非 thenable 的那刀就地被按回去");
  } finally { restoreClock(); }
});

test("停住之后还在路上的那一拍什么都不做", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    d.btn.listeners.click();
    const beat = timers.find(Boolean);   // 拿住这一根时钟
    advance(1000);
    d.btn.listeners.click();             // 停住，clearInterval
    const before = d.clock.textContent;
    beat();                              // 已经在路上的那一拍
    assert.equal(d.clock.textContent, before, "停住后的一拍不推进时间");
  } finally { restoreClock(); }
});

test("进度条给出不是数字的值就当 0", () => {
  installClock();
  try {
    const d = standard();
    drivePlayer(d.root);
    seekTo(d, 6);
    assert.equal(d.clock.textContent, "0:06.0 / 0:10.0");
    d.seek.value = "拖过头了";
    d.seek.listeners.input();
    assert.equal(d.clock.textContent, "0:00.0 / 0:10.0", "读不出数就回到 0");
  } finally { restoreClock(); }
});

test("没有任何控件的容器也能驱动：只摆画面", () => {
  installClock();
  try {
    const a = layer({ "data-start": "0", "data-end": "4", "data-in": "0" });
    const root = mkRoot({ duration: 4, layers: [a] });   // 无 cap / btn / seek / clock
    drivePlayer(root);
    assert.equal(a.style.visibility, "visible");
    assert.equal(root.getAttribute("tabindex"), "0");
    // 键盘还是能起播：btn 不存在的分支也要走通
    root.listeners.keydown({ key: " ", preventDefault() {} });
    advance(500);
    assert.equal(a.playCalls > 0, true);
  } finally { restoreClock(); }
});

test("没有 data-duration 就是 0 秒：起播立刻收在 0", () => {
  installClock();
  try {
    const btn = control(), clock = control();
    const a = layer({ "data-start": "0", "data-end": "0", "data-in": "0" });
    const root = mkRoot({ layers: [a], btn, clock });
    delete root.attrs["data-duration"];
    drivePlayer(root);
    assert.equal(clock.textContent, "0:00.0 / 0:00.0");
    btn.listeners.click();
    advance(100);
    assert.equal(clock.textContent, "0:00.0 / 0:00.0");
    assert.equal(btn.textContent, "▶", "立刻停住");
  } finally { restoreClock(); }
});

test("属性不是数字就退回默认值", () => {
  installClock();
  try {
    // data-transition-duration 写坏 -> 退回 0.3；data-gain 写坏 -> 退回 1
    const a = layer({
      "data-start": "0", "data-end": "10", "data-in": "0",
      "data-transition-in": "fade", "data-transition-duration": "ever-so-long", "data-gain": "loud",
    });
    const seek = control();
    const root = mkRoot({ duration: 10, layers: [a], seek });
    drivePlayer(root);
    seek.value = "0.15"; seek.listeners.input();   // 默认 0.3 的一半
    assert.equal(a.style.opacity, "0.5");
    assert.equal(a.volume, 1, "增益退回 1");
  } finally { restoreClock(); }
});

console.log(`\n${passed} test(s) passed.`);
