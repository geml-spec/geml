# GEML Agent Runtime — 发布交接清单

日期：2026-09-15 · 分支 `feat/geml-agent-runtime`（未合并、未推送）
设计：[`../specs/2026-09-14-geml-agent-runtime-design.md`](../specs/2026-09-14-geml-agent-runtime-design.md) ·
A 期计划：[`2026-09-14-geml-agent-runtime-phase-a.md`](2026-09-14-geml-agent-runtime-phase-a.md) ·
B 期计划：[`2026-09-15-geml-agent-runtime-phase-b.md`](2026-09-15-geml-agent-runtime-phase-b.md)

A、B、C 三期的**仓内工作已全部完成**。这份文档只列**仓外的、必须由人执行的**步骤，以及它们之间的顺序依赖。每一条都是不可逆或对外可见的，所以没有一条是我能替你做的。

## 0. 为什么不能直接 publish

`@geml/agent-runtime` 的 `dependencies` 现在写的是：

```json
"@geml/geml": "file:../../geml-parser"
```

`geml-agent/v1` profile 住在解析器里（`geml-parser/src/profiles.ts`），所以运行时必须依赖一个**已发布且登记了该 profile 的**解析器版本。一条 `file:` 依赖发到 npm 上，别人装下来会是空的。

因此顺序是死的：**先发解析器，再改依赖，再发运行时。**

## 1. 发解析器（含 `geml-agent/v1`）

解析器当前版本 `1.10.3`，工作区里已有 `geml-agent/v1` 的注册与文档，但**版本没动**——发版时机是你的决定，我没有替你 bump。

按 [`docs/PUBLISHING.geml` 的 `#a-parser`](../../PUBLISHING.md) 走。要点重述（版本号动八个地方，不是两个）：

| 文件 | 处数 |
|---|---|
| `geml-parser/package.json` | 1 |
| `geml-parser/server.json` | 2（MCP registry 按它作键，过期会报 "duplicate version"） |
| `geml-parser/package-lock.json` | 2 |
| `integrations/claude-plugin` / `integrations/codex-plugin` 的清单 | 各 1 |
| 根 `gemini-extension.json` | 1 |
| `integrations/grok-plugin/.grok-plugin/plugin.json` | 1 |

`PARSER_VERSION` 是运行时读的，**永远不要手改**。同一个提交里补 `CHANGELOG.md`。

建议版本：`1.11.0`（新增 profile 是 feature，走 minor）。

- [ ] 八处版本 + CHANGELOG，一个提交
- [ ] `cd geml-parser && npm test`（全量，约 230 s）
- [ ] 发布，并 `npm view @geml/geml version` 确认

## 2. 把运行时的依赖换成版本范围

解析器发出去之后，且**只有在那之后**：

- [ ] `integrations/geml-agent-runtime/package.json`：`"@geml/geml": "file:../../geml-parser"` → `"^1.11.0"`（填实际发布的版本）
- [ ] `cd integrations/geml-agent-runtime && npm install && npm test` —— 131 条必须全绿，且这一次跑的是**从 npm 装下来的**解析器，不是本地链接
- [ ] 提交

这一步是整条链上唯一会"看起来没事但其实断了"的地方：本地链接一直能跑，换成版本范围之后如果解析器没带 profile，`geml check` 会开始报 `unknown-block-type`，示例状态图会失败。上面那次 `npm test` 就是为了抓这个。

## 3. 发运行时

- [ ] `npm run build`（`files` 里发的是 `dist/`，源码不发）
- [ ] `npm test` 一次，确认跑的是构建产物
- [ ] `npm publish`，起始版本 `0.1.0`
- [ ] `npm view @geml/agent-runtime version` 确认
- [ ] **同一个 tarball 也是一个 pi package**，发完顺手验一下另一条路：`pi install npm:@geml/agent-runtime@0.1.0`，然后在一个放了 `agent.geml` 的目录里起 `pi`，确认三个 `agent_*` 工具在、别的工具按状态收窄。装不上多半是 `pi` 清单路径（`pi.extensions` 指向 `dist/`，所以必须先 build）或者 peer 范围（pi agent 要求它自己的包写 `"*"` 且不打包）。
- [ ] pi.dev 的 package gallery 按 `pi-package` 这个 keyword 收录（已加）。愿意的话可以在 `pi` 清单里加 `image`/`video` 做预览图——**这是对外露出，发之前你自己定**。

## 4. 改名善后（对外可见，按顺序）

- [ ] `npm deprecate @geml/dsh-plugin "renamed to @geml/agent-runtime"` —— npm 没有别名，deprecate 是唯一能把人引到新包的机制。已经装了旧包的人要手动 `dsh plugin remove @geml/dsh-plugin` 再 `add @geml/agent-runtime`。
- [ ] **awesome-dsh-plugin 列表 PR**：条目（`data/plugins`，原 PR #1310）是按 `integrations/dsh-plugin` 这个路径作键的，而该路径已不存在。要改成 `integrations/geml-agent-runtime`，顺便更新描述——这个 bundle 现在带监督器，不只是 MCP server 加技能。dshmarket 读这份列表。
- [ ] 改完之前，两个 README 里我已经**去掉了** dshmarket / awesome-dsh-plugin 的链接（它们按旧路径构造，现在是坏的）。列表 PR 合并后可以加回去，用新路径。

## 5. 合并前必做的一件事

- [ ] **开 PR 让三平台 CI 判。** 这条分支新增了 `agent-runtime` 这个 job，跑 ubuntu / macos / windows 三平台，但它**一次都没在 CI 上跑过**——本地只在 Windows 上绿过。仓库自己的规矩就是「Windows 绿不算证据」。

## 还没做、且知道没做的

- **接真实模型的端到端**：需要 DeepSeek API key。插件与 CLI 的互通已用 testkit 的真 agent 验过（模型走完退款流、台账被 `verify` 通过），但没有一次真实模型对话。README 里没有任何地方声称做过。
- **pi agent 上没跑过真 `pi`**：适配器是对着 `@earendil-works/pi-coding-agent@0.85.1` 的 `.d.ts` 与随包文档写的，测试用的是按它的管线顺序、并且用它自己的 typebox 校验器跑的替身，`pi-parity` 再拿真包的声明钉住形状。三件事只能在真 `pi` 上看：① 每次跃迁换活跃工具集对提示词前缀缓存的代价（它的文档说非增量替换会重发整表、可能失效）；② `hasUI` 为假时 `ctx.ui.confirm` 是抛还是返回默认值（我们两种都按拒处理，但语义要确认）；③ fork 之后 `getBranch()` 给的是分支还是整棵树（哈希链的 `parent` 按它返回的东西算，错了 `geml-agent verify` 会抓到）。README 的两个语言版本都写了这三条。
- **`run --statechart`**：设计 §7 提过，依赖 dsh 的 `--patch` 覆盖层，那个 flag 的确切用法我没核实，所以 `run` 只支持默认的 `agent.geml`（cwd），这也正是 bundle 配置里写的。
- **把快照镜像进会话日志**：设计 §1.3 那条硬约束还在（DSH 不让仓外插件写自定义会话事件），等上游开了 `ignorable` 的写入口再说。
