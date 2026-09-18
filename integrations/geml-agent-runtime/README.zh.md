# @geml/agent-runtime — coding agent 的监督器

[English](README.md) | 中文

一份**用 GEML 写的状态图**决定 agent 此刻能看见哪些工具、能走哪些跃迁、能改哪些
变量。每次变化先校验后落地，并追加进一本**带哈希链的台账**——台账本身就是一份
普通 GEML 文档，可读、可寻址、可 diff、可校验。

这不是对 agent 的建模，而是一个 Ramadge–Wonham 意义上的**监督器**：被控对象是
LLM 加它的整个上下文，任意、不建模；监督器在旁边并行运行，只做一件事——把事件
从"接下来可能发生"里拿掉。它买到的是**安全性质**：某些动作序列不可能发生。不是
收敛，也不是对模型行为的预测。

```mermaid
flowchart TB
    subgraph plant["被控对象 plant — 刻意不建模"]
        M["LLM + 整个上下文窗口"]
        L["宿主的 agent loop：turn / step"]
        M --- L
    end

    L -->|"提出一个事件 e"| G1

    subgraph sup["监督器 supervisor — 确定性自动机，只做减法"]
        G1{"闸1 可见性<br/>不在 A(σ) 的工具<br/>根本不进提示词"}
        G2{"闸2 参数域<br/>agent_transition 的 to 枚举"}
        G3{"闸3 派发前熔断<br/>单调：只能拒，拒了没人能翻"}
        G4{"闸4 人工闸<br/>除了明确的同意以外都算拒"}
        G5{"闸5 动词校验<br/>requires / vars schema<br/>先验后写"}
        G1 --> G2 --> G3 --> G4 --> G5
    end

    G5 -->|"通过"| NEXT["σ′ = δ(σ, e)<br/>追加 agent-snapshot"]
    G3 -.->|"拒"| REF["σ 不变<br/>追加 agent-refused"]
    G4 -.->|"拒"| REF
    G5 -.->|"拒"| REF

    UNC["不可控事件<br/>工具失败 · 用户输入"] ==>|"只能观察"| RESP["工具结果监听<br/>→ error-rollback"]
    RESP --> NEXT

    NEXT --> LEDGER[("台账 .geml<br/>投影后的完整历史<br/>哈希链")]
    REF --> LEDGER
    LEDGER -->|"恢复：读最后一块"| SIGMA
    SIGMA["σ = (state, vars)"] --> G1
    NEXT --> SIGMA
    SIGMA -->|"状态指令<br/>+ 几百字节快照"| M
```

上面每一道闸的**判断**都只有一份（`src/core/supervisor.ts`），两个宿主各自只提供
**机制**，谁也没有第二份拷贝：

| | DeepSeek Harness | Pi |
|---|---|---|
| 闸1 可见性 | `agent.ctx.tools.restrict()` | `pi.setActiveTools()` |
| 闸2 参数域 | 动词按状态重注册，枚举就是 `outgoing(σ)` | 每会话只注册一次，枚举是状态图里的全部目标；其余交给闸5 拒 |
| 闸3 熔断 | `agent.ctx.tools.guard()` | `tool_call` → `{ block, reason }` |
| 闸4 人工闸 | `ctx.approval.request()`——没挂服务、抛异常、非 `allowed-once` 都算拒 | `ctx.ui.confirm()`——连 UI 都没有（`-p`、json）也算拒 |
| 闸5 动词校验 | 同一份 | 同一份 |
| 进 pause / final 结束回合 | `exec.concludeTurn()` | `AgentToolResult.terminate` |
| σ 怎么到模型眼前 | 一段提示词 section + 每步一次的 context | 系统提示词，每个用户回合重建一次 |
| 台账 | `<ledgerDir>/<session>.geml` | 同一个文件，外加每块一条会话条目——分叉出去的会话就是靠它继承整条链的 |

监督器的状态是 `σ = (state, vars)`，允许集一行说完：

> `A(σ)` = 当前状态声明的工具 ∩ 已注册工具，⋃ 守卫在当前 `vars` 下成立的那些
> 出边，⋃ 当前状态允许写的变量。

## 状态

| | |
|---|---|
| 现在可用 | `geml-agent/v1` 词汇表；核心库（状态图载入与静态检查、哈希链快照、台账渲染/读取/校验、监督器本身）；`geml-agent` CLI；两个宿主适配器——DeepSeek Harness `0.1.5-rc.1` 的 Cordis 插件与 Pi `0.85.x` 的扩展。 |
| 不接模型也测过 | 五道闸在两个宿主上各测一遍：DSH 侧用 `dsh-agent-loop-testkit` 起真 agent，Pi 侧用一个按 Pi 自己的管线顺序、并且用 Pi 自己的参数校验器（typebox）跑的替身。接真模型跑一遍是手工步骤，见下。 |
| 还没实测 | 按状态门控在 Pi 上对提示词前缀缓存的真实代价。Pi 文档写明：非增量地更换活跃工具集要重发整张工具表、可能让缓存前缀失效——而每次跃迁干的正好是这件事。`GEML_AGENT_VISIBILITY=guard-only` 可以把闸1 换掉省这笔钱，闸3 照拦。 |
| bundle 里还带着 | GEML MCP server，以及写作与代码图谱两个技能（见[安装](#安装)）。 |

设计：[`docs/design/specs/2026-09-14-geml-agent-runtime-design.md`](../../docs/design/specs/2026-09-14-geml-agent-runtime-design.md)。
词汇表：[`spec/profiles/geml-agent/`](../../spec/profiles/geml-agent/geml-agent-profile_CN.md)。

## 一份状态图

```geml
=== meta
profile = "geml-agent/v1"
tools   = "read_file grep"
===

=== agent-vars {#vars}
{ "type": "object", "additionalProperties": false, "properties": {
    "order":    { "type": "string" },
    "amount":   { "type": "number",  "default": 0 },
    "approved": { "type": "boolean", "default": false } } }
===

=== agent-state {#intake initial vars="order amount"}
向用户问清订单号和退款金额，此时先不做判断。
===

=== agent-state {#pay tools="pay_refund" vars=none rollback-on-error}
把这笔退款执行恰好一次。
===

=== data {#is-approved format=json}
{ "type": "object", "required": ["approved"], "properties": { "approved": { "const": true } } }
===

=== agent-transition {#to-pay from=#review to=#pay requires=#is-approved approval}
政策允许退款。这一步需要人工点头。
===
```

在 `#pay` 里，模型只看得见一个外部工具，什么变量都不能写，任何失败都会把变量拨
回进入该状态时的样子。`geml check` 像验任何 GEML 一样验它；`geml get agent.geml
'#pay'` 取一个状态；`.gemlhistory` 给它记版本。

`geml-agent init` 会把这份示例（完整版）写到当前目录。

## 它不做什么

它只约束它建模了的那部分世界。下面三条不是疏漏：

- **回滚恢复的是声明变量与控制状态，不是外部副作用。** 台账能把 `approved`
  拨回 `false`，拨不回已经打出去的退款。补偿跃迁要状态图作者自己写。
- **工具门控不是沙箱。** 它决定模型在某个状态里能调哪些工具；被放行的 `bash`
  里干了什么，那是 harness 沙箱的事。两层互补。
- **恢复恢复的是状态，不是对话。** 几百字节带回"在哪、能做什么"；对话由 harness
  按它自己的规则重放。
- **一道闸的强度按宿主最弱的那个机制算**，上面那张表写的就是哪一个。闸2 是现成的
  例子：Pi 上 `to` 的枚举是状态图里的全部目标，而不是只有 `σ` 当下能到的那几个，
  因为 Pi 的工具不能在会话中途重注册。但这一步仍然会被拒——晚一道闸，由闸5 拒，
  并且照样记进台账。

因此适用面是**可枚举的流程**——审批、KYC、工单分级、运维 runbook。开放式任务
（写代码、做研究）枚举不出状态，硬套只会把 agent 本身的价值抹掉。

## CLI

```
geml-agent check <flow.geml> [--tools a,b]        静态检查（有 error 退出 1）
geml-agent snapshot <ledger.geml> [--json]        最后一条修订
geml-agent verify <ledger.geml> [--statechart f]  哈希链与自洽性
geml-agent export <ledger.geml> --to md           修订表，逐步变量 diff
geml-agent init [dir]                             写出示例 agent.geml
geml-agent run [--profile name] <task>            把 bundle 加进某个 dsh profile，并在那里跑这个任务
```

只有 `run` 会伸到这个包外面：它在 PATH 上找 `dsh`（找不到就退回
`npx -y @deepseek-ai/dsh`），把 bundle 加进 profile（不指定就是 `headless`），
然后把任务交过去，并把 dsh 的退出码原样传回。加失败时它把 dsh 自己的话打出来，
再给出手工执行的两条命令，绝不在一个没装监督器的 profile 上把任务跑起来。

`check` 在 `geml check` 之上另报十一条自己的诊断——没有初始状态、终态有出边、
守卫不是 schema、`vars` 里的名字 `agent-vars` 没声明、状态不可达，等等。

`verify` 重算整条链：修订号连续、每个 `parent` 等于前一块的哈希、每个哈希按内容
重算、并且——给了状态图时——每次记录的跃迁都对应一条声明过的边。删掉**末尾**
一段块是这条链唯一检测不出的改动。

## 安装

### DeepSeek Harness

```sh
dsh plugin --profile web add @geml/agent-runtime
```

先不启动、只验证这一层，再启动：

```sh
dsh --profile web --dump-config   # 应能看到 "# == @geml/agent-runtime" 这一层
dsh --profile web
```

bundle 贡献三行：**监督器**（`@geml/agent-runtime/dsh`，按 agent 挂载；会话的工作
目录里没有 `agent.geml` 时它什么都不做——这就是 `onMissing: skip`）、**GEML MCP
server**（`npx -y @geml/geml mcp --root .`，限定在会话自己的项目目录内，于是模型
一次改一个块而不是重写整个文件），以及 `skills/` 下的两个**技能**——写作与代码
图谱。要覆盖哪一行，在你 profile 的 `cordis.patch.yml` 里按 `id` 重写，注意把该行
需要的每个键都写全。

### Pi

```sh
pi install npm:@geml/agent-runtime
```

同一个包就是一个 pi package：`pi.extensions` 指向监督器，`pi.skills` 指向同样那
两个技能——它们本来就是一个技能一个 `SKILL.md` 文件夹，正是 Pi 自己的约定。

状态图在**扩展加载时**读一次，因为三个动词必须在第一个会话开始之前注册好，而它们
的 schema 来自状态图。这也是为什么路径是环境变量而不是命令行 flag——那个时刻 flag
还没解析：

```sh
GEML_AGENT_STATECHART=agent.geml pi      # 默认值，相对当前目录
GEML_AGENT_LEDGER_DIR=/var/ledgers pi    # 默认 <会话目录>/geml-agent
GEML_AGENT_VISIBILITY=guard-only pi      # 工具表保持不变（见"状态"）
```

没有状态图时：不注册、不监听，`pi` 的行为和没装这个包完全一样。

Pi 这边有三件事只读过它发布的类型与随包文档、没有实测，接真模型跑的时候正是要看
它们：按状态门控对提示词前缀缓存的代价；没有 UI 时 `ctx.ui.confirm` 是抛异常还是
返回默认值（两种情况本适配器都按拒处理）；以及 fork 之后 `getBranch()` 给的是分支
还是整棵树（`hash`/`parent` 是按它返回的东西算的，出问题由 `geml-agent verify`
抓）。

不装 harness，只用 CLI：

```sh
npx -y @geml/agent-runtime init
npx -y @geml/agent-runtime check agent.geml
```

## 开发

```sh
npm install        # 把 @geml/geml 链到 ../../geml-parser
npm test           # tsc + node --test
```

`src/core/` 是纯函数库——不碰 `node:fs`、`process`、`console`，也不 import 任何
宿主的包（这几条都有测试钉着）——所以 CLI 和两个适配器共用同一份实现。
`src/host-fs.ts` 是唯一碰文件系统的模块。

目录结构就是从这条规矩来的：`src/core/supervisor.ts` 做判断，`src/hosts/dsh/` 与
`src/hosts/pi/` 只做翻译。两个适配器谁都不许 import 对方的宿主——宿主包都是可选
peer，只装了一家 harness 的人绝不能被解析到另一家的包上，这条有测试拦着。每个宿主
还各有一份 parity 测试（`dsh-parity`、`pi-parity`），拿我们依赖的形状去对已安装的
包做断言：宿主改了接口，红在这儿，而不是红在用户的会话里。
