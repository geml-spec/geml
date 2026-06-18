---
title: Kitchen Sink
author: GEML Test
draft: false
version: 3
---

# Kitchen Sink {#top}

A document exercising as many Markdown constructs as possible.

## Table of Contents {#toc}

1. [Inline formatting](#inline)
2. [Code](#code)
3. [Tables](#tables)
4. [Math](#math)
5. [Quotes and lists](#quotes-lists)
6. [Media and links](#media)

Section One
===========

## Inline formatting {#inline}

Plain text with *emphasis*, **strong**, ***both***, ~~strikethrough~~,
`inline code`, and inline math $E = mc^2$. A hard break here\
continues on the next line. Escaped \*asterisks\* stay literal.

A footnote reference[^note] points to a definition below.

Subsection via setext
---------------------

See [the table section](#tables) and the auto-referenced [[#tables]].

## Code {#code}

```js
function hello(name) {
  return `hi ${name}`;
}
```

A GEML example embedded as code (note the inner `===` fences):

```geml
=== table {#demo caption="inner"}
| a | b |
|---|---|
| 1 | 2 |
===
```

## Tables {#tables}

| Feature   | Status | Score |
|:----------|:------:|------:|
| Headings  |  done  |    10 |
| Tables    |  done  |     9 |
| Footnotes |  wip   |     7 |

## Math {#math}

Block math:

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

## Quotes and lists {#quotes-lists}

> A blockquote spanning
> two lines.

- top level
  - nested item
  - another nested
- second top
  1. ordered child
  2. ordered child two

Task list:

- [x] done item
- [ ] pending item

---

## Media and links {#media}

An inline link to [Anthropic](https://www.anthropic.com) and an image:

![alt text](https://example.com/pic.png)

An autolink: <https://commonmark.org>.

[^note]: This is the footnote body.
