# geml-media 讲解片（计划 B1：双语管线、占位插画、S10）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管线按语言各渲一套镜头，接入可替换的漫剧图片素材（先是代码画的占位），并做出按新分镜重做的第一镜 S10（改发型），发给作者看。

**Architecture:** 场景模块的 `render(t, root, { lang })` 多收一个语言；`render-scenes.mjs` 每镜渲 `zh` / `en` 两遍，产出 `#shot-sNN-zh` / `#shot-sNN-en`，两者的生成记录都以 `#scene-sNN` 与该镜用到的图片素材为输入。图片是 `library.geml` 里的 `media-asset {kind=image}`，场景模块用 `export const uses = [...]` 声明用到哪几张；换一张图（同一个 id、新哈希）只让用到它的镜头过期。

**Tech Stack:** 同计划 A。

**依据：** 设计 §3（推翻后的版本）、§4.5、§7 的 S10。计划 A 的第一版 S07 作废。

**本计划刻意不预写场景代码。** S10 的视觉要按作者的反馈迭代；这里锁定的是接口、文件与验证方式。场景写完照计划 A Task 5 的办法截四个时刻逐张看。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `scenes/s07.js`、`assets/shot-s07.mp4`、`assets/voice-s07-*.wav` | 删 | 第一版 S07 作废 |
| `library.geml` | 改 | 删掉 `#scene-s07`、`#shot-s07`、`#voice-s07-*` 与它们的记录 |
| `script.geml` | 改 | 分镜表只列已做的镜头（S10）；S10 两语旁白 |
| `scenes/stage.html` | 改 | 读 `lang`，传给 `render` |
| `scenes/lib.js` | 改 | `tr(lang, table)` 取文案；`img(id)` 取素材库里图片的 URL |
| `scenes/art.js` | 新 | 占位插画：按外貌参数画扁平半身像 / 双人中景（SVG 字符串），纯函数 |
| `tools/make-placeholders.mjs` | 新 | 用 `art.js` 写出 `assets/art/*.svg`，登记为 `kind=image` 素材并记 `model=placeholder-svg` |
| `tools/lib/geml.mjs` | 改 | `LANGS = ["zh", "en"]` |
| `tools/render-scenes.mjs` | 改 | 每镜 × 每语言；输入 = `#scene-sNN` + 场景 `uses` 的图片 |
| `tools/lay-cut.mjs` | 改 | video 片段指向 `#shot-sNN-<lang>` |
| `scenes/s10.js` | 新 | S10 |
| `tools/test/*.test.mjs` | 改/新 | 见各任务 |

图片素材 id（与即梦出图清单的编号对应）：

| id | 清单 | 内容 |
|---|---|---|
| `art-hero-sheet` | ① | 林夏角色图，银灰短发 |
| `art-sister-sheet` | ② | 林岚角色图 |
| `art-s01-key` | ③ | S01 林夏特写，银灰 |
| `art-s03-take2` | ④ | S03 双人中景，银灰 |
| `art-hero-sheet-v2` | ⑤ | 林夏角色图，黑色长发 |
| `art-s01-key-v2` | ⑥ | S01 林夏特写，黑色长发 |
| `art-s03-take2-v2` | ⑦（追加） | S03 双人中景，黑色长发——S10 的结尾要「全部重做完、再查一遍全绿」，缺它就只能重做一半 |

---

## Task 1: 撤掉第一版 S07

- [ ] 删 `scenes/s07.js`、`assets/shot-s07.mp4`、`assets/voice-s07-*.wav`；`geml delete library.geml '#scene-s07' '#shot-s07' '#voice-s07-zh-1' …`；清掉 `#gen-log` 里 `output` 指向它们的记录（记录只追加是对**活着的**素材说的；素材整个删掉，它的记录就是孤儿）。
- [ ] `script.geml` 分镜表改为只有 `| s10 | 16 | concepts.geml#lineage |`，删掉 S07 旁白，加 S10 旁白四句（`vo-s10-{zh,en}-{1,2}`）。
- [ ] `tools/test/scenes.test.mjs` 不动（它按分镜表迭代）。
- [ ] 验：`geml check library.geml script.geml --root .` 零诊断；**T** 里 scenes 测试因为 `s10.js` 还不存在而失败——这是预期，Task 5 补上。
- [ ] 提交：`refactor(explainer): retire the first S07; the storyboard starts over at S10`

## Task 2: 语言贯穿舞台与文案

- [ ] 测试（`scene-lib.test.mjs` 追加）：`tr("en", { zh: "甲", en: "A" }) === "A"`；缺该语言时抛错（不静默回落到另一种语言——英文版里冒出一行中文标题比报错更糟）。
- [ ] `lib.js` 加 `tr`；`stage.html` 读 `q.get("lang") ?? "zh"`，`mod.render(t, root, { lang })`。
- [ ] `stage.test.mjs` 追加：`_probe.js` 按 `lang` 画不同颜色，`lang=zh` 与 `lang=en` 同一 t 截图不同。
- [ ] 提交：`feat(explainer): scenes render per language`

## Task 3: 占位插画与图片素材

- [ ] 测试（`art.test.mjs`）：`portrait({ hair: "silver-bob" })` 与 `portrait({ hair: "black-long" })` 输出不同且都是合法的 `<svg …>…</svg>`；同一参数两次输出逐字相同。
- [ ] `scenes/art.js`：`portrait(opts)`（半身像：发型 / 发色 / 衣服 / 眉疤）、`twoShot(left, right)`（双人中景）。9:16，冷色调蓝紫底——即梦提示词里的画风。
- [ ] `tools/make-placeholders.mjs`：写 `assets/art/<id>.svg` 七张，逐张 `registerFile(..., { kind: "image", role })`（`role`：角色图 `sheet`，镜头图 `take`），`logGen(model=placeholder-svg, mode=code2i)`。只重做过期或缺失的。
- [ ] 验：`geml check library.geml --root .` 零诊断；再跑一遍打印「没有要重做的占位图」。
- [ ] 提交：`feat(explainer): placeholder manju art as replaceable image assets`

## Task 4: 渲染与时间线按语言展开

- [ ] `lay-cut.test.mjs` 改：video 片段 `src=library.geml#shot-s07-zh`（中文 cut）/ `…-en`（英文 cut）。
- [ ] `render-scenes.mjs`：在 node 里 `import` 场景模块读 `uses`（`lib.js` 顶层不碰 DOM，所以 node 能加载）；对每个 `lang`：`needsRegen(shot-sNN-lang)` 才渲；`logGen` 的 `inputs = [scene-sNN, ...uses]`。
- [ ] `lay-cut.mjs`：video 片段 `src=library.geml#shot-${id}-${lang}`。
- [ ] 提交：`feat(explainer): one shot per language, each logged against its scene and art`

## Task 5: S10

- [ ] 写 `scenes/s10.js`（`uses` 列出它用到的图片）。节拍（16 秒）：
  - 0–2：步骤标题「改需求的时候」/「When the brief changes」；画面淡入：左角色卡（`characters.geml` 里 `#hero-look` 的原文与角色图）、右上素材库（四个 take 缩略图）、右下剪映式时间线（`#c01`、`#c03` 两段）、终端。
  - 2–4：导演便签「女主改成黑色长发」/「Make her hair long and black」。
  - 4–6.5：光标进角色卡，「银灰短发齐耳」→「黑色长发及腰」（文档原文不翻译）。
  - 6.5–8：终端打出 `$ geml check ep01/ep01-cut.geml --root .`。
  - 8–11：真实输出六行逐行出现（行尾截断加 `…`），**同时**对应的缩略图与时间线片段亮黄、挂上「要重做」/「redo」标签——缩略图里还是银发。诊断码只在终端里小字出现，大字信号是画面上亮起来的缩略图。
  - 11–12：小结「6 处要重做 · 不多不少」/「6 to redo — no more, no less」。
  - 12–15：重新生成：缩略图逐个换成黑发版，标签变绿勾。
  - 15–16：终端 `ok: no diagnostics`，全绿。
- [ ] **T**：`s10：三个时刻…` 两语各一条都 PASS。
- [ ] 截 `zh` 的 3 / 5.5 / 9.5 / 15.5 秒与 `en` 的 9.5 秒，逐张看：不重叠、不溢出、英文版没有漏翻的标题；缩略图里银发 / 黑发一眼可辨。
- [ ] `render-scenes` → `make-voice` → `check-timing` → `lay-cut` → `verify`，全绿。
- [ ] 把 `out/explainer-zh.mp4`、`out/explainer-en.mp4` 发给作者。
- [ ] 提交：`feat(explainer): S10, when the brief changes — one edit, one check, six shots to redo`

---

## 计划 B2（已完成，未单独成文）

S10 之后，作者要求「先完全完成剩余的工作」，出图放到后面。按设计 §7 的分镜直接做完，未另写计划：

- `tools/capture-evidence.mjs`：十一条证据，全部对 demo 副本跑真实命令；只差时间戳的重采保留旧文件。
- `scenes/kit.js`：公共部件；其余 13 个场景（S01–S09、S11–S14）。
- `script.geml`：14 镜的分镜表、50 句中英旁白、七张即梦图与配乐的提示词块。
- `tools/import-generated.mjs`：即梦图 / Suno 配乐换进素材库；`tools/snap.mjs`：截帧。
- CDP 调用加期限；旁白改 AAC（设计 §11）。
- 结果：`verify.mjs` 全绿，两个成片各 150.000 秒，中英各 26 条字幕；测试 67 条全过。
