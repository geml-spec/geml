// geml-media/v1 的检查器。
//
// 为什么它是**项目级**的：一个片段住在 cut 里、它的素材住在 library 里、产出它的记录
// 住在第三份文件里，三者之间靠引用连着。第一个真实用例（playground/geml-media-ep01）
// 在这上面撞过一次 —— `geml check a.geml b.geml` 静默地只查第一个，而逐份查又看不见
// 跨文档的关系。所以这里从入口文档出发，**顺着 media 的引用把相关文档都拉进来**，
// 范围由根目录限定（规范 §9.4）。
//
// 它不 import node:fs：浏览器打包（geml-viewer）会把这个模块一起吃进去，一个 node:*
// 依赖就能让整份扩展构建失败（node:os 那次）。文件访问走 MediaIO，由宿主给。
import { parse, type Block, type Document, type Inline } from "./geml.js";
import { mediaDiag, type MediaDiagnostic } from "./media-diagnostics.js";

export interface MediaIO {
  /** 读一份文档（相对根目录）。越界或不存在返回 null。 */
  readDoc(rel: string): string | null;
  /** 一个文件的 SHA-256（十六进制全长）。不存在返回 null。 */
  hashFile(rel: string): string | null;
  /** 一段文本的 SHA-256（UTF-8，十六进制全长）。提示词展开后要算它。 */
  hashText(text: string): string;
}

/** 轨道的种类（profile §3.1）。说的是内容是什么、住在哪，不是画在哪。 */
const TRACK_KINDS = new Set(["video", "audio", "prose"]);
/** 有固有时长的素材种类；其余（静图、模型、其它）在时间线上要 `dur`。 */
const TIMED_KINDS = new Set(["video", "audio"]);

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

/**
 * 一个散文块展开投射之后的纯文本 —— 模型看到的那串字，`prompt-sha256` 哈希的对象。
 * 核心今天没有按块展开的办法（`geml get` 返回原文，只有整篇 `--to md` 才展开），
 * 所以检查器自带一个。这正是设计记录 §9 第 2 条（`get --resolved`）的用例。
 */
function proseText(
  block: Extract<Block, { kind: "block" }>,
  from: string,
  load: (rel: string) => Loaded | null,
  depth = 0,
): string | null {
  if (depth > 8) return null;
  const para = (block.children ?? []).find((c) => c.kind === "paragraph");
  if (para === undefined || para.kind !== "paragraph") return null;
  const render = (nodes: Inline[]): string => nodes.map((n): string => {
    if (n.type === "text") return n.value;
    if (n.type === "project") {
      const tgt = splitRef(n.doc !== undefined ? `${n.doc}#${n.anchor}` : `#${n.anchor}`, from);
      if (tgt === null) return "";
      const into = load(tgt.doc);
      if (into === null) return "";
      const b = blocksOf(into.doc).find((x) => x.id === tgt.id);
      return b === undefined ? "" : (proseText(b, tgt.doc, load, depth + 1) ?? "");
    }
    const kids = (n as { children?: Inline[] }).children;
    if (kids !== undefined) return render(kids);
    const v = (n as { value?: string }).value;
    return v ?? "";
  }).join("");
  return render(para.inlines);
}

/** 把 `meta.tracks` 的「名字:种类」读成一张表，顺带报它自己的毛病。 */
function trackKinds(m: Map<string, string>, rel: string, out: MediaDiagnostic[]): Map<string, string> {
  const kinds = new Map<string, string>();
  const decl = (m.get("tracks") ?? "").trim();
  if (decl === "") return kinds;
  for (const entry of decl.split(/\s+/)) {
    const colon = entry.indexOf(":");
    if (colon < 0) {
      out.push(mediaDiag("media-track-kind-missing",
        `\`meta.tracks\` 里的 \`${entry}\` 只有名字没有种类；写成 \`${entry}:video\`（种类是 video / audio / prose）`, rel));
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
  for (const rel of seen) {
    const l = docs.get(rel);
    if (l === null || l === undefined) continue;
    for (const b of blocksOf(l.doc)) if (b.type === "media-asset" && b.id !== undefined) assets.set(`${rel}#${b.id}`, { l, b });
  }

  // ---- 素材：哈希、文件、种类、of --------------------------------------------
  const currentHash = new Map<string, string | null>();   // "doc#id" -> 文件现值
  for (const [key, { l, b }] of assets) {
    const src = str(b.attrs["src"]);
    const declared = str(b.attrs["sha256"]);
    if (src === undefined || src === "") {
      out.push(mediaDiag("media-src-unresolved", "`media-asset` 没有 `src=`", l.rel, b.id));
      continue;
    }
    const path = joinRel(dirOf(l.rel), src);
    const now = io.hashFile(path);
    currentHash.set(key, now);
    if (now === null) {
      out.push(mediaDiag("media-file-missing", `\`${src}\` 不存在（描述别处素材的库照样合法，只是未校验）`, l.rel, b.id));
    } else if (declared === undefined) {
      out.push(mediaDiag("media-asset-unhashed", "没有 `sha256=`，这份素材的血缘不可校验", l.rel, b.id));
    } else if (declared !== now) {
      out.push(mediaDiag("media-hash-mismatch",
        `\`${src}\` 在，但它的 SHA-256 是 \`${now.slice(0, 12)}…\`，声明的是 \`${declared.slice(0, 12)}…\` —— 文件在、内容却不是它说的那个，比没有更糟`,
        l.rel, b.id));
    }
    if (declared === undefined && now === null) {
      out.push(mediaDiag("media-asset-unhashed", "没有 `sha256=`，这份素材的血缘不可校验", l.rel, b.id));
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
    if (clips.length === 0) continue;
    const kinds = trackKinds(l.meta, rel, out);
    for (const b of clips) {
      const track = str(b.attrs["track"]);
      let kind: string | undefined;
      if (track === undefined || track === "") {
        out.push(mediaDiag("media-track-missing", "`media-clip` 没有 `track=`", rel, b.id));
      } else if (!kinds.has(track)) {
        out.push(mediaDiag("media-track-undeclared", `\`track=${track}\` 不在 \`meta.tracks\` 里`, rel, b.id));
      } else {
        kind = kinds.get(track);
      }
      const src = str(b.attrs["src"]);
      if (src === undefined || src === "") { out.push(mediaDiag("media-src-unresolved", "`media-clip` 没有 `src=`", rel, b.id)); continue; }
      const t = splitRef(src, rel);
      const target = t === null ? undefined : blockAt(t.doc, t.id);
      if (target === undefined) { out.push(mediaDiag("media-src-unresolved", `\`src=${src}\` 指不到任何块`, rel, b.id)); continue; }
      if (kind === "prose") {
        if (target.type !== "media-text") {
          out.push(mediaDiag("media-src-not-asset", `轨道 \`${track}\` 的种类是 prose，\`src\` 必须指 \`media-text\`，实际是 \`${target.type}\``, rel, b.id));
        } else if (str(b.attrs["dur"]) === undefined) {
          out.push(mediaDiag("media-dur-required", "散文没有固有时长，这一刀要写 `dur=`", rel, b.id));
        }
      } else if (kind !== undefined) {
        if (target.type !== "media-asset") {
          out.push(mediaDiag("media-src-not-asset", `轨道 \`${track}\` 的种类是 ${kind}，\`src\` 必须指 \`media-asset\`，实际是 \`${target.type}\``, rel, b.id));
        } else {
          const akind = str(target.attrs["kind"]);
          const timed = akind !== undefined && TIMED_KINDS.has(akind) && str(target.attrs["duration"]) !== undefined;
          if (!timed && str(b.attrs["dur"]) === undefined) {
            out.push(mediaDiag("media-dur-required", "源没有固有时长（静图，或没写 `duration=` 的音视频），这一刀要写 `dur=`", rel, b.id));
          }
        }
      }
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
    const list = byOutput.get(key);
    if (list === undefined) byOutput.set(key, [rec]); else list.push(rec);
  }

  /** 一个引用现在的哈希：素材看文件，散文块看展开后的文本。 */
  const nowHashOf = (ref: string, from: string): string | null => {
    const t = splitRef(ref, from);
    if (t === null) return null;
    const key = `${t.doc}#${t.id}`;
    if (assets.has(key)) return currentHash.get(key) ?? null;
    const b = blockAt(t.doc, t.id);
    if (b === undefined) return null;
    const text = proseText(b, t.doc, load);
    return text === null ? null : io.hashText(text);
  };

  const stale = new Map<string, string[]>();        // 素材 key -> 为什么
  const current = new Map<string, Rec>();           // 素材 key -> 当前记录
  for (const [key, recs] of byOutput) {
    const now = currentHash.get(key) ?? null;
    const match = recs.filter((x) => str(x.r["output-sha256"]) === now);
    const pick = (list: Rec[]): Rec => [...list].sort((a, b) => (str(a.r["at"]) ?? "") < (str(b.r["at"]) ?? "") ? 1 : -1)[0] as Rec;
    if (match.length === 0) {
      if (now !== null && recs.length > 0) {
        out.push(mediaDiag("media-orphan-record",
          "没有任何记录的 `output-sha256` 等于它现在的哈希 —— 这份字节来历不明", recs[0]!.rel, recs[0]!.id));
      }
      current.set(key, pick(recs));
      continue;
    }
    current.set(key, pick(match));
  }

  for (const [key, rec] of current) {
    const why: string[] = [];
    const prompt = str(rec.r["prompt"]);
    const promptSha = str(rec.r["prompt-sha256"]);
    if (prompt !== undefined && promptSha !== undefined) {
      const nowSha = nowHashOf(prompt, rec.rel);
      if (nowSha !== null && nowSha !== promptSha) why.push(`提示词 \`${prompt}\``);
    }
    const refs = rec.r["prompt-refs"];
    if (Array.isArray(refs)) {
      for (const it of refs as Record<string, unknown>[]) {
        const ref = str(it["ref"]); const was = str(it["sha256"]);
        if (ref === undefined || was === undefined) continue;
        const nowSha = nowHashOf(ref, rec.rel);
        if (nowSha !== null && nowSha !== was) why.push(`投射源 \`${ref}\``);
      }
    }
    const inputs = rec.r["inputs"];
    if (Array.isArray(inputs)) {
      for (const it of inputs as Record<string, unknown>[]) {
        const ref = str(it["ref"]); const was = str(it["sha256"]);
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
  return b === undefined ? null : proseText(b, t.doc, load);
}
