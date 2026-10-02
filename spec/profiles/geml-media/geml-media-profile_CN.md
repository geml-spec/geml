# geml-media profile v1 — 素材、剪辑与生成血缘

*[English](geml-media-profile.md) | 中文*

- 状态：**草案**。其中 `media-text` 声明了散文体，而 [GEP-0013](../../proposals/0013-prose-body-for-vocabularies.md) 既放行词汇表这么做，也定义了 `prose` 体是什么。下面的词汇已在参考实现里注册，并由一个真实用例跑过
  （[geml-media 演示](https://github.com/geml-spec/geml-spec.github.io/blob/main/public/examples/geml-media-demo/README.md)）；
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
`code {src=file#L14-24}` 指向源码的一段是同一个形状。一镜的画面也可以**由几层拼出来**
——一张场景母版、几张角色立绘，每张都是素材，摆在一块画布上（§5.1）——于是血缘伸进
画面内部：哪一层变了，哪些镜头用过它。

## 1. 声明 profile

```geml
=== meta
profile = "geml-media/v1"
===
```

不声明时，三个类型名是 `unknown-block-type`，正文是 raw。不认识这个 profile 名的处理器什么也不放行并报出 `unrecognized-vocabulary`（§8.6 规则 3）；它依然合规，只是把 `media-text` 读作 raw 块而不是散文——这是认识这份词汇表所改变的唯一一件事。文档携带的每一个地址两边相同（§8.6 规则 4）。
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
| `role` | 推荐 | 它在生成里当什么用：`sheet`、`master`、`stand`（抠好的角色立绘，§5.1）、`lora`、`voice`、`first-frame`、`last-frame`、`style-ref`、`workflow`、`take`，或宿主词。开放集 |

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

### 5.1 `media-comp` 与 `media-layer` —— 分层写的提示词

一镜的画面可以用字要（一条 `.prompt`），也可以**由几部分拼出来**：一张场景母版、一张或几张
角色立绘，每张都是 `kind=image` 的 `media-asset`，摆在一块画布上。`media-comp` 就是这份
配方，`media-layer` 是其中一层。comp 之于 `compose`，正如 `.prompt` 之于模型——都是
"这次生成照着哪个块做"，都挂 `shot=`，都出现在记录的 `prompt` 字段里。它**不是**分镜：
一镜可以没有 comp（一条提示词直出一张图），也可以有两个（首帧与尾帧）。

```geml
==== media-comp {#s05-comp shot=s05 size=720x1280}

=== media-layer {#s05-bg src=library.geml#bedroom-master xywh=0,200,720,1280}
===

=== media-layer {#s05-hero src=library.geml#hero-sit x=300 y=340 w=480 flip=h}
===

====
```

| 类型 | 键 | 必需 | 含义 |
|---|---|---|---|
| `media-comp` | `shot` | 否 | 这张画面属于哪一镜，与 `.prompt` 上的同义 |
| | `size` | 是 | 画布 `宽x高`。它是**这张图**的事实，不是呈现，所以不在样式表。缺失 → `media-comp-size-missing` |
| `media-layer` | `src` | 是 | 一个 `kind=image` 的 `media-asset`：立绘、母版。不是图片 → `media-layer-not-image`；悬空 → `media-src-unresolved` |
| | `xywh` | 否 | 摆放**之前**先对源裁切，语法与 `media-clip` 的 `xywh` 同（W3C Media Fragments）。一张母版、几种裁切，场景的机位就是这么来的 |
| | `w` | 否 | 缩放后的宽，等比；缺省为源（裁切后）的宽 |
| | `x`、`y` | 否 | 左上角在画布上的位置，像素，可为负；缺省 `0 0` |
| | `flip` | 否 | `h` 水平镜像：一张立绘，两个朝向 |

**层序就是文档顺序**，先写的在下——和轨道顺序是同一条规则，所以没有 `z=`。**变换只有
四个**——裁、缩、翻、放——每个对应 ffmpeg 一个滤镜，顺序固定（`crop` → `scale` →
`hflip` → `overlay`）。旋转、透明度、混合模式不放行：还没有谁需要，而每多一种变换，
两个渲染器就多一处可能不一致。

**不是布局事实的**：立绘怎么抠的、接触阴影、色彩匹配、融合重绘。那些是合成器的事，进
记录的 `params`——于是同一份文档在赛璐璐风管线上用 `colorkey` 合成，在写实风管线上用
抠图模型加阴影合成，`check` 在两边说的是同一个真相。

**comp 像提示词一样哈希。** `prompt` 指向 comp 的记录，其 `prompt-sha256` 是该 comp
**规范化文本**的哈希：从模型生成，不切源文本——comp 一行、每层一行、每个互动一行，每行是
类型、id 和按键排序的属性；§6 把各行写明。调换属性顺序、重排空白都不算改动；`x=300` 改成
`x=340` 就过期，点挪了也过期，因为互动那一行带着它解析到的坐标。各层的素材各是一条
`inputs[]`，所以立绘重出一张也过期。

`geml media compose <doc>#<comp> --out <file.png> [--log <library.geml> [--as '#id']]`
用 ffmpeg 渲一个 comp：`size` 大小的透明画布，每层依次裁、缩、翻、叠——同一份文档、
同样的输入，永远出同一串字节。带 `--log` 时顺手登记产出（`role=first-frame`；没有就新建
块，有就只换 `sha256=`）并追加记录——`mode=composite`、`model=ffmpeg-overlay`、
`prompt=` 该 comp、`inputs[]` 各层素材——因为 `inputs[]` 唯一正确的来源就是 comp 本身。
`geml media todo` 把没有记录认领的 comp 列成一件 `composite` 待办——和提示词、台词一样，
一旦 `check` 发现它的产出对不上现值（挪了一层、重出了一张立绘），它再次上清单，带 `stale: true`：
待办从诊断同一批事实派生。

### 5.2 点与互动 —— 两样东西在哪里碰上

手搭在碗上、两人对视、脚落在地上——两样东西在哪里碰上，是这一镜的事实，不是把它们画进
同一张图的理由。三个键加一个类型承载它（设计记录 §16.8）：

| 在哪 | 键 | 含义 |
|---|---|---|
| `media-asset`（立绘**和母版**） | `points` | 这张图自己像素坐标里的命名点：`points="hand:562,522 eyes:290,300"`。母版的 `floor`、`bed-edge`、`door` 才是多数站位问题所在 |
| 素材 `of=` 指向的角色 / 场景块——标题节的属性，或 `.look` 那个 `media-text` 的属性 | `points` | 只有**名字**：`points="hand eyes feet"`。它是 schema，不是坐标：立绘缺了角色声明的点、互动引了角色没有的点，在合成之前就报出来 |
| `media-comp` 里的 `media-interaction` | `a`、`b`、`kind` | `a=#层:点 b=#层:点 kind=contact\|gaze`。**散文**类型：body 写这一拍发生了什么——按步可读（`geml get '#s05-handoff'`），用到生成式精修时就是它的提示词 |
| `media-comp` | `at` | 这一帧在镜头里的时刻，秒。同 `shot=` 的几个 comp 是一个序列；帧与帧之间层按素材 `of=` 的角色对应，不按 id——id 在一份文档里唯一 |
| `media-layer` | `dx`、`dy` | 位置由互动定了之后的微调 |

```geml
==== media-comp {#s05-comp shot=s05 size=720x1280}

=== media-layer {#s05-bg src=library.geml#bedroom-plate}
===
=== media-layer {#s05-sister src=library.geml#sister-hand x=-90 y=370 w=560}
===
=== media-layer {#s05-bowl src=library.geml#bowl w=180}
===
=== media-interaction {#s05-handoff a=#s05-sister:hand b=#s05-bowl:left-grip kind=contact}
林岚双手端着碗，递到林夏面前。
===

====
```

**摆放。** 层按文档顺序放。一条互动指的两层里，**靠后的那层动**，向前面那层靠；`a` `b`
的先后无关。`contact` 让两点重合；`gaze` 只把两点的高度对齐，`x` 不动。一个层由它的
**第一条**互动定位置，之后的互动只验：两点合成后相距超过 2 像素报 `media-interaction-apart`。
由 contact 定位的层不能再写 `x`/`y`，由 gaze 定位的不能写 `y`（`media-layer-position-conflict`），
微调用 `dx`/`dy`。`flip=h` 的层，点跟着镜像。点随 `w` 缩放、或镜像，都要知道源图多宽：
有 `xywh` 用裁切宽，否则用素材的 `size=`（`media-asset-size-required`）。互动只在关键帧上成立：两个 `at` 之间是视频模型或补间器的事。
comp 的规范化文本带上解析后的点坐标，点挪了，用它的 comp 就过期。`check` 和 `compose` 用的
是同一份几何；互动引不到层或点时 `compose` 拒绝，不会把那一层放到原点再登记一条看似正常的
记录——立绘重出之后像素变了，旧的点不再是它的事实，得重标。

## 6. 生成日志 —— `data {.gen-log format=jsonl}`

一次生成一条记录，只追加，不改写。它是带 class 的核心 `data` 块，不是自己的类型，这买到
三样新类型会丢掉的东西：JSON 由核心校验、每条记录每个字段都有坐标
（`geml get '#gen-log[8]["inputs"]'`）、记录数组能直接喂 `geml-chart`。

| 字段 | 必需 | 含义 |
|---|---|---|
| `output` | 是 | 产出的素材块；**失败时为 `null`**，并带 `error` |
| `output-sha256` | `output` 非 null 时必需 | **产出当刻**那个文件的哈希。它回答"素材现在这份字节是哪条记录产的"。没有它，一次重生之后被取代的旧记录会永远对不上现值，素材读起来就是永远过期 |
| `model` | 是 | 模型名，自由字符串，带版本 |
| `mode` | 是 | `t2i`、`i2v`、`t2v`、`tts`、`lipsync`、`upscale`、`composite`、`other` |
| `prompt` | 条件 | 提示词块、台词块、comp 块或互动块（§5.1、§5.2） |
| `prompt-sha256` | 与 `prompt` 同 | **展开投射之后**的提示词的哈希：模型看到的那串字，定义见下 |
| `prompt-refs[]` | 与 `prompt` 同 | `{ref, sha256}`，**这条提示词投射到的每个块**。只有 `prompt-sha256` 的话，诊断只能说"提示词变了"；有了它才说得出**是哪个源**变了 |
| `inputs[]` | 否 | `{ref, sha256, role?}`：参考图、LoRA、关键帧、声线样本、口型合成吃进去的 take 与配音、ComfyUI 的 workflow |
| `seed`、`params` | 否 | 种子；开放 map |
| `at` | 是 | ISO-8601 |
| `cost`、`tool`、`prompt-text`、`error` | 否 | 数值；在哪跑的；提示词全文（为复现）；失败原因 |

**`prompt-sha256` 哈希的是什么**在这里定死，两个工具才会算出同一个值：对下面这段文本的
UTF-8 字节取 SHA-256，文本末尾不带换行。

- `media-text` 的台词，或任何别的**散文**提示词：取块的第一个段落渲染成的纯文本——字面
  文字照写；代码段、内联数学取其正文；强调、加粗、删除线、链接取它们包住的文字；内联投射
  `![[…]]` 按同一规则取被投射块的文本，递归，到 GEML §9.3 的投射深度上限为止——解析不到的
  投射什么也不贡献；自动引用指向坐标时取它携带的值，否则什么也不贡献；图片嵌入、硬换行、
  脚注引用什么也不贡献。
- `media-comp`：取它的**规范化文本**——comp 一行，然后按文档顺序每个 `media-layer` 一行，
  再按文档顺序每个 `media-interaction` 一行，用 LF 连接。一行是该块的类型、有 id 时的
  `#id`、按键排序的属性 `key=value`，全部用一个空格隔开，值写成它的文本（裸标志写 `true`）。
  互动那一行的 `a=` 与 `b=` 带上解析到的点：原写法、`@`、再是素材 `points=` 给出的 `x,y`——
  `a=#s05-sister:hand@562,522`——点解析不到时写 `@?`。

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
| `media-gen-output-not-asset` | error | 记录的 `output` 指不到任何 `media-asset`：日志声称产出了一份库里没有的文件，吃过它的东西从此判不出过期 |
| `media-orphan-record` | info | 没有任何记录的 `output-sha256` 等于素材现值：它现在这份字节来历不明 |
| `media-stale-generation` | warning | 与素材现值匹配的那条记录里，某个输入的哈希、`prompt-sha256` 或某条 `prompt-refs[]` 与现值不符；消息点名变了的那个 |
| `media-stale-clip` | warning | 片段的 `src` 是过期记录的产出，或其祖先过期；消息带整条链 |
| `media-layer-unassembled` | error | `media-layer` 不在任何 `media-comp` 里 |
| `media-comp-size-missing` | error | `media-comp` 没有 `size=宽x高` |
| `media-comp-empty` | error | `media-comp` 的体里一层都没有 |
| `media-layer-not-image` | error | 层的 `src` 解析到的不是图片素材。悬空的 `src` 是 `media-src-unresolved` |
| `media-interaction-unassembled` | error | `media-interaction` 不在任何 `media-comp` 里 |
| `media-interaction-unresolved` | error | `a`/`b` 不是 `#层:点`、指的层不在这个 comp 里、层的素材没有那个点，或 `kind` 不是 `contact` / `gaze` |
| `media-interaction-point-undeclared` | error | 点名不在素材所画的角色 / 场景声明的名字里 |
| `media-interaction-same-layer` | error | 一条互动的两端在同一层上 |
| `media-layer-position-conflict` | error | 由互动定位的层又写了那条互动要定的坐标 |
| `media-asset-size-required` | error | 点要随 `w` 缩放，而 `xywh` 和素材的 `size=` 都没给源图宽 |
| `media-comp-at-duplicate` | error | 同一镜两个 comp 的 `at` 相同 |
| `media-interaction-apart` | warning | 只验不动的那条互动，两点合成后相距超过 2 像素 |

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
  裁切（`xywh`）是另一回事，它是文档事实——层的 `x`/`y`/`w`（§5.1）也是：它们不是一条轨
  在**播放器**里画在哪，而是合成器据以在它**产出的文件**里摆像素的地方。

## 10. 版本与范围

`geml-media/v1` 就是上面这份名字清单。加一个名字是小版本改动；删掉一个、或改变一个名字的
含义，要 `v2`。两种情况下规范都不变：这份 profile 放行的，全是 §8.6 本来就允许一份词汇表
放行的名字。

2026-09-29：加了 `media-comp`、`media-layer`、`composite` 模式与四个码（§5.1），随后加了
`media-interaction`、`points`、`at`、`dx`/`dy` 与八个码（§5.2）——只加名字，是小版本改动；
`v1` 不变。
