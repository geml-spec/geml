// 时间模型（profile 文档 §3.2）。预览、出片、导出三者共用这一份计算 —— 时间线上
// 每个片段从第几秒开始、持续多久，只能有一个答案。
//
//   · 主轨（meta.primary，缺省 video）是**顺序的**：文档顺序就是播放顺序。第 i 个
//     片段的起点 = 第 i-1 个的终点，减去它 transition-in 声明的重叠量（cut 为 0，
//     dissolve/crossfade 为 transition-dur，fade 不重叠）。第一个从 0 开始。
//   · 一个片段的时长 = out - in，无固有时长的源则是 dur，再除以 speed。
//   · 其余轨是**锚定的**：起点 = over 那个片段的起点 + offset。在主轨插一个片段，
//     后面所有锚定的字幕、配音、音乐跟着走 —— 锚在内容上，不锚在数字上。
import { parse, type Block, type Document } from "./geml.js";

export interface PlacedClip {
  id: string;
  track: string;
  kind: string;
  /** 片段引用的块：素材或散文块 */
  src: string;
  /** 时间线上的起点与时长，秒 */
  start: number;
  duration: number;
  /** 源内的入点（无固有时长的源为 0） */
  in: number;
  attrs: Record<string, string>;
}

export interface Timeline {
  fps: number;
  primary: string;
  tracks: { name: string; kind: string }[];
  clips: PlacedClip[];
  /** 整条时间线的总长：所有片段终点的最大值 */
  duration: number;
  problems: string[];
}

const num = (v: unknown, dflt?: number): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return dflt;
  const s = v.trim();
  // `hh:mm:ss:ff` 时码 —— 帧数按 meta.fps 换算，由调用方先乘好
  if (/^\d+:\d\d:\d\d(:\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : dflt;
};

/** `hh:mm:ss:ff` → 秒。fps 缺失时返回 undefined（时码没有基准就没有意义）。 */
export function timecodeToSeconds(tc: string, fps: number | undefined): number | undefined {
  const m = /^(\d+):(\d\d):(\d\d)(?::(\d+))?$/.exec(tc.trim());
  if (m === null) return undefined;
  const [h, mi, s, f] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 0 : Number(m[4])];
  if (f !== 0 && (fps === undefined || fps <= 0)) return undefined;
  return h * 3600 + mi * 60 + s + (fps === undefined || fps <= 0 ? 0 : f / fps);
}

const time = (v: unknown, fps: number | undefined): number | undefined => {
  if (typeof v === "string" && v.includes(":")) return timecodeToSeconds(v, fps);
  return num(v);
};

const OVERLAP = new Set(["dissolve", "crossfade"]);

/**
 * 把一份时间线文档算成摆好位置的片段表。
 *
 * `durationOf(ref)` 由调用方给：素材的固有时长从哪来是宿主的事（素材块的
 * `duration=`，或本机 ffprobe 读出来的真值）。算时间的这一段不碰文件系统。
 */
export function layout(
  cutSource: string,
  opts: { durationOf: (srcRef: string) => number | undefined },
): Timeline {
  return layoutDoc(parse(cutSource), opts);
}

/** 同上，但收一份**已经解析好**的文档 —— viewer 手上就有，不必再解析一遍。 */
export function layoutDoc(
  doc: Document,
  opts: { durationOf: (srcRef: string) => number | undefined },
): Timeline {
  const meta = new Map<string, string>();
  for (const b of doc.children) {
    if (b.kind === "block" && b.type === "meta" && b.data) for (const [k, v] of Object.entries(b.data)) meta.set(k, String(v));
  }
  const fps = Number(meta.get("fps") ?? "") || undefined;
  const primary = meta.get("primary") ?? "video";
  const tracks: { name: string; kind: string }[] = [];
  for (const entry of (meta.get("tracks") ?? "").trim().split(/\s+/).filter((x) => x !== "")) {
    const i = entry.indexOf(":");
    if (i > 0) tracks.push({ name: entry.slice(0, i), kind: entry.slice(i + 1) });
  }
  const kindOf = (t: string): string => tracks.find((x) => x.name === t)?.kind ?? "video";

  const blocks: Extract<Block, { kind: "block" }>[] = [];
  const walk = (bs: Block[]): void => { for (const b of bs) if (b.kind === "block") { blocks.push(b); if (b.children) walk(b.children); } };
  walk(doc.children);
  const raw = blocks.filter((b) => b.type === "media-clip" && b.id !== undefined);

  const problems: string[] = [];
  const attrsOf = (b: Extract<Block, { kind: "block" }>): Record<string, string> => {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.attrs)) o[k] = String(v);
    return o;
  };
  const lengthOf = (b: Extract<Block, { kind: "block" }>, srcRef: string): { len: number; inPt: number } => {
    const a = attrsOf(b);
    const speed = num(a["speed"], 1) ?? 1;
    const inPt = time(a["in"], fps) ?? 0;
    const outPt = time(a["out"], fps);
    const dur = num(a["dur"]);
    if (outPt !== undefined) return { len: Math.max(0, (outPt - inPt) / (speed || 1)), inPt };
    if (dur !== undefined) return { len: dur / (speed || 1), inPt };
    const intrinsic = opts.durationOf(srcRef);
    if (intrinsic !== undefined) return { len: Math.max(0, (intrinsic - inPt) / (speed || 1)), inPt };
    problems.push(`片段 #${b.id ?? "?"} 算不出时长：没有 out=、没有 dur=，源也没有已知的固有时长`);
    return { len: 0, inPt };
  };

  // 主轨：顺序摆放，transition-in 声明的重叠量从前一个的终点往回借。
  const placed: PlacedClip[] = [];
  const byId = new Map<string, PlacedClip>();
  let cursor = 0;
  for (const b of raw) {
    const a = attrsOf(b);
    if ((a["track"] ?? "") !== primary) continue;
    const srcRef = a["src"] ?? "";
    const { len, inPt } = lengthOf(b, srcRef);
    const trans = a["transition-in"] ?? "cut";
    const overlap = OVERLAP.has(trans) ? (num(a["transition-dur"], 0) ?? 0) : 0;
    const start = placed.length === 0 ? 0 : Math.max(0, cursor - overlap);
    const p: PlacedClip = { id: b.id as string, track: primary, kind: kindOf(primary), src: srcRef, start, duration: len, in: inPt, attrs: a };
    placed.push(p); byId.set(p.id, p);
    cursor = start + len;
  }
  // 其余轨：锚到主轨某个片段的起点，加 offset；`at=` 是逃生口，写了它锚定被忽略。
  for (const b of raw) {
    const a = attrsOf(b);
    const track = a["track"] ?? "";
    if (track === primary) continue;
    const srcRef = a["src"] ?? "";
    const { len, inPt } = lengthOf(b, srcRef);
    let start: number;
    const at = num(a["at"]);
    if (at !== undefined) start = at;
    else {
      const overId = (a["over"] ?? "").replace(/^#/, "");
      const anchor = byId.get(overId);
      if (anchor === undefined) { problems.push(`片段 #${b.id ?? "?"} 的 over=${a["over"] ?? "(缺)"} 不是主轨上的片段`); continue; }
      start = anchor.start + (num(a["offset"], 0) ?? 0);
    }
    const p: PlacedClip = { id: b.id as string, track, kind: kindOf(track), src: srcRef, start, duration: len, in: inPt, attrs: a };
    placed.push(p); byId.set(p.id, p);
  }
  placed.sort((x, y) => x.start - y.start || x.track.localeCompare(y.track));
  const duration = placed.reduce((m, p) => Math.max(m, p.start + p.duration), 0);
  return { fps: fps ?? 0, primary, tracks, clips: placed, duration, problems };
}
