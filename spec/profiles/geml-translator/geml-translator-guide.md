# geml-translator guide

> **Status** draft · **Declare** `profile = "geml-translator/v1"` · **Limits** only a viewer translates, not the CLI

## What it does

A translation written with this profile holds no translated text. It embeds the source and names the language it wants; a viewer translates when you open it. Nothing is copied, so the translation cannot fall behind the source. What you read is machine translation made on the spot, not a reviewed text.

## Try it

Install the CLI with `npm i -g @geml/geml` (Node 22+). Put two files in one folder. The source, `hello.geml`:

```geml
=== meta
title = "Hello"
===

## Start {#start}

GEML keeps one source of truth.

## Install {#install}

Run `npm i -g @geml/geml`.
```

The translation, `hello_CN.geml`:

```geml
=== meta
title        = "你好"
profile      = "geml-translator/v1"
translate-to = "zh-cn"
===

=== embed {src=hello.geml}
===
```

`geml check hello_CN.geml` prints `ok: no diagnostics`.

To see it translated, install the [GEML Viewer](https://chromewebstore.google.com/detail/opmhfphgoidpnipphfgkhhjhmnmaenie) in desktop Chrome, turn on **Allow access to file URLs** in its details, and open `hello_CN.geml`. The English shows first and turns into Chinese when Chrome's built-in translator answers; the 原文 button on the heading shows the source again. If Chrome does not have the language model yet, the page offers a button to download it.

## Everyday use

**Keep one part in the source language.** Replace the single embed with one per unit and put `translate-to=none` on the one to keep. `geml list hello.geml` prints the units with their line ranges, so you can see nothing is left out (reference §4).

```geml
=== embed {src=hello.geml#start}
===

=== embed {src=hello.geml#install translate-to=none}
===
```

**Fix how a term is translated.** Add `glossary = "#terms"` to the meta and a hidden table of settled terms (reference §6):

```geml
=== table {#terms hidden}
| term | zh-cn |
|---|---|
| source of truth | 事实来源 |
===
```

**Notice when the source changes.** Rename `#install` in `hello.geml` and `geml check hello_CN.geml` fails with `error: unresolved reference` for `hello.geml#install`.

**Save a translated copy.** `geml hello_CN.geml --to md` writes the source text and says on stderr that `translate-to=zh-cn` was not applied. To keep the Chinese, click **Export snapshot** in the viewer: it saves what the page shows as Markdown.

**More:** [Reference](geml-translator-profile.md) · [Illustrated](https://geml-spec.github.io/illustrated/11-profile-translator.html)
