// S07 · ⑤ 剪辑：cut.geml 就是时间线。上：它的原文（证据 ep-cut）；下：按它画出来的时间线——画面、
// 配音、中英字幕、配乐，位置全部由原文里的 out / over / offset / duration 算出。
import { C, el, once, prog, text, tr, art, evidence, mono, sans } from "./lib.js";
import { heading, panel, header, docView, timeline, fadeIn } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = ["evidence-ep-cut", "ep-s01-key", "ep-s02-key", "ep-s03-key", "ep-s04-key", "ep-s05-key", "ep-s06-key"];

const T = {
  title: { zh: "⑤ 剪辑：时间线也是文本", en: "⑤ The edit: the timeline is text too" },
  cut: { zh: "时间线", en: "Timeline" },
  video: { zh: "画面", en: "Video" },
  dialogue: { zh: "配音", en: "Voice" },
  zh: { zh: "中文字幕", en: "Chinese subs" },
  en: { zh: "英文字幕", en: "English subs" },
  music: { zh: "配乐", en: "Music" },
  anchor: { zh: "锚在 #c4 上，晚 0.4 秒", en: "on #c4, 0.4 s in" },
};
const X0 = 270, PX = 40, TOP = 670;

const attrs = (l) => Object.fromEntries([...l.matchAll(/([\w-]+)=([^\s}]+)/g)].map((m) => [m[1], m[2]]));

function build(root, lang) {
  const head = heading(root, lang, ACT.make, T.title);
  const all = evidence("evidence-ep-cut").split("\n");
  const clips = all.filter((l) => l.startsWith("=== media-clip"));
  const shown = [all.find((l) => l.startsWith("==== media")), ...clips.filter((l) => /\{#c\d /.test(l)), clips.find((l) => l.includes("{#music ")),
    ...clips.filter((l) => /\{#[dte]-l2 /.test(l)), "…"];
  const top = panel(80, 150, 1760, 400);
  top.append(header("cut.geml", tr(lang, T.cut)));
  const doc = docView(shown, { fontSize: 16, lineHeight: 1.6 });
  top.append(doc.box);
  root.append(top);

  // 位置：主轨顺排，其余按 over + offset
  const start = {}; let acc = 0;
  const video = clips.filter((l) => /\{#c\d /.test(l)).map((l) => {
    const id = l.match(/\{#(c\d+) /)[1], a = attrs(l), d = Number(a.out) - Number(a.in);
    start[id] = acc; const from = acc; acc += d;
    return { track: 0, from, to: acc, art: art(`ep-${a.src.split("#")[1].replace(/-take$/, "")}-key`), label: `#${id}` };
  });
  const anchored = (l, track, extra) => {
    const a = attrs(l), from = start[a.over.slice(1)] + Number(a.offset ?? 0);
    return { track, from, to: from + Number(a.duration ?? 0), ...extra };
  };
  const durOf = (line) => Number(attrs(clips.find((l) => l.includes(`{#t-${line} `))).duration);
  const lineIds = clips.filter((l) => /\{#t-\w+ /.test(l)).map((l) => l.match(/\{#t-(\w+) /)[1]);
  const items = [...video,
    ...lineIds.map((id) => { const d = anchored(clips.find((l) => l.includes(`{#d-${id} `)), 1, { kind: "audio" }); d.to = d.from + durOf(id); return d; }),
    ...lineIds.map((id) => anchored(clips.find((l) => l.includes(`{#t-${id} `)), 2, { kind: "text", text: "" })),
    ...lineIds.map((id) => anchored(clips.find((l) => l.includes(`{#e-${id} `)), 3, { kind: "text", text: "" })),
  ];
  const m = attrs(clips.find((l) => l.includes("{#music ")));
  items.push({ track: 4, from: 0, to: Number(m.out) - Number(m.in), kind: "audio" });
  const tp = panel(80, 590, 1760, 440);
  root.append(tp);
  const tl = timeline(lang, items, { x0: X0, px: PX, top: TOP, seconds: acc, step: 3, labels: [{ name: T.video, h: 76 }, { name: T.dialogue, h: 38 }, { name: T.zh, h: 34 }, { name: T.en, h: 34 }, { name: T.music, h: 30 }] });
  root.append(tl.box);
  const d4 = items.find((it) => it.track === 1 && Math.abs(it.from - (start.c4 + 0.4)) < 1e-6);
  const anchor = el("div", { position: "absolute", left: `${X0 + start.c4 * PX}px`, top: `${TOP + 76 + 4}px`, width: `${0.4 * PX}px`, height: "4px", background: C.warn, opacity: "0" });
  // 标注放在刻度尺上方的空白里：放在配音行旁边会压住下一段配音
  const aLabel = el("div", { position: "absolute", left: `${X0 + start.c4 * PX}px`, top: `${TOP - 60}px`, fontFamily: sans, fontSize: "20px", fontWeight: "600", color: C.warn, whiteSpace: "nowrap", opacity: "0" }, `↓ ${tr(lang, T.anchor)}`);
  root.append(anchor, aLabel);
  return { head, top, doc, shown, tp, tl, anchor, aLabel };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.top, t, 0.3);
    s.doc.reveal(t, 0.6, 0.18);
    fadeIn(s.tp, t, 2.6);
    s.tl.update(t);
    const at = { 0: 3.0, 1: 4.2, 2: 5.0, 3: 5.6, 4: 6.2 };
    s.tl.items.forEach((it) => fadeIn(it.e, t, at[it.track] + (it.track === 0 ? it.from * 0.03 : 0), 0.4, 6));
    const row = s.shown.findIndex((l) => l.includes("{#d-l2 "));
    if (row >= 0) s.doc.mark(t, row, 7.2, C.warn);
    s.anchor.style.opacity = String(prog(t, 7.3, 7.6));
    fadeIn(s.aLabel, t, 7.5, 0.4, 6);
  },
};
