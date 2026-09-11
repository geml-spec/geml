// geml-style 的选择器引擎（设计 §4）。
//
// 语法刻意只用 §4 已有的词汇：<type>?(.class)*(#id)?([key]|[key=val])*，
// 加上唯一一个组合子 —— 后代（空白），以及作为**整步**的 `*`（任意节点）。
// `>` `+` `~` `:nth-child` 和模糊匹配一律拒绝并点名（§4.4）：CSS 相似性要当坡道，
// 不能当陷阱。`*` 是后来加的，因为一个槽位要按文档顺序摆下整篇文档时，块之间的散文
// 段落带不了 class，没有全选就写不出来；它只在"整步"位置合法，`.a*` 照旧被拒。
// 部件步（link image code-span strong emphasis）只在最后一步合法，见 PARTS。

import type { Block, Document, Inline, Value } from "./geml.js";
import { nameKey } from "./geml.js";
import { styleDiag, type StyleDiagnostic } from "./style-diagnostics.js";

export interface SimpleSelector {
  type?: string;
  classes: string[];
  id?: string;
  attrs: { key: string; value?: string }[];
}

export interface Selector {
  /** 后代链，最后一个是目标 */
  steps: SimpleSelector[];
  source: string;
  /** 解析出来但不致命的提醒（保留字的另一种读法）。由装载器变成 warning。 */
  notes?: string[];
}

export type SelectorResult =
  | { ok: true; selector: Selector; branches: Selector[]; notes?: string[] }
  | { ok: false; code: "selector-unsupported"; message: string };

const SUPPORTED = "supported: type, .class, #id, [attr], [attr=val], `*`, descendant, an inline part (link image code-span strong emphasis) as the last step";

/**
 * 行内部件（设计 2026-09-10 §4a）：选择器的最后一步可以指到块**里面**的一类行内节点，
 * 于是"这个块里的链接"能上色，而调色板不必写进宿主。名字取 GEML-spec §5.1 的叫法
 * （code span、emphasis）—— `code` 是块类型，`text#nav code` 今天已经有意思（嵌在里面的
 * 代码块），不能借来当行内用。值是行内节点在模型里的 type。
 */
export const PARTS: ReadonlyMap<string, string> = new Map([
  ["link", "link"], ["image", "image"], ["code-span", "code"], ["strong", "strong"], ["emphasis", "emph"],
]);

/** 这条选择器指的是部件（最后一步是部件名）还是块。 */
// 一步的选择器**永远不是**部件：部件要求前面有块步，所以在第一步的位置上这个名字
// 只可能是块类型。这条判断散在三处（这里、matches、parseOne），共用一个定义。
function partAt(sel: Selector, i: number): boolean {
  return i > 0 && i === sel.steps.length - 1 && PARTS.has(sel.steps[i]!.type ?? "");
}

export function isPartSelector(sel: Selector): boolean {
  if (sel.steps.length < 2) return false;
  const last = sel.steps[sel.steps.length - 1];
  return last !== undefined && last.type !== undefined && PARTS.has(last.type);
}

// 明确拒绝的构造，分两区扫描 —— 这不是洁癖，是正确性：
// 属性值里完全可能合法地出现 `:`（codemap 的 anchor 就是
// `ts:render.ts#esc(string)`），一遍过的正则会把它误判成伪类。
// 所以伪类/组合子/通配符只在**括号外**找，模糊匹配算子只在**括号内**找，
// 而引号内的内容两边都不参与。
const UNSUPPORTED_OUTSIDE = /::?[A-Za-z-]+(\([^)]*\))?|[>+~]|(?<!^|[\s,])\*|\*(?!$|[\s,])/;
const UNSUPPORTED_ATTR_OP = /[\^$*|]=/;

/** 找出第一个不被支持的构造，没有就返回 null。 */
function scanUnsupported(src: string): string | null {
  let outside = "", body = "", depth = 0, quote = "";
  const bodies: string[] = [];
  for (const ch of src) {
    if (quote) {
      if (ch === quote) quote = "";
      if (depth > 0) body += "x"; else outside += "x";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      if (depth > 0) body += "x"; else outside += "x";
      continue;
    }
    if (ch === "[") {
      depth++;
      if (depth === 1) { outside += "["; body = ""; } else body += ch;
      continue;
    }
    if (ch === "]") {
      depth--;
      if (depth === 0) { bodies.push(body); outside += "]"; } else body += ch;
      continue;
    }
    if (depth > 0) body += ch; else outside += ch;
  }
  const o = UNSUPPORTED_OUTSIDE.exec(outside);
  if (o) return o[0].trim();
  for (const b of bodies) {
    const m = UNSUPPORTED_ATTR_OP.exec(b);
    if (m) return m[0];
  }
  return null;
}

function unsupported(what: string): SelectorResult {
  return { ok: false, code: "selector-unsupported", message: `\`${what}\` is not supported (${SUPPORTED})` };
}

/** 在括号与引号之外按空白切分成后代步骤。 */
function splitSteps(src: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0, quote = "";
  for (const ch of src) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 在括号与引号之外按逗号切分成分支。 */
function splitBranches(src: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0, quote = "";
  for (const ch of src) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

function parseSimple(src: string): SimpleSelector | { error: string } {
  const sel: SimpleSelector = { classes: [], attrs: [] };
  // `*` = 不加任何限制的一步：匹配任意节点（类型块、标题、散文）。整步才算，
  // 所以 `*.kpi` 这种半吊子写法到不了这里 —— scanUnsupported 已经拒了。
  if (src === "*") return sel;
  let i = 0;
  const typeM = /^[A-Za-z][A-Za-z0-9_-]*/.exec(src);
  if (typeM) { sel.type = typeM[0]; i = typeM[0].length; }
  while (i < src.length) {
    const ch = src[i];
    if (ch === "." || ch === "#") {
      const m = /^[^.#[\]]+/.exec(src.slice(i + 1));
      if (!m) return { error: `empty ${ch === "." ? "class" : "id"} in \`${src}\`` };
      if (ch === ".") sel.classes.push(m[0]);
      else {
        if (sel.id !== undefined) return { error: `two ids in \`${src}\`` };
        sel.id = m[0];
      }
      i += 1 + m[0].length;
    } else if (ch === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) return { error: `unclosed \`[\` in \`${src}\`` };
      const body = src.slice(i + 1, end);
      const eq = body.indexOf("=");
      if (eq < 0) {
        const key = body.trim();
        if (!key) return { error: `empty attribute test in \`${src}\`` };
        sel.attrs.push({ key });
      } else {
        const key = body.slice(0, eq).trim();
        if (!key) return { error: `empty attribute name in \`${src}\`` };
        sel.attrs.push({ key, value: unquote(body.slice(eq + 1).trim()) });
      }
      i = end + 1;
    } else {
      return { error: `unexpected \`${ch}\` in \`${src}\`` };
    }
  }
  if (sel.type === undefined && sel.classes.length === 0 && sel.id === undefined && sel.attrs.length === 0) {
    return { error: `empty selector step` };
  }
  return sel;
}

function parseOne(src: string): Selector | { error: string } {
  const steps: SimpleSelector[] = [];
  for (const part of splitSteps(src)) {
    const s = parseSimple(part);
    if ("error" in s) return s;
    steps.push(s);
  }
  if (steps.length === 0) return { error: "empty selector" };
  // 部件步的三条规矩：只能在最后、前面要有块步、自己不带过滤。不在最后就成了"链接里面的块"，
  // 模型里没有这种东西；没有块步就是"语料里所有链接"，那是选择器选内容的边界之外。
  const notes: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.type === undefined || !PARTS.has(s.type)) continue;
    // 第一步上这个名字**只可能**是块类型 —— 部件要求前面有块步，所以这里没有歧义可言。
    // 以前这是个硬错误,于是一个类型叫 `link` 的块用类型名根本选不到,只剩 `#id` 和 `*`。
    // 现在照块类型匹配,同时把另一种读法说出来:作者想要的若是行内部件,就差一个块步。
    if (i === 0) {
      notes.push(`\`${s.type}\` is read as a block type here; the inline part of that name needs a block step before it (\`text#nav ${s.type}\`)`);
      continue;
    }
    if (i !== steps.length - 1) return { error: `\`${s.type}\` names an inline part and must be the last step in \`${src}\`` };
    if (s.id !== undefined || s.classes.length > 0 || s.attrs.length > 0) return { error: `an inline part takes no #id, .class or [attr] in \`${src}\`` };
  }
  return notes.length > 0 ? { steps, source: src, notes } : { steps, source: src };
}

/**
 * 解析一个 `match=` 值。逗号列表是纯语法糖 —— 等价于 N 条同体分支，
 * 优先级按分支各算各的（设计 §4.1）。`selector` 是第一条分支，便于单分支调用方直接用。
 */
export function parseSelector(src: string): SelectorResult {
  const trimmed = src.trim();
  if (!trimmed) return unsupported("");
  const bad = scanUnsupported(trimmed);
  if (bad !== null) return unsupported(bad);
  const branches: Selector[] = [];
  for (const b of splitBranches(trimmed)) {
    const r = parseOne(b);
    if ("error" in r) return { ok: false, code: "selector-unsupported", message: `${r.error} (${SUPPORTED})` };
    branches.push(r);
  }
  // 一条 match= 的分支要么全指块、要么全指部件：混着写会让同一条规则的内含词一半合法一半不合法。
  const partness = branches.map(isPartSelector);
  if (partness.some(Boolean) && !partness.every(Boolean)) {
    return { ok: false, code: "selector-unsupported", message: `branches of \`${trimmed}\` mix inline parts with blocks; write two rules (${SUPPORTED})` };
  }
  if (branches.length === 0) return unsupported(trimmed);
  const notes = branches.flatMap((b) => b.notes ?? []);
  return notes.length > 0
    ? { ok: true, selector: branches[0]!, branches, notes: [...new Set(notes)] }
    : { ok: true, selector: branches[0]!, branches };
}

/** 解析失败时把它变成一条本 profile 的诊断。 */
export function selectorDiag(r: Extract<SelectorResult, { ok: false }>, rule?: string): StyleDiagnostic {
  return styleDiag(r.code, r.message, rule);
}

/** 祖先链上的一环：一个标题节，或一个 flow 块。 */
export interface AncestorRef {
  /** 标题没有 type —— `#api table` 里的 `#api` 步骤因此不带 type 才能匹配上 */
  type?: string;
  id?: string;
  classes: string[];
  attrs: Record<string, Value>;
}

export interface Candidate {
  /** 可放置的节点：类型块、标题、或块之间的散文段落。 */
  block: Block;
  /**
   * 归一化后的匹配面。type 是：类型块的 `type`、标题的 `heading`、散文的 `prose`。
   * 标题和散文在 `geml list` 里一直可寻址（`#h1-before-t`），样式层没道理看不见它们；
   * 归一化在这里做一次，matches / address 都读它，不再各自去摸节点的形状。
   */
  self: AncestorRef;
  /** 由外向内 */
  ancestors: AncestorRef[];
  /** 文档序下标，给没有 id 的节点当稳定地址 */
  index: number;
  /** 部件候选：这个块的某一类行内（`link` `image` `code-span` `strong` `emphasis`）。没有 = 块本身。 */
  part?: string;
}

/**
 * 枚举文档里每一个 typed block，并附上它的祖先链。
 *
 * 标题不是模型里的容器（它和后续块是兄弟），所以标题节的包含关系在这里
 * 用一个"当前打开的标题栈"重建：遇到 level ≤ 栈顶的标题就先弹栈，正是 §3
 * "up to, but not including, the next heading of the same or higher level"。
 */
export function candidates(doc: Document): Candidate[] {
  const blocks: Candidate[] = [];
  const counter = { n: 0 };
  walk(doc.children, [], blocks, counter);
  // 部件候选紧跟它的块：块里出现过的每一类行内一个。地址、index 都沿用块的 —— 它不是新节点，
  // 是块的一个面；binding 用 `part` 区分。
  const out: Candidate[] = [];
  for (const c of blocks) {
    out.push(c);
    for (const [part, inlineType] of PARTS) {
      if (!hasInline(c.block, inlineType)) continue;
      out.push({ block: c.block, self: { type: part, classes: [], attrs: {} }, ancestors: [...c.ancestors, c.self], index: c.index, part });
    }
  }
  return out;
}

/** 块（含嵌套列表、嵌在里面的块）的行内里有没有这一类节点 —— 后代语义，和生成的 CSS 一致。 */
function hasInline(b: Block, type: string): boolean {
  const inl = (nodes: Inline[] | undefined): boolean =>
    (nodes ?? []).some((n) => n.type === type || inl((n as { children?: Inline[] }).children));
  if (b.kind === "heading" || b.kind === "paragraph") return inl(b.inlines);
  if (b.kind === "list") return b.items.some((it) => inl(it.inlines) || (it.children ?? []).some((ch) => hasInline(ch, type)));
  if (b.kind === "block") return (b.children ?? []).some((ch) => hasInline(ch, type));
  return false;
}

function walk(nodes: Block[], inherited: AncestorRef[], out: Candidate[], counter: { n: number }, insideBlock = false): void {
  const headings: { ref: AncestorRef; level: number }[] = [];
  for (const n of nodes) {
    const chain = () => [...inherited, ...headings.map((h) => h.ref)];
    if (n.kind === "heading") {
      while (headings.length > 0 && headings[headings.length - 1]!.level >= n.level) headings.pop();
      // 祖先用的 ref 不带 type —— `#api table` 里的 `#api` 步骤要能匹配上它。
      const ref: AncestorRef = { classes: n.classes, attrs: n.attrs };
      if (n.id !== undefined) ref.id = n.id;
      const outer = chain();
      headings.push({ ref, level: n.level });
      // 自身当候选时才带 type=heading，外加一个 `level` 属性：`heading[level=1]` 就能选一级标题。
      // `level` 铺在作者属性**后面**：层级是这一行的结构事实（`###` 数出来的），不是作者能
      // 改写的值。反过来铺的话 `### T {#t level=9}` 会让一个三级标题对外自称九级，于是
      // `heading[level=3]` 选不到它 —— 结构被一个同名属性悄悄盖掉。
      const self: AncestorRef = { type: "heading", classes: n.classes, attrs: { ...n.attrs, level: n.level } };
      if (n.id !== undefined) self.id = n.id;
      out.push({ block: n, self, ancestors: outer, index: counter.n++ });
      continue;
    }
    // 块**之间**的散文是文档的一节，可放置；块**内部**的段落是那个块的内容，不是。
    if (n.kind === "paragraph" && !insideBlock) {
      // 段落节点本身不带 id/class/attrs —— 它的地址是文档序（`[12]`），和 `geml list`
      // 给散文派生地址是同一件事的两种写法。
      const self: AncestorRef = { type: "prose", classes: [], attrs: {} };
      out.push({ block: n, self, ancestors: chain(), index: counter.n++ });
      continue;
    }
    if (n.kind !== "block") continue;
    const self: AncestorRef = { type: n.type, classes: n.classes, attrs: n.attrs };
    if (n.id !== undefined) self.id = n.id;
    out.push({ block: n, self, ancestors: chain(), index: counter.n++ });
    if (n.children && n.children.length > 0) walk(n.children, [...chain(), self], out, counter, true);
  }
}

function matchSimple(s: SimpleSelector, n: AncestorRef): boolean {
  if (s.type !== undefined && s.type !== n.type) return false;
  // §4: names compare under NFD.
  if (s.id !== undefined && (n.id === undefined || nameKey(s.id) !== nameKey(n.id))) return false;
  for (const c of s.classes) if (!n.classes.includes(c)) return false;
  for (const a of s.attrs) {
    if (!Object.hasOwn(n.attrs, a.key)) return false;
    if (a.value !== undefined && String(n.attrs[a.key]) !== a.value) return false;
  }
  return true;
}

/**
 * 选择器是否命中候选。最后一步匹配块本身，之前每一步必须在祖先链上
 * 按序找到 —— 后代是**子序列**关系，不是父子关系。
 */
export function matches(sel: Selector, c: Candidate): boolean {
  const target = sel.steps[sel.steps.length - 1]!;
  // 块选择器（含 `*`）与部件候选互不相干：否则 `slots="*"` 会把每个块摆两遍。
  const wantsPart = partAt(sel, sel.steps.length - 1);
  if (wantsPart !== (c.part !== undefined)) return false;
  if (!matchSimple(target, c.self)) return false;
  let ai = c.ancestors.length - 1;
  for (let si = sel.steps.length - 2; si >= 0; si--) {
    const step = sel.steps[si]!;
    let found = false;
    while (ai >= 0) {
      if (matchSimple(step, c.ancestors[ai--]!)) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

/** 候选的稳定地址：有 id 用 `#id`，否则用文档序下标。部件的地址就是它所属块的地址（binding 用 part 区分）。 */
export function address(c: Candidate): string {
  const owner = c.part !== undefined ? c.ancestors[c.ancestors.length - 1]! : c.self;
  return owner.id !== undefined ? `#${owner.id}` : `[${c.index}]`;
}

function simpleConditions(s: SimpleSelector, prefix: string, into: Set<string>): void {
  if (s.type !== undefined) into.add(`${prefix}type:${s.type}`);
  if (s.id !== undefined) into.add(`${prefix}id:${s.id}`);
  for (const c of s.classes) into.add(`${prefix}class:${c}`);
  for (const a of s.attrs) into.add(a.value === undefined ? `${prefix}attr:${a.key}` : `${prefix}attr:${a.key}=${a.value}`);
}

/**
 * 一条选择器的条件集（设计 §4.3）。祖先步骤按**位置**加前缀，
 * 于是 `#api table` 与 `#other table` 互不包含 —— 正确地不可比，
 * 而不是被错误地判成同级。
 */
export function selectorConditions(sel: Selector): Set<string> {
  const out = new Set<string>();
  const last = sel.steps.length - 1;
  sel.steps.forEach((s, i) => simpleConditions(s, i === last ? "" : `anc${i}:`, out));
  return out;
}

/** a 是否比 b 更特定 —— 真超集，没有权重、没有算术（设计 §4.3）。 */
export function moreSpecific(a: Set<string>, b: Set<string>): boolean {
  if (a.size <= b.size) return false;
  for (const x of b) if (!a.has(x)) return false;
  return true;
}
