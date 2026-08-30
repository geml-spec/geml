# geml-style 检查器（计划 A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `geml style check` —— 解析 geml-style 样式表、对着内容语料求解，产出可诊断、可对拍的**视图模型**，全程不碰 React。

**Architecture:** 三个新的扁平 TS 模块（`style-diagnostics` / `style-selector` / `style-resolve`）加一个 CLI 动词。选择器把样式表里的规则映射到内容文档的 block 上，按属性合并，按条件集的真超集偏序裁决冲突；状态图是 `interaction → state → view` 的单向管道，构造上无环。输出的视图模型是本 profile 的**一致性面**——第二实现不必附带 React 即可对拍。

**Tech Stack:** TypeScript（`tsc` → `dist/`）、node 内建 test 风格（`.test.mjs` + `node:assert`）、`c8` 覆盖率闸门。

**分支：** `feat/geml-style`（已存在，持有设计文档 `b88f0b3` + `33f9bff`）。

**依据：** `docs/superpowers/specs/2026-08-29-geml-style-design.md`。本计划只实现该设计的 §4（选择器）、§5（绑定）、§7（诊断）、§8（测试）。§6 的 React 运行时是**计划 B**，§3.3 的 profile 词汇表机制是**计划 C**，都不在本计划内。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `geml-parser/src/style-diagnostics.ts`（新建） | 本 profile 的诊断码目录与严重性表。**不进** GEML 的 Appendix A |
| `geml-parser/src/style-selector.ts`（新建） | 选择器的解析、候选枚举、匹配、条件集与偏序比较 |
| `geml-parser/src/style-resolve.ts`（新建） | 样式表装载与词汇校验、规则求解、状态图、视图模型 |
| `geml-parser/src/cli.ts`（修改） | 新增 `style` 动词，转发到 `runStyle` |
| `geml-parser/test/style-selector.test.mjs`（新建） | 选择器单元测试 |
| `geml-parser/test/style-check.test.mjs`（新建） | 端到端：样式表 + 语料 → 诊断与视图模型 |
| `geml-parser/test/all.mjs`（修改） | 注册两个新 suite |

**刻意的架构决定：新模块不从 `geml.ts` 再导出。** 测试直接
`import { … } from "../dist/style-selector.js"`。理由是仓库既有的硬约束——
对 `geml.ts` 顶层导入/再导出的任何改动都必须同步 viewer 的 esbuild stub
（`integrations/geml-viewer/src/render-html-stub.js`、node-stub），
否则整个浏览器 bundle 构建失败（`node:os` 在 4b93941、`pageAssets` 在 cd8bed4 都栽过）。
不再导出就完全绕开这个雷区。

---

## Task 1: 诊断目录

**Files:**
- Create: `geml-parser/src/style-diagnostics.ts`
- Test: `geml-parser/test/style-selector.test.mjs`

- [ ] **Step 1: 写下失败的测试**

创建 `geml-parser/test/style-selector.test.mjs`：

```js
// geml-style profile 的选择器引擎（设计 §4）与诊断目录（设计 §7）。
// 直接 import dist 模块 —— 这些模块刻意不从 geml.js 再导出，见计划的"文件结构"。
import { STYLE_SEVERITY } from "../dist/style-diagnostics.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

test("诊断目录：结构性错误是 error，未知名字是 warning（设计 §7）", () => {
  assert.equal(STYLE_SEVERITY["selector-unsupported"], "error");
  assert.equal(STYLE_SEVERITY["ambiguous-rule"], "error");
  assert.equal(STYLE_SEVERITY["unknown-state"], "error");
  assert.equal(STYLE_SEVERITY["unknown-value-source"], "error");
  assert.equal(STYLE_SEVERITY["unmatched-rule"], "warning");
  assert.equal(STYLE_SEVERITY["unmatched-producer"], "warning");
  assert.equal(STYLE_SEVERITY["unknown-component"], "warning");
  assert.equal(STYLE_SEVERITY["unknown-handler"], "warning");
});

test("诊断目录：没有 binding-cycle —— 构造上不可能（设计 §5.1）", () => {
  assert.equal(Object.hasOwn(STYLE_SEVERITY, "binding-cycle"), false);
});

console.log(`\n${passed} passed`);
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/style-selector.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/style-diagnostics.js'`

- [ ] **Step 3: 写最小实现**

创建 `geml-parser/src/style-diagnostics.ts`：

```ts
// geml-style profile 的诊断目录（设计 §7）。
//
// 这些码属于 profile，不进 GEML 规范的 Appendix A —— profile 不是规范。
// 严重性哲学：结构性错误 = error（歧义、悬空引用），未知名字 = warning + 惰性回退，
// 以保住 §8.5 的前向兼容机制（一个处理器不认识的名字必须降级，不能拒收文档）。
//
// 目录里没有 `binding-cycle`：数据流被限死成 interaction → state → view，
// 状态永不读状态，因此没有图，也就没有环可成（设计 §5.1）。

export type StyleDiagnosticCode =
  | "selector-unsupported"
  | "ambiguous-rule"
  | "unmatched-rule"
  | "unknown-state"
  | "unmatched-producer"
  | "unknown-value-source"
  | "unknown-component"
  | "unknown-handler"
  | "style-missing-attribute"
  | "style-unknown-attribute";

export type StyleSeverity = "error" | "warning";

export const STYLE_SEVERITY: Record<StyleDiagnosticCode, StyleSeverity> = {
  "selector-unsupported": "error",
  "ambiguous-rule": "error",
  "unknown-state": "error",
  "unknown-value-source": "error",
  "style-missing-attribute": "error",
  "unmatched-rule": "warning",
  "unmatched-producer": "warning",
  "unknown-component": "warning",
  "unknown-handler": "warning",
  "style-unknown-attribute": "warning",
};

export interface StyleDiagnostic {
  severity: StyleSeverity;
  code: StyleDiagnosticCode;
  message: string;
  /** 出问题的样式表块 id，若能定位 */
  rule?: string;
}

export function styleDiag(code: StyleDiagnosticCode, message: string, rule?: string): StyleDiagnostic {
  const d: StyleDiagnostic = { severity: STYLE_SEVERITY[code], code, message };
  if (rule !== undefined) d.rule = rule;
  return d;
}
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/style-selector.test.mjs`
Expected: PASS —— `2 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/style-diagnostics.ts geml-parser/test/style-selector.test.mjs
git commit -m "feat(style): the geml-style diagnostic catalogue"
```

---

## Task 2: 选择器解析

**Files:**
- Create: `geml-parser/src/style-selector.ts`
- Modify: `geml-parser/test/style-selector.test.mjs`

- [ ] **Step 1: 写下失败的测试**

在 `style-selector.test.mjs` 的 import 区加一行：

```js
import { parseSelector } from "../dist/style-selector.js";
```

在 `console.log(\`\n${passed} passed\`);` 之前插入：

```js
test("解析：type / .class / #id / [attr] / [attr=val]（设计 §4.1）", () => {
  const r = parseSelector("code.leaf#esc[anchor][kind=call]");
  assert.equal(r.ok, true);
  assert.equal(r.selector.steps.length, 1);
  const s = r.selector.steps[0];
  assert.equal(s.type, "code");
  assert.deepEqual(s.classes, ["leaf"]);
  assert.equal(s.id, "esc");
  assert.deepEqual(s.attrs, [{ key: "anchor" }, { key: "kind", value: "call" }]);
});

test("解析：后代组合子是空白（设计 §4.2）", () => {
  const r = parseSelector("#api table.kpi");
  assert.equal(r.ok, true);
  assert.equal(r.selector.steps.length, 2);
  assert.equal(r.selector.steps[0].id, "api");
  assert.equal(r.selector.steps[1].type, "table");
  assert.deepEqual(r.selector.steps[1].classes, ["kpi"]);
});

test("解析：带引号的属性值里的空白不切分步骤", () => {
  const r = parseSelector('code[anchor="ts:a.ts#f(x, y)"]');
  assert.equal(r.ok, true);
  assert.equal(r.selector.steps.length, 1);
  assert.deepEqual(r.selector.steps[0].attrs, [{ key: "anchor", value: "ts:a.ts#f(x, y)" }]);
});

test("不支持的 CSS 构造必须点名，不得静默失配（设计 §4.4）", () => {
  for (const bad of [":nth-child(2)", "div > p", "a + b", "a ~ b", "*", 'a[href^="x"]']) {
    const r = parseSelector(bad);
    assert.equal(r.ok, false, `应当拒绝：${bad}`);
    assert.equal(r.code, "selector-unsupported");
    assert.match(r.message, /supported: type, \.class, #id, \[attr\], \[attr=val\], descendant/);
  }
});

test("逗号列表是语法糖：等价于 N 条同体分支（设计 §4.1）", () => {
  const r = parseSelector("table.kpi, table.summary");
  assert.equal(r.ok, true);
  assert.equal(r.branches.length, 2);
  assert.equal(r.branches[0].steps[0].classes[0], "kpi");
  assert.equal(r.branches[1].steps[0].classes[0], "summary");
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/style-selector.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/style-selector.js'`

- [ ] **Step 3: 写最小实现**

创建 `geml-parser/src/style-selector.ts`：

```ts
// geml-style 的选择器引擎（设计 §4）。
//
// 语法刻意只用 §4 已有的词汇：<type>?(.class)*(#id)?([key]|[key=val])*，
// 加上唯一一个组合子 —— 后代（空白）。`>` `+` `~` `:nth-child` `*` 和模糊匹配
// 一律拒绝并点名（§4.4）：CSS 相似性要当坡道，不能当陷阱。

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

// 明确拒绝的构造，分两区扫描 —— 这不是洁癖，是正确性：属性值里完全可能
// 合法地出现 `:`（codemap 的 anchor 就是 `ts:render.ts#esc(string)`），
// 一遍过的正则会把它误判成伪类。所以伪类/组合子/通配符只在**括号外**找，
// 模糊匹配算子只在**括号内**找，引号内的内容两边都不参与。
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
    if (ch === "[") { depth++; if (depth === 1) { outside += "["; body = ""; } else body += ch; continue; }
    if (ch === "]") { depth--; if (depth === 0) { bodies.push(body); outside += "]"; } else body += ch; continue; }
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
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/style-selector.test.mjs`
Expected: PASS —— `7 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/style-selector.ts geml-parser/test/style-selector.test.mjs
git commit -m "feat(style): selector parsing, with named refusals for unsupported CSS"
```

---

## Task 3: 候选枚举与匹配

**Files:**
- Modify: `geml-parser/src/style-selector.ts`
- Modify: `geml-parser/test/style-selector.test.mjs`

**背景（实现者必读）：** 文档模型里**标题不是容器**。`# Api {#api}` 和它"底下"的
`table` 是 `children` 里的**兄弟节点**。所以"在 `#api` 这一节里"必须按 §3 的定义
从扁平序列上算：标题本身及其后所有块，直到下一个同级或更高级标题、或文档结束。
而 flow 块（`note` / `text`）是**真容器**，其 `children` 里是嵌套块。两种包含关系
都要进祖先链。

- [ ] **Step 1: 写下失败的测试**

在 import 区补：

```js
import { parse } from "../dist/geml.js";
import { candidates, matches } from "../dist/style-selector.js";
```

插入测试：

```js
const CORPUS = parse(
  '=== meta\ntitle = "c"\n===\n\n' +
  "# Api {#api}\n\n" +
  "=== table {#t1 .kpi format=csv}\na,b\n1,2\n===\n\n" +
  "# Other {#other}\n\n" +
  "=== table {#t2 .kpi format=csv}\na,b\n3,4\n===\n\n" +
  "==== note {#outer}\nprose\n\n=== code {#inner lang=js}\nx\n===\n====\n"
);

const hit = (sel) => {
  const r = parseSelector(sel);
  assert.equal(r.ok, true, `选择器应当解析成功：${sel}`);
  return candidates(CORPUS).filter((c) => r.branches.some((b) => matches(b, c)))
    .map((c) => c.block.id ?? "(anon)");
};

test("匹配：type + class 命中全文档（设计 §4.1）", () => {
  assert.deepEqual(hit("table.kpi"), ["t1", "t2"]);
});

test("匹配：标题节的包含关系按 §3 从扁平序列上算（设计 §4.2）", () => {
  assert.deepEqual(hit("#api table.kpi"), ["t1"]);
  assert.deepEqual(hit("#other table.kpi"), ["t2"]);
});

test("匹配：flow 块的 body 嵌套也是后代", () => {
  assert.deepEqual(hit("#outer code"), ["inner"]);
  assert.deepEqual(hit("note code"), ["inner"]);
});

test("匹配：后代是子序列，不是父子", () => {
  assert.deepEqual(hit("#api table"), ["t1"]);
  // #inner 隔着一层 note 容器，仍是 #other 节的后代 —— 子序列关系
  assert.deepEqual(hit("#other code"), ["inner"]);
  // 而它不在 #api 节里
  assert.deepEqual(hit("#api code"), []);
});

test("匹配：[attr] 测存在，[attr=val] 测相等", () => {
  assert.deepEqual(hit("table[format]"), ["t1", "t2"]);
  assert.deepEqual(hit("table[format=csv]"), ["t1", "t2"]);
  assert.deepEqual(hit("table[format=json]"), []);
});

test("匹配：逗号分支取并集，按文档序去重", () => {
  assert.deepEqual(hit("#t1, #inner"), ["t1", "inner"]);
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/style-selector.test.mjs`
Expected: FAIL —— `candidates is not a function`

- [ ] **Step 3: 写最小实现**

在 `style-selector.ts` 末尾追加（并在文件顶部补 import）：

```ts
import type { Block, Document, Value } from "./geml.js";
```

```ts
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
  if (s.id !== undefined && s.id !== n.id) return false;
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
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/style-selector.test.mjs`
Expected: PASS —— `13 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/style-selector.ts geml-parser/test/style-selector.test.mjs
git commit -m "feat(style): candidate enumeration and descendant matching

Headings are not containers in the model — a heading and the blocks under it
are siblings — so the section relation of §3 is rebuilt here from an open
heading stack. Flow bodies nest for real; both go on the ancestor chain."
```

---

## Task 4: 条件集与真超集偏序

**Files:**
- Modify: `geml-parser/src/style-selector.ts`
- Modify: `geml-parser/test/style-selector.test.mjs`

- [ ] **Step 1: 写下失败的测试**

import 区补 `selectorConditions, moreSpecific`，插入：

```js
const conds = (s) => selectorConditions(parseSelector(s).selector);

test("偏序：条件集是真超集才更特定（设计 §4.3）", () => {
  assert.equal(moreSpecific(conds("table.kpi[sortable]"), conds("table.kpi")), true);
  assert.equal(moreSpecific(conds("table.kpi"), conds("table")), true);
  assert.equal(moreSpecific(conds("table"), conds("table.kpi")), false);
});

test("偏序：条件集相同不算更特定（情况 2，设计 §4.3）", () => {
  assert.equal(moreSpecific(conds("table.kpi"), conds("table.kpi")), false);
  // 属性书写顺序不影响条件集 —— 集合语义，不是字符串比较
  assert.equal(moreSpecific(conds("table[a][b]"), conds("table[b][a]")), false);
  assert.equal(moreSpecific(conds("table[b][a]"), conds("table[a][b]")), false);
});

test("偏序：互不包含则不可比（情况 3，设计 §4.3）", () => {
  const a = conds("table.kpi"), b = conds("table[sortable]");
  assert.equal(moreSpecific(a, b), false);
  assert.equal(moreSpecific(b, a), false);
});

test("偏序：并集选择器对两者都是真超集 —— 逃生出口永远存在", () => {
  const u = conds("table.kpi[sortable]");
  assert.equal(moreSpecific(u, conds("table.kpi")), true);
  assert.equal(moreSpecific(u, conds("table[sortable]")), true);
});

test("偏序：祖先步骤按位置计入条件集", () => {
  assert.equal(moreSpecific(conds("#api table.kpi"), conds("table.kpi")), true);
  const x = conds("#api table"), y = conds("#other table");
  assert.equal(moreSpecific(x, y), false);
  assert.equal(moreSpecific(y, x), false);
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/style-selector.test.mjs`
Expected: FAIL —— `selectorConditions is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `style-selector.ts`：

```ts
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
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/style-selector.test.mjs`
Expected: PASS —— `18 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/style-selector.ts geml-parser/test/style-selector.test.mjs
git commit -m "feat(style): condition sets and the strict-superset partial order"
```

---

## Task 5: 样式表装载与词汇校验

**Files:**
- Create: `geml-parser/src/style-resolve.ts`
- Create: `geml-parser/test/style-check.test.mjs`

- [ ] **Step 1: 写下失败的测试**

创建 `geml-parser/test/style-check.test.mjs`：

```js
// geml-style 样式表的装载、求解与视图模型（设计 §4/§5/§7）。
import { parse } from "../dist/geml.js";
import { loadStylesheet } from "../dist/style-resolve.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const codes = (ds) => ds.map((d) => d.code).sort();

const sheet = (body) => loadStylesheet(parse('=== meta\nprofile = "geml-style/v1"\n===\n\n' + body));

test("装载：三种块被识别，其余块被忽略（设计 §3.2）", () => {
  const s = sheet(
    '=== style-rule {#r match="table" component=data-table}\n===\n\n' +
    '=== style-state {#sel type=block-ref match="table" on=select value-from=id}\n===\n\n' +
    '=== style-screen {#scr slots="table"}\n===\n\n' +
    "=== note {#ignored}\nnot ours\n===\n"
  );
  assert.deepEqual(s.rules.map((r) => r.id), ["r"]);
  assert.deepEqual(s.states.map((r) => r.id), ["sel"]);
  assert.deepEqual(s.screens.map((r) => r.id), ["scr"]);
});

test("装载：保留键之外的键原样透传为组件参数（设计 §5.4）", () => {
  const s = sheet('=== style-rule {#r match="table" component=kpi-card badge="leaf" collapsed}\n===\n');
  assert.deepEqual(s.rules[0].params, { badge: "leaf", collapsed: true });
  assert.equal(s.rules[0].component, "kpi-card");
  assert.equal(codes(s.diagnostics).length, 0);
});

test("装载：style-rule 缺 match= 是错误", () => {
  const s = sheet("=== style-rule {#r component=data-table}\n===\n");
  assert.deepEqual(codes(s.diagnostics), ["style-missing-attribute"]);
  assert.equal(s.diagnostics[0].severity, "error");
  assert.equal(s.diagnostics[0].rule, "r");
});

test("装载：style-state 缺 from=/on= 是错误", () => {
  const s = sheet("=== style-state {#sel type=block-ref}\n===\n");
  assert.deepEqual(codes(s.diagnostics), ["style-missing-attribute", "style-missing-attribute"]);
});

test("装载：style-state 上的未知键是 warning，不是 error", () => {
  const s = sheet('=== style-state {#sel type=block-ref match="table" on=select bogus=1}\n===\n');
  assert.deepEqual(codes(s.diagnostics), ["style-unknown-attribute"]);
  assert.equal(s.diagnostics[0].severity, "warning");
});

test("装载：不合法的选择器点名报错（设计 §4.4）", () => {
  const s = sheet('=== style-rule {#r match="div > p" component=x}\n===\n');
  assert.deepEqual(codes(s.diagnostics), ["selector-unsupported"]);
  assert.equal(s.diagnostics[0].rule, "r");
});

console.log(`\n${passed} passed`);
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/style-check.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/style-resolve.js'`

- [ ] **Step 3: 写最小实现**

创建 `geml-parser/src/style-resolve.ts`：

```ts
// geml-style 样式表的装载、词汇校验与求解（设计 §4/§5）。
//
// 样式表是一份**普通的 .geml 文档**，靠 meta 的 `profile` 键声明身份。
// 三个块类型对核心 parser 而言是未注册类型 —— 其 body 是 raw、不被解析，
// 所以本 profile 的全部信息都写在属性对象里，由这里读取（设计 §3.2）。

import type { Block, Document, Value } from "./geml.js";
import { styleDiag, type StyleDiagnostic } from "./style-diagnostics.js";
import { parseSelector, selectorDiag, type Selector } from "./style-selector.js";

/** style-rule 上的保留键；其余键原样透传为组件参数（设计 §5.4）。 */
const RULE_RESERVED = new Set(["match", "component", "capability", "show", "filter"]);
const STATE_KNOWN = new Set(["kind", "from", "on", "value", "initial"]);
const SCREEN_RESERVED = new Set(["slots", "layout", "doc"]);

export interface StyleRule {
  id: string;
  branches: Selector[];
  component?: string;
  capability?: string;
  show?: string;
  filter?: string;
  params: Record<string, Value>;
}

export interface StyleState {
  id: string;
  kind: string;
  from: Selector[];
  on: string;
  value?: string;
}

export interface StyleScreen {
  id: string;
  slots: string[];
  layout?: string;
  doc?: string;
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
      const rule: StyleRule = { id, branches: r.branches, params };
      const component = str(b.attrs["component"]); if (component !== undefined) rule.component = component;
      const capability = str(b.attrs["capability"]); if (capability !== undefined) rule.capability = capability;
      const show = str(b.attrs["show"]); if (show !== undefined) rule.show = show;
      const filter = str(b.attrs["filter"]); if (filter !== undefined) rule.filter = filter;
      sheet.rules.push(rule);
    } else if (b.type === "style-state") {
      const from = str(b.attrs["from"]);
      const on = str(b.attrs["on"]);
      if (from === undefined) sheet.diagnostics.push(styleDiag("style-missing-attribute", "`style-state` requires `from=`", id));
      if (on === undefined) sheet.diagnostics.push(styleDiag("style-missing-attribute", "`style-state` requires `on=`", id));
      for (const k of Object.keys(b.attrs)) {
        if (!STATE_KNOWN.has(k)) sheet.diagnostics.push(styleDiag("style-unknown-attribute", `unknown attribute \`${k}\` for \`style-state\``, id));
      }
      if (from === undefined || on === undefined) continue;
      const r = parseSelector(from);
      if (!r.ok) { sheet.diagnostics.push(selectorDiag(r, id)); continue; }
      const st: StyleState = { id, kind: str(b.attrs["kind"]) ?? "block-ref", from: r.branches, on };
      const value = str(b.attrs["value"]); if (value !== undefined) st.value = value;
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
      const scr: StyleScreen = { id, slots: slots.split(/\s+/).filter((x) => x.length > 0) };
      const layout = str(b.attrs["layout"]); if (layout !== undefined) scr.layout = layout;
      const d = str(b.attrs["doc"]); if (d !== undefined) scr.doc = d;
      sheet.screens.push(scr);
    }
  }
  return sheet;
}
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/style-check.test.mjs`
Expected: PASS —— `6 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/style-resolve.ts geml-parser/test/style-check.test.mjs
git commit -m "feat(style): stylesheet loading and vocabulary validation"
```

---

## Task 6: 规则求解 —— 合并、歧义、未命中

**Files:**
- Modify: `geml-parser/src/style-resolve.ts`
- Modify: `geml-parser/test/style-check.test.mjs`

- [ ] **Step 1: 写下失败的测试**

import 区补 `resolveStyle`，插入：

```js
const CORPUS = parse(
  '=== meta\ntitle = "c"\n===\n\n' +
  "=== table {#kpi .kpi format=csv sortable}\na,b\n1,2\n===\n\n" +
  "=== table {#plain format=csv}\na,b\n3,4\n===\n"
);
const resolve = (body) => resolveStyle(sheet(body), [CORPUS]);
const binding = (vm, addr) => vm.bindings.find((b) => b.block === addr);

test("求解：不同属性的规则按属性合并（设计 §4.3）", () => {
  const vm = resolve(
    '=== style-rule {#base match="table" component=data-table}\n===\n\n' +
    '=== style-rule {#kpis match="table.kpi" badge="kpi"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(binding(vm, "#kpi").params.component, "data-table");
  assert.equal(binding(vm, "#kpi").params.badge, "kpi");
  assert.equal(binding(vm, "#plain").params.badge, undefined);
});

test("求解：同属性冲突时最特定的赢（情况 1，设计 §4.3）", () => {
  const vm = resolve(
    '=== style-rule {#base match="table" component=data-table}\n===\n\n' +
    '=== style-rule {#kpis match="table.kpi" component=kpi-card}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(binding(vm, "#kpi").params.component, "kpi-card");
  assert.equal(binding(vm, "#plain").params.component, "data-table");
});

test("求解：条件集相同 + 同属性 = ambiguous-rule 错误（情况 2）", () => {
  const vm = resolve(
    '=== style-rule {#a match="table.kpi" component=x}\n===\n\n' +
    '=== style-rule {#b match="table.kpi" component=y}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["ambiguous-rule"]);
  assert.equal(vm.diagnostics[0].severity, "error");
  assert.match(vm.diagnostics[0].message, /#a/);
  assert.match(vm.diagnostics[0].message, /#b/);
});

test("求解：不可比 + 同属性 = ambiguous-rule 错误，并给出并集写法（情况 3）", () => {
  const vm = resolve(
    '=== style-rule {#a match="table.kpi" component=x}\n===\n\n' +
    '=== style-rule {#b match="table[sortable]" component=y}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["ambiguous-rule"]);
  assert.match(vm.diagnostics[0].message, /neither is more specific/);
});

test("求解：冲突对着语料判 —— 从不共现的规则不报错（设计 §4.3）", () => {
  const vm = resolve(
    '=== style-rule {#a match="table.kpi" component=x}\n===\n\n' +
    '=== style-rule {#b match="code[anchor]" component=y}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["unmatched-rule"]);
  assert.equal(vm.diagnostics[0].severity, "warning");
  assert.equal(vm.diagnostics[0].rule, "b");
});

test("求解：unknown-component 是 warning，惰性回退（设计 §7）", () => {
  const vm = resolveStyle(sheet('=== style-rule {#r match="table" component=nope}\n===\n'), [CORPUS], { components: ["data-table"] });
  assert.deepEqual(codes(vm.diagnostics), ["unknown-component"]);
  assert.equal(vm.diagnostics[0].severity, "warning");
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/style-check.test.mjs`
Expected: FAIL —— `resolveStyle is not a function`

- [ ] **Step 3: 写最小实现**

在 `style-resolve.ts` 顶部把 selector import 补全：

```ts
import { parseSelector, selectorDiag, candidates, matches, address, selectorConditions, moreSpecific, type Selector, type Candidate } from "./style-selector.js";
```

追加：

```ts
export interface Binding {
  /** 稳定地址：`#id`，或没有 id 时的文档序下标 */
  block: string;
  /** 命中它的规则 id，按样式表内的出现序 */
  rules: string[];
  /** 合并后的参数，含 component / capability / show / filter */
  params: Record<string, Value>;
}

export interface ViewModel {
  states: { id: string; kind: string; on: string; value?: string }[];
  screens: StyleScreen[];
  bindings: Binding[];
  diagnostics: StyleDiagnostic[];
}

export interface ResolveOptions {
  /** 宿主已注册的组件名；不给就不做 unknown-component 检查 */
  components?: string[];
  /** 宿主已注册的能力名；不给就不做 unknown-handler 检查 */
  capabilities?: string[];
}

/** 一条规则贡献的全部属性 —— 保留键与组件参数在这里合流。 */
function ruleProps(r: StyleRule): Record<string, Value> {
  const out: Record<string, Value> = { ...r.params };
  if (r.component !== undefined) out["component"] = r.component;
  if (r.capability !== undefined) out["capability"] = r.capability;
  if (r.show !== undefined) out["show"] = r.show;
  if (r.filter !== undefined) out["filter"] = r.filter;
  return out;
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
export function resolveStyle(sheet: Stylesheet, corpus: Document[], opts: ResolveOptions = {}): ViewModel {
  const diagnostics: StyleDiagnostic[] = [...sheet.diagnostics];
  const bindings: Binding[] = [];
  const used = new Set<string>();

  const all: Candidate[] = [];
  for (const doc of corpus) all.push(...candidates(doc));

  for (const c of all) {
    const hits: { rule: StyleRule; conds: Set<string> }[] = [];
    for (const rule of sheet.rules) {
      let best: Set<string> | null = null;
      for (const b of rule.branches) {
        if (!matches(b, c)) continue;
        const conds = selectorConditions(b);
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
        diagnostics.push(styleDiag(
          "ambiguous-rule",
          `\`#${prev.rule.id}\` and \`#${hit.rule.id}\` both set \`${k}\` on \`${address(c)}\` — ` +
          `neither is more specific; write a rule matching the union of both selectors`,
          hit.rule.id,
        ));
      }
    }
    bindings.push({ block: address(c), rules: hits.map((h) => h.rule.id), params });
  }

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
      if (rule.capability !== undefined && !known.has(rule.capability)) {
        diagnostics.push(styleDiag("unknown-handler", `capability \`${rule.capability}\` is not registered — renders inert`, rule.id));
      }
    }
  }

  return {
    states: sheet.states.map((s) => (s.value === undefined
      ? { id: s.id, kind: s.kind, on: s.on }
      : { id: s.id, kind: s.kind, on: s.on, value: s.value })),
    screens: sheet.screens,
    bindings,
    diagnostics,
  };
}
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/style-check.test.mjs`
Expected: PASS —— `12 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/style-resolve.ts geml-parser/test/style-check.test.mjs
git commit -m "feat(style): rule resolution — property-wise merge, superset arbitration, corpus-judged conflicts"
```

---

## Task 7: 状态图 —— 悬空引用、未命中产生者、未知列

**Files:**
- Modify: `geml-parser/src/style-resolve.ts`
- Modify: `geml-parser/test/style-check.test.mjs`

**背景：** `unknown-value-source` 能真查，是因为 §6 的表带 schema。模型里表在
`block.table` 上（类型 `TableModel`，`columns` 是 `string[]`）。
表若没有解析出来（`block.table` 为 `undefined`），跳过该检查而不是报错 ——
一个 `src=` 外部数据的表在解析期没有行，那不是样式表的毛病。

- [ ] **Step 1: 写下失败的测试**

```js
test("状态：规则引用未声明的 $foo 是错误（设计 §7）", () => {
  const vm = resolve('=== style-rule {#r match="table" component=x show="$nope"}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "unknown-state"), true);
  assert.equal(vm.diagnostics.find((d) => d.code === "unknown-state").severity, "error");
});

test("状态：screen 的槽位也能引用状态，且同样被检查（设计 §5.5）", () => {
  const ok = resolve(
    '=== style-state {#sel type=block-ref match="table" on=select value-from=a}\n===\n\n' +
    '=== style-screen {#s slots="table, $sel"}\n===\n'
  );
  assert.equal(ok.diagnostics.some((d) => d.code === "unknown-state"), false);
  const bad = resolve('=== style-screen {#s slots="table, $ghost"}\n===\n');
  assert.equal(bad.diagnostics.some((d) => d.code === "unknown-state"), true);
});

test("状态：from= 选不中任何块是 warning（设计 §7）", () => {
  const vm = resolve('=== style-state {#sel type=block-ref match="code[anchor]" on=select value-from=id}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "unmatched-producer"), true);
  assert.equal(vm.diagnostics.find((d) => d.code === "unmatched-producer").severity, "warning");
});

test("状态：value= 不在目标表 schema 里是错误 —— 表有 schema，能真查（设计 §7）", () => {
  const vm = resolve('=== style-state {#sel type=scalar match="table#kpi" on=select value-from=nosuch}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "unknown-value-source"), true);
  const ok = resolve('=== style-state {#sel type=scalar match="table#kpi" on=select value-from=a}\n===\n');
  assert.equal(ok.diagnostics.some((d) => d.code === "unknown-value-source"), false);
});

test("状态：多产生者是允许的 —— 时序赋值不是静态冲突（设计 §5.2）", () => {
  const vm = resolve('=== style-state {#sel type=block-ref match="table.kpi, table#plain" on=select value-from=a}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "ambiguous-rule"), false);
  assert.equal(vm.diagnostics.some((d) => d.code === "unmatched-producer"), false);
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/style-check.test.mjs`
Expected: FAIL —— `unknown-state` 未被报出

- [ ] **Step 3: 写最小实现**

在 `resolveStyle` 里 `return` 之前插入：

```ts
  // ---- 状态图（设计 §5）。构造上无环：interaction → state → view，
  // 状态永不读状态，所以这里没有、也不需要环检测。
  const declared = new Set(sheet.states.map((s) => s.id));

  const refs = (v: Value | undefined): string[] => {
    if (typeof v !== "string") return [];
    return [...v.matchAll(/\$([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  };
  const checkRefs = (v: Value | undefined, where: string): void => {
    for (const name of refs(v)) {
      if (!declared.has(name)) {
        diagnostics.push(styleDiag("unknown-state", `\`$${name}\` is not declared by any \`style-state\` block`, where));
      }
    }
  };
  for (const rule of sheet.rules) {
    for (const v of Object.values(ruleProps(rule))) checkRefs(v, rule.id);
  }
  for (const scr of sheet.screens) {
    for (const slot of scr.slots) checkRefs(slot, scr.id);
  }

  for (const st of sheet.states) {
    const producers = all.filter((c) => st.from.some((b) => matches(b, c)));
    if (producers.length === 0) {
      diagnostics.push(styleDiag("unmatched-producer", `state \`#${st.id}\`: \`from=\` matched no block in the corpus`, st.id));
      continue;
    }
    if (st.value === undefined) continue;
    for (const p of producers) {
      const table = p.block.table;
      if (p.block.type !== "table" || table === undefined) continue;
      const cols = table.columns;
      if (!cols.includes(st.value)) {
        diagnostics.push(styleDiag(
          "unknown-value-source",
          `state \`#${st.id}\`: \`value=${st.value}\` is not a column of \`${address(p)}\` (has: ${cols.join(", ")})`,
          st.id,
        ));
      }
    }
  }
```

**已核实的模型形状：** `TableModel.columns` 是 `string[]`（列名本身），不是对象数组 ——
`parse("=== table {#t format=csv}\na,b\n1,2\n===")` 产出
`{ header: true, columns: ["a","b"], align: [], rows: [...] }`。
所以上面写的是 `table.columns`，不要写成 `.map(c => c.name)`。

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/style-check.test.mjs`
Expected: PASS —— `17 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/style-resolve.ts geml-parser/test/style-check.test.mjs
git commit -m "feat(style): the state graph — dangling refs, unmatched producers, unknown columns

No cycle detector: the pipeline is interaction -> state -> view and state
never reads state, so there is no graph to cycle."
```

---

## Task 8: CLI —— `geml style check`

**Files:**
- Modify: `geml-parser/src/cli.ts`
- Modify: `geml-parser/test/style-check.test.mjs`

- [ ] **Step 1: 写下失败的测试**

在 `style-check.test.mjs` 的 import 区补：

```js
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "geml-style-"));
const p = (n) => join(dir, n);
const w = (n, s) => { writeFileSync(p(n), s); return p(n); };
const cli = (...args) => {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
};
```

插入测试：

```js
test("CLI：干净的样式表 exit 0", () => {
  w("c.geml", '=== meta\ntitle = "c"\n===\n\n=== table {#kpi .kpi format=csv}\na,b\n1,2\n===\n');
  w("s.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-rule {#r match="table.kpi" component=kpi-card}\n===\n');
  const r = cli("style", "check", p("s.geml"), p("c.geml"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /0 error/);
});

test("CLI：ambiguous-rule 让构建失败（exit 1）", () => {
  w("bad.geml",
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#a match="table.kpi" component=x}\n===\n\n' +
    '=== style-rule {#b match="table[sortable]" component=y}\n===\n');
  w("c2.geml", '=== meta\ntitle = "c"\n===\n\n=== table {#kpi .kpi format=csv sortable}\na,b\n1,2\n===\n');
  const r = cli("style", "check", p("bad.geml"), p("c2.geml"));
  assert.equal(r.code, 1);
  assert.match(r.err + r.out, /ambiguous-rule/);
});

test("CLI：--json 吐出视图模型 —— 本 profile 的一致性面（设计 §8）", () => {
  const r = cli("style", "check", p("s.geml"), p("c.geml"), "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.bindings.map((b) => b.block), ["#kpi"]);
  assert.equal(vm.bindings[0].params.component, "kpi-card");
  assert.deepEqual(vm.diagnostics, []);
});

test("CLI：warning 不影响 exit code", () => {
  w("warn.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-rule {#r match="code[anchor]" component=x}\n===\n');
  const r = cli("style", "check", p("warn.geml"), p("c.geml"));
  assert.equal(r.code, 0);
  assert.match(r.out, /unmatched-rule/);
});

test("CLI：没给语料是用法错误（exit 2）", () => {
  const r = cli("style", "check", p("s.geml"));
  assert.equal(r.code, 2);
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/style-check.test.mjs`
Expected: FAIL —— `unknown command 'style'`

- [ ] **Step 3: 写最小实现**

在 `cli.ts` 里 `runMcp` 函数定义之前加入：

```ts
// geml style check <stylesheet.geml> <corpus…> [--json]
//
// 样式表对着语料求解（设计 §4.3：冲突对着语料判，不静态判）。
// 退出码沿用 check 的约定：error → 1，warning → 0，用法错误 → 2。
function runStyle(args: string[]): void {
  const sub = args[0];
  if (sub !== "check") fail(`unknown style subcommand '${sub ?? ""}'. Run 'geml style check <stylesheet.geml> <corpus…>'.`, 2);
  const files = args.slice(1).filter((a) => !a.startsWith("--"));
  const sheetPath = files[0];
  const corpusPaths = files.slice(1);
  if (sheetPath === undefined) fail("geml style check needs a stylesheet", 2);
  if (corpusPaths.length === 0) fail("geml style check needs at least one content document to resolve against", 2);

  const sheetDoc = parse(readFileSync(sheetPath, "utf8"));
  const sheet = loadStylesheet(sheetDoc);
  const corpus = corpusPaths.map((f) => parse(readFileSync(f, "utf8")));
  const vm = resolveStyle(sheet, corpus);

  if (jsonMode) {
    console.log(JSON.stringify(vm, null, 2));
  } else {
    for (const d of vm.diagnostics) {
      const where = d.rule === undefined ? "" : ` (#${d.rule})`;
      const line = `${d.severity}: ${d.code}: ${d.message}${where}`;
      if (d.severity === "error") console.error(line); else console.log(line);
    }
    const errs = vm.diagnostics.filter((d) => d.severity === "error").length;
    const warns = vm.diagnostics.length - errs;
    console.log(`${errs} error(s), ${warns} warning(s)`);
  }
  process.exit(vm.diagnostics.some((d) => d.severity === "error") ? 1 : 0);
}
```

在 `cli.ts` 的 import 区补：

```ts
import { loadStylesheet, resolveStyle } from "./style-resolve.js";
```

在动词分发里，`} else if (cmd === "codemap") {` **之前**插入：

```ts
  } else if (cmd === "style") {
    runStyle(argv.slice(1));
```

在 `USAGE` 常量里，`geml check` 那一行之后补：

```
  geml style check <stylesheet.geml> <corpus…> [--json]   resolve a geml-style sheet against content
                                             (--json prints the view model: bindings, states, screens)
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/style-check.test.mjs`
Expected: PASS —— `22 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/cli.ts geml-parser/test/style-check.test.mjs
git commit -m "feat(style): geml style check — resolve a stylesheet against a corpus"
```

---

## Task 9: 接入 suite 与覆盖率闸门

**Files:**
- Modify: `geml-parser/test/all.mjs`

- [ ] **Step 1: 注册两个 suite**

在 `test/all.mjs` 的 `suites` 数组末尾（右方括号之前）加入：

```js
  // geml-style profile（计划 A）：选择器引擎与样式表求解。
  // 两个 suite 分开，因为它们测的层不同 —— 一个是纯函数，一个是端到端 CLI。
  "style-selector", "style-check",
```

- [ ] **Step 2: 跑全量 suite**

Run: `cd geml-parser && npm run build && node test/all.mjs`
Expected: 全绿；输出末尾没有 failure 列表。**一次跑完就从这一次取输出和退出码**，不要重跑。

- [ ] **Step 3: 跑覆盖率闸门**

Run: `cd geml-parser && npm run coverage:check`
Expected: PASS，四项都 ≥ 95%。

若 `style-*.js` 的分支覆盖不足，补测**拒绝路径**而不是删代码：
未闭合的 `[`、两个 `#id`、空 class、`style-screen` 上的未知键、
`kind` 缺省走 `block-ref`、`table` 没有 `table` 模型时跳过 `unknown-value-source`。

- [ ] **Step 4: 提交**

```bash
git add geml-parser/test/all.mjs
git commit -m "test(style): register the geml-style suites in the single runner"
```

---

## Task 10: 端到端验收 —— 设计文档 §2 的 codemap 例子

**Files:**
- Create: `geml-parser/test/fixtures/style/codemap.style.geml`
- Create: `geml-parser/test/fixtures/style/codemap-content.geml`
- Modify: `geml-parser/test/style-check.test.mjs`

**为什么单独一个任务：** 设计文档 §2 是这套东西的验收标准。前九个任务测的是零件，
这个任务测的是**文档里承诺的那个例子真的能跑**。

- [ ] **Step 1: 写下两个 fixture**

`geml-parser/test/fixtures/style/codemap-content.geml`：

```
=== meta
module = "geml-parser/core"
resolution-default = "cpg"
===

# geml-parser/core

=== code {#renderHtml anchor="ts:render-html.ts#renderHtml(Document,RenderOptions)"}
===

=== code {#esc .leaf anchor="ts:render.ts#esc(string)"}
===

=== table {#calls format=csv}
from,to,kind,confidence
renderHtml,esc,call,high
===
```

`geml-parser/test/fixtures/style/codemap.style.geml`：

```
=== meta
profile = "geml-style/v1"
===

=== style-state {#sel type=block-ref match="table#calls" on=select value-from=to}
===

=== style-rule {#edges match="table#calls" component=edge-list selectable}
===

=== style-rule {#methods match="code[anchor]" component=method-card}
===

=== style-rule {#leaves match="code.leaf[anchor]" collapsed badge="leaf"}
===

=== style-screen {#overview layout=split slots="table#calls, $sel"}
===
```

- [ ] **Step 2: 写下失败的测试**

```js
test("验收：设计文档 §2 的 codemap 例子，零诊断", () => {
  const r = cli("style", "check", "test/fixtures/style/codemap.style.geml", "test/fixtures/style/codemap-content.geml", "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, []);

  // 叶子方法继承 #methods 的 component，并叠加 #leaves 的修饰（设计 §2.4）
  const leaf = vm.bindings.find((b) => b.block === "#esc");
  assert.equal(leaf.params.component, "method-card");
  assert.equal(leaf.params.collapsed, true);
  assert.equal(leaf.params.badge, "leaf");

  // 非叶子只拿到基础规则
  const nonLeaf = vm.bindings.find((b) => b.block === "#renderHtml");
  assert.equal(nonLeaf.params.component, "method-card");
  assert.equal(nonLeaf.params.collapsed, undefined);

  // 状态与屏幕都在视图模型里
  assert.deepEqual(vm.states.map((s) => s.id), ["sel"]);
  assert.equal(vm.screens[0].slots.includes("$sel"), true);
});

test("验收：内容文档一个字节都没为样式而改", () => {
  const before = readFileSync("test/fixtures/style/codemap-content.geml", "utf8");
  cli("style", "check", "test/fixtures/style/codemap.style.geml", "test/fixtures/style/codemap-content.geml");
  assert.equal(readFileSync("test/fixtures/style/codemap-content.geml", "utf8"), before);
});
```

在 import 区把 `readFileSync` 补进 `node:fs` 的解构。

- [ ] **Step 3: 跑它**

Run: `cd geml-parser && npx tsc && node test/style-check.test.mjs`
Expected: PASS —— `24 passed`

- [ ] **Step 4: 跑全量与覆盖率，取同一次运行的输出与退出码**

Run: `cd geml-parser && npm run coverage:check`
Expected: 全绿，四项 ≥ 95%。

- [ ] **Step 5: 提交**

```bash
git add geml-parser/test/fixtures/style geml-parser/test/style-check.test.mjs
git commit -m "test(style): acceptance — the codemap example from the design doc resolves clean"
```

---

## 完成的定义

- [ ] `geml style check <sheet> <corpus…>` 可用，`--json` 输出视图模型
- [ ] 设计文档 §4.3 的三种冲突情况各有测试，且都产出 `ambiguous-rule`
- [ ] 设计文档 §7 的八个诊断码全部有测试覆盖
- [ ] 设计文档 §2 的 codemap 例子零诊断通过
- [ ] `node test/all.mjs` 全绿；`npm run coverage:check` 四项 ≥ 95%
- [ ] `geml-parser/src/geml.ts` 的顶层导入/再导出**未被改动**（因此不需要动 viewer 的 esbuild stub）
- [ ] 全部提交在 `feat/geml-style` 分支上；`main` 不受影响

## 不在本计划内

- **计划 B**：`@geml/style-react` 运行时（设计 §6）。它消费本计划产出的视图模型。
- **计划 C**：`profile` 词汇表机制（设计 §3.3），顺带修 `geml.ts:672` 的 codemap 词汇泄漏。
- `geml style eject`（设计 §6.1 的逃生口）——属于计划 B。
- `=== form` 提升进核心规范（设计 §10 的开放问题 3）。
