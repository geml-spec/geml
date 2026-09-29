// S04 · ② 提示词引用角色卡，todo 列出待办。左边是 script.geml 里三条镜头提示词（引用上色），
// 右边是刚开工时真实的 `geml media todo`（证据 ep-todo-fresh）：八张图、六句配音。
import { C, el, once, prog, mix, paint, hl, text, tr, evidence, mono, sans } from "./lib.js";
import { heading, panel, header, terminal, caption, fadeIn } from "./kit.js";
import { ACT, REF } from "./acts.js";

export const uses = ["evidence-ep-script", "evidence-ep-todo-fresh"];

const T = {
  title: { zh: "② 提示词引用角色卡，文档自己列出待办", en: "② Prompts embed the cards; the documents list what is left" },
  prompts: { zh: "镜头提示词", en: "Shot prompts" },
  count: { zh: "项待办：8 张图 · 6 句配音", en: "to do: 8 images · 6 lines to voice" },
};
const SHOW = ["s01-prompt", "s04-prompt", "s05-prompt"];

function build(root, lang) {
  const head = heading(root, lang, ACT.make, T.title);
  const script = evidence("evidence-ep-script").split("\n");
  const left = panel(80, 150, 900, 880);
  left.append(header("script.geml", tr(lang, T.prompts)));
  const embeds = [];
  const blocks = SHOW.map((id) => {
    const i = script.findIndex((l) => l.startsWith(`=== media-text {#${id} `));
    const box = el("div", { marginBottom: "30px" });
    const h = el("div", { fontFamily: mono, fontSize: "18px", lineHeight: "1.7" });
    paint(h, hl(script[i]));
    const body = el("div", { fontFamily: mono, fontSize: "21px", lineHeight: "1.75", color: C.code, whiteSpace: "pre-wrap" });
    for (const part of script[i + 1].split(/(!\[\[[^\]]+\]\])/)) {
      if (part === "") continue;
      const m = part.match(/#([\w-]+)\]\]$/);
      const e = el("span", { borderRadius: "5px", padding: "1px 3px", display: m ? "inline-block" : "inline" }, part);
      if (m) embeds.push({ e, color: REF[m[1]] ?? C.accent });
      body.append(e);
    }
    box.append(h, body);
    left.append(box);
    return box;
  });
  root.append(left);

  const todo = evidence("evidence-ep-todo-fresh").trimEnd().split("\n");
  const right = panel(1020, 150, 820, 700, "#07080b");
  const term = terminal(todo.map((l, i) => (i === 0 ? { at: 5.6, text: l, cps: 40 } : { at: 6.6 + i * 0.12, text: l, color: l.startsWith("生成") ? C.accent : C.ok })), { fontSize: 19, lineHeight: 1.7 });
  right.append(term.box);
  root.append(right);
  const n = todo.length - 1;
  const count = caption(1020, 890, 820, 40);
  count.style.color = C.warn;
  text(count, `${n} ${tr(lang, T.count)}`);
  root.append(count);
  return { head, left, blocks, embeds, right, term, count };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.left, t, 0.3);
    s.blocks.forEach((b, i) => fadeIn(b, t, 0.6 + i * 0.5, 0.4, 8));
    s.embeds.forEach(({ e, color }, i) => {
      const p = prog(t, 2.4 + i * 0.25, 2.8 + i * 0.25);
      e.style.background = p > 0 ? mix(C.panel, color, 0.45 * p) : "transparent";
      e.style.color = p > 0.5 ? "#fff" : C.code;
    });
    fadeIn(s.right, t, 5.2);
    s.term.update(t);
    fadeIn(s.count, t, 8.8);
  },
};
