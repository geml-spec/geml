// S03 · ① 一页梗概 → 角色卡与分镜表。左边是 episode/story.md 原文，右边是 Agent 由它写出的
// characters.geml 与 script.geml 里的分镜表（都是证据），外加两张角色图。
import { C, el, once, prog, text, tr, art, evidence, hasId, mono, sans } from "./lib.js";
import { heading, panel, header, thumb, fadeIn } from "./kit.js";
import { ACT, REF } from "./acts.js";

export const uses = ["evidence-ep-story", "evidence-ep-characters", "evidence-ep-script", "ep-hero-sheet", "ep-sister-sheet"];

const T = {
  title: { zh: "① 一页梗概 → 角色卡与分镜表", en: "① A synopsis → cards and a storyboard" },
  story: { zh: "梗概", en: "Synopsis" },
  cards: { zh: "角色卡", en: "Character cards" },
  board: { zh: "分镜表", en: "Storyboard" },
};

function build(root, lang) {
  const head = heading(root, lang, ACT.make, T.title);
  const story = evidence("evidence-ep-story").trim().split("\n");
  const left = panel(80, 150, 560, 880, "#f4f1ea");
  left.append(el("div", { fontFamily: mono, fontSize: "16px", color: "#777", marginBottom: "16px" }, "story.md"));
  const paras = [];
  for (const l of story) {
    if (l.trim() === "") continue;
    const h = l.startsWith("# ");
    const p = el("div", { fontFamily: sans, fontSize: h ? "28px" : "22px", fontWeight: h ? "700" : "400", color: "#222", lineHeight: "1.7", marginBottom: h ? "18px" : "4px" }, h ? l.slice(2) : l);
    left.append(p);
    paras.push(p);
  }
  root.append(left);

  const chars = evidence("evidence-ep-characters").split("\n");
  const cardP = panel(680, 150, 1160, 400);
  cardP.append(header("characters.geml", tr(lang, T.cards)));
  const looks = ["hero-look", "sister-look", "look"].map((id) => {
    const i = chars.findIndex((l) => hasId(l, id));
    const r = el("div", { fontFamily: sans, fontSize: "21px", lineHeight: "1.6", color: C.text, marginBottom: "12px", width: "760px" });
    r.append(el("span", { fontFamily: mono, fontSize: "18px", color: REF[id], marginRight: "14px" }, `#${id}`), document.createTextNode(chars[i + 1]));
    cardP.append(r);
    return r;
  });
  const sheets = ["ep-hero-sheet", "ep-sister-sheet"].map((a, i) => {
    const th = thumb(art(a), 150, 267);
    Object.assign(th.box.style, { position: "absolute", left: `${820 + i * 166}px`, top: "100px" });
    cardP.append(th.box);
    return th.box;
  });
  root.append(cardP);

  const script = evidence("evidence-ep-script").split("\n");
  const rows = script.filter((l) => /^\| (镜号|s\d\d) /.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const boardP = panel(680, 590, 1160, 440);
  boardP.append(header("script.geml", tr(lang, T.board)));
  const grid = el("div", { display: "grid", gridTemplateColumns: "90px 80px 90px 1fr 90px", fontFamily: sans, fontSize: "20px" });
  const rowEls = rows.map((r, k) => r.map((v, j) => {
    const c = el("div", { padding: "8px 10px", borderBottom: `1px solid ${C.line}`, color: k === 0 ? C.dim : j === 0 || j === 4 ? C.id : C.text,
      fontFamily: j === 0 || j === 4 ? mono : sans, fontWeight: k === 0 ? "600" : "400", whiteSpace: "nowrap" }, v);
    grid.append(c);
    return c;
  }));
  boardP.append(grid);
  root.append(boardP);
  return { head, left, paras, cardP, looks, sheets, boardP, rowEls };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.left, t, 0.3);
    s.paras.forEach((p, i) => fadeIn(p, t, 0.6 + i * 0.35, 0.4, 6));
    fadeIn(s.cardP, t, 3.2);
    s.looks.forEach((l, i) => fadeIn(l, t, 3.5 + i * 0.4, 0.4, 6));
    s.sheets.forEach((b, i) => fadeIn(b, t, 4.4 + i * 0.3));
    fadeIn(s.boardP, t, 6.2);
    s.rowEls.forEach((cells, i) => cells.forEach((c) => { c.style.opacity = String(prog(t, 6.5 + i * 0.35, 6.8 + i * 0.35)); }));
  },
};
