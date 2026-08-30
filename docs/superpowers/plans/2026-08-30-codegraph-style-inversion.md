# geml-code-graph 反转控制（计划 D）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `geml-code-graph` 的展示决策从一份可编辑的 GEML 文档里读，而不是写死在渲染器里——**不替换渲染器，只反转控制权**。

**Architecture:** 新增 `_index/style.geml`，与既有的 `_index/foldings.geml` 并列：一个管构建期折叠、一个管显示期展示。`src/graph-style.ts` 负责解析与播种（镜像 `codemap/foldings.mjs` 的四函数接口），`render.ts` 把解析结果随 `data-graph` 一起送进页面，浏览器运行时读它而不是字面量。

**Tech Stack:** TypeScript（`tsc` → `dist/`）、`.test.mjs` + `node:assert`、`c8` 闸门。

**分支：** `feat/geml-style`。

---

## 为什么是反转而不是替换

量过：`codeGraphJs` 编译后 **1508 行 / 79 KB**，加服务端数据收集数百行；spike 全部约 300 行。
`codemap.test.mjs` 有 **118 个测试**，另有 13 个测试文件引用 code-graph。
而"没对上"的九项恰是难的那部分：布局、缩放、方法搜索、⊕ 完整调用链、cross-stack。

**并且 `codeGraphRuntime` 开头就是同源限制**，注释写明防的是
"a crafted codemap doc could aim a fetch / HEAD probe / `<script src>` at a third-party
host (silent beacon, SSRF, or remote-code load)"，配套整个 `sec-codemap.test.mjs`。
替换意味着这些安全工作要重新挣一遍。反转不动它一行。

真正要的是"调展示不必通用"，而反转就能给到——`depth` 已经证明这条路走得通
（它本来就来自 `graph-depth` meta，codemap 给建议、渲染器执行）；缺的只是让第三方也能给建议。

## 为什么样式表放在 `_index/style.geml`

- **零规范改动、零词汇改动。** 不需要给 `diagram` 加 `style=` 属性，
  也就不会把刚从核心里收回去的东西又塞回去（计划 C）。
- **精确镜像既有先例。** `_index/foldings.geml` 的文件头自己写着
  "Seeded on first build; edit freely — build never rewrites this"。
  「拿一份 GEML 文档当调节面」这个做法仓库里早就有了，只是只用在了构建期那一半。
- **不用改嵌入方**。`=== diagram {format=geml-code-graph src=…}` 一个字不动，
  `codemap render` / `serve` 也一个字不动。

## v1 的四个旋钮

全部取自 `codeGraphRuntime` 里现有的字面量：

| 键 | 现状 | 位置 |
|---|---|---|
| `fold` | `first(p)` 写死切到第一个 `/` | `render.ts` `codeGraphRuntime` 内 `function first` |
| `depth` | 来自 `graph-depth` meta，默认 6 | `d >= data.depth` |
| `hide-accessors` | `data.mode !== "modules" && !state.showAcc` | accessor 段 |
| `palette` | 12 个色值的数组 | `var PALETTE = [...]` |

**默认值一律保持现状**，所以既有测试全部原样通过。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `geml-parser/src/graph-style.ts`（新建） | 解析 / 序列化 / 默认值 / 装载或播种，四函数镜像 `foldings.mjs` |
| `geml-parser/src/render.ts`（修改） | 装载 style config，随 `data-graph` 送出；运行时读它 |
| `geml-parser/codemap/build.mjs`（修改） | 首次 build 时播种 `_index/style.geml` |
| `geml-parser/test/graph-style.test.mjs`（新建） | 解析、默认值、装载、旋钮生效 |
| `geml-parser/test/all.mjs`（修改） | 注册 suite |

---

## Task 1: 样式配置的解析与默认值

**Files:**
- Create: `geml-parser/src/graph-style.ts`
- Create: `geml-parser/test/graph-style.test.mjs`

- [ ] **Step 1: 写下失败的测试**

创建 `geml-parser/test/graph-style.test.mjs`：

```js
// geml-code-graph 的显示期调节面（计划 D）。
//
// 存在的理由：codemap 已经有两个调节面，劈得很别扭 —— 构建期折叠在
// `_index/foldings.geml`（一份「edit freely」的 GEML 文档），显示期折叠写死在
// 渲染器 JS 里。这个模块给显示期补上同样的面。
import { parseGraphStyle, defaultGraphStyle, serializeGraphStyle } from "../dist/graph-style.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

test("默认值就是渲染器今天的行为 —— 反转不改变任何现状", () => {
  const d = defaultGraphStyle();
  assert.equal(d.fold, 1);          // first(p)：切到第一个 `/`
  assert.equal(d.depth, 6);         // codemap-profile: renderer default 6
  assert.equal(d.hideAccessors, true);
  assert.equal(Array.isArray(d.palette), true);
  assert.equal(d.palette.length, 12);
});

test("解析：style-rule 上的旋钮覆盖默认值", () => {
  const cfg = parseGraphStyle(
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=2 depth=3}\n===\n'
  );
  assert.equal(cfg.fold, 2);
  assert.equal(cfg.depth, 3);
  assert.equal(cfg.hideAccessors, true, "没写的键保持默认");
});

test("解析：布尔旗标关掉 accessor 隐藏", () => {
  const cfg = parseGraphStyle(
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" hide-accessors=false}\n===\n'
  );
  assert.equal(cfg.hideAccessors, false);
});

test("解析：palette 是空格分隔的色值（§4 不支持数组）", () => {
  const cfg = parseGraphStyle(
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" palette="#111 #222 #333"}\n===\n'
  );
  assert.deepEqual(cfg.palette, ["#111", "#222", "#333"]);
});

test("解析：没有 style-rule 的文档退回默认值，不抛异常", () => {
  assert.deepEqual(parseGraphStyle('=== meta\ntitle = "空"\n===\n'), defaultGraphStyle());
});

test("解析：坏输入退回默认值 —— 调节面坏掉不该让渲染失败", () => {
  assert.deepEqual(parseGraphStyle("=== 这不是 geml"), defaultGraphStyle());
});

test("序列化的种子文件能被自己解析回来", () => {
  const seeded = serializeGraphStyle(defaultGraphStyle());
  assert.deepEqual(parseGraphStyle(seeded), defaultGraphStyle());
});

console.log(`\n${passed} passed`);
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/graph-style.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/graph-style.js'`

- [ ] **Step 3: 写最小实现**

创建 `geml-parser/src/graph-style.ts`：

```ts
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
  const cfg = defaultGraphStyle();
  let doc;
  try { doc = parse(text); } catch { return cfg; }
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

function findRule(nodes: Block[]): Extract<Block, { kind: "block" }> | null {
  for (const n of nodes) {
    if (n.kind !== "block") continue;
    if (n.type === "style-rule") return n;
    if (n.children) { const hit = findRule(n.children); if (hit !== null) return hit; }
  }
  return null;
}

/** 播种用的文档。写成 geml-style 样式表，所以 `geml style check` 能验它。 */
export function serializeGraphStyle(cfg: GraphStyle): string {
  return '=== meta\nprofile = "geml-style/v1"\ntitle = "codemap graph style"\n===\n\n' +
    "Display-time knobs for `geml-code-graph`. Seeded on first build; edit\n" +
    "freely — build never rewrites this, exactly like `foldings.geml` beside it.\n" +
    "That one tunes BUILD-time folding; this one tunes what you see.\n\n" +
    "=== style-rule {#graph match=\"diagram[format=geml-code-graph]\" \\\n" +
    `                fold=${cfg.fold} depth=${cfg.depth} ` +
    `hide-accessors=${cfg.hideAccessors} \\\n` +
    `                palette="${cfg.palette.join(" ")}"}\n===\n`;
}
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/graph-style.test.mjs`
Expected: PASS —— `7 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/graph-style.ts geml-parser/test/graph-style.test.mjs
git commit -m "feat(codegraph): a display-time style surface, defaults matching today"
```

---

## Task 2: 装载或播种 `_index/style.geml`

**Files:**
- Modify: `geml-parser/src/graph-style.ts`
- Modify: `geml-parser/test/graph-style.test.mjs`

- [ ] **Step 1: 写下失败的测试**

import 区补 `loadOrSeedGraphStyle`，以及 `node:fs` / `node:os` / `node:path`，插入：

```js
test("装载：没有文件时播种，并返回默认值", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  const r = loadOrSeedGraphStyle(dir);
  assert.equal(r.seeded, true);
  assert.deepEqual(r.config, defaultGraphStyle());
  assert.equal(existsSync(join(dir, "_index", "style.geml")), true);
});

test("装载：已有文件时读它，且不重写 —— 和 foldings 一样 edit freely", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  mkdirSync(join(dir, "_index"), { recursive: true });
  const mine = '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=2}\n===\n';
  writeFileSync(join(dir, "_index", "style.geml"), mine);
  const r = loadOrSeedGraphStyle(dir);
  assert.equal(r.seeded, false);
  assert.equal(r.config.fold, 2);
  assert.equal(readFileSync(join(dir, "_index", "style.geml"), "utf8"), mine, "不得重写");
});

test("装载：播种出来的文件 geml check 干净（能被 geml style check 验）", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  loadOrSeedGraphStyle(dir);
  const d = parse(readFileSync(join(dir, "_index", "style.geml"), "utf8"));
  assert.deepEqual(d.diagnostics.filter((x) => x.severity === "error"), []);
});
```

`parse` 从 `../dist/geml.js` 引入。

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/graph-style.test.mjs`
Expected: FAIL —— `loadOrSeedGraphStyle is not a function`

- [ ] **Step 3: 写最小实现**

在 `graph-style.ts` 顶部补 `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";`
和 `import { join } from "node:path";`，末尾追加：

```ts
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
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/graph-style.test.mjs`
Expected: PASS —— `10 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/graph-style.ts geml-parser/test/graph-style.test.mjs
git commit -m "feat(codegraph): load or seed _index/style.geml, mirroring foldings"
```

---

## Task 3: 把配置送进页面

**Files:**
- Modify: `geml-parser/src/render.ts`
- Modify: `geml-parser/test/graph-style.test.mjs`

**背景：** code-graph 的数据在 `render.ts` 里组装成一个对象，序列化进
`<div class="cg-mount" data-graph="…">`。配置作为该对象的一个新键 `style` 随行，
运行时因此不需要第二次取数。

- [ ] **Step 1: 写下失败的测试**

```js
test("渲染：data-graph 里带上 style 配置", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-gs-"));
  mkdirSync(join(dir, "_index"), { recursive: true });
  writeFileSync(join(dir, "index.geml"),
    '=== meta\nprofile = "codemap/v1"\nrepo = t\ncontainer = module\nresolution-default = cpg\n===\n\n' +
    "# Code map\n\n" +
    '=== table {#modules format=csv}\nmodule, doc, methods, entries, tests\na, a.geml, 1, 0, 0\n===\n');
  writeFileSync(join(dir, "a.geml"),
    '=== meta\nprofile = "codemap/v1"\nmodule = a\nresolution-default = cpg\n===\n\n# a\n\n' +
    '=== code {#f anchor="x:a#f()"}\n===\n');
  writeFileSync(join(dir, "_index", "style.geml"),
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#graph match="diagram[format=geml-code-graph]" fold=3 depth=2}\n===\n');

  const src = `=== meta\ntitle = "t"\n===\n\n=== diagram {#g format=geml-code-graph src=${join(dir, "index.geml")}}\n===\n`;
  const html = renderHtml(parse(src), { docPath: join(dir, "host.geml") });
  const m = /data-graph="([^"]*)"/.exec(html);
  assert.notEqual(m, null, "应当渲染出 cg-mount");
  const data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  assert.equal(data.style.fold, 3);
  assert.equal(data.style.depth, 2);
});
```

import 区补 `import { renderHtml } from "../dist/render-html.js";`。

**注意：** `renderHtml` 的第二参数名与形状要以 `dist/render-html.js` 的实际签名为准；
若 `docPath` 不是正确的键，先跑
`node -e "import('./dist/render-html.js').then(m=>console.log(m.renderHtml.length))"`
并读 `src/render-html.ts` 的 `RenderOptions` 定义后再写。

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/graph-style.test.mjs`
Expected: FAIL —— `data.style` 是 undefined

- [ ] **Step 3: 写最小实现**

在 `render.ts` 里：

1. 顶部补 `import { loadOrSeedGraphStyle, defaultGraphStyle, type GraphStyle } from "./graph-style.js";`
2. code-graph 数据对象的类型（`CgData` 或等价的 interface，`medges?` 那一带）加 `style: GraphStyle;`
3. 组装数据的地方（`mode: "modules"` 那条提前返回，以及方法层的返回）都带上
   `style: loadOrSeedGraphStyle(cgDir(startPath)).config`，
   **装载失败或目录不可写时用 `defaultGraphStyle()`**。

**装载只做一次**：把结果提到组装函数的开头，两条返回路径共用同一个值。

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/graph-style.test.mjs`
Expected: PASS —— `11 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/render.ts geml-parser/test/graph-style.test.mjs
git commit -m "feat(codegraph): ship the display style with the graph payload"
```

---

## Task 4: 运行时读配置，不读字面量

**Files:**
- Modify: `geml-parser/src/render.ts`（`codeGraphRuntime` 内）
- Modify: `geml-parser/test/graph-style.test.mjs`

- [ ] **Step 1: 写下失败的测试**

在 Task 3 的渲染测试之后补：

```js
test("运行时读的是配置而不是字面量：fold / depth / accessor / palette 都出现在 bundle 的读取路径上", () => {
  const js = pageAssets.codeGraphJs;
  // 四个旗标都必须从 data.style 上取；留一个字面量就等于留一个调不动的决策。
  for (const key of ["fold", "depth", "hideAccessors", "palette"]) {
    assert.match(js, new RegExp("style[^;]{0,40}" + key), `${key} 应从 style 配置读取`);
  }
  // 12 色调色板不得再作为字面量数组出现在运行时里
  assert.doesNotMatch(js, /#e3f2fd"?\s*,\s*"?#e8f5e9/, "PALETTE 应来自配置");
});
```

import 区补 `pageAssets`（`../dist/render-html.js`）。

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/graph-style.test.mjs`
Expected: FAIL —— PALETTE 仍是字面量

- [ ] **Step 3: 写最小实现**

在 `codeGraphRuntime` 内，四处逐一改成读配置。每处都保留原值作为回退，
使**没有 style 配置的旧页面行为不变**：

```ts
      // 显示期的展示决策来自随数据一同送来的 style 配置（_index/style.geml），
      // 不再是这里的字面量。回退值逐一等于反转之前的行为，所以旧页面与
      // 既有测试的输出不变。
      var st = (data0 && data0.style) || {};
      var FOLD = st.fold || 1;
      var PALETTE = st.palette || ["#e3f2fd", "#e8f5e9", "#fff3e0", "#f3e5f5", "#e0f7fa", "#fce4ec",
                                   "#f1f8e9", "#ede7f6", "#fff8e1", "#e0f2f1", "#efebe9", "#f9fbe7"];
```

- `first(p)` 改成按 `FOLD` 段切：
  ```ts
      function first(p: any) {
        var parts = String(p).split("/");
        return parts.length <= FOLD ? String(p) : parts.slice(0, FOLD).join("/");
      }
  ```
  `FOLD === 1` 时与原实现逐字符等价。
- `var hideAcc = data.mode !== "modules" && !state.showAcc;` 改成
  `var hideAcc = data.mode !== "modules" && !state.showAcc && (st.hideAccessors !== false);`
- `d >= data.depth` 不动 —— depth 已经通过 payload 走通；Task 3 让 style 的 depth
  覆盖它即可（在服务端组装时取 `style.depth`）。

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/graph-style.test.mjs`
Expected: PASS —— `12 passed`

- [ ] **Step 5: 回归闸门**

Run: `cd geml-parser && node test/all.mjs`
Expected: 全绿。**默认值没变，118 个 codemap 测试必须原样通过**；
任何一个挂了都说明某个回退值写错了，改回退值而不是改测试。

- [ ] **Step 6: 提交**

```bash
git add geml-parser/src/render.ts geml-parser/test/graph-style.test.mjs
git commit -m "feat(codegraph): the runtime reads its display decisions from the style config"
```

---

## Task 5: build 播种 + 接入 suite + viewer 闸门

**Files:**
- Modify: `geml-parser/codemap/build.mjs`
- Modify: `geml-parser/test/all.mjs`

- [ ] **Step 1: build 播种**

`build.mjs` 里紧接 `loadOrSeedFoldings` 那一段之后：

```js
import { loadOrSeedGraphStyle } from "../dist/graph-style.js";
…
const { seeded: styleSeeded } = loadOrSeedGraphStyle(outDir);
if (styleSeeded) console.error("seeded _index/style.geml — edit to tune the graph's display");
```

`outDir` 用该文件里既有的输出目录变量（与 `loadOrSeedFoldings` 收的那个一致）。

- [ ] **Step 2: 注册 suite**

`test/all.mjs` 的 `suites` 里，`"profiles",` 之后加：

```js
  // geml-code-graph 的显示期调节面（计划 D）
  "graph-style",
```

- [ ] **Step 3: 全量 + 覆盖率**

Run: `cd geml-parser && pgrep -f 'codemap/serve.mjs' | while read -r p; do kill "$p"; done; npm run coverage:check > /tmp/cov.txt 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`，四项 ≥ 95%。
**先清僵尸 serve 进程**——它们跨整个会话累积，占住端口会让 `cov-serve` 假失败。
**不要用 `| tail` 取退出码**（那报的是 tail 的）。

- [ ] **Step 4: viewer 闸门**

本计划改了 `render.ts` 的顶层导入。

Run: `cd integrations/geml-viewer && npm run build > /tmp/viewer.txt 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`。若报 missing named export，按 CLAUDE.md 同步
`src/render-html-stub.js` 与 node-stub。

- [ ] **Step 5: 端到端手验**

```bash
node geml-parser/dist/geml.js codemap build --root <repo>
sed -i '' 's/fold=1/fold=2/' .geml-code-graph/_index/style.geml
node geml-parser/dist/geml.js codemap render .geml-code-graph
```
打开 `index.html`：模块数应当随 `fold` 变化，**渲染器一行没改**。

- [ ] **Step 6: 提交**

```bash
git add geml-parser/codemap/build.mjs geml-parser/test/all.mjs
git commit -m "feat(codegraph): seed _index/style.geml on build; register the suite"
```

---

## 完成的定义

- [ ] `_index/style.geml` 首次 build 时被播种，之后 build 不重写它
- [ ] 改 `fold` / `depth` / `hide-accessors` / `palette` 能改变渲染结果
- [ ] **`codeGraphRuntime` 的布局、缩放、方法搜索、调用链、cross-stack、同源限制一行未改**
- [ ] 默认值不变 → `codemap.test.mjs` 的 118 个测试与 `sec-codemap` 原样通过
- [ ] `node test/all.mjs` 全绿；`npm run coverage:check` 四项 ≥ 95%（真实退出码）
- [ ] viewer esbuild 构建通过（真实退出码）
- [ ] 播种出的 `_index/style.geml` 能被 `geml style check` 验

## 不在本计划内

- **替换渲染器。** 明确不做，理由在开头。
- 更多旋钮（布局尺寸 `NH`/`GY`/`GX`/`W`、节点宽度公式、边色、`CG_MAX_NODES`）——
  形状与这四个一样，等真有人要调再加。
- spike 的节点口径 bug（数边端点而非方法块）—— 那是 spike 的问题，与本计划无关。
