# GEML — General Expressive Markup Language（通用表达型标记语言）

*[English](README.md) | 中文*

**一种纯文本标记语言：用唯一的原语表达一切结构化内容。**

> 状态：`0.1 草案`
> 规范：[English](GEML-spec-draft.md) · [中文](GEML-spec-draft_CN.md)

---

GEML 是一种面向结构化、富表达力文档的标记语言。`.geml` 文件**作为纯文本即可完整阅读**——无需任何渲染器。它不为每一种内容各设一套迷你语法，而是用**唯一**的构造承载全部内容：**类型块（typed block）**。

```
=== code {#hello lang=python}
print("hi")
===
```

这就是一个块。代码是块，表格、图形、公式、提示框，乃至文档元数据，也都是块。形态始终如一。

## 为什么选 GEML？

- **无需渲染即可阅读。** 没有 HTML，没有隐藏语义。你在文件里看到的*就是*文档本身。
- **一个原语承载一切。** 代码、表格、图形、公式、提示框、元数据——全是同一个类型块。没有一堆按内容划分的语法要记。
- **稳定 id，构建时校验。** 给任意块加 `#id`，在任意处引用它。断链或悬空引用是构建**错误**，而不是悄无声息的 404。
- **托管外部图形 DSL。** Mermaid、Graphviz、D2、PlantUML——GEML 把正文路由给可插拔渲染器，而绝不自创图形语言。
- **没有原始 HTML 逃逸口。** 语义不绑定任何后端或渲染器。
- **没有语法歧义。** 标题只用 ATX `#`——没有 setext、没有 `---` frontmatter 的怪规则、没有分隔线的猜测。

### Markdown vs. GEML

Markdown 很出色，GEML 也深受其惠。但 Markdown 靠*叠加*成长：每出现一种新需求就加一套语法，再加上渲染器各自的扩展，剩下的统统交给 HTML 兜底。

| | Markdown | GEML |
|---|---|---|
| 结构化内容 | 每个特性一套语法（+ HTML） | 一个类型块全包 |
| 元数据 | `---` YAML frontmatter（约定） | 原生 `=== meta` 块 |
| 引用 | 手写锚点；断链悄然失败 | `#id` 引用，**构建时校验** |
| 图形 | 围栏 + 各渲染器的魔法 | `diagram` 块托管任意 DSL |
| 原始 HTML | 常见的逃逸口 | 无——语义保持可移植 |
| 标题 | ATX *与* setext 都行 | 只用 ATX `#` |

跨 **Markdown、HTML、CommonMark、AsciiDoc、Org-mode** 的完整对照，见[格式比较](COMPARISON_CN.md)。

## 五分钟看懂格式

### 类型块

一串 `=`（≥3 个）开块，**等长**的一串 `=` 闭块。更长的围栏可嵌套在更短的之内。

```
=== note {#welcome}
这是被解析的散文。你可以在这里用 *强调* 和 `代码`。
===
```

围栏后面的词是**类型**。类型决定正文如何被读取：

| 模式 | 正文读法 | 类型 |
|------|----------|------|
| `raw` | 原样，不解析 | `code`、`diagram`、`math`、`table` |
| `flow` | 按内联标记解析的散文 | `note`、`aside` |
| `data` | 每行一个 `key=val` | `meta` |

### 属性

每个块都可携带属性对象：`{#id .class key=val}`。

- `#id` —— 文档内唯一；引用的锚点。
- `.class` —— *语义*标签，绝不作样式钩子。
- `key=val` —— 带类型的值：带引号是字符串，`true`/`false` 是布尔，数字语法是数字，其余是字符串。

### 元数据也只是一个块

```
=== meta
title = "Budget plan"
version = 0.1
===
```

### 内联标记（在 `flow` 块内）

`*强调*` · `**加重**` · `` `代码` `` · `~~删除线~~` · `$行内数学$`

- 链接：`[文字](https://example.com)`
- 内部引用：`[文字](#budget)`
- 自动引用：`[[#budget]]` —— 链接文字取自目标的 caption 或标题
- 媒体嵌入：`![alt](clip.mp4)` —— 类型（image / audio / video）按扩展名推断
- 脚注：`[^note]`

若 `#id`、`[^id]` 或跨文档引用无法解析，构建**失败**。没有悬空引用能存活。

### 表格 —— 两种正文，一个模型

可视化书写：

```
=== table {#budget caption="Annual cost"}
| Plan | Months | Rate |
|------|-------:|-----:|
| Org  |      1 |   30 |
===
```

……或写成数据形态，带**计算列**：

```
=== table {#budget format=csv compute="Total = Months * Rate"}
Plan, Months, Rate
Org,  1,      30
===
```

`compute` 支持对各列（按表头名或列字母）做 `+ - * / ( )` 运算，以及聚合 `sum / avg / min / max / count`。合并单元格用 `span="r2c1:2x1"`。两种形态描述的是同一个表格模型。

### 图形 —— 自带 DSL

GEML 绝不解释图形正文，只把它路由给可插拔渲染器。未知 `format` 是告警，正文原样保留。

```
=== diagram {#flow format=mermaid caption="Review flow"}
graph LR
  A[Draft] --> B{Review} -->|ok| C[Publish]
===
```

### 数学

```
=== math {#steady caption="Steady state"}
y^* = a / k
===
```

## 为 AI 与智能体而生

GEML 对 LLM 和自动化工具异常友好——不是靠加什么 AI 特性，而是源于格式本身的形态。

- **纯文本，零渲染。** 模型直接读写 `.geml`。它看到的就是文档——没有需要还原的渲染层。
- **唯一统一原语。** 不像 Markdown 那一堆特例，这里只有一种块形态。生成或解析正确的歧义少得多，畸形输出的边界情况也少得多。
- **构建时引用校验。** 当智能体写出断链或留下悬空 id，工具链会把它当作硬错误抓出来——于是自动化编辑是可靠的，而不是悄悄腐烂。
- **结构化内容留在文本模态内。** 表格、数学、图形、元数据既是一等公民、又仍是纯文本，智能体无需离开文本、也无需输出 HTML 就能操作它们。
- **可被机器校验的反馈。** 参考解析器输出带 `diagnostics` 的文档模型 JSON，智能体与 CI 都能拿到结构化的通过/失败信号。

## 版本化且自包含：`.gemlhistory`

配套规范——[`GEML-history-spec.md`](GEML-history-spec.md)——为文档加上完整版本历史，**无需 git、也无需任何在线服务**。

- **`.geml` 只保存当前版本** —— 热路径始终小而干净，无论历史长到多大。同基名的伴生文件 `doc.gemlhistory` 保存历史 —— 冷路径，仅在需要时加载。
- 历史以**自当前版本向回的逆向增量**加上周期性全量**关键帧**快照来存储。它是**自包含**的：始终携带一份由工具维护、镜像已提交当前版的关键帧。
- 因此仅凭历史文件就能**还原任意历史修订**或**把活动文件回滚**——离线、无 git、无服务。历史作为纯文本伴生文件随文档同行，经得起复制与转发，且自我描述。
- **SHA-256** 内容哈希保证完整性，修订 id 可按时间排序（`<时间戳>-<短哈希>`）。
- **优雅降级。** 万一历史文件丢失，当前文档仍完整保存在 `.geml` 中。
- **AI 可读。** 历史是纯文本、按块寻址、每条修订带人类可读的 `summary`，智能体可读它来理解文档*如何以及为何*演变。（智能体应调用历史**工具**来提交、还原、校验或回滚，而不是手写补丁或哈希。）
- **不增加新语法。** 版本化骑在同一个类型块原语之上；普通 GEML 工具照样能渲染 `.geml`。

## 参考解析器与 CLI

可用的参考解析器与 CLI 位于 [`geml-parser/`](geml-parser/)——TypeScript，Node 22。它覆盖规范 §3–§8，并附带 31 项检查的测试集（含一个元素丰富的 kitchen-sink fixture 与一份真实世界的 Markdown 文档）。

```sh
cd geml-parser
npm install
npm run build
node dist/geml.js ../GEML-spec-draft.geml      # 解析 → 文档模型 JSON
node dist/geml.js convert ../some.md -o out.geml
npm test
```

`node dist/geml.js <file.geml>` 把文档解析为**文档模型 JSON**，若有错误则以非零码退出。

### Markdown → GEML 转换

已经有 Markdown？转过来：

```sh
node dist/geml.js convert <file.md> [-o out.geml]
```

转换器的映射：

- YAML frontmatter → `=== meta`
- 围栏代码 → `=== code {lang=…}`
- ` ```mermaid / graphviz / dot / d2 / plantuml ` → `=== diagram {format=…}`
- `$$…$$` → `=== math`
- `>` 引用 → `=== note`
- GFM 表格 → `=== table`
- 脚注定义 `[^id]:` → `=== note {#id}`
- autolink `<url>` → `[url](url)`
- setext 标题 → ATX

它会给转换出的类型块自动分配 `#type-N` id，按文件扩展名推断媒体 `as`，并丢弃分隔线（非 GEML 构造）。

### 历史 CLI

```sh
geml history <commit | verify | show | restore> <file.geml>
```

## 状态与规范

GEML 目前是 **`0.1 草案`**。格式已稳定到足以书写真实文档——本仓库的规范自身就是用 GEML 写的——但在 1.0 之前仍会有所打磨。

| 文档 | English | 中文 |
|------|---------|------|
| 核心规范 | [`GEML-spec-draft.md`](GEML-spec-draft.md) | [`GEML-spec-draft_CN.md`](GEML-spec-draft_CN.md) |
| 历史扩展 | [`GEML-history-spec.md`](GEML-history-spec.md) | [`GEML-history-spec_CN.md`](GEML-history-spec_CN.md) |

**Dogfood：** [`GEML-spec-draft.geml`](GEML-spec-draft.geml) 是用 GEML 自身写就的规范，[`GEML-spec-draft.gemlhistory`](GEML-spec-draft.gemlhistory) 是历史格式的样例。一致性由参考解析器的测试集（`npm test`）来检验。

## 仓库结构

```
GEML-spec-draft.md          核心规范（English）
GEML-spec-draft_CN.md        核心规范（中文）
GEML-history-spec.md         .gemlhistory 扩展（English）
GEML-history-spec_CN.md      .gemlhistory 扩展（中文）
GEML-spec-draft.geml         用 GEML 写就的规范（dogfood）
GEML-spec-draft.gemlhistory  历史格式样例
COMPARISON.md                GEML 与其他标记格式的比较
geml-parser/                 参考解析器 + CLI（TypeScript，Node 22）
```

## 许可

MIT。
