# GEML 与其他标记格式的比较

*[English](COMPARISON.md) | 中文*

GEML 与 **Markdown**（GitHub 风格）、**HTML**、**CommonMark**（严格核心）、
**AsciiDoc**、**Org-mode**、**Pandoc Markdown** 的对照。

关于 Pandoc：它本质是一个*转换器*，外加它自带的 **Pandoc Markdown**——功能最全的
Markdown 方言。它的属性写法 `{#id .class key=val}` 其实正是 GEML 那套的源头。Pandoc
自身的杀手锏——多格式互转与可编程 **Lua 过滤器**——属于和下面"逐元素对照"不同的维度。

关于定位的说明：这**不是**一场打勾竞赛。尤其是 AsciiDoc，单格式开箱即用的元素比
GEML 还多。GEML 的立论靠的是这里**没有别的格式同时具备**的三件事——本比较意在让它们
可见，而非比拼功能数量：

1. **单一原语承载每一种结构化块** —— 学习、解析、尤其*生成*的语法面最小（这正是它对
   AI 友好的原因）。
2. **构建时引用校验** —— 断链是错误，而不是悄无声息的死链。
3. **自包含版本历史**（`.gemlhistory`）—— 无需 git、也无需任何在线服务。

图例：✓ 原生 · ◐ 靠扩展/约定 · ✗ 无 · *(H)* 需借原始 HTML。

## 能力矩阵

| 元素 / 能力 | GEML | Markdown (GFM) | HTML | CommonMark | AsciiDoc | Org-mode | Pandoc Markdown |
|---|---|---|---|---|---|---|---|
| 标题 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 粗体 / 斜体 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 行内代码 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 代码块（带语言） | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ |
| 列表 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 链接 / 图片 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 音频 / 视频嵌入 | ✓ | ✗ *(H)* | ✓ | ✗ | ✓ | ◐ | ✗ *(H)* |
| 表格 | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ |
| 数据表 / 计算列 | ✓ | ✗ | ✗ | ✗ | ◐ csv | ◐ 公式 | ✗ |
| 提示框 / admonition | ✓ | ◐ alert | ◐ | ✗ | ✓ | ◐ | ◐ 围栏 div |
| 脚注 | ✓ | ✓ | ◐ | ✗ | ✓ | ✓ | ✓ |
| 描述/定义列表 | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ |
| 上标/下标、行内 span | ✗ | ✗ | ✓ | ✗ | ✓ | ◐ | ✓ |
| 数学（行内 / 块级） | ✓ | ◐ | ◐ | ✗ | ✓ | ✓ | ✓ |
| 图形（托管 DSL） | ✓ | ◐ mermaid | ✗ | ✗ | ✓ | ✓ | ◐ 过滤器 |
| 引用文献 / 参考书目 | ✗ | ✗ | ✗ | ✗ | ◐ | ✓ | ✓ |
| 文档元数据 | ✓ 原生块 | ◐ frontmatter | ✓ | ✗ | ✓ | ✓ | ✓ |
| 块 id + 交叉引用 | ✓ | ◐ 仅标题 | ✓ | ◐ | ✓ | ✓ | ✓ |
| **构建时引用校验** | ✓ 报错 | ✗ | ✗ | ✗ | ✓ 告警 | ◐ | ✗ |
| 原始 HTML 逃逸口 | ✗ *(刻意)* | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| 纯文本可读（免渲染） | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| 可编程过滤器 / 宏 | ✗ *(刻意)* | ✗ | ✗ | ✗ | ◐ | ✓ | ✓ Lua |
| **单一原语统一所有块** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **自包含版本历史** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

加粗的三行是 GEML 的真正差异化。「原始 HTML = ✗」是特性而非缺失：它让语义保持可移植、
不绑定任何后端。Pandoc Markdown 是这里最宽的一列——它多了引用文献、定义列表、Lua
过滤器——但依然没有"单一原语、构建时校验、自包含历史"这三样。

## 并排语法

### 代码块

```
GEML        === code {#hello lang=python}
            print("hi")
            ===
Markdown    ```python
            print("hi")
            ```
HTML        <pre><code class="language-python">print("hi")</code></pre>
CommonMark  ```python
            print("hi")
            ```
AsciiDoc    [source,python]
            ----
            print("hi")
            ----
Org-mode    #+begin_src python
            print("hi")
            #+end_src
Pandoc      ```{.python}
            print("hi")
            ```
```

### 文档元数据

```
GEML        === meta
            title = "Budget plan"
            ===
Markdown    ---                 (YAML frontmatter —— 仅约定，非规范)
            title: Budget plan
            ---
HTML        <meta name="title" content="Budget plan">
CommonMark  （无机制）
AsciiDoc    = Budget plan
            :version: 0.1
Org-mode    #+TITLE: Budget plan
Pandoc      ---                 (YAML 元数据块 —— 一等公民)
            title: Budget plan
            ---
```

### 提示框 / Admonition

```
GEML        === note {#risks}
            供应商锁定是主要风险。
            ===
Markdown    > [!NOTE]            (GitHub 扩展)
            > 供应商锁定是主要风险。
HTML        <div class="note">供应商锁定是主要风险。</div>
CommonMark  （无机制 —— 只有普通引用块）
AsciiDoc    [NOTE]
            ====
            供应商锁定是主要风险。
            ====
Org-mode    （无标准 —— 特殊块，依赖导出后端）
Pandoc      ::: {.note}
            供应商锁定是主要风险。
            :::
```

### 交叉引用，以及是否被校验

```
GEML        见 [[#budget]]          → #budget 不存在 ⇒ 构建“错误”
Markdown    见 [budget](#budget)    → 断链静默通过
HTML        见 <a href="#budget">…  → 不校验
CommonMark  见 [budget](#budget)    → 不校验
AsciiDoc    见 <<budget>>           → 处理器对未解析 xref 告警
Org-mode    见 [[budget]]           → 导出时部分校验
Pandoc      见 [budget](#budget)    → 不校验（xref 靠 pandoc-crossref 过滤器）
```

### 带计算列的表格（GEML 独有）

```
GEML        === table {#fy25 format=csv header=1
              compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4"
              summary="Segment = 'Total'; FY = sum(FY)"}
            Segment, Q1, Q2, Q3, Q4
            Cloud,   1,  2,  3,  4
            ===                       → 逐行 FY 列 + 一行 Total 汇总行，
                                        FY 保留 1 位小数
Org-mode    | Segment | Q1 | Q2 | Q3 | Q4 | FY |
            |---------+----+----+----+----+----|
            #+TBLFM: $6=$2+$3+$4+$5    (灵感来源——但它是完整电子表格：单元格
                                        引用、remote()、Emacs Lisp。GEML 只取
                                        受限的列公式子集)
其他格式      仅静态表格 —— 无计算
```

### 图形（托管外部 DSL）

```
GEML        === diagram {#flow format=mermaid}
            graph LR
              A --> B
            ===
Markdown    ```mermaid             (GitHub 渲染；无 id/caption/校验)
            graph LR
              A --> B
            ```
AsciiDoc    [mermaid]
            ----
            graph LR
              A --> B
            ----
Org-mode    #+begin_src plantuml :file out.png
            ...
            #+end_src
Pandoc      ```{.mermaid}          (靠过滤器渲染，如 mermaid-filter)
            graph LR
              A --> B
            ```
HTML/CMark  无原生图形托管
```

### 绑定数据表的图表（GEML 独有）

```
GEML        === diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY}
            ===                       → 把表 #fy25 渲染成图表；列引用受校验
其他格式      手抄数据进图表库，或用电子表格 App —— 无链接
```

## 唯有 GEML 做到的

上面每种格式都能渲染一个标题和一个代码块。差别在于：当*整篇文档*经历变更与自动化时，
会发生什么——

- **单一类型块**承载代码、表格、图形、数学、提示框与元数据——于是只有一套语法要学，
  工具（或 LLM）也只需正确产出一套语法，而不是每个特性一套语法外加 HTML 兜底。
- **引用在构建时校验。** 无法解析的 `#id` 会让构建失败。断链不会像在 Markdown/HTML
  里那样悄悄腐烂。
- **历史自包含。** 伴生的 `.gemlhistory` 文件能还原任意历史修订、把文档回滚——离线、
  无 git、无在线服务。见[历史扩展](GEML-history-spec_CN.md)。

Pandoc 玩的是另一个游戏——它是通用*转换器*，也是抵达 `docx`/`latex`/`epub` 最实用的
路径。GEML 自然的未来是*接入*这个生态（做一个 Pandoc reader/writer），而非与之竞争。

完整格式见[核心规范](GEML-spec_CN.md)，快速上手见 [README](README_CN.md)。
