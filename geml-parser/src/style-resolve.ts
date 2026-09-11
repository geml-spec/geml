// geml-style 样式表的装载、词汇校验与求解（设计 §4/§5）。
//
// 样式表是一份**普通的 .geml 文档**，靠 meta 的 `profile` 键声明身份。
// 三个块类型对核心 parser 而言是未注册类型 —— 其 body 是 raw、不被解析，
// 所以本 profile 的全部信息都写在属性对象里，由这里读取（设计 §3.2）。

import type { Block, Document, Value } from "./geml.js";
import { selectEmbed } from "./geml.js";
import { styleDiag, type StyleDiagnostic } from "./style-diagnostics.js";
import {
  parseSelector, selectorDiag, candidates, matches, address,
  selectorConditions, moreSpecific, isPartSelector, type Selector, type Candidate,
} from "./style-selector.js";

/** style-rule 上的保留键；其余键原样透传为组件参数（设计 §5.4）—— 内含词除外，见 BOX_WORDS。 */
const RULE_RESERVED = new Set(["match", "component", "handler", "show", "filter", "screen", "when"]);
/** 合并后仍留在 params 里、但由运行时而非组件消费的键（profile §5）。 */
const RUNTIME_KEYS = new Set(["component", "handler", "show", "filter"]);
const STATE_KNOWN = new Set(["type", "match", "on", "value-from", "init-value"]);
/** style-screen / style-frame 上的保留键。`layout` 已改名 `component`（设计 §12.4）。 */
const CONTAINER_RESERVED = new Set(["slots", "axis", "component"]);
/** `axis=` 的封闭值域：槽位横排还是竖排。默认 column。 */
const AXES = new Set(["row", "column"]);

/**
 * 内含词（设计 §12.3）：放在段落、表格、图上意思都一样的属性。由 profile 消费、
 * 落进视图模型的 `box`，**不透传**给组件 —— 所以组件不可能把 `width` 另解释成缩进。
 * 判据是"换个块还是不是这个意思"；只对某种控件才说得通的（`fold`、`collapsible`）
 * 仍是组件词，走 `params`。清单按第一个真实用例圈死，多一个不加。
 * `axis` 不在这里：它挂在 screen/frame 上，不挂在块上。
 */
export const BOX_WORDS: ReadonlySet<string> = new Set([
  "width", "max-width", "padding", "margin", "sticky", "scroll", "hide-below",
  "font-size", "line-height", "font-family", "text-align", "color", "background",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "gap",
  "layer", "visible", "grow",
  // 第二个页面用例（设计 2026-09-10）：`axis` 也能挂块上（列表横排）；`view`/`editable` 是"看源码"。
  "axis", "view", "editable",
  // 同一个用例的开场提示：画出来之后自己淡掉。
  "fade-out",
  // 这段文字带不带下划线。HTML 的默认是带，去掉是**外观决定**，该由样式表说 ——
  // 宿主替所有页面剥掉的那一版，连嵌进来的文章里的链接都一起剥了，正文的链接看不出是链接。
  "underline",
]);
/**
 * `border` 是**简写**，四个单边是它的一部分 —— 两者的结果取决于哪条声明落在后面，
 * 而 §4 是**按属性名**仲裁的，两个不同的名字从不相遇。于是同一层里的两条规则，
 * 一条写 `border`、一条写 `border-left`，只要在文件里换个先后，渲染结果就不同，
 * 而且零诊断 —— 正是排除源码顺序要防的那件事（`geml add --before` 能悄悄改掉它）。
 *
 * 所以简写与单边在同一层、同一 when 组、来自**不同规则**时，直接报 `ambiguous-rule`。
 * 写进同一条规则里是可以的：那里的先后是作者自己写下的，`geml set` 换的是整块。
 * 跨层也放行：层是声明出来的顺序（规则按层收集，低层先进 box），本来就有序。
 * `border-radius` 不在这一族里 —— 它跟边框的宽/样式/色互不覆盖。
 */
const BORDER_SIDES = ["border-top", "border-right", "border-bottom", "border-left"] as const;

/** 封闭值域的内含词。其余（`width=321px`、`color=#1f2328`）不校验，原样交给宿主。 */
const SCROLLS = new Set(["own", "page"]);
const NUMERIC_BOX = new Set(["sticky", "hide-below"]);
const ALIGNS = new Set(["left", "center", "right", "justify"]);
/**
 * `layer`：`page` 跟着文档流走；`overlay` 贴着最近的容器浮出来、不占位置（下拉菜单、弹出面板）；
 * `screen` 盖住整个视口、内容居中（开场提示、模态框、吐司）。三者的区别是**贴谁**，
 * 和内容是什么无关，所以它对任何块都是同一个意思。
 */
const LAYERS = new Set(["page", "overlay", "screen"]);
/**
 * `fade-out`：这一片画出来之后自己淡掉，值是秒数，0 表示不淡。时间轴上目前只有这一件事 ——
 * 「出现一下就走」对一段话、一张表、一张图意思都一样，所以它是内含词而不是组件参数。
 * 上限 60 秒：样式表是不可信输入，一个荒唐的值不该变成一条永远跑不完的动画。
 */
const FADE_MAX = 60;
/**
 * `underline`：带不带下划线。**不叫 `text-decoration`** —— 那是 CSS 的简写，管线型、线样式、
 * 线颜色、粗细四样，借了名字只兑现一丝，正是 §12.4 说的那种陷阱；也**不叫 `text-link`** ——
 * 内含词命名的是属性，作用在谁身上是选择器的事（`text#nav link`）。
 */
const UNDERLINES = new Set(["yes", "no"]);
/**
 * `visible`：这一片现在显不显示。`hide-below` 是按视口宽度的那一半，这是按**状态**的
 * 那一半 —— 下拉菜单、tab 切换、整片折叠，都得先能把「现在不显示」这句话说出来。
 */
const VISIBLES = new Set(["yes", "no"]);
/**
 * `grow`：这一格吃不吃行/列里剩下的空间。默认 `no` —— 按内容大小。
 * 宿主原来让行里每个容器等分拉伸，于是「一个图标那么大的一格」有三百像素宽，
 * 侧栏还会随正文内容变宽。谁吃剩余空间是版面的意思，得由样式表说出来。
 */
const GROWS = new Set(["yes", "no"]);
/** `view`：显示这一块的渲染结果还是源文本。任何块都有源文本，所以它是内含词。 */
const VIEWS = new Set(["rendered", "source"]);
/** `editable`：源文本可不可以改。只在 view=source 时被消费；否则惰性、不报。宿主没有写回路径。 */
const EDITABLES = new Set(["yes", "no"]);
/**
 * 行内部件上说得通的内含词：颜色、内外边距、边框、字号、（图的）宽度、显不显示。
 * sticky/scroll/hide-below/layer/grow/gap/text-align/axis/view/editable 是块或容器的事，
 * 写在部件规则上报 style-unknown-attribute。
 */
const PART_BOX: ReadonlySet<string> = new Set([
  "color", "background", "padding", "margin", "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-radius", "font-size", "line-height", "font-family", "width", "max-width", "visible", "underline",
]);

/** 校验一个内含词的值；域外值报 style-invalid-value，并告诉调用方别收它。 */
function boxValueOk(k: string, v: Value, id: string, sheet: Stylesheet): boolean {
  if (k === "axis" && !(typeof v === "string" && AXES.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`axis=${String(v)}\` is not \`row\` or \`column\``, id));
    return false;
  }
  if (k === "view" && !(typeof v === "string" && VIEWS.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`view=${String(v)}\` is not \`rendered\` or \`source\``, id));
    return false;
  }
  if (k === "editable" && !(typeof v === "string" && EDITABLES.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`editable=${String(v)}\` is not \`yes\` or \`no\``, id));
    return false;
  }
  if (k === "scroll" && !(typeof v === "string" && SCROLLS.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`scroll=${String(v)}\` is not \`own\` or \`page\``, id));
    return false;
  }
  if (k === "grow" && !(typeof v === "string" && GROWS.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`grow=${String(v)}\` is not \`yes\` or \`no\``, id));
    return false;
  }
  if (k === "visible" && !(typeof v === "string" && VISIBLES.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`visible=${String(v)}\` is not \`yes\` or \`no\``, id));
    return false;
  }
  if (k === "layer" && !(typeof v === "string" && LAYERS.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`layer=${String(v)}\` is not \`page\`, \`overlay\` or \`screen\``, id));
    return false;
  }
  if (k === "underline" && !(typeof v === "string" && UNDERLINES.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`underline=${String(v)}\` is not \`yes\` or \`no\``, id));
    return false;
  }
  if (k === "fade-out" && !(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= FADE_MAX)) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`fade-out=${String(v)}\` must be a number of seconds between 0 and ${FADE_MAX}`, id));
    return false;
  }
  if (k === "text-align" && !(typeof v === "string" && ALIGNS.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`text-align=${String(v)}\` is not left/center/right/justify`, id));
    return false;
  }
  if (NUMERIC_BOX.has(k) && typeof v !== "number") {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`${k}=${String(v)}\` must be a number (pixels)`, id));
    return false;
  }
  return true;
}

/**
 * `on=` 的**封闭**词汇：运行时自己解释这些名字，所以非法成员是错误，
 * 不是"未知名字降级"（那条留给 component / handler 这类**开放**注册表）。
 * 同样的分野在核心 GEML 里已有先例：`chart-unknown-type` 是 error，
 * 而 `unknown-diagram-format` 是 warning。
 *
 * `select` 是 codemap 接线的那一种；`toggle` 是第一个文档布局用例（折叠的文件树）
 * 带进来的，值在两个之间翻。多的等实例出现再加。
 */
const INTERACTIONS = new Set(["select", "toggle"]);

export interface WhenCond { state: string; value: string }

const WHEN_TERM = /^\$([A-Za-z0-9_-]+)=([^=!<>|&]+)$/;

/**
 * `when=` 里的内建伪状态（设计 2026-09-10 §4e）：值由指针给、不由 style-state 声明。`@` 前缀保证
 * 不与任何状态撞名。放在 when= 而不是选择器里：选择器选内容，when= 说状态（§12.5 的边界）。
 * 进条件集时是一个普通项（state 为 `@hover`、value 恒为 "true"），仲裁不另设规则。
 */
const PSEUDO = new Set(["hover", "focus"]);

/** 解析 `when=`；形式不对报 style-invalid-value 并返回 null。 */
function parseWhen(raw: string, id: string, sheet: Stylesheet): WhenCond[] | null {
  const out: WhenCond[] = [];
  for (const term of raw.split(",").map((x) => x.trim()).filter((x) => x.length > 0)) {
    if (term.startsWith("@")) {
      const name = term.slice(1);
      if (!PSEUDO.has(name)) {
        sheet.diagnostics.push(styleDiag("style-invalid-value",
          `\`${term}\` is not a built-in condition; \`when=\` knows \`@hover\` and \`@focus\``, id));
        return null;
      }
      out.push({ state: `@${name}`, value: "true" });
      continue;
    }
    const m = WHEN_TERM.exec(term);
    if (m === null || /\s(or|and)\s/i.test(term)) {
      sheet.diagnostics.push(styleDiag("style-invalid-value",
        `\`when=\` takes \`$state=value\` or \`@hover\`/\`@focus\` terms separated by commas (equality only); got \`${term}\``, id));
      return null;
    }
    out.push({ state: m[1]!, value: m[2]!.trim() });
  }
  return out;
}

export interface StyleRule {
  id: string;
  branches: Selector[];
  component?: string;
  handler?: string;
  show?: string;
  filter?: string;
  /**
   * 这条规则只在这些屏幕里生效；空 = 每个屏幕都生效。
   * 空格分隔，和 `profile` 同一个惯例（§4 不支持数组）——**名字**列表用空格，
   * **选择器**列表（`match` / `slots`）用逗号，因为空格在选择器里是后代组合子。
   */
  screens: string[];
  params: Record<string, Value>;
  /** 内含词（BOX_WORDS）。与 params 并列，结构上分开 —— 见 BOX_WORDS 上的注释。 */
  box: Record<string, Value>;
  /**
   * 这条规则只在这些状态取值时生效；空 = 无条件。`$state=value`，逗号并列表示全部满足。
   * **只做相等**：没有 `!=`、没有 or —— §5.3 "没有条件、没有算术"的克制不破。
   * 求解时它作为普通条件进入条件集（设计 §12.5），仲裁不另设规则。
   */
  when: WhenCond[];
  /**
   * 这条规则来自第几层。层由**样式入口**产生，顺序固定：`default-style` 是 0，
   * `#sitemap` 命中的那份是 1，入口自己写的规则在最上面。层内 §4 一字不改
   * （不看来源、不算 specificity、只认严格超集）；**跨层**才按层号决胜。
   *
   * 这是 CSS `@layer` 的模型，不是 specificity：层号是显式声明的顺序，不是从
   * 选择器算出来的分数。所以「id 选择器天生赢类型选择器」这条在这里依然不成立 ——
   * `match="#hero"` 之所以赢 `match="note"`，是因为它在更上面那一层。
   */
  layer: number;
}

export interface StyleState {
  id: string;
  /** `block-ref`（值是一个块 id）或 `scalar`。块类型定大类、`type=` 定小类 —— §7.1 的
   *  `diagram {type=bar}` 是同一个先例。目前只供人读：值的种类从消费方式就推得出来
   *  （`show="$s"` 必是块引用，`filter="x=$s"` 必是标量）。 */
  type: string;
  /** 哪些块喂它。和 `style-rule` 的 `match=` 是同一种东西，所以用同一个词。 */
  match: Selector[];
  on: string;
  /** 从产生者身上取哪一部分。`value=to` 会被读成"值设成 to"，所以带上方向。 */
  valueFrom?: string;
  initValue?: string;
}

/**
 * 一个装槽位的容器。`style-screen` 是**一页**（根）；`style-frame` 是页内的**一块区域**，
 * 只能被槽位引用、可以再装区域（设计 §12.4）。两者形状相同，区别在能否作根。
 */
export interface StyleContainer {
  id: string;
  slots: string[];
  /** 槽位横排（row）还是竖排（column）。内含词，宿主同解。 */
  axis: "row" | "column";
  /** 宿主命名的特殊排布（grid 之类），可选；与块上的 `component=` 同构。 */
  component?: string;
  /**
   * 容器自己的内含词。块上的 box 说"这一块长什么样"，容器上的说"这一片区域长什么样" ——
   * 整页底色、栏间距（`gap`）、区域内边距只有容器说得出，挂在任何一个块上都是错的。
   */
  box: Record<string, Value>;
  /**
   * 保留键与内含词之外的键，原样透传给 `component=` 点名的组件 —— 和规则上一模一样。
   * 页面外壳（顶栏、面包屑、图标）不是文档内容，把它塞进文档里冒充块才是错的；
   * 它属于样式表，所以容器得能带参数。
   */
  params: Record<string, Value>;
}
export type StyleScreen = StyleContainer;
export type StyleFrame = StyleContainer;

export interface Stylesheet {
  rules: StyleRule[];
  states: StyleState[];
  screens: StyleScreen[];
  frames: StyleFrame[];
  diagnostics: StyleDiagnostic[];
}

function typedBlocks(nodes: Block[], out: Extract<Block, { kind: "block" }>[]): void {
  for (const n of nodes) {
    if (n.kind !== "block") continue;
    out.push(n);
    if (n.children) typedBlocks(n.children, out);
  }
}

function str(v: Value | undefined): string | undefined {
  return v === undefined ? undefined : String(v);
}

/**
 * 样式表可以用 `embed` 组合：一份共享的默认层 + 本地的例外。`embed` 就是这个语言的
 * include，所以不需要新词汇——需要的只是装载器拿到和渲染器一样的两个钩子。展开在
 * **装载期**完成，于是展开之后所有规则都在同一份表里，§4 的仲裁一个字都不用改：
 * `table` 与 `table.actions` 本来就是严格超集关系，谁胜出与它们来自哪个文件无关。
 *
 * 目标块用 `selectEmbed` 选，和渲染器、`--to md`、`get --view` 是同一个函数——§10 的
 * 教训是「另写一份匹配器迟早和构建期语义分叉」，这里不再犯。
 */
export interface StyleLoadOptions {
  /** 按相对路径读一份文档；返回 null 表示读不到。与 RenderOptions.loadDoc 同形。 */
  loadDoc?: (relPath: string) => string | null;
  parseDoc?: (source: string) => Document;
  /**
   * 正在为**哪一份**内容文档装载（文件名，不含目录）。给了它，样式入口的 `#sitemap`
   * 表才有意义：那张表是「文档 → 额外样式表」，不指明文档就无从命中。
   * 不给就只有 `default-style` 那一层 —— 一份普通样式表压根没有这两个键，所以
   * 这个选项对非清单的输入是彻底的 no-op。
   */
  forDoc?: string;
}

const EMBED_DEPTH_CAP = 8;
/**
 * frame 嵌套的上限。和 EMBED_DEPTH_CAP 同一个理由：样式表是不可信输入，一条一万个 frame 的链
 * 没有环、却不能让宿主去渲染一万层盒子。GitHub 的 blob 页是 4 层；16 是给设计留的余量，不是量出来的。
 */
const FRAME_DEPTH_CAP = 16;

/**
 * 样式入口的两个键都是**隐式 embed**，层次和 CSS 一样：
 *
 *   [0] meta 的 `default-style` —— 基础层，**命中与否都加载**
 *   [1] `#sitemap` 表里 `<forDoc>` 精确命中的那份 —— 额外叠上去
 *
 * 也就是说一份清单声明了这两样，就等于它开头写了那两条 `=== embed`。于是"这个 site
 * 该加载哪几层"只有一处答案，几个调用者共用它：
 *
 *   宿主      把清单交给装载器就行 —— 它自己不做解析
 *   CLI       `geml style check _index/index.geml <文档>` 直接可用，不必先人肉查表
 *   模板作者  `embed {src=index.geml}` = "给我这个 site 的默认，不管它叫什么"
 *
 * **"它优先"是层号在起作用，不是 specificity。** 这是 CSS `@layer` 的模型：层的顺序
 * 是显式声明出来的（默认层在下、指派的那份在上、入口自己写的在最上），跨层冲突按
 * 层号决胜。§4 在**层内**一字不改 —— 不看来源、不算 specificity、只认严格超集，
 * 所以同一层里条件不可比的两条规则照常报 `ambiguous-rule`。
 *
 * 这一条是对 §4 的**扩展**，得记着：原本"仲裁与规则来自哪个文件无关"现在只对层内
 * 成立。没有它，默认层的 `match="note"` 和覆盖层的 `match="#hero"` 就是不可比的两条，
 * 首页那五份文档会全部报错 —— 实测过。
 *
 * 按名字 `embed {src=style.geml#base}` 依然可以——那是"我要那一份的那一节"，写死名字
 * 是作者的选择。显式 `embed` **不**开新层：它拉进来的规则和引用它的文件同层，靠 §4
 * 的严格超集决胜（`home-embed.geml` 一直是这么工作的）。
 *
 * 每层独立展开、各自一份 seen，所以环、深度上限和诊断全部免费复用；一份
 * `default-style` 指向自己的清单会照常报 cycle。
 */
function entryLayers(doc: Document, forDoc?: string): { path: string; id: string }[] {
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  const data = meta && meta.kind === "block" ? meta.data : undefined;
  const out: { path: string; id: string }[] = [];
  const dflt = str(data?.["default-style"]);
  // 默认层**命中与否都加载** —— 和 CSS 一样，它是基础，不是「没命中时的替补」。
  if (dflt) out.push({ path: dflt, id: "default-style" });
  if (forDoc === undefined) return out;
  const sitemap = doc.children.find((b) => b.kind === "block" && b.id === "sitemap");
  const rows = sitemap && sitemap.kind === "block" ? sitemap.table?.rows ?? [] : [];
  for (const r of rows) {
    if ((r[0]?.text ?? "").trim() !== forDoc) continue;
    const hit = (r[1]?.text ?? "").trim();
    // 指派成默认层自己不是错，但同一份不该当两层读 —— 那会让它自己跟自己比层号。
    if (hit !== "" && hit !== dflt) out.push({ path: hit, id: "sitemap-style" });
    break;
  }
  return out;
}

/**
 * 样式表里的**记号**（设计 §13.13）：`meta` 的每个键都是一个记号，块属性里的
 * `{{key}}` 在装载期换成它的值。没有新块类型、没有新语法 —— 复用核心 §4 的
 * `{{key}}` 写法，只是核心只在流文本里代换，属性里不动，所以这一层自己做。
 *
 * 为什么需要它：一份 104 块的样式表里 `#d1d9e0` 抄了 21 遍、`#59636e` 14 遍，
 * 改一次边框色要动 21 个块。CSS 用自定义属性解决这个已经十年了。
 *
 * 三条边界，都是有意的：
 *  - **一遍代换，不递归**。记号的值里的 `{{…}}` 原样留着，没有环可成。
 *  - **按文件**。embed 进来的规则用**它自己那份文件**的 meta —— 和核心对
 *    借来内容的规定一致（借来的 `{{key}}` 认源文档的 meta，不认宿主的）。
 *  - **悬空即错误**（`unknown-token`）。静默换成空串会让整页悄悄掉色。
 */
const TOKEN_REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

function tokensOf(doc: Document): Map<string, Value> {
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  const data = meta && meta.kind === "block" ? meta.data : undefined;
  return new Map<string, Value>(Object.entries(data ?? {}));
}

/** 属性值恰好是**一个**记号引用（没有别的字符）—— 那一个的类型要原样带过来。 */
const WHOLE_TOKEN = /^\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}$/;

/** 一份文档的顶层块序列 → 属性里的 `{{key}}` 都已按这份文档的 meta 代换过的副本。 */
function expandTokens(
  children: Block[], tokens: Map<string, Value>, sheet: Stylesheet,
): Block[] {
  // 没有 meta 块的文档（被 embed 进来的规则片段）里没有记号可用 —— 连扫都不必扫。
  // 只写了 `profile` 的样式表**要**扫：那里的 `{{nope}}` 依然是悬空引用，该响。
  if (tokens.size === 0) return children;
  const walk = (nodes: Block[]): Block[] => nodes.map((n) => {
    if (n.kind !== "block") return n;
    let attrs = n.attrs;
    for (const [k, v] of Object.entries(n.attrs)) {
      if (typeof v !== "string" || !v.includes("{{")) continue;
      const miss = (key: string): void => void sheet.diagnostics.push(styleDiag("unknown-token",
        `\`{{${key}}}\` in \`${k}=\` is not a key of this stylesheet's \`meta\``, n.id ?? "(anon)"));
      // 整个值就是一个记号时带上**类型**：`hide-below="{{col}}"` 配 meta 的 `col = 1012`
      // 要得到数字 1012，不是字符串 "1012" —— 否则数值域的内含词永远喂不进记号。
      const whole = WHOLE_TOKEN.exec(v);
      if (whole) {
        const hit = tokens.get(whole[1]!);
        if (hit === undefined) { miss(whole[1]!); continue; }
        if (attrs === n.attrs) attrs = { ...n.attrs };
        attrs[k] = hit;
        continue;
      }
      const swapped = v.replace(TOKEN_REF, (text, key: string) => {
        const hit = tokens.get(key);
        if (hit !== undefined) return String(hit);
        miss(key);
        return text;
      });
      if (swapped !== v) { if (attrs === n.attrs) attrs = { ...n.attrs }; attrs[k] = swapped; }
    }
    const kids = n.children ? walk(n.children) : undefined;
    if (attrs === n.attrs && kids === n.children) return n;
    const out = { ...n, attrs };
    if (kids !== undefined) out.children = kids;
    return out;
  });
  return walk(children);
}

/** 一份样式表文档 → 记号已代换、`default-style` 已前置的块序列。 */
function sheetBlocks(doc: Document, sheet: Stylesheet): Block[] {
  return expandTokens(withDefaultStyle(doc), tokensOf(doc), sheet);
}

/** 合成一个 embed 块，和解析器产出的同形（`mode: "raw"`、空 raw/classes），
 *  这样下游只有一条代码路径 —— 合成的块和写出来的块无从区分。 */
function implicitEmbed(src: string, id: string): Block {
  return { kind: "block", type: "embed", mode: "raw", id, raw: [], classes: [], attrs: { src } };
}

/** 一份文档 + 它 meta 里 `default-style` 指的那份（作为开头的一次隐式 embed）。 */
function withDefaultStyle(doc: Document): Block[] {
  const layers = entryLayers(doc);
  if (layers.length === 0) return doc.children;
  return [...layers.map((l) => implicitEmbed(l.path, l.id)), ...doc.children];
}

/** 就地展开样式表里的 embed，返回展开后的顶层块序列。 */
function expandEmbeds(
  children: Block[], sheet: Stylesheet, opts: StyleLoadOptions, seen: Set<string>, depth: number,
): Block[] {
  const out: Block[] = [];
  for (const b of children) {
    if (!(b.kind === "block" && b.type === "embed")) { out.push(b); continue; }
    const id = b.id ?? "(anon)";
    const written = str(b.attrs["src"]) ?? "";
    const hash = written.indexOf("#");
    const docPath = hash < 0 ? written : written.slice(0, hash);
    const anchor = hash < 0 ? undefined : written.slice(hash + 1);
    const say = (why: string): void => void sheet.diagnostics.push(
      styleDiag("style-embed-not-expanded",
        `\`embed\`${written ? ` of \`${written}\`` : ""} contributed no rules: ${why}`, id));

    if (written === "") { say("no `src=`"); continue; }
    if (depth >= EMBED_DEPTH_CAP) { say(`nesting deeper than ${EMBED_DEPTH_CAP}`); continue; }
    let target: Block[];
    if (docPath === "") {
      // 同文档内的 `#id`。这里也要防环：一节里写着 `embed {src=#本节}` 会把自己无限展开，
      // 之前只有深度上限兜着（实测出 9 份拷贝）。和跨文档一样用路径栈判，同一套消息。
      const key = `#${anchor ?? ""}`;
      if (seen.has(key)) { say(`\`${key}\` is already being expanded (cycle)`); continue; }
      target = children;
      seen = new Set([...seen, key]);
    } else {
      if (!opts.loadDoc || !opts.parseDoc) { say("this caller supplied no document resolver"); continue; }
      if (seen.has(docPath)) { say(`\`${docPath}\` is already being expanded (cycle)`); continue; }
      const src = opts.loadDoc(docPath);
      if (src === null) { say(`cannot resolve \`${docPath}\``); continue; }
      // 被 embed 的可能就是一份**清单**（`embed {src=index.geml}` = "给我本站默认，
      // 不管它叫什么"）。所以这里也要跟 `default-style` —— 但**只跟它**，不跟
      // `#sitemap`：那张表是「为哪份文档」的，只有顶层的样式入口才有那个身份。
      // 跟来的规则和引用它的文件**同层**（显式 embed 不开新层），层内照 §4 决胜。
      // 记号按**文件**算：跟来的规则用它自己那份 meta，不用宿主的（设计 §13.13）。
      target = sheetBlocks(opts.parseDoc(src), sheet);
      seen = new Set([...seen, docPath]);
    }
    const picked = selectEmbed(target, anchor);
    if (picked === null) { say(anchor === undefined ? "the target is empty" : `\`#${anchor}\` is not in it`); continue; }
    // 选中了、但一个块都没有（空文件、空的一节）：同样是"一条规则也没贡献"，该说出来。
    if (picked.length === 0) { say(anchor === undefined ? "the target is empty" : `\`#${anchor}\` holds no blocks`); continue; }
    out.push(...expandEmbeds(picked, sheet, opts, seen, depth + 1));
  }
  return out;
}

/** 样式表文档 → 结构化的规则/状态/屏幕，外加装载期诊断。 */
export function loadStylesheet(doc: Document, opts: StyleLoadOptions = {}): Stylesheet {
  const sheet: Stylesheet = { rules: [], states: [], screens: [], frames: [], diagnostics: [] };
  // 层要**分开展开**，一层一次 expandEmbeds、各自一份 seen。合在一次里做会有两个后果，
  // 都实测过：默认层被后一层的 `embed` 再次引用时误报 cycle（同一次展开共享 seen），
  // 而且所有规则挤进同一层，`match="note"` 和 `match="#hero"` 就成了 §4 眼里不可比的
  // 两条 —— 首页那五份文档因此全报 ambiguous-rule。
  let layer = 0;
  for (const src of entryLayers(doc, opts.forDoc)) {
    collect(expandEmbeds([implicitEmbed(src.path, src.id)], sheet, opts, new Set(), 0), sheet, layer++);
  }
  // 被装载的这份文档自己写的规则是**最高层**：它最具体（它就是为这份产物/这个文档写的）。
  collect(expandEmbeds(expandTokens(doc.children, tokensOf(doc), sheet), sheet, opts, new Set(), 0), sheet, layer);
  return sheet;
}

/** 把一层展开后的块序列读成规则/状态/屏幕，全部打上层号。 */
function collect(nodes: Block[], sheet: Stylesheet, layer: number): void {
  const blocks: Extract<Block, { kind: "block" }>[] = [];
  typedBlocks(nodes, blocks);
  for (const b of blocks) {
    const id = b.id ?? "(anon)";
    // embed 块到不了这里：expandEmbeds 要么把它展开成目标块，要么报诊断后丢弃。
    if (b.type === "style-rule") {
      const match = str(b.attrs["match"]);
      if (match === undefined) {
        sheet.diagnostics.push(styleDiag("style-missing-attribute", "`style-rule` requires `match=`", id));
        continue;
      }
      const r = parseSelector(match);
      if (!r.ok) { sheet.diagnostics.push(selectorDiag(r, id)); continue; }
      const partRule = isPartSelector(r.branches[0]!);
      const component = str(b.attrs["component"]);
      const params: Record<string, Value> = {};
      const box: Record<string, Value> = {};
      for (const [k, v] of Object.entries(b.attrs)) {
        if (RULE_RESERVED.has(k)) continue;
        if (BOX_WORDS.has(k)) {
          if (partRule && !PART_BOX.has(k)) {
            sheet.diagnostics.push(styleDiag("style-unknown-attribute",
              `\`${k}\` is not a word for an inline part (\`${r.branches[0]!.source}\`); it belongs on the block`, id));
            continue;
          }
          if (boxValueOk(k, v, id, sheet)) box[k] = v;
          continue;
        }
        // 其余键透传给组件。这里**不**判"没有 component= 就是笔误"：§4.3 按属性合并，一条规则给
        // 组件、另一条更具体的规则给参数是合法写法。有没有接收方要看合并后的绑定（resolveBindings）。
        params[k] = v;
      }
      const screensRaw = str(b.attrs["screen"]) ?? "";
      const whenRaw = str(b.attrs["when"]);
      let when: WhenCond[] = [];
      if (whenRaw !== undefined) {
        const parsed = parseWhen(whenRaw, id, sheet);
        if (parsed === null) continue;
        when = parsed;
      }
      const rule: StyleRule = {
        id, branches: r.branches, params, box, layer, when,
        screens: screensRaw.split(/\s+/).filter((x) => x.length > 0),
      };
      if (component !== undefined) rule.component = component;
      const handler = str(b.attrs["handler"]); if (handler !== undefined) rule.handler = handler;
      const show = str(b.attrs["show"]); if (show !== undefined) rule.show = show;
      const filter = str(b.attrs["filter"]); if (filter !== undefined) rule.filter = filter;
      sheet.rules.push(rule);
    } else if (b.type === "style-state") {
      const match = str(b.attrs["match"]);
      const on = str(b.attrs["on"]);
      if (match === undefined) sheet.diagnostics.push(styleDiag("style-missing-attribute", "`style-state` requires `match=`", id));
      if (on === undefined) sheet.diagnostics.push(styleDiag("style-missing-attribute", "`style-state` requires `on=`", id));
      for (const k of Object.keys(b.attrs)) {
        if (!STATE_KNOWN.has(k)) sheet.diagnostics.push(styleDiag("style-unknown-attribute", `unknown attribute \`${k}\` for \`style-state\``, id));
      }
      if (on !== undefined && !INTERACTIONS.has(on)) {
        sheet.diagnostics.push(styleDiag("unknown-interaction",
          `\`on=${on}\` is not an interaction this profile defines (known: ${[...INTERACTIONS].join(", ")})`, id));
      }
      if (match === undefined || on === undefined) continue;
      const r = parseSelector(match);
      if (!r.ok) { sheet.diagnostics.push(selectorDiag(r, id)); continue; }
      const st: StyleState = { id, type: str(b.attrs["type"]) ?? "block-ref", match: r.branches, on };
      const vf = str(b.attrs["value-from"]); if (vf !== undefined) st.valueFrom = vf;
      const iv = str(b.attrs["init-value"]); if (iv !== undefined) st.initValue = iv;
      sheet.states.push(st);
    } else if (b.type === "style-screen" || b.type === "style-frame") {
      const c = readContainer(b, id, b.type, sheet);
      if (c === null) continue;
      if (b.type === "style-screen") sheet.screens.push(c); else sheet.frames.push(c);
    }
  }
}

/**
 * 读一个容器块（style-screen / style-frame）。两者除了能否作根之外完全同形，
 * 所以是同一段代码 —— 分两份会让 `axis` 的校验在其中一份上漂掉。
 */
function readContainer(
  b: Extract<Block, { kind: "block" }>, id: string, kind: "style-screen" | "style-frame", sheet: Stylesheet,
): StyleContainer | null {
  const slots = str(b.attrs["slots"]);
  if (slots === undefined) {
    sheet.diagnostics.push(styleDiag("style-missing-attribute", `\`${kind}\` requires \`slots=\``, id));
    return null;
  }
  const component = str(b.attrs["component"]);
  const box: Record<string, Value> = {};
  const params: Record<string, Value> = {};
  for (const k of Object.keys(b.attrs)) {
    if (CONTAINER_RESERVED.has(k)) continue;
    // 内含词在容器上和在块上同解 —— 同一张表、同一道取值闸，不另立一套。
    if (BOX_WORDS.has(k)) {
      const v = b.attrs[k]!;
      if (boxValueOk(k, v, id, sheet)) box[k] = v;
      continue;
    }
    // `layout=` 是 v1 落地时的名字，0 个消费者时改成了和块上同一个词。指路，不静默。
    // `layout=` 是 v1 落地时的名字，0 个消费者时改成了和块上同一个词。指路，不静默。
    if (k === "layout") {
      sheet.diagnostics.push(styleDiag("style-unknown-attribute",
        `\`layout=\` is now \`component=\` (a host-named arrangement); \`split\` is \`axis=row\``, id));
      continue;
    }
    // 有 component= 才透传 —— 参数是给组件的。没有组件却写了别的键，那必然是笔误，
    // 报出来。规则那边不用分这一刀，因为规则总有个组件可以接。
    if (component === undefined) {
      sheet.diagnostics.push(styleDiag("style-unknown-attribute", `unknown attribute \`${k}\` for \`${kind}\``, id));
      continue;
    }
    params[k] = b.attrs[k]!;
  }
  let axis: "row" | "column" = "column";
  const axisRaw = str(b.attrs["axis"]);
  if (axisRaw !== undefined) {
    if (AXES.has(axisRaw)) axis = axisRaw as "row" | "column";
    else sheet.diagnostics.push(styleDiag("style-invalid-value", `\`axis=${axisRaw}\` is not \`row\` or \`column\``, id));
  }
  // 逗号分隔，不是空格 —— 空格在选择器里是**后代组合子**，按空格切会把
  // `#api table.kpi` 劈成两个槽位（实测：#api 选不中任何东西，还附送一条
  // 不解释真正原因的 unmatched-rule）。规矩是：名字列表用空格，选择器列表用逗号。
  const out: StyleContainer = { id, slots: slots.split(",").map((x) => x.trim()).filter((x) => x.length > 0), axis, box, params };
  if (component !== undefined) out.component = component;
  return out;
}

/** 语料里的一份文档，连同它的路径 —— 地址必须按文档限定，见 CorpusDoc 上的注释。 */
export interface CorpusDoc {
  /** 文档路径，作为地址的限定前缀。语料内唯一即可。 */
  path: string;
  doc: Document;
}

export interface Variant {
  /** 状态名 → 值。全部满足时这个 variant 生效。 */
  when: Record<string, string>;
  box: Record<string, Value>;
  params: Record<string, Value>;
}

/** 两个 when 集合是否**互斥**：对同一个状态给了不同的值，就不可能同时成立（设计 §12.5）。 */
function exclusive(a: WhenCond[], b: WhenCond[]): boolean {
  for (const x of a) for (const y of b) if (x.state === y.state && x.value !== y.value) return true;
  return false;
}

/** when 集合的规范键：排序后拼接，"" 表示无条件。同键 = 同一组。 */
function whenKey(w: WhenCond[]): string {
  return w.map((c) => `${c.state}=${c.value}`).sort().join("|");
}

export interface Binding {
  /**
   * 块所在文档的路径。**这个字段不是冗余的**：§4 只保证 id 在**单份文档内**唯一，
   * 所以两份文档里各有一个 `#budget` 是完全合法的，而选择器模型的常态就是
   * 一份样式表配一整个目录。没有它，消费者无法把绑定 join 回正确的块。
   */
  doc: string;
  /** 文档内地址：`#id`，或没有 id 时的文档序下标 */
  block: string;
  /** 部件绑定：这个块的某一类行内（`link` `image` `code-span` `strong` `emphasis`）。没有 = 块本身。 */
  part?: string;
  /** 命中它的规则 id，按样式表内的出现序 */
  rules: string[];
  /** 合并后的参数，含 component / handler / show / filter */
  params: Record<string, Value>;
  /** 合并后的内含词。宿主对它做一件事 —— 生成 CSS —— 对所有块一样。 */
  box: Record<string, Value>;
  /**
   * 按状态取值才生效的那部分（设计 §12.5）。按 `when` 条件数升序、同数按样式表内出现序；
   * 运行时把条件全部满足的依次叠在基础参数上 —— 真超集一定排在后面，所以不用再比。
   */
  variants: Variant[];
}

/**
 * 一个已解析的屏幕槽位。**槽位不再是选择器字符串** —— 消费者若还要自己匹配选择器，
 * 就等于把构建期的求解在运行时重做一遍，而山寨的运行时匹配器必然和构建期语义分叉。
 * 这条是 spike 抓出来的：第一版视图模型只给原始 `slots` 字符串，
 * 运行时被迫写了个只认 `type#id` 的 slotMatches()。
 */
export type ResolvedSlot =
  | { kind: "blocks"; selector: string; blocks: { doc: string; block: string }[] }
  | { kind: "state"; state: string }
  /** 本样式表的一个 style-frame；宿主在这个格子里递归渲染它（设计 §12.4）。 */
  | { kind: "frame"; frame: string };

export interface ResolvedFrame {
  id: string;
  axis: "row" | "column";
  component?: string;
  /** 给 `component=` 的参数（图标的路径、条目文字…）。与块上的组件参数同构。 */
  params: Record<string, Value>;
  /** 容器自己的内含词（背景、内边距、槽位间距…）。宿主照它给这一片区域上样式。 */
  box: Record<string, Value>;
  /** 按状态变的那几套 —— 和块上的同形。整片区域随状态显示/隐藏靠它。 */
  variants: Variant[];
  slots: ResolvedSlot[];
}

export interface ResolvedScreen {
  id: string;
  axis: "row" | "column";
  component?: string;
  /** 给 `component=` 的参数。 */
  params: Record<string, Value>;
  /** 整页的内含词。screen 是页，所以它的背景就是页面底色。 */
  box: Record<string, Value>;
  /** 按状态变的那几套。 */
  variants: Variant[];
  slots: ResolvedSlot[];
  /**
   * 这个屏幕上下文里的绑定表。`screen=` 让同一个块在不同屏幕里有不同展示，
   * 所以绑定不可能是全局的一张表。顶层的 `bindings` 是未限定屏幕的那一张。
   */
  bindings: Binding[];
}

export interface ViewModel {
  states: { id: string; type: string; on: string; valueFrom?: string; initValue?: string }[];
  screens: ResolvedScreen[];
  /** 顶层平铺、按 id 引用；没有 bindings —— 绑定表在 screen 上，覆盖整页所有块。 */
  frames: ResolvedFrame[];
  bindings: Binding[];
  diagnostics: StyleDiagnostic[];
}

export interface ResolveOptions {
  /** 宿主已注册的组件名；不给就不做 unknown-component 检查 */
  components?: string[];
  /** 宿主已注册的处理器名；不给就不做 unknown-handler 检查 */
  handlers?: string[];
}

/** 一条规则贡献的全部属性 —— 保留键与组件参数在这里合流。 */
function ruleProps(r: StyleRule): Record<string, Value> {
  const out: Record<string, Value> = { ...r.params, ...r.box };
  if (r.component !== undefined) out["component"] = r.component;
  if (r.handler !== undefined) out["handler"] = r.handler;
  if (r.show !== undefined) out["show"] = r.show;
  if (r.filter !== undefined) out["filter"] = r.filter;
  return out;
}

/**
 * 在一个屏幕上下文里求解绑定（`screenId` 为 null = 全局，只用未限定屏幕的规则）。
 *
 * `screen=` 的裁决**不需要新逻辑**：它作为一个额外条件进入条件集，于是限定屏幕的
 * 规则天然是同选择器未限定规则的真超集 —— 通用规则全局生效，屏幕规则在自己屏幕里
 * 胜出，正是想要的语义，而且是既有偏序白送的。
 */
function resolveBindings(
  sheet: Stylesheet,
  all: { c: Candidate; path: string }[],
  screenId: string | null,
  used: Set<string>,
  diagnostics: StyleDiagnostic[],
): Binding[] {
  const where = (x: { c: Candidate; path: string }): string => `${x.path}${address(x.c)}`;
  const bindings: Binding[] = [];
  const active = sheet.rules.filter((r) =>
    r.screens.length === 0 || (screenId !== null && r.screens.includes(screenId)));

  for (const entry of all) {
    const hits: { rule: StyleRule; conds: Set<string>; order: number }[] = [];
    active.forEach((rule, order) => {
      let best: Set<string> | null = null;
      for (const b of rule.branches) {
        if (!matches(b, entry.c)) continue;
        const conds = selectorConditions(b);
        // 屏幕限定与 when= 都进入条件集，特异性因此自动成立（设计 §5.5 / §12.5）。
        if (rule.screens.length > 0 && screenId !== null) conds.add(`screen:${screenId}`);
        for (const c of rule.when) conds.add(`when:${c.state}=${c.value}`);
        if (best === null || moreSpecific(conds, best)) best = conds;
      }
      if (best !== null) { hits.push({ rule, conds: best, order }); used.add(rule.id); }
    });
    if (hits.length === 0) continue;

    // 按 when 集合分组。"" 是基础组（无条件）。组内照 §4 仲裁 —— 一字不改；
    // 组间只查冲突与跨层，不赋值：一个有条件的规则赢了，它的值进 variant，不进基础参数。
    type Hit = typeof hits[number];
    type Group = { when: WhenCond[]; order: number; params: Record<string, Value>; owner: Map<string, Hit> };
    const groups = new Map<string, Group>();
    const groupOf = (h: Hit): Group => {
      const key = whenKey(h.rule.when);
      let g = groups.get(key);
      if (g === undefined) { g = { when: h.rule.when, order: h.order, params: {}, owner: new Map() }; groups.set(key, g); }
      return g;
    };
    const ambiguous = (a: Hit, b: Hit, k: string, identical: boolean): void => {
      // 屏幕名只在冲突的一方确实限定了屏幕时才带上：两条**未限定**的规则在每一轮
      // 屏幕求解里都会再撞一次，消息一字不差，靠 resolveStyle 的按消息去重合成一条 ——
      // 带上屏幕名就去重不了，一个冲突会按屏幕数翻倍。
      const scoped = a.rule.screens.length > 0 || b.rule.screens.length > 0;
      diagnostics.push(styleDiag(
        "ambiguous-rule",
        `\`#${a.rule.id}\` and \`#${b.rule.id}\` both set \`${k}\` on \`${where(entry)}\`` +
        (screenId !== null && scoped ? ` in screen \`#${screenId}\`` : "") + " — " +
        (identical
          ? `their selectors are identical, so no rule can be more specific; delete one, or add a condition that tells them apart`
          : `neither is more specific; write a rule matching the union of both selectors`),
        b.rule.id,
      ));
    };

    // 1) 组内仲裁：与 v1 落地时完全相同的循环，只是 owner 表按组分开。
    for (const hit of hits) {
      const g = groupOf(hit);
      for (const [k, v] of Object.entries(ruleProps(hit.rule))) {
        const prev = g.owner.get(k);
        if (prev === undefined) { g.params[k] = v; g.owner.set(k, hit); continue; }
        // **跨层先决胜**，再谈特异性。层是显式声明的顺序（CSS `@layer` 的模型），
        // 所以「上层赢」不需要任何 specificity 算术 —— 它甚至不看两个条件集。
        // 顺序很重要：先比特异性会让默认层里一条更具体的规则赢过上层的粗规则，
        // 那正是 `@layer` 存在的理由 —— 层的意思就是"这一层整体压过下面那层"。
        if (hit.rule.layer !== prev.rule.layer) {
          if (hit.rule.layer > prev.rule.layer) { g.params[k] = v; g.owner.set(k, hit); }
          continue;
        }
        if (moreSpecific(hit.conds, prev.conds)) { g.params[k] = v; g.owner.set(k, hit); continue; }
        if (moreSpecific(prev.conds, hit.conds)) continue;
        // 情况 2（条件集相同）与情况 3（不可比）的**补救办法不同**，所以建议必须分开：
        // 对相同的选择器建议"写并集"是不可能执行的 —— 两个相同集合的并集就是它自己。
        const identical = prev.conds.size === hit.conds.size && [...prev.conds].every((x) => hit.conds.has(x));
        ambiguous(prev, hit, k, identical);
      }
    }

    // 1b) 简写与单边：见 BORDER_SIDES 上方。按属性名的仲裁看不见这一对，得单独查。
    for (const g of groups.values()) {
      const short = g.owner.get("border");
      if (short === undefined) continue;
      for (const side of BORDER_SIDES) {
        const one = g.owner.get(side);
        if (one === undefined || one.rule.id === short.rule.id) continue;
        if (one.rule.layer !== short.rule.layer) continue;
        const [a, b] = short.order <= one.order ? [short, one] : [one, short];
        diagnostics.push(styleDiag(
          "ambiguous-rule",
          `\`#${a.rule.id}\` sets \`${a === short ? "border" : side}\` and \`#${b.rule.id}\` sets ` +
          `\`${b === short ? "border" : side}\` on \`${where(entry)}\` — a shorthand and one of its sides ` +
          `in the same layer, where the result depends on which declaration lands last, and a layer has no order; ` +
          `write both words in one rule, or put them in different layers`,
          b.rule.id,
        ));
      }
    }

    // 2) 组间：同一属性出现在两个组里时 —— 互斥的 when 集合永不同时生效，跳过；
    //    不同层，高层保留、低层丢掉该属性；同层要么一方是真超集（运行时按序叠加即可），
    //    要么不可比 → ambiguous-rule。相同的完整条件集在不同组里不可能出现。
    const gs = [...groups.values()];
    for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
      const A = gs[i]!, B = gs[j]!;
      if (exclusive(A.when, B.when)) continue;
      for (const k of Object.keys(A.params)) {
        if (!(k in B.params)) continue;
        const a = A.owner.get(k)!, b = B.owner.get(k)!;
        if (a.rule.layer !== b.rule.layer) {
          const loser = a.rule.layer > b.rule.layer ? B : A;
          delete loser.params[k]; loser.owner.delete(k);
          continue;
        }
        if (moreSpecific(a.conds, b.conds) || moreSpecific(b.conds, a.conds)) continue;
        ambiguous(a, b, k, false);
      }
    }

    // 3) 组装：基础组进 box/params；其余组按条件数升序、同数按出现序进 variants。
    const split = (p: Record<string, Value>): { box: Record<string, Value>; params: Record<string, Value> } => {
      const box: Record<string, Value> = {}, params: Record<string, Value> = {};
      for (const [k, v] of Object.entries(p)) (BOX_WORDS.has(k) ? box : params)[k] = v;
      return { box, params };
    };
    const base = groups.get("");
    const baseSplit = split(base?.params ?? {});
    // 跨层被拿空的组不再是一个 variant：一个什么都不设的 variant 是噪音，不是信息。
    const variants: Variant[] = gs
      .filter((g) => g.when.length > 0 && Object.keys(g.params).length > 0)
      .sort((x, y) => x.when.length - y.when.length || x.order - y.order)
      .map((g) => {
        const s = split(g.params);
        // 无原型：状态名来自样式表，`$__proto__=closed` 写进普通对象改的是原型不是属性，条件就静静丢了
        const when: Record<string, string> = Object.create(null);
        for (const c of g.when) when[c.state] = c.value;
        return { when, box: s.box, params: s.params };
      });
    // 参数要有接收方（设计 2026-09-10 §4f）。按**合并后**的绑定判，不按单条规则：§4.3 允许一条规则
    // 给组件、另一条更具体的规则给参数。合并之后仍没有 component=/handler= 的参数就是没人会读的键 ——
    // 第一个页面用例里十个私有键零校验、拼错静默，就是这一刀没切。容器那边装载期就能判，因为容器不合并。
    const hasReceiver = gs.some((g) => g.params["component"] !== undefined || g.params["handler"] !== undefined);
    if (!hasReceiver) {
      const stray = new Map<string, Hit>();
      for (const g of gs) for (const [k, h] of g.owner) {
        if (!RUNTIME_KEYS.has(k) && !BOX_WORDS.has(k) && !stray.has(k)) stray.set(k, h);
      }
      if (stray.size > 0) {
        const keys = [...stray.keys()];
        const setBy = [...new Set([...stray.values()].map((h) => `#${h.rule.id}`))].join(", ");
        diagnostics.push(styleDiag("style-unknown-attribute",
          `\`${keys.join("`, `")}\` on \`${where(entry)}\` ${keys.length === 1 ? "has" : "have"} no \`component=\` to receive ${keys.length === 1 ? "it" : "them"} (set by ${setBy})`,
          [...stray.values()][0]!.rule.id));
      }
    }
    const binding: Binding = {
      doc: entry.path, block: address(entry.c), rules: hits.map((h) => h.rule.id),
      params: baseSplit.params, box: baseSplit.box, variants,
    };
    if (entry.c.part !== undefined) binding.part = entry.c.part;
    bindings.push(binding);
  }
  return bindings;
}

/**
 * 把样式表对着语料求解成视图模型（设计 §4.3）。
 *
 * 合并按属性进行；同一属性被多条规则设置时，只有真超集能裁决，
 * 相同或不可比一律报 `ambiguous-rule` —— 不做源序兜底，因为样式表一旦
 * 顺序敏感，agent 的按块编辑（`geml set` / `geml add --before`）就会静默改变渲染。
 *
 * 冲突**对着语料判**：两条不可比的规则只有真的在某个块上共现才报错。
 */
export function resolveStyle(sheet: Stylesheet, corpus: CorpusDoc[], opts: ResolveOptions = {}): ViewModel {
  const diagnostics: StyleDiagnostic[] = [...sheet.diagnostics];
  const used = new Set<string>();

  // 容器也可以点名组件（页面外壳就住在那儿），所以未注册的名字在容器上同样要报 ——
  // 只查规则的话，写错的外壳组件会静默变成一个空的 section。
  if (opts.components !== undefined) {
    for (const c of [...sheet.screens, ...sheet.frames]) {
      if (c.component !== undefined && !opts.components.includes(c.component)) {
        diagnostics.push(styleDiag("unknown-component",
          `component \`${c.component}\` is not registered — renders inert`, c.id));
      }
    }
  }

  // 候选带上它来自哪份文档 —— 地址按文档限定（见 Binding.doc）。
  const all: { c: Candidate; path: string }[] = [];
  for (const entry of corpus) for (const c of candidates(entry.doc)) all.push({ c, path: entry.path });
  /** 诊断里用 GEML 自己的跨文档引用语法（§5.2）：`other.geml#id`。 */
  const where = (x: { c: Candidate; path: string }): string => `${x.path}${address(x.c)}`;

  // 每个屏幕一张绑定表，外加一张未限定屏幕的全局表。诊断按消息去重：
  // 同一个冲突在多张表里重复出现是噪音，而屏幕限定的冲突消息本就带屏幕名。
  const screenIds = new Set(sheet.screens.map((s) => s.id));
  for (const rule of sheet.rules) {
    for (const want of rule.screens) {
      if (!screenIds.has(want)) {
        diagnostics.push(styleDiag("unknown-screen", `rule \`#${rule.id}\`: \`screen=${want}\` names no \`style-screen\` block`, rule.id));
      }
    }
  }

  const raw: StyleDiagnostic[] = [];
  const bindings = resolveBindings(sheet, all, null, used, raw);
  const perScreen = new Map<string, Binding[]>();
  for (const scr of sheet.screens) perScreen.set(scr.id, resolveBindings(sheet, all, scr.id, used, raw));
  const seen = new Set<string>();
  for (const d of raw) {
    if (seen.has(d.message)) continue;
    seen.add(d.message);
    diagnostics.push(d);
  }

  /**
   * 指向容器的规则。`match="#side"` 这种裸 id 命中一个 frame（或 screen）时，这条规则
   * 说的是那一片区域，不是某个块 —— 于是「侧栏收起」「菜单弹出」和「块变宽」用的是
   * 同一套 when= 变体，不必为容器另造条件语法。
   *
   * 语料里若也有同名的块，两边都会生效 —— 那是作者自己的重名，报一条给他看。
   */
  const containerIds = new Set([...sheet.screens.map((c) => c.id), ...sheet.frames.map((c) => c.id)]);
  const forContainer = new Map<string, { box: Record<string, Value>; variants: Variant[] }>();
  for (const rule of sheet.rules) {
    // 只有单分支、且整条就是一个裸 #id 的规则才可能指向容器
    const m = rule.branches.length === 1 ? /^#([A-Za-z0-9_-]+)$/.exec(rule.branches[0]!.source.trim()) : null;
    if (!m || !containerIds.has(m[1]!)) continue;
    const id = m[1]!;
    const cur = forContainer.get(id) ?? { box: {}, variants: [] };
    if (rule.when.length === 0) Object.assign(cur.box, rule.box);
    else {
      const when: Record<string, string> = Object.create(null);
      for (const c of rule.when) when[c.state] = c.value;
      cur.variants.push({ when, box: rule.box, params: rule.params });
    }
    forContainer.set(id, cur);
    used.add(rule.id);
  }

  // unmatched-rule 在所有轮次跑完之后统一报一次：一条只在某屏幕生效的规则，
  // 在别的屏幕那轮里当然不会被用到，那不是"没选中任何块"。
  for (const rule of sheet.rules) {
    if (!used.has(rule.id)) {
      diagnostics.push(styleDiag("unmatched-rule", `rule \`#${rule.id}\` matched no block in the corpus`, rule.id));
    }
  }

  if (opts.components !== undefined) {
    const known = new Set(opts.components);
    for (const rule of sheet.rules) {
      if (rule.component !== undefined && !known.has(rule.component)) {
        diagnostics.push(styleDiag("unknown-component", `component \`${rule.component}\` is not registered — renders inert`, rule.id));
      }
    }
  }
  if (opts.handlers !== undefined) {
    const known = new Set(opts.handlers);
    for (const rule of sheet.rules) {
      if (rule.handler !== undefined && !known.has(rule.handler)) {
        diagnostics.push(styleDiag("unknown-handler", `handler \`${rule.handler}\` is not registered — renders inert`, rule.id));
      }
    }
  }

  // ---- 状态图（设计 §5）。构造上无环：interaction → state → view，
  // 状态永不读状态，所以这里没有、也不需要环检测。
  const declared = new Set(sheet.states.map((s) => s.id));
  const refs = (v: Value | undefined): string[] => {
    if (typeof v !== "string") return [];
    return [...v.matchAll(/\$([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  };
  const checkRefs = (v: Value | undefined, whereId: string): void => {
    for (const name of refs(v)) {
      if (!declared.has(name)) {
        diagnostics.push(styleDiag("unknown-state", `\`$${name}\` is not declared by any \`style-state\` block`, whereId));
      }
    }
  };
  for (const rule of sheet.rules) for (const v of Object.values(ruleProps(rule))) checkRefs(v, rule.id);
  // `@hover` / `@focus` 是内建伪状态，没有 style-state 声明它们。
  for (const rule of sheet.rules) for (const c of rule.when) if (!c.state.startsWith("@")) checkRefs(`$${c.state}`, rule.id);
  for (const scr of sheet.screens) for (const slot of scr.slots) checkRefs(slot, scr.id);
  for (const f of sheet.frames) for (const slot of f.slots) checkRefs(slot, f.id);

  for (const st of sheet.states) {
    const producers = all.filter((x) => st.match.some((b) => matches(b, x.c)));
    // 状态也可以由**容器**产生：`match="#menu-btn"` 指向一个 frame，点那一片翻这个状态。
    // 下拉菜单、弹出面板的「点哪儿」就是这么表达的 —— 触发者不一定是文档里的块。
    const onContainer = st.match.length === 1
      && /^#([A-Za-z0-9_-]+)$/.test(st.match[0]!.source.trim())
      && containerIds.has(st.match[0]!.source.trim().slice(1));
    if (producers.length === 0 && onContainer) continue;
    if (producers.length === 0) {
      diagnostics.push(styleDiag("unmatched-producer", `state \`#${st.id}\`: \`match=\` matched no block in the corpus`, st.id));
      continue;
    }
    if (st.valueFrom === undefined) continue;
    for (const p of producers) {
      const node = p.c.block;
      const table = node.kind === "block" ? node.table : undefined;
      if (p.c.self.type !== "table" || table === undefined) continue;
      const cols = table.columns;
      if (!cols.includes(st.valueFrom)) {
        diagnostics.push(styleDiag(
          "unknown-value-source",
          `state \`#${st.id}\`: \`value-from=${st.valueFrom}\` is not a column of \`${where(p)}\` (has: ${cols.join(", ")})`,
          st.id,
        ));
      }
    }
  }

  // ---- 槽位解析。`$state` 记名字；**裸 `#x` 是本样式表的 frame**（设计 §12.4）——
  // 语法上就和语料选择器分开了（语料块须带类型/类/属性），所以不需要查表消歧，
  // 写错的 `#bdoy` 也是 error 而非 warning；其余选择器展开成它选中的地址列表。
  // 运行时因此不需要任何选择器逻辑。
  const BARE_ID = /^#([A-Za-z0-9_-]+)$/;
  const frameIds = new Set(sheet.frames.map((f) => f.id));
  /** frame id → 引用它的容器 id（每个槽位记一次，同一容器引两次就记两次） */
  const referencedBy = new Map<string, string[]>();
  const resolveSlots = (owner: StyleContainer, ownerKind: "screen" | "frame"): ResolvedSlot[] => owner.slots.map((slot) => {
    if (slot.startsWith("$")) return { kind: "state", state: slot.slice(1) };
    const bare = BARE_ID.exec(slot);
    if (bare !== null) {
      const ref = bare[1]!;
      if (screenIds.has(ref)) {
        diagnostics.push(styleDiag("screen-nested",
          `${ownerKind} \`#${owner.id}\`: slot \`${slot}\` names a style-screen — a screen is a page and cannot be placed inside another; a region is a style-frame`, owner.id));
      } else if (!frameIds.has(ref)) {
        diagnostics.push(styleDiag("unknown-frame",
          `${ownerKind} \`#${owner.id}\`: slot \`${slot}\` names no style-frame block (a bare #id in slots= is a frame of this stylesheet; a corpus block needs a type, e.g. \`text${slot}\`)`, owner.id));
      } else {
        const owners = referencedBy.get(ref);
        if (owners === undefined) referencedBy.set(ref, [owner.id]); else owners.push(owner.id);
      }
      return { kind: "frame", frame: ref };
    }
    const r = parseSelector(slot);
    if (!r.ok) {
      diagnostics.push(selectorDiag(r, owner.id));
      return { kind: "blocks", selector: slot, blocks: [] };
    }
    // 槽位摆的是块；一类行内不是能摆的东西（它跟着自己的块走）。
    if (isPartSelector(r.branches[0]!)) {
      diagnostics.push(styleDiag("selector-unsupported",
        `${ownerKind} \`#${owner.id}\`: slot \`${slot}\` names an inline part; a slot places blocks, not parts of them`, owner.id));
      return { kind: "blocks", selector: slot, blocks: [] };
    }
    const picked = all.filter((x) => r.branches.some((b) => matches(b, x.c)))
      .map((x) => ({ doc: x.path, block: address(x.c) }));
    if (picked.length === 0) {
      diagnostics.push(styleDiag("unmatched-rule", `${ownerKind} \`#${owner.id}\`: slot \`${slot}\` matched no block in the corpus`, owner.id));
    }
    return { kind: "blocks", selector: slot, blocks: picked };
  });


  const screens: ResolvedScreen[] = sheet.screens.map((scr) => {
    // perScreen 上面刚为每个 screen 各填了一张表，这里的查找不会落空。
    const out: ResolvedScreen = { id: scr.id, axis: scr.axis, box: { ...scr.box, ...(forContainer.get(scr.id)?.box ?? {}) }, variants: forContainer.get(scr.id)?.variants ?? [], params: scr.params, slots: resolveSlots(scr, "screen"), bindings: perScreen.get(scr.id)! };
    if (scr.component !== undefined) out.component = scr.component;
    return out;
  });
  const frames: ResolvedFrame[] = sheet.frames.map((f) => {
    const out: ResolvedFrame = { id: f.id, axis: f.axis, box: { ...f.box, ...(forContainer.get(f.id)?.box ?? {}) }, variants: forContainer.get(f.id)?.variants ?? [], params: f.params, slots: resolveSlots(f, "frame") };
    if (f.component !== undefined) out.component = f.component;
    return out;
  });

  // ---- frame 的包含关系是一张从 screen 出发的 DAG：一个 frame 可以被放在多处（每处都再
  // 渲染一遍，等于把它的块点名两次），不能成环，嵌套有上限。两条检查各一趟、都不递归：
  // 样式表和文档一样是不可信输入（§9）—— 一万个 frame 串成的链不能把栈打爆，四十层菱形
  // （每层两个槽位指向同一个子 frame）不能把检查器拖成 2^40。
  //   frame-cycle     引用回到祖先：消息带整条链，链旋转到字典序最小的 id 开头再去重，
  //                   否则同一个环从不同起点走会得到不同的串
  //   frame-too-deep  最深的一条放置路径超过 FRAME_DEPTH_CAP：和 embed 的上限同一个理由
  const frameById = new Map(sheet.frames.map((f) => [f.id, f]));
  const frameRefs = (slots: string[]): string[] =>
    slots.map((s) => BARE_ID.exec(s)?.[1]).filter((r): r is string => r !== undefined && frameById.has(r));
  const reported = new Set<string>();
  const visited = new Set<string>();
  const stack: { id: string; path: string[] }[] = [];
  // 显式栈；`visited` 让每个 frame 只展开一次，菱形就不会指数。环的判定在**压栈前**看
  // 路径，所以不受 visited 影响。
  const drain = (): void => {
    while (stack.length > 0) {
      const { id, path } = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const next of frameRefs(frameById.get(id)!.slots)) {
        const at = path.indexOf(next);
        if (at >= 0) {
          const cyc = path.slice(at);
          const start = cyc.indexOf([...cyc].sort()[0]!);
          const rotated = [...cyc.slice(start), ...cyc.slice(0, start)];
          const chain = [...rotated, rotated[0]!].map((x) => `#${x}`).join(" → ");
          if (!reported.has(chain)) {
            reported.add(chain);
            diagnostics.push(styleDiag("frame-cycle", `frames nest in a cycle: ${chain}`, rotated[0]!));
          }
          continue;
        }
        stack.push({ id: next, path: [...path, next] });
      }
    }
  };
  // 先从每个 screen 出发（这才是真实的深度），再补上任何没被走到的 frame ——
  // 一个不挂在任何 screen 下的环也得报出来。
  for (const scr of sheet.screens) for (const r of frameRefs(scr.slots)) stack.push({ id: r, path: [r] });
  drain();
  for (const f of sheet.frames) if (!visited.has(f.id)) { stack.push({ id: f.id, path: [f.id] }); drain(); }

  // 深度单独算：一个 frame 被放在两处时两条路径的深度可能不同，DFS 只看见先到的那条。
  // 拓扑 DP 一遍精确：depth(f) = 1 + max(depth(放它的 frame))，放它的是 screen 记 0，
  // 没人放的（unused-frame）当自己那棵的根。环上的节点入度永远清不到 0，自然跳过 ——
  // 环已经在上面报了。O(N+E)，无递归。
  const indeg = new Map<string, number>();
  const depth = new Map<string, number>();
  for (const f of sheet.frames) { indeg.set(f.id, 0); depth.set(f.id, 1); }
  for (const f of sheet.frames) for (const r of frameRefs(f.slots)) indeg.set(r, indeg.get(r)! + 1);
  const ready = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
  while (ready.length > 0) {
    const id = ready.pop()!;
    const d = depth.get(id)!;
    for (const r of frameRefs(frameById.get(id)!.slots)) {
      if (depth.get(r)! < d + 1) depth.set(r, d + 1);
      indeg.set(r, indeg.get(r)! - 1);
      if (indeg.get(r) === 0) ready.push(r);
    }
  }
  let deepest: { id: string; d: number } | null = null;
  for (const [id, d] of depth) if (d > FRAME_DEPTH_CAP && (deepest === null || d > deepest.d)) deepest = { id, d };
  if (deepest !== null) {
    diagnostics.push(styleDiag("frame-too-deep",
      `frames nest ${deepest.d} deep at \`#${deepest.id}\`; the cap is ${FRAME_DEPTH_CAP} — a page is not that deep`, deepest.id));
  }

  for (const f of sheet.frames) {
    if (!referencedBy.has(f.id)) {
      diagnostics.push(styleDiag("unused-frame", `style-frame \`#${f.id}\` is referenced by no slot`, f.id));
    }
  }

  return {
    states: sheet.states.map((s) => {
      const out: ViewModel["states"][number] = { id: s.id, type: s.type, on: s.on };
      if (s.valueFrom !== undefined) out.valueFrom = s.valueFrom;
      if (s.initValue !== undefined) out.initValue = s.initValue;
      return out;
    }),
    screens,
    frames,
    bindings,
    diagnostics,
  };
}
