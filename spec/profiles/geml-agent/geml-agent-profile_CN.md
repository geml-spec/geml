# geml-agent profile v1 — 一个 agent 的状态图，和它的台账

*[English](geml-agent-profile.md) | 中文*

- 状态：**实验性**，v1，2026-09-14。设计依据：
  [`docs/design/specs/2026-09-14-geml-agent-runtime-design.md`](../../../docs/design/specs/2026-09-14-geml-agent-runtime-design.md)。
- 性质：**应用层 profile，不是 GEML 标准的一部分。** 下面每个块的体都是 §3 已经定义的 `raw` 或 `flow`，GEML 不需要读体内任何新语法。解释它们的运行时是 `@geml/agent-runtime`（`integrations/geml-agent-runtime/`）——一个 DeepSeek Harness 插件 bundle，附带离线 CLI `geml-agent`。

## 0. 一段话说清楚

声明 `profile = "geml-agent/v1"` 的文档描述一张 **agent 状态图**：agent 可能处于的状态、每个状态下给它的指令、在那里能看见哪些工具、能改哪些变量，以及状态之间带守卫的跃迁。第二种文档是**台账**，记录一次运行：只追加的 `agent-snapshot` 块序列（修订号、状态、变量、与前一块链起来的哈希）和 `agent-refused` 块（被守卫拒绝的跃迁或补丁）。两者都是普通 GEML：`geml check` 验它们，`geml get ledger.geml '#rev-7'` 读一条修订，`.gemlhistory` 像对任何文档一样给状态图记版本。

这套词汇**不做**的事：它只约束它建模了的东西。回滚恢复的是声明过的变量和控制状态，不是外部副作用；工具门控决定模型在某个状态里能调哪些工具，不决定被放行的工具做什么；从台账恢复的是状态，对话是 harness 自己的事。

## 1. 声明 profile

```geml
=== meta
profile = "geml-agent/v1"
tools   = "read_file grep"
===
```

`=== meta` 上的 `tools` 是文档级默认，给那些自己没写 `tools=` 的状态用。不声明 profile，同一份文档解析出同一个模型（§8.6 第 4 条），只是每个 `agent-*` 块都报 `unknown-block-type` 警告。

## 2. 块

| 类型 | 体 | 属性 | 含义 |
|---|---|---|---|
| `agent-vars` | raw，JSON | — | 变量的 JSON Schema。object 根，每份文档至多一个，限于 §4 的子集。`default` 给初值。 |
| `agent-state` | **flow** | `initial` `final` `pause` `tools` `vars` `rollback-on-error` | 一个状态。体是模型处于该状态时收到的指令，按字节原文。 |
| `agent-transition` | **flow** | `from` `to` `requires` `approval` | 一条边。体是告诉模型这条边是什么。 |
| `agent-snapshot` | raw，JSON | `rev` `state` `cause` `parent` `hash` `at` `call` `from` `restores` | 一次运行的一条修订（只出现在台账）。体是变量，单行 canonical JSON。 |
| `agent-refused` | raw，JSON | `rev` `at` `tool` `call` | 一次被拒绝的尝试（只出现在台账）。体是 `{"reason": …, "diagnostics": […]}`。 |

### 2.1 `agent-state`

- `initial` —— 每份文档恰好一个状态带它。
- `final` —— 终态：不得有出边，进入即结束 agent 的回合。
- `pause` —— 进入即结束当前回合；下一条输入到来（人工回复、webhook）时从这里继续。
- `tools="a b"` —— 空格分隔的**全局**工具名，在该状态可见。缺省：继承 `=== meta` 的 `tools`；两者都缺省：不限制。字面值 `none`：任何外部工具都不可见。
- `vars="x y"` —— 该状态下模型可以设置的变量。缺省：全部。`none`：只读状态。每个名字都必须在 `agent-vars` 里。
- `rollback-on-error` —— 该状态内任何外部工具失败时，变量与状态回到进入本状态时的那条修订。

状态的体按 GEML 普通的围栏规则界定：体里出现一行与开栏等长的裸 `=` 串就在那里
结束本块——指令里要引用 GEML 的话，状态必须用更长的围栏开头（`==== agent-state …`），
否则那一行以下的文字会被静默丢掉。`geml check` 不会报任何东西，因为截断后的块本身是合法的。

### 2.2 `agent-transition`

- `from=#id`、`to=#id` —— 状态，写法沿用 GEML 在属性里引用块的 `#`（`data=#id`）。
- `requires=#id` —— 一个 `data {format=json}` 块，体是 JSON Schema（§4）。当前变量作为一个整体满足它，跃迁才放行。
- `approval` —— 跃迁提交前必须获得 harness 的一次性审批；没有审批服务，或被拒，跃迁即被拒。

### 2.3 台账

```geml
=== meta
title           = "geml-agent ledger"
profile         = "geml-agent/v1"
session         = "session-…"
statechart      = "…/agent.geml"
statechart-hash = "sha256:…"
created         = "2026-09-14T12:00:00Z"
===

=== agent-snapshot {#rev-0 rev=0 state=#intake cause=enter hash="sha256:…" at="2026-09-14T12:00:00Z"}
{"amount":0,"approved":false}
===

=== agent-snapshot {#rev-1 rev=1 state=#intake cause=patch parent="sha256:…" hash="sha256:…" at="…" call="call_01"}
{"amount":120,"approved":false,"order":"A-17"}
===

=== agent-refused {#refused-1 rev=1 at="…" tool=agent_transition call="call_02"}
{"reason":"transition #to-pay: requires #is-approved failed","diagnostics":["$.approved: expected const true, got false"]}
===
```

- `rev` 从 0 起连续。`cause` 取 `enter`、`transition`、`patch`、`rollback`、`error-rollback` 之一。
- `hash` = `"sha256:" + sha256(canonical({v: 1, rev, parent: parent ?? null, state, vars}))`，`canonical` 键按码点排序、无空白。`parent` 是前一块的 `hash`；第 0 条修订没有。因为 `rev` 和 `parent` 都进了哈希，这些块构成一条链：换序、删块、改任何一块都会让校验失败。删掉**末尾**的一段块是这条链唯一检测不出的改动——剩下的每一块仍然自洽——所以台账的尾部只和它下面的存储一样可信。
- `from` 出现在 `transition`、`rollback`、`error-rollback` 上（离开的那个状态）；`restores` 出现在两种回滚上（恢复到的修订，`< rev`）；`call` 是引起这次变化的 harness 调用 id（有的话）。
- 台账用**盲追加**写：每一块自身完整，写入方从不读文件（GEP-0005）。`#rev-N` / `#refused-N` 让每条修订可寻址。

## 3. 静态检查

`geml-agent check` 先跑 `geml check`（那里有 error 就拒绝这份文档），再报：

| 码 | 级别 | 条件 |
|---|---|---|
| `agent-no-initial` / `agent-many-initial` | error | 不是恰好一个 `initial` |
| `agent-bad-ref` | error | `from` / `to` / `requires` 不是 `#id` 形式，或指向了错误类型的块 |
| `agent-final-outgoing` | error | `final` 状态有出边 |
| `agent-dup-edge` | error | 两条跃迁的 `from` 和 `to` 完全相同 |
| `agent-vars-schema` | error | 多于一个 `agent-vars`，或体不是 §4 子集内的 object schema |
| `agent-requires-schema` | error | `requires` 目标不是子集内的 schema |
| `agent-unknown-var` | error | `vars=` 里的名字不在 schema 里 |
| `agent-unreachable` | warning | 从 initial 不可达的状态 |
| `agent-dead-end` | warning | 没有出边的非终态 |
| `agent-unknown-tool` | warning | `tools=` 里的名字运行时不认识（只在工具清单已知时报） |

`geml-agent verify` 检查台账：`rev` 连续、每个 `parent` 等于前一块的 `hash`、每个 `hash` 重算一致、`cause` 与 `from` / `restores` 自洽，并且——给了状态图时——每个 `state` 存在、每次 transition 对应一条声明过的边。

## 4. JSON Schema 子集

与 DeepSeek Harness 工具注册表强制的子集完全一致：任意 JSON 根；单个标量 `type`（`object`、`array`、`string`、`number`、`integer`、`boolean`、`null`）；`properties`、`required`、布尔 `additionalProperties`；`items`；与类型匹配的标量 `enum` / `const`；`oneOf`（至少两个分支，恰好一个命中）；注解 `title`、`description`、`default`、`examples`。**其他任何关键字都是错误**，不是被忽略的提示——`minimum` 写了却不生效，比拒绝它更糟。

## 5. 一致性（资料性）

不认识 `geml-agent/v1` 的 GEML 处理器不受影响：它把五个类型报成 `unknown-block-type` 警告，体照旧保持 raw（§8.6 第 3 条）。只有运行时读 JSON 体，只有 `geml-agent verify` 验链。
