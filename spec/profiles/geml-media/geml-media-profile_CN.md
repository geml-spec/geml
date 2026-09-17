# geml-media profile v1 — 素材、剪辑与生成血缘

*[English](geml-media-profile.md) | 中文*

- 状态：**草案**，其中 `media-text` 依赖 [GEP-0013](../../proposals/0013-prose-body-for-vocabularies.md)（草案）：在词汇表可以声明散文体之前，这个类型是对 §8.6.2 规则 4 的偏离，不是被放行的扩展。下面的词汇已在参考实现里注册，并由一个真实用例跑过
  （[`playground/geml-media-demo/`](../../../playground/geml-media-demo/README.md)）；
  设计记录在
  [`2026-09-15-geml-media-design.md`](../../../docs/design/specs/2026-09-15-geml-media-design.md)。
- 性质：**应用层 profile，不是 GEML 标准的一部分。** 它放行三个块类型名、这些类型上的
  属性键，以及一个说明 `data` 块怎么读的 class（`.gen-log`）。§8.6 允许一份词汇表放行的
  正是这些。规范一个字不动。

## 0. 一段话说清

用生成模型做图和视频的流水线，产出的**中间产物**远多于成片：演员表、角色卡、风格板、
分镜表、提示词、台词、参考图、take、配音、口型合成、字幕、时间线。这份 profile 给它们
每一个**一个带地址的块**，把每次生成记成一条**只追加的记录**，记下**生成当刻**每个输入的
哈希，于是"我改了角色卡，哪些镜头要重做"变成 `geml check` 能回答的问题。素材是有身份的
文件（`sha256`）；一个片段是**对它某一段的引用**，从不复制字节——和
`code {src=file#L14-24}` 指向源码的一段是同一个形状。

## 1. 声明 profile

```geml
=== meta
profile = "geml-media/v1"
===
```

不声明，同一份文档解析出同一个模型（§8.6 规则 4），三个类型名是 `unknown-block-type`。
不认识这个 profile 名的处理器把声明当作不存在（§8.6 规则 3），依然合规：它看到的是散文和
raw 块，而它们本来就是。

## 2. `media` —— 一段可播的东西

一份文档里的每一个 `media` 块各是**一条时间线**。轨道表、主轨、帧率挂在块上，不在
文档 `meta` 里：它们是这条时间线的事实，不是装着它的那份文件的。挂在块上它们就是
属性，于是这份词汇表的属性表会查它们的拼写——`primry=` 当场报，而写在 `meta` 里的
`primry` 是静默的。

两种形态由**形状**分，不由属性分，和 `<video>` 的做法一样：

```geml
==== media {#ep01 tracks="video:video dialogue:audio subtitle:prose" primary=video fps=24}

=== media-clip {#c01 track=video src=library.geml#s01-take3 in=0 out=4}
===

====
```

```geml
=== media {#hero-shot src=library.geml#s01-take3 in=0 out=4}
===
```

**有体是装配**（`<video><source>…</video>`），**无体加 `src=` 是一个可播的单源**
（`<video src>`）。单源就是「只有一个片段的时间线」，所以播放、出片、导出三条路一行
代码都不用分叉。没有 `type=` 或 `format=` 去重说一遍形状：同一件事两个说法，总有一天
互相矛盾。

| 键 | 形态 | 含义 |
|---|---|---|
| `tracks` | 装配 | 空格分隔的 **`名字:种类`** 列表。种类只有 `video` / `audio` / `prose`，说的是内容是什么。声明的顺序就是轨道的顺序 |
| `primary` | 装配 | 主轨的名字。**缺省是声明的第一条轨**——那是其余轨都锚上去的脊梁 |
| `fps` | 都可 | 这条时间线的帧率。只有写了 `hh:mm:ss:ff` 时码才用得上 |
| `src` | 单源 | 指向一个 `media-asset`。有体时不该出现 |
| `in` | 都可 | **源内的入点**：从被引文件的第几秒开始取。剪辑软件与 W3C Media Fragments 用的都是这个词 |
| `out` | 都可 | **源内的出点**。长度 = `out` − `in` |
| `duration` | 都可 | 直接给长度，用于说不出 `out` 的源。优先级：`out` > `duration` > 源的固有时长 |

有三个键是**故意不在这儿**的。**画面比例是呈现**，写在样式表上（`component=player
aspect=9:16`）。**种类**从被引的 `media-asset` 的 `kind=` 读，不在引用它的地方重说一遍。
**播放策略**——自动播、循环、静音、控件——根本不是文档的事实：`<video>` 身上那一堆
属性一个都不进来，因为它是页面里的呈现元素，而 `media` 是关于内容的陈述。

**音频不另立类型。** HTML 分 `<audio>` / `<video>` 是因为渲染的盒子不同。这里种类是
**数据**（素材上的 `kind=`、轨道表里的 `dialogue:audio`），不是类型。只有对白轨没有画面
的粗剪照样是一条时间线，而这里每条真实的时间线都是混合的。

## 3. `media-asset` —— 一个文件

| 键 | 必需 | 含义 |
|---|---|---|
| `src` | 是 | 文件路径，相对文档解析，受 §9.4 的根目录限定 |
| `sha256` | 推荐 | 文件的 SHA-256，**全长 64 位十六进制，不截短**。键名已点明算法，所以值不带前缀。缺失 → `media-asset-unhashed`，该素材的血缘无法校验 |
| `kind` | 条件 | `image`、`video`、`audio`、`model`、`other`，可由扩展名推断。**没有 `text`**：字幕文件、LUT、外部提示词文件先归 `other`，等真有用例再按它是什么命名 |
| `duration` | 视频/音频 | 秒。缺失且本机没有 `ffprobe` 时，入出点不校验（`media-duration-unknown`） |
| `fps`、`size` | 否 | 帧率；`宽x高` |
| `origin` | 推荐 | `generated`、`captured`、`licensed` —— 合规审核问的第一个问题 |
| `license` | 条件 | 授权依据。`captured`/`licensed` 而缺失 → `media-license-missing` |
| `mime` | 否 | 显式媒体类型，覆盖扩展名推断 |
| `of` | 推荐 | 这份素材**画的是谁**：指向它所属的角色、场景或道具块 |
| `role` | 推荐 | 它在生成里当什么用：`sheet`、`master`、`lora`、`voice`、`first-frame`、`last-frame`、`style-ref`、`workflow`、`take`，或宿主词。开放集 |

body 是 raw，放作者自己的备注。备注是文档事实，进历史；它不是 caption——渲染成什么由
样式表决定。

**文件缺失是 warning，哈希不符是 error。** 一份描述别处素材的库照样是合法文档，只是未校验
（`media-file-missing`）。文件在、内容却不是它说的那个（`media-hash-mismatch`），比没有更糟：
那是错的文件。

## 4. `media-clip` —— 时间线上的一个片段

| 键 | 必需 | 含义 |
|---|---|---|
| `track` | 是 | 轨道名，须在 `meta.tracks` 里声明过。下面哪几条规则适用，由轨道的**种类**决定，不由轨道的名字决定 |
| `src` | 是 | 块引用。`video`/`audio` 种类的轨必须指 `media-asset`；`prose` 种类的轨必须指 `media-text` |
| `in`、`out` | `video`/`audio` | 素材内的起止，秒**或** `hh:mm:ss:ff` 时码（按 `meta.fps` 换算） |
| `duration` | 无固有时长的源 | 静图或一段散文在时间线上占多久 |
| `over` | 非主轨 | 锚到**主轨**上的某个片段 |
| `offset` | 否 | 相对锚点起点的秒数，默认 0 |
| `at` | 否 | 绝对起点。逃生口：写了它，锚定被忽略 |
| `transition-in`、`transition-out` | 否 | `cut`（默认）、`dissolve`、`fade`、`crossfade`，或宿主词 |
| `transition-duration` | 否 | 秒 |
| `gain`、`fade-in`、`fade-out` | 音频 | `-14dB`；秒 |
| `speed` | 否 | 倍速，默认 1 |
| `xywh` | 否 | 源画面的裁切，W3C Media Fragments 语法 |

### 3.1 轨道种类

`meta.tracks` 是空白分隔的 **`名字:种类`** 列表，种类只有三个：`video`、`audio`、`prose`。
种类说的是**内容是什么、住在哪**——一个视频文件、一个音频文件、一个文档里的散文块——
不是画在哪。overlay 轨的种类是 `video`；它叠在画面之上是样式表的决定，不是内容的。

```geml
==== media {#ep01 tracks="video:video dialogue:audio bgm:audio subtitle:prose overlay:video" primary=video fps=24}
```

只写名字不写种类是 error，种类不在这三个里也是 error。不做回退：一条要从名字猜种类的
规则根本说不出口，因为名字是作者自由取的。

### 3.2 时间模型

- **主轨**（`meta.primary`，缺省 `video`）是**顺序的**：文档顺序就是播放顺序。第 *i* 个
  片段的起点 = 第 *i-1* 个的终点减去它 `transition-in` 声明的重叠量（`cut` 为 0，
  `dissolve` 与 `crossfade` 为 `transition-duration`，`fade` 不重叠）。第一个片段从 0 开始。
- 一个片段的时长 = `out - in`，无固有时长的源则是 `duration`，再除以 `speed`。
- **其余轨是锚定的**：起点 = 锚点片段的起点 + `offset`。在主轨插一个片段，后面所有锚定的
  字幕、配音、音乐跟着走。这和"id 优于行号"是同一个道理：锚在内容上，不锚在数字上。

## 5. `media-text` —— 剧本层

带剧本语义的散文：外貌、提示词、台词。它就是 **`text` 加五个键**——同样的 flow 体、同样
可被行内投射、同样投成 Markdown 段落——所以参考实现把它声明为**散文类型**。

| 键 | 在哪 | 含义 |
|---|---|---|
| `shot` | `.prompt` | 这条提示词属于哪个镜号 |
| `speaker` | `.line` | 说这句话的角色块，**必填** |
| `to` | `.line` | 说给谁 |
| `emotion` | `.line` | 情绪标注：剧本的**意图**。TTS 记录的 `params.emotion` 是实际发出的 |
| `since` | `.look` | 这版外貌从第几集起生效 |

约定 class（不放行、不查拼写；样式表和检查器靠它们识别）：`.prompt`、`.line`、`.inner`
（内心独白或旁白）、`.look`。

**这些键里的引用归 profile 查，不归核心。** 核心只在四处记引用：`embed` 的 `src=`、
`data` 的 `schema=`、`view` 的 `src=`，以及行内 `[[…]]`。profile 放行的属性值核心从不解析，
所以悬空的 `speaker=` 得到的是本 profile 的 `media-speaker-unresolved`，核心一声不吭。

## 6. 生成日志 —— `data {.gen-log format=jsonl}`

一次生成一条记录，只追加，不改写。它是带 class 的核心 `data` 块，不是自己的类型，这买到
三样新类型会丢掉的东西：JSON 由核心校验、每条记录每个字段都有坐标
（`geml get '#gen-log[8]["inputs"]'`）、记录数组能直接喂 `geml-chart`。

| 字段 | 必需 | 含义 |
|---|---|---|
| `output` | 是 | 产出的素材块；**失败时为 `null`**，并带 `error` |
| `output-sha256` | `output` 非 null 时必需 | **产出当刻**那个文件的哈希。它回答"素材现在这份字节是哪条记录产的"。没有它，一次重生之后被取代的旧记录会永远对不上现值，素材读起来就是永远过期 |
| `model` | 是 | 模型名，自由字符串，带版本 |
| `mode` | 是 | `t2i`、`i2v`、`t2v`、`tts`、`lipsync`、`upscale`、`other` |
| `prompt` | 条件 | 提示词块或台词块 |
| `prompt-sha256` | 与 `prompt` 同 | **展开投射之后**的提示词的哈希：模型看到的那串字 |
| `prompt-refs[]` | 与 `prompt` 同 | `{ref, sha256}`，**这条提示词投射到的每个块**。只有 `prompt-sha256` 的话，诊断只能说"提示词变了"；有了它才说得出**是哪个源**变了 |
| `inputs[]` | 否 | `{ref, sha256, role?}`：参考图、LoRA、关键帧、声线样本、口型合成吃进去的 take 与配音、ComfyUI 的 workflow |
| `seed`、`params` | 否 | 种子；开放 map |
| `at` | 是 | ISO-8601 |
| `cost`、`tool`、`prompt-text`、`error` | 否 | 数值；在哪跑的；提示词全文（为复现）；失败原因 |

**过期只在 `output-sha256` 等于素材现值的那条记录上算**，并沿血缘图向下传播：配音过期 →
吃它的口型合成过期 → 用它的片段过期。被取代的记录不参与，这正是 `output-sha256` 的用处。

**追加记录的人同时要更新素材块**——它的 `sha256`，以及工具知道时的 `duration`。只追加记录
会让库里继续声称一个文件已经没有的哈希，下一次 check 就是 `media-hash-mismatch`。

## 7. `=== meta` 键

| 键 | 文档 | 含义 |
|---|---|---|
| `tracks` | 时间线 | `名字:种类` 列表；种类是 `video`、`audio`、`prose` |
| `primary` | 时间线 | 主轨名，缺省 `video`。不限定种类：纯音频剪辑是合法用例 |
| `fps` | 时间线 | 时码换算的基准 |
| `aspect` | 剧本、时间线 | `9:16`、`16:9` —— 渲染参数，不影响时间 |
| `target-duration` | 剧本 | 目标时长，秒 |
| `episode` | 剧本 | 集号 |

## 8. 诊断

级别沿用核心的规矩：**结构坏了是 error，事实过期是 warning，选择是 info。** 过期必须是
warning 而不是 error——否则改一次角色卡整条流水线红掉，人就会学着忽略它。

| 码 | 级别 | 何时 |
|---|---|---|
| `media-src-unresolved` | error | 片段的 `src` 指不到任何块 |
| `media-src-not-asset` | error | `src` 与该轨的种类不符 |
| `media-file-missing` | warning | 素材的文件不存在 |
| `media-hash-mismatch` | error | 文件在，但 SHA-256 不是声明的那个 |
| `media-asset-unhashed` | warning | 素材没有 `sha256`，血缘无法校验 |
| `media-duration-required` | error | 源无固有时长且未写 `duration` |
| `media-track-missing` | error | 片段没有 `track=` |
| `media-track-undeclared` | warning | `track=` 不在 `meta.tracks` 里 |
| `media-track-kind-missing` | error | `meta.tracks` 里某条只写了名字没写种类 |
| `media-track-kind-unknown` | error | 种类不在 `video`、`audio`、`prose` 之内 |
| `media-of-unresolved` | error | 素材的 `of=` 指不到任何块 |
| `media-speaker-unresolved` | error | 台词的 `speaker=` 或 `to=` 指不到任何块 |
| `media-line-no-speaker` | error | `.line` 没有 `speaker=` |
| `media-gen-schema` | error | 日志记录缺必需字段，消息点名记录序号与字段 |
| `media-orphan-record` | info | 没有任何记录的 `output-sha256` 等于素材现值：它现在这份字节来历不明 |
| `media-stale-generation` | warning | 与素材现值匹配的那条记录里，某个输入的哈希、`prompt-sha256` 或某条 `prompt-refs[]` 与现值不符；消息点名变了的那个 |
| `media-stale-clip` | warning | 片段的 `src` 是过期记录的产出，或其祖先过期；消息带整条链 |

**v1 刻意不实现**（设计记录里描述过的）：编导口味的几条（`media-runtime-off-target`、
`media-emotion-drift`、`media-look-outdated`、`media-episode-mismatch`、
`media-gen-before-approval`）、模型卡相关的几条，以及时间线形状的几条
（`media-track-order`、`media-track-overlap`、`media-transition-too-long`、
`media-absolute-anchor`、`media-subtitle-unmatched`）。第一个真实用例一条都没接近，
而一条没人需要过的诊断，只是披着码的猜测。

## 9. 这份 profile 不放行什么

- **不接任何一家生成器的 API。** 日志记录下的是**用了什么**，从不是**怎么调用**：没有
  endpoint、没有 key、没有脚本（§9.1——文档是数据，永不是代码）。
- **不做审美规则。** 景别重复率、钩子密度、对白长度是编导的事，不是文档的事。
- **不做剧本格式。** 场景标题与动作描写属于 Fountain 那一族；`.line` 只保证台词有地址、
  有说话人。
- **不做工作流引擎。** 没有队列、没有调度器、没有重试策略。GEML 给流水线的是派生的任务
  清单、幂等的写入，和一道"这几类诊断为零"的门。
- **不定义呈现层的画面几何。** overlay 摆在哪，是样式表透传给宿主的参数。对**源画面**的
  裁切（`xywh`）是另一回事，它是文档事实。

## 10. 版本与范围

`geml-media/v1` 就是上面这份名字清单。加一个名字是小版本改动；删掉一个、或改变一个名字的
含义，要 `v2`。两种情况下规范都不变：这份 profile 放行的，全是 §8.6 本来就允许一份词汇表
放行的名字。
