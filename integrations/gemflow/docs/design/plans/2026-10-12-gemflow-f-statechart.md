# Gemflow F — 状态机格式：解析器模块与 gemflow 迁移

日期：2026-10-12 · 分支：`feat/geml-agent-runtime` · 前置：`docs/design/specs/2026-10-11-gemflow-design.md` §4、§5；`spec/profiles/geml-statechart/`、`spec/profiles/geml-flow/`（已推送，`6f0548c`、`c78028e`）

## 问题

文档与注册表已经是新设计：一份流程是一个 `diagram {format=geml-statechart}` 块，节点、转换、通行要求、动作、条件变量都在它的 JSON 正文里；Gemflow 在节点上挂 `prompt`/`skills`/`tools`（用途），在条件变量上挂 `source`，在转换上挂 `approval`；工具词典按用途绑定本项目的工具。代码还停在旧形状：`flow-state` 块、`flow-vars`/`flow-transitions` meta 键、正则匹配的命令信号、`only-in`。注册表一改，gemflow 包的套件 758 个里挂 115 个（`checks.json` 的用例、"无诊断"的断言）。解析器也还不认识这个格式：`geml check` 不做 `statechart-*` 检查，`--to html` 把正文当源码显示，`--to md` 原样输出 JSON。

## 设计

### a. 解析器：`geml-statechart` 模块（`geml-parser/src/statechart.ts`）

- `buildStatechart(block, doc)`：读正文（JSON），或 `data=` 指向的 `data` 块的值；按 geml-statechart §2、§3 校验，返回 `{ model, diagnostics }`。模型：`initial`；`states: Map<id, { title, description, attrs }>`；`vars: Map<name, { default, attrs }>`；`transitions: [{ index, from, to, guard?: { kind: "schema" | "ref" | "text", value }, actions, attrs }]`；每条转换的 `reads`（对象与引用通行要求读到的变量名）；`current`。
- 通行要求是对象或引用时，按 §4 的子集校验 JSON Schema；引用解析成本文档或别的文档里的 `data` 块。
- `statechart-check.ts`：`checkStatechart(doc, host)` 对文档里每个该格式的块跑 `buildStatechart`，按地址报 `statechart-*`（与 `media-check.ts` 同形）。`cli.ts` 的词汇表检查表加两行：`geml-statechart/v1` 与 `geml-flow/v1` 都指向它（geml-flow 放行这个格式、以 geml-statechart 为准）。
- 用例钉在 `spec/profiles/geml-statechart/checks.json`，`geml-parser/test/statechart.test.mjs` 逐例重放（形状同 geml-flow 的 `checks.json`：meta 行、正文、期望的 `severity:code` 列表）。

### b. 解析器：画法与投影

- `statechart-render.ts`：宿主注册的 `DiagramRenderer`（与 `codemap-render.ts` 同一机制），`--to html`、`geml serve`、viewer 都注册。MVP 画法：由模型生成 Mermaid `stateDiagram-v2` 交给页面已有的 Mermaid 运行时画图；图下面是静态的两张清单——每个状态一个 `<details>`（title、description、属性、出入边），每条转换一个 `<details>`（通行要求按 §4 读成人话、动作、属性）。点开即看，不需要新的运行时脚本。`current=` 的状态在图里加粗、清单里标出。
- `--to md`：`geml-statechart` 投影成 Mermaid 围栏（§2.7），GitHub 直接画；属性不进投影。
- 没注册渲染器的处理器按 §7 回退为源码块，不是错误。

### c. gemflow 迁移

1. `src/core/statechart.ts`：经解析器的 `buildStatechart` 取模型，再做 §4.3 的 `flow-*` 检查（`flow-attr`、`flow-source`、`flow-dup-edge`、`flow-auto-ambiguous`、`flow-auto-cycle`、`flow-unit`、`flow-tools`）。删掉旧的章节/边表/`flow-vars` 读取、Mermaid 对照（`diagram.ts`）。
2. 条件变量与证据（`signals.ts`）：`source` 的五种写法；`tool` 证据——绑到用途的调用结束时写入（命令看退出码，其他工具看 `isError`）；正则匹配与 `only-in` 删除；用途封路按词典的键在整行查找（`command-line.ts` 的扫描保留，匹配改为模式键：`*` 任意一段、无 `*` 为前缀、字面最长优先）。
3. 工具词典（`tools.ts`）：`for` 列绑用途；判定按 §5.3 的七步（逐键判，有拒整拒）；学习的问题加"这是 <用途>"；起步词典随内置流程。
4. 三种通行要求（`supervisor.ts`、`verbs.ts`）：对象/引用由机器判、自动走；一句话交给模型、`move` 走；`approval` 由人走；`move` 不走机器判的边。
5. journal（`journal.ts`、`snapshot.ts`）：`#journal`、`#rev-N`、`#refused-N` 核心 `data` 块；去掉 `flow-snapshot` 与 `flow-*` meta 键。
6. Stagehand（`stagehand.ts`、`prompt.ts`）：`description` + `prompt`（章节或整份文档）+ skills + 用途与绑定的工具 + 条件变量当前值 + 出边（机器判的列缺的变量，一句话的给原文，要批准的标出）。
7. 宿主：Claude Code 快路径按用途与词典键（`hosts/claude-code/`）；dsh、pi 适配器接用途封路；MCP 三个工具不变。
8. `spec/profiles/geml-flow/checks.json` 按 `flow-*` 重写；`test/*.mjs` 跟着改。

### d. 内置流程

`workflows/dev`、`coding`、`refund`、`video` 各改成一个状态机块（dev 即 spec §4.1），各带起步词典 `tools.geml`（dev：`test`、`pr`、`deploy-staging`、`deploy-prod` 的常见写法；video：`todo-check`、`stale-check`、`render` 绑 `geml media …` 的模式键）；`guide.geml` 是 `prompt` 指向的提示词文档。

### e. 文档

`integrations/gemflow/README.md`、`README.zh.md`、`skills/gemflow/SKILL.md`、CHANGELOG。

## 任务

| # | 任务 | 文件 | 完成标志 |
|---|---|---|---|
| 1 | 解析器 statechart 模块与检查 | `geml-parser/src/statechart.ts`、`statechart-check.ts`、`cli.ts`；`spec/profiles/geml-statechart/checks.json`；`test/statechart.test.mjs` | `geml check` 对 spec §4.1 的例子无诊断；checks.json 每例重放通过；`node test/all.mjs` 全绿 |
| 2 | 画法与投影 | `statechart-render.ts`、`to-md.ts`、`cli.ts`（`--to html`、`serve`）、viewer `parse-entry.js` | `--to html` 出图与清单；`--to md` 出 Mermaid 围栏；viewer 的 esbuild 门过 |
| 3 | gemflow 核心迁移（c.1–c.8） | `integrations/gemflow/src/**`、`test/**`、`spec/profiles/geml-flow/checks.json` | `npm test` 全绿 |
| 4 | 内置流程与起步词典 | `integrations/gemflow/workflows/**` | 四个流程 `gemflow check` 无诊断；dev 流程端到端测试过 |
| 5 | 文档 | README 两份、SKILL.md、CHANGELOG | — |

1、2 先做，3 依赖 1；4 与 3 同步；5 最后。按 MVP 节奏：功能端到端、套件绿，评审与加固之后。

## 待办（MVP 之后）

- Rust 解析器的 `statechart-*` 检查（`geml-parser-rs/src/check/statechart.rs`），之后把 `checks` 用例并进 `spec/profiles/geml-statechart/conformance.json`，两个运行器一起跑。
- HTML 的点开面板：带运行时脚本的交互版（点图上的节点展开），MVP 是静态 `<details>`。
- 层级、并行、事件、`set`：geml-statechart v2。
- 计划 E「待办」里的 15 条归属问题；Windows 上挂的 5 个测试。
- 工具偏好的个人层；命令的默认参数；`ci-success` 按 workflow 名筛。
