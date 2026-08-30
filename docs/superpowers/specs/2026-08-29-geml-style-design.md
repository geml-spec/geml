# geml-style —— 一个不改动 GEML 规范的应用层样式 profile

- 日期：2026-08-29
- 状态：设计稿（brainstorm 产出，尚未立 GEP）
- 目标：让 `.geml` 文档能被渲染成组件化、可交互的 webapp 界面，而 **GEML 1.0 规范一个字不动**
- **词汇表在别处**：本文是*为什么*。落地后的完整词汇、属性表、诊断目录与视图模型见
  [`docs/design/specs/geml-style/geml-style-profile_CN.md`](../../design/specs/geml-style/geml-style-profile_CN.md)
  —— 那份跟着实现走，本文停在设计当时。

---

## 1. 摘要

`geml-style` 是一个**应用层 profile**——和 `codemap` 同级，"the way schema.org relates to HTML"。
它定义三个带连字符的块类型（`style-rule` / `style-state` / `style-screen`），
把文档里的 block 映射到宿主应用提供的 UI 组件上，并声明一套**闭合的、无环的**跨块联动。

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
| `style-screen` | 屏幕组合（槽位、布局） |

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
| `style-unknown-attribute` | warning | `style-state` / `style-screen` 上的未知键 |

`style-rule` 上**没有**未知键检查：保留键之外的键原样透传为组件参数（§5.4），
那是组件自己的词汇，profile 无权裁决。

**没有 `binding-cycle`。** 构造上不可能，不需要这个码。

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

`--to html` 单张嵌入一个 index 文档时，[render.ts:873](../../geml-parser/src/render.ts) 是一条提前返回：

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
