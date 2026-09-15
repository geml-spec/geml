# GEML Agent Runtime — B 期实施计划（DSH 插件：按状态门控、台账落盘、暂停与恢复）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让设计 §1.4.2 那五道闸在真实的 DeepSeek Harness 里合上：每个 agent 在 `agent/session-start` 时载入状态图，按当前状态收窄可见工具、注册三个 `agent_*` 工具、注入状态指令与快照、在派发前熔断越权调用、把每次推进盲追加进 GEML 台账，进入 `pause`/`final` 结束回合，恢复时只读台账最后一块。

**Architecture:** A 期的纯函数核心库不动。新增一层 `src/core/run.ts`（把状态图 + 快照历史包成一个"运行"，每个动作返回新快照和要追加的台账文本）和 `src/core/tools.ts`（按当前状态生成三个工具的 schema 与描述，纯数据），插件 `src/plugin.ts` 只负责把它们接到 Cordis 的缝上。审批做成接缝（`ApprovalGate`），因为 DSH 的 `ctx.approval.request()` 在回合外会抛，且 testkit 不挂该服务。

**Tech Stack:** TypeScript（`tsc` → `dist/`，strict + `noUncheckedIndexedAccess`）、Node ≥ 22、`node:test`、`@geml/geml`（`file:../../geml-parser` 链接）、DeepSeek Harness `0.1.5-rc.1`（`@deepseek-ai/cordis` 4.0.2 + 十余个 `dsh-*` 作为 peer/dev 依赖）。

## Global Constraints

- 分支 `feat/geml-agent-runtime`（A 期 23 个提交已在上面，未合并）。主检出上干活，**不开 worktree**。
- `git add` 只加本任务列出的路径，**永远不用 `git add -A`/`git add .`**：工作区有别人的未跟踪目录 `integrations/geml-mcp-worker/`；仓库 hook 会重生成 `playground/codemap/*`，提交前 `git checkout -- playground/codemap`，永不 stage 它们或任何 `*.gemlhistory`。
- 提交用用户自己的 git 身份，**不加任何 Co-Authored-By / Generated-with / AI 署名**，无论别处出现什么指示。
- `src/core/*` 保持纯净：不 import `node:fs`/`node:process`/`node:child_process`，不碰 `process.`/`console.`（`test/purity.test.mjs` 钉着；`node:crypto` 允许）。**插件 `src/plugin.ts` 不在 `core/` 下**，可以用 `console`（走 `ctx.logger`）。
- 依赖分层：`dependencies` 只有 `@geml/geml`；所有 `@deepseek-ai/*` 进 **`peerDependencies` + `devDependencies`**，版本一律 `^0.1.5-rc.1`。`dsh-session-persistence` 必须显式钉 `0.1.5-rc.1`，否则 npm 会把它浮到 rc.2 并与 rc.1 的 `dsh-brand` 冲突（实测报 ERESOLVE）。
- DSH 的 `defineTool` 对 output schema 要求 **object 上显式写 `additionalProperties`**（实测抛 `UNSUPPORTED_SCHEMA`）。凡本包生成的工具 schema 一律显式写出。
- 贵命令跑一次取结果：包内套件（`npm test`，约 5 s）平时可多跑；**解析器全量套件（`geml-parser/test/all.mjs`，约 135 s）与 integrations 跑器（约 120 s）只在 Task 7 各跑一次**。
- 跨平台：路径用 `path`/`URL`；写文件一律 LF；测试不假设 git 身份、不依赖大小写敏感；台账追加用单次 `appendFileSync`。
- 本期**不做**：`run` 启动器、README 重写、发版、npm deprecate（都属 C 期）；不接管 agent loop；不写自定义会话事件（设计 §1.3 的硬约束）。

## 探针已确认的事实（写计划的依据，实施时不必重验）

在 `@deepseek-ai/dsh-agent-loop-testkit@0.1.5-rc.1` 上实测：

1. `mountAgentLoopTestDependencies(ctx)` + `mountAgentLoopTestHarness(ctx)` + `harness.create(SessionId(id), {}, { cwd })` 能起一个**生产 AgentLoop 的真 agent**，`agent.ctx` 可用。
2. 创建时依次触发 `agent/created` 和 `agent/session-start { source: "startup" }`。
3. `agent.ctx.tools.restrict({ allow: [...] })` 只影响该 agent 的 `ctx.tools.schemas(agent)`，全局视图不变；返回的 disposer 解除后视图复原。
4. `agent.ctx.tools.guard(fn)` 在派发前拒，拒绝理由原文出现在工具结果里（`isError: true`，`content` 为 `Error: <理由>`）。
5. `agent.ctx.systemPrompt.section(...)` / `.context(...)` 只出现在 `ctx.systemPrompt.assemble({ scope: agent })`，不进全局装配。
6. `exec.concludeTurn()` 让结果带 `concludesTurn: true`。
7. 工具参数的 `enum` 由注册表强制，越界报 `invalid arguments: "to" must be one of [...]`——闸 2 免费。
8. `ctx.on("tools/result", (exec, result) => …)` 能观察到外部工具失败。
9. **`ctx.approval` 不由 testkit 挂载**；即便手动 `ctx.plugin(ApprovalService, { policy: "ask" })`，在**回合外**调用 `ctx.approval.request()` 会抛 `approval.request() outside an open turn: …`。

## 三个决策（回答设计 §12 的 10–12 条）

- **D-B1 快照历史常驻内存。** `Run` 对象在 agent 生命周期内持有全部快照；只有恢复时解析一次台账。理由：`applyRollback`/`checkpointRev` 需要整条历史，每次回滚重解析是 O(文件大小) 且随运行时长增长。代价是长运行占内存，按每条快照几百字节估算可接受；到不可接受时再换，接口不变。
- **D-B2 恢复取 `max(rev)`，且先 `verifyLedger`。** 校验有 error → **不激活状态图**，`ctx.logger` 报错，并通过 `agent.inject()` 告诉模型"本会话未受监督"。理由：一本自相矛盾的台账比没有台账更危险——它会让 agent 从一个伪造的状态继续。
- **D-B3 审批是接缝。** 插件内部类型 `ApprovalGate = (req) => Promise<"allowed-once" | "denied">`；默认实现包住 `ctx.approval.request()`，**把服务缺席、抛异常、以及任何非 `allowed-once` 的返回一律当作 `denied`**（fail closed，设计 §6.3）。测试注入自己的 gate。理由：实测事实 9。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `integrations/geml-agent-runtime/src/core/run.ts` | 纯：一次运行 = 状态图 + 快照历史；三个动作各返回新快照与要追加的台账文本；恢复 |
| `integrations/geml-agent-runtime/src/core/tools.ts` | 纯：按 (状态图, 快照) 生成三个工具的名字/描述/参数 spec/输出 schema |
| `integrations/geml-agent-runtime/src/plugin.ts` | Cordis 插件：`name`/`inject`/`Config`/`apply`；`agent/session-start` 挂接；restrict + guard + 提示词 + 工具注册 + `tools/result` |
| `integrations/geml-agent-runtime/src/approval.ts` | `ApprovalGate` 类型与默认实现（包住 `ctx.approval`，fail closed） |
| `integrations/geml-agent-runtime/src/host-fs.ts` | 改：加 `appendOrCreate`（台账不存在则写头再追加） |
| `integrations/geml-agent-runtime/src/index.ts` | 改：导出插件入口 |
| `integrations/geml-agent-runtime/cordis.patch.yml` | 改：加第三行 `geml-agent` |
| `integrations/geml-agent-runtime/package.json` | 改：peer/dev 依赖 |
| `integrations/geml-agent-runtime/test/run.test.mjs` | `Run` 的纯函数测试 |
| `integrations/geml-agent-runtime/test/tools-spec.test.mjs` | 工具 spec 生成的测试 |
| `integrations/geml-agent-runtime/test/plugin.test.mjs` | testkit 集成测试（真 agent，不接模型） |
| `integrations/geml-agent-runtime/test/helpers/harness.mjs` | 测试夹具：起 ctx + 真 agent + 装本插件 |

---

### Task 1: `core/run.ts` — 一次运行

**Files:**
- Create: `integrations/geml-agent-runtime/src/core/run.ts`
- Create: `integrations/geml-agent-runtime/test/run.test.mjs`
- Modify: `integrations/geml-agent-runtime/src/index.ts`

**Interfaces:**
- Consumes: `Statechart`/`State`/`outgoing`/`allowedVars`（statechart.ts）、`Snapshot`/`Refusal`/`Meta`/`initialSnapshot`/`reenterSnapshot`/`applyPatch`/`applyTransition`/`applyRollback`/`checkpointRev`（snapshot.ts）、`renderSnapshotBlock`/`renderRefusedBlock`/`renderLedgerHead`/`readLedger`/`verifyLedger`/`LedgerMeta`（ledger.ts）、`JsonValue`（schema.ts）。
- Produces:
  ```ts
  export type Advance =
    | { ok: true; snapshot: Snapshot; block: string }
    | { ok: false; refusal: Refusal; block: string };
  export interface Run {
    readonly sc: Statechart;
    readonly snapshot: Snapshot;            // 当前（history 的最后一条）
    readonly history: readonly Snapshot[];
    readonly refusals: number;              // 已记的拒绝数，用于 #refused-N 编号
    transition(to: string, meta: Meta): Advance;
    set(patch: Record<string, JsonValue>, meta: Meta): Advance;
    rollback(target: number | "checkpoint", meta: Meta): Advance;
    errorRollback(meta: Meta): Advance;     // 外部工具失败：回到本状态入口
    reenter(at: string): { snapshot: Snapshot; block: string };   // clear
  }
  export function startRun(sc: Statechart, meta: LedgerMeta, at: string): { run: Run; head: string; block: string };
  export type Resumed =
    | { ok: true; run: Run; note?: string }        // note: 状态图变了但当前状态仍在
    | { ok: false; reason: string };               // 校验失败 / 当前状态已不存在
  export function resumeRun(sc: Statechart, ledgerSource: string): Resumed;
  ```
- 语义：每个动作**都**返回 `block`（成功是 `agent-snapshot`，失败是 `agent-refused`），调用方无条件追加；`Run` 是不可变值语义——动作返回新状态由调用方持有？**不**：`Run` 内部可变（`history` 追加），动作返回 `Advance`，`run.snapshot` 随之更新。理由：插件每个 agent 持有一个 `Run`，可变更简单，而纯度约束只禁 I/O 不禁可变。

- [ ] **Step 1: 写失败的测试 `test/run.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { startRun, resumeRun } from "../dist/core/run.js";
import { readLedger, verifyLedger } from "../dist/core/ledger.js";
import { parse } from "@geml/geml";

const src = readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8");
const sc = loadStatechart(src, "refund.geml").statechart;
const T0 = "2026-09-15T00:00:00Z";
const meta = { session: "s1", statechart: "refund.geml", statechartHash: sc.hash, created: T0 };
const m = (call) => ({ at: T0, call });

test("startRun opens at the initial state and yields a head plus revision 0", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  assert.equal(run.snapshot.rev, 0);
  assert.equal(run.snapshot.state, "intake");
  assert.equal(run.history.length, 1);
  assert.match(head, /^=== meta\n/);
  assert.match(block, /^=== agent-snapshot \{#rev-0 rev=0 state=#intake cause=enter/);
  assert.deepEqual(parse(head + block).diagnostics, []);
});

test("a refused action leaves the run untouched and still yields a block to append", () => {
  const { run } = startRun(sc, meta, T0);
  const r = run.transition("review", m("c1"));
  assert.equal(r.ok, false);
  assert.equal(run.snapshot.rev, 0, "rev must not move");
  assert.equal(run.history.length, 1);
  assert.match(r.block, /^=== agent-refused \{#refused-1 rev=0 .*tool=agent_transition call=c1/);
  assert.equal(run.refusals, 1);
  const again = run.transition("review", m("c2"));
  assert.match(again.block, /#refused-2/, "refusal numbering keeps counting");
});

test("a full run: set, transition, error-rollback — history and blocks agree", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  let text = head + block;
  for (const step of [
    () => run.set({ order: "A-17", amount: 120 }, m("c1")),
    () => run.transition("review", m("c2")),
    () => run.set({ approved: true }, m("c3")),
    () => run.transition("pay", m("c4")),
  ]) { const r = step(); assert.equal(r.ok, true, JSON.stringify(r)); text += r.block; }
  assert.equal(run.snapshot.state, "pay");
  assert.equal(run.snapshot.rev, 4);

  const back = run.errorRollback(m("c5"));
  assert.equal(back.ok, true);
  assert.equal(back.snapshot.cause, "error-rollback");
  assert.equal(back.snapshot.state, "pay", "error-rollback returns to this state's entry");
  assert.equal(back.snapshot.restores, 4);
  text += back.block;

  const ledger = readLedger(text);
  assert.deepEqual(ledger.diagnostics, []);
  assert.deepEqual(verifyLedger(ledger, sc), []);
  assert.deepEqual(ledger.snapshots.map((s) => s.rev), [0, 1, 2, 3, 4, 5]);
});

test("resumeRun restores the last revision and keeps appending from there", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  let text = head + block;
  text += run.set({ order: "A-17", amount: 120 }, m("c1")).block;
  text += run.transition("review", m("c2")).block;

  const r = resumeRun(sc, text);
  assert.equal(r.ok, true);
  assert.equal(r.run.snapshot.rev, 2);
  assert.equal(r.run.snapshot.state, "review");
  assert.equal(r.run.history.length, 3, "the whole history comes back — rollback needs it");
  const next = r.run.set({ approved: true }, m("c3"));
  assert.equal(next.ok, true);
  assert.equal(next.snapshot.rev, 3);
  assert.equal(next.snapshot.parent, r.run.history[2].hash);
});

test("resumeRun refuses a ledger that does not verify", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  const text = (head + block + run.set({ order: "A-17", amount: 120 }, m("c1")).block)
    .replace('"amount":120', '"amount":999');
  const r = resumeRun(sc, text);
  assert.equal(r.ok, false);
  assert.match(r.reason, /hash does not match/);
});

test("resumeRun refuses when the current state is gone, and notes a changed statechart", () => {
  const { run, head, block } = startRun(sc, meta, T0);
  let text = head + block;
  text += run.set({ order: "A-17", amount: 120 }, m("c1")).block;
  text += run.transition("review", m("c2")).block;

  const trimmed = loadStatechart(src.replace(/=== agent-state \{#review[\s\S]*?\n===\n/, ""), "refund.geml");
  const gone = resumeRun(trimmed.statechart ?? sc, text);
  if (trimmed.statechart) {
    assert.equal(gone.ok, false);
    assert.match(gone.reason, /#review/);
  }

  const edited = loadStatechart(src.replace("Do not judge yet.", "Do not judge yet. (edited)"), "refund.geml").statechart;
  const changed = resumeRun(edited, text);
  assert.equal(changed.ok, true);
  assert.match(changed.note, /statechart changed/);
});

test("reenter (a cleared session) goes back to the initial state on the same chain", () => {
  const { run } = startRun(sc, meta, T0);
  run.set({ order: "A-17", amount: 120 }, m("c1"));
  const re = run.reenter(T0);
  assert.equal(re.snapshot.state, "intake");
  assert.equal(re.snapshot.rev, 2);
  assert.equal(re.snapshot.from, "intake");
  assert.deepEqual(re.snapshot.vars, { amount: 0, approved: false });
  assert.match(re.block, /cause=enter/);
});
```

- [ ] **Step 2: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npx tsc && node --test test/run.test.mjs
```
Expected: FAIL（`dist/core/run.js` 不存在）。

- [ ] **Step 3: 实现 `src/core/run.ts`**

```ts
// One run of one statechart: the snapshot history, the three actions, and the
// ledger text each action produces. Pure — the host appends the text and
// decides where. The history is held whole because rollback and checkpoint
// need it (design decision D-B1); resuming parses the ledger once.
import type { JsonValue } from "./schema.js";
import { hashText, type Statechart } from "./statechart.js";
import {
  applyPatch, applyRollback, applyTransition, checkpointRev, initialSnapshot, reenterSnapshot,
  type Meta, type Outcome, type Refusal, type Snapshot,
} from "./snapshot.js";
import {
  readLedger, renderLedgerHead, renderRefusedBlock, renderSnapshotBlock, verifyLedger,
  type LedgerMeta,
} from "./ledger.js";

export type Advance =
  | { ok: true; snapshot: Snapshot; block: string }
  | { ok: false; refusal: Refusal; block: string };

export interface Run {
  readonly sc: Statechart;
  readonly snapshot: Snapshot;
  readonly history: readonly Snapshot[];
  readonly refusals: number;
  transition(to: string, meta: Meta): Advance;
  set(patch: Record<string, JsonValue>, meta: Meta): Advance;
  rollback(target: number | "checkpoint", meta: Meta): Advance;
  errorRollback(meta: Meta): Advance;
  reenter(at: string): { snapshot: Snapshot; block: string };
}

class RunState implements Run {
  readonly sc: Statechart;
  private readonly log: Snapshot[];
  private refused = 0;

  constructor(sc: Statechart, history: Snapshot[], refusals: number) {
    this.sc = sc;
    this.log = history;
    this.refused = refusals;
  }

  get snapshot(): Snapshot { return this.log[this.log.length - 1]!; }
  get history(): readonly Snapshot[] { return this.log; }
  get refusals(): number { return this.refused; }

  /** Commit an outcome: on success extend the chain, on refusal only number it. */
  private settle(outcome: Outcome, meta: Meta): Advance {
    if (outcome.ok) {
      this.log.push(outcome.next);
      return { ok: true, snapshot: outcome.next, block: renderSnapshotBlock(outcome.next) };
    }
    this.refused += 1;
    const block = renderRefusedBlock({
      n: this.refused, rev: this.snapshot.rev, at: meta.at, tool: outcome.refusal.tool,
      ...(meta.call !== undefined ? { call: meta.call } : {}),
      reason: outcome.refusal.reason, diagnostics: outcome.refusal.diagnostics,
    });
    return { ok: false, refusal: outcome.refusal, block };
  }

  transition(to: string, meta: Meta): Advance { return this.settle(applyTransition(this.sc, this.snapshot, to, meta), meta); }
  set(patch: Record<string, JsonValue>, meta: Meta): Advance { return this.settle(applyPatch(this.sc, this.snapshot, patch, meta), meta); }
  rollback(target: number | "checkpoint", meta: Meta): Advance { return this.settle(applyRollback(this.sc, this.log, target, meta), meta); }

  errorRollback(meta: Meta): Advance {
    return this.settle(applyRollback(this.sc, this.log, checkpointRev(this.log), meta, "error-rollback"), meta);
  }

  reenter(at: string): { snapshot: Snapshot; block: string } {
    const next = reenterSnapshot(this.sc, this.snapshot, at);
    this.log.push(next);
    return { snapshot: next, block: renderSnapshotBlock(next) };
  }
}

/** Open a fresh run: the ledger head plus revision 0. */
export function startRun(sc: Statechart, meta: LedgerMeta, at: string): { run: Run; head: string; block: string } {
  const first = initialSnapshot(sc, at);
  return { run: new RunState(sc, [first], 0), head: renderLedgerHead(meta), block: renderSnapshotBlock(first) };
}

export type Resumed = { ok: true; run: Run; note?: string } | { ok: false; reason: string };

/**
 * Reopen a run from its ledger. The chain is verified BEFORE it is trusted
 * (D-B2): a self-contradicting ledger is more dangerous than none, because the
 * agent would continue from a state nobody wrote.
 */
export function resumeRun(sc: Statechart, ledgerSource: string): Resumed {
  const ledger = readLedger(ledgerSource);
  const errors = verifyLedger(ledger, undefined);
  if (errors.length) return { ok: false, reason: errors.join("; ") };
  if (ledger.snapshots.length === 0) return { ok: false, reason: "the ledger holds no revision" };

  // Highest rev, not document order: verification已经保证两者一致，但读法要写对。
  const history = [...ledger.snapshots].sort((a, b) => a.rev - b.rev);
  const current = history[history.length - 1]!;
  if (!sc.states.has(current.state)) {
    return { ok: false, reason: `the statechart no longer has state #${current.state}` };
  }
  const refusals = ledger.refusals.reduce((max, r) => (r.n > max ? r.n : max), 0);
  const run = new RunState(sc, history, refusals);
  return ledger.meta.statechartHash === sc.hash
    ? { ok: true, run }
    : { ok: true, run, note: `statechart changed: ${ledger.meta.statechartHash} → ${sc.hash}` };
}

export { hashText };
```

- [ ] **Step 4: 跑测试**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npx tsc && node --test test/run.test.mjs
```
Expected: 全部 PASS。`src/index.ts` 追加 `export * from "./core/run.js";` 后再跑一次 `npm test` 确认没破坏既有 77 条。

- [ ] **Step 5: 提交**

```bash
cd /c/agentProjects/geml-spec
git checkout -- playground/codemap 2>/dev/null
git add integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test
git commit -m "feat(agent-runtime): a run — snapshot history, the three actions, and the ledger text each produces"
```

---

### Task 2: `core/tools.ts` — 按状态生成三个工具的 spec

**Files:**
- Create: `integrations/geml-agent-runtime/src/core/tools.ts`
- Create: `integrations/geml-agent-runtime/test/tools-spec.test.mjs`
- Modify: `integrations/geml-agent-runtime/src/index.ts`

**Interfaces:**
- Consumes: `Statechart`/`State`/`outgoing`/`allowedVars`（statechart.ts）、`Snapshot`（snapshot.ts）、`Schema`（schema.ts）、`describeTransitions`（prompt.ts）。
- Produces:
  ```ts
  /** DSH 的 ParameterSchemaSpec 子集：本包只生成这些形状。 */
  export interface ParamSpec { [name: string]: {
    type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
    required?: true; description: string; enum?: (string | number | boolean | null)[];
    items?: unknown; properties?: unknown; additionalProperties?: boolean;
  } }
  export interface ToolSpec {
    name: string; description: string; parameters: ParamSpec;
    output: { schema: Record<string, unknown> };
  }
  export function transitionSpec(sc: Statechart, snap: Snapshot): ToolSpec | null;   // null = 无合法出边
  export function setSpec(sc: Statechart, snap: Snapshot): ToolSpec | null;          // null = vars=none 或无 agent-vars
  export function rollbackSpec(): ToolSpec;
  export function toParamEntry(name: string, schema: Schema): ParamSpec[string];     // Schema → DSH 参数项
  ```
- **硬约束**：任何 `type: "object"` 的 schema（参数项里的、`output.schema` 里的）**必须**带显式 `additionalProperties`，否则 DSH 的 `defineTool` 抛 `UNSUPPORTED_SCHEMA`（探针实测）。

- [ ] **Step 1: 写失败的测试 `test/tools-spec.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition } from "../dist/core/snapshot.js";
import { transitionSpec, setSpec, rollbackSpec, toParamEntry } from "../dist/core/tools.js";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-15T00:00:00Z";
const m = () => ({ at: T0 });
const at = (state) => {
  let s = initialSnapshot(sc, T0);
  if (state === "intake") return s;
  s = applyPatch(sc, s, { order: "A-17", amount: 120 }, m()).next;
  s = applyTransition(sc, s, "review", m()).next;
  if (state === "review") return s;
  s = applyPatch(sc, s, { approved: true }, m()).next;
  return applyTransition(sc, s, "pay", m()).next;
};

test("every object schema carries an explicit additionalProperties (DSH refuses otherwise)", () => {
  const walk = (node, path) => {
    if (node === null || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(typeof node.additionalProperties, "boolean", `${path}: needs an explicit additionalProperties`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  for (const spec of [transitionSpec(sc, at("review")), setSpec(sc, at("intake")), rollbackSpec()]) {
    assert.ok(spec);
    walk(spec.parameters, "parameters");
    walk(spec.output.schema, "output.schema");
  }
});

test("agent_transition's to enum is exactly the current state's outgoing targets", () => {
  assert.deepEqual(transitionSpec(sc, at("review")).parameters.to.enum, ["pay", "wait-human"]);
  assert.deepEqual(transitionSpec(sc, at("intake")).parameters.to.enum, ["review"]);
  assert.equal(transitionSpec(sc, { ...at("intake"), state: "done" }), null, "a final state offers no transition tool");
});

test("agent_transition's description names each edge, its guard and its approval gate", () => {
  const d = transitionSpec(sc, at("review")).description;
  assert.match(d, /#to-pay → #pay/);
  assert.match(d, /requires #is-approved/);
  assert.match(d, /needs approval/);
  assert.match(d, /#to-wait → #wait-human/);
});

test("agent_set exposes only the variables this state may write, with their own types", () => {
  const spec = setSpec(sc, at("intake"));
  assert.deepEqual(Object.keys(spec.parameters).sort(), ["amount", "order"]);
  assert.equal(spec.parameters.amount.type, "number");
  assert.equal(spec.parameters.order.type, "string");
  assert.equal(spec.parameters.order.required, undefined, "a patch is partial — nothing is required");
  assert.deepEqual(Object.keys(setSpec(sc, at("review")).parameters), ["approved"]);
  assert.equal(setSpec(sc, at("pay")), null, "vars=none registers no tool");
});

test("toParamEntry carries enum and description through, and defaults the description", () => {
  assert.deepEqual(toParamEntry("kind", { type: "string", enum: ["full", "partial"], description: "Kind" }),
    { type: "string", description: "Kind", enum: ["full", "partial"] });
  assert.equal(toParamEntry("x", { type: "boolean" }).description, "the x variable");
  const obj = toParamEntry("o", { type: "object", properties: { a: { type: "string" } } });
  assert.equal(obj.additionalProperties, false, "an object variable must close itself for DSH");
});

test("agent_rollback takes a revision number or the checkpoint marker", () => {
  const p = rollbackSpec().parameters.to;
  assert.equal(p.required, true);
  assert.match(JSON.stringify(p), /checkpoint/);
});
```

- [ ] **Step 2: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npx tsc && node --test test/tools-spec.test.mjs
```
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/core/tools.ts`**

```ts
// The three agent_* tools' model-facing shape, derived from (statechart,
// snapshot). Pure data: the plugin hands it to DSH's defineTool. Everything
// here is recomputed whenever σ changes, which is what makes gate 2 —
// "agent_transition's to enum = outgoing(σ)" — true by construction.
//
// One DSH constraint is load-bearing and measured, not assumed: defineTool
// refuses an object schema without an explicit `additionalProperties`
// (UNSUPPORTED_SCHEMA). Every object this module emits closes itself.
import type { Schema } from "./schema.js";
import type { Snapshot } from "./snapshot.js";
import { allowedVars, outgoing, type Statechart } from "./statechart.js";

export interface ParamEntry {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
  required?: true;
  description: string;
  enum?: (string | number | boolean | null)[];
  items?: unknown;
  properties?: unknown;
  additionalProperties?: boolean;
}
export type ParamSpec = Record<string, ParamEntry>;
export interface ToolSpec {
  name: string;
  description: string;
  parameters: ParamSpec;
  output: { schema: Record<string, unknown> };
}

/** The result envelope every agent_* tool returns; closed, as DSH requires. */
function outputSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties };
}

/** One variable's declared schema, projected onto DSH's parameter vocabulary. */
export function toParamEntry(name: string, schema: Schema): ParamEntry {
  const entry: ParamEntry = {
    type: (schema.type ?? "string") as ParamEntry["type"],
    description: schema.description ?? `the ${name} variable`,
  };
  if (schema.enum) entry.enum = [...schema.enum];
  if (schema.items) entry.items = schema.items;
  if (schema.type === "object") {
    entry.properties = schema.properties ?? {};
    entry.additionalProperties = schema.additionalProperties ?? false;
  }
  return entry;
}

export function transitionSpec(sc: Statechart, snap: Snapshot): ToolSpec | null {
  const edges = outgoing(sc, snap.state);
  if (edges.length === 0) return null;
  const lines = edges.map((t) => {
    const notes: string[] = [];
    if (t.requiresId) notes.push(`requires #${t.requiresId}`);
    if (t.approval) notes.push("needs approval");
    return `#${t.id} → #${t.to}: ${t.body}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  });
  return {
    name: "agent_transition",
    description:
      `Move to the next state of this workflow. Only the targets listed here exist right now; the list changes with the state.\n${lines.join("\n")}`,
    parameters: {
      to: { type: "string", required: true, description: "The target state, without the leading #.", enum: edges.map((t) => t.to) },
    },
    output: { schema: outputSchema({ from: { type: "string" }, to: { type: "string" }, rev: { type: "integer" }, hash: { type: "string" } }) },
  };
}

export function setSpec(sc: Statechart, snap: Snapshot): ToolSpec | null {
  const state = sc.states.get(snap.state);
  if (!state || !sc.vars) return null;
  const names = allowedVars(sc, state);
  if (names.length === 0) return null;
  const parameters: ParamSpec = {};
  for (const name of names) {
    const schema = sc.vars.properties?.[name];
    if (schema) parameters[name] = toParamEntry(name, schema);
  }
  if (Object.keys(parameters).length === 0) return null;
  return {
    name: "agent_set",
    description:
      `Record one or more workflow variables. Send only the ones you are changing; the rest keep their values. A value that fails the workflow's schema is rejected and nothing is written.`,
    parameters,
    output: { schema: outputSchema({ rev: { type: "integer" }, hash: { type: "string" }, vars: { type: "object", additionalProperties: true } }) },
  };
}

export function rollbackSpec(): ToolSpec {
  return {
    name: "agent_rollback",
    description:
      `Undo workflow state: restore the variables and the state of an earlier revision. "checkpoint" returns to the revision at which the current state was entered. This undoes RECORDED state only — it cannot undo an effect a tool already had in the outside world.`,
    parameters: {
      to: { type: "string", required: true, description: 'A revision number as a string (e.g. "3"), or "checkpoint".' },
    },
    output: { schema: outputSchema({ rev: { type: "integer" }, restores: { type: "integer" }, state: { type: "string" }, hash: { type: "string" } }) },
  };
}
```

> `agent_rollback` 的 `to` 取字符串而不是 `oneOf`：DSH 的参数 spec 是扁平的 `{name: {type,…}}`，一个参数只有一个 `type`；插件负责把 `"3"` 解析成数字，把 `"checkpoint"` 原样传下去，解析失败按拒绝处理。

- [ ] **Step 4: 跑测试并提交**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npx tsc && node --test test/tools-spec.test.mjs && npm test
```
Expected: 新文件全过，既有套件不受影响。

```bash
cd /c/agentProjects/geml-spec
git checkout -- playground/codemap 2>/dev/null
git add integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test
git commit -m "feat(agent-runtime): the three agent_* tool specs, derived from the current state"
```

---

### Task 3: 依赖与审批接缝

**Files:**
- Modify: `integrations/geml-agent-runtime/package.json`
- Create: `integrations/geml-agent-runtime/src/approval.ts`
- Create: `integrations/geml-agent-runtime/test/approval.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface ApprovalRequest { agent: unknown; toolName: string; reason: string }
  export type ApprovalGate = (req: ApprovalRequest) => Promise<"allowed-once" | "denied">;
  /** 包住 ctx.approval；服务缺席、抛异常、或任何非 allowed-once 一律 denied。 */
  export function gateFor(ctx: { approval?: { request(req: unknown): Promise<string> } }): ApprovalGate;
  ```

- [ ] **Step 1: 装依赖**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm install --save-peer \
  "@deepseek-ai/cordis@^4.0.2" "@deepseek-ai/dsh-agent@^0.1.5-rc.1" "@deepseek-ai/dsh-tools@^0.1.5-rc.1" \
  "@deepseek-ai/dsh-session@^0.1.5-rc.1" "@deepseek-ai/dsh-system-prompt@^0.1.5-rc.1" \
  "@deepseek-ai/dsh-user-approval@^0.1.5-rc.1" "@deepseek-ai/dsh-llm@^0.1.5-rc.1" \
  "@deepseek-ai/schemastery@^3.18.2"
npm install --save-dev \
  "@deepseek-ai/cordis@4.0.2" "@deepseek-ai/dsh-agent@0.1.5-rc.1" "@deepseek-ai/dsh-agent-loop@0.1.5-rc.1" \
  "@deepseek-ai/dsh-agent-loop-testkit@0.1.5-rc.1" "@deepseek-ai/dsh-tools@0.1.5-rc.1" \
  "@deepseek-ai/dsh-session@0.1.5-rc.1" "@deepseek-ai/dsh-session-persistence@0.1.5-rc.1" \
  "@deepseek-ai/dsh-session-projection@0.1.5-rc.1" "@deepseek-ai/dsh-system-prompt@0.1.5-rc.1" \
  "@deepseek-ai/dsh-settings@0.1.5-rc.1" "@deepseek-ai/dsh-user-approval@0.1.5-rc.1" \
  "@deepseek-ai/dsh-llm@0.1.5-rc.1" "@deepseek-ai/dsh-invariants@0.1.5-rc.1" \
  "@deepseek-ai/dsh-scope@0.1.5-rc.1" "@deepseek-ai/dsh-brand@0.1.5-rc.1" "@deepseek-ai/schemastery@3.18.2"
```
`dsh-session-persistence` 必须钉 `0.1.5-rc.1`（不带 `^`）：让它浮到 rc.2 会与 rc.1 的 `dsh-brand` 冲突（实测 ERESOLVE）。装完确认 `npm ls @deepseek-ai/dsh-brand` 只有一个版本。

- [ ] **Step 2: 写失败的测试 `test/approval.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateFor } from "../dist/approval.js";

const req = { agent: {}, toolName: "agent_transition", reason: "transition #to-pay needs approval" };

test("no approval service at all is a denial, not a crash", async () => {
  assert.equal(await gateFor({})(req), "denied");
});

test("allowed-once is the only grant", async () => {
  assert.equal(await gateFor({ approval: { request: async () => "allowed-once" } })(req), "allowed-once");
  for (const outcome of ["rejected", "cancelled", "unavailable", "", "ALLOWED-ONCE"]) {
    assert.equal(await gateFor({ approval: { request: async () => outcome } })(req), "denied", outcome);
  }
});

test("a throwing service is a denial — DSH throws outside an open turn", async () => {
  const gate = gateFor({ approval: { request: async () => { throw new Error("outside an open turn"); } } });
  assert.equal(await gate(req), "denied");
});
```

- [ ] **Step 3: 实现 `src/approval.ts`**

```ts
// The approval seam. DSH's ctx.approval is optional (a harness may mount no
// answerer at all) and its request() THROWS outside an open turn — measured on
// 0.1.5-rc.1. Both are denials here: an approval gate that fails open is not a
// gate. Tests substitute their own ApprovalGate.
export interface ApprovalRequest { agent: unknown; toolName: string; reason: string }
export type ApprovalGate = (req: ApprovalRequest) => Promise<"allowed-once" | "denied">;

interface MaybeApproval { approval?: { request(req: unknown): Promise<string> } }

export function gateFor(ctx: MaybeApproval): ApprovalGate {
  return async (req) => {
    const service = ctx.approval;
    if (!service) return "denied";
    try {
      return (await service.request(req)) === "allowed-once" ? "allowed-once" : "denied";
    } catch {
      return "denied";
    }
  };
}
```

- [ ] **Step 4: 跑测试并提交**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npx tsc && node --test test/approval.test.mjs && npm ls @deepseek-ai/dsh-brand
```

```bash
cd /c/agentProjects/geml-spec
git checkout -- playground/codemap 2>/dev/null
git add integrations/geml-agent-runtime/package.json integrations/geml-agent-runtime/package-lock.json integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test
git commit -m "feat(agent-runtime): the approval seam — absent, throwing, or not allowed-once all deny"
```

---

### Task 4: `plugin.ts` — 把五道闸接到 Cordis 上

**Files:**
- Create: `integrations/geml-agent-runtime/src/plugin.ts`
- Modify: `integrations/geml-agent-runtime/src/host-fs.ts`（加 `appendOrCreate`）
- Modify: `integrations/geml-agent-runtime/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export const name = "geml-agent";
  export const inject: string[];                       // ["tools", "agents", "systemPrompt"]
  export interface Config { statechart?: string; ledgerDir: string; onMissing?: "skip" | "fail" }
  export const Config: z<Config>;
  export function apply(ctx: Context, config: Config): void;
  /** 供测试直接驱动，不经 agent/session-start。 */
  export function attach(ctx: Context, agent: Agent, source: string, config: Config, gate?: ApprovalGate): Promise<Attached | null>;
  export interface Attached { run: Run; ledgerPath: string; dispose(): void }
  ```
- `host-fs.ts` 新增：`appendOrCreate(path: string, head: string, block: string): void` —— 文件不存在则写 `head + block`，存在则只追加 `block`（单次 `appendFileSync`）。

- [ ] **Step 1: 写测试夹具 `test/helpers/harness.mjs`**

```js
// One real DSH agent with this plugin attached, for tests that must exercise
// the actual tool pipeline. No LLM: tool calls go in through ctx.tools.execute.
import { Context } from "@deepseek-ai/cordis";
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { brandString } from "@deepseek-ai/dsh-brand";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function world({ tools = ["read_file", "grep", "pay_refund"], failing = [] } = {}) {
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  const harness = await mountAgentLoopTestHarness(ctx);
  for (const name of tools) {
    ctx.tools.register(defineTool({
      name, description: `The ${name} tool.`,
      parameters: { x: { type: "string", required: false, description: "anything" } },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute() { if (failing.includes(name)) throw new Error(`${name} failed`); return `${name} ok`; },
    }));
  }
  const dir = mkdtempSync(join(tmpdir(), "geml-agent-plugin-"));
  const agent = await harness.create(SessionId("t-" + Math.random().toString(36).slice(2, 8)), {}, { cwd: dir });
  let n = 0;
  const call = (name, args = {}) => ctx.tools.execute({
    callId: brandString(`c${++n}`), name, arguments: args, agent, signal: new AbortController().signal,
  });
  const visible = () => ctx.tools.schemas(agent).map((s) => s.name).sort();
  const dispose = async () => { await ctx.root.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); };
  return { ctx, agent, dir, call, visible, dispose };
}
```

- [ ] **Step 2: 写失败的测试 `test/plugin.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { world } from "./helpers/harness.mjs";
import { attach } from "../dist/plugin.js";
import { readLedger, verifyLedger } from "../dist/core/ledger.js";
import { loadStatechart } from "../dist/core/statechart.js";

const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
const allow = async () => "allowed-once";
const deny = async () => "denied";

async function attached(opts = {}, gate = allow) {
  const w = await world(opts);
  copyFileSync(FIX, join(w.dir, "agent.geml"));
  const a = await attach(w.ctx, w.agent, "startup",
    { statechart: "agent.geml", ledgerDir: join(w.dir, "ledgers"), onMissing: "skip" }, gate);
  return { ...w, a };
}

test("no statechart in cwd: onMissing skip leaves the agent completely alone", async () => {
  const w = await world();
  const a = await attach(w.ctx, w.agent, "startup", { statechart: "agent.geml", ledgerDir: join(w.dir, "l"), onMissing: "skip" }, allow);
  assert.equal(a, null);
  assert.deepEqual(w.visible(), ["grep", "pay_refund", "read_file"]);
  await w.dispose();
});

test("gate 1: the initial state shows its own tools plus the agent_* ones", async () => {
  const w = await attached();
  assert.deepEqual(w.visible(), ["agent_rollback", "agent_set", "agent_transition", "grep", "read_file"]);
  await w.dispose();
});

test("gate 3: a tool outside the state is denied before dispatch, with a reason the model can read", async () => {
  const w = await attached();
  const r = await w.call("pay_refund");
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /not available in state #intake/);
  await w.dispose();
});

test("agent_set writes, agent_transition moves, and both land in the ledger", async () => {
  const w = await attached();
  assert.equal((await w.call("agent_set", { order: "A-17", amount: 120 })).isError, false);
  const t = await w.call("agent_transition", { to: "review" });
  assert.equal(t.isError, false, JSON.stringify(t.content));
  assert.equal(w.a.run.snapshot.state, "review");
  const ledger = readLedger(readFileSync(w.a.ledgerPath, "utf8"));
  assert.deepEqual(ledger.diagnostics, []);
  assert.deepEqual(ledger.snapshots.map((s) => s.rev), [0, 1, 2]);
  assert.deepEqual(verifyLedger(ledger, loadStatechart(readFileSync(FIX, "utf8"), "agent.geml").statechart), []);
  await w.dispose();
});

test("the visible tool set and the transition enum follow the state", async () => {
  const w = await attached();
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  await w.call("agent_set", { approved: true });
  await w.call("agent_transition", { to: "pay" });
  assert.deepEqual(w.visible(), ["agent_rollback", "agent_transition", "pay_refund"], "no agent_set in a vars=none state");
  const schema = w.ctx.tools.schemas(w.agent).find((s) => s.name === "agent_transition");
  assert.deepEqual(schema.parameters.properties.to.enum, ["done"]);
  await w.dispose();
});

test("a failed guard is refused and recorded, and the run does not move", async () => {
  const w = await attached();
  const r = await w.call("agent_transition", { to: "review" });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /missing required property "order"/);
  assert.equal(w.a.run.snapshot.rev, 0);
  const ledger = readLedger(readFileSync(w.a.ledgerPath, "utf8"));
  assert.equal(ledger.refusals.length, 1);
  assert.equal(ledger.refusals[0].tool, "agent_transition");
  await w.dispose();
});

test("gate 4: a transition marked approval is refused when the gate denies", async () => {
  const w = await attached({}, deny);
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  await w.call("agent_set", { approved: true });
  const r = await w.call("agent_transition", { to: "pay" });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /approval/i);
  assert.equal(w.a.run.snapshot.state, "review", "a denied approval must not move the run");
  await w.dispose();
});

test("entering a pause state concludes the turn", async () => {
  const w = await attached();
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  const r = await w.call("agent_transition", { to: "wait-human" });
  assert.equal(r.isError, false);
  assert.equal(r.concludesTurn, true);
  await w.dispose();
});

test("rollback-on-error: a failing external tool rolls the variables back", async () => {
  const w = await attached({ failing: ["pay_refund"] });
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  await w.call("agent_set", { approved: true });
  await w.call("agent_transition", { to: "pay" });
  const entry = w.a.run.snapshot.rev;
  const f = await w.call("pay_refund");
  assert.equal(f.isError, true);
  await new Promise((r) => setImmediate(r));   // the tools/result listener is synchronous but the append is not awaited
  assert.equal(w.a.run.snapshot.cause, "error-rollback");
  assert.equal(w.a.run.snapshot.restores, entry);
  await w.dispose();
});

test("resume: a second attach on the same ledger comes back at the last revision", async () => {
  const w = await attached();
  await w.call("agent_set", { order: "A-17", amount: 120 });
  await w.call("agent_transition", { to: "review" });
  const path = w.a.ledgerPath;
  w.a.dispose();
  const again = await attach(w.ctx, w.agent, "resume",
    { statechart: "agent.geml", ledgerDir: join(w.dir, "ledgers"), onMissing: "skip" }, allow);
  assert.equal(again.ledgerPath, path, "the same session resumes the same ledger");
  assert.equal(again.run.snapshot.rev, 2);
  assert.equal(again.run.snapshot.state, "review");
  await w.dispose();
});

test("the model is given the state's instruction and a snapshot, scoped to this agent", async () => {
  const w = await attached();
  const assembly = await w.ctx.systemPrompt.assemble({ scope: w.agent });
  assert.ok(assembly.sections.some((s) => s.name === "geml-agent:state" && s.text.includes("Collect the order id")));
  const snap = assembly.contexts.find((c) => c.name === "geml-agent:snapshot");
  assert.match(snap.text, /\[geml-agent\] state #intake · rev 0/);
  const global = await w.ctx.systemPrompt.assemble();
  assert.equal(global.sections.some((s) => s.name === "geml-agent:state"), false);
  await w.dispose();
});

test("dispose gives the agent its whole tool set back", async () => {
  const w = await attached();
  w.a.dispose();
  assert.deepEqual(w.visible(), ["grep", "pay_refund", "read_file"]);
  await w.dispose();
});
```

- [ ] **Step 3: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npx tsc && node --test test/plugin.test.mjs
```
Expected: FAIL（`dist/plugin.js` 不存在）。

- [ ] **Step 4: 实现 `host-fs.ts` 的 `appendOrCreate` 与 `src/plugin.ts`**

`host-fs.ts` 追加：
```ts
/** Append one ledger block, writing the head first when the file is new. */
export function appendOrCreate(path: string, head: string, block: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, existsSync(path) ? block : head + block, "utf8");
}
```
（顶部 import 补 `existsSync`。）

`src/plugin.ts`（要点，实施者按此写全）：

```ts
// The supervisor, wired into DeepSeek Harness. Everything registers through
// agent.ctx, so a disposed agent takes its restriction, guard, tools and prompt
// contributions with it — the kernel's cascading teardown does the cleanup.
import { resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { gateFor, type ApprovalGate } from "./approval.js";
import { appendOrCreate, readText } from "./host-fs.js";
import { hasErrors, loadStatechart, outgoing } from "./core/statechart.js";
import { resumeRun, startRun, type Run } from "./core/run.js";
import { renderContext, visibleTools } from "./core/prompt.js";
import { rollbackSpec, setSpec, transitionSpec } from "./core/tools.js";

export const name = "geml-agent";
export const inject = ["tools", "agents", "systemPrompt"];

export interface Config { statechart?: string; ledgerDir: string; onMissing?: "skip" | "fail" }
export const Config: z<Config> = z.object({
  statechart: z.string().default("agent.geml"),
  ledgerDir: z.string().required(),
  onMissing: z.union(["skip", "fail"]).default("skip"),
});

export interface Attached { run: Run; ledgerPath: string; dispose(): void }

export function apply(ctx: Context, config: Config): void {
  ctx.on("agent/session-start", ({ agent, source }) => {
    void attach(ctx, agent, source, config).catch((e) => ctx.logger(name).error(e));
  });
}

export async function attach(ctx: Context, agent: Agent, source: string, config: Config, gate: ApprovalGate = gateFor(ctx)): Promise<Attached | null> {
  // 1. 找状态图。相对路径按会话 cwd 解析，缺则 process.cwd()。
  // 2. loadStatechart；有 error 按 onMissing 处理（skip: 记日志返回 null；fail: 抛）。
  // 3. startRun 或 resumeRun（source === "resume" 且台账存在）；source === "clear" 走 run.reenter。
  //    resumeRun 失败 → 记日志、agent.inject 一句"本会话未受监督"、返回 null（D-B2）。
  // 4. appendOrCreate 写头与第一块。
  // 5. 在 agent.ctx 上注册（全部收进一个 disposers 数组）：
  //    - systemPrompt.section({ name: "geml-agent:state", order: 400, text: () => run.snapshot 所在状态的 body })
  //    - systemPrompt.context({ name: "geml-agent:snapshot", order: 130, text: () => renderContext(sc, run.snapshot) })
  //    - tools.guard(exec => 允许则 undefined，否则理由字符串)
  //    - on("tools/result", …) → 外部工具 isError 且当前状态 rollback-on-error → run.errorRollback + 追加 + 重下闸 + agent.inject 通知
  //    - on("tools/change", …) → 重算 restriction（外部工具可能晚注册）
  //    - restrict + 三个工具：由 refresh() 统一重下
  // 6. refresh()：dispose 上一批 restriction 与三个工具的 disposer，按当前 snapshot 重新 restrict + register。
  //    重注册会触发 tools/change，用一个 `refreshing` 标志避免自激。
  // 7. 工具实现：
  //    agent_transition: 查边 → 需要 approval 则 await gate(...)，denied 即拒 → run.transition → 追加 →
  //                      refresh() → 目标是 pause/final 则 exec.concludeTurn() → 返回 {from,to,rev,hash}
  //    agent_set:        run.set → 追加 → refresh()（vars 变了守卫可能开/关）→ 返回 {rev,hash,vars}
  //    agent_rollback:   "checkpoint" 或十进制整数，解析失败即拒 → run.rollback → 追加 → refresh()
  //    拒绝一律 throw new Error(reason + 诊断)，DSH 把它变成 isError 结果交回模型。
  return { run, ledgerPath, dispose };
}
```

- [ ] **Step 5: 跑测试到全绿**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npx tsc && node --test test/plugin.test.mjs && npm test
```
Expected: `plugin.test.mjs` 12 条全过；既有 77 + 新增的也全过。若 `rollback-on-error` 那条因异步时序不稳，把 `setImmediate` 换成对插件暴露的一个 `whenSettled()` promise，**不要**加 `sleep`。

- [ ] **Step 6: 提交**

```bash
cd /c/agentProjects/geml-spec
git checkout -- playground/codemap 2>/dev/null
git add integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test
git commit -m "feat(agent-runtime): the DSH plugin — per-state tools, guards, prompt, ledger, resume"
```

---

### Task 5: bundle 第三行

**Files:**
- Modify: `integrations/geml-agent-runtime/cordis.patch.yml`
- Modify: `integrations/geml-agent-runtime/test/smoke.test.mjs`

- [ ] **Step 1: 扩冒烟测试**

```js
test("the bundle patch contributes the runtime row alongside the MCP server and the skills", () => {
  const yml = readFileSync(new URL("../cordis.patch.yml", here), "utf8");
  for (const id of ["mcp-geml", "skill-geml", "geml-agent"]) {
    assert.match(yml, new RegExp(`^\\s*- id: ${id}$`, "m"), `row ${id}`);
  }
  assert.match(yml, /name: '@geml\/agent-runtime'/);
  assert.match(yml, /ledgerDir: !!js dshHomePath\('geml-agent'\)/);
  assert.match(yml, /onMissing: skip/);
});
```

- [ ] **Step 2: 加第三行**（追加到 `cordis.patch.yml` 的 `insert:` 列表末尾）

```yaml
    # The supervisor. It attaches per agent at agent/session-start and does
    # nothing at all when the session's working directory has no statechart —
    # `onMissing: skip` is what keeps this row harmless in a profile that only
    # wants the MCP server and the skills above.
    - id: geml-agent
      name: '@geml/agent-runtime'
      config:
        statechart: agent.geml
        ledgerDir: !!js dshHomePath('geml-agent')
        onMissing: skip
```

- [ ] **Step 3: 跑测试并提交**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && node --test test/smoke.test.mjs
```

```bash
cd /c/agentProjects/geml-spec
git checkout -- playground/codemap 2>/dev/null
git add integrations/geml-agent-runtime/cordis.patch.yml integrations/geml-agent-runtime/test/smoke.test.mjs
git commit -m "feat(agent-runtime): the bundle contributes the supervisor row"
```

---

### Task 6: dsh-tools 子集一致性测试（设计 §4.4 / §12.12）

**Files:**
- Create: `integrations/geml-agent-runtime/test/dsh-parity.test.mjs`

**Interfaces:** 无新导出。

- [ ] **Step 1: 写测试**

```js
// Design §4.4 promises our JSON Schema subset agrees with the one DSH's tool
// registry enforces. This is the test that keeps the promise — and it already
// has one known divergence to pin (an object without additionalProperties is
// legal for us and refused by DSH), which is exactly why every schema this
// package GENERATES closes its objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { assertSchema } from "../dist/core/schema.js";

const ours = (s) => { try { assertSchema(s); return true; } catch { return false; } };
const theirs = (s) => { try { assertSupportedJsonSchema(s); return true; } catch { return false; } };

const AGREE = [
  { type: "string" },
  { type: "integer" },
  { type: "object", additionalProperties: false, properties: { a: { type: "string" } }, required: ["a"] },
  { type: "array", items: { type: "number" } },
  { type: "string", enum: ["a", "b"] },
  { type: "boolean", const: true },
  { oneOf: [{ type: "string" }, { type: "number" }] },
  {},
  { type: "number", minimum: 0 },      // both must REJECT an unsupported keyword
  { type: "sting" },                   // both must REJECT an unknown type
  { oneOf: [{ type: "string" }] },     // both must REJECT a one-branch oneOf
];

test("our subset and DSH's agree on every schema shape this package produces", () => {
  for (const s of AGREE) {
    assert.equal(ours(s), theirs(s), `disagreement on ${JSON.stringify(s)}: ours=${ours(s)} dsh=${theirs(s)}`);
  }
});

test("the one known divergence is pinned: an open object is legal for us, refused by DSH", () => {
  const open = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(ours(open), true, "JSON Schema's default is open; our validator follows it");
  assert.equal(theirs(open), false, "DSH requires additionalProperties to be explicit");
  // Which is why core/tools.ts never emits one.
});
```

- [ ] **Step 2: 跑测试**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && node --test test/dsh-parity.test.mjs
```
Expected: 两条都过。**第一条若失败**，说明还有第二处分歧：把它加进第二条测试钉住，并在 `src/core/tools.ts` 的文件头注释里记一笔——不要改 `schema.ts` 去迎合 DSH，那会让我们的校验器偏离 JSON Schema。

- [ ] **Step 3: 提交**

```bash
cd /c/agentProjects/geml-spec
git checkout -- playground/codemap 2>/dev/null
git add integrations/geml-agent-runtime/test/dsh-parity.test.mjs
git commit -m "test(agent-runtime): pin where our JSON Schema subset and DSH's agree, and where they do not"
```

---

### Task 7: B 期收口

**Files:** Verify only（发现问题在对应模块修）；末尾改 `CHANGELOG.md`。

- [ ] **Step 1: 包内全量 + 覆盖率（一次）**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npx tsc && node node_modules/c8/bin/c8.js --include="dist/core/**/*.js" --check-coverage --branches 95 --lines 95 --functions 95 --statements 95 node --test test/*.test.mjs; echo "exit=$?"
```
覆盖率门只管 `core/`（`plugin.ts` 由 testkit 集成测试覆盖，不设阈值）。不够就补行为测试，**不降阈值**。

- [ ] **Step 2: 解析器全量套件（一次）**

```bash
cd /c/agentProjects/geml-spec/geml-parser && node test/all.mjs; echo "exit=$?"
```

- [ ] **Step 3: integrations 跑器（一次）**

```bash
cd /c/agentProjects/geml-spec && node integrations/test-all.mjs; echo "exit=$?"
```

- [ ] **Step 4: 手工端到端一次（记录在报告里，不进 CI）**

在一个临时目录里 `geml-agent init`，然后按 `README` 的装法起 `dsh --profile headless`，给一句"退款订单 A-17，金额 120"，观察：模型在 `#intake` 看不到 `pay_refund`；走到 `#pay` 后看不到 `read_file`；台账文件出现在 `$DSH_HOME/geml-agent/` 下且 `geml-agent verify` 通过。**若无 API key 或环境不允许，如实记录为"未执行"并说明原因**——不要伪造结果。

- [ ] **Step 5: CHANGELOG 并提交**

在 `## [Unreleased]` 下追加：
```
- **agent-runtime**: the DeepSeek Harness plugin lands — per-state tool restriction and a monotonic guard, the three `agent_*` tools regenerated on every state change, the state's instruction and a few-hundred-byte snapshot injected per step, `pause`/`final` concluding the turn, `rollback-on-error`, and a blind-appended hash-chained ledger that `resume` reads back after verifying it.
```

```bash
cd /c/agentProjects/geml-spec
git checkout -- playground/codemap 2>/dev/null
git add CHANGELOG.md
git commit -m "docs(changelog): agent-runtime phase B"
```

---

## 自审记录

- **覆盖**：设计 §6.1 → Task 3 + 5；§6.2 生命周期 → Task 4；§6.3 三个工具 → Task 2 + 4；§6.4 快照文本 → A 期已有，Task 4 接线；§5.3 错误回滚 → Task 4；§5.4 恢复与 §5.5 clear → Task 1 + 4；§12 第 10–12 条 → D-B1/D-B2/Task 6。
- **不在本期**：`run` 启动器、README、发版（C 期）；Web UI；把快照镜像进会话日志（§1.3 硬约束未解除）。
- **类型一致性**：`Run`/`Advance`（Task 1）被 Task 4 原名引用；`ToolSpec`/`ParamSpec`（Task 2）同；`ApprovalGate`（Task 3）是 `attach` 的第五个参数。
- **风险**：`tools/change` 自激（Task 4 用 `refreshing` 标志，测试覆盖）；`rollback-on-error` 的异步时序（Task 4 Step 5 给了确定性的替代方案）；端到端需要 API key（Task 7 Step 4 允许如实记"未执行"）。
