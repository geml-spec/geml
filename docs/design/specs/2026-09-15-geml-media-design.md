# geml-media —— 素材、剪辑与生成血缘的应用层 profile

- 日期：2026-09-15
- 状态：设计稿（brainstorm 产出，尚未实现、尚未立 GEP）。GEML 今天没有的东西集中在
  §9（依赖核心的改动）与 §13（待讨论的设计），不散在正文里。示例文档全部用当前 `geml`
  跑过 `check` / `list` / `get` / `add` / `set` / `revert` / `style check`，本文引用的
  命令与输出都是真实的，出处随文标注。
- 目标：让 GEML 成为 AI 图片与视频创作全部**中间产物**的胶水——演员表、角色卡、风格板、
  分集大纲、分镜表、提示词、台词、参考图、生成片段、配音、口型、字幕、时间线——并让
  "改了源头哪些产出要重做"变成一次 `check` 就能回答的问题。**GEML 的格式一个字不动**——
  `=== meta`、块语法、§3 的九个核心类型全不碰。要动的是 `view` 的源域、`where` 的一条
  语义，外加几处 CLI 行为与一个 profile 机制的修复，全部集中在 §9，逐条标了是不是规范级。
- 验证用例：**AI 漫剧的一季**。选它有三个理由：它是 2026 年产量最大的 AI 视频形态
  （§2）；它的痛点恰好是 GEML 四条定律各对一条；它不依赖任何一家生成器，跑通不需要
  等谁的 API。
- 词汇表在别处（将来）：落地后完整的属性表、诊断目录与一致性面写进
  `spec/profiles/geml-media/geml-media-profile{,_CN}.md`，那份跟着实现走，本文停在设计当时。
- 术语：**片段**＝时间线上的一段（`media-clip`，对应 clip；剪映、DaVinci、Final Cut 的
  中文界面都用这个词）；**镜头**＝shot，分镜表的单位，**一个镜头可以由多个片段拼成**
  （§5.2.2）；**刀 / 剪辑点**＝两个片段之间的那个切口，转场发生在那里。三个词在本文各归
  各位，不混用：拿"刀"指片段会让"每个片段的起点 = 前一个片段的终点"这句话在行业读法下
  不成立（切口没有起点），而真正的切口反倒没词可说。
- 命名：profile 叫 `geml-media/v1`，类型名带连字符（`media-asset`、`media-clip`），
  §8.5 保留不带连字符的名字给规范；视觉风格一律叫 **look**，不叫 style——
  `geml-style` 已经是 UI 样式表，两个 "style" 必然混。

---

## 1. 摘要

`geml-media` 是一个**应用层 profile**，与 `geml-codemap`、`geml-style` 同级。它定义三个
带连字符的块类型（`media-asset`、`media-clip`、`media-text`）、在其中一个上放行五个属性键、
约定一种 `data` 块记录形态，并带自己的动词（`geml media …`，§6）。

三条贯穿全文的原则：

1. **素材有身份，片段是引用。** 一个文件一个 `media-asset` 块，`sha256` 是它的身份，
   `src` 只是它现在放在哪。一个片段（`media-clip`）指向素材块的一段时间，不复制字节——
   和 `code {src=file#L14-24}` 指向源码的一段是同一件事。
2. **血缘是可校验的引用，过期是诊断不是猜。** 每次生成追加一条记录：输出了哪个素材、
   用了哪条提示词或台词、哪些输入、以及**生成当刻**各输入的哈希。`check` 拿现值比对，
   角色卡改了一个字，所有下游镜头标黄。这是 `stale-code-snapshot` 在创作域的翻版。
3. **内容与呈现分层。** "这个片段在哪条轨"是内容事实，写在 `media-clip` 上；"轨道怎么摆、
   叠在谁上面"是呈现，交给 `geml-style` 的 `style-frame`。内容文档不为多轨长出任何
   容器语法。

剧本层——演员表、角色卡、分集大纲、分镜表、提示词、台词——**骨架全是核心词汇**：标题
分节、`table`、`view`、`data`、`embed`。只有承载剧本语义的三类块——外貌 `.look`、
提示词 `.prompt`、台词 `.line`——是 `media-text`，五个属性键挂在它上面，核心 `text` 的
命名空间不受影响。不定义任何 `story-*` 类型（§5.4）。

四条定律各落一处：寻址（每个片段、每个素材、每条生成记录、每句台词、每格分镜都有地址）；
投射（角色外貌投射进每条提示词，台词投射成字幕，各集 brief 投射成全季大纲，副本不存在）；
校验（引用、时长、哈希、过期、镜号钉合）；回退（`.gemlhistory` 按块回滚一个片段，不推倒
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
| 角色一致性 | 角色卡是一个块，`![[#hero-look]]` 投射进每条提示词，改一处全变 | 参考图、LoRA、声线样本成为带哈希的 `media-asset`，生成记录记下它们 |
| 改源头后不知道哪些镜头受影响 | 引用在构建期核验 | 生成日志记录输入哈希，`check` 比对现值，逐镜头报 `media-stale-clip` |
| 抽卡与拼接 | `add` / `delete` / `set --head` 就是插入、剪断、改入出点 | 每条 take 一个素材块，一个片段可以只取 take 的 2.0–4.0 秒；两条 take 拼成一个片段就是两个 `media-clip` |
| 对白、配音、字幕三份不同步 | 台词是一个块，TTS、字幕、翻译三个消费者都引用它 | `media-text {.line}` 的 `speaker=`；`text` 种类的轨 `src` 指台词块；配音记录以台词块为 `prompt` |
| 分集大纲与各集 brief 两处维护 | `embed` 把各集 brief 投射进全季文档 | 无需新增 |
| 分镜表 | `table` 给人扫，`view` 求总时长、按角色筛，坐标指到任一格 | 镜号是键，`.prompt shot=` 把提示词块钉到行上，`check` 负责钉牢 |
| 多语言字幕与配音 | 字幕是文本块的投射，`geml-translator` 沿语言轴投影 | `text` 种类的轨，`src` 指文本块而非素材 |
| 版本 V1/V2/V3 可回查 | `.gemlhistory` 按块记录，`revert` 只退一个片段 | 无需新增 |
| 合规：授权依据、AI 标识 | 属性是文档事实 | `origin=` / `license=` 挂在每个素材上，`check` 可要求非 generated 素材必填 license |
| 平台版本拆分 | `embed` 投射主剪的场，各平台版只写自己的头尾 | `aspect=` 是 meta 键，渲染参数 |
| 资产找不到 | 跨文档引用、`--root` 限定 | `_index/media.json`：sha256 → 文档#id，`check --write-index` 产出 |

一个**没有**对应物、也刻意不做的：分镜的"连续 15 个镜头内同景别不超过 3 次"是窗口
聚合，`view` 表达不了，本 profile 不做——那是分镜师的审美规则，不是文档的结构事实。

---

## 3. 一个完整的例子

一季漫剧的骨架，八份文档。**角色库、共享素材库、剧本、本集素材库、时间线这五份必须声明
`profile = "geml-media/v1"`**——角色卡是 `media-text`，素材与片段是 `media-asset` / `media-clip`。
全季大纲与模型卡只用核心词汇，声明与否都合法；样式表声明 `geml-style/v1`。全部通过
`geml check --root .`，此刻的 warning 全部来自这三个类型与五个属性键尚未注册，注册后为零。

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
    providers.geml           模型卡与路由表（数据，不是代码；§6.3）
    media.json               sha256 → {doc, id, src, kind}；`check --write-index` 产出
```

### 3.1 角色库 `characters.geml` —— 演员表、关系、四个角色

```geml
=== meta
title = "《重生之夜》角色库"
profile = "geml-media/v1"
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

=== media-text {#hero-look .look}
二十六岁女性，**银灰短发齐耳**，左眉一道旧疤，黑色高领毛衣，红色长风衣。眼神冷、话少。
===

=== media-text {#hero-look-2 .look since=5}
同 [[#hero-look]]，另加：左臂缠白色绷带，风衣左袖口烧焦。第 5 集火场之后的样子。
===

=== media-text {#hero-donot}
禁改项：发色不得变、疤在左眉不在右、风衣永远是红色。
===

=== data {#hero-card}
{"name": "林夏", "age": 26, "voice": "低、慢、少停顿", "arc": "被害重生，复仇"}
===

# 沈砚 {#male-lead}

=== media-text {#male-lead-look .look}
三十岁男性，黑色短发，深灰大衣，金丝眼镜，左手无名指有戒痕。站姿笔直，不苟言笑。
===

=== media-text {#male-lead-donot}
禁改项：眼镜不摘、戒痕在左手、大衣不换色。
===

# 林岚 {#sister}

=== media-text {#sister-look .look}
二十三岁女性，栗色长卷发，白色连衣裙，珍珠耳钉。笑的时候眼睛不弯。
===

# 旁白 {#narrator}

=== media-text {#narrator-note}
第一人称旁白，林夏重生后的视角，只在每集开头与结尾出现。
===

# 视觉风格板 {#look-board}

=== media-text {#look}
2D 手绘赛璨风，冷色调，蓝紫主色，硬边阴影，电影感 16:9 构图裁竖屏，胶片颗粒轻。
===

# 道具与场景 {#world}

=== media-text {#phone-prop}
林夏的手机：碎屏，锁屏日期 **2023-09-14**。第 1 集 0:40 的钩子，之后每集出现一次。
===

=== media-text {#mourning-hall-desc}
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
- **这份文档里的散文块一律是 `media-text`**，禁改项、道具、场景描述也不例外。按 class 拆
  （`.look`/`.prompt`/`.line` 用 `media-text`、其余留 `text`）看似能把键关得更紧，代价是
  作者每给一个块加 `since=` 都要先改类型（`geml set` 改不了块类型），而且同一份文件里
  两种散文类型混着，选哪个全凭记忆。`media-text` 就是**`text` 加五个键**，一份 media
  文档里只用它，规则只有一条。代价见 §5.4，前提是 §9 第 1 条的"散文类型"落地——否则
  `![[#hero-look]]` 这样的投射会直接报错。

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

=== media-text {#s01-prompt .prompt shot=s01}
![[../characters.geml#look]] ![[../characters.geml#hero-look]] 特写，从闭眼开始，睫毛颤动，猛然睁开；镜头缓推；烛光从下方打亮面部。
===

=== media-text {#s01-l1 .line .inner speaker=../characters.geml#narrator}
我死过一次。这一次，我记得是谁推的手。
===

## s02 {#s02}

=== media-text {#s02-prompt .prompt shot=s02}
![[../characters.geml#look]] ![[../characters.geml#hero-look]] 全景，![[../characters.geml#mourning-hall-desc]] 她半坐起身；固定机位。
===

## s03 {#s03}

=== media-text {#s03-prompt .prompt shot=s03}
![[../characters.geml#look]] 中景双人，灵堂一角。左：![[../characters.geml#sister-look]] 低头抹泪，嘴角上扬。右：![[../characters.geml#hero-look]] 半坐在棺中盯着她。缓摇，从妹妹摇到林夏。
===

=== media-text {#s03-l1 .line speaker=../characters.geml#sister to=../characters.geml#hero emotion=假哭}
姐……你怎么会……
===

=== media-text {#s03-l2 .line speaker=../characters.geml#hero to=../characters.geml#sister emotion=冷}
是你。
===

## s04 {#s04}

=== media-text {#s04-prompt .prompt shot=s04}
![[../characters.geml#look]] ![[../characters.geml#hero-look]] 近景，瞳孔收缩，手指攥紧棺沿；固定机位；弦乐骤停。
===
```

- **一个镜头一个标题节**，节里是这个镜头的提示词块和它的台词块，按说话顺序排。
  `geml get '#s03'` 取回整场对白连提示词；`embed src=ep01/ep01-script.geml#s03` 把它投射到
  任何地方。
- **对白是 `media-text {.line}`**，`speaker=` 必填，`to=` 说给谁、`emotion=` 情绪标注可选，
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

=== media-asset {#s01-key src=assets/gen/s01-key-2.png sha256=aa10c3e7… kind=image size=1080x1920 origin=generated}
===

=== media-asset {#s01-take3 src=assets/gen/s01-take3.mp4 sha256=b3f7d2c8… kind=video duration=5.0 fps=24 size=1080x1920 origin=generated}
===

=== media-asset {#s01-take5 src=assets/gen/s01-take5.mp4 sha256=0f9e6a4d… kind=video duration=5.0 fps=24 size=1080x1920 origin=generated}
后半段睫毛颤动更自然，前半段有闪烁；只用 2.0 秒以后。
===

=== media-asset {#s02-take1 src=assets/gen/s02-take1.mp4 sha256=7719ce02… kind=video duration=5.0 fps=24 size=1080x1920 origin=generated}
===

=== media-asset {#s03-take2 src=assets/gen/s03-take2.mp4 sha256=5c5c2b7e… kind=video duration=6.0 fps=24 size=1080x1920 origin=generated}
双人镜头原始 take，无口型。
===

=== media-asset {#s03-take2-lips src=assets/gen/s03-take2-lips.mp4 sha256=d91b44e0… kind=video duration=6.0 fps=24 size=1080x1920 origin=generated}
s03-take2 加两条配音后的口型合成版。时间线用它，不用原始 take。
===

# 配音 {#voices}

=== media-asset {#s01-l1-vo src=assets/gen/s01-l1-vo.wav sha256=c8d1e5f0… kind=audio duration=3.6 origin=generated}
===

=== media-asset {#s03-l1-vo src=assets/gen/s03-l1-vo.wav sha256=1a9e77c3… kind=audio duration=2.1 origin=generated}
===

=== media-asset {#s03-l2-vo src=assets/gen/s03-l2-vo.wav sha256=6f02b8d4… kind=audio duration=0.9 origin=generated}
===

# 生成日志 {#gen}

%% 追加写入的记录流：每次生成一条，工具写、人不改。inputs 里的 sha256 是生成当刻各输入的哈希。

=== data {#gen-log .gen-log format=jsonl}
{"output":"#s01-key","output-sha256":"aa10c3e7…","model":"jimeng-4.5","mode":"t2i","seed":20481,"prompt":"ep01-script.geml#s01-prompt","prompt-sha256":"6b3c…","prompt-refs":[{"ref":"../characters.geml#look","sha256":"2f77a1b9…"},{"ref":"../characters.geml#hero-look","sha256":"e4c0d812…"}],"inputs":[{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa…"},{"ref":"../library-shared.geml#hero-lora","sha256":"51b0d7f3…"},{"ref":"../library-shared.geml#mourning-hall","sha256":"4d22f9b8…"}],"at":"2026-09-14T09:12:03Z"}
{"output":"#s01-take3","output-sha256":"b3f7d2c8…","model":"seedance-2.0","mode":"i2v","seed":88213,"prompt":"ep01-script.geml#s01-prompt","prompt-sha256":"6b3c…","prompt-refs":[{"ref":"../characters.geml#look","sha256":"2f77a1b9…"},{"ref":"../characters.geml#hero-look","sha256":"e4c0d812…"}],"inputs":[{"ref":"#s01-key","sha256":"aa10c3e7…"},{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa…"}],"at":"2026-09-14T09:20:41Z"}
{"output":"#s01-take5","output-sha256":"0f9e6a4d…","model":"seedance-2.0","mode":"i2v","seed":88217,"prompt":"ep01-script.geml#s01-prompt","prompt-sha256":"6b3c…","prompt-refs":[{"ref":"../characters.geml#look","sha256":"2f77a1b9…"},{"ref":"../characters.geml#hero-look","sha256":"e4c0d812…"}],"inputs":[{"ref":"#s01-key","sha256":"aa10c3e7…"},{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa…"}],"at":"2026-09-14T09:26:15Z"}
{"output":"#s02-take1","output-sha256":"7719ce02…","model":"kling-3.0","mode":"i2v","seed":5150,"prompt":"ep01-script.geml#s02-prompt","prompt-sha256":"91aa…","prompt-refs":[{"ref":"../characters.geml#look","sha256":"2f77a1b9…"},{"ref":"../characters.geml#hero-look","sha256":"e4c0d812…"},{"ref":"../characters.geml#mourning-hall-desc","sha256":"7b31ca04…"}],"inputs":[{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa…"},{"ref":"../library-shared.geml#mourning-hall","sha256":"4d22f9b8…"}],"at":"2026-09-14T09:31:07Z"}
{"output":"#s03-take2","output-sha256":"5c5c2b7e…","model":"seedance-2.0","mode":"t2v","seed":41007,"prompt":"ep01-script.geml#s03-prompt","prompt-sha256":"e2e2…","prompt-refs":[{"ref":"../characters.geml#look","sha256":"2f77a1b9…"},{"ref":"../characters.geml#sister-look","sha256":"c05e3a66…"},{"ref":"../characters.geml#hero-look","sha256":"e4c0d812…"}],"inputs":[{"ref":"../library-shared.geml#hero-sheet","sha256":"9c1e40aa…"},{"ref":"../library-shared.geml#sister-sheet","sha256":"77ab0c1d…"},{"ref":"../library-shared.geml#mourning-hall","sha256":"4d22f9b8…"}],"at":"2026-09-14T10:02:55Z"}
{"output":"#s01-l1-vo","output-sha256":"c8d1e5f0…","model":"cosyvoice-3","mode":"tts","prompt":"ep01-script.geml#s01-l1","prompt-sha256":"d4e0…","inputs":[{"ref":"../library-shared.geml#narrator-voice","sha256":"8f8f10aa…"}],"params":{"emotion":"平","speed":0.9},"at":"2026-09-14T10:10:22Z"}
{"output":"#s03-l1-vo","output-sha256":"1a9e77c3…","model":"cosyvoice-3","mode":"tts","prompt":"ep01-script.geml#s03-l1","prompt-sha256":"0a0a…","inputs":[{"ref":"../library-shared.geml#sister-voice","sha256":"3e3e91f2…"}],"params":{"emotion":"假哭"},"at":"2026-09-14T10:11:40Z"}
{"output":"#s03-l2-vo","output-sha256":"6f02b8d4…","model":"cosyvoice-3","mode":"tts","prompt":"ep01-script.geml#s03-l2","prompt-sha256":"b7b7…","inputs":[{"ref":"../library-shared.geml#hero-voice","sha256":"e07a2c11…"}],"params":{"emotion":"冷"},"at":"2026-09-14T10:12:05Z"}
{"output":"#s03-take2-lips","output-sha256":"d91b44e0…","model":"sekotalk-2.0","mode":"lipsync","inputs":[{"ref":"#s03-take2","sha256":"5c5c2b7e…"},{"ref":"#s03-l1-vo","sha256":"1a9e77c3…"},{"ref":"#s03-l2-vo","sha256":"6f02b8d4…"}],"params":{"speakers":2},"at":"2026-09-14T10:20:31Z"}
===
```

`output-sha256` 是**产出当刻那个文件的哈希**，`prompt-refs` 是**这条提示词投射到的每个源块
与当刻它的哈希**。前者回答"素材现在这份字节是哪条记录产的"——同一个镜头重生一次就多一条
记录，没有它，旧记录永远对不上现值、永远标黄；后者让诊断说得出"变的是 `#hero-look`"而
不只是"提示词变了"。两个字段都由工具写，且**都不能事后补**：老记录缺了就永远缺。

日志是核心的 `data` 块，`jsonl`：规范 §3.2 把它定义为"记录流形态……盲追加的人机工学，
外加 id 与校验"。每条记录有坐标——实跑 `geml get ep01/ep01-library.geml '#gen-log[8]["inputs"]'`
返回口型合成那条记录的三个输入。**血缘在这里成链**：`#s03-take2-lips` ← `#s03-take2` +
两条配音 ← 两句台词 + 两条声线样本；台词改一个字，配音过期，口型合成过期，用它的那个片段
过期。一条 take 是不是"被采用"不是记录的字段：有 `media-clip` 引用它就是采用。

### 3.5 时间线 `ep01/ep01-cut.geml` —— 五条轨

```geml
=== meta
title = "EP01 粗剪 · 竖屏"
profile = "geml-media/v1"
fps = 24
aspect = "9:16"
tracks = "video:video dialogue:audio bgm:audio subtitle:prose overlay:video"
primary = "video"
===

%% tracks 声明"名字:种类"。种类只有 video/audio/prose 三个，说的是内容是什么、住在哪——
%% overlay 轨的种类是 video，它叠在画面上是样式表的事（§3.6）。
%% 每个片段都显式写 track=。主轨（meta.primary）上块的先后就是播放顺序，每个片段的起点 = 前一个片段的终点。
%% 其余轨道用 over= 锚到主轨的某个片段上，offset 是相对那个片段起点的秒数。
%% 种类为 text 的轨，src 指剧本里的台词块而不是素材：台词只有一个家。

# 第一场 灵堂 {#sc01}

=== media-clip {#c01a track=video src=ep01-library.geml#s01-take3 in=0 out=2.0}
睁眼前的静止段，take3 的前两秒最稳。
===

=== media-clip {#c01b track=video src=ep01-library.geml#s01-take5 in=2.0 out=4.0 transition-in=dissolve transition-dur=0.2}
睫毛颤动到睁眼，接 take5 的后半段。两条 take 拼成一个片段。
===

=== media-clip {#c02 track=video src=ep01-library.geml#s02-take1 in=0 out=5 transition-in=cut}
===

=== media-clip {#c03 track=video src=ep01-library.geml#s03-take2-lips in=0 out=6 transition-in=cut}
用口型合成版。
===

%% 对白轨：一条台词一个片段，锚在它所属镜头上。旁白在 s01 上，两句对白在 s03 上。

=== media-clip {#vo-s01-l1 track=dialogue src=ep01-library.geml#s01-l1-vo over=#c01a offset=0.3 gain=0dB}
===

=== media-clip {#vo-s03-l1 track=dialogue src=ep01-library.geml#s03-l1-vo over=#c03 offset=0.4 gain=0dB}
===

=== media-clip {#vo-s03-l2 track=dialogue src=ep01-library.geml#s03-l2-vo over=#c03 offset=3.8 gain=0dB}
===

%% subtitle 轨（种类 prose）：src 指台词块，dur 与配音同长。

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

对白与字幕**成对**：同一句台词的配音片段和字幕片段锚同一镜头、同一 `offset`，字幕 `dur` 等于
配音时长。今天两处手写；`check` 对同一台词块的配音片段与字幕片段 offset 或时长不一致报
`media-subtitle-unmatched`（§7），自动摆放是 §9 的待办 `geml media lay`。

### 3.6 样式表 `_index/style.geml` —— 轨道即 frame

```geml
=== meta
title = "时间线样式：轨道即 frame"
profile = "geml-style/v1"
track-h = 56
===

%% 内容文档只说"这个片段在哪条轨"。轨道怎么摆、叠在谁上面，是这里的事。

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

=== style-rule {#lower-third match="media-clip.lower-third" component=overlay-card overlay-place=bottom}
===
```

`geml style check _index/style.geml ep01/ep01-cut.geml`：**0 error(s), 0 warning(s)**。视图模型
（`--json`）里 `#timeline` 的五个槽位各是一个 frame，每个 frame 用属性选择器
`media-clip[track=…]` 从时间线里选中自己那条轨的所有片段。`geml-style` 一个字没改。
两处是试写时撞出来的。**一、overlay 的位置键叫 `overlay-place=`，不叫 `anchor=` 也不叫
`place=`。** 这两个名字 geml-style 都占了：`anchor=`（flow/parent/viewport）说贴谁，
`place=`（九宫格）说贴哪，两个都是**内含词**。内含词与透传参数的分流在
`style-resolve.ts` 里按 `BOX_WORDS` 判，实测 `place=bottom` 落进 `box` 而不是 `params`：

```
"block": "#title", "params": {"component": "overlay-card"}, "box": {"place": "bottom"}
```

也就是说组件**收不到**它。换成不在 `BOX_WORDS` 里的 `overlay-place=` 才会进 `params`。
**二、主轨片段最初省略了 `track=video`**，选择器无法表达"属性缺省即主轨"，于是**每个片段
必须显式写 `track=`**——这和"显式声明优于隐式猜测"一致，不是妥协；`meta.tracks` 的
"名字:种类"同样不给缺省，理由相同。

### 3.7 块动词就是剪辑动词——实跑

```
geml list ep01/ep01-cut.geml                             → 每个片段一个地址：#c01a #c01b #c02 #c03 #vo-s01-l1 …
geml add ep01/ep01-cut.geml --after '#c01b' --in -       → 插入 #c01c：补 0.6 秒停顿再切全景
geml set ep01/ep01-cut.geml '#c02' --head --in -         → 只改 c02 的出点 5 → 4.5，备注不动
geml delete ep01/ep01-cut.geml '#c01a'                   → 剪掉一个片段
geml revert ep01/ep01-cut.geml '#c01a' --rev <第一版>     → 只把那个片段找回来，c01c 仍在，c02 仍是新出点
geml history restore ep01/ep01-cut.geml <第一版>         → 整条时间线回到第一版
geml get ep01/ep01-script.geml '#s03'                    → 一个镜头的提示词加整场对白
```

`history restore` 在有未保存改动时拒绝执行（"uncommitted changes … rerun with force"），
这是既有守卫，剪辑场景下正是想要的行为。

实跑暴露的一个问题：`revert` 找回被删的一个片段时，把它放到了**所在章节的末尾**，不是原来
两个片段之间。文档场景里"回到本节末尾"无伤大雅，时间线里位置就是内容。见 §9 第 2 条。

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
  抽卡统计"这类跨集聚合，GEML 今天做不到（§13 第 2 条），由 `geml media report --kind`
  生成表格文件，再以 `table {src=…csv}` 引入。
- 平台版本是 `embed` 的用法，不是新词汇：`ep01-cut.bilibili.geml` 里
  `=== embed {src=ep01-cut.geml#sc01}` 投射主剪的场，自己只写横屏片头和 `aspect = "16:9"`。
  主剪改一个片段，所有平台版跟着变。

---

## 5. 词汇表

### 5.1 `media-asset` —— 一个文件

| 属性 | 必需 | 含义 |
|---|---|---|
| `src` | 是 | 文件路径，相对文档解析，受 §9.4 根目录限定；`http(s)` 由渲染器取 |
| `sha256` | 推荐 | 文件内容的 SHA-256，**全长 64 位十六进制**，不截短。键名已点明算法，所以值不带 `sha256:` 前缀（`geml-history` 的键叫通用的 `hash=`，才需要前缀）。缺失时 `check` 报 `media-asset-unhashed`，且该素材的血缘不可校验 |
| `kind` | 条件 | `image` \| `video` \| `audio` \| `model` \| `other`。可由扩展名推断（同 §5.1 行内媒体的 `as` 推断）；推断不出必须写。**没有 `text`**：SRT/LUT/外部提示词文件先归 `other`，等真有用例再按它是什么命名——占一个枚举值却不定义任何行为，读起来像支持，其实什么都没有 |
| `duration` | 视频/音频推荐 | 秒。缺失且本机无 ffprobe 时入出点不校验，报 `media-duration-unknown` |
| `fps` / `size` | 否 | 帧率；`宽x高` |
| `origin` | 推荐 | `generated` \| `captured` \| `licensed`。合规审核的第一个问题 |
| `license` | 条件 | 授权依据。`origin=licensed` 或 `captured` 时缺失报 `media-license-missing`（warning，可配置为 error） |
| `mime` | 否 | 显式媒体类型，覆盖扩展名推断 |
| `of` | 推荐 | 这份素材**画的是谁、属于哪个场景或道具**：角色、场景、道具块的引用（`characters.geml#hero`）。解析不到报 `media-of-unresolved`（error）。它让请求能从分镜表**派生**（§6.2） |
| `role` | 推荐 | 在生成里扮演的角色：`sheet`（三视图）\| `master`（母版）\| `lora` \| `voice` \| `first-frame` \| `last-frame` \| `style-ref` \| `workflow` \| `take` \| 宿主词。开放集。`sheet`/`voice`/`lora`/`master` 而无 `of=` 报 `media-asset-unlinked`（info） |

- **哈希不截短。** 它同时干三件事：过期比对、`import` 的去重键、合规争议时的回查依据。
  前两件截短到 12–16 位也够（一个项目 1 万个素材，48 位的碰撞概率约 1.8e-7），第三件不行：
  截到 64 位（16 个十六进制字符），暴力找一个同前缀的替身约 2^32 次哈希，笔记本几十分钟
  的事；截到 48 位只要几秒。一旦 §2.2 那条"授权依据可回查"当真，截短就把依据作废了。
  而"太长"是显示问题不是存储问题——`sha256=` 是 `geml media log` / `import` 写的，人不写；
  `geml-history` 的 `hash=` 全长存了一整年，没人手读过。**截短只活在显示层**：`check` 的
  消息、`check --write-index` 的输出、人写的备注。本文示例里的哈希按 `geml-history` 文档的惯例
  截断加省略号显示，真实文件里是全长。
- **空体或备注体。** body 是 raw，放人写的备注（"只用 2.0 秒以后"）。备注是文档事实，
  进历史；它不是 caption——渲染成什么由样式表决定。
- **文件缺失是 warning，哈希不符是 error。** 与 §3.3 源路由同一条规则：一份描述别处
  素材的素材库照样合法、只是未校验（`media-file-missing`）；文件在、内容却不是它说的
  那个（`media-hash-mismatch`），比没有更糟——那是错的文件。
- **LoRA 是素材。** 它是生成的输入、有文件、有版权，和参考图没有区别。`kind=model`。
- **声线样本是素材。** 每个说话的角色一条，TTS 的输入。旁白也有。

### 5.2 `media-clip` —— 一个片段

| 属性 | 必需 | 含义 |
|---|---|---|
| `track` | 是 | 轨道名。必须在 `meta.tracks` 里声明过，否则报 `media-track-undeclared`（warning）。轨道的**种类**（`video` / `audio` / `prose`）由 `meta.tracks` 给出，下面几行的适用范围都按种类判，不按轨名判 |
| `src` | 是 | 块引用（`#id` 或 `doc.geml#id`）。`video` / `audio` 种类的轨必须指 `media-asset`；**`prose` 种类的轨必须指 `media-text`**（§5.2.3）。不符报 `media-src-not-asset`（error），消息点名该轨的种类 |
| `in` / `out` | `video` / `audio` 轨 | 素材内的起止，秒（小数）**或** `hh:mm:ss:ff` 时码——两种都收，时码按 `meta.fps` 换算，`fps` 缺失时时码报错。`in ≥ out`、越过 `duration` 报 `media-range-out-of-bounds`。写在 `prose` 轨上报 `media-attr-not-for-kind`（warning） |
| `dur` | 无固有时长的源 | 静图、文本、`model` 之外任何没有 `duration` 的源在时间线上占多久 |
| `over` | 非主轨 | 锚到**主轨**某个片段（`#id`）。指到非主轨的片段、不存在的片段报 `media-anchor-invalid` |
| `offset` | 否 | 相对 `over` 那个片段起点的秒数，默认 0 |
| `at` | 否 | 绝对起点，秒。**逃生口**：写了它 `over`/`offset` 被忽略并报 `media-absolute-anchor`（info） |
| `transition-in` / `transition-out` | 否 | `cut`（默认）\| `dissolve` \| `fade` \| `crossfade` \| 宿主词。开放集 |
| `transition-dur` | 否 | 过渡时长，秒。超过本片段或相邻片段长度报 `media-transition-too-long` |
| `gain` | 音频 | `-14dB` 这样的字符串 |
| `fade-in` / `fade-out` | 音频 | 秒 |
| `speed` | 否 | 倍速，默认 1 |
| `xywh` | 否 | 源画面裁切，W3C Media Fragments 的 `xywh=` 语法 |

- **body 是 raw，放剪辑备注。** 台词不写在这里（§5.2.3）。
- **class 是开放的。** `.lower-third` 这类只对样式表有意义，profile 不放行也不校验 class。

#### 5.2.1 时间模型

- **主轨**（`meta.primary`，缺省 `video`）是**顺序的**：文档里块的先后就是播放顺序。
  第 *i* 个片段的起点 = 第 *i−1* 个片段的终点 − 第 *i* 个片段 `transition-in` 的重叠量（`cut` 为 0，
  `dissolve`/`crossfade` 为 `transition-dur`，`fade` 不重叠）。第一个片段从 0 开始。
- 一个片段的时长 = `out − in`（有固有时长的源），或 `dur`（没有的源），再除以 `speed`。
- **非主轨是锚定的**：起点 = `over` 那个片段的起点 + `offset`。在主轨前面插入一个片段，后面
  所有锚定的字幕、配音、BGM 跟着整体后移，对位不散。这和"id 优于行号"是同一个道理：
  锚在内容上，不锚在数字上。
- 同一非主轨内，文档顺序应与时间顺序一致；不一致报 `media-track-order`（warning）。
  同一轨两个片段时间重叠报 `media-track-overlap`（warning；BGM 轨的交叉淡化是合法重叠，
  由 `transition-*` 声明时不报）。
- `over` 只能锚主轨。v1 不允许锚到非主轨的片段（链式锚定），避免"起点依赖起点"的传递
  计算；需要时再放开。

#### 5.2.2 一个片段取两条 take 的一段 —— "Frankenstein" 就是两个块

```geml
=== media-clip {#c01a track=video src=ep01-library.geml#s01-take3 in=0 out=2.0}
===
=== media-clip {#c01b track=video src=ep01-library.geml#s01-take5 in=2.0 out=4.0 transition-in=dissolve transition-dur=0.2}
===
```

行业里"最终镜头 40% 由多次生成拼成"在这里没有专门语法：一个镜头拼几段就是几个块，
每个块指向不同 take 的不同区间。`geml history` 记得每次换 take。

#### 5.2.3 `prose` 种类的轨：`src` 指台词块

```geml
=== media-clip {#sub-s03-l1 track=subtitle src=ep01-script.geml#s03-l1 over=#c03 offset=0.4 dur=2.1}
===
```

台词在剧本里是 `media-text {.line speaker=…}`，有三个消费者：TTS 的输入、字幕的内容、
翻译的单元。三个消费者都引用它，谁也不复制它。种类为 `prose` 的轨，它的 `media-clip` 的
`src` 因此指一个 `media-text` 块——渲染时取它的行内内容作为字幕文本，`dur` 必填（文本
没有固有时长）。`video` / `audio` 种类的轨指到 `media-text` 是 error，反之亦然。

**判据是种类，不是轨名。** 写成"字幕轨例外"是不可判定的：轨名由作者自由取，一个写
`tracks = "video:video vo:audio cc:prose"` 的项目里根本没有叫 `subtitle` 的轨，例外条款就
没有着落。改成 `meta.tracks` 声明"名字:种类"之后，这条规则、`media build` 该混哪几条轨、
`export --to srt|otio` 该导哪条，三处共用同一个声明，谁都不用猜（§5.7）。

出海版字幕沿语言轴投影：一份 `ep01-script.pt.geml` 里全是
`=== embed {src=ep01-script.geml#s03-l1 translate-to=pt}`，葡语字幕轨的 `src` 指它。
这是 `geml-translator` 的现成能力（GEP-0010），本 profile 一个键都不加。

### 5.3 生成日志 —— `data {.gen-log format=jsonl}`

一条记录一次生成。字段：

| 字段 | 必需 | 含义 |
|---|---|---|
| `output` | 是 | 产出的素材块引用；**失败时为 `null`** 并带 `error`。解析不到 `media-asset` 报 `media-gen-output-not-asset` |
| `output-sha256` | 是（`output` 非 null 时） | **产出当刻**那个文件的哈希。它回答"素材现在这份字节是哪条记录产的"：同一个 `output` 重生一次就多一条记录，没有这个字段就分不出哪条记录对应现值，旧记录会永远报过期。过期只在**与素材现值同哈希的那条记录**上算（§8 第 4 步） |
| `model` | 是 | 模型名，自由字符串（`seedance-2.0`、`kling-3.0`、`cosyvoice-3`、`sekotalk-2.0`） |
| `mode` | 是 | `t2i` \| `i2v` \| `t2v` \| `tts` \| `lipsync` \| `upscale` \| `other` |
| `prompt` | 条件 | 提示词块或台词块引用。`t2i/i2v/t2v/tts` 必需；`lipsync/upscale` 没有 |
| `prompt-sha256` | 与 prompt 同 | **展开投射之后**的提示词文本的哈希——模型看到的那串字。角色卡改了，这个值变 |
| `prompt-refs[]` | 与 prompt 同 | `{ref, sha256}`：这条提示词**投射到的每个源块**与生成当刻它的哈希。`prompt-sha256` 只能说"提示词变了"，这个字段让诊断说得出"变的是 `#hero-look`"。冗余是故意的：不记的话，老记录永远补不回来 |
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
  台词：展开全部投射后的纯文本（`geml get --resolved` 输出的那串字）的 UTF-8 字节，LF 换行。
  两者都由工具算，人不算。

### 5.4 剧本层：角色、对白、镜头 —— 一个 `media-text` 类型，五个属性

剧本层的骨架仍是核心词汇：标题分节、`table`、`view`、`data`、`embed`。只有三类块带
剧本语义，它们是 `media-text`——外貌 `.look`、提示词 `.prompt`、台词 `.line`；五个属性键
放行在这一个类型上：

| 键 | 在哪 | 含义 |
|---|---|---|
| `shot` | `media-text.prompt` | 这条提示词属于哪个镜号。`check` 要求分镜表 `镜号` 列的每个值恰有一个 `.prompt` 带相同 `shot=`，反之亦然（`media-shot-unpinned` / `media-prompt-orphan`） |
| `speaker` | `media-text.line` | 说话的角色块引用，**必填**。解析不到报 `media-speaker-unresolved`（error，由本 profile 报，理由见下）；解析到的块不在演员表 `id` 列报 `media-speaker-not-cast`（warning） |
| `to` | `media-text.line` | 说给谁，角色块引用，可选。悬空同 `speaker` |
| `emotion` | `media-text.line` | 情绪标注，自由字符串，可选。它是剧本的**意图**；TTS 记录 `params.emotion` 是实际发出的。两者不一致 `check` 报 `media-emotion-drift`（info） |
| `since` | `media-text.look` | 这版外貌从第几集起生效。`episode ≥ since` 的剧本里仍投射旧版 look 报 `media-look-outdated`（warning） |

**属性里的引用归 profile 查，不归核心。** 核心只在四处记引用：`embed` 的 `src=`、`data` 的
`schema=`、`view` 的 `src=`，以及行内 `[[…]]`。profile 放行的属性值核心从不解析——实测把
一个 `of=` 指向不存在的块，核心不报。所以 `speaker=` / `to=` / `of=` / `media-clip.src=` 的
悬空引用统统是 `geml check` 的活（profile 的检查挂在核心 `check` 上，§6.1），§7 各有一条码。

**为什么是一个新类型，而不是在核心 `text` 上放行这五个键。** 两条路都能让核心查拼写
（前提是 §9 第 1 条落地），真正的差别是**这五个键跟着谁走**：

| | 核心 `text` + 放行五键 | `media-text` |
|---|---|---|
| 五个键的作用域 | 跟着**文档**：声明了 profile，这份文档每个 `text` 块都合法 | 跟着**类型**：换一份文档、换一个 profile 都带得走 |
| 要核心改几处 | 一处（属性检查） | **三处**（属性检查 + 散文类型谓词，后者解锁投射/md/html） |
| 不认 profile 的实现 | 照旧是 `text` | 未知类型，降级 raw |

选后者，而且**一份 media 文档里所有散文块都用它**——不按 class 拆。拆开看似能把键关得更紧，
实际上作者每加一个 `since=` 就要改块类型（`geml set` 改不了类型），同一份文件里两种散文
类型混着，选哪个全凭记忆。统一之后规则只有一条：**`media-text` 就是 `text` 加五个键**。

代价写在明处，三条：`characters.geml` 必须声明 profile（§3）；角色卡对不认这份 profile 的
工具降级成 raw；**核心要多改两处**——`geml.ts` 的行内投射
今天硬性要求目标是 `text` 块，不改的话 `![[#hero-look]]` 会直接报
`inline-transclusion-not-inline`，而那是本 profile 最核心的机制。详见 §9 第 1 条。

约定 class（不放行、不校验；样式表和 `check` 靠它们识别）：`.prompt` 提示词、`.line` 台词、
`.inner` 内心独白或旁白、`.look` 外貌。**键与 class 的配对**（`since=` 只该出现在 `.look` 上）
核心查不了——它只问"这个键属不属于这个类型"——由 `check` 报
`media-attr-misplaced`（warning）。

**角色。** 演员表是一张 `table`，`id` 列是文档内引用；每个角色一个标题节，节里是外貌、
禁改项、角色卡。旁白是角色。男女主、配角、反派只是 `定位` 列的值，`view` 按它筛。
人物关系是另一张表；关系的**变化**写在"变化"列，将来若要按集筛，拆成一行一次变化即可。

**对白。** 一句台词一个 `media-text {.line}`，在所属镜头的标题节里按说话顺序排。它是 TTS 的
`prompt`、字幕片段的 `src`、翻译的单元。双人对白就是两个 `.line` 两个 `speaker`；口型合成是
一条 `mode=lipsync` 的记录，输入是原始 take 加各句配音。对白的**时间位置**（在镜头里第几秒
开口）写在时间线的配音片段上，不写在剧本里：剧本说"谁对谁说了什么"，时间线说"什么时候"。

**镜头。** 分镜表是给人扫的规划表，提示词块是给模型的。两者各存不同的事实，只共享一个
键（镜号），像外键。曾考虑过的替代：每个镜头只有标题节、分镜表由样式表渲染出来。
没选它，因为分镜表是这个行业的母语（Excel，12 列的规则文档），先在它自己的形态上
给它地址和派生，比要求它换形态更能落地。

**不定义 `story-*` 类型。** 剧集、场、镜头、角色、道具在这里都是标题、`table`
或普通 `text` 块。
将来某个真实用例需要更多结构（比如按集筛人物关系、道具出场表），那是 `geml-story/v1`
的事；本 profile 的血缘引用对块类型不设限，两者天然可组合。

### 5.5 多轨的呈现：`geml-style` 的 frame 与 overlay

内容文档为多轨只多了一个属性（`track=`）和一对锚定（`over=`/`offset=`）。**轨道怎么画**
全在样式表（§3.6）：

- 一个 `style-screen {#timeline axis=column}`，槽位是若干 frame，一个 frame 一条轨。
- 每个 frame `axis=row component=timeline-track slots="media-clip[track=…]"`——沿时间轴
  横排，属性选择器把这条轨的片段全选进来。`component=` 是开放注册表，`timeline-track`
  由宿主 viewer 实现：读每个片段算出的起点与时长，按比例摆盒子。
- **overlay 不是新轴。** 它就是一个 `component=overlay-track` 的 frame，宿主把它画在
  视频轨之上；一个片段在画面里的位置（`.lower-third`）由 `style-rule` 的透传参数决定
  （`overlay-place=bottom`——不能叫 `place=`，那是 geml-style 的内含词，实测会落进 `box`
  而到不了组件，见 §3.6），profile 不定义画面几何。
- `geml-style` 今天缺什么：**什么都不缺**。`axis` 只有 row/column 够用（时间是 row），
  叠放靠 component。唯一的新东西是宿主要实现两个组件契约（`timeline-track`、
  `overlay-track`）和一个 `clip` 组件。
- 分镜板同理：`style-frame {#board slots="table#shots, media-text.prompt, media-text.line"}` 把分镜表、
  提示词卡、台词摆在一页；`style-state` 让点一行高亮它的提示词、台词与所有片段（主从视图，
  codemap 已经这么用）。

### 5.6 多集的组织

- **全季一份 `season.geml`**：分集大纲表（集、标题、核心冲突、钩子、反转、结尾悬念、状态），
  `view` 回答"哪集没钩子""付费窗里放了什么""进度分布"；各集 brief 用 `embed` 投射进来，
  不复制。`meta.paywall` 记付费卡点所在集。
- **每集一个目录**，三份文档同形（§3.0）。集号在目录名、文件名和 `meta.episode` 里各
  出现一次；`check` 三者不一致报 `media-episode-mismatch`（warning）。
- **生成日志按集**：每集的 `.gen-log` 在本集素材库里，共享素材的
  生成记录放 `library-shared.geml` 自己的 `.gen-log`。
- **共享素材与本集素材分库**：三视图、LoRA、声线、母版、音乐在 `library-shared.geml`；
  关键帧、take、配音、口型合成在本集库。本集库的生成记录以 `../library-shared.geml#…`
  引用共享输入，血缘跨文件成链。
- **外貌随剧情变**用多版 `.look` 加 `since=`（§3.1）。改旧版会让已生成的前几集过期，
  是特性：那正是"改源头、重生受影响镜头"该发生的事。
- **跨集聚合**（全季出场表、每角色出现在哪些镜头、全季抽卡统计）GEML 今天没有：
  `view` 只接一个源。由 `geml media report --kind cast|stats` 生成 CSV，再以
  `table {src=…}` 引入全季文档（§4、§13 第 2 条）。

### 5.7 `=== meta` 键

| 键 | 文档 | 含义 |
|---|---|---|
| `tracks` | 时间线 | 空格分隔的 **`名字:种类`** 列表，如 `"video:video dialogue:audio subtitle:prose"`。种类是闭集 `video` \| `audio` \| `prose`，说的是**内容是什么、住在哪**（一个视频文件 / 一个音频文件 / 一个文档里的散文块），不是画在哪——overlay 轨的种类是 `video`，叠放由样式表决定。`prose` 与 §9 第 1 条的"散文类型"同指一个概念，故意共用一个词。只写名字不写种类报 `media-track-kind-missing`（error，不做兼容回退）；种类不在闭集里报 `media-track-kind-unknown`（error）。声明之外的 `track=` 值 warning |
| `primary` | 时间线 | 主轨名，缺省 `video`。**不限定种类**：纯音频剪辑（播客、有声剧）把 `primary` 指向一条 `audio` 轨是合法的 |
| `fps` | 时间线 | 时码换算基准 |
| `aspect` | 剧本 / 时间线 | `9:16`、`16:9`；渲染参数，不影响时间 |
| `target-duration` | 剧本 | 目标时长，秒。分镜表 `sum(时长)` 与时间线实际总长偏离 ±10% 以上报 `media-runtime-off-target`（warning） |
| `episode` | 剧本 | 集号；与目录名、文件名对照 |
| `episodes` / `paywall` | 全季 | 总集数；付费卡点所在集。`paywall` 不在 `episodes` 表里报 warning |
| `platform` | 剧本 / 全季 | 元信息，不校验 |

---

## 6. 动词

本 profile 自己的动词只有七个。每一个都过了三问：必要吗、能不能与别的并掉、有没有现成的
核心动词已经做了同一件事。答案在 §6.1；这里先给表。

| 动词 | 做什么 | 期 |
|---|---|---|
| `geml media log <library.geml> --output #id --model m --mode i2v --prompt doc#id [--input #id…] [--seed n] [--param k=v…]` | 算哈希（含 `output-sha256`、`prompt-refs`）、追加一条记录到 `.gen-log`。生成器的适配脚本调它，人不手写 | P2 |
| `geml media todo <root> [--json]` | 待办清单：没有产出的提示词、没有配音的台词、过期项。agent 的生成循环从它开始（§6.2） | P2 |
| `geml media lay <cut.geml> --shot #c03` | 按镜头里台词的文档顺序与各配音的 `duration`，自动写出配音片段与字幕片段的 `offset`/`dur`（相邻留固定间隙）。人再微调 | P2 |
| `geml media export <cut.geml> --to preview\|otio\|fcpxml\|edl\|srt\|json` | 文档→文档的投射。`preview` 产出一份只含行内媒体引用（`![](clips/x.mp4#t=2.0,4.0)`）的 GEML/HTML，浏览器原生逐段播放，零依赖；其余是交换格式，OTIO 是行业标准，剪映/Premiere/Resolve 都能进 | P2–P3 |
| `geml media build <cut.geml> --out ep01.mp4` | ffmpeg：按时间模型拼接、混音、烧字幕。需要本机 ffmpeg | P3 |
| `geml media import <manifest.json> --into library.geml` | 回填：生成平台导出的清单（文件、模型、种子、提示词）→ 素材块 + 日志记录 | P3 |
| `geml media report --kind cast\|stats <root> [-o x.csv]` | 跨文档聚合产出 CSV，供全季文档 `table {src=}`：`cast` 是出场表（角色 × 集 × 镜头），`stats` 是抽卡统计（每镜头生成次数、采用率、按模型分布） | P3 |

**核心动词一个不加名字**：`list` / `get` / `set` / `add` / `delete` / `revert` / `find` 在时间线
上就是剪辑动词，§3.7 已实跑。**校验也不加名字**：见下。

### 6.1 为什么不是别的形状

| 想得到的动词 | 实际形态 | 理由 |
|---|---|---|
| `media check` | **核心 `geml check`** | 文档自己在 `=== meta` 里声明了 `profile = "geml-media/v1"`，核心已经据此放行词汇（`vocabularyFor`）。"要不要按 media 的规则查"是文档说了算，不该再要求调用者换一个命令名。`geml style check` 那个先例不适用——它吃的是**两份角色不同的文件**（样式表 + 语料），而 media 的输入就是文档本身。ad-hoc 的 `--strict-license` 一并换成通用的 `--severity media-license-missing=error`（§7.1） |
| `media prompt` | **核心 `get --resolved`**（§9 第 2 条） | 它要做的就是"按块展开投射后输出纯文本"，对 `.prompt` 和 `.line` 是同一件事，没有一丝 media 特有的逻辑。留一个薄封装只是给同一个能力起第二个名字 |
| `media stale` | **`geml check --only 'media-stale-*'`** | 过期是诊断的一个子集，不是另一种计算。单开一个动词等于让同一份装载与 DAG 遍历有两个入口，两处各自演化就会不一致 |
| `media render` | **拆成 `export --to preview` 与 `media build`** | 预览产出的是**一份文档**（GEML/HTML），和导出 OTIO/SRT 同类；出成片是调 ffmpeg 产二进制。一个名字扛两件事，它们的依赖、失败模式、产物类型全不同 |
| `media cast` + `media stats` | **一个 `media report --kind`** | 两者是同一件事的两个参数——跨文档聚合、产出 CSV、供 `table {src=}` 引入。而且都是 §13 第 2 条（`view` 接多源）的**替身**：那条一旦落地，这个动词整个消失，所以不值得占两个名字 |
| `media index` | `geml check --write-index` 的副产品 | `check` 的第 1 步本来就要装载全部 `media-asset` 建表（§8）。再跑一个动词把同样的表算一遍并落盘，是重复计算。`_index/media.json` 还要不要，等 P0 真片跑完看查找到底慢不慢——codemap 建索引是因为图有上万节点，一季几千个素材未必需要 |

**一个保留下来、但暴露了核心缺口的**：`media log` 要往一个 `data {format=jsonl}` 块**追加
一条记录**，而核心今天没有这个动作——`add` 加的是块，`set` 换的是整块。所以 `log` 自己
读写文件。这大概是个通用缺口（`geml append <file> '#id'`，记录流追加），但只有 media 一个
用例，按本项目的规矩先在 profile 里跑，第二个用例出现再提核心（同 §9 第 7 条的态度）。

### 6.2 工具怎么接：MCP、CLI 与适配器

一集漫剧要过手七八种工具：写剧本的大模型、生图、图生视频、TTS、口型、剪辑、审核。
本 profile 对它们的态度只有一句：**文档说 what，不说 how；生成器不进 GEML。** 具体分三层。

**第一层，文档只记事实。** `.gen-log` 里的 `model` / `mode` / `params` 是"用了什么"，不是
"怎么调用"——没有 endpoint、没有 key、没有脚本（规范 §9.1：文档是数据，永不是代码）。
**工作队列是派生的，不是任务文件**：`geml media todo` 从三类诊断得出待办——没有产出的
提示词（`media-prompt-ungenerated`）、没有配音的台词（`media-line-unvoiced`）、过期项
（`media-stale-*`）。没有人给 agent 写任务单，它读诊断。这和 codemap 记 `resolution-default =
cpg | heuristic` 是同一个原则：文档记下事实是**怎么来的**，引擎本身在文档外。

**第二层，一套动词，两个传输——暴露多少条待定。** 每个 `geml media` 动词既是 CLI 子命令，也是 MCP 工具
（`geml_media_todo`、`geml_media_prompt`、`geml_media_log`、`geml_media_check`、
`geml_media_stale`、`geml_media_lay`、`geml_media_import`、`geml_media_render`、
`geml_media_export`），一份实现两个入口。这会是对现状的一个刻意改变：今天 MCP 只暴露
核心动词加 `geml_history`，codemap 与 style 的动词只有 CLI。理由是调用者不同——codemap 的
主要调用者是构建脚本，media 的主要调用者是 agent 的生成循环。

**暴露几条是未决项。** MCP 的工具清单开场就进上下文，九条会让每个加载 geml MCP 的会话
都为一个它可能永远不碰的 profile 付 token。三个选项：全上；只上生成循环真正要的三条
（`todo` / `prompt` / `log`，其余留 CLI——`check`/`stale` 是构建期动作，
`render`/`export`/`import` 本来就是批处理）；或给 MCP 服务器加按 profile 分组的开关
（最干净，成本最高）。**等第一个真实用例跑完再定**（§14）——那时才知道 agent 到底调了哪几条。
无论定哪个：MCP 工具的输入只有文档路径、块地址和文本，不收也不返回文件字节；描述沿用
核心的写法："先调 `todo`，它给的地址就是 `log` 要的"。

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
NLE 里改了片段——v1 不做，见 §13 第 8 条。

**provider 配置不进文档。** "`kling-3.0` 由谁生成、默认参数是什么"在形态 a 里是 agent 自己
的事，在形态 b 里是写 manifest 的脚本的事；两者都不需要 geml 知道。若形态 c 落地，映射放
`_index/providers.geml` 的 `data` 块，密钥永远在环境变量，见 §13 第 9 条。

**agent 边界。** `log` 与 `import` 自己算哈希，agent 不填哈希；`import` 拒绝越出 `--root` 的
路径与重复的 sha256；所有写动词沿用核心的"结果不能解析就拒写"；MCP 工具只返回地址与
文本。

### 6.3 不同工具、不同模型：集成契约

工具今天一个都还没接，所以要定的不是"接哪个"，而是**任何一个**接进来时碰哪几处、
不碰哪几处。答案：**碰三份数据，不碰格式、profile、parser。**

**契约的两端是两份 JSON，中间是任何东西。**

| 端 | 谁产出 | 一条长什么样 |
|---|---|---|
| **请求** | `geml media todo --json` | `{address, mode, prompt, refs:[{role, file, sha256}], constraints:{duration, aspect, fps, size}, model?, params?}` |
| **结果** | 工具 → manifest（§6.2 形态 b）或 `geml media log` 的参数 | `{file \| null, model, tool?, mode, prompt, inputs:[{ref, role}], seed?, params?, error?, at}` |

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
故意指错，**核心不报**——核心只在 `embed` 的 `src=`、`data` 的 `schema=`、`view` 的 `src=`
和行内 `[[…]]` 四处记引用，profile 放行的属性值从不解析（§5.4），所以
`media-of-unresolved` 由 profile 的 check 报。

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
3. 让工具吃请求 JSON、吐结果 manifest；或按 §6.2 的 skill 循环由 agent 驱动。

不改的：格式、profile 词汇、parser、`check`、`stats`、每一份已有的文档。

### 6.4 自动化流水线：制作公司怎么做，在这个设计上怎么跑

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
| 生成 | `todo` 非空，且本集状态 ≥ `分镜已审` | 路由 → 生成 → `import` → `check`，循环到每镜头有 N 条无诊断的 take（N 在路由表的 `takes` 列） | 挑 take：写一个片段 `add`；或先自动预选再人改 |
| 对白 | `media-line-unvoiced` 为零 | TTS、口型合成、`lay` 摆位 | 听配音，改 `emotion=` 重生 |
| 粗剪 | 每个镜号在 cut 里有片段；`media-runtime-off-target` 为零 | `export --to preview` | 看片，`set --head` 改入出点 |
| 审核与发布 | `check --severity media-license-missing=error` 干净；AI 标识素材在 overlay 轨 | `export`、`build` | 发布决定，改状态 `发布` |

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
| `media-src-not-asset` | error | `src` 解析到的块与该轨的种类不符：`video`/`audio` 轨不是 `media-asset`，或 `prose` 轨不是 `media-text` |
| `media-file-missing` | warning | `media-asset.src` 文件不存在（描述别处素材的库照样合法） |
| `media-hash-mismatch` | error | 文件存在但 SHA-256 与 `sha256=` 不符 |
| `media-asset-unhashed` | warning | `media-asset` 无 `sha256`，其血缘不可校验 |
| `media-kind-unknown` | error | `kind` 缺失且扩展名推断不出 |
| `media-duration-unknown` | warning | 视频/音频无 `duration` 且无 ffprobe，入出点未校验 |
| `media-range-out-of-bounds` | error | `in ≥ out`，或越过素材 `duration` |
| `media-dur-required` | error | 源无固有时长（静图、文本）而未写 `dur` |
| `media-track-undeclared` | warning | `track=` 不在 `meta.tracks` 里 |
| `media-track-missing` | error | `media-clip` 无 `track=` |
| `media-track-kind-missing` | error | `meta.tracks` 里某条只写了名字，没写 `:种类` |
| `media-track-kind-unknown` | error | 种类不是 `video` / `audio` / `prose` |
| `media-attr-not-for-kind` | warning | 属性与轨道种类不匹配：`gain=`/`fade-*` 在 `video` 轨，`transition-*`/`xywh`/`in`/`out` 在 `prose` 轨 |
| `media-anchor-invalid` | error | `over=` 不是主轨上的一个片段 |
| `media-anchor-required` | error | 非主轨的片段既无 `over=` 也无 `at=` |
| `media-absolute-anchor` | info | 用了 `at=`，锚定被忽略 |
| `media-track-order` | warning | 同一非主轨内文档顺序与时间顺序不一致 |
| `media-track-overlap` | warning | 同一轨两个片段时间重叠且未声明过渡 |
| `media-transition-too-long` | warning | `transition-dur` 超过本片段或相邻片段长度 |
| `media-subtitle-unmatched` | warning | 同一台词块的配音片段与字幕片段 `offset` 或时长不一致 |
| `media-license-missing` | warning（可用 `--severity` 提为 error，§7.1） | `origin` 为 `licensed`/`captured` 而无 `license` |
| `media-gen-schema` | error | `.gen-log` 记录缺必需字段或字段形状不对，消息点名记录序号与字段 |
| `media-gen-output-not-asset` | error | 记录的 `output` 不是 `media-asset` |
| `media-gen-cycle` | error | 血缘图成环（某素材是自己的祖先） |
| `media-stale-generation` | warning | **素材现值对应的那条记录**（`output-sha256` 匹配者）里，某个输入的哈希、`prompt-sha256` 或某条 `prompt-refs[]` 与现值不符；消息点名变了的那个。被取代的旧记录不参与判定 |
| `media-stale-clip` | warning | 一个片段的 `src` 是过期记录的产出，**或其祖先过期**；消息带整条链 |
| `media-shot-unpinned` | warning | 分镜表某镜号没有对应 `.prompt shot=` |
| `media-prompt-orphan` | warning | `.prompt shot=` 指向的镜号不在分镜表 |
| `media-line-no-speaker` | error | `.line` 无 `speaker=` |
| `media-speaker-unresolved` | error | `speaker=` 或 `to=` 指向的块不存在。核心不解析 profile 属性里的引用（§5.4），这条只能由本 profile 报 |
| `media-speaker-not-cast` | warning | `speaker=` 解析到的块不在演员表 `id` 列 |
| `media-line-unvoiced` | info | 台词块没有任何 `mode=tts` 记录以它为 `prompt`——待配音清单。**只出现在 `todo`，不进 `check`**（见表下） |
| `media-prompt-ungenerated` | info | 提示词块没有任何记录以它为 `prompt`——待生成清单。**只出现在 `todo`，不进 `check`** |
| `media-emotion-drift` | info | 台词 `emotion=` 与其 TTS 记录 `params.emotion` 不同 |
| `media-look-outdated` | warning | `episode ≥ since` 的剧本仍投射被更新版取代的 `.look` |
| `media-episode-mismatch` | warning | 目录名、文件名、`meta.episode` 三者集号不一致 |
| `media-runtime-off-target` | warning | 规划或实际时长偏离 `target-duration` ±10% 以上 |
| `media-asset-unused` | info | 素材无任何片段引用、也不是任何记录的输入（`index` 时报） |
| `media-of-unresolved` | error | `media-asset.of=` 指向的块不存在 |
| `media-attr-misplaced` | warning | 属性与 class 不配：`since=` 不在 `.look` 上、`shot=` 不在 `.prompt` 上、`speaker=`/`to=`/`emotion=` 不在 `.line` 上 |
| `media-orphan-record` | info | 一个 `output` 有多条记录，且没有一条的 `output-sha256` 等于该素材现值——现在这份字节来历不明 |
| `media-asset-unlinked` | info | `role` 为 `sheet`/`voice`/`lora`/`master` 的素材没有 `of=`，请求无法从分镜表派生 |
| `media-gen-failed` | info | 记录 `output` 为 `null`；`error` 进 `stats`。**按文档聚合成一条带计数的汇总**，不逐条报 |
| `media-model-unknown` | info | 记录或请求的 `model` 没有模型卡 |
| `media-model-capability` | warning | 记录或请求超出模型卡声明：模式、时长、画幅、参考角色、参数范围 |
| `media-gen-before-approval` | warning | 生成记录所属的集在 `season.geml` 里状态未到 `分镜已审` |

级别的规矩沿用核心：**结构坏了是 error，事实过期是 warning，选择是 info**。过期是最
常见、最值钱的一类，它必须是 warning 而不是 error——否则改一次角色卡整条流水线红掉，
人就会学着忽略它。

**`check` 报健康，`todo` 报工作。** 待生成、待配音这两类"还没做"不是缺陷，一集开工时
每个镜头都命中，`check` 会一次吐几十条 info，健康信号就淹了。它们只从 `geml media todo`
出来（`todo` 本来就从诊断派生，§6.2）。同理，返工率行业均值 40–50%，一季上千条失败
记录，`media-gen-failed` 必须聚合成"本文档 N 条失败"，不能一条一行。

### 7.1 诊断码跟着 profile 走

上面这张表**是这份 profile 的一部分**，不该只活在实现里。三条：

**一、码必须带 profile 前缀。** 全部是 `media-`，与核心码、与别的 profile 的码永不相撞，
读的人看一眼就知道去哪查定义。这条不需要规范改动，是词汇表自己的约定，和 §8.5 要求扩展
用带连字符的类型名同一个道理。

**二、码表与默认级别写进 `ProfileDef`**，而不是散在检查器的各个 `push` 里：

=== code {lang=ts}
"geml-media/v1": {
  types: [...], prose: [...], attrs: {...},
  diagnostics: {
    "media-src-unresolved": "error",
    "media-stale-clip": "warning",
    "media-asset-unused": "info",
    // …
  },
}
===

买到三样东西：

- **一致性面**（规范 §8.4）。第二实现要复刻的是这张表——可抄、可 diff、可断言，而不是
  去读参考实现挖出四十个字符串。
- **严重级别成为一个通用机制**。`geml check --severity media-license-missing=error` 对**任意**
  码都成立，不必每条重要的诊断各长一个专用 flag（`--strict-license` 那种）。`--only 'media-stale-*'`（§6.1 砍掉 `media stale` 那条）
  也靠同一份表做前缀匹配。
- **防两处拷贝漂移**。一个测试就能断言"检查器只发出声明过的码"以及"本文 §7 的表与注册表
  逐行一致"。这个项目在别处吃过同一种亏——同一份事实抄三处，上游一动就漂。

**三、现状是两套，别再加第三套散装的。** 核心的码在 `diagnostics.ts` 的级别表里，
`geml-style` 另有一份 `style-diagnostics.ts`。media 若再把码硬写进自己的检查器，就是第三种
形状。所以这条应当**和 §9 第 1 条一起做**（同属"让 profile 类型成为一等公民"），并让
`geml-style` 将来能迁过来——迁不迁是它自己的事，但机制要留得下它。

**留一个没定的**：用户能不能把 error **降**成 warning。提级（warning → error）显然安全；
降级会让"结构坏了"的判断失效，但现实里"我知道这批素材没 license，别拦我"是真实需求。
倾向允许降级但**不允许降到静默**（最低 info），等第一个真实用例。

---

## 8. 校验怎么算

1. **装载**：按 `--root` 解析所有跨文档引用；`media-asset` 建表（id → src、sha256、kind、
   duration）；`.gen-log` 记录建表；演员表 `id` 列建集合。
2. **文件**：对每个 `media-asset`，文件存在则算 SHA-256 比对；有 ffprobe 且无 `duration`
   时读真实时长并用于后续校验（不写回文档；`check --write-duration` 可写回）。
3. **时间**：按 §5.2.1 算每个片段起止；范围、锚定、重叠、过渡各出诊断；同一台词块的配音片段与
   字幕片段配对比较。
4. **血缘**：以 `output` 为节点、`inputs[].ref` 与 `prompt` 为入边建 DAG（环 → error）。
   先**给每个素材定位它的当前记录**：同一 `output` 可能有多条记录（重生过），取
   `output-sha256` 等于该素材 `sha256=` 现值的那一条；一条都不匹配报
   `media-orphan-record`（info），匹配多条取 `at` 最新。只有当前记录参与过期判定——
   被取代的旧记录永远对不上现值，若也参与，一次重生之后它就会永远标黄。
   然后对当前记录：素材输入比 `sha256=` 现值；提示词或台词重新展开投射、算哈希比
   `prompt-sha256`，各投射源比 `prompt-refs[]`。任一不符 → 记录过期。**过期沿 DAG 向下
   传播**：过期素材作为输入的记录也过期（配音过期 → 口型合成过期）。最后对每个片段查它的
   `src` 是否是过期产出。
5. **剧本**：分镜表 `镜号` 列 ↔ `.prompt shot=` 双向钉合；`speaker=` 对演员表；`.look since=`
   对 `meta.episode`；`sum(时长)` 与实际总长各比 `target-duration`。

ffprobe、ffmpeg 都是**可选依赖**：没有它们，`check` 仍能做除真实时长之外的一切，并把
未校验的项说清楚（`media-duration-unknown`），而不是静默通过。

---

## 9. 待办：依赖核心的改动（不在 profile 内）

GEML 今天没有、而本设计需要的东西。**逐条标了是不是规范级**——第 1、2、5 条只动实现，
第 3、4 条动规范正文，第 6 条是 GEP 且现在不提。第 1 条是前置条件：它不落地，本 profile
的三个类型连拼写检查都没有。

1. **profile 类型的属性检查与投影声明**（前置，独立于 media 的价值）。**不动规范。**
   今天 `profiles.ts` 放行的类型，核心**一个属性都不检查**——`bodyModeFor` 在 profile 分支
   提前 return，跳过整段拼写检查。实测 `form-field {pattern="x" bogus-key=1 sinse=3}` 得到
   `ok: no diagnostics`。后果有二：`geml-form` 在 `profiles.ts` 里给 `form-field` 登记的六个
   键**今天完全空转**；`geml.ts` 里那条 `form-options` 的属性白名单分支**是死代码**
   （`form-options` 不在核心 `REGISTRY` 里，永远走不到）。
   改法是**按类型 opt-in**：profile 为某类型声明了 `attrs` ⇒ 该类型是闭集，查拼写；
   没声明 ⇒ 开集，不查。这样 `geml-style` 原样不动（它的属性空间是**故意开放**的——
   非内含词一律透传给宿主组件，核心不可能有它的词典），而 `form-field`、`history-*`、
   `media-*` 自动进检查。实测爆炸半径：`history-*` 用到的键与登记的完全一致，**零 warning**；
   `form-field` 实际用到 `type`/`label`/`placeholder`/`value`/`options`/`description` 等一批
   没登记的键——**词典残缺正是因为它从来没被执行过**，所以这条改动连带"补全 geml-form 的
   词典 + 把 `form-options` 那条死分支搬进 profile 条目 + 全库回归"。
   **同一条里还有第二件事：把"散文类型"变成可声明的。** 核心今天把 `text` 当特权类型，
   硬编码在三处，profile 类型一处也继承不到：

   | 位置 | 做什么 | 不改的后果 |
   |---|---|---|
   | `geml.ts` `projectableInlines`：`found.type !== "text"` | 行内投射的合法目标 | **`![[#hero-look]]` 直接报 `inline-transclusion-not-inline`**——本 profile 最核心的机制不工作 |
   | `to-md.ts`：`if (b.type === "text") return inner;` | 投成段落还是引用块 | 角色卡、提示词、台词在 `--to md` 里全变 `>` 开头 |
   | `render.ts`：`case "text"` → `<div class="text">` | html 里的标签与 class | 走默认分支 |

   实测过第一条：一个 profile 的 flow 类型作 `![[…]]` 的目标，`check` 直接给 error。
   所以加 `prose: ["media-text"]`，和一个三处共查的 `isProseType(type, vocab)` 谓词。
   `prose` **蕴含 `bodies=flow`**（散文类型必然装段落），不必声明两遍；`bodies` 留给
   非散文的 flow 容器（`form`/`form-group` 那种——它们是 flow，但不该能被行内投射、
   也不该渲染成段落），两个轴确实不同。在核心里再硬编码一个类型名，正是 `profiles.ts`
   开头那段注释反对的做法。
   **用词**：`prose` 这个词在代码里本来就是这么用的（`to-md.ts` 的注释：`text` is an
   addressable **prose** container）。`meta.tracks` 的种类 `prose` 与它同指一个概念，
   故意共用；而 `text` 此后在本 profile 里只剩"核心块类型"一个意思——`media-asset` 的
   `kind=text` 已经删掉（§5.1），轨道种类也从 `text` 改成了 `prose`。
2. **`geml get --resolved`。** **不动规范。** `get` 返回原文，投射标记原样留着；只有整篇
   `--to md` 才展开——实测 `geml get proj.geml '#s01-prompt'` 拿回的仍是 `![[#look]]`。
   给单个镜头出可发送的提示词需要按块展开，`prompt-sha256` 哈希的也正是展开后那串字。
   本 profile 不为此单开动词（§6.1）——那是给同一个能力起第二个名字；在核心落地之前，
   `media todo` 自己展开。
3. **`revert` 找回块的位置。** **不动规范。** 现在被删块复活时落在所在章节末尾。需要记住
   它原来的前后邻块（`.gemlhistory` 的逆向补丁里有这个信息），优先复位到原邻块之间，
   邻块都不在了再退回章节末尾。时间线里位置就是内容，这一条不改，剪辑用不了 `revert`。
4. **`view` 接受记录数组 `data` 块作 `src`。** **动规范**（`view` 的源域）。今天 `view` 只接
   `table`/`view`，错误消息就是 `view source #id is not a table or view`。但转换**核心里已经
   写好了**，只是今天只给 geml-chart 用：`recordsToTable()`——"键按首见顺序投成列，嵌套值
   投成紧凑 JSON 文本，投影喂给未改动的表机制"。它正好吃下生成日志的两个麻烦：记录字段
   不齐（`lipsync` 没有 `prompt`）取并集，`inputs` 数组压成一格。所以这条是**把已有函数
   从 chart 专用抬成公用**，不是新能力。
   （另一条路是给 `table` 加 `format=jsonl`。更贵——要在 `table.ts` 再写一份转换，
   让 jsonl 有两个家，而且 `data` 的树寻址 `#gen-log[8]["inputs"]` 会退化成一格 JSON 文本。
   走这条则两边都留着。）
5. **多值格的筛选：把它定义成"引用集"。** **动规范**（`=` 的语义）。`角色` 列 `#sister #hero`，
   `where="角色 = '#hero'"` 今天取不到这一行。核心拒绝 `*=` 是对的（§9.2 不让文档**文本**
   进模式语言），但 `#NAME` 是**引用**不是散文，所以有一条不违背它的路：
   > 一格的内容若整体是 ≥2 个空白分隔的 `#NAME` 记号，它是一个**引用集**；`=` 对引用集
   > 是成员判断。
   两条边界必须同时定：右值带空白时**报错**，不能静默退回整串相等（`角色 = '#sister #hero'`
   是诊断，不是"没匹配上"）；只认全称 `#`，`状态` 列的 `粗剪 剧本` 不走这条路，否则就
   真的是散文进了模式语言。比新增一个 `has` 算子小，而且是可扩展的一小块（将来
   `count(角色)` 也说得通），不是一次性算子。
6. **`schema=` 的校验。** **不动规范。** 规范把它留白。本 profile 对 `.gen-log` 自己校验；
   角色卡这类 `data` 块的字段完整性同样只能由应用层做，先不推核心。
7. **裸 `media` 类型与源路由的 `#t=`。** 这两项是 GEP 而不是小改，**现在不提**。提的
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
| `.gen-log` 记录：`output` `output-sha256` `model` `mode` `prompt` `prompt-sha256` `prompt-refs[]` `inputs[].{ref,sha256}` `at` | `params` 的约定键；`cost` |
| `media-text` 上的 `shot=` `speaker=` | `to=` `emotion=` `since=` 的取值形式 |
| meta：`tracks`（含"名字:种类"写法与三个种类）`primary` `fps` `target-duration` `episode` | `aspect` 的取值形式；`episodes`/`paywall` |
| `text` 种类的轨，`src` 指 `media-text` 块 | 平台版本的文件命名约定；分集目录的命名 |
| 诊断的**存在**与级别 | 诊断的消息措辞 |

---

## 11. v1 明确的非目标

- **不做 NLE。** 没有特效、调色、关键帧动画、变速曲线、多机位同步，没有混音的**包络与
  自动化**。这些是剪映、Resolve 的事，GEML 是它们之间的胶水，`export --to otio` 是出口。
  两样**已经有了**、不在非目标里：嵌套序列就是 `embed`（平台版拿它投射主剪的场，§4），
  基础混音就是 `gain` / `fade-in` / `fade-out`（§5.2）——把它们写成"不做"与正文自相矛盾，
  所以这里说清楚界限在**曲线**，不在功能本身。
- **不定义呈现层的几何。** overlay 摆在画面哪个角、字幕的字号描边，是样式表透传给宿主的
  参数（§5.5）。但**源画面的裁切是内容事实，已经收了**——`xywh`（W3C Media Fragments）
  说的是"从这张画面里取哪一块"，和 `in`/`out` 从时间轴上取一段是同一类事实，跟渲染器
  怎么排版无关。
- **不接任何一家生成器的 API。** `geml media log` / `import` 定义的是**记录形态**，
  适配脚本在仓库外。第一个适配器（ComfyUI 或即梦导出清单）是验证用例的一部分，
  不是 profile 的一部分。
- **不做审美规则。** 景别重复率、钩子密度、对白长度是编导的事，不是文档结构。
- **不做剧本格式。** 场景标题、动作描写、台词的排版是行业剧本格式（如 Fountain）的事；
  这里的 `.line` 只保证台词有地址、有说话人。
- **不做工作流引擎。** 没有队列、没有调度器、没有重试策略。runner 是 Dify、n8n、cron
  或一个 agent 的 skill；GEML 给它派生的任务清单、幂等的写入和零诊断的门（§6.3）。
- **不管文件本体。** `assets/` 怎么存、走不走 LFS、要不要去重，由项目定；GEML 只拿哈希。
  一句**非规范建议**（省得每个项目各撞一次）：生成物按 `<镜号>-<模型>-<seed>.<ext>` 命名，
  `assets/` 整个走 git-lfs 或干脆进 `.gitignore` 由对象存储托管，去重交给 `check`
  报的 `media-asset-unused` 加同哈希提示。这是建议不是要求，`check` 不据此报任何东西。

---

## 12. 测试策略

- **夹具用真文件。** `ffmpeg -f lavfi -i color=c=blue:s=64x64:d=1` 生成 1 秒小视频、
  `sine` 生成 1 秒音频、1×1 PNG——都几 KB，进 `test/fixtures/media/`，让哈希、时长、
  越界检查是真的而不是 mock。无 ffmpeg 的 CI 机器跳过真实时长用例并断言
  `media-duration-unknown` 出现。
- **每条诊断一个最小用例**，正例反例各一。过期传播单独一组：改台词一个字 → 台词哈希变
  → 配音记录过期 → 口型合成记录过期 → 用它的那片段标黄，断言链完整；改角色卡 → 三条
  提示词哈希变 → 关键帧、take 记录过期 → 四个片段标黄。
- **时间模型用表驱动**：给定片段序列与过渡，断言每个片段起止；含 `dissolve` 重叠、`fade`
  不重叠、`speed`、静图 `dur`、配音字幕配对。
- **样式表**：`geml style check` 对 §3.6 的样式表与时间线，0 error 0 warning，`--json`
  视图模型里每个 frame 的槽位数等于该轨片段数。
- **多集**：§3 的八份文档作为一组夹具；`season.geml` 三个 `view` 的输出逐格断言；
  `media-look-outdated` 用一份 `episode = 6` 仍投射 `#hero-look` 的剧本触发。
- **重生不留旧账**（`output-sha256`）：同一镜头生成两次，第二次覆盖素材的 `sha256=`，
  断言 `check` **干净**——旧记录不参与过期判定；再把两条记录的 `output-sha256` 都改成
  对不上现值，断言 `media-orphan-record`。这一组直接对应设计里最容易回归的一处。
- **轨道种类**：`tracks` 少写 `:种类` → `media-track-kind-missing`；写 `subtitle:caption` →
  `media-track-kind-unknown`；`gain=` 写在 video 轨、`in=` 写在 text 轨 →
  `media-attr-not-for-kind`；`text` 轨的 `src` 指 `media-asset` → `media-src-not-asset`。
- **`media-text` 是散文类型**：`![[#hero-look]]` 指向一个 `media-text` 块**不报**
  `inline-transclusion-not-inline`，且展开内容与指向核心 `text` 时逐字节相同；`--to md` 输出里
  角色卡与台词是**段落不是引用块**；同一份文档删掉 `profile=` 后退化成 raw，断言差异被
  说出来而不是静默。反例：一个只声明了 `bodies=flow`、没声明 `prose` 的 profile 类型，
  作 `![[…]]` 目标仍要报错——两个轴不能互相顶替。
- **动词往返**：`add` → `set --head` → `delete` → `revert` 后时间线可解析，且
  `history restore` 到任一修订与当时字节一致。
- **跨平台**：路径分隔符、CRLF 的 jsonl、Windows 上 ffprobe 缺失——既有约定。
- **95% 覆盖率门**照旧。

---

## 13. 待讨论的设计

GEML 今天没有、而且**不确定该不该有**的东西，各附倾向。

每条先标**加**还是**改**，因为两者的代价差一个量级：**加**＝将来是新增能力，已有文档照样
合法，留着不定是安全的；**改**＝将来会改变已有文档的写法或含义，**第一个真实用例写出来的
东西会作废**，所以必须现在定。下面标"已定"的几条就是从"改"里挑出来、当场拍掉的。

1. **投射不能按条件选源。** 第 5 集起外貌变了，每条提示词要手写 `#hero-look-2`；
   `![[#hero-look]]` 不会因为 `episode = 6` 就换源。今天靠 `since=` 加 `media-look-outdated`
   兜底。真正的解法是"带条件的投射"或"带版本的块"，两者都碰规范。倾向：**不做**，
   显式引用加一条 warning 已经够；等第二个需要条件投射的用例。
2. **跨文档聚合。** `view` 只接一个源，全季出场表、全季抽卡统计做不出来。三条路：
   `view` 接多个 `src`（并集）；一个 `union` 块；工具生成 CSV 再 `table {src=}`。倾向：
   先走第三条（`geml media report --kind`），它不碰规范；若并集需求在别的领域再出现
   （多仓库 codemap 已经有影子），再考虑前两条。
3. **对白的时间位置该不该自动。** `geml media lay` 按配音时长顺排是待办；但"开口前停
   半秒""两句叠一点"是表演，不是算法。倾向：工具给初值，人改，`check` 只管配音与字幕
   配对。
4. **`embed` 不能覆盖属性。** 平台版若要同一个片段在竖屏版用不同 `xywh` 裁切，`embed` 投射
   过来的片段改不了属性；只能在平台版里重写那个片段。
   **不动核心也能试。** `embed` 的属性键是可以被 profile 放行的，已有先例：`geml-translator`
   就在 `embed` 上放行了 `translate-to=`。所以 `geml-media/v1` 可以自己放行一个覆盖键，
   语义由 `media export` / `check` 解释，核心一个字不动：
   `=== embed {src=ep01-cut.geml#c03 media-xywh="0,0,1080,1920"}`。跑一季真片，数一下到底
   多少个片段要改。
   **要是将来真进核心，形状应该是"源头声明哪些属性可被覆盖"**（在被投射的块上标
   `inheritable="xywh"`），而不是"embed 想改什么就改什么"——前者保住"源头说了算"，
   后者把投射变成模板实例化，那是另一个特性。但它要用例数撑：`embed` 一旦能改被投射块，
   平台版里的 `#c03` 就不再是主剪的 `#c03`，同一个 id 两份内容，和"副本不存在"直接冲突。
   倾向：v1 先重写，其次 profile 内放行键，核心 GEP 排最后。
5. （改，弱）**多说话人口型的粒度。** 今天一条 `lipsync` 记录输入整条 take 加全部配音，输出一条。
   若工具按说话人分别处理，是两条记录两个中间产物还是一条记录 `params.speakers=2`，
   看第一个真实工具的形态。
6. （加）**`over=` 锚到非主轨**（字幕锚配音而非画面）。v1 禁，将来放开是纯增量。
7. **人物关系的变化按集筛。** `#relations` 的"变化"列是散文。要按集筛就得一行一次变化，
   表会长成事件日志——那时它也许该是 `data` 而不是 `table`，或者干脆是 `geml-story` 的事。
8. **NLE 回写。** 剪辑师在 Premiere 里挪了三个片段，要不要回到 `ep01-cut.geml`？做法只有
   一种说得通：`import --from otio` 生成时间线的**新版本**，`geml history` 显示与上一版的
   逐片段差异，人决定收不收。双向实时同步不做——两个真相源是这个项目反对的第一件事。
   倾向：P2 之后，等第一个真的把 OTIO 导进 NLE 的用户。
9. **模型卡由谁维护、放哪。** §6.3 把模型卡与路由表定为项目里的 `_index/providers.geml`。
   但模型卡的内容（上限、画幅、参考角色）对所有项目都一样，理应随适配器分发、项目只写
   路由。倾向：本仓库不收模型卡；适配器包各带自己的卡，`check --write-index` 合并到项目的
   `providers.geml`。密钥永远只在环境变量。
10. **自动预选 take。** 平台用视觉模型给 take 打分预选，人只看前几名。打分是一次"生成"：
    有输入（take）、有模型、没有产出文件。是否允许 `mode=qa` 的记录（`output: null`，
    `params.score`），让 `stats` 和预选都读它？倾向：允许，因为它不新增字段；但预选写成
    一个片段的动作仍由人或 agent 显式做，`check` 不自动改时间线。

---

## 14. 分期

**第一个真实用例排在词汇落地之前。** 理由是 §10 那句话：**此刻真实用例是零**。零用户的
情况下这份设计已经写出三个类型、五个属性键、四十来条诊断码和七个动词——其中至少八条
诊断是编导口味而不是文档的结构事实（`runtime-off-target`、`emotion-drift`、
`look-outdated`、`episode-mismatch`、`gen-before-approval`…）。先冻它们等于拿猜测当规范。
这个项目自己有过对照：`view` 是从 `table` 里长出来的，在 profile 里跑了两个月才进核心
（§9 第 7 条正是拿它作类比）。

- **P-1 前置：让 profile 类型成为一等公民**（§9 第 1 条）。不依赖 media，独立有价值。两件事：
  ① **属性检查按类型 opt-in**——让 `geml-form` 登记的键从空转变成生效、干掉 `form-options`
  那条死代码、并让此后任何 profile 的属性表被核心免费执行；
  ② **`prose` 声明与 `isProseType` 谓词**——把写死在三处的 `text` 特权（行内投射、md 段落
  投影、html 标签）换成可声明的。含补全 geml-form 词典与全库回归。
  **验收**：`form-field` 的错键被报出；`history-*` 全库仍是零 warning；`geml-style` 的透传
  参数一条都没被误报；一个声明了 `prose` 的 profile 类型可作 `![[…]]` 的目标、`--to md`
  投成段落；核心 `text` 的行为逐字节不变。
  **这一步单独一个 commit，不含任何 media 内容。**
- **P0 一集真片，只用今天的核心词汇 + 一份纯文档的 profile 说明。** 从剧本到出片走一遍，
  素材库、生成日志、时间线全部手写或用一次性脚本写，`check` 只有核心那一层。目的不是
  出片，是**让用例来选词汇**：哪些属性真的每天在写，哪些诊断真的救过场，哪些是我们坐在
  桌前想出来的。**验收**：一集成片；一份"实际用到 / 从没用到"的清单，逐条对照 §5 与 §7。
- **P1 词汇落地，按 P0 的清单裁剪。** `profiles.ts` 注册 `geml-media/v1`（三个类型、
  `media-text` 上五个键、`prose` 投影）；`spec/profiles/geml-media/` 两份 profile 文档；
  profile 的检查挂进核心 `geml check`（§6.1）；§12 的夹具与测试。**诊断码只落 P0 用过的那些**，
  编导口味的几条留在设计稿里不实现。**验收**：§3 的八份文档 `check` 干净（0 warning），
  故意改坏每一处各得到对应诊断。
- **P2 血缘、对白与预览。** `media log`、`media todo`、`media lay`、`export --to preview`；
  按 P0 观察到的实际调用面决定 MCP 暴露几条（§6.2）；
  agent 平台的 `geml-media` skill（§6.2 的循环）。**验收**：改台词一个字，`stale` 列出配音、
  口型合成与那个片段；改 `#hero-look` 一个字，列出全部四个片段，且消息点名是 `#hero-look` 变了
  （`prompt-refs`）；同一镜头重生两次后 `check` 仍干净（`output-sha256`）；浏览器里逐片段
  按 `#t=` 播放。
- **P3 出入口、全季与模型卡。** `media build`（ffmpeg）、`export --to otio|fcpxml|edl|srt`、
  `import`、`report --kind cast|stats`；`_index/providers.geml` 的模型卡与路由表进 `todo` 与 `check`。
  **验收**：导出的 OTIO 能进一款 NLE；ffmpeg 出片时长等于时间模型算出的总长；全季出场表
  CSV 引入 `season.geml` 后 `check` 干净。
- **P4 viewer。** `timeline-track` / `overlay-track` / `clip` 三个组件契约进 `geml-viewer`，
  §3.6 样式表渲染成可拖动的时间线；分镜板主从视图。
- §10 的左列在 P0 跑通之前不冻结。

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
