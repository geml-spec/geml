// `geml media …` 的动词（profile 文档 §6 / 设计记录 §6）。
//
// 七个动词，不是十四个：check 并进了核心 `geml check`（文档自己在 meta 里声明了
// profile，不该再要求调用者换命令名），prompt 并进了 `get --resolved` 的位置，
// stale 是 check 的一个过滤，preview 与出片分家，cast/stats 合成 report。
//
// 和 media-check 一样，这个模块不碰 node:fs —— 文件、哈希、以及**外部程序**
// （ffmpeg/ffprobe）全部走 MediaIO/MediaHost，由宿主给。
import { parse, type Block } from "./geml.js";
import { blocksOf, metaOf, splitRef, promptTextOf, type MediaIO, type Loaded } from "./media-check.js";
import { layout, type Timeline } from "./media-timeline.js";
import { drivePlayer } from "./media-player-runtime.js";

/** 宿主能做、而这个模块不能做的事：跑外部程序、写文件。 */
export interface MediaHost extends MediaIO {
  writeDoc(rel: string, text: string): void;
  /** 跑一个外部程序，返回 stdout；跑不了返回 null（可选依赖，缺了降级） */
  run?(cmd: string, args: string[]): string | null;
}

export interface Project {
  docs: Map<string, Loaded>;
  /** "doc#id" -> 块 */
  block: (ref: string, from: string) => { rel: string; b: Extract<Block, { kind: "block" }> } | null;
  assets: Map<string, { rel: string; b: Extract<Block, { kind: "block" }> }>;
  records: { rel: string; i: number; r: Record<string, unknown> }[];
  prompts: { rel: string; b: Extract<Block, { kind: "block" }> }[];
  lines: { rel: string; b: Extract<Block, { kind: "block" }> }[];
  clips: { rel: string; b: Extract<Block, { kind: "block" }> }[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

/**
 * 从入口出发，顺着 media 的引用把项目装进来。和检查器同一条路。
 *
 * 入口可以是**多个**：引用是有方向的 —— 素材库引用剧本，剧本不引用素材库 —— 所以
 * 从剧本出发看不见日志，`todo` 会把每条提示词都当成待办。项目级的动词因此收一个
 * 目录，由宿主把它下面的 .geml 全给进来。
 */
export function loadProject(entry: string | string[], io: MediaIO): Project {
  const docs = new Map<string, Loaded>();
  const load = (rel: string): Loaded | null => {
    if (docs.has(rel)) return docs.get(rel) as Loaded;
    const src = io.readDoc(rel);
    if (src === null) return null;
    const doc = parse(src);
    const l: Loaded = { rel, doc, meta: metaOf(doc) };
    docs.set(rel, l);
    return l;
  };
  const seen = new Set<string>();
  const queue = Array.isArray(entry) ? [...entry] : [entry];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const l = load(cur);
    if (l === null) continue;
    for (const b of blocksOf(l.doc)) {
      const refs: string[] = [];
      for (const k of ["src", "of", "speaker", "to"]) { const v = str(b.attrs[k]); if (v !== undefined && v.includes("#")) refs.push(v); }
      if (b.classes.includes("gen-log") && Array.isArray(b.value)) {
        for (const rec of b.value as Record<string, unknown>[]) {
          for (const k of ["output", "prompt"]) { const v = str(rec[k]); if (v !== undefined) refs.push(v); }
          for (const g of ["inputs", "prompt-refs"]) { const a = rec[g]; if (Array.isArray(a)) for (const it of a as Record<string, unknown>[]) { const v = str(it["ref"]); if (v !== undefined) refs.push(v); } }
        }
      }
      for (const r of refs) { const t = splitRef(r, cur); if (t !== null && !seen.has(t.doc)) queue.push(t.doc); }
    }
  }
  const assets = new Map<string, { rel: string; b: Extract<Block, { kind: "block" }> }>();
  const records: Project["records"] = [];
  const prompts: Project["prompts"] = [];
  const lines: Project["lines"] = [];
  const clips: Project["clips"] = [];
  for (const [rel, l] of docs) {
    for (const b of blocksOf(l.doc)) {
      if (b.type === "media-asset" && b.id !== undefined) assets.set(`${rel}#${b.id}`, { rel, b });
      if (b.type === "media-clip") clips.push({ rel, b });
      if (b.type === "media-text" && b.classes.includes("prompt")) prompts.push({ rel, b });
      if (b.type === "media-text" && b.classes.includes("line")) lines.push({ rel, b });
      if (b.classes.includes("gen-log") && Array.isArray(b.value)) {
        (b.value as Record<string, unknown>[]).forEach((r, i) => records.push({ rel, i, r }));
      }
    }
  }
  const block = (ref: string, from: string): { rel: string; b: Extract<Block, { kind: "block" }> } | null => {
    const t = splitRef(ref, from);
    if (t === null) return null;
    const l = docs.get(t.doc);
    if (l === undefined) return null;
    const b = blocksOf(l.doc).find((x) => x.id === t.id);
    return b === undefined ? null : { rel: t.doc, b };
  };
  return { docs, block, assets, records, prompts, lines, clips };
}

// ---------------------------------------------------------------------------
// todo —— 待办清单。它从文档**派生**，不是一份任务文件：没有人给 agent 写任务单，
// 它读事实。三类：没有产出的提示词、没有配音的台词、过期项。
// ---------------------------------------------------------------------------

export interface TodoItem {
  kind: "generate" | "voice";
  /** 要做的那件事的地址 */
  address: string;
  mode: string;
  /** 展开投射之后的提示词或台词文本 —— 发给模型的那串字 */
  prompt: string | null;
  refs: { ref: string; role?: string }[];
}

export function todo(entry: string | string[], io: MediaIO): TodoItem[] {
  const p = loadProject(entry, io);
  const out: TodoItem[] = [];
  const produced = new Set<string>();
  for (const rec of p.records) {
    const pr = str(rec.r["prompt"]);
    if (pr === undefined) continue;
    const t = splitRef(pr, rec.rel);
    if (t !== null) produced.add(`${t.doc}#${t.id}`);
  }
  const askedFor = (rel: string, b: Extract<Block, { kind: "block" }>): boolean =>
    b.id !== undefined && !produced.has(`${rel}#${b.id}`);

  for (const { rel, b } of p.prompts) {
    if (!askedFor(rel, b)) continue;
    const address = `${rel}#${b.id as string}`;
    // 参考图：库里 of= 指向本镜头角色、role 是 sheet/lora 的素材。镜号从 shot= 来。
    const refs: { ref: string; role?: string }[] = [];
    for (const [key, a] of p.assets) {
      const role = str(a.b.attrs["role"]);
      if (role === "sheet" || role === "lora" || role === "master") refs.push(role === undefined ? { ref: key } : { ref: key, role });
    }
    out.push({ kind: "generate", address, mode: "t2i", prompt: promptTextOf(address, "", io), refs });
  }
  for (const { rel, b } of p.lines) {
    if (!askedFor(rel, b)) continue;
    const address = `${rel}#${b.id as string}`;
    const speaker = str(b.attrs["speaker"]);
    const refs: { ref: string; role?: string }[] = [];
    if (speaker !== undefined) {
      const t = splitRef(speaker, rel);
      for (const [key, a] of p.assets) {
        if (str(a.b.attrs["role"]) !== "voice") continue;
        const of = str(a.b.attrs["of"]);
        if (of === undefined || t === null) continue;
        const ot = splitRef(of, a.rel);
        if (ot !== null && ot.doc === t.doc && ot.id === t.id) refs.push({ ref: key, role: "voice" });
      }
    }
    out.push({ kind: "voice", address, mode: "tts", prompt: promptTextOf(address, "", io), refs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// report —— 跨文档聚合产出 CSV，供全季文档 `table {src=…}` 引入。
// cast：角色 × 出现在哪些台词/提示词。 stats：每个提示词生成了几次、按模型分布。
// 这个动词是 §13 第 2 条（view 接多源）的替身；那条一旦落地，它可以整个消失。
// ---------------------------------------------------------------------------

const csv = (rows: string[][]): string =>
  rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(",")).join("\n") + "\n";

export function report(entry: string | string[], kind: "cast" | "stats", io: MediaIO): string {
  const p = loadProject(entry, io);
  if (kind === "cast") {
    const rows: string[][] = [["角色", "文档", "台词"]];
    for (const { rel, b } of p.lines) {
      const sp = str(b.attrs["speaker"]) ?? "";
      rows.push([sp, rel, "#" + (b.id ?? "")]);
    }
    return csv(rows);
  }
  const byPrompt = new Map<string, { n: number; models: Map<string, number> }>();
  for (const rec of p.records) {
    const pr = str(rec.r["prompt"]);
    if (pr === undefined) continue;
    const t = splitRef(pr, rec.rel);
    const key = t === null ? pr : `${t.doc}#${t.id}`;
    const e = byPrompt.get(key) ?? { n: 0, models: new Map<string, number>() };
    e.n += 1;
    const m = str(rec.r["model"]) ?? "?";
    e.models.set(m, (e.models.get(m) ?? 0) + 1);
    byPrompt.set(key, e);
  }
  const rows: string[][] = [["提示词", "生成次数", "按模型"]];
  for (const [k, e] of byPrompt) rows.push([k, String(e.n), [...e.models].map(([m, n]) => `${m}×${n}`).join(" ")]);
  return csv(rows);
}

// ---------------------------------------------------------------------------
// export —— 文档到文档的投射。preview 产出一份浏览器能直接逐段播放的 HTML，
// 其余是交换格式。出成片是另一件事（build），名字分开，因为依赖、失败模式、
// 产物类型全不同。
// ---------------------------------------------------------------------------

export type ExportFormat = "preview" | "player" | "srt" | "edl" | "otio" | "json";

/** 素材的固有时长与路径：从素材块读，宿主可以用 ffprobe 补。 */
function assetInfo(p: Project, io: MediaIO) {
  return (ref: string, from: string): { path?: string; duration?: number; kind?: string; text?: string } => {
    const hit = p.block(ref, from);
    if (hit === null) return {};
    if (hit.b.type === "media-asset") {
      const src = str(hit.b.attrs["src"]);
      const d = Number(str(hit.b.attrs["duration"]) ?? "");
      const dir = hit.rel.includes("/") ? hit.rel.slice(0, hit.rel.lastIndexOf("/")) : "";
      const out: { path?: string; duration?: number; kind?: string } = {};
      if (src !== undefined) out.path = dir === "" ? src : `${dir}/${src}`;
      if (Number.isFinite(d)) out.duration = d;
      // 种类从素材读，不在引用它的地方重说一遍 —— 同一件事有两个说法就会有一天不一致。
      const k = str(hit.b.attrs["kind"]);
      if (k !== undefined) out.kind = k;
      return out;
    }
    const text = promptTextOf(ref, from, io);
    return text === null ? {} : { text };
  };
}

const hhmmss = (t: number, sep = ",", ms = true): string => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return ms ? `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(Math.round((t % 1) * 1000), 3)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
};
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `-14dB` → 线性音量。播放器用它设 `el.volume`，出片那边交给 ffmpeg 的 `volume` 滤镜。 */
const dbToGain = (v: unknown): number => {
  const m = /^(-?\d+(?:\.\d+)?)\s*dB$/i.exec(String(v ?? "").trim());
  return m === null ? 1 : Math.round(Math.min(1, Math.pow(10, Number(m[1]) / 20)) * 1000) / 1000;
};

export function exportTimeline(entry: string, fmt: ExportFormat, io: MediaIO): string {
  const p = loadProject(entry, io);
  const src = io.readDoc(entry);
  if (src === null) return "";
  const info = assetInfo(p, io);
  const tl: Timeline = layout(src, { durationOf: (r) => info(r, entry).duration, kindOf: (r) => info(r, entry).kind });

  if (fmt === "json") return JSON.stringify(tl, null, 2) + "\n";

  // `--to player`：整条时间线合成**一个能播的面**，零 ffmpeg、零编码。
  //
  // 和 `--to preview` 的分别就是"成片"和"联系表"的分别：preview 一刀一个独立播放器、
  // 各播各的，用来核对素材；player 是一个舞台加一条走带，一个时钟推所有元素，看到的
  // 就是 `media build` 会出的那条片子（差距见设计 §10.1）。
  //
  // 时钟的源码原样内联——和 viewer 组件调的是同一个 `drivePlayer`，一份源码两个宿主。
  if (fmt === "player") {
    const zOf = (name: string): number => Math.max(0, tl.tracks.findIndex((t) => t.name === name));
    const cues: { start: number; end: number; text: string }[] = [];
    const layers: string[] = [];
    for (const c of tl.clips.sort((a, b) => a.start - b.start)) {
      const i = info(c.src, entry);
      if (c.kind === "prose") {
        cues.push({ start: c.start, end: c.start + c.duration, text: (i.text ?? "").replace(/\s+/g, " ").trim() });
        continue;
      }
      if (i.path === undefined) continue;
      const tag = c.kind === "audio" ? "audio" : "video";
      const attrs = [
        `class="geml-layer geml-layer-${c.kind}"`,
        `src="${esc(i.path)}"`, "preload=\"auto\"", "playsinline",
        `data-clip="${esc(c.id)}"`,
        `data-start="${c.start.toFixed(3)}"`,
        `data-end="${(c.start + c.duration).toFixed(3)}"`,
        `data-in="${c.in.toFixed(3)}"`,
        `data-gain="${dbToGain(c.attrs["gain"])}"`,
      ];
      // 画面轨静音：声音走声音轨，画面轨再出声就是两份。
      if (c.kind === "video") attrs.push("muted", `style="z-index:${zOf(c.track)}"`);
      for (const k of ["transition-in", "transition-out", "transition-duration", "fade-in", "fade-out", "xywh"]) {
        if (c.attrs[k] !== undefined) attrs.push(`data-${k}="${esc(c.attrs[k] as string)}"`);
      }
      layers.push(`  <${tag} ${attrs.join(" ")}></${tag}>`);
    }
    const aspect = p.docs.get(entry)?.meta.get("aspect");
    const ratio = typeof aspect === "string" && /^\d+:\d+$/.test(aspect) ? aspect.replace(":", " / ") : "16 / 9";
    const total = tl.duration.toFixed(3);
    return `<!doctype html>
<meta charset="utf-8">
<title>${esc(entry)} — player</title>
<style>
 body{margin:0;background:#0b0d10;color:#cbd5e1;font:14px/1.5 system-ui,sans-serif}
 .geml-player{max-width:min(92vw,520px);margin:24px auto;display:flex;flex-direction:column;gap:10px}
 .geml-stage{position:relative;width:100%;aspect-ratio:${ratio};background:#000;border-radius:8px;overflow:hidden}
 .geml-layer-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
 .geml-layer-audio{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
 .geml-caption{position:absolute;left:0;right:0;bottom:6%;padding:0 8%;text-align:center;color:#fff;
   text-shadow:0 1px 3px rgba(0,0,0,.9);line-height:1.4;pointer-events:none}
 .geml-transport{display:flex;align-items:center;gap:10px}
 .geml-play{width:2.2em;height:2.2em;border:1px solid currentColor;border-radius:50%;background:transparent;
   color:inherit;font:inherit;line-height:1;cursor:pointer}
 .geml-seek{flex:1;min-width:0}
 .geml-clock{font:12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.75;min-width:9ch;text-align:right}
</style>
<div class="geml-player" data-duration="${total}" data-captions="${esc(JSON.stringify(cues))}" tabindex="0">
 <div class="geml-stage">
${layers.join("\n")}
  <div class="geml-caption"></div>
 </div>
 <div class="geml-transport">
  <button class="geml-play" type="button" aria-label="播放/暂停">\u25B6</button>
  <input class="geml-seek" type="range" min="0" max="${total}" step="0.01" value="0">
  <span class="geml-clock">0:00.0</span>
 </div>
</div>
<script>
(${drivePlayer.toString()})(document.querySelector('.geml-player'));
<\/script>
`;
  }

  if (fmt === "srt") {
    // 字幕：prose 种类的轨，按时间排序，编号从 1 起。
    const subs = tl.clips.filter((c) => c.kind === "prose").sort((a, b) => a.start - b.start);
    return subs.map((c, i) => {
      const text = (info(c.src, entry).text ?? "").replace(/\s*\n\s*/g, " ").trim();
      return `${i + 1}\n${hhmmss(c.start)} --> ${hhmmss(c.start + c.duration)}\n${text}\n`;
    }).join("\n");
  }

  if (fmt === "edl") {
    // 一份人读得懂的 EDL：剪映没有公开 API，给它 clips 加 SRT 加这个。
    const rows = tl.clips.filter((c) => c.kind !== "prose").sort((a, b) => a.start - b.start);
    const head = `TITLE: ${entry}\nFCM: NON-DROP FRAME\n`;
    return head + rows.map((c, i) => {
      const n = String(i + 1).padStart(3, "0");
      const kind = c.kind === "audio" ? "AA" : "V";
      return `${n}  AX       ${kind}     C        ${hhmmss(c.in, ":", false)}:00 ${hhmmss(c.in + c.duration, ":", false)}:00 ${hhmmss(c.start, ":", false)}:00 ${hhmmss(c.start + c.duration, ":", false)}:00\n* FROM CLIP NAME: ${info(c.src, entry).path ?? c.src}\n`;
    }).join("");
  }

  if (fmt === "otio") {
    // OpenTimelineIO 的 JSON：行业交换标准，Premiere / Resolve 都能进。
    const rate = tl.fps > 0 ? tl.fps : 24;
    const rt = (t: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value: Math.round(t * rate) });
    const byTrack = new Map<string, typeof tl.clips>();
    for (const c of tl.clips) byTrack.set(c.track, [...(byTrack.get(c.track) ?? []), c]);
    const tracks = [...byTrack].map(([name, clips]) => ({
      OTIO_SCHEMA: "Track.1", name,
      kind: clips[0]?.kind === "audio" ? "Audio" : "Video",
      children: clips.sort((a, b) => a.start - b.start).map((c) => ({
        OTIO_SCHEMA: "Clip.1", name: c.id,
        media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: info(c.src, entry).path ?? c.src },
        source_range: { OTIO_SCHEMA: "TimeRange.1", start_time: rt(c.in), duration: rt(c.duration) },
      })),
    }));
    return JSON.stringify({ OTIO_SCHEMA: "Timeline.1", name: entry, tracks: { OTIO_SCHEMA: "Stack.1", children: tracks } }, null, 2) + "\n";
  }

  // preview：一份零依赖的 HTML。每个片段一个 <video>/<audio>，src 带 W3C Media
  // Fragments 的 `#t=in,out` —— 浏览器原生按时间片段播放，不需要任何库。
  const rows = tl.clips.sort((a, b) => a.start - b.start).map((c) => {
    const i = info(c.src, entry);
    const at = `${c.start.toFixed(2)}s`;
    if (c.kind === "prose") return `<div class="cue" data-start="${c.start}"><span class="t">${at}</span><p>${esc(i.text ?? "")}</p></div>`;
    const frag = `#t=${c.in.toFixed(2)},${(c.in + c.duration).toFixed(2)}`;
    const tag = c.kind === "audio" ? "audio" : "video";
    return `<div class="cue" data-start="${c.start}"><span class="t">${at}</span><${tag} controls preload="metadata" src="${esc(i.path ?? "")}${frag}"></${tag}></div>`;
  }).join("\n");
  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(entry)} — preview</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:2rem;max-width:52rem}
 .cue{display:flex;gap:.75rem;align-items:flex-start;margin:.5rem 0;padding:.5rem;border-left:3px solid #ccd}
 .t{font-variant-numeric:tabular-nums;color:#667;min-width:4.5rem}
 video,audio{max-width:24rem}
 p{margin:0}
 h1{font-size:1.1rem}
</style>
<h1>${esc(entry)} · ${tl.clips.length} 个片段 · 总长 ${tl.duration.toFixed(2)}s</h1>
${rows}
`;
}

// ---------------------------------------------------------------------------
// build —— 按时间模型出成片。唯一直接调用的外部程序是 ffmpeg：它通用、本地、
// 无 API、无账号，用法与 codemap 调 Joern 一致 —— 可选依赖，缺了降级并说清楚。
//
// 字幕**不烧进画面**，另出一份 .srt：烧字需要 libass 与一份中文字体，两者都不是
// 到处都有的东西，而一条在别人机器上必然失败的默认路径比没有更糟。
// ---------------------------------------------------------------------------

export interface BuildPlan {
  args: string[];
  /** 与成片同名的字幕边车，没有字幕轨时为 null */
  srt: string | null;
  duration: number;
  notes: string[];
}

export interface BurnSubs {
  /** 字幕文件路径，相对 ffmpeg 的工作目录 */
  file: string;
  /** libass 的 force_style，逗号分隔的键值对（这里按滤镜语法转义后再拼） */
  style?: string;
  /** 字体目录。Windows 上 libass 常找不到 fontconfig，指给它 */
  fontsdir?: string;
}

export interface BuildOpts {
  /** 把字幕烧进画面。默认不烧 —— 一份剪辑是文档，烧字是交付时的选择。 */
  burn?: BurnSubs;
}

// filtergraph 里一个选项值的转义。写成查表而不是正则：这段要经过 shell、heredoc 和
// 编辑器三道手，正则里的反斜杠被吃掉一次就会静默失效（这次就被吃掉过）。
const FG_SPECIAL = new Set([":", ",", "'", "[", "]", ";", String.fromCharCode(92)]);
const fgEsc = (s: string): string =>
  [...s].map((c) => (FG_SPECIAL.has(c) ? String.fromCharCode(92) + c : c)).join("");

export function buildPlan(entry: string, outFile: string, io: MediaIO, opts: BuildOpts = {}): BuildPlan {
  const p = loadProject(entry, io);
  const src = io.readDoc(entry) ?? "";
  const info = assetInfo(p, io);
  const tl = layout(src, { durationOf: (r) => info(r, entry).duration, kindOf: (r) => info(r, entry).kind });
  const notes = [...tl.problems];

  const video = tl.clips.filter((c) => c.kind === "video" && c.track === tl.primary).sort((a, b) => a.start - b.start);
  const audio = tl.clips.filter((c) => c.kind === "audio").sort((a, b) => a.start - b.start);
  const inputs: string[] = [];
  const idx = new Map<string, number>();
  const addInput = (path: string): number => {
    const had = idx.get(path);
    if (had !== undefined) return had;
    const n = inputs.length;
    inputs.push(path); idx.set(path, n);
    return n;
  };

  const filters: string[] = [];
  const vLabels: string[] = [];
  video.forEach((c, k) => {
    const path = info(c.src, entry).path;
    if (path === undefined) { notes.push(`片段 #${c.id} 的源没有文件路径，跳过`); return; }
    const i = addInput(path);
    filters.push(`[${i}:v]trim=start=${c.in.toFixed(3)}:end=${(c.in + c.duration).toFixed(3)},setpts=PTS-STARTPTS[v${k}]`);
    vLabels.push(`[v${k}]`);
  });
  const aLabels: string[] = [];
  audio.forEach((c, k) => {
    const path = info(c.src, entry).path;
    if (path === undefined) { notes.push("片段 #" + c.id + " 的源没有文件路径，跳过"); return; }
    const i = addInput(path);
    const delayMs = Math.round(c.start * 1000);
    // 电平与淡入淡出要真的施加。以前这条链只有 trim/asetpts/adelay —— 于是
    // `gain=-14dB` 的垫乐在浏览器里是小声的、在出片里是原声，同一份文档两个结果。
    // `volume` 直接收 dB，不必自己换算；`afade` 的时间是**片段内**的，所以裁剪之后、
    // 延迟之前施加。
    const steps = ["atrim=start=" + c.in.toFixed(3) + ":end=" + (c.in + c.duration).toFixed(3), "asetpts=PTS-STARTPTS"];
    const gain = c.attrs["gain"];
    if (gain !== undefined && gain !== "0dB") steps.push("volume=" + gain);
    const fadeIn = Number(c.attrs["fade-in"]);
    if (Number.isFinite(fadeIn) && fadeIn > 0) steps.push("afade=t=in:st=0:d=" + fadeIn);
    const fadeOut = Number(c.attrs["fade-out"]);
    if (Number.isFinite(fadeOut) && fadeOut > 0) {
      steps.push("afade=t=out:st=" + Math.max(0, c.duration - fadeOut).toFixed(3) + ":d=" + fadeOut);
    }
    // `all=1`：延迟施加到**所有**声道，不必知道源是单声道还是立体声。
    steps.push("adelay=" + delayMs + ":all=1");
    filters.push("[" + i + ":a]" + steps.join(",") + "[a" + k + "]");
    aLabels.push("[a" + k + "]");
  });
  if (vLabels.length > 0) filters.push(vLabels.join("") + "concat=n=" + vLabels.length + ":v=1:a=0[vout]");
  // 烧字幕。默认不烧：一份剪辑是文档，字幕是它的一条轨，烧进像素是**交付**时的选择
  // ——烧了就再也拆不开，而 srt 边车谁都能关掉。要烧才烧，并且烧的是同一份 srt。
  let vFinal = "[vout]";
  if (opts.burn !== undefined && vLabels.length > 0) {
    const bits = ["filename=" + fgEsc(opts.burn.file)];
    if (opts.burn.fontsdir !== undefined) bits.push("fontsdir=" + fgEsc(opts.burn.fontsdir));
    // force_style 里全是逗号分隔的键值对。**加引号，不要逐个转义逗号** —— 实测
    // `force_style=A\,B` 会让解析器在标签处断掉，`force_style='A,B'` 才对。
    if (opts.burn.style !== undefined) bits.push("force_style='" + opts.burn.style.split("'").join("") + "'");
    filters.push("[vout]subtitles=" + bits.join(":") + "[vsub]");
    vFinal = "[vsub]";
  }
  if (aLabels.length > 0) {
    // 音频要**贯穿全长**，否则交织器会停在最后一段音频结束的地方等下去 —— 实测
    // 一条 4.4s 才开始、6.5s 就结束的配音，让一条 10s 的片子卡死在 4.35s。所以先铺
    // 一条和时间线等长的静音底，再把每段配音混上去，duration=first 以底为准。
    const total = Math.max(tl.duration, 0.001).toFixed(3);
    filters.push("anullsrc=channel_layout=stereo:sample_rate=44100:d=" + total + "[abed]");
    filters.push("[abed]" + aLabels.join("") + "amix=inputs=" + (aLabels.length + 1) + ":duration=first:normalize=0[aout]");
  }

  const args: string[] = ["-y"];
  for (const p2 of inputs) { args.push("-i", p2); }
  if (filters.length > 0) args.push("-filter_complex", filters.join(";"));
  if (vLabels.length > 0) args.push("-map", vFinal);
  if (aLabels.length > 0) args.push("-map", "[aout]");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (aLabels.length > 0) args.push("-c:a", "aac");
  args.push(outFile);

  const hasSubs = tl.clips.some((c) => c.kind === "prose");
  return { args, srt: hasSubs ? exportTimeline(entry, "srt", io) : null, duration: tl.duration, notes };
}

// ---------------------------------------------------------------------------
// log —— 追加一条生成记录，**并更新目标素材块的 sha256 / duration**。
//
// 后半句是第一个真实用例挖出来的：只追加记录会让库里继续声称一个文件已经没有的
// 哈希，下一次 check 就是 media-hash-mismatch。对照 import 明写产出"素材块 + 日志
// 记录"两样，log 少了前一半。
// ---------------------------------------------------------------------------

export interface LogEntry { [k: string]: unknown }

/** 往一份素材库文本里追加一条记录，并把产出素材的 sha256 改成现值。返回新文本。 */
export function appendLog(librarySource: string, rec: LogEntry, assetSha?: { id: string; sha256: string; duration?: number }): string {
  const nl = librarySource.includes("\r\n") ? "\r\n" : "\n";
  const lines = librarySource.split(/\r?\n/);
  // 找 .gen-log 的开栏与它的收栏
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (/^={3,}\s+data\s*\{[^}]*\.gen-log/.test(l)) { open = i; break; }
  }
  if (open < 0) throw new Error("这份文档里没有 `data {.gen-log}` 块");
  const fence = /^(={3,})/.exec(lines[open] as string)?.[1] ?? "===";
  let close = -1;
  for (let i = open + 1; i < lines.length; i++) { if ((lines[i] as string).trim() === fence) { close = i; break; } }
  if (close < 0) throw new Error("`.gen-log` 块没有收栏");
  lines.splice(close, 0, JSON.stringify(rec));

  if (assetSha !== undefined) {
    // 不用正则找这一行：模板字符串里的 `` 是退格符、`s` 是 s —— 写出来的正则
    // 看着对、跑起来永不匹配，而失败是静默的（素材块不更新，下一次 check 才炸）。
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!line.startsWith("===") || !line.includes("media-asset")) continue;
      const brace = line.lastIndexOf("}");
      if (brace < 0) continue;
      const head = line.slice(0, brace);
      const marker = "#" + assetSha.id;
      const at = head.indexOf(marker);
      if (at < 0) continue;
      const after = head.charAt(at + marker.length);
      if (after !== "" && after !== " " && after !== "\t") continue;   // #a 不该匹配 #abc
      let next = head.includes("sha256=")
        ? head.replace(/sha256=[^\s}]*/, "sha256=" + assetSha.sha256)
        : head + " sha256=" + assetSha.sha256;
      if (assetSha.duration !== undefined) {
        next = next.includes("duration=")
          ? next.replace(/duration=[^\s}]*/, "duration=" + String(assetSha.duration))
          : next + " duration=" + String(assetSha.duration);
      }
      lines[i] = next + "}";
      break;
    }
  }
  return lines.join(nl);
}

// ---------------------------------------------------------------------------
// lay —— 按一个镜头里台词的文档顺序与各配音的时长，算出配音刀与字幕刀的
// offset / dur。工具给初值，人再改：「开口前停半秒」「两句叠一点」是表演，不是算法。
// ---------------------------------------------------------------------------

export interface LaySuggestion { id: string; offset: number; dur?: number }

export function lay(entry: string, anchorId: string, io: MediaIO, gap = 0.2): LaySuggestion[] {
  const p = loadProject(entry, io);
  const src = io.readDoc(entry);
  if (src === null) return [];
  const info = assetInfo(p, io);
  const tl = layout(src, { durationOf: (r) => info(r, entry).duration, kindOf: (r) => info(r, entry).kind });
  const anchor = tl.clips.find((c) => c.id === anchorId.replace(/^#/, ""));
  if (anchor === undefined) return [];
  // 锚在这个镜头上的非主轨片段，按文档顺序（clips 里的原序由 layout 保持在 id 上）
  const mine = p.clips
    .map(({ b }) => b)
    .filter((b) => (str(b.attrs["over"]) ?? "").replace(/^#/, "") === anchor.id && b.id !== undefined);
  const out: LaySuggestion[] = [];
  let t = 0;
  for (const b of mine) {
    const placed = tl.clips.find((c) => c.id === b.id);
    const len = placed?.duration ?? info(str(b.attrs["src"]) ?? "", entry).duration ?? 0;
    const s: LaySuggestion = { id: b.id as string, offset: Number(t.toFixed(2)) };
    if ((tl.tracks.find((x) => x.name === (str(b.attrs["track"]) ?? ""))?.kind) === "prose") s.dur = Number(len.toFixed(2));
    out.push(s);
    t += len + gap;
  }
  return out;
}

// ---------------------------------------------------------------------------
// import —— 回填：生成平台导出的清单（文件、模型、种子、提示词）→ 素材块 + 日志记录。
// 对方不需要知道 GEML 的存在，只要能写 JSON。
// ---------------------------------------------------------------------------

export interface ManifestItem {
  file: string; model: string; mode: string;
  prompt?: string; inputs?: { ref: string; role?: string }[];
  seed?: number; params?: Record<string, unknown>; at?: string; cost?: number; error?: string;
}

export interface ImportPlan {
  /** 要新建的素材块（已按 sha256 去重：同哈希的复用既有块） */
  newAssets: { id: string; src: string; sha256: string; kind: string }[];
  records: LogEntry[];
  notes: string[];
}

const kindFromExt = (f: string): string => {
  const e = (f.split(".").pop() ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(e)) return "image";
  if (["mp4", "mov", "webm", "mkv"].includes(e)) return "video";
  if (["wav", "mp3", "m4a", "flac", "ogg"].includes(e)) return "audio";
  if (["safetensors", "ckpt", "pt"].includes(e)) return "model";
  return "other";
};

export function importPlan(entry: string, items: ManifestItem[], io: MediaIO): ImportPlan {
  const p = loadProject(entry, io);
  const byHash = new Map<string, string>();      // sha256 -> 既有素材的 id
  for (const [key, a] of p.assets) {
    const h = str(a.b.attrs["sha256"]);
    if (h !== undefined) byHash.set(h, key.slice(key.indexOf("#") + 1));
  }
  const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : "";
  const newAssets: ImportPlan["newAssets"] = [];
  const records: LogEntry[] = [];
  const notes: string[] = [];
  for (const it of items) {
    const rel = dir === "" ? it.file : `${dir}/${it.file}`;
    const sha = io.hashFile(rel);
    if (sha === null) { notes.push(`清单里的 ${it.file} 读不到，跳过`); continue; }
    let id = byHash.get(sha);
    if (id === undefined) {
      id = (it.file.split("/").pop() ?? it.file).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-");
      newAssets.push({ id, src: it.file, sha256: sha, kind: kindFromExt(it.file) });
      byHash.set(sha, id);
    } else {
      notes.push(`${it.file} 的哈希与既有的 #${id} 相同，复用它而不新建`);
    }
    const rec: LogEntry = { output: "#" + id, "output-sha256": sha, model: it.model, mode: it.mode, at: it.at ?? new Date().toISOString() };
    if (it.prompt !== undefined) {
      rec["prompt"] = it.prompt;
      const text = promptTextOf(it.prompt, entry, io);
      if (text !== null) rec["prompt-sha256"] = io.hashText(text);
      else notes.push(`展不开提示词 ${it.prompt}，这条记录没有 prompt-sha256`);
    }
    if (it.inputs !== undefined) {
      rec["inputs"] = it.inputs.map((x) => {
        const hit = p.block(x.ref, entry);
        const h = hit === null ? undefined : str(hit.b.attrs["sha256"]);
        return h === undefined ? x : { ...x, sha256: h };
      });
    }
    for (const k of ["seed", "params", "cost", "error"] as const) if (it[k] !== undefined) rec[k] = it[k];
    records.push(rec);
  }
  return { newAssets, records, notes };
}

// ---------------------------------------------------------------------------
// import 的格式判定：**看后缀**，不要求调用者说自己带的是什么。
//
// 字幕是其中一种，不是全部：一次生成跑完，手上可能是一份清单、一堆文件、或者别处
// 来的一份 srt。让调用者先回答"这是什么格式"没有道理 —— 文件名已经说了。
// ---------------------------------------------------------------------------

export type ImportKind = "manifest" | "subtitles" | "asset" | "timeline" | "unknown";

const EXT = (p: string): string => { const i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i + 1).toLowerCase(); };

export function importKindOf(path: string): ImportKind {
  const e = EXT(path);
  if (e === "json") return "manifest";
  if (e === "srt" || e === "vtt") return "subtitles";
  // NLE 回写是 §13 的待讨论项，v1 不做 —— 但要认出它并说清楚，不能混进 unknown。
  if (e === "otio" || e === "fcpxml" || e === "edl" || e === "xml") return "timeline";
  if (["mp4", "mov", "webm", "mkv", "wav", "mp3", "m4a", "flac", "ogg", "png", "jpg", "jpeg", "webp", "gif", "safetensors", "ckpt", "pt"].includes(e)) return "asset";
  return "unknown";
}

export interface Cue { start: number; end: number; text: string }

/**
 * srt / vtt → 字幕条目。两种格式的差别只有时间分隔符（`,` 与 `.`）和一行 WEBVTT 头，
 * 所以一个解析器收两种；分不清的行跳过并计数，不猜。
 */
export function parseCues(text: string): { cues: Cue[]; skipped: number } {
  const t = (s: string): number | null => {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
    if (m === null) return null;
    return (m[1] === undefined ? 0 : Number(m[1])) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] as string).padEnd(3, "0")) / 1000;
  };
  const cues: Cue[] = [];
  let skipped = 0;
  for (const block of text.replace(/^﻿/, "").split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (/^WEBVTT/.test(lines[0] as string)) { lines.shift(); if (lines.length === 0) continue; }
    let i = 0;
    if (!(lines[i] as string).includes("-->")) i++;          // 序号行，vtt 里可能没有
    const time = lines[i];
    if (time === undefined || !time.includes("-->")) { skipped++; continue; }
    const [a, b] = time.split("-->");
    const start = t(a ?? ""), end = t((b ?? "").trim().split(/\s/)[0] ?? "");
    if (start === null || end === null) { skipped++; continue; }
    const body = lines.slice(i + 1).join(" ").trim();
    if (body === "") { skipped++; continue; }
    cues.push({ start, end, text: body });
  }
  return { cues, skipped };
}

export interface SubtitleImport {
  /** 要写进剧本的台词块（GEML 文本） */
  lines: string;
  /** 要写进时间线的字幕片段（GEML 文本）；没给 cut 时为 null */
  clips: string | null;
  /** 新块占用的 id，交给调用者查重 */
  ids: string[];
  notes: string[];
}

export interface SubtitleOpts {
  /** id 前缀：台词是 `<前缀>1`，字幕片段是 `sub-<前缀>1` */
  idPrefix: string;
  /** 台词块所在文档，写成从 cut 出发的路径；同一份文档时给空串 */
  srcDoc: string;
  /** 时间线文档（相对根）；给 null 就只出台词块 */
  cutEntry: string | null;
  track?: string;
  /** 说话的人。srt 里没有这个信息，给了才写成 `.line`（台词），不给就是一条无名字幕。 */
  speaker?: string;
}

/**
 * srt/vtt → 台词块 + 字幕片段。
 *
 * **导入，不是挂载。** 转完之后文档是唯一的源，srt 只是它的来处 —— 一份外挂 srt 会是
 * 同一段文字的第二份拷贝，还自带一套时间，与时间线的 over=/offset= 争"这句话什么时候
 * 出现"。所以这里把它化进文档，而不是让字幕轨去指一个文件。
 *
 * 时间的落点：srt 的时刻是绝对的，字幕片段是锚定的。按每条字幕的起点找出那一刻在播的
 * 主轨片段，写成 `over=#那一刀 offset=差值` —— 这样主轨插一个片段时字幕跟着走。找不到
 * 就退回 `at=`（绝对起点，逃生口），并说出来。
 */
export function importSubtitles(srtText: string, opts: SubtitleOpts, io: MediaIO): SubtitleImport {
  const { cues, skipped } = parseCues(srtText);
  const notes: string[] = [];
  if (skipped > 0) notes.push(String(skipped) + " 条读不出时间或正文，已跳过");
  if (cues.length === 0) return { lines: "", clips: null, ids: [], notes: [...notes, "没有解析出任何字幕"] };

  const lineId = (i: number): string => opts.idPrefix + String(i + 1);
  const ids = cues.map((_, i) => lineId(i));
  const lines = cues.map((c, i) =>
    "=== media-text {#" + lineId(i)
    + (opts.speaker === undefined ? "" : " .line speaker=" + opts.speaker)
    + "}\n" + c.text + "\n===\n").join("\n");
  if (opts.speaker === undefined) notes.push("没给 --speaker，台词块没写成 .line —— srt 不带说话人，编出一个不如不写");

  if (opts.cutEntry === null) {
    notes.push("没给 --cut，只产出台词块；字幕片段要知道主轨才能锚");
    return { lines, clips: null, ids, notes };
  }
  const src = io.readDoc(opts.cutEntry);
  if (src === null) return { lines, clips: null, ids, notes: [...notes, "读不到 " + opts.cutEntry] };
  const p = loadProject(opts.cutEntry, io);
  const info = assetInfo(p, io);
  const cut = opts.cutEntry;
  const tl = layout(src, { durationOf: (r) => info(r, cut).duration, kindOf: (r) => info(r, cut).kind });
  const primary = tl.clips.filter((c) => c.track === tl.primary).sort((a, b) => a.start - b.start);
  if (primary.length === 0) notes.push("时间线主轨上没有片段，字幕只能用绝对起点 at=");

  const round = (n: number): number => Math.round(n * 1000) / 1000;
  let loose = 0;
  const clips = cues.map((c, i) => {
    const id = "sub-" + lineId(i);
    ids.push(id);
    const dur = Math.max(0.1, round(c.end - c.start));
    const anchor = primary.find((x) => c.start >= x.start && c.start < x.start + x.duration);
    const head = "=== media-clip {#" + id + " track=" + (opts.track ?? "subtitle")
      + " src=" + opts.srcDoc + "#" + lineId(i);
    if (anchor === undefined) {
      loose++;
      return head + " at=" + c.start.toFixed(3) + " duration=" + String(dur) + "}\n===\n";
    }
    return head + " over=#" + anchor.id + " offset=" + String(round(c.start - anchor.start))
      + " duration=" + String(dur) + "}\n===\n";
  }).join("\n");
  if (loose > 0) notes.push(String(loose) + " 条落在主轨之外，用了绝对起点 at=（主轨一改就会错位）");
  return { lines, clips, ids, notes };
}

/** 一个媒体文件 → 一个素材块。时长由宿主读（有 ffprobe 才是真值），读不到就不写。 */
export function assetBlockFor(src: string, id: string, sha256: string | null, duration?: number): string {
  const d = duration === undefined || !Number.isFinite(duration) ? "" : " duration=" + String(Math.round(duration * 1000) / 1000);
  return "=== media-asset {#" + id + " src=" + src
    + (sha256 === null ? "" : " sha256=" + sha256)
    + " kind=" + kindFromExt(src) + d + " origin=generated}\n===\n";
}

/** 文件名 → 一个能当 id 用的名字。与 importPlan 用的是同一条规则。 */
export function idFromFile(file: string): string {
  return (file.split("/").pop() ?? file).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-");
}

/** 文档里已经占掉的 id —— 插块之前查一遍，撞了就停，不覆盖别人的东西。 */
export function idsTaken(text: string, want: string[]): string[] {
  const has = new Set<string>();
  for (const m of text.matchAll(/\{[^}\n]*#([A-Za-z0-9_-]+)/g)) has.add(m[1] as string);
  return want.filter((w) => has.has(w));
}
