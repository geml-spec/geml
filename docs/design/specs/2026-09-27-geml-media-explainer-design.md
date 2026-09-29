# geml-media 讲解片 —— 一支用 geml-media 做出来的、讲 geml-media 的片子

- 日期：2026-09-27
- 状态：**第三版已完成**（2026-09-28），两版成片各 162 秒，待作者看片。前两版（讲 geml 概念的 S07；讲给个人创作者的「改需求」版）已作废，
  见下面的「前两版的教训」。
- 目标：出一支约 2 分 40 秒的动画讲解片，讲清「用 geml-media 做 AI 漫剧」这条管线；
  中英两版。
- **观众（第三版）**：**自建漫剧流水线的团队**——有技术 / 工程岗、用 AI Agent 或脚本把即梦、可灵、
  本地开源模型串起来的工作室。调研（「AI 漫剧制作痛点调研」文档）的结论：一站式平台已经把个人创作者的
  流程包了，geml-media 对他们是额外负担；自建流水线的团队则正在用飞书表格、`episode_scene_shot` 命名
  规则和手写的任务状态表，自己拼 geml-media 要提供的东西。
- **片子的主线（第三版）**：**从一页梗概开始，实打实做完一集能看的漫剧**（《重生之夜》第一集，
  `episode/`），并在片中完整播放它；「改需求」降为末尾的一个加分镜头。
- 前两版的教训：第一版满屏哈希卡片，作者看不懂在讲什么；第二版讲给个人创作者，只讲「改需求时一条命令
  告诉你哪些要重做」——作者看完指出它不是一个完整出片的过程，而且不确定这个痛点够不够疼。调研证实了
  这个怀疑。
- 与现有 demo 的关系：[`playground/geml-media-demo/`](../../../playground/geml-media-demo/README.md)
  是一条 10 秒的**漫剧样片**（素材是 ffmpeg 测试图）；本片是**讲解片**，放在新目录
  `playground/geml-media-explainer/`，共用词汇，不互相依赖。S10 的证据镜头会对那份 demo
  跑真实命令。

---

## 1. 已定的决定

| 决定 | 取舍 |
|---|---|
| 形态：代码生成的动画讲解片 | 不录屏、不用真实 AI 画面。可控、可重建；代价是不展示真实的生成器 |
| 自举：用 geml-media 做自己 | 最强的证据；顺带把 `build` / `log` / `check` / `todo` 在真实用例上压一遍 |
| 结构：沿漫剧作者的流程走 | 例子用仓库里现成的 demo《重生之夜》，观众看完可以 clone 下来照着跑；每一步画面配真实文档片段与真实 CLI 输出 |
| 片长约 2:30 | 流程六步之外，留 38 秒给「改需求」：改发型、改一刀、改一句台词 |
| 旁白：本地 TTS（macOS `say`）+ 字幕 | 把 narration 轨与 `over`/`offset` 锚定真正演出来 |
| 中英双版：画面带步骤标题，中英各渲一套镜头；两份 cut 共用一份素材库 | 见 §3 |
| 背景音乐：代码合成；最初计划用 Suno，作者不想付费 | 见 §5.2 |
| 漫剧画面：本机开源模型（Z-Image-Turbo）按 demo 的真实提示词出图；最初计划用即梦，作者不想付费 | 见 §4.5 |

## 2. 目录与文档模型

```
playground/geml-media-explainer/
  README.md
  concepts.geml        本片的立意 + 四个概念块（素材身份 / 引用 / 血缘 / 锚定）
                       —— 地位等同漫剧的角色卡，被每个镜头素材的 of= 指
  script.geml          分镜表（table）；每镜旁白，中英各一个 media-text .line；
                       配乐提示词一个 media-text .prompt
  library.geml         media-asset：14 个场景模块 #scene-sNN（role=workflow）、
                       4 份证据 #evidence-sNN（role=workflow）、14 段镜头 #shot-sNN
                       （role=take）、28 条旁白 #voice-sNN-zh|en（role=voice）、
                       1 首配乐 #bgm；data {#gen-log .gen-log format=jsonl}
  cut-zh.geml          中文版时间线 ┐ lay-cut.mjs 从剧本与素材库派生的整份产物，
  cut-en.geml          英文版时间线 ┘ 手改会被覆盖
  _index/index.geml    样式表
  scenes/              场景模块：stage.html + s01.js … s14.js
  evidence/            证据镜头用到的真实命令输出（由工具生成，不手写）
  assets/              shot-sNN-zh|en.mp4、voice-sNN-zh|en-K.m4a、art/、bgm.*
                       ——文件名带前缀，块 id 与文件名一眼对得上
  tools/
    render-scenes.mjs    场景模块 → 逐帧截图 → 每镜一个 mp4 → add/set + log
    make-voice.mjs       .line → say → AAC → add/set + log
    lay-cut.mjs          剧本 + 素材库 → cut-zh.geml / cut-en.geml
    capture-evidence.mjs 对真实夹具跑真实命令，把输出落进 evidence/
    check-timing.mjs     旁白不得超出所在镜头
    verify.mjs           §8 的全部检查
```

时间线：

```geml
==== media {#explainer tracks="video:video narration:audio music:audio subtitle:prose" primary=video fps=30}
```

主轨 `video` 顺排 14 个片段；`narration` 与 `subtitle` 的片段各自 `over=` 锚在对应镜头上；
`music` 一个片段锚在 S01 上铺满全片。

## 3. 双语：画面带标题，中英各渲一套

初稿主张「画面里不放散文」：视频素材只有一套，中英只换字幕与旁白，用片子自己的结构演
「内容与呈现分层」。**推翻了。** 观众是从没用过 GEML 的人，他要靠「① 角色卡」「改需求
的时候」这样的步骤标题才跟得上；而初稿担心的代价——视频素材翻倍——切片实测下来很小：
一套 1080p 镜头约 4MB，渲染约 4 分钟。

于是**每个场景模块渲两遍**：舞台页带 `lang=zh|en`，场景从一张两语的文案表里取字。产物是
`#shot-sNN-zh` 与 `#shot-sNN-en` 两个素材，**生成记录的输入是同一个 `#scene-sNN`**——改一处
场景代码，两个语言版一起过期，血缘照样成立。

画面上的**文档内容与 CLI 输出不翻译**：`characters.geml` 里写的就是「银灰短发齐耳」，
`geml media todo` 印的就是「生成 / 配音」。那是工具与数据真实的样子；英文版的标题与
字幕解释它们。

仍然是**两份 cut**：`export --to srt` 收**全部** prose 轨（`media-verbs.ts:320`），`build`
混**全部** audio 轨（`:426`），一份 cut 里放两套会出两条字幕叠在一起、两个旁白同时开口
（§10 #3）。现在两份 cut 的 video 轨也各指各的语言版镜头，就不再有「列表重复」的代价可说。

## 4. 画面

### 4.1 场景契约

每个镜头是一个**纯函数**，不是动画：

```js
export default {
  id: "s07",
  duration: 14,
  render(t, root) { /* 只读 t，写 DOM */ },
};
```

**禁止 CSS animation、transition 与 requestAnimationFrame。** 第 t 秒的画面只由 t 决定
——否则逐帧截图会漂，镜头也无法测试。缓动、插值由一个共享的 `scenes/lib.js` 提供
（`ease`、`lerp`、`stagger`、`typewriter(text, t, cps)`）。

`scenes/stage.html` 是唯一的页面：按 `?scene=s07&lang=zh` 载入模块，暴露
`window.__seek(t)`。画布 1920×1080，深色底，等宽字体渲染代码。

### 4.2 证据：画面上的 CLI 输出全是真的

镜头里出现的终端输出与文档片段**从 `evidence/*.txt` 读，不手写**。`capture-evidence.mjs`
在临时目录里复制 `playground/geml-media-demo`、做真实改动、跑真实命令，落下 stdout 与退出码：

| 镜头 | 命令 | 夹具上的改动 |
|---|---|---|
| S05 | `geml media todo . --root . --json` | 新加一条 `#s05-prompt`（嵌角色卡），它是唯一的待办 |
| S07 | `geml media todo . --root .` | 新加一句台词，没有配音记录 |
| S09 | `geml media build … --out ep01.mp4` 与 `export --to edl` | 无 |
| S10 | `geml check ep01/ep01-cut.geml --root .` | `#hero-look`：银灰短发齐耳 → 黑色长发及腰 |
| S11 | `geml media build …` 两次 + `ffprobe` | `#c01`：`out=4` → `out=2` |
| S12 | `geml check ep01/ep01-cut.geml --root .` | 改 `#s03-l1` 一个字 |

证据文本随渲染一起进血缘：它们是 `evidence` 素材（`kind=other role=workflow`），被对应
镜头的生成记录列为输入。demo 升级、输出变了，用到它的镜头就过期重渲。

### 4.3 渲染管线

`render-scenes.mjs`：

1. 拉起本机的 `chrome-headless-shell`（查找顺序：环境变量 `CHROME` →
   `~/Library/Caches/ms-playwright/chromium_headless_shell-*/…` →
   `~/.cache/ms-playwright/…` → `/Applications/Google Chrome.app --headless=new`）。
   都没有就明确报错退出，和 codemap 对 Joern 的处理一致。
2. 用 Node 24 的全局 `WebSocket` 直接讲 CDP——**零 npm 依赖**。每帧
   `Runtime.evaluate("__seek(t)")` + `Page.captureScreenshot`，PNG 序列落到临时目录。
3. `ffmpeg -framerate 30 -i %05d.png -c:v libx264 -crf 20 -pix_fmt yuv420p` 出
   `assets/shot-sNN.mp4`。全部镜头同分辨率同帧率——`buildPlan` 只做 trim + concat，不做
   缩放对齐。
4. 素材块一律由工具算好头行（`sha256`、`duration`、`kind`、`role`、`of`），**首次**
   `geml add --before '#gen'` 建块，**此后** `geml set '#shot-sNN' --head` 只换头行。
   **不用 `geml media import`**：它按文件名派生 id，同一路径的新字节会派生出同一个 id 而
   撞车（§10 #8）；它也不写 `role` / `of`，登记完还得再改一遍头行。
5. 再调 `geml media log library.geml --output '#shot-sNN' --model render-scenes
   --mode code2v --input '#scene-sNN' [--input '#evidence-sNN']`，追加一条记录。记录
   只追加，旧记录留着——它们就是这个镜头的渲染史。

**不手写素材块与生成记录。** 片子里演的那条流水线，就是造出这支片子的那条流水线。

### 4.4 场景模块本身也是素材

每个 `scenes/sNN.js` 以显式 id `#scene-sNN` 登记为 `media-asset {kind=other role=workflow}`，
带 `sha256`，同 §4.3 走 `add` / `set`。`render-scenes.mjs` 每次运行先把它的哈希刷成现值，
再问 `check` 哪些镜头过期——改过的模块此刻换了哈希，用它渲的镜头就报出来了。
镜头的生成记录把它列为输入。改了哪个场景的代码，`geml check` 就对哪个镜头报
`media-stale-generation`——既是片子的内容（S07 讲的就是这个），也是渲染时真正用来决定
「哪些镜头要重渲」的依据：`render-scenes.mjs` 默认只重渲过期的镜头，`--all` 全渲。

### 4.5 漫剧画面：本机开源模型出图

初稿让作者用即梦出图。作者不想为 demo 付费，于是改为在本机跑开源模型：通义 **Z-Image-Turbo**
（Apache-2.0，6B，中英双语）的 8-bit 量化版 `mflux-community/z-image-turbo-mflux-q8`，经 mflux（MIT）
在 Apple M4 上跑，720×1280，9 步，每张约 3 分钟，峰值内存 8.8GB。

- 中英双语让提示词块**原样可用**：`script.geml` 里七条 `#art-*-prompt` 就是喂给模型的那串中文，记录的
  `prompt-sha256` 记的也是它。
- 种子写死在 `tools/make-art.mjs`。v2（改需求后的黑发版）与 v1 同种子：提示词只差发型那几个字，构图
  与长相几乎不变——S10 演的正是这个对比。
- Turbo 版只有文生图，没有即梦那样的参考图功能；同一角色跨图的一致性靠同一段外貌描述与同一个种子。
  实测林岚的「栗色长卷发」画成了偏酒红的深色，S01 那张是闭着眼的（提示词写的是「从闭眼开始」）——
  这是模型对真实提示词的理解，不手修，记录与图保持一致。
- **16GB 内存的坑**：不带 `--low-ram`，系统大量换页，交换文件写在同一块盘上，可用空间从 18GB 掉到
  652MB。带上之后峰值 8.8GB、换页可控；出图脚本外另有一道「可用磁盘低于 2GB 就停」的保险。
- 场景通过素材库的 id 引用图片（`/_art.json`），场景代码一行没改；换图之后只有用到它的镜头过期重渲。
- 占位插画（`tools/make-placeholders.mjs`，代码画的扁平半身像）保留为没有 mflux 时的后备，它不会覆盖
  已经换进来的真图。

## 5. 声音

### 5.1 旁白

`make-voice.mjs` 读 `script.geml` 里的 `.line` 块（id 形如 `vo-s07-zh-1`；一镜可以有
几句，按序号排）：

- 中文 `say -v Tingting`，英文 `say -v Samantha`；本机无此声音时回落到同语言的第一个
  可用声音。**传给 `say` 的是完整名字**——「Eddy」与「Eddy (中文（中国大陆）)」是两个
  声音，前者读不了中文。实际用的声音记在生成记录的 `model` 里（`say-Tingting-zh_CN`）；
  `geml media log` 没有写 `params` 的参数，所以不记 `params.voice`。
- `say -o x.aiff` → `ffmpeg` 转 44.1kHz 单声道 AAC（`.m4a`，见 §11）。**读出来短于 0.2 秒就停下**：`say`
  碰到读不了的文字不报错，给一段几毫秒的空音频、退出码 0。
- 落成 `assets/voice-s07-zh-1.m4a`，同 §4.3 走 `add` / `set` 登记为 `#voice-s07-zh-1`
  （`role=voice`）；`geml media log --mode tts --prompt script.geml#vo-s07-zh-1 --root .`。
- 改了一句旁白的文字 → 该条 `media-stale-generation` → 重跑只重生成过期的那几条。

旁白与字幕由 `lay-cut.mjs` 按 §6 的规则排：每镜第一句 `offset=0.3`，句间隔 0.25 秒；
字幕同锚点、同 offset，`duration` 取旁白的实测时长。不用 `geml media lay`：它把同锚的
旁白与字幕当成先后排列，字幕会被排到旁白之后。

### 5.2 背景音乐：代码合成

初稿让作者用 Suno 生成。作者不想付费，也不想为此去找来源难核实的「免费」曲子（FreePD 原站 2025 年已
关，镜像站的授权无从核实；Pixabay 一类许可多半禁止原文件单独再分发，放进公开仓库有风险），于是改为
`tools/make-music.mjs` 用代码逐个采样合成：

- A 小调 i–VI–III–VII（Am F C G），80 BPM，一轮 4 小节 12 秒；垫音全程，琶音 12 秒起、低音 36 秒起、
  轻打击 60–122 秒，结尾只剩垫音淡出；152 秒，比全片多 2 秒给 `out=` 留余量。
- 随机部分用固定种子，AAC 带 `+bitexact`：同一份脚本永远生成同一串字节。
- 登记为 `#bgm {origin=generated role=take}`，生成记录 `model=make-music.mjs mode=code2a`，输入是登记为
  workflow 素材的脚本本身——改一个和弦，`check` 就说配乐过期。
- 时间线上一个片段锚在 S01 上铺满全片：`gain=-20dB fade-in=1 fade-out=3`。实测只有配乐的空档平均
  -36dB，旁白处平均 -21dB，配乐在旁白下约 15dB。

电平：`buildPlan` 的混音不支持闪避（旁白响起时自动压低配乐需要 sidechain），全片用固定的 `-20dB`。
见 §10。

## 6. 时间

**镜头时长是设计出来的定值**，写在 `script.geml` 的分镜表里；中英旁白都写来适配同一个
槽位。不让配音时长反推画面长度——否则中英两版画面不一样长，视频素材就得出两套，
§3 的前提就没了。

`check-timing.mjs`：任何一条旁白的 `offset + 实测时长` 超出所在镜头时长即失败。旁白
短了留静音，长了改词。

全片硬切，不用转场（原因见 §10）。

## 7. 分镜（第三版）

| # | 时长 | 画面 | 旁白要点 |
|---|---|---|---|
| **一 · 给谁看** ||||
| S01 | 12s | 飞书表格里的分镜脚本表（带 pending / running / success / failed）、按 `episode_scene_shot` 命名的素材目录、群里的追问 | 你也许已经用 Agent 串起了即梦和可灵；可分镜表、资产和进度还散在表格和文件夹里 |
| S02 | 8s | 这一集的四份文档 | 几份文本：Agent 读得懂，工具核得了 |
| **二 · 从零做一集** ||||
| S03 | 12s | `story.md` → 角色卡（三段外貌）+ 两张角色图 + 分镜表六镜 | 从一页梗概开始 |
| S04 | 12s | 三条镜头提示词（引用上色）；刚开工时真实的 `todo`：14 项 | 文档自己说出还差什么 |
| S05 | 16s | `todo --json` 的一项 → 真实的出图命令 → 登记的记录；八张图逐张出现，带各自的种子 | 每出一张就登记 |
| S06 | 12s | 六张关键帧按「运镜」动起来；六句台词与各自的声音；`todo: 没有待办` | 待办清零 |
| S07 | 12s | `cut.geml` 原文 + 由它算出的时间线（画面、配音、中英字幕、配乐） | 时间线也是文本 |
| S08 | 8s | 真实的 `build` 与 `check`；成片里真实的一帧 | 一条命令出片 |
| **三 · 成片** ||||
| S09 | 38s | **完整播放第一集**（36 秒，画中画，原片画质）；两侧写明每一样是怎么来的 | 无旁白，放那一集自己的声音 |
| **四 · 还能做什么** ||||
| S10 | 10s | 做到一半断了：`todo` 只剩后三张图与全部配音 | 重跑只做剩下的 |
| S11 | 10s | 改一句台词，`check` 点名的只有它的配音与用到配音的那一段 | 别的不动 |
| S12 | 12s | 源文件、上手命令、仓库地址，停在字标上 | 你刚看的这一集和这支片子，都是这么做出来的 |

合计 162 秒。

### 7.1 这一集是怎么做出来的

`episode/` 是一个独立的 geml-media 项目：`story.md`（输入）、`characters.geml`、`script.geml`、
`library.geml`、`cut.geml`、`assets/`。`tools/produce-episode.mjs` 是照着 `geml media todo` 干活的
Agent 循环——由 Claude Code 写出并运行：

1. **出图**：`todo --json` 的「生成」项已经带着展开好的提示词，交给本机 Z-Image-Turbo（种子写死），
   `geml media log` 登记。
2. **配音**：「配音」项按角色库的声音表挑声音（林夏 Tingting、林岚 Meijia、旁白 Reed），macOS `say`。
3. **运镜**：分镜表每一镜的「运镜」（推近 / 缓推 / 拉远 / 横移）→ ffmpeg `zoompan` 把关键帧做成一段
   视频 take，记成 `i2v`，输入是那张图——换了图，这一镜的 take 就过期。
4. **配乐**：`tools/make-music.mjs` 合成。
5. **剪辑**：按分镜表与配音时长派生 `cut.geml`；中英字幕是两条 prose 轨，锚在同一个镜头上。
6. **出片**：`geml media build`；本机 ffmpeg 没有 libass（§10 #1），双语字幕由浏览器画成透明图层，
   ffmpeg `overlay` 叠进画面。

每一步都只做过期或缺失的：中途断了重跑，已经做完的不再做——S10 演的正是这个。讲解片的证据全部对
这一集的副本跑真实命令得到（§4.2）；这一集的图、成片与成片音轨经 `tools/link-episode.mjs` 登记进
讲解片的素材库，所以这一集重做了，用到它的镜头就过期重渲。

## 8. 验证

`tools/verify.mjs` 依次跑，任一失败即非零退出：

1. `geml check cut-zh.geml --root .` 与 `cut-en.geml`：exit 0，零诊断。
2. 每个场景在 `t = 0 / duration/2 / duration − 1/30` 三点渲染：无 JS 异常；截图非纯色。
3. `check-timing.mjs` 全绿。
4. 两个成片：时间线模型给出的时长与 `ffprobe` 实测一致到 3 位小数（沿用现有 demo 的
   那条断言）；各有一条音频流；`.srt` 边车条目数等于该版字幕片段数。

**不进 CI。** CI 里装 chromium 与 macOS TTS 不值；`playground/` 本来也不在 CI 的测试
范围里。可重建性由「源文件与素材都进库、`check` 在 clone 下来的仓库上零诊断」保证。

## 9. 实施顺序

前两版留下的管线（场景契约、逐帧渲染、每镜两语、证据采集、旁白、配乐、派生时间线、`verify.mjs`）
全部沿用；第三版换的是内容与它的来源：

1. （已完成）`episode/`：`produce-episode.mjs` 从 `story.md` 做完第一集，`check` 零诊断、`todo` 为空、
   成片 36.000 秒、中英字幕六组。中途配音失败过一次，重跑没有重做任何一张图——这正是 S10 要讲的。
2. （已完成）`link-episode.mjs` 把那一集的图与成片登记进讲解片；`capture-evidence.mjs` 改为对那一集的
   副本跑真实命令（十五条证据）。
3. （已完成）十二个场景、四十句中英旁白；S09 的成片由渲染时的 ffmpeg overlay 叠进画面，声音走时间线上的
   `#ep-audio-s09`，配乐在 S09 前后分成两段。
4. （已完成）24 个镜头、两份时间线、`verify.mjs` 全绿；README。

## 10. 待办 —— 本次发现、本次不修

每一条都是 geml-media 的实现或规范与现实的落差，这支片子撞到了它们，但修它们不在
本片范围内。

| # | 落差 | 位置 | 本片如何绕开 |
|---|---|---|---|
| 1 | `--burn-subs` 依赖 ffmpeg 的 `subtitles` 滤镜（libass），Homebrew 默认的 ffmpeg 8.1 没有它，也没有 `drawtext`；README 承诺「ffmpeg 在 PATH 上」即可出片 | `media-verbs.ts` `buildPlan` · demo README | 画面上的字全部自己渲进帧里；字幕只出 `.srt` 边车 |
| 2 | `transition-in` / `transition-out` 是 profile 收的属性，但 `buildPlan` 只做 trim + concat，转场声明了不渲染，也不报诊断；player 导出只把它们原样挂成属性 | `media-verbs.ts:418` 起（`buildPlan`）、`:276`（player） | 全片硬切 |
| 3 | `export --to srt` 与 `build` 的混音不按轨过滤 | `media-verbs.ts:320`、`:426` | 两份 cut |
| 4 | `todo` 把所有提示词的模式硬编码为 `t2i` | `media-verbs.ts:136` | 配乐提示词会被错标为 `(t2i)`，接受 |
| 5 | `todo` 把库里所有 sheet/lora/master 挂成每条提示词的参考图，注释说按 `shot=` 过滤但代码没有 | `media-verbs.ts:129-135` | 本片没有 sheet，不触发 |
| 6 | 混音不支持闪避（sidechain ducking） | `buildPlan` | 配乐固定 `-20dB` |
| 7 | `build` 丢弃 `kind=image` 的片段，静图不能上主轨 | `media-verbs.ts:425` | 每个镜头都渲成 mp4 |
| 8 | `import` 没有「更新既有素材」的路径：同一路径的文件内容变了，会按文件名派生出同一个 id 新建块，与原块撞车。对「重新生成＝新 take」这件事它是对的（新字节就该是新素材），但对确定性的构建产物（重渲、重转码）它没有出口 | `media-verbs.ts:635-639` | 不用 import；`geml add` / `set` + `media log` |
| 9 | `geml media log --prompt <ref>` 在引用落到 root 之外时**静默**不写 `prompt-sha256`，那条记录的提示词血缘从此不可校验 | `cli.ts:618` 附近 | 工具每次都带 `--root .` |
| 10 | `geml media log` 不写 `prompt-refs`：CLI 记下的记录，过期时只能说「提示词」变了，说不出是哪个投射源（demo 里手写的记录能说出「投射源 `#hero-look`」） | `cli.ts` 的 `media log` | 接受；`prompt-sha256` 覆盖展开后的文本，过期照样判得出 |
| 11 | `geml media` 的动词只收一个入口，多给的位置参数**静默忽略**：`todo script.geml library.geml` 看起来查了两份，实际只查了剧本——而从剧本出发看不见素材库里的记录，于是每句已配音的台词都被列成待办 | `cli.ts` 的 `mediaEntry` | 给目录：`todo .`（CLI 注释里写明了这是正确用法，缺的是对多余参数的拒绝） |
| 12 | `geml media todo` 的纯文本输出只有地址与模式，**不印展开后的提示词**——而对漫剧作者，那串能直接粘进即梦的文字正是 `todo` 最有用的产出；要看得加 `--json` | `cli.ts` 的 `todo` 分支 | S05 画面用 `--json` 取文字，另行排版 |
| 13 | `geml media build` 报告字幕文件时只印文件名（`wrote ep01.srt`），而它写在 `--out` 的目录里（`out/ep01.srt`）；同一段输出的下一行又印了完整的相对路径 `wrote out/ep01.mp4`，照着找会找错地方 | `cli.ts` 的 `build` 分支（`basename(srtPath)`） | 接受；S08 画面照录真实输出 |

## 11. 待讨论

| 问题 | 倾向 |
|---|---|
| 屏幕上要不要有大字标题与金句 | **已定：要**（§3）。步骤标题与短标签，中英各一套 |
| 两个成片 mp4 放哪 | **GitHub release 附件，不进仓库。** 与现有 demo「出片产物不进库」一致；README 链过去。发布是对外动作，届时单独确认 |
| 镜头与旁白进不进库 | **进。** 否则 clone 下来 `check` 报 `media-file-missing`。切片实测：S07 14 秒 1080p crf 20 为 431KB，按比例全片视频约 4.2MB——保持 1080p |
| 旁白用什么容器 | **已定：AAC（`.m4a`）。** 全片 50 句 wav 实测 20MB，是全部镜头（11MB）的近两倍；AAC 96k 为 2.9MB。编码带 `+bitexact` 并去掉元数据，同一段输入永远编出同一串字节，哈希照样是身份。注意：此前的提交里带过 wav，分支历史仍含那 20MB——合并时用 squash，`main` 只拿到最终的 m4a |
| 那一集的成片进不进库 | **进（6MB）。** 讲解片的 `#ep-final` 指向 `episode/out/ep01.mp4`，S09 播放它；不进库则 clone 下来 `check` 报缺文件。中间产物 `ep01-raw.*` 不进库 |
| 公共件变了镜头不过期 | `#scene-sNN` 只登记 `scenes/sNN.js`；`lib.js` / `kit.js` / `acts.js` 与舞台页改了，`check` 不说任何镜头过期，要 `render-scenes --all`。**倾向：**把公共件也登记成 `workflow` 素材、列进每镜的输入——代价是改一处部件全片 24 镜都重渲，而这正是事实 |
| 竖屏版 | **不做。** 讲解片面向 GitHub 与开发者；漫剧本身是竖屏，但这支不是漫剧 |

## 12. 非目标

- 不改解析器（§10 的每一条都另起）。
- 不接任何在线生成服务、不用任何付费模型：画面本机开源模型出，配乐代码合成，声音用系统 TTS。
- 不做竖屏版、不做字幕烧录版。
