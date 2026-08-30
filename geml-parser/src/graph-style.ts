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
  /** 展开深度。codemap-profile 记的渲染器默认值是 6 */
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
 * 同上，但从**已解析的文档**读 —— 让调用方能走自己的文档缓存。
 * `buildCodeGraph` 就是这么用的：样式表和其他兄弟文档共用同一个 loadParsed 缓存，
 * 于是"重建完全走缓存、零 fetch"这条既有不变量继续成立。
 */
export function graphStyleFromDoc(doc: { children: Block[] }): GraphStyle {
  const cfg = defaultGraphStyle();
  const rule = findRule(doc.children);
  if (rule === null) return cfg;
  const a = rule.attrs;
  cfg.fold = num(a["fold"], cfg.fold);
  cfg.depth = num(a["depth"], cfg.depth);
  cfg.hideAccessors = bool(a["hide-accessors"], cfg.hideAccessors);
  const pal = a["palette"];
  if (pal !== undefined) {
    const list = String(pal).split(/\s+/).filter((x) => x.length > 0);
    if (list.length > 0) cfg.palette = list;
  }
  return cfg;
}

/** 播种用的文档。写成 geml-style 样式表，所以 `geml style check` 能验它。 */
export function serializeGraphStyle(cfg: GraphStyle): string {
  return '=== meta\nprofile = "geml-style/v1"\ntitle = "codemap graph style"\n===\n\n' +
    "Display-time knobs for `geml-code-graph`. Seeded on first build; edit\n" +
    "freely — build never rewrites this, exactly like `foldings.geml` beside it.\n" +
    "That one tunes BUILD-time folding; this one tunes what you see.\n\n" +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" \\\n' +
    `                fold=${cfg.fold} depth=${cfg.depth} ` +
    `hide-accessors=${cfg.hideAccessors} \\\n` +
    `                palette="${cfg.palette.join(" ")}"}\n===\n`;
}

/**
 * 装载 `<codemap>/_index/style.geml`，没有就播种一份默认的。
 * 与 `codemap/foldings.mjs` 的 `loadOrSeedFoldings` 同形 —— 那是这个做法的先例。
 */
export function loadOrSeedGraphStyle(outDir: string): { config: GraphStyle; seeded: boolean } {
  const path = join(outDir, "_index", "style.geml");
  if (existsSync(path)) {
    try { return { config: parseGraphStyle(readFileSync(path, "utf8")), seeded: false }; }
    catch { return { config: defaultGraphStyle(), seeded: false }; }
  }
  const cfg = defaultGraphStyle();
  try {
    mkdirSync(join(outDir, "_index"), { recursive: true });
    writeFileSync(path, serializeGraphStyle(cfg));
    return { config: cfg, seeded: true };
  } catch {
    // 只读目录之类：拿默认值继续渲染，不因为写不了调节面就失败。
    return { config: cfg, seeded: false };
  }
}
