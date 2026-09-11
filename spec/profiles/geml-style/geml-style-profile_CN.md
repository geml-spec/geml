# geml-style profile v1 — 词汇表与约定

*[English](geml-style-profile.md) | 中文*

- 状态：v1，2026-08-30 落地。设计论证见
  [`docs/design/specs/2026-08-29-geml-style-design.md`](../../../docs/design/specs/2026-08-29-geml-style-design.md)。
- 性质：**应用层 profile，不是 GEML 标准的一部分**。GEML 标准保持不动；本文档定义
  样式表把块映射到宿主 UI 组件所用的类型与属性——如同 schema.org 之于 HTML，和
  [codemap](../geml-codemap/geml-codemap-profile_CN.md) 同级。校验器随 `@geml/geml` 包分发：
  `geml style check`（源码 `geml-parser/src/style-*.ts`）。

## 0. 一段话说清

**样式表**是一份普通的 `.geml` 文档，`meta` 里声明 `profile = "geml-style/v1"`，
内含三种块。它**不修改内容文档**——规则用选择器*选中*文档，而不是模板*包裹*文档，
因为内容通常是机器生成、作者改不动的（codemap 输出就是眼前的例子）。它**不含
script**：组件和处理器**只报名字**，实现由宿主提供，与 `diagram {format=…}` 完全
同构的注册表模式。**歧义是构建错误**，不是静默兜底。

**看一个。** [`playground/style-demo/`](../../../playground/style-demo) 是照这套
排出来的一整页 —— GitHub blob 页的 1:1 复刻，每一个字在 `page.geml`，每一个颜色、
尺寸和状态在 `github.style.geml`。它要装 `geml-viewer` 并在本地起服务；
[playground 的 README](../../../playground/README.md#the-page-layout-demo-style-demo)
说清了为什么，也给了那两条命令。

## 0.1 稳定性范围 —— 在它上面盖东西之前先读这一节

**v1 里只有一个子集带稳定性承诺**：codemap 的显示旋钮真正用到的那部分。

| 守住的 | 可以变的 |
|---|---|
| `profile = "geml-style/v1"` | 带 `filter=` / `show=` 消费者的 `style-state` |
| `style-rule` · `match=` · `when=` | `handler=`（还没有真实宿主） |
| `style-screen` · `style-frame` · `slots=` · `axis=` · 容器上的 `component=` | 两个真实状态之外的 `value-from=` / `init-value=` |
| §2.1 的内含词 | `#sitemap` 那一列（表存在，但真实的 map 里还没人用） |
| 属性透传（§2.1） | 守住的子集不会触发的每一条诊断 |
| 样式入口：路径 + `default-style`（§1.1） | |
| `on=select` · `on=toggle` | |

左列守得住，是因为它**已经逃逸**——两次。每次 codemap build 都会往用户仓库里播种
`_index/style.geml` **和它的入口 `_index/index.geml`**，那些文件是真实存在的，而且在
渲染路径上——渲染器只经那个入口找样式表；而自 2026-09-09 起，文档布局用例（viewer
渲染的一整页）用上了 screen、frame、内含词和 `when=`。右列是**已定义、已检查、无人使用**
——它会**跟着第一个真实用例变形**，而不是为了自己被保留。

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
（`profile = "geml-codemap/v1 geml-style/v1"`）。多 profile 取**并集**：校验只问"这个
名字允许吗"，不问"它是什么意思"，所以两个 profile 放行同一个键不是冲突，是同一个
答案说了两遍。注册表在 `geml-parser/src/profiles.ts`。

不声明的话，每条 `style-rule` 都会产生一条 `unknown-block-type` warning——50 条规则
50 条 warning，正是训练人忽略 warning 的做法。声明之后 `geml check` 干净通过。

## 1.1 样式入口——一个根怎么说明自己怎么渲染

一份样式表可以直接交给工具（`geml style check <样式表> <文档>`）。但一个**目录**要说明
"我这一堆文档该怎么渲染"，就需要一个约定的位置：

```
<root>/_index/index.geml
```

任何 GEML 根都只有这一个路径，宿主只探它。名字用来找，`meta.profile` 用来**认**——那个
路径上放了别的东西时按"没有样式入口"处理，不硬当入口解析。

入口用两个键说明加载哪几份样式表：

| 键 | 是什么 |
|---|---|
| `default-style`（meta 键） | 本根的**默认样式表**。命中与否都加载 |
| `#sitemap`（一张表） | `document` / `template` 两列，文档名 → **额外**的样式表 |

```
  === meta
  profile = "geml-style/v1"
  default-style = "style.geml"
  ===

  === table {#sitemap}
  | document | template |
  |---|---|
  | index.geml | home.geml |
  ===
```

`#sitemap` 是**精确匹配**：没有 glob，没有级联，没列进来的文档就只有默认层。这和 §4
拒绝特异性算术是同一个态度——查表要能一眼看出结果。键是根相对的文档名。

两个键都是**一次隐式 `embed`**：声明它们等于在入口开头写了对应的 `=== embed {src=…}`。
所以它们不是新的装载机制，环检测、深度上限和诊断全部沿用 `embed` 那一套——一份
`default-style` 指向自己的入口会照常报环。

因此"本根的默认是哪一份"只有一处答案，三方共用：宿主把入口原样交给装载器，
`geml style check <入口> <文档>` 直接可用，而模板里写 `embed {src=index.geml}` 就是
"给我本根的默认，不管它叫什么"——默认样式表改名时模板不用跟着改。

`embed` 本身是 GEML 的 include，不是本 profile 的词汇；样式表用它组合（一份共享的默认层
加本地例外）。装载器展开它时和渲染器用**同一个** `selectEmbed`：另写一份匹配器迟早和
构建期语义分叉。展开在**装载期**完成，所以展开之后所有规则都在同一张表里。

显式 `embed` **不**开新层（§4.1）：拉进来的规则和引用它的文件同层。层只由样式入口产生，
所以"这份文档有几层"查一个固定路径就能答出来，不取决于 `embed` 嵌了多深。

## 2. 四个块类型

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
| `when=` | 否 | `$state=value` 项，以及内建的 `@hover` / `@focus`，逗号并列、全部满足；只做相等（§4） |
| *其余任意键* | 否 | **原样透传**为组件参数——内含词除外，见下。**合并后**的绑定（§4）没有 `component=` / `handler=` 接的参数报 `style-unknown-attribute`（warning） |

**内含词。** 一小组封闭的属性是 profile 自己的、不是组件的：它们放在段落、表格、图上意思
都一样，所以每个宿主同解（CSS 属性 / Web Components 属性那条分界线的 CSS 那一侧）。它们在
这里被消费、落进视图模型的 `box`；组件在 `params` 里永远看不到它们，所以不可能把 `width`
另解释成别的意思。

| 词 | 值域 | 挂在 |
|---|---|---|
| `width` `max-width` `padding` `margin` | 开放（CSS 长度） | 块与容器 |
| `sticky` | 数字：距顶 px | 块与容器 |
| `scroll` | `own` \| `page` | 块与容器 |
| `hide-below` | 数字：视口窄于此 px 则隐藏 | 块与容器 |
| `font-size` `line-height` `font-family` `color` `background` `border` `border-radius` | 开放 | 块与容器 |
| `text-align` | `left` \| `center` \| `right` \| `justify` | 块与容器 |
| `gap` | 开放（CSS 长度）：槽位之间的间距；块带 `axis` 时既是条目之间的间距，**也是**一条条目里面图标与文字之间的间距 | 容器，以及带 `axis` 的块 |
| `axis` | `row` \| `column`（默认 `column`） | `style-screen` / `style-frame`；以及块——它的条目（列表的项、表单的字段）沿这条轴排，横排的列表不画项目符号 |
| `layer` | `page` \| `overlay` \| `screen`（默认 `page`） | 块与容器：跟着文档流；贴着最近的容器浮出来、不占位置（下拉菜单）；或盖住整个视口、内容居中（开场提示、模态框、吐司） |
| `visible` | `yes` \| `no`（默认 `yes`） | 块与容器：**现在**显不显示。`hide-below` 是「不显示」按视口的那一半，这是按状态的那一半 |
| `grow` | `yes` \| `no`（默认 `no`） | 块与容器：这一格吃不吃行/列里剩下的空间 |
| `fade-out` | 秒数，0–60（默认 0，不淡） | 块与容器：画出来之后自己淡掉，淡完也不再接点击。时间轴上只有这一件事；宿主遇到「减少动态效果」时直接跳到终点 |
| `view` | `rendered` \| `source`（默认 `rendered`） | 块：显示渲染结果，还是它的源文本 |
| `editable` | `yes` \| `no`（默认 `no`） | `view=source` 下的块：源文本可以就地改；否则惰性。它不说改了存到哪——没有写回路径的宿主给的是一个草稿框 |

容器收同一批词，含义也同一个：块上的 box 说**这一块**长什么样，容器上的说**这一片区域**
长什么样。有些话只有容器说得出——整页的底色（`style-screen` **就是**页，它的
`background` 就是页面底色）、槽位之间的间距、一片区域的内边距。把这些挂到碰巧在那儿的
某个块上，版面就变成"谁排在第一个"的函数了。

容器也可以点名 `component=`，这时既不是保留键、也不是内含词的键会原样透传给它当参数——
和规则上一模一样。**页面外壳**就住在这里：顶栏、面包屑、一个图标都不是文档，为了让样式表
有东西可指而把它们当块塞进文档，页面里就会多出一堆不是内容的「内容」。容器没有
`component=` 时没人接参数，所以那种情况下不认识的键仍然是 `style-unknown-attribute`——
那就是笔误。

封闭值域会被检查（`style-invalid-value`）；开放的原样交给宿主——宿主必须把它们当作不可信文本。
生成 CSS 的宿主只能接长度、颜色、关键字形状的值；`width` 写成 `0} body{display:none}` 是跳出规则，
不是宽度，丢弃并警告。清单按第一个真实页面圈死，
一次只按实测需要加一个；第二个页面（一个文档阅读器的外壳，2026-09-10）加了块上的 `axis`、
`view`、`editable`。判据：*换个块还是不是这个意思？*——`fold`、`collapsible`、`indent`
不是，所以仍是组件参数。

**参数要有接收方。** `selectable`、`badge="leaf"`、`collapsed` 属于组件自己的词汇，profile
无权裁决——所以规则自己没有 `style-unknown-attribute` 检查。但 §4 按属性合并，合并之后一个块
要么有 `component=`（或 `handler=`）、要么没有。合并后的参数没人接的绑定报一条
`style-unknown-attribute`（warning），点出那些键和写它们的规则：这些键永远不会被读，那正是
笔误的样子。判在绑定上而不是规则上，因为一条规则给组件、另一条更具体的规则给参数是合法写法。
上表的保留键加内含词，就是 profile 自己消费的键的全集。

**行内部件。** 选择器以部件步（§3）收尾的规则，给选中块**里面**的某一类行内上样式——
`text#nav link` 是 `#nav` 里的每个链接。那里只收对一段文字说得通的词：`color` `background`
`padding` `margin` `border`（及四边）`border-radius` `font-size` `line-height` `font-family`
`width` `max-width` `visible`。别的内含词写在部件规则上报 `style-unknown-attribute`（warning）
并丢弃——链接上的 `sticky` 不是一个东西。

### 2.2 `style-state` —— 一格视图状态，和喂它的东西

```
  === style-state {#sel type=block-ref match="table#calls" on=select value-from=to}
  ===
```

| 属性 | 必需 | 含义 |
|---|---|---|
| `match=` | **是** | 写这个状态的**产生者**块的选择器 |
| `on=` | **是** | 哪种交互写它。**封闭词汇**：`select`（值是选中的那个）、`toggle`（值在两个之间翻） |
| `type=` | 否 | `block-ref`（缺省）或 `scalar` |
| `value-from=` | 否 | 从产生者身上取哪一部分（表就是列名） |
| `init-value=` | 否 | 任何交互发生之前的值 |

`form-field`（geml-form/v1）可以当产生者：`on=select` 下状态就是控件自己的值——选中哪一项，
状态就是那一项。不写 `init-value=` 时状态从字段的 `value=` 起。一选多本来就是表单字段，
profile 不为 tab 另造词。

`match=` 和 `style-rule` 上是同一个词，因为装的是同一种东西——选择器，白拿 §4 的
检查能力。`value-from=` 特意带方向：`value=to` 会被读成"值设成 `to`"，恰好是反的。

这里的未知键**是** warning（`style-unknown-attribute`）：状态不像规则，没有任何
东西可以透传。

`type=` 不做校验，目前只供人读：值的种类从消费方式就推得出来（`show="$s"` 必是块
引用，`filter="x=$s"` 必是标量）。块类型定大类、`type=` 定小类，是 §7.1
`diagram {type=bar}` 的同一个先例。

**允许多产生者。** 两个块写同一个状态是时序赋值，不是静态冲突，因此不报
`ambiguous-rule`。

### 2.3 `style-screen` —— 一页

```
  === style-screen {#page axis=column slots="text#global-header, text#repo-tabs, #body"}
  ===
```

| 属性 | 必需 | 含义 |
|---|---|---|
| `slots=` | **是** | **逗号分隔**、有序。每个槽位是一个语料选择器、一个 `$state`，或一个裸 `#id`——本样式表里的某个 `style-frame` |
| `axis=` | 否 | `row` 或 `column`（默认）：槽位沿容器横排还是竖排 |
| `component=` | 否 | 宿主命名的特殊排布（`grid` 之类）；可选、不校验——排布是宿主的事 |

`$state` 槽位呈现该状态当前指向的块——这就是主从视图里"详情那一侧"的写法。

screen 是**根**：一整页。一份样式表能有几个根是**宿主**的规则，不是 profile 的——codemap
的 master/detail 有好几个；渲染"这一页"的 viewer 要恰好一个，0 个退回它的普通渲染，
2 个拒绝。

**槽位语法。** 裸 `#x` 是 frame 引用；带类型、类或属性的（`text#x`、`table.kpi`、
`#x[attr]`）是语料选择器。这是**语法**上的区分，不需要查表、不需要消歧诊断，写错的
`#bdoy` 是错误（`unknown-frame`）而不是警告。它遵循 GEML 自己的约定：裸 `#id` 指本文档，
别的文档要带路径。

**不提供 `route=`。** 路由是宿主框架的事，样式表再声明一遍就是两套路由打架。

### 2.4 `style-frame` —— 页内的一块区域

```
  === style-frame {#body axis=row slots="table#file-tree, #main"}
  ===
```

属性与 `style-screen` 相同。frame 只能出现在某个槽位点名它的地方，它自己的槽位可以再点名
别的 frame——一页是一棵 frame 树。它不是 `<iframe>`：不是独立文档、不隔离任何东西，就是
一个盒子。

| 检查 | 码 | 级别 |
|---|---|---|
| `slots=` 里的裸 `#x` 没有对应 frame | `unknown-frame` | error |
| 裸 `#x` 指到了 `style-screen`——页不能装进页 | `screen-nested` | error |
| frame 嵌套成环（`#a → #b → #a`；消息带整条链） | `frame-cycle` | error |
| 某条放置路径上嵌套深过 16 层 | `frame-too-deep` | error |
| 没有任何槽位引用的 frame | `unused-frame` | warning |

一个 frame **可以**被多个槽位放置：每放一处就再渲染一遍，等于同样的块出现两次——和把那些
块在两个槽位里各点名一次完全一样，所以没有什么要禁止的。嵌套因此是一张以 screen 为根的
DAG，不严格是树；深度取最长的那条放置路径。

深度上限是**安全边界**，不只是形状规则。样式表和任何文档一样是不可信输入（§9）：一万个
frame 串成一条链——哪儿都没有环——宿主就得渲染一万层盒子。上限取 16：GitHub 的 blob 页是
四层，`embed` 出于同一个理由早就有同类上限（8）。校验器对每个 frame 只访问一次、深度用一遍
拓扑 DP 算出，所以恶意样式表——包括四十层的菱形链——都只花线性时间。

校验器的线性不等于宿主的线性。一个 frame 可以放进多个槽位，所以嵌套 × 复用是乘法：每层两个
槽位指向同一个子 frame、叠 16 层，就是 65 536 份叶子——校验器只访问一次、放行。因此宿主要
给一页**放置**的块和 frame 数量设上限（浏览器 viewer：2 000），超了就不带样式表渲染，和
`embed` 总量上限同一个做法。

## 3. 选择器语法

```
<type>? (.class)* (#id)? ([key] | [key=value])*      单个简单选择器
*                                                    任意节点（只能整步）
#api table.kpi                                       后代（唯一的组合子）
table.kpi, table.summary                             逗号＝分支（等价于写两条规则）
text#nav link                                        行内部件：只能是最后一步，前面要有块步
```

选择器可以以**行内部件**收尾——`link`、`image`、`code-span`、`strong`、`emphasis`——指选中块
里面的某一类行内（`text#nav link` 是 `#nav` 里的每个链接，嵌套列表里的也算）。名字取 §5.1
自己的叫法：`code` 已经是块类型，所以代码段叫 `code-span`。部件步必须是最后一步、前面要有块步、
不带 `#id` / `.class` / `[attr]`，一条 `match=` 的分支不能部件与块混写——各报 `selector-unsupported`。
`*` 与块选择器永不匹配部件，槽位也永不摆部件：部件跟着自己的块走。

`*` 匹配任意节点，且**只有整步**才合法——`*.kpi`、`table.a*` 照旧拒绝。它之所以存在，
是因为一个槽位要按文档顺序摆下整篇文档时，别无写法：两个块之间的散文段落身上没有
class 可选。

选择器能匹配的节点有三类：类型块、**标题**（`heading`，层级是属性：`heading[level=1]`），
以及块之间的**散文**（`prose`）。标题和散文在核心里本来就可寻址（`geml list` 会给它们地址），
一个给文档排版的层没有道理摆不了它们。块**内部**的段落是那个块的内容、不是文档的一节，
不算候选。

词汇正好是 §4 自己那套——类型、`.class`、`#id`、属性存在、属性等值——加一个组合子。
章节即包含关系：标题在块模型里不是容器，所以这层关系是用一个开放的标题栈重建的。

不支持的 CSS 一律**点名报错，而不是静默失配**：

| 拒绝 | 为什么是拒绝而不是忽略 |
|---|---|
| `>` `+` `~` | 子/兄弟组合子——块模型有包含关系，没有次序邻接 |
| `:hover` `:nth-child(…)` | 状态/位置伪类——选择器选内容；指针的状态写在 `when="@hover"`（§2.1） |
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
一个 `screen:<id>`；`when=` 的每一项额外贡献一个 `when:<state>=<value>`。一方真包含
另一方就胜出；否则报 `ambiguous-rule` **错误**。

`when=` 进条件集之后裁决原样成立：同选择器的有条件规则是无条件那条的真超集，它赢——
在运行时、当它的状态成立时。两条有条件规则若 `when=` 集合**互斥**（同一状态、不同值）则
永不同时生效，不算冲突；能同时成立、互不包含、又争同一属性的两条，照旧是 `ambiguous-rule`。

没有特异性算术，没有 `!important`，**没有源序兜底**。排除源序是刻意的：样式表一旦
顺序敏感，agent 的按块编辑（`geml set`、`geml add --before`）——这个格式存在的理由
本身——就会静默改变渲染结果。

冲突**对着语料判**：两条不可比的规则只有真的在某个块上共现才报错。

诊断把两种情形分开说，因为补救办法不同——对**相同**的选择器建议"写并集"是不可能
执行的（相同集合的并集就是它自己），那一支改成建议删掉一条、或加一个能区分二者的
条件。

### 4.1 层——唯一按来源裁决的地方

§1.1 的样式入口把样式表排成**层**。层号是声明出来的，不是从选择器算出来的：

| 层 | 来源 |
|---|---|
| 0 | `default-style` |
| 1 | `#sitemap` 命中的那份 |
| 2 | 入口自己写的规则 |

**跨层冲突按层号裁决，上层胜；层内一切照上面不变。** 也就是说 `match="#hero"` 能压过
默认层的 `match="note"`，是因为它在更上面那一层——不是因为 id 选择器"更值钱"。这是
CSS `@layer` 的模型，不是 specificity：层号来自入口的两个键，选择器一个字都不参与。

没有这一条，上面那套就不够用。默认层给**类型**定规则、覆盖层给**具体块**定规则，是这个
profile 最常见的写法，而这两种选择器的条件集互不包含——每一处都会撞 `ambiguous-rule`。
实测过：首页那五份文档在没有层的时候全部报错。

**排除源序的那个理由依然成立**，这一点要说清楚：层不是文件里的行序。同一层内没有顺序；
`#sitemap` 是精确匹配，所以改行序不改结果；层数由入口那两个键固定。agent 的按块编辑
（`geml set`、`geml add --before`）因此仍然不会静默改变渲染——那正是排除源序要守的东西。

代价是诚实的：§4 开头"裁决与规则来自哪个文件无关"从此只对**层内**成立。换来的是
"默认层 + 例外"这个写法能用；不换，它就得靠每条覆盖规则重复默认层的条件（写成
`match="note#hero"`）才不报错。

## 5. 绑定管道

```
interaction  →  state  →  view
```

单向、三段，且**状态永不读状态**。这不是"环检测碰巧通过"——根本没有图，也就没有环
可成。因此目录里**没有 `binding-cycle` 这个码**。

这句话说的是**状态**。frame（§2.4）是第二张图——区域装区域——它能成环，所以有 `frame-cycle`。
两张图不相干：状态永不读状态，frame 不持有状态。

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
| `selector-unsupported` | error | 不支持的 CSS 构造，点名；以及部件步不在最后、前面没有块步、带过滤、与块分支混写——还有槽位里写了部件 |
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
| `style-unknown-attribute` | warning | `style-state` / `style-screen` / `style-frame` 上的未知键；合并后的绑定没有 `component=` / `handler=` 接的参数（§2.1）；部件规则上只对块说得通的内含词 |
| `style-embed-not-expanded` | warning | 一条 `embed`（含 §1.1 的两个隐式 embed）一条规则也没贡献 |
| `unknown-frame` | error | `slots=` 里的裸 `#x` 没有对应的 `style-frame` |
| `screen-nested` | error | `slots=` 里的裸 `#x` 指到了 `style-screen` |
| `frame-cycle` | error | frame 嵌套成环；消息带整条链 |
| `frame-too-deep` | error | 某条放置路径上 frame 嵌套深过 16 层 |
| `unused-frame` | warning | 没有任何槽位引用的 `style-frame` |
| `style-invalid-value` | error | 封闭值域的内含词（`axis` / `scroll` / `sticky` / `hide-below` / `layer` / `visible` / `grow` / `view` / `editable` / `fade-out`）取了域外值，或 `when=` 的项既不是 `$state=value` 也不是 `@hover` / `@focus` |

`unknown-value-source` 之所以能真查，是因为 §6 给了表真正的 schema。产生者不是表时
这项检查**跳过**，不猜。

`unmatched-rule` 是样式层的 `bad-source-range`：样式表内部自洽，但已经和它所样式化
的语料漂移了。

`style-embed-not-expanded` 是 warning，不是 error，因为它和 `style-unknown-attribute`
同一性质：**我们忽略了作者写下的东西，该说出来。** 消息里带原因——读不到、锚点不存在、
成环、或者调用方没给文档解析钩子。沉默才是这里最坏的结果：一份看起来组合好了的样式表，
实际只有本文件那几条规则生效，页面少一大块而没有人吭声。

## 9. 校验

```
geml style check <stylesheet.geml> <corpus…> [--json] [--components=a,b] [--handlers=x,y]
```

干净或只有 warning 时 exit 0，有 error 时 1，用法错误 2。`--json` 打印视图模型。

## 10. 视图模型 —— 本 profile 的一致性面

`--json` 就是第二实现必须对齐的东西（§8.4 的形状），也是宿主消费的东西。四个字段：

| 字段 | 形状 |
|---|---|
| `states` | `{id, type, on, valueFrom?, initValue?}[]`——`on` 是 `select` 或 `toggle` |
| `screens` | `{id, axis, component?, slots, bindings}[]`——根 |
| `frames` | `{id, axis, component?, slots}[]`——平铺、按 id 引用；自己没有 bindings |
| `bindings` | 未限定屏幕的那张表 |
| `diagnostics` | `{severity, code, message, rule?}[]` |

一条**绑定**是 `{doc, block, part?, rules, params, box, variants}`。`part` 只在部件规则（§3）
造出的绑定上出现，写的是行内种类——`link` `image` `code-span` `strong` `emphasis`；这种绑定
和它的块同地址，但在 §4 的裁决里是另一个目标。`variants[].when` 里内建的 `@hover` / `@focus`
作为键出现，值恒为 `"true"`。`params` 是组件的词（含
`component` / `handler` / `show` / `filter`）；`box` 是 §2.1 的内含词，单独放着，宿主统一
处理、组件永远看不到。`variants` 是 `{when, box, params}[]`——只在每一项 `when`
（`{state: value}`）都成立时才叠上的那部分——按条件数升序、同数按样式表内出现序，运行时
把匹配的依次叠上去，不再裁决。`doc` **不是冗余的**：§4 只保证 id 在
*单份文档内*唯一，而一份样式表配一整个目录才是常态，所以两份文档里各有一个
`#budget` 完全合法。没有 `doc`，消费者无法把绑定 join 回正确的块。

**绑定按屏幕分表。** `screen=` 让同一个块在不同屏幕里有不同展示，所以全局一张表不
可能存在；顶层 `bindings` 是未限定屏幕的那张，每个 `screens[].bindings` 是该屏幕的。
消费者查绑定必须带屏幕上下文。

**槽位是已解析的**，绝不是选择器字符串：

```json
{"kind": "blocks", "selector": "table#calls", "blocks": [{"doc": "…", "block": "#calls"}]}
{"kind": "state",  "state": "sel"}
{"kind": "frame",  "frame": "body"}
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

渲染器**只经 §1.1 的样式入口**找这份文件，不直接去读 `_index/style.geml`。所以 build
播种的是**两份**：样式表，和指向它的 `_index/index.geml`。只播前者，那份样式表就没有
入口可达。入口缺失时同样退回内置默认值，补法是重新 build——没有"找不到入口就直读
style.geml"的回落，因为那等于永久留着第二条发现路径、两套语义。

这里的叠加粒度是**键对键**：`#sitemap` 指派的那份只覆盖它自己写了的旋钮，没写的落回
`default-style` 那一层。所以每层都只能读出"这份文档真的写了"的键——一层把默认值写死，
就分不清"它要 fold=1"还是"它没提 fold"，上层的显式值会被下层的默认值盖掉。

## 12. 版本与范围

`geml-style/v1`。新增一个词汇成员就是新版本；profile 名是兼容单位，未知成员按 §7
降级。

**2026-09-10——第二个真实页面**（一个文档阅读器的外壳，由列表和表单字段排出来）：
选择器的行内部件步（§3）；块上的 `axis`、`view`、`editable`（§2.1）；`when=` 里的
`@hover` / `@focus`（§2.1）；参数在合并后的绑定上要有接收方（§2.1）。没有删掉任何东西。

**2026-09-11——同一个页面的菜单与开场提示**：`layer` 的值域多一个 `screen`，`fade-out`
进内含词（§2.1）。`layer` / `visible` / `grow` 本身是第一个页面带进来的，但一直没写进 §2.1
的表，这次补上。

**v1 刻意没有的东西**：任何形式的 script；URL（dev/staging/prod 地址不同，写死会让
样式表绑定环境）；路由；设计令牌之外的主题化（复用 `data` 块，GEP-0005）；
三种块的 body 内容。

**已定义但尚未被真实样式表验过**：§0.1 右列的全部。其中 `filter=` 从没对着真实噪音
跑过（mustapi 的边全是 `kind=call`、confidence 全空，没有可过滤的东西），`handler=`
没有真实宿主。它们是被规定和被检查的，不是被实战验过的——§0.1 写清了这买到的是什么。

`geml style check` 在 `geml --help` 里标着 EXPERIMENTAL，就是这个原因。它能用、有
测试，但词汇没定——你可以指望它今天是对的，不能指望它明年还叫这个名字。
