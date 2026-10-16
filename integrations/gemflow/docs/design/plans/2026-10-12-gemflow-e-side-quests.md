# Gemflow E — 岔出去再回来：工作项的边界

日期：2026-10-12 · 分支：`feat/geml-agent-runtime` · 前置：`docs/design/specs/2026-10-11-gemflow-design.md` §5、§8；计划 D（边表）已完成

## 问题

做 A 的途中插进来一件无关的事（agent 发现 B 文档没修订、C 有 bug，用户要 rebase、开 PR），做完要回到 A 原来的状态，并且 A 的状态与变量不被那件事改动。

Gemflow 以工作项为隔离单位：每个工作项一本 journal、一份变量。插进来的事落在另一个工作项上（另一个分支、另一集）时，回得来也不串（已实测）。串与卡住都出在下面几处（实测见 `scratchpad/sidequest/probe.mjs`）：

| 情形 | 现状 |
|---|---|
| 在 worktree 里做、子 agent 用隔离 worktree、`cd 别处 && npm test` | 串：插件的项目根在会话开始时定死，命令在别处跑出的退出码写进当前工作项 |
| 视频流程顺手改了另一集 | 串：当前工作项是最近写入的那一集，对 ep02 跑的检查记进了 ep03 |
| 换了工作项 | 当轮模型拿不到新工作项的阶段说明，切回来也没有 |
| rebase、测完又改代码 | 证据过期：`tests-pass` 仍为 true |
| 插进来的事要用另一种流程 | 一个项目只有一个当前流程，`use` 是全局的 |
| A 处在 strict 状态 | 卡住：连 `git switch` 都被拒，没有出口 |

不做：按每次用户输入判断"属于哪个流程"。理由：插进来的事一半是 agent 途中发现的，输入时判断不到；判断本身不隔离，隔离靠活落在哪里；它是模型判断，违背"凭事实推进"；成本与宿主可移植性。

## 实测（2026-10-12，Claude Code 2.1.295，探针插件记录每次 `tool.call`）

- `tool.call` 的输入只有工具参数、`tool`、`tool_use_id`，子 agent 的调用另带 `agentId`；没有 cwd。
- **`$.session.cwd()` 在钩子里读，答的是这次调用所在的循环的目录**：主循环是 shell 当前目录（上一次调用里 `cd` 留下的，调用开始时读到）；普通子 agent 是父会话的目录；**隔离 worktree 的子 agent 是它的 worktree**（`<项目>/.claude/worktrees/agent-<id>`，分支 `worktree-agent-<id>`，位于项目目录之内，是另一个 git 检出）。
- 同一次调用里命令自己的 `cd` 不会让 `$.session.cwd()` 变化（调用结束后才更新），所以命令开头的 `cd` 要自己读。
- `$.session.root()` 始终是会话的项目根，不随 shell `cd`、也不随子 agent 的 worktree 变。
- `cd` 到项目之外，harness 当即把 shell 目录重置回项目根。
- Agent 工具调用的输入带 `isolation: "worktree"`；`agent.spawn` 的结果带 `agentId`。

## 设计

### a. 按每次调用归属

1. **调用的起始目录**：hooks 模块在每次 `tool.call` 进入时（`next` 之前）读 `$.session.cwd()`，随 `before`/`after` 请求发给 CLI（新字段 `cwd`，绝对路径）。
2. **每条简单命令的目录**：起始目录，加上 `&&` 链里它之前的每个 `cd <路径>`（纯函数 `commandDirs`，在 `src/core/command-line.ts`）。`cd` 的参数含展开（`$`、`~`、反引号）、是 `-` 或缺省时，这条命令及其后的目录未知。
3. **目录属于哪个检出**：`git -C <dir> rev-parse --show-toplevel`，与会话检出比较。写文件的工具（Edit、Write、NotebookEdit）按文件所在目录判断。
4. **归属规则**（命令信号、文件信号、偏离、拒绝都按它）：
   - 会话检出（含其子目录）→ 当前工作项，与今天相同。
   - 另一个检出，且它找得到流程（`resolveWorkflow` 按它自己的根）→ 那个检出的当前工作项：它的分支、它那份流程。
   - 别处（另一个没有流程的仓库、不在任何仓库里且不在项目内）→ 不归任何工作项：不写信号、不记偏离；只有人专属命令照拒。
   - 目录未知 → 不写信号；闸照当前工作项判断（与今天相同）。
5. **journal 的位置**：仓库的主工作树（`git rev-parse --path-format=absolute --git-common-dir` 的上一级）的 `.geml/journals/`，所有检出共用：同一个分支在哪个检出里做都是同一本 journal，worktree 删掉记录也还在。不在 git 里的项目用项目根。上下文文档 `.geml/context.geml` 仍按检出各一份。
6. **按需建 journal**：路由到别的检出的观察，只有真要记点什么（信号写入、拒绝、偏离）时才打开并建那本 journal；只跑了 `pwd` 的子 agent 不留 journal。
7. **file 单位**：命令信号记在命令行里写到的那一集（相对命令目录解析、匹配单位的 glob）；写到不止一集就不记；一集都没写才退回"最近写入的那一集"。
8. **快路径**：hooks 模块判断调用是否"落在别处"：从起始目录（写文件的工具用文件目录）往上直到项目根，用 `$.fs.stat` 找 `.git`（结果按目录缓存）；找到，或目录在项目根之外，或命令行里有 `cd`，就请 CLI 定夺（`before` 与 `after` 都请），不按当前工作项的策略快照放行。`fastpath-parity` 测试跟上。

### b. 换工作项当场交接

一次请求的应答所在的工作项，与上次交给主循环的上下文（`item@rev` 记号）不是同一个时，hooks 模块把新工作项的阶段说明放进这次工具结果的 `context`，前面加一行：

```
[gemflow] now on fix/doc-b · #build (new work item)
[gemflow] back on feat/a · #build · rev 3 · tests ✓ · pr ✗
```

只对主循环（事件没有 `agentId`）；子 agent 的调用照旧只交给子 agent、不记为已交付。行由 CLI 生成（应答新字段 `handoff`），hooks 模块只拼接。

### c. 证据有效期

信号表新增可选列 `until`，取值为空或 `change`：

- `change`：这个信号写下的值，在工作项的内容变了之后回到 `flow-vars` 的默认值。内容的指纹：`branch` 单位是 `HEAD` 加 `git status --porcelain=v1 -z --untracked-files=all` 与其中每个路径的大小、修改时间的哈希；`file` 单位是那一集文件内容的哈希。
- 信号写下非默认值的那个快照带上指纹（`flow-snapshot` 新属性 `tree`）。之后每次对该工作项的操作开始时（持锁），若有 `until = change` 的变量仍是信号写下的非默认值，而指纹变了，就追加一个快照把它们复位：`cause=expire by=signal signal=<第一个复位的信号>`。复位之后照常评估 auto 边。
- 只对 `command` 与 `manual` 信号有效；写在 `git`、`file` 行上是错误（它们本来就按当下的事实重新读）。
- 内置流程：dev 的 `tests`；video 的 `todo-clear`、`fresh`、`rendered`。

静态检查：`flow-signal-until`（error）——值不是空或 `change`，或写在 `git`/`file` 行上。两个解析器的 `flow-snapshot` 属性加 `tree`；`cause` 取值加 `expire`（journal 读取与 `gemflow verify` 接受它）。

### d. 每个工作项记住自己的流程

- 已有 journal 的工作项按 journal 头 `flow-statechart` 记的流程继续；新工作项用项目的当前流程（`flow-workflow`，即默认）。
- `gemflow use <流程>` 只改默认，不再提醒"续不上"；已开始的工作项不受影响。`/gemflow use` 同理。
- journal 记的流程文件不存在时：报错并给出路——恢复那个文件，或把 journal 挪开从默认流程重新开始。
- 当前工作项仍按默认流程的单位解析（`branch` 或 `file:`）；两种单位的流程同时推进是待讨论项（见下）。
- 状态带、看板与 `/gemflow` 显示工作项所用的流程名（与默认不同时）。

### e. strict 状态的出口

只切换工作项的命令行在任何状态都放行：不拒、不记偏离（与"只做搜索的 Bash"同一类规则，监督器判断，快路径用同一个函数）。`&&` 链里每条简单命令都是下列之一：

- `git switch <分支>`、`git switch -c|-C|--create|--force-create <分支> [<起点>]`
- `git checkout -b|-B <分支> [<起点>]`；`git checkout <分支>` 仅当 `<分支>` 是已有的本地分支（CLI 用 git 核实，快路径一律请 CLI）
- `git worktree add [-b|-B <分支>] [--detach] <路径> [<起点>]`
- `cd <路径>`

带其他选项（`-f`、`--force`、`--discard-changes`、`--merge`、`--`、路径参数）的不算。拒绝信息里提示这个出口。注意 `git switch` 会把未提交的改动带过去，这是 git 的行为，文档写明。

### g. 引导

内置流程的 guide（dev、coding、video）与 `skills/gemflow/SKILL.md` 写明：和当前工作项无关的改动，另开分支或 worktree 做（子 agent 可用隔离 worktree）；做完切回来。

### 待讨论（写进设计文档）

两种单位的流程同时推进（dev 走 feat/A 的同时 video 走 ep02）：各流程按自己的单位解析当前工作项，观察按匹配到的信号表分发，状态带并列显示——状态图里的正交区域。d 是它的前提，本期不做。

## 任务（顺序执行，每个任务一个提交，每个之后审查）

1. **归属**（a）：protocol 的 `cwd` 字段与 hooks 模块读 `$.session.cwd()`；`commandDirs`；`host-git` 的检出查询（toplevel、主工作树）；journal 移到主工作树；workspace 按调用路由与按需建 journal；file 单位按命令里写到的那一集；快路径"落在别处"。测试：探针的三个情形各成测试（别处的测试不改 A；worktree 的工作项拿到它；ep02 的检查记在 ep02；写到两集不记），一个子 agent 在隔离 worktree 里的 `before`/`after` 序列，parity 测试跟上。
2. **交接**（b）：bridge 应答 `handoff`，hooks 模块拼接；`tests/hooks.test.ts` 加换分支与切回的事件序列。
3. **有效期**（c）：信号表 `until` 列与检查、两个解析器的 `tree` 属性、`expire`、指纹、复位、内置流程、`checks.json` 与 `conformance.json` 用例。
4. **每个工作项的流程**（d）：workspace、bridge、CLI `use`、看板与状态带。
5. **strict 出口**（e）：`switchesWorkItemOnly`、监督器、快路径、parity。
6. **文档**（g + 全部）：profile 中英文、设计文档（§5 新增一节"工作项的边界"、§8、§12 实测行、待讨论项）、README 中英文、SKILL.md、guide、CHANGELOG。

验收（每个任务）：`integrations/gemflow` 下 `npm test`；动了解析器时 `geml-parser` 下 `npm run build && node test/all.mjs`，`geml-parser-rs` 下 `cargo test --quiet`、`cargo fmt --check`、`cargo clippy --all-targets --features wasm -- -D warnings`；改了 hooks 模块时 `claude plugin validate integrations/gemflow`。

## 待办（MVP 之后）

任务 1（bf98fcd）的对抗性审查查出、MVP 阶段不修的问题（复现脚本在会话 scratchpad 的 `exp*.mjs`）：

1. 另一个检出的工作项不活跃（默认分支、游离 HEAD）、流程载入失败或出错时，连人专属命令都不再拒绝。
2. `cd /tmp && <受限命令>`：命令全在任何检出之外时，`only-in` 与 strict 的拒绝消失（规则应改为：拒绝从严，只在确定属于另一个有活跃工作项的检出时才换用它的闸）。
3. worktree 里的子 agent 调用五个动词，作用在会话的工作项上。
4. `file:` 单位共用 journal，使另一个检出里的同名一集成了会话的那一集（`file:` 单位应按检出各存 journal）。
5. 视频流程的 `only-in` 按当前一集判断，信号却记到命令写到的那一集。
6. 回归：目录"未知"的命令行（非 `&&` 链里带 cd、cd 带选项、Windows 起始目录）连 git 重读、出错回滚、文件信号重读都跳过。
7. 带 `**` 的文件信号遍历进嵌套的 worktree。
8. 同一行里删掉的 worktree 被当成会话的检出。
9. `file:` 单位里写到非本检出剧集的文件时退回当前一集；花括号展开会建出伪工作项。
10. 主工作树的分支没有 `.geml/.gitignore` 时，共用的 journal 不被忽略，`git clean` 会删掉。
11. 性能：带 cd 的命令、隔离 worktree 子 agent 的每次调用都起两次 node、十几个 git 进程（应按检出缓存策略快照）。
12. 粘在 cd 目标上的重定向（`cd w>/dev/null`）读错目录；`npm --prefix`、`git -C` 不跟踪。
13. 经过符号链接时快路径与 CLI 判断不一致；`.git` 缓存不失效。
14. 绝对路径的 `GEMFLOW_STATECHART` 让任何仓库都"有流程"。
15. worktree 会话里 `use` 的提醒指错 journal 位置。
