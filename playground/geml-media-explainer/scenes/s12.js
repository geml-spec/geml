// S12 · 开始用：这一集和这支片子的源文件，上手的命令，最后停在字标上。
import { C, el, once, prog, text, tr, mono, sans } from "./lib.js";
import { heading, panel, header, terminal, caption, fadeIn } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = [];

const T = {
  title: { zh: "开始用", en: "Get started" },
  src: { zh: "这一集与这支片子的源文件", en: "The episode's and this video's sources" },
  start: { zh: "照着跑一遍", en: "Run it yourself" },
  notes: {
    ep: { zh: "《重生之夜》第一集", en: "the episode" },
    ex: { zh: "这支讲解片", en: "this video" },
    tools: { zh: "Agent 用的工具", en: "the agent's tools" },
  },
};
const REPO = "github.com/geml-spec/geml";

function build(root, lang) {
  const head = heading(root, lang, ACT.more, T.title);
  const n = (k) => tr(lang, T.notes[k]);
  const tree = [["playground/geml-media-explainer/", ""], ["├─ episode/", n("ep")], ["│  ├─ story.md  characters.geml", ""], ["│  ├─ script.geml  library.geml", ""],
    ["│  └─ cut.geml  assets/", ""], ["├─ script.geml  library.geml", n("ex")], ["├─ cut-zh.geml  cut-en.geml", ""], ["└─ tools/", n("tools")]];
  const left = panel(80, 150, 860, 700);
  left.append(header(undefined, tr(lang, T.src)));
  const rows = tree.map(([f, note]) => {
    const r = el("div", { display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: "21px", lineHeight: "2.0", whiteSpace: "pre" });
    r.append(el("span", { color: C.text }, f), el("span", { color: C.dim, fontFamily: sans, fontSize: "19px" }, note));
    left.append(r);
    return r;
  });
  root.append(left);
  const right = panel(980, 150, 860, 420, "#07080b");
  right.append(header(undefined, tr(lang, T.start)));
  const cmds = ["$ npm i -g @geml/geml", "$ git clone https://github.com/geml-spec/geml", "$ cd geml/playground/geml-media-explainer", "$ node tools/produce-episode.mjs"];
  const term = terminal(cmds.map((c, i) => ({ at: 3.6 + i * 0.9, text: c, cps: 55 })), { fontSize: 21, lineHeight: 2.0, wrap: true });
  right.append(term.box);
  root.append(right);
  const repo = caption(980, 640, 860, 46);
  Object.assign(repo.style, { fontFamily: mono, color: C.accent });
  text(repo, REPO);
  const tag = caption(980, 720, 860, 28);
  Object.assign(tag.style, { color: C.dim, fontWeight: "400" });
  text(tag, "npm · @geml/geml");
  root.append(repo, tag);
  const mark = el("div", { position: "absolute", left: "0", top: "440px", width: "1920px", textAlign: "center", opacity: "0" });
  mark.append(el("div", { fontFamily: mono, fontSize: "96px", fontWeight: "700", color: C.text }, "geml-media"),
    el("div", { fontFamily: mono, fontSize: "30px", color: C.accent, marginTop: "18px" }, REPO));
  root.append(mark);
  const rest = [...root.children].filter((e) => e !== mark);
  return { head, left, rows, right, term, repo, tag, mark, rest };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.left, t, 0.2);
    s.rows.forEach((r, i) => fadeIn(r, t, 0.5 + i * 0.18, 0.3, 6));
    fadeIn(s.right, t, 3.2);
    s.term.update(t);
    fadeIn(s.repo, t, 7.6);
    fadeIn(s.tag, t, 8.0);
    const out = prog(t, 10.6, 11.1);
    if (out > 0) for (const e of s.rest) e.style.opacity = String(Math.min(Number(e.style.opacity || 1), 1 - out));
    s.mark.style.opacity = String(prog(t, 11.0, 11.5));
  },
};
