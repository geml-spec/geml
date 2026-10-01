# geml-codemap 使用指南

> **状态** stable · **声明** `profile = "geml-codemap/v1"`（`geml codemap build` 会自动写上）· **限制** TypeScript/JavaScript 以外的语言要另装索引器

## 它做什么

把代码库的调用图写成 GEML 文档。每个方法是一个带 id 的块，`#calls` / `#called-by` 两张表把调用关系双向连起来：它调用了谁，谁调用了它。
这个工具叫 codemap（命令是 `geml codemap`），只有三处字面上叫 geml-code-graph：输出目录 `.geml-code-graph/`、diagram 格式名和 Claude 技能名。

![geml-parser/render.ts 的方法图：悬停 RenderCtx.inline，整条调用链高亮、其余变暗；点击节点，该方法源码就显示在图旁边](../../../docs/assets/codemap-render-ts.gif)

## 上手

先装好 CLI（Node 22+），再到仓库根目录跑后两条：

```sh
npm i -g @geml/geml
geml codemap build    # 识别语言、建索引，写进 .geml-code-graph/
geml codemap serve    # 启动本地服务（http://localhost:8140/），自动打开浏览器看图
```

各语言需要准备什么：

- **TypeScript / JavaScript**：什么都不用装。`build` 会用 npx 拉取 scip 索引器，所以第一次要联网。
- **Java、C、Python、Go、Kotlin**：装 [Joern](https://docs.joern.io/installation)。解压后把目录传给 build（`geml codemap build --joern ~/joern/joern-cli`），或者放进 PATH。
- **Rust**：PATH 里要有 `rust-analyzer`。

前端和后端用不同语言写的仓库，也会合并成同一张图。
在 Apache Flink 上实测：13,585 个 Java 文件，约 8.1 万个方法，266,821 条调用边。

## 常用

先找到方法，再看谁调用了它；把 `#called-by` 换成 `#calls`，看的就是它调用了谁。
下面是在一个叫 `demo` 的小 TypeScript 项目上跑的：

```console
$ geml codemap find add
add	demo.geml#add	src/math.ts#L1-3

1 match(es) for "add" across 1 name(s).
$ geml get .geml-code-graph/demo.geml '#called-by'
=== table {#called-by format=csv}
from,         to,           kind, site
#main,        #formatTotal, call, src/main.ts:4
#formatSum,   #add,         call, src/format.ts:8
#total,       #add,         call, src/math.ts:6
#formatTotal, #total,       call, src/format.ts:4
===
```

各列是什么意思、一条边能信到什么程度，见参考文档 §4 和 §8。

提交代码之后，把图更新到最新。`refresh` 会重新执行第一次 build 时记下的步骤；
源文件没有变化时，它什么也不做：

```sh
geml codemap refresh
```

Claude 技能里带一个可选的提交钩子，每次提交后自动跑它。

在任何 GEML 文档里加一个块，就能把这张图嵌进去：

```geml
=== diagram {format=geml-code-graph src=.geml-code-graph/index.geml}
===
```

agent 也能通过 MCP 问同样的问题：`--root` 下有图时，`geml mcp --root .` 会多出四个只读的 `geml_codemap_*` 工具。

**延伸：** [参考文档](geml-codemap-profile_CN.md) · [图解](https://geml-spec.github.io/illustrated/09-profile-codemap_CN.html) · [演示](https://geml-spec.github.io/demos) · [技能](../../../integrations/claude-plugin/skills/geml-code-graph/SKILL.md)
