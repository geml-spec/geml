#!/usr/bin/env node
// 旁白不得超出所在镜头（设计 §6）。镜头时长是定值，旁白迁就画面：短了留静音，长了改词。
//
//   node tools/check-timing.mjs      超了就非零退出
import { pathToFileURL } from "node:url";
import { LEAD, GAP, realSource } from "./lay-cut.mjs";
import { LANGS } from "./lib/geml.mjs";

export function spans(lang, src) {
  return src.shots.map((s) => {
    const lines = src.lines(s.id, lang);
    const end = lines.length === 0 ? 0 : LEAD + lines.reduce((a, [, d]) => a + d, 0) + GAP * (lines.length - 1);
    return { shot: s.id, lang, end: Number(end.toFixed(3)), limit: s.duration, over: end > s.duration };
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const src = realSource();
    const rows = LANGS.flatMap((lang) => spans(lang, src));
    for (const r of rows) console.log(`${r.over ? "超" : "  "} ${r.shot} ${r.lang}  ${r.end.toFixed(2)}s / ${r.limit}s`);
    if (rows.some((r) => r.over)) process.exit(1);
  } catch (e) { console.error(e.message); process.exit(1); }
}
