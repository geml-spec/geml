// geml-media/v1 的检查器。
//
// 为什么它是**项目级**的：一个片段住在 cut 里、它的素材住在 library 里、产出它的记录
// 住在第三份文件里，三者之间靠引用连着。第一个真实用例
// 在这上面撞过一次 —— `geml check a.geml b.geml` 静默地只查第一个，而逐份查又看不见
// 跨文档的关系。所以这里从入口文档出发，**顺着 media 的引用把相关文档都拉进来**，
// 范围由根目录限定（规范 §9.4）。
//
// 它不 import node:fs：浏览器打包（geml-viewer）会把这个模块一起吃进去，一个 node:*
// 依赖就能让整份扩展构建失败（node:os 那次）。文件访问走 MediaIO，由宿主给。
import { EMBED_TOTAL_CAP, parse, type Block, type Document, type Inline } from "./geml.js";
import { layoutsOf, timecodeToSeconds } from "./media-timeline.js";
import { mediaDiag, type MediaDiagnostic } from "./media-diagnostics.js";
import { type ProfileIO } from "./profiles.js";
import { CHAIN_DEPTH, MEDIA_MAX_TIME } from "./bounds.js";
import { layerSpec, parseEnd, parsePoints, parsePointNames, solveLayout, type End, type InteractionSpec, type LayerSpec } from "./media-compose.js";

// 这份检查器读盘的方式，就是任何一份 profile 检查器读盘的方式（profiles.ts
// `ProfileIO`）。别名留着，是因为这个文件通篇用它说话。
export type MediaIO = ProfileIO;

/** 轨道的种类（profile §3.1）。说的是内容是什么、住在哪，不是画在哪。 */
const TRACK_KINDS = new Set(["video", "audio", "prose"]);
/** 没写 `kind=` 时按扩展名定种类，不分大小写（profile §3）。检查与导入用同一份。 */
const KIND_BY_EXT = new Map<string, string>();
for (const [kind, exts] of [
  ["image", "png jpg jpeg webp gif bmp tif tiff avif svg"],
  ["video", "mp4 mov webm mkv avi m4v"],
  ["audio", "wav mp3 m4a aac flac ogg opus"],
  ["model", "safetensors ckpt pt onnx gguf"],
]) for (const e of exts!.split(" ")) KIND_BY_EXT.set(e, kind!);
export const kindOfFile = (f: string): string => KIND_BY_EXT.get((f.split(".").pop() ?? "").toLowerCase()) ?? "other";
const kindOfAsset = (b: Block & { kind: "block" }): string => str(b.attrs["kind"]) ?? kindOfFile(str(b.attrs["src"]) ?? "");
/** 能播的素材种类：单源只收这几种（profile §2）。 */
const PLAYABLE = new Set(["video", "audio", "image"]);

export interface Loaded { rel: string; doc: Document; meta: Map<string, string> }

const dirOf = (rel: string): string => { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); };
const joinRel = (base: string, rel: string): string => {
  if (base === "") return rel;
  const out: string[] = base.split("/").filter((x) => x !== "");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
};

/** 把一个引用拆成 {文档, id}。`#id` 是本文档，`a.geml#id` 是别处。 */
export function splitRef(ref: string, from: string): { doc: string; id: string } | null {
  const s = ref.trim();
  if (s === "") return null;
  const hash = s.indexOf("#");
  if (hash < 0) return null;
  const id = s.slice(hash + 1);
  if (id === "") return null;
  const docPart = s.slice(0, hash);
  return { doc: docPart === "" ? from : joinRel(dirOf(from), docPart), id };
}

export function blocksOf(doc: Document): Extract<Block, { kind: "block" }>[] {
  const out: Extract<Block, { kind: "block" }>[] = [];
  const walk = (bs: Block[]): void => {
    for (const b of bs) {
      if (b.kind === "block") { out.push(b); if (b.children) walk(b.children); }
    }
  };
  walk(doc.children);
  return out;
}

export function metaOf(doc: Document): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of doc.children) {
    if (b.kind === "block" && b.type === "meta" && b.data) {
      for (const [k, v] of Object.entries(b.data)) m.set(k, String(v));
    }
  }
  return m;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
/** 哈希按十六进制数字比较，不分大小写（§6）。 */
const hex = (v: unknown): string | undefined => str(v)?.toLowerCase();

/**
 * 一个散文块展开投射之后的纯文本 —— 模型看到的那串字，`prompt-sha256` 哈希的对象。
 * 核心今天没有按块展开的办法（`geml get` 返回原文，只有整篇 `--to md` 才展开），
 * 所以检查器自带一个。这正是设计记录 §9 第 2 条（`get --resolved`）的用例。
 */
// 一次展开（一条 prompt）共用的账：花掉的展开次数。
type ProseRun = { spent: number };

function proseText(
  block: Extract<Block, { kind: "block" }>,
  from: string,
  load: (rel: string) => Loaded | null,
  depth = 0,
  path: ReadonlySet<string> = new Set(block.id !== undefined ? [`${from}#${block.id}`] : []),
  run: ProseRun = { spent: 0 },
): string | null {
  if (depth > CHAIN_DEPTH) return null; // GEML §9.3's bound on a projection chain
  const para = (block.children ?? []).find((c) => c.kind === "paragraph");
  if (para === undefined || para.kind !== "paragraph") return null;
  const render = (nodes: Inline[]): string => nodes.map((n): string => {
    if (n.type === "text") return n.value;
    if (n.type === "project") {
      const tgt = splitRef(n.doc !== undefined ? `${n.doc}#${n.anchor}` : `#${n.anchor}`, from);
      if (tgt === null) return "";
      // 只有深度上限时，一块里投三次自己就是 3^16 次展开（276 字节跑了二十秒）；无环的
      // 菱形也一样，每层投下一层四次，展开出的字就有 4^16 个。所以：已在展开路径上的是环
      // （核心检查报 transclusion-cycle），这里贡献空串；每一次展开都记账，一条 prompt 最多
      // 展开 EMBED_TOTAL_CAP 次，之后的贡献空串 —— 按文档顺序、深度优先截断。
      const key = `${tgt.doc}#${tgt.id}`;
      if (path.has(key)) return "";
      if (++run.spent > EMBED_TOTAL_CAP) return "";
      const into = load(tgt.doc);
      if (into === null) return "";
      const b = blocksOf(into.doc).find((x) => x.id === tgt.id);
      return (b === undefined ? null : proseText(b, tgt.doc, load, depth + 1, new Set(path).add(key), run)) ?? "";
    }
    const kids = (n as { children?: Inline[] }).children;
    if (kids !== undefined) return render(kids);
    const v = (n as { value?: string }).value;
    return v ?? "";
  }).join("");
  return render(para.inlines);
}

/**
 * 一个 comp 的规范化文本 —— `prompt-sha256` 对它哈希的对象（设计记录 §16.2）。
 *
 * 从模型生成，不切源文本：类型、id、按键排序的属性，一层一行，层按文档顺序。
 * 于是重排空白、调换属性顺序都不算改动，而 `x=300` 改成 `x=340` 就是 —— 和提示词
 * 的哈希忽略标记、只看展开后的字是同一个道理。
 */
function compText(
  block: Extract<Block, { kind: "block" }>,
  from: string,
  load: (rel: string) => Loaded | null,
): string {
  type B = Extract<Block, { kind: "block" }>;
  const head = (b: B, attrs: Record<string, unknown> = b.attrs): string => [
    b.type,
    ...(b.id === undefined ? [] : [`#${b.id}`]),
    ...Object.keys(attrs).sort().map((k) => `${k}=${String(attrs[k])}`),
  ].join(" ");
  const lines = [head(block)];
  const kids = (block.children ?? []).filter((c): c is B => c.kind === "block");
  const layers = new Map<string, B>();
  for (const c of kids) if (c.type === "media-layer") { lines.push(head(c)); if (c.id !== undefined) layers.set(c.id, c); }
  // 连接的两端带上解析后的点坐标（§16.8）：素材上的 points= 一改，用它的 comp 就过期。
  const withPoint = (v: unknown): string => {
    const e = parseEnd(v);
    const src = e === null ? undefined : str(layers.get(e.layer)?.attrs["src"]);
    const t = src === undefined ? null : splitRef(src, from);
    const into = t === null ? null : load(t.doc);
    const asset = into === null || t === null ? undefined : blocksOf(into.doc).find((x) => x.id === t.id);
    const p = asset === undefined || e === null ? undefined : parsePoints(asset.attrs["points"]).get(e.point);
    return p === undefined ? `${String(v)}@?` : `${String(v)}@${p.x},${p.y}`;
  };
  for (const c of kids) {
    if (c.type === "media-interaction") lines.push(head(c, { ...c.attrs, a: withPoint(c.attrs["a"]), b: withPoint(c.attrs["b"]) }));
  }
  return lines.join("\n");
}

/** 一个块「作为提示词」的文本：散文块展开投射，comp 取规范化文本。 */
function blockText(
  block: Extract<Block, { kind: "block" }>,
  from: string,
  load: (rel: string) => Loaded | null,
): string | null {
  return block.type === "media-comp" ? compText(block, from, load) : proseText(block, from, load);
}

/** 把一条时间线的 `tracks=` 的「名字:种类」读成一张表，顺带报它自己的毛病。 */
function trackKinds(m: Map<string, string>, rel: string, out: MediaDiagnostic[]): Map<string, string> {
  const kinds = new Map<string, string>();
  const decl = (m.get("tracks") ?? "").trim();
  if (decl === "") return kinds;
  for (const entry of decl.split(/\s+/)) {
    const colon = entry.indexOf(":");
    if (colon < 0) {
      out.push(mediaDiag("media-track-kind-missing",
        `\`tracks=\` 里的 \`${entry}\` 只有名字没有种类；写成 \`${entry}:video\`（种类是 video / audio / prose）`, rel));
      continue;
    }
    const [name, kind] = [entry.slice(0, colon), entry.slice(colon + 1)];
    if (!TRACK_KINDS.has(kind)) {
      out.push(mediaDiag("media-track-kind-unknown",
        `轨道 \`${name}\` 的种类 \`${kind}\` 不是 video / audio / prose`, rel));
      continue;
    }
    kinds.set(name, kind);
  }
  return kinds;
}

/**
 * 检查一个 geml-media 项目。从 `entry` 出发，顺着 media 的引用把相关文档拉进来。
 *
 * 返回的诊断按**地址**定位（文档 + 块 id），不按行号 —— 见 media-diagnostics.ts。
 */
export function checkMedia(entry: string, io: MediaIO): MediaDiagnostic[] {
  const out: MediaDiagnostic[] = [];
  const docs = new Map<string, Loaded | null>();
  const load = (rel: string): Loaded | null => {
    if (docs.has(rel)) return docs.get(rel) ?? null;
    const src = io.readDoc(rel);
    if (src === null) { docs.set(rel, null); return null; }
    // 每份文档按**它自己的** `=== meta` 解析（§8.6.2 规则 2）。
    const doc = parse(src);
    const l: Loaded = { rel, doc, meta: metaOf(doc) };
    docs.set(rel, l);
    return l;
  };

  const root = load(entry);
  if (root === null) return out;

  // ---- 装载：从入口顺着引用把文档拉进来 -------------------------------------
  const seen = new Set<string>([entry]);
  const queue = [entry];
  const refsOf = (l: Loaded): string[] => {
    const refs: string[] = [];
    for (const b of blocksOf(l.doc)) {
      for (const k of ["src", "of", "speaker", "to", "over"]) {
        const v = str(b.attrs[k]);
        if (v !== undefined && v.includes("#")) refs.push(v);
      }
      if (b.classes.includes("gen-log") && Array.isArray(b.value)) {
        for (const rec of b.value as Record<string, unknown>[]) {
          for (const k of ["output", "prompt"]) { const v = str(rec[k]); if (v !== undefined) refs.push(v); }
          for (const group of ["inputs", "prompt-refs"]) {
            const arr = rec[group];
            if (Array.isArray(arr)) for (const it of arr as Record<string, unknown>[]) { const v = str(it["ref"]); if (v !== undefined) refs.push(v); }
          }
        }
      }
    }
    return refs;
  };
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const l = docs.get(cur);
    if (l === null || l === undefined) continue;
    for (const r of refsOf(l)) {
      const t = splitRef(r, cur);
      if (t === null || seen.has(t.doc)) continue;
      seen.add(t.doc);
      if (load(t.doc) !== null) queue.push(t.doc);
    }
  }

  // ---- 索引：素材、片段、台词、日志 -----------------------------------------
  interface AssetRef { l: Loaded; b: Extract<Block, { kind: "block" }> }
  const assets = new Map<string, AssetRef>();          // "doc#id" -> 素材
  const blockAt = (doc: string, id: string): Extract<Block, { kind: "block" }> | undefined => {
    const l = docs.get(doc);
    return l === null || l === undefined ? undefined : blocksOf(l.doc).find((x) => x.id === id);
  };
  const anyBlockExists = (doc: string, id: string): boolean => {
    const l = docs.get(doc);
    if (l === null || l === undefined) return false;
    if (blocksOf(l.doc).some((x) => x.id === id)) return true;
    return l.doc.ids.includes(id);
  };
  // 角色是标题节：`# 林夏 {#hero points="hand eyes"}`。标题不在 blocksOf 里，单独找。
  const headingAt = (doc: string, id: string): Extract<Block, { kind: "heading" }> | undefined => {
    const l = docs.get(doc);
    if (l === null || l === undefined) return undefined;
    for (const b of l.doc.children) if (b.kind === "heading" && b.id === id) return b;
    return undefined;
  };
  for (const rel of seen) {
    const l = docs.get(rel);
    if (l === null || l === undefined) continue;
    for (const b of blocksOf(l.doc)) if (b.type === "media-asset" && b.id !== undefined) assets.set(`${rel}#${b.id}`, { l, b });
  }

  // ---- 素材：哈希、文件、种类、of --------------------------------------------
  const currentHash = new Map<string, string | null>();   // "doc#id" -> 文件现值
  for (const [key, { l, b }] of assets) {
    const src = str(b.attrs["src"]);
    const declared = hex(b.attrs["sha256"]);
    if (src === undefined || src === "") {
      out.push(mediaDiag("media-src-unresolved", "`media-asset` 没有 `src=`", l.rel, b.id));
      continue;
    }
    // 素材文件要交给播放器和 ffmpeg，它们把 scheme（`concat:`、`http:`）当指令读（§3）。
    // 判断用用户代理读到的样子：去掉 C0 控制符与空格（GEML §9.4）。
    const read = src.replace(/[\x00-\x20]/g, "");
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(read) || read.startsWith("/") || read.includes("\\")) {
      // 不是这个检查器会打开的文件：它在不在、哈希对不对都不问。
      out.push(mediaDiag("media-src-not-relative", `\`${src}\` 不是相对路径：带 URL scheme、以 / 开头或含反斜杠的路径不交给播放器和 ffmpeg`, l.rel, b.id));
      currentHash.set(key, null);
    } else {
      const path = joinRel(dirOf(l.rel), src);
      const now = io.hashFile(path);
      currentHash.set(key, now);
      // 缺 `sha256=` 与文件在不在无关：库没说期望哪份字节（§3）。
      if (declared === undefined) out.push(mediaDiag("media-asset-unhashed", "没有 `sha256=`，没法校验它的文件是不是库里描述的那一份", l.rel, b.id));
      if (now === null) {
        out.push(mediaDiag("media-file-missing", `\`${src}\` 不存在（描述别处素材的库照样合法，只是未校验）`, l.rel, b.id));
      } else if (declared !== undefined && declared !== now) {
        out.push(mediaDiag("media-hash-mismatch",
          `\`${src}\` 在，但它的 SHA-256 是 \`${now.slice(0, 12)}…\`，声明的是 \`${declared.slice(0, 12)}…\` —— 文件在、内容却不是它说的那个，比没有更糟`,
          l.rel, b.id));
      }
    }
    const of = str(b.attrs["of"]);
    if (of !== undefined && of !== "") {
      const t = splitRef(of, l.rel);
      if (t === null || !anyBlockExists(t.doc, t.id)) {
        out.push(mediaDiag("media-of-unresolved", `\`of=${of}\` 指不到任何块`, l.rel, b.id));
      }
    }
  }

  // ---- 片段：轨道、src 与种类、dur -------------------------------------------
  for (const rel of seen) {
    const l = docs.get(rel);
    if (l === null || l === undefined) continue;
    const clips = blocksOf(l.doc).filter((b) => b.type === "media-clip");
    // 轨道表属于**所属的 `media` 块**，不属于文档：一份文档能装好几条时间线，各有
    // 各的轨。每块只验一次并记下来 —— 轨道表自己的毛病（少种类、种类不认得）跟有没有
    // 片段用它无关，而逐片段重算会把同一条诊断报很多遍。
    const byOwner = new Map<string, Map<string, string>>();
    for (const m of blocksOf(l.doc)) {
      if (m.type !== "media") continue;
      const cfg = new Map(Object.entries(m.attrs).map(([k, v]) => [k, String(v)]));
      const inner = blocksOf({ children: m.children ?? [] } as never).filter((c) => c.type === "media-clip");
      // 形状：有体＝装配，无体加 `src=`＝单源。两样都占，就说不清该按哪种算；两样
      // 都没有，它什么也不是 —— 与其让它默默摆出一条空时间线，不如当场说。
      if (inner.length > 0 && cfg.has("src")) {
        out.push(mediaDiag("media-shape-ambiguous",
          "`media` 既有体又有 `src=`：有体是装配（片段说了算），无体加 `src=` 是单源，二选一", rel, m.id));
      } else if (inner.length === 0 && !cfg.has("src")) {
        out.push(mediaDiag("media-shape-empty",
          "`media` 既没有片段也没有 `src=`，它不指向任何可播的东西", rel, m.id));
      }
      // 单源按它就是的那一个片段来查（profile §2）：`src` 要指能播的素材（视频、音频、静图），
      // 指静图就得写明占多久。
      if (inner.length === 0 && cfg.has("src")) {
        const one = str(m.attrs["src"]) ?? "";
        const t = one === "" ? null : splitRef(one, rel);
        const target = t === null ? undefined : blockAt(t.doc, t.id);
        if (target === undefined) {
          out.push(mediaDiag("media-src-unresolved", `\`src=${one}\` 指不到任何块`, rel, m.id));
        } else if (target.type !== "media-asset" || !PLAYABLE.has(kindOfAsset(target))) {
          const got = target.type === "media-asset" ? `${kindOfAsset(target)} 素材` : `\`${target.type}\``;
          out.push(mediaDiag("media-src-not-asset", `单源的 \`src\` 要指视频、音频或静图素材，实际是${got}`, rel, m.id));
        } else if (kindOfAsset(target) === "image" && str(m.attrs["duration"]) === undefined) {
          out.push(mediaDiag("media-duration-required", "静图没有固有时长，单源要写 `duration=`", rel, m.id));
        }
      }
      const kinds = trackKinds(cfg, rel, out);
      for (const c of inner) if (c.id !== undefined) byOwner.set(c.id, kinds);
    }
    // 不在任何 `media` 体内的片段：没有轨道表可依，也不属于任何一条时间线。
    for (const b of clips) {
      if (b.id === undefined || !byOwner.has(b.id)) {
        out.push(mediaDiag("media-clip-unassembled",
          "`media-clip` 不在任何 `media` 块里 —— 它不属于任何一条时间线", rel, b.id));
      }
    }
    if (clips.length === 0) continue;
    const EMPTY = new Map<string, string>();
    const kindsFor = (id: string | undefined): Map<string, string> =>
      (id === undefined ? undefined : byOwner.get(id)) ?? EMPTY;
    for (const b of clips) {
      const track = str(b.attrs["track"]);
      let kind: string | undefined;
      if (track === undefined || track === "") {
        out.push(mediaDiag("media-track-missing", "`media-clip` 没有 `track=`", rel, b.id));
      } else if (!kindsFor(b.id).has(track)) {
        out.push(mediaDiag("media-track-undeclared", `\`track=${track}\` 不在这条时间线的 \`tracks=\` 里`, rel, b.id));
      } else {
        kind = kindsFor(b.id).get(track);
      }
      const src = str(b.attrs["src"]);
      if (src === undefined || src === "") { out.push(mediaDiag("media-src-unresolved", "`media-clip` 没有 `src=`", rel, b.id)); continue; }
      const t = splitRef(src, rel);
      const target = t === null ? undefined : blockAt(t.doc, t.id);
      if (target === undefined) { out.push(mediaDiag("media-src-unresolved", `\`src=${src}\` 指不到任何块`, rel, b.id)); continue; }
      // 合不合轨看轨的种类（profile §4）：视频轨收视频或静图素材，音频轨收音频素材，散文轨
      // 收 `media-text`；素材的种类看 `kind=`，没写看扩展名。不合轨的只报这一条。
      const ak = target.type === "media-asset" ? kindOfAsset(target) : undefined;
      const fits = kind === "prose" ? target.type === "media-text"
        : kind === "video" ? ak === "video" || ak === "image"
        : kind === "audio" ? ak === "audio"
        : true;
      if (!fits) {
        const want = kind === "prose" ? "`media-text`" : kind === "video" ? "视频或静图素材" : "音频素材";
        const got = ak === undefined ? `\`${target.type}\`` : `${ak} 素材`;
        out.push(mediaDiag("media-src-not-asset", `轨道 \`${track}\` 的种类是 ${kind}，\`src\` 要指${want}，实际是${got}`, rel, b.id));
        continue;
      }
      // 有没有长度是来源的事，不是轨的事（§8）：静图和散文没有固有时长，这一刀得写
      // `duration=`，轨声明没声明都一样。音视频总有固有时长：文件自己的，`duration=` 写没写都算。
      if (str(b.attrs["duration"]) === undefined && (target.type === "media-text" || ak === "image")) {
        out.push(mediaDiag("media-duration-required",
          target.type === "media-text" ? "散文没有固有时长，这一刀要写 `duration=`" : "静图没有固有时长，这一刀要写 `duration=`", rel, b.id));
      }
    }
  }

  // ---- 合成：层要在 comp 里，comp 要有画布和至少一层，层要指向图片（§16）------
  for (const rel of seen) {
    const l = docs.get(rel);
    if (l === null || l === undefined) continue;
    const layers = blocksOf(l.doc).filter((b) => b.type === "media-layer");
    const owned = new Set<Extract<Block, { kind: "block" }>>();
    for (const m of blocksOf(l.doc)) {
      if (m.type !== "media-comp") continue;
      const inner = blocksOf({ children: m.children ?? [] } as never).filter((c) => c.type === "media-layer");
      for (const c of inner) owned.add(c);
      const size = str(m.attrs["size"]);
      if (size === undefined || !/^\d+x\d+$/.test(size)) {
        out.push(mediaDiag("media-comp-size-missing", "`media-comp` 没有 `size=`：画布多大无从知道，写成 `size=720x1280`", rel, m.id));
      }
      if (inner.length === 0) {
        out.push(mediaDiag("media-comp-empty", "`media-comp` 的体里一个 `media-layer` 都没有，它合不出任何东西", rel, m.id));
      }
    }
    for (const b of layers) {
      if (!owned.has(b)) {
        out.push(mediaDiag("media-layer-unassembled", "`media-layer` 不在任何 `media-comp` 里 —— 它不属于任何一张合成", rel, b.id));
      }
      const src = str(b.attrs["src"]);
      if (src === undefined || src === "") { out.push(mediaDiag("media-src-unresolved", "`media-layer` 没有 `src=`", rel, b.id)); continue; }
      const t = splitRef(src, rel);
      const target = t === null ? undefined : blockAt(t.doc, t.id);
      if (target === undefined) { out.push(mediaDiag("media-src-unresolved", `\`src=${src}\` 指不到任何块`, rel, b.id)); continue; }
      const kind = target.type !== "media-asset" ? target.type : kindOfAsset(target);
      if (kind !== "image") {
        out.push(mediaDiag("media-layer-not-image", `\`src=${src}\` 不是一张图片（是 ${kind}）：层只能是立绘或母版`, rel, b.id));
      }
    }
  }

  // ---- 互动：点、连接、序列（§16.8）------------------------------------------
  //
  // 解算和 compose 用同一份几何（media-compose.ts）：这里报"位置冲突""缺 size""两点分开"，
  // compose 据同一份算坐标。引不到、同一层、不在 comp 里，是这里独有的结构检查。
  const codeOf = {
    "position-conflict": "media-layer-position-conflict",
    "size-required": "media-asset-size-required",
    "apart": "media-interaction-apart",
  } as const;
  for (const rel of seen) {
    const l = docs.get(rel);
    if (l === null || l === undefined) continue;
    type B = Extract<Block, { kind: "block" }>;
    const owned = new Set<B>();
    const byShot = new Map<string, Map<string, string>>();
    for (const m of blocksOf(l.doc)) {
      if (m.type !== "media-comp") continue;
      const shot = str(m.attrs["shot"]);
      const at = str(m.attrs["at"]);
      if (shot !== undefined && at !== undefined) {
        const ats = byShot.get(shot) ?? new Map<string, string>();
        const prev = ats.get(at);
        if (prev !== undefined) {
          out.push(mediaDiag("media-comp-at-duplicate", `镜 ${shot} 在 at=${at} 已经有 #${prev}：同一时刻两帧，说不清哪个是画面`, rel, m.id));
        } else ats.set(at, m.id ?? "?");
        byShot.set(shot, ats);
      }
      const kids = (m.children ?? []).filter((c): c is B => c.kind === "block");
      const inter = kids.filter((c) => c.type === "media-interaction");
      for (const c of inter) owned.add(c);
      if (inter.length === 0) continue;
      const specs = new Map<string, LayerSpec>();
      const declared = new Map<string, Set<string> | null>();
      kids.filter((c) => c.type === "media-layer").forEach((c, index) => {
        if (c.id === undefined) return;
        const src = str(c.attrs["src"]);
        const t = src === undefined ? null : splitRef(src, rel);
        const asset = t === null ? undefined : blockAt(t.doc, t.id);
        specs.set(c.id, layerSpec(c.id, index, c.attrs, asset?.attrs ?? {}));
        // 点的名字声明在素材 of= 指向的角色 / 场景上：标题节或 .look 块。
        let names: Set<string> | null = null;
        const of = asset === undefined ? undefined : str(asset.attrs["of"]);
        if (of !== undefined && t !== null) {
          const ot = splitRef(of, t.doc);
          const target = ot === null ? undefined : (blockAt(ot.doc, ot.id) ?? headingAt(ot.doc, ot.id));
          names = target === undefined ? null : parsePointNames(target.attrs["points"]);
        }
        declared.set(c.id, names);
      });
      const valid: InteractionSpec[] = [];
      for (const b of inter) {
        let problem: string | null = null;
        const ends: End[] = [];
        for (const k of ["a", "b"]) {
          const v = str(b.attrs[k]);
          const e = parseEnd(v);
          if (e === null) { problem ??= `\`${k}=${v ?? ""}\` 要写成 \`#层:点\``; continue; }
          const spec = specs.get(e.layer);
          if (spec === undefined) { problem ??= `\`${k}=${v}\` 指的层 #${e.layer} 不在这个 comp 里`; continue; }
          if (!spec.points.has(e.point)) { problem ??= `层 #${e.layer} 的素材没有点 \`${e.point}\``; continue; }
          const names = declared.get(e.layer) ?? null;
          if (names !== null && !names.has(e.point)) {
            out.push(mediaDiag("media-interaction-point-undeclared", `点 \`${e.point}\` 不在层 #${e.layer} 所画的角色 / 场景声明的点名里`, rel, b.id));
          }
          ends.push(e);
        }
        const kindRaw = str(b.attrs["kind"]);
        const kind: InteractionSpec["kind"] | null = kindRaw === "contact" || kindRaw === "gaze" ? kindRaw : null;
        if (kind === null) problem ??= `\`kind=${kindRaw ?? ""}\` 不是 contact / gaze`;
        if (problem !== null || kind === null) { out.push(mediaDiag("media-interaction-unresolved", problem ?? "", rel, b.id)); continue; }
        const [ea, eb] = ends as [End, End];
        if (ea.layer === eb.layer) { out.push(mediaDiag("media-interaction-same-layer", "连接的两端在同一层上：一层不能和自己相碰", rel, b.id)); continue; }
        valid.push({ id: b.id ?? "?", a: ea, b: eb, kind });
      }
      for (const p of solveLayout([...specs.values()], valid).problems) out.push(mediaDiag(codeOf[p.code], p.message, rel, p.id));
    }
    for (const b of blocksOf(l.doc)) {
      if (b.type !== "media-interaction" || owned.has(b)) continue;
      out.push(mediaDiag("media-interaction-unassembled", "`media-interaction` 不在任何 `media-comp` 里 —— 它连的层无从解析", rel, b.id));
      out.push(mediaDiag("media-interaction-unresolved", "不在 comp 里，`a=` `b=` 指的层无从解析", rel, b.id));
    }
  }

  // ---- 台词：speaker 必填，speaker/to 要解析得到 -----------------------------
  for (const rel of seen) {
    const l = docs.get(rel);
    if (l === null || l === undefined) continue;
    for (const b of blocksOf(l.doc)) {
      if (b.type !== "media-text" || !b.classes.includes("line")) continue;
      const sp = str(b.attrs["speaker"]);
      if (sp === undefined || sp === "") { out.push(mediaDiag("media-line-no-speaker", "`.line` 必须有 `speaker=`", rel, b.id)); }
      for (const k of ["speaker", "to"]) {
        const v = str(b.attrs[k]);
        if (v === undefined || v === "") continue;
        const t = splitRef(v, rel);
        if (t === null || !anyBlockExists(t.doc, t.id)) {
          out.push(mediaDiag("media-speaker-unresolved", `\`${k}=${v}\` 指不到任何块`, rel, b.id));
        }
      }
    }
  }

  // ---- 血缘：当前记录、过期、传播 --------------------------------------------
  //
  // 关键一步是"当前记录"：同一个 output 可以有多条记录（重生过一次就多一条），
  // 取 `output-sha256` 等于素材现值的那一条。没有这一步，被取代的旧记录会永远对不上
  // 现值，一次重生之后那份素材就永远标黄 —— 这是第一个真实用例实测出来的。
  interface Rec { rel: string; id: string | undefined; i: number; r: Record<string, unknown> }
  const records: Rec[] = [];
  for (const rel of seen) {
    const l = docs.get(rel);
    if (l === null || l === undefined) continue;
    for (const b of blocksOf(l.doc)) {
      if (!b.classes.includes("gen-log") || !Array.isArray(b.value)) continue;
      (b.value as Record<string, unknown>[]).forEach((r, i) => records.push({ rel, id: b.id, i, r }));
    }
  }

  const REQUIRED = ["model", "mode", "at"];
  const byOutput = new Map<string, Rec[]>();
  for (const rec of records) {
    const missing = REQUIRED.filter((k) => str(rec.r[k]) === undefined);
    const hasOutput = rec.r["output"] !== undefined;
    if (!hasOutput) missing.unshift("output");
    const outRef = str(rec.r["output"]);
    if (outRef !== undefined && str(rec.r["output-sha256"]) === undefined) missing.push("output-sha256");
    if (missing.length > 0) {
      out.push(mediaDiag("media-gen-schema",
        `记录 [${rec.i}] 缺必需字段：${missing.map((k) => `\`${k}\``).join("、")}`, rec.rel, rec.id));
    }
    if (outRef === undefined) continue;
    const t = splitRef(outRef, rec.rel);
    if (t === null) continue;
    const key = `${t.doc}#${t.id}`;
    // 记录说它产出了一份素材，库里却没有这个块：结构坏了。第一个真实用例撞到的 —— 素材块
    // 没建成，下游的运镜记录以它为输入，过期从此判不出来，成片悄悄用了旧图。
    if (!assets.has(key)) {
      out.push(mediaDiag("media-gen-output-not-asset",
        `记录 [${rec.i}] 的 \`output=${outRef}\` 指不到任何 \`media-asset\``, rec.rel, rec.id));
    }
    const list = byOutput.get(key);
    if (list === undefined) byOutput.set(key, [rec]); else list.push(rec);
  }

  /** 一个引用现在的哈希：素材看文件，散文块看展开后的文本，comp 看规范化文本。 */
  const nowHashOf = (ref: string, from: string): string | null => {
    const t = splitRef(ref, from);
    if (t === null) return null;
    const key = `${t.doc}#${t.id}`;
    if (assets.has(key)) return currentHash.get(key) ?? null;
    const b = blockAt(t.doc, t.id);
    if (b === undefined) return null;
    const text = blockText(b, t.doc, load);
    return text === null ? null : io.hashText(text);
  };

  const stale = new Map<string, string[]>();        // 素材 key -> 为什么
  const current = new Map<string, Rec>();           // 素材 key -> 当前记录
  for (const [key, recs] of byOutput) {
    const now = currentHash.get(key) ?? null;
    // 现值是文件此刻的哈希（§6）。读不到文件就没有现值：没有记录与它匹配，不算孤儿，
    // 血缘也不查。没有记录匹配时只是孤儿 —— 过期只在匹配现值的那条记录上算。
    if (now === null) continue;
    const match = recs.filter((x) => hex(x.r["output-sha256"]) === now);
    const pick = (list: Rec[]): Rec => [...list].sort((a, b) => (str(a.r["at"]) ?? "") < (str(b.r["at"]) ?? "") ? 1 : -1)[0] as Rec;
    if (match.length === 0) {
      out.push(mediaDiag("media-orphan-record",
        "没有任何记录的 `output-sha256` 等于它现在的哈希 —— 这份字节来历不明", recs[0]!.rel, recs[0]!.id));
      continue;
    }
    current.set(key, pick(match));
  }

  for (const [key, rec] of current) {
    const why: string[] = [];
    const prompt = str(rec.r["prompt"]);
    const promptSha = hex(rec.r["prompt-sha256"]);
    if (prompt !== undefined && promptSha !== undefined) {
      const nowSha = nowHashOf(prompt, rec.rel);
      if (nowSha !== null && nowSha !== promptSha) why.push(`提示词 \`${prompt}\``);
    }
    const refs = rec.r["prompt-refs"];
    if (Array.isArray(refs)) {
      for (const it of refs as Record<string, unknown>[]) {
        const ref = str(it["ref"]); const was = hex(it["sha256"]);
        if (ref === undefined || was === undefined) continue;
        const nowSha = nowHashOf(ref, rec.rel);
        if (nowSha !== null && nowSha !== was) why.push(`投射源 \`${ref}\``);
      }
    }
    const inputs = rec.r["inputs"];
    if (Array.isArray(inputs)) {
      for (const it of inputs as Record<string, unknown>[]) {
        const ref = str(it["ref"]); const was = hex(it["sha256"]);
        if (ref === undefined || was === undefined) continue;
        const nowSha = nowHashOf(ref, rec.rel);
        if (nowSha !== null && nowSha !== was) why.push(`输入 \`${ref}\``);
      }
    }
    if (why.length > 0) stale.set(key, why);
  }

  // 过期沿血缘图向下传播：配音过期 → 吃它的口型合成过期 → 用它的片段过期。
  for (let grew = true; grew;) {
    grew = false;
    for (const [key, rec] of current) {
      if (stale.has(key)) continue;
      const inputs = rec.r["inputs"];
      if (!Array.isArray(inputs)) continue;
      for (const it of inputs as Record<string, unknown>[]) {
        const ref = str(it["ref"]);
        if (ref === undefined) continue;
        const t = splitRef(ref, rec.rel);
        if (t !== null && stale.has(`${t.doc}#${t.id}`)) { stale.set(key, [`上游过期 \`${ref}\``]); grew = true; break; }
      }
    }
  }

  for (const [key, why] of stale) {
    const a = assets.get(key);
    out.push(mediaDiag("media-stale-generation",
      `产出它的那条记录已经对不上现值：${why.join("；")}`, a?.l.rel ?? key.split("#")[0] ?? "", a?.b.id ?? key.split("#")[1]));
  }

  // 最后：每个片段的 src 是不是过期产出。
  for (const rel of seen) {
    const l = docs.get(rel);
    if (l === null || l === undefined) continue;
    for (const b of blocksOf(l.doc)) {
      if (b.type !== "media-clip") continue;
      const src = str(b.attrs["src"]);
      if (src === undefined) continue;
      const t = splitRef(src, rel);
      if (t === null) continue;
      const why = stale.get(`${t.doc}#${t.id}`);
      if (why !== undefined) {
        out.push(mediaDiag("media-stale-clip",
          `它用的 \`${src}\` 已过期：${why.join("；")}`, rel, b.id));
      }
    }
  }

  // ---- 电平与时间（§4、§3.2） -----------------------------------------------
  // gain 要拼进播放图与 ffmpeg 的滤镜图，只认带单位的分贝值；每个时间都是有限数且不超过
  // max-time（MEDIA_MAX_TIME），片段在时间线上的终点也一样 —— 时间线按长度绘制、按长度出片。
  const timeOf = (v: unknown, fps: number | undefined): number | undefined => {
    if (typeof v === "number") return v;
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    if (t.includes(":")) return timecodeToSeconds(t, fps);
    return /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(t) ? Number(t) : undefined;
  };
  const pastMax = (t: number | undefined): boolean => t !== undefined && !(Number.isFinite(t) && t <= MEDIA_MAX_TIME);
  const tooLong = (rel: string, id: string | undefined, what: string, t: number): void => {
    out.push(mediaDiag("media-time-out-of-range", `${what} 是 ${Number.isFinite(t) ? `${t} 秒` : "非有限数"}：时间不超过 24 小时（86400 秒）`, rel, id));
  };
  for (const [, { l, b }] of assets) {
    const d = timeOf(b.attrs["duration"], undefined);
    if (pastMax(d)) tooLong(l.rel, b.id, "`duration`", d!);
  }
  for (const rel of seen) {
    const l = docs.get(rel);
    if (l === null || l === undefined) continue;
    const reported = new Set<string>();
    const walk = (bs: Block[], fps: number | undefined): void => {
      for (const b of bs) {
        if (b.kind !== "block") continue;
        const own = b.type === "media" ? timeOf(b.attrs["fps"], undefined) : fps;
        if (b.type === "media-clip" || (b.type === "media" && b.attrs["src"] !== undefined)) {
          const gain = b.attrs["gain"];
          if (gain !== undefined && !/^-?\d+(\.\d+)?\s*dB$/i.test(String(gain).trim())) {
            out.push(mediaDiag("media-gain-invalid", `\`gain=${String(gain)}\` 不是分贝值（写成 \`-14dB\`）`, rel, b.id));
          }
          for (const k of ["in", "out", "duration", "offset", "at"]) {
            const t = timeOf(b.attrs[k], own);
            if (pastMax(t) && b.id !== undefined && !reported.has(b.id)) { reported.add(b.id); tooLong(rel, b.id, `\`${k}\``, t!); }
          }
        }
        if (b.children) walk(b.children, own);
      }
    };
    walk(l.doc.children, undefined);
    const durationOf = (ref: string): number | undefined => {
      const t = splitRef(ref, rel);
      const a = t === null ? undefined : assets.get(`${t.doc}#${t.id}`);
      const d = a === undefined ? undefined : timeOf(a.b.attrs["duration"], undefined);
      return d !== undefined && Number.isFinite(d) ? d : undefined;
    };
    for (const tl of layoutsOf(l.doc, { durationOf })) {
      for (const c of tl.clips) {
        const end = c.start + c.duration;
        if (pastMax(end) && !reported.has(c.id)) { reported.add(c.id); tooLong(rel, c.id, "片段在时间线上的终点", end); }
      }
    }
  }
  return out;
}

/**
 * 一个提示词或台词块展开全部投射之后的纯文本 —— 模型看到的那串字，也是
 * `prompt-sha256` 哈希的对象。
 *
 * 导出它，是因为**算这个哈希的地方必须只有一处**。手工拼字符串算出来的是错的：
 * 角色卡里的 `**银灰短发齐耳**` 展开后是纯文本，没有星号，而拼接的人会把标记
 * 一起算进去。夹具生成器、将来的 `geml media prompt`、检查器，走的都是这一个实现。
 * 核心有了 `get --resolved` 之后，这里改成它的薄封装。
 */
export function promptTextOf(ref: string, from: string, io: MediaIO): string | null {
  const cache = new Map<string, Loaded | null>();
  const load = (rel: string): Loaded | null => {
    if (cache.has(rel)) return cache.get(rel) ?? null;
    const src = io.readDoc(rel);
    if (src === null) { cache.set(rel, null); return null; }
    const doc = parse(src);
    const l: Loaded = { rel, doc, meta: metaOf(doc) };
    cache.set(rel, l);
    return l;
  };
  const t = splitRef(ref, from);
  if (t === null) return null;
  const l = load(t.doc);
  if (l === null) return null;
  const b = blocksOf(l.doc).find((x) => x.id === t.id);
  return b === undefined ? null : blockText(b, t.doc, load);
}
