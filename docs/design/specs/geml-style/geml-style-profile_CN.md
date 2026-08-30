# geml-style profile v1 — 词汇表与约定

*[English](geml-style-profile.md) | 中文*

- 状态：v1，2026-08-30 落地。设计论证见
  [`docs/superpowers/specs/2026-08-29-geml-style-design.md`](../../../superpowers/specs/2026-08-29-geml-style-design.md)。
- 性质：**应用层 profile，不是 GEML 标准的一部分**。GEML 标准保持不动；本文档定义
  样式表把块映射到宿主 UI 组件所用的类型与属性——如同 schema.org 之于 HTML，和
  [codemap](../codemap/codemap-profile_CN.md) 同级。校验器随 `@geml/geml` 包分发：
  `geml style check`（源码 `geml-parser/src/style-*.ts`）。

## 0. 一段话说清

**样式表**是一份普通的 `.geml` 文档，`meta` 里声明 `profile = "geml-style/v1"`，
内含三种块。它**不修改内容文档**——规则用选择器*选中*文档，而不是模板*包裹*文档，
因为内容通常是机器生成、作者改不动的（codemap 输出就是眼前的例子）。它**不含
script**：组件和处理器**只报名字**，实现由宿主提供，与 `diagram {format=…}` 完全
同构的注册表模式。**歧义是构建错误**，不是静默兜底。

## 0.1 稳定性范围 —— 在它上面盖东西之前先读这一节

**v1 里只有一个子集带稳定性承诺**：codemap 的显示旋钮真正用到的那部分。

| 守住的 | 可以变的 |
|---|---|
| `profile = "geml-style/v1"` | `style-state`、`style-screen` |
| `style-rule` | `show=` `filter=` `handler=` `screen=` |
| `match=` | `on=` `value-from=` `init-value=` `type=` `layout=` |
| 属性透传（§2.1） | 守住的子集不会触发的每一条诊断 |

左列守得住，是因为它**已经逃逸**：每次 codemap build 都会往用户仓库里播种一份
`_index/style.geml`，那些文件是真实存在的。右列是**已定义、已检查、无人使用**——
没有任何一份真实样式表用到它。它会**跟着第一个真实用例变形**，而不是为了自己被保留。

这个切分是刻意的，不是道歉。逃逸面被刻意做得极小，**正是为了**让其余部分保持自由：
一个块类型、一个属性，加一个透传——而透传里装的是宿主的词汇，不是 profile 的。

版本写进 profile 名字也是同一个理由。`geml-style/v2` 可以改任何东西，`v1` 的文档
照样解析，因为词汇表注册表是一张以这个名字为键的 map（`geml-parser/src/profiles.ts`）。

## 1. 声明 profile

```
=== meta
profile = "geml-style/v1"
===
```

`profile` 是**空格分隔的列表**，一份文档可同时声明多个
（`profile = "codemap/v1 geml-style/v1"`）。多 profile 取**并集**：校验只问"这个
名字允许吗"，不问"它是什么意思"，所以两个 profile 放行同一个键不是冲突，是同一个
答案说了两遍。注册表在 `geml-parser/src/profiles.ts`。

不声明的话，每条 `style-rule` 都会产生一条 `unknown-block-type` warning——50 条规则
50 条 warning，正是训练人忽略 warning 的做法。声明之后 `geml check` 干净通过。

## 2. 三个块类型

**每个块的 body 一律为空**，信息全写在属性对象里。因为 §3 规定*未注册*类型的 body
"preserved as raw"——核心 parser 不解析它，放进去的结构就检查不了；而属性对象**对
任何类型都会被解析**。属性对象太长时用 §4 的 `\` 续行。

### 2.1 `style-rule` —— 哪些块，怎么画

```
=== style-rule {#edges match="table#calls" component=edge-list selectable}
===
```

| 属性 | 必需 | 含义 |
|---|---|---|
| `match=` | **是** | 选中哪些块的选择器（§3） |
| `component=` | 否 | 用宿主的哪个组件渲染 |
| `handler=` | 否 | 副作用交给宿主的哪个处理器 |
| `show=` | 否 | 呈现 `$state` 当前指向的块 |
| `filter=` | 否 | 用 `$state` 收窄集合（`filter="confidence=$conf"`） |
| `screen=` | 否 | **空格分隔**的屏幕 id；不写＝所有屏幕 |
| *其余任意键* | 否 | **原样透传**为组件参数 |

透传正是规则上没有 `style-unknown-attribute` 检查的原因：`selectable`、
`badge="leaf"`、`collapsed` 属于组件自己的词汇，profile 无权裁决。上表的保留键就是
profile 自己消费的键的全集。

### 2.2 `style-state` —— 一格视图状态，和喂它的东西

```
=== style-state {#sel type=block-ref match="table#calls" on=select value-from=to}
===
```

| 属性 | 必需 | 含义 |
|---|---|---|
| `match=` | **是** | 写这个状态的**产生者**块的选择器 |
| `on=` | **是** | 哪种交互写它。**封闭词汇**：`select` |
| `type=` | 否 | `block-ref`（缺省）或 `scalar` |
| `value-from=` | 否 | 从产生者身上取哪一部分（表就是列名） |
| `init-value=` | 否 | 任何交互发生之前的值 |

`match=` 和 `style-rule` 上是同一个词，因为装的是同一种东西——选择器，白拿 §4 的
检查能力。`value-from=` 特意带方向：`value=to` 会被读成"值设成 `to`"，恰好是反的。

这里的未知键**是** warning（`style-unknown-attribute`）：状态不像规则，没有任何
东西可以透传。

`type=` 不做校验，目前只供人读：值的种类从消费方式就推得出来（`show="$s"` 必是块
引用，`filter="x=$s"` 必是标量）。块类型定大类、`type=` 定小类，是 §7.1
`diagram {type=bar}` 的同一个先例。

**允许多产生者。** 两个块写同一个状态是时序赋值，不是静态冲突，因此不报
`ambiguous-rule`。

### 2.3 `style-screen` —— 一屏放什么

```
=== style-screen {#overview layout=split slots="table#calls, $sel"}
===
```

| 属性 | 必需 | 含义 |
|---|---|---|
| `slots=` | **是** | **逗号分隔**、按序填格。每格是一个选择器或一个 `$state` |
| `layout=` | 否 | 一个名字，由宿主解释（惯例 `single` / `split` / `grid`） |

`$state` 槽位呈现该状态当前指向的块——这就是主从视图里"详情那一侧"的写法。

`layout=` 的**值不做校验**：布局是宿主的事，在这里立一张封闭清单等于 profile 去
立法管一个它不拥有的注册表。但未知**键**仍是 `style-unknown-attribute` warning。

**不提供 `route=`。** 路由是宿主框架的事，样式表再声明一遍就是两套路由打架。
app 侧写 `<GemlScreen id="overview" doc={doc}/>`。

## 3. 选择器语法

```
<type>? (.class)* (#id)? ([key] | [key=value])*      单个简单选择器
#api table.kpi                                       后代（唯一的组合子）
table.kpi, table.summary                             逗号＝分支（等价于写两条规则）
```

词汇正好是 §4 自己那套——类型、`.class`、`#id`、属性存在、属性等值——加一个组合子。
章节即包含关系：标题在块模型里不是容器，所以这层关系是用一个开放的标题栈重建的。

不支持的 CSS 一律**点名报错，而不是静默失配**：

| 拒绝 | 为什么是拒绝而不是忽略 |
|---|---|
| `>` `+` `~` | 子/兄弟组合子——块模型有包含关系，没有次序邻接 |
| `:hover` `:nth-child(…)` | 状态/位置伪类 |
| `*` | 通配符 |
| `^=` `$=` `*=` `\|=` | 模糊匹配——§9.2 不让文档文本进模式语言 |

各报一条 `selector-unsupported`（error）并点出构造名。CSS 相似性要当**坡道**，
不能当**陷阱**。

扫描是**分区**的——伪类只在括号**外**找，模糊算子只在括号**内**找——因为属性值里
完全可能合法地出现 `:`，codemap 的 anchor 就长成 `ts:render.ts#esc(string)`。
一遍过的正则会把它误判成伪类。

## 4. 冲突裁决

合并**按属性进行**。两条规则在**同一个块**上设**同一个属性**时，只有一个关系能裁决：
**条件集的真超集**。选择器的条件 = 它的类型、类、id、属性测试；`screen=` 额外贡献
一个 `screen:<id>`。一方真包含另一方就胜出；否则报 `ambiguous-rule` **错误**。

没有特异性算术，没有 `!important`，**没有源序兜底**。排除源序是刻意的：样式表一旦
顺序敏感，agent 的按块编辑（`geml set`、`geml add --before`）——这个格式存在的理由
本身——就会静默改变渲染结果。

冲突**对着语料判**：两条不可比的规则只有真的在某个块上共现才报错。

诊断把两种情形分开说，因为补救办法不同——对**相同**的选择器建议"写并集"是不可能
执行的（相同集合的并集就是它自己），那一支改成建议删掉一条、或加一个能区分二者的
条件。

## 5. 绑定管道

```
interaction  →  state  →  view
```

单向、三段，且**状态永不读状态**。这不是"环检测碰巧通过"——根本没有图，也就没有环
可成。因此目录里**没有 `binding-cycle` 这个码**。

它同时让管道**与顺序无关**，这一点 §6 的计算列做不到：`style-state` 是顶层块，
agent 随时可能重排。

三个消费算子：

| 算子 | 写法 | 语义 |
|---|---|---|
| select | `show="$sel"` | 呈现 `$sel` 指名的块 |
| filter | `filter="confidence=$conf"` | 用状态收窄集合 |
| project | `title="$sel.caption"` | 从状态指向的块取字段 |

没有条件、没有查表、没有跨文档引用、没有算术——克制程度对齐 §6。需要算术就用 §6 的
计算列。

**三个算子由运行时执行，不由组件执行。** 组件收到的是**已解析的结果**：已过滤的行、
已选定的块。若交给组件自行解释，每个组件作者都要重实现一遍语义、实现会分叉，而
`unknown-value-source` 一类检查也会从保证退化成建议。

**检查期**只验算子里的**引用存在性**——每个 `$name` 必须被某个 `style-state` 声明。
求值是运行时的事。

## 6. 分隔符约定

一条规矩，而且不是随意定的：

- **名字列表用空格**——`profile`、`screen=`、`palette`、codemap 的 `entry`。
- **选择器列表用逗号**——`match=`、`slots=`。

因为**空格在选择器里是后代组合子**。按空白切 `slots=` 会把 `#api table.kpi` 劈成
两个槽位，两个都选不中任何东西，还附送一条完全不解释真正原因的 `unmatched-rule`。
（实测出来的，不是推演出来的——这条约定就是这么找到的。）

## 7. 封闭词汇 vs 开放注册表

| 种类 | 例子 | 未知成员 |
|---|---|---|
| **封闭**——运行时自己解释这些名字 | `on=` | **error**（`unknown-interaction`） |
| **开放**——宿主注册的名字，profile 根本看不见 | `component=`、`handler=` | **warning** + 惰性回退 |

核心 GEML 早就这么划线：`chart-unknown-type` 是 error，`unknown-diagram-format` 是
warning。开放那侧必须降级而不能拒收，否则 §8.5 的前向兼容机制就失效了。

`unknown-component` / `unknown-handler` **只在调用方声明了注册表时**才检查
（`--components=`、`--handlers=`）。不给旗标就不跑——一条永远不会触发的诊断比没有
更糟，而**假装检查过**比这还糟。

## 8. 诊断目录

这些码属于**本 profile 的目录**，刻意不进 GEML 规范的 Appendix A——profile 不是规范。

严重性哲学：**结构性错误 = error；未知名字 = warning + 惰性回退**，以保住 §8.5。

| 码 | 严重性 | 抓什么 |
|---|---|---|
| `selector-unsupported` | error | 不支持的 CSS 构造，点名 |
| `ambiguous-rule` | error | 相同或不可比的规则争同一个属性 |
| `unknown-state` | error | 规则或槽位引用了没人声明的 `$foo` |
| `unknown-screen` | error | `screen=` 点名的 `style-screen` 不存在 |
| `unknown-value-source` | error | `value-from=` 不是目标表的列 |
| `unknown-interaction` | error | `on=` 不在封闭的交互词汇里 |
| `style-missing-attribute` | error | 缺必需属性 |
| `unmatched-rule` | warning | 规则（或屏幕槽位）在语料里选不中任何块 |
| `unmatched-producer` | warning | 状态的 `match=` 选不中任何块 |
| `unknown-component` | warning | 不在声明的注册表里 → 惰性渲染 |
| `unknown-handler` | warning | 不在声明的注册表里 → 惰性渲染 |
| `style-unknown-attribute` | warning | `style-state` / `style-screen` 上的未知键 |

`unknown-value-source` 之所以能真查，是因为 §6 给了表真正的 schema。产生者不是表时
这项检查**跳过**，不猜。

`unmatched-rule` 是样式层的 `bad-source-range`：样式表内部自洽，但已经和它所样式化
的语料漂移了。

## 9. 校验

```
geml style check <stylesheet.geml> <corpus…> [--json] [--components=a,b] [--handlers=x,y]
```

干净或只有 warning 时 exit 0，有 error 时 1，用法错误 2。`--json` 打印视图模型。

## 10. 视图模型 —— 本 profile 的一致性面

`--json` 就是第二实现必须对齐的东西（§8.4 的形状），也是宿主消费的东西。四个字段：

| 字段 | 形状 |
|---|---|
| `states` | `{id, type, on, valueFrom?, initValue?}[]` |
| `screens` | `{id, layout?, slots, bindings}[]` |
| `bindings` | 未限定屏幕的那张表 |
| `diagnostics` | `{severity, code, message, rule?}[]` |

一条**绑定**是 `{doc, block, rules, params}`。`doc` **不是冗余的**：§4 只保证 id 在
*单份文档内*唯一，而一份样式表配一整个目录才是常态，所以两份文档里各有一个
`#budget` 完全合法。没有 `doc`，消费者无法把绑定 join 回正确的块。

**绑定按屏幕分表。** `screen=` 让同一个块在不同屏幕里有不同展示，所以全局一张表不
可能存在；顶层 `bindings` 是未限定屏幕的那张，每个 `screens[].bindings` 是该屏幕的。
消费者查绑定必须带屏幕上下文。

**槽位是已解析的**，绝不是选择器字符串：

```json
{"kind": "blocks", "selector": "table#calls", "blocks": [{"doc": "…", "block": "#calls"}]}
{"kind": "state",  "state": "sel"}
```

拿到原始选择器的消费者只能在运行时把构建期的求解重做一遍，而山寨的运行时匹配器必然
和构建期语义分叉。这条是消费者 spike 抓出来的：它被迫写了个只认 `type#id` 的
`slotMatches()`。

## 11. 实例：codemap 的显示旋钮

第一份真实的样式表，是 codemap 在 `<codemap>/_index/style.geml` 播种的那份：

```
=== meta
profile = "geml-style/v1"
title = "codemap graph style"
===

=== style-rule {#graph match="diagram[format=geml-code-graph]" \
                fold=1 depth=6 hide-accessors=true \
                palette="#e3f2fd #e8f5e9 …"}
===
```

里面每个旋钮都是**组件参数**（§2.1 的透传），不是 profile 词汇——`fold`、`depth`、
`hide-accessors`、`palette` 是 code-graph 渲染器自己的词。`palette` 是**名字**列表，
所以空格分隔（§6）。

它和 `foldings.geml` 并排放着，这一对正是要点：`foldings.geml` 调**构建期**的模块
命名，`style.geml` 调**显示**。两份都在首次 build 时播种，之后的 build 永不重写。
在此之前，显示那一半写死在渲染器里，于是"想调展示"就得改一个服务所有人的渲染器，
每个改动都被迫必须通用。

渲染器**没有被替换**，改的只是那些数字从哪儿来。因此它的默认值必须逐个等于今天的
行为，既有的 codemap 测试才会原样通过。样式表缺失或读不了时退回内置默认值——也就是
这个文件出现之前的行为。

## 12. 版本与范围

`geml-style/v1`。新增一个词汇成员就是新版本；profile 名是兼容单位，未知成员按 §7
降级。

**v1 刻意没有的东西**：任何形式的 script；URL（dev/staging/prod 地址不同，写死会让
样式表绑定环境）；路由；设计令牌之外的主题化（复用 `data` 块，GEP-0005）；
三种块的 body 内容。

**已定义但尚未被真实样式表验过**：§0.1 右列的全部。其中 `filter=` 从没对着真实噪音
跑过（mustapi 的边全是 `kind=call`、confidence 全空，没有可过滤的东西），`handler=`
没有真实宿主，封闭的 `on=` 只有一个成员因为真正接线的交互只有一种。它们是被规定和
被检查的，不是被实战验过的——§0.1 写清了这买到的是什么。

`geml style check` 在 `geml --help` 里标着 EXPERIMENTAL，就是这个原因。它能用、有
测试，但词汇没定——你可以指望它今天是对的，不能指望它明年还叫这个名字。
