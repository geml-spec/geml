// geml-code-graph 的**显示期**调节面（计划 D）。
//
// codemap 已经有一个调节面：`_index/foldings.geml`，文件头自己写着
// "Seeded on first build; edit freely — build never rewrites this"。它管的是
// 构建期的命名折叠。显示期的那一半 —— 折叠到几级、深度、accessor 隐不隐、配色 ——
// 一直写死在渲染器 JS 里，于是「想调展示」就得改一个服务所有人的渲染器，
// 每个改动都被迫必须通用。这个模块把那一半也变成一份可编辑的文档。
//
// **不替换渲染器。** codeGraphRuntime 的 1508 行（布局、缩放、方法搜索、调用链、
// cross-stack、同源限制）一行不动；改的只是那些数字从哪儿来。
// 因此默认值必须逐一等于渲染器今天的行为，既有的 118 个 codemap 测试才会原样通过。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./geml.js";
import type { Block, Value } from "./geml.js";

export interface GraphStyle {
  /** 显示期折叠到前 N 段路径。1 = 渲染器今天的 `first(p)` */
  fold: number;
  /** 展开深度。geml-codemap-profile 记的渲染器默认值是 6 */
  depth: number;
  /** bean get/set/is 叶子默认隐藏（工具条仍可切回来） */
  hideAccessors: boolean;
  /** 模块配色轮转 */
  palette: string[];
}

const PALETTE = [
  "#e3f2fd", "#e8f5e9", "#fff3e0", "#f3e5f5", "#e0f7fa", "#fce4ec",
  "#f1f8e9", "#ede7f6", "#fff8e1", "#e0f2f1", "#efebe9", "#f9fbe7",
];

export function defaultGraphStyle(): GraphStyle {
  return { fold: 1, depth: 6, hideAccessors: true, palette: [...PALETTE] };
}

function num(v: Value | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(v: Value | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  return String(v) !== "false";
}

function findRule(nodes: Block[]): Extract<Block, { kind: "block" }> | null {
  for (const n of nodes) {
    if (n.kind !== "block") continue;
    if (n.type === "style-rule") return n;
    if (n.children) { const hit = findRule(n.children); if (hit !== null) return hit; }
  }
  return null;
}

/**
 * 从一份 geml-style 样式表里读出显示旋钮。
 *
 * 找**第一条** `style-rule` 的属性 —— 这个调节面只描述一个视图（这份 codemap 的图），
 * 不需要选择器求解。`match=` 仍然写着，因为词汇要求它、而且它自我说明；
 * `geml style check` 也因此能验这份文件。
 *
 * 任何解析失败都退回默认值：调节面坏掉不该让渲染失败。
 */
export function parseGraphStyle(text: string): GraphStyle {
  try { return graphStyleFromDoc(parse(text)); } catch { return defaultGraphStyle(); }
}

/**
 * 只读出这份文档**真的写了**的那些旋钮，没写的键不出现。
 *
 * 叠加需要它：一层写死了默认值，就分不清"它要 fold=1"还是"它没提 fold"，
 * 于是上层的显式值会被下层的默认值盖掉。CSS 里没有这个问题是因为没写的属性
 * 压根不进那条规则；这里照同一个道理办。
 */
function writtenKnobs(doc: { children: Block[] }): Partial<GraphStyle> {
  const rule = findRule(doc.children);
  if (rule === null) return {};
  const a = rule.attrs;
  const written: Partial<GraphStyle> = {};
  if (a["fold"] !== undefined) written.fold = num(a["fold"], defaultGraphStyle().fold);
  if (a["depth"] !== undefined) written.depth = num(a["depth"], defaultGraphStyle().depth);
  if (a["hide-accessors"] !== undefined) written.hideAccessors = bool(a["hide-accessors"], true);
  if (a["palette"] !== undefined) {
    const list = String(a["palette"]).split(/\s+/).filter((x) => x.length > 0);
    if (list.length > 0) written.palette = list;
  }
  return written;
}

/**
 * 同上，但从**已解析的文档**读 —— 让调用方能走自己的文档缓存。
 * `buildCodeGraph` 就是这么用的：样式表和其他兄弟文档共用同一个 loadParsed 缓存，
 * 于是"重建完全走缓存、零 fetch"这条既有不变量继续成立。
 */
export function graphStyleFromDoc(doc: { children: Block[] }): GraphStyle {
  return { ...defaultGraphStyle(), ...writtenKnobs(doc) };
}

/**
 * 层层叠加：**默认值 → default-style → #sitemap 指派的那份**，后者只覆盖它自己
 * 写了的键。和 CSS 同一个模型 —— 默认层永远加载，命中时再额外加载指定的那份，
 * 它优先；它没提到的键落回默认层。
 *
 * 注意这里叠的是**旋钮**（几个数字），键对键覆盖；规则那边的层是同一个模型，但决胜
 * 发生在「同一个块上的同一个属性」这个粒度上（§4.1）。两处都只按层号，都不算
 * specificity。
 */
export function graphStyleFromLayers(docs: ({ children: Block[] } | null)[]): GraphStyle {
  const cfg = defaultGraphStyle();
  for (const d of docs) if (d !== null) Object.assign(cfg, writtenKnobs(d));
  return cfg;
}

/** 播种用的文档。写成 geml-style 样式表，所以 `geml style check` 能验它。 */
export function serializeGraphStyle(cfg: GraphStyle): string {
  return '=== meta\nprofile = "geml-style/v1"\ntitle = "codemap graph style"\n===\n\n' +
    "Display-time knobs for `geml-code-graph`. Seeded on first build; edit\n" +
    "freely — build never rewrites this, exactly like `foldings.geml` beside it.\n" +
    "That one tunes BUILD-time folding; this one tunes what you see.\n\n" +
    // `component=code-graph`：旋钮是给这个组件的参数（profile §2.1）。没有它，一条不带组件的 rule
    // 上的旋钮会被当成笔误报 style-unknown-attribute（设计 2026-09-10 §4f）。
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" component=code-graph \\\n' +
    `                fold=${cfg.fold} depth=${cfg.depth} ` +
    `hide-accessors=${cfg.hideAccessors} \\\n` +
    `                palette="${cfg.palette.join(" ")}"}\n===\n`;
}

/**
 * 一个根的样式表怎么找 —— 全系统只有这一条规则，只有这一处实现。
 * 返回的是**有序的层**，基础层在前、覆盖层在后：
 *
 *   `_index/index.geml`（样式入口，唯一固定路径）
 *     [0] meta 的 `default-style` —— **命中与否都加载**
 *     [1] `#sitemap` 表里 `<文档名>` 精确命中的那份 —— 额外加载，它优先
 *
 * 和 CSS 同一个模型：默认层永远在，指定的那份叠在上面，它没管到的落回默认层。
 * `#sitemap` 是精确匹配，没有 glob 也没有级联。
 *
 * **没有入口清单就是没有**：返回空列表，调用方用默认旋钮，补法是重新 build（种子会
 * 把清单写回来）。这里不回落去直读 `_index/style.geml` —— 两条发现路径就是两套
 * 语义，宿主和渲染器迟早会对同一份 map 给出不同结论。
 *
 * `loadFromIndex` 按**名字**在 `_index/` 里取一份文档，所以调用方各自决定怎么读：
 * 渲染器走 loadDoc 钩子（受 CLI 的限制约束、共享解析缓存），构建期走文件系统。
 */
export function resolveStyleLayers(
  loadFromIndex: (name: string) => { children: Block[] } | null,
  docName?: string,
): string[] {
  const mf = loadFromIndex("index.geml");
  if (mf === null) return [];
  let meta: Record<string, Value> | undefined;
  for (const b of mf.children) if (b.kind === "block" && b.type === "meta" && b.data) { meta = b.data; break; }
  // 名字用来找，meta 用来认：这个路径上放了别的东西时当作「没有入口」，不硬当清单读。
  if (meta === undefined || String(meta["profile"]) !== "geml-style/v1") return [];
  const layers: string[] = [];
  const dflt = meta["default-style"];
  if (dflt !== undefined && String(dflt) !== "") layers.push(String(dflt));
  if (docName !== undefined) {
    const sitemap = mf.children.find((b) => b.kind === "block" && b.id === "sitemap");
    const rows = sitemap && sitemap.kind === "block" ? sitemap.table?.rows ?? [] : [];
    for (const r of rows) {
      if ((r[0]?.text ?? "").trim() !== docName) continue;
      const hit = (r[1]?.text ?? "").trim();
      // 指派成默认层自己不是错，但也不该把同一份读两遍。
      if (hit !== "" && !layers.includes(hit)) layers.push(hit);
      break;
    }
  }
  return layers;
}

/**
 * 一份 map 的**样式入口**：`_index/index.geml`。任何 GEML 根都只有这一个固定路径，
 * 所以宿主、CLI、模板作者三方都只需要记住它。codemap 每份文档都用同一份样式表，
 * 所以这里不写 `#sitemap` 表 —— 37 行说同一件事没有意义；`default-style` 指明那一份，
 * 装载器把它当作一次隐式 embed 跟下去。
 *
 * 播种它和播种 style.geml 是一件事的两半：只播样式表，那份样式表就没有入口可达。
 */
function serializeStyleManifest(): string {
  return "=== meta\n" +
    'profile = "geml-style/v1"\n' +
    'title = "codemap style entry"\n' +
    'default-style = "style.geml"\n' +
    "===\n\n" +
    "This map's style entry point. `default-style` names the stylesheet every\n" +
    "document in this root uses. Seeded on first build; build never rewrites it.\n\n" +
    "To give some document a DIFFERENT stylesheet, add a `#sitemap` table here\n" +
    "(`| document | template |` rows). Resolution is two steps and no more: an\n" +
    "exact row wins, otherwise `default-style` — no glob, no cascade.\n";
}

/**
 * 装载 `<codemap>/_index/style.geml`，没有就播种一份默认的，并连带播种入口清单。
 * 与 `codemap/foldings.mjs` 的 `loadOrSeedFoldings` 同形 —— 那是这个做法的先例。
 */
export function loadOrSeedGraphStyle(
  outDir: string,
): { config: GraphStyle; seeded: boolean; seededEntry: boolean } {
  const path = join(outDir, "_index", "style.geml");
  const manifest = join(outDir, "_index", "index.geml");
  // 入口清单和样式表各自独立播种：手工删掉一个，下次 build 只补那一个。
  const seedManifest = (): boolean => {
    try {
      mkdirSync(join(outDir, "_index"), { recursive: true });
      if (existsSync(manifest)) return false;
      writeFileSync(manifest, serializeStyleManifest());
      return true;
    } catch { return false; } // 只读目录：入口缺失只降级到默认旋钮，不该让 build 失败
  };
  if (existsSync(path)) {
    const seededEntry = seedManifest();
    try { return { config: parseGraphStyle(readFileSync(path, "utf8")), seeded: false, seededEntry }; }
    catch { return { config: defaultGraphStyle(), seeded: false, seededEntry }; }
  }
  const cfg = defaultGraphStyle();
  try {
    mkdirSync(join(outDir, "_index"), { recursive: true });
    writeFileSync(path, serializeGraphStyle(cfg));
    return { config: cfg, seeded: true, seededEntry: seedManifest() };
  } catch {
    // 只读目录之类：拿默认值继续渲染，不因为写不了调节面就失败。
    return { config: cfg, seeded: false, seededEntry: false };
  }
}
