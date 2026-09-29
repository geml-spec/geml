#!/usr/bin/env node
// 从剧本与素材库派生两份时间线。cut-*.geml 是这个工具的产物：手改会在下次运行时被覆盖。
//
//   node tools/lay-cut.mjs
//
// 规则（设计 §6）：主轨按分镜表顺排，每镜长度是定值；每镜的旁白从 LEAD 秒起、句与句
// 之间隔 GAP 秒，锚在本镜上；字幕与旁白同锚、同 offset，长度取旁白的实测时长。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, LANGS, shotTable, lineIds, blockAttrs, hasBlock } from "./lib/geml.mjs";

export const LEAD = 0.3;
export const GAP = 0.25;
/** 成片镜里，这一集从第几秒开始放（前后各留一点，让观众看清楚这是另一段片子）。 */
export const EP_AT = 1;
const r3 = (x) => Number(x.toFixed(3));
const TITLE = { zh: "中文版时间线", en: "英文版时间线" };

/** src：{ shots:[{id,duration}], lines:(shot,lang)=>[[lineId, seconds]…], hasBgm } —— 测试可以给假的。 */
export function layCut(lang, src) {
  const out = [
    "=== meta", `title = "geml-media 讲解片 · ${TITLE[lang]}"`, 'profile = "geml-media/v1"', "===", "",
    "%% 由 tools/lay-cut.mjs 从 script.geml 与 library.geml 派生，手改会被覆盖。", "",
    `==== media {#explainer-${lang} tracks="video:video narration:audio music:audio subtitle:prose" primary=video fps=30}`, "",
  ];
  const clip = (attrs) => out.push(`=== media-clip {${attrs}}`, "===", "");
  // 画面带步骤标题，所以每种语言各有一套镜头（设计 §3）。
  for (const s of src.shots) clip(`#v-${s.id} track=video src=library.geml#shot-${s.id}-${lang} in=0 out=${s.duration}`);
  // 配乐：成片镜要让出来（那一集有自己的配乐）。按成片镜切成几段；每段从文件里对应的位置接着放，
  // 不从头重播。
  if (src.hasBgm) {
    const start = []; let acc = 0;
    for (const s of src.shots) { start.push(acc); acc += s.duration; }
    const total = r3(acc);
    const segs = []; let from = null;
    src.shots.forEach((s, i) => {
      if (s.voice === "成片") { if (from !== null) segs.push([from, i]); from = null; }
      else if (from === null) from = i;
    });
    if (from !== null) segs.push([from, src.shots.length]);
    const whole = segs.length === 1 && segs[0][0] === 0 && segs[0][1] === src.shots.length;
    segs.forEach(([a, b], k) => {
      const inAt = r3(start[a]), outAt = b < src.shots.length ? r3(start[b]) : total;
      const fin = a === 0 ? 1 : 1.5, fout = b === src.shots.length ? 3 : 1.5;
      clip(`#music${whole ? "" : `-${k + 1}`} track=music src=library.geml#bgm over=#v-${src.shots[a].id} in=${inAt} out=${outAt} gain=-20dB fade-in=${fin} fade-out=${fout}`);
    });
  }
  for (const s of src.shots.filter((x) => x.voice === "成片")) {
    clip(`#ep-audio-${s.id} track=narration src=library.geml#ep-audio over=#v-${s.id} offset=${EP_AT}`);
  }
  for (const s of src.shots) {
    let at = LEAD;
    src.lines(s.id, lang).forEach(([id, dur], k) => {
      const n = k + 1;
      clip(`#n-${s.id}-${n} track=narration src=library.geml#${id.replace(/^vo-/, "voice-")} over=#v-${s.id} offset=${r3(at)}`);
      clip(`#t-${s.id}-${n} track=subtitle src=script.geml#${id} over=#v-${s.id} offset=${r3(at)} duration=${r3(dur)}`);
      at += dur + GAP;
    });
  }
  out.push("====", "");
  return out.join("\n");
}

/** 从真实文档读出 layCut 要的输入。旁白还没做的，直接报错叫人先跑 make-voice。 */
export function realSource(root = ROOT) {
  return {
    shots: shotTable(root),
    hasBgm: hasBlock("library.geml", "bgm", root),
    lines: (shot, lang) => lineIds(shot, lang, root).map((id) => {
      const asset = id.replace(/^vo-/, "voice-");
      if (!hasBlock("library.geml", asset, root)) throw new Error(`#${asset} 还没有：先跑 node tools/make-voice.mjs`);
      return [id, Number(blockAttrs("library.geml", asset, root).duration)];
    }),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const src = realSource();
    for (const lang of LANGS) {
      writeFileSync(join(ROOT, `cut-${lang}.geml`), layCut(lang, src));
      console.log(`wrote cut-${lang}.geml`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
