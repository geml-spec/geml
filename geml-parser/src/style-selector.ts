// geml-style 的选择器引擎（设计 §4）。
//
// 语法刻意只用 §4 已有的词汇：<type>?(.class)*(#id)?([key]|[key=val])*，
// 加上唯一一个组合子 —— 后代（空白）。`>` `+` `~` `:nth-child` `*` 和模糊匹配
// 一律拒绝并点名（§4.4）：CSS 相似性要当坡道，不能当陷阱。

import type { Block, Document, Value } from "./geml.js";
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
}

export type SelectorResult =
  | { ok: true; selector: Selector; branches: Selector[] }
  | { ok: false; code: "selector-unsupported"; message: string };

const SUPPORTED = "supported: type, .class, #id, [attr], [attr=val], descendant";

// 明确拒绝的构造，分两区扫描 —— 这不是洁癖，是正确性：
// 属性值里完全可能合法地出现 `:`（codemap 的 anchor 就是
// `ts:render.ts#esc(string)`），一遍过的正则会把它误判成伪类。
// 所以伪类/组合子/通配符只在**括号外**找，模糊匹配算子只在**括号内**找，
// 而引号内的内容两边都不参与。
const UNSUPPORTED_OUTSIDE = /::?[A-Za-z-]+(\([^)]*\))?|[>+~]|(^|[\s,])\*/;
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
  return { steps, source: src };
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
  if (branches.length === 0) return unsupported(trimmed);
  return { ok: true, selector: branches[0]!, branches };
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
  block: Extract<Block, { kind: "block" }>;
  /** 由外向内 */
  ancestors: AncestorRef[];
  /** 文档序下标，给没有 id 的块当稳定地址 */
  index: number;
}

/**
 * 枚举文档里每一个 typed block，并附上它的祖先链。
 *
 * 标题不是模型里的容器（它和后续块是兄弟），所以标题节的包含关系在这里
 * 用一个"当前打开的标题栈"重建：遇到 level ≤ 栈顶的标题就先弹栈，正是 §3
 * "up to, but not including, the next heading of the same or higher level"。
 */
export function candidates(doc: Document): Candidate[] {
  const out: Candidate[] = [];
  const counter = { n: 0 };
  walk(doc.children, [], out, counter);
  return out;
}

function walk(nodes: Block[], inherited: AncestorRef[], out: Candidate[], counter: { n: number }): void {
  const headings: { ref: AncestorRef; level: number }[] = [];
  for (const n of nodes) {
    if (n.kind === "heading") {
      while (headings.length > 0 && headings[headings.length - 1]!.level >= n.level) headings.pop();
      const ref: AncestorRef = { classes: n.classes, attrs: n.attrs };
      if (n.id !== undefined) ref.id = n.id;
      headings.push({ ref, level: n.level });
      continue;
    }
    if (n.kind !== "block") continue;
    const chain = [...inherited, ...headings.map((h) => h.ref)];
    out.push({ block: n, ancestors: chain, index: counter.n++ });
    if (n.children && n.children.length > 0) {
      const self: AncestorRef = { type: n.type, classes: n.classes, attrs: n.attrs };
      if (n.id !== undefined) self.id = n.id;
      walk(n.children, [...chain, self], out, counter);
    }
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
  const self: AncestorRef = { type: c.block.type, classes: c.block.classes, attrs: c.block.attrs };
  if (c.block.id !== undefined) self.id = c.block.id;
  const target = sel.steps[sel.steps.length - 1]!;
  if (!matchSimple(target, self)) return false;
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

/** 候选的稳定地址：有 id 用 `#id`，否则用文档序下标。 */
export function address(c: Candidate): string {
  return c.block.id !== undefined ? `#${c.block.id}` : `[${c.index}]`;
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
