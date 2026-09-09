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
  selectorConditions, moreSpecific, type Selector, type Candidate,
} from "./style-selector.js";

/** style-rule 上的保留键；其余键原样透传为组件参数（设计 §5.4）。 */
const RULE_RESERVED = new Set(["match", "component", "handler", "show", "filter", "screen"]);
const STATE_KNOWN = new Set(["type", "match", "on", "value-from", "init-value"]);
const SCREEN_RESERVED = new Set(["slots", "layout"]);

/**
 * `on=` 的**封闭**词汇：运行时自己解释这些名字，所以非法成员是错误，
 * 不是"未知名字降级"（那条留给 component / handler 这类**开放**注册表）。
 * 同样的分野在核心 GEML 里已有先例：`chart-unknown-type` 是 error，
 * 而 `unknown-diagram-format` 是 warning。
 *
 * 目前只有一个成员，因为目前只有一种交互被真正接线。多的等实例出现再加。
 */
const INTERACTIONS = new Set(["select"]);

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

export interface StyleScreen {
  id: string;
  slots: string[];
  layout?: string;
}

export interface Stylesheet {
  rules: StyleRule[];
  states: StyleState[];
  screens: StyleScreen[];
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
      target = children; // 同文档内的 `#id`
    } else {
      if (!opts.loadDoc || !opts.parseDoc) { say("this caller supplied no document resolver"); continue; }
      if (seen.has(docPath)) { say(`\`${docPath}\` is already being expanded (cycle)`); continue; }
      const src = opts.loadDoc(docPath);
      if (src === null) { say(`cannot resolve \`${docPath}\``); continue; }
      // 被 embed 的可能就是一份**清单**（`embed {src=index.geml}` = "给我本站默认，
      // 不管它叫什么"）。所以这里也要跟 `default-style` —— 但**只跟它**，不跟
      // `#sitemap`：那张表是「为哪份文档」的，只有顶层的样式入口才有那个身份。
      // 跟来的规则和引用它的文件**同层**（显式 embed 不开新层），层内照 §4 决胜。
      target = withDefaultStyle(opts.parseDoc(src));
      seen = new Set([...seen, docPath]);
    }
    const picked = selectEmbed(target, anchor);
    if (picked === null) { say(anchor === undefined ? "the target is empty" : `\`#${anchor}\` is not in it`); continue; }
    out.push(...expandEmbeds(picked, sheet, opts, seen, depth + 1));
  }
  return out;
}

/** 样式表文档 → 结构化的规则/状态/屏幕，外加装载期诊断。 */
export function loadStylesheet(doc: Document, opts: StyleLoadOptions = {}): Stylesheet {
  const sheet: Stylesheet = { rules: [], states: [], screens: [], diagnostics: [] };
  // 层要**分开展开**，一层一次 expandEmbeds、各自一份 seen。合在一次里做会有两个后果，
  // 都实测过：默认层被后一层的 `embed` 再次引用时误报 cycle（同一次展开共享 seen），
  // 而且所有规则挤进同一层，`match="note"` 和 `match="#hero"` 就成了 §4 眼里不可比的
  // 两条 —— 首页那五份文档因此全报 ambiguous-rule。
  let layer = 0;
  for (const src of entryLayers(doc, opts.forDoc)) {
    collect(expandEmbeds([implicitEmbed(src.path, src.id)], sheet, opts, new Set(), 0), sheet, layer++);
  }
  // 被装载的这份文档自己写的规则是**最高层**：它最具体（它就是为这份产物/这个文档写的）。
  collect(expandEmbeds(doc.children, sheet, opts, new Set(), 0), sheet, layer);
  return sheet;
}

/** 把一层展开后的块序列读成规则/状态/屏幕，全部打上层号。 */
function collect(nodes: Block[], sheet: Stylesheet, layer: number): void {
  const blocks: Extract<Block, { kind: "block" }>[] = [];
  typedBlocks(nodes, blocks);
  for (const b of blocks) {
    const id = b.id ?? "(anon)";
    if (b.type === "embed") continue; // 已在 expandEmbeds 里处理（展开或报诊断）
    if (b.type === "style-rule") {
      const match = str(b.attrs["match"]);
      if (match === undefined) {
        sheet.diagnostics.push(styleDiag("style-missing-attribute", "`style-rule` requires `match=`", id));
        continue;
      }
      const r = parseSelector(match);
      if (!r.ok) { sheet.diagnostics.push(selectorDiag(r, id)); continue; }
      const params: Record<string, Value> = {};
      for (const [k, v] of Object.entries(b.attrs)) if (!RULE_RESERVED.has(k)) params[k] = v;
      const screensRaw = str(b.attrs["screen"]) ?? "";
      const rule: StyleRule = {
        id, branches: r.branches, params, layer,
        screens: screensRaw.split(/\s+/).filter((x) => x.length > 0),
      };
      const component = str(b.attrs["component"]); if (component !== undefined) rule.component = component;
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
    } else if (b.type === "style-screen") {
      const slots = str(b.attrs["slots"]);
      if (slots === undefined) {
        sheet.diagnostics.push(styleDiag("style-missing-attribute", "`style-screen` requires `slots=`", id));
        continue;
      }
      for (const k of Object.keys(b.attrs)) {
        if (!SCREEN_RESERVED.has(k)) sheet.diagnostics.push(styleDiag("style-unknown-attribute", `unknown attribute \`${k}\` for \`style-screen\``, id));
      }
      // 逗号分隔，不是空格 —— 空格在选择器里是**后代组合子**，按空格切会把
      // `#api table.kpi` 劈成两个槽位（实测：#api 选不中任何东西，还附送一条
      // 不解释真正原因的 unmatched-rule）。规矩是：名字列表用空格，选择器列表用逗号。
      const scr: StyleScreen = { id, slots: slots.split(",").map((x) => x.trim()).filter((x) => x.length > 0) };
      const layout = str(b.attrs["layout"]); if (layout !== undefined) scr.layout = layout;
      sheet.screens.push(scr);
    }
  }
}

/** 语料里的一份文档，连同它的路径 —— 地址必须按文档限定，见 CorpusDoc 上的注释。 */
export interface CorpusDoc {
  /** 文档路径，作为地址的限定前缀。语料内唯一即可。 */
  path: string;
  doc: Document;
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
  /** 命中它的规则 id，按样式表内的出现序 */
  rules: string[];
  /** 合并后的参数，含 component / handler / show / filter */
  params: Record<string, Value>;
}

/**
 * 一个已解析的屏幕槽位。**槽位不再是选择器字符串** —— 消费者若还要自己匹配选择器，
 * 就等于把构建期的求解在运行时重做一遍，而山寨的运行时匹配器必然和构建期语义分叉。
 * 这条是 spike 抓出来的：第一版视图模型只给原始 `slots` 字符串，
 * 运行时被迫写了个只认 `type#id` 的 slotMatches()。
 */
export type ResolvedSlot =
  | { kind: "blocks"; selector: string; blocks: { doc: string; block: string }[] }
  | { kind: "state"; state: string };

export interface ResolvedScreen {
  id: string;
  layout?: string;
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
  const out: Record<string, Value> = { ...r.params };
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
    const hits: { rule: StyleRule; conds: Set<string> }[] = [];
    for (const rule of active) {
      let best: Set<string> | null = null;
      for (const b of rule.branches) {
        if (!matches(b, entry.c)) continue;
        const conds = selectorConditions(b);
        // 屏幕限定进入条件集，特异性因此自动成立。
        if (rule.screens.length > 0 && screenId !== null) conds.add(`screen:${screenId}`);
        if (best === null || moreSpecific(conds, best)) best = conds;
      }
      if (best !== null) { hits.push({ rule, conds: best }); used.add(rule.id); }
    }
    if (hits.length === 0) continue;

    const params: Record<string, Value> = {};
    const owner = new Map<string, { rule: StyleRule; conds: Set<string> }>();
    for (const hit of hits) {
      for (const [k, v] of Object.entries(ruleProps(hit.rule))) {
        const prev = owner.get(k);
        if (prev === undefined) { params[k] = v; owner.set(k, hit); continue; }
        // **跨层先决胜**，再谈特异性。层是显式声明的顺序（CSS `@layer` 的模型），
        // 所以「上层赢」不需要任何 specificity 算术 —— 它甚至不看两个条件集。
        // 顺序很重要：先比特异性会让默认层里一条更具体的规则赢过上层的粗规则，
        // 那正是 `@layer` 存在的理由 —— 层的意思就是"这一层整体压过下面那层"。
        if (hit.rule.layer !== prev.rule.layer) {
          if (hit.rule.layer > prev.rule.layer) { params[k] = v; owner.set(k, hit); }
          continue;
        }
        if (moreSpecific(hit.conds, prev.conds)) { params[k] = v; owner.set(k, hit); continue; }
        if (moreSpecific(prev.conds, hit.conds)) continue;
        // 情况 2（条件集相同）与情况 3（不可比）的**补救办法不同**，所以建议必须分开：
        // 对相同的选择器建议"写并集"是不可能执行的 —— 两个相同集合的并集就是它自己。
        const identical = prev.conds.size === hit.conds.size && [...prev.conds].every((x) => hit.conds.has(x));
        diagnostics.push(styleDiag(
          "ambiguous-rule",
          `\`#${prev.rule.id}\` and \`#${hit.rule.id}\` both set \`${k}\` on \`${where(entry)}\`` +
          (screenId === null ? "" : ` in screen \`#${screenId}\``) + " — " +
          (identical
            ? `their selectors are identical, so no rule can be more specific; delete one, or add a condition that tells them apart`
            : `neither is more specific; write a rule matching the union of both selectors`),
          hit.rule.id,
        ));
      }
    }
    bindings.push({ doc: entry.path, block: address(entry.c), rules: hits.map((h) => h.rule.id), params });
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
  for (const scr of sheet.screens) for (const slot of scr.slots) checkRefs(slot, scr.id);

  for (const st of sheet.states) {
    const producers = all.filter((x) => st.match.some((b) => matches(b, x.c)));
    if (producers.length === 0) {
      diagnostics.push(styleDiag("unmatched-producer", `state \`#${st.id}\`: \`match=\` matched no block in the corpus`, st.id));
      continue;
    }
    if (st.valueFrom === undefined) continue;
    for (const p of producers) {
      const table = p.c.block.table;
      if (p.c.block.type !== "table" || table === undefined) continue;
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

  // 屏幕槽位在这里解析完：`$state` 直接记名字，选择器则展开成它选中的地址列表。
  // 运行时因此不需要任何选择器逻辑。
  const screens: ResolvedScreen[] = sheet.screens.map((scr) => {
    const slots: ResolvedSlot[] = scr.slots.map((slot) => {
      if (slot.startsWith("$")) return { kind: "state", state: slot.slice(1) };
      const r = parseSelector(slot);
      if (!r.ok) {
        diagnostics.push(selectorDiag(r, scr.id));
        return { kind: "blocks", selector: slot, blocks: [] };
      }
      const picked = all.filter((x) => r.branches.some((b) => matches(b, x.c)))
        .map((x) => ({ doc: x.path, block: address(x.c) }));
      if (picked.length === 0) {
        diagnostics.push(styleDiag("unmatched-rule", `screen \`#${scr.id}\`: slot \`${slot}\` matched no block in the corpus`, scr.id));
      }
      return { kind: "blocks", selector: slot, blocks: picked };
    });
    const out: ResolvedScreen = { id: scr.id, slots, bindings: perScreen.get(scr.id) ?? [] };
    if (scr.layout !== undefined) out.layout = scr.layout;
    return out;
  });

  return {
    states: sheet.states.map((s) => {
      const out: ViewModel["states"][number] = { id: s.id, type: s.type, on: s.on };
      if (s.valueFrom !== undefined) out.valueFrom = s.valueFrom;
      if (s.initValue !== undefined) out.initValue = s.initValue;
      return out;
    }),
    screens,
    bindings,
    diagnostics,
  };
}
