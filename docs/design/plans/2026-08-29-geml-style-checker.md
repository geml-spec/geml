# geml-style 检查器（计划 A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `geml style check` —— 解析 geml-style 样式表、对着内容语料求解，产出可诊断、可对拍的**视图模型**，全程不碰 React。

**Architecture:** 三个新的扁平 TS 模块（`style-diagnostics` / `style-selector` / `style-resolve`）加一个 CLI 动词。选择器把样式表里的规则映射到内容文档的 block 上，按属性合并，按条件集的真超集偏序裁决冲突；状态图是 `interaction → state → view` 的单向管道，构造上无环。输出的视图模型是本 profile 的**一致性面**——第二实现不必附带 React 即可对拍。

**Tech Stack:** TypeScript（`tsc` → `dist/`）、node 内建 test 风格（`.test.mjs` + `node:assert`）、`c8` 覆盖率闸门。

**分支：** `feat/geml-style`（已存在，持有设计文档 `b88f0b3` + `33f9bff`）。

**依据：** `docs/design/specs/2026-08-29-geml-style-design.md`。本计划只实现该设计的 §4（选择器）、§5（绑定）、§7（诊断）、§8（测试）。§6 的 React 运行时是**计划 B**，§3.3 的 profile 词汇表机制是**计划 C**，都不在本计划内。

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


---

## 第二部分：页面布局词汇（计划 E，2026-09-09）


**Goal:** 让一份 geml-style 样式表能描述一整页的布局 —— 嵌套区域、盒子与文字属性、按状态变化的外观 —— 并从 `geml style check --json` 交出宿主可直接渲染的视图模型。

**Architecture:** 全部改动落在既有的三个扁平模块里（`style-diagnostics` / `style-resolve`，`style-selector` 不动）加 `profiles.ts` 一行。新增 `style-frame` 块类型承载页内区域，槽位里裸 `#id` 引用它；一组**内含词**（`width` `sticky` `axis` …）由 profile 消费、落进视图模型的 `box`，不再透传给组件；`when=` 作为普通条件进入 §4.3 的条件集，求解时把有条件的规则分流成 `variants`。§4 的仲裁逻辑一字不改，只是条件集多了两类成员。

**Tech Stack:** TypeScript（`tsc` → `dist/`）、`.test.mjs` + `node:assert`、`c8` 覆盖率闸门（95%）。

**依据：** `docs/design/specs/2026-08-29-geml-style-design.md` **§12**（2026-09-09 增补）。本计划只做解析器与 profile 文档两半；viewer 那三件（§12.7）是**计划 F**，要等本计划的视图模型定型后才有东西可消费。

## Global Constraints

- `geml-parser` 零运行时依赖（`dependencies: {}`）—— 不引任何包。
- **不改 `geml-parser/src/geml.ts` 的顶层导入/再导出**：那会要求同步 viewer 的 esbuild stub。本计划三个模块都不从 `geml.ts` 再导出，测试直接 `import … from "../dist/style-resolve.js"`。
- 跨平台：代码与测试必须在 Windows（开发）和 Linux/macOS（CI）都过。fixture 文件用 `\n` 写入（`writeFileSync` 的字符串里写 `\n`，不要从磁盘拷带 CRLF 的文件）；断言不依赖行尾。
- 贵命令**跑一次**，从同一次结果里取输出与退出码：`node test/all.mjs`、`npm run coverage:check`。**绝不** npm 套 npm（Windows PATH 溢出）。
- 提交用用户自己的 git 身份，**不加任何 AI 署名**（无 Co-Authored-By、无 Generated-with）。
- 不 bump 版本、不写 CHANGELOG —— 发版由用户决定。
- 所有诊断消息**英文**（与既有目录一致），源码注释中文（与既有模块一致）。

---

## 文件结构

| 文件 | 职责 | 本计划的改动 |
|---|---|---|
| `geml-parser/src/style-diagnostics.ts` | 诊断码目录与严重性 | +5 个码 |
| `geml-parser/src/profiles.ts` | profile 词汇注册表 | `geml-style/v1` 的 types 加 `style-frame` |
| `geml-parser/src/style-resolve.ts` | 装载、校验、求解、视图模型 | `style-frame`；`axis`/`component`；内含词 → `box`；`when=`/`toggle`；frame 引用与环；`variants` |
| `geml-parser/test/style-check.test.mjs` | 端到端测试 | 追加用例 |
| `geml-parser/test/fixtures/style-page/page.geml`（新建） | 验收语料：GitHub blob 页的内容块 | |
| `geml-parser/test/fixtures/style-page/github.style.geml`（新建） | 验收样式表：§12.4 + §12.5 的那份 | |
| `spec/profiles/geml-style/geml-style-profile.md` | profile 词汇表（EN） | §0.1 §2 §2.1 §2.2 §2.3 §2.4(新) §4 §5 §8 §10 |
| `spec/profiles/geml-style/geml-style-profile_CN.md` | 同上（CN，手维护，不是投影） | 同上 |
| `docs/design/specs/2026-08-29-geml-style-design.md` | 设计文档 | §12 三处补记（Task 0） |

**刻意的决定 —— 控制键留在 `params` 里。** 设计 §12.6 把 `component?` 画在 binding 顶层，但既有视图模型（和 58 条测试、`graph-style.ts`）都在 `params.component` 上；本计划**不搬**它，Task 0 把 §12.6 改成与实现一致。`box` 是新增字段，只装内含词。

**刻意的决定 —— 环检测是独立一趟。** frame 平铺存放、各自解析槽位，环不能在解析单个 frame 时发现；Task 6 用一趟带路径栈的 DFS 专门找环，消息带整条链。

---

## Task 0: 设计文档补记三处

实现中确定下来、§12 没写到的三条。先改文档再写代码，spec 始终是真相。

**Files:**
- Modify: `docs/design/specs/2026-08-29-geml-style-design.md`（§12.5 末尾、§12.6、§12.4 诊断行）

- [ ] **Step 1: §12.5 末尾追加两条规则**

在 §12.5 最后一个列表项（"视图模型里 binding 因此多一层 `variants`…"）之后追加：

```markdown
- **互斥的 `when` 集合不算冲突。** 两条都带 `when=` 的规则若对**同一个状态**给了**不同的值**
  （`$tab=Preview` 与 `$tab=Code`），它们不可能同时生效，争同一属性也不是 `ambiguous-rule`
  —— tab 条的每个 tab 一条规则正是这种写法。只有**可以同时成立**的两个 `when` 集合
  （`$tree=closed` 与 `$tab=Code`）、条件集又互不包含、又争同一属性，才报错。
- **variants 的叠加顺序**：按 `when` 条件数升序，同数按样式表内出现序。运行时按此序把
  条件全部满足的 variant 依次叠在基础参数上；真超集的一定排在后面，所以"更具体的赢"
  不需要运行时再比较。
- **跨层**：基础参数与 variant 若来自不同层，层号高的保留、低的那个属性直接丢弃 ——
  §4.1 的"上层整体压过下层"对有条件的规则同样成立。
```

- [ ] **Step 2: §12.6 把 `component?` 收回 `params`**

把 §12.6 代码块里这一行：

```
bindings  [{ doc, block, component?, box, params, variants: [{ when, box, params }] }]
```

改成：

```
bindings  [{ doc, block, rules, box, params, variants: [{ when, box, params }] }]
```

并在代码块下那句 "`box` 装内含词，`params` 装组件词，二者结构上分开（§12.3）。" 之后追加：

```markdown
`component` / `handler` / `show` / `filter` 留在 `params` 里，与 v1 落地时的视图模型一致 ——
既有消费者（`graph-style.ts`）和测试都在那里读它，搬动没有收益。`when` 是
`{ state: value }` 的映射。
```

- [ ] **Step 3: §12.4 诊断列表加一个码**

§12.4 最后一个列表项 "**诊断**（已并入 §7）：…" 里，在 `unused-frame` 之后追加：

```markdown
；`style-invalid-value`（error）—— 内含词里值域封闭的几个（`axis=row|column`、
  `scroll=own|page`、`sticky` 与 `hide-below` 须为数字）取了域外值，以及 `when=` 不符合
  `$state=value` 形式。开放值域的（`width=321px`、`color=#1f2328`）不校验，原样交给宿主
```

同时 §7 的诊断表里，在 `unused-frame` 那一行之后加一行：

```markdown
| `style-invalid-value` | error | 内含词的封闭值域被违反（`axis` / `scroll` / `sticky` / `hide-below`），或 `when=` 形式不对（§12.4） |
```

- [ ] **Step 4: Commit**

```bash
git add docs/design/specs/2026-08-29-geml-style-design.md
git commit -m "docs(style): §12 — exclusive when-sets, variant order, style-invalid-value"
```

---

## Task 1: 诊断目录 +5

**Files:**
- Modify: `geml-parser/src/style-diagnostics.ts`
- Test: `geml-parser/test/style-check.test.mjs`

**Interfaces:**
- Produces: `StyleDiagnosticCode` 新成员 `"unknown-frame" | "screen-nested" | "frame-cycle" | "unused-frame" | "style-invalid-value"`；`STYLE_SEVERITY` 相应条目。后续 Task 直接 `styleDiag("unknown-frame", …)`。

- [ ] **Step 1: 写失败的测试**

在 `test/style-check.test.mjs` 顶部的 import 里加一行：

```js
import { STYLE_SEVERITY } from "../dist/style-diagnostics.js";
```

文件末尾（`console.log(\`${passed} style tests passed.\`)` 之前 —— 若结尾行不是这个形状，放在最后一个 `test(` 之后）追加：

```js
test("诊断目录：frame 相关的四个码与 style-invalid-value（设计 §12.4 / §7）", () => {
  assert.equal(STYLE_SEVERITY["unknown-frame"], "error");
  assert.equal(STYLE_SEVERITY["screen-nested"], "error");
  assert.equal(STYLE_SEVERITY["frame-cycle"], "error");
  assert.equal(STYLE_SEVERITY["unused-frame"], "warning");
  assert.equal(STYLE_SEVERITY["style-invalid-value"], "error");
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
cd geml-parser && npm run build && node test/style-check.test.mjs
```

预期：最后一条用例抛 `AssertionError`（`undefined !== 'error'`）。

- [ ] **Step 3: 实现**

`src/style-diagnostics.ts`：

头部注释第 7–8 行改为：

```ts
// 目录里没有 `binding-cycle`：数据流被限死成 interaction → state → view，
// 状态永不读状态，因此没有图，也就没有环可成（设计 §5.1）。
// `frame-cycle` 抓的是另一张图 —— style-frame 的包含关系（设计 §12.4）——
// 区域装区域可以成环，那张图有环检测；状态管道这一条依然成立。
```

`StyleDiagnosticCode` 联合类型末尾追加：

```ts
  | "style-embed-not-expanded"
  | "unknown-frame"
  | "screen-nested"
  | "frame-cycle"
  | "unused-frame"
  | "style-invalid-value";
```

`STYLE_SEVERITY` 追加：

```ts
  "style-embed-not-expanded": "warning",
  // 槽位里裸 `#x` 是本样式表的 frame 引用（设计 §12.4）。悬空、指到页、成环都是
  // 结构性错误，和 unknown-screen / unknown-state 同级。
  "unknown-frame": "error",
  "screen-nested": "error",
  "frame-cycle": "error",
  // 声明了没人引用：我们忽略了作者写下的东西，该说出来 —— 和 unmatched-rule 同性质。
  "unused-frame": "warning",
  // 内含词里值域封闭的几个取了域外值，与 unknown-interaction 同一哲学：封闭词汇的
  // 非法成员是错误，不是"未知名字降级"。
  "style-invalid-value": "error",
};
```

- [ ] **Step 4: 跑，确认通过**

```bash
npm run build && node test/style-check.test.mjs
```

预期：全部 `ok`，末尾计数比之前多 1。

- [ ] **Step 5: Commit**

```bash
git add src/style-diagnostics.ts test/style-check.test.mjs
git commit -m "feat(style): five diagnostic codes for frames and closed-domain built-in values"
```

---

## Task 2: `style-frame` 进 profile 词汇注册表

**Files:**
- Modify: `geml-parser/src/profiles.ts:76`
- Test: `geml-parser/test/style-check.test.mjs`

- [ ] **Step 1: 写失败的测试**

```js
test("profile：style-frame 是本 profile 的类型，geml check 不再报 unknown-block-type", () => {
  const f = w("frame-known.geml",
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-frame {#body slots="table"}\n===\n');
  const r = cli("check", f);
  assert.equal(r.out.includes("unknown-block-type"), false, r.out + r.err);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
npm run build && node test/style-check.test.mjs
```

预期：断言失败，输出里含 `unknown-block-type`。

- [ ] **Step 3: 实现**

`src/profiles.ts` 第 76 行：

```ts
    types: ["style-rule", "style-state", "style-screen", "style-frame"],
```

- [ ] **Step 4: 跑，确认通过**

```bash
npm run build && node test/style-check.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/profiles.ts test/style-check.test.mjs
git commit -m "feat(style): style-frame is a geml-style/v1 type"
```

---

## Task 3: 装载 `style-frame`；screen/frame 的 `axis=` 与 `component=`

`layout=` 改名 `component=`；`axis` 是封闭值域的内含词，默认 `column`。

**Files:**
- Modify: `geml-parser/src/style-resolve.ts`（第 18 行常量；第 70–81 行接口；`collect()` 第 283–298 行）
- Test: `geml-parser/test/style-check.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface StyleContainer { id: string; slots: string[]; axis: "row" | "column"; component?: string; }
  export type StyleScreen = StyleContainer;
  export type StyleFrame = StyleContainer;
  export interface Stylesheet { rules; states; screens: StyleScreen[]; frames: StyleFrame[]; diagnostics }
  ```
  Task 6 按 `sheet.frames` 解析引用。

- [ ] **Step 1: 写失败的测试**

```js
test("装载：style-frame 被读成容器，与 style-screen 同形（设计 §12.4）", () => {
  const s = sheet(
    '=== style-screen {#page axis=column slots="text#hdr, #body"}\n===\n\n' +
    '=== style-frame  {#body axis=row slots="table#tree, text#main"}\n===\n'
  );
  assert.deepEqual(s.screens.map((x) => [x.id, x.axis]), [["page", "column"]]);
  assert.deepEqual(s.frames.map((x) => [x.id, x.axis, x.slots]), [["body", "row", ["table#tree", "text#main"]]]);
  assert.deepEqual(codes(s.diagnostics), []);
});

test("装载：axis 默认 column；域外值是 style-invalid-value 错误", () => {
  const ok = sheet('=== style-frame {#f slots="table"}\n===\n');
  assert.equal(ok.frames[0].axis, "column");
  const bad = sheet('=== style-frame {#f axis=diagonal slots="table"}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["style-invalid-value"]);
  assert.equal(bad.diagnostics[0].rule, "f");
  assert.equal(bad.frames[0].axis, "column");
});

test("装载：screen/frame 上的 component= 是宿主命名的排布；layout= 已改名，报 warning 并指路", () => {
  const s = sheet(
    '=== style-screen {#a component=grid slots="table"}\n===\n\n' +
    '=== style-screen {#b layout=split slots="table"}\n===\n'
  );
  assert.equal(s.screens[0].component, "grid");
  assert.deepEqual(codes(s.diagnostics), ["style-unknown-attribute"]);
  assert.match(s.diagnostics[0].message, /layout=.*component=/);
  assert.equal(s.screens[1].component, undefined);
});

test("装载：style-frame 缺 slots= 是错误，消息点名 style-frame", () => {
  const s = sheet("=== style-frame {#f}\n===\n");
  assert.deepEqual(codes(s.diagnostics), ["style-missing-attribute"]);
  assert.match(s.diagnostics[0].message, /style-frame/);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
npm run build && node test/style-check.test.mjs
```

预期：`s.frames` 为 `undefined` → TypeError；或 `axis` 断言失败。

- [ ] **Step 3: 实现**

`src/style-resolve.ts`：

第 18 行替换：

```ts
/** style-screen / style-frame 上的保留键。`layout` 已改名 `component`（设计 §12.4）。 */
const CONTAINER_RESERVED = new Set(["slots", "axis", "component"]);
/** `axis=` 的封闭值域：槽位横排还是竖排。默认 column。 */
const AXES = new Set(["row", "column"]);
```

第 70–74 行 `StyleScreen` 接口替换为：

```ts
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
}
export type StyleScreen = StyleContainer;
export type StyleFrame = StyleContainer;
```

`Stylesheet` 接口加一行：

```ts
  screens: StyleScreen[];
  frames: StyleFrame[];
```

`loadStylesheet` 第 223 行初始化加 `frames: []`：

```ts
  const sheet: Stylesheet = { rules: [], states: [], screens: [], frames: [], diagnostics: [] };
```

`collect()` 里第 283–298 行的 `else if (b.type === "style-screen") {…}` 整段替换为：

```ts
    } else if (b.type === "style-screen" || b.type === "style-frame") {
      const c = readContainer(b, id, b.type, sheet);
      if (c === null) continue;
      if (b.type === "style-screen") sheet.screens.push(c); else sheet.frames.push(c);
    }
```

并在 `collect()` 之后新增函数：

```ts
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
  for (const k of Object.keys(b.attrs)) {
    if (CONTAINER_RESERVED.has(k)) continue;
    // `layout=` 是 v1 落地时的名字，0 个消费者时改成了和块上同一个词。指路，不静默。
    const msg = k === "layout"
      ? `\`layout=\` is now \`component=\` (a host-named arrangement); \`split\` is \`axis=row\``
      : `unknown attribute \`${k}\` for \`${kind}\``;
    sheet.diagnostics.push(styleDiag("style-unknown-attribute", msg, id));
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
  const out: StyleContainer = { id, slots: slots.split(",").map((x) => x.trim()).filter((x) => x.length > 0), axis };
  const component = str(b.attrs["component"]); if (component !== undefined) out.component = component;
  return out;
}
```

`ResolvedScreen`（第 334–343 行）的 `layout?: string` 改为：

```ts
  axis: "row" | "column";
  component?: string;
```

`resolveStyle` 末尾组装 screens 处（第 559–561 行）：

```ts
    const out: ResolvedScreen = { id: scr.id, axis: scr.axis, slots, bindings: perScreen.get(scr.id) ?? [] };
    if (scr.component !== undefined) out.component = scr.component;
    return out;
```

- [ ] **Step 4: 检查既有测试里有没有用 `layout=`**

```bash
grep -n "layout=" test/style-check.test.mjs test/graph-style.test.mjs
```

有命中的，把 `layout=split` 改成 `axis=row`（或删掉，若断言不依赖它）。

- [ ] **Step 5: 跑，确认通过**

```bash
npm run build && node test/style-check.test.mjs && node test/graph-style.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/style-resolve.ts test/style-check.test.mjs test/graph-style.test.mjs
git commit -m "feat(style): style-frame containers; axis= and component= on screens and frames"
```

---

## Task 4: 内含词分流到 `box`

**Files:**
- Modify: `geml-parser/src/style-resolve.ts`（`StyleRule`、`collect()` 的 rule 分支、`Binding`、`ruleProps`、`resolveBindings` 组装处）
- Test: `geml-parser/test/style-check.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export const BOX_WORDS: ReadonlySet<string>;          // 11 个内含词
  StyleRule.box: Record<string, Value>;                 // 与 params 并列
  Binding.box: Record<string, Value>;                   // 求解后
  ```
  Task 7 的 variant 也各带一份 `box`。

- [ ] **Step 1: 写失败的测试**

```js
test("装载：内含词落 box，组件词落 params，二者结构上分开（设计 §12.3）", () => {
  const s = sheet('=== style-rule {#r match="table" component=tree width=321px sticky=0 scroll=own hide-below=1012 collapsible indent=2}\n===\n');
  assert.deepEqual(s.rules[0].box, { width: "321px", sticky: 0, scroll: "own", "hide-below": 1012 });
  assert.deepEqual(s.rules[0].params, { collapsible: true, indent: 2 });
  assert.deepEqual(codes(s.diagnostics), []);
});

test("装载：封闭值域的内含词取了域外值是 style-invalid-value；开放值域的不校验", () => {
  const bad = sheet('=== style-rule {#r match="table" scroll=sideways sticky=top hide-below=wide}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["style-invalid-value", "style-invalid-value", "style-invalid-value"]);
  const ok = sheet('=== style-rule {#r match="table" width=anything color="not a colour" border="3 dashed"}\n===\n');
  assert.deepEqual(codes(ok.diagnostics), []);
  assert.deepEqual(ok.rules[0].box, { width: "anything", color: "not a colour", border: "3 dashed" });
});

test("求解：binding 上 box 与 params 并列，仲裁对两者一视同仁（设计 §12.3）", () => {
  const vm = resolve(
    '=== style-rule {#base match="table" width=100px component=data-table}\n===\n\n' +
    '=== style-rule {#kpis match="table.kpi" width=200px}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(binding(vm, "#kpi").box.width, "200px");
  assert.equal(binding(vm, "#plain").box.width, "100px");
  assert.equal(binding(vm, "#kpi").params.component, "data-table");
  assert.equal(binding(vm, "#kpi").box.component, undefined);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
npm run build && node test/style-check.test.mjs
```

预期：`s.rules[0].box` 为 `undefined`。

- [ ] **Step 3: 实现**

`src/style-resolve.ts`，紧接 `CONTAINER_RESERVED` 之后：

```ts
/**
 * 内含词（设计 §12.3）：放在段落、表格、图上意思都一样的属性。由 profile 消费、
 * 落进视图模型的 `box`，**不透传**给组件 —— 所以组件不可能把 `width` 另解释成缩进。
 * 判据是"换个块还是不是这个意思"；只对某种控件才说得通的（`fold`、`collapsible`）
 * 仍是组件词，走 `params`。清单按第一个真实用例圈死，多一个不加。
 * `axis` 不在这里：它挂在 screen/frame 上，不挂在块上。
 */
export const BOX_WORDS: ReadonlySet<string> = new Set([
  "width", "max-width", "padding", "sticky", "scroll", "hide-below",
  "font-size", "line-height", "color", "background", "border",
]);
/** 封闭值域的内含词。其余（`width=321px`、`color=#1f2328`）不校验，原样交给宿主。 */
const SCROLLS = new Set(["own", "page"]);
const NUMERIC_BOX = new Set(["sticky", "hide-below"]);

/** 校验一个内含词的值；域外值报 style-invalid-value，并告诉调用方别收它。 */
function boxValueOk(k: string, v: Value, id: string, sheet: Stylesheet): boolean {
  if (k === "scroll" && !(typeof v === "string" && SCROLLS.has(v))) {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`scroll=${String(v)}\` is not \`own\` or \`page\``, id));
    return false;
  }
  if (NUMERIC_BOX.has(k) && typeof v !== "number") {
    sheet.diagnostics.push(styleDiag("style-invalid-value", `\`${k}=${String(v)}\` must be a number (pixels)`, id));
    return false;
  }
  return true;
}
```

`StyleRule` 接口在 `params` 之后加：

```ts
  params: Record<string, Value>;
  /** 内含词（BOX_WORDS）。与 params 并列，结构上分开 —— 见 BOX_WORDS 上的注释。 */
  box: Record<string, Value>;
```

`collect()` 的 rule 分支，第 252–253 行替换为：

```ts
      const params: Record<string, Value> = {};
      const box: Record<string, Value> = {};
      for (const [k, v] of Object.entries(b.attrs)) {
        if (RULE_RESERVED.has(k)) continue;
        if (BOX_WORDS.has(k)) { if (boxValueOk(k, v, id, sheet)) box[k] = v; }
        else params[k] = v;
      }
```

第 255–258 行的 `rule` 字面量加 `box`：

```ts
      const rule: StyleRule = {
        id, branches: r.branches, params, box, layer,
        screens: screensRaw.split(/\s+/).filter((x) => x.length > 0),
      };
```

`Binding` 接口在 `params` 之后加：

```ts
  /** 合并后的内含词。宿主对它做一件事 —— 生成 CSS —— 对所有块一样。 */
  box: Record<string, Value>;
```

`ruleProps` 让 box 一起参加仲裁（仲裁对属性是通用的）：

```ts
function ruleProps(r: StyleRule): Record<string, Value> {
  const out: Record<string, Value> = { ...r.params, ...r.box };
  …（其余四行不变）
}
```

`resolveBindings` 第 433 行组装 binding 处，把赢出来的属性按名字分回两边：

```ts
    const box: Record<string, Value> = {};
    const rest: Record<string, Value> = {};
    for (const [k, v] of Object.entries(params)) (BOX_WORDS.has(k) ? box : rest)[k] = v;
    bindings.push({ doc: entry.path, block: address(entry.c), rules: hits.map((h) => h.rule.id), params: rest, box });
```

- [ ] **Step 4: 跑，确认通过**

```bash
npm run build && node test/style-check.test.mjs && node test/graph-style.test.mjs
```

`graph-style` 必须仍全绿 —— 它读的 `fold`/`depth`/`palette`/`hide-accessors` 都不是 BOX 词，不受分流影响。

- [ ] **Step 5: Commit**

```bash
git add src/style-resolve.ts test/style-check.test.mjs
git commit -m "feat(style): built-in box words are consumed into box, never passed through"
```

---

## Task 5: 装载 `when=` 与 `on=toggle`

**Files:**
- Modify: `geml-parser/src/style-resolve.ts`（`RULE_RESERVED`、`INTERACTIONS`、`StyleRule`、`collect()` 的 rule 分支）
- Test: `geml-parser/test/style-check.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface WhenCond { state: string; value: string }
  StyleRule.when: WhenCond[];      // 空数组 = 无条件
  ```
  Task 7 用它算条件集与 variants。

- [ ] **Step 1: 写失败的测试**

```js
test("装载：on=toggle 进闭集；其它仍是 unknown-interaction", () => {
  const ok = sheet('=== style-state {#tree type=scalar match="table" on=toggle init-value=open}\n===\n');
  assert.deepEqual(codes(ok.diagnostics), []);
  assert.equal(ok.states[0].on, "toggle");
  const bad = sheet('=== style-state {#t type=scalar match="table" on=hover}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["unknown-interaction"]);
});

test("装载：when= 解析成 $state=value 的列表，逗号并列（设计 §12.5）", () => {
  const s = sheet('=== style-rule {#r match="table" when="$tree=closed, $tab=Code" width=0}\n===\n');
  assert.deepEqual(s.rules[0].when, [{ state: "tree", value: "closed" }, { state: "tab", value: "Code" }]);
  assert.equal(s.rules[0].params.when, undefined, "when 是保留键，不透传");
  const plain = sheet('=== style-rule {#p match="table" width=0}\n===\n');
  assert.deepEqual(plain.rules[0].when, []);
});

test("装载：when= 形式不对是 style-invalid-value，且只做相等", () => {
  for (const bad of ['when="tree=closed"', 'when="$tree"', 'when="$tree!=closed"', 'when="$tree=closed or $tab=Code"']) {
    const s = sheet(`=== style-rule {#r match="table" ${bad} width=0}\n===\n`);
    assert.deepEqual(codes(s.diagnostics), ["style-invalid-value"], bad);
  }
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
npm run build && node test/style-check.test.mjs
```

- [ ] **Step 3: 实现**

`src/style-resolve.ts`：

第 16 行 `RULE_RESERVED` 加 `"when"`：

```ts
const RULE_RESERVED = new Set(["match", "component", "handler", "show", "filter", "screen", "when"]);
```

第 28 行：

```ts
const INTERACTIONS = new Set(["select", "toggle"]);
```

并把它上面那段注释的最后一句 "目前只有一个成员，因为目前只有一种交互被真正接线。多的等实例出现再加。" 改为：

```ts
 * `select` 是 codemap 接线的那一种；`toggle` 是第一个文档布局用例（折叠的文件树）
 * 带进来的，值在两个之间翻。多的等实例出现再加。
```

`StyleRule` 接口加：

```ts
  /**
   * 这条规则只在这些状态取值时生效；空 = 无条件。`$state=value`，逗号并列表示全部满足。
   * **只做相等**：没有 `!=`、没有 or —— §5.3 "没有条件、没有算术"的克制不破。
   * 求解时它作为普通条件进入条件集（设计 §12.5），仲裁不另设规则。
   */
  when: WhenCond[];
```

在 `StyleRule` 之前新增：

```ts
export interface WhenCond { state: string; value: string }

const WHEN_TERM = /^\$([A-Za-z0-9_-]+)=([^=!<>|&]+)$/;

/** 解析 `when=`；形式不对报 style-invalid-value 并返回 null。 */
function parseWhen(raw: string, id: string, sheet: Stylesheet): WhenCond[] | null {
  const out: WhenCond[] = [];
  for (const term of raw.split(",").map((x) => x.trim()).filter((x) => x.length > 0)) {
    const m = WHEN_TERM.exec(term);
    if (m === null || /\s(or|and)\s/i.test(term)) {
      sheet.diagnostics.push(styleDiag("style-invalid-value",
        `\`when=\` takes \`$state=value\` terms separated by commas (equality only); got \`${term}\``, id));
      return null;
    }
    out.push({ state: m[1]!, value: m[2]!.trim() });
  }
  return out;
}
```

`collect()` 的 rule 分支，在 `screensRaw` 之后、构造 `rule` 之前加：

```ts
      const whenRaw = str(b.attrs["when"]);
      let when: WhenCond[] = [];
      if (whenRaw !== undefined) {
        const parsed = parseWhen(whenRaw, id, sheet);
        if (parsed === null) continue;
        when = parsed;
      }
```

`rule` 字面量加 `when`：

```ts
      const rule: StyleRule = {
        id, branches: r.branches, params, box, layer, when,
        screens: screensRaw.split(/\s+/).filter((x) => x.length > 0),
      };
```

- [ ] **Step 4: 跑，确认通过**

```bash
npm run build && node test/style-check.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/style-resolve.ts test/style-check.test.mjs
git commit -m "feat(style): when= on rules and toggle in the interaction vocabulary"
```

---

## Task 6: 求解 frame 引用 —— 裸 `#x`、悬空、指到页、环、未引用

**Files:**
- Modify: `geml-parser/src/style-resolve.ts`（`ResolvedSlot`、`ViewModel`、`resolveStyle` 的槽位解析段第 542–562 行）
- Test: `geml-parser/test/style-check.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export type ResolvedSlot = … | { kind: "frame"; frame: string };
  export interface ResolvedFrame { id: string; axis: "row" | "column"; component?: string; slots: ResolvedSlot[] }
  ViewModel.frames: ResolvedFrame[];
  ```

- [ ] **Step 1: 写失败的测试**

```js
test("frame：槽位里裸 #x 是本样式表的 frame，带类型的才是语料块（设计 §12.4）", () => {
  const vm = resolve(
    '=== style-screen {#page slots="table#kpi, #body"}\n===\n\n' +
    '=== style-frame  {#body axis=row slots="table#plain"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.deepEqual(vm.screens[0].slots[1], { kind: "frame", frame: "body" });
  assert.equal(vm.screens[0].slots[0].kind, "blocks");
  assert.deepEqual(vm.frames.map((f) => [f.id, f.axis, f.slots[0].kind]), [["body", "row", "blocks"]]);
});

test("frame：裸 #x 没有对应 style-frame 是 unknown-frame 错误，消息教人加类型", () => {
  const vm = resolve('=== style-screen {#page slots="#kpi"}\n===\n');
  assert.deepEqual(codes(vm.diagnostics), ["unknown-frame"]);
  assert.match(vm.diagnostics[0].message, /text#kpi|a corpus block needs a type/);
  assert.equal(vm.diagnostics[0].rule, "page");
});

test("frame：裸 #x 指到 style-screen 是 screen-nested 错误 —— 页不能装进页", () => {
  const vm = resolve(
    '=== style-screen {#a slots="#b"}\n===\n\n' +
    '=== style-screen {#b slots="table"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["screen-nested"]);
});

test("frame：区域装区域成环是 frame-cycle 错误，消息带整条链", () => {
  const vm = resolve(
    '=== style-screen {#page slots="#a"}\n===\n\n' +
    '=== style-frame {#a slots="#b"}\n===\n\n' +
    '=== style-frame {#b slots="#c"}\n===\n\n' +
    '=== style-frame {#c slots="#a"}\n===\n'
  );
  const cyc = vm.diagnostics.filter((d) => d.code === "frame-cycle");
  assert.equal(cyc.length, 1, JSON.stringify(vm.diagnostics));
  assert.match(cyc[0].message, /#a → #b → #c → #a/);
  const self = resolve('=== style-frame {#a slots="#a"}\n===\n');
  assert.match(self.diagnostics.find((d) => d.code === "frame-cycle").message, /#a → #a/);
});

test("frame：声明了没人引用是 unused-frame warning", () => {
  const vm = resolve(
    '=== style-screen {#page slots="table"}\n===\n\n' +
    '=== style-frame {#orphan slots="table"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["unused-frame"]);
  assert.equal(vm.diagnostics[0].severity, "warning");
  assert.equal(vm.diagnostics[0].rule, "orphan");
});

test("frame：#x 不再拿去匹配语料，所以不会再有那条 unmatched-rule", () => {
  const vm = resolve(
    '=== style-screen {#page slots="#body"}\n===\n\n' +
    '=== style-frame {#body slots="table"}\n===\n'
  );
  assert.equal(vm.diagnostics.some((d) => d.code === "unmatched-rule"), false);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
npm run build && node test/style-check.test.mjs
```

- [ ] **Step 3: 实现**

`src/style-resolve.ts`：

`ResolvedSlot`（第 330–332 行）：

```ts
export type ResolvedSlot =
  | { kind: "blocks"; selector: string; blocks: { doc: string; block: string }[] }
  | { kind: "state"; state: string }
  /** 本样式表的一个 style-frame；宿主在这个格子里递归渲染它（设计 §12.4）。 */
  | { kind: "frame"; frame: string };

export interface ResolvedFrame {
  id: string;
  axis: "row" | "column";
  component?: string;
  slots: ResolvedSlot[];
}
```

`ViewModel` 加：

```ts
  screens: ResolvedScreen[];
  /** 顶层平铺、按 id 引用；没有 bindings —— 绑定表在 screen 上，覆盖整页所有块。 */
  frames: ResolvedFrame[];
```

`resolveStyle` 第 542–562 行的槽位解析段整段替换为：

```ts
  // ---- 槽位解析。`$state` 记名字；**裸 `#x` 是本样式表的 frame**（设计 §12.4）——
  // 语法上就和语料选择器分开了（语料块须带类型/类/属性），所以不需要查表消歧，
  // 写错的 `#bdoy` 也是 error 而非 warning；其余选择器展开成它选中的地址列表。
  // 运行时因此不需要任何选择器逻辑。
  const BARE_ID = /^#([A-Za-z0-9_-]+)$/;
  const frameIds = new Set(sheet.frames.map((f) => f.id));
  const referencedFrames = new Set<string>();
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
        referencedFrames.add(ref);
      }
      return { kind: "frame", frame: ref };
    }
    const r = parseSelector(slot);
    if (!r.ok) {
      diagnostics.push(selectorDiag(r, owner.id));
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
    const out: ResolvedScreen = { id: scr.id, axis: scr.axis, slots: resolveSlots(scr, "screen"), bindings: perScreen.get(scr.id) ?? [] };
    if (scr.component !== undefined) out.component = scr.component;
    return out;
  });
  const frames: ResolvedFrame[] = sheet.frames.map((f) => {
    const out: ResolvedFrame = { id: f.id, axis: f.axis, slots: resolveSlots(f, "frame") };
    if (f.component !== undefined) out.component = f.component;
    return out;
  });

  // ---- frame 的包含关系是一张图，可以成环（设计 §5.1 的括注、§12.4）。带路径栈的 DFS，
  // 一条环报一次、消息带整条链。**不设深度上限**：没有环就不可能无限深。
  const frameById = new Map(sheet.frames.map((f) => [f.id, f]));
  const reported = new Set<string>();
  const walk = (id: string, path: string[]): void => {
    const f = frameById.get(id);
    if (f === undefined) return;
    for (const slot of f.slots) {
      const bare = BARE_ID.exec(slot);
      if (bare === null || !frameById.has(bare[1]!)) continue;
      const next = bare[1]!;
      const at = path.indexOf(next);
      if (at >= 0) {
        const chain = [...path.slice(at), next].map((x) => `#${x}`).join(" → ");
        if (!reported.has(chain)) {
          reported.add(chain);
          diagnostics.push(styleDiag("frame-cycle", `frames nest in a cycle: ${chain}`, next));
        }
        continue;
      }
      walk(next, [...path, next]);
    }
  };
  for (const f of sheet.frames) walk(f.id, [f.id]);

  for (const f of sheet.frames) {
    if (!referencedFrames.has(f.id)) {
      diagnostics.push(styleDiag("unused-frame", `style-frame \`#${f.id}\` is referenced by no slot`, f.id));
    }
  }
```

并在函数末尾的返回对象里加 `frames`：

```ts
    screens,
    frames,
    bindings,
```

**注意**：`screenIds` 在第 459 行已存在（`new Set(sheet.screens.map((s) => s.id))`），复用它；`StyleContainer` 类型来自 Task 3。

同一环从不同起点走会得到不同的链串（`#a → #b → #a` 与 `#b → #a → #b`）。测试只要求"一条环报一次"，`reported` 按链串去重不够 —— 把链**归一化**再去重：旋转到字典序最小的 id 开头。把 `const chain = …` 那一行换成：

```ts
        const cyc = path.slice(at);                       // 环上的节点，不含重复的收尾
        const start = cyc.indexOf([...cyc].sort()[0]!);
        const rotated = [...cyc.slice(start), ...cyc.slice(0, start)];
        const chain = [...rotated, rotated[0]!].map((x) => `#${x}`).join(" → ");
```

- [ ] **Step 4: 跑，确认通过**

```bash
npm run build && node test/style-check.test.mjs
```

既有那条"状态：screen 的槽位也能引用状态"仍须过 —— `$sel` 分支在裸 `#x` 之前，没动。

- [ ] **Step 5: Commit**

```bash
git add src/style-resolve.ts test/style-check.test.mjs
git commit -m "feat(style): frames resolve from bare #id slots; unknown, nested-screen, cycle and unused are diagnosed"
```

---

## Task 7: `when=` 进条件集，求解出 `variants`

本计划最重的一处。既有 `resolveBindings` 的仲裁循环不重写，只是**分组**：无条件的命中是基础组，每个不同的 `when` 集合一组；组内照既有逻辑仲裁；组间只做**冲突检查**与**跨层裁决**，不做赋值。

**Files:**
- Modify: `geml-parser/src/style-resolve.ts`（`Binding`、`resolveBindings` 全函数、`checkRefs` 处）
- Test: `geml-parser/test/style-check.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface Variant { when: Record<string, string>; box: Record<string, Value>; params: Record<string, Value> }
  Binding.variants: Variant[];    // 按 when 条件数升序，同数按样式表内出现序
  ```

- [ ] **Step 1: 写失败的测试**

```js
const TREE = parse(
  '=== meta\ntitle = "t"\n===\n\n' +
  "=== table {#tree .region format=csv}\nname\nagents\n===\n\n" +
  "=== text {#toolbar}\nPreview Code Blame\n===\n"
);
const resolveT = (body) => resolveStyle(sheet(body), [{ path: "t.geml", doc: TREE }]);
const bT = (vm, addr) => vm.bindings.find((b) => b.block === addr);

test("when：有条件的规则不进基础参数，进 variants；条件集是无条件那条的真超集，不报错（设计 §12.5）", () => {
  const vm = resolveT(
    '=== style-state {#tree type=scalar match="table#tree" on=toggle init-value=open}\n===\n\n' +
    '=== style-rule {#open   match="table#tree" component=tree width=321px sticky=0}\n===\n\n' +
    '=== style-rule {#closed match="table#tree" when="$tree=closed" width=0}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  const b = bT(vm, "#tree");
  assert.deepEqual(b.box, { width: "321px", sticky: 0 });
  assert.equal(b.params.component, "tree");
  assert.deepEqual(b.variants, [{ when: { tree: "closed" }, box: { width: 0 }, params: {} }]);
});

test("when：互斥的 when 集合（同状态不同值）争同一属性不是冲突 —— tab 条的写法", () => {
  const vm = resolveT(
    '=== style-state {#tab type=scalar match="text#toolbar" on=select init-value=Preview}\n===\n\n' +
    '=== style-rule {#a match="text#toolbar" when="$tab=Preview" border="2px #fd8c73"}\n===\n\n' +
    '=== style-rule {#b match="text#toolbar" when="$tab=Code"    border="2px #fd8c73"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(bT(vm, "#toolbar").variants.length, 2);
});

test("when：可同时成立、互不包含、争同一属性 → ambiguous-rule（设计 §12.5）", () => {
  const vm = resolveT(
    '=== style-state {#tree type=scalar match="table#tree" on=toggle}\n===\n\n' +
    '=== style-state {#tab  type=scalar match="text#toolbar" on=select}\n===\n\n' +
    '=== style-rule {#a match="table#tree" when="$tree=closed" width=0}\n===\n\n' +
    '=== style-rule {#b match="table#tree" when="$tab=Code"    width=100px}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["ambiguous-rule"]);
});

test("when：有条件但选择器更弱的规则，对无条件的强选择器规则 → 不可比 → ambiguous-rule", () => {
  const vm = resolveT(
    '=== style-state {#tree type=scalar match="table" on=toggle}\n===\n\n' +
    '=== style-rule {#strong match="table#tree" width=321px}\n===\n\n' +
    '=== style-rule {#weak   match="table" when="$tree=closed" width=0}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["ambiguous-rule"]);
});

test("when：variants 按条件数升序 —— 真超集排在后面，运行时无需再比", () => {
  const vm = resolveT(
    '=== style-state {#tree type=scalar match="table" on=toggle}\n===\n\n' +
    '=== style-state {#tab  type=scalar match="text#toolbar" on=select}\n===\n\n' +
    '=== style-rule {#two match="table#tree" when="$tree=closed, $tab=Code" padding=0}\n===\n\n' +
    '=== style-rule {#one match="table#tree" when="$tree=closed" padding=8px}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.deepEqual(bT(vm, "#tree").variants.map((v) => Object.keys(v.when).length), [1, 2]);
});

test("when：引用未声明的状态是 unknown-state", () => {
  const vm = resolveT('=== style-rule {#r match="table#tree" when="$ghost=1" width=0}\n===\n');
  assert.deepEqual(codes(vm.diagnostics), ["unknown-state"]);
});

test("when：无条件规则的 variants 是空数组，既有绑定形状不变", () => {
  const vm = resolve('=== style-rule {#base match="table" component=data-table}\n===\n');
  assert.deepEqual(binding(vm, "#kpi").variants, []);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
npm run build && node test/style-check.test.mjs
```

- [ ] **Step 3: 实现**

`src/style-resolve.ts`：

`Binding` 接口加：

```ts
  box: Record<string, Value>;
  /**
   * 按状态取值才生效的那部分（设计 §12.5）。按 `when` 条件数升序、同数按样式表内出现序；
   * 运行时把条件全部满足的依次叠在基础参数上 —— 真超集一定排在后面，所以不用再比。
   */
  variants: Variant[];
```

在 `Binding` 之前新增：

```ts
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
```

`resolveBindings` 从第 388 行 `for (const entry of all) {` 到第 434 行 `bindings.push(…)` 整段替换为：

```ts
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
    type Group = { when: WhenCond[]; order: number; params: Record<string, Value>; owner: Map<string, typeof hits[number]> };
    const groups = new Map<string, Group>();
    const groupOf = (h: typeof hits[number]): Group => {
      const key = whenKey(h.rule.when);
      let g = groups.get(key);
      if (g === undefined) { g = { when: h.rule.when, order: h.order, params: {}, owner: new Map() }; groups.set(key, g); }
      return g;
    };
    const ambiguous = (a: typeof hits[number], b: typeof hits[number], k: string, identical: boolean): void => {
      diagnostics.push(styleDiag(
        "ambiguous-rule",
        `\`#${a.rule.id}\` and \`#${b.rule.id}\` both set \`${k}\` on \`${where(entry)}\`` +
        (screenId === null ? "" : ` in screen \`#${screenId}\``) + " — " +
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
        // **跨层先决胜**，再谈特异性（CSS `@layer` 的模型，设计 §4.1）。
        if (hit.rule.layer !== prev.rule.layer) {
          if (hit.rule.layer > prev.rule.layer) { g.params[k] = v; g.owner.set(k, hit); }
          continue;
        }
        if (moreSpecific(hit.conds, prev.conds)) { g.params[k] = v; g.owner.set(k, hit); continue; }
        if (moreSpecific(prev.conds, hit.conds)) continue;
        const identical = prev.conds.size === hit.conds.size && [...prev.conds].every((x) => hit.conds.has(x));
        ambiguous(prev, hit, k, identical);
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
    const variants: Variant[] = gs
      .filter((g) => g.when.length > 0)
      .sort((x, y) => x.when.length - y.when.length || x.order - y.order)
      .map((g) => {
        const s = split(g.params);
        const when: Record<string, string> = {};
        for (const c of g.when) when[c.state] = c.value;
        return { when, box: s.box, params: s.params };
      });
    bindings.push({
      doc: entry.path, block: address(entry.c), rules: hits.map((h) => h.rule.id),
      params: baseSplit.params, box: baseSplit.box, variants,
    });
  }
```

**Task 4 在第 433 行加的那四行组装代码被这段整体替代**，不要留两份。

`checkRefs` 处（第 518 行之后）加一行，让 `when=` 里的 `$x` 也进 unknown-state 检查：

```ts
  for (const rule of sheet.rules) for (const c of rule.when) checkRefs(`$${c.state}`, rule.id);
```

- [ ] **Step 4: 跑，确认通过 —— 含既有的 ambiguous-rule 三种情况与 screen= 全部用例**

```bash
npm run build && node test/style-check.test.mjs && node test/graph-style.test.mjs
```

既有第 97 / 111 / 339–385 行那些用例是这一步的回归网：仲裁语义在无条件规则上必须**逐字不变**。

- [ ] **Step 5: Commit**

```bash
git add src/style-resolve.ts test/style-check.test.mjs
git commit -m "feat(style): when= joins the condition set; conditional rules resolve into ordered variants"
```

---

## Task 8: 验收 —— GitHub blob 页的样式表端到端

设计 §12.4 / §12.5 那份样式表对着一份写好的内容文档，`geml style check` 必须 0 error 0 warning，`--json` 的形状必须是 §12.6。

**Files:**
- Create: `geml-parser/test/fixtures/style-page/page.geml`
- Create: `geml-parser/test/fixtures/style-page/github.style.geml`
- Test: `geml-parser/test/style-check.test.mjs`

- [ ] **Step 1: 写 fixture**

```bash
mkdir -p geml-parser/test/fixtures/style-page
```

`geml-parser/test/fixtures/style-page/page.geml`（用 `\n` 行尾写入）：

```
=== meta
title = "Publishing — what ships, where it lands, and how to know it did"
===

=== text {#global-header}
Search or jump to… · Pull requests · Issues · Codespaces · Marketplace
===

=== text {#repo-tabs}
Code · Issues · Pull requests · Actions · Projects · Wiki · Security · Insights
===

=== table {#file-tree format=csv}
name
agents
docs
geml-parser
===

=== text {#breadcrumb}
geml / docs / PUBLISHING.md
===

=== text {#commit-bar}
xiongjy2104 · feat(projection): the meta title is the h1 · 2 days ago · History
===

=== text {#toolbar}
Preview · Code · Blame
===

=== text {#content}
Eight things ship from this repository on six version tracks.
===
```

`geml-parser/test/fixtures/style-page/github.style.geml`：

```
=== meta
profile = "geml-style/v1"
title = "GitHub blob page, as a geml-style stylesheet"
===

=== style-screen {#page axis=column slots="text#global-header, text#repo-tabs, #body"}
===
=== style-frame  {#body axis=row    slots="table#file-tree, #main"}
===
=== style-frame  {#main axis=column slots="text#breadcrumb, text#commit-bar, #card"}
===
=== style-frame  {#card axis=column slots="text#toolbar, text#content"}
===

=== style-state {#tree type=scalar match="table#file-tree" on=toggle init-value=open}
===
=== style-state {#tab  type=scalar match="text#toolbar" on=select init-value=Preview}
===

=== style-rule {#hdr    match="text#global-header" component=global-header background="#24292f" color="#fff"}
===
=== style-rule {#tabs   match="text#repo-tabs" component=tab-bar}
===
=== style-rule {#tree-open   match="table#file-tree" component=tree width=321px sticky=0 scroll=own hide-below=1012}
===
=== style-rule {#tree-closed match="table#file-tree" when="$tree=closed" width=0}
===
=== style-rule {#crumb  match="text#breadcrumb" font-size=14px}
===
=== style-rule {#commit match="text#commit-bar" font-size=12px color="#59636e"}
===
=== style-rule {#tb     match="text#toolbar" component=tab-bar sticky=0}
===
=== style-rule {#md     match="text#content" component=markdown-body padding=32px max-width=1012px font-size=16px line-height=24px color="#1f2328"}
===
```

- [ ] **Step 2: 写测试**

```js
test("验收：GitHub blob 页的样式表 —— 0 error 0 warning，视图模型是 §12.6 的形状", () => {
  const dir = join("test", "fixtures", "style-page");
  const r = cli("style", "check", join(dir, "github.style.geml"), join(dir, "page.geml"));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /0 error\(s\), 0 warning\(s\)/);

  const j = cli("style", "check", join(dir, "github.style.geml"), join(dir, "page.geml"), "--json");
  const vm = JSON.parse(j.out);
  assert.deepEqual(vm.screens.map((s) => [s.id, s.axis]), [["page", "column"]]);
  assert.deepEqual(vm.screens[0].slots.map((s) => s.kind), ["blocks", "blocks", "frame"]);
  assert.deepEqual(vm.frames.map((f) => [f.id, f.axis]), [["body", "row"], ["main", "column"], ["card", "column"]]);
  assert.deepEqual(vm.frames[0].slots[1], { kind: "frame", frame: "main" });

  const tree = vm.bindings.find((b) => b.block === "#file-tree");
  assert.deepEqual(tree.box, { width: "321px", sticky: 0, scroll: "own", "hide-below": 1012 });
  assert.equal(tree.params.component, "tree");
  assert.deepEqual(tree.variants, [{ when: { tree: "closed" }, box: { width: 0 }, params: {} }]);

  const body = vm.bindings.find((b) => b.block === "#content");
  assert.equal(body.box["max-width"], "1012px");
  assert.equal(body.box.padding, "32px");
  assert.deepEqual(vm.states.map((s) => [s.id, s.on]), [["tree", "toggle"], ["tab", "select"]]);
});
```

`join` 已在测试文件顶部 import。`cli()` 的 cwd 是 `geml-parser/`（`spawnSync` 默认继承），所以相对路径 `test/fixtures/…` 成立。

- [ ] **Step 3: 跑**

```bash
npm run build && node test/style-check.test.mjs
```

预期：通过。若 `0 warning` 不成立，读 `r.out` —— 最可能是 `unmatched-rule`（fixture 里少了某个 id）或 `style-invalid-value`（某个值写错了类型）。改 fixture，不改断言。

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/style-page test/style-check.test.mjs
git commit -m "test(style): the GitHub blob page as a stylesheet checks clean and resolves to the §12.6 shape"
```

---

## Task 9: profile 文档（EN）

`spec/profiles/geml-style/geml-style-profile.md`。每处给出要替换/追加的**完整文字**。

**Files:**
- Modify: `spec/profiles/geml-style/geml-style-profile.md`

- [ ] **Step 1: §0.1 稳定性表 —— 右栏搬家**

把 §0.1 的表替换为：

```markdown
| held | free to move |
|---|---|
| `profile = "geml-style/v1"` | `style-state` with `filter=` / `show=` consumers |
| `style-rule` · `match=` · `when=` | `handler=` (no real host yet) |
| `style-screen` · `style-frame` · `slots=` · `axis=` · `component=` on containers | `value-from=` / `init-value=` beyond the two real states |
| the built-in words of §2.1 | |
| attribute pass-through (§2.1) | |
| the style entry: its path + `default-style` (§1.1) | |
| `on=select` · `on=toggle` | |
```

并把表下那段 "The held column is held because it **escaped**…" 的第一句改为：

```markdown
The held column is held because it **escaped** — twice. Every codemap build seeds
`_index/style.geml` **and its entry `_index/index.geml`** into a user's repository;
and since 2026-09-09 the document-layout use case (a page rendered by the viewer)
exercises screens, frames, the built-in words and `when=`. The right column is
**specified, checked, and unexercised** — it will move with its first genuine use case.
```

- [ ] **Step 2: §2 标题与 §2.1 的两处追加**

`## 2. The three block types` → `## 2. The four block types`。

§2.1 属性表 `screen=` 那一行之后插一行：

```markdown
| `when=` | no | `$state=value` terms, comma-separated, all must hold; equality only (§4) |
```

§2.1 的 "The pass-through is the reason…" 段落之前插入：

```markdown
**Built-in words.** A small closed set of attributes is the profile's own, not the
component's: they mean the same thing on a paragraph, a table or a diagram, so every
host renders them the same way (the CSS-property side of the CSS/Web-Components split).
They are consumed here and land in the view model's `box`; a component never sees them
in its `params`, so it cannot give `width` a private meaning.

| word | domain | on |
|---|---|---|
| `width` `max-width` `padding` | open (a CSS length) | blocks |
| `sticky` | a number: offset from the top in px | blocks |
| `scroll` | `own` \| `page` | blocks |
| `hide-below` | a number: viewport px below which the block is hidden | blocks |
| `font-size` `line-height` `color` `background` `border` | open | blocks |
| `axis` | `row` \| `column` (default `column`) | `style-screen` / `style-frame` |

Closed domains are checked (`style-invalid-value`); open ones are handed to the host
verbatim. The list is pinned to the first real page and grows one measured need at a
time. The test for a candidate: *does it mean the same thing on any block?* — `fold`,
`collapsible`, `indent` do not, and stay component parameters.
```

并把 "The reserved names above are the complete list of keys the profile itself consumes." 改为：

```markdown
The reserved names above plus the built-in words are the complete list of keys the
profile itself consumes.
```

- [ ] **Step 3: §2.2 `on=` 闭集**

表里 `on=` 那一行改为：

```markdown
| `on=` | **yes** | which interaction writes it. **Closed vocabulary**: `select` (the value is what was picked), `toggle` (the value flips between two) |
```

- [ ] **Step 4: §2.3 重写为 screen，新增 §2.4 frame**

把 §2.3 整节（从 `### 2.3 \`style-screen\`` 到 `## 3. Selector grammar` 之前）替换为：

```markdown
### 2.3 `style-screen` — a page

```
  === style-screen {#page axis=column slots="text#global-header, text#repo-tabs, #body"}
  ===
```

| attribute | required | meaning |
|---|---|---|
| `slots=` | **yes** | **comma-separated**, ordered. Each slot is a corpus selector, a `$state`, or a bare `#id` naming a `style-frame` of this stylesheet |
| `axis=` | no | `row` or `column` (default): how the slots are laid along the container |
| `component=` | no | a host-named arrangement (`grid`, …); optional, unvalidated — layout is the host's business |

A screen is a **root**: a whole page. How many roots a stylesheet may have is the
host's rule, not the profile's — codemap's master/detail is several; a viewer rendering
"this page" wants exactly one, falls back to its plain rendering on none, and refuses
two.

**Slot grammar.** A bare `#x` is a frame reference; anything with a type, class or
attribute (`text#x`, `table.kpi`, `#x[attr]`) is a corpus selector. The split is
syntactic, so it needs no lookup and no disambiguation error, and a mistyped `#bdoy`
is an error (`unknown-frame`), not a warning. This follows GEML's own convention: a
bare `#id` addresses this document; another document takes a path.

**There is no `route=`.** Routing belongs to the host framework; a stylesheet
declaring it again is two routers fighting.

### 2.4 `style-frame` — a region inside a page

```
  === style-frame {#body axis=row slots="table#file-tree, #main"}
  ===
```

Same attributes as `style-screen`. A frame can only appear where a slot names it, and
its own slots may name further frames — a page is a tree of frames. Unlike an
`<iframe>` it is not a separate document and isolates nothing; it is a box.

| check | code | severity |
|---|---|---|
| a bare `#x` in `slots=` names no frame | `unknown-frame` | error |
| a bare `#x` names a `style-screen` — a page cannot be placed inside another | `screen-nested` | error |
| frames nest in a cycle (`#a → #b → #a`; the message carries the chain) | `frame-cycle` | error |
| a frame no slot references | `unused-frame` | warning |

There is deliberately **no depth cap**: without a cycle the tree cannot be unbounded,
and a second gate would only ever fire on cycles the first already caught.
```

- [ ] **Step 5: §4 条件集一句**

§4 开头 "strict-superset of condition sets" 那段之后加一段：

```markdown
A rule's **condition set** is its selector's conditions plus `screen=` (§2.1) plus each
`when=` term. The last two enter as ordinary conditions, so the arbitration below
applies to them unchanged: a conditional rule with the same selector is a strict
superset of the unconditional one and wins — at runtime, when its state holds. Two
conditional rules whose `when=` sets are **exclusive** (the same state, different
values) can never both apply and are not a conflict; two that can both hold, are
incomparable, and set one attribute are `ambiguous-rule`, exactly as before.
```

- [ ] **Step 6: §5 管道那句的括注**

§5 "The catalogue therefore has **no `binding-cycle` code**." 之后加：

```markdown
That sentence is about **state**. Frames (§2.4) are a second graph — regions holding
regions — and that one can cycle, so it has `frame-cycle`. The two graphs do not touch:
state never reads state, and a frame holds no state.
```

- [ ] **Step 7: §8 诊断表加五行**

在 `style-embed-not-expanded` 那一行之后：

```markdown
| `unknown-frame` | error | a bare `#x` in `slots=` names no `style-frame` |
| `screen-nested` | error | a bare `#x` in `slots=` names a `style-screen` |
| `frame-cycle` | error | frames nest in a cycle; the message carries the chain |
| `unused-frame` | warning | a `style-frame` no slot references |
| `style-invalid-value` | error | a closed-domain built-in word (`axis` / `scroll` / `sticky` / `hide-below`) took a value outside its domain, or `when=` is not `$state=value` |
```

- [ ] **Step 8: §10 视图模型**

§10 的四字段表替换为：

```markdown
| field | shape |
|---|---|
| `states` | `{id, type, on, valueFrom?, initValue?}[]` — `on` is `select` or `toggle` |
| `screens` | `{id, axis, component?, slots, bindings}[]` — the roots |
| `frames` | `{id, axis, component?, slots}[]` — flat, referenced by id; no bindings of their own |
| `bindings` | the screen-unqualified table |
| `diagnostics` | `{severity, code, message, rule?}[]` |
```

"A **binding** is `{doc, block, rules, params}`." 改为：

```markdown
A **binding** is `{doc, block, rules, params, box, variants}`. `params` are the
component's words (including `component` / `handler` / `show` / `filter`); `box` the
built-in words of §2.1, kept apart so a host applies them uniformly and a component
never sees them. `variants` is `{when, box, params}[]` — the parts that apply only
while every `when` entry (`{state: value}`) holds — ordered by number of conditions
ascending, then stylesheet order, so a runtime overlays the matching ones in sequence
and never re-arbitrates.
```

"**Slots arrive resolved**" 的 JSON 例子加第三行：

```json
{"kind": "frame",  "frame": "body"}
```

- [ ] **Step 9: 校对并提交**

```bash
node geml-parser/dist/geml.js check spec/profiles/geml-style/geml-style-profile.md 2>&1 | tail -2
git add spec/profiles/geml-style/geml-style-profile.md
git commit -m "docs(style-profile): frames, built-in words, when= and toggle — the document-layout vocabulary"
```

（`geml check` 读 Markdown 不改写，只是确认没有围栏意外开成真块。）

---

## Task 10: profile 文档（CN）

`spec/profiles/geml-style/geml-style-profile_CN.md` 是**手维护**的（不是翻译投影），与 Task 9 逐节对应。

**Files:**
- Modify: `spec/profiles/geml-style/geml-style-profile_CN.md`

- [ ] **Step 1: §0.1 表**

```markdown
| 已固定 | 可移动 |
|---|---|
| `profile = "geml-style/v1"` | 带 `filter=` / `show=` 消费者的 `style-state` |
| `style-rule` · `match=` · `when=` | `handler=`（还没有真实宿主） |
| `style-screen` · `style-frame` · `slots=` · `axis=` · 容器上的 `component=` | 两个真实状态之外的 `value-from=` / `init-value=` |
| §2.1 的内含词 | |
| 属性透传（§2.1） | |
| 样式入口：路径 + `default-style`（§1.1） | |
| `on=select` · `on=toggle` | |
```

表下第一句改为：

```markdown
左栏被固定，是因为它**逃逸了**——两次。每次 codemap 构建都会把 `_index/style.geml`
**和它的入口 `_index/index.geml`** 播种进用户仓库；而自 2026-09-09 起，文档布局用例
（viewer 渲染的一整页）用上了 screen、frame、内含词和 `when=`。右栏是**写了规范、有检查、
没人用** —— 等第一个真实用例来了再动。
```

- [ ] **Step 2: §2 标题与 §2.1**

`## 2. 三个块类型` → `## 2. 四个块类型`。

§2.1 表 `screen=` 行后插：

```markdown
| `when=` | 否 | `$state=value` 项，逗号并列、全部满足；只做相等（§4） |
```

"透传正是……" 段之前插入：

```markdown
**内含词。** 一小组封闭的属性是 profile 自己的、不是组件的：它们放在段落、表格、图上意思
都一样，所以每个宿主同解（CSS 属性 / Web Components 属性那条分界线的 CSS 那一侧）。它们在
这里被消费、落进视图模型的 `box`；组件在 `params` 里永远看不到它们，所以不可能把 `width`
另解释成别的意思。

| 词 | 值域 | 挂在 |
|---|---|---|
| `width` `max-width` `padding` | 开放（CSS 长度） | 块 |
| `sticky` | 数字：距顶 px | 块 |
| `scroll` | `own` \| `page` | 块 |
| `hide-below` | 数字：视口窄于此 px 则隐藏 | 块 |
| `font-size` `line-height` `color` `background` `border` | 开放 | 块 |
| `axis` | `row` \| `column`（默认 `column`） | `style-screen` / `style-frame` |

封闭值域会被检查（`style-invalid-value`）；开放的原样交给宿主。清单按第一个真实页面圈死，
一次只按实测需要加一个。判据：*换个块还是不是这个意思？*——`fold`、`collapsible`、`indent`
不是，所以仍是组件参数。
```

"以上保留名是 profile 自己消费的键的完整清单。" 改为：

```markdown
以上保留名加内含词，是 profile 自己消费的键的完整清单。
```

- [ ] **Step 3: §2.2 `on=`**

```markdown
| `on=` | **是** | 哪种交互写它。**封闭词汇**：`select`（值是选中的那个）、`toggle`（值在两个之间翻） |
```

- [ ] **Step 4: §2.3 重写、新增 §2.4**

替换 §2.3 整节为：

```markdown
### 2.3 `style-screen` —— 一页

```
  === style-screen {#page axis=column slots="text#global-header, text#repo-tabs, #body"}
  ===
```

| 属性 | 必需 | 含义 |
|---|---|---|
| `slots=` | **是** | **逗号分隔**、有序。每个槽位是一个语料选择器、一个 `$state`，或一个裸 `#id`——本样式表里的某个 `style-frame` |
| `axis=` | 否 | `row` 或 `column`（默认）：槽位沿容器横排还是竖排 |
| `component=` | 否 | 宿主命名的特殊排布（`grid` 之类）；可选、不校验——排布是宿主的事 |

screen 是**根**：一整页。一份样式表能有几个根是**宿主**的规则，不是 profile 的——codemap
的 master/detail 有好几个；渲染"这一页"的 viewer 要恰好一个，0 个退回它的普通渲染，
2 个拒绝。

**槽位语法。** 裸 `#x` 是 frame 引用；带类型、类或属性的（`text#x`、`table.kpi`、
`#x[attr]`）是语料选择器。这是**语法**上的区分，不需要查表、不需要消歧诊断，写错的
`#bdoy` 是错误（`unknown-frame`）而不是警告。它遵循 GEML 自己的约定：裸 `#id` 指本文档，
别的文档要带路径。

**不提供 `route=`。** 路由是宿主框架的事，样式表再声明一遍就是两套路由打架。

### 2.4 `style-frame` —— 页内的一块区域

```
  === style-frame {#body axis=row slots="table#file-tree, #main"}
  ===
```

属性与 `style-screen` 相同。frame 只能出现在某个槽位点名它的地方，它自己的槽位可以再点名
别的 frame——一页是一棵 frame 树。它不是 `<iframe>`：不是独立文档、不隔离任何东西，就是
一个盒子。

| 检查 | 码 | 级别 |
|---|---|---|
| `slots=` 里的裸 `#x` 没有对应 frame | `unknown-frame` | error |
| 裸 `#x` 指到了 `style-screen`——页不能装进页 | `screen-nested` | error |
| frame 嵌套成环（`#a → #b → #a`；消息带整条链） | `frame-cycle` | error |
| 没有任何槽位引用的 frame | `unused-frame` | warning |

刻意**不设深度上限**：没有环树就不可能无限深，第二道闸只会在第一道已经抓住的环上响。
```

- [ ] **Step 5: §4 条件集**

§4 开头那段之后加：

```markdown
一条规则的**条件集** = 它选择器的各项条件 + `screen=`（§2.1）+ 每一项 `when=`。后两者作为
普通条件进入，所以下面的裁决对它们原样成立：同选择器的有条件规则是无条件那条的真超集，
它赢——在运行时、当它的状态成立时。两条有条件规则若 `when=` 集合**互斥**（同一状态、不同值）
则永不同时生效，不算冲突；能同时成立、互不包含、又争同一属性的两条，照旧是 `ambiguous-rule`。
```

- [ ] **Step 6: §5 括注**

"目录里因此**没有 `binding-cycle` 码**。" 之后加：

```markdown
那句话说的是**状态**。frame（§2.4）是第二张图——区域装区域——它能成环，所以有 `frame-cycle`。
两张图不相干：状态永不读状态，frame 不持有状态。
```

- [ ] **Step 7: §8 加五行**

```markdown
| `unknown-frame` | error | `slots=` 里的裸 `#x` 没有对应的 `style-frame` |
| `screen-nested` | error | `slots=` 里的裸 `#x` 指到了 `style-screen` |
| `frame-cycle` | error | frame 嵌套成环；消息带整条链 |
| `unused-frame` | warning | 没有任何槽位引用的 `style-frame` |
| `style-invalid-value` | error | 封闭值域的内含词（`axis` / `scroll` / `sticky` / `hide-below`）取了域外值，或 `when=` 不是 `$state=value` |
```

- [ ] **Step 8: §10 视图模型**

四字段表：

```markdown
| 字段 | 形状 |
|---|---|
| `states` | `{id, type, on, valueFrom?, initValue?}[]`——`on` 是 `select` 或 `toggle` |
| `screens` | `{id, axis, component?, slots, bindings}[]`——根 |
| `frames` | `{id, axis, component?, slots}[]`——平铺、按 id 引用；自己没有 bindings |
| `bindings` | 未限定屏幕的那一张 |
| `diagnostics` | `{severity, code, message, rule?}[]` |
```

binding 那句改为：

```markdown
一个**绑定**是 `{doc, block, rules, params, box, variants}`。`params` 是组件的词（含
`component` / `handler` / `show` / `filter`）；`box` 是 §2.1 的内含词，单独放着，宿主统一
处理、组件永远看不到。`variants` 是 `{when, box, params}[]`——只在每一项 `when`
（`{state: value}`）都成立时才叠上的那部分——按条件数升序、同数按样式表内出现序，运行时
把匹配的依次叠上去，不再裁决。
```

槽位 JSON 例子加：

```json
{"kind": "frame",  "frame": "body"}
```

- [ ] **Step 9: 校对并提交**

```bash
node geml-parser/dist/geml.js check spec/profiles/geml-style/geml-style-profile_CN.md 2>&1 | tail -2
git add spec/profiles/geml-style/geml-style-profile_CN.md
git commit -m "docs(style-profile): CN mirror of the document-layout vocabulary"
```

---

## Task 11: 全部闸门

**Files:** 无改动；只跑。

- [ ] **Step 1: 全量套件 —— 跑一次，同一次取输出与退出码**

```bash
cd geml-parser && npm run build && node test/all.mjs 2>&1 | tail -15; echo "SUITE_EXIT=${PIPESTATUS[0]}"
```

预期：`SUITE_EXIT=0`。有红的先读**第一条**失败，不看覆盖率。

- [ ] **Step 2: 覆盖率闸门**

```bash
npm run coverage:check 2>&1 | tail -8; echo "COV_EXIT=${PIPESTATUS[0]}"
```

预期：`COV_EXIT=0`，四项 ≥ 95%。掉下去最可能是 Task 7 组间循环里的某个分支（跨层丢弃、
互斥跳过）没被测到——按缺的分支**补测试**，不降门槛。

- [ ] **Step 3: 确认 `geml.ts` 顶层导入未动**

```bash
git diff main -- geml-parser/src/geml.ts | head -3
```

预期：空。非空则 viewer 的 esbuild stub 要同步（本计划不应触发）。

- [ ] **Step 4: 汇报**

不 bump、不写 CHANGELOG、不 push——把 `git log --oneline main..HEAD` 交给用户。

---

## 自查

**规格覆盖（§12 → Task）：** §12.3 内含词与 `box` → Task 4；`axis` → Task 3；§12.4 frame / 裸 `#id` / 四个诊断 / `layout→component` → Task 1、2、3、6；§12.5 `toggle` / `when=` / 条件集 / variants / 互斥 / 顺序 → Task 5、7；§12.6 视图模型 → Task 6、7、9、10；§12.7 viewer → **计划 F**；§12.8 profile 文档 → Task 9、10；实现中新确定的三条 → Task 0。

**类型一致性：** `StyleContainer`（Task 3）在 Task 6 的 `resolveSlots` 参数上复用；`BOX_WORDS`（Task 4）在 Task 7 的 `split` 里复用；`WhenCond`（Task 5）在 Task 7 的 `exclusive` / `whenKey` 上复用；`Variant`（Task 7）与 Task 8 断言的形状一致。

**已知的边界，写在这里而不是留给实现者猜：**
- `when=` 的 value 里不能有 `,`（它是分隔符）—— 与 `slots=` 同一条规矩，实测页面上的值（`closed`、`Code`）都不需要。
- `hide-below` 取的是"低于此宽隐藏"，实测阈值落在 769–1011 之间；写 `1012` 是取 Primer 的 `lg`，不是量出来的确数。


---

## 第三部分：viewer 渲染整页（计划 F，2026-09-09）

**Goal:** geml-viewer 打开一份 `.geml` 时，找到它的样式入口，把计划 E 交出的视图模型画成一整页 —— frame 嵌套、内含词变 CSS、三个组件、两种交互 —— 没有样式入口时与今天一字不差。

**Architecture:** 三个新模块，都在 `integrations/geml-viewer/src/`，都是纯函数、能在 linkedom 里跑：`style-entry.js` 异步预取样式入口及其引用的每份文件，再用**同步**的 `loadDoc` 喂给解析器的 `loadStylesheet`/`resolveStyle`（它们是同步 API，浏览器 fetch 不是，预取到 Map 里是唯一的接法）；`layout.js` 把 `screens[0]` 展成 DOM 树、把每个 binding 的 `box` 和 `variants` 生成一段 CSS，状态是 `<body>` 上的 class，所以状态变化不重绘；`components.js` 是宿主注册表（`tree` / `tab-bar` / `markdown-body`）加 `toggle` / `select` 的接线。`content.js` 只多一个分叉：有样式入口且恰好一个 screen → 走 `layout.js`，否则今天的路径。

**Tech Stack:** esbuild 打包（已有 `build.mjs`）、linkedom 测试、`c8` 闸门（viewer 的门槛是 lines 85 / statements 85 / functions 90 / branches 75）。

**依据：** `docs/design/specs/2026-08-29-geml-style-design.md` §12.7；视图模型形状 §12.6；profile §2.3 / §2.4 / §10。前置：计划 E 已在 `feat/style-page-layout` 上（`resolveStyle` 产出 `screens` / `frames` / `box` / `variants`）。

## Global Constraints

- **绝不改 `geml-parser/src/geml.ts` 的顶层导入/再导出**。viewer 需要的 `loadStylesheet` / `resolveStyle` 从 `geml-parser/dist/style-resolve.js` 直接导出（`parse-entry.js` 已对 `selector.js` / `coord.js` / `render.js` 这么做），不经 `geml.js`。
- **注入页面的 CSS 不能加载任何资源**（`raw.githubusercontent.com` 的 `default-src 'none'`）：没有 `url()`、没有字体、没有图。`<style>` 元素本身可以注入 —— `content.js` 的 `injectStyle()` 今天就这么做。
- **同源限制**：样式入口和它引用的每份文件都经 `content.js` 既有的 `isSameOriginSrc` 闸（http(s) 同源；`file://` 同目录），`credentials: "omit"`，HTML content-type 拒收。和 `src=` 表、`embed`、code-graph 三条既有 fetch 路径**一字不差**。
- 预取有上限：深度 8（与 `EMBED_DEPTH_CAP` 同值）、总文件数 32、单文件 4 MB（`EMBED_DOC_BYTES_CAP`）。超限 = 没有样式入口，退回默认渲染并在 console 说明。
- 跨平台：测试用 linkedom，不依赖真实浏览器；fixture 用 `\n`。
- 贵命令跑一次：`npm --prefix integrations/geml-viewer run coverage:check`（含 build + 全套件），退出码从同一次取。**`| tail` 管道报的是 tail 的退出码** —— 用 `${PIPESTATUS[0]}`。
- 发布前 `grep -c "cdn.jsdelivr" dist/viewer.bundle.js` 必须是 0（CWS 拒含远程代码字符串的 bundle）。`style-resolve.js` 不含，但闸门照跑。
- 提交用用户 git 身份，无 AI 署名；不 bump manifest 版本、不写 CHANGELOG。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `integrations/geml-viewer/src/parse-entry.js`（修改） | +`loadStylesheet` / `resolveStyle` 再导出 |
| `integrations/geml-viewer/src/style-entry.js`（新建） | 找 `_index/index.geml`，预取它引用的每份样式表，装载并求解 → 视图模型（或 `null`） |
| `integrations/geml-viewer/src/layout.js`（新建） | 视图模型 → DOM（screen / frame / slot / 块）+ 生成的 CSS（`box`、`variants`、`hide-below`）+ 状态 class |
| `integrations/geml-viewer/src/components.js`（新建） | 宿主注册表：`tree` / `tab-bar` / `markdown-body`；`toggle` / `select` 接线 |
| `integrations/geml-viewer/src/content.js`（修改） | 分叉：有页就画页，否则今天的路径；诊断横幅 |
| `integrations/geml-viewer/src/geml.css`（修改） | `.geml-page` / `.geml-frame[data-axis]` / `.geml-placed` / `.geml-tree` / `.geml-tabs` 的静态规则 |
| `integrations/geml-viewer/test/layout.test.mjs`（新建） | 三个模块的 linkedom 测试 + 用真 fixture 的端到端 |
| `integrations/geml-viewer/test/all.mjs`（修改） | 注册 `layout` |
| `docs/design/specs/2026-08-29-geml-style-design.md`（修改） | §12.7 补四条实现中定下来的规则（Task 0） |

**刻意的决定 —— 状态是 `<body>` 上的 class，variant 是带 body 选择器的 CSS 规则。** `when="$tree=closed"` 生成 `body.geml-s-tree-closed .geml-b-file-tree { width: 0 }`。状态一变只换 body class，不重绘；两个条件的 variant 选择器天然比一个条件的特异性高，和 §12.5 "更具体的赢"一致，运行时零仲裁。

**刻意的决定 —— 没被任何槽位放置的块不渲染。** screen 定义了整页；CSS 世界里样式表决定什么可见。数量记在返回值 `unplaced` 里，content.js 打到 console，不做横幅。

---

## Task 0: §12.7 补四条实现规则

**Files:**
- Modify: `docs/design/specs/2026-08-29-geml-style-design.md`（§12.7 末尾、"退路" 那行之前）

- [ ] **Step 1: 在 §12.7 第 3 条之后、"**退路**" 之前插入**

```markdown
实现时定下的四条，profile 没写、宿主必须有答案：

- **入口在哪**：与被看文档**同目录**的 `_index/index.geml`；用 `meta.profile` 含 `geml-style/v1`
  来**认**，路径上放了别的东西按"没有入口"处理（profile §1.1 的话）。入口里的路径相对于
  `_index/`。viewer 的 fetch 是异步的而 `loadStylesheet` 的 `loadDoc` 是同步的，所以先按
  `default-style` / `#sitemap` 命中 / 每条 `embed {src=}` 传递地把文件预取进一张 Map，再同步喂。
- **`toggle` 翻到哪个值**：profile 只说"两个之间翻"没说是哪两个。取 `init-value` 和该状态在
  所有 `when=` 里被点名的**那一个**别的值；点名了零个或多于一个，toggle 惰性并在 console 说明。
- **没被槽位放置的块不渲染**：screen 就是整页。数量报到 console。
- **screen 数**：0 → 今天的单栏；1 → 画页；≥2 → 横幅说明 + 单栏。视图模型带 error 级诊断 → 同样
  横幅 + 单栏，横幅列出诊断。"拒绝"永远是可读的退回，不是白页。
```

- [ ] **Step 2: Commit**

```bash
git add docs/design/specs/2026-08-29-geml-style-design.md
git commit -m "docs(style): §12.7 — where the viewer looks, what toggle flips to, unplaced blocks, screen count"
```

---

## Task 1: 把解析器的样式求解露给 bundle

**Files:**
- Modify: `integrations/geml-viewer/src/parse-entry.js`
- Test: `integrations/geml-viewer/test/layout.test.mjs`（新建，本 Task 只放导入）

- [ ] **Step 1: 写失败的测试 —— 新建 `test/layout.test.mjs`**

```js
// 页面布局（计划 F）：样式入口的发现、视图模型 → DOM/CSS、组件与状态。
// linkedom 提供 document；三个模块都是纯函数，所以在 Node 里跑。
import { parse } from "../../../geml-parser/dist/geml.js";
import { loadStylesheet, resolveStyle } from "../src/parse-entry.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const atest = async (name, fn) => { await fn(); passed++; console.log("ok", name); };

test("parse-entry 露出 loadStylesheet / resolveStyle，不经 geml.js", () => {
  assert.equal(typeof loadStylesheet, "function");
  assert.equal(typeof resolveStyle, "function");
});

console.log(`\n${passed} layout tests passed.`);
```

- [ ] **Step 2: 跑，确认失败**

```bash
cd integrations/geml-viewer && node test/layout.test.mjs
```

预期：`SyntaxError: The requested module '../src/parse-entry.js' does not provide an export named 'loadStylesheet'`。

- [ ] **Step 3: 实现**

`src/parse-entry.js` 末尾追加：

```js
// geml-style（计划 E/F）：样式表的装载与求解。从定义它的模块取 —— `geml.js` 不再导出
// 它，而拓宽 `geml.js` 的表面正是 viewer 的 esbuild stub 必须跟着改的那件事。
export { loadStylesheet, resolveStyle } from "../../../geml-parser/dist/style-resolve.js";
```

- [ ] **Step 4: 跑，确认通过；顺手确认 bundle 能打、且不含远程脚本串**

```bash
node test/layout.test.mjs && node build.mjs 2>&1 | tail -2 && grep -c "cdn.jsdelivr" dist/viewer.bundle.js; echo "(必须是 0)"
```

- [ ] **Step 5: Commit**

```bash
git add src/parse-entry.js test/layout.test.mjs
git commit -m "feat(viewer): the bundle carries the stylesheet loader and resolver"
```

---

## Task 2: `style-entry.js` —— 找入口、预取、求解

**Files:**
- Create: `integrations/geml-viewer/src/style-entry.js`
- Test: `integrations/geml-viewer/test/layout.test.mjs`

**Interfaces:**
- Produces:
  ```js
  export const STYLE_PREFETCH_DEPTH = 8, STYLE_PREFETCH_FILES = 32;
  export function entryUrlFor(docUrl)                       // → "…/_index/index.geml"
  export function isStyleEntry(doc)                          // meta.profile 含 geml-style/v1
  export async function loadPageStyle({ docUrl, fetchText, parse, loadStylesheet, resolveStyle, model })
  //  → null（没有入口 / 入口不认 / 预取超限）
  //  → { vm, forDoc, errors }   errors = vm.diagnostics 里 severity==="error" 的那些
  ```
  Task 5 的 content.js 消费它。

- [ ] **Step 1: 写失败的测试**

```js
import { entryUrlFor, isStyleEntry, loadPageStyle, STYLE_PREFETCH_FILES } from "../src/style-entry.js";

const SITE = "https://host.test/site/";
const ENTRY = `=== meta
profile = "geml-style/v1"
default-style = "base.geml"
===

=== table {#sitemap}
| document | template |
|---|---|
| page.geml | page.style.geml |
===
`;
const BASE = `=== meta
profile = "geml-style/v1"
===
=== style-rule {#all match="text" font-size=16px}
===
`;
const PAGE_STYLE = `=== meta
profile = "geml-style/v1"
===
=== embed {#shared src="shared.geml"}
===
=== style-screen {#page axis=column slots="text#hdr, #body"}
===
=== style-frame {#body axis=row slots="table#tree, text#main"}
===
`;
const SHARED = `=== meta
profile = "geml-style/v1"
===
=== style-rule {#tree match="table#tree" component=tree width=321px}
===
`;
const DOC = `=== text {#hdr}
header
===
=== table {#tree format=csv}
name
a
===
=== text {#main}
body
===
`;
const FILES = new Map([
  [SITE + "_index/index.geml", ENTRY],
  [SITE + "_index/base.geml", BASE],
  [SITE + "_index/page.style.geml", PAGE_STYLE],
  [SITE + "_index/shared.geml", SHARED],
]);
const fetchFrom = (files) => async (url) => files.get(url) ?? null;
const deps = { parse, loadStylesheet, resolveStyle };

test("entryUrlFor：与文档同目录的 _index/index.geml", () => {
  assert.equal(entryUrlFor(SITE + "page.geml"), SITE + "_index/index.geml");
  assert.equal(entryUrlFor("file:///C:/docs/a.geml"), "file:///C:/docs/_index/index.geml");
});

test("isStyleEntry：靠 meta.profile 认，不靠路径", () => {
  assert.equal(isStyleEntry(parse(ENTRY)), true);
  assert.equal(isStyleEntry(parse('=== meta\ntitle = "not a style"\n===\n')), false);
  assert.equal(isStyleEntry(parse("# no meta at all\n")), false);
});

await atest("loadPageStyle：入口 → default-style + sitemap 命中 + 传递的 embed，全部预取后求解", async () => {
  const page = await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(FILES), model: parse(DOC), ...deps });
  assert.ok(page, "有入口");
  assert.equal(page.forDoc, "page.geml");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.vm.screens.map((s) => s.id), ["page"]);
  assert.deepEqual(page.vm.frames.map((f) => f.id), ["body"]);
  const tree = page.vm.bindings.find((b) => b.block === "#tree");
  assert.equal(tree.params.component, "tree", "embed 进来的规则生效了");
  assert.equal(tree.box.width, "321px");
  assert.equal(page.vm.bindings.find((b) => b.block === "#hdr").box["font-size"], "16px", "默认层生效了");
});

await atest("loadPageStyle：没有入口 → null；入口不认 → null；读不到的样式表 → 有 error 的视图模型", async () => {
  assert.equal(await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(new Map()), model: parse(DOC), ...deps }), null);
  const notEntry = new Map([[SITE + "_index/index.geml", '=== meta\ntitle = "x"\n===\n']]);
  assert.equal(await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(notEntry), model: parse(DOC), ...deps }), null);
  const missingBase = new Map([[SITE + "_index/index.geml", ENTRY], [SITE + "_index/page.style.geml", PAGE_STYLE], [SITE + "_index/shared.geml", SHARED]]);
  const page = await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(missingBase), model: parse(DOC), ...deps });
  assert.ok(page.vm.diagnostics.some((d) => d.code === "style-embed-not-expanded" && /base\.geml/.test(d.message)), JSON.stringify(page.vm.diagnostics));
});

await atest("loadPageStyle：预取有上限 —— 超过文件数就当没有入口，不无限拉", async () => {
  const files = new Map([[SITE + "_index/index.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "s0.geml"\n===\n']]);
  for (let i = 0; i <= STYLE_PREFETCH_FILES + 2; i++) {
    files.set(SITE + `_index/s${i}.geml`, `=== meta\nprofile = "geml-style/v1"\n===\n=== embed {#e src="s${i + 1}.geml"}\n===\n`);
  }
  let fetches = 0;
  const counting = async (url) => { fetches++; return files.get(url) ?? null; };
  const page = await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: counting, model: parse(DOC), ...deps });
  assert.equal(page, null);
  assert.ok(fetches <= STYLE_PREFETCH_FILES + 1, `fetched ${fetches}`);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
node test/layout.test.mjs
```

- [ ] **Step 3: 实现 `src/style-entry.js`**

```js
// 样式入口（profile §1.1）：与文档同目录的 `_index/index.geml`。viewer 的 fetch 是异步的，而
// 解析器的 loadStylesheet 要一个**同步**的 loadDoc —— 所以先把入口引用的每份文件（`default-style`、
// `#sitemap` 对本文档的命中、每条 `embed {src=}`，传递地）预取进一张 Map，再同步喂。
//
// 预取受同一套闸约束：调用方给的 fetchText 已经做了同源/同目录/无凭据/拒 HTML（content.js 里
// 和 src= 表、embed、code-graph 三条路径共用），这里再加深度与文件数上限 —— 样式表和文档一样
// 是不可信输入，一份互相 embed 的样式表不能让 viewer 拉个没完。

export const STYLE_PREFETCH_DEPTH = 8;   // 与解析器的 EMBED_DEPTH_CAP 同值
export const STYLE_PREFETCH_FILES = 32;  // 一页的样式表不该有这么多份

/** 与文档同目录的 `_index/index.geml`。 */
export function entryUrlFor(docUrl) {
  return new URL("_index/index.geml", docUrl).href;
}

/** 用 meta.profile 认入口，不用路径认（§1.1）。 */
export function isStyleEntry(doc) {
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  const profile = meta && meta.data ? String(meta.data.profile ?? "") : "";
  return profile.split(/\s+/).includes("geml-style/v1");
}

/** 一份样式表里点名的其它文件：meta 的 default-style、#sitemap 对 forDoc 的命中、每条 embed 的 src 文档部分。 */
function referencedDocs(doc, forDoc) {
  const out = [];
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  const dflt = meta && meta.data && typeof meta.data["default-style"] === "string" ? meta.data["default-style"] : "";
  if (dflt) out.push(dflt);
  const sitemap = doc.children.find((b) => b.kind === "block" && b.id === "sitemap");
  const rows = sitemap && sitemap.table ? sitemap.table.rows : [];
  for (const r of rows) {
    if ((r[0]?.text ?? "").trim() !== forDoc) continue;
    const hit = (r[1]?.text ?? "").trim();
    if (hit) out.push(hit);
    break;
  }
  const walk = (nodes) => {
    for (const b of nodes) {
      if (b.kind === "block" && b.type === "embed") {
        const src = typeof b.attrs?.src === "string" ? b.attrs.src.trim() : "";
        const docPath = src.includes("#") ? src.slice(0, src.indexOf("#")) : src;
        if (docPath) out.push(docPath);
      }
      if (b.children) walk(b.children);
    }
  };
  walk(doc.children);
  return out;
}

/**
 * 找到并求解本页的样式。返回 null = 没有样式入口（或入口不认、或预取超限）；
 * 否则 { vm, forDoc, errors }。errors 非空时 content.js 退回默认渲染并把它们画成横幅。
 */
export async function loadPageStyle({ docUrl, fetchText, parse, loadStylesheet, resolveStyle, model }) {
  const entryUrl = entryUrlFor(docUrl);
  const entryText = await fetchText(entryUrl);
  if (entryText == null) return null;
  let entryDoc;
  try { entryDoc = parse(entryText); } catch { return null; }
  if (!isStyleEntry(entryDoc)) return null;

  const forDoc = decodeURIComponent(new URL(docUrl).pathname.split("/").pop() || "");
  // 相对路径 → 文本。键是**相对 _index/ 的原样路径**，loadStylesheet 就是拿它来查的。
  const cache = new Map();
  const queue = referencedDocs(entryDoc, forDoc).map((rel) => ({ rel, depth: 1 }));
  let files = 0;
  while (queue.length > 0) {
    const { rel, depth } = queue.shift();
    if (cache.has(rel) || depth > STYLE_PREFETCH_DEPTH) continue;
    if (++files > STYLE_PREFETCH_FILES) {
      console.warn(`[geml-viewer] style entry references more than ${STYLE_PREFETCH_FILES} files; ignoring it`);
      return null;
    }
    const text = await fetchText(new URL(rel, entryUrl).href);
    if (text == null) { cache.set(rel, null); continue; } // 记下"读不到"，loadStylesheet 会报 style-embed-not-expanded
    cache.set(rel, text);
    let sub;
    try { sub = parse(text); } catch { continue; }
    // 被 embed 的可能也是一份清单 —— 只跟它的 default-style（解析器的规则），sitemap 不跟
    for (const next of referencedDocs(sub, "")) queue.push({ rel: next, depth: depth + 1 });
  }

  const sheet = loadStylesheet(entryDoc, {
    loadDoc: (rel) => cache.get(rel) ?? null,
    parseDoc: (s) => parse(s),
    forDoc,
  });
  const vm = resolveStyle(sheet, [{ path: forDoc, doc: model }]);
  return { vm, forDoc, errors: vm.diagnostics.filter((d) => d.severity === "error") };
}
```

**注意**：`referencedDocs(sub, "")` 里 `forDoc=""` 让子清单的 `#sitemap` 永远不命中 —— 解析器 `expandEmbeds` 对被 embed 的清单也是"只跟 default-style、不跟 sitemap"（`style-resolve.ts` 里那段注释），两边一致。相对路径解析：子样式表里的 `embed src` 按解析器的语义也是相对**入口所在目录**解析（CLI 的 `resolverFor(sheetPath)` 固定在样式表目录上），所以统一用 `new URL(rel, entryUrl)`。

- [ ] **Step 4: 跑，确认通过**

```bash
node test/layout.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/style-entry.js test/layout.test.mjs
git commit -m "feat(viewer): find the style entry beside the document, prefetch what it names, resolve"
```

---

## Task 3: `layout.js` —— 视图模型 → DOM + CSS

**Files:**
- Create: `integrations/geml-viewer/src/layout.js`
- Test: `integrations/geml-viewer/test/layout.test.mjs`

**Interfaces:**
- Produces:
  ```js
  export function classFor(addr)                 // "#file-tree" → "geml-b-file-tree"
  export function cssForPage(vm)                 // box + variants + hide-below → CSS 文本
  export function renderPage(vm, model, dom, { renderBlock, labels, components, state })
  //  → { root, css, unplaced }   或   { error: "…" }（0 或 ≥2 个 screen）
  ```
  Task 4 传 `components` 与 `state`；Task 5 把 `root` 放进 body、`css` 进 `<style>`。

- [ ] **Step 1: 写失败的测试**

```js
import { renderBlock, collectLabels } from "../src/render.js";
import { classFor, cssForPage, renderPage } from "../src/layout.js";

const dom = () => parseHTML("<!doctype html><html><head></head><body></body></html>");
const SHEET = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#page axis=column slots="text#hdr, #body"}
===
=== style-frame {#body axis=row slots="table#tree, #card"}
===
=== style-frame {#card axis=column slots="text#toolbar, text#main"}
===
=== style-state {#tree type=scalar match="table#tree" on=toggle init-value=open}
===
=== style-rule {#t match="table#tree" component=tree width=321px sticky=0 scroll=own hide-below=1012}
===
=== style-rule {#tc match="table#tree" when="$tree=closed" width=0}
===
=== style-rule {#m match="text#main" padding=32px max-width=1012px font-size=16px line-height=24px color="#1f2328"}
===
`;
const DOC3 = `=== text {#hdr}
header
===
=== table {#tree format=csv}
name
agents
docs
===
=== text {#toolbar}
Preview · Code · Blame
===
=== text {#main}
body text
===
=== text {#orphan}
not placed by any slot
===
`;
const vmOf = (sheetText, docText) => {
  const model = parse(docText);
  const vm = resolveStyle(loadStylesheet(parse(sheetText)), [{ path: "page.geml", doc: model }]);
  return { vm, model };
};
const page = (sheetText, docText) => {
  const { vm, model } = vmOf(sheetText, docText);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: collectLabels(model.children), components: {}, state: null });
  return { ...out, document, vm, model };
};

test("classFor：块地址变成合法的 class 名", () => {
  assert.equal(classFor("#file-tree"), "geml-b-file-tree");
  assert.equal(classFor("#a.b c"), "geml-b-a_b_c");
});

test("renderPage：screen → frame → frame 三层，axis 落在 data-axis 上，块按槽位顺序进格子", () => {
  const { root } = page(SHEET, DOC3);
  const screen = root.querySelector('section.geml-frame[data-id="page"]');
  assert.ok(screen); assert.equal(screen.getAttribute("data-axis"), "column");
  const body = screen.querySelector(':scope > section.geml-frame[data-id="body"]');
  assert.ok(body); assert.equal(body.getAttribute("data-axis"), "row");
  const card = body.querySelector(':scope > section.geml-frame[data-id="card"]');
  assert.ok(card);
  const order = [...screen.querySelectorAll(".geml-placed")].map((e) => e.getAttribute("data-block"));
  assert.deepEqual(order, ["#hdr", "#tree", "#toolbar", "#main"]);
});

test("renderPage：没被放置的块不出现，数量报回来", () => {
  const { root, unplaced } = page(SHEET, DOC3);
  assert.equal(root.querySelector('[data-block="#orphan"]'), null);
  assert.equal(unplaced, 1);
});

test("cssForPage：box 变 CSS；sticky/scroll/hide-below 各有翻译；variant 挂在 body 的状态 class 上", () => {
  const { vm } = vmOf(SHEET, DOC3);
  const css = cssForPage(vm);
  assert.match(css, /\.geml-b-tree\s*\{[^}]*width:\s*321px/);
  assert.match(css, /\.geml-b-tree\s*\{[^}]*position:\s*sticky;\s*top:\s*0px/);
  assert.match(css, /\.geml-b-tree\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /@media \(max-width:\s*1011px\)\s*\{\s*\.geml-b-tree\s*\{\s*display:\s*none/);
  assert.match(css, /\.geml-b-main\s*\{[^}]*max-width:\s*1012px;[^}]*font-size:\s*16px;[^}]*line-height:\s*24px;[^}]*color:\s*#1f2328/);
  assert.match(css, /body\.geml-s-tree-closed \.geml-b-tree\s*\{[^}]*width:\s*0/);
  assert.equal(/url\(/.test(css), false, "CSP：注入的 CSS 不加载任何资源");
});

test("renderPage：0 个 screen 和 2 个 screen 都返回 error，不返回半张页", () => {
  const none = vmOf('=== meta\nprofile = "geml-style/v1"\n===\n=== style-rule {#r match="text" color=red}\n===\n', DOC3);
  assert.match(renderPage(none.vm, none.model, dom().document, { renderBlock, labels: [], components: {}, state: null }).error, /no style-screen/);
  const two = vmOf('=== meta\nprofile = "geml-style/v1"\n===\n=== style-screen {#a slots="text#hdr"}\n===\n=== style-screen {#b slots="text#main"}\n===\n', DOC3);
  assert.match(renderPage(two.vm, two.model, dom().document, { renderBlock, labels: [], components: {}, state: null }).error, /2 style-screen/);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
node test/layout.test.mjs
```

- [ ] **Step 3: 实现 `src/layout.js`**

```js
// 视图模型（计划 E，profile §10）→ 一整页的 DOM 和它的 CSS。
//
// 形状：screens[0] 是页；frame 是页内区域，槽位里裸 #id 引用它；块槽位按 bindings 画。
// 内含词（box）变成每块一条 CSS 规则，挂在 `.geml-b-<id>` 上；`when=` 的 variant 变成
// `body.geml-s-<state>-<value> .geml-b-<id> { … }` —— 状态是 body 上的 class，状态一变只换
// class，不重绘。两个条件的 variant 选择器天然比一个条件的特异性高，正是 §12.5 要的顺序。
// 注入页面的 CSS 不能加载任何资源（raw.githubusercontent 的 default-src 'none'）：这里生成的
// 只有长度、颜色、位置，没有 url()。

const BOX_PASS = new Set(["width", "max-width", "padding", "font-size", "line-height", "color", "background", "border"]);

export function classFor(addr) {
  return "geml-b-" + String(addr).replace(/^#/, "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function stateClass(state, value) {
  return `geml-s-${state}-${String(value).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** 一个 box 对象 → CSS 声明串。sticky/scroll/hide-below 不是 CSS 属性名，各有翻译；hide-below 走 @media，由 cssForPage 单独处理。 */
function declarations(box) {
  const out = [];
  for (const [k, v] of Object.entries(box)) {
    if (BOX_PASS.has(k)) out.push(`${k}: ${typeof v === "number" ? `${v}px` : String(v)}`);
    else if (k === "sticky") out.push(`position: sticky; top: ${Number(v)}px`);
    else if (k === "scroll" && v === "own") out.push("overflow: auto; max-height: 100vh");
  }
  return out.join("; ");
}

/** 整页的 CSS：每个 binding 的 box，再是它的 variants，hide-below 用 media query。 */
export function cssForPage(vm) {
  const rules = [];
  const screen = vm.screens[0];
  const bindings = screen ? screen.bindings : vm.bindings;
  for (const b of bindings) {
    const cls = classFor(b.block);
    const base = declarations(b.box);
    if (base) rules.push(`.${cls} { ${base} }`);
    if (typeof b.box["hide-below"] === "number") {
      rules.push(`@media (max-width: ${b.box["hide-below"] - 1}px) { .${cls} { display: none } }`);
    }
    // variants 已按条件数升序（§12.5）；这里的输出顺序保留它，特异性也随条件数递增。
    for (const v of b.variants ?? []) {
      const sel = Object.entries(v.when).map(([s, val]) => `body.${stateClass(s, val)}`).join("");
      const decl = declarations(v.box);
      if (decl) rules.push(`${sel} .${cls} { ${decl} }`);
      if (typeof v.box["hide-below"] === "number") {
        rules.push(`@media (max-width: ${v.box["hide-below"] - 1}px) { ${sel} .${cls} { display: none } }`);
      }
    }
  }
  return rules.join("\n");
}

function collectBlocks(nodes, out) {
  for (const b of nodes) {
    if (b.id !== undefined) out.set(`#${b.id}`, b);
    if (b.children) collectBlocks(b.children, out);
  }
  return out;
}

/**
 * 画一页。返回 { root, css, unplaced } 或 { error }。
 * opts.components：名字 → (block, params, ctx) => Element，缺省用 renderBlock。
 * opts.state：Task 4 的状态存储（有 get/set/subscribe）；null 表示不接交互。
 */
export function renderPage(vm, model, dom, opts) {
  const { renderBlock, labels, components = {}, state = null } = opts;
  if (vm.screens.length !== 1) {
    return { error: vm.screens.length === 0 ? "no style-screen in the stylesheet" : `${vm.screens.length} style-screen blocks; a page has one` };
  }
  const screen = vm.screens[0];
  const byAddr = collectBlocks(model.children, new Map());
  const binding = new Map(screen.bindings.map((b) => [b.block, b]));
  const frames = new Map(vm.frames.map((f) => [f.id, f]));
  const placed = new Set();
  const ctx = { dom, renderBlock, labels, state, model };

  const place = (addr) => {
    const block = byAddr.get(addr);
    if (!block) return null;
    placed.add(addr);
    const b = binding.get(addr);
    const params = b ? b.params : {};
    const name = typeof params.component === "string" ? params.component : "";
    const render = components[name] ?? ((blk) => renderBlock(blk, dom, labels));
    const inner = render(block, params, ctx);
    const wrap = dom.createElement("div");
    wrap.className = `geml-placed ${classFor(addr)}`;
    wrap.setAttribute("data-block", addr);
    if (name) wrap.setAttribute("data-component", name);
    if (inner) wrap.appendChild(inner);
    return wrap;
  };

  const container = (c, depth) => {
    const sec = dom.createElement("section");
    sec.className = "geml-frame";
    sec.setAttribute("data-id", c.id);
    sec.setAttribute("data-axis", c.axis);
    if (c.component) sec.setAttribute("data-component", c.component);
    for (const slot of c.slots) {
      if (slot.kind === "frame") {
        const f = frames.get(slot.frame);
        if (f) sec.appendChild(container(f, depth + 1));
      } else if (slot.kind === "state") {
        const holder = dom.createElement("div");
        holder.className = "geml-slot-state";
        holder.setAttribute("data-state", slot.state);
        sec.appendChild(holder);
      } else {
        for (const { block } of slot.blocks) {
          const el = place(block);
          if (el) sec.appendChild(el);
        }
      }
    }
    return sec;
  };

  const root = dom.createElement("div");
  root.className = "geml-page";
  root.appendChild(container(screen, 0));
  const unplaced = [...byAddr.keys()].filter((a) => !placed.has(a) && byAddr.get(a).kind === "block" && byAddr.get(a).type !== "meta").length;
  return { root, css: cssForPage(vm), unplaced };
}
```

- [ ] **Step 4: 跑，确认通过**

```bash
node test/layout.test.mjs
```

`:scope >` 选择器：linkedom 支持；若报不支持，改成 `[...screen.children].find(e => e.getAttribute("data-id") === "body")`。

- [ ] **Step 5: Commit**

```bash
git add src/layout.js test/layout.test.mjs
git commit -m "feat(viewer): a view model renders as a page — frames to sections, box to CSS, variants to body-state rules"
```

---

## Task 4: `components.js` —— 三个组件与两种交互

**Files:**
- Create: `integrations/geml-viewer/src/components.js`
- Test: `integrations/geml-viewer/test/layout.test.mjs`

**Interfaces:**
- Produces:
  ```js
  export function createState(vm, dom)      // { get(id), set(id, v), toggleTarget(id) } —— set 换 body class
  export const COMPONENTS = { tree, "tab-bar": tabBar, "markdown-body": markdownBody }
  ```
  组件签名 `(block, params, ctx) => Element`，ctx = `{ dom, renderBlock, labels, state, model }`。

- [ ] **Step 1: 写失败的测试**

```js
import { createState, COMPONENTS } from "../src/components.js";

const SHEET4 = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#page axis=row slots="table#tree, text#toolbar, text#main"}
===
=== style-state {#tree type=scalar match="table#tree" on=toggle init-value=open}
===
=== style-state {#tab type=scalar match="text#toolbar" on=select init-value=Preview}
===
=== style-rule {#t match="table#tree" component=tree width=321px}
===
=== style-rule {#tc match="table#tree" when="$tree=closed" width=0}
===
=== style-rule {#tb match="text#toolbar" component=tab-bar}
===
=== style-rule {#m match="text#main" component=markdown-body}
===
`;
const pageWith = (sheetText, docText) => {
  const { vm, model } = vmOf(sheetText, docText);
  const { document, window } = dom();
  const state = createState(vm, document);
  const out = renderPage(vm, model, document, { renderBlock, labels: collectLabels(model.children), components: COMPONENTS, state });
  document.body.appendChild(out.root);
  return { ...out, document, window, state, vm };
};

test("state：init-value 上 body；set 换 class；toggle 的另一个值来自 when= 点名的那个", () => {
  const { document, state } = pageWith(SHEET4, DOC3);
  assert.equal(state.get("tree"), "open");
  assert.equal(state.get("tab"), "Preview");
  assert.ok(document.body.classList.contains("geml-s-tree-open"));
  assert.equal(state.toggleTarget("tree"), "closed");
  state.set("tree", "closed");
  assert.ok(document.body.classList.contains("geml-s-tree-closed"));
  assert.equal(document.body.classList.contains("geml-s-tree-open"), false);
});

test("state：toggle 找不到恰好一个别的值就惰性（返回 null）", () => {
  const sheet = SHEET4.replace('=== style-rule {#tc match="table#tree" when="$tree=closed" width=0}\n===\n', "");
  const { state } = pageWith(sheet, DOC3);
  assert.equal(state.toggleTarget("tree"), null);
});

test("tree：表变成列表，点头部翻状态", () => {
  const { document, window, state } = pageWith(SHEET4, DOC3);
  const tree = document.querySelector('[data-block="#tree"] .geml-tree');
  assert.ok(tree);
  assert.deepEqual([...tree.querySelectorAll("li")].map((li) => li.textContent.trim()), ["agents", "docs"]);
  const btn = document.querySelector('[data-block="#tree"] .geml-tree-toggle');
  assert.ok(btn, "有 toggle 状态绑到这张表，就有开关");
  btn.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(state.get("tree"), "closed");
  btn.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(state.get("tree"), "open");
});

test("tab-bar：· 分隔的文本变成按钮，点哪个状态就是哪个，aria-pressed 跟着走", () => {
  const { document, window, state } = pageWith(SHEET4, DOC3);
  const tabs = [...document.querySelectorAll('[data-block="#toolbar"] .geml-tabs button')];
  assert.deepEqual(tabs.map((b) => b.textContent), ["Preview", "Code", "Blame"]);
  assert.equal(tabs[0].getAttribute("aria-pressed"), "true");
  tabs[1].dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(state.get("tab"), "Code");
  assert.equal(tabs[1].getAttribute("aria-pressed"), "true");
  assert.equal(tabs[0].getAttribute("aria-pressed"), "false");
  assert.ok(document.body.classList.contains("geml-s-tab-Code"));
});

test("markdown-body：默认渲染包在 article.markdown-body 里", () => {
  const { document } = pageWith(SHEET4, DOC3);
  const art = document.querySelector('[data-block="#main"] article.markdown-body');
  assert.ok(art);
  assert.match(art.textContent, /body text/);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
node test/layout.test.mjs
```

- [ ] **Step 3: 实现 `src/components.js`**

```js
// 宿主注册表（profile §2.1：component 是名字，实现在宿主）和状态接线（§5：interaction → state → view）。
// 状态住在 <body> 的 class 上（layout.js 的 variant 规则就挂在那儿），所以 set() 就是换 class。
// 三个组件是第一个页面用例要的三个；名字不在表里的块走 renderBlock，unknown-component 在
// 检查期就已是 warning。

import { classFor } from "./layout.js";

const stateClass = (state, value) => `geml-s-${state}-${String(value).replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * 状态存储。toggle 翻到哪个值 profile 没说：取 init-value 和所有 variant 的 when= 里
 * 为该状态点名的**那一个**别的值（§12.7）；点名了零个或多个就惰性 —— 返回 null，组件不装开关。
 */
export function createState(vm, dom) {
  const values = new Map();
  const named = new Map(); // state → Set(values named by when=)
  for (const s of vm.states) values.set(s.id, s.initValue ?? "");
  const bindings = vm.screens[0] ? vm.screens[0].bindings : vm.bindings;
  for (const b of bindings) for (const v of b.variants ?? []) {
    for (const [s, val] of Object.entries(v.when)) {
      if (!named.has(s)) named.set(s, new Set());
      named.get(s).add(val);
    }
  }
  const body = dom.body;
  const apply = (id, prev, next) => {
    if (!body) return;
    if (prev !== undefined && prev !== "") body.classList.remove(stateClass(id, prev));
    if (next !== "") body.classList.add(stateClass(id, next));
  };
  for (const [id, v] of values) apply(id, undefined, v);
  const listeners = new Set();
  return {
    get: (id) => values.get(id),
    set(id, v) {
      const prev = values.get(id);
      values.set(id, v);
      apply(id, prev, v);
      for (const fn of listeners) fn(id, v);
    },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    toggleTarget(id) {
      const init = vm.states.find((s) => s.id === id)?.initValue ?? "";
      const others = [...(named.get(id) ?? [])].filter((v) => v !== init);
      if (others.length !== 1) return null;
      return values.get(id) === init ? others[0] : init;
    },
  };
}

/** 哪个状态由这个块的哪种交互喂（state 的 match 命中它）。 */
function producing(ctx, block, on) {
  if (!ctx.state) return null;
  const addr = `#${block.id}`;
  // 求解期没把 state→producer 的绑定放进视图模型；这里按 vm.states 的 match 在 model 里再对一次
  // 最简形式：id 相等（`type#id` / `#id`）。够第一个页面用；更宽的选择器留给消费者 spike 回灌。
  for (const s of ctx.vmStates ?? []) {
    if (s.on !== on) continue;
    if (s.matchIds && s.matchIds.has(addr)) return s.id;
  }
  return null;
}

/** table → <ul class="geml-tree">，第一列是条目；若有 toggle 状态喂自它，加一个开关。 */
export function tree(block, params, ctx) {
  const { dom } = ctx;
  const wrap = dom.createElement("div");
  wrap.className = "geml-tree-wrap";
  const stateId = producing(ctx, block, "toggle");
  if (stateId && ctx.state.toggleTarget(stateId) !== null) {
    const btn = dom.createElement("button");
    btn.type = "button";
    btn.className = "geml-tree-toggle";
    btn.textContent = "☰";
    btn.setAttribute("aria-label", "toggle");
    btn.addEventListener("click", () => {
      const next = ctx.state.toggleTarget(stateId);
      if (next !== null) ctx.state.set(stateId, next);
    });
    wrap.appendChild(btn);
  }
  const ul = dom.createElement("ul");
  ul.className = "geml-tree";
  for (const row of block.table?.rows ?? []) {
    const li = dom.createElement("li");
    li.textContent = row[0]?.text ?? "";
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

/** text 块按 · 切成按钮；点哪个，select 状态就是哪个的 label。 */
export function tabBar(block, params, ctx) {
  const { dom } = ctx;
  const text = (block.raw ?? []).join(" ").trim() || (block.children ?? []).map((c) => (c.inlines ?? []).map((i) => i.value ?? "").join("")).join(" ");
  const labels = text.split("·").map((s) => s.trim()).filter(Boolean);
  const nav = dom.createElement("nav");
  nav.className = "geml-tabs";
  const stateId = producing(ctx, block, "select");
  const buttons = labels.map((label) => {
    const b = dom.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-pressed", stateId && ctx.state.get(stateId) === label ? "true" : "false");
    if (stateId) b.addEventListener("click", () => ctx.state.set(stateId, label));
    nav.appendChild(b);
    return b;
  });
  if (stateId) ctx.state.subscribe((id, v) => { if (id === stateId) for (const b of buttons) b.setAttribute("aria-pressed", b.textContent === v ? "true" : "false"); });
  return nav;
}

/** 默认渲染，包在 article.markdown-body 里 —— GitHub 正文那一栏的容器。 */
export function markdownBody(block, params, ctx) {
  const art = ctx.dom.createElement("article");
  art.className = "markdown-body";
  const inner = ctx.renderBlock(block, ctx.dom, ctx.labels);
  if (inner) art.appendChild(inner);
  return art;
}

export const COMPONENTS = { tree, "tab-bar": tabBar, "markdown-body": markdownBody };
```

**`producing()` 需要 `ctx.vmStates`**：视图模型的 `states` 只有 `{id, type, on, valueFrom, initValue}`，没带"喂它的是哪些块"。在 `layout.js` 的 `renderPage` 里补上 —— 把 `vm.states` 映射成 `{...s, matchIds}`：`matchIds` 是 `sheet` 里该 state 的 `match` 选择器命中的块地址集合。**但 renderPage 拿不到 sheet。** 最小改法：让 `style-entry.js` 的 `loadPageStyle` 在返回值里多给一份 `producers: Map<stateId, Set<addr>>`，用 `sheet.states[i].match` 对 `model` 求一次 —— 解析器没导出 `matches/candidates`，所以这里用最简对法：选择器形如 `type#id` 或 `#id` 时取 `#id`；其它形式不接（console.warn）。把这段加进 `loadPageStyle`：

```js
  // 状态的产生者：视图模型不带，宿主接交互时要知道点谁。只认 `type#id` / `#id` 形式的 match。
  const producers = new Map();
  for (const s of sheet.states) {
    const ids = new Set();
    for (const br of s.match) {
      const last = br.steps[br.steps.length - 1];
      if (last && last.id) ids.add(`#${last.id}`);
      else console.warn(`[geml-viewer] state #${s.id}: only \`type#id\` producers are wired; \`${JSON.stringify(br)}\` is not`);
    }
    producers.set(s.id, ids);
  }
  return { vm, forDoc, producers, errors: … };
```

并在 `renderPage` 的 `ctx` 上加 `vmStates: vm.states.map((s) => ({ ...s, matchIds: opts.producers?.get(s.id) ?? new Set() }))`，`renderPage` 的 opts 多收 `producers`。测试里 `pageWith` 用 `loadStylesheet(parse(sheet))` 得到 `sheet` 后自己算同样的 map 传进去（把这段抽成 `export function producersOf(sheet)` 放在 `style-entry.js`，两边共用）。

`Selector.steps[i].id` 的形状见 `geml-parser/src/style-selector.ts` 的 `SimpleSelector` 接口；若字段名不是 `id`，以那里为准。

- [ ] **Step 4: 跑，确认通过**

```bash
node test/layout.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/components.js src/layout.js src/style-entry.js test/layout.test.mjs
git commit -m "feat(viewer): tree, tab-bar and markdown-body components; toggle and select drive body state classes"
```

---

## Task 5: `content.js` 分叉 + `geml.css` + 端到端

**Files:**
- Modify: `integrations/geml-viewer/src/content.js`
- Modify: `integrations/geml-viewer/src/geml.css`
- Test: `integrations/geml-viewer/test/layout.test.mjs`（用真 fixture 的端到端）

- [ ] **Step 1: 写失败的测试 —— 真 fixture 走完整链**

```js
import { readFileSync } from "node:fs";
import { COMPONENTS as REG } from "../src/components.js";
import { producersOf } from "../src/style-entry.js";

const FIX = new URL("../../../geml-parser/test/fixtures/style-page/", import.meta.url);
const PAGE_GEML = readFileSync(new URL("page.geml", FIX), "utf8");
const GH_STYLE = readFileSync(new URL("github.style.geml", FIX), "utf8");

await atest("端到端：GitHub blob 页的 fixture 经入口 → 视图模型 → 一整页 DOM + CSS", async () => {
  const files = new Map([
    [SITE + "_index/index.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "github.style.geml"\n===\n'],
    [SITE + "_index/github.style.geml", GH_STYLE],
  ]);
  const model = parse(PAGE_GEML);
  const page = await loadPageStyle({ docUrl: SITE + "page.geml", fetchText: fetchFrom(files), model, ...deps });
  assert.deepEqual(page.errors, []);
  const { document } = dom();
  const state = createState(page.vm, document);
  const out = renderPage(page.vm, model, document, { renderBlock, labels: collectLabels(model.children), components: REG, state, producers: page.producers });
  assert.ok(out.root, out.error);
  assert.equal(out.unplaced, 0, "那一页的每个块都被放置了");
  const ids = [...out.root.querySelectorAll("section.geml-frame")].map((s) => s.getAttribute("data-id"));
  assert.deepEqual(ids, ["page", "body", "main", "card"]);
  assert.ok(out.root.querySelector('[data-block="#file-tree"] .geml-tree'));
  assert.ok(out.root.querySelector('[data-block="#toolbar"] .geml-tabs'));
  assert.ok(out.root.querySelector('[data-block="#content"] article.markdown-body'));
  assert.match(out.css, /\.geml-b-file-tree \{[^}]*width: 321px/);
  assert.match(out.css, /body\.geml-s-tree-closed \.geml-b-file-tree \{[^}]*width: 0px/);
  assert.match(out.css, /@media \(max-width: 1011px\)/);
});
```

- [ ] **Step 2: 跑，确认失败（`producersOf` 还没导出 / renderPage 不收 producers 就会失败）**

- [ ] **Step 3: `geml.css` 追加静态规则（末尾）**

```css
/* ---- 页面布局（计划 F）。只有长度、颜色、排布：注入页面的 CSS 不得加载任何资源。 */
.geml-page { margin: 0; }
.geml-frame { display: flex; min-width: 0; min-height: 0; }
.geml-frame[data-axis="column"] { flex-direction: column; }
.geml-frame[data-axis="row"] { flex-direction: row; align-items: stretch; }
.geml-frame[data-axis="row"] > .geml-frame { flex: 1 1 auto; }
.geml-frame[data-axis="row"] > .geml-placed { flex: 0 0 auto; }
.geml-placed { min-width: 0; box-sizing: border-box; }
.geml-tree-wrap { padding: 8px 0; }
.geml-tree-toggle { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.geml-tree { list-style: none; margin: 8px 0 0; padding: 0 12px; font-size: 14px; line-height: 28px; }
.geml-tabs { display: flex; gap: 4px; border-bottom: 1px solid #d0d7de; padding: 0 8px; }
.geml-tabs button { border: 0; background: none; padding: 8px 12px; cursor: pointer; font: inherit; border-bottom: 2px solid transparent; }
.geml-tabs button[aria-pressed="true"] { border-bottom-color: #fd8c73; font-weight: 600; }
.geml-page article.markdown-body { box-sizing: border-box; }
```

- [ ] **Step 4: `content.js` 分叉**

导入（顶部）：

```js
import { loadStylesheet, resolveStyle } from "./parse-entry.js";
import { loadPageStyle } from "./style-entry.js";
import { renderPage } from "./layout.js";
import { createState, COMPONENTS } from "./components.js";
import { collectLabels } from "./render.js";
```

在 `model.diagnostics = viewerDiagnostics(model.diagnostics);` 之后、`injectStyle();` 之前：

```js
  // 页面布局（计划 F）：文档旁边有样式入口就按它画整页。没有、或它不认、或它有错，
  // 都退回下面今天的路径 —— 有错时多一条横幅说清楚。fetch 走 readText，同一道同源闸。
  let page = null;
  try {
    page = await loadPageStyle({
      docUrl: location.href,
      fetchText: async (url) => (isSameOriginSrc(url) ? await readText(url) : null),
      parse, loadStylesheet, resolveStyle, model,
    });
  } catch (e) {
    console.error("[geml-viewer] style entry failed:", e);
  }
```

`paint()` 里，`document.body.className = "geml-body";` 之后、`replaceChildren(renderDocument(...))` 之前插入：

```js
    if (page) {
      const banner = (text) => {
        const d = document.createElement("div");
        d.className = "geml-diag geml-diag-error";
        d.textContent = text;
        return d;
      };
      if (page.errors.length > 0) {
        const root = renderDocument(model, document, focus);
        root.prepend(banner(`stylesheet has ${page.errors.length} error(s); rendering without it — ` + page.errors.map((d) => `${d.code}: ${d.message}`).join(" · ")));
        document.body.replaceChildren(root);
      } else {
        const state = createState(page.vm, document);
        const out = renderPage(page.vm, model, document, { renderBlock, labels: collectLabels(model.children), components: COMPONENTS, state, producers: page.producers });
        if (out.error) {
          const root = renderDocument(model, document, focus);
          root.prepend(banner(`stylesheet: ${out.error}; rendering without it`));
          document.body.replaceChildren(root);
        } else {
          if (out.unplaced > 0) console.info(`[geml-viewer] ${out.unplaced} block(s) are placed by no slot and are not shown`);
          pageCss.textContent = out.css;
          document.body.replaceChildren(out.root);
          await upgradeIn(document);
          return;
        }
      }
      await upgradeIn(document);
      return;
    }
```

`renderBlock` 要从 `./render.js` 导入（今天 content.js 只导入 `renderDocument, viewerDiagnostics`）。`pageCss`：在 `injectStyle()` 里多建一个空 `<style id="geml-page-css">` 并保存到模块级变量 `let pageCss;`，页的 CSS 每次 paint 重写它的 `textContent`。

**注意 `upgradeIn` 的声明位置**：它是 `paint` 内部的 `const`，声明在函数体后半；上面的插入点在它之前会撞 TDZ。把 `const upgradeIn = …` 整段上移到 `paint` 开头（它不依赖前面的语句），或者把页面分叉放到 `upgradeIn` 声明之后、`await upgradeIn(document)` 之前 —— 后者改动最小：让默认路径的 `replaceChildren(renderDocument…)` 与 embed 展开也包进 `if (!page) { … }`。实现时以文件当时的结构为准，目标只有一条：**有页就不画默认文档，也不跑 expandTransclusions**（页里的 embed 由 layout 的默认渲染画成链接，和今天单块渲染一致）。

- [ ] **Step 5: 跑测试 + 打包 + 闸门**

```bash
node test/layout.test.mjs && node build.mjs 2>&1 | tail -1 && grep -c "cdn.jsdelivr" dist/viewer.bundle.js
```

`grep -c` 必须打印 `0`。

- [ ] **Step 6: Commit**

```bash
git add src/content.js src/geml.css src/layout.js src/style-entry.js test/layout.test.mjs
git commit -m "feat(viewer): a document with a style entry beside it renders as the page it declares"
```

---

## Task 6: 注册套件、跑闸门

**Files:**
- Modify: `integrations/geml-viewer/test/all.mjs`

- [ ] **Step 1: 注册**

```js
const suites = ["render", "transclude", "inline-src", "chart", "upgrade", "security", "d2", "graphviz", "translate-browser", "translate-map", "snapshot", "layout"];
```

- [ ] **Step 2: viewer 闸门 —— 一次，取真实退出码**

```bash
cd integrations/geml-viewer && npm run coverage:check > /tmp/viewer-cov.log 2>&1; echo "VIEWER_EXIT=$?"; grep -E "all viewer suites passed|suite FAILED|^All files|ERROR" /tmp/viewer-cov.log
```

预期 `VIEWER_EXIT=0`。掉门槛最可能在 `components.js` 的 `producing()` 分支（warn 路径）—— 补一条 state 用宽选择器（`match="table"`）的测试，断言 console.warn 被调用且组件不装开关。

- [ ] **Step 3: 解析器那边没动 —— 但确认**

```bash
cd ../../geml-parser && git diff HEAD --stat -- src/ | cat
```

预期为空（计划 F 不改解析器）。

- [ ] **Step 4: Commit**

```bash
git add test/all.mjs
git commit -m "test(viewer): register the layout suite"
```

---

## Task 7: 在真浏览器里看一眼（手工，不能自动化）

browser pane 是另一个 Chromium，没装扩展；扩展只能在用户的 Chrome 里验。步骤写死在这里，做完把截图贴回来：

- [ ] **Step 1**：`cd integrations/geml-viewer && node build.mjs`
- [ ] **Step 2**：Chrome → `chrome://extensions` → 开发者模式 → Load unpacked → 选 `integrations/geml-viewer/`（已装过就点刷新）
- [ ] **Step 3**：造一个目录：把 `geml-parser/test/fixtures/style-page/page.geml` 拷到 `C:\tmp\blob\page.geml`，`github.style.geml` 拷到 `C:\tmp\blob\_index\github.style.geml`，再写 `C:\tmp\blob\_index\index.geml`：
  ```
  === meta
  profile = "geml-style/v1"
  default-style = "github.style.geml"
  ===
  ```
- [ ] **Step 4**：Chrome 打开 `file:///C:/tmp/blob/page.geml`。预期：顶栏 → tab 条 → 左 321px 文件树（☰ 开关）+ 右侧面包屑 / commit 条 / 卡片（Preview·Code·Blame 三个 tab，正文）。点 ☰ 文件树宽度变 0；点 Code 高亮切换；窗口拖窄到 <1012 文件树消失。
- [ ] **Step 5**：把 `_index/` 整个删掉再刷新 → 今天的单栏渲染，一字不差。

`file://` 下同目录读取走 bg.js 的 `geml-read-file`（content.js 的 `readText` 已经处理）。

---

## 自查

**规格覆盖（§12.7 → Task）**：找样式表 → Task 2；消费视图模型（DOM / axis / box→CSS / 默认渲染）→ Task 3；注册表 + 状态接线 → Task 4；退路（0 个 screen、有错、≥2）→ Task 5。§12.7 里"先核 viewer 能不能取同目录文件"：能 —— `readText` 在 http(s) 直接 fetch、`file://` 经 bg.js，同源闸已在。

**类型一致性**：`renderPage` 的返回 `{ root, css, unplaced } | { error }` 在 Task 3 定义、Task 5 消费；`createState` 的 `get/set/subscribe/toggleTarget` 在 Task 4 定义、组件与 Task 5 消费；`producersOf(sheet)` 在 Task 4 加到 `style-entry.js`，Task 5 的端到端与 `loadPageStyle` 都用它。

**已知边界**：
- 状态的产生者只认 `type#id` / `#id` 形式的 `match=`；宽选择器（`match="table"`）不接线，console.warn 说明。第一个页面用例够了；接宽选择器要解析器把 producer 绑定放进视图模型 —— 那是 profile §10 的变更，不在本计划。
- `hide-below` 用 `max-width: (N-1)px`，与实测"1011 还在、768 没了、取 1012"对齐。
- 页里的 `embed` 不做异步展开（画成链接）；要展开等有人真在页里用它。

---

# 第二轮（2026-09-10）：外壳归位

**Goal:** 按[设计文档 §13](../specs/2026-08-29-geml-style-design.md) 落地：GitHub blob 复刻页保持 1:1，
viewer 里不再有任何认得 GitHub 的代码，样式表里不再有无人校验的键。

**Architecture:** 解析器加六件规范改动（行内部件步、块上的 `axis`、`view`/`editable`、`when=` 的 `@hover`/`@focus`、
参数收口）。viewer 把这些词编译成 CSS/DOM，删掉七个页面组件，只留 `tree` 与 `segments` 两个通用组件加状态接线。
复刻的 `page.geml` 改成列表承载，`github.style.geml` 只用内含词。

**任务号接着第一轮往下排**：Task 8 起。

## Global Constraints（第二轮）

- 分支 `feat/style-page-layout`，主检出，**不开 worktree**。每个 Task 一次 commit，消息不带任何 AI 署名。
- 每步之后复刻页（`C:/tmp/blob`，`node scratchpad/render-real.mjs C:/tmp/blob/rendered.html`）仍须零诊断。
- 注入页面的 CSS 不得出现 `url(`；宿主 CSS 页面段不得出现 `#` 开头的色值。
- 部件名、`@` 内建名、`view`/`editable`/`axis` 值域全部闭集；开放值仍经 `safeCssValue`。
- 用户测试规则：每条测试在 macOS/Linux 上也成立（路径用 `new URL(…, import.meta.url)`，不写 `C:\`）。
- 一条贵命令只跑一次，从同一次结果取输出与退出码。

---
## Task 8：解析器 —— 选择器多一类步：行内部件

**Files:**
- Modify: `geml-parser/src/style-selector.ts`
- Test: `geml-parser/test/style-selector.test.mjs`

**Interfaces:**
- Produces: `export const PARTS: ReadonlyMap<string,string>`（部件名 → 行内节点 type：`link→link`、`image→image`、`code-span→code`、`strong→strong`、`emphasis→emph`）；`export function isPartSelector(sel: Selector): boolean`；`Candidate.part?: string`；部件候选的 `self.type` = 部件名，`ancestors` = 块的祖先 + 块自身。
- Consumes: `Inline` 类型（`geml-parser/src/inline.ts` 的 `export type Inline`，若 `geml.ts` 未再导出则直接从 `./inline.js` 引）。

- [ ] **Step 1: 写失败的测试**

在 `geml-parser/test/style-selector.test.mjs` 末尾（`console.log` 之前）追加：

```js
test("部件步：text#nav link 解析成两步，最后一步 type=link（设计文档 §13.4a）", () => {
  const r = parseSelector("text#nav link");
  assert.equal(r.ok, true);
  assert.equal(r.selector.steps.length, 2);
  assert.equal(r.selector.steps[1].type, "link");
  assert.equal(isPartSelector(r.selector), true);
  assert.equal(isPartSelector(parseSelector("text#nav").selector), false);
});

test("部件步：只能是最后一步、前面要有块步、不带 #id/.class/[attr]；分支不能混", () => {
  for (const [src, re] of [
    ["link", /write the block before it/],
    ["text#nav link image", /must be the last step/],
    ["text#nav link[title]", /takes no #id, .class or \[attr\]/],
    ["text#nav link, table#t", /mix inline parts with blocks/],
  ]) {
    const r = parseSelector(src);
    assert.equal(r.ok, false, src);
    assert.equal(r.code, "selector-unsupported");
    assert.match(r.message, re, src);
  }
});

test("部件候选：块里出现过的行内类型各一个候选，地址沿用块的，`*` 与块选择器都选不中它", () => {
  const doc = parse('=== text {#nav}\n- ![](a.svg) [Code](https://x) `1`\n- **b** *c*\n===\n\n=== text {#plain}\nno inlines here\n===\n');
  const cs = candidates(doc);
  const nav = cs.filter((c) => address(c) === "#nav");
  assert.deepEqual(nav.map((c) => c.part ?? "(block)").sort(), ["(block)", "code-span", "emphasis", "image", "link", "strong"]);
  assert.deepEqual(cs.filter((c) => address(c) === "#plain").map((c) => c.part ?? "(block)"), ["(block)"]);
  const link = nav.find((c) => c.part === "link");
  assert.equal(link.self.type, "link");
  assert.equal(link.ancestors.at(-1).id, "nav", "块自身进了部件的祖先链");
  assert.equal(matches(parseSelector("text#nav link").selector, link), true);
  assert.equal(matches(parseSelector("text#nav").selector, link), false, "块选择器不选部件");
  assert.equal(matches(parseSelector("*").selector, link), false, "`*` 不选部件，否则槽位会把块摆两遍");
  assert.equal(matches(parseSelector("text#nav link").selector, nav.find((c) => c.part === undefined)), false);
});

test("部件候选：嵌套列表里的链接也算这个块的；嵌在块里的块的行内算内层也算外层（后代语义）", () => {
  const doc = parse('=== text {#tree}\n- docs\n  - [a](https://a)\n===\n');
  const cs = candidates(doc).filter((c) => address(c) === "#tree").map((c) => c.part ?? "(block)").sort();
  assert.deepEqual(cs, ["(block)", "link"]);
});
```

并把文件顶部的 import 改成：

```js
import { parseSelector, candidates, matches, address, selectorConditions, moreSpecific, isPartSelector } from "../dist/style-selector.js";
```

- [ ] **Step 2: 跑，确认失败**

```bash
cd geml-parser && npm run build && node test/style-selector.test.mjs
```
Expected: FAIL —— `isPartSelector is not a function` 或 `text#nav link` 被当成两个块步（`part` 为 undefined）。

- [ ] **Step 3: 实现**

`geml-parser/src/style-selector.ts`：

在 `import { styleDiag … }` 之后加：

```ts
import type { Inline } from "./inline.js";

/**
 * 行内部件（设计文档 §13.4a）：选择器的最后一步可以指到块**里面**的一类行内节点，
 * 于是"这个块里的链接"能上色，而调色板不必写进宿主。名字取 GEML-spec §5.1 的叫法
 * （code span、emphasis）—— `code` 是块类型，`text#nav code` 今天已经有意思（嵌在里面的
 * 代码块），不能借来当行内用。值是行内节点在模型里的 type。
 */
export const PARTS: ReadonlyMap<string, string> = new Map([
  ["link", "link"], ["image", "image"], ["code-span", "code"], ["strong", "strong"], ["emphasis", "emph"],
]);

/** 这条选择器指的是部件（最后一步是部件名）还是块。 */
export function isPartSelector(sel: Selector): boolean {
  const last = sel.steps[sel.steps.length - 1];
  return last !== undefined && last.type !== undefined && PARTS.has(last.type);
}
```

`parseOne` 改成：

```ts
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
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.type === undefined || !PARTS.has(s.type)) continue;
    if (i === 0) return { error: `\`${s.type}\` names an inline part; write the block before it (\`text#nav ${s.type}\`)` };
    if (i !== steps.length - 1) return { error: `\`${s.type}\` names an inline part and must be the last step in \`${src}\`` };
    if (s.id !== undefined || s.classes.length > 0 || s.attrs.length > 0) return { error: `an inline part takes no #id, .class or [attr] in \`${src}\`` };
  }
  return { steps, source: src };
}
```

`parseSelector` 在 `branches.push(r)` 循环之后、`if (branches.length === 0)` 之前加：

```ts
  // 一条 match= 的分支要么全指块、要么全指部件：混着写会让同一条规则的内含词一半合法一半不合法。
  const partness = branches.map(isPartSelector);
  if (partness.some(Boolean) && !partness.every(Boolean)) {
    return { ok: false, code: "selector-unsupported", message: `branches of \`${trimmed}\` mix inline parts with blocks; write two rules (${SUPPORTED})` };
  }
```

`Candidate` 接口加字段：

```ts
  /** 部件候选：这个块的某一类行内（`link` `image` `code-span` `strong` `emphasis`）。没有 = 块本身。 */
  part?: string;
```

`candidates` 改成：

```ts
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
```

`matches` 开头加一行，块选择器与部件候选互不相干（`*` 也是块选择器）：

```ts
export function matches(sel: Selector, c: Candidate): boolean {
  const target = sel.steps[sel.steps.length - 1]!;
  const wantsPart = target.type !== undefined && PARTS.has(target.type);
  if (wantsPart !== (c.part !== undefined)) return false;
  if (!matchSimple(target, c.self)) return false;
  …（其余不动）
```

文件头注释第一段末尾补一句：`部件步（link image code-span strong emphasis）只在最后一步合法，见 PARTS。`

- [ ] **Step 4: 跑，确认通过**

```bash
npm run build && node test/style-selector.test.mjs
```
Expected: 全部 ok。

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/style-selector.ts geml-parser/test/style-selector.test.mjs
git commit -m "feat(style): a selector's last step can name an inline part — link, image, code-span, strong, emphasis"
```

---

## Task 9：解析器 —— `axis` 上块、`view`、`editable`、部件上的内含词、rule 参数收口、codemap 种子

**Files:**
- Modify: `geml-parser/src/style-resolve.ts`
- Modify: `geml-parser/src/graph-style.ts`
- Test: `geml-parser/test/style-check.test.mjs`
- Test: `geml-parser/test/graph-style.test.mjs`（若断言零诊断则同步加 `component=code-graph`）

**Interfaces:**
- Produces: `BOX_WORDS` 多 `axis` `view` `editable`；`Binding.part?: string`；rule 上无 `component=` 的非保留非内含键 → `style-unknown-attribute`；部件规则上不适用的内含词 → `style-unknown-attribute`；槽位选择器指部件 → `selector-unsupported`。
- Consumes: Task 8 的 `isPartSelector`、`Candidate.part`。

- [ ] **Step 1: 写失败的测试**

`geml-parser/test/style-check.test.mjs` 末尾追加（沿用文件里的 `sheet()`、`codes()`；`resolveStyle` 已 import）：

```js
test("内含词：axis 能挂块上、view/editable 闭域；域外报 style-invalid-value（设计文档 §13.4b-d）", () => {
  const ok = sheet('=== style-rule {#r match="text#nav" axis=row view=source editable=yes}\n===\n');
  assert.deepEqual(ok.rules[0].box, { axis: "row", view: "source", editable: "yes" });
  assert.deepEqual(codes(ok.diagnostics), []);
  const bad = sheet('=== style-rule {#r match="text#nav" axis=diagonal view=raw editable=maybe}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["style-invalid-value", "style-invalid-value", "style-invalid-value"]);
  assert.deepEqual(bad.rules[0].box, {});
});

test("收口：没有 component= 的 rule 出现未知键报 warning；有 component= 照旧透传（设计文档 §13.4f）", () => {
  const typo = sheet('=== style-rule {#r match="text#nav" icon="x.svg" color=red}\n===\n');
  assert.deepEqual(codes(typo.diagnostics), ["style-unknown-attribute"]);
  assert.equal(typo.diagnostics[0].severity, "warning");
  assert.match(typo.diagnostics[0].message, /no `component=` to receive it/);
  assert.deepEqual(typo.rules[0].params, {});
  assert.deepEqual(typo.rules[0].box, { color: "red" });
  const comp = sheet('=== style-rule {#r match="text#nav" component=tree collapsed}\n===\n');
  assert.deepEqual(codes(comp.diagnostics), []);
  assert.deepEqual(comp.rules[0].params, { collapsed: true });
});

test("部件规则：只收对一段行内说得通的内含词，其余报 style-unknown-attribute 并丢弃", () => {
  const s = sheet('=== style-rule {#r match="text#nav link" color="#0969da" padding="4px 6px" sticky=0 grow=yes}\n===\n');
  assert.deepEqual(codes(s.diagnostics), ["style-unknown-attribute", "style-unknown-attribute"]);
  assert.match(s.diagnostics[0].message, /not a word for an inline part/);
  assert.deepEqual(s.rules[0].box, { color: "#0969da", padding: "4px 6px" });
});

test("部件绑定：binding 带 part；块规则与部件规则不争；两条部件规则争同一属性照旧 ambiguous-rule", () => {
  const corpus = [{ path: "p.geml", doc: parse('=== text {#nav}\n- [Code](https://x) `1`\n===\n\n=== text {#nolink}\nplain\n===\n') }];
  const vm = resolveStyle(sheet(
    '=== style-rule {#blk match="text#nav" color=black}\n===\n' +
    '=== style-rule {#lnk match="text#nav link" color=blue}\n===\n' +
    '=== style-rule {#pill match="text#nav code-span" background=grey}\n===\n' +
    '=== style-rule {#miss match="text#nolink link" color=red}\n===\n'
  ), corpus);
  const nav = vm.bindings.filter((b) => b.block === "#nav");
  assert.deepEqual(nav.map((b) => b.part ?? "(block)").sort(), ["(block)", "code-span", "link"]);
  assert.equal(nav.find((b) => b.part === undefined).box.color, "black");
  assert.equal(nav.find((b) => b.part === "link").box.color, "blue");
  assert.equal(nav.find((b) => b.part === "code-span").box.background, "grey");
  assert.deepEqual(codes(vm.diagnostics), ["unmatched-rule"], "#miss 没命中：#nolink 里没有链接");
  const clash = resolveStyle(sheet(
    '=== style-rule {#a match="text#nav link" color=blue}\n===\n' +
    '=== style-rule {#b match="text#nav link" color=red}\n===\n'
  ), corpus);
  assert.deepEqual(codes(clash.diagnostics), ["ambiguous-rule"]);
});

test("槽位不摆部件：slots 里写部件选择器是 selector-unsupported", () => {
  const vm = resolveStyle(sheet('=== style-screen {#p slots="text#nav link"}\n===\n'),
    [{ path: "p.geml", doc: parse('=== text {#nav}\n- [a](https://a)\n===\n') }]);
  assert.ok(vm.diagnostics.some((d) => d.code === "selector-unsupported" && /slot places blocks/.test(d.message)), JSON.stringify(vm.diagnostics));
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
npm run build && node test/style-check.test.mjs
```
Expected: FAIL —— `axis` 落进 params 而非 box；`icon=` 无诊断；binding 没有 `part`。

- [ ] **Step 3: 实现 `style-resolve.ts`**

（a）import 行加 `isPartSelector`：

```ts
import {
  parseSelector, selectorDiag, candidates, matches, address,
  selectorConditions, moreSpecific, isPartSelector, type Selector, type Candidate,
} from "./style-selector.js";
```

（b）`BOX_WORDS` 与值域：

```ts
export const BOX_WORDS: ReadonlySet<string> = new Set([
  "width", "max-width", "padding", "margin", "sticky", "scroll", "hide-below",
  "font-size", "line-height", "font-family", "text-align", "color", "background",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "gap",
  "layer", "visible", "grow",
  // 第二个页面用例（设计文档 §13）：`axis` 也能挂块上（列表横排）；`view`/`editable` 是"看源码"。
  "axis", "view", "editable",
]);
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
  "border-radius", "font-size", "line-height", "font-family", "width", "max-width", "visible",
]);
```

`boxValueOk` 开头加三段（放在 `scroll` 那段之前）：

```ts
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
```

（c）`collect()` 里 style-rule 的属性循环改成（并删掉后面那行 `const component = str(b.attrs["component"]); if (…) rule.component = component;` 的**读取**部分，保留赋值）：

```ts
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
        // 与容器同规则（设计文档 §13.4f）：有 component= 才有接收方。没有组件却写了别的键，
        // 那是笔误 —— 第一个页面用例里十个私有键零校验，拼错静默，就是这一刀没切。
        if (component === undefined) {
          sheet.diagnostics.push(styleDiag("style-unknown-attribute",
            `unknown attribute \`${k}\` for \`style-rule\` (no \`component=\` to receive it)`, id));
          continue;
        }
        params[k] = v;
      }
```
后面 `if (component !== undefined) rule.component = component;` 保留（只删重复的 `const`）。

（d）`Binding` 接口加：

```ts
  /** 部件绑定：这个块的某一类行内（`link` `image` `code-span` `strong` `emphasis`）。没有 = 块本身。 */
  part?: string;
```

`resolveBindings` 末尾 `bindings.push({…})` 改成：

```ts
    const binding: Binding = {
      doc: entry.path, block: address(entry.c), rules: hits.map((h) => h.rule.id),
      params: baseSplit.params, box: baseSplit.box, variants,
    };
    if (entry.c.part !== undefined) binding.part = entry.c.part;
    bindings.push(binding);
```

（e）槽位求解处（`resolveStyle` 里把 `slots` 字符串解析成 `ResolvedSlot` 的那段；找 `kind: "blocks"`）：解析成功后加

```ts
        if (isPartSelector(sel.branches[0]!)) {
          diagnostics.push(styleDiag("selector-unsupported", `slot \`${raw}\` names an inline part; a slot places blocks, not parts of them`, c.id));
          continue;
        }
```
（变量名以现场为准：`sel` 是 parseSelector 结果，`raw` 是槽位原文，`c` 是容器。）

（f）`graph-style.ts` `serializeGraphStyle` 的规则行加 `component=code-graph`：

```ts
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" component=code-graph \\\n' +
```
若 `graph-style.test.mjs` 里有断言 `serializeGraphStyle` 输出全文或零诊断的用例，把期望同步加上 `component=code-graph`；`writtenKnobs` 若把所有非 match 属性当旋钮读，跳过 `component`。

- [ ] **Step 4: 跑，确认通过；全量解析器测试一次**

```bash
npm run build && node test/style-check.test.mjs && node test/graph-style.test.mjs && node test/all.mjs
```
Expected: 全部 ok。若其它套件因 rule 上无 `component=` 的参数而新增 warning 断言失败，给那条 fixture 的 rule 加 `component=`（fixture `test/fixtures/style-page/github.style.geml` 每条带参数的 rule 已有 `component=`，不动）。

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/style-resolve.ts geml-parser/src/graph-style.ts geml-parser/test/style-check.test.mjs geml-parser/test/graph-style.test.mjs
git commit -m "feat(style): axis on blocks, view and editable; part rules take part words; a rule without component= reports stray keys"
```

---

## Task 10：解析器 —— `when=` 多 `@hover` `@focus`

**Files:**
- Modify: `geml-parser/src/style-resolve.ts`
- Test: `geml-parser/test/style-check.test.mjs`

- [ ] **Step 1: 写失败的测试**

```js
test("when=@hover：内建伪状态进条件集；与 $state 并列；@focus 与 @hover 争同一属性是 ambiguous-rule（设计文档 §13.4e）", () => {
  const corpus = [{ path: "p.geml", doc: parse('=== text {#nav}\n- [a](https://a)\n===\n') }];
  const vm = resolveStyle(sheet(
    '=== style-state {#side type=scalar match="text#nav" on=toggle init-value=open}\n===\n' +
    '=== style-rule {#base match="text#nav link" color=black}\n===\n' +
    '=== style-rule {#hov match="text#nav link" when="@hover" color=blue}\n===\n' +
    '=== style-rule {#both match="text#nav link" when="$side=closed, @hover" color=red}\n===\n'
  ), corpus);
  assert.deepEqual(codes(vm.diagnostics), []);
  const link = vm.bindings.find((b) => b.block === "#nav" && b.part === "link");
  assert.equal(link.box.color, "black");
  assert.deepEqual(link.variants.map((v) => v.when), [{ "@hover": "true" }, { side: "closed", "@hover": "true" }], "条件数升序；@hover 算一项");
  const clash = resolveStyle(sheet(
    '=== style-rule {#h match="text#nav link" when="@hover" color=blue}\n===\n' +
    '=== style-rule {#f match="text#nav link" when="@focus" color=red}\n===\n'
  ), corpus);
  assert.deepEqual(codes(clash.diagnostics), ["ambiguous-rule"], "可以同时成立、互不包含、争同一属性");
  const typo = sheet('=== style-rule {#h match="text#nav" when="@hoover" color=blue}\n===\n');
  assert.deepEqual(codes(typo.diagnostics), ["style-invalid-value"]);
  assert.match(typo.diagnostics[0].message, /@hover/);
  assert.match(typo.diagnostics[0].message, /@focus/);
  const inj = sheet('=== style-rule {#h match="text#nav" when="@hover} body{display:none" color=blue}\n===\n');
  assert.deepEqual(codes(inj.diagnostics), ["style-invalid-value"]);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
npm run build && node test/style-check.test.mjs
```
Expected: FAIL —— `@hover` 被 `WHEN_TERM` 拒为 style-invalid-value。

- [ ] **Step 3: 实现**

`parseWhen` 改成：

```ts
/**
 * `when=` 里的内建伪状态（设计文档 §13.4e）：值由指针给、不由 style-state 声明。`@` 前缀
 * 保证不与任何状态撞名。放在 when= 而不是选择器里：选择器选内容，when= 说状态（§12.5 的边界）。
 */
const PSEUDO = new Set(["hover", "focus"]);

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
```

`unknown-state` 检查（`checkRefs` 附近，若对 `rule.when` 的 state 名逐个查 `declared`）：以 `@` 开头的名字跳过：

```ts
  for (const rule of sheet.rules) for (const c of rule.when) {
    if (c.state.startsWith("@")) continue; // 内建伪状态，没有 style-state 声明它
    if (!declared.has(c.state)) diagnostics.push(styleDiag("unknown-state", `\`$${c.state}\` is not declared by any \`style-state\` block`, rule.id));
  }
```
（若现场是别的写法，保持其形状，只加那一行 `continue`。）

- [ ] **Step 4: 跑，确认通过**

```bash
npm run build && node test/style-check.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add geml-parser/src/style-resolve.ts geml-parser/test/style-check.test.mjs
git commit -m "feat(style): when= takes @hover and @focus — a pointer's state is a state the stylesheet can dress"
```

---

## Task 11：viewer —— 链接与图片的 `{title=}` 落到 HTML

**Files:**
- Modify: `integrations/geml-viewer/src/render.js`（`linkAttrs`、`renderMedia`）
- Test: `integrations/geml-viewer/test/render.test.mjs`

- [ ] **Step 1: 写失败的测试**

```js
test("§5.2 属性对象里的 title 落到 a/img 的 title；alt 照旧；不是字串就不落", () => {
  const root = render('=== text {#t}\n[Issues](https://x/issues){title="All issues"} ![unread](dot.svg){title="New"} [x](https://y){title=3}\n===\n');
  const as = [...root.querySelectorAll("a")];
  assert.equal(as[0].getAttribute("title"), "All issues");
  assert.equal(as[1].getAttribute("title"), "3", "数字也是文本");
  const img = root.querySelector("img");
  assert.equal(img.getAttribute("alt"), "unread");
  assert.equal(img.getAttribute("title"), "New");
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
cd integrations/geml-viewer && node test/render.test.mjs
```

- [ ] **Step 3: 实现**

`linkAttrs` 的 `return a;` 之前：

```js
  // §5.2 的属性对象。title 是提示语，也是只有图标的链接的无障碍名（HTML 的名字计算本来就这样）。
  if (typeof at.title === "string" || typeof at.title === "number") a.title = String(at.title);
```

`renderMedia` 的 `img` 分支：

```js
  const t = n.attrs && (typeof n.attrs.title === "string" || typeof n.attrs.title === "number") ? { title: String(n.attrs.title) } : {};
  return el(dom, "img", { src, alt: n.alt || "", style: "max-width:100%", ...dim, ...t });
```

- [ ] **Step 4: 跑，确认通过**

```bash
node test/render.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add integrations/geml-viewer/src/render.js integrations/geml-viewer/test/render.test.mjs
git commit -m "feat(viewer): a link's or image's {title=} reaches the DOM"
```

---

## Task 12：viewer —— 视图模型到 CSS：部件、伪状态、块上的 axis、view 的两副面孔

**Files:**
- Modify: `integrations/geml-viewer/src/layout.js`（`cssForPage`、新 helper）
- Test: `integrations/geml-viewer/test/layout.test.mjs`

**Interfaces:**
- Produces: `export const PART_TAG = { link: "a", image: "img", "code-span": "code", strong: "strong", emphasis: "em" }`；`export function whenSelector(when) → { body, suffix }`；CSS 形状：部件 `.geml-b-nav a { … }`；伪状态 `.geml-b-nav a:hover { … }` / `body.geml-s-side-closed .geml-b-nav a:hover { … }`；块 axis `.geml-b-nav .geml-items { display: flex; flex-direction: row; list-style: none; margin: 0; padding: 0; gap: 16px }`；面 `.geml-b-doc > .geml-face { display: none }` `.geml-b-doc > .geml-face-rendered { display: revert }` 与按条件的同形。
- Consumes: Task 9/10 的 `Binding.part`、`when` 里的 `@hover`。

- [ ] **Step 1: 写失败的测试**

在 `test/layout.test.mjs` 的 `cssForPage` 那组测试后追加（用文件里已有的 `vmOf`）：

```js
test("cssForPage：部件绑定接标签；@hover 接 :hover；块上的 axis 生成 .geml-items 的 flex；gap 跟着 axis 走", () => {
  const { vm } = vmOf(`=== meta
profile = "geml-style/v1"
===
=== style-screen {#p slots="text#nav"}
===
=== style-state {#side type=scalar match="text#nav" on=toggle init-value=open}
===
=== style-rule {#n match="text#nav" axis=row gap=16px padding=8px}
===
=== style-rule {#l match="text#nav link" color="#0969da" padding="4px 6px"}
===
=== style-rule {#h match="text#nav link" when="@hover" background="#eaeef2"}
===
=== style-rule {#hc match="text#nav link" when="$side=closed, @hover" background="#fff"}
===
=== style-rule {#i match="text#nav image" width=16px}
===
`, '=== text {#nav}\n- ![](a.svg) [Code](https://x)\n===\n');
  const css = cssForPage(vm);
  assert.match(css, /\.geml-b-nav \{ padding: 8px \}/, "gap 不在块自己身上");
  assert.match(css, /\.geml-b-nav \.geml-items \{ display: flex; flex-direction: row; list-style: none; margin: 0; padding: 0; gap: 16px \}/);
  assert.match(css, /\.geml-b-nav a \{ color: #0969da; padding: 4px 6px \}/);
  assert.match(css, /\.geml-b-nav a:hover \{ background: #eaeef2 \}/);
  assert.match(css, /body\.geml-s-side-closed \.geml-b-nav a:hover \{ background: #fff \}/);
  assert.match(css, /\.geml-b-nav img \{ width: 16px; flex: 0 0 auto \}/);
  assert.doesNotMatch(css, /geml-s-@/, "伪状态不会变成 body 上的 class");
});

test("cssForPage：view 有两副面孔 —— 基础面显示、其余隐藏，按条件反过来", () => {
  const { vm } = vmOf(`=== meta
profile = "geml-style/v1"
===
=== style-screen {#p slots="text#doc"}
===
=== style-state {#tab type=scalar match="text#doc" on=select init-value=Preview}
===
=== style-rule {#r match="text#doc" view=rendered max-width=1012px}
===
=== style-rule {#c match="text#doc" when="$tab=Code" view=source editable=yes}
===
=== style-rule {#b match="text#doc" when="$tab=Blame" view=source}
===
`, '=== text {#doc}\nbody\n===\n');
  const css = cssForPage(vm);
  assert.match(css, /\.geml-b-doc > \.geml-face \{ display: none \}/);
  assert.match(css, /\.geml-b-doc > \.geml-face-rendered \{ display: revert \}/);
  assert.match(css, /body\.geml-s-tab-Code \.geml-b-doc > \.geml-face \{ display: none \}/);
  assert.match(css, /body\.geml-s-tab-Code \.geml-b-doc > \.geml-face-source-editable \{ display: revert \}/);
  assert.match(css, /body\.geml-s-tab-Blame \.geml-b-doc > \.geml-face-source \{ display: revert \}/);
  assert.doesNotMatch(css, /view:|editable:/, "view/editable 不是 CSS 属性");
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
node test/layout.test.mjs
```

- [ ] **Step 3: 实现 `layout.js`**

在 `BOX_PASS` 之后加：

```js
/** 部件名 → 它在 DOM 里的标签。闭集，和解析器的 PARTS 一一对应。 */
export const PART_TAG = { link: "a", image: "img", "code-span": "code", strong: "strong", emphasis: "em" };

/**
 * 一个 variant 的 when → 选择器的两半：`$state=value` 是 body 上的 class；`@hover`/`@focus`
 * 是指针给的状态，落在目标自己身上（`:hover` / `:focus-visible`）。
 */
export function whenSelector(when) {
  let body = "", suffix = "";
  for (const [st, val] of Object.entries(when)) {
    if (st === "@hover") suffix += ":hover";
    else if (st === "@focus") suffix += ":focus-visible";
    else body += `body.${stateClass(st, val)}`;
  }
  return { body, suffix };
}

/** `view`/`editable` → 面的名字。rendered | source | source-editable。 */
export function faceOf(box) {
  if (!box || box.view !== "source") return "rendered";
  return box.editable === "yes" ? "source-editable" : "source";
}

/** 一个 binding 用到的全部面。只有 {rendered} 时宿主不包面，DOM 和今天一样。 */
export function facesOf(b) {
  const set = new Set([faceOf(b.box)]);
  for (const v of b.variants ?? []) if (v.box && v.box.view !== undefined) set.add(faceOf(v.box));
  return set;
}
```

`declarations(box, dropped, where)` 改签名为 `declarations(box, dropped, where, skip = new Set())`，循环开头 `if (skip.has(k)) continue;`。`axis`/`view`/`editable` 不在 `BOX_PASS` 且无 else-if 分支，本来就不进 CSS。

`cssForPage` 的 bindings 循环改成：

```js
  for (const b of bindings) {
    const cls = classFor(b.block);
    const target = `.${cls}` + (b.part ? ` ${PART_TAG[b.part] ?? "span"}` : "");
    // 块上的 axis：条目容器（列表/表单）横排或竖排；gap 跟条目走，不留在块自己身上。
    const items = (box, cond) => {
      if (box.axis === undefined) return;
      const gap = box.gap === undefined ? null : safeCssValue(box.gap);
      rules.push(`${cond}${target} .geml-items { display: flex; flex-direction: ${box.axis === "row" ? "row" : "column"}; list-style: none; margin: 0; padding: 0${gap ? `; gap: ${gap}` : ""} }`);
    };
    const skipFor = (box) => new Set(box.axis === undefined ? [] : ["gap"]);
    const base = declarations(b.box, dropped, b.block, skipFor(b.box));
    if (base) rules.push(`${target} { ${base} }`);
    items(b.box, "");
    if (typeof b.box["hide-below"] === "number") rules.push(`@media (max-width: ${b.box["hide-below"] - 1}px) { ${target} { display: none } }`);
    // 面：view=source 是另一副面孔。两副都在 DOM 里（renderPage 画），这里只切显示。
    const faces = facesOf(b);
    if (faces.size > 1 || !faces.has("rendered")) {
      rules.push(`${target} > .geml-face { display: none }`);
      rules.push(`${target} > .geml-face-${faceOf(b.box)} { display: revert }`);
    }
    for (const v of b.variants ?? []) {
      const { body, suffix } = whenSelector(v.when);
      const cond = body ? `${body} ` : "";
      const decl = declarations(v.box, dropped, `${b.block} when ${JSON.stringify(v.when)}`, skipFor(v.box));
      if (decl) rules.push(`${cond}${target}${suffix} { ${decl} }`);
      items(v.box, cond);
      if (typeof v.box["hide-below"] === "number") rules.push(`@media (max-width: ${v.box["hide-below"] - 1}px) { ${cond}${target}${suffix} { display: none } }`);
      if (v.box.view !== undefined) {
        rules.push(`${cond}${target}${suffix} > .geml-face { display: none }`);
        rules.push(`${cond}${target}${suffix} > .geml-face-${faceOf(v.box)} { display: revert }`);
      }
    }
  }
```

容器的 `container(c, sel)` 里 variants 的条件同样改用 `whenSelector`（容器也可以 `when="@hover"`）：

```js
    for (const v of c.variants ?? []) {
      const { body, suffix } = whenSelector(v.when);
      const cond = body ? `${body} ` : "";
      const d = declarations(v.box, dropped, `container #${c.id} when ${JSON.stringify(v.when)}`);
      if (d) rules.push(`${cond}${sel}${suffix} { ${d} }`);
      if (typeof v.box["hide-below"] === "number") rules.push(`@media (max-width: ${v.box["hide-below"] - 1}px) { ${cond}${sel}${suffix} { display: none } }`);
    }
```

- [ ] **Step 4: 跑，确认通过**

```bash
node test/layout.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add integrations/geml-viewer/src/layout.js integrations/geml-viewer/test/layout.test.mjs
git commit -m "feat(viewer): part bindings, @hover, axis on blocks and view faces compile to CSS"
```

---

## Task 13：viewer —— 放置：条目标记、两副面、块触发、字段喂状态；组件表只剩 tree / segments / code-graph；宿主 CSS 页面段瘦身

**Files:**
- Modify: `integrations/geml-viewer/src/layout.js`（`renderPage`：`place`、`container`、`wireTrigger`）
- Rewrite: `integrations/geml-viewer/src/components.js`
- Modify: `integrations/geml-viewer/src/content.js`（把宿主文档原文挂进语料）
- Modify: `integrations/geml-viewer/src/parse-entry.js`（若未导出 `blockSpans` 则再导出）
- Modify: `integrations/geml-viewer/src/geml.css`（257–355 行整段替换）
- Test: `integrations/geml-viewer/test/layout.test.mjs`（删 7 条、改 2 条、加 6 条）
- Test: `integrations/geml-viewer/test/security.test.mjs`（若引用了 `bar`/`field`，改为部件路径）

**Interfaces:**
- Produces: `COMPONENTS = { tree, segments, "code-graph": passthrough }`；`createState` 忽略 `@` 开头的 when 键；`renderPage` opts 不变，`ctx` 多 `sources`（path → 原文）与 `spans`（Map id → {start,end}，仅宿主文档）；`.geml-items` 标在块里第一个 `ul/ol/.geml-form` 上；面：`div.geml-face.geml-face-rendered` / `.geml-face-source`（`pre.geml-source`）/ `.geml-face-source-editable`（`textarea.geml-source`）；toggle 状态的块产生者：包装 div `role=button tabindex=0`；select 状态的 form-field 产生者：控件 `change` 写状态、无 init-value 时用字段 `value=`。
- Consumes: 解析器 `blockSpans(source)`（`geml-parser/dist/geml.js`）；Task 12 的 `facesOf`/`faceOf`。

- [ ] **Step 1: 改测试**

删除 `layout.test.mjs` 里这些用例（整段）：`状态槽位画出开关…`（275）、`tab-bar：· 分隔…`（295）、`markdown-body：默认渲染…`（307）、`组件：直接调用 —— 没有 state 的 tree…`（510）、`组件：tab-bar 的文本来自 raw 行…`（524）、`field 组件：给标准表单块加宿主装饰…`（681）、`图标：写成文件就引用文件…`（787）、`外壳的地址过闸…`（804）、`文件树：kind 决定图标…`（817）。文件顶部 import 里去掉 `tree as treeComponent, "tab-bar"…` 之类不再存在的名字（以现场为准）。

把 `容器当组件：页面外壳…`（654）改成用测试自己注入的组件，只验"容器能点名组件、参数从容器来"：

```js
test("容器当组件：component= 与参数从容器来，宿主注册什么就画什么", () => {
  const doc = "=== text {#body}\nthe document\n===\n";
  const { vm, model } = vmOf(`=== meta
profile = "geml-style/v1"
===
=== style-screen {#page axis=column slots="#top, text#body"}
===
=== style-frame {#top axis=row component=stamp label="hello" slots=""}
===
`, doc);
  const { document } = dom();
  const stamp = (_block, params, ctx) => { const s = ctx.dom.createElement("span"); s.className = "stamp"; s.textContent = String(params.label); return s; };
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: { stamp }, state: null });
  assert.ok(out.root, out.error);
  const top = out.root.querySelector('section[data-id="top"]');
  assert.equal(top.getAttribute("data-component"), "stamp");
  assert.equal(top.querySelector(".stamp").textContent, "hello");
  assert.equal(out.root.querySelector('[data-block="#body"]').textContent.trim(), "the document");
});
```

把 `state：toggle 找不到恰好一个别的值就惰性…`（268）里的 `assert.equal(document.querySelector(".geml-state-toggle"), null);` 删掉（开关不再存在）。

追加：

```js
test("$state 槽位：scalar 状态是空占位，带 data-state；不再画 ☰", () => {
  const sheet = "=== meta\nprofile = \"geml-style/v1\"\n===\n"
    + '=== style-screen {#p axis=column slots="$tree, table#tree"}\n===\n'
    + '=== style-state {#tree type=scalar match="table#tree" on=toggle init-value=open}\n===\n'
    + '=== style-rule {#c match="table#tree" when="$tree=closed" width=0}\n===\n';
  const { vm, model } = vmOf(sheet, DOC3);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state: createState(vm, document) });
  const slot = out.root.querySelector(".geml-slot-state");
  assert.equal(slot.getAttribute("data-state"), "tree");
  assert.equal(slot.children.length, 0);
  assert.equal(out.root.querySelector("button"), null);
});

test("块当触发者：toggle 状态的产生者是块时，包装元素可点、可键盘；浮层状态点别处关掉，非浮层不管", () => {
  const sheet = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#p axis=column slots="text#caret, #menu, text#other"}
===
=== style-frame {#menu axis=column slots="text#items"}
===
=== style-state {#m type=scalar match="text#caret" on=toggle init-value=closed}
===
=== style-rule {#hide match="#menu" visible=no}
===
=== style-rule {#show match="#menu" when="$m=open" visible=yes layer=overlay}
===
`;
  const doc = '=== text {#caret}\n![Open](caret.svg)\n===\n=== text {#items}\n- [a](https://a)\n===\n=== text {#other}\nelsewhere\n===\n';
  const { vm, model, sheet: loaded } = vmOf(sheet, doc);
  const { document } = dom();
  const state = createState(vm, document);
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state, producers: producersOf(loaded) });
  document.body.appendChild(out.root);
  const caret = out.root.querySelector('[data-block="#caret"]');
  assert.equal(caret.getAttribute("role"), "button");
  assert.equal(caret.getAttribute("tabindex"), "0");
  caret.dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));
  assert.equal(state.get("m"), "open");
  out.root.querySelector('[data-block="#other"]').dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));
  assert.equal(state.get("m"), "closed", "浮层开着，点别处关掉");
  caret.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(state.get("m"), "open", "键盘也能翻");
});

test("字段喂状态：select 状态的产生者是 form-field 时，值就是状态；没 init-value 用字段的 value=；change 写状态", () => {
  const sheet = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#p axis=column slots="form-field#view, text#doc"}
===
=== style-state {#tab type=scalar match="form-field#view" on=select}
===
=== style-rule {#c match="text#doc" when="$tab=Code" color=red}
===
`;
  const doc = '=== meta\nprofile = "geml-form/v1"\n===\n=== form-options {#views format=csv}\nvalue,label\nPreview,Preview\nCode,Code\n===\n=== form-field {#view type=select options=#views value=Preview}\n===\n=== text {#doc}\nbody\n===\n';
  const { vm, model, sheet: loaded } = vmOf(sheet, doc);
  const { document } = dom();
  const state = createState(vm, document);
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state, producers: producersOf(loaded) });
  assert.equal(state.get("tab"), "Preview", "初值取字段的 value=");
  const sel = out.root.querySelector("select");
  sel.value = "Code";
  sel.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
  assert.equal(state.get("tab"), "Code");
  assert.ok(document.body.classList.contains("geml-s-tab-Code"));
});

test("segments：select 画成分段按钮，aria-pressed 跟状态，点击写字段值与状态", () => {
  const sheet = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#p axis=column slots="form-field#view"}
===
=== style-state {#tab type=scalar match="form-field#view" on=select}
===
=== style-rule {#seg match="form-field#view" component=segments}
===
`;
  const doc = '=== meta\nprofile = "geml-form/v1"\n===\n=== form-options {#views format=csv}\nvalue,label\nPreview,Preview\nCode,Code\nBlame,Blame\n===\n=== form-field {#view type=select options=#views value=Preview}\n===\n';
  const { vm, model, sheet: loaded } = vmOf(sheet, doc);
  const { document } = dom();
  const state = createState(vm, document);
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state, producers: producersOf(loaded) });
  const btns = [...out.root.querySelectorAll(".geml-segments button")];
  assert.deepEqual(btns.map((b) => b.textContent), ["Preview", "Code", "Blame"]);
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-pressed")), ["true", "false", "false"]);
  assert.equal(state.get("tab"), "Preview");
  btns[1].dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));
  assert.equal(state.get("tab"), "Code");
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-pressed")), ["false", "true", "false"]);
  assert.equal(out.root.querySelector("select"), null, "不再是原生下拉");
});

test("tree：嵌套列表里带子列表的条目包成 details[open]/summary，没子列表的不包；没有列名", () => {
  const sheet = '=== meta\nprofile = "geml-style/v1"\n===\n=== style-screen {#p slots="text#t"}\n===\n=== style-rule {#r match="text#t" component=tree}\n===\n';
  const doc = '=== text {#t}\n- ![](d.svg) [docs](https://d)\n  - ![](f.svg) [a.md](https://d/a)\n- ![](f.svg) [README.md](https://r)\n===\n';
  const { vm, model } = vmOf(sheet, doc);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state: null });
  const lis = [...out.root.querySelectorAll('[data-block="#t"] > .text > ul > li')];
  assert.equal(lis.length, 2);
  const d = lis[0].querySelector("details");
  assert.ok(d && d.hasAttribute("open"), "有子项 = 展开着");
  assert.equal(d.querySelector("summary a").getAttribute("href"), "https://d");
  assert.equal(d.querySelector("ul a").getAttribute("href"), "https://d/a");
  assert.equal(lis[1].querySelector("details"), null);
});

test("axis 上块：第一个列表标成 .geml-items；view=source 画两副面，源码来自语料原文或块的 raw", () => {
  const sheet = `=== meta
profile = "geml-style/v1"
===
=== style-screen {#p axis=column slots="text#nav, embed#doc, code#c"}
===
=== style-state {#tab type=scalar match="text#nav" on=toggle init-value=Preview}
===
=== style-rule {#n match="text#nav" axis=row}
===
=== style-rule {#d match="embed#doc" when="$tab=Code" view=source editable=yes}
===
=== style-rule {#cc match="code#c" view=source}
===
`;
  const host = '=== text {#nav}\n- [a](https://a)\n===\n=== embed {#doc src="other.geml"}\n===\n=== code {#c lang=js}\nlet x = 1;\n===\n';
  const other = "=== text {#o}\nborrowed\n===\n";
  const model = parse(host);
  const loaded = loadStylesheet(parse(sheet));
  const corpus = [{ path: "page.geml", doc: model, text: host }, { path: "other.geml", doc: parse(other), text: other }];
  const vm = resolveStyle(loaded, corpus);
  const { document } = dom();
  const out = renderPage(vm, model, document, { renderBlock, labels: [], components: COMPONENTS, state: createState(vm, document), corpus });
  assert.ok(out.root, out.error);
  assert.ok(out.root.querySelector('[data-block="#nav"] ul.geml-items'), "条目容器标出来了");
  const doc = out.root.querySelector('[data-block="#doc"]');
  assert.ok(doc.querySelector(".geml-face-rendered"), "渲染面");
  const ta = doc.querySelector("textarea.geml-face-source-editable, .geml-face-source-editable textarea");
  assert.ok(ta, "可编辑的源码面是 textarea");
  assert.equal(ta.value.trim(), other.trim(), "embed 的源码是借来那份文档的原文");
  const pre = out.root.querySelector('[data-block="#c"] .geml-face-source pre, [data-block="#c"] pre.geml-face-source');
  assert.ok(pre, "不可编辑的源码面是 pre");
  assert.match(pre.textContent, /let x = 1;/);
});
```

`SHEET`（136–153）里 `component=tree` 落在 `table#tree` 上：新 tree 对没有 `li` 的块是空操作，用例照旧成立，不改。

- [ ] **Step 2: 跑，确认失败**

```bash
node test/layout.test.mjs
```

- [ ] **Step 3: 重写 `components.js`**

整文件替换为：

```js
// 宿主注册表（profile §2.1：component 是名字，实现在宿主）和状态存储（§5：interaction → state → view）。
// 状态住在 <body> 的 class 上（layout.js 的 variant 规则挂在那儿），所以 set() 就是换 class。
//
// 这里只有**不认页面**的东西（设计文档 §13.5）：任何一行不许出现色值、尺寸、某个站点的类名。
// 第一个页面用例长出来的 bar / tab-bar / field / editor / icon / markdown-body 都删了 —— 它们做的事
// GEML 本来就有办法说（列表 + 行内链接与图片、form-field select、view=source）。

import { stateClass } from "./layout.js";

/**
 * 状态存储。toggle 翻到哪个值 profile 没说：取 init-value 和所有 variant 的 when= 里
 * 为该状态点名的**那一个**别的值（设计 §12.7）；点名了零个或多个就惰性 —— 返回 null。
 */
export function createState(vm, dom) {
  const values = new Map();
  const named = new Map(); // state → Set(values named by when=)
  for (const s of vm.states) values.set(s.id, s.initValue ?? "");
  const bindings = vm.screens[0] ? vm.screens[0].bindings : vm.bindings;
  const withVariants = [...bindings, ...(vm.screens ?? []), ...(vm.frames ?? [])];
  for (const b of withVariants) for (const v of b.variants ?? []) {
    for (const [s, val] of Object.entries(v.when)) {
      if (s.startsWith("@")) continue; // @hover / @focus 是指针给的，不是这里管的状态
      if (!named.has(s)) named.set(s, new Set());
      named.get(s).add(val);
    }
  }
  const body = dom.body;
  const apply = (id, prev, next) => {
    if (!body) return;
    if (prev !== undefined && prev !== "") body.classList.remove(stateClass(id, prev));
    if (next !== "") body.classList.add(stateClass(id, next));
  };
  for (const [id, v] of values) apply(id, undefined, v);
  const listeners = new Set();
  return {
    namedValues: (id) => [...new Set([values.get(id), ...(named.get(id) ?? [])])].filter((v) => v !== undefined && v !== ""),
    get: (id) => values.get(id),
    set(id, v) {
      const prev = values.get(id);
      values.set(id, v);
      apply(id, prev, v);
      for (const fn of listeners) fn(id, v);
    },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    toggleTarget(id) {
      const init = vm.states.find((s) => s.id === id)?.initValue ?? "";
      const others = [...(named.get(id) ?? [])].filter((v) => v !== init);
      if (others.length !== 1) return null;
      return values.get(id) === init ? others[0] : init;
    },
  };
}

/** 哪个状态由这个块的这种交互喂：state 的 match 命中它（producersOf 只认 type#id / #id）。 */
export function producing(ctx, block, on) {
  if (!ctx.state || !block?.id) return null;
  const addr = `#${block.id}`;
  for (const s of ctx.vmStates ?? []) if (s.on === on && s.matchIds.has(addr)) return s.id;
  return null;
}

/**
 * 嵌套列表 → 可折叠的树：带子列表的条目包成 details/summary。缩进就是层级（§2.2），
 * 没有列名、没有缩进算术；折叠是原生的，零脚本。有子项 = 展开着（GitHub 也只下发展开
 * 目录的子项）。展开箭头是系统 ::marker，CSP 下它本来也引不了图。
 */
export function tree(block, params, ctx) {
  const dom = ctx.dom;
  const inner = ctx.renderBlock(block, dom, ctx.labels, ctx.byId);
  if (!inner) return null;
  inner.classList.add("geml-tree");
  for (const li of [...inner.querySelectorAll("li")]) {
    const sub = [...li.children].find((c) => c.tagName === "UL" || c.tagName === "OL");
    if (!sub) continue;
    const details = dom.createElement("details");
    details.setAttribute("open", "");
    const summary = dom.createElement("summary");
    while (li.firstChild && li.firstChild !== sub) summary.appendChild(li.firstChild);
    li.insertBefore(details, sub);
    details.appendChild(summary);
    details.appendChild(sub);
  }
  return inner;
}

/**
 * `form-field type=select` 画成一组分段按钮（一选多的另一副样子）。值仍是字段的值；
 * 它喂哪个状态由 style-state 说（`on=select`），和原生控件同一条接线。
 */
export function segments(block, params, ctx) {
  const dom = ctx.dom;
  const a = block?.attrs ?? {};
  const wrap = dom.createElement("div");
  wrap.className = "geml-segments";
  wrap.setAttribute("role", "group");
  if (block?.id) wrap.id = block.id;
  const ref = typeof a.options === "string" ? a.options.replace(/^#/, "") : "";
  const opts = ref && ctx.byId ? ctx.byId.get(ref) : null;
  const cols = opts?.table?.columns ?? [];
  const vi = cols.indexOf("value"), li = cols.indexOf("label");
  const stateId = producing(ctx, block, "select");
  let current = String(a.value ?? "");
  if (stateId) {
    const s = ctx.state.get(stateId);
    if (s) current = String(s); else if (current) ctx.state.set(stateId, current);
  }
  const buttons = [];
  const paint = () => { for (const b of buttons) b.setAttribute("aria-pressed", b.getAttribute("data-value") === current ? "true" : "false"); };
  for (const r of opts?.table?.rows ?? []) {
    const value = (r[vi >= 0 ? vi : 0]?.text ?? "").trim();
    const label = (r[li >= 0 ? li : (cols.length > 1 ? 1 : 0)]?.text ?? "").trim() || value;
    const btn = dom.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute("data-value", value);
    btn.addEventListener("click", () => { current = value; paint(); if (stateId) ctx.state.set(stateId, value); });
    buttons.push(btn);
    wrap.appendChild(btn);
  }
  paint();
  if (stateId && ctx.state.subscribe) ctx.state.subscribe((id, v) => { if (id === stateId) { current = String(v); paint(); } });
  return wrap;
}

/** codemap 播种的样式表把显示旋钮挂在 `component=code-graph` 上；旋钮由 graph-style 另行读取，这里照常画块。 */
function codeGraph(block, params, ctx) {
  return ctx.renderBlock(block, ctx.dom, ctx.labels, ctx.byId);
}

export const COMPONENTS = { tree, segments, "code-graph": codeGraph };
```

- [ ] **Step 4: 改 `layout.js` 的 `renderPage`**

（a）import 处去掉 `stateControl`：

```js
import { candidates, address } from "./parse-entry.js";
```
（`parse-entry.js` 若没导出 `blockSpans`，加一行 `export { blockSpans } from "../../../geml-parser/dist/geml.js";`，与文件里其它再导出同形；然后这里 `import { candidates, address, blockSpans } from "./parse-entry.js";`。）

（b）`renderPage` 开头，`const ctx = …` 改成：

```js
  // 源文本：`view=source` 要画块的原文。embed 的原文是借来那份文档的 text；宿主文档自己的块
  // 按 blockSpans 切行。都没有就退回块的 raw / text。
  const sources = new Map(corpus.filter((e) => typeof e.text === "string").map((e) => [e.path, e.text]));
  const hostText = sources.get(corpus[0]?.path);
  let spans = null;
  if (typeof hostText === "string") { try { spans = blockSpans(hostText); } catch { spans = null; } }
  const ctx = { dom, renderBlock, labels, state, model, vmStates, byId, corpus, sources, spans };

  const sourceOf = (node, docPath) => {
    if (node.kind === "block" && node.type === "embed") {
      const src = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
      const path = src.includes("#") ? src.slice(0, src.indexOf("#")) : src;
      const t = sources.get(path);
      if (typeof t === "string") return t;
    }
    const id = node.kind === "heading" || node.kind === "block" ? node.id : undefined;
    const span = id !== undefined && spans && docPath === corpus[0]?.path ? spans.get(id) : undefined;
    if (span && typeof hostText === "string") {
      const lines = hostText.split(/\r?\n/);
      return lines.slice(Math.max(0, span.start - 1), span.end).join("\n");
    }
    if (Array.isArray(node.raw)) return node.raw.join("\n");
    return typeof node.text === "string" ? node.text : "";
  };
```
（`Span` 的字段名以 `geml-parser/src/geml.ts` 的 `interface Span` 为准，1-based 行号；若是 0-based 或叫 `from/to`，照实改。）

（c）把容器里的触发接线抽成 `wireTrigger`，放在 `place` 之前：

```js
  /** 让一个元素成为某个 toggle 状态的触发者：可点、可键盘；只有驱动浮层的状态才「点别处关掉」。 */
  const wireTrigger = (el, trigger) => {
    if (!trigger || !state) return;
    el.setAttribute("data-triggers", trigger.id);
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    const flip = () => {
      const next = state.toggleTarget(trigger.id);
      if (next !== null) state.set(trigger.id, next);
    };
    const drivesOverlay = [...(vm.screens ?? []), ...(vm.frames ?? [])]
      .some((c) => (c.variants ?? []).some((v) => v.box?.layer === "overlay" && trigger.id in v.when));
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      flip();
      if (drivesOverlay && state.get(trigger.id) !== (trigger.initValue ?? "")) {
        const off = (ev) => {
          if (el.contains(ev.target)) return;
          if (ev.target.closest?.(`[data-opened-by="${trigger.id}"]`)) return;
          state.set(trigger.id, trigger.initValue ?? "");
          dom.removeEventListener("click", off, true);
        };
        dom.addEventListener("click", off, true);
      }
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
  };
```
容器里原来那一大段 `if (trigger && state) { … }` 换成 `wireTrigger(sec, ctx.vmStates.find((st) => st.on === "toggle" && st.matchIds?.has(`#${c.id}`)));`。

（d）`place` 在 `if (inner) wrap.appendChild(inner);` 之前/之后加四段：

```js
    // 块上的 axis：条目容器标出来，CSS（cssForPage）对它做 flex。第一个列表/表单就是最外层的那个。
    if (b && (b.box.axis !== undefined || (b.variants ?? []).some((v) => v.box?.axis !== undefined)) && inner) {
      const items = inner.matches?.("ul, ol, .geml-form") ? inner : inner.querySelector("ul, ol, .geml-form");
      if (items) items.classList.add("geml-items");
    }
    // 面：view=source 是另一副面孔，两副都画，CSS 按状态切显示。只有 rendered 时不包，DOM 和从前一样。
    const faces = b ? facesOf(b) : new Set(["rendered"]);
    if (faces.size > 1 || !faces.has("rendered")) {
      const rendered = dom.createElement("div");
      rendered.className = "geml-face geml-face-rendered";
      if (inner) rendered.appendChild(inner);
      wrap.appendChild(rendered);
      const text = sourceOf(node, doc);
      for (const f of faces) {
        if (f === "rendered") continue;
        const face = dom.createElement(f === "source-editable" ? "textarea" : "pre");
        face.className = `geml-face geml-face-${f} geml-source`;
        face.setAttribute("spellcheck", "false");
        face.textContent = text;
        wrap.appendChild(face);
      }
    } else if (inner) {
      wrap.appendChild(inner);
    }
    // 块当触发者（toggle）：点这一片，翻那个状态。
    wireTrigger(wrap, ctx.vmStates.find((st) => st.on === "toggle" && st.matchIds?.has(block)));
    // 字段喂状态（select）：控件的值就是状态；没 init-value 就用字段的 value=。segments 这类组件
    // 自己画按钮、自己接线，这里找不到原生控件就不重复接。
    const feeder = state ? ctx.vmStates.find((st) => st.on === "select" && st.matchIds?.has(block)) : null;
    const control = feeder ? wrap.querySelector("select, input, textarea") : null;
    if (feeder && control) {
      if ((state.get(feeder.id) ?? "") === "" && control.value) state.set(feeder.id, control.value);
      control.addEventListener("change", () => state.set(feeder.id, control.value));
      state.subscribe?.((id, v) => { if (id === feeder.id && control.value !== v) control.value = v; });
    }
```
（原来的 `if (inner) wrap.appendChild(inner);` 删掉，由上面的 else 分支承担。）`import { facesOf } …` 不需要 —— 它就在本文件里。

（e）`$state` 槽位：容器里 `slot.kind === "state"` 那段改成只放占位：

```js
      } else if (slot.kind === "state") {
        // profile §2.4：渲染那个块引用状态指向的块。这一版没有块引用状态的用例，先放占位；
        // 不再画开关 —— 折叠按钮是文档里的一个块（一张图）当触发者，不是宿主编的 ☰。
        const holder = dom.createElement("div");
        holder.className = "geml-slot-state";
        holder.setAttribute("data-state", slot.state);
        sec.appendChild(holder);
```

（f）`content.js`：`loadPageStyle` 之后、`paintPage` 之前加一行 `if (page && page.corpus[0]) page.corpus[0].text = raw;`（`raw` 是该文件里已有的页面原文变量）。

- [ ] **Step 5: `geml.css` 257–355 行整段替换**

```css
/* ---- 页面布局（geml-style）。只有容器的 flex 与几条不带任何色值、尺寸的通用规则：
   颜色、间距、字号全部来自样式表（cssForPage 生成）。注入页面的 CSS 不得加载任何资源。 */
.geml-page { margin: 0; }
.geml-frame { display: flex; min-width: 0; min-height: 0; position: relative; }
.geml-frame[data-axis="column"] { flex-direction: column; }
.geml-frame[data-axis="row"] { flex-direction: row; align-items: stretch; }
.geml-frame[data-axis="row"] > .geml-placed { flex: 0 0 auto; }
.geml-placed { min-width: 0; box-sizing: border-box; }
.geml-placed[role="button"], .geml-frame[role="button"] { cursor: pointer; }
.geml-page button { color: inherit; font: inherit; }
.geml-page a { color: inherit; text-decoration: none; }
.geml-page img { vertical-align: middle; }
.geml-items > li { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.geml-tree summary { cursor: pointer; }
.geml-segments { display: inline-flex; }
.geml-segments button { border: 0; background: none; cursor: pointer; }
.geml-segments button[aria-pressed="true"] { background: Canvas; font-weight: 500; }
.geml-source { width: 100%; box-sizing: border-box; min-height: 60vh; font-family: ui-monospace, monospace; }
.geml-page .geml-form-control { font: inherit; color: inherit; background: transparent; border: 0; outline: none; width: 100%; }
```
（`geml-form/v1` 控件那段 292–303 是文档内表单的样子，保留在页面段之前，不动；上面最后一行只在整页布局里把控件的默认边框去掉，边框由样式表的 frame 给。）

- [ ] **Step 6: 跑，确认通过；再跑 security 套件**

```bash
node build.mjs && node test/layout.test.mjs && node test/security.test.mjs
```
Expected: 全部 ok。若 `security.test.mjs` 引用了 `bar`/`field`/`icon`，把那条改成走部件路径（文档里的 `[x](javascript:…)` 已由 render.js 的 `isSafeHref` 拦，安全套件已有同类用例）。

- [ ] **Step 7: Commit**

```bash
git add integrations/geml-viewer/src/layout.js integrations/geml-viewer/src/components.js integrations/geml-viewer/src/content.js integrations/geml-viewer/src/parse-entry.js integrations/geml-viewer/src/geml.css integrations/geml-viewer/test/layout.test.mjs integrations/geml-viewer/test/security.test.mjs
git commit -m "feat(viewer): page chrome is lists and fields — tree and segments stay, seven page components go, host CSS loses its palette"
```

---

## Task 14：GEML 文件 —— 复刻页改成列表承载

**Files:**
- Rewrite: `C:/tmp/blob/page.geml`
- Rewrite: `C:/tmp/blob/_index/github.style.geml`
- Create: `C:/tmp/blob/icons/dot.svg`
- Test: `node scratchpad/render-real.mjs C:/tmp/blob/rendered.html`（零诊断、全部落位）；浏览器看一次

- [ ] **Step 1: `icons/dot.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#0969da"/></svg>
```

- [ ] **Step 2: `page.geml`**

```
=== meta
title = "Publishing — what ships, where it lands, and how to know it did"
profile = "geml-form/v1"
source = "1:1 复刻实验（第二版）：外壳是列表与行内链接，样式表只用内含词"
===

%% ——— 页面外壳。每个块有 id，可以单独 `geml get`；条目是 GEML 行内：图片、链接、代码。
%% 提示语是链接/图片的 {title=}；计数是行内代码；未读点是一张 8px 的 SVG。

=== text {#brand}
- ![Open menu](icons/three-bars.svg)
- [![](icons/mark-github.svg)](https://github.com/){title="GitHub"}
- [geml-spec](https://github.com/geml-spec)
- /
- [geml](https://github.com/geml-spec/geml)
- ![Switch repository](icons/triangle-down.svg){width=12}
===

=== text {#search-icon}
![Open quick search dialog, type / to search](icons/search.svg){width=14}
===

=== form-field {#site-search type=text placeholder="Type / to search"}
===

=== text {#search-key}
`/`
===

=== text {#top-ai}
- [![](icons/copilot.svg)](https://github.com/copilot){title="Chat with Copilot"}
===

=== text {#ai-caret}
![Open Copilot…](icons/triangle-down.svg){width=12}
===

=== text {#ai-menu}
- [Ask Copilot](https://github.com/copilot)
- [Copilot Chat](https://github.com/copilot)
- Copilot Workspace
===

=== text {#top-nav}
- [![](icons/plus.svg) ![](icons/triangle-down.svg){width=12}](https://github.com/new){title="Create new..."}
- [![](icons/issue-opened.svg)](https://github.com/issues){title="All issues"}
- [![](icons/git-pull-request.svg)](https://github.com/pulls){title="All pull requests"}
- [![](icons/repo.svg)](https://github.com/repos){title="All repositories"}
- [![](icons/inbox.svg)](https://github.com/notifications){title="Notifications"} ![unread](icons/dot.svg)
- [![](icons/avatar.svg)](https://github.com/xiongjy2104){title="Open user navigation menu"}
===

=== text {#repo-nav}
- ![](icons/code.svg) [Code](https://github.com/geml-spec/geml)
- ![](icons/issue-opened.svg) [Issues](https://github.com/geml-spec/geml/issues) `1`
- ![](icons/git-pull-request.svg) [Pull requests](https://github.com/geml-spec/geml/pulls)
- ![](icons/agent.svg) [Agents](https://github.com/geml-spec/geml/agents?author=xiongjy2104)
- ![](icons/comment-discussion.svg) [Discussions](https://github.com/geml-spec/geml/discussions)
- ![](icons/play.svg) [Actions](https://github.com/geml-spec/geml/actions)
- ![](icons/table.svg) [Projects](https://github.com/geml-spec/geml/projects)
- ![](icons/book.svg) [Wiki](https://github.com/geml-spec/geml/wiki)
- ![](icons/shield.svg) [Security](https://github.com/geml-spec/geml/security)
- ![](icons/graph.svg) [Insights](https://github.com/geml-spec/geml/pulse)
- ![](icons/gear.svg) [Settings](https://github.com/geml-spec/geml/settings)
- More ![](icons/triangle-down.svg){width=12}
===

=== text {#side-toggle}
![Collapse file tree](icons/sidebar-expand.svg)
===

=== text {#side-head}
- ![](icons/file-directory-fill.svg) [Files](https://github.com/geml-spec/geml/tree/title-projection)
===

=== text {#side-back}
[![](icons/chevron-left.svg){width=14}](https://github.com/geml-spec/geml/blob/main/docs/PUBLISHING.md){title="View file on default branch"}
===

=== text {#branch-icon}
![title-projection branch](icons/git-branch.svg){width=14}
===

=== form-options {#branches format=csv}
value,label
title-projection,title-projection
main,main
===

=== form-field {#branch type=select options=#branches value=title-projection}
===

=== text {#side-tools}
- [![](icons/plus.svg){width=14}](https://github.com/geml-spec/geml/new/title-projection/docs){title="Add file"}
- ![Search this repository](icons/search.svg){width=14}
===

=== text {#find-icon}
![Go to file](icons/search.svg){width=14}
===

=== form-field {#file-find type=text placeholder="Go to file"}
===

=== text {#find-key}
`T`
===

=== text {#file-tree}
- ![](icons/file-directory-fill.svg) [.agents](https://github.com/geml-spec/geml/tree/title-projection/.agents)
- ![](icons/file-directory-fill.svg) [.claude-plugin](https://github.com/geml-spec/geml/tree/title-projection/.claude-plugin)
- ![](icons/file-directory-fill.svg) [.claude](https://github.com/geml-spec/geml/tree/title-projection/.claude)
- ![](icons/file-directory-fill.svg) [.github](https://github.com/geml-spec/geml/tree/title-projection/.github)
- ![](icons/file-directory-open-fill.svg) [docs](https://github.com/geml-spec/geml/tree/title-projection/docs)
  - ![](icons/file-directory-fill.svg) [assets](https://github.com/geml-spec/geml/tree/title-projection/docs/assets)
  - ![](icons/file-directory-fill.svg) [benchmarks](https://github.com/geml-spec/geml/tree/title-projection/docs/benchmarks)
  - ![](icons/file-directory-fill.svg) [comparisons](https://github.com/geml-spec/geml/tree/title-projection/docs/comparisons)
  - ![](icons/file-directory-fill.svg) [design](https://github.com/geml-spec/geml/tree/title-projection/docs/design)
  - ![](icons/file-directory-fill.svg) [illustrated](https://github.com/geml-spec/geml/tree/title-projection/docs/illustrated)
  - ![](icons/file.svg) [MANIFESTO.geml](https://github.com/geml-spec/geml/blob/title-projection/docs/MANIFESTO.geml)
  - ![](icons/file.svg) [MANIFESTO.md](https://github.com/geml-spec/geml/blob/title-projection/docs/MANIFESTO.md)
  - ![](icons/file.svg) [MANIFESTO_CN.geml](https://github.com/geml-spec/geml/blob/title-projection/docs/MANIFESTO_CN.geml)
  - ![](icons/file.svg) [MANIFESTO_CN.md](https://github.com/geml-spec/geml/blob/title-projection/docs/MANIFESTO_CN.md)
  - ![](icons/file.svg) [PUBLISHING.geml](https://github.com/geml-spec/geml/blob/title-projection/docs/PUBLISHING.geml)
  - ![](icons/file.svg) [PUBLISHING.md](https://github.com/geml-spec/geml/blob/title-projection/docs/PUBLISHING.md)
  - ![](icons/file.svg) [PUBLISHING_CN.geml](https://github.com/geml-spec/geml/blob/title-projection/docs/PUBLISHING_CN.geml)
  - ![](icons/file.svg) [PUBLISHING_CN.md](https://github.com/geml-spec/geml/blob/title-projection/docs/PUBLISHING_CN.md)
  - ![](icons/file.svg) [WRITING-A-PARSER.md](https://github.com/geml-spec/geml/blob/title-projection/docs/WRITING-A-PARSER.md)
  - ![](icons/file.svg) [WRITING-A-PARSER_CN.md](https://github.com/geml-spec/geml/blob/title-projection/docs/WRITING-A-PARSER_CN.md)
  - ![](icons/file.svg) [mcp-guide.md](https://github.com/geml-spec/geml/blob/title-projection/docs/mcp-guide.md)
  - ![](icons/file.svg) [mcp-guide_CN.md](https://github.com/geml-spec/geml/blob/title-projection/docs/mcp-guide_CN.md)
- ![](icons/file-directory-fill.svg) [geml-parser](https://github.com/geml-spec/geml/tree/title-projection/geml-parser)
- ![](icons/file-directory-fill.svg) [integrations](https://github.com/geml-spec/geml/tree/title-projection/integrations)
- ![](icons/file-directory-fill.svg) [playground](https://github.com/geml-spec/geml/tree/title-projection/playground)
- ![](icons/file-directory-fill.svg) [site](https://github.com/geml-spec/geml/tree/title-projection/site)
- ![](icons/file-directory-fill.svg) [spec](https://github.com/geml-spec/geml/tree/title-projection/spec)
- ![](icons/file.svg) [.gitattributes](https://github.com/geml-spec/geml/blob/title-projection/.gitattributes)
- ![](icons/file.svg) [.gitignore](https://github.com/geml-spec/geml/blob/title-projection/.gitignore)
- ![](icons/file.svg) [CHANGELOG.md](https://github.com/geml-spec/geml/blob/title-projection/CHANGELOG.md)
- ![](icons/file.svg) [CODE_OF_CONDUCT.md](https://github.com/geml-spec/geml/blob/title-projection/CODE_OF_CONDUCT.md)
- ![](icons/file.svg) [CONTRIBUTING.md](https://github.com/geml-spec/geml/blob/title-projection/CONTRIBUTING.md)
- ![](icons/file.svg) [GOVERNANCE.md](https://github.com/geml-spec/geml/blob/title-projection/GOVERNANCE.md)
- ![](icons/file.svg) [LICENSE](https://github.com/geml-spec/geml/blob/title-projection/LICENSE)
- ![](icons/file.svg) [README.md](https://github.com/geml-spec/geml/blob/title-projection/README.md)
- ![](icons/file.svg) [README_CN.md](https://github.com/geml-spec/geml/blob/title-projection/README_CN.md)
- ![](icons/file.svg) [SECURITY.md](https://github.com/geml-spec/geml/blob/title-projection/SECURITY.md)
- ![](icons/file.svg) [gemini-extension.json](https://github.com/geml-spec/geml/blob/title-projection/gemini-extension.json)
- ![](icons/file.svg) [kimi.plugin.json](https://github.com/geml-spec/geml/blob/title-projection/kimi.plugin.json)
===

=== text {#breadcrumb}
[geml](https://github.com/geml-spec/geml/tree/title-projection) / [docs](https://github.com/geml-spec/geml/tree/title-projection/docs) / **PUBLISHING.md** ![Copy path](icons/copy.svg)
===

=== text {#commit-left}
[![](icons/avatar.svg){width=20}](https://github.com/geml-spec/geml/commits?author=xiongjy2104){title="commits by xiongjy2104"} [xiongjy2104](https://github.com/xiongjy2104) [feat(projection): the meta title is the h1 in --to md and --to html; …](https://github.com/geml-spec/geml/commit/b8475ea7f9b7c89887c457c066a3ace01f82fd64) ![Open commit details](icons/ellipsis.svg)
===

=== text {#commit-right}
[b8475ea · 1 hour ago](https://github.com/geml-spec/geml/commit/b8475ea7f9b7c89887c457c066a3ace01f82fd64){title="Commit b8475ea"} ![](icons/history.svg) [History](https://github.com/geml-spec/geml/commits/title-projection/docs/PUBLISHING.md){title="History"}
===

=== form-options {#views format=csv}
value,label
Preview,Preview
Code,Code
Blame,Blame
===

=== form-field {#view type=select options=#views value=Preview}
===

=== text {#file-meta}
380 lines (332 loc) · 26.8 KB
===

=== text {#file-actions}
- [![](icons/space.svg)](https://github.com/geml-spec/geml/spaces){title="Add to space"}
- [![](icons/copilot.svg)](https://github.com/copilot){title="Ask Copilot about this file"}
- [Raw](https://github.com/geml-spec/geml/raw/refs/heads/title-projection/docs/PUBLISHING.md)
- ![Copy raw file](icons/copy.svg)
- [![](icons/download.svg)](https://github.com/geml-spec/geml/raw/refs/heads/title-projection/docs/PUBLISHING.md){title="Download raw file"}
- [![](icons/pencil.svg)](https://github.com/geml-spec/geml/edit/title-projection/docs/PUBLISHING.md){title="Edit this file"}
- ![More edit options](icons/triangle-down.svg){width=12}
- ![Outline](icons/list-unordered.svg)
===

=== embed {#doc src="PUBLISHING.geml"}
===
```

- [ ] **Step 3: `_index/github.style.geml`**

```
=== meta
profile = "geml-style/v1"
title = "GitHub blob page"
source = "数值抄自 1.mhtml：侧栏 260px、正文列 1012px、亮色 #ffffff/#f6f8fa/#1f2328/#59636e/#d1d9e0，链接 #0969da。样式表只用内含词，0 个私有键"
===

%% ---------------------------------------------------------------- 骨架
=== style-screen {#page axis=column background="#ffffff" color="#1f2328" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans, Helvetica, Arial, sans-serif" font-size=14px slots="#topbar, text#repo-nav, #body"}
===
=== style-frame {#topbar axis=row gap=16px padding="8px 16px" background="#f6f8fa" border-bottom="1px solid #d1d9e0" slots="text#brand, #search, #ai, text#top-nav"}
===
=== style-frame {#search axis=row gap=6px grow=yes max-width=320px padding="4px 8px" border="1px solid #d1d9e0" border-radius=6px background="#ffffff" slots="text#search-icon, form-field#site-search, text#search-key"}
===
=== style-frame {#ai axis=row margin="0 0 0 auto" slots="text#top-ai, text#ai-caret, #ai-menu"}
===
=== style-frame {#ai-menu axis=column visible=no slots="text#ai-menu"}
===
=== style-frame {#body axis=row gap=16px padding=16px slots="#side, #main"}
===
=== style-frame {#side axis=column gap=8px width=260px hide-below=1012 slots="#side-bar, #side-body"}
===
=== style-frame {#side-bar axis=row gap=8px slots="text#side-toggle, text#side-head"}
===
=== style-frame {#side-body axis=column gap=8px slots="#branch-row, #find, text#file-tree"}
===
=== style-frame {#branch-row axis=row gap=4px slots="text#side-back, #branch, text#side-tools"}
===
=== style-frame {#branch axis=row gap=4px grow=yes padding="3px 8px" border="1px solid #d1d9e0" border-radius=6px font-size=12px slots="text#branch-icon, form-field#branch"}
===
=== style-frame {#find axis=row gap=6px padding="4px 8px" border="1px solid #d1d9e0" border-radius=6px font-size=12px slots="text#find-icon, form-field#file-find, text#find-key"}
===
=== style-frame {#main axis=column gap=8px grow=yes slots="text#breadcrumb, #commitrow, #card"}
===
=== style-frame {#commitrow axis=row gap=16px padding="8px 16px" background="#f6f8fa" border="1px solid #d1d9e0" border-radius=6px slots="text#commit-left, text#commit-right"}
===
=== style-frame {#card axis=column grow=yes border="1px solid #d1d9e0" border-radius=6px slots="#cardbar, #doc-body"}
===
=== style-frame {#cardbar axis=row gap=16px padding="8px 16px" background="#f6f8fa" border-bottom="1px solid #d1d9e0" slots="form-field#view, text#file-meta, text#file-actions"}
===
=== style-frame {#doc-body axis=column grow=yes padding="0 32px 32px" slots="embed#doc"}
===

%% ---------------------------------------------------------------- 状态
%% 折叠按钮、下拉箭头都是文档里的一个块（一张图），块当触发者；Tab 是 select 字段，值就是状态。
=== style-state {#sidebar type=scalar match="text#side-toggle" on=toggle init-value=open}
===
=== style-state {#aimenu type=scalar match="text#ai-caret" on=toggle init-value=closed}
===
=== style-state {#tab type=scalar match="form-field#view" on=select}
===

%% ---------------------------------------------------------------- 顶栏
=== style-rule {#brand match="text#brand" axis=row gap=8px}
===
=== style-rule {#brand-link match="text#brand link" color="#1f2328" padding="4px 6px" border-radius=6px}
===
=== style-rule {#brand-hover match="text#brand link" when="@hover" background="#eaeef2"}
===
=== style-rule {#brand-icon match="text#brand image" width=16px}
===
=== style-rule {#search-icon match="text#search-icon image" width=14px}
===
=== style-rule {#search-key match="text#search-key code-span" border="1px solid #d1d9e0" border-radius=4px padding="0 5px" color="#59636e" font-size=12px background="transparent"}
===
=== style-rule {#top-ai match="text#top-ai" axis=row}
===
=== style-rule {#top-ai-link match="text#top-ai link" padding="4px 6px" border-radius="6px 0 0 6px" border="1px solid #d1d9e0"}
===
=== style-rule {#ai-caret match="text#ai-caret" padding="8px 4px" border="1px solid #d1d9e0" border-left="0" border-radius="0 6px 6px 0"}
===
=== style-rule {#ai-menu-open match="#ai-menu" when="$aimenu=open" visible=yes layer=overlay padding=4px background="#ffffff" border="1px solid #d1d9e0" border-radius=6px width=220px}
===
=== style-rule {#ai-menu-items match="text#ai-menu" axis=column gap=2px}
===
=== style-rule {#ai-menu-link match="text#ai-menu link" color="#1f2328" padding="6px 8px" border-radius=6px}
===
=== style-rule {#ai-menu-hover match="text#ai-menu link" when="@hover" background="#eaeef2"}
===
=== style-rule {#top-nav match="text#top-nav" axis=row gap=8px border-left="1px solid #d1d9e0" padding="0 0 0 16px"}
===
=== style-rule {#top-nav-link match="text#top-nav link" color="#59636e" padding="4px 6px" border="1px solid #d1d9e0" border-radius=6px}
===
=== style-rule {#top-nav-hover match="text#top-nav link" when="@hover" background="#eaeef2"}
===
=== style-rule {#top-nav-icon match="text#top-nav image" width=16px}
===

%% ---------------------------------------------------------------- 仓库导航
=== style-rule {#repo-nav match="text#repo-nav" axis=row gap=8px padding="4px 16px" border-bottom="1px solid #d1d9e0"}
===
=== style-rule {#repo-nav-link match="text#repo-nav link" color="#59636e" padding="6px 8px" border-radius=6px}
===
=== style-rule {#repo-nav-hover match="text#repo-nav link" when="@hover" background="#eaeef2" color="#1f2328"}
===
=== style-rule {#repo-nav-icon match="text#repo-nav image" width=16px}
===
=== style-rule {#repo-nav-badge match="text#repo-nav code-span" background="#eff2f5" color="#59636e" border-radius=999px padding="0 6px" font-size=12px}
===

%% ---------------------------------------------------------------- 侧栏
=== style-rule {#side-toggle match="text#side-toggle" padding="4px 6px" border="1px solid #d1d9e0" border-radius=6px}
===
=== style-rule {#side-head match="text#side-head" axis=row gap=6px}
===
=== style-rule {#side-head-link match="text#side-head link" color="#1f2328"}
===
=== style-rule {#side-back-link match="text#side-back link" color="#59636e" padding="4px 6px" border-radius=6px}
===
=== style-rule {#side-tools match="text#side-tools" axis=row gap=4px color="#59636e"}
===
=== style-rule {#find-icon match="text#find-icon image" width=14px}
===
=== style-rule {#find-key match="text#find-key code-span" border="1px solid #d1d9e0" border-radius=4px padding="0 5px" color="#59636e" font-size=12px background="transparent"}
===
=== style-rule {#tree match="text#file-tree" component=tree sticky=0 scroll=own padding=8px line-height=28px}
===
=== style-rule {#tree-link match="text#file-tree link" color="#1f2328"}
===
=== style-rule {#tree-hover match="text#file-tree link" when="@hover" color="#0969da"}
===
=== style-rule {#tree-icon match="text#file-tree image" width=16px}
===
%% 收起：内容那一片不显示，侧栏缩到只剩按钮，Files 那行也一起收
=== style-rule {#side-closed match="#side-body" when="$sidebar=closed" visible=no}
===
=== style-rule {#side-narrow match="#side" when="$sidebar=closed" width=auto}
===
=== style-rule {#side-head-off match="text#side-head" when="$sidebar=closed" visible=no}
===

%% ---------------------------------------------------------------- 正文列
=== style-rule {#crumb match="text#breadcrumb" font-size=16px}
===
=== style-rule {#crumb-link match="text#breadcrumb link" color="#0969da"}
===
=== style-rule {#crumb-hover match="text#breadcrumb link" when="@hover" color="#0969da" background="#eaeef2"}
===
=== style-rule {#commit-left match="text#commit-left" font-size=14px}
===
=== style-rule {#commit-left-link match="text#commit-left link" color="#1f2328"}
===
=== style-rule {#commit-left-hover match="text#commit-left link" when="@hover" color="#0969da"}
===
=== style-rule {#commit-right match="text#commit-right" font-size=12px color="#59636e" margin="0 0 0 auto"}
===
=== style-rule {#commit-right-link match="text#commit-right link" color="#59636e"}
===
=== style-rule {#commit-right-hover match="text#commit-right link" when="@hover" color="#0969da"}
===
=== style-rule {#view match="form-field#view" component=segments border="1px solid #d1d9e0" border-radius=6px background="#f6f8fa" padding=2px font-size=14px}
===
=== style-rule {#meta match="text#file-meta" font-size=12px color="#59636e"}
===
=== style-rule {#file-actions match="text#file-actions" axis=row gap=4px color="#59636e" margin="0 0 0 auto"}
===
=== style-rule {#file-actions-link match="text#file-actions link" color="#59636e" padding="4px 6px" border-radius=6px}
===
=== style-rule {#file-actions-hover match="text#file-actions link" when="@hover" background="#eaeef2" color="#1f2328"}
===
=== style-rule {#file-actions-icon match="text#file-actions image" width=16px}
===
=== style-rule {#doc match="embed#doc" view=rendered max-width=1012px font-size=16px line-height=24px color="#1f2328"}
===
=== style-rule {#doc-code match="embed#doc" when="$tab=Code" view=source editable=yes}
===
=== style-rule {#doc-blame match="embed#doc" when="$tab=Blame" view=source}
===
```

- [ ] **Step 4: 渲染、检查、看一次**

```bash
node "C:/agentProjects/geml-spec/geml-parser/dist/cli.js" check C:/tmp/blob/page.geml
node "C:/agentProjects/geml-spec/geml-parser/dist/cli.js" style check C:/tmp/blob/_index/github.style.geml C:/tmp/blob/page.geml C:/tmp/blob/PUBLISHING.geml --components=tree,segments,code-graph
cd "C:/Users/george/AppData/Local/Temp/claude/C--agentProjects-geml-spec/1e2b6639-90ef-4e82-8e52-fee0f59ce3fb/scratchpad" && node render-real.mjs C:/tmp/blob/rendered.html
```
Expected：`check` 无诊断；`style check` 零 error（`form-options` 未被槽位放置不是诊断）；render 输出 `横幅: (无)`、`放置的块` 含 `#brand … #doc`；`rendered.html` 里 `grep -c 'title='` ≥ 28、`grep -c '<a '` ≥ 80。宿主 CSS：`grep -c '#[0-9a-fA-F]\{3,6\}' src/geml.css` 在 257 行之后为 0。浏览器（`http://localhost:8181/rendered.html`）截一张图核对五行外壳与侧栏树。若 `render-real.mjs` 的 `page.corpus[0].text` 未被设置（脚本绕过 content.js 的那一行），在脚本里等价补上。

- [ ] **Step 5: 记录**

`scratchpad/build-both.mjs` 作废，不再生成（文件直接维护）。不 commit（`C:/tmp/blob` 不在仓库里）。

---

## Task 15：文档 —— profile、设计文档、图解、GEP-0011 待办

**Files:**
- Modify: `spec/profiles/geml-style/geml-style-profile.md`、`spec/profiles/geml-style/geml-style-profile_CN.md`
- Modify: `docs/design/specs/2026-08-29-geml-style-design.md` §13（§13.4f 影响面更正）
- Modify: `docs/design/specs/2026-08-29-geml-style-design.md`（状态行加一句指向本设计）
- Modify: `docs/illustrated/10-profile-style.html`、`docs/illustrated/10-profile-style_CN.html`（看板加第二个用例的条目）
- Modify: `spec/proposals/0011-inner-unit-coordinates.md`（若有 Open questions / Deferred 节，加一条；否则不动，待办已在设计文档 §12）

- [ ] **Step 1: profile 英文**

§2.1 属性表：`| *any other key* | no | passed through **verbatim** as a component parameter — except the built-in words below |` 改为 `| *any other key* | no | with `component=`: passed through **verbatim** as a component parameter; without one: `style-unknown-attribute` (warning) — except the built-in words below |`。`| when= |` 那行改为 `| `when=` | no | `$state=value` terms and the built-in `@hover` / `@focus`, comma-separated, all must hold; equality only (§4) |`。

内含词表加三行：

```
| `axis` | `row` \| `column` (default `column`) | `style-screen` / `style-frame`, and a block: its items run along that axis (a list laid out in a row draws no markers) |
| `view` | `rendered` \| `source` (default `rendered`) | blocks: show the block, or its source text |
| `editable` | `yes` \| `no` (default `no`) | blocks under `view=source`: the source may be edited in place; inert otherwise. Nothing here says where an edit goes — a host without a write path shows a scratch textarea |
```
（删掉原来的 `| axis | … | style-screen / style-frame |` 那行。）

§2.1 末段 `The pass-through is the reason a rule has no style-unknown-attribute check…` 改为：

```
A rule passes unrecognized keys through only when it names a `component=` — the
component's own vocabulary (`selectable`, `badge="leaf"`, `collapsed`) is not the
profile's to rule on. A rule with no `component=` has nothing to receive them, so an
unrecognized key there is `style-unknown-attribute`, exactly as on a container. The
reserved names above plus the built-in words are the complete list of keys the profile
itself consumes.

**Inline parts.** A rule whose selector ends in a part step (§3) dresses one kind of
inline inside the matched blocks. Only words that mean something on a run of text are
taken there — `color` `background` `padding` `margin` `border`(-side) `border-radius`
`font-size` `line-height` `font-family` `width` `max-width` `visible`; any other
built-in word on a part rule is `style-unknown-attribute`.
```

§2.2 `on=` 那行之后加一句段落：`A `form-field` producer under `on=select` feeds the control's own value; with no `init-value=` the state starts at the field's `value=`.`

§3 语法块加一行 `text#nav link                                        inline part: last step only, after a block step`，段落加：

```
A selector may end in an **inline part** — `link`, `image`, `code-span`, `strong`,
`emphasis` — naming one kind of inline inside the matched blocks (`text#nav link`). The
names are §5.1's own (`code` is a block type already, so the span is `code-span`). A
part step must be last, must follow a block step, takes no `#id`/`.class`/`[attr]`, and
a `match=` may not mix part branches with block branches. `*` and block selectors never
match parts. A slot never places a part.
```
拒绝表 `:hover` 那行改为 `| `:hover` `:nth-child(…)` | state/position pseudo-classes — pointer state is `when="@hover"`, not a selector |`。

§8 目录：`selector-unsupported`、`style-invalid-value`、`style-unknown-attribute` 三行的 meaning 各补上新情形（部件步位置/裸部件/混分支；`view`/`editable`/`@` 域外；无 `component=` 的 rule 未知键、部件规则上的块词）。

§10 视图模型：binding 形状改为 `{doc, block, part?, rules, params, box, variants}`，加一句 `part` 的说明；`variants[].when` 说明加 `@hover`/`@focus` 键值恒为 `"true"`。

§12 版本：加一条 `2026-09-10 — second real page: inline parts, axis on blocks, view/editable, @hover/@focus, rule pass-through only with component=.`

- [ ] **Step 2: profile 中文**

`geml-style-profile_CN.md` 同节同改动，措辞对应。

- [ ] **Step 3: 设计文档**

设计文档 §13.4f「影响面」段改为：`codemap 播种的样式表（graph-style.ts 的 serializeGraphStyle）原来不带 component=，本次给种子加 component=code-graph，viewer 注册同名透传组件；已经播种在用户仓库里的旧文件会得到四条 style-unknown-attribute warning（fold/depth/hide-accessors/palette），旋钮照常读取、渲染不受影响；build 不改写它，用户改一行即可。` 并在 §13.1 表下加一句指向本计划第二轮的注。

设计文档状态行末尾加一句：**2026-09-10** 第二个用例（外壳归位）把 §12.3 圈死的清单再动一次，见 §13。

- [ ] **Step 4: 图解**

`docs/illustrated/10-profile-style_CN.html` 看板表末尾加两行（编号接 18、19）：
- 18：`第二个用例（2026-09-10）：选择器可以以行内部件收尾（link image code-span strong emphasis）；内含词多 axis（块上）、view、editable；when= 认 @hover @focus；无 component= 的 rule 出现未知键报 style-unknown-attribute。判据仍是 §12.3「换个块还是不是这个意思」。` 出处 `设计文档 §13.4` 状态 `规范已定`。
- 19：`实测：GitHub blob 复刻页外壳全部改为 text 块里的列表 + 行内链接后零诊断；viewer 组件 7 → 2，宿主 CSS 页面段色值 22 → 0，样式表私有键 10 → 0。` 出处 `render-real` 状态 `实测`。
英文页同样两行；两页顶部 tally 的数字随之更新。

- [ ] **Step 5: GEP-0011**

读 `spec/proposals/0011-inner-unit-coordinates.md`，若有 "Open questions" / "Deferred" / "Not in this proposal" 一类小节，加一条：`- **List items as inner units.** `#nav[5]` for the fifth item of the list in block `nav`, `[2][1]` for a nested item; `get`/`set` as for table rows. Motivated by geml-style's second page (2026-09-10), where page chrome moved from tables into lists and lost per-item addressing.` 没有这样的小节就不动（待办已在设计文档 §12）。

- [ ] **Step 6: Commit**

```bash
git add spec/profiles/geml-style docs/design docs/illustrated/10-profile-style.html docs/illustrated/10-profile-style_CN.html spec/proposals/0011-inner-unit-coordinates.md
git commit -m "docs(style): the second page — inline parts, axis on blocks, view/editable, @hover, and the rule pass-through only with component="
```

---

## Task 16：全量验证一次

- [ ] **Step 1: 解析器全量 + 覆盖率闸（一次）**

```bash
cd geml-parser && npm run coverage:check 2>&1 | tail -30; echo EXIT=$?
```
Expected: 全部 ok，闸 95 通过。

- [ ] **Step 2: viewer 全量 + 覆盖率闸（一次）**

```bash
cd integrations/geml-viewer && npm run coverage:check 2>&1 | tail -30; echo EXIT=$?
```
Expected: 全部 ok，闸 85/85/90/75 通过。若 components.js 因删代码而覆盖率变化，只加测试、不降闸。

- [ ] **Step 3: bundle 不含远程代码串**

```bash
grep -c "cdn.jsdelivr" integrations/geml-viewer/dist/viewer.bundle.js
```
Expected: 0。

- [ ] **Step 4: 汇报**

列出：每个 Task 的 commit；复刻页的实测（诊断、链接数、提示语数、宿主 CSS 色值数）；四处刻意的不像；GEP-0011 待办落在哪。**不 push**（用户自己决定；推送前用户会改 commit 消息）。
