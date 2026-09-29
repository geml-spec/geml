// 场景公共件。**一切都是 t 的函数**：没有 CSS 动画、没有 transition、没有
// requestAnimationFrame —— 第 t 秒的画面只能由 t 决定，否则逐帧截图会漂，也没法测。
//
// 这个文件同时被浏览器（舞台页）与 node（测试）加载，所以模块顶层不许碰 DOM。
// 画面里不拼 HTML：文字一律 textContent，带颜色的行用 hl() 切词元、paint() 画。

export const W = 1920;
export const H = 1080;

export const C = {
  bg: "#0b0d12", panel: "#141821", line: "#2a3142", text: "#e8e6e3", dim: "#8a93a6",
  accent: "#4f8cff", ok: "#3ecf8e", warn: "#f5b83d", bad: "#ff5c5c", code: "#c9d1d9",
  key: "#79c0ff", str: "#a5d6ff", id: "#d2a8ff",
};

export const mono = '"SF Mono", "JetBrains Mono", Menlo, monospace';
export const sans = '"PingFang SC", "Helvetica Neue", sans-serif';

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, p) => a + (b - a) * p;
export const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** t 在 [a, b] 里走到了哪儿，缓动后的 0..1。 */
export const prog = (t, a, b, ease = easeInOut) => ease(clamp((t - a) / (b - a)));

/** 打字机：第 t 秒露出几个字。按码点切，汉字不会被劈成半个。 */
export const typed = (text, t, start, cps = 30) =>
  [...text].slice(0, Math.max(0, Math.floor((t - start) * cps + 1e-9))).join("");

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** 两个 #rrggbb 之间插值。 */
export const mix = (a, b, p) => {
  const A = rgb(a), B = rgb(b);
  return "#" + A.map((x, i) => Math.round(lerp(x, B[i], clamp(p))).toString(16).padStart(2, "0")).join("");
};

/**
 * 给一行 GEML 分词上色：[[文本, 颜色], …]，相邻同色合并。只为画面好看，不是解析器。
 * 词元拼回去恒等于原文。
 */
export function hl(line) {
  const toks = [];
  const push = (s, c) => {
    if (s === "") return;
    const last = toks[toks.length - 1];
    if (last !== undefined && last[1] === c) last[0] += s; else toks.push([s, c]);
  };
  const m = line.match(/^(={3,})(\s+)([\w-]*)(.*)$/);
  if (m === null) { push(line, C.code); return toks; }
  const [, fence, sp, type, rest] = m;
  push(fence, C.dim); push(sp, C.code); push(type, C.accent);
  for (const x of rest.matchAll(/#[\w-]+|([\w-]+)=("[^"]*"|[^\s}]+)|[\s\S]/g)) {
    if (x[0].startsWith("#")) push(x[0], C.id);
    else if (x[1] !== undefined) { push(x[1], C.key); push("=", C.code); push(x[2], C.str); }
    else push(x[0], C.code);
  }
  return toks;
}

/**
 * 改文字，但**没变就不碰**。给 textContent 赋一个相同的串也会换掉文字节点、让浏览器局部重画
 * 那一行；局部重画与整块重画在边缘像素的抗锯齿上差一点——于是同一个 t 截两次图会不一样。
 */
export function text(e, s) {
  if (e.textContent !== s) e.textContent = s;
}

/** 把词元画进一个元素：每个词元一个 span，文字走 textContent。词元没变就不碰（理由同 text）。 */
export function paint(e, toks) {
  const key = JSON.stringify(toks);
  if (e.__paintKey === key) return;
  e.__paintKey = key;
  e.replaceChildren(...toks.map(([s, c]) => {
    const sp = document.createElement("span");
    sp.style.color = c;
    sp.textContent = s;
    return sp;
  }));
}

/**
 * 按语言取文案：tr(lang, { zh: "…", en: "…" })。缺了就抛错——英文版里冒出一行中文标题，
 * 比渲染失败更糟：前者会一路混进成片。
 */
export function tr(lang, table) {
  const s = table[lang];
  if (s === undefined) throw new Error(`缺 ${lang} 文案：${JSON.stringify(table)}`);
  return s;
}

/** 素材库里一张图的 URL。舞台页在载入场景之前把 /_art.json 读进 window.__art。 */
export function art(id) {
  const src = globalThis.__art?.[id];
  if (src === undefined) throw new Error(`素材库里没有图片 #${id}：先跑 node tools/link-episode.mjs`);
  return `/${src}`;
}

/** 一份证据的全文。舞台页在第一次渲染前把场景 `uses` 里的 evidence-* 读进 window.__evidence。 */
export function evidence(id) {
  const s = globalThis.__evidence?.[id];
  if (s === undefined) throw new Error(`证据 #${id} 没有预载：把它写进场景的 uses，并先跑 node tools/capture-evidence.mjs`);
  return s;
}

/** 这一行是不是带 id 的那个块头或标题：`{#look}`、`{#look .x}` 算，`{#look-board}` 不算。 */
export const hasId = (line, id) => new RegExp(`\\{#${id}[\\s}]`).test(line);

/** 建一个元素。场景第一次 render 时建好全部 DOM，之后每帧只改样式。 */
export function el(tag, style = {}, text) {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 只建一次：同一个 root 上第二次调用直接拿缓存。 */
export function once(root, build) {
  if (root.__scene === undefined) root.__scene = build(root);
  return root.__scene;
}
