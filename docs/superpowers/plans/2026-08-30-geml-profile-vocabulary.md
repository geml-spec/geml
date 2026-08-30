# profile 词汇表机制（计划 C）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一份文档能在 `meta` 里声明它使用的应用层 profile，`geml check` 据此认识该 profile 的块类型与属性键——从而把 codemap 的词汇从核心 parser 里**收回去**，把拼写检查还给其他所有文档。

**Architecture:** 一个新的扁平模块 `profiles.ts` 持有注册表；`geml.ts` 在既有的类型/属性校验点查一次由 `ctx.meta` 算出的词汇表。核心 parser 不再认识任何具体 profile。

**Tech Stack:** TypeScript（`tsc` → `dist/`）、`.test.mjs` + `node:assert`、`c8` 覆盖率闸门。

**分支：** `feat/geml-style`（承接计划 A）。

**依据：** `docs/superpowers/specs/2026-08-29-geml-style-design.md` §3.3。

---

## 已核实的既有事实

1. **`collectMeta` 在 `scanBlocks` 之前跑完**（[geml.ts:1748](../../../geml-parser/src/geml.ts)）：
   `ctx.meta` 在校验块的时候已经可用，所以**不需要延迟过滤**，直接在校验点查表。
2. **泄漏点是** [geml.ts:672](../../../geml-parser/src/geml.ts)：
   `else if (type === "code") validRe = /^(lang|src|anchor|name|entry-via)$/;`
   实测后果：`anchor=` / `entry-via=` 在**任何文档的任何 `code` 块**上静默通过，
   只有拼错的 `ancohr=` 被抓。
3. **codemap 已经在 meta 里写 `resolution-default`**，且 [emit.mjs:487](../../../geml-parser/codemap/emit.mjs)
   拿它当**生成物标记**用（`/^===\s*meta\b[\s\S]*?\bresolution-default\s*=/`）。
   这给了向后兼容一条现成的路。

## 两个已定的设计决策

**决策 1：不做向后兼容探测。旧产物重新生成一次。**

既有的 codemap 产物没有 `profile` 键，从核心移除 `anchor` 后它们会开始报
`unknown-attribute` warning（exit 仍为 0）。曾考虑让 `codemap/v1` 自带一条 legacy 探测
（*meta 里有 `resolution-default` 即视为声明*），**否决了**：

- 它会把本计划正要清除的问题以更小的形式重新引入。核心里硬编码 codemap 词汇的坏处之一，
  是污染了 §8.4 的一致性面——第二实现要么复刻那份词汇表，要么报出参考实现不报的 warning。
  而"看见 `resolution-default` 就当作声明了 codemap/v1"是**同一类**实现特定知识，
  第二实现照样得复刻。留着它，收益直接打折。
- 它让 `resolution-default` 在第二个地方变成承重键（今天它只是 emit.mjs 的生成物标记）。
  codemap 将来若改名或弃用该键，两处会一起静默失效。
- 代价很低：修复就是重新生成一次（`geml codemap build`），而仓库本来就有这个先例——
  "older codemap/, graph/ dirs: regenerate once to replace"。
- 失败模式温和且自解释：warning 点名了具体的键，而且**它是对的**——那份文档确实没有声明
  自己的 profile。

**迁移说明**：本变更落地后，旧的 `.geml-code-graph/` 重新 build 一次即可。

**决策 2：v1 的 profile 只放行*名字*，不改*body 模式*。**

一个被 profile 放行的块类型，body 模式仍是 §3 规定的 `raw`。也就是说 profile 能消掉
`unknown-block-type` 与 `unknown-attribute` 两类 warning，但不能让一个自定义类型拥有
flow body。这对本仓库现有的两个 profile 都够用（codemap 只用已注册类型；geml-style 的
三个类型 body 都是空的）。放宽它是将来的事，且需要单独论证——body 模式影响的是解析结果，
不只是诊断。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `geml-parser/src/profiles.ts`（新建） | profile 注册表：名字 → 放行的块类型与逐类型属性键；含各 profile 自己的 legacy 探测 |
| `geml-parser/src/geml.ts`（修改） | 两处：`Ctx` 增一个字段；校验点查表。**并移除 `code` 正则里的 codemap 词汇** |
| `geml-parser/codemap/emit.mjs`（修改） | 两个 meta 写出点补 `profile = "codemap/v1"` |
| `geml-parser/test/profiles.test.mjs`（新建） | 声明生效、限定作用域、legacy 探测、拼写检查回归 |
| `geml-parser/test/all.mjs`（修改） | 注册新 suite |

**注意 esbuild stub：** 本计划**修改 `geml.ts`**。只要不新增/删除**顶层导入或再导出**就无需
动 viewer 的 stub——`profiles.ts` 是 `geml.ts` 内部使用的新导入，不是再导出。
Task 5 会显式跑 viewer 闸门确认，并取**真实退出码**（`| tail` 报的是 tail 的）。

---

## Task 1: profile 注册表

**Files:**
- Create: `geml-parser/src/profiles.ts`
- Create: `geml-parser/test/profiles.test.mjs`

- [ ] **Step 1: 写下失败的测试**

创建 `geml-parser/test/profiles.test.mjs`：

```js
// 应用层 profile 的词汇表机制（设计 §3.3）。
//
// 这个机制存在的理由是把 codemap 的词汇从核心 parser 收回去：在它之前，
// `anchor=` / `entry-via=` 在任何文档的任何 code 块上都静默通过，
// 等于全世界每份 GEML 文档都让出了这三个键的拼写检查。
import { vocabularyFor } from "../dist/profiles.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const meta = (o) => new Map(Object.entries(o));

test("注册表：声明了 codemap/v1 才放行它的属性键", () => {
  const v = vocabularyFor(meta({ profile: "codemap/v1" }));
  assert.equal(v.attrs.get("code")?.has("anchor"), true);
  assert.equal(v.attrs.get("code")?.has("entry-via"), true);
});

test("注册表：没声明就什么都不放行 —— 拼写检查回到其他文档手里", () => {
  const v = vocabularyFor(meta({ title: "an ordinary document" }));
  assert.equal(v.attrs.get("code"), undefined);
  assert.equal(v.types.size, 0);
});

test("注册表：geml-style/v1 放行三个块类型（计划 A 的回报）", () => {
  const v = vocabularyFor(meta({ profile: "geml-style/v1" }));
  for (const t of ["style-rule", "style-state", "style-screen"]) {
    assert.equal(v.types.has(t), true, `应放行 ${t}`);
  }
});

test("注册表：profile 是空格分隔的列表，语义是并集（设计 §3.1）", () => {
  const v = vocabularyFor(meta({ profile: "codemap/v1 geml-style/v1" }));
  assert.equal(v.attrs.get("code")?.has("anchor"), true);
  assert.equal(v.types.has("style-rule"), true);
});

test("注册表：未知 profile 名被忽略，不炸也不放行", () => {
  const v = vocabularyFor(meta({ profile: "nope/9 codemap/v1" }));
  assert.equal(v.attrs.get("code")?.has("anchor"), true);
  assert.equal(v.types.size, 0);
});

test("注册表：没有后门 —— 只有 profile= 声明才放行（决策 1）", () => {
  // 旧 codemap 产物靠 resolution-default 自我标识，但那是 emit 的生成物标记，
  // 不是 profile 声明。认它会把 §8.4 一致性面的污染以更小的形式重新引入。
  const v = vocabularyFor(meta({ module: "a/b", "resolution-default": "cpg" }));
  assert.equal(v.attrs.get("code"), undefined);
});

console.log(`\n${passed} passed`);
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/profiles.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/profiles.js'`

- [ ] **Step 3: 写最小实现**

创建 `geml-parser/src/profiles.ts`：

```ts
// 应用层 profile 的词汇表注册表（设计 §3.3）。
//
// 一份文档在 `=== meta` 里用 `profile = "<name> …"`（空格分隔的列表，
// 因为 §4 不支持数组）声明它使用哪些应用层词汇表。声明之后，那些块类型不再算
// `unknown-block-type`，那些属性键不再算 `unknown-attribute`。
//
// 这不改规范：§8.5 明写 "The type registry (§3) is **open**"，§8.2(6) 约束的是
// 处理器*不认识*的类型必须降级。一个处理器通过 profile 认识了更多名字，完全合规。
//
// 为什么这个模块必须存在，而不是在 geml.ts 里多写几个 if：在它之前，codemap 的
// `anchor`/`name`/`entry-via` 硬编码在核心的属性校验表里，后果是这三个键在**任何
// 文档的任何 code 块**上都静默通过 —— 全世界每份 GEML 文档都永久让出了它们的
// 拼写检查，只为一个应用的清净。而且 §8.4 的一致性面被污染：第二实现要么复刻
// codemap 的词汇表，要么报出参考实现不报的 warning。
//
// v1 的范围：profile 只放行**名字**，不改 **body 模式** —— 一个被放行的类型，
// body 仍按 §3 当 raw 处理。放宽它影响的是解析结果而不只是诊断，需要单独论证。

/** 一个 profile 放行的词汇。 */
export interface ProfileDef {
  /** 额外放行的块类型名 */
  types?: string[];
  /** 逐块类型额外放行的属性键 */
  attrs?: Record<string, string[]>;
}

export const PROFILES: Record<string, ProfileDef> = {
  // docs/design/specs/codemap/codemap-profile.md
  "codemap/v1": {
    attrs: { code: ["anchor", "name", "entry-via"] },
  },
  // docs/superpowers/specs/2026-08-29-geml-style-design.md
  "geml-style/v1": {
    types: ["style-rule", "style-state", "style-screen"],
  },
};

export interface Vocabulary {
  types: Set<string>;
  attrs: Map<string, Set<string>>;
}

/**
 * 一份文档的 meta 决定它放行哪些名字。多个 profile 取**并集** —— 校验只问
 * "这个名字允许吗"，不问"它是什么意思"，所以两个 profile 放行同一个键不是冲突，
 * 是同一个答案说了两遍（设计 §3.1）。
 */
export function vocabularyFor(meta: Map<string, string>): Vocabulary {
  const declared = new Set((meta.get("profile") ?? "").split(/\s+/).filter((x) => x.length > 0));
  const types = new Set<string>();
  const attrs = new Map<string, Set<string>>();
  for (const [name, def] of Object.entries(PROFILES)) {
    if (!declared.has(name)) continue;
    for (const t of def.types ?? []) types.add(t);
    for (const [type, keys] of Object.entries(def.attrs ?? {})) {
      let set = attrs.get(type);
      if (set === undefined) { set = new Set<string>(); attrs.set(type, set); }
      for (const k of keys) set.add(k);
    }
  }
  return { types, attrs };
}
```

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/profiles.test.mjs`
Expected: PASS —— `6 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/profiles.ts geml-parser/test/profiles.test.mjs
git commit -m "feat(profiles): an application-layer profile vocabulary registry"
```

---

## Task 2: 接进 parser，并移除核心里的 codemap 词汇

**Files:**
- Modify: `geml-parser/src/geml.ts`
- Modify: `geml-parser/test/profiles.test.mjs`

- [ ] **Step 1: 写下失败的测试**

在 `profiles.test.mjs` 的 import 区补 `import { parse } from "../dist/geml.js";`，插入：

```js
const warns = (src, code) => parse(src).diagnostics.filter((d) => d.code === code);

const CODEMAP_BLOCK =
  '=== code {#esc anchor="ts:render.ts#esc(string)" entry-via=main}\n===\n';

test("回归：普通文档里的 anchor= 现在被抓了 —— 拼写检查回来了", () => {
  const d = warns('=== meta\ntitle = "ordinary"\n===\n\n' + CODEMAP_BLOCK, "unknown-attribute");
  assert.equal(d.length, 2, "anchor 和 entry-via 都该报");
});

test("声明了 codemap/v1 之后，同样的块检查干净", () => {
  const d = warns('=== meta\nprofile = "codemap/v1"\n===\n\n' + CODEMAP_BLOCK, "unknown-attribute");
  assert.deepEqual(d, []);
});

test("旧产物（只有 resolution-default）现在会报 —— 重新 build 一次即可（决策 1）", () => {
  const d = warns('=== meta\nresolution-default = "cpg"\n===\n\n' + CODEMAP_BLOCK, "unknown-attribute");
  assert.equal(d.length, 2);
});

test("拼错的键在任何情况下都被抓 —— 放行的是名字，不是整个类型", () => {
  const d = warns('=== meta\nprofile = "codemap/v1"\n===\n\n=== code {#a ancohr="typo"}\n===\n', "unknown-attribute");
  assert.equal(d.length, 1);
  assert.match(d[0].message, /ancohr/);
});

test("geml-style 样式表不再逐块报 unknown-block-type（计划 A 的回报）", () => {
  const sheet =
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#a match="table"}\n===\n\n' +
    '=== style-rule {#b match="code"}\n===\n';
  assert.deepEqual(warns(sheet, "unknown-block-type"), []);
  // 没声明 profile 的同一份内容照旧逐块报
  assert.equal(warns(sheet.replace('profile = "geml-style/v1"', 'title = "x"'), "unknown-block-type").length, 2);
});

test("放行的类型 body 仍按 §3 当 raw —— v1 不改 body 模式", () => {
  const d = parse('=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-rule {#a match="table"}\nnot parsed\n===\n');
  const block = d.children.find((c) => c.kind === "block" && c.type === "style-rule");
  assert.equal(block.mode, "raw");
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && npx tsc && node test/profiles.test.mjs`
Expected: FAIL —— 第一条就挂：`anchor` 仍被核心放行，`d.length` 是 0 不是 2

- [ ] **Step 3: 写最小实现**

**(a)** 在 `geml.ts` 的 import 区加：

```ts
import { vocabularyFor, type Vocabulary } from "./profiles.js";
```

**(b)** 在 `Ctx` 接口里 `meta` 那行之后加：

```ts
  vocab: Vocabulary; // 本文档 `profile=` 声明放行的块类型与属性键（§3.3）
```

**(c)** 在 `parse()` 里构造 `ctx` 的那行改成先算 meta 再算词汇表：

```ts
  const meta = collectMeta(lines, diags);
  const ctx: Ctx = { diags, ids: new Map(), refs: [], meta, vocab: vocabularyFor(meta), resolveDoc: opts.resolveDoc };
```

**(d)** 把类型/属性校验那一段（`let mode = REGISTRY.get(type);` 开始）改成：

```ts
      let mode = REGISTRY.get(type);
      if (mode === undefined && ctx.vocab.types.has(type)) {
        // 一个 profile 放行的类型：不再算 unknown。v1 只放行名字，
        // body 仍按 §3 当 raw —— 放宽它影响解析结果，不只是诊断。
        mode = "raw";
      } else if (mode === undefined) {
        diags.push({ severity: "warning", code: "unknown-block-type", message: `unknown block type \`${type}\`; body kept as raw`, line: openLineNo });
        mode = "raw";
      } else {
        // `hidden` (§4) and `caption` (§4, and the label an auto-reference takes
        // per §5.2) are not type-specific: every typed block may carry them. Only
        // the extras below are per type.
        let validRe: RegExp;
        if (type === "table") validRe = /^(src|format|delim|header|format-data|compute\d*|summary\d*|span\d*)$/;
        else if (type === "data") validRe = /^(format|schema|src)$/;
        else if (type === "embed") validRe = /^(src)$/;
        else if (type === "diagram") validRe = /^(src|data|format|format-data|delim|header|type|rows|x|y|size|series)$/;
        else if (type === "code") validRe = /^(lang|src)$/;
        else validRe = /^$/;

        const universal = /^(hidden|caption)$/;
        // 本文档声明的 profile 额外放行的键（§3.3）。在此之前 codemap 的
        // `anchor`/`name`/`entry-via` 硬编码在上面的 `code` 分支里，于是它们在
        // 每份文档的每个 code 块上都静默通过 —— 现在只对声明了 codemap/v1 的
        // 文档放行，其余文档拿回拼写检查。
        const licensed = ctx.vocab.attrs.get(type);

        for (const key of Object.keys(attrs.attrs)) {
          if (universal.test(key) || validRe.test(key)) continue;
          if (licensed?.has(key) === true) continue;
          diags.push({ severity: "warning", code: "unknown-attribute", message: `unknown attribute \`${key}\` for block type \`${type}\``, line: openLineNo });
        }
      }
```

注意 `code` 的正则**从 `/^(lang|src|anchor|name|entry-via)$/` 收窄成 `/^(lang|src)$/`**
——这就是本计划的正题。

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && npx tsc && node test/profiles.test.mjs`
Expected: PASS —— `12 passed`

- [ ] **Step 5: 提交**

```bash
git add geml-parser/src/geml.ts geml-parser/test/profiles.test.mjs
git commit -m "feat(profiles): consult the declared vocabulary, and take codemap's keys out of the core

anchor/name/entry-via were hardcoded into the core code-block attribute
table, so they passed silently on every code block in every document —
every GEML document had permanently forfeited spell-checking on those three
keys for one application's convenience. Now only a document declaring
codemap/v1 licenses them."
```

---

## Task 3: codemap 写出 profile 声明

**Files:**
- Modify: `geml-parser/codemap/emit.mjs`
- Modify: `geml-parser/test/profiles.test.mjs`

- [ ] **Step 1: 写下失败的测试**

```js
test("codemap 的两个 meta 写出点都声明 profile", () => {
  const src = readFileSync(new URL("../codemap/emit.mjs", import.meta.url), "utf8");
  const declarations = src.match(/profile = "codemap\/1"/g) ?? [];
  assert.equal(declarations.length, 2, "index 与 container 两个写出点都要声明");
});
```

import 区补 `import { readFileSync } from "node:fs";`。

- [ ] **Step 2: 跑它，确认失败**

Run: `cd geml-parser && node test/profiles.test.mjs`
Expected: FAIL —— `0 !== 2`

- [ ] **Step 3: 写最小实现**

`emit.mjs` 里两处 `"=== meta\n"` 之后，把 profile 声明作为**第一个键**写出。
两处的形状都是拼接串，最后一段是 `+ \`resolution-default = ${RESOLUTION_DEFAULT}\n===\n\``。
把每处的 `"=== meta\n"` 改为：

```js
      "=== meta\n"
      + 'profile = "codemap/v1"\n'
```

（第 272 行附近与第 395 行附近各一处；缩进照各自原样。）

- [ ] **Step 4: 跑它，确认通过**

Run: `cd geml-parser && node test/profiles.test.mjs && node test/codemap.test.mjs`
Expected: 两个都 PASS。codemap suite 若有断言比对生成文档的字节，按新增的那一行更新期望值。

- [ ] **Step 5: 提交**

```bash
git add geml-parser/codemap/emit.mjs geml-parser/test/profiles.test.mjs
git commit -m "feat(codemap): declare profile = codemap/v1 in generated documents"
```

---

## Task 4: 接入 suite

**Files:**
- Modify: `geml-parser/test/all.mjs`

- [ ] **Step 1: 注册**

在 `suites` 数组里，`"style-selector", "style-check",` 那两行之前加：

```js
  // 应用层 profile 的词汇表机制（计划 C）：声明生效、限定作用域、legacy 探测。
  "profiles",
```

- [ ] **Step 2: 跑全量**

Run: `cd geml-parser && npm run build && node test/all.mjs`
Expected: 全绿。**一次跑完就从这一次取输出和退出码。**

若 `sec-codemap` / `codemap` / `fixtures` 因为生成文档多了一行而失败，
更新那些期望值——那是本计划有意造成的输出变更。

- [ ] **Step 3: 覆盖率闸门**

Run: `cd geml-parser && npm run coverage:check > /tmp/cov.txt 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`，四项 ≥ 95%。**不要用 `| tail` 取退出码**——那报的是 tail 的。

- [ ] **Step 4: 提交**

```bash
git add geml-parser/test/all.mjs
git commit -m "test(profiles): register the profile-vocabulary suite"
```

---

## Task 5: viewer 闸门与文档

**Files:**
- Modify: `docs/design/specs/codemap/codemap-profile.md`
- Modify: `docs/design/specs/codemap/codemap-profile_CN.md`

- [ ] **Step 1: 跑 viewer 闸门，取真实退出码**

本计划改了 `geml.ts`。虽然只新增了一个**内部导入**（不是顶层再导出），
仍必须确认 viewer 的 esbuild bundle 没被打断。

Run: `cd integrations/geml-viewer && npm run build > /tmp/viewer.txt 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`。若报 missing named export，按 CLAUDE.md 的规矩同步
`src/render-html-stub.js` 与 node-stub。

- [ ] **Step 2: 更新 codemap profile 文档**

在 `codemap-profile.md` 的 §2「Document rules」的 meta 键表格里，
把 `profile` 作为第一行加入：

```markdown
  | `profile` | all | `codemap/v1` — declares this document's application-layer vocabulary, so `geml check` licenses `anchor`/`name`/`entry-via` on `code` blocks. **Required** — graphs generated before this key existed warn until rebuilt (`geml codemap build`) |
```

在 `codemap-profile_CN.md` 的对应表格加同义的一行。

- [ ] **Step 3: 提交**

```bash
git add docs/design/specs/codemap/codemap-profile.md docs/design/specs/codemap/codemap-profile_CN.md
git commit -m "docs(codemap): record the profile declaration in the profile document"
```

---

## 完成的定义

- [ ] 普通文档里的 `anchor=` / `entry-via=` 被报为 `unknown-attribute`（拼写检查已归还）
- [ ] 声明 `profile = "codemap/v1"` 的文档检查干净
- [ ] 只有 `resolution-default` 的旧产物**会**报 warning——迁移靠重新 build 一次
- [ ] geml-style 样式表不再逐块报 `unknown-block-type`
- [ ] `geml.ts` 里不再出现 `anchor`/`entry-via` 字样
- [ ] `node test/all.mjs` 全绿；`npm run coverage:check` 四项 ≥ 95%（**真实退出码**）
- [ ] viewer 的 esbuild 构建通过（**真实退出码**）
- [ ] 全部提交在 `feat/geml-style` 上；`main` 不受影响

## 不在本计划内

- 让 profile 改变 **body 模式**（v1 只放行名字，见决策 2）
- 让 profile 声明 **meta 键**（meta 键本来就完全不校验，没有需要解决的问题）
- 未知 profile 名的诊断（现在静默忽略；要不要报 warning 留待真实需求）
