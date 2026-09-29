// 镜头的公共部件：标题、面板、文档视图、终端、缩略图、时间线、便签。
//
// 规矩同 lib.js：部件在第一次 render 时建好，之后每帧只按 t 改样式与文字；文字没变不碰
// （text / paint 已经这么做）。所有部件的「随 t 变化」都写成接受 t 的函数，不藏状态。
import { C, el, prog, lerp, mix, paint, hl, text, typed, tr, mono, sans } from "./lib.js";

export const fadeIn = (e, t, at, dur = 0.6, dy = 14) => {
  const p = prog(t, at, at + dur);
  e.style.opacity = String(p);
  e.style.transform = `translateY(${lerp(dy, 0, p).toFixed(2)}px)`;
  return p;
};

/** 左上角：幕名 + 镜头标题。返回 animate(t)。 */
export function heading(root, lang, kicker, title) {
  const k = el("div", { position: "absolute", left: "80px", top: "40px", fontFamily: sans, fontSize: "22px", color: C.accent, letterSpacing: "2px" }, tr(lang, kicker));
  const h = el("div", { position: "absolute", left: "80px", top: "70px", fontFamily: sans, fontSize: "48px", fontWeight: "700", color: C.text, whiteSpace: "nowrap" }, tr(lang, title));
  root.append(k, h);
  return (t) => { fadeIn(k, t, 0); fadeIn(h, t, 0.1); };
}

export function panel(x, y, w, h, bg = C.panel) {
  return el("div", {
    position: "absolute", left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, boxSizing: "border-box",
    padding: "18px 22px", background: bg, border: `2px solid ${C.line}`, borderRadius: "14px", overflow: "hidden",
  });
}

/** 面板标题：「角色卡  characters.geml」。label 可省。 */
export function header(file, label) {
  const h = el("div", { display: "flex", alignItems: "baseline", gap: "14px", marginBottom: "12px", whiteSpace: "nowrap" });
  if (label !== undefined) h.append(el("span", { fontFamily: sans, fontSize: "24px", color: C.text, fontWeight: "600" }, label));
  if (file !== undefined) h.append(el("span", { fontFamily: mono, fontSize: "16px", color: C.dim }, file));
  return h;
}

/**
 * 一段文档：每行一个 div，GEML 围栏行上色，其余行原样。rows[i] 可以单独改。
 * reveal(t, start, per)：从 start 起每 per 秒露一行。
 */
export function docView(lines, { fontSize = 20, lineHeight = 1.6 } = {}) {
  const box = el("div", { fontFamily: mono, fontSize: `${fontSize}px`, lineHeight: String(lineHeight), color: C.code, whiteSpace: "pre" });
  const rows = lines.map((l) => {
    const r = el("div", { borderRadius: "6px", padding: "0 6px", margin: "0 -6px", minHeight: `${fontSize * lineHeight}px` });
    paint(r, l.startsWith("=") ? hl(l) : [[l, l.startsWith("#") ? C.text : C.code]]);
    box.append(r);
    return r;
  });
  const reveal = (t, start, per) => rows.forEach((r, i) => { r.style.opacity = String(prog(t, start + i * per, start + i * per + 0.3)); });
  /** 第 i 行底色高亮：at 起亮，color 缺省强调色。 */
  const mark = (t, i, at, color = C.accent, until = Infinity) => {
    const p = prog(t, at, at + 0.3) * (1 - prog(t, until, until + 0.3));
    rows[i].style.background = p > 0 ? mix(C.panel, color, 0.28 * p) : "transparent";
  };
  return { box, rows, reveal, mark };
}

/**
 * 终端。script：[{ at, text, color?, cps? }]——每项一行；给了 cps 就按打字机出，否则到点整行出现。
 * 命令行（以 "$ " 开头）的 "$" 画成绿色。
 */
export function terminal(script, { fontSize = 17, lineHeight = 1.5, wrap = false } = {}) {
  const box = el("div", { fontFamily: mono, fontSize: `${fontSize}px`, lineHeight: String(lineHeight), color: C.code, whiteSpace: wrap ? "pre-wrap" : "pre", wordBreak: "break-all" });
  const rows = script.map(() => { const r = el("div", {}); box.append(r); return r; });
  const update = (t) => script.forEach((s, i) => {
    const shown = s.cps !== undefined ? typed(s.text, t, s.at, s.cps) : t >= s.at ? s.text : "";
    if (shown.startsWith("$ ")) paint(rows[i], [["$ ", C.ok], [shown.slice(2), C.code]]);
    else paint(rows[i], shown === "" ? [] : [[shown, s.color ?? C.code]]);
  });
  return { box, rows, update };
}

/** 一张图，可带第二张在上面淡入（重做之后的新版本）；可带 ▶ 角标。 */
export function thumb(src, w, h, { next, play = false } = {}) {
  const box = el("div", { position: "relative", width: `${w}px`, height: `${h}px`, borderRadius: "8px", overflow: "hidden", flex: "none", background: "#10131b" });
  const a = el("img", { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover" });
  a.src = src;
  box.append(a);
  let b = null;
  if (next !== undefined) {
    b = el("img", { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover", opacity: "0" });
    b.src = next;
    box.append(b);
  }
  if (play) {
    const d = Math.round(Math.min(w, h) * 0.2);
    box.append(el("div", {
      position: "absolute", left: "8%", bottom: "6%", width: `${d}px`, height: `${d}px`, borderRadius: "50%",
      background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: `${Math.round(d * 0.5)}px`, lineHeight: `${d}px`, textAlign: "center",
    }, "▶"));
  }
  return { box, next: b };
}

/** 一条胶片：同一张图横向平铺成 w×h。 */
export function strip(src, w, h) {
  const s = el("div", { position: "absolute", inset: "0", display: "flex", overflow: "hidden" });
  const tile = Math.round(h * 9 / 16);
  for (let i = 0; i < Math.ceil(w / tile); i++) {
    const im = el("img", { width: `${tile}px`, height: `${h}px`, objectFit: "cover", flex: "none" });
    im.src = src;
    s.append(im);
  }
  return s;
}

/** 波形：确定的柱高，不用随机数。 */
export function wave(n, color = C.ok) {
  const w = el("div", { display: "flex", alignItems: "center", gap: "3px", height: "100%" });
  for (let i = 0; i < n; i++) w.append(el("div", { width: "4px", height: `${6 + ((i * 7) % 13)}px`, background: color, borderRadius: "2px", flex: "none" }));
  return w;
}

/** 右上角的小标签（要重做 / 已重做）。 */
export function badge() {
  return el("div", {
    position: "absolute", right: "8px", top: "8px", padding: "4px 10px", borderRadius: "8px", whiteSpace: "nowrap",
    fontFamily: sans, fontSize: "17px", fontWeight: "600", color: C.bg, background: C.warn, opacity: "0",
  });
}

/** 黄色便签。 */
export function note(textStr, x, y, w) {
  return el("div", {
    position: "absolute", left: `${x}px`, top: `${y}px`, width: `${w}px`, padding: "18px 22px", boxSizing: "border-box",
    background: "#ffe27a", color: "#2a2410", fontFamily: sans, fontSize: "27px", fontWeight: "600", lineHeight: "1.4",
    borderRadius: "6px", boxShadow: "0 12px 30px rgba(0,0,0,0.45)", whiteSpace: "pre-line", transformOrigin: "30% 0",
  }, textStr);
}

/** 便签的出现与离开。 */
export function animateNote(n, t, at, until = Infinity) {
  const i = prog(t, at, at + 0.4);
  const o = prog(t, until, until + 0.5);
  n.style.opacity = String(i * (1 - o));
  n.style.transform = `rotate(-4deg) scale(${lerp(0.85, 1, i).toFixed(3)})`;
}

/** 大字小结。 */
export function caption(x, y, w, size = 46) {
  return el("div", { position: "absolute", left: `${x}px`, top: `${y}px`, width: `${w}px`, fontFamily: sans, fontSize: `${size}px`, fontWeight: "700", color: C.text, opacity: "0" });
}

/**
 * 剪映式时间线。clips：[{ track, from, to, art?, label, kind }]，track 是行号；from/to 是秒，
 * 可以是 (t) => 秒 的函数——S11 改一刀时片段会动。返回 { box, update(t), items }。
 * 坐标：x0 是 0 秒的横坐标，px 是每秒像素。
 */
export function timeline(lang, clips, { x0, px, top, rowH = 66, rowGap = 12, labels, seconds = 10, step = 1 }) {
  const box = el("div", { position: "absolute", left: "0", top: "0" });
  // 刻度按这条时间线的实际长度出（seconds），每 step 秒一格——不写死成 10 秒。
  const ruler = el("div", { position: "absolute", left: `${x0}px`, top: `${top - 24}px`, width: `${seconds * px}px`, height: "16px" });
  for (let s = 0; s <= seconds + 1e-9; s += step) ruler.append(el("div", { position: "absolute", left: `${s * px}px`, fontFamily: mono, fontSize: "13px", color: C.dim }, `${s}s`));
  box.append(ruler);
  const rowTop = (r) => top + r.reduce((a, h) => a + h + rowGap, 0);
  const heights = labels.map((l) => l.h ?? rowH);
  labels.forEach((l, i) => {
    box.append(el("div", {
      position: "absolute", left: `${x0 - 130}px`, width: "116px", top: `${rowTop(heights.slice(0, i))}px`, height: `${heights[i]}px`,
      display: "flex", alignItems: "center", justifyContent: "flex-end", fontFamily: sans, fontSize: "17px", color: C.dim,
    }, tr(lang, l.name)));
  });
  const val = (v, t) => (typeof v === "function" ? v(t) : v);
  const items = clips.map((c) => {
    const h = heights[c.track];
    const e = el("div", {
      position: "absolute", top: `${rowTop(heights.slice(0, c.track))}px`, height: `${h}px`, boxSizing: "border-box",
      border: `3px solid ${C.line}`, borderRadius: "8px", overflow: "hidden", background: c.kind === "audio" ? "#1d3b35" : c.kind === "text" ? "#2a2440" : "#10131b",
    });
    if (c.art !== undefined) e.append(strip(c.art, 1400, h - 6));
    if (c.kind === "audio") { const w = wave(60); Object.assign(w.style, { position: "absolute", left: "8px", top: "0" }); e.append(w); }
    if (c.kind === "text") e.append(el("div", { position: "absolute", left: "10px", top: "0", height: "100%", display: "flex", alignItems: "center", fontFamily: sans, fontSize: "17px", color: C.text, whiteSpace: "nowrap" }, c.text));
    if (c.label !== undefined) {
      e.append(el("div", {
        position: "absolute", left: "6px", top: "4px", padding: "1px 8px", borderRadius: "6px", background: "rgba(0,0,0,0.6)",
        fontFamily: mono, fontSize: "14px", color: C.id, whiteSpace: "nowrap",
      }, c.label));
    }
    box.append(e);
    return { ...c, e };
  });
  const update = (t) => {
    for (const it of items) {
      const f = val(it.from, t), to = val(it.to, t);
      it.e.style.left = `${(x0 + f * px).toFixed(2)}px`;
      it.e.style.width = `${Math.max(0, (to - f) * px - 4).toFixed(2)}px`;
    }
  };
  return { box, update, items };
}

export { text };
