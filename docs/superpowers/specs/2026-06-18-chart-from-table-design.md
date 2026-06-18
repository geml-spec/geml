# 设计：图表引用数据表（chart-from-table）

> 状态：草案 · 日期：2026-06-18 · 关联：GEML §6 表格、§7 图形

## 1. 目标与动机

让一个 `diagram` 能**引用一张 `table`**并把它画成图表，核心价值是
**单一真相（single source of truth）**：图表不再手抄数据，而是绑定到已有的表；
表改了，图自动跟着变。次级收益是这个绑定走 GEML 的**引用校验**层——悬空的表 id
或写错的列名在**构建期报错**，不会悄悄烂掉。

非目标：把 GEML 做成通用可视化语言。原生只覆盖少数常见图；复杂图退到外部 DSL。

## 2. 关键决策（含取舍）

1. **单一真相优先**：图通过 `data=#id` 绑定到表，而不是内联复制数据。
2. **hybrid**：常见图用 GEML 原生、可校验；长尾/复杂图退外部 DSL。
3. **`format` 只选渲染器**，绝不承载图表种类。`bar/line/pie` 不进 `format`。
4. **一个块、一个渲染器**：不新增 `chart` 块型；`geml-chart` 是 `diagram` 下的一个
   内置可插拔渲染器，和 `mermaid`/`graphviz`/`d2` 并列。
5. **图谱写在属性里、body 留空**：简单图的映射（type/x/y/…）是 GEML 属性，处理器
   本就解析属性（§4），因此能校验——而 §7「MUST NOT interpret the body」**完全不动**。
6. **封闭的编码通道集**：`type` 只改画法，绝不为每种图新增专属属性。
7. **`data=#id` 是新的受校验引用属性**，处理器解析后把表模型喂给渲染器；纯增量。

## 3. 块形态

### 3.1 原生图（`geml-chart`，属性即图谱，body 留空）

```
=== diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY caption="FY 营收"}
===
```

- `format=geml-chart` —— 渲染器（内置）。
- `data=#fy25` —— 受校验引用，指向一张表。
- `type` —— 图表种类（见 §4 通道映射）。
- `x`/`y`/… —— 编码通道（见 §4）。
- body 为空；写了 body 给 **warning**（原生图谱在属性里，body 被忽略）。

### 3.2 DSL 逃逸（复杂图）

```
=== diagram {#rev2 format=vega-lite data=#fy25 caption="..."}
{ "mark": "boxplot", ... 引用注入的数据 ... }
===
```

- 同样用 `data=#id` 注入数据；body 是外部 DSL，**处理器不解释、不校验列名**。
- 这是诚实的逃生舱：拿到单一真相的数据绑定，放弃原生校验。

## 4. 编码通道（封闭集合）

借鉴图形语法，砍到最小。`geml-chart` 只认这一组通道，**所有 type 复用同一组**：

| 通道 | 含义 | 可选性 |
|---|---|---|
| `x` | 类目/横轴 | 必填 |
| `y` | 数值；可单列，或列表（列表即多系列） | 必填 |
| `series` | 按某列分组成多系列（长表数据） | 可选 |
| `size` | 气泡大小（散点） | 可选 |

`type` 只决定如何解读这组通道，**不引入新属性**：

| `type` | 用法 |
|---|---|
| `bar` | x=类目，y=值（或列表=分组/堆叠柱） |
| `line` / `area` | x=类目，y=值（或列表=多条线） |
| `pie` | x=扇区类目，y=扇区大小（复用 x/y，零新属性） |
| `scatter` | x=值，y=值，可选 size、series |

多系列两种写法：
- **宽表**：`y="Q1,Q2,Q3,Q4"`（每列一条系列）。
- **长表**：`series=部门 y=营收`。

**边界规则**：
- 通道集封闭（仅 `x/y/series/size`），不因新增 type 而增长。
- type 用不到的通道（如 pie 给 `size`）→ **warning**，忽略。
- 需要 bespoke 通道（热力图颜色值、箱线图分布、地图、桑基图…）→ 退 `format=vega-lite`。

## 5. 数据绑定：`data=#id` 如何喂给渲染器

职责切分：**处理器负责解析 + 校验 + 归一化；渲染器只负责画。** `geml-chart` 与
外部 DSL 共用同一套数据注入。

1. **解析**：`data=#fy25` 解析成 §6 的 `TableModel`（列 + 数据行 + 汇总行），与
   `[[#id]]` 同一套引用解析。
2. **范围**：默认喂**数据行**，且**计算列已算好**（FY、YoY 作为普通列存在）——
   图表可直接画计算列。
3. **取值**：x 类目取单元格**文本**（如 `Cloud`）；y/size 取单元格**数值 `.value`**
   （不是带 `[printf]` 格式的显示文本）。
4. **归一化产物**：`{columns, rows: 数值}` + 通道属性，交给渲染器。
   - `geml-chart`（内置）：按通道直接画。
   - DSL 逃逸：把同一份数据集注入成该 DSL 的数据输入（如 Vega-Lite 的
     `data.values`）；注入机制每个渲染器自定，处理器只保证数据送达。

### 5.1 汇总行：`rows` 选哪些行进图

数据绑定层属性（**不算进通道集**），一个枚举三个值：

| `rows` | 含义 | 场景 |
|---|---|---|
| `data`（默认） | 只画数据行，排除汇总行 | 部门营收对比、占比饼 |
| `all` | 数据行 + 汇总行作为额外一个数据点 | 各部门后多一根 Total 柱 |
| `summary` | 只画汇总行 | 用汇总行 Q1–Q4 合计画各季度总营收 |

- `rows=all` 时，额外点的 x 标签复用汇总行的标签单元格（`Segment = 'Total'`）。
- `rows=summary` 配宽表很顺：
  ```
  === diagram {format=geml-chart data=#fy25 type=bar rows=summary x=Segment y="Q1,Q2,Q3,Q4"}
  ===
  ```
  一行 + y 列表 → Q1–Q4 四根「季度总计」柱。
- 标注类需求（把总计当参考线/目标线叠加）**不进原生**，退 `format=vega-lite`。

## 6. 错误用例（构建期诊断）

内置 `geml-chart` 是「受信格式」，处理器**校验其属性**（属性校验，非解释 body，
§7 body 规则不动）。外部 DSL 格式只校验 `data=#id` 可解析，body 内列名不看。

| 情况 | 级别 | 说明 |
|---|---|---|
| `data=#id` 悬空 | **error** | 与其它引用一致 |
| `data=#id` 指向非 table | **error** | 数据源必须是表 |
| `x`/`y` 列不存在 | **error** | 对照表列名校验，可带 did-you-mean |
| 必填通道缺失（bar 无 y） | **error** | type 声明所需通道 |
| y/size 列含非数值 | **error** | 指到具体行；空值按跳过该点处理 |
| 通道用错（pie 给 size） | **warning** | 忽略但告警 |
| 未知 `type` | **error** | 列出内置类型，提示退 vega-lite |
| `format=geml-chart` 写了 body | **warning** | body 被忽略 |
| 无汇总行却 `rows=summary` | **error** | 没东西可画 |
| 无汇总行却 `rows=all` | **warning** | 退化成只画数据行 |

## 7. 规范改动（§7 纯增量）

§7 新增一段，大意：

> 块可声明 `data=#id`。处理器**必须解析**该引用（悬空即 **error**），并把被引
> `table` 的模型作为数据提供给渲染器。处理器仍**不解释 body**。内置数据感知渲染器
> （如 `geml-chart`）的**属性**（`type`/`x`/`y`/`series`/`size`/`rows`）由处理器
> 校验；外部 DSL 渲染器的 body 保持 raw、不校验。

`geml-chart` 登记进渲染器注册表，与 `mermaid` 等并列。`format` 语义不变。

## 8. 完整示例

```
=== table {#fy25 caption="FY2025 各部门营收（$M）" format=csv header=1 compute="FY [%.1f] = Q1 + Q2 + Q3 + Q4" summary="Segment = 'Total'; Q1 = sum(Q1); Q2 = sum(Q2); Q3 = sum(Q3); Q4 = sum(Q4); FY = sum(FY)"}
Segment,   Q1,    Q2,    Q3,    Q4
Cloud,     124.5, 131.2, 142.8, 158.3
Hardware,  88.1,  84.6,  90.3,  95.7
Services,  45.2,  47.8,  49.1,  52.6
===

=== diagram {#rev-bar  format=geml-chart data=#fy25 type=bar  x=Segment y=FY caption="各部门全年营收"}
===
=== diagram {#rev-pie  format=geml-chart data=#fy25 type=pie  x=Segment y=FY caption="营收占比"}
===
=== diagram {#rev-line format=geml-chart data=#fy25 type=line x=Segment y="Q1,Q2,Q3,Q4" caption="各部门季度走势"}
===
=== diagram {#rev-qtot format=geml-chart data=#fy25 type=bar rows=summary x=Segment y="Q1,Q2,Q3,Q4" caption="各季度总营收"}
===
```

## 9. 范围之外 / 未来

- `include-summary` 之外更细的行筛选/过滤、排序：暂不做（YAGNI）。
- 标注/参考线/双轴/组合图：退 DSL，不进原生。
- tooltip 显示带 `[printf]` 格式的文本：渲染器细节，可后置。
- 跨文档 `data=other.geml#id`：沿用既有跨文档引用规则，后续确认。

## 10. 实施面（供 writing-plans 展开）

- 规范文档：`GEML-spec-draft.md` / `_CN` §7 增量；`COMPARISON(.md/_CN)`、
  `README(.md/_CN)` 同步；`GEML-spec-draft.geml` dogfood 加示例。
- 参考解析器：渲染器注册表加 `geml-chart`；实现 `data=#id` 解析 + 列校验 +
  数据归一化 + `rows` 范围；诊断按 §6 表输出；新增测试。
- 校验时机与 §6 计算列一致：构建期 error/warning。
