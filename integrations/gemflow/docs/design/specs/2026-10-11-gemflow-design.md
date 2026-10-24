# Gemflow — 设计文档

日期：2026-10-11，修订 2026-10-12 · 状态：**草稿，待审** · 分支：`feat/geml-agent-runtime`
前置阅读：`docs/design/specs/2026-09-14-geml-agent-runtime-design.md`、`spec/profiles/geml-agent/geml-agent-profile.md`、`integrations/geml-agent-runtime/README.md`，以及讲解页《看门人与火车》（Ramadge–Wonham 监督控制）。
本文覆盖子项目 ①（核心引擎）、②（开发流程 + Claude Code 外壳）与 ④（视频流程）；③⑤ 在 §10 占位，各自另写规格。

---

## 0. 一句话

Gemflow 是一个给别人装的 Claude Code 插件：用户选一个流程（开发、视频，或从市场装的、自己写的），它按流程的阶段替用户管三样东西——**当前该看什么上下文、流程走到哪一步、每一步留下了什么**——并在输入框上方常驻一行状态、在面板里画出流程看板。流程是一份普通的 GEML 文档：一个 `geml-statechart` 图块写节点、转换、通行要求与条件变量，提示词是它引用的章节，词汇表（`geml-flow/v1`）只多定义一个 meta 键和挂在节点、变量、转换上的几个属性。流程里写的是用途（`test`、`deploy-prod`），不是命令；每个用途在你的项目里是哪个工具、同类工具首选哪个、参数默认取什么，在使用中由你的选择记进工具词典；流程作者只在真正要紧的岔口封路（只在某些阶段能用的用途、要人批准的转换）。

## 1. 出发点

### 1.1 为什么是这个形态

effortless 的成功模式是：装上就自动工作，眼前天天有一个证明它有用的东西。Gemflow 照这个路子，但管的是**流程**而不是 effort：开发者用 Claude 做一个功能，从写代码、测试、PR、CI 到部署，每一步发生了什么、下一步是什么、这一步该带哪些上下文，插件都替他记着、摆在眼前。

### 1.2 为什么建在 geml-agent runtime 上

| Gemflow 需要的 | runtime 已有的 |
|---|---|
| 流程定义 | GEML 状态图：状态、转换、变量 |
| 阶段完成的通行要求 | 转换上的 `guard`（对条件变量的 JSON Schema，机器判） |
| 按阶段给模型的指令 | 状态的 `description` 与 `prompt` 指向的章节成为模型在该状态收到的指令 |
| 关键步骤要人点头 | `approval`（第 4 道门） |
| 不可伪造的记录 | 哈希链快照，本身是可寻址、可验证的 GEML 文档 |
| 项目内的存储 | 每个项目一个 `.geml/` 目录 |

`geml-agent/v1` 从未发布，本设计直接修改它（§4），不升版本、不留兼容写法。

### 1.3 拆分

| 序号 | 子项目 | 依赖 | 本文 |
|---|---|---|---|
| ① | 核心引擎：改名、变量的来源、按工作项的 journal、Stagehand、backlog | — | §4–§6 |
| ② | 开发流程 + Claude Code 外壳（状态带、看板、命令、MCP 工具） | ① | §7.1、§8 |
| ③ | 流程市场：目录、预览、安装、+ 菜单 | ① | §10 占位，搁置 |
| ④ | 视频流程（基于 geml-media），检验格式的通用性 | ① | §7.2 |
| ⑤ | 按块读改写 + 节省计数、改动影响面、Obsidian 投影 | ① | §10 占位 |

② 完成即第一个可用版本；④ 与 ② 同期交付，两个内置流程一起发布。

## 2. 目标与边界

**目标**
- 一份流程文档在 Claude Code、Codex、Grok、Gemini CLI、DeepSeek Harness 上语义相同；v1 只有 Claude Code 有界面，只接 MCP 的宿主通过 MCP + skill 推进与记录（它们看不到的部分见 §8.5）。
- 两个内置流程与用户流程用同一种格式，引擎里没有内置流程的特殊通道。
- 判断"阶段做完了"靠观测到的事实（退出码、文件、git/CI、人的勾选），不靠模型自报。
- 默认不挡路：流程作者只在要紧的岔口封路；工具的权限与偏好由你在使用中决定（§5.3）。
- 词汇最少：状态机用通用的 `geml-statechart` 格式写，Gemflow 只在它的节点、变量、转换上挂几个属性；词汇表只定义一个 meta 键和这几个属性，不另造词。

**不做（v1）**
- 以分支为单位的流程（开发流程）里，直接提交到 `main` 的工作不记 journal。
- 用户在自己终端里跑的命令不写 `tool` 证据；git、文件来源会在会话开始时补齐它们的结果。
- 信号只产生布尔值。
- Codex、Gemini CLI、Grok 的界面（它们的插件接口画不了或要用户手配，见 §10）。
- 插件不替用户切换分支。

## 3. 总体架构

```
              ┌──────────────── 宿主外壳 ────────────────┐
              │ Claude Code：hooks 模块（状态带 + 看板 + 命令）│
              │ DeepSeek Harness / pi agent：现有适配器      │
              │ Codex：MCP + skill + hooks（§8.9）          │
              │ Grok / Gemini：MCP + skill                  │
              └──────────────────┬───────────────────────┘
                                 │ 工具调用事件进，状态与上下文出
┌──────────────────── 核心（宿主无关，纯函数 + Supervisor）────────────────────┐
│ statechart  载入、静态检查                                                  │
│ supervisor  通行要求、批准、用途封路、人专属命令；按工具词典放行、拒绝或问人          │
│ signals     变量的来源求值：tool / file / git / human；tool 证据随内容过期        │
│ stagehand   进入状态时取它的说明、展开 prompt、加上 skill、用途与出路，写成上下文   │
│ journal     每个工作项一本（单位由流程声明），哈希链；每次调用归到它作用的工作项          │
│ backlog     待办项表，认领时绑定分支                                            │
└────────────────────────────────────────────────────────────────────────┘
```

**数据布局**（项目内）

```
.geml/
  workflows/<name>/flow.geml   流程定义；同目录放它自带的上下文文档与工具词典 tools.geml；提交进仓库
  journals/<工作项>.geml        每个工作项一本：分支名或剧集文件的相对路径，其中的 / 直接成为子目录；默认 gitignore。
                               branch 单位的 journal 放在仓库主工作树的这个目录里，所有检出共用（§5.7）
  backlog.geml                 待办项表，提交进仓库
  gemflow.geml                 项目配置：一个 data 块 #gemflow，default 指定新工作项用的流程；提交进仓库
  context.geml                 当前阶段的说明（text 块 #current）、阶段信息（data 块 #stage）与当前变量值（data 块 #vars），Stagehand 重新生成；按检出各一份；默认 gitignore
  codemap/                     代码地图（已有）
```

**包与目录**：`integrations/geml-agent-runtime/` 改名为 `integrations/gemflow/`，npm 包 `@geml/gemflow`，CLI `gemflow`。同一个包带全部宿主入口：Claude Code 插件清单与 hooks 模块（新增）、DeepSeek Harness 的 `cordis.patch.yml`、pi agent 扩展。插件根目录就是 `integrations/gemflow/`，发布在仓库根的 geml marketplace，条目以 npm 包 `@geml/gemflow` 为来源，安装一行：`/plugin install gemflow --marketplace geml-spec/geml`（包发布到 npm 之后可用；开发时 `npm run build` 后 `claude --plugin-dir integrations/gemflow`）。hooks 模块要用的 Node 一侧打成单文件 `dist/gemflow.mjs`（`@geml/geml` 内联），装上不需要再装依赖；它需要 Node ≥ 22。其他宿主用同一个包里的 `gemflow mcp`（§8.5）。profile 目录改为 `spec/profiles/geml-flow/`。

## 4. 流程文档

一份流程是一份普通的 GEML 文档：meta 里声明 `geml-flow/v1`，一个 `geml-statechart` 图块写状态机（格式见 `spec/profiles/geml-statechart/`），加上它引用的提示词文档和通行要求块。状态机的骨架——节点、转换、通行要求、动作、条件变量——是通用格式的；Gemflow 在节点、变量、转换上挂几个自己的属性，把状态机接到 agent 上：状态给模型什么（`prompt`、`skills`、`tools`），变量的值从哪来（`source`），转换要不要人点头（`approval`）。工具的权限与偏好不写在流程里，记在同目录的工具词典 `tools.geml` 里，在使用中由你的选择长出来（§5.3）。词汇表自己只定义一个 meta 键 `flow-unit`（默认 `branch`，按分支的流程不用写）和这几个属性。

### 4.1 一份完整的流程文档（开发流程）

```geml
=== meta
title   = "开发流程"
profile = "geml-flow/v1"
===

=== diagram {#flow format=geml-statechart caption="开发流程"}
{
  "initial": "build",

  "states": {
    "build": {
      "title": "构建",
      "description": "写代码和测试，直到测试通过、PR 开出来。",
      "prompt": "./guide.geml#build",
      "skills": ["test-driven-development"],
      "tools": ["edit", "test", "pr"]
    },
    "review": {
      "title": "评审",
      "description": "处理 review 意见，等 CI 绿、PR 合并。",
      "prompt": "./guide.geml#review",
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
    "done": { "title": "完成" }
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

链条是 **状态 → 工具 → 变量 → 转换 → 状态**：`build` 声明了用途 `test`，词典把它绑到本项目的 `npm test`；那条命令以 0 退出，`tests-pass` 变成 true；`build→review` 的通行要求读它，成立就自动走；进入 `review`，模型换一套提示词和用途。流程里只写用途不写命令，所以同一份流程搬到 Rust 项目，词典里 `test` 绑的是 `cargo test`，流程一字不改。

`build` 不会卡住：PR 在 Gemflow 看到它开着之前就合并了，或者测试只在 CI 里跑、本地从不出现测试证据，通行要求的另外两个分支（PR 已合并、人勾选 ready）都能放行。`./guide.geml` 是流程目录里给模型的提示词文档，`prompt` 指向它的章节，进入状态时由 Stagehand 展开（§5.4）。工具词典（`tools.geml`）在 §5.3。

### 4.2 构件

| 构件 | 写法 | 含义 |
|---|---|---|
| 状态机 | `diagram {format=geml-statechart}`，正文 JSON | 节点、转换、变量；格式的规则——保留键、通行要求的三种写法、`reset`、画法、`data=`——在它自己的词汇表里 |
| 状态 | `states` 里的一项 | `title`、`description` 给人看也给模型看；`final: true` 是格式的终态标记，一张图可以有几个（§5.1）。Gemflow 的属性：`prompt`，提示词：一个章节（本文档的 `#id`，或 `doc.geml#id`）或整份文档（`./guide.geml`，Markdown 也行）；`./` 开头的路径相对流程目录，其余相对项目根；`skills`，skill 名的列表，交给宿主；`tools`，用途的列表 |
| 条件变量 | `vars` 里的一项 | `default` 定类型。Gemflow 的属性：`source`（值从哪来，见下）、`note` |
| 转换 | `transitions` 里的一项 | `guard`、`actions` 里的 `reset`。Gemflow 的属性：`approval: true`（要人此刻点头）、`note`（给模型的说明） |
| 通行要求块 | `format=json` 的 `data` 块，`guard` 用 `#id` 引用 | 长的、几条转换共用的通行要求 |
| 提示词 | 普通的章节或文档，`prompt` 引用 | 进入状态时展开进上下文 |
| 工作项单位 | meta `flow-unit` | `branch`（默认，每个分支一个工作项）或 `file:<glob>`（每个匹配的文件一个，如 `file:episodes/*.geml`） |

**`source`：条件变量的值从哪来。**

| 写法 | 何时写 | 值 |
|---|---|---|
| 没有 `source` | 模型调用 `set` | 模型写的值，类型须与默认值相同 |
| `{ "tool": "<用途>" }` | 绑定到这个用途的一次工具调用结束时（§5.2） | 成功 true，失败 false |
| `{ "file": "<glob>" }` | 写文件或运行命令的调用结束时、会话开始时、看板刷新时 | 有文件匹配时 true |
| `"committed"` `"pr-open"` `"pr-merged"` `"ci-success"` | 会话开始时、运行了 `git`/`gh` 的调用结束时、看板刷新时 | git 与 CI 的事实（§5.2） |
| `"human"` | 人在看板上勾选，或 `gemflow mark` | 勾上 true，取消 false |
| `{ "elapsed": "<ISO 8601 时长>" }` | 打开工作项时，和每次写操作开始时（§5.2） | 当前状态已停留至少这么久时 true；进入状态时回到 false |

有 `source` 的条件变量是证据，模型写不了，默认值必须是 `false`；没有 `source` 的是模型自己的记事本。

**三种通行要求，三种判断者。**

| 通行要求 | 谁判 | 怎么走 |
|---|---|---|
| 对象，或引用通行要求块 | 机器 | 一次改动之后成立就自动走；一个状态至多一条这样的出边 |
| 一句话 | 模型 | 原文随阶段说明交给模型；模型认为成立时 `move` |
| `approval: true` | 人 | 看板上点，或 `gemflow advance`；写了通行要求则它也须满足；从不自动走 |

没有通行要求、不要批准的转换，模型 `move` 或人走。

**用途。** 状态的 `tools` 列出这个阶段要用的用途——`edit`、`test`、`pr`、`deploy-prod`、`image`——自己起的词。工具词典把用途绑到本项目的具体工具（§5.3）。一个用途只能在声明了它的状态里用：这是流程作者封路的办法，production 部署只在 `release` 里跑得了。没有绑到任何用途的工具，按词典里学到的决定（§5.3）。

### 4.3 静态检查

格式层的检查（`statechart-*`：正文的结构、`initial`、`from`/`to`、通行要求读的条件变量、`reset` 的名字、走不到的状态、标了终态却有出边、没标终态却没有出边）由 geml-statechart 词汇表定义，`geml check` 与 `gemflow check` 都报。Gemflow 自己的：

| id | 级别 | 何时 |
|---|---|---|
| `flow-attr` | error | `prompt` 解析不到；`skills`、`tools` 不是字符串数组；`approval` 不是 `true`；`source` 不是上表的写法；有 `source` 的变量默认值不是 `false`；`note` 不是字符串 |
| `flow-source` | warning | 变量 `source.tool` 的用途没有任何状态声明，这个变量永远立不起来；词典里 `for` 的用途没有任何状态声明 |
| `flow-dup-edge` | error | 同一对状态之间有两条转换（journal 按 `from→to` 记转换） |
| `flow-auto-ambiguous` | error | 一个状态有多于一条机器判的、不要批准的出边 |
| `flow-auto-cycle` | warning | 自动走的边首尾相接成环：通行要求若同时满足，流程会原地打转，运行时在第一个会二次进入的状态前停下 |
| `flow-unit` | error | `flow-unit` 不是 `branch`，也不是 `file:` 加一个非空 glob |
| `flow-tools` | error | 工具词典（§5.3）表头不对；`allow`、`deny` 里有流程没有的状态；`params` 不是 JSON 对象；同一用途有两个 `default` |

诊断里转换写作 `from→to`。每条检查都钉在 `spec/profiles/geml-flow/checks.json`，由运行时的测试逐例重放。

## 5. 运行时

### 5.1 推进

| 谁 | 怎么发生 | `by` |
|---|---|---|
| 模型 | `move` 走一条出边：一句话的通行要求的边，或没有通行要求的边；机器判的边不由它走（通行要求满足时自己走），要批准的边也不行 | `model` |
| 人 | 在看板上点一条边，或在自己终端运行 `gemflow advance <state>`；这本身就是批准 | `human` |
| 自动 | 一次改动之后，当前状态那条机器判的、不要批准的出边的通行要求满足了，立即走 | 记那次改动的来源：信号写入后 `signal`（带 `signal=<变量>`），模型动作后 `model`，人推进后 `human` |

一次写入了几个信号时，自动走的边记在它的通行要求所读的条件变量对应的那个信号名下（通行要求的 `properties` 或 `required` 里出现的第一个），没有则记最后写入的信号。

一次改动之后连着自动走，走到某个本次已经进入过的状态（出发时所在的状态也算），就停在它前面；自动走的自环因此永远不会被走。

一次转换（模型的 `move`、人的推进）之后的第一条自动边，不会把流程直接带回这次转换刚离开的状态：人把流程从评审退回构建（dev 流程的 `review→build`）时，「构建 → 评审」的通行要求即使仍满足，流程也停在构建，不会被立刻弹回去。只有刚离开的那个状态被挡，也只在这一次改动里挡：之后的下一次改动（例如测试重新跑绿）照常走这条边，一条链隔一步再回到那个状态也照常走。回滚不算这样的转换，它恢复出的状态上成立的自动边照常走。

通行要求对三种来源一视同仁。

**终态。**进了标 `final` 的状态，工作项就关闭：没有出边，模型、人、自动都走不了；`tool` 证据不再过期；状态带显示 ✓ 加该状态的 `title`。闸照旧按这个状态声明的用途判——一集发布之后不该再动剧本，一条分支完成之后再改是新的改动；出路是换工作项（新分支、下一集），或者人 `rollback` 回到之前的修订。模型到不了终态，除非作者给了一条模型判的转换进去。`initial` 保持单个 id：起点看情况（PR 已合并的分支一进来就该在评审）用一条机器判的出边表达，进入时事实一读到就自动走，journal 还留下凭什么走的记录；几个起点同时启动是 v2 正交区域的事，到时每个区域各有自己的 `initial`。

### 5.2 条件变量与信号

| `source` | 何时读 | 值 |
|---|---|---|
| 没有 | 模型调用 `set` | 模型写的值，类型须与默认值相同 |
| `{ "tool": "<用途>" }` | 绑定到这个用途的一次工具调用结束时（怎么对上用途见下） | 成功 true，失败 false：命令看退出码，其他工具看 `isError` |
| `{ "file": "<glob>" }` | 写文件或运行命令的调用结束时（构建、渲染产生文件，和编辑一样确定；指明的路径在项目之外或在 `.geml`、`.git`、`node_modules` 里时不算）、会话开始时、看板刷新时 | 有文件匹配时 true |
| `"committed"` `"pr-open"` `"pr-merged"` `"ci-success"` | 会话开始时、命令行在任一命令位置运行了 `git` 或 `gh`（任意路径；经启动器运行的如 `sudo git switch main`、`timeout 30 git pull`，交给 shell 的字符串里的如 `bash -c "git checkout -b x"` 也算；只当别的命令的参数写出来不算）的调用结束时、看板刷新时 | 按当前分支查询；`ci-success` 取分支 head 上每个 CI workflow 最近一次运行的结论 |
| `"human"` | 只来自人：看板上的勾选框，或用户在自己终端运行 `gemflow mark <变量>`（`gemflow unmark <变量>` 取消） | 勾上 true，取消 false |
| `{ "elapsed": "<ISO 8601 时长>" }` | 时钟：每次打开工作项时和每次写操作开始时，和 `tool` 证据的过期一起，持锁 | 从进入当前状态的修订到现在已满这个时长时 true；进入状态与回滚都把它还原成 false，重新计时 |

- **`tool` 证据会过期**：`source` 是 `tool` 的变量写下非默认值时，那条修订记下工作项内容的指纹（`tree`）。之后每次对该工作项的操作开始时（持锁），指纹若已变，就在一条修订里把这些变量还原成默认值（`cause=expire`，`signal=` 记第一个），随后照常评估自动边。指纹：`branch` 单位是检出里工作内容的 git tree（git 不忽略的每个已跟踪、未跟踪文件在磁盘上的样子，从 index 的副本 `git add -A` 后 `git write-tree` 写出，真实的 index 不动，只给变了的文件算哈希；`.geml` 与 `node_modules` 不算）；`file:` 单位是那一集文件内容的哈希。所以测试通过之后改了代码、rebase、pull 都要重跑，只是提交了不用。`file` 与 git 的事实本来就按当下重读；`human` 是人的判断，不过期。
- **退出码怎么判定**（Claude Code，已实测）：调用以错误结束时 `isError` 为 true，`text` 以 `Exit code <n>` 开头，取这个 `n`；未以错误结束且结果里没有 `returnCodeInterpretation` 时退出码为 0。Claude Code 把少数非零码当作正常结束（`grep` 无匹配是 `No matches found`，`diff` 有差异是 `Files differ`），这类结果按非零处理，所以 `tool` 证据不会把"测试命令里 grep 没找到"误判成通过。
- **调用怎么对上用途**：运行命令的工具，命令行拆成简单命令（跳过开头的 `NAME=value` 赋值；空白只指空格和制表符），每条简单命令去掉引号与转义、把每段空白并成一个空格后，与词典里 `Bash(…)` 的键匹配：键是一个模式，`*` 匹配任意一段文字，没有 `*` 的键匹配前缀；字面部分最长的键优先（`Bash(wrangler deploy --env staging)` 赢过 `Bash(wrangler deploy)`）。其他工具按工具名匹配（可带 `*`）。匹配到的键绑着用途（`for`），这条调用就属于那个用途。只有当命令行整个就是用 `&&` 连接的简单命令时退出码才算数，其他命令行不写 `tool` 证据，因为它的退出码说明不了匹配到的那条命令。命令行在引号之外含下面任何一种，就不是单纯的 `&&` 链：`;`、`||`、管道、后台 `&`（`&>` 也算；`2>&1`、`>&log` 这类重定向里的 `&` 不算）、换行、`$(`、`${`、`$[`、反引号、`(`、出现在词首的 `#`（注释）；引号没有闭合或有空命令（`a &&`）同样不行。引号规则同 shell：单引号里什么都不是运算符，`$'…'` 里只有反斜杠转义有效，双引号把运算符挡在拆分之外（shell 仍会执行双引号里的 `$(…)` 与反引号，`${` 也挡不住），引号之外的反斜杠转义下一个字符（反斜杠加换行是续行）。某个简单命令的命令字（跳过赋值、重定向和前缀 `builtin`、`command`、`time`、`!`、`noglob`、`nocorrect`）是 shell 关键字（`[[`、`]]`、`{`、`}`、`function`、`if`、`while`、`for`、`case` 等）、会结束 shell 或改变后续命令含义的内建命令（`exit`、`exec`、`trap`、`return`、`logout`、`hash`、`alias`、`unalias`、`enable`、`eval`、`source`、`.`），或由展开拼出来的词（含 `$`）时，这行也不写 `tool` 证据：它们都能让整行以 0 退出而匹配到的命令并不为此负责。**用途封路**则在整条命令行的任意位置查找，并在去掉引号和反斜杠、把每段空白并成一个空格的副本里再查一遍，所以复合命令行里或包装器（`npx …`、`bash -c "…"`）里的部署照样被拒绝，`wran"gler"  deploy` 也一样。
- **局限**：`tool` 证据的意思是「绑到这个用途的一条命令以 0 退出」，不是「测试套件通过了」：参数、环境和被改过的脚本都会改变命令实际运行的内容，所以词典里的键要写够长（`Bash(npm test)`，不是 `Bash(npm)`）。用途封路只看得见命令行的文字，并且区分大小写：变量、`eval`、编码后的字符串、模型自己写的脚本都能绕过它，所以脚本名也要一并守住；要真正拦住一条命令，得让 agent 手里没有执行它所需的凭据。
- 后台运行的命令（结果里有 `backgroundTaskId`）在 `tool.call` 结束时还没有退出码，不写 `tool` 证据。
- 子 agent 的工具调用同样经过主会话的 `tool.call`（已实测），由子 agent 跑的测试照样记入信号——记进它所在检出的工作项（§5.7）。
- `committed` 只问 git（当前分支有默认分支没有的提交）；`pr-open`、`pr-merged`、`ci-success` 问 `gh`，`vars` 里有这三种来源时才问。没有 `gh`、未登录或没有可问的 GitHub remote 时，这三种信号不写入、保持原值，标为"不可用"，状态带显示原因。Claude Code 的 `Bash` 结果自带 `gitOperation`（commit、push、合并、PR 创建与合并），由它触发的 `git` 信号不必再查一次 `gh`。
- 人在终端推进用 `gemflow advance <state>`；模型通过 `run` 调用 `gemflow mark|unmark|advance|pause|resume`（命令位置上的一次调用，经 `npx`、`npm exec`、`pnpm dlx` 等启动器也算）一律被拒绝并记一条 `refused`：人勾选的变量与人推进的转换不能由模型触发。判定看命令位置：命令行按 `;`、`&`、`|`、换行、括号与反引号拆开（双引号里的 `$(…)` 也拆），每条命令取命令字——跳过赋值、重定向和 `builtin`、`command`、`time`、`env`、`sudo` 这类接着执行下一个词的前缀，引号与转义去掉之后。命令字是 `gemflow`（取路径末段，不分大小写，`./node_modules/.bin/gemflow` 也算），或是 `npx`、`bunx`、`npm exec`、`pnpm dlx`、`pnpm exec`、`yarn dlx`、`node` 之类的启动器而参数里有 `@geml/gemflow`（可带 `@版本`）或它的 `cli` 脚本，并且其后第一个非选项参数是 `mark`、`unmark`、`advance`、`pause` 或 `resume`（不分大小写，或由展开拼成）时拒绝；`bash -c "…"`、`pwsh -c "…"`、`eval` 的参数，以及启动器交给 shell 的字符串（`sudo sh -c "…"`、`timeout 5 bash -c "…"`、`npx -c "…"`、`npm exec --call=…`、`env -S "…"`）照此再查一遍；PowerShell 的字符串按同样的规则读，另外再按词查找一遍，作为兜底。命令字由展开拼成（含 `$`）或命令行引号不闭合时退而求其次：去掉引号后的命令行里同时有 `gemflow` 和这五个词之一就拒绝。只是提到（`echo gemflow mark`、提交信息里写到 `gemflow` 与 `advance`）不拒绝。

### 5.3 工具：词典、询问与偏好

每个状态能用哪些工具、同类工具里首选哪个、参数默认取什么，都不写进流程，记在流程目录下的工具词典 `tools.geml` 里（`#tools` 表，提交进仓库），在使用中由你的选择长出来：

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

- `tool`：工具名，可带 `*` 通配（`mcp__geml__*`）。运行命令的工具按命令记：`Bash(npm test)` 匹配以它开头的命令，`*` 匹配任意一段（`Bash(geml media todo * --check)`），字面部分最长的键优先（§5.2）；单写 `Bash` 表示所有命令。
- `for`：用途——流程在状态的 `tools` 里声明的词（`edit`、`test`、`image`……）；同一用途的工具互为替代。绑了用途的工具只在声明了这个用途的状态里能用（§4.2）。
- `allow`、`deny`：状态名的列表，`*` 表示所有状态。
- `default`：`yes` 表示同一用途里的首选，每个用途至多一个；一个用途登记的第一个工具自动成为首选。
- `params`：一个 JSON 对象：调用这个工具时，模型没给的参数用它补上。

**一次调用怎么判**（在调用所属工作项的当前状态 S 里，§5.7）：

1. 先判任何状态都生效的规则：人专属命令拒绝（§5.2）；只切换工作项的命令行放行（§5.7）；Gemflow 自己的三个工具（§8.5）放行。
2. 取这次调用的键：工具名；运行命令的工具再按命令行里每条简单命令取 `Bash(…)` 的键，字面部分最长的优先（§5.2）。
3. 每个键各判一次：绑着用途（`for`）的键，S 声明了这个用途就放行，S 没声明就拒绝（理由写明"`deploy-prod` 只在 #release 里用"）；没绑用途的键，在 S 或 `*` 上被拒过就拒绝（理由写明"你在 #S 拒绝过它"），允许过就放行，没见过就待定。
4. 有一个键被拒绝：整次调用拒绝，理由列出每个被拒的键，记一条 `refused`。
5. 每个键都放行：放行，宿主自己的权限规则照常生效；调用结束时，绑着用途的键按变量的 `source` 写证据。
6. 否则（有待定的键）问你：本阶段允许 / 所有阶段允许 / 只这一次 / 拒绝，S 声明的每个用途再各一项"这是 <用途>"。前两项写进 `allow`（S 或 `*`），拒绝写进 `deny`，"这是 <用途>"写进 `for`（之后按第 3 步判），只这一次不记。
7. 没有人可问（`-p`、SDK）：没见过的键一律拒绝，什么都不记。

**偏好**：

- 阶段说明列出本阶段的工具：每个用途的首选和它的默认参数，以及本阶段拒绝的工具（§5.4）。模型一般照着用。
- 调用带 `params` 的工具时，模型没给的参数由 Gemflow 补上（改写这次调用的输入），模型给了的不覆盖。只对输入是结构化数据的工具做（MCP 工具、内置工具），命令行不改写。
- 模型用了一个有用途却不是首选的工具时问你：这次允许 / 以后默认用它 / 拒绝（让模型改用首选）。选择写回词典。与第 6 步同时发生时合成一个问题。
- 用途在看板上绑定或解绑，或在问你时选"这是 <用途>"；默认参数在看板上编辑，或在一次调用上"设为默认"，把那次的参数存下来。

**起步词典**：`gemflow init`、`/gemflow add` 复制内置流程时带上它的起步词典：`*` 行预先允许宿主的只读工具（`Read`、`Grep`、`Glob`）；流程声明的用途预先绑好常见的工具——开发流程的 `test` 绑 `npm test`、`pnpm test`、`yarn test`、`cargo test`、`pytest`、`go test`，`pr` 绑 `gh pr create`，`deploy-staging`、`deploy-prod` 绑 `wrangler deploy` 的几种写法（`npx`、`pnpm`、`bunx` 前缀各一行；不带 `--env` 的按 production 算）；要严格的流程预先写好拒绝（coding 流程在 `#explore` 拒绝 `Edit`、`Write`）；其余在使用中问。

**为什么由插件自己问**：实测（§12），桌面会话里插件挂在 `classic.PreToolUse` 上的钩子不被调用，借不到宿主的权限框；auto 权限模式下宿主自己的权限提示由分类模型代答，人看不到，学到的就不是你的选择。插件的问题框（`$.ui.ask`）总问到人，返回所选选项的原文，还能给出偏好需要的几个选项。宿主的权限机制照常独立工作；宿主本来也要问的工具，第一次用时会被问两次。

### 5.4 Stagehand

Stagehand 分两层：核心只写文件，宿主负责把文件交给模型。

- **核心**：进入一个状态时（任一来源），取这个状态的 `description`，展开 `prompt` 指向的章节或整份文档（`./` 开头的路径相对流程目录，其余相对项目根；其中的 `embed` 在进程内展开），后面加上要用的 skill、本阶段的用途与各自绑定的工具（首选与默认参数，§5.3）、条件变量的当前值，和接下来能去的状态（每条出边：机器判的列出还缺的变量，一句话的给原文，要批准的标出，以及 `note`）。整段按字节计不超过 16 KB：`description`、skill、工具、变量与出边总在内，`prompt` 的内容分剩下的字节，放不下的只列出地址，模型需要时自己去取。
- 结果写进 `.geml/context.geml`：`=== text {#current}` 是这段说明；`=== data {#stage}` 是 `{"item", "state", "rev", "at"}`，`rev` 是进入这个阶段的修订；`=== data {#vars}` 是当前的变量值，同一阶段里的修订只重写它。`#vars` 是只读视图：`geml get .geml/context.geml '#vars["tests-pass"]'` 读一个值，写入只经动词，因为 journal 只追加、带哈希链，写入要过类型与"信号变量模型写不了"的规则。上下文文档按检出各一份，默认 gitignore。
- **宿主**：Claude Code 用 hooks 模块把 `#current` 交给模型（§8.4），换了工作项时当场交接（§5.7）；没有注入通道的宿主由 skill 要求模型每轮先读 `.geml/context.geml`，`status` 也返回同一段。

### 5.5 journal

- 每个工作项一本 journal，单位由流程的 `flow-unit` 决定：
  - `branch`：路径 `.geml/journals/<分支名>.geml`，放在**仓库主工作树**（`git rev-parse --git-common-dir` 的上一级）里，所有检出共用：同一个分支在哪个检出里做都是同一本，worktree 删掉了记录也还在；这个目录自带一个内容为 `*` 的 `.gitignore`。当前在 `main`（或仓库默认分支）上时引擎不工作，状态带显示"main · 不记录"。
  - `file:<glob>`：路径 `.geml/journals/<文件相对路径去掉扩展名>.geml`，按检出各一份；当前工作项是最近一次被写入的匹配文件，用户也可以在看板上切换；不依赖 git。
  - 不在 git 里的项目：项目根的 `.geml/journals/`。
- journal 是一份普通的 GEML 文档，每条记录是一个追加写的 `data` 块：

```geml
=== data {#journal}
{ "item": "feat/rate-limit", "workflow": ".geml/workflows/dev/flow.geml", "workflow-hash": "sha256:…", "created": "2026-10-12T09:00:00Z" }
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

- 修订的字段：`cause` 是做了什么（`enter`、`transition`、`patch`、`rollback`、`expire`、`pause`、`resume`），`by` 是谁（`model`、`human`、`signal`），`signal` 是触发的信号变量，`from` 是转换前的状态，`restores` 是回滚恢复的修订，`call` 是触发它的工具调用，`tree` 是命令证据的内容指纹；`hash` 是这一块去掉 `hash` 之后规范 JSON 的 sha256，`parent` 是上一条修订的 `hash`。拒绝（`#refused-N`）记下它发生在哪个修订之后。坐标能读到任何一个值：`geml get .geml/journals/feat/a.geml '#rev-3["vars"]["tests-pass"]'`。
- 第一次在某个工作项上有 Gemflow 事件时创建，`rev=0` 的修订 `cause=enter`；归到别的检出的观察只在真要记录时才建那本 journal。
- 工作项记住自己的流程：`#journal` 的 `workflow` 记着它开始时的流程文件，之后一直按它推进；新工作项用项目的默认流程（`.geml/gemflow.geml` 里 `=== data {#gemflow}` 的 `default`）。那个流程文件不存在时报错，出路是恢复它，或把 journal 挪开从默认流程重新开始。
- 同一工作项的多次会话、多个会话追加到同一本，哈希链连续；写入持文件锁（`<journal>.lock`），拿不到锁时等待后重试，超时则这次写入失败并在状态带报错，不静默丢弃。
- 人用 `gemflow rollback <修订|checkpoint>` 回滚：恢复那个修订的状态与变量（`checkpoint` 是进入当前阶段的修订），不撤销已经发生的副作用。
- 人用 `gemflow pause` 暂停工作项（看板与状态带上也能点）：记一条 `cause=pause`、`by=human`、状态与变量不变的修订；暂停期间证据照记（信号、过期、时钟都写进 journal），但任何转换都不走——模型的 `move` 被拒绝并记 `refused`，人的 `advance` 被拒绝，机器判的边等着；`gemflow resume` 记一条 `resume` 修订，并以人的身份走此刻已满足的机器判的边。`pause`、`resume` 与 `mark`、`unmark`、`advance` 一样是人专属命令，模型运行它们一律被拒绝。`#current` 不因暂停重写；模型从 `status` 的回答和被拒的 `move` 得知暂停。
- `gemflow verify` 校验一本 journal：链、`cause` 与 `from`/`restores` 一致、每次记录的转换都是状态机里的一条转换、`by=signal` 时 `signal` 是有来源的变量。

### 5.6 backlog

`.geml/backlog.geml` 是一张表：

```geml
=== table {#backlog}
| id          | title                  | branch           |
|-------------|------------------------|------------------|
| rate-limit  | 登录接口加限流          | feat/rate-limit  |
| dark-mode   | 设置页支持深色模式      |                  |
===
```

`branch` 列为空即待办；`flow-unit = "file:…"` 的流程用 `file` 列代替 `branch` 列。某个工作项第一次创建 journal 时，若有待办项，看板提示把其中一项绑定到它；也可以在看板上手动绑定。已绑定项的进度从对应 journal 读出，表里不重复存状态。

绑定只改那一行的 `branch`（或 `file`）单元格，文档里的其余字节——别的列和它们的对齐、别的行、正文、meta、别的块、换行符——原样保留。`id` 为空的行读表时报诊断，也不能被绑定；`id` 重复的行同样不能；已绑定到别处的行不能改绑。

### 5.7 工作项的边界：岔出去再回来

做 A 的途中常会插进一件无关的事：agent 顺手发现 B 文档没修订、C 有个 bug，用户要 rebase、开 PR。做完要回到 A 原来的状态，并且 A 的状态与变量不被那件事改动。Gemflow 以工作项为隔离单位，每个工作项一本 journal、一份变量；那件事落在另一个工作项上（另一个分支、另一个检出、另一集），就回得来、不串。本节的规则保证每次调用归到它真正作用的工作项上。

**调用从哪里开始、每条命令在哪里跑。** 宿主报告每次调用的起始目录（Claude Code：钩子里读 `$.session.cwd()`，按发起调用的循环作答，§12）。每条简单命令的目录是起始目录，加上 `&&` 链里它之前的 `cd`、`pushd`、`chdir`；目标写不定（含 `$`、`~`、反引号，`-`，缺省）时目录未知。写文件的工具（Edit、Write、NotebookEdit）按目标文件所在的目录。目录属于哪个检出，看它的 git 顶层。

**记录从准。** 信号只写进确定归属的工作项：

| 调用落在 | 记进 |
|---|---|
| 会话的检出（含其子目录） | 会话当前的工作项 |
| 另一个检出，它有流程、有活跃的工作项 | 那个检出的当前工作项（它的分支、它那份流程） |
| 别处，或目录未知 | 不写信号 |

**拦截从严。** 人专属命令（`gemflow mark|unmark|advance|pause|resume`）在哪里跑都拒；journal 与上下文文档的写入在哪里都拒。写文件的工具按目标文件所属工作项的闸。命令只有在整行每条命令都确定落在同一个、有活跃工作项的另一个检出里时，才用那个工作项的闸；其余情况（别处、目录未知、混合、对方工作项不活跃、流程载入失败）一律按会话当前工作项的闸——命令从哪里开始跑不等于它作用在哪里，`cd /tmp && rm -rf <项目>/src` 照样被拒。

**重读事实跟会话走。** git 事实重读、文件来源重读，在调用不确定属于另一个检出时作用于会话的工作项：重读的是真实事实，总是对的。文件信号的遍历不进入嵌套的检出（含 `.git` 的目录）。另一个检出用它自己的 `.geml/` 找流程，`GEMFLOW_STATECHART` 只指定会话的流程。

**动词。** 调用方循环的目录确定落在另一个检出（有活跃工作项）时，五个动词作用于那个检出的工作项——隔离 worktree 里的子 agent 推进的是它自己的分支；否则作用于会话的工作项。

**`file` 单位。** `tool` 证据与闸都跟随命令行写到的那一集（恰好写到本检出的一集）；写到不是本检出剧集的文件、通配或花括号时不记；一个文件都没写时归当前一集。

**换工作项当场交接。** 一次应答所在的工作项，与上次交给主循环的上下文（`item@rev` 记号）不是同一个时，新工作项的阶段说明随这次工具结果交给模型，前面加一行：

```
[gemflow] now on fix/doc-b · #build (new work item)
[gemflow] back on feat/a · #build · rev 3 · tests ✓ · pr ✗
```

子 agent 的调用拿到它自己工作项的说明，不记为已交给主循环。

**每个工作项记住自己的流程**（§5.5）。`gemflow use` 只改项目的默认流程，已开始的工作项不受影响；所以岔出去的那件事可以用另一种流程（比如一个文档流程），回来时 A 仍按它的流程。当前工作项按默认流程的单位解析。

**只切换工作项的命令行在任何状态都放行**：不拒、不问，在工具词典之前判（§5.3），监督器判断，快路径用同一个函数。`&&` 链里每条简单命令都是下列之一：`git switch <分支>`、`git switch -c|-C|--create|--force-create <分支> [<起点>]`；`git checkout -b|-B <分支> [<起点>]`，`git checkout <分支>`（`<分支>` 是已有的本地分支时）；`git worktree add [-b|-B <分支>] [--detach] <路径> [<起点>]`；`cd <路径>`。带其他选项（`-f`、`--force`、`--discard-changes`、`--merge`、`--`、路径参数）的不算。所以即使你在某个阶段拒绝过 `Bash(git)`，也总能离开去做别的事。`git switch` 会把未提交的改动带过去，这是 git 的行为。拒绝的理由里提示这个出口。

**引导。** 内置流程的 guide 与 `skills/gemflow-mcp/SKILL.md` 写明：和当前工作项无关的改动，另开分支或 worktree 做（子 agent 可用隔离 worktree），做完切回来。

**局限。** 目录按命令文字判断：变量、脚本，`npm --prefix`、`git -C` 这类参数里的目录都不跟踪；经符号链接的路径，快路径与 CLI 的判断可能不一致。

**不做。**
- 每次用户输入先判断"属于当前流程还是新流程"：插进来的事一半是 agent 途中发现的，用户输入时判断不到；判断本身不隔离，隔离靠活落在哪里；它是模型判断，违背凭事实推进；每次多一次模型调用，只接 MCP 的宿主也没有输入钩子。sidechat 是用户自己开的旁支，对应的是显式动作，不是自动分类。
- 显式的"岔出去 / 回来"动词：在会话的检出、会话的分支上顺手做的事，观察到的就是这个工作项自己的事实，记在它名下是对的；那种情况下的"污染"是 PR 混进无关改动，属于 git 与评审，靠引导解决。

**待讨论：两种单位的流程同时推进。** dev 走 feat/A 的同时 video 走 ep02：各流程按自己的单位解析当前工作项，观察按匹配到的信号表分发，状态带并列显示——状态图里的正交区域。"每个工作项记住自己的流程"是它的前提。

## 6. 对现有代码的改动

1. 把 `main` 合进本分支，解决冲突，现有测试全绿。
2. 机械改名（§4.2），一个独立提交。
3. `src/core/`：`signals.ts`、`stagehand.ts`、`backlog.ts`、`unit.ts`（按 `flow-unit` 定位当前工作项）；`journal.ts` 按工作项定位；`statechart.ts` 经解析器的 statechart 模块读图块、再做 §4.3 的检查；`supervisor.ts` 管通行要求、批准、用途封路、人专属命令、自动边与工具词典的判定；`tools.ts` 读写工具词典。
4. `src/hosts/dsh/`、`src/hosts/pi/`：接工具词典的判定；按 CLI 的方式找流程（`GEMFLOW_STATECHART`，否则 `.geml/gemflow.geml` 的 `default`，否则唯一的 `.geml/workflows/<name>/flow.geml`）；把调用的输入交给第 3 道门（用途封路与只许人做的命令）。它们仍按会话记 journal，不求值信号、不写 `.geml/context.geml`（§10）。
5. 新增 `src/hosts/claude-code/`（§8）与插件清单。
6. `spec/profiles/geml-flow/` 按 §4 改写（英文与中文两份），建立在新的 `spec/profiles/geml-statechart/` 之上；静态检查的用例进各自的 `checks.json`，解析器层的规则进各自的 `conformance.json`。
7. 内置流程随包发布在 `workflows/` 下，一个流程一个目录，各自带 `flow.geml` 和自己的上下文文档；`gemflow init --template <name>` 整目录复制到项目的 `.geml/workflows/<name>/` 并设为当前流程。现有 `coding`（编码会话的五个阶段）；开发流程 `workflows/dev/`（§4.1）与视频流程 `workflows/video/`（§7.2）随 ② ④ 加入。
8. `geml-parser`：`geml media todo` 加 `--check`，有待办时以非零退出（与 `geml check` 一致），供视频流程的 `tool` 证据使用；CHANGELOG 同一提交记一条。
9. 转换与流程图的实现：计划 `docs/design/plans/2026-10-12-gemflow-d-transition-table.md`（§4 改写前的形状；改写按第 12 条另写计划）。
10. 工作项的边界（§5.7）：计划 `docs/design/plans/2026-10-12-gemflow-e-side-quests.md`。
11. `geml-parser`：`geml-statechart/v1` 词汇表、`statechart-*` 检查、渲染器（`--to html`、viewer）与 `--to md` 的 Mermaid 投影；`geml-flow/v1` 放行该格式。
12. 状态机格式、用途与工具词典（§4、§5.3）：另写计划。

## 7. 内置流程

### 7.1 开发流程

`flow-unit = "branch"`。§4.1 即其全文结构：`build → review → deploy → release → done`，五个状态，只在顺序真正要紧处设状态（编辑和测试反复交替，不值得两个状态）。

| 封路点 | 机制 |
|---|---|
| 合并且 CI 通过前不能部署 | 用途 `deploy-staging` 只有 `deploy` 声明、`deploy-prod` 只有 `release` 声明；进 `deploy` 的通行要求是 `pr-merged` 且 `ci-pass` |
| production 要人点头 | 进 `release` 的转换 `approval: true`，通行要求是 staging 已部署 |

工具在使用中由你决定（§5.3）。测试证据随工作内容过期：测完又改了代码就要重跑。

### 7.2 视频流程

`flow-unit = "file:episodes/*.geml"`：每一集的 `.geml` 文件是一个工作项，不依赖 git。建立在 geml-media 上：剧本是 `media-text`，剪辑是 `media` 时间线（见 `spec/profiles/geml-media/`）。一集只占一个文件：本集的素材块与生成日志也写在里面，几集共用的角色卡、配音样本放在别的文档，用 `speaker=`、`of=` 引用。引用是有方向的，`geml media todo` 从本集出发，只看得见它够得着的生成记录。

```
script ─→ assets ─→ cut ─→ render ─→ review ─→ publish ─→ done
              ↑        ↑ ↑       │          │
              │        │ └───────┘ fix-cut  │
              │        └────── recut ───────┤
              └───────── reshoot ───────────┘
```

```json
"vars": {
  "script-final": { "default": false, "source": "human", "note": "剧本定稿" },
  "assets-done":  { "default": false, "source": { "tool": "todo-check" } },
  "no-stale":     { "default": false, "source": { "tool": "stale-check" } },
  "rendered":     { "default": false, "source": { "tool": "render" } },
  "approved":     { "default": false, "source": "human", "note": "审片通过" },
  "published":    { "default": false, "source": "human", "note": "已发布" }
}
```

用途：`assets` 声明 `image`、`video`、`voice`、`import`、`todo-check`；`cut` 声明 `lay`、`stale-check`；`render` 声明 `render`。

三个 `tool` 来源的用途在流程的起步词典里绑好：`todo-check` 绑 `geml media todo * --check`，`stale-check` 绑 `geml check * --severity media-stale-clip=error`，`render` 绑 `geml media build * --out *`；`geml` 前面的 `npx`、`bunx`、`pnpm dlx`、`yarn dlx`、`npm exec` 启动器各一行。`render` 只有 `render` 状态声明，所以出片命令在别处被拒绝，`bash -c "…"` 里的、去掉引号之后的照样被拒；它只看文字，`bun`、`tsx` 之类别的启动器、变量与脚本都能绕过它。信号与闸跟随命令行写到的那一集（§5.7），所以流程的 `guide.geml` 要求每条命令都写本集的文件并带 `--root .`。三个 `tool` 证据随这一集文件的内容过期：文件改了，待办检查、过期检查与出片都要重新过。

| 边 | 怎么走 |
|---|---|
| `script→assets` | 自动，剧本定稿 |
| `assets→cut` | 自动，`geml media todo --check` 通过 |
| `cut→render` | 自动，`geml check` 没有过期片段 |
| `render→review` | 自动，出片成功 |
| `render→cut` | 模型或人（出片失败、要改剪辑）；`reset` 清掉 `no-stale` |
| `review→assets`、`review→cut` | 模型或人（要重出镜头、要改剪辑）；前者清掉 `assets-done`、`no-stale`、`rendered`，后者清掉 `no-stale`、`rendered` |
| `review→publish` | 自动，审片通过 |
| `publish→done` | 自动，已发布 |

- **封路点只有一个**：用途 `render` 只有 `render` 声明，所以 `geml media build` 只能在那里运行，而进入 `render` 要求没有过期片段。改了提示词却没重新生成素材，就出不了片。
- 三个 `human` 来源的变量只能由人勾选。
- 六个非终态的 `prompt` 指向流程自带的 `./guide.geml`：`script` 用写台词与分镜、一集一个文件的一节，`assets` 用生成与登记（`geml media todo`、`geml media import`、`geml media log`）的一节，`cut` 用时间线与对齐（`geml media lay`）的一节，`render` 用出片选项与出片失败的一节，`review` 用审片与返工的一节，`publish` 用发布的一节。
- 生图、生视频、配音工具的权限、首选与默认参数记在这个流程的工具词典里（§5.3）：同一部剧的画幅比例、模型这类参数写成默认参数，全剧一致。
- **返工**走 `review→assets`、`review→cut`，出片失败走 `render→cut`：这三条转换用 `reset`（§4.2）把上一轮的证据清回默认值，所以待办检查、过期检查与出片都要重新过一遍，新片也要人重新审。`review` 里 `approved` 总是 false（勾上它流程就离开了 `review`），不必复位。
- 状态带示例：`⧗ episodes/ep02 · assets · 待办 7 项`。工作项的文件声明了 geml-media 时，桥接在 `refresh` 与 `board` 两个 op 里用解析器的 `todo` 在进程内数出待办，经的是解析器同一个受限的文件宿主，所以与 `geml media todo <本集文件> --root . --json` 列出的条数相同；数随应答带回，带着数的时候所在的状态；hooks 模块留着最近一次的数，只在它所说的那个工作项、仍在那个状态时显示，状态一变（比如离开 `assets`）就不再显示。会话开始与打开、刷新看板时会读到它；数待办要给本集够得着的每个素材文件算哈希，所以别的 op 不数。数到 999 以上记作 1000，状态带显示 `待办 999+ 项`；每次读文件、算哈希前看一眼时限（10 秒），超时或出错就没有数，状态带不显示。文件经受限的文件宿主读不到（不存在、不是文件、链接到项目之外）时同样没有数，不当成「无待办」。它只用于显示，不进信号。
- **待讨论：库文档布局。** 素材块与生成日志放在几集共用的库文档里时，是库引用剧本、剧本不引用库，从本集出发的 `geml media todo` 看不见那些生成记录，待办永远清不掉；交一个目录给它，又会把别的集的待办算进来。要支持这种布局，`todo` 需要一个“从本集出发、连同引用了本集的库文档”的入口（比如一个指名库文档的参数，或者沿反向引用把库收进来），过期检查也一样。在那之前，规则是上面的一集一个文件。

## 8. Claude Code 外壳

**界面示意（2026-10-13）**：画板源文件在 `docs/design/ui/2026-10-13-gemflow-ui/`（画布 https://claude.ai/artifact/Aw9u6PXPAaXpFZYWppafY8 ），其 README 列了这一版定下的事。§8.1–8.3 与 §8.6–8.7 写的是实现了的那一版；示意图里还没落地的部分在 §8.8。

### 8.1 状态带（AbovePrompt）

终端与桌面 app 都画（`AbovePrompt` 只在这两处出现），两处文字相同；桌面上按钮是原生按钮，终端上是 `[ 标签 ]`（状态带持有焦点时数字快捷键生效）：

```
G · ⧗ feat/rate-limit · review · ci-pass ✓ · pr-merged ✓ · → #deploy 需批准   [批准] [打回 build] [待处理 3]
```

- **行首是 GEML 的 G 标**（品牌红，粗体；终端没有 Svg，所以是字）。红只用在 G 标和「待处理 N」计数上。
- **文字**：工作项、当前状态、当前状态出边的通行要求所读的条件变量的值（✓ / ✗，设置里可关）、下一步——有机器判的出边时取它，其次取要批准的，标"自动""需批准"或"手动"，通行要求没满足时加"待 <变量>"；终态显示"✓ 完成"。暂停时在状态后面只显示"⏸ 已暂停 · 模型推不动，证据照记"，不再显示变量与下一步。两分钟内有拒绝时加"刚拒绝 <键>"（设置里可关）；下一条机器判的边等的是时钟变量时加"等了 2 小时"。
- git 信号问不了 `gh` 时显示原因；会话里有工具或命令没注册上时，最后追加一段说明是哪个。工作项所用的流程不是项目默认流程时，在工作项后面标出流程名。
- 没有工作项时只显示原因（`⧗ main · not tracked (work items are branches)`）；项目里没有流程时写"没有流程"和一条建议（`ShellStatus.suggest`，CLI 的 `suggestWorkflow` 按项目顶层判断：`episodes/` 或 geml-media 文档→video，部署配置→dev，构建清单→coding，都没有→dev），按钮"添加 <流程>"（`add`）和"选流程"（打开设置）；桥接没应答时写"启动中"。状态带默认就在：只有 G 标又没有按钮时才整条不画。
- 桥接失败（找不到 Node ≥ 22、子进程失败或超时、应答无法解析）时只显示一行原因，后面一个"重试"按钮；bundle 没有构建时这一行带上该跑的构建命令。
- **行尾是此刻最紧要的动作**：待处理清单（§8.2）第一项的前两个动作——批准/打回、勾上、本阶段允许/所有阶段、放行一次、重试；暂停时只有"继续"。最后是"待处理 N"按钮（N 为待处理项数，设置里可关），点开看板的待处理页。按钮从左到右配数字快捷键 1、2、3（终端上状态带持有焦点时按数字即可，空输入框里的裸数字也行）。按钮的宽度先从文字里扣掉，文字放不下的那一段截断加 `…`。
- 文字与按钮由纯函数（`band.ts` 的 `bandView`）从最近一次桥接应答、看板的时间线与待处理清单算出，hooks 模块只用各界面都有的 `Box`、`Text`、`Button` 排版；画不出来时画 G 标加一行原因。有问卷占着这一行时让给问卷。
- 子项目 ⑤ 完成后追加 `⛁ 少读 182k`。

### 8.2 看板（Pane）

各界面都没有现成的标签元素，六个标签页是一排按钮，旁边一个"刷新"。顺序：**待处理 → 工作项 → 记录 → 流程 → 工具 → 会话**，打开默认在待处理。面板顶部常驻一行头部：G 标、名字、版本（有新版本时标"● 可更新 x.y.z"），右侧分享 · 设置 · 升级 · 关于；其下一行是工作项、状态、流程名、修订号，以及"暂停"/"继续"按钮。会话开始时就读一次看板（在 `refresh` 之后），所以待处理与状态带的动作不依赖面板打开过；一次调用、动词或补齐让阶段变了，一条拒绝记下了，词典学了一条，或者 `/gemflow use`、`add`、`pause`、`resume` 之后，看板在这次 hook 之后重读。

| 标签 | 内容 | 操作 |
|---|---|---|
| 待处理 | 只有人能做的事，按类分组、组内按等待时间排：**桥接坏了**（原因）；**要批准**（通行要求已满足的 `approval` 边，列出它读的变量）；**要回答**（问过而没答的工具问题，带命令行）；**要勾选**（当前状态出边读到的、`source: human` 的变量）；**卡住了**（进入当前阶段以来同一个键 30 分钟内被拒 ≥ 2 次：原因与次数）。空时写"没有要你做的事" | 重试；批准、打回到当前状态另一条人可走的边；本阶段允许 / 所有阶段 / 只这一次 / 拒绝 / 这是 `<用途>`；勾上；放行一次（一次性豁免：下一条按这个键被拒的调用放行，不学任何东西）、在 #状态 也允许（只对词典 deny 的键，用途封路的不给）、看记录 |
| 工作项 | 每个状态一组：有 journal 的工作项，当前项以 ▶ 高亮并标"当前"，附上次写入的时间、流程名（非默认时）、"⏸ 已暂停"；backlog 一节如前 | 当前项的暂停 / 继续；文件单位下别的工作项"切过去"（看板带回每个工作项对应的文件，hooks 模块把它记为最近写的文件，下一次桥接请求就开在它上面）；把一个待办项绑定到当前项 |
| 记录 | 顶部"自上次之后"摘要（§8.6）；筛选：全部 / 转换 / 证据 / 拒绝，旁边"导出 journal"；时间线最新在前，放得下的几行，每条是时间、做了什么、谁（自动 / 人 / 模型）、信号；有细节的条目可展开：凭什么（这条修订改了哪些变量）、哪次调用、在哪份内容上（`tree`）、还算不算数（与看板带回的当前指纹比对） | 展开 / 收起；导出 |
| 流程 | 每个状态一行，当前状态以 ▶ 高亮，标出起点、终点；其下是它的出边：自动、手动或需批准，通行要求，当前状态上没满足的标"未满足"，`approval` 边用醒目样式；用途与各自的状态；时钟（`elapsed` 变量：停留满多久、还有多久）；人勾选的变量；"打开 flow.geml"链接 | 当前状态上通行要求满足的出边是按钮，点一下就是人推进；勾选或取消人勾选的变量。暂停时不给按钮 |
| 工具 | 词典每一行在当前状态的处境（用途放行、封路、允许、拒绝、未定），用途、首选、默认参数；底部一个输入框"加一行：工具 \| 用途"，"打开 tools.geml"链接 | 在 #状态 也允许（没绑用途、本状态不放行的行）、设为首选（绑了用途但不是首选的行）、回答（待处理里有这个工具的问题时）；输入 `工具 \| 用途` 加一条 `use` 课，只写工具名则所有阶段允许。写进 `tools.geml`，持文件锁 |
| 会话 | 本会话发过的每条 prompt，按当时所在阶段分组（hooks 模块在 `prompt.submit` 时记下时间、工作项、阶段，宿主把这条 prompt 存成一行时（`session.append`）记下这行在记录文件里的 id，之后累计这一轮的工具调用数、拒绝数、成立的证据、进入的状态）；每条可勾选，勾中的一条下面是它的三个动作 | 定位：`$.ui.scroll` 滚到对话里那一行（按键是人的输入，这时对话行可以动）。从这里拆分、删除：先问一句，人点头后把活交给模型——插件发一条 prompt，点名随附的 `gemflow:split-session` skill 的脚本、这条 prompt 的时间与首行；拆分是这条起到末尾（最后一轮留下）搬进新会话，删除是只这一轮搬成单独的会话、内容不丢；原会话先备份到 `~/.claude/session-split-backups/` 再改写、桌面端条目克隆，都是 skill 的事，模型在对话里汇报。导出本会话：GEML（另带 journal，索引里带行 id）/ Markdown / JSON，可只导出勾选的；文件写到 `.geml/exports/` |

看板上的操作都经桥接执行，执行完重读看板；操作被拒时弹一条提示说明原因。`/gemflow board [标签]` 打开（任何宽度都会摆出来）；读不到看板（桥接不可用、错误应答、项目没有流程或流程有错）时不打开面板，回复原因；面板已经开着时显示原因，保留上一份看板。待处理页与会话页不需要看板数据。

**对话框**（同一个面板 `gemflow-dialog`，Esc 关闭）：

- 设置：提醒（待处理有新项、模型被拒绝——同一原因 3 分钟内只提一次、阶段变化）；状态带显示（变量、待处理数、最近一次拒绝）；项目（默认流程——在已装的里选；添加内置流程；从路径导入——一个含 flow.geml 的目录、一个 flow.geml，或任一 `.geml` 文件，先过静态检查，复制进 `.geml/workflows/`，项目还没有流程时同时设为默认）；偏好语言（跟随系统 / 中文 / English / 日本語）。设置存在插件自己的 store 里，跨会话。
- 升级：当前版本、npm 上的最新版本（打开时查一次 `registry.npmjs.org`）、该运行的 `claude plugin update gemflow@<marketplace>`（复制按钮；marketplace 名从插件目录路径读出）、更新后下一个会话生效。
- 关于：一句话、插件与解析器版本、词汇表、许可、规范与文档 / 仓库 / 反馈链接。
- 分享：分享什么（现在在哪 / 这个工作项的记录 / 本会话 / 流程与工具词典）× 怎么给（复制一段文字 / 写成文件 / PR 评论），"去掉命令行里的绝对路径"开关，下面预览"现在在哪"的三行。文件经桥接的 `export` 写到 `.geml/exports/`；PR 评论跑 `gh pr comment --body`。

**流程页的图**：`geml-statechart` 是数据，图是它的投影，所以图从模型画，不从 SVG 画。解析器的渲染器给出三样：拓扑（`flowOf`：状态按层、每条边是顺行、跨层/回头还是自环，没有像素）、几何（`layoutOf`，SVG 用）、画好的 SVG；`core/picture.ts` 把运行时叠上去：当前阶段、当前阶段每条机器判的出边的通行要求是否满足（人判的一句话不标）、每个阶段里的工作项数（当前阶段只有一项时不标）、暂停、刚走过的那条边、现在可走的边。桥接把拓扑、叠加和 SVG 一起作为 `BoardData.picture` 给出；`flowRows` 把它和看板的措辞合成第一行（`kind: "flow"`：每层的状态各带当前/起点/终点/角标，每条边带措辞、是否成立、是否刚走过，可走的边带编号和它的按下动作），它取代了原来的状态列表。hooks 模块在每个界面（桌面、编辑器、手机、终端）都用面板自己的元素画它：一层一行带边框的状态盒子（当前态强调色、终点双线框、角标），盒子下面一行一条出边，可走的边是带数字热键的真 `Button`，刚走过的边成功色，要批准的边警告色，其余灰字并给机器判的条件标 ✓ / ✗。`Svg` 元素是隔离的叶子（§12），点击传不回来，所以不用它。dsh 的网页看板拿同一行的 `svg` 字段内联，图上可走的边本身能点。

图上能按的：流程列表提供给人的那些转换（当前阶段的出边、通行要求成立、没被暂停）在图里用强调色画，带指针和一条宽的透明描边好点中，组上有 `data-from` / `data-to`。把图内联进页面的宿主（dsh 的网页看板）把点击变成 `advance`；Claude Code 的 `Svg` 元素把标记隔离画出来，点击传不回插件，所以面板上的图只看不按，按钮仍在图下的列表里（§8.8）。

### 8.3 `/gemflow` 命令

`/gemflow`（当前工作项、阶段、信号、下一步、拒绝计数，暂停时标"已暂停"）、`/gemflow board [pending|items|journal|flow|tools|sessions]`（打开看板，停在那一页）、`/gemflow pause`、`/gemflow resume`（回答带上之后的状态）、`/gemflow use <流程>`（切换项目的默认流程：之后新开的工作项用它，已开始的工作项按各自的流程继续）、`/gemflow add [流程]`（+ 菜单：不带参数列出内置流程，带名字时把它复制进 `.geml/workflows/`；项目还没有流程时同时设为当前流程，否则提示 `/gemflow use <流程>`；市场见 ③）。其他参数回一段用法。

### 8.4 hooks 模块接线

hooks 模块运行在没有 Node、没有 DOM 的环境里，`$.fs` 不能追加、改名或加锁，所以它从不写项目里的文件：journal、上下文文档与 backlog 只由 Node 一侧的 CLI 写。两侧之间是一座桥：`node <插件目录>/dist/gemflow.mjs hook`，stdin 一个 JSON 请求，stdout 一行 JSON 应答，不论应答说什么退出码都是 0（op：status、refresh、before、after、verb、learn、mark、advance、bind、use、add、board）。CLI 每个请求都重新打开工作区——打开时读 git 的事实，别的进程也可能在两次请求之间写过 journal——用 `host: "claude"` 执行。请求只带调用的命令与路径，不带文件内容。请求与应答的类型只在不依赖 Node 的 `src/hosts/claude-code/protocol.ts` 里定义一次。`before`、`after` 与 `verb` 请求带上这次调用的起始目录（`cwd`，hooks 模块在调用进入时读 `$.session.cwd()`），CLI 按 §5.7 归属。

- **快路径**：每个应答都带一份状态与策略快照（读一遍 journal 与工具词典得出）——是否有工作项、单位、当前状态、本状态在词典里允许与拒绝的键、每个键绑定的用途与各状态声明的用途、各用途的首选与默认参数、文件来源的 glob、出边通行要求所读的条件变量。调用前由纯函数判断：人专属命令与封路用途的命令请 CLI 记录并拒绝；只切换工作项的命令行放行；其余按 §5.3——键绑着本状态声明的用途就放行，有键被拒过就拒绝（请 CLI 记一条 `refused`），全部允许过就放行（不起子进程），有没见过的键或模型没用首选，hooks 模块就用 `$.ui.ask` 问人，答案经 `learn` 写进词典，再按答案放行或拒绝；带默认参数的工具，hooks 模块补上缺的参数（`next({ ...e, ...缺的参数 })`）。读命令行用的是监督器自己的扫描函数（`src/core/command-line.ts`，不 import 任何东西），快路径与 CLI 判断得完全一样；人专属命令与用途封路读任何输入里带 `command` 的工具调用（Bash、Monitor）。调用后只在这几种情况起 `after`：写了匹配 `file:` 单位 glob 的路径；Bash 结果带 `gitOperation`，或命令行在任一命令位置运行了 `git`、`gh`（切换分支、reset 不带 `gitOperation`，却可能换掉工作项，或带来第一个工作项）——这两种在没有工作项时也起；`before` 刚记过一条；流程有文件来源时的任何运行命令的调用（构建、渲染也会产生文件）；绑着用途的命令带着退出码结束；写文件的调用写了匹配文件来源 glob 的路径。`test/fastpath-parity.test.mjs` 对着工作区钉住这两个判断。调用可能落在别的检出时快路径不按会话的策略放行：hooks 模块从起始目录（写文件的工具用文件所在目录）往上直到项目根，用 `$.fs.stat` 找 `.git`（按目录缓存），找到了、目录在项目根之外，或命令行里有切换目录的命令，就请 CLI 定夺；策略快照按检出各留一份，同一个检出里之后的调用照常走快路径。
- **git 信号**在会话开始、看板打开与刷新、结果带 `gitOperation` 的调用之后重读，连同 `gh`；命令行运行了 `git` 或 `gh` 而结果不带 `gitOperation` 时只重读 git 自己的事实（当前分支、`committed`），所以 `git status` 之类的命令不会多问一次 `gh`。其余请求沿用上一次应答报告的 `gh` 可用性。`GEMFLOW_GH` 指定 `gh` 程序。
- **上下文**：应答报告阶段变化（这次操作进入了新状态，工作区的结果带着新阶段的文字）时，新的 `#current` 放进这次工具结果的 `context`；调用来自主线程时，应答里上下文文档的 `item@rev` 记为已交给模型，子 agent 的调用（事件带 `agentId`）的结果只到子 agent，不记，主线程的下一次提交照样带上。`prompt.submit` 读 `.geml/context.geml`，`item@rev` 与已交的不同、且 `item` 是当前工作项时放进 `context`；`session.end`（含 `/clear`）清掉这个记号。工作区的每次操作（含打开）都会让上下文文档对上当前工作项。应答所在的工作项与已交给主线程的不同（切换了分支、换了一集）时，新工作项的说明连同交接行放进这次工具结果的 `context`（§5.7），并记为已交给模型。
- **失败放行**：Node 缺失、桥接失败或超时（每次 15 秒；`refresh`、`board`、`use`、`add` 45 秒）、应答无法解析时，调用照常执行、什么都不记，状态带显示原因；词典的拒绝、用途封路与人专属命令只在有策略快照时生效；问人在 hooks 模块里，答案要经桥接才记得进词典。CLI 从不把异常抛给 hooks 模块：打不开工作区是一个问题（项目里没有流程时状态带写"没有流程"并给出建议），读不了 journal、锁一直被占、动词反复冲突是不带状态的错误应答——hooks 模块保留上一份状态与策略，状态带显示原因。会话开始时没找到 Node，之后的工具调用、提交或 `/gemflow` 十秒后再试；找到了 Node 但没拿到应答，再试至多一分钟一次。每个会拦截的 hook 都带 `.catch`：hook 自己出错时调用照常执行。

| 事件 | 做什么 |
|---|---|
| `session.start` | 记下会话目录；注册三个模型工具（`$.tool.register`，`isDeferred: false`）与 `/gemflow`，没注册上的记下来由状态带显示，启动照常继续；从 `$.store` 读设置与上次看记录的时间，读 `LANG`，读 plugin.json 的版本；找 Node（候选依次：PATH 上的 `node`；shell 找到的——Unix `/bin/sh -lc "command -v node"`，Windows `cmd.exe /d /c where node`，不是本系统的那个立刻失败；安装器的位置——`%ProgramFiles%\nodejs`、`%LOCALAPPDATA%\Programs\nodejs`、`%NVM_SYMLINK%`、Volta、Homebrew、`/usr/local/bin`、`/usr/bin`；每个 `--version` 探测 10 秒，第一个主版本 ≥ 22 的就是）；经桥接取一次状态；随后在会话开始之外（`$.clock.after(0, …)`）请 `refresh` 补齐 `git`、`file` 信号，再读一次看板（待处理清单从它的时间线算） |
| `session.end` | 清掉"已交给模型的上下文"记号：`/clear` 之后的下一次提交重新带上 `#current`；把现在记为上次看记录的时间（`$.store`，按项目根） |
| `tool.call` | gemflow 自己的三个工具直接放过。进入时读 `$.session.cwd()` 作为这次调用的起始目录。调用前：按快路径与工具词典放行、拒绝（回 `{ deny }`，按设置发一条桌面提醒）或用 `$.ui.ask` 问人（问题被关掉时进待处理，调用放行一次），补默认参数；人放行过一次的键随 `before` 的 `waived` 送到 CLI，闸对这一条调用让路，用掉即清；调用后：按快路径只在需要时请 `after` 求值 `tool`、`file`、`git` 信号（退出码判定见 §5.2）；`file:` 单位下记下最近写过的匹配文件；若这次调用触发了状态变化或换了工作项，把新的 `#current`（换工作项时连同交接行）放进这次结果的 `context`，模型在同一轮就读到 |
| `tool.call`（`mcp__gemflow__status`、`move`、`set`） | 经桥接的 `verb` 执行，带上调用方循环的目录；改变了阶段的动词把新的 `#current` 放进结果的 `context` |
| `prompt.submit` | 不是插件发的 prompt 记进会话页（时间、文字、工作项、阶段；之后这一轮的工具调用数、拒绝数、成立的证据、进入的状态累计到它上面）；`.geml/context.geml` 的 `item@rev` 与已交给模型的不同（人在看板上推进、会话开始时 git 信号补齐、子 agent 推进过），且 `item` 是当前工作项时，把 `#current` 放进 `context` |
| `session.append`（`door: "prompt"`） | 宿主把人的 prompt 存成一行时，把这行的 `uuid`（与记录文件里的一致）记到会话页最新一条还没有 id 的记录上；插件自己发的、子 agent 的、注入的行不记 |
| `command.run` | `/gemflow` 各子命令（§8.3）；`/gemflow board [标签]` 先读看板，读到了才调 `$.ui.open({ id: "gemflow-board", title: "Gemflow" })` |
| `ui.render` `AbovePrompt` / `Pane`（`requestId: "gemflow-board"`、`"gemflow-dialog"`） | 状态带、看板、对话框；每个按钮的 `onPress` 走同一个 `act`（`actions.ts` 的动作联合）：经桥接的操作、引擎的 `$`（打开面板、复制、通知、导出），或模块自己的状态（标签、筛选、展开、一次性豁免、待答问题、勾选的 prompt） |
| `ui.press`（`requestId: "gemflow-dialog"`） | 分享对话框里"分享什么 / 怎么给 / 去路径"的选择只改对话框自己的状态 |

`prompt.submit` 的 `context` 与 `tool.call` 结果的 `context` 都只给模型看、不显示给用户（已实测前者到达模型）。看板只由用户的命令打开，所以任何宽度都会摆出来（插件自己打开时终端要 144 列以上）；没摆出来时 `/gemflow board` 说明原因。

### 8.5 MCP 工具（跨宿主共用）

三个工具 `status`、`move`、`set`，参数结构固定，不随状态变（免得 prompt 缓存失效）：`status` 只读，给出工作项、阶段、变量、每条出边与通行要求是否满足，以及本阶段的说明；`move {to}` 走一条出边；`set {变量: 值, …}` 写由模型写的变量（类型须与默认值相同，有来源的变量写不了）。Claude Code 里由 hooks 模块在会话开始时用 `$.tool.register` 注册，列为 `mcp__gemflow__status` 等；只接 MCP 的宿主经 `gemflow mcp` 看到同样三个名字（宿主按服务名分命名空间）；DeepSeek Harness 与 pi agent 没有命名空间，注册为 `gemflow_status`、`gemflow_move`、`gemflow_set`。它们是 gemflow 自己的工具：不经工具词典；动词自己的规则（通行要求、批准、变量类型）照样生效。模型对要批准的边调用 `move` 一律被拒绝并记一条 `refused`，回答里提示由人在看板上或用 `gemflow advance <state>` 批准。人勾选的变量与回滚不是模型的工具（回滚是人的 `gemflow rollback`）。

其他宿主用 `gemflow mcp [--host <宿主>] [--root <目录>]`（stdio MCP：initialize、ping、tools/list、tools/call）。每次调用都重新打开工作区，用 `--host` 指定宿主（默认 `mcp`）；打不开工作区、读不了 journal、锁一直被占、动词反复冲突都是一条错误结果，服务不会因此退出。改变了阶段的调用把新的 `#current` 附在结果后面。这类宿主不把自己的工具调用交给 Gemflow，所以：

- 工具调用观察不到，`tool` 证据立不起来，工具词典不起作用，什么都不拒——用途封路与人专属命令也一样。通行要求对人的推进同样生效，所以通行要求要读 `tool` 证据的转换，只有通行要求也接受一个人勾选的变量时才会走：开发流程里人勾选 `review-ready` 能让 `build` 进入 `review`，production 部署的退出码在这类宿主上永远读不到，`release` 到不了 `done`，除非流程给这条转换的通行要求加一个人勾选的条件变量。
- `git`、`file` 来源只在模型调用 `status` 时重读；读完流程动了，回答后面附上新阶段的文字。
- 没有状态带和看板；人在终端里用 `gemflow` 推进、勾人勾选的变量。

skill `skills/gemflow-mcp/SKILL.md` 要求只接 MCP 的宿主每轮先读 `.geml/context.geml#current`，推了代码、开了 PR 或写了阶段要的文件之后调用 `status`，不运行人专属命令，运行封路用途的命令之前自己先看当前状态。Grok、Gemini CLI 用 `gemflow mcp` 推进与记录；Codex 用 `gemflow mcp --host codex` 加插件的 hooks（§8.9）；DeepSeek Harness 与 pi agent 用各自的适配器（§6 第 4 条）。

### 8.6 提醒与「自上次之后」

- **桌面提醒**走 `$.ui.notify`（用户自己的通知渠道），三种，各有设置开关：待处理清单里出现了没见过的项（桥接坏了不算；一条提醒说第一项——"feat/rate-limit 等你批准：review → deploy"或"… 有事要你做：…"）；模型被拒绝（同一原因 3 分钟内只提一次）；阶段变化（默认关）。
- **摘要**（记录页顶部、分享的"现在在哪"）：`digest.ts` 把上次看记录的时间之后的时间线说成一句话——按时间顺序，成立的证据合并成"tests-pass、pr-open 成立"，转换按谁走的说（"自动进了 #review" / "你推进到" / "模型推进到"），暂停、继续、回滚、过期各一句，拒绝按键合并（"模型 3 次想用 deploy-staging，都拦下了"），末尾接上待处理第一项要的事（"现在等你批准 review → deploy"）；下面一行计数（自动推进、证据、拒绝）。"上次看记录的时间"：会话开始时取 store 里上一次会话结束（或上次离开记录页）的时间，离开记录页时更新；没有就不显示摘要。

### 8.7 设置与词条表

- 设置（§8.2 对话框）存在插件的 `$.store`（`settings`），`settings.ts` 读写：缺的、类型不对的字段取默认。`selectedOnly`（会话页"只选中的"）是看板自己的开关，不是设置。
- **词条表** `text.ts`：键是中文原文（带 `{0}` 空位），值是英文与日文；`wordsFor(lang)` 给出 `t(key, …args)`，没有译文的键回落到中文。语言：设置里选了就用它；"跟随系统"按 CLI 报告的 `Intl` locale，其次 `LANG`（`zh*` 中文、`ja*` 日文、其余英文），都没有时中文。状态带、看板、对话框、提醒与 `/gemflow` 的回答（用法、状态、添加、看板的开与不开）都经 `t`；流程自己的标题、说明与变量名照作者写的。`test/text.test.mjs` 扫描 `src/hosts/claude-code/*.ts` 里每个 `t("…")`，钉住每个键都有英文和日文、空位一致。

### 8.8 示意图里还没落地的

| 项 | 为什么还没有 | 位置 |
|---|---|---|
| 工作项页的"切过去"（分支单位） | 切分支是人在自己 shell 里的动作，看板不替人切；文件单位的"切过去"已有（§8.2） | 工作项页 |
| 分享的"链接" | 没有服务端；等 ③ 流程市场或别的落点 | 分享 |
| 升级对话框里的"更新"按钮直接升级 | 插件拿不到自己的 marketplace 名（只能从路径猜），先给命令和复制按钮 | §8.2 |
| Codex 上问人 | hooks 答不了问题（`permissionDecision: "ask"` 不支持，`PermissionRequest` 是宿主自己的审批流）；词典没有决定的调用放行，模型收到一句说明，人在 tools.geml 里加一行 | §8.9 |
| Codex 上 Windows 的退出码 | 包命令的壳是 POSIX shell；Windows 上不包，`tool` 证据写不了 | §8.9 |
| DeepSeek Harness 的状态带 | dsh 0.1.5 的 web GUI 没有输入框上方的插槽；等其 0.2.1 alpha 的 mods 桥 | §8.10 |
| DeepSeek Harness 的会话页 | 会话页是人的 prompt 列表与 Claude Code 记录文件上的三个动作（定位 / 拆分 / 删除）；dsh 的会话是它自己的，适配器没有 prompt 记录 | §8.10 |
| DeepSeek Harness 上看板问人 | 闸里的 `ask` 走 dsh 的审批服务，看板没有待答的问题；词典的决定在工具页写 | §8.10 |
| Claude Code 面板上点图 | `Svg` 元素把标记隔离画（图片或无脚本沙箱帧），没有把点击传回插件的通道；图上标出的可走转换在 dsh 网页看板里能点，面板里按图下的按钮 | §8.2 |

### 8.9 Codex 适配器

Codex 的插件能带 hooks，每个 hook 要人先在 `/hooks` 里信任（装上不等于信任；未信任的静默跳过），信任之后 Gemflow 在 Codex 上看得到工具调用。随包的 Codex 清单是 `.codex-plugin/plugin.json`：skills 同一份；`codex/mcp.json` 在插件目录里起 `gemflow mcp --host codex`（status / move / set / note 四个工具；`cwd` 为 `.`、命令是 `node ./dist/gemflow.mjs`——Codex 不替换服务器参数里的 `${PLUGIN_ROOT}`，§12），每次调用的项目是调用的 `_meta["x-codex-turn-metadata"].workspaces` 里的工作区（几个时取有 `.geml/` 的那个），note 记进这次调用所属会话（`session_id`）的记录；`codex/hooks.json` 把 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop 都交给同一条命令 `node "${PLUGIN_ROOT}/dist/gemflow.mjs" codex`。仓库的 `.agents/plugins/marketplace.json` 以本地路径列出它（要先 `npm run build`）；`.codexignore` 把 src、测试、node_modules 留在包外，dist 必须在。

每个事件是一个新进程：`src/codex.ts` 在进程内调桥接的 `handleRequest`，用和 Claude Code 模块一样的函数判断（`fastpath.ts` 的 `beforeDecision`、`afterNeeded`、`paramsToFill`）；`src/hosts/codex/hook.ts` 读事件、拼应答，纯函数。模型上次读到的 `item@rev` 记在 `PLUGIN_DATA`（没有就临时目录）下按会话一个文件。

| 事件 | 做什么 |
|---|---|
| `SessionStart` | `status`，再 `refresh` 补齐 git 信号；把 `.geml/context.geml` 的 `#current` 作为 `additionalContext` 交给模型，记为已交 |
| `UserPromptSubmit` | `item@rev` 与已交的不同、且 item 是当前工作项时再交一次 |
| `PreToolUse` | gemflow 自己的工具放过。`beforeDecision` 说要请 CLI 就发 `before`：拒绝即 `permissionDecision: "deny"` 带原因（CLI 记一条 `refused`）。词典没有决定的键，或用的不是用途的首选：hooks 问不了人，调用放行，`additionalContext` 告诉模型词典没有决定、人可以在 tools.geml 里加一行；两个宿主的写文件工具之间不算首选之争（词典的默认编辑器是 Claude Code 的名字，Codex 的是 `apply_patch`）。结构化输入的工具有默认参数就用 `updatedInput` 补齐。`Bash` 命令的退出码是证据时（某个键绑着 `tool` 变量读的用途），`updatedInput` 把命令包成 `( 命令 ); __gemflow_status=$?; printf '\n[gemflow exit %s]\n' "$__gemflow_status"; exit $__gemflow_status`：子 shell 里跑，宿主看到的退出状态不变，输出末尾多一行标记；Windows 不包 |
| `PostToolUse` | 包过的命令先还原，按原样判断与记录；退出码取 `tool_response` 里任何字符串的最后一个 `[gemflow exit N]`，没有就是不知道（不写 `tool` 证据）；`apply_patch` 的补丁只取 `*** Add/Update/Delete File:` 的路径，不当命令行扫；补丁写的项目内文件记进会话记录，命令里有提交时记下这一轮提交过；`afterNeeded` 成立才发 `after`，阶段变了把交接行与新 `#current` 作为 `additionalContext` 交给模型，记为已交 |
| `Stop` | 回合结束：最后的回答（`last_assistant_message`）记进会话记录，这一轮提交过时连同它的提交；什么都不交给模型 |

什么都不说、退出码 0：项目没有流程、事件读不懂、出错（原因到 stderr）。宿主工具表 `codex`：`Bash` 运行命令，`apply_patch` 写文件；内置词典给 `apply_patch` 绑了 `edit`（视频流程里所有阶段放行）。Codex 上没有状态带与看板，人在终端里用 `gemflow` 推进、勾变量。

### 8.10 DeepSeek Harness 界面

dsh 的 web GUI（`dsh --profile web`）里，看板是右侧栏的一个标签页：引导页列出「Gemflow — 流程、阶段、证据与记录」，点开即看板。两半：

- **宿主半边**（`src/hosts/dsh/board.ts`，`plugin.ts` 挂路由）：`GET /api/gemflow/board?session=<id>&tab=&filter=&expanded=&lang=` 答一个标签页的行、标签页列表与表头（工作项、阶段、流程名、修订、拒绝数、暂停、版本）；`POST /api/gemflow/act` `{ session, action }` 跑一次按键。行由 Claude Code 看板的同一组函数（`paneRows`、`inboxItems`、`tabs`）生成：会话的监督（statechart、Supervisor、词典、journal）站在 Claude Code 桥的 workspace 的位置（`sessionShell` / `sessionBoard`），所以两个看板说同样的话。没人监督的会话 404；宿主做不了的按键 400 带原因。
- **浏览器半边**（`client.js`，`package.json` 的 `dsh.client` 加 `exports["./client"]`）：手写的 ModuleLoader bundle，注册标签页类型（`sidebarRightTabs.register`）与标签页正文（`slots.inject("sidebar.right.pane.tab")`），只画宿主给的行、把按键发回去；标签页可见时每 3 秒读一次；语言按 dsh 的 locale（zh / en / ja）。文件链接经 dsh 自己的 `session/openWorkspacePath` 打开（http 页面里的 `file:` 链接什么都打不开），没有应用认领的文件改为在文件管理器里显示。按键或打开失败的原因留在看板上，直到下一次按键。

五个标签页：待处理、工作项、记录、流程、工具；会话页不在（§8.8）。按键：人的转换、勾变量、暂停 / 继续，以及写进 tools.geml 的学习——「设为首选」「在 #x 也允许」与「加一行：工具 | 用途」输入框（`{ op: "input", field, value }`，宿主半边用 `inputAction` 变成 lesson）；Supervisor 每次判定都重读词典，下一次调用就生效。宿主没有的操作（导出、对话框、复制、切换流程、导入……）不画按钮：行先经 `onThisHost` 过滤，空了的按钮行一并去掉。

bundle 的行名必须是路径（`./dist/hosts/dsh/plugin.js`，dsh-app-boot 把它锚在 patch 文件旁），不能是 `@geml/gemflow/dsh`：dsh-client-modules 只为裸包名或路径命名的行找 manifest，子路径找不到包，浏览器半边就不进 boot 图（§12）。journal 仍按会话记在 `<journalDir>/<session>.geml`，会话重启后读回；状态带没有（§8.8）。流程页开头的状态图与 Claude Code 看板的是同一份数据（§8.2）：`sessionBoard` 用 `core/picture.ts` 叠上会话的运行时，浏览器半边把 `flow` 行的 `svg` 字段内联，并把图上可走转换的点击变成 `advance`。

## 9. 测试策略

- 核心全是纯函数：每条静态检查、每种信号、三种推进来源、工具词典的判定与学习、用途封路、journal 加锁与续链，各有单测。
- `checks.json` 钉住静态检查（运行时的测试逐例重放），`conformance.json` 钉住解析器层的规则。
- Claude Code 外壳：快路径、结果读取、状态带、看板的六页、待处理、摘要、会话、分享、设置、时间与词条表、`/gemflow` 的文字都是纯函数，用 node:test 测（含中日韩字符宽度）；`test/fastpath-parity.test.mjs` 对着工作区钉住快路径——工作区会拒绝或记录的调用都请 `before`，`after` 会改变状态、策略或 journal 的调用都请 `after`。桥接经打包后的 `dist/gemflow.mjs` 在临时 git 仓库里逐个 op 测（`gh` 用 `GEMFLOW_GH` 指向的替身），开发流程也这样从头走到尾：信号推进、部署封路与各种部署写法、人批准、退回重做；`gemflow mcp` 逐条消息测。hooks 模块用 `claude plugin test` 按真实事件顺序驱动（会话开始 → Bash 测试命令写信号 → 自动边推进 → 结果里带上新阶段 → 看板推进后的下一次提交带上新阶段；另有失败的测试、切换分支、词典拒绝与问人、桥接坏掉与错误应答与没有 Node 时放行、三个工具、子 agent、注册被拒、没构建的 bundle、至多一分钟一次的重试、各界面上的状态带与看板），桥接由测试脚本应答；`npm run test:claude` 运行，需要 `claude` CLI。另有一个测试沿 hooks 模块的 import 链检查，不允许任何需要 Node 的东西进来。
- 端到端：用本分支自己的开发当第一个真实用户——Gemflow 记录 Gemflow 的开发。

## 10. 后续子项目（占位）

| 子项目 | 期 | 要点 |
|---|---|---|
| ③ 流程市场 | 搁置（2026-10-22）：一个流程该怎么执行还没理清（待讨论），理清之前不设计市场 | git 仓库作目录，索引为 GEML 文档；`gemflow catalog add owner/repo`；安装前预览（阶段、每个阶段的指令、封路点）+ 静态检查；装进 `.geml/workflows/`，用户目录留缓存；+ 菜单：从市场安装（默认）/ 对话生成 / 复制修改 |
| ⑤ 按块读 + 影响面 + 投影 | 与 ③ 并行 | 大 Markdown 读取改为按块读并计节省；codemap 增量更新与调用者查询（状态带一段、看板一栏）；journal 与代码地图投影到 Obsidian，Logseq 其后 |
| DeepSeek Harness 界面 | 看板已落地（§8.10，2026-10-13）；状态带待定 | 状态带需其 0.2.1 alpha 的 mods 桥；工作项 journal 到达 DeepSeek Harness 与 pi agent 之前，这两个宿主仍按会话记 journal（`flow-item = "session:<id>"`），不求值信号、不写 `.geml/context.geml` |
| 工具偏好的个人层 | 待定 | 用户目录下一份工具词典，项目的覆盖它：个人习惯的工具与参数跨项目复用 |
| 偏好按状态覆盖、固定参数 | 待定 | 同一用途在不同阶段首选不同（草图用便宜的模型、成片用好的）；不许模型改的参数 |
| 命令的默认参数 | 待定 | 命令行不改写，给命令定默认参数要另想办法 |
| 其他宿主界面 | 待定 | Grok：可给用户一段 status line 脚本自行配置；Codex、Gemini CLI：插件接口目前画不了 |

## 11. 备选方案与取舍

| 问题 | 选了 | 没选 | 理由 |
|---|---|---|---|
| 状态怎么写 | 状态机图块里的节点 | 章节；专门的块类型 | 节点就是状态，属性挂在节点上；大段的提示词仍是章节，`prompt` 引用它 |
| 转换怎么声明 | 图块里的 `transitions` | 一张表；每条边一个块 | 通行要求、动作、属性都在一条转换上；和节点在一处，图从定义画出 |
| 通行要求怎么判 | 三种：对象由机器判，一句话由模型判，`approval` 由人判 | 只有机器判的通行要求，手动边不写 | 模型判断的通行要求也该写出来，它是给模型的指令；有通行要求的机器判边自动走 |
| 流程图 | 由定义画出（`geml-statechart`） | 手写 Mermaid，检查它与表一致 | 一份定义，不会不一致；`--to md` 投影成 Mermaid，GitHub 上照样是图 |
| 工具权限 | 工具词典：每个状态第一次用到一个工具时问你，答案记下来 | 流程里按状态写死工具清单；全局 `mode` 开关 | 工具集一直在变（新的 MCP 服务、插件），由使用的人在用的时候决定最准；同时记下首选与默认参数 |
| 怎么问人 | 插件自己的问题框 | 宿主的权限框 | 实测借不到宿主的权限框，auto 模式下也问不到人（§12）；偏好要几个选项 |
| 推进来源记在哪 | 新属性 `by` | 扩充 `cause` 取值 | `cause` 说做了什么，`by` 说谁做的，两者正交 |
| journal 单位 | 由流程的 `flow-unit` 声明：开发按分支，视频按剧集文件 | 全局固定按分支；按日期、按会话 | 一个工作项的全部阶段落在同一处；做视频的人不一定用 git |
| 流程的存放形状 | 一个目录：`flow.geml` + 自带的上下文文档 | 单个文件 | 视频流程各阶段的说明不在用户项目里；市场里的流程包也是这个形状 |
| 变量怎么声明 | 图块里的 `vars`，默认值定类型，`source` 写值从哪来 | 一张表；一份 JSON Schema 加一张信号表 | 通行要求读的、动作写的和声明在一处；要坐标寻址时把定义放进 `data` 块，图用 `data=` 引用 |
| 工具怎么指 | 用途：流程写用途，词典把用途绑到项目的工具 | 流程里写命令正则；`only-in` 列 | 流程不认识用户的项目——`npm test` 还是 `cargo test` 由项目的词典说；封路按用途，流程搬到别的项目一字不改 |
| 状态机格式放哪 | 独立的词汇表 `geml-statechart/v1`，geml-flow 放行它 | 写进规范（GEP）；写在 geml-flow 里 | `spec/proposals/README.md` 的判据：不给每个处理器加义务的东西先做词汇表；通用的格式不该归一个运行时；第二份采用它的词汇表出现时再走 GEP |
| journal 的形状 | 每条一个核心 `data` 块 | 专门的块类型 | 坐标能读到任何一个字段；journal 不必声明 profile |
| 插进来的无关事怎么隔离 | 按每次调用的目录归到它作用的工作项（§5.7） | 每次用户输入先判断属于哪个流程；显式的岔出去/回来动词 | 隔离靠活落在哪里；agent 途中发现的事输入时判断不到；凭事实而不是模型判断 |
| journal 放在哪 | branch 单位放在仓库主工作树、各检出共用；file 单位按检出 | 按检出各一份 | 工作项是分支，同一分支在哪个检出做都是同一本；worktree 删了记录也在 |
| 证据何时作废 | `tool` 证据随工作内容过期（按 git tree） | 按行选是否过期；只靠返工边的 `reset`；指纹里含 `HEAD` | 内置流程里找不到不该过期的命令证据；测完又改、rebase 不经过任何边；提交不改变内容 |

## 12. 宿主能力：已查明与待确认

已查明（2026-10-11，Claude Code 2.1.295 桌面 app 内用一个探针 mod 实测；Codex CLI 0.149.0 用脚本化的本地模型服务实测；2026-10-12 的几行用 Claude Code 2.1.296 的 `claude plugin test`、`claude plugin validate` 与一个探针插件实测，读声明得出的在行内注明）：

| 问题 | 结论 | 落在 |
|---|---|---|
| hooks 模块能否给模型附加上下文 | 能：`prompt.submit` 的 `context`、`tool.call` 结果的 `context`，用户都看不见 | §5.4、§8.4 |
| `Bash` 的退出码 | 非零：`isError` + `text` 开头的 `Exit code <n>`；零：无错误且无 `returnCodeInterpretation` | §5.2 |
| Claude Code 能否隐藏工具 | 不能，只能挪到 ToolSearch 后面或改描述；工具词典用拒绝与问人代替 | §5.3 |
| 插件怎么开面板 | `$.ui.open({ id, title })` + `ui.render` `{ component: "Pane", requestId: id }`，与 effortless 相同 | §8.4 |
| Codex CLI 是否加载插件 hooks | 加载，SessionStart / PreToolUse / PostToolUse 都触发，但每个 hook 要用户先信任（交互式 CLI 启动时会问；`codex exec` 里不问，未信任的 hook 静默跳过）。PreToolUse 能拒绝 shell 命令；PostToolUse 只拿到合并后的输出文本，**没有退出码** | §8.9 |
| Codex hooks 的接口（2026-10-13，读 learn.chatgpt.com/docs/hooks 与 developers.openai.com/plugins/build/plugins） | 事件：PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、UserPromptSubmit、SubagentStart/Stop、Stop、Interrupt、SessionStart、SessionEnd；stdin 一个 JSON：`session_id`、`transcript_path`、`cwd`、`hook_event_name`，工具事件带 `tool_name`、`tool_use_id`、`tool_input`（`Bash` 与 `apply_patch` 的命令或补丁在 `tool_input.command`），PostToolUse 另带 `tool_response`（形状按工具，Bash 的未写明）。stdout 的 `hookSpecificOutput`：PreToolUse 的 `permissionDecision: "deny"` + `permissionDecisionReason` 拦下，`"allow"` + `updatedInput` 改写（Bash 要字符串 `command`，MCP/函数工具是替换参数对象），`additionalContext` 不拦只加上下文；`"ask"` 不支持。SessionStart / UserPromptSubmit / PostToolUse 的 `additionalContext` 是给模型的 developer 上下文。退出码 2 拦下（stderr 为理由）。matcher 是工具名的正则，空匹配全部。插件 hooks 的命令里有 `${PLUGIN_ROOT}`，环境变量 `PLUGIN_ROOT`、`PLUGIN_DATA`（可写的数据目录）；工作目录是会话的 cwd。插件的 hooks 装上不信任，`/hooks` 里信任；`--dangerously-bypass-hook-trust` 跳过一次。marketplace 来源：`local`、`url`、`git-subdir`、`npm`（不跑生命周期脚本）；装好的副本在 `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`。包命令的壳经测试：子 shell 里的 `exit 3` 仍让宿主看到 3，标记在输出末尾 | §8.9 |
| hooks 模块的运行环境（2026-10-12） | 没有 Node 与 DOM；可以用相对路径 import 插件里的 `.js`；`$.process.run` 按参数向量起本机进程，起不来或超时即 reject；`$.fs` 只能整份读写，不能追加、改名、加锁 | §8.4 |
| 插件测试（2026-10-12，`claude plugin test`） | 运行插件目录下的 `*.test.ts(x)`，不进 `node_modules`；引擎调用（`process.run`、`fs.read`、`ui.open` 等）由测试自己的 hook 应答，每个应答都要在测试第一次调用 `$` 之前注册 | §9 |
| `claude plugin validate`（2026-10-12） | 拒绝找不到文件的相对 import；拒绝不是函数字面量（也不是函数名）的 hook，例如一次调用的返回值；匹配条件取自 import 的常量时显示为 `requestId=?`，所以匹配值直接写字面量；列出每个拦截 hook 是否带 `.catch` | §8.4 |
| hook 的顺序与失败（2026-10-12） | 不带匹配条件、先注册的 `tool.call` hook 在带匹配条件的之上运行，插件自己工具的调用也先经过它，由它 `next(e)` 传下去；带 `.catch(($, e, next) => next(e))` 的 hook 抛异常时调用照常执行 | §8.4 |
| 插件注册的工具（2026-10-12） | `$.tool.register` 的 `inputSchema` 是 JSON Schema，`enum`、`required`、`additionalProperties: false` 都会校验，调用由插件的 hook 应答 | §8.5 |
| 每次调用的目录（2026-10-12，探针插件实测，2.1.295） | `tool.call` 的输入只有工具参数、`tool`、`tool_use_id`，子 agent 的另带 `agentId`，没有 cwd。钩子里读 `$.session.cwd()` 按发起调用的循环作答：主循环是 shell 当前目录（调用开始时的；同一次调用里命令自己的 `cd` 调用结束后才反映）；普通子 agent 是父会话的目录；隔离 worktree 的子 agent 是 `<项目>/.claude/worktrees/agent-<id>`（分支 `worktree-agent-<id>`，在项目目录之内，是另一个 git 检出）。`$.session.root()` 不随 shell `cd`、也不随子 agent 的 worktree 变。`cd` 到项目之外，harness 当即把 shell 目录重置回项目根。Agent 工具调用的输入带 `isolation: "worktree"`，`agent.spawn` 的结果带 `agentId` | §5.7、§8.4 |
| 插件能否借宿主的权限框问人（2026-10-12，探针，桌面会话） | 不能：插件挂在 `classic.PreToolUse` 上返回 `ask` 的钩子没有被调用（只读与写文件的命令都试过）；`classic.PermissionRequest`、`classic.PermissionDenied` 也没触发；会话在 auto 权限模式下，宿主自己的权限提示由分类模型代答，人一个框都没看到 | §5.3 |
| 插件自己问人（2026-10-12，探针） | 能：`tool.call` 钩子里调用 `$.ui.ask(问题, 选项)`，auto 模式下也问到人，返回所选选项的原文；钩子据此返回 `{ deny }` 时调用不执行，模型以工具错误的形式收到这段理由；放行时调用照常执行 | §5.3、§8.4 |
| 界面元素与工具表（2026-10-12，读 2.1.295 的插件 API 声明） | 各界面都有 `Box` `Text` `Button` `Link` `Code` `Markdown`，没有标签元素；`AbovePrompt` 只在终端与桌面出现，`Pane` 各界面都有；原生构建的工具表里没有 `Grep`、`Glob`；`Bash` 结果可带 `gitOperation`、`backgroundTaskId`、`returnCodeInterpretation` | §8.1、§8.2、§8.4 |
| 状态带能否放按钮（2026-10-13，读 2.1.295 的声明） | 能：`AbovePrompt` 的元素表含 `Button`、`Input`、`Select`。桌面画原生按钮；终端画 `[ 标签 ]`，`plain` 时画 `1: 标签`，`hotkey`（一位数字或小写字母）只在状态带持有焦点时生效（ctrl+x tab 或点一下），空输入框里的裸数字也能按状态带的按钮。`variant: "primary"` 标主动作；`maxRows` 以内整条显示，更高的滚动 | §8.1 |
| 面板能画什么（2026-10-13） | `Box` `Text` `Button` `Input` `Select` `Link` `Code` `Markdown`；桌面、VS Code、手机另有 `Svg`（终端没有，所以 G 标用红色文字）；对话框式面板用 `$.ui.open({ id, focus, closeOnEscape, holdToasts, rows })`，Esc 关掉；`Input` 的 `onSubmit`、`Select` 的 `onSelect` 在插件自己的环境里跑 | §8.2 |
| 提醒与设置（2026-10-13） | `$.ui.notify(text, { title })` 走用户自己的通知渠道（回 `{ isSent, channel }` 或原因）；`$.ui.toast` 右上角几秒；`$.store` 是插件自己的 JSON 文件，跨会话、跨热重载；`$.env.get("LANG")` 可读系统语言 | §8.6、§8.7 |
| prompt 历史（2026-10-13，读 2.1.295 的声明） | `$.session.messages()` 给最近 4096 条 user/assistant 消息（`role`、`text`、`toolUses`），没有时间戳与 id，所以会话页的列表由 hooks 模块在 `prompt.submit` 时自己记。对话行有 id：`session.append` 事件每存一行带 `uuid`（声明说与记录文件里的、之后每次读到的一致），`door: "prompt"` 是人的 prompt 那一行；`$.ui.scroll({ to: { requestId: <uuid> } })` 能滚到对话里那一行，只在插件回应人自己的输入时（按键算），否则 `{ deny: "not person-initiated" }`。没有删除或拆分会话记录的接口：记录文件在 `<config>/projects/<项目>/<会话>.jsonl`，桌面端的会话列表另在 `claude-code-sessions/<账号>/<组织>/local_*.json`、只在启动时读。拆分由插件随附的 split-session skill 在模型手里做：按活动链分轮，压缩钉住的轮不动，先备份再改写，克隆桌面端条目；自动模式的分类器把插件代码里改写会话记录文件的编辑判为 Session Transcript Tampering，看板因此不自己改文件 | §8.2 会话页 |
| DeepSeek Harness 的浏览器半边与网关（2026-10-13，dsh 0.1.5-rc.2 的 web profile 实测） | 包的 `dsh.client`（`platform: "web"`、`inject`）加 `exports["./client"]` 声明浏览器 bundle；dsh-client-modules 只为裸包名或路径命名的 loader 行找 manifest（`exactPackageSpecifier`），子路径行（`@geml/gemflow/dsh`）得不到包、不进 `window.__DSH_BOOT__`；dsh-app-boot 把 patch 里 `./` 开头的行名锚在 patch 文件旁改成 `file:` URL（`anchorInsertedPluginNames`）。右侧栏按会话：`sidebarRightTabs.register({ id, kind, title, guide })` 注册类型，引导页列出它，`slots.inject("sidebar.right.pane.tab")` 给正文（props 带 `sessionId`、`useTabInfo`）。宿主路由：`ctx.inject(["webServer"], …)` 之后 `webServer.register({ kind: "prefix", path, handler })`。网关协议：`POST /api/<ns>/<method>`，body `{ type: "client-request", rpcId, method: "<ns>/<method>", payload: { args: { request } } }`，答 `{ result: { ok, value | error } }`；`workspace/create { path }`、`session/create { workspaceId }`、`session/openWorkspacePath { path, action?: "reveal" }` 都这样调（web GUI 的「添加工作区」开的是原生目录对话框）。http 页面里的 `file:` 链接浏览器不开 | §8.10 |
| 面板画矢量图（2026-10-14，读 2.1.295 的声明） | `Svg` 元素：`source`（整份 `<svg>…</svg>`，至多 131072 字符）、`alt`（必填）、`width` / `height` 可选、`isInteractive`（放进无脚本的沙箱帧，hover、CSS 动画、`<title>` 提示才生效；不设则按图片画）；桌面、编辑器、手机有，终端没有。它是叶子：点击只能挂在外面的 `Button` 上，而 `Button` 只收文字子元素；`Client` 区域收得到指针坐标，但它的元素表里没有 `Svg`。所以图上某条边要能按，只能用面板自己的元素从模型画（§8.2） | §8.2 |
| Codex 插件的 MCP 服务器与 hooks 的实际输入（2026-10-21，Codex CLI 0.149.0，`codex exec` 接本地的假 Responses 服务，`CODEX_HOME` 放在临时目录，PATH 前置一个记参数的 `node` 垫片） | 服务器参数里的 `${PLUGIN_ROOT}` 原样传给进程，环境里也没有 `PLUGIN_ROOT`；`cwd: "."`（或 `${PLUGIN_ROOT}`）解析到插件目录，命令里 `./` 开头的路径没有 `cwd` 时按会话目录解析；服务器的环境只剩 HOME、PATH、PWD、SHELL、USER、LOGNAME、TMPDIR 等几项；`initialize` 不带 `roots`；`tools/call` 的 `_meta["x-codex-turn-metadata"]` 带 `session_id`、`turn_id` 与 `workspaces`（以会话的工作区路径为键）。模型的 `exec_command` 到 hooks 是 `tool_name: "Bash"`、`tool_input: { command }`；PostToolUse 里 Bash 的 `tool_response` 是输出的一个字符串，没有退出码，`tool_input` 是 PreToolUse 改写后的。包命令端到端成立：`npm test` 被包上，输出末尾带 `[gemflow exit 0]`，`tests-pass` 记为真。插件 MCP 工具在 `codex exec` 里要 `--dangerously-bypass-approvals-and-sandbox` 或别的批准设置，否则答 "requires approval" | §8.9 |
| 出处 | `plugin-authoring` skill（用 Skill 工具载入）：它的 `types/claude-code.d.ts` 是本构建的全部插件 API（约两万行），grep `AbovePrompt: {`、`Pane: {`、`export type ButtonProps`、`export type Elements`、`^      ui: {` 直达声明；`examples/` 里有 band.tsx、pane.tsx、tool-call.ts；`reference.md` 是长篇。插件被引擎加载过之后，同一份声明也落在插件目录的 `.claude-plugin/types/` | — |

待确认：

1. 桌面 app 分屏时，面板是否与状态带一样只在左栏出现。
2. Codex 上真模型看到输出末尾的 `[gemflow exit N]` 会不会被干扰：要一个真模型的会话才看得到（假服务只证明了标记的往返）。

## 13. 已拍板（2026-10-11）

1. 包与目录：`integrations/gemflow/`，`@geml/gemflow`，CLI `gemflow`，发布在 geml marketplace。
2. journal 默认 gitignore，流程定义、backlog 与 `.geml/gemflow.geml` 提交进仓库。
3. Stagehand 预算默认 16 KB。
4. 开发流程的五个状态与两个封路点（§7）。
5. 视频流程与开发流程同期交付（§7.2）；工作项单位由流程的 `flow-unit` 声明。
6. 状态机是一个 `geml-statechart` 图块，格式是独立的词汇表，图由定义画出（2026-10-12，§4）。
7. 词汇最少：Gemflow 只在节点、变量、转换上挂 `prompt`、`skills`、`tools`、`source`、`approval`、`note`，meta 只有 `flow-unit`；journal 与上下文文档用核心 `data`、`text` 块（2026-10-12，§4）。
8. 插进来的无关事按每次调用归属，不做按输入分类、不做岔出去动词；两种单位的流程并行待讨论（2026-10-12，§5.7）。
9. 工具的权限、首选与默认参数记在工具词典里，在使用中由你的选择长出来，插件自己问（2026-10-12，§5.3）。
10. 流程写用途不写工具；词典把用途绑到项目的工具；一个用途只在声明了它的状态里能用（2026-10-12，§4.2、§5.3）。
11. 三种通行要求，三种判断者：对象由机器判、一句话由模型判、`approval` 由人判（2026-10-12，§4.2）。
12. 有通行要求的机器判边自动走；`tool` 证据随工作内容过期（2026-10-12）。
13. 时间证据 `elapsed`：第六种 `source`，量当前状态停留了多久，超时作为通行要求读；level-triggered，没有事件队列（2026-10-13，§4.2、§5.2）。
14. 终态显式：状态对象 `final: true`，一张图可以有几个，格式检查终态有出边（error）与没标终态却没有出边（warning）；`initial` 保持单个 id；进了终态工作项关闭，人 `rollback` 重开（2026-10-13，§4.2、§5.1）。
