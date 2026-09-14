# geml-media —— 素材、剪辑与生成血缘的应用层 profile

- 日期：2026-09-15
- 状态：设计稿（brainstorm 产出，尚未实现、尚未立 GEP）。**同日第二稿**：示例从"一个角色、一集"
  扩为"四个角色、两人对白加旁白、全季 24 集的组织"；GEML 今天没有的东西全部集中到
  §9（待办：依赖核心的改动）与 §13（待讨论的设计），不再散在正文里。
  示例文档全部用当前 `geml` 跑过 `check` / `list` / `get` / `add` / `set` / `revert` /
  `style check`，本文引用的命令输出是真实输出。
- 目标：让 GEML 成为 AI 图片与视频创作全部**中间产物**的胶水——演员表、角色卡、风格板、
  分集大纲、分镜表、提示词、台词、参考图、生成片段、配音、口型、字幕、时间线——并让
  "改了源头哪些产出要重做"变成一次 `check` 就能回答的问题。**GEML 1.0 规范一个字不动。**
- 验证用例：**AI 漫剧的一季**。选它有三个理由：它是 2026 年产量最大的 AI 视频形态
  （§2）；它的痛点恰好是 GEML 四条定律各对一条；它不依赖任何一家生成器，跑通不需要
  等谁的 API。
- 词汇表在别处（将来）：落地后完整的属性表、诊断目录与一致性面写进
  `spec/profiles/geml-media/geml-media-profile{,_CN}.md`，那份跟着实现走，本文停在设计当时。
- 命名：profile 叫 `geml-media/v1`，类型名带连字符（`media-asset`、`media-clip`），
  §8.5 保留不带连字符的名字给规范；视觉风格一律叫 **look**，不叫 style——
  `geml-style` 已经是 UI 样式表，两个 "style" 必然混。

---

## 1. 摘要

`geml-media` 是一个**应用层 profile**，与 `geml-codemap`、`geml-style` 同级。它定义两个
带连字符的块类型、在核心 `text` 块上放行五个属性键、约定一种 `data` 块记录形态，并带
自己的动词（`geml media …`，CLI 与 MCP 是同一套，§6.1）。

三条贯穿全文的原则：

1. **素材有身份，片段是引用。** 一个文件一个 `media-asset` 块，`sha256` 是它的身份，
   `src` 只是它现在放在哪。一刀剪辑（`media-clip`）指向素材块的一段时间，不复制字节——
   和 `code {src=file#L14-24}` 指向源码的一段是同一件事。
2. **血缘是可校验的引用，过期是诊断不是猜。** 每次生成追加一条记录：输出了哪个素材、
   用了哪条提示词或台词、哪些输入、以及**生成当刻**各输入的哈希。`check` 拿现值比对，
   角色卡改了一个字，所有下游镜头标黄。这是 `stale-code-snapshot` 在创作域的翻版。
3. **内容与呈现分层。** "这一刀在哪条轨"是内容事实，写在 `media-clip` 上；"轨道怎么摆、
   叠在谁上面"是呈现，交给 `geml-style` 的 `style-frame`。内容文档不为多轨长出任何
   容器语法。

剧本层——演员表、角色卡、分集大纲、分镜表、提示词、台词——**全部用核心词汇**：标题
分节、`table`、`view`、`text`、`data`、`embed`。本 profile 只在 `text` 上放行几个属性键，
不定义任何 `story-*` 类型（§5.4）。

四条定律各落一处：寻址（每刀、每个素材、每条生成记录、每句台词、每格分镜都有地址）；
投射（角色外貌投射进每条提示词，台词投射成字幕，各集 brief 投射成全季大纲，副本不存在）；
校验（引用、时长、哈希、过期、镜号钉合）；回退（`.gemlhistory` 按块回滚一刀，不推倒
整条时间线）。

---

## 2. 验证用例：AI 漫剧的一集是怎么做出来的

### 2.1 流程与中间产物

综合 2026 年公开资料（§15），一集漫剧的工业化流程分五层，每层产出的**中间产物**如下。
最右一列是这些东西今天实际住在哪——这一列就是本 profile 要替代的对象。

| 层 | 中间产物 | 谁产出 | 今天住在哪 |
|---|---|---|---|
| 前期 | 故事梗概；**演员表**（男女主、配角、反派、旁白）与**角色卡**（正侧面特征、服装、标志物、禁改项、声线）；人物关系；**视觉风格板**；单集 brief（时长、平台、情绪曲线、结尾钩子） | 编剧 / 美术 / 运营 | Word、飞书文档、脑图 |
| 剧本 | **分集大纲**（每集钩子、冲突、反转、悬念、付费点）；分集剧本（抖音版 200–400 字，红果版 400–800 字）；**分镜表**（镜号、景别、运镜、时长、角色、动作/表情、对白、BGM，最细的版本 12 列）；**台词**（说话人、情绪标注） | 编剧 / 分镜师 | Excel、Dify 输出的 JSON |
| 资产 | 角色三视图（4–6 张参考图）、主参考图、场景母版图、**LoRA**、每个角色的声线样本 | AI 美术 | 文件夹、云盘、ComfyUI 目录 |
| 生成 | 关键帧静图 → 图生视频片段（5 秒一段）→ 按台词逐句配音（角色声线 + 情绪）→ 双人口型 → 字幕 | AI 操作员 | 生成平台的历史记录、下载目录 |
| 后期 | 时间线（转场、BGM 卡点、字幕样式）→ 主版本 → 平台版本（抖音竖屏 / B 站横屏 / 小红书）→ 版权与 AI 标识审核 → 版本 V1/V2/V3 | 剪辑 / 法务 / 项目经理 | 剪映工程、Premiere 工程、看板 |

一集 3 分钟拆 30–50 个镜头；一部剧 24 集（红果，每集 1–3 分钟）或 60 集（抖音，每集
60–90 秒）。付费卡点在第 8–10 集结尾。

### 2.2 痛点，带数字

- **一致性是第一痛点。** 用户吐槽前三位：画面风格不统一 47.1%、配音缺乏情感 46.7%、
  角色形象扁平 44.9%。从业者的口径是"前后帧人物的脸乃至眼睛、嘴巴不一样，相当于
  不是同一个人"。解法全是**把源头锁死再生成**：三视图 + 主参考图 + LoRA（30–50 张图
  微调，一致性 90–97%），每个镜头都挂参考图。
- **抽卡是常态，不是例外。** 传统工具抽卡成功率约 15%，工业级平台拉到 90%；每个可用
  镜头平均生成 3 次，最终镜头里超过 40% 是从多次生成里各取几秒**拼**出来的（"Frankenstein
  shot"）；一部两天完成的剧集生成 164 条、用了 41 条。返工率行业平均 40–50%，
  最好的平台压到 10% 以下。
- **改源头，不改镜头。** 出现连续性错误时的正确做法被写成口诀："fix the source, not the
  shot"——改角色卡，然后**只重生受影响的镜头**。今天"哪些镜头受影响"靠人记。
- **版本蔓延。** 一场戏一旦有了中文对白、英文字幕、葡语配音、两版开场钩子、两版口型，
  "哪些资产属于同一版"就没人说得清；哪版钩子带来了完播率，也追不回是哪版剧本。
- **合规是硬门槛。** 2025 年 11 月专项治理后，全网漫剧日均上新从 150+ 部降到 20 部左右。
  SOP 要求每个素材有授权依据、AI 成分标注、肖像与音乐字体许可可回查；版本管理要求
  "可追溯源头、支持争议时回查"。
- **成本已经不是瓶颈。** 一分钟从 2024 年 8 月的 1.5 万元降到 2026 年的 1000 元左右
  （精品 1000–3000 元，海外 315–750 美元）；最耗人的环节不是生图生视频，而是"分镜前后
  的连续工作：剧本理解、分镜改写、**资产管理**、分镜出图、结果检查"。

### 2.3 这些痛点在 GEML 上各对应什么

| 痛点 | GEML 已有的 | 本 profile 补的 |
|---|---|---|
| 角色一致性 | 角色卡是 `text` 块，`![[#hero-look]]` 投射进每条提示词，改一处全变 | 参考图、LoRA、声线样本成为带哈希的 `media-asset`，生成记录记下它们 |
| 改源头后不知道哪些镜头受影响 | 引用在构建期核验 | 生成日志记录输入哈希，`check` 比对现值，逐镜头报 `media-stale-clip` |
| 抽卡与拼接 | `add` / `delete` / `set --head` 就是插刀、剪刀、改入出点 | 每条 take 一个素材块，一刀可以只取 take 的 2.0–4.0 秒；两条 take 拼一刀就是两个 `media-clip` |
| 对白、配音、字幕三份不同步 | 台词是一个 `text` 块，TTS、字幕、翻译三个消费者都引用它 | `.line` 上的 `speaker=`；字幕轨 `src` 指台词块；配音记录以台词块为 `prompt` |
| 分集大纲与各集 brief 两处维护 | `embed` 把各集 brief 投射进全季文档 | 无需新增 |
| 分镜表 | `table` 给人扫，`view` 求总时长、按角色筛，坐标指到任一格 | 镜号是键，`.prompt shot=` 把提示词块钉到行上，`check` 负责钉牢 |
| 多语言字幕与配音 | 字幕是 `text` 块的投射，`geml-translator` 沿语言轴投影 | 字幕轨的 `src` 指文本块而非素材 |
| 版本 V1/V2/V3 可回查 | `.gemlhistory` 按块记录，`revert` 只退一刀 | 无需新增 |
| 合规：授权依据、AI 标识 | 属性是文档事实 | `origin=` / `license=` 挂在每个素材上，`check` 可要求非 generated 素材必填 license |
| 平台版本拆分 | `embed` 投射主剪的场，各平台版只写自己的头尾 | `aspect=` 是 meta 键，渲染参数 |
| 资产找不到 | 跨文档引用、`--root` 限定 | `_index/media.json`：sha256 → 文档#id，`geml media index` 生成 |

一个**没有**对应物、也刻意不做的：分镜的"连续 15 个镜头内同景别不超过 3 次"是窗口
聚合，`view` 表达不了，本 profile 不做——那是分镜师的审美规则，不是文档的结构事实。

---

## 3. 一个完整的例子

一季漫剧的骨架，八份文档。**角色库与全季大纲只用核心词汇**；素材库、剧本、时间线声明
profile。全部通过 `geml check --root .`（唯一的 warning 是 `media-*` 类型与 `shot=` /
`speaker=` / `to=` / `emotion=` / `since=` 属性尚未注册）。

### 3.0 项目布局

```
<project>/
  characters.geml            演员表、人物关系、角色卡、风格板、道具与场景（核心词汇）
  library-shared.geml        跨集复用的素材：三视图、LoRA、声线样本、场景母版、音乐
  season.geml                分集大纲表 + 各集 brief 的投射
  ep01/
    ep01-script.geml         brief、分镜表、提示词、台词
    ep01-library.geml        本集的关键帧、take、配音、口型合成 + 生成日志
    ep01-cut.geml            主剪
    assets/                  文件本体
  ep02/ …                    每集同形
  _index/
    index.geml               样式入口（geml-style §1.1）
    style.geml               时间线与分镜板的样式表
    providers.geml           模型卡与路由表（数据，不是代码；§6.2）
    media.json               sha256 → {doc, id, src, kind}；`geml media index` 生成
```

### 3.1 角色库 `characters.geml` —— 演员表、关系、四个角色

```geml
=== meta
title = "《重生之夜》角色库"
===

%% 全剧共用。角色卡是所有集、所有镜头提示词的单一源：外貌用投射引用，不复制。
%% 参考图、LoRA、声线样本是素材，住在 library-shared.geml；这里只放文字事实。

# 演员表 {#cast}

=== table {#cast-table}
| id | 角色 | 定位 | 声线 | 首次出场 |
|---|---|---|---|---|
| #hero | 林夏 | 女主 | 低、慢、少停顿 | 1 |
| #male-lead | 沈砚 | 男主 | 沉、克制 | 2 |
| #sister | 林岚 | 女配 反派 | 甜、快，会假哭 | 1 |
| #narrator | 旁白 | 旁白 | 中性、平 | 1 |
===

=== view {#leads src=#cast-table where="定位 = '女主' or 定位 = '男主'" select="角色, 定位, 首次出场"}
===

=== table {#relations}
| 甲 | 乙 | 关系 | 变化 |
|---|---|---|---|
| #hero | #sister | 姐妹；妹妹是前世凶手 | 第 1 集林夏知情，第 12 集当众揭穿 |
| #hero | #male-lead | 前世未婚夫；今生盟友 | 第 2 集重逢，第 9 集结盟 |
| #male-lead | #sister | 被利用 | 第 6 集察觉 |
===

# 林夏 {#hero}

=== text {#hero-look .look}
二十六岁女性，**银灰短发齐耳**，左眉一道旧疤，黑色高领毛衣，红色长风衣。眼神冷、话少。
===

=== text {#hero-look-2 .look since=5}
同 [[#hero-look]]，另加：左臂缠白色绷带，风衣左袖口烧焦。第 5 集火场之后的样子。
===

=== text {#hero-donot}
禁改项：发色不得变、疤在左眉不在右、风衣永远是红色。
===

=== data {#hero-card}
{"name": "林夏", "age": 26, "voice": "低、慢、少停顿", "arc": "被害重生，复仇"}
===

# 沈砚 {#male-lead}

=== text {#male-lead-look .look}
三十岁男性，黑色短发，深灰大衣，金丝眼镜，左手无名指有戒痕。站姿笔直，不苟言笑。
===

=== text {#male-lead-donot}
禁改项：眼镜不摘、戒痕在左手、大衣不换色。
===

# 林岚 {#sister}

=== text {#sister-look .look}
二十三岁女性，栗色长卷发，白色连衣裙，珍珠耳钉。笑的时候眼睛不弯。
===

# 旁白 {#narrator}

=== text {#narrator-note}
第一人称旁白，林夏重生后的视角，只在每集开头与结尾出现。
===

# 视觉风格板 {#look-board}

=== text {#look}
2D 手绘赛璨风，冷色调，蓝紫主色，硬边阴影，电影感 16:9 构图裁竖屏，胶片颗粒轻。
===

# 道具与场景 {#world}

=== text {#phone-prop}
林夏的手机：碎屏，锁屏日期 **2023-09-14**。第 1 集 0:40 的钩子，之后每集出现一次。
===

=== text {#mourning-hall-desc}
灵堂：冷蓝烛光，白菊成排，棺木居中，右侧一扇半开的门。母版图见 library-shared。
===
```

- **演员表是一张表，角色是一个标题节。** 表给人扫、给 `view` 筛（`#leads` 实跑只列出
  林夏与沈砚）；标题节给提示词投射、给 `speaker=` 引用。`id` 列是文档内引用，把两者钉在
  一起。旁白是一个角色：它有声线、有素材、会出现在 `speaker=` 里，没理由另起一套。
- **外貌随剧情变**（第 5 集火场之后多了绷带）是第二个 `.look` 块加 `since=5`，不是改第一个
  ——改第一个会让前四集所有已生成的镜头过期。第 5 集起的提示词显式投射 `#hero-look-2`；
  `check` 对 `episode ≥ 5` 仍投射 `#hero-look` 的提示词报 `media-look-outdated`（§7）。
  投射本身不会按集选源，见 §13 第 1 条。
- 禁改项、人物关系、道具都是普通块：它们是提示词和审片的依据，要有地址；不需要新类型。

### 3.2 全季 `season.geml` —— 分集大纲与各集 brief 的投射

```geml
=== meta
title = "《重生之夜》全季"
profile = "geml-media/v1"
episodes = 24
platform = "hongguo"
paywall = 8
===

%% 全季只有一份：分集大纲表 + 各集 brief 的投射。brief 本体在各集自己的 script 里，这里不复制。

# 分集大纲 {#outline}

=== table {#episodes}
| 集 | 标题 | 核心冲突 | 钩子 | 反转 | 结尾悬念 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 她睁开了眼 | 葬礼上重生 | 3 秒睁眼 | 凶手是妹妹 | 妹妹推门进来 | 粗剪 |
| 2 | 旧人 | 沈砚来吊唁 | 他叫她小名 | 他也记得前世 | 手机日期 | 剧本 |
| 3 | 遗嘱 | 遗产归属 | | 遗嘱是假的 | 律师是妹妹的人 | 大纲 |
| 8 | 摊牌前夜 | 证据齐了 | 妹妹先动手 | 沈砚身份揭秘 | 火起 | 大纲 |
| 9 | 火 | 火场 | 林夏被困 | 沈砚救人 | 左臂受伤 | 大纲 |
===

=== view {#no-hook src=#episodes where="钩子 = ''" select="集, 标题"}
===

=== view {#paywall-window src=#episodes where="集 >= 8 and 集 <= 10" select="集, 标题, 反转, 结尾悬念"}
===

=== view {#progress src=#episodes by="状态" aggregate="集数 = count(集)"}
===

# 各集 brief {#briefs}

=== embed {src=ep01/ep01-script.geml#brief}
===

=== embed {src=ep02/ep02-script.geml#brief}
===
```

实跑（`--to md --root .`）：`#no-hook` 列出**第 3 集**；`#paywall-window` 列出第 8、9 集的
反转与悬念，供检查付费卡点是否有"身份揭秘"；`#progress` 得 粗剪 1、剧本 1、大纲 3；
两集的 brief 原文出现在"各集 brief"下，剧本改一字全季文档跟着变。方法论里"每集必须有
钩子""第 8–10 集要放超级钩子"这两条，`view` 直接回答，没有新词汇。想去掉投射进来的
重复标题，`embed` 加 `part=body` 即可（规范 §3）。

### 3.3 剧本 `ep01/ep01-script.geml` —— brief、分镜表、提示词、对白

```geml
=== meta
title = "EP01 她睁开了眼"
profile = "geml-media/v1"
episode = 1
platform = "hongguo"
target-duration = 75
aspect = "9:16"
===

# 单集 brief {#brief}

- **开场 3 秒**：林夏在自己的葬礼上睁眼。
- **钩子**：0:15 认出凶手是妹妹；0:40 手机显示三年前的日期；结尾 妹妹推门进来。
- **情绪曲线**：惊 → 恨 → 冷静 → 悬。

# 分镜表 {#board}

%% 给人扫的规划表。每行一个镜头，镜号是它的键；提示词和台词在下面按镜号成块。

=== table {#shots}
| 镜号 | 景别 | 运镜 | 时长 | 角色 | 动作/表情 | BGM |
|---|---|---|---|---|---|---|
| s01 | 特写 | 缓推 | 4 | #hero | 闭眼，睫毛颤动，猛然睁开 | 低频铺底 |
| s02 | 全景 | 固定 | 5 | #hero | 躺在灵堂棺中，周围白花与烛火 | 低频铺底 |
| s03 | 中景双人 | 缓摇 | 6 | #sister #hero | 妹妹低头抹泪、嘴角上扬；林夏盯着她 | 弦乐进 |
| s04 | 近景 | 固定 | 4 | #hero | 瞳孔收缩，握紧手指 | 弦乐停 |
===

=== view {#runtime src=#shots summary="时长 = sum(时长)"}
===

# 镜头 {#shot-blocks}

## s01 {#s01}

=== text {#s01-prompt .prompt shot=s01}
![[../characters.geml#look]] ![[../characters.geml#hero-look]] 特写，从闭眼开始，睫毛颤动，猛然睁开；镜头缓推；烛光从下方打亮面部。
===

=== text {#s01-l1 .line .inner speaker=../characters.geml#narrator}
我死过一次。这一次，我记得是谁推的手。
===

## s02 {#s02}

=== text {#s02-prompt .prompt shot=s02}
![[../characters.geml#look]] ![[../characters.geml#hero-look]] 全景，![[../characters.geml#mourning-hall-desc]] 她半坐起身；固定机位。
===

## s03 {#s03}

=== text {#s03-prompt .prompt shot=s03}
![[../characters.geml#look]] 中景双人，灵堂一角。左：![[../characters.geml#sister-look]] 低头抹泪，嘴角上扬。右：![[../characters.geml#hero-look]] 半坐在棺中盯着她。缓摇，从妹妹摇到林夏。
===

=== text {#s03-l1 .line speaker=../characters.geml#sister to=../characters.geml#hero emotion=假哭}
姐……你怎么会……
===

=== text {#s03-l2 .line speaker=../characters.geml#hero to=../characters.geml#sister emotion=冷}
是你。
===

## s04 {#s04}

=== text {#s04-prompt .prompt shot=s04}
![[../characters.geml#look]] ![[../characters.geml#hero-look]] 近景，瞳孔收缩，手指攥紧棺沿；固定机位；弦乐骤停。
===
```

- **一个镜头一个标题节**，节里是这个镜头的提示词块和它的台词块，按说话顺序排。
  `geml get '#s03'` 取回整场对白连提示词；`embed src=ep01/ep01-script.geml#s03` 把它投射到
  任何地方。
- **对白是 `text {.line}`**，`speaker=` 必填，`to=` 说给谁、`emotion=` 情绪标注可选，
  `.inner` 是内心独白（旁白同理）。一句台词有三个消费者：TTS 的输入、字幕的内容、翻译的
  单元；三个都引用它，谁也不复制它。
- **s03 是双人镜头**：提示词投射两张角色卡（实跑展开后，两段外貌各出现在"左："与"右："
  之后），两句台词两个 `speaker`。角色列写 `#sister #hero`。
- `#runtime` 合计 **19**，与 `target-duration = 75` 的差距由 `media-runtime-off-target`
  报出（§7）。

### 3.4 素材库 —— 共享的与本集的

**`library-shared.geml`**（摘要）：每个角色的三视图（`#hero-sheet`、`#sister-sheet`、
`#male-lead-sheet`）、林夏的 LoRA、四条声线样本（含旁白）、灵堂母版图、一段 BGM。全部
带 `sha256`、`kind`、`origin`，非生成素材带 `license`。形态与下面本集库的 `media-asset`
相同，不重复列。

**`ep01/ep01-library.geml`**：

```geml
=== meta
title = "EP01 素材库"
profile = "geml-media/v1"
===

%% 本集自己的产出：关键帧、take、配音、口型合成。共享素材在 ../library-shared.geml。

# 关键帧与 take {#takes}

=== media-asset {#s01-key src=assets/gen/s01-key-2.png sha256=aa10c3e7 kind=image size=1080x1920 origin=generated}
===

=== media-asset {#s01-take3 src=assets/gen/s01-take3.mp4 sha256=b3f7d2c8 kind=video duration=5.0 fps=24 size=1080x1920 origin=generated}
===

=== media-asset {#s01-take5 src=assets/gen/s01-take5.mp4 sha256=0f9e6a4d kind=video duration=5.0 fps=24 size=1080x1920 origin=generated}
后半段睫毛颤动更自然，前半段有闪烁；只用 2.0 秒以后。
===

=== media-asset {#s02-take1 src=assets/gen/s02-take1.mp4 sha256=7719ce02 kind=video duration=5.0 fps=24 size=1080x1920 origin=generated}
===

=== media-asset {#s03-take2 src=assets/gen/s03-take2.mp4 sha256=5c5c2b7e kind=video duration=6.0 fps=24 size=1080x1920 origin=generated}
双人镜头原始 take，无口型。
===

=== media-asset {#s03-take2-lips src=assets/gen/s03-take2-lips.mp4 sha256=d91b44e0 kind=video duration=6.0 fps=24 size=1080x1920 origin=generated}
s03-take2 加两条配音后的口型合成版。时间线用它，不用原始 take。
===

# 配音 {#voices}

=== media-asset {#s01-l1-vo src=assets/gen/s01-l1-vo.wav sha256=c8d1e5f0 kind=audio duration=3.6 origin=generated}
===

=== media-asset {#s03-l1-vo src=assets/gen/s03-l1-vo.wav sha256=1a9e77c3 kind=audio duration=2.1 origin=generated}
===

=== media-asset {#s03-l2-vo src=assets/gen/s03-l2-vo.wav sha256=6f02b8d4 kind=audio duration=0.9 origin=generated}
===

# 生成日志 {#gen}

%% 追加写入的记录流：每次生成一条，工具写、人不改。inputs 里的 sha256 是生成当刻各输入的哈希。

=== data {#gen-log .gen-log format=jsonl}
{"output":"#s01-key","model":"jimeng-4.5","mode":"t2i","seed":20481,"prompt":"ep01-script.geml#s01-prompt","prompt-sha256":"6b3c…","inputs":[{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa"},{"ref":"../library-shared.geml#hero-lora","sha256":"51b0d7f3"},{"ref":"../library-shared.geml#mourning-hall","sha256":"4d22f9b8"}],"at":"2026-09-14T09:12:03Z"}
{"output":"#s01-take3","model":"seedance-2.0","mode":"i2v","seed":88213,"prompt":"ep01-script.geml#s01-prompt","prompt-sha256":"6b3c…","inputs":[{"ref":"#s01-key","sha256":"aa10c3e7"},{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa"}],"at":"2026-09-14T09:20:41Z"}
{"output":"#s01-take5","model":"seedance-2.0","mode":"i2v","seed":88217,"prompt":"ep01-script.geml#s01-prompt","prompt-sha256":"6b3c…","inputs":[{"ref":"#s01-key","sha256":"aa10c3e7"},{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa"}],"at":"2026-09-14T09:26:15Z"}
{"output":"#s02-take1","model":"kling-3.0","mode":"i2v","seed":5150,"prompt":"ep01-script.geml#s02-prompt","prompt-sha256":"91aa…","inputs":[{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa"},{"ref":"../library-shared.geml#mourning-hall","sha256":"4d22f9b8"}],"at":"2026-09-14T09:31:07Z"}
{"output":"#s03-take2","model":"seedance-2.0","mode":"t2v","seed":41007,"prompt":"ep01-script.geml#s03-prompt","prompt-sha256":"e2e2…","inputs":[{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa"},{"ref":"../library-shared.geml#sister-sheet","sha256":"77ab0c1d"},{"ref":"../library-shared.geml#mourning-hall","sha256":"4d22f9b8"}],"at":"2026-09-14T10:02:55Z"}
{"output":"#s01-l1-vo","model":"cosyvoice-3","mode":"tts","prompt":"ep01-script.geml#s01-l1","prompt-sha256":"d4e0…","inputs":[{"ref":"../library-shared.geml#narrator-voice","sha256":"8f8f10aa"}],"params":{"emotion":"平","speed":0.9},"at":"2026-09-14T10:10:22Z"}
{"output":"#s03-l1-vo","model":"cosyvoice-3","mode":"tts","prompt":"ep01-script.geml#s03-l1","prompt-sha256":"0a0a…","inputs":[{"ref":"../library-shared.geml#sister-voice","sha256":"3e3e91f2"}],"params":{"emotion":"假哭"},"at":"2026-09-14T10:11:40Z"}
{"output":"#s03-l2-vo","model":"cosyvoice-3","mode":"tts","prompt":"ep01-script.geml#s03-l2","prompt-sha256":"b7b7…","inputs":[{"ref":"../library-shared.geml#hero-voice","sha256":"e07a2c11"}],"params":{"emotion":"冷"},"at":"2026-09-14T10:12:05Z"}
{"output":"#s03-take2-lips","model":"sekotalk-2.0","mode":"lipsync","inputs":[{"ref":"#s03-take2","sha256":"5c5c2b7e"},{"ref":"#s03-l1-vo","sha256":"1a9e77c3"},{"ref":"#s03-l2-vo","sha256":"6f02b8d4"}],"params":{"speakers":2},"at":"2026-09-14T10:20:31Z"}
===
```

日志是核心的 `data` 块，`jsonl`：规范 §3.2 把它定义为"记录流形态……盲追加的人机工学，
外加 id 与校验"。每条记录有坐标——实跑 `geml get ep01/ep01-library.geml '#gen-log[8]["inputs"]'`
返回口型合成那条记录的三个输入。**血缘在这里成链**：`#s03-take2-lips` ← `#s03-take2` +
两条配音 ← 两句台词 + 两条声线样本；台词改一个字，配音过期，口型合成过期，用它的那刀
过期。一条 take 是不是"被采用"不是记录的字段：有 `media-clip` 引用它就是采用。

### 3.5 时间线 `ep01/ep01-cut.geml` —— 五条轨

```geml
=== meta
title = "EP01 粗剪 · 竖屏"
profile = "geml-media/v1"
fps = 24
aspect = "9:16"
tracks = "video dialogue bgm subtitle overlay"
primary = "video"
===

%% 每刀都显式写 track=。主轨（meta.primary）上块的先后就是播放顺序，每刀的起点 = 前一刀的终点。
%% 其余轨道用 over= 锚到主轨的某一刀上，offset 是相对那一刀起点的秒数。
%% 字幕轨的 src 指剧本里的台词块而不是素材：台词只有一个家。

# 第一场 灵堂 {#sc01}

=== media-clip {#c01a track=video src=ep01-library.geml#s01-take3 in=0 out=2.0}
睁眼前的静止段，take3 的前两秒最稳。
===

=== media-clip {#c01b track=video src=ep01-library.geml#s01-take5 in=2.0 out=4.0 transition-in=dissolve transition-dur=0.2}
睫毛颤动到睁眼，接 take5 的后半段。两条 take 拼一刀。
===

=== media-clip {#c02 track=video src=ep01-library.geml#s02-take1 in=0 out=5 transition-in=cut}
===

=== media-clip {#c03 track=video src=ep01-library.geml#s03-take2-lips in=0 out=6 transition-in=cut}
用口型合成版。
===

%% 对白轨：一条台词一刀，锚在它所属镜头上。旁白在 s01 上，两句对白在 s03 上。

=== media-clip {#vo-s01-l1 track=dialogue src=ep01-library.geml#s01-l1-vo over=#c01a offset=0.3 gain=0dB}
===

=== media-clip {#vo-s03-l1 track=dialogue src=ep01-library.geml#s03-l1-vo over=#c03 offset=0.4 gain=0dB}
===

=== media-clip {#vo-s03-l2 track=dialogue src=ep01-library.geml#s03-l2-vo over=#c03 offset=3.8 gain=0dB}
===

%% 字幕轨：src 指台词块，dur 与配音同长。

=== media-clip {#sub-s01-l1 track=subtitle src=ep01-script.geml#s01-l1 over=#c01a offset=0.3 dur=3.6}
===

=== media-clip {#sub-s03-l1 track=subtitle src=ep01-script.geml#s03-l1 over=#c03 offset=0.4 dur=2.1}
===

=== media-clip {#sub-s03-l2 track=subtitle src=ep01-script.geml#s03-l2 over=#c03 offset=3.8 dur=0.9}
===

=== media-clip {#bgm track=bgm src=../library-shared.geml#bgm-lowdrone in=0 out=17 over=#c01a offset=0 gain=-14dB fade-out=1.0}
===

=== media-clip {#title track=overlay .lower-third src=../library-shared.geml#hero-sheet over=#c02 offset=0.5 dur=2.5}
临时占位：正式片名卡待出。
===
```

对白与字幕**成对**：同一句台词的配音刀和字幕刀锚同一镜头、同一 `offset`，字幕 `dur` 等于
配音时长。今天两处手写；`check` 对同一台词块的配音刀与字幕刀 offset 或时长不一致报
`media-subtitle-unmatched`（§7），自动摆放是 §9 的待办 `geml media lay`。

### 3.6 样式表 `_index/style.geml` —— 轨道即 frame

```geml
=== meta
title = "时间线样式：轨道即 frame"
profile = "geml-style/v1"
track-h = 56
===

%% 内容文档只说"这一刀在哪条轨"。轨道怎么摆、叠在谁上面，是这里的事。

=== style-screen {#timeline axis=column slots="#video, #overlay, #subtitle, #dialogue, #bgm"}
===

=== style-frame {#video axis=row component=timeline-track slots="media-clip[track=video]" height="{{track-h}}px"}
===

=== style-frame {#overlay axis=row component=overlay-track slots="media-clip[track=overlay]" height="{{track-h}}px"}
===

=== style-frame {#subtitle axis=row component=timeline-track slots="media-clip[track=subtitle]" height="{{track-h}}px"}
===

=== style-frame {#dialogue axis=row component=timeline-track slots="media-clip[track=dialogue]" height="{{track-h}}px"}
===

=== style-frame {#bgm axis=row component=timeline-track slots="media-clip[track=bgm]" height="{{track-h}}px"}
===

=== style-rule {#clip-card match="media-clip" component=clip}
===

=== style-rule {#lower-third match="media-clip.lower-third" component=overlay-card place=bottom}
===
```

`geml style check _index/style.geml ep01/ep01-cut.geml`：**0 error(s), 0 warning(s)**。视图模型
（`--json`）里 `#timeline` 的五个槽位各是一个 frame，每个 frame 用属性选择器
`media-clip[track=…]` 从时间线里选中自己那条轨的所有刀。`geml-style` 一个字没改。
两处是试写时撞出来的：`anchor=` 已是 geml-style 的内含词（取值 flow/parent/viewport），
overlay 的位置改叫 `place=`；主轨片段最初省略了 `track=video`，选择器无法表达"属性缺省
即主轨"，于是**每刀必须显式写 `track=`**——这和"显式声明优于隐式猜测"一致，不是妥协。

### 3.7 块动词就是剪辑动词——实跑

```
geml list ep01/ep01-cut.geml                             → 每刀一个地址：#c01a #c01b #c02 #c03 #vo-s01-l1 …
geml add ep01/ep01-cut.geml --after '#c01b' --in -       → 插入 #c01c：补 0.6 秒停顿再切全景
geml set ep01/ep01-cut.geml '#c02' --head --in -         → 只改 c02 的出点 5 → 4.5，备注不动
geml delete ep01/ep01-cut.geml '#c01a'                   → 剪掉一刀
geml revert ep01/ep01-cut.geml '#c01a' --rev <第一版>     → 只把那一刀找回来，c01c 仍在，c02 仍是新出点
geml history restore ep01/ep01-cut.geml <第一版>         → 整条时间线回到第一版
geml get ep01/ep01-script.geml '#s03'                    → 一个镜头的提示词加整场对白
```

`history restore` 在有未保存改动时拒绝执行（"uncommitted changes … rerun with force"），
这是既有守卫，剪辑场景下正是想要的行为。

实跑暴露的一个问题：`revert` 找回被删的一刀时，把它放到了**所在章节的末尾**，不是原来
两刀之间。文档场景里"回到本节末尾"无伤大雅，时间线里位置就是内容。见 §9 第 2 条。

---

## 4. 文件模型与目录约定

布局见 §3.0。约定，不是要求：

- **全剧三份共享文档**（角色库、共享素材库、全季大纲）**加每集三份**（剧本、素材库、
  时间线）。分开是因为改动节奏不同：角色库一季改几次，剧本一集改几次，素材库只增不改，
  时间线一集改几十次；分开后各自的 `.gemlhistory` 干净。小项目合成一份也合法。
- **跨集引用一律相对路径**（`../characters.geml#hero`），`--root <project>` 限定解析范围
  （规范 §9.4）。这也是 `spec/in_geml_format/` 已在用的写法。
- `assets/` 里的字节**不进任何 GEML 文件**，进的是哈希。规范 §9.4 已经规定媒体在渲染期
  读取、内容不进 `.gemlhistory`；本 profile 把 `sha256` 写成属性，于是**换图会进历史**——
  "这张参考图是第几版"由 `geml history` 回答。
- `_index/media.json` 是 codemap `_index/name-lookup.json` 的同类：一份查找表，
  agent 拿到一个哈希或文件名就能找到它的块。它是构建产物，不手改。
- **全季文档靠投射组装**：`season.geml` 里各集 brief 是 `embed`；将来"全季出场表""全季
  抽卡统计"这类跨集聚合，GEML 今天做不到（§13 第 2 条），由 `geml media cast` /
  `geml media stats` 生成表格文件，再以 `table {src=…csv}` 引入。
- 平台版本是 `embed` 的用法，不是新词汇：`ep01-cut.bilibili.geml` 里
  `=== embed {src=ep01-cut.geml#sc01}` 投射主剪的场，自己只写横屏片头和 `aspect = "16:9"`。
  主剪改一刀，所有平台版跟着变。

---

## 5. 词汇表

### 5.1 `media-asset` —— 一个文件

| 属性 | 必需 | 含义 |
|---|---|---|
| `src` | 是 | 文件路径，相对文档解析，受 §9.4 根目录限定；`http(s)` 由渲染器取 |
| `sha256` | 推荐 | 文件内容的 SHA-256（十六进制，可截短到 ≥ 8 位）。缺失时 `check` 报 `media-asset-unhashed`，且该素材的血缘不可校验 |
| `kind` | 条件 | `image` \| `video` \| `audio` \| `model` \| `text` \| `other`。可由扩展名推断（同 §5.1 行内媒体的 `as` 推断）；推断不出必须写 |
| `duration` | 视频/音频推荐 | 秒。缺失且本机无 ffprobe 时入出点不校验，报 `media-duration-unknown` |
| `fps` / `size` | 否 | 帧率；`宽x高` |
| `origin` | 推荐 | `generated` \| `captured` \| `licensed`。合规审核的第一个问题 |
| `license` | 条件 | 授权依据。`origin=licensed` 或 `captured` 时缺失报 `media-license-missing`（warning，可配置为 error） |
| `mime` | 否 | 显式媒体类型，覆盖扩展名推断 |
| `of` | 推荐 | 这份素材**画的是谁、属于哪个场景或道具**：角色、场景、道具块的引用（`characters.geml#hero`）。解析不到报 `media-of-unresolved`（error）。它让请求能从分镜表**派生**（§6.2） |
| `role` | 推荐 | 在生成里扮演的角色：`sheet`（三视图）\| `master`（母版）\| `lora` \| `voice` \| `first-frame` \| `last-frame` \| `style-ref` \| `workflow` \| `take` \| 宿主词。开放集。`sheet`/`voice`/`lora`/`master` 而无 `of=` 报 `media-asset-unlinked`（info） |

- **空体或备注体。** body 是 raw，放人写的备注（"只用 2.0 秒以后"）。备注是文档事实，
  进历史；它不是 caption——渲染成什么由样式表决定。
- **文件缺失是 warning，哈希不符是 error。** 与 §3.3 源路由同一条规则：一份描述别处
  素材的素材库照样合法、只是未校验（`media-file-missing`）；文件在、内容却不是它说的
  那个（`media-hash-mismatch`），比没有更糟——那是错的文件。
- **LoRA 是素材。** 它是生成的输入、有文件、有版权，和参考图没有区别。`kind=model`。
- **声线样本是素材。** 每个说话的角色一条，TTS 的输入。旁白也有。

### 5.2 `media-clip` —— 一刀

| 属性 | 必需 | 含义 |
|---|---|---|
| `track` | 是 | 轨道名。`meta.tracks` 声明的列表之外的值报 `media-track-undeclared`（warning） |
| `src` | 是 | 素材块引用（`#id` 或 `doc.geml#id`）。**字幕轨可指 `text` 块**（§5.2.3）。不是 `media-asset` 也不是 `text` 报 `media-src-not-asset`（error） |
| `in` / `out` | 视频/音频 | 素材内的起止，秒（小数）；或 `hh:mm:ss:ff` 时码，按 `meta.fps` 换算。`in ≥ out`、越过 `duration` 报 `media-range-out-of-bounds` |
| `dur` | 无固有时长的源 | 静图、文本、`model` 之外任何没有 `duration` 的源在时间线上占多久 |
| `over` | 非主轨 | 锚到**主轨**某一刀（`#id`）。指到非主轨的刀、不存在的刀报 `media-anchor-invalid` |
| `offset` | 否 | 相对 `over` 那一刀起点的秒数，默认 0 |
| `at` | 否 | 绝对起点，秒。**逃生口**：写了它 `over`/`offset` 被忽略并报 `media-absolute-anchor`（info） |
| `transition-in` / `transition-out` | 否 | `cut`（默认）\| `dissolve` \| `fade` \| `crossfade` \| 宿主词。开放集 |
| `transition-dur` | 否 | 过渡时长，秒。超过本刀或相邻刀长度报 `media-transition-too-long` |
| `gain` | 音频 | `-14dB` 这样的字符串 |
| `fade-in` / `fade-out` | 音频 | 秒 |
| `speed` | 否 | 倍速，默认 1 |
| `xywh` | 否 | 源画面裁切，W3C Media Fragments 的 `xywh=` 语法 |

- **body 是 raw，放剪辑备注。** 台词不写在这里（§5.2.3）。
- **class 是开放的。** `.lower-third` 这类只对样式表有意义，profile 不放行也不校验 class。

#### 5.2.1 时间模型

- **主轨**（`meta.primary`，缺省 `video`）是**顺序的**：文档里块的先后就是播放顺序。
  第 *i* 刀的起点 = 第 *i−1* 刀的终点 − 第 *i* 刀 `transition-in` 的重叠量（`cut` 为 0，
  `dissolve`/`crossfade` 为 `transition-dur`，`fade` 不重叠）。第一刀从 0 开始。
- 一刀的时长 = `out − in`（有固有时长的源），或 `dur`（没有的源），再除以 `speed`。
- **非主轨是锚定的**：起点 = `over` 那一刀的起点 + `offset`。在主轨前面插一刀，后面
  所有锚定的字幕、配音、BGM 跟着整体后移，对位不散。这和"id 优于行号"是同一个道理：
  锚在内容上，不锚在数字上。
- 同一非主轨内，文档顺序应与时间顺序一致；不一致报 `media-track-order`（warning）。
  同一轨两刀时间重叠报 `media-track-overlap`（warning；BGM 轨的交叉淡化是合法重叠，
  由 `transition-*` 声明时不报）。
- `over` 只能锚主轨。v1 不允许锚到非主轨的刀（链式锚定），避免"起点依赖起点"的传递
  计算；需要时再放开。

#### 5.2.2 一刀取两条 take 的一段 —— "Frankenstein" 就是两个块

```geml
=== media-clip {#c01a track=video src=ep01-library.geml#s01-take3 in=0 out=2.0}
===
=== media-clip {#c01b track=video src=ep01-library.geml#s01-take5 in=2.0 out=4.0 transition-in=dissolve transition-dur=0.2}
===
```

行业里"最终镜头 40% 由多次生成拼成"在这里没有专门语法：一个镜头拼几段就是几个块，
每个块指向不同 take 的不同区间。`geml history` 记得每次换 take。

#### 5.2.3 字幕轨：`src` 指台词块

```geml
=== media-clip {#sub-s03-l1 track=subtitle src=ep01-script.geml#s03-l1 over=#c03 offset=0.4 dur=2.1}
===
```

台词在剧本里是 `text {.line speaker=…}`，有三个消费者：TTS 的输入、字幕的内容、翻译的
单元。三个消费者都引用它，谁也不复制它。字幕轨的 `media-clip` 的 `src` 因此可以是一个
`text` 块——渲染时取它的行内内容作为字幕文本，`dur` 必填（文本没有固有时长）。其他轨的
`src` 指到 `text` 块是 error。

出海版字幕沿语言轴投影：一份 `ep01-script.pt.geml` 里全是
`=== embed {src=ep01-script.geml#s03-l1 translate-to=pt}`，葡语字幕轨的 `src` 指它。
这是 `geml-translator` 的现成能力（GEP-0010），本 profile 一个键都不加。

### 5.3 生成日志 —— `data {.gen-log format=jsonl}`

一条记录一次生成。字段：

| 字段 | 必需 | 含义 |
|---|---|---|
| `output` | 是 | 产出的素材块引用；**失败时为 `null`** 并带 `error`。解析不到 `media-asset` 报 `media-gen-output-not-asset` |
| `model` | 是 | 模型名，自由字符串（`seedance-2.0`、`kling-3.0`、`cosyvoice-3`、`sekotalk-2.0`） |
| `mode` | 是 | `t2i` \| `i2v` \| `t2v` \| `tts` \| `lipsync` \| `upscale` \| `other` |
| `prompt` | 条件 | 提示词块或台词块引用。`t2i/i2v/t2v/tts` 必需；`lipsync/upscale` 没有 |
| `prompt-sha256` | 与 prompt 同 | **展开投射之后**的提示词文本的哈希——模型看到的那串字。角色卡改了，这个值变 |
| `inputs[]` | 否 | `{ref, sha256, role?}`：参考图、LoRA、关键帧、声线样本、待合成的 take 与配音、ComfyUI 的 workflow 等素材块引用，与生成当刻它们的 `sha256`；`role` 同 `media-asset.role`，说明这个输入在这次生成里当什么用 |
| `seed` / `params` | 否 | 种子；开放 map（`{"emotion":"假哭"}`、`{"speakers":2}`） |
| `at` | 是 | ISO-8601 时刻 |
| `cost` | 否 | 数值，单位由项目约定 |
| `tool` | 否 | 跑这个模型的软件与版本（`comfyui@0.3.4`、`kling-api`）。同一模型可以在不同地方跑，这里记在哪跑的 |
| `prompt-text` | 否 | 实际发出的提示词全文。`prompt-sha256` 是它的哈希；存全文是为了复现，可省 |
| `error` | 条件 | `output` 为 `null` 时的失败原因。失败记录进 `stats` 的成功率，报 `media-gen-failed`（info） |

- **为什么是核心 `data` 块而不是新类型。** 三个理由：JSON 语法由核心校验，坏记录是
  `data-parse` error 而不是静默的 raw；每条记录、每个字段有坐标（`#gen-log[8]["inputs"]`）；
  记录数组能直接喂 `geml-chart`——"每个镜头抽了几次卡"是一张柱状图，零新词汇。
  用 `media-generation` 类型的话 body 是 raw，三样全丢。
- **为什么 `.gen-log` 是 class 而不是属性。** 它只是让 `check` 认出"这个 data 块按生成
  日志的 schema 验"。class 是核心已有的、开放的命名空间。
- **日志只追加。** 坐标是位置的，日志不重排，所以坐标稳定——这是规范自己给 jsonl 的
  理由。`geml media log` 是唯一推荐的写入方式；agent 不手写哈希（同 geml-history §10
  的 SHOULD NOT）。
- **"采用"不是字段。** 见 §3.4。
- **哈希是什么的哈希。** 素材：文件字节的 SHA-256，即它 `sha256=` 属性的值。提示词与
  台词：展开全部投射后的纯文本（`geml media prompt` 输出的那串字）的 UTF-8 字节，LF 换行。
  两者都由工具算，人不算。

### 5.4 剧本层：角色、对白、镜头 —— 不新增类型，放行五个属性

剧本层全部用核心词汇。本 profile 只在 `text` 上放行五个键：

| 键 | 在哪 | 含义 |
|---|---|---|
| `shot` | `text.prompt` | 这条提示词属于哪个镜号。`check` 要求分镜表 `镜号` 列的每个值恰有一个 `.prompt` 带相同 `shot=`，反之亦然（`media-shot-unpinned` / `media-prompt-orphan`） |
| `speaker` | `text.line` | 说话的角色块引用，**必填**。解析不到是核心的 `unresolved-reference`；解析到的块不在演员表 `id` 列报 `media-speaker-not-cast`（warning） |
| `to` | `text.line` | 说给谁，角色块引用，可选 |
| `emotion` | `text.line` | 情绪标注，自由字符串，可选。它是剧本的**意图**；TTS 记录 `params.emotion` 是实际发出的。两者不一致 `check` 报 `media-emotion-drift`（info） |
| `since` | `text.look` | 这版外貌从第几集起生效。`episode ≥ since` 的剧本里仍投射旧版 look 报 `media-look-outdated`（warning） |

约定 class（不放行、不校验；样式表和 `check` 靠它们识别）：`.prompt` 提示词、`.line` 台词、
`.inner` 内心独白或旁白、`.look` 外貌。

**角色。** 演员表是一张 `table`，`id` 列是文档内引用；每个角色一个标题节，节里是外貌、
禁改项、角色卡。旁白是角色。男女主、配角、反派只是 `定位` 列的值，`view` 按它筛。
人物关系是另一张表；关系的**变化**写在"变化"列，将来若要按集筛，拆成一行一次变化即可。

**对白。** 一句台词一个 `text {.line}`，在所属镜头的标题节里按说话顺序排。它是 TTS 的
`prompt`、字幕刀的 `src`、翻译的单元。双人对白就是两个 `.line` 两个 `speaker`；口型合成是
一条 `mode=lipsync` 的记录，输入是原始 take 加各句配音。对白的**时间位置**（在镜头里第几秒
开口）写在时间线的配音刀上，不写在剧本里：剧本说"谁对谁说了什么"，时间线说"什么时候"。

**镜头。** 分镜表是给人扫的规划表，提示词块是给模型的。两者各存不同的事实，只共享一个
键（镜号），像外键。曾考虑过的替代：每个镜头只有标题节、分镜表由样式表渲染出来。
没选它，因为分镜表是这个行业的母语（Excel，12 列的规则文档），先在它自己的形态上
给它地址和派生，比要求它换形态更能落地。

**不定义 `story-*` 类型。** 剧集、场、镜头、角色、道具在这里都是标题或普通块。
将来某个真实用例需要更多结构（比如按集筛人物关系、道具出场表），那是 `geml-story/v1`
的事；本 profile 的血缘引用对块类型不设限，两者天然可组合。

### 5.5 多轨的呈现：`geml-style` 的 frame 与 overlay

内容文档为多轨只多了一个属性（`track=`）和一对锚定（`over=`/`offset=`）。**轨道怎么画**
全在样式表（§3.6）：

- 一个 `style-screen {#timeline axis=column}`，槽位是若干 frame，一个 frame 一条轨。
- 每个 frame `axis=row component=timeline-track slots="media-clip[track=…]"`——沿时间轴
  横排，属性选择器把这条轨的刀全选进来。`component=` 是开放注册表，`timeline-track`
  由宿主 viewer 实现：读每刀算出的起点与时长，按比例摆盒子。
- **overlay 不是新轴。** 它就是一个 `component=overlay-track` 的 frame，宿主把它画在
  视频轨之上；一刀在画面里的位置（`.lower-third`）由 `style-rule` 的透传参数决定
  （`place=bottom`），profile 不定义画面几何。
- `geml-style` 今天缺什么：**什么都不缺**。`axis` 只有 row/column 够用（时间是 row），
  叠放靠 component。唯一的新东西是宿主要实现两个组件契约（`timeline-track`、
  `overlay-track`）和一个 `clip` 组件。
- 分镜板同理：`style-frame {#board slots="table#shots, text.prompt, text.line"}` 把分镜表、
  提示词卡、台词摆在一页；`style-state` 让点一行高亮它的提示词、台词与所有刀（主从视图，
  codemap 已经这么用）。

### 5.6 多集的组织

- **全季一份 `season.geml`**：分集大纲表（集、标题、核心冲突、钩子、反转、结尾悬念、状态），
  `view` 回答"哪集没钩子""付费窗里放了什么""进度分布"；各集 brief 用 `embed` 投射进来，
  不复制。`meta.paywall` 记付费卡点所在集。
- **每集一个目录**，三份文档同形（§3.0）。集号在目录名、文件名和 `meta.episode` 里各
  出现一次；`check` 三者不一致报 `media-episode-mismatch`（warning）。
- **共享素材与本集素材分库**：三视图、LoRA、声线、母版、音乐在 `library-shared.geml`；
  关键帧、take、配音、口型合成在本集库。本集库的生成记录以 `../library-shared.geml#…`
  引用共享输入，血缘跨文件成链。
- **外貌随剧情变**用多版 `.look` 加 `since=`（§3.1）。改旧版会让已生成的前几集过期，
  是特性：那正是"改源头、重生受影响镜头"该发生的事。
- **跨集聚合**（全季出场表、每角色出现在哪些镜头、全季抽卡统计）GEML 今天没有：
  `view` 只接一个源。由 `geml media cast` / `geml media stats` 生成 CSV，再以
  `table {src=…}` 引入全季文档（§4、§13 第 2 条）。

### 5.7 `=== meta` 键

| 键 | 文档 | 含义 |
|---|---|---|
| `tracks` | 时间线 | 空格分隔的轨道名列表。声明之外的 `track=` 值 warning |
| `primary` | 时间线 | 主轨名，缺省 `video` |
| `fps` | 时间线 | 时码换算基准 |
| `aspect` | 剧本 / 时间线 | `9:16`、`16:9`；渲染参数，不影响时间 |
| `target-duration` | 剧本 | 目标时长，秒。分镜表 `sum(时长)` 与时间线实际总长偏离 ±10% 以上报 `media-runtime-off-target`（warning） |
| `episode` | 剧本 | 集号；与目录名、文件名对照 |
| `episodes` / `paywall` | 全季 | 总集数；付费卡点所在集。`paywall` 不在 `episodes` 表里报 warning |
| `platform` | 剧本 / 全季 | 元信息，不校验 |

---

## 6. 动词

| 动词 | 做什么 | 期 |
|---|---|---|
| `geml media check <doc…> [--root d] [--json] [--strict-license]` | 本 profile 全部诊断（§7）：引用、轨道、时长、哈希、过期传播、镜号钉合、对白配对。有 ffprobe 时读真实时长补 `duration` 缺失 | P0 |
| `geml media index <root>` | 生成 `_index/media.json`；顺带报未被任何刀引用的素材（`media-asset-unused`，info） | P0 |
| `geml media log <library.geml> --output #id --model m --mode i2v --prompt doc#id [--input #id…] [--seed n] [--param k=v…]` | 算哈希、追加一条记录到 `.gen-log`。生成器的适配脚本调它，人不手写 | P1 |
| `geml media prompt <script.geml> #id` | 输出展开全部投射后的提示词或台词纯文本——发给模型的那串字。核心有 `get --resolved` 后改为它的薄封装 | P1 |
| `geml media stale <root> [--json]` | 只列过期项：哪个源变了、哪些记录、哪些刀。给 agent 的"今天要重生什么"清单 | P1 |
| `geml media todo <root> [--json]` | 待办清单：没有产出的提示词、没有配音的台词、过期项。**从诊断派生**，不是任务文件；agent 的生成循环从它开始（§6.1） | P1 |
| `geml media lay <cut.geml> --shot #c03` | 按镜头里台词的文档顺序与各配音的 `duration`，自动写出配音刀与字幕刀的 `offset`/`dur`（相邻留固定间隙）。人再微调 | P1 |
| `geml media render <cut.geml> --preview` | 把时间线**投射**成一份只含行内媒体引用（`![](clips/x.mp4#t=2.0,4.0)`）的 GEML/HTML：浏览器原生按时间片段播放每一刀。零依赖 | P1 |
| `geml media render <cut.geml> --out ep01.mp4` | ffmpeg：按时间模型拼接、混音、烧字幕。需要本机 ffmpeg | P2 |
| `geml media export <cut.geml> --to otio\|fcpxml\|edl\|ffmpeg\|json` | 交换格式。OTIO 是行业交换标准，剪映/Premiere/Resolve 都能进 | P2 |
| `geml media import <manifest.json> --into library.geml` | 回填：生成平台导出的清单（文件、模型、种子、提示词）→ 素材块 + 日志记录 | P2 |
| `geml media cast <root> [-o cast.csv]` | 全季出场表：角色 × 集 × 镜头，从各集分镜表与 `speaker=` 汇总。产出 CSV，供全季文档 `table {src=}` | P2 |
| `geml media stats <root> [-o stats.csv]` | 全季抽卡统计：每镜头生成次数、采用率、按模型分布。从各集 `.gen-log` 汇总 | P2 |

核心动词一个不加名字：`list` / `get` / `set` / `add` / `delete` / `revert` / `find` 在时间线
上就是剪辑动词，§3.7 已实跑。

### 6.1 工具怎么接：MCP、CLI 与适配器

一集漫剧要过手七八种工具：写剧本的大模型、生图、图生视频、TTS、口型、剪辑、审核。
本 profile 对它们的态度只有一句：**文档说 what，不说 how；生成器不进 GEML。** 具体分三层。

**第一层，文档只记事实。** `.gen-log` 里的 `model` / `mode` / `params` 是"用了什么"，不是
"怎么调用"——没有 endpoint、没有 key、没有脚本（规范 §9.1：文档是数据，永不是代码）。
**工作队列是派生的，不是任务文件**：`geml media todo` 从三类诊断得出待办——没有产出的
提示词（`media-prompt-ungenerated`）、没有配音的台词（`media-line-unvoiced`）、过期项
（`media-stale-*`）。没有人给 agent 写任务单，它读诊断。这和 codemap 记 `resolution-default =
cpg | heuristic` 是同一个原则：文档记下事实是**怎么来的**，引擎本身在文档外。

**第二层，一套动词，两个传输。** 每个 `geml media` 动词既是 CLI 子命令，也是 MCP 工具
（`geml_media_todo`、`geml_media_prompt`、`geml_media_log`、`geml_media_check`、
`geml_media_stale`、`geml_media_lay`、`geml_media_import`、`geml_media_render`、
`geml_media_export`），一份实现两个入口，**任何动词不得只在一边**。这是对现状的一个刻意
改变：今天 MCP 只暴露核心动词加 `geml_history`，codemap 与 style 的动词只有 CLI。理由是
调用者不同——codemap 的主要调用者是构建脚本，media 的主要调用者是 agent 的生成循环。
MCP 工具的输入只有文档路径、块地址和文本，不收也不返回文件字节；描述沿用核心的写法：
"先调 `todo`，它给的地址就是 `log` 要的"。

**第三层，适配器。三种形态，v1 只做前两种。**

| 形态 | 谁调谁 | 什么时候用 | v1 |
|---|---|---|---|
| **a. agent 编排**（主路径） | agent 用 geml 的 MCP 工具读提示词、记结果；用**生成器自己的** MCP 或 CLI 生成（可灵、fal、ComfyUI 各有 MCP server，没有的走其 SDK） | 交互式创作、逐镜头抽卡 | 做：循环写成 skill |
| **b. 清单导入**（批处理路径） | 任何能写文件的工具输出一份 manifest JSON，`geml media import` 转成素材块与日志记录 | ComfyUI 批处理、即梦/可灵网页导出、TTS 批量、剪映的 SRT | 做：定义 manifest 形态 |
| **c. 驱动插件**（`geml media run --provider x`，geml 自己调 API） | geml 内置 provider 代码 | 同一个 provider 的适配脚本在三个以上项目里被抄来抄去时 | **不做**（§11）。做了也是独立包 `@geml/media-provider-<name>`，不进 `@geml/geml` |

形态 a 的循环，写成 `integrations/*-plugin/skills/geml-media/SKILL.md`，四个 agent 平台各
一份（`geml-code-graph` 已有同样的四份先例）：

```
geml_media_todo            → 拿到一个镜号 / 一句台词 / 一个过期项，和它的地址
geml_media_prompt          → 展开后的提示词或台词文本
<生成器的 MCP / CLI>        → 生成，文件落到 <ep>/assets/gen/…（geml 不参与）
geml_media_log             → 记 output / model / mode / prompt / inputs / seed，哈希由工具算
geml_media_check           → 有诊断就回到第一步
```

geml 在这个循环里一行 provider 代码都没有。生成器换了，skill 里换一行，文档一个字不变。

形态 b 的 manifest 是一个 JSON 数组，每条：

| 字段 | 必需 | 含义 |
|---|---|---|
| `file` | 是 | 产出文件路径，必须在 `--root` 之内（§9.4） |
| `model` / `mode` | 是 | 同 `.gen-log` |
| `prompt` | 条件 | 提示词或台词块地址（`ep01-script.geml#s03-prompt`） |
| `inputs[]` | 否 | 素材块地址列表；哈希由 `import` 当场算，manifest 不写 |
| `seed` / `params` / `at` / `cost` | 否 | 同 `.gen-log` |

`import` 为每个文件算 SHA-256：库里已有同哈希的素材就复用它的块，不重复建；块 id 由
`--id-from prompt|file` 决定（默认按提示词镜号加序号：`s03-take4`）。对方不需要知道 GEML
的存在——只要能写 JSON。

**唯一直接调用的外部程序是 ffmpeg / ffprobe。** 它通用、本地、无 API、无账号。用法与
codemap 调 Joern 一致：可选依赖，缺了降级并说清楚（`media-duration-unknown`），永不静默。

**剪辑软件的边界是文件。** 出口 `export --to otio | fcpxml | srt`：Premiere、Resolve 走
OTIO/FCPXML；剪映没有公开 API，给它 clips 目录加 SRT 加一份 EDL 文本。回写——剪辑师在
NLE 里改了刀——v1 不做，见 §13 第 12 条。

**provider 配置不进文档。** "`kling-3.0` 由谁生成、默认参数是什么"在形态 a 里是 agent 自己
的事，在形态 b 里是写 manifest 的脚本的事；两者都不需要 geml 知道。若形态 c 落地，映射放
`_index/providers.geml` 的 `data` 块，密钥永远在环境变量，见 §13 第 13 条。

**agent 边界。** `log` 与 `import` 自己算哈希，agent 不填哈希；`import` 拒绝越出 `--root` 的
路径与重复的 sha256；所有写动词沿用核心的"结果不能解析就拒写"；MCP 工具只返回地址与
文本。

### 6.2 不同工具、不同模型：集成契约

工具今天一个都还没接，所以要定的不是"接哪个"，而是**任何一个**接进来时碰哪几处、
不碰哪几处。答案：**碰三份数据，不碰格式、profile、parser。**

**契约的两端是两份 JSON，中间是任何东西。**

| 端 | 谁产出 | 一条长什么样 |
|---|---|---|
| **请求** | `geml media todo --json` | `{address, mode, prompt, refs:[{role, file, sha256}], constraints:{duration, aspect, fps, size}, model?, params?}` |
| **结果** | 工具 → manifest（§6.1 形态 b）或 `geml media log` 的参数 | `{file \| null, model, tool?, mode, prompt, inputs:[{ref, role}], seed?, params?, error?, at}` |

一个工具就是"请求 → 结果"的任意函数：ComfyUI 的一个 workflow、可灵的 API、一段 Python、
一个 agent 的一轮对话。形态不同，契约相同。

**请求从文档派生，这是 GEML 的活，不是工具的。** 一个镜头要生成什么，文档里已经全有，
只是散在几处；`todo` 把它们拼成一条请求：

| 请求字段 | 从哪来 |
|---|---|
| `prompt` | `.prompt` 块展开投射后的文本；`tts` 是 `.line` 的文本 |
| `mode` | 路由表按条件决定（有 `first-frame` 输入就是 `i2v`，否则 `t2v`；`.line` 是 `tts`） |
| `refs` | 分镜表 `角色` 列的每个角色 → 库里 `of=` 指向它、`role=sheet`/`lora` 的素材；提示词投射到的场景描述块 → `of=` 指向它、`role=master` 的母版；本镜头已采用的关键帧 → `first-frame`；`speaker=` 的角色 → `role=voice` 的样本 |
| `constraints` | 分镜表 `时长`、`meta.aspect`、`meta.fps`、模型卡的上限 |
| `model` / `params` | 路由表的建议与默认参数；agent 可以不听 |

这就是为什么 `media-asset` 需要 `of=` 和 `role=`（§5.1）：没有它们，"林夏的三视图是哪张"
只能靠文件名猜。实跑：共享库里八个素材都加了 `of=`/`role=`，`check` 干净；把一个 `of=`
故意指错，**核心不报**——未注册类型上的属性不做引用检查，所以 `media-of-unresolved` 由
profile 的 check 报。

**模型之间的差异放在四个地方，都是数据。**

1. **模型名带版本**：`model = "kling-3.0"`。换版本就是换名字，旧记录照旧诚实。
2. **模型专有参数透传**：`params` 是开放 map，GEML 只存不解释——与 geml-style 把宿主参数
   透传给组件是同一原则（"透传里装的是宿主的词汇，不是 profile 的"）。
3. **模型能做什么写成模型卡**：`_index/providers.geml` 里一个 `data {.model-card}` 一张：
   支持的 `modes`、`max-duration`、`aspects`、接受哪些 `refs` 角色、`params` 的键与范围、
   `card-date`。由接工具的人维护。`check`（P2）用它报 `media-model-capability`（记录或请求
   超出卡片声明：向 10 秒上限的模型要 12 秒）和 `media-model-unknown`（info）。
4. **谁做什么写成路由表**：同一文档里 `table {#routes}`，列是 `mode`、`条件`、`model`、
   `备选`、`默认参数`。条件是封闭的几个词：`角色数 >= 2`、`有 first-frame`、`时长 > n`、
   `说话人 <= 2`。`todo` 按它填 `model` 建议；失败记一条 `output: null, error: …`，runner
   按 `备选` 列重试；`stats` 按模型算成功率。这就是 invideo 那个"逐镜头路由的决策层"，
   写成一张能 `check`、能 diff、进 history 的表。

```geml
=== meta
title = "模型卡与路由表"
profile = "geml-media/v1"
===

=== data {#seedance-2-0 .model-card}
{"name":"seedance-2.0","modes":["i2v","t2v"],"max-duration":15,"aspects":["9:16","16:9"],"refs":["first-frame","character-sheet","style-ref"],"multi-subject":true,"card-date":"2026-07-15"}
===

=== data {#cosyvoice-3 .model-card}
{"name":"cosyvoice-3","modes":["tts"],"refs":["voice"],"params":{"emotion":"string","speed":[0.5,2.0]},"card-date":"2026-06-30"}
===

=== table {#routes}
| mode | 条件 | model | 备选 | 默认参数 |
|---|---|---|---|---|
| i2v | 角色数 >= 2 | seedance-2.0 | kling-3.0 | |
| i2v | | kling-3.0 | seedance-2.0 | cfg=0.6 |
| tts | | cosyvoice-3 | | speed=0.9 |
| lipsync | 说话人 <= 2 | sekotalk-2.0 | | |
===
```

实跑：这份文档 `check` 是 `ok: no diagnostics`；`geml get _index/providers.geml
'#seedance-2-0["refs"]'` 返回它接受的三种参考角色。

**提示词方言**（Midjourney 的 `--ar --cref`、invideo 的九段式顺序）是适配器的格式化工作。
`prompt-sha256` 哈希的是**实际发出的字串**，`prompt-text` 可选存全文。格式化器改了 → 哈希
变 → 过期，这是对的：发出去的不是同一句话。

**同一模型不同运行方式**（本地 ComfyUI 与云 API）：记录可选 `tool` 字段；ComfyUI 的
workflow JSON 是一个 `role=workflow` 的输入，有哈希——改了 workflow，产出过期。一条通则：
**凡是影响产出、又住在文件或块里的东西，都是带角色的输入；模型名是唯一不是文件的输入。**

**接一个新工具或新模型要做的事**，全部是数据，零代码进 geml：
1. 新模型：写一张模型卡。
2. 路由表加一行。
3. 让工具吃请求 JSON、吐结果 manifest；或按 §6.1 的 skill 循环由 agent 驱动。

不改的：格式、profile 词汇、parser、`check`、`stats`、每一份已有的文档。

### 6.3 自动化流水线：制作公司怎么做，在这个设计上怎么跑

**公开资料里能确认的形态。** 平台方公布的是结果不是架构，能拿到的是层次、卡点和数字：

- **平台派**（腾讯视频 WorkRally、360 纳米漫剧流水线）：三层——**理解层**解析角色关系与
  情感线，标定情绪走向与高潮位置，追踪场景逻辑与道具状态；**调度层**按工艺环节自动拆
  任务、调度资产、分派 Agent 与人；**执行层**资产生成、分镜、视频，外加打戏这类技能模块。
  一致性靠"角色状态动态追踪"主动防穿帮；资产系统是三视图角色、四视图场景；分镜智能体
  自动决策运镜。数字：一次过率 >70%，返工率 <10%（行业 40–50%），日产 5–10 集，首集
  <24 小时，创作者的创意时间占比从 15% 回到 60%；纳米单集 30–60 分钟，素材成功率 >90%。
- **自建派**（Dify + ComfyUI）：大模型出**结构化分镜 JSON**；ComfyUI 把 workflow 存成
  API 格式当模板，Dify 逐镜头注入变量；Loop 加 Scheduler 一晚跑 10 集；角色知识库
  （脸部参考图加描述）每次生成都引用；产出一个视频链接，导入剪映微调。
- **agent 派**（invideo）：导演型 agent 编排，逐镜头路由模型，模型失败自动换模型与提示
  策略；"Always Ask"审批门放在花钱之前；平均 3 次生成出一个可用镜头，40% 镜头由多次生成
  拼接；粗剪回给 agent 做"maker-checker"审。
- **组织形态**：中台化（导演、美术做中台，7–8 人一个项目）；师徒或宗门制（200+ 人分
  项目组，核心 10 人精品组）；3 人极速组（5 天 75 集）。
- **SOP 说得最直白**：自动化只做重复环节——脚本批量发送提示、视频组装、参数管理；
  **必须人工**的是剧情判断、角色一致性、价值观审核、最终发布决策；看板追踪
  脚本→概念图→分镜→音效→剪辑→审核→发布；版本 V1/V2/V3，要求"可追溯源头"。

五个共同点，是这个设计要抓的：状态在平台里而不在文件里，所以换平台就丢；任务是从
剧本和分镜**派生**的，不是人开的单；一致性靠追踪"角色状态"而不是靠人记；人工卡点固定
在几处；抽卡是预算，**选择**是人做。

**在这个设计上怎么跑。** 没有单独的任务库，也没有工作流状态机：**状态就是文档**。
"下一步做什么"是 `todo`，"哪里坏了"是 `check`，"哪里过期"是 `stale`。runner——cron、Dify、
n8n、一个 agent、一个 shell 循环——**无状态**，随时可换，中途换掉也不丢进度。这是
Doc-as-a-Base 在生产线上的直接应用。

| 阶段 | 门（数据里的什么算"过"） | 自动做 | 人做 |
|---|---|---|---|
| 大纲 | `season.geml` 状态列 `大纲` → `剧本` | 大模型起草 brief，写进本集 script | 审 brief，改状态 |
| 剧本与分镜 | 状态 `剧本` → `分镜已审`；`media-shot-unpinned` 为零 | 大模型拆分镜表、写 `.prompt` 与 `.line` | 审分镜表，改提示词 |
| 资产 | 每个出场角色有 `of=` 齐全的 `sheet`/`voice`；`media-asset-unlinked` 为零 | 生成三视图候选、声线试听 | 选定主参考图：选定就是留在库里并写上 `of=` |
| 生成 | `todo` 非空，且本集状态 ≥ `分镜已审` | 路由 → 生成 → `import` → `check`，循环到每镜头有 N 条无诊断的 take（N 在路由表的 `takes` 列） | 挑 take：写一刀 `add`；或先自动预选再人改 |
| 对白 | `media-line-unvoiced` 为零 | TTS、口型合成、`lay` 摆位 | 听配音，改 `emotion=` 重生 |
| 粗剪 | 每个镜号在 cut 里有刀；`media-runtime-off-target` 为零 | `render --preview` | 看片，`set --head` 改入出点 |
| 审核与发布 | `check --strict-license` 干净；AI 标识素材在 overlay 轨 | `export`、`render --out` | 发布决定，改状态 `发布` |

门只有两种形态：**表格里的状态列**，和**某类诊断为零**。前者是人的决定，后者是机器的
事实；`todo` 同时看两者——本集状态没到 `分镜已审`，它不出生成任务，`import` 也拒收该集的
结果（`media-gen-before-approval`，warning）。这就是 SOP 里"必须人工"的四处在文档里的
落点：剧情判断是状态列，一致性是 `stale` 与 `check`，价值观审核是状态列，发布决策是状态列。

**批量与夜跑。** `todo --json` 一次给全量；runner 并发调工具；每个结果一条 manifest；
`import` 批量入库；`check`。一晚 10 集是 300–500 个镜头乘 3 次生成，一千多条记录，jsonl
不在意。抽卡策略是路由表的 `takes` 列加 `stats` 的成功率反馈：某模型在双人镜头上成功率
掉到 30%，路由表改一行，进 history。

**人工卡点在哪落笔。** 选择 = 时间线里的引用；审批 = 表格里的状态列；修改 = `set`；
全部进 `.gemlhistory`，"谁在什么时候把 s03 从 take2 换成 take4"可回溯——SOP 的 V1/V2/V3
追溯需求，不用再建版本目录。

**"角色状态动态追踪"**是平台的卖点，在这里不是一个系统：它是 `.look since=`、道具与场景块、
`of=` 链接和血缘过期传播的副产品。角色卡改了，`stale` 列出受影响的全部镜头；这就是追踪。

**不做工作流引擎**（§11）。runner 是外部的。GEML 给流水线的是三件事：**派生的任务清单**、
**幂等的写入**、**零诊断的门**。

**说实话的差别。** 平台的一体化画布、专家 Agent、技能库，GEML 不做也做不了。GEML 给的是
它们都没给的：状态是你自己的纯文本，可 diff、可 git、可换任何工具；平台倒了，流水线还在。

---

## 7. 诊断目录

| 码 | 级别 | 何时 |
|---|---|---|
| `media-src-unresolved` | error | `media-clip.src` 指向的块不存在 |
| `media-src-not-asset` | error | `src` 解析到的块既不是 `media-asset`，也不是字幕轨允许的 `text` |
| `media-file-missing` | warning | `media-asset.src` 文件不存在（描述别处素材的库照样合法） |
| `media-hash-mismatch` | error | 文件存在但 SHA-256 与 `sha256=` 不符 |
| `media-asset-unhashed` | warning | `media-asset` 无 `sha256`，其血缘不可校验 |
| `media-kind-unknown` | error | `kind` 缺失且扩展名推断不出 |
| `media-duration-unknown` | warning | 视频/音频无 `duration` 且无 ffprobe，入出点未校验 |
| `media-range-out-of-bounds` | error | `in ≥ out`，或越过素材 `duration` |
| `media-dur-required` | error | 源无固有时长（静图、文本）而未写 `dur` |
| `media-track-undeclared` | warning | `track=` 不在 `meta.tracks` 里 |
| `media-track-missing` | error | `media-clip` 无 `track=` |
| `media-anchor-invalid` | error | `over=` 不是主轨上的一刀 |
| `media-anchor-required` | error | 非主轨的刀既无 `over=` 也无 `at=` |
| `media-absolute-anchor` | info | 用了 `at=`，锚定被忽略 |
| `media-track-order` | warning | 同一非主轨内文档顺序与时间顺序不一致 |
| `media-track-overlap` | warning | 同一轨两刀时间重叠且未声明过渡 |
| `media-transition-too-long` | warning | `transition-dur` 超过本刀或相邻刀长度 |
| `media-subtitle-unmatched` | warning | 同一台词块的配音刀与字幕刀 `offset` 或时长不一致 |
| `media-license-missing` | warning / error（`--strict-license`） | `origin` 为 `licensed`/`captured` 而无 `license` |
| `media-gen-schema` | error | `.gen-log` 记录缺必需字段或字段形状不对，消息点名记录序号与字段 |
| `media-gen-output-not-asset` | error | 记录的 `output` 不是 `media-asset` |
| `media-gen-cycle` | error | 血缘图成环（某素材是自己的祖先） |
| `media-stale-generation` | warning | 记录里某输入的哈希、或 `prompt-sha256`，与现值不符；消息点名变了的那个 |
| `media-stale-clip` | warning | 一刀的 `src` 是过期记录的产出，**或其祖先过期**；消息带整条链 |
| `media-shot-unpinned` | warning | 分镜表某镜号没有对应 `.prompt shot=` |
| `media-prompt-orphan` | warning | `.prompt shot=` 指向的镜号不在分镜表 |
| `media-line-no-speaker` | error | `.line` 无 `speaker=` |
| `media-speaker-not-cast` | warning | `speaker=` 解析到的块不在演员表 `id` 列 |
| `media-line-unvoiced` | info | 台词块没有任何 `mode=tts` 记录以它为 `prompt`——待配音清单 |
| `media-prompt-ungenerated` | info | 提示词块没有任何记录以它为 `prompt`——待生成清单 |
| `media-emotion-drift` | info | 台词 `emotion=` 与其 TTS 记录 `params.emotion` 不同 |
| `media-look-outdated` | warning | `episode ≥ since` 的剧本仍投射被更新版取代的 `.look` |
| `media-episode-mismatch` | warning | 目录名、文件名、`meta.episode` 三者集号不一致 |
| `media-runtime-off-target` | warning | 规划或实际时长偏离 `target-duration` ±10% 以上 |
| `media-asset-unused` | info | 素材无任何刀引用、也不是任何记录的输入（`index` 时报） |
| `media-of-unresolved` | error | `media-asset.of=` 指向的块不存在 |
| `media-asset-unlinked` | info | `role` 为 `sheet`/`voice`/`lora`/`master` 的素材没有 `of=`，请求无法从分镜表派生 |
| `media-gen-failed` | info | 记录 `output` 为 `null`；`error` 进 `stats` |
| `media-model-unknown` | info | 记录或请求的 `model` 没有模型卡 |
| `media-model-capability` | warning | 记录或请求超出模型卡声明：模式、时长、画幅、参考角色、参数范围 |
| `media-gen-before-approval` | warning | 生成记录所属的集在 `season.geml` 里状态未到 `分镜已审` |

级别的规矩沿用核心：**结构坏了是 error，事实过期是 warning，选择是 info**。过期是最
常见、最值钱的一类，它必须是 warning 而不是 error——否则改一次角色卡整条流水线红掉，
人就会学着忽略它。

---

## 8. 校验怎么算

1. **装载**：按 `--root` 解析所有跨文档引用；`media-asset` 建表（id → src、sha256、kind、
   duration）；`.gen-log` 记录建表；演员表 `id` 列建集合。
2. **文件**：对每个 `media-asset`，文件存在则算 SHA-256 比对；有 ffprobe 且无 `duration`
   时读真实时长并用于后续校验（不写回文档；`geml media index` 可 `--write-duration`）。
3. **时间**：按 §5.2.1 算每刀起止；范围、锚定、重叠、过渡各出诊断；同一台词块的配音刀与
   字幕刀配对比较。
4. **血缘**：以 `output` 为节点、`inputs[].ref` 与 `prompt` 为入边建 DAG（环 → error）。
   对每条记录：素材输入比 `sha256=` 现值；提示词或台词输入重新展开投射、算哈希比
   `prompt-sha256`。任一不符 → 记录过期。**过期沿 DAG 向下传播**：过期素材作为输入的
   记录也过期（配音过期 → 口型合成过期）。最后对每刀查它的 `src` 是否是过期产出。
5. **剧本**：分镜表 `镜号` 列 ↔ `.prompt shot=` 双向钉合；`speaker=` 对演员表；`.look since=`
   对 `meta.episode`；`sum(时长)` 与实际总长各比 `target-duration`。

ffprobe、ffmpeg 都是**可选依赖**：没有它们，`check` 仍能做除真实时长之外的一切，并把
未校验的项说清楚（`media-duration-unknown`），而不是静默通过。

---

## 9. 待办：依赖核心的改动（不在 profile 内）

GEML 今天没有、而本设计需要的东西，按验证时暴露的顺序。前五条是小改动，第六条是 GEP
且**现在不提**。

1. **`geml get --resolved`。** `get` 返回原文，投射标记原样留着；只有整篇 `--to md` 才
   展开。给单个镜头出可发送的提示词需要按块展开。`geml media prompt` 先自己做，核心
   有了就换成薄封装。
2. **`revert` 找回块的位置。** 现在被删块复活时落在所在章节末尾。需要记住它原来的
   前后邻块（`.gemlhistory` 的逆向补丁里有这个信息），优先复位到原邻块之间，邻块都不在
   了再退回章节末尾。时间线里位置就是内容，这一条不改剪辑用不了 `revert`。
3. **`view` 接受记录数组 `data` 块作 `src`。** 今天 `view` 只接 `table`/`view`。生成日志是
   jsonl，"每个镜头抽了几次卡"用 `view {by="prompt" aggregate="次数 = count(output)"}` 一行
   就能写；现在只能靠 `geml-chart`（它已接受记录数组）或工具算。规范 §6.1 与 §3.2 的
   模型都已就位，缺的是一条允许。
4. **多值格的筛选。** `角色` 列 `#sister #hero`，`where="角色 = '#hero'"` 取不到这一行。核心
   拒绝 `*=` 是对的（§9.2 不让文档文本进模式语言）。两条路：分镜表改为一行一（镜头，角色）
   对——对人不友好；或给 `where` 一个**空格分隔词表的包含**算子（`has`），只对整词匹配，
   不是子串。倾向后者，是否值得单独一个 GEP 待议。
5. **`schema=` 的校验。** 规范把它留白。本 profile 对 `.gen-log` 自己校验，不动核心；
   角色卡这类 `data` 块的字段完整性同样只能由应用层做，先不推核心。
6. **裸 `media` 类型与源路由的 `#t=`。** 这两项是 GEP 而不是小改，**现在不提**。提的
   条件：第二个实现要渲染 `media-clip`（需要规范级的 body 模式与 MUST 级诊断），或
   `code` 之外的第二种源路由用户出现。`view` 从 `table` 里长出来用了两个月，这里也一样：
   先在 profile 里跑，值不值得进核心让用例说。

---

## 10. 稳定性范围 —— 在它上面盖东西之前先读

沿用 `geml-style` §0.1 的做法：只有被真实用例踩过的部分带稳定性承诺。**此刻真实用例
是零**，所以下表左列是"第一个真实用例跑通后即冻结"的候选，右列是"跟着用例变形"的。

| 跑通后守住 | 可以变 |
|---|---|
| `profile = "geml-media/v1"` | 过渡词汇（`transition-*`）、`gain`/`fade-*`、`speed`、`xywh` |
| `media-asset`：`src` `sha256` `kind` `origin` `license` | `mime`；`kind` 的枚举是否扩展 |
| `media-clip`：`track` `src` `in` `out` `dur` `over` `offset` | `at` 是否保留；链式锚定 |
| `.gen-log` 记录：`output` `model` `mode` `prompt` `prompt-sha256` `inputs[].{ref,sha256}` `at` | `params` 的约定键；`cost` |
| `text` 上的 `shot=` `speaker=` | `to=` `emotion=` `since=` 的取值形式 |
| meta：`tracks` `primary` `fps` `target-duration` `episode` | `aspect` 的取值形式；`episodes`/`paywall` |
| 字幕轨 `src` 可指 `text` 块 | 平台版本的文件命名约定；分集目录的命名 |
| 诊断的**存在**与级别 | 诊断的消息措辞 |

---

## 11. v1 明确的非目标

- **不做 NLE。** 没有特效、调色、关键帧动画、变速曲线、多机位同步、嵌套序列（`embed`
  之外）、音频混音（`gain`/`fade` 之外）。这些是剪映、Resolve 的事，GEML 是它们之间的胶水，
  `export --to otio` 是出口。
- **不定义画面几何。** overlay 在画面里的位置是样式表透传给宿主的参数。
- **不接任何一家生成器的 API。** `geml media log` / `import` 定义的是**记录形态**，
  适配脚本在仓库外。第一个适配器（ComfyUI 或即梦导出清单）是验证用例的一部分，
  不是 profile 的一部分。
- **不做审美规则。** 景别重复率、钩子密度、对白长度是编导的事，不是文档结构。
- **不做剧本格式。** 场景标题、动作描写、台词的排版是行业剧本格式（如 Fountain）的事；
  这里的 `.line` 只保证台词有地址、有说话人。
- **不做工作流引擎。** 没有队列、没有调度器、没有重试策略。runner 是 Dify、n8n、cron
  或一个 agent 的 skill；GEML 给它派生的任务清单、幂等的写入和零诊断的门（§6.3）。
- **不管文件本体。** `assets/` 怎么存、走不走 LFS、要不要去重，由项目定；GEML 只拿哈希。

---

## 12. 测试策略

- **夹具用真文件。** `ffmpeg -f lavfi -i color=c=blue:s=64x64:d=1` 生成 1 秒小视频、
  `sine` 生成 1 秒音频、1×1 PNG——都几 KB，进 `test/fixtures/media/`，让哈希、时长、
  越界检查是真的而不是 mock。无 ffmpeg 的 CI 机器跳过真实时长用例并断言
  `media-duration-unknown` 出现。
- **每条诊断一个最小用例**，正例反例各一。过期传播单独一组：改台词一个字 → 台词哈希变
  → 配音记录过期 → 口型合成记录过期 → 用它的那刀标黄，断言链完整；改角色卡 → 三条
  提示词哈希变 → 关键帧、take 记录过期 → 四刀标黄。
- **时间模型用表驱动**：给定刀序列与过渡，断言每刀起止；含 `dissolve` 重叠、`fade`
  不重叠、`speed`、静图 `dur`、配音字幕配对。
- **样式表**：`geml style check` 对 §3.6 的样式表与时间线，0 error 0 warning，`--json`
  视图模型里每个 frame 的槽位数等于该轨刀数。
- **多集**：§3 的八份文档作为一组夹具；`season.geml` 三个 `view` 的输出逐格断言；
  `media-look-outdated` 用一份 `episode = 6` 仍投射 `#hero-look` 的剧本触发。
- **动词往返**：`add` → `set --head` → `delete` → `revert` 后时间线可解析，且
  `history restore` 到任一修订与当时字节一致。
- **跨平台**：路径分隔符、CRLF 的 jsonl、Windows 上 ffprobe 缺失——既有约定。
- **95% 覆盖率门**照旧。

---

## 13. 待讨论的设计

GEML 今天没有、而且**不确定该不该有**的东西，各附倾向。

1. **投射不能按条件选源。** 第 5 集起外貌变了，每条提示词要手写 `#hero-look-2`；
   `![[#hero-look]]` 不会因为 `episode = 6` 就换源。今天靠 `since=` 加 `media-look-outdated`
   兜底。真正的解法是"带条件的投射"或"带版本的块"，两者都碰规范。倾向：**不做**，
   显式引用加一条 warning 已经够；等第二个需要条件投射的用例。
2. **跨文档聚合。** `view` 只接一个源，全季出场表、全季抽卡统计做不出来。三条路：
   `view` 接多个 `src`（并集）；一个 `union` 块；工具生成 CSV 再 `table {src=}`。倾向：
   先走第三条（`geml media cast` / `stats`），它不碰规范；若并集需求在别的领域再出现
   （多仓库 codemap 已经有影子），再考虑前两条。
3. **对白的时间位置该不该自动。** `geml media lay` 按配音时长顺排是待办；但"开口前停
   半秒""两句叠一点"是表演，不是算法。倾向：工具给初值，人改，`check` 只管配音与字幕
   配对。
4. **`prompt-sha256` 哈希展开后的文本**，于是 `inputs[]` 里不再需要列角色卡块。但
   "是哪个投射源变了"就要工具去 diff 才知道。是否同时记录每个投射源的哈希（冗余但
   诊断精确），待用例。
5. **`embed` 不能覆盖属性。** 平台版若要同一刀在竖屏版用不同 `xywh` 裁切，`embed` 投射
   过来的刀改不了属性；只能在平台版里重写那一刀。倾向：先重写，看有多少刀真的要改；
   若多数刀都要，那是 `embed` 的一个 GEP（属性覆盖），不是本 profile 的事。
6. **秒还是时码。** v1 两者都收（`in=2.0` / `in=00:00:02:00`），`fps` 缺失时时码报错。
   是否该只留一种，等剪辑师用过再定。
7. **生成日志按集还是按项目。** 按集小而干净，跨集复用的角色三视图记录会分散；按项目
   一个日志会长到几千行。倾向按集，共享素材的生成记录放 `library-shared.geml` 自己的
   `.gen-log`。
8. **多说话人口型的粒度。** 今天一条 `lipsync` 记录输入整条 take 加全部配音，输出一条。
   若工具按说话人分别处理，是两条记录两个中间产物还是一条记录 `params.speakers=2`，
   看第一个真实工具的形态。
9. **`over=` 锚到非主轨**（字幕锚配音而非画面）。v1 禁，看有没有人要。
10. **人物关系的变化按集筛。** `#relations` 的"变化"列是散文。要按集筛就得一行一次变化，
    表会长成事件日志——那时它也许该是 `data` 而不是 `table`，或者干脆是 `geml-story` 的事。
11. **`media-asset` 的 `text` kind**：SRT/ASS 字幕文件、LUT、外部 prompt 文件也是文件。
    `kind=text` 先留着，不定义任何行为。
12. **NLE 回写。** 剪辑师在 Premiere 里挪了三刀，要不要回到 `ep01-cut.geml`？做法只有
    一种说得通：`import --from otio` 生成时间线的**新版本**，`geml history` 显示与上一版的
    逐刀差异，人决定收不收。双向实时同步不做——两个真相源是这个项目反对的第一件事。
    倾向：P2 之后，等第一个真的把 OTIO 导进 NLE 的用户。
13. **模型卡由谁维护、放哪。** §6.2 把模型卡与路由表定为项目里的 `_index/providers.geml`。
    但模型卡的内容（上限、画幅、参考角色）对所有项目都一样，理应随适配器分发、项目只写
    路由。倾向：本仓库不收模型卡；适配器包各带自己的卡，`geml media index` 合并到项目的
    `providers.geml`。密钥永远只在环境变量。
14. **自动预选 take。** 平台用视觉模型给 take 打分预选，人只看前几名。打分是一次"生成"：
    有输入（take）、有模型、没有产出文件。是否允许 `mode=qa` 的记录（`output: null`，
    `params.score`），让 `stats` 和预选都读它？倾向：允许，因为它不新增字段；但预选写成
    一刀的动作仍由人或 agent 显式做，`check` 不自动改时间线。

---

## 14. 分期

- **P0 词汇落地。** `profiles.ts` 注册 `geml-media/v1`（两个类型、`text` 上五个键）；
  `spec/profiles/geml-media/` 两份 profile 文档；`geml media check` 与 `index`；§12 的夹具
  与测试。验收：§3 的八份文档 `check` 干净（0 warning），故意改坏每一处各得到对应诊断。
- **P1 血缘、对白与预览。** `media log`、`media stale`、`media todo`、`media prompt`、
  `media lay`、`render --preview`；全部动词同时注册为 MCP 工具；四个 agent 平台的
  `geml-media` skill（§6.1 的循环）。验收：改台词一个字，`stale` 列出配音、口型合成与那一刀；改
  `#hero-look` 一个字，列出全部四刀；浏览器里逐刀按 `#t=` 播放。
- **P2 出入口、全季与模型卡。** `render --out`（ffmpeg）、`export --to otio|ffmpeg`、
  `import`、`cast`、`stats`；`_index/providers.geml` 的模型卡与路由表进 `todo` 与 `check`
  （`media-model-capability`、`media-gen-before-approval`）。验收：导出的 OTIO 能进一款 NLE；ffmpeg 出片时长等于时间模型算出的
  总长；全季出场表 CSV 引入 `season.geml` 后 `check` 干净。
- **P3 viewer。** `timeline-track` / `overlay-track` / `clip` 三个组件契约进
  `geml-viewer`，§3.6 样式表渲染成可拖动的时间线；分镜板主从视图。
- **贯穿：第一个真实用例。** 一集真实漫剧从剧本到出片走一遍，P0 结束前开始。
  §10 的左列在它跑通之前不冻结。

---

## 15. 资料来源

制作流程与工业化：
- 腾讯云开发者社区，《AI漫剧制作流程深度解析：从工具链到工业化实践》
  <https://cloud.tencent.com/developer/article/2647810>
- 腾讯云开发者社区，《零基础AI漫剧智能量产创作营：从剧本到成片的完整技术拆解》
  <https://cloud.tencent.com/developer/article/2719540>
- 塔猴，《AI漫剧怎么制作：2026年从剧本构思到成片完整流程指南》
  <https://www.tahou.com/article/214767579928208389>
- 万兴脑图，《AI漫剧创作流程模板：从剧本分镜到合成分发的完整SOP》
  <https://edraw.wondershare.cn/mindmaster/templates/ai-comic-drama-creation-full-process-mind-map.html>
- invideo，*AI Filmmaking in 2026: The Complete Guide to Producing Short Films With AI Agents*
  <https://invideo.io/blog/ai-filmmaking/>
- MCPlato，*AI Short Drama Tools in 2026: Why the Real Breakthrough Is the Production Workflow*
  <https://mcplato.com/en/blog/ai-short-drama-generation-tools-2026-production-workflow/>

行业数据与案例：
- 新京报，《一分钟成本缩至1000元，AI漫剧站在短剧肩膀上》
  <https://m.bjnews.com.cn/detail/1769062834129084.html>
- 澎湃新闻，《从野蛮生长到规范进阶：AI漫剧如何冲击850亿市场？》
  <https://m.thepaper.cn/newsDetail_forward_32463124>
- CBNData，《短剧之后入局漫剧，阅文、红果、快手再掀三国杀》
  <https://www.cbndata.com/information/294732>

剧本方法论与分镜表规范：
- 提效录，《AI短剧剧本指南：2026从选题到爆款》
  <https://www.tixiaolu.com/posts/ai-short-drama-script-2026>
- 知乎，《AI漫剧分镜脚本生成系统 v1.0 公开规则文档》（12 列分镜表与 15 镜头窗口规则）
  <https://zhuanlan.zhihu.com/p/2006485688619647066>
- 知乎，《AI 短剧角色永不崩的底层逻辑：CHAR 资产库搭建与一致性管控核心技巧》
  <https://zhuanlan.zhihu.com/p/2001320588417996729>

工业化平台（公布的是指标与层次，不是架构）：
- 腾讯云开发者社区，《腾讯视频WorkRally：以专家级Agent重塑漫剧工业化生产》
  <https://cloud.tencent.com/developer/article/2693070>
- 腾讯云开发者社区，《AI漫剧工业化：腾讯WorkRally以智能流水线攻克精品内容产能瓶颈》
  <https://cloud.tencent.com/developer/article/2693080>
- 腾讯新闻，《360集团纳米漫剧流水线正式上线》 <https://news.qq.com/rain/a/20260205A07FL300>
- AI工具集，《纳米漫剧流水线》 <https://ai-bot.cn/namistory/>
- 博客园，《Dify + ComfyUI：零代码打造AI漫剧全自动生产线》
  <https://www.cnblogs.com/posstos/articles/19797306>

标准：
- W3C, *Media Fragments URI 1.0*（`#t=`、`#xywh=`、`#track=`）
  <https://www.w3.org/TR/media-frags/>
- OpenTimelineIO <https://opentimeline.io/>
