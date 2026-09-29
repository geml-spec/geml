// S02 · geml-media：那一堆收拢成四份文本——这一集的角色库、剧本、素材库、时间线。
// 卡片里的片段取自 episode/ 的真实文档（证据）。
import { C, el, once, prog, lerp, paint, hl, text, tr, evidence, mono, sans } from "./lib.js";
import { heading, caption, fadeIn } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = ["evidence-ep-characters", "evidence-ep-script", "evidence-ep-cut"];

const T = {
  title: { zh: "geml-media", en: "geml-media" },
  cap: { zh: "几份文本：Agent 读得懂，工具核得了", en: "A few text files: an agent can read them, a tool can check them" },
  sub: { zh: "角色卡、分镜表、提示词、台词、素材与生成记录、时间线——都在这里", en: "Character cards, storyboard, prompts, lines, assets and their generation log, the timeline — all here" },
};
const firstLines = (ev, pick, n) => evidence(ev).split("\n").filter(pick).slice(0, n);
const DOCS = [
  { file: "characters.geml", role: { zh: "角色库", en: "Characters" }, ev: "evidence-ep-characters", pick: (l) => /^# |\.look\}/.test(l) },
  { file: "script.geml", role: { zh: "剧本 · 分镜 · 提示词 · 台词", en: "Script · shots · prompts · lines" }, ev: "evidence-ep-script", pick: (l) => /^\| s0|\.prompt |\.line /.test(l) },
  { file: "library.geml", role: { zh: "素材 · 生成记录", en: "Assets · generation log" }, lines: ["=== media-asset {#s01-key kind=image …}", "=== media-asset {#s01-take kind=video …}", "=== data {#gen-log .gen-log format=jsonl}"] },
  { file: "cut.geml", role: { zh: "时间线", en: "Timeline" }, ev: "evidence-ep-cut", pick: (l) => l.startsWith("=== media-clip") },
];
const FROM = [[-300, -140], [140, 200], [-100, 280], [320, -80]];

function build(root, lang) {
  const head = heading(root, lang, ACT.who, T.title);
  const cards = DOCS.map((d, i) => {
    const c = el("div", {
      position: "absolute", left: `${80 + i * 448}px`, top: "200px", width: "416px", height: "500px", boxSizing: "border-box",
      padding: "26px", background: C.panel, border: `2px solid ${C.line}`, borderRadius: "16px", overflow: "hidden",
    });
    c.append(el("div", { width: "64px", height: "80px", borderRadius: "6px 20px 6px 6px", background: C.accent, marginBottom: "20px" }),
      el("div", { fontFamily: mono, fontSize: "25px", color: C.text }, d.file),
      el("div", { fontFamily: sans, fontSize: "21px", color: C.accent, marginTop: "10px", marginBottom: "20px" }, tr(lang, d.role)));
    for (const l of d.lines ?? firstLines(d.ev, d.pick, 5)) {
      const r = el("div", { fontFamily: mono, fontSize: "14px", lineHeight: "1.8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
      paint(r, l.startsWith("=") ? hl(l) : [[l, l.startsWith("#") ? C.text : C.code]]);
      c.append(r);
    }
    root.append(c);
    return c;
  });
  const cap = caption(80, 770, 1760, 50);
  cap.style.textAlign = "center";
  text(cap, tr(lang, T.cap));
  const sub = caption(80, 860, 1760, 26);
  Object.assign(sub.style, { textAlign: "center", color: C.dim, fontWeight: "400" });
  text(sub, tr(lang, T.sub));
  root.append(cap, sub);
  return { head, cards, cap, sub };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    s.cards.forEach((c, i) => {
      const p = prog(t, 0.2 + i * 0.18, 1.2 + i * 0.18);
      c.style.opacity = String(prog(t, 0.2 + i * 0.18, 0.5 + i * 0.18));
      c.style.transform = `translate(${lerp(FROM[i][0], 0, p).toFixed(1)}px, ${lerp(FROM[i][1], 0, p).toFixed(1)}px) rotate(${lerp(i % 2 ? 8 : -8, 0, p).toFixed(2)}deg)`;
    });
    fadeIn(s.cap, t, 1.8);
    fadeIn(s.sub, t, 2.6);
  },
};
