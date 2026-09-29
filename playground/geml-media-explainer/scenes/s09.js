// S09 · 成片：完整播放《重生之夜》第一集。中间那块由渲染工具把 episode/out/ep01.mp4 原样叠进去
// （`overlay`，不经过浏览器截图），这一镜的声音也是那一集自己的（lay-cut 按「成片」放）。两侧写清楚
// 这一集是怎么来的。
import { C, el, once, text, tr, evidence, mono, sans } from "./lib.js";
import { heading, fadeIn } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = ["evidence-ep-todo-done", "evidence-ep-check"];
/** 画中画：这一集从本镜第 1 秒起放，缩放到 560×996（9:16），居中。 */
export const overlay = { src: "ep-final", at: 1, x: 680, y: 42, w: 560, h: 996 };

const T = {
  title: { zh: "《重生之夜》第一集", en: "Rebirth Night · Episode 1" },
  stats: { zh: "6 镜 · 36 秒 · 3 个声音 · 中英字幕", en: "6 shots · 36 s · 3 voices · bilingual subtitles" },
  how: {
    zh: ["画面  本机 Z-Image-Turbo", "运镜  ffmpeg，按分镜表", "配音  macOS say，按角色库", "配乐  代码合成", "字幕  中英双语，烧进画面"],
    en: ["Images  Z-Image-Turbo, local", "Moves  ffmpeg, from the storyboard", "Voices  macOS say, from the cast", "Music  synthesized in code", "Subtitles  Chinese + English, burned in"],
  },
  from: { zh: "全部由这四份文档生成", en: "All generated from these four files" },
};

function build(root, lang) {
  const head = heading(root, lang, ACT.watch, T.title);
  const left = el("div", { position: "absolute", left: "80px", top: "170px", width: "560px" });
  left.append(el("div", { fontFamily: sans, fontSize: "30px", color: C.warn, marginBottom: "48px", lineHeight: "1.5" }, tr(lang, T.stats)));
  const how = T.how[lang].map((l) => {
    const [k, ...v] = l.split("  ");
    const r = el("div", { fontSize: "26px", lineHeight: "2.4", whiteSpace: "nowrap" });
    r.append(el("span", { fontFamily: sans, color: C.dim, display: "inline-block", width: lang === "zh" ? "100px" : "150px" }, k), el("span", { fontFamily: sans, color: C.text }, v.join("  ")));
    left.append(r);
    return r;
  });
  root.append(left);

  root.append(el("div", { position: "absolute", left: `${overlay.x - 4}px`, top: `${overlay.y - 4}px`, width: `${overlay.w + 8}px`, height: `${overlay.h + 8}px`,
    boxSizing: "border-box", border: `2px solid ${C.line}`, borderRadius: "10px", background: "#000" }));

  const right = el("div", { position: "absolute", left: "1290px", top: "170px", width: "560px" });
  right.append(el("div", { fontFamily: sans, fontSize: "30px", color: C.text, marginBottom: "28px" }, tr(lang, T.from)));
  for (const f of ["characters.geml", "script.geml", "library.geml", "cut.geml"]) right.append(el("div", { fontFamily: mono, fontSize: "28px", color: C.accent, lineHeight: "2.1" }, f));
  const done = evidence("evidence-ep-todo-done").trimEnd().split("\n").at(-1);
  const ok = evidence("evidence-ep-check").trimEnd().split("\n").at(-1);
  const status = el("div", { marginTop: "40px" });
  status.append(el("div", { fontFamily: mono, fontSize: "24px", color: C.ok, lineHeight: "2.0" }, done), el("div", { fontFamily: mono, fontSize: "24px", color: C.ok, lineHeight: "2.0" }, ok));
  right.append(status);
  root.append(right);
  return { head, left, how, right };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.left, t, 0.2);
    s.how.forEach((r, i) => fadeIn(r, t, 0.6 + i * 0.25, 0.3, 6));
    fadeIn(s.right, t, 1.4);
  },
};
