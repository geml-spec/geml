// S01 · 你的流水线今天长这样：飞书表格里的分镜脚本表、按命名规则摆的素材、群里的追问。
// 画的是调研里那篇飞书文章描述的做法（分镜脚本表 13 个字段、episode_scene_shot 命名、
// pending/running/success/failed 任务状态），不是某个真实团队的截图。
import { C, el, once, prog, mix, text, tr, mono, sans } from "./lib.js";
import { heading, panel, header, fadeIn, caption } from "./kit.js";
import { ACT } from "./acts.js";

export const uses = [];

const T = {
  title: { zh: "你的流水线今天长这样", en: "Your pipeline today" },
  sheet: { zh: "分镜脚本表 · 13 个字段", en: "Storyboard sheet · 13 fields" },
  folder: { zh: "素材目录 · 按 episode_scene_shot 命名", en: "Asset folder · named episode_scene_shot" },
  chat: { zh: "制作群", en: "Team chat" },
  src: { zh: "做法取自调研：《AI 漫剧制作太费人？用 OpenClaw 跑通 AI 漫剧全流程生产》（飞书）", en: "Practice as described in our research: a Feishu article on running an AI manju pipeline with OpenClaw" },
};
const COLS = { zh: ["镜号", "景别", "运镜", "时长", "画面", "台词", "提示词", "参考图", "状态", "…"], en: ["Shot", "Size", "Move", "Len", "Picture", "Line", "Prompt", "Ref", "Status", "…"] };
const ROWS = {
  zh: [["s01", "远景", "拉远", "5s", "雨夜天台", "旁白", "2D 手绘…", "hero_v3", "success"], ["s02", "特写", "推近", "5s", "猛然睁眼", "旁白", "2D 手绘…", "hero_v3", "success"],
    ["s03", "中景", "横移", "6s", "镜前", "林夏", "2D 手绘…", "hero_v2?", "failed"], ["s04", "中景", "推近", "6s", "端汤进门", "林岚", "2D 手绘…", "sister_v1", "running"],
    ["s05", "双人", "缓推", "7s", "递汤", "林夏", "2D 手绘…", "?", "pending"]],
  en: [["s01", "Wide", "Pull", "5s", "Rooftop", "V.O.", "cel 2D…", "hero_v3", "success"], ["s02", "Close", "Push", "5s", "Eyes open", "V.O.", "cel 2D…", "hero_v3", "success"],
    ["s03", "Med", "Pan", "6s", "Mirror", "Xia", "cel 2D…", "hero_v2?", "failed"], ["s04", "Med", "Push", "6s", "Soup", "Lan", "cel 2D…", "sister_v1", "running"],
    ["s05", "Two", "Slow", "7s", "Handing", "Xia", "cel 2D…", "?", "pending"]],
};
const STATUS = { success: C.ok, failed: C.bad, running: C.accent, pending: C.dim };
const FILES = ["ep01_sc01_sh01_v3.png", "ep01_sc01_sh01_v3_final.png", "ep01_sc01_sh02_v2.png", "ep01_sc01_sh03_v5.png", "ep01_sc01_sh03_v5_改.png",
  "ep01_sc02_sh04_v1.png", "ep01_sc02_sh04_v1.mp4", "ep01_sc02_sh05_final_final.mp4", "ep01_vo_linlan_03.wav", "角色卡_林夏_最新.docx"];
const CHAT = {
  zh: ["@抽卡师 s03 出好了吗？", "失败三次了，换个种子？", "角色卡改了，哪些要重抽？？"],
  en: ["@prompt-team is s03 done?", "Failed three times. New seed?", "The character card changed. Which shots need redoing??"],
};

function build(root, lang) {
  const head = heading(root, lang, ACT.who, T.title);
  const sheet = panel(80, 150, 1060, 470, "#f7f7f5");
  const sh = el("div", { fontFamily: sans, fontSize: "20px", color: "#333", marginBottom: "14px" }, `📊 ${tr(lang, T.sheet)}`);
  sheet.append(sh);
  const grid = el("div", { display: "grid", gridTemplateColumns: "70px 70px 70px 60px 1fr 70px 110px 110px 110px 30px", fontFamily: sans, fontSize: "17px", color: "#222" });
  const cell = (s, style = {}) => el("div", { padding: "9px 8px", borderBottom: "1px solid #ddd", whiteSpace: "nowrap", overflow: "hidden", ...style }, s);
  for (const c of COLS[lang]) grid.append(cell(c, { fontWeight: "700", background: "#ecebe6" }));
  const rows = ROWS[lang].map((r) => {
    const cells = r.map((v, i) => cell(v, i === 8 ? { color: STATUS[v], fontWeight: "700", fontFamily: mono, fontSize: "15px" } : i === 6 || i === 7 ? { color: "#777" } : {}));
    cells.push(cell(""));
    grid.append(...cells);
    return cells;
  });
  sheet.append(grid);
  root.append(sheet);

  const folder = panel(1180, 150, 660, 470);
  folder.append(header(undefined, tr(lang, T.folder)));
  const files = FILES.map((f) => {
    const r = el("div", { fontFamily: mono, fontSize: "17px", color: C.code, lineHeight: "1.95", whiteSpace: "nowrap" }, `📄 ${f}`);
    folder.append(r);
    return r;
  });
  root.append(folder);

  const chat = panel(80, 660, 1760, 300);
  chat.append(header(undefined, tr(lang, T.chat)));
  const bubbles = CHAT[lang].map((m, i) => {
    const b = el("div", { display: "inline-block", fontFamily: sans, fontSize: "24px", color: C.text, background: i === 2 ? mix(C.panel, C.warn, 0.3) : "#232a38",
      borderRadius: "16px", padding: "12px 20px", margin: `0 0 14px ${i * 120}px` }, m);
    const row = el("div", {});
    row.append(b);
    chat.append(row);
    return row;
  });
  root.append(chat);
  const src = caption(80, 990, 1760, 16);
  Object.assign(src.style, { color: C.dim, fontWeight: "400" });
  text(src, tr(lang, T.src));
  root.append(src);
  return { head, sheet, rows, folder, files, chat, bubbles, src };
}

export default {
  render(t, root, { lang } = { lang: "zh" }) {
    const s = once(root, (r) => build(r, lang));
    s.head(t);
    fadeIn(s.sheet, t, 0.3);
    s.rows.forEach((cells, i) => cells.forEach((c) => { c.style.opacity = String(prog(t, 0.8 + i * 0.3, 1.1 + i * 0.3)); }));
    fadeIn(s.folder, t, 3.0);
    s.files.forEach((f, i) => { f.style.opacity = String(prog(t, 3.3 + i * 0.15, 3.6 + i * 0.15)); });
    fadeIn(s.chat, t, 6.0);
    s.bubbles.forEach((b, i) => fadeIn(b, t, 6.4 + i * 1.1, 0.4, 10));
    fadeIn(s.src, t, 1.0);
  },
};
