<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo/geml-logo-dark.svg">
    <img src="docs/assets/logo/geml-logo-light.svg" alt="GEML" width="340">
  </picture>
</p>

# GEML — General Expressive Markup Language（通用表达型标记语言）

*[English](README.md) | 中文*

**一种格式，两类读者。**<br>
人**与** AI 智能体可共同书写同一篇章。<br>
对人，清晰可读；对机器，可寻址、可校验、可带版本。

GEML 是纯文本——由**一种类型块**承载一切，由一个 **`.gemlhistory` 伴生文件**记忆。

`1.0`

<!-- TODO(发布): demo GIF 录好后放这里：
![同一个 AI agent 改同一篇文档：Markdown 静默带病发布，GEML 让构建失败。](docs/demo.gif)
-->

---

GEML 是一种面向结构化文档的标记语言。`.geml` 文件本身就是纯文本，读它不需要任何渲染器。它也不为每种内容单独设一套迷你语法，而是把所有内容都放在一个构造上：**类型块（typed block）**。

```
=== code {#hello lang=python}
print("hi")
===
```

代码是块，表格、图形、公式、提示框、乃至文档元数据，也都是块。形态每次都一样，所以这门格式好学，也难写错。

## 为什么现在需要一种新格式

Markdown 是为**人类手写、人类阅读**的文档设计的。而今天，同一批文档还要由 **AI 智能体和 CI 流水线**来书写、编辑、评审与查询——这一转变，对格式提出了三件 Markdown 从未需要提供的事：

- **可预测的结构**，让模型直接产出合法输出，而不是在一堆按特性堆叠的特例里猜。
- **可被校验的引用**，让破坏了链接的自动编辑**当场报错**，而不是悄悄烂掉。
- **随文档一起走的历史**，让读者——无论人还是智能体——能看清它如何、为何演变，离线、无需任何外部服务。

GEML 就是围绕这三点做出来的。目标不是给某种文档格式"加上 AI 功能"，而是选一种对人更简单、对机器也更可靠的格式。

## GEML 有什么不同

很多格式能做到其中一两件。GEML 的特别之处在于，一种纯文本格式三点都满足：

1. **单一原语承载一切结构化块。** 代码、表格、图形、公式、提示框、元数据——全是同一个 `=== type {…}` 类型块。一套语法要学、一套语法去正确生成：没有按特性各设的语法，也没有 HTML 兜底。
2. **引用在构建期被校验。** 给任意块标 `#id`、在任何地方引用它；悬空引用或断掉的跨文档链接是构建**错误**，而非静默的 404。自动编辑不会悄悄腐烂。
3. **自包含的版本历史。** 一个同名 `.gemlhistory` 伴生文件即可重建任意历史修订、把文档回滚——离线、无需 git、无需服务——而且它是纯文本，智能体能读懂文档的演变。

跨 **Markdown、HTML、CommonMark、AsciiDoc、Org-mode** 的完整对照，见[格式比较](docs/COMPARISON_CN.md)。

## 五分钟看懂这个格式

### 类型块

**一种形态，通吃所有类型。** 每个块永远是 `=== type {#id .class key=val}` … `===`——变的只有 `type`（以及正文怎么读）：

```
=== code {lang=python}
print("hi")
===

=== note {.intro}
解析过的散文，可用 *强调* 与 [[#budget]] 引用。
===

=== meta
title = "Budget plan"
===
```

连续的 `=`（≥3 个）开块，等长的一串闭块；更长的围栏可嵌套更短的。类型决定正文如何解读——`raw`（原样：`code`、`diagram`、`math`、`table`）、`flow`（带内联标记的散文：`note`）、或 `data`（每行一个 `key=val`：`meta`）；每个块都可携带属性对象 `{#id .class key=val}`，其中 `.class` 是*语义*标签，绝不作样式钩子。完整的内联语法（强调、链接、`[[#id]]` 自动引用、媒体、脚注、行内 `$公式$`）见[规范](spec/GEML-spec_CN.md)。

### 表格 —— 两种正文，一个模型

可视化写法：

```
=== table {#budget caption="年度成本"}
| Plan  | Months | Rate |
|-------|-------:|-----:|
| Basic |      1 |   30 |
| Pro   |      2 |   30 |
===
```

……或写成数据，带**计算列**与**汇总行**：

```
=== table {#fy25 format=csv header=1 compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4" summary="Segment = 'Total'; FY [%.1f] = sum(FY)"}
Segment,  Q1, Q2, Q3, Q4
Cloud,     8, 10, 12, 14
Platform,  5,  6,  7,  9
Services,  3,  4,  4,  5
===
```

*两种形态描述同一个模型。`FY` 列与 `Total` 行在构建期算出：*

| Segment   | Q1 | Q2 | Q3 | Q4 |   FY |
|-----------|---:|---:|---:|---:|-----:|
| Cloud     |  8 | 10 | 12 | 14 | 44.0 |
| Platform  |  5 |  6 |  7 |  9 | 27.0 |
| Services  |  3 |  4 |  4 |  5 | 16.0 |
| **Total** |    |    |    |    | **87.0** |

`compute` 对各列逐行做 `+ - * / ( )` 运算；`summary` 用聚合 `sum / avg / min / max / count`（并可对聚合结果再做算术，如加权比率）生成表尾一行；列名后的 `[printf]` 控制数字显示。

### 公式

```
=== math {#gauss caption="高斯积分"}
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
===
```

$$\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}$$

### 图形与图表 —— 托管 DSL，或为表格作图

GEML 从不解释图形正文，而是把它交给可插拔渲染器（未知 `format` 仅告警、正文原样保留）：

```
=== diagram {#flow format=mermaid caption="评审流程"}
graph LR
  A[Draft] --> B{Review} -->|ok| C[Publish]
===
```

```mermaid
graph LR
  A[Draft] --> B{Review} -->|ok| C[Publish]
```

图形还能**为一张表作图**——单一真相，列引用在构建期受校验，数据零拷贝：

```
=== diagram {format=geml-chart data=#fy25 type=bar x=Segment y=FY}
===
```

*取自上面的 `#fy25` 表：*

```mermaid
xychart-beta
  title "FY by segment"
  x-axis [Cloud, Platform, Services]
  y-axis "FY"
  bar [44, 27, 16]
```

## 一份给程序员的礼物：geml-code-graph

为了更好体会GEML格式的强大灵活，我们试试程序员的代码图，这是个很熟悉但又很有挑战的场景。
**把整个代码库的调用图，写成 GEML。** `geml codemap build` 把调用图落成一棵 GEML 文档树——每个方法一个 `#id` 块，`#calls` / `#called-by` 正反向边。正向调用的**下游链**做问题排查、反向被调用的**上游链**查看影响面，全都秒速得见；点一个方法节点，它的**源码**就在图旁边显示。

![geml-parser/render.ts 的方法图：悬停 RenderCtx.inlines，整条上游调用链高亮、其余变暗，源码就显示在图旁边](docs/assets/codemap-render-ts.png)

*本仓库解析器 `geml-parser/render.ts` 的 codemap 页面——悬停 `RenderCtx.inlines`，整条上游调用链高亮；点一下，源码就在图旁边。*

```sh
npm i -g @geml/geml
geml codemap build --root .     # 自动识别语言、索引、合并成一张图
geml codemap serve              # 启动后自动打开浏览器（默认指向 .geml-code-graph/）
```

`build` 自己认语言：**TS/JS** 用 scip（自动拉取，零前置）；**Java / C / Python / Go / Kotlin** 用 [Joern](https://docs.joern.io/installation)（其release packages下载后解压地址放PATH，或用 `--joern <安装目录>` 指过去）。前端 + 后端混合的仓库，会并进**同一张图**。

geml-code-graph是一个 diagram 格式：一行 `=== diagram {format=geml-code-graph src=.geml-code-graph/index.geml} ===` 就能把它嵌进任何 GEML 文档。每次项目代码更新自动触发codegraph文件更新，保证代码图永远同步。

而且它扛得住规模。图是**数据表**、不是一节点一文件——上万源文件、几十万条边也**秒开秒查**，`verify` 亚秒级，全程可 `grep`、可 `diff`、带 `.gemlhistory` 版本的纯文本。

**下一步：** 读[完整规范](spec/GEML-spec_CN.md)（中 / [English](spec/GEML-spec.md)），或 ▶ **[在浏览器里试试](https://geml-spec.github.io/geml/playground/)** —— 弄断一个引用，看构建变红。

## 为什么它对人和 AI 都好使

让 GEML 肉眼读起来舒服的那套形态，也正是它在自动化下可靠的原因：

- **纯文本，没有渲染步骤。** 模型直接读写 `.geml`，它看到的就是文档本身。
- **单一统一的原语。** 比起 Markdown 的一堆特例，生成或解析时要出错的地方少得多。
- **构建期引用校验。** 断掉的交叉引用是硬错误，所以自动编辑要么把引用理顺，要么就失败。
- **结构化内容仍是文本。** 表格、公式、图形、元数据都在纯文本里;智能体直接在文本里改,不用写 HTML（你猜猜本README最前面的logo图片是怎么嵌入Markdown格式的？）。
- **机器可读的反馈。** 解析器产出带 `diagnostics` 数组的文档模型 JSON，智能体和 CI 由此拿到结构化的通过/失败信号。

## 在大模型里使用 GEML

GEML 的设计目标是**让模型来写、也来改**——而且改得精确。要改一处,agent 不必重读、
重发整篇文档,而是**按 id 定位到单个块**,改完再校验:

```sh
npm i -g @geml/geml                          # 安装 geml 命令
geml get file.geml '#plan'                   # 只打印那一个块——读一节,而非整篇
geml set file.geml '#plan' --from new.geml   # 只替换那一个块;替换后重解析,若会破坏文档则拒绝写入
geml check file.geml                         # 退出 0 = 合法;--json 出机器可读诊断,适合 agent 循环
```

按 id 读取与修补,让每次编辑又小又准——只花整篇文档零头的 token,而 `set` 绝不会
落下一处会破坏文档的改动。

- **Claude Code / Claude CLI。** 装上上面的包,再把
  [`.claude/skills/geml/`](.claude/skills/geml/SKILL.md) 拷到 `~/.claude/skills/`。
  之后 Claude 一碰 `.geml` 文件就自动加载写作规则并跑 `geml check`,无需提示。
- **ChatGPT、Gemini 或任意模型。** 把下面这段 primer 贴给模型让它产出合法 GEML,
  再对输出跑 `geml check` 拿硬性通过/失败信号。

> **GEML primer。** 把文档写成 GEML。每个块都是 `=== type {#id .class key=val}` …
> `===`;闭合围栏是与开围栏**等长**的一串 `=`,更长的围栏可嵌套更短的。块类型:
> `code`/`diagram`/`math`/`table`(原样正文)、`note`(带内联标记的散文)、
> `meta`(每行一个 `key=val`)。标题只用 ATX `#`——没有 `---` frontmatter(用
> `=== meta`)。每个 `#id` 唯一,且每个引用(`[[#id]]`、`[text](#id)`、`[^id]`、
> 图表 `data=#id`)都必须能解析。不允许 raw HTML。内联:`*强调*`、`**加粗**`、
> `` `代码` ``、`$公式$`、`[文本](url)`。规范见 [`GEML-spec_CN.md`](spec/GEML-spec_CN.md)。

## 生态

- **参考实现 + CLI** —— [`geml-parser/`](geml-parser/)。把文档解析为**文档模型 JSON**，有错误则以非零码退出。
  ```sh
  cd geml-parser && npm install && npm run build
  node dist/geml.js ../spec/GEML-spec.geml      # 解析 → JSON（含 diagnostics）
  npm test
  ```
- **浏览器扩展** —— [`integrations/geml-viewer/`](integrations/geml-viewer/)，在本地（`file://`）与网络上渲染 `.geml`：带计算列的表格、作为内联 SVG 的 `geml-chart`、Mermaid 图、KaTeX 公式，以及作为横幅显示的构建期诊断。安装：构建后在 `chrome://extensions` 里 **Load unpacked**（[步骤](integrations/geml-viewer/README.md#load-in-chrome)）。
- **按块寻址** —— `geml get <file.geml> #id` 按 id 打印单个块;`geml set <file.geml> #id` 只替换那一个块——替换后重新解析,若会破坏文档则拒绝写入。智能体改一节,无需重读或重发整篇。
- **历史版本化** —— 对自包含的 [`.gemlhistory`](spec/GEML-history-spec_CN.md) 伴生文件执行 `geml history <commit | verify | show | restore | log> <file.geml>`;再用 `geml revert <file.geml> #id [--to -1]` 把单个块回退到某历史修订(按 `-N` 偏移、`latest` 或 id)。可寻址 + 有版本——正是"智能体逐步改文档、并能回退任意一节"的底座。
- **规范格式化器** —— `node dist/geml.js fmt <file.geml> [-o out.geml]` 把文档模型重新序列化回规范 GEML（解析器的逆运算）。`parse(serialize(parse(x)))` 是同一个模型——一个由测试集校验的往返性质——且输出幂等。
- **Markdown → GEML 转换器** —— `node dist/geml.js convert <file.md> [-o out.geml]`。映射：frontmatter → `meta`、围栏代码 → `code`、` ```mermaid/graphviz/… ` → `diagram`、`$$` → `math`、引用块 → `note`、GFM 表格 → `table`、脚注、自动链接、setext → ATX。
- **GEML → Markdown 导出器** —— `node dist/geml.js export <file.geml> [-o out.md]` 把文档投影为 GFM：`meta`→frontmatter、计算表→GFM 表、`note`→引用块、脚注、围栏代码/mermaid、`$$` 公式。本质有损——Markdown 没有类型块原语——故每个无法映射的构造（`geml-chart`、`{hidden}`、块 id）都会以 note 形式报告。
- **HTML渲染器** —— `node dist/geml.js render <file.geml> -o out.html` 把文档变成**单个自包含、可交互的 HTML 文件**：可排序/可筛选的表格、从其表格绘制为内联 SVG 的 `geml-chart`、渲染好的图形，以及贯穿到非零退出码的构建期检查。见 [`docs/examples/`](docs/examples/)。

## 状态、边界与贡献

GEML 已发布 **`1.0`**——稳定,可用来写真实文档（本仓库的规范本身就是一例）。

**成熟度信号。** 完整的核心规范（§1–§8）外加历史扩展规范，均有中英两版；可用的参考实现、**渲染器** + CLI；一套[一致性测试集](geml-parser/test/conformance/)（`输入 → 投影出的文档模型`），还要由**第二个、独立编写的解析器逐用例复刻出完全相同的结果**——两个各自独立的实现在每个用例上都一致，才能保证强调、列表这类微妙规则不会各写各的、跑偏——另有 300+ 项单元与一致性检查兜底（参考实现约 93% 行覆盖，CI 门槛 ≥90%）；以及**自举**——[`GEML-spec.geml`](spec/GEML-spec.geml) 是用 GEML 写成的规范本身，每次测试都被干净解析。

**设计边界（非目标）。** GEML 刻意保持小：

- **没有 raw-HTML 逃生舱**——语义保持可移植，不绑定任何后端或渲染器。
- **托管外部图形 DSL**（Mermaid、Graphviz、D2…），而非自创一套。
- **表格能计算，但不是电子表格引擎**——逐行公式与汇总聚合，没有单元格寻址、查表或宏。
- **只用 ATX 标题**——无 setext、无 `---` frontmatter、无分隔线的歧义。

**贡献。** 各种贡献都欢迎——报 bug、工具与集成、更广的一致性覆盖，以及规范本身讨论。GEML 已是 1.0，但仍可演进：实质性的规范改动通过 [GEP](CONTRIBUTING.md) 讨论并落地，每项都附带对应的一致性用例。参考实现的测试套件就是契约——代码改动应保持 `npm test` 通过、且 dogfood 规范解析无误。**最有价值的贡献是用另一种语言写一个独立实现**——可移植的一致性测试集让它成为一个周末的活儿,见 [docs/WRITING-A-PARSER.md](docs/WRITING-A-PARSER.md)。

| 文档 | English | 中文 |
|------|---------|------|
| 核心规范 | [`GEML-spec.md`](spec/GEML-spec.md) | [`GEML-spec_CN.md`](spec/GEML-spec_CN.md) |
| 历史扩展 | [`GEML-history-spec.md`](spec/GEML-history-spec.md) | [`GEML-history-spec_CN.md`](spec/GEML-history-spec_CN.md) |

## 仓库结构

```
spec/                  核心规范 + .gemlhistory 扩展（英 / 中）、dogfood 的
                       GEML-spec.geml、CC-BY 规范许可证、proposals/（GEP）
geml-parser/           参考实现、渲染器、CLI + codemap 工具集（TypeScript, Node 22）
integrations/          GEML 接入的所有地方：geml-viewer（浏览器扩展）、
                       geml-check-action（CI）、vscode、obsidian、tree-sitter（简报）
playground/            浏览器内 playground（含本仓库的实时 geml-code-graph）
docs/                  指南、设计笔记、格式 COMPARISON（英 / 中）、图片资产，
                       以及一个可自行渲染的示例 .geml 文档
```

## 许可与治理

代码（`geml-parser/`、`integrations/geml-viewer/`、`integrations/geml-check-action/`）为 **MIT**（[`LICENSE`](LICENSE)）。规范文档为 **CC-BY-4.0**（[`LICENSE-spec.md`](spec/LICENSE-spec.md)）——规范不是软件，任何人都可以构建一个兼容实现。决策方式见 [`GOVERNANCE.md`](GOVERNANCE.md)，参与方式见 [`CONTRIBUTING.md`](CONTRIBUTING.md)——**用另一种语言写一个独立实现,是你能做的最有价值的贡献。**
