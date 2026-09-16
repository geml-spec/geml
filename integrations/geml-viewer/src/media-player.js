// geml-media/v1 的第四个组件契约：**播放器**。
//
// 为什么不是格式的事：一份时间线已经把"谁、从第几秒起、放多久"说全了，layoutDoc 也
// 已经把它算成了每个片段的绝对起点与时长 —— 和 `geml media build` 出片用的是同一份
// 结果。所以浏览器里缺的不是信息，是一个**按那份结果驱动真 <video>/<audio> 的时钟**。
// src 不需要多值（一个片段本来就只指一个源），也不需要另造一种文件。
//
// 分工与 timeline-track 一样：这里只出结构与行为，颜色尺寸归样式表。
import { layoutDoc } from "../../../geml-parser/dist/media-timeline.js";

const dirOf = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };

/** `a/b` + `../c/d.mp4` → `a/c/d.mp4`。语料里的 path 相对根，拼出来的也相对根。 */
function joinRel(dir, rel) {
  const out = [];
  for (const s of (dir ? dir.split("/") : []).concat(String(rel).split("/"))) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop(); else out.push(s);
  }
  return out.join("/");
}

function blockById(doc, id) {
  let found = null;
  (function walk(bs) {
    for (const b of bs || []) {
      if (found) return;
      if (b.kind === "block" && b.id === id) { found = b; return; }
      if (b.kind === "block" && b.children) walk(b.children);
    }
  })(doc && doc.children);
  return found;
}

/**
 * `lib.geml#s01-take3` → 语料里的那个块，连同它所在文档的路径。
 * 先按文档名对，对不上再全局找 id —— 跨文档引用写的是相对路径，语料里的是相对根的。
 */
function findRef(entries, ref) {
  const i = String(ref).indexOf("#");
  const id = i < 0 ? String(ref) : String(ref).slice(i + 1);
  const docPart = i < 0 ? "" : String(ref).slice(0, i).replace(/^(?:\.\.?\/)+/, "");
  if (docPart) {
    for (const e of entries) {
      if (!e.path || !e.path.endsWith(docPart)) continue;
      const b = blockById(e.doc, id);
      if (b) return { block: b, path: e.path };
    }
  }
  for (const e of entries) {
    const b = blockById(e.doc, id);
    if (b) return { block: b, path: e.path || "" };
  }
  return null;
}

const dbToGain = (v) => {
  const m = /^(-?\d+(?:\.\d+)?)\s*dB$/i.exec(String(v == null ? "" : v).trim());
  return m === null ? 1 : Math.min(1, Math.pow(10, Number(m[1]) / 20));
};

function blockByType(doc, type) {
  for (const b of (doc && doc.children) || []) if (b.kind === "block" && b.type === type) return b;
  return null;
}

function metaOf(entries, key) {
  for (const e of entries) {
    const m = blockByType(e.doc, "meta");
    if (m && m.attrs && m.attrs[key] !== undefined) return m.attrs[key];
    if (m && m.data && m.data[key] !== undefined) return m.data[key];
  }
  return undefined;
}

/** 块的可读文字。散文块是若干段落，`raw` 体就是它的正文行 —— 两种都取字面。 */
function textOf(block, ctx) {
  const out = [];
  (function walk(nodes) {
    for (const n of nodes || []) {
      if (typeof n.text === "string") out.push(n.text);
      else if (Array.isArray(n.inlines)) for (const i of n.inlines) if (typeof i.value === "string") out.push(i.value);
      if (Array.isArray(n.children)) walk(n.children);
    }
  })(block && block.children);
  if (out.length === 0 && typeof block.body === "string") out.push(block.body);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function timelineOf(entries) {
  for (const e of entries) {
    const doc = e.doc;
    if (!doc || !doc.children) continue;
    const durationOf = (ref) => {
      const hit = findRef(entries, ref);
      const v = hit && hit.block.attrs ? Number(hit.block.attrs.duration) : NaN;
      return Number.isFinite(v) ? v : undefined;
    };
    const tl = layoutDoc(doc, { durationOf });
    if (tl.clips.length > 0) return tl;
  }
  return null;
}

function fmt(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return String(m) + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
}

/**
 * `component=player`：整条时间线的播放面。容器组件拿不到槽位里的块（传 null），
 * 但它不需要 —— 时间线和语料都在 ctx 里，它自己就能把一份成片搭出来。
 */
export function player(block, params, ctx) {
  const dom = ctx.dom;
  const entries = [];
  for (const e of ctx.corpus || []) entries.push(e && e.doc ? e : { path: "", doc: e });
  const timeline = timelineOf(entries);
  const el = dom.createElement("div");
  el.className = "geml-player";
  if (!timeline || timeline.duration <= 0) {
    el.className += " geml-player-empty";
    el.textContent = "这份文档里没有可播的时间线";
    return el;
  }
  el.setAttribute("data-duration", timeline.duration.toFixed(3));

  const stage = dom.createElement("div");
  stage.className = "geml-stage";
  const aspect = (params && params.aspect) || metaOf(entries, "aspect");
  if (typeof aspect === "string" && /^\d+:\d+$/.test(aspect)) stage.style.aspectRatio = aspect.replace(":", " / ");

  // 一个片段一个媒体元素。片段少的时候这最简单，也最诚实：每个 <video> 就是那一刀，
  // currentTime 由时钟按 in= 推，不靠浏览器自己往下播。
  const zOf = (name) => Math.max(0, timeline.tracks.findIndex((t) => t.name === name));
  const captions = [];
  for (const c of timeline.clips) {
    const hit = findRef(entries, c.src);
    if (c.kind === "prose") {
      captions.push({ start: c.start, end: c.start + c.duration, text: hit ? textOf(hit.block, ctx) : c.src });
      continue;
    }
    if (hit === null) continue;
    const file = hit.block.attrs ? hit.block.attrs.src : undefined;
    if (typeof file !== "string") continue;
    const media = dom.createElement(c.kind === "audio" ? "audio" : "video");
    media.className = "geml-layer geml-layer-" + c.kind;
    media.setAttribute("src", joinRel(dirOf(hit.path), file));
    media.setAttribute("preload", "auto");
    media.setAttribute("playsinline", "");
    media.setAttribute("data-clip", c.id);
    media.setAttribute("data-start", c.start.toFixed(3));
    media.setAttribute("data-end", (c.start + c.duration).toFixed(3));
    media.setAttribute("data-in", c.in.toFixed(3));
    media.setAttribute("data-gain", String(dbToGain(c.attrs["gain"])));
    if (c.kind === "video") {
      media.muted = true;                       // 声音走 dialogue/bgm 轨，画面轨不出声
      media.setAttribute("muted", "");
      media.style.zIndex = String(zOf(c.track));
    }
    for (const k of ["transition-in", "transition-out", "transition-dur", "fade-in", "fade-out", "xywh"]) {
      if (c.attrs[k] !== undefined) media.setAttribute("data-" + k, c.attrs[k]);
    }
    stage.appendChild(media);
  }
  const cap = dom.createElement("div");
  cap.className = "geml-caption";
  stage.appendChild(cap);
  el.appendChild(stage);

  // 字幕不一条一条摆进 DOM，摆进一个 data- 里由时钟挑 —— 一次只有一条在屏上。
  captions.sort((a, b) => a.start - b.start);
  el.setAttribute("data-captions", JSON.stringify(captions));

  const bar = dom.createElement("div");
  bar.className = "geml-transport";
  const btn = dom.createElement("button");
  btn.className = "geml-play";
  btn.type = "button";
  btn.setAttribute("aria-label", "播放/暂停");
  btn.textContent = "\u25B6";
  const seek = dom.createElement("input");
  seek.className = "geml-seek";
  seek.setAttribute("type", "range");
  seek.setAttribute("min", "0");
  seek.setAttribute("max", timeline.duration.toFixed(3));
  seek.setAttribute("step", "0.01");
  seek.setAttribute("value", "0");
  const clock = dom.createElement("span");
  clock.className = "geml-clock";
  clock.textContent = "0:00.0 / " + fmt(timeline.duration);
  bar.appendChild(btn);
  bar.appendChild(seek);
  bar.appendChild(clock);
  el.appendChild(bar);
  return el;
}

/**
 * 时钟。一个 rAF 循环推所有元素，没有哪个元素自己往下播 —— 浏览器和 ffmpeg 必须
 * 对同一条时间线负责，让 <video> 自由跑就会漂。
 *
 * 写成一个自足的函数（不引用模块作用域里的任何东西），因为导出的静态页把它的源码
 * 原样内联进 <script>；扩展里则直接调它。一份源码，两个宿主。
 */
export function drivePlayer(root) {
  if (!root || root.__gemlDriven) return;
  root.__gemlDriven = true;
  const total = Number(root.getAttribute("data-duration")) || 0;
  const layers = Array.prototype.slice.call(root.querySelectorAll(".geml-layer"));
  const cap = root.querySelector(".geml-caption");
  const btn = root.querySelector(".geml-play");
  const seek = root.querySelector(".geml-seek");
  const clock = root.querySelector(".geml-clock");
  let cues = [];
  try { cues = JSON.parse(root.getAttribute("data-captions") || "[]"); } catch (e) { cues = []; }

  let t = 0, playing = false, last = 0, unlocked = false, timer = 0;
  const fmt2 = (v) => {
    const m = Math.floor(v / 60), s = v - m * 60;
    return String(m) + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
  };
  const num = (el, name, dflt) => {
    const v = Number(el.getAttribute(name));
    return isFinite(v) ? v : dflt;
  };

  function paint() {
    for (const el of layers) {
      const start = num(el, "data-start", 0), end = num(el, "data-end", 0), inPt = num(el, "data-in", 0);
      if (t >= start && t < end) {
        const want = inPt + (t - start);
        if (Math.abs(el.currentTime - want) > 0.15) { try { el.currentTime = want; } catch (e) { /* 还没 loadedmetadata */ } }
        // 转场只有淡入淡出会动不透明度；cut 什么都不做。
        const td = num(el, "data-transition-dur", 0.3);
        const ti = el.getAttribute("data-transition-in"), to = el.getAttribute("data-transition-out");
        let o = 1;
        if ((ti === "dissolve" || ti === "fade") && t - start < td) o = (t - start) / td;
        if ((to === "dissolve" || to === "fade") && end - t < td) o = Math.min(o, (end - t) / td);
        let g = num(el, "data-gain", 1);
        const fi = num(el, "data-fade-in", 0), fo = num(el, "data-fade-out", 0);
        if (fi > 0 && t - start < fi) g *= (t - start) / fi;
        if (fo > 0 && end - t < fo) g *= (end - t) / fo;
        if (!el.muted) el.volume = Math.max(0, Math.min(1, g));
        el.style.opacity = String(Math.max(0, Math.min(1, o)));
        el.style.visibility = "visible";
        if (playing && el.paused) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
        if (!playing && !el.paused) el.pause();
      } else {
        el.style.visibility = "hidden";
        if (!el.paused) el.pause();
      }
    }
    if (cap) {
      let text = "";
      for (const c of cues) if (t >= c.start && t < c.end) { text = c.text; break; }
      if (cap.textContent !== text) cap.textContent = text;
      cap.style.visibility = text ? "visible" : "hidden";
    }
    if (seek && root.ownerDocument.activeElement !== seek) seek.value = String(t);
    if (clock) clock.textContent = fmt2(t) + " / " + fmt2(total);
  }

  function stop() {
    playing = false;
    if (timer !== 0) { clearInterval(timer); timer = 0; }
    if (btn) btn.textContent = "\u25B6";
    for (const el of layers) if (!el.paused) el.pause();
  }
  // 时钟走 setInterval 而不是 rAF：标签页切到后台时 rAF 完全停摆，而 <video> 照放不误
  // —— 实测第一版就是这样，时钟停在 0:00 而画面已经播到 5s。setInterval 在后台只是被
  // 节流到一秒一次，配合 performance.now() 的差值，时间依然是对的。
  function tick() {
    if (!playing) return;
    const now = performance.now();
    t += (now - last) / 1000;
    last = now;
    if (t >= total) { t = total; stop(); paint(); return; }
    paint();
  }
  function start() {
    if (t >= total) t = 0;
    playing = true;
    if (btn) btn.textContent = "\u23F8";
    last = performance.now();
    // 第一次播放要在用户手势里把每个元素解锁，否则后面才切进来的那些会被自动播放策略挡下。
    if (!unlocked) {
      unlocked = true;
      for (const el of layers) {
        const p = el.play();
        if (p && p.then) p.then(() => { if (el.style.visibility === "hidden") el.pause(); }).catch(() => {});
        else if (el.style.visibility === "hidden") el.pause();
      }
    }
    if (timer !== 0) clearInterval(timer);
    timer = setInterval(tick, 33);
    paint();
  }
  if (btn) btn.addEventListener("click", () => { if (playing) { stop(); paint(); } else start(); });
  if (seek) seek.addEventListener("input", () => { t = Number(seek.value) || 0; last = performance.now(); paint(); });
  root.setAttribute("tabindex", "0");
  root.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "k") { e.preventDefault(); if (playing) { stop(); paint(); } else start(); }
  });
  paint();
}

/** 自驱：组件建好就把时钟接上。静态导出没有 rAF，那条路由导出脚本内联 drivePlayer。 */
export function playerLive(block, params, ctx) {
  const el = player(block, params, ctx);
  if (typeof window !== "undefined") drivePlayer(el);
  return el;
}
