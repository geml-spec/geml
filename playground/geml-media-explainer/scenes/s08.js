// S08 · ⑥ 出片：一条 build，一条 check（证据 ep-build、ep-check）；右边是成片里真实的一帧，
// 中英字幕已经烧在画面上。
import { C, el, once, text, tr, art, evidence, sans } from "./lib.js";
import { heading, panel, header, terminal, thumb, fadeIn } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = ["evidence-ep-build", "evidence-ep-check", "ep-frame"];

const T = {
  title: { zh: "⑥ 出片", en: "⑥ Render" },
  frame: { zh: "成片里的一帧", en: "A frame of the result" },
};

function build(root, lang) {
  const head = heading(root, lang, ACT.make, T.title);
  const b = evidence("evidence-ep-build").trimEnd().split("\n");
  const c = evidence("evidence-ep-check").trimEnd().split("\n");
  const tp = panel(80, 150, 1100, 880, "#07080b");
  const term = terminal([
    { at: 0.5, text: b[0], cps: 45 }, ...b.slice(1).map((l, i) => ({ at: 2.0 + i * 0.3, text: l, color: C.ok })),
    { at: 3.6, text: c[0], cps: 45 }, ...c.slice(1).map((l, i) => ({ at: 4.9 + i * 0.3, text: l, color: C.ok })),
  ], { fontSize: 21, lineHeight: 1.8, wrap: true });
  tp.append(term.box);
  root.append(tp);
  const fp = panel(1220, 150, 620, 880);
  fp.append(header("episode/out/ep01.mp4", tr(lang, T.frame)));
  const th = thumb(art("ep-frame"), 432, 768);
  th.box.style.margin = "0 auto";
  fp.append(th.box);
  root.append(fp);
  return { head, tp, term, fp };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.tp, t, 0.3);
    s.term.update(t);
    fadeIn(s.fp, t, 2.6);
  },
};
