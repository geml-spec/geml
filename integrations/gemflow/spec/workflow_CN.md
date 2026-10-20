# Gemflow 流程 —— 写成 GEML 文档的流程，和它的 journal

*[English](workflow.md) | 中文*

- 状态：**draft**：仍可能改动。设计依据：[`docs/design/specs/2026-10-11-gemflow-design.md`](../docs/design/specs/2026-10-11-gemflow-design.md)。
- 性质：**Gemflow 自己的格式，不是 GEML 的 profile。** 它不给 GEML 加块类型、属性键或 diagram 格式，所以不需要词汇表：流程只声明 [`geml-statechart/v1`](../../../spec/profiles/geml-statechart/geml-statechart-profile_CN.md)。那个格式——正文的形状、通行要求的三种写法、`reset` 动作、画法、`statechart-*` 检查——属于 GEML；本文加的是挂在那台状态机的状态、变量、转换上、把它接到 Gemflow 的几个键（格式本来就把它们当属性放行），外加一个 `=== meta` 键 `flow-unit`，在 GEML 看来那只是作者的元数据。GEML 的解析器对 Gemflow 一无所知。一份流程就是一份普通的 GEML 文档：一个装着状态机的 `diagram` 块，它引用的提示词文档和通行要求 `data` 块，旁边一份只是一张 `table` 的工具词典。journal 与上下文文档也是普通的 `data`、`text` 块。GEML 不需要读其中任何新语法。解释它们的运行时是 `@geml/gemflow`（`integrations/gemflow/`）：Claude Code 插件、`gemflow` CLI 及其 MCP 服务（`gemflow mcp`），以及 DeepSeek Harness 与 pi agent 的适配器。
- 运行时覆盖：DeepSeek Harness 与 pi agent 适配器按会话记 journal（`item` 是 `session:<id>`），不求值信号，不写上下文文档。只接 MCP 的宿主不把自己的工具调用交给 Gemflow，所以在它上面工具词典、用途封路与只许人做的命令都不起作用（§3.11）。

## 0. 一段话说清楚

流程是一份声明了 `profile = "geml-statechart/v1"` 的 GEML 文档，里面有一个 `format=geml-statechart` 的 `diagram` 块：一台状态机，状态是阶段，转换是阶段之间的边，条件变量是通行要求读的东西。Gemflow 在每个状态上挂模型在这里拿到什么——要载入的 `prompt`、要启用的 `skills`、能用的 `tools`，后者按**用途**写（`edit`、`test`、`pr`……）；在每个变量上挂它的值从哪来（`source`：绑到某个用途的一次工具调用、文件、git 与 CI、人的勾选；或者什么都不写，由模型自己写）；在每条转换上挂此刻要不要人点头（`approval`）。通行要求（`guard`）是对条件变量的一个对象时由机器判，成立就自动走，所以流程凭观测到的事实推进，不凭模型自己说；通行要求是一句话时由模型判；批准由人判。一个用途在这个项目里指哪个具体工具、同类工具里首选哪个、参数默认取什么，都不写进流程，而是记在项目的**工具词典** `.geml/tools.geml` 里——项目的所有流程共用一份——在使用中由人的选择长出来。每个工作项——一个分支，或者一个文件，比如一集——有一本 **journal**：一串哈希链起来的 `data` 块，记下每条修订和每次拒绝。这些文档都是普通 GEML：`geml check` 验它们，`geml get journal.geml '#rev-7'` 读一条修订，`geml --to md` 把状态机画成 Mermaid 图。

## 1. meta 块

```geml
=== meta
title     = "视频流程"
profile   = "geml-statechart/v1"
flow-unit = "file:episodes/*.geml"
===
```

| 键 | 含义 | 取值 | 默认 |
|---|---|---|---|
| `flow-state-key` | 按文件算工作项时，事项文件用哪个 meta 键记工作项现在的阶段 | 一个键名 | 不写：不碰事项文件 |
| `flow-unit` | 一个工作项是什么，也就是一本 journal 记录什么 | `branch`（每个分支一个工作项）或 `file:<glob>`（每个匹配的文件一个，如 `file:episodes/*.geml`；glob 的写法见 §3.6） | `branch` |

`flow-unit` 和 `flow-state-key` 是 Gemflow 在流程里读的两个 `=== meta` 键，只有单位是 `file:<glob>` 的流程才写它们。没有任何已声明词汇表认领的 meta 键，GEML 留给作者，所以 `geml check` 对它不置一词；它的值由 `gemflow check` 检查（§4）。

这样分正是要点：状态机的结构属于 GEML，任何 GEML 处理器都能检查它——没装 Gemflow 时 `geml check .geml/workflows/dev.geml` 照样报 `statechart-*` 码；Gemflow 那几个键是什么意思属于 Gemflow，由 `gemflow check` 检查，它先报 `statechart-*` 码，再报自己的（§4）。

journal（§2.4）、上下文文档（§2.5）、工具词典（§2.3）、backlog（§3.12）与项目配置（§3.1）都不声明 profile。

## 2. 文档

### 2.1 一份完整的流程

内置的开发流程全文：

```geml
=== meta
title   = "开发流程"
profile = "geml-statechart/v1"
===

=== diagram {#flow format=geml-statechart caption="开发流程"}
{
  "initial": "build",

  "states": {
    "build": {
      "title": "构建",
      "description": "写代码和测试，直到测试通过、PR 开出来。",
      "prompt": "#build",
      "skills": ["test-driven-development"],
      "tools": ["edit", "test", "pr"]
    },
    "review": {
      "title": "评审",
      "description": "处理 review 意见，等 CI 绿、PR 合并。",
      "prompt": "#review",
      "tools": ["edit", "test"]
    },
    "deploy": {
      "title": "部署",
      "description": "部署到 staging 并验证。",
      "tools": ["deploy-staging"]
    },
    "release": {
      "title": "上线",
      "description": "部署到 production。",
      "tools": ["deploy-prod"]
    },
    "done": { "title": "完成", "final": true }
  },

  "vars": {
    "tests-pass":       { "default": false, "source": { "tool": "test" } },
    "pr-open":          { "default": false, "source": "pr-open" },
    "pr-merged":        { "default": false, "source": "pr-merged" },
    "ci-pass":          { "default": false, "source": "ci-success" },
    "review-ready":     { "default": false, "source": "human", "note": "测试只在 CI 里跑时，由人勾选" },
    "deployed-staging": { "default": false, "source": { "tool": "deploy-staging" } },
    "deployed-prod":    { "default": false, "source": { "tool": "deploy-prod" } }
  },

  "transitions": [
    { "from": "build", "to": "review",
      "guard": { "anyOf": [
        { "properties": { "tests-pass": { "const": true }, "pr-open": { "const": true } } },
        { "properties": { "pr-merged": { "const": true } } },
        { "properties": { "review-ready": { "const": true } } } ] } },

    { "from": "review", "to": "build",
      "guard": "review 要求改动",
      "actions": [ { "reset": ["tests-pass", "review-ready"] } ] },

    { "from": "review", "to": "deploy",
      "guard": { "properties": { "pr-merged": { "const": true }, "ci-pass": { "const": true } } } },

    { "from": "deploy", "to": "release",
      "guard": { "properties": { "deployed-staging": { "const": true } } },
      "approval": true },

    { "from": "release", "to": "done",
      "guard": { "properties": { "deployed-prod": { "const": true } } } }
  ]
}
===
```

链条是 **状态 → 工具 → 变量 → 转换 → 状态**：`build` 声明了用途 `test`，词典把它绑到本项目的 `npm test`；那条命令以 0 退出，`tests-pass` 变成 true；`build→review` 的通行要求读它，成立就自动走；进入 `review`，模型换一套提示词和用途。流程里只写用途不写命令，所以同一份流程搬到 Rust 项目一字不改：那里的词典把 `test` 绑到 `cargo test`。

`build` 不会卡住：PR 在 Gemflow 看到它开着之前就合并了，或者测试只在 CI 里跑、本地从不出现测试证据，通行要求的另外两个分支（PR 已合并、人勾选了 `review-ready`）都能放行。各阶段给模型的提示词是同一个文件里、状态机之后的章节，`prompt` 指向它们，进入状态时由 Stagehand 展开（§3.10）。

起步词典的行由 `gemflow init` 并进项目的 `.geml/tools.geml`，把流程的用途绑到本项目的工具上（§2.3）：

```geml
=== table {#tools}
| tool                                | for            | allow | deny | default | params |
|-------------------------------------|----------------|-------|------|---------|--------|
| Read                                |                | *     |      |         |        |
| Edit                                | edit           |       |      |         |        |
| Bash(npm test)                      | test           |       |      | yes     |        |
| Bash(gh pr create)                  | pr             |       |      |         |        |
| Bash(wrangler deploy --env staging) | deploy-staging |       |      |         |        |
| Bash(wrangler deploy)               | deploy-prod    |       |      |         |        |
===
```

`Bash(wrangler deploy)` 是前缀，所以带 `--env production` 的部署和根本不带 `--env` 的部署都匹配它，后者按 production 算；`wrangler deploy --env staging` 归字面部分更长的那个键。内置的词典（`integrations/gemflow/workflows/dev/tools.geml`）每种写法多一行：`wrangler` 前面加 `npx`、`pnpm`、`bunx`，`test` 另有 `pnpm test`、`yarn test`、`cargo test`、`pytest`、`go test`。

### 2.2 构件

| 构件 | 写法 | 含义 |
|---|---|---|
| 状态机 | `diagram {format=geml-statechart}`，正文 JSON | 状态、转换、变量。格式的规则——保留键、通行要求的三种写法、`reset`、画法、`data=`——在[它自己的词汇表](../../../spec/profiles/geml-statechart/geml-statechart-profile_CN.md)里 |
| 状态 | `states` 里的一项 | `title`、`description` 给人看也给模型看。Gemflow 的键：`prompt`，提示词：一个章节（本文档的 `#id`，或 `doc.geml#id`）或整份文档（`./guide.geml`，Markdown 也行；`./` 开头的路径相对流程目录，其余相对项目根），进入状态时载入；`skills`，skill 名的列表，交给宿主；`tools`，用途的列表。格式的 `final: true` 标终态：进了它，工作项就关闭（§3.5） |
| 条件变量 | `vars` 里的一项 | `default` 定类型。Gemflow 的键：`source`，值从哪来（见下）；`note` |
| 转换 | `transitions` 里的一项 | `guard`，和 `actions` 里的 `reset`：走这条边时，列出的变量在同一个修订里回到默认值，通行要求读的是走之前的值——返工的边用它清掉上一轮的证据。Gemflow 的键：`approval: true`，要人此刻点头；`note`，交给模型的这条边的说明 |
| 通行要求块 | `format=json` 的 `data` 块，`guard` 用 `#id` 引用 | 长的、几条转换共用的通行要求 |
| 提示词 | 普通的章节或文档，`prompt` 引用 | 进入状态时展开进上下文 |
| 工作项单位 | meta `flow-unit` | `branch`（默认，每个分支一个工作项）或 `file:<glob>`（每个匹配的文件一个，如 `file:episodes/*.geml`） |

对象形式的通行要求是对条件变量的 JSON Schema，用 geml-statechart §4 定下的子集写，实例是「变量名 → 当前值」的对象。定义放在图块用 `data=` 引用的 `data` 块里时（geml-statechart §2.8），坐标（GEML §5.2）能寻址到其中每个值：`geml get flow.geml '#flow-def["vars"]["tests-pass"]["default"]'` 读一个，`geml set` 只改那一个，其余字节原样保留。

**`source`：条件变量的值从哪来。**

| 写法 | 何时写 | 值 |
|---|---|---|
| 没有 `source` | 模型调用 `set` | 模型写的值，类型须与默认值相同 |
| `{ "tool": "<用途>" }` | 绑定到这个用途的一次工具调用结束时（§3.6） | 成功 true，失败 false |
| `{ "file": "<glob>" }` | 写文件或运行命令的调用结束时、会话开始时、看板刷新时 | 有文件匹配时 true |
| `"committed"` `"pr-open"` `"pr-merged"` `"ci-success"` | 会话开始时、运行了 `git`/`gh` 的调用结束时、看板刷新时 | git 与 CI 的事实（§3.6） |
| `"human"` | 人在看板上勾选，或 `gemflow mark` | 勾上 true，取消 false |
| `{ "elapsed": "<ISO 8601 时长>" }` | 打开工作项时，和每次写操作开始时（§3.6） | 当前状态已停留至少这么久时 true；进入状态时回到 false |

有 `source` 的变量是**证据**：模型写不了，默认值必须是 `false`。没有 `source` 的是模型自己的记事本。

**三种通行要求，三种判断者。**

| 通行要求（`guard`） | 谁判 | 怎么走 |
|---|---|---|
| 对象，或引用通行要求块 | 机器 | 一次改动之后成立就自动走；一个状态至多一条这样的、不要批准的出边 |
| 一句话 | 模型 | 原文随阶段说明交给模型；模型认为成立时 `move` |
| `approval: true` | 人 | 看板上点，或 `gemflow advance`；旁边写了通行要求则它也须满足；从不自动走 |

没有通行要求、不要批准的转换，模型 `move` 或人走。

**用途。** 状态的 `tools` 列出这个阶段要用的用途——`edit`、`test`、`pr`、`deploy-prod`、`image`——自己起的词。工具词典把用途绑到本项目的具体工具（§2.3）。一个用途只能在声明了它的状态里用：这是流程作者封路的办法，production 部署只在 `release` 里跑得了。没有绑到任何用途的工具，按词典里学到的决定（§3.7）。

### 2.3 工具词典

每个状态能用哪些工具、同一用途里首选哪个、参数默认取什么，都不写进流程，记在项目的工具词典里：`.geml/tools.geml`，所有流程共用的一张 `#tools` 表，和流程一起放在项目的主目录（§3.1），在使用中由人的选择长出来（§3.7）：

```geml
=== table {#tools}
| tool                        | for   | allow | deny | default | params |
|-----------------------------|-------|-------|------|---------|--------|
| Read                        |       | *     |      |         |        |
| Edit                        | edit  |       |      |         |        |
| Bash(npm test)              | test  |       |      | yes     |        |
| Bash(gh pr create)          | pr    |       |      |         |        |
| mcp__jimeng__generate_image | image |       |      | yes     | `{"ratio": "9:16", "model": "seedream-4.0"}` |
| mcp__flux__generate         | image |       |      |         | `{"steps": 28}` |
===
```

- `tool` —— 工具名，可带 `*` 通配（`mcp__geml__*`）。一个工具一行，名字区分大小写；同名的第二行不算数，报警告。运行命令的工具按命令记：`Bash(npm test)` 匹配以它开头、且在词边界结束的命令（`npm test -- --watch` 算，`npm tests` 不算）；`*` 匹配任意一段（`Bash(geml media todo * --check)`）；字面部分最长的键优先（§3.6）；`Bash()` 表示所有命令。
- `for` —— 用途：流程在状态的 `tools` 里声明的词（`edit`、`test`、`image`……）。同一用途的工具互为替代。绑了用途的工具只在声明了这个用途的状态里能用（§2.2）。
- `allow`、`deny` —— 状态 id 的列表，`*` 表示所有状态。
- `default` —— `yes` 表示同一用途里的首选，每个用途至多一个；一个用途登记的第一个工具自动成为首选。
- `params` —— 一个 JSON 对象：调用这个工具时，模型没给的参数用它补上。

这张表的读法与 Gemflow 读的每张表相同：列名不分大小写；不得有表头列表之外的列、空列名或重复的列；单元格恰为一个行内代码时取代码里的文本；单元格里的字面 `|`（行内代码里也一样）写成 `\|`（GEML §6）。

**起步词典。** `gemflow init`、`/gemflow add` 复制内置流程时带上它的起步词典：`*` 行预先在所有状态允许宿主的只读工具（`Read`、`Grep`、`Glob`）；流程声明的用途预先绑好常见的工具——开发流程的 `test` 绑 `npm test`、`pnpm test`、`yarn test`、`cargo test`、`pytest`、`go test`，`pr` 绑 `gh pr create`，`deploy-staging`、`deploy-prod` 绑 `wrangler deploy` 的几种写法（`npx`、`pnpm`、`bunx` 前缀各一行；不带 `--env` 的按 production 算）；要严格的流程预先写好拒绝（内置的 coding 流程在 `explore` 拒绝 `Edit`、`Write`）；其余工具照常放行。

### 2.4 journal

journal 是一份普通的 GEML 文档，由追加写的 `data` 块组成：

```geml
=== data {#journal}
{ "item": "feat/rate-limit", "workflow": ".geml/workflows/dev.geml", "workflow-hash": "sha256:…", "created": "2026-10-12T09:00:00Z" }
===

=== data {#rev-0}
{ "rev": 0, "state": "build", "cause": "enter", "at": "2026-10-12T09:00:00Z",
  "vars": { "tests-pass": false, "pr-open": false }, "parent": null, "hash": "sha256:…" }
===

=== data {#rev-1}
{ "rev": 1, "state": "build", "cause": "patch", "by": "signal", "signal": "tests-pass", "call": "toolu_…",
  "tree": "tree:…", "at": "…", "vars": { "tests-pass": true, "pr-open": false }, "parent": "sha256:…", "hash": "sha256:…" }
===

=== data {#refused-1}
{ "rev": 1, "at": "…", "tool": "Edit", "call": "toolu_…", "reason": "你在 #explore 拒绝过 Edit" }
===
```

- `#journal` —— 工作项（`item`）、它开始时的流程文件（`workflow`，相对项目根）、这个文件的哈希（`workflow-hash`）和 journal 开始的时间（`created`，ISO 8601 UTC 时间戳）。工作项此后一直按这个流程推进（§3.2）。
- `#rev-N` —— 一条修订。`rev` 从 0 起连续；`state` 是状态 id；`vars` 是这条修订之后的变量值；`at` 是时间。
  - `cause` —— 做了什么：`enter`、`transition`、`patch`、`rollback`、`expire`、`pause` 或 `resume`。`pause` 与 `resume` 是人对工作项的暂停与继续（§3.8）：状态与变量和上一条修订相同，`by=human`；暂停期间证据照记，任何转换都不走——模型的、人的、机器的都不走。`enter` 解除暂停。
  - `by` —— 谁做的：`model`、`human` 或 `signal`。第 0 条修订不带它。
  - `signal` —— 触发它的信号变量，当且仅当 `by=signal` 时出现。
  - `from` —— 离开的状态，出现在 `transition` 与 `rollback` 上。`restores` —— 出现在 `rollback` 上，是恢复的那条修订。
  - `call` —— 触发它的工具调用（有的话）。
  - `tree` —— `tool` 证据的内容指纹（§3.6），出现在 `source` 为工具的变量取了非默认值的那条修订上。
  - `hash` —— `"sha256:"` 加上这一块去掉 `hash` 之后规范 JSON（键按码点排序、无空白）的 SHA-256。`parent` 是上一条修订的 `hash`，第 0 条修订是 `null`。换序、删掉或改动一条修订都会让链断开。删掉**末尾**的一段块是这条链唯一检测不出的改动，所以 journal 的尾部只和它下面的存储一样可信。
- `#refused-N` —— 一次拒绝，从 1 起编号：`rev` 是它发生在哪个修订之后，`tool` 是被拒的工具或动词，`call` 是它的调用 id（人的命令没有），`reason` 是理由，`key` 是闸判定时所依据的词典键或命令模式（有的话；人专属命令与动词的拒绝没有）。拒绝不增加修订。
- `#wrote-N` —— 工作项干活时写过的一个文件，从 1 起编号：`rev` 是写时的修订，`at` 是时间，`tool` 是写它的工具，`path` 是相对项目根的路径，`call` 是调用 id。同一阶段里同一个文件只记一次，工作项文件本身不记。和拒绝一样不进哈希链，也不增加修订。
- 坐标能读到任何一个值：`geml get .geml/journals/feat/a.geml '#rev-3["vars"]["tests-pass"]'`。
- journal 用**盲追加**写：每一块自身完整，写一块时写入方从不读文件（GEP-0005）。

journal 在某个工作项第一次有 Gemflow 事件时创建，第 0 条修订 `cause=enter`。放在哪里由单位决定：

- `branch` —— `.geml/journals/<分支名>.geml`，放在仓库**主工作树**（`git rev-parse --git-common-dir` 的上一级）里，所有检出共用：同一个分支在哪个检出里做都是同一本，worktree 删掉了记录也还在。这个 `journals/` 目录自带一个内容为 `*` 的 `.gitignore`。当前在 `main`（或仓库默认分支）上时引擎不工作，状态带显示 `main · not tracked`。
- `file:<glob>` —— `.geml/journals/<文件相对路径去掉扩展名>.geml`，按检出各一份；不依赖 git。
- 不在 git 里的项目：项目根的 `.geml/journals/`。

路径里工作项 id 的每个 `/` 都成为一级目录。

### 2.5 上下文文档

`.geml/context.geml` 存放 Stagehand 为当前阶段写出的内容（§3.10）：

```geml
=== text {#current}
写代码和测试，直到测试通过、PR 开出来。
===

=== data {#stage}
{ "item": "feat/rate-limit", "state": "build", "rev": 0, "at": "2026-10-12T09:00:00Z" }
===

=== data {#vars}
{ "tests-pass": false, "pr-open": false }
===
```

- `#current` —— 一个 `text` 块，内容是阶段说明。围栏比文字里任何一行行首的 `=` 串多一个 `=`，并且至少三个，所以文字里没有哪一行能把块关掉。
- `#stage` —— `item`、`state`、`rev`（进入这个阶段的修订）和 `at`。
- `#vars` —— 当前的变量值。同一阶段里的修订只重写它。它是只读视图：`geml get .geml/context.geml '#vars["tests-pass"]'` 读一个值。变量只经动词与信号写入，因为 journal 只追加、带哈希链，每次写入都要过变量的类型，以及"有 `source` 的变量模型写不了"这条规则。
- 按检出各一份，每次整份重新生成，不记版本，默认 gitignore。

## 3. 运行时语义

### 3.1 项目

```
.geml/                         项目的主目录：在主工作树里，所有检出共用；默认 gitignore
  workflows/<name>.geml        一份流程：状态机，后面跟着各阶段的提示词；它另带的文档放在 <name>/ 里
  tools.geml                   所有流程共用的工具词典（§2.3）
  project.geml                 项目文档，以及大纲 #items
  artifacts.geml               产物表 #artifacts；副本在 artifacts/
  journals/<item>.geml         每个工作项一本 journal（§2.4）
.geml/                         每个检出各一份
  context.geml                 当前阶段（§2.5）；默认 gitignore
  backlog.geml                 backlog（§3.12）；提交进仓库
```

项目文档的 meta `flow-workflow` 指定新工作项用的流程：

```geml
=== meta
title         = "Gemflow"
flow-workflow = "dev"
===
```

项目文档的 meta 下面是大纲，一个 `table {#items}`，列为 `item`、`state`、`flow`、`stage`、`worktree`、`commits`、`pr`、`tip`、`since`、`last`：项目有过的每个工作项和它的结局。Gemflow 每次列工作项时写它，只重写这张表；`state` 没有人填。分支类工作项：分支还在、没合并是 `doing`；PR 已合并，或者分支有过自己的提交、默认分支收进了它的最后一个提交，而分支还在，是 `merged`；合并过的分支删了是 `closed`；没合并就删了、或者一个提交都没有，是 `dropped`。文件类工作项走到流程终点是 `closed`，停在名为 `parked` 的状态是 `dropped`。一行记着 git 记不住的——删掉的分支最后的提交、有过几个提交、gh 下次被问到之前的 PR——journal 没了的那行也留着。

每个工作项的产物记在主目录的 `artifacts.geml` 里，一个 `table {#artifacts}`，列为 `item`、`kind`、`name`、`where`、`version`、`size`、`at`、`sha256`，一行一版。`kind` 是 `link`、`doc`、`file` 或 `image`。工作项写过的文件里 git 不留的（被忽略的，或者根本不在仓库里），每回合结束和打开看板时各看一次，内容变了就在 `artifacts/` 存一份副本，以内容的 SHA-256 加原扩展名命名，`where` 记 `artifacts/<sha256>.<ext>`；单个超过 20 MB 不复制，`where` 记它自己的路径。GEML 文档只存一份副本，之后的版本记进这份副本的 `.gemlhistory`。git 留着的文档（`.md`、`.geml`）每个一行，`where` 为 `git`，`version` 是最后改它的提交。Artifact 工具发布的页面自动记成链接，`version` 是发布结果里的版本号；别的链接和生成的图片，模型用 `artifact` 工具记。

默认流程按下面的顺序确定：环境变量 `GEMFLOW_STATECHART` 指定的流程文件（它指定的是会话的流程，另一个检出里的项目不理会它，§3.3）；否则是 `flow-workflow` 指定的那个；否则是项目唯一的那个流程。`gemflow init --template <name>` 把一个内置流程写成 `.geml/workflows/<name>.geml`——guide 的各节接在状态机后面——把它的词典行并进 `.geml/tools.geml`，并设为默认流程；`gemflow use <name>` 与 `/gemflow use` 换一个默认流程，已经开始的工作项仍按各自的流程（§3.2）。

检出里的旧布局——`.geml/workflows/<name>/` 目录里放 `flow.geml`、它的提示词文档和 `tools.geml`，加上 `.geml/gemflow.geml`——照样能读，同名时主目录的文件优先。`gemflow migrate` 和 Claude Code 会话的第一次 status 把它搬进主目录；git 跟踪着的只复制、留在原处。名字是这种 `flow.geml` 的 journal，接着在它搬去的那个文件下走。

### 3.2 工作项

当前工作项按默认流程的单位确定。

- `flow-unit = "branch"`：工作项是当前检出的分支。在仓库默认分支（远端的 `HEAD`，否则本地的 `main` 或 `master`）上、在游离的 `HEAD` 上、在还没有提交的分支上、在 git 仓库之外，都没有工作项。
- `flow-unit = "file:<glob>"`：工作项是最近一次被写入的匹配文件；还没有调用写过时，是上下文文档所写的那个工作项，只要它的文件还在、还匹配。人也可以在看板上切换。`.git`、`node_modules` 目录里的文件永远不是工作项；`.geml` 里的也不是，除非 glob 的第一段就是 `.geml`；`.geml/journals/` 里的永远不是。
- 写了 `flow-state-key` 时，事项文件在那个 meta 键下记着工作项现在的阶段：一次操作结束后它说的不一样就写回，只改这一个值；没有 journal 的工作项从它写的阶段起步（流程里有这个阶段时）。
- id 是分支名，或文件去掉扩展名的路径。只有每种文件系统都能存下的 id 才用来命名 journal：用 `/` 分隔，没有空段、`.` 段或 `..` 段，不以 `/` 开头，没有控制字符，也没有 `<` `>` `:` `"` `|` `?` `*` `\`，没有以 `.` 或空格结尾的段，没有 Windows 设备名（`con`、`nul`、`com1`……，带什么扩展名都算）。其他 id 都不构成工作项。
- 没有工作项时什么都不记录，宿主会说明原因（`main · not tracked (work items are branches)`）。

**每个工作项记住自己的流程。** 已有 journal 的工作项按 `#journal` 记的流程继续；新工作项按默认流程开始。`gemflow use` 只改默认流程，所以岔出去的那件事可以用另一种流程，被打断的工作项仍按它自己的流程，回来时照旧。journal 记的流程文件不存在时，这个工作项上的每个操作都失败并指出那个文件；出路是恢复它，或把 journal 挪开、从默认流程重新开始。宿主上显示工作项的地方，在工作项的流程不是默认流程时写出它的名字。

### 3.3 一次调用作用在哪个工作项上

做一个工作项的途中常插进一件别的事——顺手发现的修补、一次 rebase、一个 PR——做完再回来。工作项是隔离单位：每个工作项一本 journal、一份变量，那件事落在另一个工作项上（另一个分支、另一个检出、`file:` 单位的另一个文件），被打断的那个就保持原样。下面的规则把每次调用归到它真正作用的工作项上。

**调用从哪里开始，每条命令在哪里跑。** 宿主报告每次调用的起始目录（Claude Code：钩子里读 `$.session.cwd()`，按发起调用的循环作答）。单纯 `&&` 链（§3.6）里的一条简单命令，在起始目录经链里它之前的 `cd`、`pushd`、`chdir` 改变之后的目录里运行。目标写不定——含 `$`、`~` 或反引号，是 `-`，或缺省——时，这条命令的目录未知。写文件的工具（Edit、Write、NotebookEdit）按目标文件所在的目录。目录属于哪个检出，看它的 git 顶层。

**记录从准。** 信号只写进调用确定作用的工作项：

| 调用落在 | 记进 |
|---|---|
| 会话的检出（含其子目录） | 会话当前的工作项 |
| 另一个检出，它有流程、有当前工作项 | 那个检出当前的工作项，按它自己的流程 |
| 别处，或目录未知 | 不记 |

**拦截从严。**

- 只许人做的命令（§3.8）在哪里跑都拒；对 journal 或上下文文档（不论哪个检出的）的写入也在哪里都拒。
- 写文件的调用按目标文件所属工作项的闸。
- 命令行只有在每条命令都确定落在同一个、有当前工作项的另一个检出里时，才用那个检出的闸。其余的命令行——跑在别处、目录未知、落在几处、落在工作项不活跃或流程载入失败的另一个检出里——一律按会话当前工作项的闸：命令从哪里开始跑不等于它作用在哪里，`cd /tmp && rm -rf <项目>/src` 照样被拒。

**重读事实跟会话走。** 调用之后重读的 git 与 `file` 来源，只要调用不确定作用在另一个检出里，就作用于会话的工作项：重读的是真实的事实，总是对的。`file` 来源的遍历不进入嵌套的检出（项目根之下含 `.git` 的目录）。另一个检出里的项目在它自己的 `.geml/` 里找流程；`GEMFLOW_STATECHART` 只指定会话的流程。

**动词。** 调用方循环的目录确定落在另一个有当前工作项的检出里时——比如隔离 worktree 里的子 agent——动词作用于那个检出的工作项；否则作用于会话的工作项。

**`file:` 单位。** 命令的 `tool` 证据与闸都跟随命令行写到的那一集：命令行恰好写到本检出的一个单位文件时。写到不是本检出的单位文件、或在单位文件的位置写了通配或花括号的命令行不记；一个文件都没写到的命令行作用于当前工作项。

**只切换工作项的命令行在任何状态都放行**，在工具词典之前判（§3.7）：不拒、不问。它是一条单纯的 `&&` 链，其中每条简单命令都是下列之一：

- `git switch <分支>`，或 `git switch -c|-C|--create|--force-create <分支> [<起点>]`；
- `git checkout -b|-B <分支> [<起点>]`，或 `git checkout <分支>`（`<分支>` 是已有的本地分支时）；
- `git worktree add [-b|-B <分支>] [--detach] <路径> [<起点>]`；
- `cd <路径>`。

带其他选项或参数的——`-f`、`--force`、`--discard-changes`、`--merge`、`--`、路径参数——都不算。所以即使人在某个阶段拒绝过 `Bash(git)`，也总能离开去做别的事，拒绝的理由里会提示这个出口。`git switch` 会把未提交的改动带到切过去的分支上，这是 git 的行为。

**交接。** 换了工作项时当场交给模型（§3.10）。

**局限。** 目录按命令行的文字判断：变量、脚本，以及作为参数传入的目录（`npm --prefix`、`git -C`）都不跟踪。不问运行时、自己判定一部分调用的宿主（Claude Code 的快路径），对经过符号链接的路径可能与运行时判断不一致。

### 3.4 一次一个操作

对一个工作项的每个操作——一次工具调用前的检查或调用后的结果、一个动词、人的一条命令、一次刷新——都先拿锁 `<journal>.lock`，重新读 journal，执行，追加它产生的块，再放锁；所以 CLI、MCP 服务和宿主的 hooks 能共享同一个项目而不共享内存。同一工作项的多个会话追加到同一本，哈希链连续。锁被别人拿着时等待后重试；超时则这次写入失败，状态带报错，不静默丢弃。操作开始时先在同一把锁下处理 `tool` 证据的过期（§3.6）。

校验不通过的 journal（§4），或当前状态在它的流程里不存在的 journal，不会被续用：这个工作项上的每个操作都会失败，并指出 journal 和出路——把它挪开，下一个操作就从默认流程的起点重新开始这个工作项。

### 3.5 推进

| 谁 | 怎么发生 | `by` |
|---|---|---|
| 模型 | `move` 走当前状态的一条出边：一句话的通行要求的边，或没有通行要求的边；机器判的边不由它走（通行要求满足时自己走），要批准的边也不行 | `model` |
| 人 | 在看板上点一条边，或在自己终端运行 `gemflow advance <state>`；这本身就是批准 | `human` |
| 自动 | 一次改动之后，当前状态那条机器判的、不要批准的出边的通行要求满足了，立即走 | 记那次改动的来源：信号写入后 `signal`（带 `signal=<变量>`），模型动作后 `model`，人推进后 `human` |

通行要求对三种来源一视同仁。

- 一次写入了几个信号时，自动走的边记在它的通行要求所读的条件变量对应的那个信号名下（通行要求的 `properties` 或 `required` 里出现的第一个），没有则记最后写入的信号。
- 一次改动之后连着自动走，走到某个本次已经进入过的状态（出发时所在的状态也算），就停在它前面；自动走的自环因此永远不会被走。
- 一次转换（模型的 `move`、人的推进）之后的第一条自动边，不会把流程直接带回这次转换刚离开的状态：人把开发流程从评审退回构建（`review→build`）时，`build→review` 的通行要求即使仍满足，流程也停在构建，不会被立刻弹回去。只有刚离开的那个状态被挡，也只在这一次改动里挡：之后的下一次改动（例如测试重新跑绿）照常走这条边，一条链隔一步再回到那个状态也照常走。回滚不算这样的转换，它恢复出的状态上成立的自动边照常走。
- 自动走过的边同样执行它的 `reset` 动作，然后才看下一个状态的边。
- 写入后变量值没变的信号写入不算改动，不带走任何边。

模型对要批准的边调用 `move` 一律被拒绝并记一条 `refused`，回答里提示由人在看板上或用 `gemflow advance <state>` 批准。

**终态。**进了标 `final` 的状态（geml-statechart §2.1），工作项就关闭：没有出边，模型、人、自动都走不了；`tool` 证据不再过期（§3.6）；状态带显示 ✓ 加该状态的 `title`。闸照旧按这个状态声明的用途判——一集发布之后不该再动剧本，一条分支完成之后再改是新的改动；出路是换工作项（新分支、下一集），或者人 `rollback` 回到之前的修订。模型到不了终态，除非作者给了一条模型判的转换进去。

### 3.6 运行中的条件变量与证据

| `source` | 何时读 | 值 |
|---|---|---|
| 没有 | 模型调用 `set` 时 | 模型写的值，类型须与默认值相同 |
| `{ "tool": "<用途>" }` | 绑定到这个用途的一次工具调用结束时（怎么对上用途见下） | 成功 true，失败 false：命令看退出码，其他工具看 `isError` |
| `{ "file": "<glob>" }` | 写文件或运行命令的调用结束时（构建、渲染产生文件，和编辑一样确定；指明的路径在项目之外或在 `.geml`、`.git`、`node_modules` 里时不算）、会话开始时、看板刷新时 | 有文件匹配 glob 时 true |
| `"committed"` `"pr-open"` `"pr-merged"` `"ci-success"` | 会话开始时；命令行在任一命令位置运行了 `git` 或 `gh`（任意路径；经启动器运行的如 `sudo git switch main`、`timeout 30 git pull`，交给 shell 的字符串里的如 `bash -c "git checkout -b x"` 也算；只当别的命令的参数写出来不算）的调用结束时；看板刷新时 | 按当前分支查询；`ci-success` 取分支 head 上每个 CI workflow 最近一次运行的结论 |
| `"human"` | 只来自人：看板上的勾选框，或人在自己终端运行 `gemflow mark <变量>`（`gemflow unmark <变量>` 取消） | 勾上 true，取消 false |
| `{ "elapsed": "<ISO 8601 时长>" }` | 时钟：每次打开工作项时（任何命令、任何请求）和每次写操作开始时，和 `tool` 证据的过期一起，持锁 | 从进入当前状态的那条修订（§3.8 的检查点）到现在，已满这个时长时 true，否则 false |

信号只写布尔值。它的写入是一条 `cause=patch`、`by=signal`、`signal=<变量>` 的修订；写入后变量值不变时不增加修订。

**`elapsed` 证据读时钟。**时长是 ISO 8601 的日、时、分、秒子集（`PT2H`、`P1DT12H`、`PT30M`），须大于零；月和年不是时钟能加的，不认。它量的是**当前状态停留了多久**：每条进入状态的转换和每次回滚都在同一修订里把所有 `elapsed` 变量还原成 false，时钟从那条修订重新起算；所以「评审等了两小时」在 `review` 的出边上读它，退回构建再进评审时重新计时。每次打开工作项（任何命令、任何请求，`gemflow status` 也算）和每次写操作开始时求值，所以状态带、看板和 `status` 看到的总是当下的值。终态里不求值（§3.5）。

**`tool` 证据会过期。** `source` 为工具的变量写下非默认值时，那条修订记下工作项内容的指纹 `tree`。之后每次对该工作项的操作开始时（持锁），指纹若已变，就在一条修订里把这些变量还原成默认值（`cause=expire`、`by=signal`，`signal=` 记第一个），随后像任何一次改动之后一样看边。指纹：`branch` 单位是检出里工作内容的 git tree——git 不忽略的每个已跟踪、未跟踪文件在磁盘上的样子，从 index 的副本 `git add -A` 后 `git write-tree` 写出，真实的 index 不动，只给变了的文件算哈希；`.geml` 与 `node_modules` 不算——`file:` 单位是那一集文件内容的哈希。所以测试通过之后改了代码、rebase、pull 都要重跑，只是提交了不用。`file` 与 git 的事实本来就按当下重读；`human` 是人的判断，不过期。

**退出码怎么判定。** 在 Claude Code 上：调用以错误结束时 `isError` 为 true，`text` 以 `Exit code <n>` 开头，取这个 `n`；未以错误结束且结果里没有 `returnCodeInterpretation` 时退出码为 0。Claude Code 把少数非零码当作正常结束（`grep` 无匹配是 `No matches found`，`diff` 有差异是 `Files differ`），这类结果按非零处理，所以 `tool` 证据不会把"测试命令里 grep 没找到"误判成通过。

**调用怎么对上用途。** 运行命令的工具，命令行拆成简单命令（跳过开头的 `NAME=value` 赋值；空白只指空格和制表符），每条简单命令去掉引号与转义、把每段空白并成一个空格后，与词典里 `Bash(…)` 的键匹配：键是一个模式，`*` 匹配任意一段文字，没有 `*` 的键匹配以整词结束的前缀（`Bash(npm test)` 匹配 `npm test -- --watch`，不匹配 `npm tests`；`Bash()` 匹配所有命令）；字面部分最长的键优先（`Bash(wrangler deploy --env staging)` 赢过 `Bash(wrangler deploy)`）。其他工具按工具名匹配（可带 `*`）。匹配到的键的 `for` 就是这条调用所属的用途。只有当命令行整个就是用 `&&` 连接的简单命令时退出码才算数，其他命令行不写 `tool` 证据，因为它的退出码说明不了匹配到的那条命令。命令行在引号之外含下面任何一种，就不是单纯的 `&&` 链：

- `;`、`||`、管道、后台 `&`（`&>` 也算；`2>&1`、`>&log` 这类重定向里的 `&` 不算）、换行、`$(`、`${`、`$[`、反引号或 `(`；
- 出现在词首的 `#`，它开始一段注释；
- 引号没有闭合，或有空命令（`a &&`）。

引号规则同 shell：单引号里什么都不是运算符；`$'…'` 里只有反斜杠转义有效；双引号把上面的运算符挡在拆分之外（shell 仍会执行双引号里的 `$(…)` 与反引号，`${` 也挡不住）；引号之外的反斜杠转义下一个字符（反斜杠加换行是续行）。某个简单命令的命令字——跳过赋值、重定向和前缀 `builtin`、`command`、`time`、`!`、`noglob`、`nocorrect` 之后——是 shell 关键字（`[[`、`]]`、`{`、`}`、`function`、`if`、`while`、`for`、`case` 等）、会结束 shell 或改变后续命令含义的内建命令（`exit`、`exec`、`trap`、`return`、`logout`、`hash`、`alias`、`unalias`、`enable`、`eval`、`source`、`.`），或由展开拼出来的词（含 `$`）时，这行同样不写 `tool` 证据：它们都能让整行以 0 退出而匹配到的命令并不为此负责。

后台运行的命令（结果里带后台任务 id）在调用结束时还没有退出码，不写 `tool` 证据。子 agent 的工具调用同样经过主会话的钩子，由子 agent 跑的测试照样记入信号——记进它所在检出的工作项（§3.3）。

**用途封路**则在整条命令行的任意位置查找，并在去掉引号和反斜杠、把每段空白并成一个空格的副本里再查一遍，所以复合命令行里或包装器（`npx …`、`bash -c "…"`）里的部署，在没有声明这个用途的状态里照样被拒绝，`wran"gler"  deploy` 也一样。

命令行是 PowerShell 的工具——DeepSeek Harness 的 `pwsh`——从不按这些 sh 规则读。它不写 `tool` 证据；它的封路检查在原样的命令行里查找键，并在去掉 PowerShell 反引号转义的副本里再查一遍（反引号加换行把两行接起来）。

**两者的局限。** `tool` 证据的意思是「绑到这个用途的一条命令以 0 退出」，不是「测试套件通过了」：参数、环境和被改过的脚本都会改变命令实际运行的内容，所以词典里的键要写够长（`Bash(npm test)`，不是 `Bash(npm)`）。用途封路只看得见命令行的文字，并且区分大小写：变量、`eval`、编码后的字符串、模型自己写的脚本都能绕过它，所以脚本名也要一并守住；要真正拦住一条命令，得让 agent 手里没有执行它所需的凭据。

**glob 的写法。** `file` 来源的 glob 与 `flow-unit = "file:<glob>"` 里的 glob 对整条路径匹配，路径相对项目根、用 `/` 分隔。`*` 匹配一段路径之内的任意字符，`**` 匹配跨段的任意字符（`**/` 也可以什么都不匹配，所以 `docs/**/*.md` 能找到 `docs/a.md`），`?` 匹配 `/` 以外的一个字符。没有字符类，也没有花括号：`[`、`]`、`{`、`}` 只匹配它们自己。`*` 与 `?` 也匹配开头的 `.`，所以 `*` 能找到点文件。名字区分大小写，不论文件系统怎样。任何深度上 `.geml`、`.git`、`node_modules` 目录里的文件都不匹配；遍历不跟随指向目录的符号链接，也不进入嵌套的检出；遍历满 50 000 个条目仍未结束就放弃，此时变量保持原值。

**git 与 CI 的事实**，按当前分支：

- `committed`：分支上有默认分支没有的提交。只问 git。
- `pr-open`、`pr-merged`：head 为该分支的最新一个 pull request 的状态；没有 pull request 的分支两者都不是。
- `ci-success`：分支当前所在提交上每个 CI workflow 的最新一次运行：至少有一次，且每一次都以 `success`、`skipped` 或 `neutral` 结束时为 true；还在跑的不算成功。

只有 `vars` 里有来源为 `pr-open`、`pr-merged` 或 `ci-success` 的变量时才问 `gh`（`GEMFLOW_GH` 指定的程序，否则 `gh`）。没有 `gh`、未登录或没有可问的 GitHub remote 时，这几种变量不写入、保持原值，标为"不可用"，状态带显示原因。谁都确定不了的事实绝不当作 false。

### 3.7 工具：词典、询问与偏好

**一次调用怎么判**（在调用所属工作项的当前状态 S 里，§3.3）：

1. 先判任何状态都生效的规则：只许人做的命令拒绝（§3.8）；只切换工作项的命令行放行（§3.3）；Gemflow 自己的三个工具（§3.11）放行。
2. 取这次调用的键：工具名；写文件的工具取 `<工具>(<路径>)`——只写工具名的一行管这个工具的所有路径，`<工具>(<glob>)` 这样的一行只管路径结尾匹配 glob 的调用（从某一段开头算起）；运行命令的工具再按命令行里每条简单命令取 `Bash(…)` 的键，字面部分最长的优先（§3.6）。
3. 每个键各判一次：绑着用途（`for`）的键，S 声明了这个用途就放行，S 没声明就拒绝（理由写明"`deploy-prod` 只在 #release 里用"）；没绑用途的键，在 S 或 `*` 上被拒过就拒绝（理由写明"你在 #S 拒绝过它"），允许过就放行，没有哪一行管它就是未归类。
4. 有一个键被拒绝：整次调用拒绝，理由列出每个被拒的键，记一条 `refused`。
5. 其余（每个键都放行或未归类）：放行，宿主自己的权限规则照常生效——一条没归类的命令能不能跑、安不安全，由它按命令的实际参数判断，不归 Gemflow 管；调用结束时，绑着用途的键按变量的 `source` 写证据。
6. Gemflow 不问人"没归类的键能不能用"。把它绑到某个用途、或者拒绝它，是人在看板上或在 `.geml/tools.geml` 里写的一行。

**偏好。**

- 阶段说明列出本阶段的工具：每个用途的首选和它的默认参数，以及本阶段拒绝的工具（§3.10）。模型一般照着用。
- 调用带 `params` 的工具时，模型没给的参数由 Gemflow 补上（改写这次调用的输入），模型给了的不覆盖。只对输入是结构化数据的工具做（MCP 工具、内置工具），命令行不改写。
- 模型用了一个有用途却不是首选的工具时问人：这次允许 / 以后默认用它 / 拒绝（让模型改用首选）。选择写回词典。
- 用途在看板上绑定或解绑，或者在 `.geml/tools.geml` 里写一行；默认参数在看板上编辑，或在一次调用上"设为默认"，把那次的参数存下来。

### 3.8 只许人做的事

`gemflow mark <变量>` 与 `gemflow unmark <变量>` 写一个 `source` 为 `human` 的变量，分别写 true 和 false；别的来源的变量被拒绝。`gemflow advance <state>` 以人的身份走当前状态的一条边：修订记 `by=human`，边的通行要求必须满足，`approval` 边不再询问就走——这条命令本身就是批准。`gemflow rollback <修订|checkpoint>` 恢复那个修订的状态与变量（`checkpoint` 是进入当前阶段的修订），不撤销已经发生的副作用。`gemflow pause` 暂停工作项（一条 `pause` 修订，§2.4）：证据照记，任何转换都不走——模型的 `move` 被拒绝并记下，人的 `advance` 被拒绝，机器判的边等着——直到 `gemflow resume` 继续：它以人的身份走此刻已满足的机器判的边。

模型不能运行 `mark`、`unmark`、`advance`、`pause`、`resume`。运行了其中之一的调用，在每个状态都被拒绝，并记一条 `refused`：

- **命令从哪里开始。** 命令行按 `;`、`&`、`|`、换行、括号与反引号拆开，双引号里的 `$(…)` 也拆。每条命令的命令字是跳过赋值、重定向和接着执行下一个词的前缀——`builtin`、`command`、`time`、`env`、`sudo` 这类——之后的第一个词，去掉引号与转义。
- **什么算运行 gemflow。** 命令字是 `gemflow`（取路径末段，不分大小写，`./node_modules/.bin/gemflow` 也算）；或者命令字是启动器——`npx`、`bunx`、`npm exec`、`pnpm dlx`、`pnpm exec`、`yarn dlx`、`node` 之类——而参数里有 `@geml/gemflow`（可带 `@版本`）或它的 `cli` 脚本。
- **动词。** 其后第一个非选项参数是 `mark`、`unmark` 或 `advance`（不分大小写）——或者由展开拼成，因而可能是其中任何一个。
- **交给 shell 的字符串。** `bash -c "…"`、`pwsh -c "…"`、`eval` 的参数，以及启动器交给 shell 的字符串（`sudo sh -c "…"`、`timeout 5 bash -c "…"`、`npx -c "…"`、`npm exec --call=…`、`env -S "…"`）照此再查一遍。PowerShell 的字符串按同样的规则读，另外再按词查找一遍，作为兜底。
- **扫描读不懂的命令行。** 命令字由展开拼成（含 `$`）或引号不闭合时，退而求其次：去掉引号后的命令行里同时有 `gemflow` 和这三个词之一就拒绝。

所以 `npx @geml/gemflow mark x`、`bash -c 'gemflow mark x'` 都被拒绝；`echo gemflow mark`、提交信息里写到 `gemflow` 与 `advance` 都不会。和用途封路一样，这条规则只看得见命令行的文字。

### 3.9 `by` 是一句声称

`by=human` 记录的是这次改动来自人的命令——终端里的 `gemflow advance`，或看板——仅此而已：运行时不验证任何人的身份。链证明的是发生了什么、按什么顺序；把 `by` 当作一句声称来读，不要当作证据。

### 3.10 Stagehand

Stagehand 分两层：核心只写文件，宿主负责把文件交给模型。

- **核心。** 进入一个状态时（任一来源），取这个状态的 `description`，展开 `prompt` 指向的章节或整份文档——`./` 开头的路径相对流程目录，其余相对项目根；其中的 `embed` 在进程内展开——后面加上要启用的 skill、本阶段的用途与各自绑定的工具（首选与默认参数，§3.7）、条件变量的当前值，和接下来能去的状态：每条出边，机器判的列出还缺的变量，一句话的给原文，要批准的标出，以及它的 `note`。解析符号链接之后落在项目之外的文件一律不读。
- **预算。** 整段按字节计不超过 16 KB。`description`、skill、工具、变量与出边总在内；`prompt` 的内容分剩下的字节，放不下的只列出地址，模型需要时自己去取。
- **文档。** 结果写进 `.geml/context.geml`（§2.5）。换阶段时整份重写；同一阶段里的修订只重写 `#vars`。
- **宿主。** Claude Code 的 hooks 模块把 `#current` 交给模型：随改变了阶段的那次调用的工具结果交，阶段在别处变了（看板、会话开始、子 agent）时随下一次提交交。没有注入通道的宿主由 skill 要求模型每轮先读 `.geml/context.geml`，`status` 也返回同一段。

**换工作项时当场交接。** 一次调用的应答所在的工作项，与上次交给主循环的阶段说明（`item@rev`）不是同一个时，新工作项的阶段说明随这次工具结果交给模型，前面加一行：

```
[gemflow] now on fix/doc-b · #build (new work item)
[gemflow] back on feat/a · #build · rev 3 · tests ✓ · pr ✗
```

子 agent 的调用拿到它自己工作项的说明，不算已经交给主循环。

### 3.11 动词

三个工具，参数结构固定，不随状态变：

- `status` —— 只读：工作项、阶段、变量、每条出边与通行要求是否满足，以及本阶段的说明。
- `move {to}` —— 走一条出边（§3.5）。
- `set {变量: 值, …}` —— 写由模型写的变量：类型须与默认值相同，有 `source` 的变量写不了。

Claude Code 里列为 `mcp__gemflow__status`、`mcp__gemflow__move`、`mcp__gemflow__set`；只接 MCP 的宿主经 `gemflow mcp` 看到同样三个名字；DeepSeek Harness 与 pi agent 注册为 `gemflow_status`、`gemflow_move`、`gemflow_set`。它们是 Gemflow 自己的工具：不经工具词典，动词自己的规则（通行要求、批准、变量类型）照样生效。人勾选的变量与回滚不是模型的工具。

只接 MCP 的宿主不把自己的工具调用交给 Gemflow，所以在它上面：

- `tool` 来源观察不到，`tool` 证据立不起来，工具词典、用途封路与只许人做的命令什么都不拒。通行要求对人的推进同样生效，所以通行要求要读 `tool` 证据的转换，只有通行要求也接受一个人勾选的变量时才会走：开发流程里人勾选 `review-ready` 能让 `build` 进入 `review`，production 部署的退出码在这类宿主上永远读不到，`release` 到不了 `done`，除非流程给这条转换的通行要求加一个人勾选的条件变量。
- git、`file` 来源只在模型调用 `status` 时重读；读完流程动了，回答后面附上新阶段的说明。
- 没有状态带和看板；人在终端里用 `gemflow` 推进、勾人勾选的变量。

### 3.12 backlog

`.geml/backlog.geml` 里有一个 `table` 块 `#backlog`，列是 `id`、`title` 和一个目标列：`branch`，`file:…` 单位的流程用 `file`。单元格的读法与工具词典相同（§2.3）。目标单元格为空的行是待办。某个工作项第一次创建 journal 时，若有待办项，看板提示把其中一项绑定到它；也可以在看板上自己绑定。绑定只填那一个单元格，文档里的其余字节原样保留——别的列和它们的对齐、别的行、正文、meta、别的块、换行符。`id` 为空或重复的行、已经绑定到别处的行都不能被绑定。读表时对没有 id 的行报诊断。已绑定项的进度从它的 journal 读出，表里从不存状态。

## 4. 静态检查

`gemflow check <workflow.geml>` 先跑 `geml check`——那里有 error 就拒绝这份文档；声明了 `geml-statechart/v1` 时它包括状态机自己的检查 `statechart-body`、`statechart-initial`、`statechart-state`、`statechart-transition`、`statechart-guard`、`statechart-actions`、`statechart-vars`、`statechart-current` 与 `statechart-unreachable`，定义在 [geml-statechart §3](../../../spec/profiles/geml-statechart/geml-statechart-profile_CN.md)——再读流程的工具词典（项目的那份对照它的所有流程读），然后报 Gemflow 自己的：

| 码 | 级别 | 何时 |
|---|---|---|
| `flow-attr` | error | `prompt` 解析不到；`skills`、`tools` 不是字符串数组；`approval` 不是 `true`；`source` 不是 §2.2 表里的写法；有 `source` 的变量默认值不是 `false`；`note` 不是字符串 |
| `flow-source` | warning | 变量 `source.tool` 的用途没有任何状态声明，这个变量永远立不起来；词典里 `for` 的用途没有任何状态声明 |
| `flow-dup-edge` | error | 同一对状态之间有两条转换（journal 按 `from→to` 记转换） |
| `flow-auto-ambiguous` | error | 一个状态有多于一条机器判的、不要批准的出边 |
| `flow-auto-cycle` | warning | 自动走的边首尾相接成环：通行要求若同时满足，流程会原地打转，运行时在第一个会二次进入的状态前停下 |
| `flow-unit` | error | `flow-unit` 不是 `branch`，也不是 `file:` 加一个非空 glob；或者 `flow-state-key` 写在按分支的流程里、不是一个键名 |
| `flow-tools` | error | 工具词典（§2.3）表头不对；`allow`、`deny` 里有流程没有的状态；`params` 不是 JSON 对象；同一用途有两个 `default` |

诊断里转换写作 `from→to`。每条检查都钉在本文旁边的 [`checks.json`](checks.json)，由运行时的测试逐例重放：每个用例是一份文档，以及载入器必须报出的 `severity:code` 列表。

`gemflow verify` 校验一本 journal：链、`cause` 与 `from`/`restores` 一致、每次记录的转换都是状态机里的一条转换、`by=signal` 时 `signal` 是有 `source` 的变量、`pause` 与 `resume` 是 `by=human`、状态与变量不变、暂停的是没暂停的工作项而继续的是暂停中的。

通行要求所用的 JSON Schema 子集是 geml-statechart §4，钉住它的用例也在那份词汇表里。只有运行时读状态机上 Gemflow 的键、通行要求块与工具词典，只有 `gemflow verify` 验链。
