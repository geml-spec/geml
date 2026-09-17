# geml-media/v1 演示：从一份文档到一条成片

一条 10 秒的竖屏粗剪，四份文档、六个素材。

**下面每条命令都在 `playground/geml-media-demo/` 里跑**，从仓库根目录开始就是：

```bash
cd playground/geml-media-demo
```

## 最快出片

**前置**：`ffmpeg` 和 `ffprobe` 在 PATH 上（出片、读素材时长都要它）。
命令行 `geml` 来自 `npm i -g @geml/geml`；在本仓库里也可以用
`node ../../geml-parser/dist/cli.js` 代替下面所有的 `geml`。

```bash
geml media build ep01/ep01-cut.geml --out ep01.mp4 --root . --burn-subs
```

完。`ep01.mp4` 就在目录里，10.00 秒，字幕烧在画面上。

去掉 `--burn-subs` 就不烧字——字幕另出成 `ep01.srt` 放在成片旁边。**默认是不烧的**：
一份剪辑是文档，字幕是它的一条轨，烧进像素是交付时的选择，烧了就再也拆不开，
而边车字幕谁都能关掉。要换字体加 `--font '思源黑体'`。

`--root .` 不能省：剧本里的 `speaker=../characters.geml#sister` 指到了 `ep01/` 上面
一层，没有它那条引用解析不出来。

## 先在浏览器里看

不编码、秒开、能拖进度条：

```bash
node ../../integrations/geml-viewer/tools/media-page.mjs . ep01/ep01-cut.geml
```

写出 `play.html`，双击就是这条片子的播放面：画面按时间切，配音落在第 4.4 秒，
字幕跟着配音出现。它和 `build` 读的是**同一条时间线**，所以浏览器里看到的和
ffmpeg 出的是一回事——模型说 10.00 秒，ffprobe 量出来就是 10.000000 秒。

只想逐刀检查素材（每刀一个独立小播放器，零依赖）：

```bash
geml media export ep01/ep01-cut.geml --to preview --root . -o contact.html
```

## 改一刀试试

把 `ep01/ep01-cut.geml` 里 `#c01` 的 `out=4` 改成 `out=2`，然后：

```bash
geml check ep01/ep01-cut.geml --root .    # 引用、哈希、时间，一起查
geml media build ep01/ep01-cut.geml --out ep01.mp4 --root . --burn-subs
```

片子短了 2 秒，而且**配音和字幕自动跟着往前挪**——因为它们写的是"压在 `#c03` 上、
晚 0.4 秒"，不是"第 4.4 秒"。

## 目录里是什么

```
characters.geml           角色卡（外观、关系）——被剧本的 speaker= 指
ep01/ep01-script.geml     剧本：分镜表、提示词、台词（media-text）
ep01/ep01-library.geml    素材库：每个文件一个 media-asset + 生成日志
ep01/ep01-cut.geml        时间线：每一刀一个 media-clip
ep01/_index/index.geml    样式表：装了 viewer 扩展时，打开上面任一份文档用哪套呈现
ep01/assets/              素材文件：ffmpeg 合成的测试图，不是真片子
tools/make-assets.mjs     重新生成那六个素材
```

## 时间是怎么定的

主轨（`video`）顺排，其余轨锚在主轨的某一刀上：

```geml
=== media-clip {#c01 track=video src=ep01-library.geml#s01-take3 in=0 out=4}
=== media-clip {#c03 track=video src=ep01-library.geml#s03-take2-lips in=0 out=6}
=== media-clip {#vo-s03-l1 track=dialogue src=ep01-library.geml#s03-l1-vo over=#c03 offset=0.4 gain=0dB}
=== media-clip {#sub-s03-l1 track=subtitle src=ep01-script.geml#s03-l1 over=#c03 offset=0.4 duration=2.1}
```

绝对时间只有 `at=` 一个逃生口，别的都是锚定。

## 素材是合成的

六个素材是 ffmpeg 的测试图（`testsrc` / `testsrc2`），画面左上角**自带走时码**——
和播放器走带上的读数可以对着看，时间对不对一眼能验。配音是一段能听见的颤音。
重新生成：

```bash
node tools/make-assets.mjs            # ffmpeg/ffprobe 在 PATH 上
FFMPEG=/path/to/ffmpeg node tools/make-assets.mjs   # 或者指给它
```

它会把素材库里的 `sha256`、`duration`，以及生成日志里每条记录的 `output-sha256` 和
`inputs` 的哈希一起更新。**不更新的话 `check` 会说这份字节来历不明、下游全过期——
而它说得对**，那正是这套血缘检查存在的理由。

## 哪些进版本库

四份 `.geml`、六个素材、`play.html` 和 `tools/` 进；出片产物（`ep01*.mp4`、`ep01*.srt`）
不进，它们由 `build` 产出。

`play.html` 是生成的，而且**内联了 `geml.css` 和播放器时钟的源码**：改了 viewer 要重跑
上面那条 `media-page.mjs`，否则这个文件会静静地停在旧版本上。
