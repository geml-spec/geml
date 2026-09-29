# geml-media 讲解片（计划 A：管线与 S07 垂直切片）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起讲解片的全部管线，并用一个镜头（S07 · 血缘）从头走到尾：场景模块 → 逐帧截图 → mp4 → 旁白 → 素材库与生成记录 → 两份时间线 → `geml media build` 出中英两个 mp4 → `geml check` 零诊断 → ffprobe 校时。

**Architecture:** 一个新目录 `playground/geml-media-explainer/`。四份 GEML 文档是唯一的源；`tools/` 里的脚本只经 geml CLI（`add` / `set` / `get` / `list` / `check` / `media log` / `media build`）读写它们，从不直接改文档文本——时间线（`cut-*.geml`）例外，它是 `lay-cut.mjs` 从剧本与素材库**派生**的整份产物。画面由场景模块（`render(t, root)` 纯函数）经无头 Chromium 逐帧截图得到，CDP 用 Node 自带的 `WebSocket` 直连，零 npm 依赖。

**Tech Stack:** Node 24（全局 `WebSocket`、`node:test`）、本仓库 `geml-parser/dist/geml.js`、ffmpeg / ffprobe、macOS `say`、Playwright 缓存里的 `chrome-headless-shell`。

**分支 / 工作区：** `feat/geml-media-explainer`，worktree 在 `.claude/worktrees/geml-media-explainer`（主工作区另有会话在改解析器，别在那边动）。下文所有路径相对 worktree 根。

**依据：** `docs/design/specs/2026-09-27-geml-media-explainer-design.md`。本计划实现其 §2、§4、§5.1、§6、§8 的管线部分与 §7 的 S07 一镜。其余 13 镜、证据采集（§4.2）、配乐接入（§5.2）是**计划 B**。

---

## 实测过的前提（写计划前逐条跑过）

| 事实 | 出处 |
|---|---|
| `geml add <doc> --before '#id' --in -` 从 stdin 插入块；id 冲突会被拒 | `geml add --help` |
| `geml set <doc> '#id' --head --in -` 只换头行 | 在 demo 副本上实测 |
| `geml get <doc> '#id'` 找不到时非零退出；`--body` 只给正文（表格就是那几行 `\|…\|`） | 实测 |
| `geml check <doc> --root . --json` 输出 `{core:[…], profile:[…]}`，每条带 `code`/`doc`/`id` | 实测 |
| 改一个 `role=workflow` 素材的文件并 `set` 新哈希后，`check` 对用它当输入的产出报 `media-stale-generation` | 实测 |
| `geml media log … --prompt <ref>` **必须带 `--root .`**：引用落在 root 之外时静默不写 `prompt-sha256` | 实测（设计 §10 待办 #9） |
| `geml media import` 按文件名派生 id、不写 `role`/`of`、同路径新字节会撞 id → 本计划不用它，一律 `add`/`set` | `media-verbs.ts:635-639` |
| `geml media lay` 把同锚的旁白与字幕当成先后排列（字幕 offset 被排到旁白之后）→ 不用它，时长自己算 | 实测 |
| `geml add`/`set` 不生成 `.gemlhistory` | 实测 |
| Chrome 不让 `file://` 页面加载 ES module → 渲染走本地 http | 已知 |
| CDP 截 1920×1080 PNG 约 45ms/帧；1 秒扁平画面编成 mp4 约 15KB | 原型实测 |
| `say -v Tingting` / `say -v Samantha` 可用 | 实测 |
| demo 里 `#hero-look` 改词前哈希 `5f9bb75d…`，改成「黑色长发及腰」后 `1dedc60b5538d06b…` | `geml media log --prompt ../characters.geml#hero-look --root .` 实测 |

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `playground/geml-media-explainer/concepts.geml` | 立意、旁白（说话人）、四个概念块 |
| `playground/geml-media-explainer/script.geml` | 分镜表 `#shots`；旁白 `.line` 块 `vo-sNN-{zh,en}-K` |
| `playground/geml-media-explainer/library.geml` | 素材块（工具写入）+ `#gen-log` |
| `playground/geml-media-explainer/cut-zh.geml`、`cut-en.geml` | **派生**：`lay-cut.mjs` 的产物 |
| `playground/geml-media-explainer/_index/index.geml` | 样式表（viewer 播放器） |
| `playground/geml-media-explainer/.gitignore` | `out/` |
| `playground/geml-media-explainer/scenes/lib.js` | 场景公共件：色板、缓动、打字机、GEML 分词上色、`once` |
| `playground/geml-media-explainer/scenes/stage.html` | 唯一的舞台页，暴露 `__seek(t)` / `__ready` |
| `playground/geml-media-explainer/scenes/_probe.js` | 舞台页的测试场景 |
| `playground/geml-media-explainer/scenes/s07.js` | S07 场景 |
| `playground/geml-media-explainer/tools/lib/geml.mjs` | 调 CLI、哈希、时长、素材块读写、分镜表与台词 id |
| `playground/geml-media-explainer/tools/lib/server.mjs` | 零依赖静态服务 |
| `playground/geml-media-explainer/tools/lib/chrome.mjs` | 找 Chromium、CDP 会话 |
| `playground/geml-media-explainer/tools/render-scenes.mjs` | 渲镜头 |
| `playground/geml-media-explainer/tools/make-voice.mjs` | 旁白 TTS |
| `playground/geml-media-explainer/tools/lay-cut.mjs` | 派生两份时间线 |
| `playground/geml-media-explainer/tools/check-timing.mjs` | 旁白不得超出镜头 |
| `playground/geml-media-explainer/tools/verify.mjs` | 设计 §8 的检查 |
| `playground/geml-media-explainer/tools/test/*.test.mjs` | `node --test` 单元与集成测试 |
| `playground/geml-media-explainer/README.md` | 切片阶段的运行说明 |

测试命令（下文简写为 **T**）：

```bash
node --test "playground/geml-media-explainer/tools/test/*.test.mjs"
```

CLI（下文简写为 **G**）：`node geml-parser/dist/geml.js`。worktree 里先 `cd geml-parser && npm ci && npm run build` 一次。

**画面里不拼 HTML。** 所有文字经 `textContent` 写入；带颜色的 GEML 行由 `hl()` 切成 `[文本, 颜色]` 词元，再由 `paint()` 逐个建 `<span>`。

---

## Task 1: 目录骨架与四份文档

**Files:**
- Create: `playground/geml-media-explainer/concepts.geml`
- Create: `playground/geml-media-explainer/script.geml`
- Create: `playground/geml-media-explainer/library.geml`
- Create: `playground/geml-media-explainer/_index/index.geml`
- Create: `playground/geml-media-explainer/.gitignore`

- [ ] **Step 1: 写 `concepts.geml`**

```geml
=== meta
title = "geml-media 讲解片 · 立意与概念"
profile = "geml-media/v1"
===

# 立意 {#premise}

一支用 geml-media 做出来的、讲 geml-media 的片子。它讲的机制，就是造出它的机制：
每个镜头是一个 `media-asset`，时间线是 `media-clip`，旁白带生成记录，成片由
`geml media build` 出。

# 旁白 {#narrator}

片中唯一的说话人。中文版用 macOS 的 Tingting，英文版用 Samantha；实际用了哪个声音，
记在每条旁白生成记录的 `model` 里。

# 素材有身份 {#identity}

一个文件一个 `media-asset`，`sha256` 是它的身份，`src` 只是它现在放在哪。

# 片段是引用 {#reference}

`media-clip` 指向素材的一段时间，不复制字节——和 `code {src=file#L14-24}` 指向源码的
一段同一个形状。

# 血缘可校验 {#lineage}

每次生成追加一条记录，记下生成当刻每个输入的哈希。改了源头，`geml check` 沿血缘图把
所有下游标成过期。过期是诊断，不是猜。

# 时间是锚定的 {#anchoring}

主轨顺排，其余轨 `over=` 锚在主轨的某个片段上。改一刀，锚在它后面的配音与字幕自动跟着挪。
绝对时间只有 `at=` 一个逃生口。
```

- [ ] **Step 2: 写 `script.geml`（切片阶段只有 S07）**

```geml
=== meta
title = "geml-media 讲解片 · 剧本"
profile = "geml-media/v1"
===

# 分镜表 {#board}

镜头时长是设计出来的定值；中英旁白都写来适配同一个槽位（设计 §6）。

=== table {#shots}
| 镜号 | 时长 | 概念 |
|---|---|---|
| s07 | 14 | concepts.geml#lineage |
===

# 旁白 {#narration}

## S07 · 血缘 {#vo-s07}

=== media-text {#vo-s07-zh-1 .line speaker=concepts.geml#narrator}
每一次生成，都记下当时每个输入的哈希。
===

=== media-text {#vo-s07-zh-2 .line speaker=concepts.geml#narrator}
角色卡上改一个词，两条提示词、三个镜头、一段口型，跟着全部过期。
===

=== media-text {#vo-s07-en-1 .line speaker=concepts.geml#narrator}
Every generation records the hash of each input, as it was at that moment.
===

=== media-text {#vo-s07-en-2 .line speaker=concepts.geml#narrator}
Change one word on a character card, and two prompts, three takes and a lip-sync all go stale.
===
```

- [ ] **Step 3: 写 `library.geml`**

```geml
=== meta
title = "geml-media 讲解片 · 素材库"
profile = "geml-media/v1"
===

%% 本库由 tools/ 维护：素材块经 `geml add` / `geml set` 写入，生成记录经
%% `geml media log` 追加。别手改头行——下次运行会按文件现值重写它。

# 素材 {#assets}

# 生成日志 {#gen}

=== data {#gen-log .gen-log format=jsonl}
===
```

- [ ] **Step 4: 写 `_index/index.geml`**

```geml
=== meta
title = "讲解片的呈现：打开就是成片"
profile = "geml-style/v1"
track-h = 48
===

%% 与 playground/geml-media-demo 的样式表同形；轨道换成本片的四条，画幅 16:9。

=== style-screen {#play axis=column component=player aspect=16:9 slots="#video, #narration, #music, #subtitle"}
===

=== style-frame {#video axis=row component=timeline-track slots="media-clip[track=video]" height="{{track-h}}px"}
===

=== style-frame {#narration axis=row component=timeline-track slots="media-clip[track=narration]" height="{{track-h}}px"}
===

=== style-frame {#music axis=row component=timeline-track slots="media-clip[track=music]" height="{{track-h}}px"}
===

=== style-frame {#subtitle axis=row component=timeline-track slots="media-clip[track=subtitle]" height="{{track-h}}px"}
===

=== style-rule {#clip-card match="media-clip" component=clip}
===
```

- [ ] **Step 5: 写 `.gitignore`**

```
out/
```

- [ ] **Step 6: 校验**

```bash
cd playground/geml-media-explainer
for f in concepts.geml script.geml library.geml _index/index.geml; do node ../../geml-parser/dist/geml.js check $f --root . || exit 1; done
```

Expected: 四行 `ok: no diagnostics`，退出码 0。若空的 `jsonl` 数据块报错，先看报的是什么再改形状——**不要**塞假记录。

- [ ] **Step 7: 提交**

```bash
git add playground/geml-media-explainer
git commit -m "feat(explainer): the four documents of a geml-media explainer, S07 only"
```

---

## Task 2: 场景公共件 `scenes/lib.js`

**Files:**
- Create: `playground/geml-media-explainer/scenes/lib.js`
- Test: `playground/geml-media-explainer/tools/test/scene-lib.test.mjs`

- [ ] **Step 1: 写失败的测试**

```js
// scene-lib.test.mjs —— 场景公共件里不碰 DOM 的部分。
import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp, lerp, prog, typed, mix, hl, C } from "../../scenes/lib.js";

test("prog 夹在 0..1，端点精确，单调", () => {
  assert.equal(prog(-1, 0, 2), 0);
  assert.equal(prog(0, 0, 2), 0);
  assert.equal(prog(2, 0, 2), 1);
  assert.equal(prog(9, 0, 2), 1);
  let last = -1;
  for (let t = 0; t <= 2; t += 0.05) { const p = prog(t, 0, 2); assert.ok(p >= last); last = p; }
});

test("typed 按码点切，汉字不劈半", () => {
  assert.equal(typed("黑色长发", 0.99, 0, 2), "黑");
  assert.equal(typed("黑色长发", 1.0, 0, 2), "黑色");
  assert.equal(typed("abc", -1, 0, 10), "");
  assert.equal(typed("abc", 99, 0, 10), "abc");
});

test("mix 在两色之间插值并夹住 p", () => {
  assert.equal(mix("#000000", "#ffffff", 0), "#000000");
  assert.equal(mix("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#000000", "#ffffff", 7), "#ffffff");
  assert.equal(clamp(3), 1);
  assert.equal(lerp(10, 20, 0.25), 12.5);
});

const LINE = "=== media-clip {#c01 track=video src=lib.geml#s01 in=0 out=4}";

test("hl 的词元拼回去就是原文，一个字都不多不少", () => {
  for (const l of [LINE, '=== media-text {#x .line title="a b"}', "a < b & c", "====", ""]) {
    assert.equal(hl(l).map(([s]) => s).join(""), l);
  }
});

test("hl 给围栏、类型、#id、键、值各上各的色；相邻同色合并", () => {
  const toks = hl(LINE);
  const has = (s, c) => toks.some(([x, y]) => x === s && y === c);
  assert.ok(has("===", C.dim));
  assert.ok(has("media-clip", C.accent));
  assert.ok(has("#c01", C.id));
  assert.ok(has("track", C.key) && has("video", C.str));
  assert.ok(has("lib.geml#s01", C.str));
  for (let i = 1; i < toks.length; i++) assert.notEqual(toks[i][1], toks[i - 1][1], `第 ${i} 个词元没合并`);
  assert.deepEqual(hl("plain"), [["plain", C.code]]);
});
```

- [ ] **Step 2: 跑，确认失败**

Run: **T**
Expected: FAIL，`Cannot find module …/scenes/lib.js`

- [ ] **Step 3: 实现 `scenes/lib.js`**

```js
// 场景公共件。**一切都是 t 的函数**：没有 CSS 动画、没有 transition、没有
// requestAnimationFrame —— 第 t 秒的画面只能由 t 决定，否则逐帧截图会漂，也没法测。
//
// 这个文件同时被浏览器（舞台页）与 node（测试）加载，所以模块顶层不许碰 DOM。
// 画面里不拼 HTML：文字一律 textContent，带颜色的行用 hl() 切词元、paint() 画。

export const W = 1920;
export const H = 1080;

export const C = {
  bg: "#0b0d12", panel: "#141821", line: "#2a3142", text: "#e8e6e3", dim: "#8a93a6",
  accent: "#4f8cff", ok: "#3ecf8e", warn: "#f5b83d", bad: "#ff5c5c", code: "#c9d1d9",
  key: "#79c0ff", str: "#a5d6ff", id: "#d2a8ff",
};

export const mono = '"SF Mono", "JetBrains Mono", Menlo, monospace';
export const sans = '"PingFang SC", "Helvetica Neue", sans-serif';

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, p) => a + (b - a) * p;
export const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** t 在 [a, b] 里走到了哪儿，缓动后的 0..1。 */
export const prog = (t, a, b, ease = easeInOut) => ease(clamp((t - a) / (b - a)));

/** 打字机：第 t 秒露出几个字。按码点切，汉字不会被劈成半个。 */
export const typed = (text, t, start, cps = 30) =>
  [...text].slice(0, Math.max(0, Math.floor((t - start) * cps + 1e-9))).join("");

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** 两个 #rrggbb 之间插值。 */
export const mix = (a, b, p) => {
  const A = rgb(a), B = rgb(b);
  return "#" + A.map((x, i) => Math.round(lerp(x, B[i], clamp(p))).toString(16).padStart(2, "0")).join("");
};

/**
 * 给一行 GEML 分词上色：[[文本, 颜色], …]，相邻同色合并。只为画面好看，不是解析器。
 * 词元拼回去恒等于原文。
 */
export function hl(line) {
  const toks = [];
  const push = (s, c) => {
    if (s === "") return;
    const last = toks[toks.length - 1];
    if (last !== undefined && last[1] === c) last[0] += s; else toks.push([s, c]);
  };
  const m = line.match(/^(={3,})(\s+)([\w-]*)(.*)$/);
  if (m === null) { push(line, C.code); return toks; }
  const [, fence, sp, type, rest] = m;
  push(fence, C.dim); push(sp, C.code); push(type, C.accent);
  for (const x of rest.matchAll(/#[\w-]+|([\w-]+)=("[^"]*"|[^\s}]+)|[\s\S]/g)) {
    if (x[0].startsWith("#")) push(x[0], C.id);
    else if (x[1] !== undefined) { push(x[1], C.key); push("=", C.code); push(x[2], C.str); }
    else push(x[0], C.code);
  }
  return toks;
}

/** 把词元画进一个元素：每个词元一个 span，文字走 textContent。 */
export function paint(e, toks) {
  e.replaceChildren(...toks.map(([s, c]) => {
    const sp = document.createElement("span");
    sp.style.color = c;
    sp.textContent = s;
    return sp;
  }));
}

/** 建一个元素。场景第一次 render 时建好全部 DOM，之后每帧只改样式。 */
export function el(tag, style = {}, text) {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 只建一次：同一个 root 上第二次调用直接拿缓存。 */
export function once(root, build) {
  if (root.__scene === undefined) root.__scene = build(root);
  return root.__scene;
}
```

- [ ] **Step 4: 跑，确认通过**

Run: **T**
Expected: 5 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add playground/geml-media-explainer/scenes/lib.js playground/geml-media-explainer/tools/test/scene-lib.test.mjs
git commit -m "feat(explainer): scene helpers where every frame is a function of t"
```

---

## Task 3: `tools/lib/geml.mjs` —— 经 CLI 读写文档

**Files:**
- Create: `playground/geml-media-explainer/tools/lib/geml.mjs`
- Test: `playground/geml-media-explainer/tools/test/geml-lib.test.mjs`

- [ ] **Step 1: 写失败的测试**

```js
// geml-lib.test.mjs —— 在临时副本上跑真实的 geml CLI。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROOT, assetHead, hasBlock, registerFile, logGen, checkJson,
  needsRegen, shotTable, lineIds, blockBody, blockAttrs,
} from "../lib/geml.mjs";

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "explainer-lib-"));
  for (const f of ["concepts.geml", "script.geml", "library.geml"]) cpSync(join(ROOT, f), join(d, f));
  mkdirSync(join(d, "scenes"));
  return d;
}

test("assetHead 属性顺序固定，含空白的值直接拒", () => {
  assert.equal(
    assetHead("x", { role: "take", kind: "video", src: "a.mp4", sha256: "ab", duration: 2, origin: "generated" }),
    "=== media-asset {#x src=a.mp4 sha256=ab kind=video duration=2 origin=generated role=take}",
  );
  assert.throws(() => assetHead("x", { src: "a b.mp4" }), /空白/);
});

test("shotTable 读出分镜表", () => {
  assert.deepEqual(shotTable(ROOT), [{ id: "s07", duration: 14, concept: "concepts.geml#lineage" }]);
});

test("lineIds 按序号排，只收本镜本语言", () => {
  assert.deepEqual(lineIds("s07", "zh", ROOT), ["vo-s07-zh-1", "vo-s07-zh-2"]);
  assert.deepEqual(lineIds("s07", "en", ROOT), ["vo-s07-en-1", "vo-s07-en-2"]);
  assert.deepEqual(lineIds("s99", "zh", ROOT), []);
  assert.equal(blockBody("script.geml", "vo-s07-zh-1", ROOT), "每一次生成，都记下当时每个输入的哈希。");
});

test("registerFile：没有就 add，有就 set 头行；check 保持干净", () => {
  const d = fixture();
  writeFileSync(join(d, "scenes/s07.js"), "export default 1\n");
  assert.equal(hasBlock("library.geml", "scene-s07", d), false);
  registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow", of: "concepts.geml#lineage" }, d);
  assert.equal(hasBlock("library.geml", "scene-s07", d), true);
  const first = blockAttrs("library.geml", "scene-s07", d);
  assert.equal(first.role, "workflow");
  writeFileSync(join(d, "scenes/s07.js"), "export default 2\n");
  registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow", of: "concepts.geml#lineage" }, d);
  assert.notEqual(blockAttrs("library.geml", "scene-s07", d).sha256, first.sha256);
  const { core, profile } = checkJson("library.geml", d);
  assert.deepEqual([core, profile], [[], []]);
});

test("needsRegen：没块、没记录、输入变了都算；记过之后不算", () => {
  const d = fixture();
  writeFileSync(join(d, "scenes/s07.js"), "export default 1\n");
  writeFileSync(join(d, "out.txt"), "rendered 1\n");
  registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow" }, d);
  assert.equal(needsRegen("library.geml", "shot-s07", d), true);             // 没块
  registerFile("library.geml", "shot-s07", "out.txt", { kind: "other", role: "take" }, d);
  assert.equal(needsRegen("library.geml", "shot-s07", d), true);             // 有块没记录
  logGen("library.geml", { output: "shot-s07", model: "render-scenes", mode: "code2v", inputs: ["scene-s07"] }, d);
  assert.equal(needsRegen("library.geml", "shot-s07", d), false);            // 记过了
  writeFileSync(join(d, "scenes/s07.js"), "export default 2\n");
  registerFile("library.geml", "scene-s07", "scenes/s07.js", { kind: "other", role: "workflow" }, d);
  assert.equal(needsRegen("library.geml", "shot-s07", d), true);             // 输入变了
});

test("logGen 带 --root .：提示词的哈希一定写进记录", () => {
  const d = fixture();
  writeFileSync(join(d, "v.txt"), "voice\n");
  registerFile("library.geml", "voice-s07-zh-1", "v.txt", { kind: "other", role: "voice" }, d);
  logGen("library.geml", { output: "voice-s07-zh-1", model: "say-Tingting", mode: "tts", prompt: "script.geml#vo-s07-zh-1" }, d);
  const log = blockBody("library.geml", "gen-log", d).trim().split("\n").map((l) => JSON.parse(l));
  assert.match(log.at(-1)["prompt-sha256"], /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: 跑，确认失败**

Run: **T**
Expected: FAIL，`Cannot find module …/tools/lib/geml.mjs`

- [ ] **Step 3: 实现 `tools/lib/geml.mjs`**

```js
// 讲解片工具的公共部分：调用本仓库的 geml CLI、算哈希与时长、读写素材库。
//
// 素材块与生成记录**一律经 CLI 写入**（`geml add` / `geml set` / `geml media log`），
// 不直接改文档文本：片子里演的那条流水线，就是造出这支片子的那条流水线。
//
// 不用 `geml media import`：它按文件名派生 id、不写 role/of，同一路径的新字节
// 会派生出同一个 id 而撞车（设计 §10 待办 #8）。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 讲解片目录。每个函数都收一个 root，缺省是它；测试传临时副本。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = process.env.GEML_CLI ?? resolve(ROOT, "../../geml-parser/dist/geml.js");
export const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE ?? "ffprobe";

export function geml(args, { root = ROOT, input, allowFail = false } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`geml ${args.join(" ")} → 退出码 ${r.status}\n${r.stderr}${r.stdout}`);
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

export function probeDuration(path) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe ${path}：${r.stderr}`);
  return Number(Number(r.stdout.trim()).toFixed(3));
}

// 头行里的属性顺序固定：同一组事实永远写成同一行，否则每次重跑都是一处无意义的 diff。
const ORDER = ["src", "sha256", "kind", "duration", "origin", "of", "role"];

export function assetHead(id, attrs) {
  const keys = [...ORDER.filter((k) => k in attrs), ...Object.keys(attrs).filter((k) => !ORDER.includes(k)).sort()];
  for (const k of keys) {
    if (/\s/.test(String(attrs[k]))) throw new Error(`#${id} 的 ${k}=${attrs[k]} 含空白：本工具不写带引号的值`);
  }
  return `=== media-asset {#${id} ${keys.map((k) => `${k}=${attrs[k]}`).join(" ")}}`;
}

export const hasBlock = (doc, id, root = ROOT) =>
  geml(["get", doc, `#${id}`], { root, allowFail: true }).code === 0;

export const blockBody = (doc, id, root = ROOT) =>
  geml(["get", doc, `#${id}`, "--body"], { root }).stdout.trim();

/** 一个块头行上的属性。只认本工具写的形状：值不带引号、不含空白。 */
export function blockAttrs(doc, id, root = ROOT) {
  const head = geml(["get", doc, `#${id}`], { root }).stdout.split("\n")[0];
  const out = {};
  for (const m of head.matchAll(/([\w-]+)=("[^"]*"|[^\s}]+)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

/** 没有就 add 到「素材」一节末尾，有就只换头行。 */
export function upsertAsset(lib, id, attrs, root = ROOT) {
  const head = assetHead(id, attrs);
  if (hasBlock(lib, id, root)) {
    geml(["set", lib, `#${id}`, "--head", "--in", "-"], { root, input: head + "\n" });
  } else {
    geml(["add", lib, "--before", "#gen", "--in", "-"], { root, input: `${head}\n===\n\n` });
  }
}

/** 把一个文件登记成素材：哈希与时长取现值。file 相对 root（素材库就在 root）。 */
export function registerFile(lib, id, file, { kind, role, of }, root = ROOT) {
  const abs = join(root, file);
  const attrs = { src: file, sha256: sha256File(abs), kind, origin: "generated" };
  if (kind === "video" || kind === "audio") attrs.duration = probeDuration(abs);
  if (of !== undefined) attrs.of = of;
  if (role !== undefined) attrs.role = role;
  upsertAsset(lib, id, attrs, root);
  return attrs;
}

/** 追加一条生成记录。**必须带 --root .**：引用落在 root 外时 CLI 静默不写 prompt-sha256。 */
export function logGen(lib, { output, model, mode, prompt, inputs = [] }, root = ROOT) {
  const args = ["media", "log", lib, "--output", `#${output}`, "--model", model, "--mode", mode, "--root", "."];
  if (prompt !== undefined) args.push("--prompt", prompt);
  for (const i of inputs) args.push("--input", `#${i}`);
  geml(args, { root });
}

export function checkJson(doc, root = ROOT) {
  const r = geml(["check", doc, "--root", ".", "--json"], { root, allowFail: true });
  const j = JSON.parse(r.stdout);
  return { core: j.core ?? [], profile: j.profile ?? [] };
}

// 这个产出要不要重做 —— 问 check，不自己比哈希。它说过期、说文件不对、说文件没了、
// 说这份字节没有记录认领，或者库里根本还没有这个块，都算。
const REGEN = new Set(["media-stale-generation", "media-hash-mismatch", "media-file-missing", "media-orphan-record"]);

export function needsRegen(lib, id, root = ROOT) {
  if (!hasBlock(lib, id, root)) return true;
  const { profile } = checkJson(lib, root);
  if (profile.some((d) => d.id === id && REGEN.has(d.code))) return true;
  // 有块、字节也对，但一条记录都没有（上次跑到一半断了）：自己看一眼日志。
  const log = blockBody(lib, "gen-log", root);
  return !log.split("\n").some((l) => l.includes(`"output":"#${id}"`));
}

/** 分镜表：| 镜号 | 时长 | 概念 | */
export function shotTable(root = ROOT) {
  const rows = blockBody("script.geml", "shots", root).split("\n").slice(2);
  return rows.map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .map(([id, dur, concept]) => ({ id, duration: Number(dur), concept }));
}

export function listIds(doc, root = ROOT) {
  return geml(["list", doc], { root }).stdout.split("\n")
    .map((l) => l.split(/\s+/)[0]).filter((s) => s.startsWith("#")).map((s) => s.slice(1));
}

/** 某镜某语言的旁白块 id，按序号排：vo-s07-zh-1, vo-s07-zh-2, … */
export function lineIds(shot, lang, root = ROOT) {
  const re = new RegExp(`^vo-${shot}-${lang}-(\\d+)$`);
  return listIds("script.geml", root).filter((id) => re.test(id))
    .sort((a, b) => Number(a.match(re)[1]) - Number(b.match(re)[1]));
}
```

- [ ] **Step 4: 跑，确认通过**

Run: **T**
Expected: 本文件 6 个测试 PASS（连同 Task 2 共 11 个）。`needsRegen` 若在「记过了」一步仍为 true，先 `G check library.geml --root . --json` 看报了什么再动实现——**不要**放宽断言。

- [ ] **Step 5: 提交**

```bash
git add playground/geml-media-explainer/tools/lib/geml.mjs playground/geml-media-explainer/tools/test/geml-lib.test.mjs
git commit -m "feat(explainer): read and write the library only through the geml CLI"
```

---

## Task 4: 静态服务、CDP 会话、舞台页

**Files:**
- Create: `playground/geml-media-explainer/tools/lib/server.mjs`
- Create: `playground/geml-media-explainer/tools/lib/chrome.mjs`
- Create: `playground/geml-media-explainer/scenes/stage.html`
- Create: `playground/geml-media-explainer/scenes/_probe.js`（测试用最小场景；下划线开头，不进分镜表）
- Test: `playground/geml-media-explainer/tools/test/stage.test.mjs`

- [ ] **Step 1: 写失败的测试**

```js
// stage.test.mjs —— 服务、浏览器、舞台页。本机没有 Chromium 时浏览器部分跳过。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ROOT } from "../lib/geml.mjs";
import { startServer } from "../lib/server.mjs";
import { findChrome, openBrowser } from "../lib/chrome.mjs";

const skip = findChrome() === null ? "本机没有 Chromium" : false;
let server, page;
before(async () => { server = await startServer(ROOT); if (!skip) page = await openBrowser(); });
after(async () => { await page?.close(); await server.close(); });

test("服务：正确的 MIME，目录外 403，不存在 404", async () => {
  const ok = await fetch(`${server.url}/scenes/lib.js`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(`${server.url}/..%2F..%2Fpackage.json`)).status, 403);
  assert.equal((await fetch(`${server.url}/nope.js`)).status, 404);
});

test("舞台：同一 t 两次截图逐字节相同，不同 t 不同", { skip }, async () => {
  await page.goto(`${server.url}/scenes/stage.html?scene=_probe`);
  await page.evaluate("window.__seek(0.5)");
  const a = await page.screenshot();
  await page.evaluate("window.__seek(0.9)");
  await page.evaluate("window.__seek(0.5)");
  const b = await page.screenshot();
  await page.evaluate("window.__seek(0.9)");
  const c = await page.screenshot();
  assert.ok(a.equals(b), "同一 t 的两帧不同：场景不是 t 的纯函数");
  assert.ok(!a.equals(c));
  assert.deepEqual(page.errors, []);
});

test("舞台：场景载入失败时 goto 不会假装成功", { skip }, async () => {
  await assert.rejects(page.goto(`${server.url}/scenes/stage.html?scene=__missing`), /就绪/);
});
```

- [ ] **Step 2: 跑，确认失败**

Run: **T**
Expected: FAIL，`Cannot find module …/tools/lib/server.mjs`

- [ ] **Step 3: 实现 `tools/lib/server.mjs`**

```js
// 场景页的静态服务。Chrome 不让 file:// 页面加载 ES module（CORS），所以渲染与预览都走 http。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
};

export function startServer(root, port = 0) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = resolve(join(base, rel));
    if (file !== base && !file.startsWith(base + sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}
```

- [ ] **Step 4: 实现 `tools/lib/chrome.mjs`**

```js
// 无依赖地驱动一个无头 Chromium：用 Node 自带的 WebSocket 直接讲 CDP。
// 查找顺序：CHROME 环境变量 → Playwright 缓存里的 chrome-headless-shell → 系统 Chrome。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const cache of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(cache)) continue;
    const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const d of dirs) {
      for (const sub of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"]) {
        const p = join(cache, d, sub, "chrome-headless-shell");
        if (existsSync(p)) return p;
      }
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(mac) ? mac : null;
}

export async function openBrowser({ width = 1920, height = 1080 } = {}) {
  const bin = findChrome();
  if (bin === null) throw new Error("找不到 Chromium：设 CHROME=<可执行文件>，或 npx playwright install chromium-headless-shell");
  const profile = mkdtempSync(join(tmpdir(), "explainer-chrome-"));
  const args = ["--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-device-scale-factor=1", "--mute-audio", `--user-data-dir=${profile}`];
  if (bin.includes("Google Chrome")) args.push("--headless=new");
  args.push("about:blank");
  const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });

  const wsUrl = await new Promise((ok, fail) => {
    let buf = "";
    const timer = setTimeout(() => fail(new Error("Chromium 10 秒内没有给出调试地址：\n" + buf)), 10_000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    proc.once("exit", (code) => { clearTimeout(timer); fail(new Error(`Chromium 退出了（${code}）：\n${buf}`)); });
  });
  const http = wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
  const target = (await (await fetch(`${http}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.addEventListener("open", ok, { once: true }); ws.addEventListener("error", fail, { once: true }); });

  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const { ok, fail } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) fail(new Error(m.error.message)); else ok(m.result);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    }
  });
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Runtime.enable");
  await send("Page.enable");

  return {
    errors,
    evaluate,
    async goto(url) {
      errors.length = 0;
      await send("Page.navigate", { url });
      for (let i = 0; i < 100; i++) {
        if (await evaluate("window.__ready === true").catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`页面 5 秒内没有就绪：${url}\n${errors.join("\n")}`);
    },
    async screenshot() {
      return Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64");
    },
    async close() {
      ws.close();
      const gone = new Promise((r) => proc.once("exit", r));
      proc.kill();
      await gone;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 5: 实现 `scenes/stage.html`**

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>explainer stage</title>
<style>
  html, body { margin: 0; background: #0b0d12; overflow: hidden; }
  #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #0b0d12; transform-origin: 0 0; }
  #scrub { position: fixed; left: 0; right: 0; bottom: 0; width: 100%; display: none; }
  body.preview #scrub { display: block; }
</style>
</head>
<body>
<div id="root"></div>
<input id="scrub" type="range" min="0" step="0.001" value="0">
<script type="module">
  // 唯一的舞台页：?scene=s07 载入同目录的 s07.js。
  // 渲染工具只用 window.__seek(t)。带 &preview=1&d=14 时页面自己走带、可拖动 ——
  // 只给人看；渲染不走这条路，所以这里用 requestAnimationFrame 不违反「t 的纯函数」。
  const q = new URLSearchParams(location.search);
  const root = document.getElementById("root");
  const mod = (await import(`./${q.get("scene")}.js`)).default;
  window.__seek = (t) => { mod.render(t, root); return true; };
  window.__seek(0);
  await document.fonts.ready;
  window.__ready = true;

  if (q.get("preview") === "1") {
    const d = Number(q.get("d") ?? 10);
    document.body.classList.add("preview");
    const fit = () => { root.style.transform = `scale(${Math.min(innerWidth / 1920, innerHeight / 1080)})`; };
    fit(); addEventListener("resize", fit);
    const scrub = document.getElementById("scrub");
    scrub.max = String(d);
    let t0 = performance.now(), dragging = false;
    scrub.addEventListener("input", () => { dragging = true; window.__seek(Number(scrub.value)); });
    scrub.addEventListener("change", () => { t0 = performance.now() - Number(scrub.value) * 1000; dragging = false; });
    const tick = (now) => {
      if (!dragging) { const t = ((now - t0) / 1000) % d; scrub.value = String(t); window.__seek(t); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
</script>
</body>
</html>
```

- [ ] **Step 6: 实现 `scenes/_probe.js`**

```js
// 舞台页的测试场景：一个随 t 平移的方块。不进分镜表。
import { el, once, C } from "./lib.js";

export default {
  render(t, root) {
    const s = once(root, (r) => {
      const box = el("div", { position: "absolute", top: "400px", width: "200px", height: "200px", background: C.accent });
      r.append(box);
      return { box };
    });
    s.box.style.left = `${Math.round(t * 800)}px`;
  },
};
```

- [ ] **Step 7: 跑，确认通过**

Run: **T**
Expected: 本文件 3 个测试 PASS。

- [ ] **Step 8: 提交**

```bash
git add playground/geml-media-explainer/tools/lib/server.mjs playground/geml-media-explainer/tools/lib/chrome.mjs playground/geml-media-explainer/scenes/stage.html playground/geml-media-explainer/scenes/_probe.js playground/geml-media-explainer/tools/test/stage.test.mjs
git commit -m "feat(explainer): drive headless Chromium over CDP with no dependencies"
```

---

## Task 5: S07 场景

**Files:**
- Create: `playground/geml-media-explainer/scenes/s07.js`
- Test: `playground/geml-media-explainer/tools/test/scenes.test.mjs`

画面全部取自 `playground/geml-media-demo` 的真实文档与真实 `check` 结果：把 `characters.geml#hero-look` 的「银灰短发齐耳」改为「黑色长发及腰」后，`check ep01/ep01-cut.geml --root .` 报 6 条——`#s01-key`、`#s01-take3`、`#s03-take2` 三条 `media-stale-generation`（提示词的投射源过期），`#s03-take2-lips` 一条（上游过期），`#c01`、`#c03` 两条 `media-stale-clip`。

时间表（秒）：0–1.8 卡片按列出现；1.0–2.6 连线画出；2.4–4.8 生成日志逐行打出，角色卡哈希与日志里记下的哈希同时高亮（同一个值）；4.7–6.8 光标进入角色卡，删掉旧词、打出新词；6.9–7.3 哈希翻成新值；7.4 起过期沿边传播，每跳 0.6 秒，到 9.8；10.3 起右下角打出 `$ geml check …`，12.0 出 `6 warning(s)`；之后停住。

- [ ] **Step 1: 写失败的测试**

```js
// scenes.test.mjs —— 分镜表里的每个场景：三个时刻渲染无异常、非空白、确定、会动。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ROOT, shotTable } from "../lib/geml.mjs";
import { startServer } from "../lib/server.mjs";
import { findChrome, openBrowser } from "../lib/chrome.mjs";

const skip = findChrome() === null ? "本机没有 Chromium" : false;
let server, page, blank;
before(async () => {
  server = await startServer(ROOT);
  if (skip) return;
  page = await openBrowser();
  await page.goto(`${server.url}/scenes/stage.html?scene=_probe`);
  await page.evaluate("document.getElementById('root').replaceChildren()");
  blank = await page.screenshot();
});
after(async () => { await page?.close(); await server.close(); });

for (const shot of shotTable(ROOT)) {
  test(`${shot.id}：三个时刻渲染无异常、非空白、同一 t 两次一致`, { skip }, async () => {
    await page.goto(`${server.url}/scenes/stage.html?scene=${shot.id}`);
    const frames = [];
    for (const t of [0.5, shot.duration / 2, shot.duration - 1 / 30]) {
      await page.evaluate(`window.__seek(${t})`);
      const a = await page.screenshot();
      await page.evaluate(`window.__seek(${t})`);
      assert.ok(a.equals(await page.screenshot()), `${shot.id} 在 t=${t} 不确定`);
      assert.ok(!a.equals(blank), `${shot.id} 在 t=${t} 是空白`);
      frames.push(a);
    }
    assert.ok(!frames[0].equals(frames[2]), `${shot.id} 从头到尾没动`);
    assert.deepEqual(page.errors, []);
  });
}
```

- [ ] **Step 2: 跑，确认失败**

Run: **T**
Expected: `s07：…` FAIL，`页面 5 秒内没有就绪`（`s07.js` 不存在，动态 import 抛错）。

- [ ] **Step 3: 实现 `scenes/s07.js`**

```js
// S07 · 血缘：角色卡改一个词，过期沿血缘图一路传下去。
//
// id、哈希、文本全部取自 playground/geml-media-demo 的真实文档。新哈希 1dedc60b… 是
// 改词之后用 `geml media log --prompt ../characters.geml#hero-look --root .` 实测的；
// 六处过期与各自的诊断码，是同一改动下 `geml check ep01/ep01-cut.geml --root .` 的真实输出。
import { C, el, once, prog, typed, mix, lerp, clamp, hl, paint, mono, sans } from "./lib.js";

const OLD = "5f9bb75d849c6db8";
const NEW = "1dedc60b5538d06b";
const BEFORE = "银灰短发齐耳";
const AFTER = "黑色长发及腰";

const CARD_W = 320;
const CARD_H = 150;
const HOP = 0.6;            // 过期每跳一条边用多久

const NODES = [
  { id: "hero-look", doc: "characters.geml", type: "media-text .look", x: 60, y: 150, h: 470, show: 0, warn: 7.4 },
  { id: "s01-prompt", doc: "ep01-script.geml", type: "media-text .prompt", x: 430, y: 150, show: 0.3 },
  { id: "s03-prompt", doc: "ep01-script.geml", type: "media-text .prompt", x: 430, y: 470, show: 0.4 },
  { id: "s01-key", doc: "ep01-library.geml", type: "media-asset", x: 800, y: 60, show: 0.6, code: "media-stale-generation" },
  { id: "s01-take3", doc: "ep01-library.geml", type: "media-asset", x: 800, y: 260, show: 0.7, code: "media-stale-generation" },
  { id: "s03-take2", doc: "ep01-library.geml", type: "media-asset", x: 800, y: 470, show: 0.8, code: "media-stale-generation" },
  { id: "s03-take2-lips", doc: "ep01-library.geml", type: "media-asset", x: 1170, y: 470, show: 1.0, code: "media-stale-generation" },
  { id: "c01", doc: "ep01-cut.geml", type: "media-clip", x: 1540, y: 260, show: 1.2, code: "media-stale-clip" },
  { id: "c03", doc: "ep01-cut.geml", type: "media-clip", x: 1540, y: 470, show: 1.3, code: "media-stale-clip" },
];
const EDGES = [
  ["hero-look", "s01-prompt"], ["hero-look", "s03-prompt"],
  ["s01-prompt", "s01-key"], ["s01-prompt", "s01-take3"], ["s03-prompt", "s03-take2"],
  ["s03-take2", "s03-take2-lips"], ["s01-take3", "c01"], ["s03-take2-lips", "c03"],
];
const LOG = ["s01-key", "s01-take3", "s03-take2"];

// 每个节点何时标黄：父节点 + 一跳。只定义角色卡的，其余沿边推出来（EDGES 已按拓扑序排）。
const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
for (const [a, b] of EDGES) byId[b].warn = Math.max(byId[b].warn ?? 0, byId[a].warn + HOP);
const LAST_WARN = Math.max(...NODES.map((n) => n.warn));

const hOf = (n) => n.h ?? CARD_H;
const rightMid = (n) => [n.x + CARD_W, n.y + hOf(n) / 2];
const leftMid = (n) => [n.x, n.y + hOf(n) / 2];

function card(n) {
  const box = el("div", {
    position: "absolute", left: `${n.x}px`, top: `${n.y}px`, width: `${CARD_W}px`, height: `${hOf(n)}px`,
    boxSizing: "border-box", padding: "14px 18px", background: C.panel, border: `2px solid ${C.line}`,
    borderRadius: "12px", fontFamily: mono,
  });
  box.append(
    el("div", { color: C.dim, fontSize: "14px" }, n.doc),
    el("div", { color: C.accent, fontSize: "16px", marginTop: "6px" }, n.type),
    el("div", { color: C.id, fontSize: "24px", marginTop: "4px" }, `#${n.id}`),
  );
  let badge = null;
  if (n.code !== undefined) {
    badge = el("div", {
      position: "absolute", left: "18px", bottom: "14px", fontSize: "13px", color: C.bg,
      background: C.warn, padding: "3px 8px", borderRadius: "6px", opacity: "0",
    }, n.code);
    box.append(badge);
  }
  return { box, badge };
}

function heroExtras(box) {
  const body = el("div", { fontFamily: sans, fontSize: "21px", lineHeight: "1.7", color: C.text, marginTop: "18px" });
  const edit = el("span", { borderRadius: "4px", padding: "0 2px" });
  const cursor = el("span", { color: C.accent }, "▍");
  body.append(document.createTextNode("二十六岁女性，**"), edit, cursor, document.createTextNode("**，左眉一道旧疤，红色长风衣。"));
  const sha = el("div", { marginTop: "26px", fontFamily: mono, fontSize: "17px", lineHeight: "1.6" });
  const shaOld = el("span", { color: C.code }, `${OLD}…`);
  const shaNew = el("div", { color: C.warn, paddingLeft: "74px", opacity: "0" }, `${NEW}…`);
  sha.append(el("span", { color: C.dim }, "sha256  "), shaOld, shaNew);
  box.append(body, sha);
  return { edit, cursor, shaOld, shaNew };
}

function panel(x, w, bg) {
  return el("div", {
    position: "absolute", left: `${x}px`, top: "690px", width: `${w}px`, height: "330px", boxSizing: "border-box",
    padding: "18px 22px", background: bg, border: `2px solid ${C.line}`, borderRadius: "12px",
    fontFamily: mono, fontSize: "17px", lineHeight: "1.9", color: C.code,
  });
}

function build(root) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "1920");
  svg.setAttribute("height", "1080");
  Object.assign(svg.style, { position: "absolute", left: "0", top: "0" });
  root.append(svg);

  const cards = {};
  for (const n of NODES) { cards[n.id] = card(n); root.append(cards[n.id].box); }
  const hero = heroExtras(cards["hero-look"].box);

  const edges = EDGES.map(([a, b]) => {
    const [x1, y1] = rightMid(byId[a]);
    const [x2, y2] = leftMid(byId[b]);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const mx = (x1 + x2) / 2;
    path.setAttribute("d", `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-width", "3");
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("r", "7");
    dot.setAttribute("fill", C.warn);
    svg.append(path, dot);
    const len = path.getTotalLength();
    path.style.strokeDasharray = String(len);
    return { path, dot, len, from: byId[a] };
  });

  // 左下：生成日志 —— 数据块的头 + 三条记录
  const log = panel(60, 1240, C.panel);
  log.append(el("div", { color: C.dim }, "ep01-library.geml"));
  const logHead = el("div", {});
  paint(logHead, hl("=== data {#gen-log .gen-log format=jsonl}"));
  log.append(logHead);
  const rows = LOG.map(() => {
    const row = el("div", { whiteSpace: "pre" });
    const pre = el("span", {});
    const hash = el("span", {});
    const post = el("span", {});
    const after = el("span", { color: C.warn });
    row.append(pre, hash, post, after);
    log.append(row);
    return { pre, hash, post, after };
  });
  root.append(log);

  // 右下：终端
  const term = panel(1340, 520, "#07080b");
  term.style.whiteSpace = "pre-wrap";
  const cmd = el("div", {});
  const result = el("div", { color: C.warn, fontSize: "26px", marginTop: "18px" });
  term.append(cmd, result);
  root.append(term);

  return { cards, hero, edges, rows, cmd, result };
}

export default {
  render(t, root) {
    const s = once(root, build);

    for (const n of NODES) {
      const { box, badge } = s.cards[n.id];
      const a = prog(t, n.show, n.show + 0.5);
      box.style.opacity = String(a);
      box.style.transform = `translateY(${lerp(16, 0, a).toFixed(2)}px)`;
      const w = prog(t, n.warn, n.warn + 0.3);
      box.style.borderColor = mix(C.line, C.warn, w);
      if (badge !== null) badge.style.opacity = String(w);
    }

    s.edges.forEach((e, i) => {
      const drawn = prog(t, 1.0 + i * 0.1, 1.8 + i * 0.1);
      e.path.style.strokeDashoffset = String(e.len * (1 - drawn));
      const start = e.from.warn + 0.05;
      e.path.style.stroke = mix(C.line, C.warn, prog(t, start, start + 0.4));
      const p = clamp((t - start) / (HOP - 0.1));
      const pt = e.path.getPointAtLength(e.len * p);
      e.dot.setAttribute("cx", pt.x.toFixed(2));
      e.dot.setAttribute("cy", pt.y.toFixed(2));
      e.dot.style.opacity = p > 0 && p < 1 ? "1" : "0";
    });

    // 角色卡：删旧词、打新词
    let word;
    if (t < 5.0) word = BEFORE;
    else if (t < 5.9) word = [...BEFORE].slice(0, BEFORE.length - Math.floor((t - 5.0) / 0.15)).join("");
    else word = typed(AFTER, t, 5.9, 1 / 0.15);
    s.hero.edit.textContent = word;
    s.hero.edit.style.background = t >= 4.7 && t < 7.4 ? mix(C.bg, C.accent, 0.35) : "transparent";
    s.hero.cursor.style.opacity = t >= 4.7 && t < 7.0 && Math.floor(t * 4) % 2 === 0 ? "1" : "0";

    // 哈希：先与日志里记下的同时高亮（同一个值），改词之后翻成新值
    const same = prog(t, 2.4, 2.8) * (1 - prog(t, 4.4, 4.8));
    const flip = prog(t, 6.9, 7.3);
    s.hero.shaOld.style.color = flip > 0 ? mix(C.code, C.bad, flip) : mix(C.code, C.accent, same);
    s.hero.shaOld.style.textDecoration = flip > 0.5 ? "line-through" : "none";
    s.hero.shaNew.style.opacity = String(flip);

    // 生成日志：逐行打出；记下的哈希在改词之后对不上了
    s.rows.forEach((r, i) => {
      const parts = [`{"output":"#${LOG[i]}","prompt-refs":[{"ref":"../characters.geml#hero-look","sha256":"`, `${OLD}…`, `"}]}`];
      let n = Math.max(0, Math.floor((t - (2.4 + i * 0.5)) * 90));
      const shown = parts.map((p) => { const k = Math.min(n, [...p].length); n -= k; return [...p].slice(0, k).join(""); });
      r.pre.textContent = shown[0];
      r.hash.textContent = shown[1];
      r.post.textContent = shown[2];
      const bad = prog(t, 7.6 + i * 0.1, 7.9 + i * 0.1);
      r.hash.style.color = bad > 0 ? mix(C.code, C.bad, bad) : mix(C.code, C.accent, same);
      r.hash.style.textDecoration = bad > 0.5 ? "line-through" : "none";
      r.after.textContent = bad > 0.5 ? `  ≠ ${NEW.slice(0, 8)}…` : "";
    });

    // 右下：一次检查说出全部
    paint(s.cmd, [["$ ", C.ok], [typed("geml check ep01/ep01-cut.geml --root .", t, LAST_WARN + 0.5, 30), C.code]]);
    s.result.textContent = t >= 12.0 ? "6 warning(s)" : "";
  },
};
```

- [ ] **Step 4: 跑，确认通过**

Run: **T**
Expected: `s07：三个时刻…` PASS。

- [ ] **Step 5: 看画面**

截 3.5 / 6.2 / 9.0 / 13.0 四个时刻到会话 scratchpad，逐张看：3.5 秒日志在打、两处哈希同色高亮；6.2 秒新词打到一半、光标可见；9.0 秒过期传到第三列、边上有黄点在走；13.0 秒六张卡带徽章、右下 `6 warning(s)`。**卡片之间、卡片与底部面板之间不许重叠，文字不许溢出卡片。** 有问题改坐标再看，直到四张都对。

- [ ] **Step 6: 提交**

```bash
git add playground/geml-media-explainer/scenes/s07.js playground/geml-media-explainer/tools/test/scenes.test.mjs
git commit -m "feat(explainer): S07, lineage — one word on a character card, six stale items"
```

---

## Task 6: `tools/render-scenes.mjs`

**Files:**
- Create: `playground/geml-media-explainer/tools/render-scenes.mjs`
- Output: `assets/shot-s07.mp4`；`library.geml` 里的 `#scene-s07`、`#shot-s07` 与记录

- [ ] **Step 1: 实现**

```js
#!/usr/bin/env node
// 场景模块 → 逐帧截图 → 每镜一个 mp4 → 登记进素材库并追加一条生成记录。
//
//   node tools/render-scenes.mjs            只渲过期的镜头（问 geml check）
//   node tools/render-scenes.mjs --all      全渲
//   node tools/render-scenes.mjs s07 s08    只渲这几个
//
// 前置：ffmpeg / ffprobe（或 FFMPEG / FFPROBE 指过去）；本机有 Chromium（见 lib/chrome.mjs）。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, FFMPEG, shotTable, registerFile, logGen, needsRegen } from "./lib/geml.mjs";
import { startServer } from "./lib/server.mjs";
import { openBrowser } from "./lib/chrome.mjs";

export const FPS = 30;
const LIB = "library.geml";

export async function renderShot(page, base, shot, outFile) {
  const frames = mkdtempSync(join(tmpdir(), `explainer-${shot.id}-`));
  try {
    await page.goto(`${base}/scenes/stage.html?scene=${shot.id}`);
    const n = Math.round(shot.duration * FPS);
    for (let f = 0; f < n; f++) {
      await page.evaluate(`window.__seek(${f / FPS})`);
      writeFileSync(join(frames, `${String(f).padStart(5, "0")}.png`), await page.screenshot());
    }
    if (page.errors.length > 0) throw new Error(`${shot.id} 渲染时页面报错：\n${page.errors.join("\n")}`);
    const r = spawnSync(FFMPEG, ["-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(frames, "%05d.png"),
      "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), outFile], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg 编码 ${shot.id} 失败：\n${r.stderr}`);
  } finally {
    rmSync(frames, { recursive: true, force: true });
  }
}

async function main(argv) {
  const all = argv.includes("--all");
  const only = argv.filter((a) => /^s\d\d$/.test(a));
  const shots = shotTable().filter((s) => only.length === 0 || only.includes(s.id));
  // 先把场景模块的哈希刷成现值：改过的模块这时变成新哈希，
  // 用它渲出来的镜头在 check 眼里就「过期」了 —— 下一行问的正是这个。
  for (const s of shots) registerFile(LIB, `scene-${s.id}`, `scenes/${s.id}.js`, { kind: "other", role: "workflow", of: s.concept });
  const todo = shots.filter((s) => all || only.length > 0 || needsRegen(LIB, `shot-${s.id}`));
  if (todo.length === 0) { console.log("没有过期的镜头；要全渲加 --all"); return; }

  mkdirSync(join(ROOT, "assets"), { recursive: true });
  const server = await startServer(ROOT);
  const page = await openBrowser();
  try {
    for (const s of todo) {
      const t0 = Date.now();
      const file = `assets/shot-${s.id}.mp4`;
      await renderShot(page, server.url, s, join(ROOT, file));
      registerFile(LIB, `shot-${s.id}`, file, { kind: "video", role: "take", of: s.concept });
      logGen(LIB, { output: `shot-${s.id}`, model: "render-scenes", mode: "code2v", inputs: [`scene-${s.id}`] });
      console.log(`${s.id}  ${s.duration}s  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${file}`);
    }
  } finally {
    await page.close();
    await server.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
```

- [ ] **Step 2: 渲一遍，校验产物与血缘**

```bash
cd playground/geml-media-explainer
node tools/render-scenes.mjs
ffprobe -v error -show_entries stream=width,height,r_frame_rate,nb_frames -of csv=p=0 assets/shot-s07.mp4
node ../../geml-parser/dist/geml.js check library.geml --root .
node tools/render-scenes.mjs
```

Expected: `s07  14s  用时 …s → assets/shot-s07.mp4`；`1920,1080,30/1,420`；`ok: no diagnostics`；第二次打印 `没有过期的镜头；要全渲加 --all`。

- [ ] **Step 3: 验「改场景 → 过期 → 只重渲它」**

```bash
cd playground/geml-media-explainer
echo "// touch" >> scenes/s07.js
node tools/render-scenes.mjs          # 应当重渲 s07
git checkout scenes/s07.js
node tools/render-scenes.mjs          # 模块回到原值也是一次变化，应当再重渲一次
node ../../geml-parser/dist/geml.js check library.geml --root .
```

Expected: 两次都打印 `s07 … → assets/shot-s07.mp4`；最后 `ok: no diagnostics`；`gen-log` 里 `#shot-s07` 有三条记录（渲染史，只追加）。

- [ ] **Step 4: 提交**

```bash
git add playground/geml-media-explainer/tools/render-scenes.mjs playground/geml-media-explainer/assets/shot-s07.mp4 playground/geml-media-explainer/library.geml
git commit -m "feat(explainer): render shots from scene modules, re-rendering only what check calls stale"
```

---

## Task 7: `tools/make-voice.mjs`

**Files:**
- Create: `playground/geml-media-explainer/tools/make-voice.mjs`
- Output: `assets/voice-s07-{zh,en}-{1,2}.wav`、四个素材块与四条记录

- [ ] **Step 1: 实现**

```js
#!/usr/bin/env node
// 旁白：script.geml 里每条 .line → macOS say → wav → 登记 → 生成记录（prompt 指回那条台词）。
//
//   node tools/make-voice.mjs            只重做过期的（台词改了字，check 会说它的配音过期）
//   node tools/make-voice.mjs --all
//   node tools/make-voice.mjs s07
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, FFMPEG, listIds, blockBody, registerFile, logGen, needsRegen } from "./lib/geml.mjs";

const LIB = "library.geml";
export const PREFERRED = { zh: "Tingting", en: "Samantha" };
const LOCALE = { zh: "zh_CN", en: "en_US" };

/** 首选声音在就用它，不在就用同语言的第一个。实际用的名字进记录的 model。 */
export function pickVoice(lang) {
  const r = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("没有 say：旁白目前只支持 macOS");
  const voices = r.stdout.split("\n").map((l) => l.match(/^(.+?)\s{2,}(\w\w_\w\w)\s/)).filter(Boolean)
    .map((m) => ({ name: m[1].trim(), locale: m[2] }));
  const want = PREFERRED[lang];
  if (voices.some((v) => v.name === want || v.name.startsWith(`${want} (`))) return want;
  const alt = voices.find((v) => v.locale === LOCALE[lang]);
  if (alt === undefined) throw new Error(`本机没有 ${LOCALE[lang]} 的声音`);
  return alt.name.replace(/\s*\(.*$/, "");
}

function synth(text, voice, outWav) {
  const aiff = outWav.replace(/\.wav$/, ".aiff");
  let r = spawnSync("say", ["-v", voice, "-o", aiff, text], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`say -v ${voice} 失败：${r.stderr}`);
  r = spawnSync(FFMPEG, ["-loglevel", "error", "-y", "-i", aiff, "-ar", "44100", "-ac", "1", outWav], { encoding: "utf8" });
  rmSync(aiff, { force: true });
  if (r.status !== 0) throw new Error(`ffmpeg 转 wav 失败：${r.stderr}`);
}

async function main(argv) {
  const all = argv.includes("--all");
  const only = argv.filter((a) => /^s\d\d$/.test(a));
  const ids = listIds("script.geml").filter((id) => /^vo-s\d\d-(zh|en)-\d+$/.test(id))
    .filter((id) => only.length === 0 || only.includes(id.split("-")[1]));
  const voices = { zh: pickVoice("zh"), en: pickVoice("en") };
  mkdirSync(join(ROOT, "assets"), { recursive: true });
  let made = 0;
  for (const id of ids) {
    const asset = id.replace(/^vo-/, "voice-");
    if (!all && !needsRegen(LIB, asset)) continue;
    const lang = id.split("-")[2];
    const file = `assets/${asset}.wav`;
    synth(blockBody("script.geml", id), voices[lang], join(ROOT, file));
    const a = registerFile(LIB, asset, file, { kind: "audio", role: "voice", of: "concepts.geml#narrator" });
    logGen(LIB, { output: asset, model: `say-${voices[lang]}`, mode: "tts", prompt: `script.geml#${id}` });
    console.log(`${id}  ${a.duration}s  ${voices[lang]} → ${file}`);
    made++;
  }
  if (made === 0) console.log("没有过期的旁白；要全做加 --all");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
```

- [ ] **Step 2: 生成并校验**

```bash
cd playground/geml-media-explainer
node tools/make-voice.mjs
node ../../geml-parser/dist/geml.js check library.geml --root .
node ../../geml-parser/dist/geml.js media todo script.geml --root .
node tools/make-voice.mjs
```

Expected: 四行 `vo-s07-…  N.NNNs  Tingting|Samantha → …`；`ok: no diagnostics`；`todo` 不列任何「配音」项；第二次打印 `没有过期的旁白`。

- [ ] **Step 3: 验「改台词 → 配音过期 → 只重做它」**

```bash
cd playground/geml-media-explainer
sed -i '' 's/每一次生成，都记下当时每个输入的哈希。/每次生成，都记下当时每个输入的哈希。/' script.geml
node ../../geml-parser/dist/geml.js check library.geml --root .   # 期望：voice-s07-zh-1 一条 media-stale-generation
node tools/make-voice.mjs                                          # 期望：只重做 vo-s07-zh-1
git checkout script.geml && node tools/make-voice.mjs              # 改回来，再重做一次
```

- [ ] **Step 4: 提交**

```bash
git add playground/geml-media-explainer/tools/make-voice.mjs playground/geml-media-explainer/assets/voice-s07-*.wav playground/geml-media-explainer/library.geml
git commit -m "feat(explainer): narration via macOS say, each take logged against its line"
```

---

## Task 8: `tools/lay-cut.mjs` 与 `tools/check-timing.mjs`

**Files:**
- Create: `playground/geml-media-explainer/tools/lay-cut.mjs`
- Create: `playground/geml-media-explainer/tools/check-timing.mjs`
- Test: `playground/geml-media-explainer/tools/test/lay-cut.test.mjs`
- Output: `cut-zh.geml`、`cut-en.geml`

- [ ] **Step 1: 写失败的测试**

```js
// lay-cut.test.mjs —— 时间线的派生规则。用假时长，不碰真素材。
import { test } from "node:test";
import assert from "node:assert/strict";
import { layCut, LEAD, GAP } from "../lay-cut.mjs";
import { spans } from "../check-timing.mjs";

const shots = [{ id: "s07", duration: 14 }, { id: "s08", duration: 10 }];
const lines = { "s07:zh": [["vo-s07-zh-1", 4], ["vo-s07-zh-2", 6.5]], "s08:zh": [["vo-s08-zh-1", 3]] };
const src = { shots, lines: (shot, lang) => lines[`${shot}:${lang}`] ?? [], hasBgm: false };

test("主轨顺排；旁白与字幕同锚、同 offset；第二句接在第一句后面", () => {
  const out = layCut("zh", src);
  assert.match(out, /=== media-clip \{#v-s07 track=video src=library\.geml#shot-s07 in=0 out=14\}/);
  assert.match(out, /=== media-clip \{#v-s08 track=video src=library\.geml#shot-s08 in=0 out=10\}/);
  assert.ok(out.indexOf("#v-s07") < out.indexOf("#v-s08"));
  assert.match(out, new RegExp(`#n-s07-1 track=narration src=library\\.geml#voice-s07-zh-1 over=#v-s07 offset=${LEAD}\\}`));
  assert.match(out, new RegExp(`#t-s07-1 track=subtitle src=script\\.geml#vo-s07-zh-1 over=#v-s07 offset=${LEAD} duration=4\\}`));
  const second = Number((LEAD + 4 + GAP).toFixed(3));
  assert.match(out, new RegExp(`#n-s07-2 [^}]*offset=${second}\\}`));
  assert.match(out, new RegExp(`#t-s07-2 [^}]*offset=${second} duration=6\\.5\\}`));
});

test("没有配乐素材就不放 music 片段；有就铺满全片", () => {
  assert.doesNotMatch(layCut("zh", src), /track=music/);
  assert.match(layCut("zh", { ...src, hasBgm: true }),
    /=== media-clip \{#music track=music src=library\.geml#bgm over=#v-s07 in=0 out=24 gain=-20dB fade-in=1 fade-out=3\}/);
});

test("同一输入两次输出逐字相同", () => {
  assert.equal(layCut("en", src), layCut("en", src));
});

test("spans：算出每镜旁白的结束时刻，超了就标出来", () => {
  const r = spans("zh", src);
  assert.deepEqual(r.find((x) => x.shot === "s07"), { shot: "s07", lang: "zh", end: Number((LEAD + 4 + GAP + 6.5).toFixed(3)), limit: 14, over: false });
  assert.equal(spans("zh", { ...src, lines: () => [["x", 20]] })[0].over, true);
});
```

- [ ] **Step 2: 跑，确认失败**

Run: **T**
Expected: FAIL，`Cannot find module …/tools/lay-cut.mjs`

- [ ] **Step 3: 实现 `tools/lay-cut.mjs`**

```js
#!/usr/bin/env node
// 从剧本与素材库派生两份时间线。cut-*.geml 是这个工具的产物：手改会在下次运行时被覆盖。
//
//   node tools/lay-cut.mjs
//
// 规则（设计 §6）：主轨按分镜表顺排，每镜长度是定值；每镜的旁白从 LEAD 秒起、句与句
// 之间隔 GAP 秒，锚在本镜上；字幕与旁白同锚、同 offset，长度取旁白的实测时长。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, shotTable, lineIds, blockAttrs, hasBlock } from "./lib/geml.mjs";

export const LEAD = 0.3;
export const GAP = 0.25;
const r3 = (x) => Number(x.toFixed(3));
const TITLE = { zh: "中文版时间线", en: "英文版时间线" };

/** src：{ shots:[{id,duration}], lines:(shot,lang)=>[[lineId, seconds]…], hasBgm } —— 测试可以给假的。 */
export function layCut(lang, src) {
  const out = [
    "=== meta", `title = "geml-media 讲解片 · ${TITLE[lang]}"`, 'profile = "geml-media/v1"', "===", "",
    "%% 由 tools/lay-cut.mjs 从 script.geml 与 library.geml 派生，手改会被覆盖。", "",
    `==== media {#explainer-${lang} tracks="video:video narration:audio music:audio subtitle:prose" primary=video fps=30}`, "",
  ];
  const clip = (attrs) => out.push(`=== media-clip {${attrs}}`, "===", "");
  for (const s of src.shots) clip(`#v-${s.id} track=video src=library.geml#shot-${s.id} in=0 out=${s.duration}`);
  if (src.hasBgm) {
    const total = r3(src.shots.reduce((a, s) => a + s.duration, 0));
    clip(`#music track=music src=library.geml#bgm over=#v-${src.shots[0].id} in=0 out=${total} gain=-20dB fade-in=1 fade-out=3`);
  }
  for (const s of src.shots) {
    let at = LEAD;
    src.lines(s.id, lang).forEach(([id, dur], k) => {
      const n = k + 1;
      clip(`#n-${s.id}-${n} track=narration src=library.geml#${id.replace(/^vo-/, "voice-")} over=#v-${s.id} offset=${r3(at)}`);
      clip(`#t-${s.id}-${n} track=subtitle src=script.geml#${id} over=#v-${s.id} offset=${r3(at)} duration=${r3(dur)}`);
      at += dur + GAP;
    });
  }
  out.push("====", "");
  return out.join("\n");
}

/** 从真实文档读出 layCut 要的输入。旁白还没做的，直接报错叫人先跑 make-voice。 */
export function realSource(root = ROOT) {
  return {
    shots: shotTable(root),
    hasBgm: hasBlock("library.geml", "bgm", root),
    lines: (shot, lang) => lineIds(shot, lang, root).map((id) => {
      const asset = id.replace(/^vo-/, "voice-");
      if (!hasBlock("library.geml", asset, root)) throw new Error(`#${asset} 还没有：先跑 node tools/make-voice.mjs`);
      return [id, Number(blockAttrs("library.geml", asset, root).duration)];
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const src = realSource();
    for (const lang of ["zh", "en"]) {
      writeFileSync(join(ROOT, `cut-${lang}.geml`), layCut(lang, src));
      console.log(`wrote cut-${lang}.geml`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
```

- [ ] **Step 4: 实现 `tools/check-timing.mjs`**

```js
#!/usr/bin/env node
// 旁白不得超出所在镜头（设计 §6）。镜头时长是定值，旁白迁就画面：短了留静音，长了改词。
//
//   node tools/check-timing.mjs      超了就非零退出
import { pathToFileURL } from "node:url";
import { LEAD, GAP, realSource } from "./lay-cut.mjs";

export function spans(lang, src) {
  return src.shots.map((s) => {
    const lines = src.lines(s.id, lang);
    const end = lines.length === 0 ? 0 : LEAD + lines.reduce((a, [, d]) => a + d, 0) + GAP * (lines.length - 1);
    return { shot: s.id, lang, end: Number(end.toFixed(3)), limit: s.duration, over: end > s.duration };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const src = realSource();
    const rows = ["zh", "en"].flatMap((lang) => spans(lang, src));
    for (const r of rows) console.log(`${r.over ? "超" : "  "} ${r.shot} ${r.lang}  ${r.end.toFixed(2)}s / ${r.limit}s`);
    if (rows.some((r) => r.over)) process.exit(1);
  } catch (e) { console.error(e.message); process.exit(1); }
}
```

- [ ] **Step 5: 跑测试**

Run: **T**
Expected: 本文件 4 个测试 PASS。

- [ ] **Step 6: 用真实素材生成并校验**

```bash
cd playground/geml-media-explainer
node tools/check-timing.mjs
node tools/lay-cut.mjs
for f in cut-zh.geml cut-en.geml; do node ../../geml-parser/dist/geml.js check $f --root . || exit 1; done
```

Expected: 两行时长都不带「超」；`wrote cut-zh.geml` / `wrote cut-en.geml`；两次 `ok: no diagnostics`。若报超，改 `script.geml` 里那一句的措辞、重跑 `make-voice.mjs`，**不改镜头时长**。

- [ ] **Step 7: 提交**

```bash
git add playground/geml-media-explainer/tools/lay-cut.mjs playground/geml-media-explainer/tools/check-timing.mjs playground/geml-media-explainer/tools/test/lay-cut.test.mjs playground/geml-media-explainer/cut-zh.geml playground/geml-media-explainer/cut-en.geml
git commit -m "feat(explainer): derive the zh and en cuts; narration may not outrun its shot"
```

---

## Task 9: 出片与 `tools/verify.mjs`

**Files:**
- Create: `playground/geml-media-explainer/tools/verify.mjs`
- Create: `playground/geml-media-explainer/README.md`
- Output（不进库）：`out/explainer-{zh,en}.mp4` 与 `.srt`

- [ ] **Step 1: 实现 `tools/verify.mjs`**

```js
#!/usr/bin/env node
// 设计 §8 的检查，任一失败即非零退出。不进 CI（要 Chromium 与 macOS TTS），手动跑：
//
//   node tools/verify.mjs
//
// 1. 两份 cut 的 geml check 零诊断  2. 旁白不超镜头  3. 出片：时长与模型一致到 3 位小数、
// 有音轨、srt 条目数等于字幕片段数。场景的确定性与非空白由 tools/test/scenes.test.mjs 管。
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, FFPROBE, geml, checkJson, shotTable, probeDuration } from "./lib/geml.mjs";

let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? "ok  " : "FAIL"}  ${what}`); if (!cond) failed++; };

for (const lang of ["zh", "en"]) {
  const { core, profile } = checkJson(`cut-${lang}.geml`);
  const all = [...core, ...profile];
  ok(all.length === 0, `cut-${lang}.geml 零诊断${all.length ? "：" + JSON.stringify(all) : ""}`);
}

const timing = spawnSync(process.execPath, [join(ROOT, "tools/check-timing.mjs")], { cwd: ROOT, encoding: "utf8" });
ok(timing.status === 0, `旁白不超镜头\n${timing.stdout.trimEnd()}`);

mkdirSync(join(ROOT, "out"), { recursive: true });
const expected = shotTable().reduce((a, s) => a + s.duration, 0);
for (const lang of ["zh", "en"]) {
  const mp4 = `out/explainer-${lang}.mp4`;
  const b = geml(["media", "build", `cut-${lang}.geml`, "--out", mp4, "--root", "."], { allowFail: true });
  ok(b.code === 0, `build ${mp4}${b.code ? "\n" + b.stderr + b.stdout : ""}`);
  if (b.code !== 0) continue;
  const got = probeDuration(join(ROOT, mp4));
  ok(got.toFixed(3) === expected.toFixed(3), `${mp4} 时长 ${got.toFixed(3)} = 模型 ${expected.toFixed(3)}`);
  const a = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", join(ROOT, mp4)], { encoding: "utf8" });
  ok(a.stdout.trim().split("\n").filter(Boolean).length === 1, `${mp4} 有且只有一条音轨`);
  const cues = (readFileSync(join(ROOT, mp4.replace(/\.mp4$/, ".srt")), "utf8").match(/-->/g) ?? []).length;
  const subs = (readFileSync(join(ROOT, `cut-${lang}.geml`), "utf8").match(/track=subtitle/g) ?? []).length;
  ok(cues === subs, `${lang} 字幕 ${cues} 条 = 字幕片段 ${subs} 个`);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑**

```bash
cd playground/geml-media-explainer && node tools/verify.mjs
```

Expected: 全部 `ok`，末行 `全部通过`，退出码 0。若时长差在 AAC 的前导帧（例如 14.021 对 14.000），**先报告实测值再决定**：要么把断言改成量视频流时长并在设计 §8 写明，要么查 `buildPlan` 的音频床长度——不要悄悄放宽容差。

- [ ] **Step 3: 听、看**

把 `out/explainer-zh.mp4` 与 `out/explainer-en.mp4` 发给用户（SendUserFile），附一句：这是 S07 单镜的切片，14 秒，无配乐。

- [ ] **Step 4: 写 `README.md`（切片阶段）**

````markdown
# geml-media 讲解片

一支用 geml-media 做出来的、讲 geml-media 的片子。设计：
[`docs/design/specs/2026-09-27-geml-media-explainer-design.md`](../../docs/design/specs/2026-09-27-geml-media-explainer-design.md)。

**现状：管线与 S07 一镜（血缘，14 秒）。** 其余 13 镜与配乐见设计 §9。

## 从源重建

前置：Node 24、ffmpeg / ffprobe、macOS（旁白用 `say`）、一个 Chromium（Playwright 缓存里的
`chrome-headless-shell`，或系统 Chrome，或 `CHROME=` 指过去）。仓库根先
`cd geml-parser && npm ci && npm run build`。下面的命令都在本目录跑。

```bash
node tools/render-scenes.mjs   # 只渲 check 说过期的镜头；--all 全渲
node tools/make-voice.mjs      # 只做过期的旁白；--all 全做
node tools/lay-cut.mjs         # 派生 cut-zh.geml / cut-en.geml
node tools/verify.mjs          # check 零诊断、旁白不超镜头、出片并校时 → out/
```

## 预览一个场景

```bash
node -e 'import("./tools/lib/server.mjs").then(m => m.startServer(".", 8765))'
```

浏览器打开 `http://127.0.0.1:8765/scenes/stage.html?scene=s07&preview=1&d=14`，底部可拖。

## 文档

| 文件 | 是什么 |
|---|---|
| `concepts.geml` | 立意、旁白（说话人）、四个概念 |
| `script.geml` | 分镜表与中英旁白 |
| `library.geml` | 素材与生成日志 —— 由 `tools/` 经 geml CLI 维护 |
| `cut-zh.geml`、`cut-en.geml` | 时间线 —— `lay-cut.mjs` 的产物，别手改 |

场景模块 `scenes/sNN.js` 本身也登记在素材库里（`role=workflow`），每个镜头的生成记录把它列为
输入：改了场景代码，`geml check` 就说那个镜头过期，`render-scenes.mjs` 据此只重渲它。
````

- [ ] **Step 5: 跑全部测试并提交**

```bash
node --test "playground/geml-media-explainer/tools/test/*.test.mjs"
git add playground/geml-media-explainer/tools/verify.mjs playground/geml-media-explainer/README.md
git commit -m "feat(explainer): verify the slice end to end and document how to rebuild it"
```

---

## Task 10: 把实施中的偏离写回设计

**Files:**
- Modify: `docs/design/specs/2026-09-27-geml-media-explainer-design.md`

- [ ] **Step 1: 改 §4.3 第 4–5 步与 §4.4、§5.1**：素材块一律经 `geml add`（首次）/ `geml set --head`（此后）写入，**不用 `geml media import`**；理由指向 §10 #8，并补一句 import 也不写 `role` / `of`。

- [ ] **Step 2: 改 §5.1**：删去「初值用 `geml media lay` 给出」，改为「`lay-cut.mjs` 按 §6 的规则自己算：`lay` 把同锚的旁白与字幕当成先后排列，不适用」。删去 `params.voice`——`geml media log` 没有写 `params` 的参数，实际声音记在 `model`（`say-Tingting`）里。

- [ ] **Step 3: 改 §2**：`cut-*.geml` 标注为 `lay-cut.mjs` 的派生产物。

- [ ] **Step 4: §10 加两行**

| # | 落差 | 位置 | 本片如何绕开 |
|---|---|---|---|
| 9 | `geml media log --prompt <ref>` 在引用落到 root 之外时**静默**不写 `prompt-sha256`，那条记录的提示词血缘从此不可校验 | `cli.ts:618` 附近 | 工具每次都带 `--root .` |
| 10 | `geml media log` 不写 `prompt-refs`：CLI 记下的记录，过期时只能说「提示词」变了，说不出是哪个投射源（demo 里手写的记录能说出「投射源 `#hero-look`」） | `cli.ts` 的 `media log` | 接受；`prompt-sha256` 覆盖展开后的文本，过期照样判得出 |

- [ ] **Step 5: 提交**

```bash
git add docs/design/specs/2026-09-27-geml-media-explainer-design.md
git commit -m "docs(media): record where the explainer slice departed from its design"
```

---

## 计划 B（不在本计划内，切片跑通后另写）

- S01–S06、S08–S14 共 13 个场景模块，分镜表补全；
- `tools/capture-evidence.mjs` 与证据素材（设计 §4.2），`render-scenes.mjs` 把 `#evidence-sNN` 加进输入；
- 全部中英旁白与 `check-timing` 全绿；
- 配乐接入（设计 §5.2，取决于用户交付文件）；
- README 完整版；两个成片发 release（对外动作，届时确认）。
