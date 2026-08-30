// geml-style 样式表的装载、词汇校验与求解（设计 §4/§5）。
//
// 样式表是一份**普通的 .geml 文档**，靠 meta 的 `profile` 键声明身份。
// 三个块类型对核心 parser 而言是未注册类型 —— 其 body 是 raw、不被解析，
// 所以本 profile 的全部信息都写在属性对象里，由这里读取（设计 §3.2）。

import type { Block, Document, Value } from "./geml.js";
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

/** 样式表文档 → 结构化的规则/状态/屏幕，外加装载期诊断。 */
export function loadStylesheet(doc: Document): Stylesheet {
  const sheet: Stylesheet = { rules: [], states: [], screens: [], diagnostics: [] };
  const blocks: Extract<Block, { kind: "block" }>[] = [];
  typedBlocks(doc.children, blocks);

  for (const b of blocks) {
    const id = b.id ?? "(anon)";
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
        id, branches: r.branches, params,
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
  return sheet;
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
