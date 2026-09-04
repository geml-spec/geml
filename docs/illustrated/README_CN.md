# GEML 图解

*[English](README.md) | 中文*

每个 block 类型、每个 profile、以及 CLI 各一页。每页开头是**决策看板**（每条规则一行：
规则、出处、状态），中间每个情形一张图版（左边 GEML 语法，右边处理器的实际输出：
`geml check` 的诊断、`geml list` 的地址、`--to html` 的标签），末尾是**依据**（探针
文件与实测结果）。

状态四种：**规范已定**（规范正文或已接受的 GEP 写死）、**GEP 草案**（提案定义、可能已
实现、规范未收）、**实测**（规范不规定、参考实现今天这样做）、**实现偏差**（规范这样说，
参考实现不这样做——待修清单就从这里读）。另有**草案缺口**，标草案该说而没说的。

页面是自包含 HTML，中英两版（`X.html` 英文，`X_CN.html` 中文），直接用浏览器打开；
也发布为 claude.ai artifact 方便在手机上看。

## 块类型

| # | 覆盖 | English | 中文 | 状态 |
|---|---|---|---|---|
| 1 | 共同围栏与属性规则 · `meta` · `math` · `note` · `text` | [01-simple-blocks.html](01-simple-blocks.html) | [中文](01-simple-blocks_CN.html) | 已写，实测 geml 1.9.2 本地构建 |
| 2 | `code` · `data`，一套 `src=` 路由 | [02-code-data.html](02-code-data.html) | [中文](02-code-data_CN.html) | 已写 |
| 3 | `table`，以及 GEP-0012 的 `view` | [03-table-view.html](03-table-view.html) | [中文](03-table-view_CN.html) | 已写 |
| 4 | `diagram`：外部 DSL、`geml-chart`、`geml-code-graph` | [04-diagram.html](04-diagram.html) | [中文](04-diagram_CN.html) | 已写 |
| 5 | `embed`：块级与行内投影、翻译 | [05-embed.html](05-embed.html) | [中文](05-embed_CN.html) | 已写 |

## form 提案、CLI 与各 profile

| # | 覆盖 | English | 中文 | 状态 |
|---|---|---|---|---|
| 6 | `form` 与 `form-*` 家族（GEP-0008，草案）及 `geml-form/v1` profile | [06-form.html](06-form.html) | [中文](06-form_CN.html) | 已写（评审定下的 15 项决定） |
| 7 | `geml` CLI：每个动词、地址形式、退出码 | [07-cli.html](07-cli.html) | [中文](07-cli_CN.html) | 已写；每个动词对同一份探针文档实跑 |
| 8 | `geml-history/v1` 与 `.gemlhistory` | [08-profile-history.html](08-profile-history.html) | [中文](08-profile-history_CN.html) | 已写；save/set/save 一轮生成的真实边车 |
| 9 | `geml-codemap/v1` | [09-profile-codemap.html](09-profile-codemap.html) | [中文](09-profile-codemap_CN.html) | 已写；playground/codemap verify 35/35 |
| 10 | `geml-style/v1` | [10-profile-style.html](10-profile-style.html) | [中文](10-profile-style_CN.html) | 已写；干净 + 写坏两份样式表，跑出 12 条诊断中的 10 条 |
| 11 | `geml-translator/v1`（GEP-0010） | [11-profile-translator.html](11-profile-translator.html) | [中文](11-profile-translator_CN.html) | 已写；一条文档缺口（见下） |

## 已发现的实现偏差

| 页 · 看板 | 规范 | geml 1.9.2 实际 |
|---|---|---|
| 1 · 11 | 两个以上 `meta` 时别的块声明 `{#meta}` 是 `reserved-id` error（§4，A.2） | 零诊断通过 |
| 1 · 19 | `![[#id]]` 指向多段 `text` 是 `inline-transclusion-not-inline` error（§5.2） | 报了该 error，另多报一条不成立的 `transclusion-cycle` |

## 已发现的草案缺口

| 页 · 看板 | 草案 | 缺口 |
|---|---|---|
| 3 · 18，4 · 15 | GEP-0012（`view`） | 一处未提图表；compute 搬到 view 后，`geml-chart` 的 `data=` 需接受 view，否则画计算列的图没有数据源 |
| 5 · 行内 | GEP-0011（坐标） | 说穿过 embed 的坐标应「报出能用的地址」，实测消息解释了原因但没给地址 |
| 3 · 18（追加） | GEP-0012（`view`） | `src=` 只接 csv/tsv 文件、table、另一个 view；record-array 的 `data` 块、`.json`/`.jsonl` 文件（§7.1 里对 chart 已经算关系）和指向值树的 GEP-0011 坐标（`#cfg["items"]`）都没提。需要一条归一化规则（键按首次出现顺序变列、缺键与 `null` 为空格、非标量 → `data-not-records`），让 chart 或第二个 view 分不出源是什么 |

## 已发现的文档缺口

| 页 · 看板 | 该有 | 实际 |
|---|---|---|
| 11 · 10 | `spec/profiles/geml-translator/` 的 profile 文档和 `spec/profiles/README.md` 的索引行，因为 profile 已在 `profiles.ts` 注册 | 只有注册和 GEP-0010 正文；README 说的「索引表和注册表是同一张表说两遍」已不成立 |

修掉一条就把对应页的状态改回去。
