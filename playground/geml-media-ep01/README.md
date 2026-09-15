# EP01 —— geml-media 的 P0 用例

设计稿 `docs/design/specs/2026-09-15-geml-media-design.md` 的 §14 把"跑一集真片"排在
词汇落地之前，理由是它自己那句话：**此刻真实用例是零**。这个目录就是那一集，
**只用今天的核心词汇**写成——没有 `media-asset`、没有 `media-clip`、没有 `media-text`，
一个 profile 都没声明。目的不是出片，是让用例来选词汇。

## 这不是什么

**没有 AI 生成的画面，也没有成片。** 一集真片要过生图、图生视频、TTS、口型四类生成器，
本机一个都没接（设计 §11 也明写 GEML 不接任何生成器）。所以：

- `assets/` 下是 **ffmpeg 合成的真视频真音频**（色块与正弦波，竖屏 270×480 / 24fps /
  16kHz 单声道），不是画面。它们几 KB 一个，进得了仓库。
- `duration` 由 **ffprobe 读出**，不是手写的。这一步不是形式：h264 按 GOP 收尾，标称
  5 秒的片子实际是 **5.083 秒**，手写的时长是意图，ffprobe 读的是事实，而时间线要按
  事实算才能和出片对得上。
- 因此本目录验证的是**文档这一层**：寻址、投射、血缘、过期传播。画面好不好看，这里
  一个字都没资格说。

重建素材：`node tools/make-assets.mjs`（ffmpeg 不在 PATH 就跳过并说清楚，不静默）。

## 怎么复现

```sh
node tools/make-assets.mjs                          # 用 ffmpeg 生成素材
node tools/sync-assets.mjs                          # 把 sha256 / duration 同步成文件真值
node tools/hash-prompts.mjs ep01/ep01-script.geml   # 展开投射，算提示词哈希
node tools/build-log.mjs                            # 重算哈希，生成 .gen-log
node tools/stale.mjs                                # 走血缘 DAG，报过期
for f in *.geml ep01/*.geml; do node ../../geml-parser/dist/geml.js check $f --root .; done
```

规模：**8 份文档 · 15 个素材 · 9 条生成记录 · 10 个片段**，逐份 `check` 全部干净。

**两处要注意的**：`geml check` 一次只收**一个**文件（`check a.geml b.geml` 静默地只查
第一个），所以要用循环；而且必须带 `--root .`——剧本里 `![[../characters.geml#hero-look]]`
这样的跨集投射，默认根是文档自己的目录，`..` 越界，会得到十条 `cannot resolve document`。
这是 §9.4 的根目录限定在按规矩办事，不是 bug，但它说明**项目级的检查需要一个项目级的入口**——
profile 的检查器不能是逐文档的。

## 核心词汇顶住了什么

| 要做的事 | 用了什么 | 结果 |
|---|---|---|
| 角色卡是所有提示词的单一源 | `text` + `![[…]]` 投射 | 改一处全变；实测改 `#hero-look` 一个词，三条提示词的哈希全变 |
| 分镜表给人扫、给机器算 | `table` + `view` | `#runtime` 合计 **19**；`#no-hook` 列出第 3 集；`#progress` 得 粗剪1/剧本1/大纲1 |
| 各集 brief 投射进全季 | `embed` | brief 原文出现在 `season.geml` 里，不复制 |
| 生成日志是记录流 | `data {format=jsonl}` | 坐标寻址可用：`geml get '#gen-log[8]["inputs"]'` 返回口型合成那条的三个输入 |
| 每个素材、每条记录、每个片段有地址 | 带 `#id` 的块 | 全部可寻址 |

**血缘链实测**（`tools/stale.mjs`）：把 `#hero-look` 里"齐耳"改成"及肩"——

```
过期记录 6 条:
  s01-key         ← 提示词 ep01-script.geml#s01-prompt; 投射源 ../characters.geml#hero-look
  s01-take3       ← 同上
  s01-take5       ← 同上
  s02-take1       ← 提示词 …#s02-prompt; 投射源 …#hero-look
  s03-take2       ← 提示词 …#s03-prompt; 投射源 …#hero-look
  s03-take2-lips  ← 上游过期 #s03-take2
受影响的片段: #c01a #c01b #c02 #c03
```

两条设计决定当场兑现：

- **`prompt-refs[]`**——诊断点名的是 `#hero-look`，不是含糊的"提示词变了"。
- **`output-sha256`**——重生 `#s03-take2`（换文件 + 追加一条新记录，旧记录原样留着）之后，
  它自己**不再过期**（当前记录被正确认出），只有真正依赖它的 `#s03-take2-lips` 过期。
  没有这个字段，旧记录会永远对不上现值，一次重生之后它就永远标黄。

## 疼在哪里

1. **素材与片段没有身份类型。** 用带 `#id` 的 `data` 块顶替是**可行的降级路径**（值得写进
   设计稿：不声明 profile 的项目照样能干活）。代价是 `src`、`sha256`、`of`、`over` 全是 JSON
   里的字符串，核心一个都不解析——**`check` 干净不等于引用有效**。把 `src` 指向不存在的
   素材、把 `of` 指错人，`check` 一声不吭。
2. **`speaker=` 挂不上 `text`**，只能另立一张 `#lines` 表拿 id 当外键。台词与它的说话人从此
   分居两处，改一个不会带动另一个。这是本次最疼的一处，`media-text` 的 `speaker` 键站得住。
3. **`shot=` 没真用上。** 镜号靠 id 命名约定（`#s01-prompt`）就够了，而且 `check` 同样能按
   命名核对。这个键的必要性**存疑**——见下。
4. **时间线的顺序没有载体。** "块在文件里的先后就是播放顺序"是约定，文档里没有任何东西
   表达它；插一个片段要靠 `geml add --after`，位置对不对无人校验。
5. **没有 `get --resolved`，寸步难行。** `prompt-sha256` 哈希的是展开投射之后的文本，而
   `geml get` 返回原文。所以这个项目不得不自带 `tools/hash-prompts.mjs`（40 行）。
   设计稿 §9 第 2 条的用例，这里是实物。

## 挖出的三个设计缺口

**一、`media log` 只说"追加一条记录"，没说更新素材块。** 重生一个镜头之后，文件变了、日志多了
一条，但素材块里声明的 `sha256=`（和 `duration`）还是旧的——真实 profile 下这会立刻
`media-hash-mismatch`（error）。对照 `media import`，设计稿明写它产出"素材块 + 日志记录"
两样；`log` 少了前一半。**§6 的 `media log` 一行要补上"并更新目标素材块的 `sha256` /
`duration`"**，否则每次重生都留下一个不一致的库。

**二、一次性占位符写不出可重跑的生成器。** `build-log.mjs` 原本靠替换一个
`PROMPT_HASHES_GO_HERE` 占位符写日志；占位符第一次就被用掉，之后每次运行都是空转 ——
素材换了、哈希刷新了，日志却停在旧值上，走血缘时每个素材都「来历不明」。改成重写
`.gen-log` 块的内容。凡是「生成物覆盖生成物」的工具都会撞上这一条。

**三、`.gen-log` 这个 class 漏了。** 第一版把日志写成 `data {#gen-log format=jsonl}`，
少了 class，而设计里正是靠这个 class 认出「这个 data 块按生成日志的 schema 验」。
id 看起来像标记，但它不是 —— 这正说明 class 与 id 的分工要在 profile 文档里说死。

## 实际用到 / 从没用到

对照设计稿 §5 的属性表与 §7 的诊断目录。"没用到"不等于该删，但它标出了**哪些是猜的**。

| §5.1 `media-asset` | 用到 | 没用到 |
|---|---|---|
| | `src` `sha256` `kind` `duration` `origin` `of` `role` | `license`（全是 generated）`mime` `fps` `size` |

| §5.2 `media-clip` | 用到 | 没用到 |
|---|---|---|
| | `track` `src` `in` `out` `over` `offset` `dur` `gain` `transition-in` `transition-dur` | `at` `speed` `xywh` `fade-in` `fade-out` |

| §5.3 记录字段 | 用到 | 没用到 |
|---|---|---|
| | `output` **`output-sha256`** `model` `mode` `prompt` `prompt-sha256` **`prompt-refs[]`** `inputs[]` `seed` `params` `at` | `cost` `tool` `prompt-text` `error` |

| §5.4 `media-text` 五键 | 结论 |
|---|---|
| `speaker` | **最痛**，外键表完全顶不了 |
| `to` `emotion` | 用到了，但都写在表里；作为属性会更好 |
| `shot` | **没用上**，id 命名约定顶掉了 |
| `since` | 一集之内**无从验证**（跨集才有意义），本轮不作数 |

**§7 里这一轮真正会救场的**：`media-src-unresolved`、`media-src-not-asset`、
`media-hash-mismatch`（重生后立刻遇到）、`media-dur-required`（字幕片段必须有 `dur`）、
`media-stale-generation`、`media-stale-clip`、`media-of-unresolved`、`media-track-missing`。

**一次都没接近的**：`media-runtime-off-target`（会误报：4 个镜头的 demo 合计 19 秒 vs
`target-duration = 75`）、`media-emotion-drift`、`media-look-outdated`、
`media-episode-mismatch`、`media-gen-before-approval`、`media-model-capability`、
`media-model-unknown`、`media-track-order`、`media-track-overlap`、
`media-transition-too-long`、`media-absolute-anchor`、`media-asset-unlinked`、
`media-gen-cycle`、`media-subtitle-unmatched`。

按 §14 "诊断码只落 P0 用过的那些"，上面第二组不进 P1。
