# geml-style —— 一个不改动 GEML 规范的应用层样式 profile

- 日期：2026-08-29
- 状态：设计稿（brainstorm 产出，尚未立 GEP）；**2026-09-09 增补 §12** —— 第一个文档布局用例
  （用 viewer 渲染出 GitHub 的 blob 页）把 profile §0.1 里"specified, checked, and unexercised"
  的那一栏全部拉进了真实使用，并改动了 §3.2 / §4.3 / §5.1 / §5.4 / §5.6 / §7 各一处；
  **2026-09-10 增补 §13** —— 第二个用例（外壳归位）把 §12.3 圈死的清单再动一次
- 目标：让 `.geml` 文档能被渲染成组件化、可交互的 webapp 界面，而 **GEML 1.0 规范一个字不动**
- **词汇表在别处**：本文是*为什么*。落地后的完整词汇、属性表、诊断目录与视图模型见
  [`spec/profiles/geml-style/geml-style-profile_CN.md`](../../../spec/profiles/geml-style/geml-style-profile_CN.md)
  —— 那份跟着实现走，本文停在设计当时。

---

## 1. 摘要

`geml-style` 是一个**应用层 profile**——和 `codemap` 同级，"the way schema.org relates to HTML"。
它定义四个带连字符的块类型（`style-rule` / `style-state` / `style-screen` / `style-frame`，
最后一个是 §12 增补的），把文档里的 block 映射到宿主应用提供的 UI 组件上，
并声明一套**闭合的、无环的**跨块联动。

三条贯穿全文的原则：

1. **内容文档不被修改。** 样式表用选择器*选中*内容，而不是模板*包裹*内容。
   这样机器生成、作者改不动的文档（codemap 输出是典型）也能被样式化。
2. **样式表里永远没有 script。** 组件和能力**只报名字**，实现由宿主提供——
   与 `diagram {format=mermaid}` 的注册表模式完全同构。
3. **歧义是构建错误，不是静默兜底。** 没有 CSS 特异性算术、没有 `!important`、没有源序兜底。

---

## 2. 一个完整的例子：给 codemap 加主从视图

这是理解整个设计最快的路径。三个文件，各写各的。

### 2.1 内容文档 —— codemap 的输出，一个字不改

`.geml-code-graph/geml-parser--core.geml`，由 `geml codemap build` 生成：

```
=== code {#renderHtml src=render-html.ts#L90-110 anchor="ts:render-html.ts#renderHtml(...)"}
===

=== code {#esc .leaf src=render.ts#L66-72 anchor="ts:render.ts#esc(string)"}
===

=== table {#calls schema="from, to, kind, confidence"}
...
===
```

### 2.2 样式表 —— 新写的，一共四个块

`app/codemap.style.geml`：

```
=== meta
profile = "geml-style/v1"
===

=== style-state {#sel type=block-ref match="table#calls" on=select value-from=to}
===

=== style-rule {#edges match="table#calls" component=edge-list selectable}
===

=== style-rule {#methods match="code[anchor]" component=method-card}
===

=== style-rule {#leaves match="code.leaf[anchor]" collapsed badge="leaf"}
===

=== style-screen {#overview layout=split slots="table#calls, $sel"}
===
```

（`layout=` 自 §12.4 起写作 `component=`，`split` 也可直接用内含词 `axis=row` 表达；
例子保留设计当时的写法。）

### 2.3 宿主应用 —— TSX

```tsx
<GemlScreen
  id="overview"
  doc={codemapDoc}
  style={codemapStyle}
  components={{ 'edge-list': EdgeList, 'method-card': MethodCard }}
/>
```

### 2.4 结果

点 `#calls` 表里一行 → `$sel` 变成那行 `to` 列的值 → 详情区显示对应的方法块。
`code.leaf[anchor]` 比 `code[anchor]` 更特定，所以叶子方法在继承 `component=method-card`
的同时额外拿到 `collapsed` 和 badge。

**注意 2.1 里一个字符都没有为样式而改。**

---

## 3. 文件模型

### 3.1 不引入新文件类型

样式表就是一份**普通的 `.geml` 文档**，靠 `meta` 声明身份：

```
=== meta
profile = "geml-style/v1"
===
```

这样 vscode / tree-sitter / obsidian / logseq / viewer / `.gemlhistory` hook / `geml check`
**全部零改动可用**。codemap 走的就是这条路（它的产物全是 `.geml`）。

`profile` 取**空格分隔的列表**（`profile = "codemap/v1 geml-style/v1"`），
因为 §4 明确 "Arrays, dates and nested tables are not supported"，
而空格分隔列表在本仓库已是既有惯例（codemap 的 `entry` 键）。

- **键名是 `profile` 而不是 `style`**：这个机制要同时服务 codemap，
  `style = "codemap/v1"` 是胡话。键描述*机制*，值描述*是哪一套*。
- **多 profile 的语义是并集，检查层不存在冲突**：属性校验只问"这个键允许吗"，
  不问"它是什么意思"。含义由各自的消费工具解释。因此 v1 **不需要任何冲突消解机制**。

### 3.2 三个块类型，信息全放属性对象

| 类型 | 职责 |
|---|---|
| `style-rule` | 选择器 → 组件映射、参数、能力绑定 |
| `style-state` | 一格视图状态 + 它的产生者 |
| `style-screen` | 一页：根，槽位按 `axis=` 排布 |
| `style-frame` | 页内的一块区域：只能被槽位引用，可以再装区域（§12.4） |

**body 一律为空，全部信息写在属性对象里。** 因为 §3 规定未注册类型的 body
"preserved as raw"——核心 parser 不解析它，放进去的结构就检查不了。
而属性对象**对任何类型都会被核心解析**。属性过长用 §4 的 `\` 续行。

已验证（`geml check` + `--to json`）：未注册类型的属性被完整解析并按 §4 定型
（`sortable` → boolean，`match` → string），`#id` 进入文档的 `ids` 表，
`geml list` / `geml get '#id'` 精确寻址。**block 级编辑、`.gemlhistory` 版本化、
`geml revert` 全部白送。**

**设计令牌不发明新类型**，复用已有的 `data` 块（§3.2 / GEP-0005）。

### 3.3 一个可选的工具侧改动

当前每个 `style-rule` 会产生一条 `unknown-block-type` warning（实测确认）。
50 条规则 = 50 条 warning，会训练人忽略 warning。

建议 `geml check` 读到 `profile` 键后加载对应词汇表，使这些类型不再算 unknown。
**这不是改规范**——§8.5 明写 "The type registry (§3) is **open**"，
§8.2(6) 约束的是处理器*不认识*的类型。

**它同时修掉一处既有泄漏。** [`geml.ts:672`](../../../geml-parser/src/geml.ts) 现状：

```ts
// `src`/`anchor` on a `code` block are the code-graph profile's …
else if (type === "code") validRe = /^(lang|src|anchor|name|entry-via)$/;
```

codemap 的 profile 词汇被硬编码进了核心 parser。后果实测确认：
`anchor=` / `entry-via=` 在**任何文档的任何 `code` 块**上都静默通过，
只有拼错的 `ancohr=` 被抓。也就是**全世界每份 GEML 文档都永久让出了这三个键的拼写检查**。
更严重的是 §8.4 一致性面被污染：第二实现要么复刻 codemap 词汇表，要么报出参考实现不报的 warning。

**这个改动是可选的、可延后的**，不做样式表照样能跑。

---

## 4. 选择器与冲突消解

### 4.1 语法

简单选择器 = 对单个 block 的一组合取条件，词汇全部来自 §4：

```
<type>?  (.class)*  (#id)?  ([key] | [key=val])*
```

```
table                    任意表格
table.kpi                带 .kpi 类的表格
#budget                  id 为 budget 的块
code[anchor]             codemap 的方法块
code.leaf[anchor]        codemap 的叶子方法
```

`[key]` 测存在，`[key=val]` 测相等。**不提供 `^=` `*=` `~=`**——
它们会把选择器变成一门小语言，而 §4 的值定型已够表达意图。

`match` 可写逗号列表，那是**纯语法糖**，等价于 N 条同体规则，优先级按分支各算各的。

### 4.2 唯一的组合子：后代

```
#api table.kpi           #api 这一节里的任意 table.kpi
```

**为什么需要**：内容常常是机器生成、样式作者改不动的。选择器必须够到内容自己没标注的东西，
否则整个"内容不被修改"的立场在最重要的场景里失效。

**为什么只有它**：`>` `+` `~` `:nth-child` 全部依赖精确文档顺序，对生成内容极脆弱，
且正是 CSS 里最常被写错的部分。

后代关系**不需要新定义**：§3 已规定标题片段
"selects the heading's whole section (the heading itself and all subsequent blocks
up to, but not including, the next heading of the same or higher level, or the end
of the document)"；加上 flow block 的 body 嵌套，一条组合子全覆盖。

### 4.3 合并与冲突

**默认按属性合并。** 多条规则命中同一 block 但设置**不同**属性 → 并集。
这让"基础规则 + 修饰规则"成为可能（见 §2.2 的 `#methods` / `#leaves`）。

**同一属性被多条规则设置时**，优先级是**按子集的偏序**，没有权重、没有算术：

> A 比 B 更特定 ⟺ A 的条件集是 B 的**真超集**

一条规则的**条件集** = 选择器的各项合取条件 + `screen=`（§5.5）+ `when=`（§12.5）。
后两者都是作为普通条件进入这个集合的，所以下面三种情况对它们同样成立，不另设裁决。

三种情况：

| | 情况 | 处理 |
|---|---|---|
| 1 | `A ⊃ B` 真超集 | A 赢 |
| 2 | `A = B` 条件集相同 | **`ambiguous-rule` 错误** |
| 3 | `A ⊄ B` 且 `B ⊄ A`（不可比） | **`ambiguous-rule` 错误** |

**情况 2 必须报错**：两条规则对完全相同的集合说相反的话，没有第三条规则能比它俩都特定。
形状等同于 §4 的 `duplicate-id`——同一地址两份定义。源序兜底会让第一条变成静默死代码。

**情况 3 也报错，理由是顺序无关性**：这个格式存在的理由是 block 级可寻址、
agent 用 `geml get/set` 单块编辑、`geml add --before/--after` 插入。
**若渲染依赖源序，agent 挪动一条规则就会静默改变 UI。**
CSS 敢用源序，是因为 CSS 由人整体维护、顺序是有意编排的；这里不是。

情况 3 的逃生出口永远存在且便宜：写 `A ∪ B`，它必是两者真超集。

**冲突对着语料判，不静态判。** 只有语料里真的存在同时命中的 block 时才报错。
代价是诚实的：今天干净的样式表，可能因新增内容而报错——但那个冲突是真的，随内容一起出现。

诊断必须直接可操作：

```
error ambiguous-rule: `#kpis` and `#sortables` both set `component` on `q3.geml#revenue`
  #kpis      match="table.kpi"
  #sortables match="table[sortable]"
  neither is more specific — write a rule matching `table.kpi[sortable]`
```

### 4.4 CSS 相似性是坡道，不是陷阱

写 `:nth-child(2)` 或 `div > p` 时**不得静默失配**，必须点名：

```
error selector-unsupported: `:nth-child` is not supported
  (supported: type, .class, #id, [attr], [attr=val], descendant)
```

---

## 5. 绑定语言（T2）

### 5.1 三层单向管道

```
interaction  ──→  state  ──→  view params
  (产生)          (存储)         (消费)
```

**状态永远不读状态。** 于是没有图，也就没有环——**结构化无环，且与源序无关**。

（这句话说的是**状态**。§12.4 引入的 `style-frame` 嵌套是另一张图 —— 区域装区域 ——
它**有**环的可能，由 `frame-cycle` 检查；两张图互不相干，状态管道这一条依然成立。）

这一点必须结构化而非位置化：§6 的计算列靠**声明顺序**保证无环
（"a formula sees only data columns and *earlier* computed columns"，
故 §9.3 得以宣称 "GEML tables need no cycle detector"），
但计算列住在**同一个 table block 内部**，重排是一次单块编辑；
而 `style-state` 是顶层块，照搬"只见更早声明"会把 §4.3 刚禁掉的顺序依赖请回来。

已对 T2 用例逐一验证落在管道内：主从选择、图表下钻、facet 筛选、
两级下钻（两个状态各由各自的交互产生，不是状态派生状态）、
"筛选后的合计"（属 §6 的计算列/summary，是 view 不是 state）。

### 5.2 产生者声明在 state 上

```
=== style-state {#sel type=block-ref match="table#calls" on=select value-from=to}
===
```

读作："状态 `#sel` 由 `table#calls` 上的 select 交互喂养，取 `to` 列。"

放在 state 而非 rule 上换来：整个应用的交互模型 = 读一遍所有 `style-state`；
`match=` 是选择器，白拿 §4 的检查能力 —— 和 `style-rule` 装的是同一种东西，所以用同一个词。

`kind=` 两种：`block-ref`（值是一个块 id）与 `scalar`（值是一个标量）。

**`block-ref` 的值相对于产生者所在的文档解析。** 裸引用（`#Logo`）指本文档，
限定引用（`other.geml#id`，§5.2）指别处——codemap 的边表两种都写，
所以这条不是理论问题。消费者必须知道一格状态是谁喂的才能解析它的值。
名字刻意避开 `value`——那是产生者侧的属性名，同名会读混。

**允许多产生者**（`from="diagram#trend, table#picker"`）。这不是 §4.3 那种冲突：

- §4.3 的冲突是**静态的**——两条规则同时静态声称同一属性，无时间维度，必须现在裁决。
- 多产生者是**时序的**——两个事件源在不同时刻给同一格赋值。这就是 `setState` 从两处被调用，
  "最后写的赢"不是需要设计的裁决规则，那就是赋值的含义。

### 5.3 消费者：三类算子

| 算子 | 写法 | 语义 |
|---|---|---|
| select | `show="$sel"` | 呈现 `$sel` 指名的块 |
| filter | `filter="confidence=$conf"` | 用状态收窄集合 |
| project | `title="$sel.caption"` | 从状态指向的块取字段 |

**没有条件、没有查表、没有跨文档引用、没有算术**——克制程度对齐 §6。
需要算术就用 §6 的计算列。

**三个算子由运行时执行，不由组件执行。** 组件收到的是**已解析的结果**：
已经过滤好的行、已经选定的块。若交给组件自行解释，每个组件作者都要重实现一遍语义、
实现会分叉，而 `unknown-value-source` 一类检查也会从保证退化成建议。
运行时持有完整文档模型，具备执行条件。

### 5.4 组件契约

组件是"哑"的，接口最小且固定：

| 方向 | 形态 |
|---|---|
| 入 | 已解析的数据 props（`block` / `rows` / `value`）+ 规则里的其余键作为组件参数 |
| 出 | 可选的 `onSelect(value)` 回调——`on=select` 唯一的信号通道 |

规则里**除保留键以外**的所有键（`match` / `component` / `handler` / `show` / `filter` 之外）
原样作为组件参数透传，因此组件参数不受 `style-unknown-attribute` 约束。

**2026-09-09 起保留键多了一组**：§12.3 的内含词（`width` `sticky` `font-size` …）。
它们由 profile 消费、落进视图模型的 `box` 字段，**不再透传** —— 组件收到的 `params`
里永远看不到它们，所以组件也不可能把 `width` 另解释成别的意思。

### 5.5 `screen=` —— 同一个块在不同屏幕里的不同展示

一条规则可以用 `screen=` 限定它只在某些屏幕里生效（空格分隔，惯例同 `profile` ——
**名字**列表用空格，**选择器**列表用逗号，见 §5.6）；
不写就是每个屏幕都生效。

```
=== style-rule {#edges   match="table#calls" component=edge-list}
===
=== style-rule {#asGraph match="table#calls" component=call-graph screen=map}
===
```

**裁决不需要新逻辑。** `screen=` 作为一个额外条件进入条件集（§4.3），
于是限定屏幕的规则天然是同选择器未限定规则的**真超集** —— 通用规则全局生效，
屏幕规则在自己屏幕里胜出，正是想要的语义，从既有偏序白送。
两条规则限定同一屏幕、选择器又相同，仍然是 `ambiguous-rule`（情况 2），不受影响。

**后果是绑定不可能是一张全局表。** 视图模型因此给每个屏幕一张
`screens[].bindings`，顶层的 `bindings` 是未限定屏幕的那一张。
消费者查绑定必须带屏幕上下文。

`screen=` 点名一个不存在的屏幕是 `unknown-screen` **错误** —— 悬空引用，
和 `unknown-state` 同级。

### 5.6 `style-screen`

> **2026-09-09 变更（§12.4）**：`layout=` 改名 `component=`，与块上的同名键同构；
> 新增内含词 `axis=row|column`；槽位里**裸 `#x` 指本样式表的 `style-frame`**，
> 语料块须带类型（`text#x`）；新增 `style-frame` 块类型承载页内区域。
> 下文保留设计当时的写法，作为"为什么是槽位列表"的理由。

```
=== style-screen {#overview layout=split slots="table#calls, $sel"}
===
```

`slots=` 是**逗号分隔的槽位列表**，按序填格。

**不能用空格**：空格在选择器里是后代组合子，按空格切会把 `#api table.kpi`
劈成两个槽位（实测：`#api` 选不中任何东西，还附送一条不解释真正原因的
`unmatched-rule`）。规矩是 —— **名字列表用空格**（`profile`、`screen`、`palette`、
codemap 的 `entry`），**选择器列表用逗号**（`match`、`slots`）。
每个槽位是一个选择器，或一个状态引用（`$sel`）——后者让该格呈现状态当前指向的块，
这是主从视图里"详情那一侧"的写法。

指名具体文档（模板模型作为特例收进来）**没有进 v1**：`style-screen` 的保留键
只有 `slots` 和 `layout`，写 `doc=` 会得到一条 `style-unknown-attribute`。
文档由宿主传入（`<GemlScreen doc={doc}/>`），样式表不点名文件。

**不提供 `route=`。** 路由是宿主框架的事，样式表再声明一遍就是两套路由打架。
app 侧写 `<GemlScreen id="overview" doc={doc}/>`。

### 5.7 T3：处理器绑定

```
=== style-rule {#signup match="#signup-form" component=form handler=subscribe}
===
```

宿主提供 `handlers={{ subscribe: fn }}`；未知 handler → warning + 惰性渲染，
且**只在宿主声明了注册表时才检查**（`--handlers=`）——不给旗标就不跑，
因为一条永远不会触发的诊断比没有更糟，假装检查过比这还糟。

**样式表里永远不出现 URL**——不是因为不安全（模型 C 下样式表是可信的），
而是 dev/staging/prod 地址不同，写死会让样式表绑定环境。

---

## 6. 编译模型

### 6.1 运行时库 + `--eject`，不是 codegen 优先

产物形态：`@geml/style-react` 提供 `<GemlScreen>`，样式表在构建期被解析成配置对象消费。
**不默认生成 `.tsx` 文件。**

理由是本仓库自己的教训：`spec/in_geml_format/*.geml`
"carry hand-applied fixes that regeneration would silently destroy"。
codegen 优先的产物会被手改，再生成时静默摧毁手改——同一个腐烂模式。

`geml style eject <screen>` 作为逃生口，输出可读 TSX 让人彻底离开运行时。
**这是单向门**，文档必须写明。

**状态挂载位置与其性能后果。** 状态是文档级的（§9.3），在 React 里即所有状态格都挂在
`<GemlScreen>` 根上——这是"状态必须提升到所有消费者的共同祖先"的直接结果。
于是任何一次状态变化都会重渲染整棵屏幕子树；codemap 那种上千方法块的文档会明显变慢。
解法是常规手段（组件 `React.memo` + 稳定 props 引用），不影响设计，但**运行时必须默认提供**，
不能留给组件作者自觉。

### 6.2 包边界

| 包 | 新增 | 硬约束 |
|---|---|---|
| `@geml/geml` | `geml style check` | **不得依赖 React**——检查器是纯的 |
| `@geml/style-react` | 运行时、组件注册表、处理器注册表 | 新包 |

若 `geml style check` 改动了 `geml-parser/src/geml.ts` 的顶层导入或再导出，
**必须同步 viewer 的 esbuild stub**（`integrations/geml-viewer/src/render-html-stub.js`、node-stub），
并捕获 viewer gate 的**真实退出码**（`| tail` 管道报的是 tail 的）。

---

## 7. 诊断目录

诊断码属于**本 profile 的目录**，不进 GEML 的 Appendix A——profile 不是规范。

严重性哲学：**结构性错误 = error；未知名字 = warning + 惰性回退**，
以保住 §8.5 的前向兼容机制。

| 码 | 严重性 | 抓什么 |
|---|---|---|
| `selector-unsupported` | error | 不支持的 CSS 构造 |
| `ambiguous-rule` | error | 相同或不可比的规则争同一属性 |
| `unmatched-rule` | warning | 规则在语料里选不中任何块——**style 层的 `bad-source-range`** |
| `unknown-state` | error | 规则或槽位引用了不存在的 `$foo` |
| `unknown-screen` | error | `screen=` 点名的 `style-screen` 不存在 |
| `style-missing-attribute` | error | 缺必需属性（`match=` / `on=` / `slots=`） |
| `unmatched-producer` | warning | `match=` 选择器选不中 |
| `unknown-value-source` | error | `value-from=` 不在目标表的 schema 里（§6 的表有 schema，可真查） |
| `unknown-interaction` | error | `on=` 不是本 profile 定义的交互（封闭词汇） |
| `unknown-component` | warning | 宿主未注册 → 惰性回退 |
| `unknown-handler` | warning | 宿主未注册 → 惰性回退 |
| `style-unknown-attribute` | warning | `style-state` / `style-screen` / `style-frame` 上的未知键 |
| `unknown-frame` | error | 槽位里裸 `#x` 没有对应的 `style-frame`（§12.4） |
| `screen-nested` | error | 槽位里裸 `#x` 指到了一个 `style-screen` —— 页不能装进页 |
| `frame-cycle` | error | 区域装区域形成环，消息带整条链 `#a → #b → #a` |
| `frame-too-deep` | error | 某条放置路径上 frame 嵌套深过 16 层——和 embed 的上限同一个理由（§12.4） |
| `unused-frame` | warning | 声明了却没有任何槽位引用的 `style-frame` |
| `style-invalid-value` | error | 内含词的封闭值域被违反（`axis` / `scroll` / `sticky` / `hide-below`），或 `when=` 形式不对（§12.4） |

`style-rule` 上**没有**未知键检查：保留键之外的键原样透传为组件参数（§5.4），
那是组件自己的词汇，profile 无权裁决。

**没有 `binding-cycle`。** 构造上不可能，不需要这个码。`frame-cycle` 抓的是另一张图
（§5.1 的括注）—— 区域的包含关系，不是状态的依赖关系。

---

## 8. 测试策略

照 §8.4 的形状：语料对拍。

- 输入 =（样式表 + 内容文档集），期望 = **解析后视图模型**的规范化投影：
  哪条规则命中哪个块、合并后的参数、状态图。
- **组件的元数（一个块 vs 一批块）是宿主的声明，不是样式表的。** 一张调用图必须看见
  语料里所有的 calls 表才画得出来，而绑定模型是一块一个组件实例。样式表只写
  `component=call-graph`，元数是组件的实现细节 —— 和 handler 同一个模式。
- **屏幕槽位必须在构建期解析成地址列表**，而不是把原始选择器字符串交给消费者。
  否则消费者只能在运行时重做一遍选择器匹配，而那个山寨匹配器必然和构建期语义分叉——
  选择器求解是构建期的事，这是本设计的根基之一。
- **绑定的地址必须按文档限定**（`{doc, block}`，诊断里渲染成 §5.2 的 `other.geml#id`）。
  §4 只保证 id 在**单份文档内**唯一，而一份样式表配一整个目录正是选择器模型的常态：
  两份文档里各有一个 `#budget` 完全合法，不限定就无法 join 回正确的块。
- **视图模型是一致性面，不是像素。** 第二实现不必附带 React 即可对拍。
- 冲突用例必须覆盖 §4.3 的三种情况各自的诊断。
- 仓库既有闸门照旧：`node test/all.mjs`（单一 runner，绝不 npm 套 npm）、
  `npm run coverage:check`（95% 行/语句/函数/分支）。

---

## 9. v1 明确的非目标与限制

1. **文档级谓词**（"只对 codemap 文档生效"）不做——模型 C 下"哪份样式表配哪份文档"
   是 app 的路由决策。
2. **伪状态**：`:selected` 属 T2 状态（§5）；`:hover` 属组件实现，不进选择器。
3. **状态是文档级的，不按 screen 隔离**；多屏隔离靠取不同状态名。
4. **`override=` 阀门不放。** 先放它会变成默认写法，§4.3 的偏序就白设计了。
   等 `ambiguous-rule` 的人机效真被咬到再加——它是声明式、与顺序无关、可检查的，
   比 `!important` 强在说得出自己压的是谁。
5. **不做 `=== form` 进核心规范。** v1 用 `component=form` + `handler=` 覆盖。

---

## 10. 开放问题

1. ~~**`profile` 词汇表机制是否随 v1 落地**（§3.3）~~ —— **已落地**（计划 C）。
   `geml-parser/src/profiles.ts` 持有注册表；`geml.ts` 里的 codemap 词汇泄漏已收回。
   **未采纳旧产物兼容探测**（认 `resolution-default` 为隐式声明）：那会把本机制正要
   清除的问题以更小的形式重新引入 —— 第二实现照样得复刻这条实现特定知识才能在诊断上
   与参考实现一致（§8.4）。旧图重新 `geml codemap build` 一次即可。
2. **计算列（§6）的去留** 是一个独立 GEP，**不被本设计推动**：
   算术本来就不在绑定语言里，去掉它反而会让本设计更难（少了可以 offload 的地方）。
   实测 `--to md` 会把计算值**物化进投影**（`total` 列与 summary 行都落地），
   故带计算列的文档在每种投影里都自足；去掉后要么作者手写会腐烂的派生值
   （正是 GEP-0006 存在的理由），要么合计只活在 app 里、`.md` 与 agent 直读都看不到。
3. **`=== form` 是否将来提升进核心规范**：若提升，建议与 `code` 完全对称——
   §9.1 规定 `code` "MUST NOT be run"，则 `form` **MUST NOT be submitted**，
   默认渲染为 disabled 预览，由应用层激活。目的地永远由宿主决定（`handler=`，不是 `action=`），
   否则等于把钓鱼原语写进核心规范（§9 的威胁模型：文档 "frequently machine-generated
   and frequently untrusted"）。
4. **多产生者的实际人机效**：v1 已放开，需真实用例回灌验证。

---

## 11. 消费者验证的结论（spike，不在版本库内）

视图模型曾经从未被任何消费者读过，而没被消费过的接口通常缺东西。为此写过一个
约 300 行、**无框架**的消费者 spike，跑过真实语料（mustapi：3312 方法 / 6369 边 /
57 份文档）。**它的产出已全部落地**（地址按文档限定、槽位构建期解析、聚合元数契约、
`ambiguous-rule` 建议分叉、以及整个计划 D），代码本身没有测试覆盖、必然随视图模型
变动而腐烂，因此**不进版本库**。以下是它留下的耐用结论。

### 11.1 为什么刻意不用 React

要证的是**视图模型**够用，不是 React 够用。一个 135 行的朴素运行时就能跑通，
说明这个模型不是 React 形状的——框架中立的说法因此才站得住，而不只是断言。

运行时里没有响应式系统：状态格是普通对象，写入后整屏重渲染（React 里就是 `setState`），
状态永不读状态所以没有依赖图、没有环检测、没有调度器。

### 11.2 和 `geml-code-graph` 逐条核对

**对上了：**

| | 真渲染器 | spike |
|---|---|---|
| 模块层 | 18 节点 / 21 边 | 18 / 21，节点名一一对应 |
| 显示期折叠 | 硬编码 | `fold=1` |
| 方法层的根 | `roots: entry` | `entry ∪ 无入边` |
| 深度 | `graph-depth`，默认 6 | `depth=6`，样式表可覆盖 |
| 下钻 | 跳兄弟页面 | `$module` + `screen=drill`，同页切换 |
| 回边 | 红色虚线 | `.back` 虚线 |

**没对上：**

| | 差距 |
|---|---|
| 节点口径 | 真渲染器数**文档里的方法块**（ms-parser 96/96）；我数**边的端点去重**（98）。实测差额正是 2 个跨文档目标；该文档恰好没有孤立方法，所以另一半误差是 0 —— 但换个文档就会漏掉无边的方法。**这是口径错，不是数量差。** |
| 缩放 | `−` `+` `fit` `1:1` 全无 |
| 方向 | `top-down` ↔ `left-right` 切换无 |
| 全屏 | 无 |
| 方法搜索 | `find a method…` 无 |
| 逐节点操作 | ⊕ 完整调用链、⊙ 看源码 无 |
| accessor 折叠 | 无（ms-parser 恰好 0 个 accessor，所以这次没看出差别） |
| 模块配色 | 真渲染器每模块一色；这里只有 leaf/root 两类 |
| 跨文档图例 | 无（真渲染器底部列出 `ms-lexer.geml` / `ms-parser.geml`） |
| 边的权重 | `#module-edges` 有 `calls` 列，算了但没画 |

这些**全是组件级的功夫**，`geml-code-graph` 里已经有了。spike 的目的从来不是复刻它，
是验证视图模型够不够喂一个组件 —— 那件事已经证完了。

### 11.3 `=== diagram {format=geml-code-graph}` 单张嵌入的坑

`--to html` 单张嵌入一个 index 文档时，[render.ts:873](../../../geml-parser/src/render.ts) 是一条提前返回：

```ts
return { data: { …, nodes: {}, edges: [], mode: "modules", mods, medges, entryDocs } };
```

**方法层数据一开始就是空的**（不是 `CG_MAX_NODES` 截断 —— mustapi 的 3312 < 4000，
`cg-note` 提示也确实没渲染出来）。`codemap render` 出的 57 个页面里点模块是跳兄弟页面，
所以能用；单张嵌入没有兄弟页面可跳，于是**工具条上的下钻和「find a method…」都在，
但点了没反应** —— 承诺了数据支撑不了的能力。

### 11.4 未被真实用例验过的词汇

`filter` 算子（mustapi 的边全是 `kind=call`、confidence 全空，没有可过滤的噪音）、
多产生者状态、`handler=`（无真实宿主）、`select` 之外的交互。
它们在检查器里都有测试，但没有任何真实样式表用到过。

**2026-09-09 更新**：`style-screen`、槽位、`select` 之外的交互（`toggle`）自 §12 起有了
第一个真实用例 —— GitHub blob 页的布局。`filter`、多产生者、`handler=` 仍未被验过。

---

## 12. 设计变更（2026-09-09）：从显示旋钮到一整页

### 12.1 触发

要求是：用 geml-viewer 浏览器插件直接渲染一份 `.geml`，出来的页面 1:1 是 GitHub 的
blob 视图（`docs/PUBLISHING.md` 那一页，以 mhtml 存档为准）。**关系照 HTML + CSS**：
页面的全部内容 —— 顶栏、repo tabs、文件树、面包屑、commit 条、toolbar、正文、footer ——
都是作者写在 `.geml` 里的块；样式表只说它们**摆在哪、多大、什么样**。没有路由，没有数据源。

从 mhtml 量出的骨架（视口 1440）：

```
GlobalNav                       全宽 · h=100 · 随页滚走
PageLayout ─ row
├─ 文件树栏   x=0   w=321      position:sticky top:0 · 自己滚
└─ 内容      x=321  w=1104
   ├─ 面包屑 + commit 条        y 100→225
   └─ 卡片   x=337  w=1072     （内缩 16）
      ├─ toolbar                sticky top:0 · z=4
      └─ markdown-body  w=1008  （内缩 32；≤768 时 48）
```

栏宽是定值不流式；≤768 时文件树 `display:none`（1011 还在）。文字：正文 16/24、h1 32/40、
h2 24/30、表格 16/24、代码 13.6/20.4；色 `#1f2328`；边框 `#d0d7de`，标题下沿 `#d7dde3`。

### 12.2 用既有词汇试写，暴露出的四处

先按 §5.6 原样写了一份样式表 —— 六个区域六个槽位。`geml style check` **0 error 0 warning**，
`--json` 出来的视图模型**完整**：槽位全部解析到真实块，区域参数逐字透传
（`sticky:true`、`width:"321px"`、`component:"outline-pane"`）。从样式表到解析器这条链是通的。
问题在链的两端：

1. **嵌套表达不了。** `slots=` 是一层扁平的块选择器。让一个槽位指向另一个 screen，
   它被当成块选择器去匹配语料 —— `unmatched-rule`、`blocks: []`，两个 screen 在视图模型里
   是毫无关系的兄弟。而页面是三层嵌套。
2. **断点表达不了。** `screen=` 是 screen id 列表，不是 media query；"低于某宽收起文件树"
   在 v1 里没有任何写法。
3. **外观没有词汇。** 被真实使用的旋钮只有四个（`fold` `depth` `hide-accessors` `palette`），
   全是 codemap 那个组件自己的遥控器按键。要写出 321px、sticky、1012px，要么给 viewer
   做一个把像素全烤死的 `github-shell` 组件 —— 那不是 style，是挑主题名 —— 要么 profile
   自己收一组词。
4. **没有宿主。** `style-resolve.ts` 产出 `screens[]`，全仓库 **0 个**消费者；viewer 不读
   样式表（grep `style-resolve|loadStylesheet|geml-style` = 0，自带手写 `geml.css`），
   整个 CSS 只有一个容器 `.geml-body`。

顺带看清了两条术语裂缝：块的展现叫 `component=`、screen 的展现叫 `layout=`，同一件事两个词；
`handler=` 在 rule 上、`on=` 在 state 上，§5 的三段管道里没有"副作用"的位置。

### 12.3 决策一：内含词与组件词并存，判据是"换个块还是不是这个意思"

> 一个属性，放在段落、表格、图上意思都一样 → **内含**（profile 定义，所有渲染器同解）；
> 只对某一种控件才说得通 → **组件自定**（透传，各组件说明书）。

这就是 CSS 属性与 Web Components 属性的分法，也是 §2.1 早就在做的二分 —— 只是 profile
那一栏从 6 个控制词扩成"控制词 + 一小组盒子/文字属性"。按那一页圈死，多一个不加：

| 内含词 | 页面上的位置 | 实测值 |
|---|---|---|
| `width` | 文件树栏 | `321px` |
| `padding` | 卡片 / 正文 | `16px` / `32px`（≤768：`48px`） |
| `sticky` | 文件树栏、toolbar | `0` |
| `scroll` | 文件树栏 | `own`：高度钉在视口，内容自己滚 |
| `hide-below` | 文件树栏 | `1012`（阈值落在 769–1011 之间） |
| `max-width` | 正文 | 1440 以内未触发（正文填满父级减 padding）；留给更宽的屏，否则正文流式撑满 |
| `axis` | **screen / frame 上**，槽位横排还是竖排 | 最外层 `row`，其余 `column`（默认） |
| `font-size` `line-height` | 正文/h1/h2/表格/代码 | 见 §12.1 |
| `color` `background` `border` | 正文 / 页面 / 单元格与标题下沿 | 见 §12.1 |

不叫 `flow` —— 那是块类型；不叫 `direction` —— CSS 里它已经是 `ltr|rtl`，借 CSS 的词却换意思
正是 §4.4 说的陷阱。`font-family` 不收：两边都是系统字体栈，CSP 下也引不了字体。

配套规则：**内含词是保留的**。profile 消费掉、落进视图模型的 `box` 字段，不再透传；
组件的 `params` 里永远看不到它们，所以 tree 组件不可能把 `width` 另解释成缩进。
这是结构保证，不是约定。§4.3 的仲裁对属性是通用的，新词自动获得"两条规则打架 → 报错"。

### 12.4 决策二：screen 是页，frame 是页内区域

| | 之前 | 现在 |
|---|---|---|
| 根 | 要靠"没被引用"推导 | **`style-screen` 就是根**，一页一个 |
| 区域 | 没有 | **`style-frame`**，只能被槽位引用，可以再装区域 |

```
=== style-screen {#page axis=column slots="text#global-header, text#repo-tabs, #body"}
===
=== style-frame  {#body axis=row    slots="table#file-tree, #main"}
===
=== style-frame  {#main axis=column slots="text#breadcrumb, text#commit-bar, #card"}
===
=== style-frame  {#card axis=column slots="text#toolbar, text#content"}
===
```

- **槽位里的引用**：裸 `#x` = 本样式表里的 frame；带任何限定的（`text#x`、`table.kpi`、
  `#x[attr]`）= 语料块选择器。这是**语法**上的区分，不靠查表，所以不需要 `ambiguous-slot`，
  写错的 `#bdoy` 也是 error 而非 warning。跟 GEML 自己的约定一致：`#id` 单独出现指本文档，
  别的文档要带路径；`screen=` 引用 style-screen 也已经是裸 id。`match=` 不受影响，
  永远是语料选择器。
- **frame 不是 `<iframe>`**：不是独立文档、不隔离，就是同一页上的一块区域。
- **几个根算对，是宿主的事**：codemap 的 master/detail 天然多根；viewer 渲染"这一页"，
  要求恰好一个 `style-screen`，0 个退回今天的单栏渲染，≥2 报错。profile 不裁定。
- **`screen=` 的作用域**：screen 就是整页，`screen=page` 自然罩住页里所有 frame。
  frame 级的"同一块在不同区域不同画法"这一页用不到，不加 `frame=`。
- **`layout=` → `component=`**：screen/frame 的宿主命名排布与块上的 `component=` 完全同构，
  改成同一个词；`axis=` 是内含词，`component=` 可选。`layout=` 今天 0 个消费者，改名零成本。
- **诊断**（已并入 §7）：`unknown-frame`、`screen-nested`、`frame-cycle`（消息带整条链）、
  `frame-too-deep`（上限 16）、`unused-frame`。**深度上限是安全边界**：样式表是不可信输入
  （§9），一万个 frame 的链没有环却要渲染一万层。第一版写的是"不设上限，没有环就不可能无限深"，
  把"有限"和"栈放得下"混为一谈了，而且遍历是递归的 —— 一万层就打爆栈，四十层菱形（每层两个
  槽位指向同一个子 frame）是 2⁴⁰ 步。现在环检测是迭代 + 已访问集、深度是一遍拓扑 DP，都 O(N)。
  **frame 复用放行**：一个 frame 放两处就渲染两遍，等于同样的块点名两次，本来就允许 ——
  嵌套因此是以 screen 为根的 DAG，深度取最长的放置路径；
  `style-invalid-value`（error）—— 内含词里值域封闭的几个（`axis=row|column`、
  `scroll=own|page`、`sticky` 与 `hide-below` 须为数字）取了域外值，以及 `when=` 不符合
  `$state=value` 形式。开放值域的（`width=321px`、`color=#1f2328`）不校验，原样交给宿主。

### 12.5 决策三：状态只管样子，触发归宿主

边界照 CSS 的 `details[open]`：样式表声明状态和每个状态下的外观，谁去点是 viewer 的事。

```
=== style-state {#tree type=scalar match="table#file-tree" on=toggle init-value=open}
===
=== style-rule  {#tree-open   match="table#file-tree" component=tree width=321px sticky=0 scroll=own}
===
=== style-rule  {#tree-closed match="table#file-tree" when="$tree=closed" width=0}
===
```

- `on=` 的闭集从 `select` 一个变两个，加 `toggle`。tab 的 active 用既有的 `select` 就够。
- `when=` 是 rule 上的新保留键，形式 `$state=value`，逗号并列表示全部满足。**只做相等**，
  不做 `!=`、不做 or —— §5.3 "没有条件、没有算术"的克制不破。`$x` 未声明 → `unknown-state`。
- **与 §4.3 的关系是零改动**：`when=` 作为普通条件进入条件集。`#tree-closed` 的条件集是
  `#tree-open` 的真超集，折叠时它赢，依据是既有偏序，不是新加一条"带状态的优先"。
  两条都带 `when=` 且互不包含、又争同一属性 → 照旧 `ambiguous-rule`，正是该报的。
- 视图模型里 binding 因此多一层 `variants`（下节）。叠加顺序**构建期按 §4.3 排好**，
  运行时只挑 `when` 全匹配的叠上去，不做仲裁 —— 与 §5.3 "算子由运行时执行、判定在构建期"
  同一态度。
- **互斥的 `when` 集合不算冲突。** 两条都带 `when=` 的规则若对**同一个状态**给了**不同的值**
  （`$tab=Preview` 与 `$tab=Code`），它们不可能同时生效，争同一属性也不是 `ambiguous-rule`
  —— tab 条的每个 tab 一条规则正是这种写法。只有**可以同时成立**的两个 `when` 集合
  （`$tree=closed` 与 `$tab=Code`）、条件集又互不包含、又争同一属性，才报错。
- **variants 的叠加顺序**：按 `when` 条件数升序，同数按样式表内出现序。运行时按此序把
  条件全部满足的 variant 依次叠在基础参数上；真超集的一定排在后面，所以"更具体的赢"
  不需要运行时再比较。
- **跨层**：基础参数与 variant 若来自不同层，层号高的保留、低的那个属性直接丢弃 ——
  §4.1 的"上层整体压过下层"对有条件的规则同样成立。

### 12.6 视图模型（§10）的最终形状

```
states    [{ id, type, on: select|toggle, valueFrom?, initValue? }]
screens   [{ id, axis, component?, slots, bindings }]        ← 根
frames    [{ id, axis, component?, slots }]                  ← 顶层平铺，按 id 引用
bindings  [{ doc, block, rules, box, params, variants: [{ when, box, params }] }]
diagnostics

slot  =  { kind:"blocks", selector, blocks[] } | { kind:"state", state } | { kind:"frame", frame }
```

`box` 装内含词，`params` 装组件词，二者结构上分开（§12.3）。
`component` / `handler` / `show` / `filter` 留在 `params` 里，与 v1 落地时的视图模型一致 ——
既有消费者（`graph-style.ts`）和测试都在那里读它，搬动没有收益。`when` 是
`{ state: value }` 的映射。

### 12.7 宿主侧：viewer 要接的三件与退路

1. **找到样式表** —— 沿用 render.ts 那条唯一路径：相对被看文档找 `_index/index.geml`，
   读 `default-style` / `#sitemap`。**先核一件事**：viewer 能否取同目录文件；`transclude.js`
   存在说明 embed 能取，大概走 bg.js 的宿主权限，未验。
2. **消费视图模型** —— screen → frames → slots → blocks 建 DOM；`axis` 变 flex 方向；
   `box` 变内联 CSS（纯 CSS，`default-src 'none'` 下没问题）；块槽位查 bindings，
   有 `component` 走注册表，没有走今天的默认渲染。
3. **注册表 + 状态接线** —— 这一页要三个 component：`tree`、`tab-bar`、`markdown-body`。
   `toggle`/`select` 接到点击；状态变了 → 挑 `when` 全匹配的 variants 叠上。

实现时定下的四条，profile 没写、宿主必须有答案：

- **入口在哪**：与被看文档**同目录**的 `_index/index.geml`；用 `meta.profile` 含 `geml-style/v1`
  来**认**，路径上放了别的东西按"没有入口"处理（profile §1.1 的话）。入口里的路径相对于
  `_index/`。viewer 的 fetch 是异步的而 `loadStylesheet` 的 `loadDoc` 是同步的，所以先按
  `default-style` / `#sitemap` 命中 / 每条 `embed {src=}` 传递地把文件预取进一张 Map，再同步喂。
- **`toggle` 翻到哪个值**：profile 只说"两个之间翻"没说是哪两个。取 `init-value` 和该状态在
  所有 `when=` 里被点名的**那一个**别的值；点名了零个或多于一个，toggle 惰性并在 console 说明。
- **没被槽位放置的块不渲染**：screen 就是整页。数量报到 console。
- **screen 数**：0 → 今天的单栏；1 → 画页；≥2 → 横幅说明 + 单栏。视图模型带 error 级诊断 → 同样
  横幅 + 单栏，横幅列出诊断。"拒绝"永远是可读的退回，不是白页。

**退路**：没样式表、或没有 `style-screen` → 今天的 `.geml-body` 单栏。零回归。

### 12.8 落点

| | 改什么 |
|---|---|
| `style-resolve.ts` | `style-frame`；槽位裸 `#x` 查 frame；四个诊断；`axis` / `component`；内含词分流到 `box`；`on=toggle`；`when=` 进条件集、出 `variants` |
| profile（EN + CN） | §0.1（有真实用例了）、§2.1、§2.2、§2.3、§4、§5（"no graph" 那句）、§8、§10 |
| viewer | §12.7 三件 |

一句话总结这次变更：**词汇表能表达一层、表达不了嵌套和外观；宿主一个都没接。**
补的是嵌套、外观、状态三组词和一个宿主，`select into` 的立场、无 script、歧义即错误，一条没动。

---

## 13. 设计变更（2026-09-10）：外壳归位 —— 谁进规范，谁留文件

第二个页面用例。§12 让样式表能排出一页，代价在 §12.8 落点之外的地方显出来：viewer 里长出了 7 个只认那一页的
组件、99 行带着 GitHub 调色板的宿主 CSS、样式表里 10 个没人校验的私有参数键。这一节把每一样东西按 §12.3 的
判据分回三层：**规范**只收对任何块都成立的词，**插件**只留对这些词的解释，**GEML 文件**装下所有 GitHub 的东西。

两处分岔由作者拍板：外壳数据用**列表**承载（§13.3），hover **进规范**（§13.4e）。
图解：[外壳归位](https://claude.ai/code/artifact/57f49eba-6dbd-4d53-9792-4abd3e356302)。
### 13.1 摘要

复刻做到了 1:1，代价是三堆东西落在了错的地方：

| 在哪 | 是什么 | 实测 |
|---|---|---|
| `integrations/geml-viewer/src/components.js` | 只认这一页的组件：`bar` `tree` `tab-bar` `field` `editor` `icon` `markdown-body` | 459 行，7 个 |
| `integrations/geml-viewer/src/geml.css` 257–355 行 | 页面段：带 GitHub 调色板的宿主 CSS，含一条按**块 id** 写的 `.geml-b-toolbar` | 99 行，22 处色值，10 个不同的色 |
| `_index/github.style.geml` | rule 上无人校验的私有参数键：`icon icon-dir icon-open icon-closed icon-size shortcut state source-when preview-max-width title` | 10 个 |

方法是反着看：现有实现里每一段 CSS/JS 都问一句「GEML 本来有没有说这件事的办法」。多数有；少数要补词，
补词按设计 §12.3 的判据过：**放在段落、表格、图上意思都一样的才进规范**。

结果分三层：

- **规范**（geml-style profile；GEML-spec §5 一处）：六件事。选择器多一类行内步；`axis` 允许挂在块上；`view`、`editable`
  两个内含词；`when=` 多 `@hover` `@focus` 两个内建名；rule 上的参数袋收口。核心那边渲染器放行链接与图片的
  `{title=}`。
- **插件**（geml-viewer）：只解释规范里的词。状态存储与三种喂法；视图模型到 CSS 的编译多行内选择器与伪状态；两个不认
  页面的通用组件 `tree` `segments`；`view=source` 的源码框。任何一行不许出现色值、尺寸、GitHub 的类名。
- **GEML 文件**（`page.geml` `github.style.geml` `icons/*.svg`）：所有 GitHub 的东西。

估算：components.js 459 → 约 90 行、7 → 2 个组件；geml.css 页面段 99 → 约 15 行、色值 22 → 0；样式表私有键 10 → 0。
这些数字说量级，不是承诺。实施步骤见[同期的计划](../plans/2026-08-29-geml-style-checker.md)，Task 8 起。

---

### 13.2 判据

沿用两条已经写在设计文档里的原话，不新造：

> §12.3：一个属性，放在段落、表格、图上意思都一样 → **内含**（profile 定义，所有渲染器同解）；只对某一种控件才说得通
> → **组件自定**（透传，各组件说明书）。

> §12.5：样式表声明状态和每个状态下的外观，谁去点是 viewer 的事。

§12.3 还说过「清单按第一个真实用例圈死，多一个不加」。本文就是第二个真实用例：第一个用例把清单圈成 23 个词，
第二个用例证明其中三样（`layer` `visible` `grow`）确实通用，同时暴露出 7 个组件与 10 个私有键是把「这一页的东西」
写进了宿主。清单因此再动一次，仍按同一条判据。

---

### 13.3 数据形态：外壳用列表承载（决策 A）

#### 13.3.1 为什么不是表

复刻第一版把外壳做成六列表 `label,href,icon,title,badge,dot`，理由是「data 可寻址」。它带来两个后果：

1. 列名合同写在 JS 里。`bar` 组件认这六个名字，`tree` 认 `name,kind,depth,href`，谁也校验不了，拼错静默。
2. CSV 单元格没有行内标记（GEML-spec §6「数据体只按分隔符切」），于是「图标 + 文字」永远要拆成两列，「＋ 和 ▾ 合成一个按钮」
   写不出来，只能写成两行。

要保住表，就得把这六个列名写进 profile，成为「链接行表」的规范词汇 —— 一个为导航条量身定做的 schema 进了规范。

#### 13.3.2 列表本来就是导航条

GEML 第一天就有的东西够用：`text` 块的流式体里放一个列表，一条就是一条行内。

```
=== text {#top-nav}
- [![](icons/plus.svg) ![](icons/triangle-down.svg)](https://github.com/new){title="Create new..."}
- [![](icons/issue-opened.svg)](https://github.com/issues){title="All issues"}
- [![](icons/git-pull-request.svg)](https://github.com/pulls){title="All pull requests"}
- [![](icons/repo.svg)](https://github.com/repos){title="All repositories"}
- [![](icons/inbox.svg)](https://github.com/notifications){title="Notifications"} ![unread](icons/dot.svg)
- [![](icons/avatar.svg)](https://github.com/xiongjy2104){title="Open user navigation menu"}
===
```

- 图标是 `![](icons/x.svg)`（GEML-spec §5.1 媒体嵌入），文件已经是文件，不再有名字到路径的映射表。
- 提示语是链接属性对象里的 `{title=…}`（GEML-spec §5.2 已允许属性对象，今天只有 `rel` `target` 两个键被渲染器放行）。
  只有图标的链接，`title` 同时是它的无障碍名，HTML 的名字计算本来就这样。
- 计数是行内代码 `` `1` ``，未读点是一张 8px 蓝圆的 SVG。两样都还是数据，只是用行内元素写。
- ＋ 和 ▾ 是同一个链接里的两张图，和原页一个按钮对得上。

#### 13.3.3 全部外壳块

| 块 | 类型 | 原来 | 现在 |
|---|---|---|---|
| `#brand` | text · 列表 | 六列表 | ☰、GitHub 标、`geml-spec` / `geml`、▾ 各一条 |
| `#site-search` | form-field type=text | 同 | 同；两侧的图标与键帽见 §13.3.4 |
| `#top-ai` | text · 列表 | 六列表 | Copilot 一条 |
| `#ai-caret` | text · 一张图 | frame + `component=bar icon=` | 块，作 `#aimenu` 状态的触发者 |
| `#ai-menu` | text · 列表 | 六列表 | 三条链接 |
| `#top-nav` | text · 列表 | 六列表 | 见 §13.3.2 |
| `#repo-nav` | text · 列表 | 六列表 | 十二条，Issues 后 `` `1` `` |
| `#side-toggle` | text · 一张图 | frame + `component=bar icon=` | 块，作 `#sidebar` 状态的触发者 |
| `#side-head` | text · 列表 | 六列表 | Files 一条 |
| `#side-back` | text · 一张图 | 六列表 | 一条链接 |
| `#branch` `#branches` | form-field type=select · form-options | 同 | 同 |
| `#side-tools` | text · 列表 | 六列表 | ＋、搜索两条 |
| `#file-find` | form-field type=text | 同 | 同 |
| `#file-tree` | text · 嵌套列表 | 四列表 `name,kind,depth,href` | 缩进就是层级，见 §13.3.5 |
| `#breadcrumb` | text · 一段 | 六列表 | `[geml](…) / [docs](…) / PUBLISHING.md ![](icons/copy.svg){title="Copy path"}` |
| `#commit-left` `#commit-right` | text · 一段 | 六列表 | 头像、作者、提交信息、⋯ 各是行内 |
| `#views` `#view` | form-options · form-field type=select | `text#toolbar` 一段文字按 `·` 切 | 见 §13.3.6 |
| `#file-meta` | text | 同 | 同 |
| `#file-actions` | text · 列表 | 六列表 | 八条 |
| `#doc` | embed | 同 | 同 |

#### 13.3.4 输入框两侧的装饰

`field` 组件做的事是把一张图和一个键帽拼到控件两边。页面上就是三样东西，那就放三个块，用 frame 并排：

```
=== text {#search-icon}
![Open quick search dialog, type / to search](icons/search.svg)
===
=== text {#search-key}
`/`
===
```

```
=== style-frame {#search axis=row gap=6px grow=yes max-width=320px border="1px solid #d1d9e0" border-radius=6px padding="4px 8px" slots="text#search-icon, form-field#site-search, text#search-key"}
===
=== style-rule {#kbd match="text#search-key code" border="1px solid #d1d9e0" border-radius=4px padding="0 5px" color="#59636e"}
===
```

`#file-find`（Go to file，键帽 T）与 `#branch`（分支下拉，前置 ⑂ 图标）同法。代价是每个字段多两个小块。

#### 13.3.5 文件树：缩进就是层级

`depth` 列是把 GEML 已经会的事（GEML-spec §2.2 嵌套列表）重新编码了一遍；`kind` 列在「有没有子列表」里。

```
=== text {#file-tree}
- ![](icons/file-directory-fill.svg) [.agents](…/tree/title-projection/.agents)
- ![](icons/file-directory-fill.svg) [docs](…/tree/title-projection/docs)
  - ![](icons/file-directory-fill.svg) [assets](…/docs/assets)
  - ![](icons/file.svg) [MANIFESTO.geml](…/docs/MANIFESTO.geml)
- ![](icons/file.svg) [README.md](…/blob/title-projection/README.md)
===
```

目录 = 带子列表的条目；有子项 = 展开着，无子项 = 收起着。GitHub 本来也只下发展开目录的子项，所以这不是近似，
是同一件事。折叠用原生 `details/summary`，零 JS；展开箭头是系统 `::marker` 三角（见 §13.9）。

#### 13.3.6 Tab：一选多本来就是表单字段

`text#toolbar` 里的「Preview · Code · Blame」是一个列表冒充一段话，再由 `tab-bar` 组件按 `·` 切开。GEP-0008 有现成的词：

```
=== form-options {#views format=csv}
value,label
Preview,Preview
Code,Code
Blame,Blame
===
=== form-field {#view type=select options=#views value=Preview}
===
```

```
=== style-state {#tab type=scalar match="form-field#view" on=select}
===
```

字段的值就是状态；`init-value` 不写时取字段的 `value=`。这是 profile §2.2 里 `on=select`（"the value is what was picked"）
落到表单字段上的自然读法，只需在 profile §2.2 加一句说明，不是新词。

#### 13.3.7 寻址上的代价，以及它其实出在哪

实物验证：表这边 `geml get page.geml '#top-nav[6]["href"]'` 直接回 `https://github.com/notifications`，`geml set`
同样能只改这一格；列表这边 `#top-nav[2]` 报错「`text` carries no addressable units inside it — a coordinate needs a table
or a `data` block」。所以列表的代价不是「href 不再是单元格」，而是**条目整个指不到**，只能拿整个块。

这个缺口出在 GEP-0011 的坐标系统，不在数据形态：列表项本来就是有序的单元，让 `#top-nav[5]` 指到第五条是坐标系统顺理成章
的一步扩展，对所有文档的所有列表都成立。记为 GEP-0011 的待办（§13.12）；等它落地，列表的可寻址性就回来了，
而 profile 里不用多六个列名。

---

### 13.4 进规范的六件事

每件都按 §12.3 过一遍。字母编号只是引用用的。

#### 13.4a 选择器多一类步：行内节点

**语法**（profile §3）。步的种类多一种「部件步」，取值封闭：`link` `image` `code-span` `strong` `emphasis`。
名字取 GEML-spec §5.1 自己的叫法，不用行内节点在模型里的 type：`code` 已经是**块类型**，`text#nav code` 今天就有意思
（嵌在那个块里的代码块），借来当行内会撞；`em` 同理写全。部件步只能是选择器的
**最后一步**，且前面至少有一个块步：

```
text#repo-nav link          ✓  这个块里的每个链接
text#repo-nav image         ✓  这个块里的每张图
text#file-tree link         ✓
link                        ✗  selector-unsupported：部件步前面要有块步
text#nav link image         ✗  selector-unsupported：部件步只能是最后一步
text#nav link[title]        ✗  selector-unsupported：部件步不带属性过滤与类
```

**为什么通用**。行内节点在任何块里都是这几种；给「这个块里的链接」上色和给块上色是同一件事。仍然不收伪类、组合子、
通配、子串匹配，profile §3 的拒绝清单一字不改。

**候选枚举**。检查器为每个块候选走一遍它的行内（段落、列表项、标题），记录出现过的部件种类。一条 `text#nav link`
在语料里没有任何 `text#nav` 含链接 → 照旧 `unmatched-rule`。

**视图模型**（profile §10）。binding 多一个可选字段 `part`：

```
bindings [{ doc, block, part?, rules, box, params, variants }]
```

有 `part` 的 binding 和没有的是**不同的目标**：`text#nav` 与 `text#nav link` 争 `color` 不是冲突；两条 `text#nav link`
争 `color` 照旧 `ambiguous-rule`。profile §4 的仲裁不改。

**宿主这一侧有个坑**（实施时撞上的，两份文档原本都没写）：部件 binding 和块 binding **共用同一个地址**，`part` 才是
区分它们的字段。宿主把 bindings 建成「地址 → binding」的放置表时必须跳过 `part` 不为空的那些，否则部件 binding 会盖掉
块自己的 `component=` 与 `axis`。表现是页面照常渲染、零诊断，但树不折叠、列表不横排 —— 一个不报错的静默失败。

**部件上的内含词**。只有对一段行内说得通的词才收：`color` `background` `padding` `margin` `border`（四边）
`border-radius` `font-size` `line-height` `font-family` `width` `max-width` `visible`。其余（`sticky` `scroll`
`hide-below` `layer` `grow` `gap` `text-align` `axis` `view` `editable`）写在部件规则上 → `style-unknown-attribute`
warning，消息说明「不是行内部件的词」。

**宿主**。`link → a`，`image → img`，`code → code`，`strong → strong`，`em → em`；选择器 `.geml-b-<id> a { … }`。

#### 13.4b `axis` 允许挂在块上

今天 `axis` 已是内含词，只是限定在 screen/frame 上（"它挂在 screen/frame 上，不挂在块上"）。第二个用例要说的是
「这个列表横着排」。

**语义**。块上的 `axis=row|column`：这个块的**条目**沿哪条轴排。列表横排时不画项目符号。默认 column，即今天的样子。

**为什么通用**。列表、表单、表格的行都有「条目」；段落没有条目，写了不报错也没有效果（和 `gap` 在段落上一样）。

**宿主**。对列表：`display:flex; flex-direction:<axis>; list-style:none; margin:0; padding:0`，配 `gap`。对表单：
字段并排。对其他块：无效果。生成进页面 CSS，不放静态 CSS。

#### 13.4c `view=rendered|source`

**语义**。显示这个块的渲染结果，还是它的源文本。默认 `rendered`。源文本 = 该块在文档里的原文行段；对 `embed`，
是它借来的那份文档的原文（语料里有）。值域封闭，域外 → `style-invalid-value`。

**为什么通用**。任何块都有源文本；「看源码」对段落、表、嵌入、代码块意思一样。

**用法**。配既有的 `when=`，Code 与 Blame 各一条，正是 §12.5「tab 条的每个 tab 一条规则」：

```
=== style-rule {#md       match="embed#doc" view=rendered max-width=1012px font-size=16px line-height=24px}
===
=== style-rule {#md-code  match="embed#doc" when="$tab=Code"  view=source editable=yes}
===
=== style-rule {#md-blame match="embed#doc" when="$tab=Blame" view=source}
===
```

它替掉 `editor` 组件的三个私有键：`state=` 由 `when=` 承担，`source-when="Code · Blame"` 变成两条规则，
`preview-max-width` 就是已有的 `max-width`。

#### 13.4d `editable=yes|no`

**语义**。源文本可不可以改。默认 `no`。只在 `view=source` 时被消费；`view` 解析为 rendered 时它是惰性的，
不报诊断（和 `gap` 在段落上同一态度）。值域封闭。

**为什么通用**。同 c。它说的是「能不能改」，不说「改了存到哪」—— 保存归宿主，§12.5 的边界。viewer 这一版**没有写回路径**：
textarea 是本地草稿，刷新即失。这一点写进 profile，免得有人以为它是编辑器。

#### 13.4e `when=` 多两个内建名：`@hover` `@focus`

**语法**。`when=` 的项从「只有 `$state=value`」变成「`$state=value` 或 `@hover` 或 `@focus`」，逗号并列表示全部满足。
`@` 前缀保证不与任何 `style-state` 撞名。`@` 后面不是这两个名字 → `style-invalid-value`，消息列出两个合法名。

**为什么通用，以及为什么放在 `when=` 而不是选择器**。hover 是「状态 → 样子」的一种，只是状态由指针给、不由
`style-state` 声明。放进 `when=` 正是 §12.5 的边界：样式表声明每个状态下的外观，谁去点是宿主的事。profile §3 拒绝
`:hover` 选择器的那一行**不改**：选择器选内容，`when=` 说状态。

**仲裁**。`@hover` 是普通条件项，进条件集参与 profile §4 的偏序。`when="@hover"` 与 `when="$sidebar=closed, @hover"` 是真超集关系；
`when="@hover"` 与 `when="@focus"` 可以同时成立、互不包含，争同一属性 → `ambiguous-rule`，正是该报的。

**宿主**。目标选择器后缀 `:hover` / `:focus-visible`，块与部件同法：`.geml-b-nav a:hover { … }`。

```
=== style-rule {#navhover match="text#repo-nav link" when="@hover" background="#eaeef2"}
===
```

#### 13.4f rule 上的参数袋收口

**现状**。profile §2.1：rule 上「其余键原样透传为组件参数」，没有未知属性检查。容器早已是「没有 `component=` 就报
`style-unknown-attribute`」。两种块两套规矩，于是本页十个私有键零校验、拼错不报。

**改动**。判在**合并后的绑定**上，不在单条规则上：§4.3 按属性合并，一条规则给 `component=`、另一条更具体的
规则给参数是合法写法（`#base match="table" component=data-table` + `#kpis match="table.kpi" badge=kpi`），装载期
还不知道合并结果。合并之后没有 `component=` / `handler=` 接的参数 → 一条 `style-unknown-attribute` warning，
点出那些键和写它们的规则。`component=` 仍是开放注册表（profile §7）的逃生口，一字不动。
（第一稿写的是「无 `component=` 的 rule 装载期就报」，落地时被 style-check 的既有用例拦下——那条用例正是上面那种写法。）

**影响面**。codemap 播种的样式表（`graph-style.ts` 的 `serializeGraphStyle`）原来**不带** `component=`，四个旋钮
（`fold` `depth` `hide-accessors` `palette`）会被判成没人接。本次给种子加 `component=code-graph`，viewer 注册同名的
透传组件；已经播种在用户仓库里的旧文件会得到一条 warning，旋钮照常读取、渲染不受影响，build 不改写它，用户加一个词即可。
本页十个私有键在 §13.3 落地后全部消失，所以对本页零影响。

#### 核心（GEML-spec §5）：渲染器放行 `{title=}`

GEML-spec §5.2 已允许链接带属性对象，例子是 `{rel=nofollow target=_blank}`。图片同样有属性对象（`{width=…}` 上一轮刚落地）。
改动只在渲染器：链接与图片的 `title` 落到 HTML 的 `title` 属性，`setAttribute` 写、不拼字符串。不是语法改动。

#### 13.4g `layer=screen` 与 `fade-out`（2026-09-11 追加）

页面的开场提示要「盖住整个视口、一秒淡掉」。两件事现有词汇都说不出来，各补一个：

- **`layer` 多一个成员 `screen`**：盖住视口、内容居中、不占版面位置。`page` 跟流走，`overlay` 贴最近的容器，
  `screen` 贴视口 —— 三者的区别是**贴谁**，与内容无关，所以对任何块都是同一个意思。开场提示、模态框、吐司是同一件事。
- **`fade-out=<秒>`**（0–60，默认 0）：画出来之后自己淡掉，淡完 `visibility: hidden`，既看不见也挡不住点击。
  「出现一下就走」放在一段话、一张表、一张图上意思都一样。上限是安全边界：样式表是不可信输入，
  一个荒唐的值不该变成一条永远跑不完的动画。

时间轴上**只有这一个词**。没有 `fade-in`、没有 `delay`、没有关键帧 —— §12.3 的「按第一个真实用例圈死」照旧。
关键帧与「减少动态效果」的让步放在宿主的静态表里（都不带页面常量、不加载任何资源）；秒数由样式表给。

顺带补上一处文档缺口：`layer` / `visible` / `grow` 是第一个页面用例带进来的，实现里有、profile §2.1 的内含词表里
一直没有。这次一并写进去。

#### 13.4h 复审（2026-09-11）：宿主里剩下的两个数搬走了

分支收口后又量了一遍「通用的和特定的分开了没有」。宿主的 JS 干净：`components.js` 与 `layout.js` 里没有一个色值、
没有一个页面尺寸、没有站点名、没有列名合同（只剩 `z-index` 与 `100vh` 这类分层常量）。样式表里私有键为零。
文件那一侧查出两类混放，都已改：

1. **内容文件带着尺寸**。`page.geml` 里有 8 处 `![…](icons/x.svg){width=N}`。图标多大是外观。更糟的是其中三处的数字
   是死的：两处与样式表重复（CSS 赢），一处（`#file-actions` 的 ▾ 写 12）被同块的 `width=16px` 盖掉。全部摘掉，
   缺的四条宽度规则补进样式表。**判据**：`{width=}` 作为核心语法没问题——文章里的一张照片确实可以自己说多大；
   外壳图标不行，那是这一页的外观。
2. **宿主 CSS 里两个样式表够不着的数**。`.geml-items > li { gap: 6px }`（图标与文字之间）和
   `.geml-tree ul { padding-left: 1.2em }`（每层缩进）。前者现在由 `gap` 一并生成：同一个值既管条目之间也管条目
   里面——代价是这两者不能取不同的值，换一个词不值。后者成了 `tree` 的组件参数 `indent=`（§12.3 早把 `indent`
   点名为组件词），组件留一个能看出层级的默认值，值过 `safeCssValue` 同一道闸。

**还没改的一处**，记在这里：`.geml-page a { color: inherit; text-decoration: none }`。整页布局下宿主替所有页面
decide 了「链接不带颜色和下划线」，而 `text-decoration` 不是内含词，样式表**无法**把下划线要回来。要么加这个词，
要么让宿主不要剥、由样式表自己说。两条路都没走，等下一个真实需求。

#### 不进的

- `collapsible`：§12.3 明文归组件词，只对列表说得通 → 留在插件里作 `component=tree`。
- `segments`（把 select 画成分段按钮）：只对一选多说得通 → 插件，`component=segments`。
- `@selected`：本页选中段的白底用系统色 `Canvas` 绕开（§13.9），先不加。
- 任何图标名到路径的映射：图标就是文件，写在数据里。

---

### 13.5 插件（geml-viewer）

#### 13.5.1 删

`components.js` 里的 `bar` `tree`（旧）`tab-bar` `markdown-body` `icon` `field` `editor`，以及 `stateControl` 画「☰」
的那一支。`$state` 槽回到 profile §2.4 的定义：渲染那个块引用状态当前指向的块；对 scalar 状态渲染空占位。
geml.css 257–355 行里所有带色值、尺寸、块 id 的规则。

#### 13.5.2 留，并且不认页面

| 模块 | 内容 | 约多少行 |
|---|---|---|
| 状态存储 | `createState`：初值、`when=` 点名的值、toggle 目标；与今天一致 | 50 |
| 三种喂法 | 块点击（`on=toggle` 的生产者是块 → 包装元素 `role=button` 可点，与容器触发同一段代码）；字段取值（`on=select` 的生产者是 form-field → 控件 change 事件写状态，初值取 `value=`）；容器点击（保留） | 40 |
| 浮层收回 | 只对驱动 `layer=overlay` 变体的状态「点别处关掉」；与今天一致，块触发也走它 | 20 |
| 视图模型 → CSS | `cssForPage`：binding 有 `part` 时选择器接 `a/img/code/strong/em`；`when` 含 `@hover`/`@focus` 时接 `:hover`/`:focus-visible`；块上的 `axis` 生成 flex 声明 | 今天 100 + 30 |
| `tree` | 嵌套列表：带子列表的 `li` 包成 `<details open><summary>…</summary><ul>…</ul></details>`；没有列名、没有缩进算术 | 15 |
| `segments` | `form-field type=select` 画成一组 `button[aria-pressed]`；点哪个，字段值与状态就是哪个 | 25 |
| `view=source` | 取块源文本（embed 取语料里那份文档的 `text`），`editable=yes` 画 `textarea`，否则 `pre` | 15 |
| `title` 放行 | `linkAttrs` 与 `renderMedia` 加一个键 | 2 |

#### 13.5.3 geml.css 页面段的目标形态

约 15 行，零色值；尺寸常量只剩源码框的最小高度，其余尺寸都从样式表生成：

```
.geml-page { margin: 0; }
.geml-frame { display: flex; min-width: 0; min-height: 0; position: relative; }
.geml-frame[data-axis="column"] { flex-direction: column; }
.geml-frame[data-axis="row"] { flex-direction: row; align-items: stretch; }
.geml-frame[data-axis="row"] > .geml-placed { flex: 0 0 auto; }
.geml-placed { min-width: 0; box-sizing: border-box; }
.geml-placed[role="button"], .geml-frame[role="button"] { cursor: pointer; }
.geml-page button { color: inherit; font: inherit; }
.geml-segments { display: inline-flex; }
.geml-segments button { border: 0; background: none; cursor: pointer; }
.geml-segments button[aria-pressed="true"] { background: Canvas; font-weight: 500; }
.geml-source { width: 100%; box-sizing: border-box; min-height: 60vh; }
```

`Canvas` 是系统色，不是页面的色（§13.9）。

---

### 13.6 视图模型（profile §10）的改动

```
bindings  [{ doc, block, part?, rules, box, params, variants: [{ when, box, params }] }]
when      { "$state": value, … } ∪ { "@hover": true, "@focus": true }
```

- `part` 只在部件规则命中时出现，取值封闭（§4a）。
- `when` 的键多两个 `@` 开头的内建名，值恒为 `true`；条件数按项数计，`@hover` 算一项。
- `box` 多 `axis`（块上）、`view`、`editable`。
- 其余字段不动。`--json` 是一致性面，三项都是**新增字段**，旧消费者不读它们就不受影响。

---

### 13.7 诊断（profile §8）的改动

| 诊断 | 级别 | 新增 / 变化 |
|---|---|---|
| `selector-unsupported` | error | 新情形：部件步不在最后、部件步前无块步、部件步带过滤或类 |
| `style-invalid-value` | error | 新情形：`view` `editable` `fade-out` 域外值；`layer=screen` 之外的第四个值；`@` 后不是 `hover`/`focus` |
| `style-unknown-attribute` | warning | 新情形：合并后的绑定没有 `component=` / `handler=` 接的参数（点出键与规则）；部件规则上不适用于行内的内含词 |
| `unmatched-rule` | warning | 部件规则在语料里没有命中任何行内时照旧触发 |
| `ambiguous-rule` | error | 不改；`@hover` 与 `@focus` 争同一属性照旧 |

没有新诊断码。

---

### 13.8 安全

- 部件名与 `@` 内建名都是闭集，编译成固定的 CSS 文本（`a` `img` `:hover` …），不经过任何字符串拼接进入选择器。
- 部件规则上的值仍走 `safeCssValue`：`;` `{` `}` `url(` `/*` 一律不收，不因为目标从块变成行内而放松。
- `title` 用 `setAttribute` 写，内容当文本。
- `editable=yes` 的 textarea 没有写回路径；viewer 不向任何地方发送编辑内容。
- `axis` 生成的声明是固定词（`display:flex` 等），无用户值参与。
- 放置上限 `PLACEMENT_CAP` 不变；部件不算放置，它们是已放置块的子节点。

---

### 13.9 1:1 上刻意退让的四处

| 哪儿 | 现在 | 之后 | 要收回来的话 |
|---|---|---|---|
| 文件树的展开箭头 | chevron-down / chevron-right 两张图随开合切换 | 系统 `::marker` 三角 | 把 chevron 写进数据（不会旋转），或规范加 `marker-open=`/`marker-closed=`，但 CSP 下 `::marker` 引不了图，等于只在 localhost 上像 |
| Issues 后的计数 | `badge` 列 + 专门的 `.geml-badge` | 行内代码 `` `1` `` 由样式画成药丸 | 语义上是「代码」不是「计数」。要区分，行内元素得多一种，那是核心语法的事，本文不碰 |
| 选中的 Tab 段 | 宿主 CSS 写死白底 `#ffffff` + `#d1d9e0` 边 | 宿主一条不含色值的规则：`background: Canvas` | 加 `@selected`，与 `@hover` 同一机制 |
| Blame | 显示源码 | 显示源码 | 不收。Blame 需要 git 历史，不是一份文档能有的东西 |

---

### 13.10 测试要点

**解析器**（`geml-parser`，闸 95%）

- 选择器：部件步解析；`link` 单独 / 不在最后 / 带 `[title]` 三种拒绝各自的消息。
- 候选枚举：段落、列表项（含嵌套）、标题里的行内都被走到；`text#nav link` 在无链接的块上 `unmatched-rule`。
- binding 带 `part`；`text#nav` 与 `text#nav link` 争 `color` 不报；两条 `text#nav link` 争 `color` 报 `ambiguous-rule`。
- 部件规则上写 `sticky` → warning；写 `color` → 进 `box`。
- 块上 `axis=row` 进 `box`；`axis=diagonal` → `style-invalid-value`。
- `view` `editable` 域内/域外；`editable=yes` 无 `view=source` 不报。
- `when="@hover"` 解析；`when="$a=1, @hover"` 条件数 2 且是 `when="@hover"` 的真超集；`@hover` vs `@focus` 争同一属性
  → `ambiguous-rule`；`@hoover` → `style-invalid-value` 消息含两个合法名。
- 无 `component=` 的 rule 写 `icon=` → warning；带 `component=x` 写 `icon=` → 不报且进 `params`；codemap fixtures 零新增诊断。
- 安全：`when="@hover} body{display:none"` 被 `style-invalid-value` 拒；部件规则上 `color="red} .x{"` 被 `safeCssValue` 丢弃。

**viewer**（linkedom + `css-stub-hooks.mjs`，闸 85/85/90/75）

- `cssForPage`：`part=link` 出 `.geml-b-nav a`；`@hover` 出 `:hover`；块 `axis=row` 出 flex 声明与 `list-style:none`。
- `title` 落到 `a`/`img`。
- 块触发：点 `text#ai-caret` 翻 `$aimenu`；浮层开着点别处关掉；点非浮层触发者不误收。
- `segments`：三个按钮、`aria-pressed` 跟状态、点击写字段值与状态。
- `tree`：有子列表的项包 `details[open]`，无子列表的不包。
- `view=source`：embed 的源码来自语料 `text`；`editable=yes` 是 `textarea`，否则 `pre`。
- 端到端：新的 `page.geml` + `github.style.geml` 渲染零诊断，除 `form-options` 外的块全部落位，行内链接与提示语数量
  与上一版一致（上一版实测 84 个链接、28 条提示语）。
- geml.css 页面段 `grep -c '#[0-9a-f]\{3,6\}'` 为 0。

---

### 13.11 落地顺序

每一步之后复刻页都应当仍是 1:1，能在浏览器里看。

1. **解析器 a、b、f**：选择器部件步、块上的 `axis`、rule 参数收口 + 测试。样式表从这一步起能表达导航条。
2. **viewer 第一批**：行内选择器与 `axis` 的 CSS 生成；块触发；`title` 放行；`tree`（新）与 `segments`；
   重写 `page.geml` 与 `github.style.geml` 为列表形态；删 `bar` `icon` `field` `markdown-body` `tab-bar`。看一次页面。
3. **解析器 c、d + viewer `view=source`**：删 `editor`。看一次页面。
4. **解析器 e + viewer `:hover`**：删 geml.css 里最后的调色板。`grep` 色值为 0。看一次页面。
5. **文档**：profile `_CN` 与英文 §2.1 §2.2 §3 §8 §10 §12（profile 自己的章节号）；`docs/illustrated/10-profile-style` 两语增补「第二个用例」；
   设计文档 §12 加一条指向本节的注（已并入，见本节开头）。
6. **GEP-0011 待办**登记（§13.12）。

第 1、3、4 步各是一次 minor 级别的 profile 词汇变化；发版时机由作者定。

---

### 13.12 待办与不做

**GEP-0011 待办**：列表项作为内单元。`#top-nav[5]` 指到第五条，嵌套用 `[2][1]`，`geml get` / `set` 同表格行。
本文不设计它，只记下动机：决策 A 把外壳数据放进列表，坐标系统跟上后可寻址性回到与表格同等。

**不做**：

- 不做富文本编辑；`editable` 是源码框，没有写回。
- 不做 `@selected`、`marker-open=`、行内「计数」元素；四处退让见 §13.9。
- 不改 profile §3 对 `:hover` 选择器、组合子、通配的拒绝。
- 不给 rule 加 `frame=`（§12.4 已议：这一页用不到）。
- 不动 codemap 样式表的任何一行。
