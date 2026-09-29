// S05 · ③ 出图：照着 todo 一项项做。上：todo 给出的一项（提示词已展开）→ 真实的出图命令 → 登记；
// 下：这一集的八张图，每张带它真实生成记录里的种子（证据 ep-genlog）。
import { C, el, once, prog, text, tr, art, evidence, mono, sans } from "./lib.js";
import { heading, panel, header, terminal, thumb, caption, fadeIn } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = ["evidence-ep-todo-json", "evidence-ep-mflux", "evidence-ep-log", "evidence-ep-genlog",
  "ep-hero-sheet", "ep-sister-sheet", "ep-s01-key", "ep-s02-key", "ep-s03-key", "ep-s04-key", "ep-s05-key", "ep-s06-key"];

const T = {
  title: { zh: "③ 出图：照着 todo 一项项做", en: "③ Images: work through the to-do list" },
  logged: { zh: "登记", en: "Logged" },
  model: { zh: "模型", en: "Model" },
  seed: { zh: "种子", en: "Seed" },
  prompt: { zh: "提示词", en: "Prompt" },
  left: { zh: "待办", en: "To do" },
  eight: { zh: "这一集的八张图 · 本机 Z-Image-Turbo", en: "The episode's eight images · Z-Image-Turbo, local" },
};
const IDS = ["hero-sheet", "sister-sheet", "s01-key", "s02-key", "s03-key", "s04-key", "s05-key", "s06-key"];
const imgAt = (i) => 7.0 + i * 0.9;

function build(root, lang) {
  const head = heading(root, lang, ACT.make, T.title);
  const tj = evidence("evidence-ep-todo-json").split("\n");
  const item = JSON.parse(tj.slice(1).join("\n")).find((x) => x.address.endsWith("#s01-prompt"));
  const mflux = evidence("evidence-ep-mflux").trim();
  const tp = panel(80, 150, 1120, 390, "#07080b");
  const term = terminal([
    { at: 0.6, text: tj[0], cps: 50 },
    { at: 1.6, text: `{ "kind": "${item.kind}", "address": "${item.address}",`, color: C.dim },
    { at: 1.8, text: `  "prompt": "${item.prompt.trim()}" }`, color: C.str },
    { at: 3.2, text: mflux, cps: 110 },
    { at: 6.0, text: "✓ assets/s01-key.png", color: C.ok },
  ], { fontSize: 17, lineHeight: 1.55, wrap: true });
  tp.append(term.box);
  root.append(tp);

  const rec = JSON.parse(evidence("evidence-ep-log").trim().split("\n").at(-1));
  const lp = panel(1240, 150, 600, 390);
  lp.append(header("library.geml", tr(lang, T.logged)));
  const row = el("div", { display: "flex", gap: "20px" });
  const th = thumb(art("ep-s01-key"), 150, 267);
  const kv = el("div", { fontSize: "19px", lineHeight: "2.0" });
  const pair = (k, v, c) => { const d = el("div", { whiteSpace: "nowrap" }); d.append(el("span", { fontFamily: sans, color: C.dim }, `${tr(lang, T[k])}  `), el("span", { fontFamily: mono, color: c }, v)); kv.append(d); return d; };
  const kvs = [pair("model", rec.model, C.text), pair("seed", String(rec.seed), C.text), pair("prompt", rec.prompt.split("#")[1], C.str)];
  kv.append(el("div", { fontFamily: mono, fontSize: "15px", color: C.dim }, `prompt-sha256 ${rec["prompt-sha256"].slice(0, 12)}…`));
  row.append(th.box, kv);
  lp.append(row);
  root.append(lp);

  const seeds = Object.fromEntries(evidence("evidence-ep-genlog").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)).filter((r) => r.mode === "t2i").map((r) => [r.output.slice(1), r.seed]));
  const bp = panel(80, 580, 1760, 450);
  bp.append(header(undefined, tr(lang, T.eight)));
  const imgs = IDS.map((id, i) => {
    const box = el("div", { position: "absolute", left: `${30 + i * 212}px`, top: "64px", width: "180px", textAlign: "center" });
    const t2 = thumb(art(`ep-${id}`), 180, 320);
    box.append(t2.box, el("div", { fontFamily: mono, fontSize: "15px", color: C.id, marginTop: "8px", whiteSpace: "nowrap" }, `#${id}`),
      el("div", { fontFamily: mono, fontSize: "15px", color: C.dim, whiteSpace: "nowrap" }, `seed ${seeds[id]}`));
    bp.append(box);
    return box;
  });
  root.append(bp);
  const counter = el("div", { position: "absolute", right: "110px", top: "594px", fontFamily: sans, fontSize: "26px", fontWeight: "700", color: C.warn, whiteSpace: "nowrap" });
  root.append(counter);
  return { head, tp, term, lp, th, kvs, bp, imgs, counter };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.tp, t, 0.3);
    s.term.update(t);
    fadeIn(s.lp, t, 5.8);
    s.kvs.forEach((k, i) => fadeIn(k, t, 6.4 + i * 0.3, 0.3, 6));
    fadeIn(s.bp, t, 6.6);
    let shown = 0;
    s.imgs.forEach((b, i) => { fadeIn(b, t, imgAt(i), 0.4, 10); if (t >= imgAt(i)) shown++; });
    s.counter.style.opacity = String(prog(t, 6.6, 7.0));
    text(s.counter, `${tr(lang, T.left)} ${14 - shown}`);
  },
};
