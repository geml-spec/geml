# geml-statechart 词汇表 v1 —— 一个 `diagram` 块装下一台状态机

*[English](geml-statechart-profile.md) | 中文*

- **状态**：draft。
- **放行**：`diagram` 的 `format` 名 `geml-statechart`，以及该块上的属性键 `current`。不放行任何块类型、别的属性键或 meta 键。
- **实现**：`@geml/geml` 的 `--to html` 与 viewer 注册渲染器，`--to md` 投影成 Mermaid；`geml check` 在文档声明了本词汇表时，做 §3 的检查。

## 0. 一段话

一台状态机写在一个 `diagram` 块里：`format=geml-statechart`，正文是一个 JSON 对象，写明节点（状态和它的属性）、转换（从哪到哪、通行要求、动作）和通行要求读的条件变量。渲染器把它画成状态图：点开一个状态看它的属性与出入边，点开一条转换看它的通行要求与动作。格式只定骨架——几个保留键，以及通行要求和动作放在哪。节点、转换、变量上其余的键都是属性：原样展示，含义由使用这张图的程序自己定。所以一张订单流程、一台游戏关卡机、一份 agent 的工作流写法相同，各自挂各自的属性。

## 1. 声明

```geml
=== meta
profile = "geml-statechart/v1"
===
```

运行状态图的程序不需要自己的词汇表：格式没保留的键都是属性（§2.2），程序自己的词就写在正文里，文档只声明本词汇表。本词汇表没有 meta 键。

## 2. 块

### 2.1 一张完整的图（订单）

```geml
=== meta
profile = "geml-statechart/v1"
===

=== diagram {#order format=geml-statechart caption="订单"}
{
  "initial": "unpaid",
  "states": {
    "unpaid":    { "title": "待支付", "owner": "买家", "deadline": "30 分钟" },
    "paid":      { "title": "已支付", "owner": "仓库", "deadline": "48 小时" },
    "shipped":   { "title": "已发货", "owner": "快递", "final": true },
    "cancelled": { "title": "已取消", "final": true }
  },
  "transitions": [
    { "from": "unpaid", "to": "paid",      "guard": "支付成功",          "actions": ["通知仓库"] },
    { "from": "unpaid", "to": "cancelled", "guard": "超过 30 分钟未支付", "actions": ["释放库存"] },
    { "from": "paid",   "to": "shipped",   "guard": "仓库确认出库" },
    { "from": "paid",   "to": "cancelled", "guard": "买家申请退款",      "actions": ["退款"] }
  ]
}
===
```

`owner`、`deadline` 是这张图自己的属性，格式不认识它们，照样画出来：点开"待支付"看到负责人、时限和两条出路。这里的通行要求和动作都是一句话，给人看；要让程序判断通行要求，就写它读的条件变量（§2.3）。

### 2.2 定义

正文是一个 JSON 对象。顶层：

| 键 | 必需 | 值 |
|---|---|---|
| `initial` | 是 | 起点：`states` 里的一个 id |
| `states` | 是 | 对象：状态 id → 状态对象 |
| `transitions` | 是 | 数组，一项一条转换；可以为空 |
| `vars` | 否 | 对象：条件变量名 → 条件变量对象 |

其余顶层键是整台状态机的属性。

**状态对象**：`title` 是显示名，缺省用 id；`description` 是一段说明；`final: true` 标终态——这张图走到此为止的状态，没有出边——一张图可以有几个；其余键是属性。状态 id 是 GEML 的 NAME（Unicode 字母、组合字符、数字、`_`、`-`）。v1 没有层级与并行：状态对象里的 `states`、`regions`、`initial` 是错误（§5）。

**转换对象**：`from`、`to` 必需，都是 `states` 里的 id，可以相同（自环）；`guard` 是通行要求（§2.3）；`actions` 是动作（§2.4）；`event` 保留给 v2（§5）；其余键是属性。同一对状态之间可以有多条转换。诊断里一条转换写作 `from→to`，同一对之间有多条时加序号：`unpaid→cancelled[2]`。

**条件变量对象**：`default` 必需，任意 JSON 值，它的 JSON 类型就是变量的类型；其余键是属性。变量名是 NAME。条件变量是通行要求读的、动作写的那份记忆；值从哪来、什么时候变，由程序定（§5）。

### 2.3 通行要求 `guard`

三种写法，按 JSON 类型区分：

| 写法 | 含义 |
|---|---|
| 对象 | 对变量的 JSON Schema（§4 的子集），实例是「变量名 → 当前值」的对象。程序能判 |
| 以 `#` 开头，或形如 `doc.geml#id` 的字符串 | 引用一个 `format=json` 的 `data` 块，它的值是上面那种对象；长的、几条转换共用的通行要求这样写 |
| 其他字符串 | 一句话。格式不判；谁来判由程序定 |

没有 `guard` 的转换没有通行要求。对象与引用的通行要求读到的变量名——`properties` 的键、`required` 里的名字，各层分支都算——都要在 `vars` 里。

一个程序能判的通行要求：

```geml
=== diagram {format=geml-statechart}
{
  "initial": "draft",
  "states": { "draft": {}, "published": { "final": true } },
  "vars": { "reviewed": { "default": false }, "approvals": { "default": 0 } },
  "transitions": [
    { "from": "draft", "to": "published",
      "guard": { "properties": { "reviewed": { "const": true }, "approvals": { "enum": [2, 3] } } } }
  ]
}
===
```

### 2.4 动作 `actions`

数组，走这条转换时执行。格式认得一种：

```json
{ "reset": ["reviewed"] }
```

走这条转换时这些变量回到 `default`；名字都要在 `vars` 里。其他项——字符串，或别的对象——是程序自己的动作，格式原样展示。对象里带 `set` 键的保留给 v2（§5）。

### 2.5 引用

正文里以 `#` 开头、或形如 `doc.geml#id` 的字符串值是对块的引用，路径相对本文档。格式只解析 `guard` 里的引用；属性里的引用由程序解析，渲染器把它画成链接。

### 2.6 画法

- 节点是状态，显示 `title`；`initial` 标起点；标了 `final` 的状态标终点。
- 边上标：对象形式的通行要求读到的条件变量名（按名字排序、逗号隔开）；引用形式的写它指向的 id；一句话的通行要求写原文；没有通行要求不标。
- `current=<状态 id>` 高亮一个状态，给程序画"现在在哪"用。
- 点开状态：`title`、`description`、全部属性（键 → 值；引用画成链接；对象与数组按 JSON 展开）、出边与入边。
- 点开转换：通行要求（对象的按 §4 读成人话：`reviewed 为 true，且 approvals 是 2 或 3`）、动作、属性。
- 渲染器由宿主注册（`--to html`、viewer）；没有注册的处理器按 GEML §7 把正文当源码块显示，不是错误。
- 图是渲染器自己画的内联 SVG，不需要任何画图运行时：从左到右，一个状态所在的列是从起点出发的最长路径；回头或跨列的边走下方的车道；每条通行要求做成一枚胶囊放在边上（一句话写的标成散文，不标谁来判——§5 把这件事留给程序），转换里值为 true 的标志与数字跟在后面各成一枚；`current=` 的状态填色加光环，起点带圆点，终点双框。图下给出同一份 SVG 的下载。

### 2.7 Markdown 投影

`--to md` 把它投影成一段 Mermaid `stateDiagram-v2`，GitHub 直接画：状态用 id，Mermaid 不认的 id（含 `-` 的）用 `state "title" as 别名`；`[*] -->` 指向起点，终点 `--> [*]`；边标签同 §2.6。属性不进投影。

### 2.8 定义放在 `data` 块里

定义也可以放在一个 `format=json` 的 `data` 块里，图块写 `data=#id`、正文留空：

```geml
=== data {#order-def format=json}
{ "initial": "unpaid", "states": { "unpaid": {}, "paid": { "final": true } }, "transitions": [ { "from": "unpaid", "to": "paid" } ] }
===

=== diagram {format=geml-statechart data=#order-def caption="订单"}
===
```

那时坐标能寻址到定义里的每个值（`geml get doc.geml '#order-def["states"]["unpaid"]'`），`geml set` 能只改一个值。`data=` 指向本文档的 `#id` 或 `doc.geml#id`，目标是值为对象的 `data` 块；正文和 `data=` 不能同时有。

## 3. 检查

| 码 | 级别 | 何时 |
|---|---|---|
| `statechart-body` | error | 正文不是一个 JSON 对象；正文与 `data=` 同时有；`data=` 指向的不是值为对象的 `data` 块 |
| `statechart-initial` | error | 没有 `initial`，或不是 `states` 里的 id |
| `statechart-state` | error | `states` 不是对象；id 不是 NAME；状态不是对象；状态里有 `states`、`regions` 或 `initial`；`title`、`description` 不是字符串；`final` 不是布尔值 |
| `statechart-transition` | error | `transitions` 不是数组；一条转换不是对象；`from`、`to` 缺失或不是 `states` 里的 id；有 `event` |
| `statechart-guard` | error | 既不是对象也不是字符串；对象不在 §4 子集内；引用解析不到，或指向的不是值为对象的 `data` 块；读了 `vars` 里没有的变量 |
| `statechart-actions` | error | 不是数组；`reset` 不是字符串数组，或名字不在 `vars` 里；对象里有 `set` |
| `statechart-vars` | error | `vars` 不是对象；名字不是 NAME；变量不是对象，或没有 `default` |
| `statechart-current` | error | `current=` 不是 `states` 里的 id |
| `statechart-final` | error | 标了 `final` 的状态有出边 |
| `statechart-unreachable` | warning | 有状态从 `initial` 走不到 |
| `statechart-dead-end` | warning | 没标 `final` 的状态没有出边：忘了写转换，或者该标成终态 |

诊断里转换写作 `from→to`（§2.2）。检查自己属性的程序先报这些，再报它自己的。

## 4. JSON Schema 子集

通行要求用这个子集写：任意 JSON 根；单个标量 `type`（`object`、`array`、`string`、`number`、`integer`、`boolean`、`null`）；`properties`、`required`、布尔 `additionalProperties`；`items`；与类型匹配的标量 `enum` / `const`；`oneOf`（至少两个分支，恰好一个命中）；`anyOf`（至少两个分支，至少一个命中，通行要求用它表达"这样，或者那样"）；注解 `title`、`description`、`default`、`examples`。`anyOf` 与同一个 schema 的其他关键字（`type`、`properties` 等）同时生效。**其他任何关键字都是错误**，不是被忽略的提示——`minimum` 写了却不生效，比拒绝它更糟。

## 5. 程序的事，以及 v2 的位置

格式不定、留给使用这张图的程序的：

- 一句话的通行要求由谁判断；对象形式的满足了是自动走还是等人；转换由谁走。
- 条件变量的值从哪来、什么时候变、什么时候作废。
- 属性的含义：`owner`、`prompt`、`approval`……都是程序的词。
- 进了终态之后发生什么。

v2 的位置。v1 把这些键标为错误，所以 v2 定义它们时不改变任何 v1 文档的含义：

| 位置 | 键 | 留给 |
|---|---|---|
| 层级 | 状态对象里的 `states`、`initial` | 复合状态：一个状态里套一台状态机 |
| 并行 | 状态对象里的 `regions` | 正交区域：几台状态机同时走 |
| 事件 | 转换上的 `event` | 由外部事件、而不是变量的变化触发的转换 |
| 赋值 | `actions` 里带 `set` 的对象 | 走转换时给变量赋值 |

## 6. 一致性（资料性）

`conformance.json`：每个用例给出声明本词汇表与不声明时的诊断（不声明时 `unknown-diagram-format:warning`，正文保持 raw），以及声明时 §3 的检查结果。渲染器的输出不在一致性之内。
