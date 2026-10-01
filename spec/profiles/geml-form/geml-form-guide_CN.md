# geml-form 使用指南

> **状态** draft · **声明** `profile = "geml-form/v1"` · **限制** 没有工具按约束校验输入；`geml check` 还不校验表单属性的取值

## 它做什么

`form` 块在文档里描述一张表单：有哪些字段，各自的标签和类型，以及 `pattern`、`min`
这类约束。它只负责描述。GEML 不提交表单，也不检查用户填了什么，这些由 `handler=`
背后的应用来做。

## 上手

先装 CLI：`npm i -g @geml/geml`（需要 Node 22+）。把下面的内容存成 `signup.geml`：

```geml
=== meta
profile = "geml-form/v1"
===

==== form {#signup handler=subscribe}
=== form-field {#email label="工作邮箱" type=text required pattern=".+@.+"}
===
=== form-field {#seats label="席位数" type=number min=1 max=50}
===
====
```

`form` 的围栏比字段多一个 `=`，字段才装得进去。

```
geml check signup.geml
```

输出 `ok: no diagnostics`。去掉 `meta` 块，它会警告 `form` 是未知的块类型。

要看效果，把文档贴进 [Playground](https://geml-spec.github.io/playground/)。也可以在
Chrome 里装上[浏览器扩展](https://chromewebstore.google.com/detail/opmhfphgoidpnipphfgkhhjhmnmaenie)，
在扩展详情里打开 **Allow access to file URLs**，再打开 `signup.geml`。你会看到一个
标了必填的文本框和一个数字框。`geml signup.geml --to html` 目前还画不出表单。

## 常用

**加一个下拉框。** 在表单里放一张 `form-options` 表写选项，再让 `select` 字段指向它：

```geml
=== form-options {#plans format=csv}
value, label
basic, 基础版
pro,   专业版
===
=== form-field {#plan label="套餐" type=select options=#plans}
===
```

**揪出拼错的属性名。** profile 不认识的键，`geml check` 都会警告。在 `#email` 上写了
`minlength=5`，它会报：

```
warning: unknown attribute `minlength` for block type `form-field` (line 6)
```

它不看取值：`type=email`、`min=abc` 都能通过。六个约束键各怎么读，见参考文档 §2。

**只改一个字段，或交给 agent 改。** 每个字段都是带 id 的块，读一个、换一个都不碰
其余部分。把新的 `#seats` 块写进 `seats.geml`，然后：

```
geml get signup.geml "#email"
geml set signup.geml "#seats" --in seats.geml
```

**延伸：** [参考文档](geml-form-profile_CN.md) · [图解](https://geml-spec.github.io/illustrated/06-form_CN.html)
