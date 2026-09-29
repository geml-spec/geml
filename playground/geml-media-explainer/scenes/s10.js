// S10 · 断点续跑：做到一半断了（后三张图、全部配音还没做），todo 只列剩下的（证据 ep-resume）；
// 前五张图保留，重跑不再碰它们。
import { C, el, once, prog, mix, text, tr, art, evidence, sans } from "./lib.js";
import { heading, panel, terminal, thumb, badge, caption, fadeIn } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = ["evidence-ep-resume", "ep-hero-sheet", "ep-sister-sheet", "ep-s01-key", "ep-s02-key", "ep-s03-key", "ep-s04-key", "ep-s05-key", "ep-s06-key"];

const T = {
  title: { zh: "断点续跑", en: "Pick up where it stopped" },
  done: { zh: "已做 ✓", en: "done ✓" },
  todo: { zh: "待做", en: "to do" },
};
const IDS = ["hero-sheet", "sister-sheet", "s01-key", "s02-key", "s03-key", "s04-key", "s05-key", "s06-key"];

function build(root, lang) {
  const head = heading(root, lang, ACT.more, T.title);
  const lines = evidence("evidence-ep-resume").trimEnd().split("\n");
  const pending = new Set(lines.filter((l) => l.startsWith("生成")).map((l) => l.match(/#(\S+)-prompt/)[1]).map((p) => (/^s\d\d$/.test(p) ? `${p}-key` : p)));
  const nGen = pending.size, nVoice = lines.filter((l) => l.startsWith("配音")).length;
  const tp = panel(80, 150, 860, 760, "#07080b");
  const term = terminal(lines.map((l, i) => (i === 0 ? { at: 1.0, text: l, cps: 40 } : { at: 2.0 + i * 0.15, text: l, color: l.startsWith("生成") ? C.accent : C.ok })), { fontSize: 20, lineHeight: 1.75 });
  tp.append(term.box);
  root.append(tp);
  const tiles = IDS.map((id, i) => {
    const box = el("div", { position: "absolute", left: `${990 + (i % 4) * 215}px`, top: `${150 + Math.floor(i / 4) * 390}px`, width: "190px" });
    const th = thumb(art(`ep-${id}`), 190, 338);
    const b = badge();
    const later = pending.has(id);
    text(b, tr(lang, later ? T.todo : T.done));
    b.style.background = later ? C.warn : C.ok;
    th.box.append(b);
    box.append(th.box);
    root.append(box);
    return { box, b, later };
  });
  const cap = caption(80, 950, 1760, 36);
  cap.style.color = C.warn;
  text(cap, lang === "zh" ? `只做剩下的：${nGen} 张图、${nVoice} 句配音` : `Only what is left: ${nGen} images, ${nVoice} lines to voice`);
  root.append(cap);
  return { head, tp, term, tiles, cap };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.tp, t, 0.3);
    s.term.update(t);
    s.tiles.forEach((k, i) => {
      fadeIn(k.box, t, 0.5 + i * 0.1, 0.4, 8);
      k.box.style.filter = k.later && t >= 4.0 ? `grayscale(${prog(t, 4.0, 4.5).toFixed(3)}) brightness(${(1 - 0.45 * prog(t, 4.0, 4.5)).toFixed(3)})` : "none";
      k.b.style.opacity = String(prog(t, 4.2, 4.6));
    });
    fadeIn(s.cap, t, 5.6);
  },
};
