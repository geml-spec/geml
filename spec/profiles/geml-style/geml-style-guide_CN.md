# geml-style 使用指南

> **状态** draft · **声明** `profile = "geml-style/v1"` · **限制** 实验性：`geml style check` 只承认 `style-rule`、`match=` 和属性透传是稳定的

## 它做什么

样式表是单独的一份 `.geml` 文件，规定一份文档怎么排版、怎么显示。文档本身一个字
都不用改。样式表里没有脚本：它只写组件的名字，由宿主负责画出来。

## 上手

先装 CLI：`npm i -g @geml/geml`（需要 Node 22+）。建一个文件夹，放两份文件。
文档 `page.geml`：

```geml
# 你好

=== note {#tip}
这条提示长什么样，由另一份文件决定。
===
```

样式表 `_index/index.geml`。viewer 只认文档旁边的这个路径（参考文档 §1.1）：

```geml
=== meta
profile = "geml-style/v1"
===

=== style-screen {#page slots="*" max-width=720px padding=24px}
===

=== style-rule {#tip-look match="note#tip" border-left="4px solid #0969da" background="#f6f8fa"}
===
```

`style-screen` 就是整页，`slots="*"` 把文档里的内容按原来的顺序全部摆上去。`style-rule`
选中那条提示，给它加左边框和底色。

拿样式表对着文档检查一遍：

```
geml style check _index/index.geml page.geml
```

输出 `0 error(s), 0 warning(s)`。

要看效果，在 Chrome 里装上[浏览器扩展](https://chromewebstore.google.com/detail/opmhfphgoidpnipphfgkhhjhmnmaenie)，
在扩展详情里打开 **Allow access to file URLs**，再打开 `page.geml`。样式表里没有
`style-screen` 时，viewer 按普通文档显示，并在页面顶上说明原因（参考文档 §2.3）。
`geml page.geml --to html` 不会套用样式表。

## 常用

**文档改了，看样式表有没有脱节。** 再跑一遍同样的检查。执行
`geml rename page.geml '#tip' '#hint'` 之后，它会报：

```
warning: style-unmatched-rule: rule `#tip-look` matched no block in the corpus (#tip-look)
```

只有警告时退出码是 0，有错误时是 1。全部诊断码见参考文档 §8。

**看宿主拿到的是什么。** 加上 `--json`：
`geml style check _index/index.geml page.geml --json` 打印视图模型——每个块被哪些
规则选中、最后取到哪些值（参考文档 §10）。

**交给 agent 改。** 每条规则都是带 id 的块，agent 用
`geml get _index/index.geml '#tip-look'` 读出一条，用 `geml set` 换掉，再跑一遍检查。

**延伸：** [参考文档](geml-style-profile_CN.md) · [图解](https://geml-spec.github.io/illustrated/10-profile-style_CN.html) · [演示](https://geml-spec.github.io/demos/style)
