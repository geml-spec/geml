# geml-media/v1 演示：一份时间线就是一条能播的成片

四份文档、六个素材，一条 10 秒的竖屏粗剪。**双击 `play.html` 就能看**——画面按时间
切，配音落在第 4.4 秒，字幕跟着配音出现。

```
characters.geml           角色卡（外观、关系）——被剧本的 speaker= 指
ep01/ep01-script.geml     剧本：分镜表、提示词、台词（media-text）
ep01/ep01-library.geml    素材库：每个文件一个 media-asset + 生成日志
ep01/ep01-cut.geml        时间线：每一刀一个 media-clip
ep01/assets/              素材文件（合成的测试素材，不是真片子）
```

> 和 `playground/geml-media-ep01/` 的关系：那一份用**核心词汇**（`data` 块）写同一集，
> 记录的是"不加 profile 能走多远"；这一份是 `geml-media/v1` 的写法。两份都留着，因为
> 对照本身就是设计记录的一部分。

## 时间是怎么定的

主轨（`video`）顺排，其余轨锚在主轨的某一刀上：

```geml
=== media-clip {#c01 track=video src=ep01-library.geml#s01-take3 in=0 out=4}
=== media-clip {#c03 track=video src=ep01-library.geml#s03-take2-lips in=0 out=6}
=== media-clip {#vo-s03-l1 track=dialogue src=ep01-library.geml#s03-l1-vo over=#c03 offset=0.4 gain=0dB}
=== media-clip {#sub-s03-l1 track=subtitle src=ep01-script.geml#s03-l1 over=#c03 offset=0.4 dur=2.1}
```

配音写的是「压在 `#c03` 上、晚 0.4 秒」，不是「第 4.4 秒」。主轨插一刀，配音和字幕
跟着走。绝对时间只有 `at=` 一个逃生口。

## 三条命令

```bash
geml check ep01/ep01-cut.geml --root .          # 引用、哈希、时间，一起查
geml media export ep01/ep01-cut.geml --to srt   # 也能出 edl / otio / json
geml media build  ep01/ep01-cut.geml --out ep01.mp4   # 要 ffmpeg 在 PATH 上
```

`build` 出来的 `ep01.mp4` 和 `play.html` 里播的是**同一条时间线**——浏览器和 ffmpeg
共用 `layoutDoc`，所以模型说 10.00 秒，ffprobe 量出来就是 10.000000 秒。

## play.html 是生成的

```bash
node ../../integrations/geml-viewer/tools/media-page.mjs . ep01/ep01-cut.geml
```

跑的是扩展里那套 `renderPage` + 组件，所以它同时是 viewer 的一张实景样片。
**它把 `geml.css` 和播放器时钟的源码内联了进去**：改了 viewer 就得重跑这条命令，
否则这个文件会静静地停在旧版本上。

出片和生成的页面都不进版本库（`ep01.mp4` / `ep01.srt` 由 `build` 产出），素材文件
进——它们是合成的小文件，没有它们这份 demo 打开就是黑屏。
