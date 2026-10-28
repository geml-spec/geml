# geml-statechart 使用指南

> **状态** draft · **声明** 在 `=== meta` 里写 `profile = "geml-statechart/v1"` · **限制** 不支持嵌套状态、并行区域和事件（留给 v2）

## 它做什么

用一个 `diagram` 块写一台状态机：有哪些状态，状态之间的转移连同它们的守卫和动作，以及守卫要读的变量。
`geml check` 能找出指向不存在状态的转移、从起点到不了的状态，以及进去就出不来的状态。
`--to html` 把它画出来，`--to md` 把它转成 GitHub 能直接显示的 Mermaid 图。

## 上手

先装好 CLI：`npm i -g @geml/geml`（Node 22+）。把下面这段存成 `review.geml`：

```geml
=== meta
profile = "geml-statechart/v1"
===

# 评审流程

=== diagram {#review format=geml-statechart caption="评审"}
{
  "initial": "draft",
  "states": {
    "draft":     { "title": "草稿", "owner": "作者" },
    "in-review": { "title": "评审中", "owner": "评审人" },
    "published": { "title": "已发布", "final": true }
  },
  "vars": { "approvals": { "default": 0 } },
  "transitions": [
    { "from": "draft", "to": "in-review", "guard": "作者提交" },
    { "from": "in-review", "to": "draft", "guard": "要求修改", "actions": [{ "reset": ["approvals"] }] },
    { "from": "in-review", "to": "published",
      "guard": { "properties": { "approvals": { "enum": [2, 3] } } } }
  ]
}
===
```

`owner` 是这张图自己的属性：格式不认识它，照原样显示。
守卫可以是一句给人看的话，也可以是对 `vars` 的一段 JSON Schema，让程序去求值。

先检查一遍；再把最后一条转移里的 `published` 故意写成 `publised`，再检查：

```console
$ geml check review.geml
ok: no diagnostics
$ geml check review.geml
error: statechart-transition: transition 3: `to` names `publised`, which is not a state (review.geml#review)
1 error(s)
```

## 常用

画出来。生成的页面是自包含的 SVG，不依赖任何绘图运行时：

```sh
geml review.geml --to html -o review.html
```

放到 GitHub 上看。`--to md` 写出一张 Mermaid `stateDiagram-v2`：

```console
$ geml review.geml --to md
…
stateDiagram-v2
    state "草稿" as draft
    state "评审中" as s1
    state "已发布" as published
    [*] --> draft
    draft --> s1 : 作者提交
    s1 --> draft : 要求修改
    s1 --> published : approvals
    published --> [*]
```

在块上写 `current=in-review`，标出某件事现在走到了哪一步；画出来时那个状态会被圈出。

找出漏掉的状态。从起点到不了的状态，以及没标 `final` 却没有出路的状态，都会报警告。在 `states` 里加一个 `"archived": { "title": "已归档" }` 再检查：

```console
$ geml check review.geml
warning: statechart-unreachable: state `archived` cannot be reached from `draft` (review.geml#review)
warning: statechart-dead-end: state `archived` has no transition out and is not marked final (review.geml#review)
2 warning(s)
```

只改一个值，不重写整张图。把定义放进一个 `data` 块，图用 `data=` 指向它，定义里的每个值就都有了坐标：

```geml
=== data {#review-def format=json}
{ "initial": "draft",
  "states": { "draft": { "owner": "作者" }, "published": { "final": true } },
  "transitions": [ { "from": "draft", "to": "published", "guard": "已批准" } ] }
===

=== diagram {format=geml-statechart data=#review-def caption="评审"}
===
```

```sh
geml get review.geml '#review-def["states"]["draft"]["owner"]'   # 作者
echo '"编辑"' | geml set review.geml '#review-def["states"]["draft"]["owner"]' --in -
```

一句话写成的守卫怎么判定、谁来推动转移、你自己的属性是什么意思，都交给运行这张图的程序决定（见参考文档 §5）。

**更多：** [参考文档](geml-statechart-profile_CN.md)
