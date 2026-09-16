// 一份时间线文档 + 一份样式表 → 一张能直接双击打开的静态页，里面就是**播出来的成片**。
//
// 和扩展里跑的是同一段代码：renderPage + MEDIA_COMPONENTS。区别只有一处 —— 静态页
// 没有 rAF，组件不会自驱，所以这里把 drivePlayer 的源码原样内联进 <script>。
// 一份源码，两个宿主；改了行为不会只改到一边。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "../../../geml-parser/dist/geml.js";
import { loadStylesheet, resolveStyle } from "../src/parse-entry.js";
import { renderBlock, collectLabels } from "../src/render.js";
import { cssForPage, renderPage } from "../src/layout.js";
import { createState, COMPONENTS } from "../src/components.js";
import { producersOf } from "../src/style-entry.js";
import { MEDIA_COMPONENTS } from "../src/media.js";
import { drivePlayer } from "../src/media-player.js";
import { parseHTML } from "linkedom";

const [, , rootArg, cutArg, sheetArg, outArg] = process.argv;
if (!rootArg || !cutArg) {
  console.error("usage: node tools/media-page.mjs <root> <cut.geml 相对根> [style.geml] [out.html]");
  process.exit(2);
}
const root = resolve(rootArg);
const read = (rel) => readFileSync(join(root, rel), "utf8");

// 语料：时间线自己，加上它引用到的每一份文档。引用是有方向的，所以从时间线出发扫。
const cutDoc = parse(read(cutArg));
const corpus = [{ path: cutArg.split("\\").join("/"), doc: cutDoc }];
const seen = new Set([corpus[0].path]);
const refDir = dirname(cutArg).split("\\").join("/");
const joinRel = (dir, rel) => {
  const out = [];
  for (const s of (dir === "." ? [] : dir.split("/")).concat(rel.split("/"))) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop(); else out.push(s);
  }
  return out.join("/");
};
for (const b of cutDoc.children) {
  const src = b.kind === "block" && b.attrs ? b.attrs.src : undefined;
  if (typeof src !== "string" || !src.includes("#")) continue;
  const p = joinRel(refDir, src.slice(0, src.indexOf("#")));
  if (p === "" || seen.has(p)) continue;
  seen.add(p);
  try { corpus.push({ path: p, doc: parse(read(p)) }); } catch { console.error("note: 读不到 " + p); }
}
// 二跳：剧本里的角色卡。
for (const e of [...corpus]) {
  for (const b of e.doc.children) {
    for (const k of ["speaker", "to", "of"]) {
      const v = b.kind === "block" && b.attrs ? b.attrs[k] : undefined;
      if (typeof v !== "string" || !v.includes("#")) continue;
      const p = joinRel(dirname(e.path).split("\\").join("/"), v.slice(0, v.indexOf("#")));
      if (p === "" || seen.has(p)) continue;
      seen.add(p);
      try { corpus.push({ path: p, doc: parse(read(p)) }); } catch { /* 缺就缺 */ }
    }
  }
}

const SHEET = sheetArg ? read(sheetArg) : `=== meta
title = "成片视图"
profile = "geml-style/v1"
===

=== style-screen {#play axis=column component=player slots="#video, #dialogue, #subtitle"}
===

=== style-frame {#video axis=row component=timeline-track slots="media-clip[track=video]" height="56px"}
===

=== style-frame {#dialogue axis=row component=timeline-track slots="media-clip[track=dialogue]" height="56px"}
===

=== style-frame {#subtitle axis=row component=timeline-track slots="media-clip[track=subtitle]" height="56px"}
===

=== style-rule {#clip-card match="media-clip" component=clip}
===
`;

const sheet = loadStylesheet(parse(SHEET));
const vm = resolveStyle(sheet, corpus);
const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
const state = createState(vm, document);
const out = renderPage(vm, cutDoc, document, {
  renderBlock, labels: collectLabels(cutDoc.children),
  components: { ...COMPONENTS, ...MEDIA_COMPONENTS },
  state, producers: producersOf(sheet), corpus, docPath: corpus[0].path,
});
if (out.error) { console.error("renderPage 失败: " + out.error); process.exit(1); }

const base = readFileSync(new URL("../src/geml.css", import.meta.url), "utf8");
const css = base + "\n" + (out.css || cssForPage(vm));
const shell = [
  "body{margin:0;background:#0b0d10;color:#cbd5e1;font:13px/1.5 system-ui,sans-serif}",
  ".geml-page{max-width:520px;margin:0 auto;padding:24px 16px}",
  ".geml-track{margin:0 0 6px;border-radius:6px;background:#101418;overflow:hidden}",
  ".geml-clip{padding:4px 6px;top:22px;height:30px;white-space:nowrap;background:#2b6cb0;color:#e8eef4;border-radius:4px;font-size:11px}",
  ".geml-track-ruler{position:absolute;inset:0 0 auto 0;height:18px;font:10px/18px ui-monospace,monospace;color:#64748b}",
  ".geml-tick{padding-left:3px;border-left:1px solid #334155}",
].join("\n");
const title = (cutDoc.children.find((b) => b.kind === "block" && b.type === "meta")?.data?.title) ?? cutArg;
const html = [
  "<!doctype html>", "<meta charset=\"utf-8\">",
  "<title>" + String(title) + " · 成片</title>",
  "<style>", shell, css, "</style>",
  out.root.outerHTML,
  "<script>(" + drivePlayer.toString() + ")(document.querySelector('.geml-player'))<" + "/script>",
].join("\n");
const dest = outArg ? resolve(outArg) : join(root, "play.html");
writeFileSync(dest, html, "utf8");
const n = (out.root.outerHTML.match(/geml-layer-/g) || []).length;
console.log("写好 " + dest + "（" + n + " 个媒体元素，" + out.unplaced + " 个块没被摆）");
