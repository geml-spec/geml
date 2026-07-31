<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo/geml-logo-dark.svg">
    <img src="docs/assets/logo/geml-logo-light.svg" alt="GEML" width="340">
  </picture>
</p>

# GEML — General Expressive Markup Language（通用表达型标记语言）

*[English](README.md) | 中文*

GEML 是一种人与AI智能体能共同书写同一篇章的标记语言。<br>
**一种格式，两类读者。**对人，是清晰可读的纯文本；对智能体，是可寻址、可校验、可溯源、可回退的**“Doc-as-a-Base”**。<br>

[![npm](https://img.shields.io/npm/v/%40geml%2Fgeml?label=npm)](https://www.npmjs.com/package/@geml/geml)
[![CI](https://github.com/geml-spec/geml/actions/workflows/ci.yml/badge.svg)](https://github.com/geml-spec/geml/actions/workflows/ci.yml)
[![GEML check](https://github.com/geml-spec/geml/actions/workflows/geml-check.yml/badge.svg)](https://github.com/geml-spec/geml/actions/workflows/geml-check.yml)
[![code: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)
[![spec: CC BY 4.0](https://img.shields.io/badge/spec-CC%20BY%204.0-lightgrey.svg)](spec/LICENSE-spec.md)

---

**GEML**极简。
它极度简单——全语言只有一种块语法；
它是纯文本——脱离渲染器依然清爽；
它对机器友好——原生提供可寻址、可校验、可引用的结构化表达。

GEML文件本身就是纯文本，读它不需要任何渲染器。它也不为每种内容单独设一套迷你语法，而是把所有类型内容都以一个**类型块（typed block）**容器承载。段落是块，代码是块，表格、图形、公式、提示框、乃至元数据，也都是块。未来要扩展也简单至极。形态都一样，所以这门语言好学到想写错都难。

```
=== code {#hello lang=python}
print("hi")
===
```


## 为什么现在需要一种新格式

每个人都会这么问。

**文字是唯一的通用介质，但文本格式的演进早已落后于交互范式的变革。**

回顾软件工程史，文字按「生产（写）→ 消费（读）」被割裂在四个闭环里。而**整个工业界一直在为「消费端」的极致体验，不惜代价地向「生产端」施加约束**：

* **人 → 人**：为了人读得舒服，诞生了 Word / Markdown——代价是牺牲机器可理解的结构。
* **人 → 机器**：为了机器能精准执行，人类不得不培养专业技能（写严密的逻辑代码、设计 UI 交互、定义 Protobuf / Schema），把自己的意图强行翻译成机器语言。
* **机器 → 人**：为了适配不同终端（Web / App / 打印），造出极其庞大的工具链与渲染引擎，把底层数据投影成各式场景化的视图。
* **机器 → 机器**：为了绝对的传输效率，制定强约束的 JSON / XML 协议，彻底摒弃人类可读性。

四个闭环格式分家，却**全靠人类的专业技能（产品经理、软件工程师）当「肉体胶水」**，在各种协议与规范之间硬生生缝合，维持着一种脆弱但确定的平衡。变更是低频的，所以缝得过来。

**LLM 的引入，彻底打破了这种由人维持的精确平衡。**

1. **输入端（人 → 机器）的约束消失了。** LLM 直接接受模糊、随意、非结构化的自然语言，人类不再需要把意图翻译成严密的代码或 Schema——也就不再有人在这一步维护那份精确性。
2. **输出端（机器 → 人 / 机器 → 机器）于是失控。** 约束没了，吞吐量却涨了几个数量级：机器向人呈现投影、或与既有系统对接时，频频产生幻觉、偏差，和不可复现的漂移。

当同一个文档要在这四个回路里**高频穿梭**——*人写下模糊意图 → Agent 解析并生成 → 系统按强类型对接 → 人类审核确认*——四种互斥的偏好就被压缩到了同一个文件上。旧格式无一例外全部失效：富文本机器进不去，JSON 人写不了，Markdown 提供不了跨回路所需的**确定性锚点**。

**代价是状态漂移，与真相源（Single Source of Truth）的崩溃。**

当 Agent 以极高的频率修改文档时，同一份内容衍生出的碎片（人类编辑源、机器改动版、渲染产物、结构化 JSON）开始迅速漂移：图引用了表格里的数字，章节引用了另一节的结论，Agent 动了结构，人类改了文本，没人知道依赖何时已经断裂。

拼凑这些漂移的碎片，得到的一定不是唯一真相源。

---

## GEML 有何不同？

先说这个解法必须满足什么，再看各家格式落在哪，最后才是 GEML 具体怎么做。

### 设计考量：碎片的解法

解决碎片化，不是把所有内容强行塞成一个庞大的单体，而是**建立基于 `#id` 的块引用**。

只要源头支持精确可寻址，多端“投影（Projection）”才是有源之水：
1. **精确可寻址（块引用）**：每一个块必须有唯一的 `#id`，允许 Agent 和人类指名道姓地引用与原子化修改局部，不搬动全文。
2. **构建期强校验**：碎片与碎片之间的引用依赖在构建期进行硬检查，死链或断链当场报错中断。
3. **可回退与可溯源**：一个 `.gemlhistory` 伴生文件记住历史版本，每一块的改动来源皆可追溯、随时块级回退。粒度是关键：文档要的是**按块**的历史，而不是 Git 那种为代码设计的行级快照——你问的是「这一块被谁改成了什么」，回退也该只退这一块。

这三条是人机协同编辑的基础。现有格式无法在“纯文本”的极低成本下同时满足这三条，所以GEML应运而生。

### 与其它格式的比较

上述三点在各自领域都有成熟方案；不寻常的是，GEML 在纯文本格式下同时满足三条：

| 流派 | 状态本质 | 可寻址 / 可引用 | 可校验 | 历史管理 / 可溯源 |
| :--- | :--- | :--- | :--- | :--- |
| **Word / Docs** | 状态黑盒 | ❌ 机器无法接入 | ❌ 无校验机制 | 依赖平台服务端，不在文件内 |
| **Markdown / AsciiDoc** | 字符串流 | ⚠️ 仅标题可寻址（按文本匹配） | ❌ 死链无声失效 | 无，必须依赖外部 Git |
| **JSON / XML** | 数据序列化 | ✔️ (id / schema) | ✔️ 依赖外部工具链 | 无，必须依赖外部 Git |
| **GEML** | **纯文本 + 块结构** | **✔️ 每块独立 `#id`（原生可引用）** | **✔️ 构建期强校验报错** | **✔️ `.gemlhistory` 紧邻文件（原生可溯源）** |

逐项对比：[对比 CommonMark](docs/GEML-vs-CommonMark_CN.md) · [对比 XML 与 JSON](docs/GEML-vs-XML-and-JSON_CN.md) · [7 种格式能力矩阵](docs/COMPARISON_CN.md)。

### GEML 的做法

三条要求对应三样具体的东西，都在纯文本里：

1. **一种块语法承载全部结构。** `=== type {#id .class key=val}` … `===`——代码、表格、图形、公式、提示框、元数据都是它，只是 `type` 不同。要学的语法只有一种，要正确生成的语法也只有一种：没有按特性各设的语法，也没有 HTML 兜底。
2. **`#id` 就是那个可寻址的把手。** 给任意块标上它，就能在任何地方引用（`[[#id]]`、`[文本](#id)`、图表 `data=#id`、脚注）——而 `geml check` 把解析不到的引用变成**构建错误**，不是静默的 404。`geml get`/`set` 也认同一个把手：只读、只改那一块。
3. **`.gemlhistory` 是一个挨着文档的纯文本文件。** 它记住每个版本，`geml history` 提交/查看/回滚，`geml revert` 只退一块——离线、不绑 git、不依赖任何服务，而且它本身可读，智能体能顺着它读懂文档怎么演变的。

### 设计边界（非目标）

GEML 刻意保持小：

- **没有 raw-HTML 逃生舱**——语义保持可移植，不绑定任何后端或渲染器。
- **托管外部图形 DSL**（Mermaid、Graphviz、D2…），而非自创一套。
- **表格能计算，但不是电子表格引擎**——逐行公式与汇总聚合，没有单元格寻址、查表或宏。
- **只用 ATX 标题**——无 setext、无 `---` frontmatter、无分隔线的歧义。

同样的克制也用在命令集上：它只对着一条标尺打磨——一个 agent 能否单靠命令行跑完一篇文档的全生命周期？——所以动词力求**够全**（每个环节都有对应动词，不必为改一块而重写整篇）、**够顺手**（参数少、默认合理、I/O 可管道化）、**够一致**（指定目标 `#id`，内容便归到它名下；输入是文件就地改、是 `-` 就走 stdout；每次写入都有守卫）。

### 必要的取舍（Trade-offs）

- **零初始生态**：Markdown 统治了主流平台，GEML 还没有。因此 GEML 的定位是**编辑源（Source of Truth）**而非交付产物。通过 `geml <file> --to md|html` 进行单向投影，交付照旧是 `.md` 或 `.html`——**只协同，不锁定**。*(注：投影是有损的，块 id 与绑表图表不会跟过去。)*
- **模型初始熟悉度不如 Markdown**：LLM 尚未针对 GEML 进行大规模预训练。虽然统一的块语法与 `--json` 诊断日志能让 Agent 实现自查自修，但初始熟悉度确实不如 Markdown，这一点不隐瞒。


### 觉得设计还不够好？来挑战它

最有价值的贡献不是代码。GEML 已是 `1.0`，但「稳定」的意思是**已有的规则不会在你脚下变动**，不是说设计已经定死：它只有**一个实现**，规范背后也只有**一套意见**——你此刻提出的反对，还能改动格式本身，而不只是它的工具链。

**先读论证再反对**——每个决定当初是怎么争的：

- **规范受什么约束** —— [`GOVERNANCE.md`](GOVERNANCE.md)：规范由它的 conformance suite 定义，所以一个改动只有配上 conformance 用例才算真的成立。
- **CLI 那套动词是怎么推导出来的** —— [按块编辑设计](docs/design/specs/2026-07-24-geml-block-mutation-cli-design.md) 与 [撤销那一半](docs/design/specs/2026-07-24-geml-revert-history-phase-design.md)。是写给实现用的工作笔记，不是打磨过的文章。
- **为什么把代码图用 GEML 表达** —— [DESIGN-geml-code-graph.md](docs/DESIGN-geml-code-graph.md)，配 [GEP 0002](spec/proposals/0002-code-graph-representation.md) / [0003](spec/proposals/0003-geml-code-graph-format.md)。
- **想自己写第二个解析器** —— [docs/WRITING-A-PARSER.md](docs/WRITING-A-PARSER.md)。

**一致性测试集就是契约。** 规范改动必须连同它的 conformance 用例一起落地，绝不单独落——这是让两个实现互相制约的东西。见 [`GOVERNANCE.md`](GOVERNANCE.md)。

**两个确实开放的问题**，如果你想找个具体的啃：

- **跨 `rename` 的回退。** 历史伴生文件按 `#id` 索引块，所以一次改名被记成*删除 + 新增*，`geml revert` 没法跟着一个块穿过这道边界。今天它是一条**写明的限制**；一份「改名谱系日志」能修好它，而不必改写已存的修订——改写会撞坏那条让历史可验证的哈希链。
- **投影出去是有损的。** `--to md` / `--to html` 会丢掉块 id 与图表绑表的引用，因为这两个目标格式根本没地方放它们。作为交付没问题，作为往返就糟了。一个无损投影值得做吗？它又该把这些信息编码到哪去？

带着一个我们能跑的用例来反对，比赞同更有价值。


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

连续的 `=`（≥3 个）开块，等长的一串闭块；更长的围栏可嵌套更短的。带 `#id` 的块还可以用**带标签围栏** `=== #id` 闭合——不必数围栏长度，长块、嵌套块因此更难写错。类型决定正文如何解读——`raw`（原样：`code`、`diagram`、`math`、`table`）、`flow`（带内联标记的散文：`note`）、或 `data`（每行一个 `key=val`：`meta`）；每个块都可携带属性对象 `{#id .class key=val}`，其中 `.class` 是*语义*标签，绝不作样式钩子。完整的内联语法（强调、链接、`[[#id]]` 自动引用、媒体、脚注、行内 `$公式$`）见[规范](spec/GEML-spec_CN.md)。

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

表格还支持用 `src="regions.csv"` 引入外部 CSV。

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

为了更好地体会 GEML 格式的强大与灵活，我们拿程序员最熟悉、也最有挑战性的场景之一——代码图——来试一试。
**把整个代码库的调用图，写成 GEML。** `geml codemap build` 把调用图落成一棵 GEML 文档树——每个方法一个 `#id` 块，`#calls` / `#called-by` 正反向边。正向调用的**下游链**做问题排查、反向被调用的**上游链**查看影响面，全都秒速得见；
![geml-parser/render.ts 的方法图：悬停 RenderCtx.inline，整条调用链高亮、其余变暗；点击节点，该方法源码就显示在图旁边](docs/assets/codemap-render-ts.gif)


```sh
npm i -g @geml/geml             # 需要 Node 22+
geml codemap build              # --root 默认当前目录：识别语言 → 索引 → 合并成一张图，落在 ./.geml-code-graph/
geml codemap serve              # 自动打开浏览器看图
```
> [!TIP]
> **TS/JS**——零前置，`build` 会自己拉取 scip 索引器。
> **Java / C / Python / Go / Kotlin**——多下载一个 [Joern](https://docs.joern.io/installation)：release 包解压后把目录传给 build，例如 `--joern C:\joern\joern-cli`（放进 PATH 也行，可省掉这个参数）。
> 前端 + 后端混合仓库——会并进**同一张图**。

geml-code-graph 本身就是一个 diagram 格式——一行就能把它嵌进任何 GEML 文档（`=== diagram {format=geml-code-graph src=.geml-code-graph/index.geml} ===`），且每次代码变更都会自动触发重建，代码图永不脱节。规模不是问题：图是纯文本**数据表**——上万源文件、几十万条边仍秒开秒查（去感受下全局密如蛛网的对称美感带来的震撼吧），随意搜方法名可以定位调用链路。

## 下一步——快点上手用一下：

▶ **[到 Playground 试写 GEML](https://geml-spec.github.io/geml/playground/)**——左边编辑、右边实时渲染，引用一断，构建判定当场翻红。无需安装。

1. 装上**[浏览器扩展](https://chromewebstore.google.com/detail/opmhfphgoidpnipphfgkhhjhmnmaenie)**，打开任一 raw `.geml` 链接看它渲染——**[GEML 规范本身](https://raw.githubusercontent.com/geml-spec/geml/main/spec/GEML-spec.geml)**（dogfood——规范本身就是一份 GEML，规模化渲染）、**[showcase](https://raw.githubusercontent.com/geml-spec/geml/main/docs/examples/showcase.geml)**（计算表、四张图、一条 Mermaid 流程、公式），或把 **[playground/sample.geml](https://raw.githubusercontent.com/geml-spec/geml/main/playground/sample.geml)** 打开看交互式代码图。
2. 或现在就到 ▶ **[Playground](https://geml-spec.github.io/geml/playground/)** 自己当场试着编辑下——无需安装。
3. 想了解完整语法，读**[完整规范](spec/GEML-spec_CN.md)**（中 / [English](spec/GEML-spec.md)）。

## 在大模型里使用 GEML

GEML 的设计目标是**让模型来写、也来改**——而且改得精确。要改一处，agent 不必重读、
重发整篇文档，而是**按 id 定位到单个块**，改完再校验：

```sh
npm i -g @geml/geml                 # 安装 geml 命令
geml doc.geml                       # 文档模型 JSON（默认 --to json）
geml doc.geml --to md|html|geml     # 转换（geml notes.md -> GEML；-o 写文件）
geml get    doc.geml ['#id']        # 列出全部 id，或打印单个块（标题 id = 整节）
geml set    doc.geml '#license' --in template.geml#mit   # 替换一个块，fork 另一文件（id 归一到 #license）
geml add    doc.geml --after '#intro' --in snippet.geml  # 在某位置插入片段（保留其自身 id）
geml delete doc.geml '#draft' '#tmp'           # 删除一个或多个块
geml rename doc.geml '#old' '#new'             # 重命名一个 id 及其全部引用
geml revert doc.geml '#plan' --rev -1          # 把单个块回退到某历史修订
```

每个变更都写出整篇更新后的文档——输入是文件就地改、输入是 `-` 走 stdout——所以编辑天然可管道化；写前都会重新解析，若会破坏文档则拒写。逐个参数见 [parser README](geml-parser/README.md)。

- **Claude Code / Claude CLI。** 装上上面的包，再把
  [`.claude/skills/`](.claude/skills/) 下的技能——`geml/` 管写作、
  [`geml-code-graph/`](.claude/skills/geml-code-graph/SKILL.md) 管调用图——
  拷到 `~/.claude/skills/`。之后 Claude 会自动加载：一碰 `.geml` 文件就跑
  `geml check`，而你说「看下 code-graph」或「谁调用了 X」时它会自动构建并打开
  调用图，无需记 CLI、也无需额外提示。
- **ChatGPT、Gemini 或任意模型。** 把下面这段 primer 贴给模型让它产出合法 GEML，
  再对输出跑 `geml check` 拿硬性通过/失败信号。

> **GEML primer。** 把文档写成 GEML。每个块都是 `=== type {#id .class key=val}` …
> `===`；闭合围栏是与开围栏**等长**的一串 `=`，更长的围栏可嵌套更短的——块若带
> `#id`，也可以用带标签围栏 `=== #id` 闭合（不必数长度，长块或嵌套块优先用它）。
> 块类型：`code`/`diagram`/`math`/`table`（原样正文）、`note`（带内联标记的散文）、
> `meta`（每行一个 `key=val`）。标题只用 ATX `#`——没有 `---` frontmatter（用
> `=== meta`）。每个 `#id` 唯一，且每个引用（`[[#id]]`、`[text](#id)`、`[^id]`、
> 图表 `data=#id`）都必须能解析。不允许 raw HTML。内联：`*强调*`、`**加粗**`、
> `` `代码` ``、`$公式$`、`[文本](url)`。规范见 [`GEML-spec_CN.md`](spec/GEML-spec_CN.md)。

### MCP 服务器

包里自带一个标准的 Model Context Protocol 服务器——让你的助手**一次只改一个块**，而不是
重写整个文件。本地运行，支持 Windows、macOS、Linux；`--root` 就是放 `.geml` 文件的目录。

**Claude Code / 任意 CLI 客户端** —— 一条命令：

```sh
claude mcp add geml -- npx -y @geml/geml@latest mcp --root /absolute/path/to/your/docs
```

**Claude Desktop** —— 加到 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "geml": {
      "command": "npx",
      "args": [
        "-y",
        "@geml/geml@latest",
        "mcp",
        "--root",
        "/absolute/path/to/your/docs"
      ]
    }
  }
}
```

然后你照常提需求就行——「把 FY26 表里 Q3 那行改掉」——助手会精确定位到那一个块。**你不用
记任何工具名**：每个都镜像一个 CLI 动词（`geml set` → `geml_set`），终端和助手共用同一套
词汇。

比「让模型直接重写文件」强的地方有两条保证：写入**落盘之前**先解析，若会破坏文档就带着
诊断被拒；而且每次写入**先记一条 `.gemlhistory` 修订**——所以一次坏编辑既*拦得住*、又
*撤得回*（`geml_revert` 只还原那一个块，文件其余部分逐字节不变）。所有路径都被限制在
`--root` 内，客户端无法放宽。

把 `--root` 指向一个建过代码图（`geml codemap build`）的仓库，同一个服务器还能回答「谁调
用了这个」——四个只读的 `geml_codemap_*` 工具，一个客户端入口而不是两个。全部工具与参数见
[docs/mcp-guide.md](docs/mcp-guide.md)。

## 生态成熟度

GEML 是一份小而年轻的规范，但已经**稳定**：已发布 **`1.0`**，可用来写真实文档（本仓库的规范本身就是一例）；有一套严格的一致性测试集、一个已通过它的参考实现，以及一个开放的提案流程。

两份规范都是中英双语：


| 文档 | English | 中文 |
|------|---------|------|
| 核心规范 | [`GEML-spec.md`](spec/GEML-spec.md) | [`GEML-spec_CN.md`](spec/GEML-spec_CN.md) |
| 历史扩展 | [`GEML-history-spec.md`](spec/GEML-history-spec.md) | [`GEML-history-spec_CN.md`](spec/GEML-history-spec_CN.md) |

**成熟度信号。** 完整的核心规范（§1–§8）外加历史扩展规范，均有中英两版；可用的参考实现、**渲染器** + CLI；一套[一致性测试集](geml-parser/test/conformance/)（`输入 → 投影出的文档模型`），还要由**第二个、独立编写的解析器逐用例复刻出完全相同的结果**——两个各自独立的实现在每个用例上都一致，才是让强调、列表这类微妙规则不漂移的东西；另有 600+ 项单元与一致性检查兜底（参考实现约 99% 行覆盖，CI 门槛：行/语句/函数/分支均 ≥95%）；以及**自举**——[`GEML-spec.geml`](spec/GEML-spec.geml) 是用 GEML 写成的规范本身，每次测试都被干净解析。

一份 `.geml` 能落到哪些场景里——每一项都在本仓库，可直接用或直接读：

| 场景 | 在哪 | 状态 |
|---|---|---|
| **命令行** —— 校验、转换、按块编辑、版本历史，一条命令管完 | [`@geml/geml`](https://www.npmjs.com/package/@geml/geml)（源码 [`geml-parser/`](geml-parser/)） | 可用 |
| **在浏览器里读** —— 打开任一 raw `.geml` 链接就地渲染：计算表格、图表、Mermaid、公式，诊断以横幅呈现 | [Chrome 应用商店](https://chromewebstore.google.com/detail/opmhfphgoidpnipphfgkhhjhmnmaenie) · [源码](integrations/geml-viewer/) | 可用 |
| **让助手按块改** —— MCP 服务器，助手改一个块而不是重写整个文件；写入落盘前先校验 | [`docs/mcp-guide.md`](docs/mcp-guide.md) | 可用 |
| **把代码库变成文档** —— 整个调用图写成 GEML 文档树，可交互浏览 | `geml codemap build`（[设计](docs/DESIGN-geml-code-graph.md)） | 可用 |
| **在编辑器里写** —— 语法高亮 + 构建期引用校验 | [`integrations/vscode/`](integrations/vscode/) | 可用 |
| **在 Obsidian 里渲染** —— 用参考解析器 + viewer 的渲染器，与网页同一条代码路径 | [`integrations/obsidian/`](integrations/obsidian/) | 已构建，未上架社区商店 |
| **进 CI 卡住坏文档** —— 悬空 `[[#id]]`、跨文档断链、重复 id、解析错误一律让构建失败 | [`integrations/geml-check-action/`](integrations/geml-check-action/) | 可用 |
| **喂给 RAG / agent 框架** —— 按块切分的加载器（每块一个 chunk，带 `block_id`）+ agent 编辑工具 | [`integrations/langchain+llamaindex/`](integrations/langchain+llamaindex/) | 参考实现 |
| **不装任何东西先试** —— 左边编辑、右边实时渲染，引用一断构建判定当场翻红 | [Playground](https://geml-spec.github.io/geml/playground/) | 可用 |

格式互转都收在同一个入口 `geml <file> [--to json|html|md|geml]`：进出 Markdown、投影成自包含 HTML、重排回规范 GEML、或吐出带 `diagnostics` 的文档模型 JSON——脚本与智能体由此拿到结构化的通过/失败信号。

## 状态与贡献

**贡献。** 各种贡献都欢迎——报 bug、工具与集成、更广的一致性覆盖，以及规范本身讨论。GEML 已是 1.0，但仍可演进：实质性的规范改动通过 [GEP](CONTRIBUTING.md) 讨论并落地，每项都附带对应的一致性用例。参考实现的测试套件就是契约——代码改动应保持 `npm test` 通过、且 dogfood 规范解析无误。想知道有哪些活真正开放：下面的[做一个集成](#做一个集成)是**缺什么**，上面的[觉得设计还不够好？来挑战它](#觉得设计还不够好来挑战它)是仍在桌面上的设计问题。**最有价值的贡献是用另一种语言写一个独立实现**——可移植的一致性测试集让它成为一个周末的活儿，见 [docs/WRITING-A-PARSER.md](docs/WRITING-A-PARSER.md)。

### 做一个集成

上面那张场景表说的是**已经有什么**；这里说的是**缺什么**——每一行都是一件可以认领的活：

| 缺口 | 现状 | 要做的事 |
|---|---|---|
| **Obsidian 深度集成** | 能渲染，但尚未上架社区商店 | CodeMirror 层面的编辑与无缝双向渲染，以及上架本身。需要熟悉 Obsidian API 的人。 |
| **tree-sitter 语法** | 只有一份设计稿 | 写出语法本身——一份就能同时点亮 **Neovim、Helix、Zed**。 |
| **一个 LSP** | VS Code 现在只有高亮 + 构建期校验 | 改名感知的重构、跳到块、编辑时实时诊断。 |
| **Logseq 插件 / Notion 导入导出** | 空白 | 全部。 |
| **Pandoc reader / writer** | 空白 | 一旦有它，GEML 就能进入 Pandoc 已经服务的每一条流水线。 |
| **viewer 的其它浏览器** | Chrome 可用 | Firefox / Safari 移植。 |
| **RAG 集成打包** | LangChain / LlamaIndex 是参考实现 | 发到 PyPI；以及接其它框架（Haystack、DSPy…）。 |
| **MCP 客户端验证** | 只在 Claude 上端到端跑过 | 在别的 MCP 客户端上验一遍，把差异报回来。 |

渲染核心是可复用的：viewer、Obsidian 插件、`--to html` 走的是**同一份**渲染代码，所以接一个新宿主主要是写胶水，而不是写一个新解析器。


**更小、边界更清楚的活**（代码图接更多语言、被搁置的 D2 / Graphviz 引擎、符号可见性、增量 emit、更广的一致性覆盖）认领方式相同：[开一个 issue](https://github.com/geml-spec/geml/issues/new) 说你想做哪块。

### 用另一种语言写一个解析器

两个互不相干却彼此吻合的实现，才是把「规范」变成「标准」的东西。这里有一套可移植的[一致性测试集](geml-parser/test/conformance/)供你自证，还有一份构建顺序指南：**[docs/WRITING-A-PARSER.md](docs/WRITING-A-PARSER.md)**。

Rust、Go、Python、Java、C 都行。**找出规范里有歧义的地方，这件事本身就是贡献**——不管那个解析器最后有没有发布。


如果「为什么不直接用 Markdown」在你看来答案很明显——不论是哪个方向——我们宁愿听你说出来。

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

代码（`geml-parser/`、`integrations/geml-viewer/`、`integrations/geml-check-action/`）为 **MIT**（[`LICENSE`](LICENSE)）。规范文档为 **CC-BY-4.0**（[`LICENSE-spec.md`](spec/LICENSE-spec.md)）——规范不是软件，任何人都可以构建一个兼容实现。决策方式见 [`GOVERNANCE.md`](GOVERNANCE.md)，参与方式见 [`CONTRIBUTING.md`](CONTRIBUTING.md)
