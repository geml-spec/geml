# geml-translator 使用指南

> **状态** draft · **声明** `profile = "geml-translator/v1"` · **限制** 只有 viewer 会翻译，CLI 不翻译

## 它做什么

用这个 profile 写的译文里没有一句译好的文字：它嵌入源文档，写明要哪种语言，打开时由 viewer 当场翻译。什么都没有抄过来，所以译文不会落后于源文档。读到的是当场生成的机器翻译，不是审校过的译稿。

## 上手

先装 CLI：`npm i -g @geml/geml`（Node 22+）。在同一个文件夹里放两个文件。源文档 `hello.geml`：

```geml
=== meta
title = "Hello"
===

## Start {#start}

GEML keeps one source of truth.

## Install {#install}

Run `npm i -g @geml/geml`.
```

译文 `hello_CN.geml`：

```geml
=== meta
title        = "你好"
profile      = "geml-translator/v1"
translate-to = "zh-cn"
===

=== embed {src=hello.geml}
===
```

`geml check hello_CN.geml` 输出 `ok: no diagnostics`。

想看翻译效果：在桌面版 Chrome 里装上 [GEML Viewer](https://chromewebstore.google.com/detail/opmhfphgoidpnipphfgkhhjhmnmaenie)浏览器扩展，在扩展详情里打开「允许访问文件网址」，再打开 `hello_CN.geml`。页面先显示英文，等 Chrome 内置的翻译器返回结果后换成中文；标题旁的「原文」按钮可以切回源文。Chrome 里还没有这对语言的模型时，页面会给出一个下载按钮。

## 常用

**某一部分保留原文。** 把唯一的那个 embed 拆成每个单元一个，在要保留的那个上写 `translate-to=none`。`geml list hello.geml` 会列出各单元和它们的行号范围，对一下就知道有没有漏（参考文档 §4）。

```geml
=== embed {src=hello.geml#start}
===

=== embed {src=hello.geml#install translate-to=none}
===
```

**固定某个词的译法。** 在 meta 里加 `glossary = "#terms"`，再放一张隐藏的词表（参考文档 §6）：

```geml
=== table {#terms hidden}
| term | zh-cn |
|---|---|
| source of truth | 事实来源 |
===
```

**源文档改了会报错。** 把 `hello.geml` 里的 `#install` 改个名字，`geml check hello_CN.geml` 就会对 `hello.geml#install` 报 `error: unresolved reference`。

**存一份译好的副本。** `geml hello_CN.geml --to md` 只会写出原文，并在 stderr 里说明 `translate-to=zh-cn` 没有生效。要留下中文，点 viewer 里的 **Export snapshot**，它把页面上显示的内容存成 Markdown。

**延伸：** [参考文档](geml-translator-profile_CN.md) · [图解](https://geml-spec.github.io/illustrated/11-profile-translator_CN.html)
