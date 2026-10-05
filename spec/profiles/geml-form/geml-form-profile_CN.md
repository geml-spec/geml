# geml-form profile v1 — `form-field` 的约束属性

*[English](geml-form-profile.md) | 中文*

- 状态：**草案**，绑定 [GEP-0008](../../proposals/0008-form-block.md)（草案）。GEP
  接受时随之落地；在 `form-field` 成为注册类型之前，下面这些键无处可挂，本文只是意图的
  描述。
- 性质：**应用层 profile，不是 GEML 标准的一部分。** GEP-0008 把 `form-*` 家族本身放进
  核心，因为表单字段需要 body 模式和 id 作用域，只有 §3 的注册表能给。字段上的**约束**
  两样都不需要：它们是属性键，处理器只存值、永不求值，这正是 §8.6 允许 profile 放行的
  东西。放在这里，规范自己的贡献就只剩五个类型名、它们的 body 模式和一条寻址规则。

## 0. 一段话说清

声明了 `profile = "geml-form/v1"` 的文档可以在 `form-field` 上写六个属性键——`pattern`、
`min`、`max`、`step`、`maxlength`、`accept`——`geml check` 不再把它们报成
`unknown-attribute`。每一个都是对字段取值应满足的格式或范围的**声明**。GEML 里没有任何
东西拿值去校验它们：`form` 是对表单的描述，渲染成禁用预览（GEP-0008，§8.3(5)），唯一
拿到用户输入的是宿主注册的 **handler**，声明在那里被执行。样式表可以把它们显示成提示，
不能用它们做判断。

## 1. 声明 profile

```geml
=== meta
profile = "geml-form/v1"
===
```

不声明，六个约束键是 `unknown-attribute` warning，而就它们而言模型不变：属性值反正都
会被存下来。`form-*` 类型是另一回事。过渡期里它们由 profile 放行（§1.1），所以不声明时
它们是 `unknown-block-type`、正文是 raw，一张 `form` 的字段要等 profile 被声明且被认识
之后才成为地址（§8.6.2 规则 4）。处理器不认识这个名字时什么也不放行，并报出
`unrecognized-vocabulary`（§8.6.2 规则 3），仍然合规。

## 1.1 参考实现的注册表里为什么不止六个

下面六个是**这份 profile 定义的**。去看参考实现的注册表，会发现 `form-field` 上还有
`label`、`description`、`placeholder`、`type`、`required`、`multiple`、`value`、
`options`，以及 `form` 的 `handler`、`form-options` 的表体那几个键。**那些是
GEP-0008 的，不是这份 profile 的。**

它们暂住在那里，只因为有一道缝还没合上：GEP 落进 §3 之前，`form-*` 是 profile 放行的
类型，而这类类型的属性检查由 profile 自己那张表驱动——表里只写六个，GEP-0008 定义的其余
每一个键都会被报成 `unknown-attribute`，连 GEP 自己的示例表单也不例外。一张不完整的表
不是"承诺得少一点"，是承诺错了。

GEP-0008 落地之后，那些键搬回核心的逐类型表，这份 profile 只留六个。无论哪一边，profile
**定义**的东西都没有变，下面 §4 照旧。

GEP 的结构规则也这样随行，对声明了这份 profile 的文档生效，一致性文件列了这些码，因为 GEP
落地之前，让 `form-*` 成为一个家族的就是这份 profile：`form-*` 块出现在 `form` 之外——字段不
直接在 form 或 group 里、group 套 group、选项表或说明不直接在 form 里——是
`form-child-outside-form`（**error**）；`form-field` 没有 `name=` 是 `form-field-missing-name`
（**error**）；同一张表单里两个字段同名是 `form-duplicate-name`（**error**）。name 是 handler
收到的键，也是坐标寻址字段用的那一步——`#vendor["phone"]`——所以字段不需要 id。

## 2. 六个键

都只用于 `form-field`。值都是字符串，下表说 handler 应当怎么读。键落在不匹配的 `type=`
上不是错误——文档是数据——handler 可以忽略，检查器可以 warning。

| 键 | 适用 `type=` | 值 | handler 执行什么 |
|---|---|---|---|
| `pattern` | `text`、`textarea` | 正则表达式，ECMAScript 语法，匹配整个值 | 值匹配 |
| `min` | `number`、`date` | 数；`date` 时为 ISO-8601 日期 | 值 ≥ min |
| `max` | `number`、`date` | 数；`date` 时为 ISO-8601 日期 | 值 ≤ max |
| `step` | `number` | 正数 | (值 − min) 是 step 的整数倍；min 缺省为 0 |
| `maxlength` | `text`、`textarea` | 非负整数 | 值的字符数不超过它 |
| `accept` | `file` | 逗号分隔的扩展名（`.pdf`）或媒体类型（`image/*`） | 每个文件匹配其中一项 |

`multiple` 字段上约束作用于**每一个**值。`form-group` 上这些键都未定义；组自己的
`required` 表示至少一条。

为什么是这六个：它们是描述**单个值本身**的约束。凡涉及两个字段的——结束晚于开始、两个
选项互斥、勾了 X 才必填 Y——是逻辑不是字段约束，GEP-0008 把它们排除在文档之外
（*Deliberately not defined*），这也是 §9.1 的要求。

## 3. 只声明，不求值

三方接触一条约束，只有一方对它采取行动：

| 方 | 可以 | 不可以 |
|---|---|---|
| 文档 | 以字符串属性声明它 | 说失败了会怎样 |
| 渲染器 / 样式表 | 显示它——数字框下写 `0 到 99999`，手机框下写 `11 位` | 因它拒绝、禁用或重排任何东西 |
| handler | 执行它，以及文档装不下的所有规则 | 改文档 |

这与 GEP-0008 给整个 `form` 块划的分工相同，只是落到每一个属性上。处理器若拿
`pattern` 去校验 `value=`，就是在对文档跑程序，§9.1 禁止。

## 4. 本 profile 不放行的

- **GEP 接受后不再放行类型名。** `form`、`form-field`、`form-group`、`form-options`、
  `form-note` 是规范的（GEP-0008）：body 模式和 id 作用域由 §3 的注册表给。过渡期里，
  参考实现的注册表经由这份 profile 暂放行这五个 `form-*` 类型及其 body 模式（`form` 与
  `form-group` 是 `flow`）（§1.1；GEML §8.6.1），好让今天声明了它的文档能校验干净。
- **不放行 `type=` 取值。** 七种值形状在 GEP 里是封闭的；未知值是 `unknown-field-type`
  warning，按 `text` 渲染。
- **不放行条件或跨字段键**——`requiredIf`、`showIf`、`excludes`。见 §2 和 GEP-0008
  *Deliberately not defined*。
- **不放行 GEP 之外的展示键**（`placeholder=` 是 GEP 的，不是本 profile 的）。布局、分步、
  控件选择归 `geml-style/v1`。

## 5. 诊断

一致性文件列出了声明本 profile 的文档会经由它遇到的码：

- `form-child-outside-form`、`form-field-missing-name`、`form-duplicate-name`——
  **error**；GEP-0008 的结构规则，过渡期由 profile 随行（§1.1）；
- `unrecognized-vocabulary`——**warning**；处理器不认识这个名字时核心报出的那条
  （§8.6.2 规则 3）。

其余都是核心和 GEP-0008 的：

- `unknown-attribute`——未声明 profile 时的约束键；
- `unknown-field-type`、`form-field-has-body`、`options-not-form-options`、
  `note-not-form-note`、`unused-form-block`——GEP-0008 的家族诊断，由 GEP 定义，参考
  检查器尚未实现（它不看 `type=` 的取值）；
- `duplicate-id`——核心的。

检查器可以在值按键自身的规则读不通时额外 warning——`number` 上的 `min=abc`、不是合法
正则的 `pattern=`——但不得当作 error：文档仍是数据。

## 6. 完整示例

```geml
=== meta
profile = "geml-form/v1"
===

==== form {#vendor handler=onboarding}
=== form-field {#revenue name=revenue label="年营收（百万元）" type=number
               min=0 max=99999 step=1 description="整数。"}
===
=== form-field {#phone name=phone label="手机" type=text required pattern="^[+0-9 ]+$"
               placeholder="+86 138 0000 0000"}
===
=== form-field {#licence name=licence label="营业执照" type=file required accept=".pdf,image/*"}
===
====
```

三方各读各的：文档说年营收是 0 到 99999 的整数；样式表可以在框下印出 *0 到 99999*；
handler 拒绝 `-1` 和 `12.5`。GEML 自己什么都不做。

## 7. 版本与范围

版本在 profile 名里。键集合变了就是 `geml-form/v2`，显式声明；声明 `v1` 的文档含义不变。
v1 承诺的是上面六个键、只在 `form-field` 上、按 §2 的读法。留给后续版本的——并且期望从
实测表单而不是从 HTML 恰好提供了什么来定——是 HTML 输入框带的其余一切：`minlength`、
`size`、`autocomplete`，以及 `time`、`datetime` 类型出现后各自的步长。
