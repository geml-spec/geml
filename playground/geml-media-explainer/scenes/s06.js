// S06 · ④ 运镜与配音。上：六张关键帧按分镜表的「运镜」动起来（画面上的推拉移是示意，真正的
// take 由 ffmpeg 按同一张表做）；下：六句台词按角色库的声音表配好；右下：待办清零（证据）。
import { C, el, once, prog, clamp, lerp, text, tr, art, evidence, mono, sans } from "./lib.js";
import { heading, panel, header, terminal, wave, fadeIn } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = ["evidence-ep-script", "evidence-ep-characters", "evidence-ep-todo-done",
  "ep-s01-key", "ep-s02-key", "ep-s03-key", "ep-s04-key", "ep-s05-key", "ep-s06-key"];

const T = {
  title: { zh: "④ 运镜与配音", en: "④ Camera moves and voices" },
  moves: { zh: "运镜 · 取自分镜表", en: "Camera moves · from the storyboard" },
  voices: { zh: "配音 · 声音取自角色库", en: "Voices · from the character list" },
  moveNames: { 推近: { zh: "推近", en: "push in" }, 缓推: { zh: "缓推", en: "slow push" }, 拉远: { zh: "拉远", en: "pull out" }, 横移: { zh: "横移", en: "pan" } },
};
const TH_W = 150, TH_H = 267;

/** 一种运镜在 p（0..1）处的 transform。 */
function move(m, p) {
  if (m === "推近") return `scale(${lerp(1, 1.18, p).toFixed(4)})`;
  if (m === "缓推") return `scale(${lerp(1, 1.08, p).toFixed(4)})`;
  if (m === "拉远") return `scale(${lerp(1.22, 1, p).toFixed(4)})`;
  return `scale(1.14) translateX(${lerp(6, -6, p).toFixed(3)}%)`;
}

function build(root, lang) {
  const head = heading(root, lang, ACT.make, T.title);
  const script = evidence("evidence-ep-script").split("\n");
  const shots = script.filter((l) => /^\| s\d\d /.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const top = panel(80, 150, 1760, 470);
  top.append(header("script.geml", tr(lang, T.moves)));
  const tiles = shots.map(([id, , m], i) => {
    const box = el("div", { position: "absolute", left: `${40 + i * 285}px`, top: "70px", width: `${TH_W}px`, textAlign: "center" });
    const frame = el("div", { width: `${TH_W}px`, height: `${TH_H}px`, overflow: "hidden", borderRadius: "8px" });
    const img = el("img", { width: "100%", height: "100%", objectFit: "cover", transformOrigin: "50% 50%" });
    img.src = art(`ep-${id}-key`);
    frame.append(img);
    box.append(frame, el("div", { fontFamily: sans, fontSize: "20px", color: C.text, marginTop: "10px" }, tr(lang, T.moveNames[m])),
      el("div", { fontFamily: mono, fontSize: "15px", color: C.id, marginTop: "4px" }, `→ #${id}-take`));
    top.append(box);
    return { box, img, m };
  });
  root.append(top);

  const chars = evidence("evidence-ep-characters").split("\n");
  const voiceOf = Object.fromEntries(chars.filter((l) => /^\| .+ \| #\w+ \| \w+ \|$/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim())).map(([name, id, v]) => [id, { name, v }]));
  const lines = script.map((l, i) => [l, script[i + 1]]).filter(([l]) => l.includes(" .line ")).map(([h, body]) => ({ who: voiceOf[`#${h.match(/speaker=characters\.geml(#\w+)/)[1].slice(1)}`], body }));
  const vp = panel(80, 660, 1180, 370);
  vp.append(header("characters.geml · script.geml", tr(lang, T.voices)));
  const rows = lines.map(({ who, body }) => {
    const r = el("div", { display: "grid", gridTemplateColumns: "80px 120px 1fr 120px", alignItems: "center", fontSize: "19px", lineHeight: "1.85" });
    const w = wave(12);
    w.style.height = "24px";
    r.append(el("span", { fontFamily: sans, color: C.text }, who.name), el("span", { fontFamily: mono, fontSize: "16px", color: C.dim }, who.v),
      el("span", { fontFamily: sans, color: C.code, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, body), w);
    vp.append(r);
    return r;
  });
  root.append(vp);

  const done = evidence("evidence-ep-todo-done").trimEnd().split("\n");
  const tp = panel(1300, 660, 540, 370, "#07080b");
  const term = terminal([{ at: 8.6, text: done[0], cps: 45 }, { at: 9.6, text: done.at(-1), color: C.ok }], { fontSize: 18, lineHeight: 1.7, wrap: true });
  term.rows[1].style.fontSize = "30px";
  term.rows[1].style.marginTop = "18px";
  tp.append(term.box);
  root.append(tp);
  return { head, top, tiles, vp, rows, tp, term };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.top, t, 0.3);
    s.tiles.forEach((k, i) => {
      fadeIn(k.box, t, 0.6 + i * 0.2, 0.4, 8);
      // 每 4 秒走一遍运镜：示意这一格会怎么动
      const p = clamp(((t - 1) % 4 + 4) % 4 / 4);
      k.img.style.transform = move(k.m, t < 1 ? 0 : p);
    });
    fadeIn(s.vp, t, 4.6);
    s.rows.forEach((r, i) => fadeIn(r, t, 5.0 + i * 0.4, 0.3, 6));
    fadeIn(s.tp, t, 8.2);
    s.term.update(t);
  },
};
