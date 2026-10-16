# Gemflow D — the transitions are a table, and a workflow carries its own Mermaid diagram

日期：2026-10-12 · 分支：`feat/geml-agent-runtime` · 前置：`docs/design/specs/2026-10-11-gemflow-design.md` §4

## 目标

1. 边不再是一种块类型。`flow-transition` 块从 `geml-flow/v1` 删除，一份流程的全部边写在一张普通 `table` 里，meta `flow-transitions` 指向它——与信号表（`flow-signals`）同一种写法。
2. 流程文档自带一张 Mermaid 状态图（GEML 核心 `diagram` 块），`gemflow check` 拿它对照边表；不设导出命令。

不留兼容：旧的 `flow-transition` 块不再被任何解析器或运行时认识（词汇表从未发布）。

## 边表

```geml
=== meta
profile          = "geml-flow/v1"
flow-transitions = "#transitions"
===

=== table {#transitions caption="转换"}
| id         | from     | to       | kind     | requires          | resets                  | note |
|------------|----------|----------|----------|-------------------|-------------------------|------|
| to-review  | #build   | #review  | auto     | #ready-for-review |                         | 测试通过且 PR 已开；或 PR 已合并；或有人勾选了 ready。 |
| rework     | #review  | #build   |          |                   | tests-pass review-ready | review 要求改动。测试结果和 ready 的勾选随之清掉。 |
| to-release | #deploy  | #release | approval |                   |                         | 上线 production 需要一个人此刻同意。 |
===
```

| 列 | 必需 | 含义 |
|---|---|---|
| `id` | 是 | 边的名字：GEML NAME（Unicode 字母、数字、`_`、`-`），表内不重复 |
| `from`、`to` | 是 | `#状态` |
| `kind` | 否 | 空：模型或人手动走；`auto`：守卫成立即自动走；`approval`：只有人能走，从不自动走。只能取其一 |
| `requires` | 否 | 空，或 `#id` 指向一个 `data` 块（JSON Schema 守卫） |
| `resets` | 否 | 空格分隔的变量名，走这条边时回到 `flow-vars` 的 `default` |
| `note` | 否 | 交给模型的这条边的说明（取代原来块的正文） |

表的读法与信号表相同：列名不分大小写；不得有其他列、空列名或重复列；单元格恰为一个行内代码时取代码里的文本。没有 `flow-transitions` 的流程没有边。

`auto` 与 `approval` 现在互斥，写不出「既 auto 又 approval」，所以 `flow-auto-approval` 删除；也写不出「`resets` 不带值」，所以那一种 `flow-resets-var` 情形删除。

### 静态检查

| id | 级别 | 条件 |
|---|---|---|
| `flow-transitions-table`（新） | error | `flow-transitions` 指向的块不存在、不是 `table`、没有表头，缺必需列，有 `id from to kind requires resets note` 之外的列，空列名或列名重复 |
| `flow-transition-id`（新） | error | `id` 为空、不是 NAME，或与前面的行重复 |
| `flow-transition-kind`（新） | error | `kind` 不是空、`auto`、`approval` 之一 |
| `flow-bad-ref` | error | `from`/`to` 不是 `#状态` 或状态不存在；`requires` 不是 `#id` 或不指向 `data` 块 |
| `flow-requires-schema`、`flow-resets-var`、`flow-resets-default`、`flow-final-outgoing`、`flow-dup-edge`、`flow-auto-requires`、`flow-auto-ambiguous`、`flow-auto-cycle`、`flow-unreachable`、`flow-dead-end` | 不变 | 判断不变，消息里写 `transition <id>`（不再带 `#`），行号取该行所在行 |

诊断消息里，边写作 `transition to-review`，行号是表中那一行。

## 流程里的 Mermaid 图

流程文档自带一张图：GEML 的核心块 `=== diagram {#graph format=mermaid}`，内容是 Mermaid `stateDiagram-v2`。不另设导出命令——HTML 渲染、viewer 与 `--to md`（GitHub 上渲染成图）都直接画它。图是给人看的视图，运行时不读它；`gemflow check` 拿它对照边表，防止两份说法分叉：

```geml
=== diagram {#graph format=mermaid caption="开发流程"}
stateDiagram-v2
    [*] --> build
    build --> review : auto · ready-for-review
    review --> build : rework
    review --> deploy : auto · merged-green
    deploy --> release : approval
    release --> done : auto · prod-live
    done --> [*]
===
```

- 状态直接用状态 id；Mermaid 认不了的 id（比如带 `-` 的）用 `state "wait-human" as waitHuman` 起别名，检查按别名解析回状态 id。
- 标签写法是约定，不检查：`kind` 不为空时以它开头，其后 ` · <守卫 id>`；手动边写边的 `id`。标签里不写 `#`（Mermaid 会当成实体编码的开头）。
- 只认 `stateDiagram`／`stateDiagram-v2` 的这几种行：`A --> B`（可带 ` : 标签`）、`[*] --> A`、`A --> [*]`、`state "名字" as 别名`；其余行（`classDef`、`note`、注释 `%%`）忽略。

### 静态检查

| id | 级别 | 条件 |
|---|---|---|
| `flow-diagram`（新） | warning | 文档里有 `format=mermaid` 且内容以 `stateDiagram` 开头的 `diagram` 块时：图里的一条状态间的边在边表里没有（按 from→to）、边表的一条边图里没有、图里出现不存在的状态、`[*] -->` 指向的不是初始状态、`--> [*]` 出发的不是终态。没有这样的块不检查 |

## 任务

1. **运行时与解析器**（一个提交）
   - `geml-parser/src/profiles.ts`、`geml-parser-rs/src/vocab.rs`：删 `flow-transition`（类型、正文、属性），加 meta 键 `flow-transitions`；更新注释。`geml-parser/test/profiles.test.mjs` 与 Rust 测试跟上；`spec/profiles/geml-flow/conformance.json` 里涉及 `flow-transition` 的用例改写。
   - `integrations/gemflow/src/core/statechart.ts`：按上表读边表（复用信号表的表头/单元格读法，抽一个共用函数）；`Transition.body` 改名 `note`，`prompt.ts`、`tools.ts` 等使用处跟上；新增三个码，删 `flow-auto-approval`。
   - `spec/profiles/geml-flow/checks.json`：所有用例改写为边表；删 auto-approval 与 bare-resets 用例；为三个新码和表结构错误各加用例（缺块、不是表、缺列、未知列、重复列、空 id、非 NAME id、重复 id、坏 kind）。
   - 四个内置流程（`workflows/{coding,dev,refund,video}/flow.geml`）、测试夹具（`test/fixtures/parity/flow.geml`、`ws-dev/flow.geml`、`refund.geml`）与所有测试里的内联流程改写为边表。
   - CHANGELOG `[Unreleased]` 一条。
   - 验收：`geml-parser` 下 `npm run build && node test/all.mjs`；`geml-parser-rs` 下 `cargo test --quiet`、`cargo fmt --check`、`cargo clippy --all-targets --features wasm -- -D warnings`；`integrations/gemflow` 下 `npm test`（含打包）；`git grep flow-transition` 只剩 `docs/design/plans/` 与本计划要改的文档。
2. **流程里的图**（一个提交）：`src/core/diagram.ts`（纯函数：读 Mermaid 子集、对照边表）接进 `loadStatechart` 的检查；`checks.json` 为 `flow-diagram` 的每种情形加用例；四个内置流程各加一个 `#graph` 图块（放在 meta 之后），且 `gemflow check` 对它们无告警。
3. **文档**（一个提交）：`spec/profiles/geml-flow/geml-flow-profile{,_CN}.md`、`docs/design/specs/2026-10-11-gemflow-design.md` §4、`integrations/gemflow/README{,.zh}.md`（示例流程带上边表与图块）、`skills/gemflow/SKILL.md` 与 `spec/profiles/README.md` 中提到 `flow-transition` 的地方。只写现行规则。
