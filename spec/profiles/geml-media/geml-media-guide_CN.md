# geml-media 使用指南

> **状态** draft · **声明** `profile = "geml-media/v1"` · **限制** `geml media build` 要装 ffmpeg

## 它做什么

geml-media 把一条剪辑写成一份文档：每个文件是一个带哈希的 `media-asset` 块，每一刀是一个 `media-clip`，指向某个文件里的一段；字幕、提示词、台词都是 `media-text` 块。做 AI 生成视频时，它还记下每一次生成，某个输入一改，`geml check` 就能指出哪些镜头得重做。它不调用任何生成模型，也不是剪辑软件。

## 上手

把下面这段存成 `hello.geml`。不需要任何媒体文件，它只有一条文字轨。

```geml
=== meta
title = "你好，时间轴"
profile = "geml-media/v1"
===

==== media {#cut tracks="subtitle:prose"}

=== media-clip {#c1 track=subtitle src=#l1 duration=2}
===

=== media-clip {#c2 track=subtitle src=#l2 duration=3}
===

====

=== media-text {#l1}
你好。
===

=== media-text {#l2}
这一句接在上一句后面。
===
```

先检查，再导出成播放页：

```bash
geml check hello.geml
geml media export hello.geml --to player -o play.html
```

`check` 输出 `ok: no diagnostics`。用浏览器打开 `play.html`，点播放：「你好。」显示两秒，接着第二句一直显示到 0:05。第二句为什么从 0:02 开始，见[参考文档](geml-media-profile_CN.md) §3.2「时间模型」。`geml hello.geml --to html` 不画时间轴，要看效果请用 `geml media export`。

## 常用

**导入文件。** `import` 会加一个 `media-asset` 块，记下文件的 `sha256`；PATH 上有 `ffprobe` 时还会写上 `duration`。`library.geml` 要先建好，并声明 profile。

```bash
geml media import shot.mp4 --into library.geml
```

**放上时间轴。** 把 `hello.geml` 里的 `media` 块换成下面这段。第一条轨换成了视频，字幕用 `over=` 锚在这一刀上（同样见 §3.2）。

```geml
==== media {#cut tracks="video:video subtitle:prose"}

=== media-clip {#v1 track=video src=library.geml#shot in=0 out=4}
===

=== media-clip {#c1 track=subtitle src=#l1 over=#v1 duration=2}
===

====
```

**出片。** 字幕另存为旁边的 `hello.srt`；加 `--burn-subs` 就烧进画面。

```bash
geml media build hello.geml --out hello.mp4
```

这一整套 agent 可以自己跑：`geml media todo hello.geml --json` 列出还没产出的提示词和还没配音的台词，`geml media log` 把做好的东西记进素材库的生成日志（§6），提示词改过之后，`geml check` 会指出哪些片段已经过期（§8）。

**延伸：** [参考文档](geml-media-profile_CN.md) · [演示](https://geml-spec.github.io/demos/media-cut)
