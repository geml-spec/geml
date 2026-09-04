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

不声明，同一份文档解析出同一个模型（§8.6 规则 4），六个键是 `unknown-attribute`
warning。声明了，且处理器认识这个名字，它们被放行。处理器不认识这个名字时视同未声明
（§8.6 规则 3），仍然合规。

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

- **不放行类型名。** `form`、`form-field`、`form-group`、`form-options`、`form-note` 是规范
  的（GEP-0008）；profile 不能给类型 body 模式或 id 作用域。
- **不放行 `type=` 取值。** 七种值形状在 GEP 里是封闭的；未知值是 `unknown-field-type`
  warning，按 `text` 渲染。
- **不放行条件或跨字段键**——`requiredIf`、`showIf`、`excludes`。见 §2 和 GEP-0008
  *Deliberately not defined*。
- **不放行 GEP 之外的展示键**（`placeholder=` 是 GEP 的，不是本 profile 的）。布局、分步、
  控件选择归 `geml-style/v1`。

## 5. 诊断

本 profile 不新增诊断。使用它的文档会遇到的都是核心和 GEP-0008 的：

- `unknown-attribute`——未声明 profile 时的约束键；
- `unknown-field-type`——七个之外的 `type=` 值；
- `form-child-outside-form`、`form-field-has-body`、`options-not-form-options`、
  `note-not-form-note`、`unused-form-block`、`duplicate-id`——GEP-0008 的家族诊断，不受本
  profile 影响。

检查器可以在值按键自身的规则读不通时额外 warning——`number` 上的 `min=abc`、不是合法
正则的 `pattern=`——但不得当作 error：文档仍是数据。

## 6. 完整示例

```geml
=== meta
profile = "geml-form/v1"
===

==== form {#vendor handler=onboarding}
=== form-field {#revenue label="年营收（百万元）" type=number
               min=0 max=99999 step=1 description="整数。"}
===
=== form-field {#phone label="手机" type=text required pattern="^[+0-9 ]+$"
               placeholder="+86 138 0000 0000"}
===
=== form-field {#licence label="营业执照" type=file required accept=".pdf,image/*"}
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
