# geml-media 讲解片

一支 2 分 42 秒、中英两版的讲解片：给**自建管线的漫剧团队、用 AI 助手（Agent）干活的人**看，
一个 Agent 怎么照着几份文本文件，从一段故事梗概开始**真的做完一集**。片子里播放那一集的成片；
改需求只作为结尾的彩蛋。

它**自己也是用 geml-media 做的**——每个镜头是一个 `media-asset`，时间线是 `media-clip`，
旁白、配乐、画面都带生成记录，成片由 `geml media build` 出。

设计：[`docs/design/specs/2026-09-27-geml-media-explainer-design.md`](../../docs/design/specs/2026-09-27-geml-media-explainer-design.md)。

## 片子讲什么

| 幕 | 镜头 |
|---|---|
| 一 · 你现在的样子 | S01 飞书表格 + 命名规范 + 群里对进度 · S02 换成四份文本 |
| 二 · 从零做一集 | S03 梗概 → 角色卡与分镜表 · S04 提示词与待办 · S05 出图 · S06 运镜与配音 · S07 剪辑 · S08 出片与检查 |
| 三 · 成片 | S09 播放第一集《重生之夜》（36 秒，中英字幕） |
| 四 · 之后 | S10 断了接着做 · S11 改一句台词 · S12 开始用 |

## 那一集怎么做出来的

`episode/` 是一集真实的漫剧工程，**全部由 `tools/produce-episode.mjs` 从 `story.md` 做出来**：

| 文件 | 是什么 |
|---|---|
| `story.md` | 故事梗概（输入） |
| `characters.geml` | 角色卡：外貌（look 块，被提示词嵌入）与声音表 |
| `script.geml` | 分镜表、每镜的提示词、台词与英文翻译 |
| `library.geml` | 素材与生成日志 |
| `cut.geml` | 时间线（派生） |
| `assets/` | 两张角色图、三张场景母版、七张立绘（纯色背景的原图与抠好的各一）、六张合成的关键帧、六段运镜视频、六段配音、配乐 |

`produce-episode.mjs` 就是一个照着 `geml media todo` 干活的循环：问文档还差什么 → 做 → `geml media log`
记下来 → 再问。出图、抠像、合成、运镜、配音、配乐、剪辑、出片八步，每步只做差的那部分，中途断了重跑
不会重做已经做完的。成片 `episode/out/ep01.mp4` 进库（讲解片的 S09 播放它），中间产物不进库。

**画面是分层拼的，不是每镜出一张整图**（设计记录 §16）：场景各出一张无人的母版，每个「角色 × 姿势」出
一张纯色背景的立绘并抠成带 alpha 的图；剧本里每镜一个 `media-comp` 写明哪几层、摆在哪、母版裁哪一块当
机位；`geml media compose` 用 ffmpeg 确定性地叠成关键帧，同一份文档永远出同一串字节。于是 s03 / s05 /
s06 里的林夏是同一张脸、s03–s06 是同一个房间，靠构造而不是靠运气；改她的风衣颜色只重出她的立绘和用到
它们的镜头，挪一个站位只重合成那一镜，零次出图。

**递碗是一条连接，不是一张合画的图**（设计记录 §16.8）：s05 里那碗汤是单独出图、单独抠的一层
（`role=prop`），林岚是一张空手托举的立绘；素材上标了点（她的手心、碗的底），角色库上声明了点的名字，
comp 里一条 `media-interaction {a=#s05-sister:hand b=#s05-bowl:base kind=contact}` 把碗放到她手上——碗的
坐标不是人填的，是解出来的；把林岚挪 50 像素，碗跟着走，`check` 只说 s05 要重做（`evidence/ep-handoff.txt`）。

## 画面、声音从哪来

**全部免费、本机、不用任何账号。**

- **漫剧画面**：通义的开源模型 **Z-Image-Turbo**（Apache-2.0，中英双语）的 8-bit 量化版
  `mflux-community/z-image-turbo-mflux-q8`，经 [mflux](https://pypi.org/project/mflux/)（MIT）在
  Apple Silicon 上出图。提示词是 `geml media todo --json` 展开好的原文（角色外貌已经嵌进去），种子写死在
  `produce-episode.mjs` 的 `SEEDS` 里——同模型、同字、同种子，出同一张图。
- **立绘与合成**：立绘在纯色背景上出图，ffmpeg 的 `colorkey` 按原图角落的颜色抠成透明（键色、容差记在
  记录的 `params` 里；以后换抠图模型只换这一步）；`geml media compose` 按剧本里的 comp 叠成关键帧，
  `--log` 把各层登记成输入。
- **运镜**：ffmpeg 的 zoompan 把关键帧推、拉、移成一段视频，记成 `i2v`，输入是那张图。
- **配音与旁白**：macOS 自带的 `say`（林夏 Tingting、林岚 Meijia、旁白 Reed；讲解片旁白 Tingting / Samantha）。
- **配乐**：`tools/make-music.mjs` 用代码逐个采样合成，固定种子，同一份脚本永远生成同一串字节。
- **双语字幕**：本机的 ffmpeg 没有 libass / drawtext，字幕层由浏览器画成透明视频再叠上去。

出图的前置（一次）：

```bash
uv tool install mflux==0.20.0      # 约 1.5GB 依赖；第一次出图会下载约 11GB 模型
```

16GB 内存的机器上必须带 `--low-ram`（脚本已经带了）：不带的话 q8 会把系统推进大量换页，交换文件写在
同一块盘上——实测把 18GB 可用空间吃到只剩 652MB。每张图约 3 分钟。

## 从源重建

前置：Node 24、ffmpeg / ffprobe、macOS（`say`）、一个 Chromium（Playwright 缓存里的
`chrome-headless-shell`，或系统 Chrome，或 `CHROME=` 指过去）。仓库根先
`cd geml-parser && npm ci && npm run build`。下面的命令都在本目录跑。

```bash
node tools/produce-episode.mjs     # 那一集：从梗概做到成片 → episode/out/ep01.mp4
node tools/link-episode.mjs        # 把那一集的图与成片登记进讲解片的素材库
node tools/capture-evidence.mjs    # 证据：对那一集的副本跑真实命令
node tools/make-music.mjs          # 讲解片配乐
node tools/make-voice.mjs          # 讲解片旁白：只做过期的
node tools/render-scenes.mjs       # 镜头：只渲 check 说过期的；--all 全渲
node tools/lay-cut.mjs             # 派生 cut-zh.geml / cut-en.geml
node tools/verify.mjs              # check 零诊断、旁白不超镜头、出片并校时 → out/
```

每一步都只重做过期的东西，判断依据是 `geml check`：那一集、场景代码、证据、台词、配乐脚本，谁变了，
谁的下游就过期。全渲一遍约 15 分钟（每镜 × 两种语言，逐帧截图）。

成片在 `out/explainer-zh.mp4` / `out/explainer-en.mp4`，字幕另出 `.srt`。`out/` 不进库。

## 调画面

预览一个镜头（底部可拖）：

```bash
node -e 'import("./tools/lib/server.mjs").then(m => m.startServer(".", 8765))'
```

浏览器打开 `http://127.0.0.1:8765/scenes/stage.html?scene=s05&lang=zh&preview=1&d=16`。

截几帧看：

```bash
node tools/snap.mjs /tmp/frames s05:zh:9.5 s05:en:9.5
```

场景是 `render(t, root, { lang })` 的纯函数：**第 t 秒的画面只由 t 决定**，没有 CSS 动画、没有
`requestAnimationFrame`，文字没变不碰 DOM——否则逐帧截图会漂。`tools/test/scenes.test.mjs` 对每个镜头、
每种语言检查：三个时刻渲染无异常、非空白、同一 t 截两次逐字节相同、从头到尾会动。

S09 的成片不是逐帧截图画的：场景声明 `export const overlay = { src, at, x, y, w, h }`，渲染时由 ffmpeg
把成片叠进画面里那块位置，声音走时间线上的 `#ep-audio-s09`。截帧时那一块是黑的。

## 文档与目录

| 文件 | 是什么 |
|---|---|
| `concepts.geml` | 立意、旁白（说话人）、几个概念（镜头素材的 `of=`） |
| `script.geml` | 分镜表、中英旁白 |
| `library.geml` | 全部素材与生成日志 —— 由 `tools/` 经 geml CLI 维护，别手改头行 |
| `cut-zh.geml`、`cut-en.geml` | 时间线 —— `lay-cut.mjs` 的产物，别手改 |
| `episode/` | 第一集《重生之夜》，见上 |
| `scenes/` | `stage.html` 舞台页；`lib.js` / `kit.js` / `acts.js` 公共件；`sNN.js` 每镜一个场景 |
| `evidence/` | 真实命令的输出 |
| `assets/` | 镜头 mp4、旁白 m4a（AAC）、配乐 `bgm.m4a`、从成片抽出的音轨与一帧 |
| `tools/` | 上面那些命令；`tools/test/` 是 `node --test "tools/test/*.test.mjs"` |

素材库里的血缘：镜头 `#shot-s05-zh` 的生成记录以 `#scene-s05`（场景代码）、它读的证据 `#evidence-ep-*`
与它画到的 `#ep-*` 图为输入；`#ep-*` 指向 `episode/assets/` 里的原文件。那一集重做了、图的哈希变了，
画到它的镜头就过期重渲。

## 测试

```bash
node --test "tools/test/*.test.mjs"
```

没有 Chromium 的机器上，涉及浏览器的用例会跳过；其余照跑。不进 CI（要 Chromium、macOS TTS 与本机模型）。
