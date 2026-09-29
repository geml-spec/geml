// S11 · 改一句台词：l4「这一次，换你喝。」→「这一次，轮到你喝。」。哪些要重做，逐字取自改完之后
// 真实的 geml check（证据 ep-change-line），不写死在这里。
import { C, el, once, prog, mix, text, typed, tr, evidence, mono, sans } from "./lib.js";
import { heading, panel, header, terminal, caption, fadeIn } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = ["evidence-ep-script", "evidence-ep-change-line"];

const T = {
  title: { zh: "改一句台词", en: "Change a line" },
  script: { zh: "剧本", en: "Script" },
  flagged: { zh: "要重做", en: "To redo" },
  rest: { zh: "其余一个不动", en: "Nothing else moves" },
};
const BEFORE = "换你喝。", AFTER = "轮到你喝。";

function build(root, lang) {
  const head = heading(root, lang, ACT.more, T.title);
  const script = evidence("evidence-ep-script").split("\n");
  const i0 = script.findIndex((l) => l.startsWith("=== media-text {#l4 "));
  const top = panel(80, 150, 1760, 230);
  top.append(header("script.geml", tr(lang, T.script)));
  top.append(el("div", { fontFamily: mono, fontSize: "18px", color: C.dim, whiteSpace: "pre" }, script[i0]));
  const body = el("div", { fontFamily: sans, fontSize: "44px", color: C.text, marginTop: "8px" });
  const edit = el("span", { borderRadius: "6px", padding: "0 4px" });
  body.append(document.createTextNode(script[i0 + 1].replace(BEFORE, "")), edit);
  top.append(body);
  root.append(top);

  const check = evidence("evidence-ep-change-line").trimEnd().split("\n");
  const flagged = [...check.join("\n").matchAll(/^warning: ([\w-]+): .*#([\w-]+)\)$/gm)].map((m) => ({ code: m[1], id: m[2] }));
  const tp = panel(80, 420, 1100, 520, "#07080b");
  const clip = (l) => l.replace(/^(warning: [\w-]+): .*(#[\w-]+)\)$/, "$1 … $2");
  const term = terminal(check.map((l, i) => (i === 0 ? { at: 3.0, text: l, cps: 50 } : { at: 4.2 + (i - 1) * 0.45, text: clip(l), color: C.warn })), { fontSize: 20, lineHeight: 1.8 });
  tp.append(term.box);
  root.append(tp);
  const fp = panel(1220, 420, 620, 520);
  fp.append(header(undefined, tr(lang, T.flagged)));
  const chips = flagged.map((f, i) => {
    const c = el("div", { fontFamily: mono, fontSize: "26px", color: C.warn, border: `2px solid ${C.warn}`, borderRadius: "10px", padding: "8px 16px", margin: "0 0 16px", width: "fit-content" }, `#${f.id}`);
    fp.append(c);
    return { c, at: 4.2 + i * 0.45 };
  });
  root.append(fp);
  const cap = caption(80, 970, 1760, 34);
  cap.style.color = C.ok;
  text(cap, tr(lang, T.rest));
  root.append(cap);
  return { head, top, edit, tp, term, fp, chips, cap, n: flagged.length };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.top, t, 0.3);
    let w;
    if (t < 1.0) w = BEFORE;
    else if (t < 1.6) w = [...BEFORE].slice(0, BEFORE.length - Math.floor((t - 1.0) / 0.15)).join("");
    else w = typed(AFTER, t, 1.6, 1 / 0.15);
    text(s.edit, w);
    const hot = prog(t, 0.9, 1.1);
    s.edit.style.background = hot > 0 ? mix(C.panel, C.accent, 0.4 * hot) : "transparent";
    fadeIn(s.tp, t, 2.6);
    s.term.update(t);
    fadeIn(s.fp, t, 4.0);
    s.chips.forEach((k) => fadeIn(k.c, t, k.at, 0.3, 8));
    fadeIn(s.cap, t, 4.2 + s.n * 0.45 + 0.4);
  },
};
