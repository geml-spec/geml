# GEML Agent Runtime — A 期实施计划（profile + 核心库 + 离线 CLI）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `integrations/dsh-plugin` 原地改造成 `integrations/geml-agent-runtime`（npm `@geml/agent-runtime`），登记 `geml-agent/v1` profile，交付不依赖 DSH 的核心库（状态图载入与静态检查、快照与哈希链、台账读写与校验、提示词渲染）和离线 CLI `geml-agent check|snapshot|verify|export|init`。

**Architecture:** 核心库是纯函数（文本进、值出，不 import `node:fs`、不碰 `process`、不打印），CLI 与 B 期的 DSH 插件共用它。状态图与台账都是 GEML 文档，解析交给 `@geml/geml` 的 `parse`，状态体原文用 `unitSpans` + `sliceUnit` 按字节切出。设计文档：`docs/design/specs/2026-09-14-geml-agent-runtime-design.md`（下称「设计」）。

**Tech Stack:** TypeScript（`tsc` → `dist/`，`strict` + `noUncheckedIndexedAccess`，与 geml-parser 同款 tsconfig）、Node ≥ 22、`node:test` + `node:assert/strict`、`@geml/geml`（开发期以 `file:../../geml-parser` 链接）。

## Global Constraints

- 分支 `feat/geml-agent-runtime`，主检出上干活，**不开 worktree**。`git add` 只加本任务列出的路径，**永远不用 `git add -A`**：工作区里未跟踪的 `integrations/geml-mcp-worker/` 是别人的 WIP。
- 提交信息用用户身份（xiongjy2104），**不加任何 Co-Authored-By / Generated-with**。
- 贵的命令跑一次：parser 全量套件（`node geml-parser/test/all.mjs`，约 4 分钟）只在 Task 9 跑一次；平时只跑相关的单个套件。
- 跨平台：路径用 `path.join`/`URL`；写文件一律 LF；测试不假设 git 身份、不依赖大小写敏感；不要在 `npm test` 里再套一层 `npm run`（cmd.exe PATH 溢出）。
- `src/core/*` 不得 import `node:fs`、`node:process`、`node:child_process`，不得引用 `process` 或 `console`（Task 3 起有一条 grep 测试钉住）。`node:crypto` 允许。
- 名字：目录 `integrations/geml-agent-runtime/`；npm `@geml/agent-runtime` `0.1.0`；bin `geml-agent`；profile `geml-agent/v1`；类型 `agent-vars` `agent-state` `agent-transition` `agent-snapshot` `agent-refused`。
- 哈希：`"sha256:" + sha256(canonical({ v, rev, parent: parent ?? null, state, vars }))`，`canonical` = 键按码点排序、无空白的 JSON。
- JSON Schema 子集（设计 §4.4）：`type`（单个）、`properties`、`required`、布尔 `additionalProperties`、`items`、标量 `enum`/`const`、`oneOf`（≥2 分支、恰一命中）、注解 `title`/`description`/`default`/`examples`。**其他关键字是错误。**
- 文档改动（README、spec/profiles）属于「面向人的文案」：本计划里的文案已在设计评审时同意，可直接落；C 期的 README 重写另行过审。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `integrations/geml-agent-runtime/package.json` | 包身份、bin、scripts、`dsh.bundle.patch` |
| `integrations/geml-agent-runtime/tsconfig.json` | 同 geml-parser |
| `integrations/geml-agent-runtime/src/index.ts` | 核心库公开出口（B 期再加 `apply`） |
| `integrations/geml-agent-runtime/src/core/schema.ts` | JSON Schema 子集：断言、校验、默认值 |
| `integrations/geml-agent-runtime/src/core/statechart.ts` | 状态图模型、载入、静态检查 |
| `integrations/geml-agent-runtime/src/core/snapshot.ts` | 快照、canonical、哈希、三个变更动词 |
| `integrations/geml-agent-runtime/src/core/ledger.ts` | 台账块的渲染、读取、校验 |
| `integrations/geml-agent-runtime/src/core/prompt.ts` | 模型看到的快照文本与跃迁说明 |
| `integrations/geml-agent-runtime/src/host-fs.ts` | 唯一碰文件系统的模块：读、独占创建、追加 |
| `integrations/geml-agent-runtime/src/cli.ts` | `geml-agent` 动词分发 |
| `integrations/geml-agent-runtime/test/*.test.mjs` | node:test 套件，一文件一模块 |
| `integrations/geml-agent-runtime/test/fixtures/refund.geml` | 设计 §4.1 的状态图，全套件共用 |
| `integrations/geml-agent-runtime/examples/refund/agent.geml` | 随包发布的示例（`init` 复制它） |
| `geml-parser/src/profiles.ts` | +`geml-agent/v1` |
| `geml-parser/test/profiles.test.mjs` | +3 条用例 |
| `geml-parser/test/skill-install.test.mjs` | 两处路径改名 |
| `.github/dependabot.yml` | 一处路径改名 |
| `spec/profiles/README.md` | +1 行索引 |
| `spec/profiles/geml-agent/geml-agent-profile.md`、`_CN.md` | profile 文档 |

---

### Task 1: 改名 dsh-plugin → geml-agent-runtime，搭 TS 脚手架

**Files:**
- Move: `integrations/dsh-plugin/` → `integrations/geml-agent-runtime/`
- Modify: `integrations/geml-agent-runtime/package.json`（整文件重写）
- Create: `integrations/geml-agent-runtime/tsconfig.json`、`src/index.ts`、`test/smoke.test.mjs`
- Modify: `.github/dependabot.yml:21`、`geml-parser/test/skill-install.test.mjs:75,107`

**Interfaces:**
- Produces: `dist/index.js` 导出 `RUNTIME_VERSION: string`（从 package.json 读）；后续 Task 在 `src/core/` 下加文件并从 `index.ts` 再导出。

- [ ] **Step 1: git mv 并确认工作区只多了改名**

```bash
cd /c/agentProjects/geml-spec
git mv integrations/dsh-plugin integrations/geml-agent-runtime
git status --short
```
Expected: 若干 `R  integrations/dsh-plugin/... -> integrations/geml-agent-runtime/...`，加上一行 `?? integrations/geml-mcp-worker/`（别人的，不动）。

- [ ] **Step 2: 写失败的冒烟测试**

`integrations/geml-agent-runtime/test/smoke.test.mjs`：
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const here = new URL(".", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", here), "utf8"));

test("package identity: the renamed bundle", () => {
  assert.equal(pkg.name, "@geml/agent-runtime");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.bin["geml-agent"], "dist/cli.js");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.deepEqual(pkg.files, ["dist", "skills", "examples", "cordis.patch.yml", "LICENSE"]);
  assert.equal(pkg.scripts.postinstall, undefined, "no lifecycle scripts: installing must never need allowBuilds");
});

test("the two dsh-plugin skills travelled with the rename", () => {
  assert.ok(existsSync(new URL("../skills/geml/SKILL.md", here)));
  assert.ok(existsSync(new URL("../skills/geml-code-graph/SKILL.md", here)));
  assert.ok(existsSync(new URL("../cordis.patch.yml", here)));
});

test("dist/index.js exports the runtime version", async () => {
  const mod = await import(new URL("../dist/index.js", here));
  assert.equal(mod.RUNTIME_VERSION, pkg.version);
});
```

- [ ] **Step 3: 跑一次确认失败**

```bash
cd integrations/geml-agent-runtime && node --test test/*.test.mjs
```
Expected: FAIL（`pkg.name` 仍是 `@geml/dsh-plugin`，`dist/` 不存在）。

- [ ] **Step 4: 重写 package.json**

```json
{
  "name": "@geml/agent-runtime",
  "version": "0.1.0",
  "description": "GEML Agent Runtime for DeepSeek Harness: a statechart written in GEML gates which tools the model sees in each state, validates every transition and patch, and appends a hash-chained GEML ledger. Also ships the geml MCP server row and the authoring and code-graph skills (formerly @geml/dsh-plugin).",
  "license": "MIT",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "geml-agent": "dist/cli.js" },
  "engines": { "node": ">=22" },
  "homepage": "https://github.com/geml-spec/geml",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/geml-spec/geml.git",
    "directory": "integrations/geml-agent-runtime"
  },
  "keywords": ["dsh-plugin", "dsh", "deepseek-harness", "geml", "agent", "statechart", "state-machine", "ledger", "mcp"],
  "files": ["dist", "skills", "examples", "cordis.patch.yml", "LICENSE"],
  "scripts": {
    "build": "tsc",
    "test": "tsc && node --test test/*.test.mjs"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "@geml/geml": "file:../../geml-parser"
  },
  "devDependencies": {
    "@types/node": "^26.5.0",
    "typescript": "^7.0.2"
  }
}
```
（`file:../../geml-parser` 是 A/B 期的开发链接；C 期 parser 发 1.11.0 后换成 `^1.11.0`。）

- [ ] **Step 5: tsconfig 与入口**

`integrations/geml-agent-runtime/tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```
`integrations/geml-agent-runtime/src/index.ts`：
```ts
// Public surface of @geml/agent-runtime. Phase A exports the core library;
// Phase B adds the DSH plugin entry (name / inject / Config / apply) here.
import { readFileSync } from "node:fs";

export const RUNTIME_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
```

- [ ] **Step 6: 安装依赖、构建、跑测试**

```bash
cd integrations/geml-agent-runtime && npm install && npm test
```
Expected: `npm install` 把 `@geml/geml` 链接到 `../../geml-parser`（Windows 上是 junction）；3 个测试 PASS。若 `dist/geml.js` 不存在，先 `cd ../../geml-parser && npm run build`。

- [ ] **Step 7: 修两处指向旧路径的代码引用**

`.github/dependabot.yml` 第 21 行：`- "/integrations/dsh-plugin"` → `- "/integrations/geml-agent-runtime"`。

`geml-parser/test/skill-install.test.mjs`：第 75 行 `join("..", "integrations", "dsh-plugin", "skills", "geml")` → `join("..", "integrations", "geml-agent-runtime", "skills", "geml")`；第 107 行 `["dsh-plugin", [[...` → `["geml-agent-runtime", [[...`。

```bash
cd /c/agentProjects/geml-spec/geml-parser && node test/skill-install.test.mjs
```
Expected: 全部 `ok`。（`features.test.mjs` 里的 `@geml/dsh-plugin` 只是 id 派生的测试字串，不改。）

- [ ] **Step 8: 提交**

```bash
cd /c/agentProjects/geml-spec
git add -A integrations/geml-agent-runtime .github/dependabot.yml geml-parser/test/skill-install.test.mjs
git status --short   # 确认没有 integrations/geml-mcp-worker
git commit -m "chore(agent-runtime): rename dsh-plugin to geml-agent-runtime and scaffold the TypeScript package"
```
（`git add -A <路径>` 限定在这些路径内，是这里唯一允许 `-A` 的形式。）

---

### Task 2: parser 登记 `geml-agent/v1` + profile 文档

**Files:**
- Modify: `geml-parser/src/profiles.ts`（`PROFILES` 末尾加一条）
- Modify: `geml-parser/test/profiles.test.mjs`（文件末尾加 3 条用例）
- Modify: `spec/profiles/README.md`（索引表加一行）
- Create: `spec/profiles/geml-agent/geml-agent-profile.md`、`spec/profiles/geml-agent/geml-agent-profile_CN.md`

**Interfaces:**
- Produces: 声明 `profile = "geml-agent/v1"` 的文档里，五个 `agent-*` 类型不再是 `unknown-block-type`；`agent-state`/`agent-transition` 的体是 flow（`block.children`），其余 raw（`block.raw`）。

- [ ] **Step 1: 写失败的用例（追加到 `geml-parser/test/profiles.test.mjs` 末尾）**

```js
test("geml-agent/v1：五个 agent-* 类型被放行，声明与否只差诊断", () => {
  const doc = (declared) =>
    "=== meta\n" + (declared ? 'profile = "geml-agent/v1"\n' : "") + 'title = "t"\n===\n\n'
    + '=== agent-vars {#vars}\n{"type":"object","properties":{}}\n===\n\n'
    + '=== agent-state {#a initial tools="read_file" vars=none rollback-on-error}\nDo the thing.\n===\n\n'
    + '=== agent-state {#b final}\nStop.\n===\n\n'
    + '=== agent-transition {#a-b from=#a to=#b requires=#g approval}\nGo.\n===\n\n'
    + '=== data {#g format=json}\n{"type":"object"}\n===\n\n'
    + '=== agent-snapshot {#rev-0 rev=0 state=#a cause=enter hash="sha256:00" at="2026-01-01T00:00:00Z"}\n{}\n===\n\n'
    + '=== agent-refused {#refused-1 rev=0 at="2026-01-01T00:00:00Z" tool=agent_set}\n{"reason":"r","diagnostics":[]}\n===\n';
  assert.deepEqual(parse(doc(true)).diagnostics, [], "declared: no diagnostics at all");
  const undeclared = parse(doc(false)).diagnostics.map((d) => d.code);
  assert.equal(undeclared.filter((c) => c === "unknown-block-type").length, 6, "undeclared: every agent-* block warns");
});

test("geml-agent/v1：agent-state / agent-transition 的体是 flow，其余是 raw", () => {
  const src = '=== meta\nprofile = "geml-agent/v1"\n===\n\n'
    + '=== agent-state {#a initial}\nRead [[#a]] first.\n\n- one\n- two\n===\n\n'
    + '=== agent-vars {#v}\n{"type":"object"}\n===\n';
  const d = parse(src);
  const state = d.children.find((b) => b.kind === "block" && b.type === "agent-state");
  const vars = d.children.find((b) => b.kind === "block" && b.type === "agent-vars");
  assert.equal(state.mode, "flow");
  assert.equal(state.children.some((c) => c.kind === "list"), true, "flow body parsed the list");
  assert.equal(vars.mode, "raw");
  assert.deepEqual(vars.raw, ['{"type":"object"}']);
});

test("geml-agent/v1：放行的属性键只挂在各自类型上", () => {
  const v = vocabularyFor(meta({ profile: "geml-agent/v1" }));
  assert.equal(v.attrs.get("agent-state")?.has("rollback-on-error"), true);
  assert.equal(v.attrs.get("agent-transition")?.has("requires"), true);
  assert.equal(v.attrs.get("agent-snapshot")?.has("restores"), true);
  assert.equal(v.attrs.get("agent-refused")?.has("tool"), true);
  assert.equal(v.attrs.get("agent-vars"), undefined, "agent-vars declares no keys");
  assert.equal(v.attrs.get("agent-state")?.has("requires"), undefined ?? false);
});
```
（最后一条断言写成 `assert.equal(v.attrs.get("agent-state")?.has("requires"), false)`。）

- [ ] **Step 2: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/geml-parser && npm run build && node test/profiles.test.mjs
```
Expected: 第一条新用例 FAIL（`unknown-block-type` 出现在 declared 的文档里）。

- [ ] **Step 3: 登记 profile（`geml-parser/src/profiles.ts`，`PROFILES` 对象末尾、`geml-history/v1` 之后）**

```ts
  // spec/profiles/geml-agent/geml-agent-profile.md — the GEML Agent Runtime's
  // statechart and ledger vocabulary (docs/design/specs/2026-09-14-geml-agent-runtime-design.md §4).
  // Two bodies are flow on purpose: a state's body is the prose the model is
  // given while in that state, a transition's body is how the model is told
  // about it — both want reference checking and rendering. The other three
  // carry JSON the runtime parses itself, so they stay raw.
  "geml-agent/v1": {
    types: ["agent-vars", "agent-state", "agent-transition", "agent-snapshot", "agent-refused"],
    bodies: { "agent-state": "flow", "agent-transition": "flow" },
    attrs: {
      "agent-state": ["initial", "final", "pause", "tools", "vars", "rollback-on-error"],
      "agent-transition": ["from", "to", "requires", "approval"],
      "agent-snapshot": ["rev", "state", "cause", "parent", "hash", "at", "call", "from", "restores"],
      "agent-refused": ["rev", "at", "tool", "call"],
    },
  },
```

- [ ] **Step 4: 索引表加一行（`spec/profiles/README.md`，`geml-translator/v1` 那行之后）**

```
| `geml-agent/v1` | types `agent-vars`, `agent-state`, `agent-transition`, `agent-snapshot`, `agent-refused`; `initial`, `final`, `pause`, `tools`, `vars`, `rollback-on-error` on `agent-state`; `from`, `to`, `requires`, `approval` on `agent-transition`; `rev`, `state`, `cause`, `parent`, `hash`, `at`, `call`, `from`, `restores` on `agent-snapshot`; `rev`, `at`, `tool`, `call` on `agent-refused` — **experimental** | [geml-agent-profile.md](geml-agent/geml-agent-profile.md) · [中文](geml-agent/geml-agent-profile_CN.md) | `geml-agent check\|snapshot\|verify\|export\|init` (package `@geml/agent-runtime`) |
```
（`profiles.test.mjs` 的「索引表与注册表是同一张表」用例要求这一行提到每个类型名和每个属性宿主类型，并且链接的两个 `.md` 真实存在——所以 Step 5 的文档必须在同一提交里。）

- [ ] **Step 5: 写 profile 文档（英文）`spec/profiles/geml-agent/geml-agent-profile.md`**

````markdown
# geml-agent profile v1 — a statechart for an agent, and its ledger

*English | [中文](geml-agent-profile_CN.md)*

- Status: **experimental**, v1, 2026-09-14. Design rationale:
  [`docs/design/specs/2026-09-14-geml-agent-runtime-design.md`](../../../docs/design/specs/2026-09-14-geml-agent-runtime-design.md).
- Nature: **an application-layer profile, not part of the GEML standard.** Every
  block below has a `raw` or `flow` body §3 already defines; GEML never reads a
  new syntax inside one. The runtime that interprets them is
  `@geml/agent-runtime` (`integrations/geml-agent-runtime/`), a DeepSeek Harness
  plugin bundle with an offline CLI, `geml-agent`.

## 0. What it is in one paragraph

A document that declares `profile = "geml-agent/v1"` describes an **agent
statechart**: the states an agent can be in, the prose instructions it is given
in each, which tools it may see there, which variables it may set, and the
transitions between states with their guards. A second kind of document, the
**ledger**, records one run: an append-only sequence of `agent-snapshot` blocks
(revision, state, variables, hash chained to the previous block) and
`agent-refused` blocks (a transition or patch the guards rejected). Both are
ordinary GEML: `geml check` validates them, `geml get ledger.geml '#rev-7'`
reads one revision, `.gemlhistory` versions the statechart like any document.

What the vocabulary does **not** do: it constrains only what it models. A
rollback restores declared variables and the control state, never an external
side effect; tool gating decides which tools the model can call in a state, not
what an allowed tool does; resuming from a ledger restores the state, while the
conversation is the harness's own business.

## 1. Declaring the profile

```geml
=== meta
profile = "geml-agent/v1"
tools   = "read_file grep"
===
```

`tools` on `=== meta` is the document-wide default for states that carry no
`tools=` of their own. Without the declaration the same document parses to the
same model (§8.6 rule 4) and every `agent-*` block is an `unknown-block-type`
warning.

## 2. Blocks

| type | body | attributes | meaning |
|---|---|---|---|
| `agent-vars` | raw, JSON | — | The variables' JSON Schema. Object root, at most one per document, restricted to the subset in §4. `default` supplies the initial value. |
| `agent-state` | **flow** | `initial` `final` `pause` `tools` `vars` `rollback-on-error` | One state. The body is the instruction the model receives while in it, byte for byte. |
| `agent-transition` | **flow** | `from` `to` `requires` `approval` | One edge. The body is how the model is told about it. |
| `agent-snapshot` | raw, JSON | `rev` `state` `cause` `parent` `hash` `at` `call` `from` `restores` | One revision of a run (ledger only). The body is the variables, canonical JSON on one line. |
| `agent-refused` | raw, JSON | `rev` `at` `tool` `call` | One rejected attempt (ledger only). The body is `{"reason": …, "diagnostics": […]}`. |

### 2.1 `agent-state`

- `initial` — exactly one state per document carries it.
- `final` — a terminal state: it may have no outgoing transition, and entering it ends the agent's turn.
- `pause` — entering it ends the current turn; the run continues from here when the next input arrives (a human reply, a webhook).
- `tools="a b"` — space-separated names of **global** tools visible in this state. Absent: inherit `tools` from `=== meta`; both absent: unrestricted. The literal `none`: no external tool at all.
- `vars="x y"` — the variables the model may set in this state. Absent: all. `none`: read-only state. Every name must exist in `agent-vars`.
- `rollback-on-error` — when any external tool fails in this state, variables and state return to the revision at which this state was entered.

### 2.2 `agent-transition`

- `from=#id`, `to=#id` — states, written with the `#` GEML uses for a block reference in an attribute (`data=#id`).
- `requires=#id` — a `data {format=json}` block holding a JSON Schema (§4). The transition is allowed only when the current variables, taken as one object, satisfy it.
- `approval` — the harness must grant a one-shot approval before the transition commits; no approval service, or a refusal, means the transition is refused.

### 2.3 The ledger

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

- `rev` starts at 0 and is contiguous. `cause` is one of `enter`, `transition`, `patch`, `rollback`, `error-rollback`.
- `hash` = `"sha256:" + sha256(canonical({v: 1, rev, parent: parent ?? null, state, vars}))`, where `canonical` sorts keys by code point and emits no whitespace. `parent` is the previous block's `hash`; revision 0 has none. Because `rev` and `parent` are hashed, the blocks form a chain: reordering, deleting or editing any one breaks verification.
- `from` is present on `transition`, `rollback` and `error-rollback` (the state left); `restores` on the two rollbacks (the revision restored, `< rev`); `call` is the harness call id that caused the change when there was one.
- A ledger is written by **blind append**: each block is complete on its own, so the writer never reads the file (GEP-0005). The `#rev-N` / `#refused-N` ids make every revision addressable.

## 3. Static checks

`geml-agent check` runs `geml check` first (an error there refuses the document) and then reports:

| code | severity | when |
|---|---|---|
| `agent-no-initial` / `agent-many-initial` | error | not exactly one `initial` |
| `agent-bad-ref` | error | `from` / `to` / `requires` is not `#id`, or names a block of the wrong type |
| `agent-final-outgoing` | error | a `final` state has an outgoing transition |
| `agent-dup-edge` | error | two transitions share the same `from` and `to` |
| `agent-vars-schema` | error | more than one `agent-vars`, or its body is not an object schema in the §4 subset |
| `agent-requires-schema` | error | a `requires` target is not a schema in the subset |
| `agent-unknown-var` | error | `vars=` names a variable not in the schema |
| `agent-unreachable` | warning | a state the initial state cannot reach |
| `agent-dead-end` | warning | a non-final state with no outgoing transition |
| `agent-unknown-tool` | warning | `tools=` names a tool the runtime does not know (only when the tool list is known) |

`geml-agent verify` checks a ledger: contiguous `rev`, every `parent` equal to the previous `hash`, every `hash` recomputed, `cause` consistent with `from` / `restores`, and — given the statechart — every `state` exists and every transition matches a declared edge.

## 4. The JSON Schema subset

Exactly the subset the DeepSeek Harness tool registry enforces: any JSON root; a single scalar `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`); `properties`, `required`, boolean `additionalProperties`; `items`; scalar `enum` / `const` matching the type; `oneOf` with at least two branches of which exactly one must match; the annotations `title`, `description`, `default`, `examples`. **Any other keyword is an error**, not an ignored hint — `minimum` silently doing nothing would be worse than refusing it.

## 5. Conformance (informative)

A GEML processor that does not recognize `geml-agent/v1` is unaffected: it reports the five types as `unknown-block-type` warnings and keeps every body raw (§8.6 rule 3). Only the runtime reads the JSON bodies, and only `geml-agent verify` checks the chain.
````

- [ ] **Step 6: 写 profile 文档（中文）`spec/profiles/geml-agent/geml-agent-profile_CN.md`**

````markdown
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
- `hash` = `"sha256:" + sha256(canonical({v: 1, rev, parent: parent ?? null, state, vars}))`，`canonical` 键按码点排序、无空白。`parent` 是前一块的 `hash`；第 0 条修订没有。因为 `rev` 和 `parent` 都进了哈希，这些块构成一条链：换序、删块、改任何一块都会让校验失败。
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
````

- [ ] **Step 7: 构建并只跑 profiles 套件**

```bash
cd /c/agentProjects/geml-spec/geml-parser && npm run build && node test/profiles.test.mjs
```
Expected: 全部 `ok`，包括「索引表与注册表是同一张表」。

- [ ] **Step 8: 提交**

```bash
cd /c/agentProjects/geml-spec
git add geml-parser/src/profiles.ts geml-parser/test/profiles.test.mjs spec/profiles/README.md spec/profiles/geml-agent
git commit -m "feat(parser): register the geml-agent/v1 profile — statechart and ledger vocabulary"
```

---

### Task 3: `core/schema.ts` — JSON Schema 子集

**Files:**
- Create: `integrations/geml-agent-runtime/src/core/schema.ts`
- Create: `integrations/geml-agent-runtime/test/schema.test.mjs`
- Create: `integrations/geml-agent-runtime/test/purity.test.mjs`
- Modify: `integrations/geml-agent-runtime/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
  export type Scalar = string | number | boolean | null;
  export interface Schema {
    type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
    oneOf?: Schema[]; properties?: Record<string, Schema>; required?: string[];
    additionalProperties?: boolean; items?: Schema; enum?: Scalar[]; const?: Scalar;
    title?: string; description?: string; default?: JsonValue; examples?: JsonValue;
  }
  export class SchemaError extends Error { readonly violations: string[] }
  export function assertSchema(raw: unknown, path?: string): Schema;          // throws SchemaError with every violation
  export function validate(schema: Schema, value: unknown, path?: string): string[];  // [] = valid
  export function defaultsOf(schema: Schema): Record<string, JsonValue>;      // object root: each property's `default`
  export function isJsonValue(v: unknown): v is JsonValue;
  ```
- 消息格式固定：`${path}: ${text}`，`path` 以 `$` 起，属性用 `.name`，数组用 `[i]`。例：`$.approved: expected const true, got false`、`$: unsupported keyword "minimum"`。

- [ ] **Step 1: 写失败的测试 `test/schema.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSchema, validate, defaultsOf, SchemaError } from "../dist/core/schema.js";

const vars = {
  type: "object", additionalProperties: false,
  properties: {
    order: { type: "string", description: "Order id" },
    amount: { type: "number", default: 0 },
    approved: { type: "boolean", default: false },
    kind: { type: "string", enum: ["full", "partial"] },
    tags: { type: "array", items: { type: "string" } },
  },
};

test("assertSchema accepts the whole subset and returns the same object", () => {
  assert.equal(assertSchema(vars), vars);
  assert.deepEqual(assertSchema({}), {});
  assert.ok(assertSchema({ oneOf: [{ type: "integer" }, { const: "checkpoint" }] }));
});

test("assertSchema lists every violation, path-qualified", () => {
  const bad = { type: "object", properties: { a: { type: "number", minimum: 0 }, b: { type: "sting" } }, required: ["zzz"] };
  assert.throws(() => assertSchema(bad), (e) => {
    assert.ok(e instanceof SchemaError);
    assert.deepEqual(e.violations, [
      '$.properties.a: unsupported keyword "minimum"',
      '$.properties.b: unknown type "sting"',
      '$: required names undeclared property "zzz"',
    ]);
    return true;
  });
});

test("assertSchema rejects a oneOf with fewer than two branches and an enum that disagrees with type", () => {
  assert.throws(() => assertSchema({ oneOf: [{ type: "string" }] }), /\$: oneOf needs at least two branches/);
  assert.throws(() => assertSchema({ type: "number", enum: ["a"] }), /\$: enum value "a" is not a number/);
});

test("validate: types, required, additionalProperties, enum, const, items", () => {
  assert.deepEqual(validate(vars, { order: "A-17", amount: 120, approved: false, kind: "full", tags: ["x"] }), []);
  assert.deepEqual(validate(vars, { amount: "120" }), ["$.amount: expected number, got string"]);
  assert.deepEqual(validate(vars, { extra: 1 }), ['$: unexpected property "extra"']);
  assert.deepEqual(validate(vars, { kind: "half" }), ['$.kind: expected one of "full", "partial", got "half"']);
  assert.deepEqual(validate(vars, { tags: ["ok", 2] }), ["$.tags[1]: expected string, got number"]);
  assert.deepEqual(validate({ type: "object", required: ["approved"], properties: { approved: { const: true } } }, { approved: false }),
    ["$.approved: expected const true, got false"]);
  assert.deepEqual(validate({ type: "object", required: ["order", "amount"] }, { order: "x" }), ['$: missing required property "amount"']);
});

test("validate: integer is a number without a fraction; null is its own type; oneOf wants exactly one", () => {
  assert.deepEqual(validate({ type: "integer" }, 3), []);
  assert.deepEqual(validate({ type: "integer" }, 3.5), ["$: expected integer, got number"]);
  assert.deepEqual(validate({ type: "null" }, null), []);
  const target = { oneOf: [{ type: "integer" }, { const: "checkpoint" }] };
  assert.deepEqual(validate(target, 7), []);
  assert.deepEqual(validate(target, "checkpoint"), []);
  assert.deepEqual(validate(target, "later"), ["$: matched 0 of 2 oneOf branches"]);
});

test("defaultsOf collects property defaults and nothing else", () => {
  assert.deepEqual(defaultsOf(vars), { amount: 0, approved: false });
  assert.deepEqual(defaultsOf({ type: "object" }), {});
});
```

`test/purity.test.mjs`（钉住核心库的纯度，之后每加一个 core 文件都自动覆盖）：
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../src/core/", import.meta.url);
test("src/core/* imports no fs/process/child_process and never touches process or console", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /from "node:(fs|process|child_process)"/, `${f} imports a host module`);
    assert.doesNotMatch(src, /\bprocess\.|\bconsole\./, `${f} touches process or console`);
  }
});
```

- [ ] **Step 2: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: `tsc` 通过（还没有 core 文件），`schema.test.mjs` 因 `dist/core/schema.js` 不存在而 FAIL。

- [ ] **Step 3: 实现 `src/core/schema.ts`**

```ts
// The JSON Schema subset the runtime enforces — deliberately the same subset
// the DeepSeek Harness tool registry enforces (dsh-tools/json-schema), so the
// `agent_set` parameters the model sees and the values we validate live under
// one rule. Anything outside the subset is refused, never ignored: `minimum`
// silently doing nothing would be worse than an error.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Scalar = string | number | boolean | null;
export type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface Schema {
  type?: SchemaType;
  oneOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: Scalar[];
  const?: Scalar;
  title?: string;
  description?: string;
  default?: JsonValue;
  examples?: JsonValue;
}

const TYPES: ReadonlySet<string> = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYWORDS: ReadonlySet<string> = new Set([
  "type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const",
  "title", "description", "default", "examples",
]);

export class SchemaError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(violations.join("\n"));
    this.name = "SchemaError";
    this.violations = violations;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isJsonValue(v: unknown): v is JsonValue {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJsonValue);
  if (isRecord(v)) return Object.values(v).every(isJsonValue);
  return false;
}

/** The JSON type name of a value, for messages: `typeOf(3.5)` is `number`, `typeOf(null)` is `null`. */
function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function scalarText(v: Scalar): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

function scalarFits(v: Scalar, type: SchemaType | undefined): boolean {
  if (type === undefined) return true;
  if (type === "integer") return typeof v === "number" && Number.isInteger(v);
  return typeOf(v) === type;
}

function collect(raw: unknown, path: string, out: string[]): void {
  if (!isRecord(raw)) { out.push(`${path}: schema must be an object`); return; }
  for (const k of Object.keys(raw)) {
    if (!KEYWORDS.has(k)) out.push(`${path}: unsupported keyword ${JSON.stringify(k)}`);
  }
  const type = raw["type"];
  if (type !== undefined && (typeof type !== "string" || !TYPES.has(type))) {
    out.push(`${path}: unknown type ${JSON.stringify(type)}`);
  }
  const t = typeof type === "string" && TYPES.has(type) ? (type as SchemaType) : undefined;
  if (raw["oneOf"] !== undefined) {
    const branches = raw["oneOf"];
    if (!Array.isArray(branches) || branches.length < 2) out.push(`${path}: oneOf needs at least two branches`);
    else branches.forEach((b, i) => collect(b, `${path}.oneOf[${i}]`, out));
  }
  const props = raw["properties"];
  if (props !== undefined) {
    if (t !== undefined && t !== "object") out.push(`${path}: properties needs type object`);
    if (!isRecord(props)) out.push(`${path}: properties must be an object`);
    else for (const [name, sub] of Object.entries(props)) collect(sub, `${path}.properties.${name}`, out);
  }
  const required = raw["required"];
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) out.push(`${path}: required must be an array of names`);
    else for (const name of required as string[]) {
      if (!isRecord(props) || !(name in props)) out.push(`${path}: required names undeclared property ${JSON.stringify(name)}`);
    }
  }
  if (raw["additionalProperties"] !== undefined && typeof raw["additionalProperties"] !== "boolean") {
    out.push(`${path}: additionalProperties must be a boolean`);
  }
  if (raw["items"] !== undefined) {
    if (t !== undefined && t !== "array") out.push(`${path}: items needs type array`);
    collect(raw["items"], `${path}.items`, out);
  }
  const en = raw["enum"];
  if (en !== undefined) {
    if (!Array.isArray(en) || en.length === 0) out.push(`${path}: enum must be a non-empty array`);
    else for (const v of en) {
      if (!(v === null || ["string", "number", "boolean"].includes(typeof v))) out.push(`${path}: enum values must be scalars`);
      else if (!scalarFits(v as Scalar, t)) out.push(`${path}: enum value ${scalarText(v as Scalar)} is not a ${t}`);
    }
  }
  const c = raw["const"];
  if (c !== undefined) {
    if (!(c === null || ["string", "number", "boolean"].includes(typeof c))) out.push(`${path}: const must be a scalar`);
    else if (!scalarFits(c as Scalar, t)) out.push(`${path}: const value ${scalarText(c as Scalar)} is not a ${t}`);
  }
  for (const k of ["title", "description"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") out.push(`${path}: ${k} must be a string`);
  }
  for (const k of ["default", "examples"] as const) {
    if (raw[k] !== undefined && !isJsonValue(raw[k])) out.push(`${path}: ${k} must be lossless JSON`);
  }
}

/** Assert `raw` is a schema in the subset; every violation is reported, not just the first. */
export function assertSchema(raw: unknown, path = "$"): Schema {
  const violations: string[] = [];
  collect(raw, path, violations);
  if (violations.length) throw new SchemaError(violations);
  return raw as Schema;
}

/** Validate `value` against an asserted schema. Total: never throws on any value. */
export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const out: string[] = [];
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((b) => validate(b, value, path).length === 0).length;
    if (hits !== 1) out.push(`${path}: matched ${hits} of ${schema.oneOf.length} oneOf branches`);
    return out;
  }
  if (schema.type !== undefined) {
    const ok = schema.type === "integer" ? typeof value === "number" && Number.isInteger(value) : typeOf(value) === schema.type;
    if (!ok) { out.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`); return out; }
  }
  if (schema.const !== undefined && value !== schema.const) {
    out.push(`${path}: expected const ${scalarText(schema.const)}, got ${isJsonValue(value) && !isRecord(value) && !Array.isArray(value) ? scalarText(value as Scalar) : typeOf(value)}`);
  }
  if (schema.enum && !schema.enum.includes(value as Scalar)) {
    const got = isJsonValue(value) && !isRecord(value) && !Array.isArray(value) ? scalarText(value as Scalar) : typeOf(value);
    out.push(`${path}: expected one of ${schema.enum.map(scalarText).join(", ")}, got ${got}`);
  }
  if (isRecord(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) out.push(`${path}: missing required property ${JSON.stringify(name)}`);
    }
    for (const [name, v] of Object.entries(value)) {
      const sub = schema.properties?.[name];
      if (sub) out.push(...validate(sub, v, `${path}.${name}`));
      else if (schema.additionalProperties === false) out.push(`${path}: unexpected property ${JSON.stringify(name)}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => out.push(...validate(schema.items as Schema, v, `${path}[${i}]`)));
  }
  return out;
}

/** The `default` of each declared property, for an object-rooted schema. */
export function defaultsOf(schema: Schema): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    if (sub.default !== undefined) out[name] = sub.default;
  }
  return out;
}
```

`src/index.ts` 追加：
```ts
export * from "./core/schema.js";
```

- [ ] **Step 4: 跑测试**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: 全部 PASS（含 purity）。若某条消息文字与断言不一致，改实现不改断言——断言就是消息合同。

- [ ] **Step 5: 提交**

```bash
cd /c/agentProjects/geml-spec
git add integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test
git commit -m "feat(agent-runtime): JSON Schema subset — assert, validate, defaults"
```

---

### Task 4: `core/statechart.ts` — 载入与静态检查

**Files:**
- Create: `integrations/geml-agent-runtime/src/core/statechart.ts`
- Create: `integrations/geml-agent-runtime/test/fixtures/refund.geml`
- Create: `integrations/geml-agent-runtime/test/statechart.test.mjs`
- Modify: `integrations/geml-agent-runtime/src/index.ts`
- Modify: `docs/design/specs/2026-09-14-geml-agent-runtime-design.md` §4.3 表格（加 `agent-dup-edge` 一行）

**Interfaces:**
- Consumes: Task 3 的 `Schema`、`assertSchema`、`SchemaError`；`@geml/geml` 的 `parse`、`unitSpans`、`sliceUnit`、`type Block`、`type Diagnostic`。
- Produces:
  ```ts
  export interface State { id: string; line: number; initial: boolean; final: boolean; pause: boolean; rollbackOnError: boolean; tools?: string[]; vars?: string[]; body: string }
  export interface Transition { id: string; line: number; from: string; to: string; requiresId?: string; requires?: Schema; approval: boolean; body: string }
  export interface Statechart { file: string; hash: string; initial: string; states: Map<string, State>; transitions: Transition[]; vars?: Schema; defaultTools?: string[] }
  export type AgentCode = "agent-no-initial" | "agent-many-initial" | "agent-bad-ref" | "agent-final-outgoing" | "agent-dup-edge" | "agent-vars-schema" | "agent-requires-schema" | "agent-unknown-var" | "agent-unreachable" | "agent-dead-end" | "agent-unknown-tool";
  export interface AgentDiagnostic { severity: "error" | "warning"; code: string; message: string; line: number }   // code: AgentCode or a core geml code
  export function hashText(text: string): string;                                  // "sha256:" + hex, LF-normalized
  export function loadStatechart(source: string, file: string, opts?: { knownTools?: readonly string[] }): { statechart?: Statechart; diagnostics: AgentDiagnostic[] };
  export function outgoing(sc: Statechart, stateId: string): Transition[];
  export function effectiveTools(sc: Statechart, state: State): string[] | undefined;   // undefined = unrestricted; [] = none
  export function allowedVars(sc: Statechart, state: State): string[];
  export function hasErrors(diagnostics: readonly AgentDiagnostic[]): boolean;
  ```
- `statechart` 仅在 `hasErrors(diagnostics) === false` 时存在。核心 `parse` 的诊断原样并入（`code` 是 geml 的码，`message` 原文）。

- [ ] **Step 1: 写 fixture `test/fixtures/refund.geml`**（设计 §4.1 的文档，逐字）

```
=== meta
title   = "Refund approval"
profile = "geml-agent/v1"
tools   = "read_file grep"
===

=== agent-vars {#vars}
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "order":    { "type": "string",  "description": "Order id" },
    "amount":   { "type": "number",  "default": 0 },
    "approved": { "type": "boolean", "default": false }
  }
}
===

=== agent-state {#intake initial vars="order amount"}
Collect the order id and the refund amount from the user. Do not judge yet.
===

=== agent-state {#review vars="approved"}
Check the order against the refund policy in [[#policy]]. Set `approved`, then move on.
===

=== agent-state {#pay tools="pay_refund" vars=none rollback-on-error}
Execute the refund exactly once. If the tool fails, the variables roll back to this state's entry.
===

=== agent-state {#wait-human pause}
Amounts above the threshold need a human. Nothing to do until they answer.
===

=== agent-state {#done final}
Summarize what happened and stop.
===

=== data {#has-order format=json}
{ "type": "object", "required": ["order", "amount"] }
===

=== data {#is-approved format=json}
{ "type": "object", "required": ["approved"], "properties": { "approved": { "const": true } } }
===

=== agent-transition {#to-review from=#intake to=#review requires=#has-order}
The order id and the amount are known.
===

=== agent-transition {#to-pay from=#review to=#pay requires=#is-approved approval}
Policy allows the refund. A human must approve this step.
===

=== agent-transition {#to-wait from=#review to=#wait-human}
The amount is above the threshold; hand over to a human.
===

=== agent-transition {#resume-pay from=#wait-human to=#pay requires=#is-approved}
The human confirmed.
===

=== agent-transition {#finish from=#pay to=#done}
The refund went through.
===

## Refund policy {#policy}

Refunds under 200 need no approval. Above that, a human confirms.
```

- [ ] **Step 2: 写失败的测试 `test/statechart.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart, outgoing, effectiveTools, allowedVars, hashText, hasErrors } from "../dist/core/statechart.js";

const refund = readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8");
const codes = (r) => r.diagnostics.map((d) => `${d.severity}:${d.code}`);
const HEAD = '=== meta\nprofile = "geml-agent/v1"\n===\n\n';

test("the refund statechart loads clean and keeps bodies byte for byte", () => {
  const r = loadStatechart(refund, "refund.geml");
  assert.deepEqual(r.diagnostics, []);
  const sc = r.statechart;
  assert.equal(sc.initial, "intake");
  assert.deepEqual([...sc.states.keys()], ["intake", "review", "pay", "wait-human", "done"]);
  assert.equal(sc.states.get("review").body, "Check the order against the refund policy in [[#policy]]. Set `approved`, then move on.");
  assert.equal(sc.states.get("pay").rollbackOnError, true);
  assert.deepEqual(sc.states.get("pay").tools, ["pay_refund"]);
  assert.deepEqual(sc.states.get("pay").vars, []);
  assert.equal(sc.states.get("wait-human").pause, true);
  assert.equal(sc.states.get("done").final, true);
  assert.deepEqual(sc.defaultTools, ["read_file", "grep"]);
  assert.equal(sc.transitions.length, 5);
  const toPay = sc.transitions.find((t) => t.id === "to-pay");
  assert.equal(toPay.approval, true);
  assert.equal(toPay.requiresId, "is-approved");
  assert.deepEqual(toPay.requires, { type: "object", required: ["approved"], properties: { approved: { const: true } } });
  assert.equal(sc.hash, hashText(refund));
  assert.match(sc.hash, /^sha256:[0-9a-f]{64}$/);
});

test("effectiveTools / allowedVars / outgoing", () => {
  const sc = loadStatechart(refund, "refund.geml").statechart;
  assert.deepEqual(effectiveTools(sc, sc.states.get("intake")), ["read_file", "grep"], "inherits meta tools");
  assert.deepEqual(effectiveTools(sc, sc.states.get("pay")), ["pay_refund"]);
  assert.deepEqual(allowedVars(sc, sc.states.get("intake")), ["order", "amount"]);
  assert.deepEqual(allowedVars(sc, sc.states.get("wait-human")), ["order", "amount", "approved"], "absent vars= means all");
  assert.deepEqual(allowedVars(sc, sc.states.get("pay")), []);
  assert.deepEqual(outgoing(sc, "review").map((t) => t.to), ["pay", "wait-human"]);
  assert.deepEqual(outgoing(sc, "done"), []);
});

test("no meta tools and no tools= means unrestricted", () => {
  const r = loadStatechart(HEAD + "=== agent-state {#a initial final}\nx\n===\n", "t.geml");
  assert.equal(effectiveTools(r.statechart, r.statechart.states.get("a")), undefined);
});

test("tools=none is the empty list", () => {
  const r = loadStatechart(HEAD + "=== agent-state {#a initial final tools=none}\nx\n===\n", "t.geml");
  assert.deepEqual(effectiveTools(r.statechart, r.statechart.states.get("a")), []);
});

test("a core geml error refuses the document and is passed through", () => {
  const r = loadStatechart(HEAD + "=== agent-state {#a initial final}\nSee [[#nowhere]].\n===\n", "t.geml");
  assert.equal(r.statechart, undefined);
  assert.ok(codes(r).some((c) => c.startsWith("error:unresolved")), codes(r).join());
});

test("agent-no-initial / agent-many-initial", () => {
  assert.deepEqual(codes(loadStatechart(HEAD + "=== agent-state {#a final}\nx\n===\n", "t")), ["error:agent-no-initial"]);
  assert.deepEqual(codes(loadStatechart(HEAD + "=== agent-state {#a initial final}\nx\n===\n=== agent-state {#b initial final}\nx\n===\n", "t")), ["error:agent-many-initial"]);
});

test("agent-bad-ref: wrong form, missing target, wrong type", () => {
  const base = HEAD + "=== agent-state {#a initial}\nx\n===\n=== agent-state {#b final}\nx\n===\n";
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#t from=a to=#b}\nx\n===\n", "t")), ["error:agent-bad-ref"]);
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#t from=#a to=#zz}\nx\n===\n", "t")), ["error:agent-bad-ref"]);
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#t from=#a to=#b requires=#a}\nx\n===\n", "t")), ["error:agent-bad-ref"]);
});

test("agent-final-outgoing and agent-dup-edge", () => {
  const base = HEAD + "=== agent-state {#a initial}\nx\n===\n=== agent-state {#b final}\nx\n===\n=== agent-transition {#t from=#a to=#b}\nx\n===\n";
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#u from=#b to=#a}\nx\n===\n", "t")), ["error:agent-final-outgoing"]);
  assert.deepEqual(codes(loadStatechart(base + "=== agent-transition {#u from=#a to=#b}\nx\n===\n", "t")), ["error:agent-dup-edge"]);
});

test("agent-vars-schema: two blocks, non-object root, unsupported keyword", () => {
  const states = "=== agent-state {#a initial final}\nx\n===\n";
  assert.deepEqual(codes(loadStatechart(HEAD + states + '=== agent-vars {#v}\n{"type":"object"}\n===\n=== agent-vars {#w}\n{"type":"object"}\n===\n', "t")), ["error:agent-vars-schema"]);
  assert.deepEqual(codes(loadStatechart(HEAD + states + '=== agent-vars {#v}\n{"type":"string"}\n===\n', "t")), ["error:agent-vars-schema"]);
  const r = loadStatechart(HEAD + states + '=== agent-vars {#v}\n{"type":"object","properties":{"n":{"type":"number","minimum":1}}}\n===\n', "t");
  assert.deepEqual(codes(r), ["error:agent-vars-schema"]);
  assert.match(r.diagnostics[0].message, /unsupported keyword "minimum"/);
});

test("agent-requires-schema and agent-unknown-var", () => {
  const base = HEAD + '=== agent-vars {#v}\n{"type":"object","properties":{"ok":{"type":"boolean"}}}\n===\n'
    + "=== agent-state {#a initial}\nx\n===\n=== agent-state {#b final}\nx\n===\n";
  assert.deepEqual(codes(loadStatechart(base + '=== data {#g format=json}\n{"type":"object","properties":{"ok":{"minimum":1}}}\n===\n=== agent-transition {#t from=#a to=#b requires=#g}\nx\n===\n', "t")), ["error:agent-requires-schema"]);
  assert.deepEqual(codes(loadStatechart(base.replace("{#a initial}", '{#a initial vars="ok nope"}') + "=== agent-transition {#t from=#a to=#b}\nx\n===\n", "t")), ["error:agent-unknown-var"]);
});

test("warnings: unreachable, dead-end, unknown tool (only with knownTools)", () => {
  const src = HEAD + "=== agent-state {#a initial tools=\"bash\"}\nx\n===\n=== agent-state {#b final}\nx\n===\n=== agent-state {#c}\nx\n===\n=== agent-transition {#t from=#a to=#b}\nx\n===\n";
  const r = loadStatechart(src, "t");
  assert.ok(r.statechart, "warnings do not refuse");
  assert.deepEqual(codes(r).sort(), ["warning:agent-dead-end", "warning:agent-unreachable"]);
  const withTools = loadStatechart(src, "t", { knownTools: ["read_file"] });
  assert.ok(codes(withTools).includes("warning:agent-unknown-tool"));
  assert.equal(hasErrors(withTools.diagnostics), false);
});
```

- [ ] **Step 3: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: `statechart.test.mjs` FAIL（模块不存在）。

- [ ] **Step 4: 实现 `src/core/statechart.ts`**

```ts
// Load a `geml-agent/v1` statechart from GEML text and check it statically.
// Pure: text in, model + diagnostics out. The host reads the file.
import { createHash } from "node:crypto";
import { parse, unitSpans, sliceUnit, type Block, type Diagnostic } from "@geml/geml";
import { assertSchema, SchemaError, type Schema } from "./schema.js";

export interface State {
  id: string; line: number;
  initial: boolean; final: boolean; pause: boolean; rollbackOnError: boolean;
  /** Global tool names visible here; undefined = inherit the document default. */
  tools?: string[];
  /** Variables the model may set here; undefined = all. */
  vars?: string[];
  /** The body, byte for byte, without the trailing newline. */
  body: string;
}
export interface Transition {
  id: string; line: number; from: string; to: string;
  requiresId?: string; requires?: Schema; approval: boolean; body: string;
}
export interface Statechart {
  file: string; hash: string; initial: string;
  states: Map<string, State>; transitions: Transition[];
  vars?: Schema; defaultTools?: string[];
}
export type AgentCode =
  | "agent-no-initial" | "agent-many-initial" | "agent-bad-ref" | "agent-final-outgoing" | "agent-dup-edge"
  | "agent-vars-schema" | "agent-requires-schema" | "agent-unknown-var"
  | "agent-unreachable" | "agent-dead-end" | "agent-unknown-tool";
export interface AgentDiagnostic { severity: "error" | "warning"; code: string; message: string; line: number }

type Typed = Extract<Block, { kind: "block" }>;

export function hashText(text: string): string {
  return "sha256:" + createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}

export function hasErrors(diagnostics: readonly AgentDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** Every typed block, depth first — a state may sit inside a flow body. */
function typedBlocks(blocks: readonly Block[], out: Typed[] = []): Typed[] {
  for (const b of blocks) {
    if (b.kind !== "block") continue;
    out.push(b);
    if (b.children) typedBlocks(b.children, out);
  }
  return out;
}

/** `tools="a b"` → ["a","b"]; `tools=none` → []; absent → undefined. Same for `vars`. */
function nameList(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  if (s === "none") return [];
  return s.split(/\s+/).filter((x) => x.length > 0);
}

function refId(v: unknown): string | undefined {
  return typeof v === "string" && v.startsWith("#") && v.length > 1 ? v.slice(1) : undefined;
}

/** Line numbers: the parser does not put one on a block, so recover it from the span layer. */
function lineIndex(source: string): Map<string, { line: number; body: string }> {
  const out = new Map<string, { line: number; body: string }>();
  for (const u of unitSpans(source)) {
    if (u.kind !== "block" || u.id === undefined) continue;
    out.set(u.id, { line: u.span.start + 1, body: sliceUnit(source, u.span, "body").replace(/\r?\n$/, "") });
  }
  return out;
}

export function loadStatechart(source: string, file: string, opts: { knownTools?: readonly string[] } = {}): { statechart?: Statechart; diagnostics: AgentDiagnostic[] } {
  const doc = parse(source);
  const diagnostics: AgentDiagnostic[] = doc.diagnostics.map((d: Diagnostic) => ({ severity: d.severity, code: d.code, message: d.message, line: d.line }));
  const err = (code: AgentCode, message: string, line: number) => diagnostics.push({ severity: "error", code, message, line });
  const warn = (code: AgentCode, message: string, line: number) => diagnostics.push({ severity: "warning", code, message, line });
  if (hasErrors(diagnostics)) return { diagnostics };

  const where = lineIndex(source);
  const at = (id: string | undefined) => (id ? where.get(id)?.line ?? 1 : 1);
  const bodyOf = (id: string | undefined) => (id ? where.get(id)?.body ?? "" : "");
  const blocks = typedBlocks(doc.children);
  const byId = new Map<string, Typed>();
  for (const b of blocks) if (b.id) byId.set(b.id, b);

  // meta defaults
  let defaultTools: string[] | undefined;
  for (const b of blocks) {
    if (b.type === "meta" && b.data && "tools" in b.data) { defaultTools = nameList(b.data["tools"]); break; }
  }

  // variables
  let vars: Schema | undefined;
  const varBlocks = blocks.filter((b) => b.type === "agent-vars");
  if (varBlocks.length > 1) err("agent-vars-schema", `more than one agent-vars block (${varBlocks.map((b) => "#" + (b.id ?? "?")).join(", ")})`, at(varBlocks[1]?.id));
  else if (varBlocks.length === 1) {
    const b = varBlocks[0]!;
    try {
      const raw: unknown = JSON.parse((b.raw ?? []).join("\n"));
      const s = assertSchema(raw);
      if (s.type !== "object") throw new SchemaError(["$: agent-vars must have type object"]);
      vars = s;
    } catch (e) {
      const text = e instanceof SchemaError ? e.violations.join("; ") : e instanceof Error ? e.message : String(e);
      err("agent-vars-schema", `agent-vars #${b.id ?? "?"}: ${text}`, at(b.id));
    }
  }
  const varNames = new Set(Object.keys(vars?.properties ?? {}));

  // states
  const states = new Map<string, State>();
  for (const b of blocks.filter((x) => x.type === "agent-state")) {
    if (!b.id) { err("agent-bad-ref", "agent-state without an id", 1); continue; }
    const a = b.attrs;
    const st: State = {
      id: b.id, line: at(b.id),
      initial: a["initial"] === true, final: a["final"] === true, pause: a["pause"] === true,
      rollbackOnError: a["rollback-on-error"] === true,
      body: bodyOf(b.id),
    };
    const tools = nameList(a["tools"]); if (tools !== undefined) st.tools = tools;
    const vs = nameList(a["vars"]); if (vs !== undefined) st.vars = vs;
    for (const v of vs ?? []) if (!varNames.has(v)) err("agent-unknown-var", `state #${st.id}: vars= names "${v}", which agent-vars does not declare`, st.line);
    states.set(st.id, st);
  }
  const initials = [...states.values()].filter((s) => s.initial);
  if (initials.length === 0) err("agent-no-initial", "no state carries `initial`", 1);
  if (initials.length > 1) err("agent-many-initial", `more than one initial state: ${initials.map((s) => "#" + s.id).join(", ")}`, initials[1]!.line);

  // transitions
  const transitions: Transition[] = [];
  const edges = new Set<string>();
  for (const b of blocks.filter((x) => x.type === "agent-transition")) {
    const id = b.id ?? `transition@${at(b.id)}`;
    const line = at(b.id);
    const from = refId(b.attrs["from"]), to = refId(b.attrs["to"]);
    let bad = false;
    for (const [key, val] of [["from", from], ["to", to]] as const) {
      if (val === undefined) { err("agent-bad-ref", `transition #${id}: ${key}= must be #id of an agent-state`, line); bad = true; }
      else if (!states.has(val)) { err("agent-bad-ref", `transition #${id}: ${key}=#${val} is not an agent-state`, line); bad = true; }
    }
    const t: Transition = { id, line, from: from ?? "", to: to ?? "", approval: b.attrs["approval"] === true, body: bodyOf(b.id) };
    if (b.attrs["requires"] !== undefined) {
      const rid = refId(b.attrs["requires"]);
      const target = rid ? byId.get(rid) : undefined;
      if (!rid || !target || target.type !== "data") { err("agent-bad-ref", `transition #${id}: requires= must be #id of a data block`, line); bad = true; }
      else {
        try { t.requires = assertSchema(target.value); t.requiresId = rid; }
        catch (e) { err("agent-requires-schema", `transition #${id}: #${rid}: ${e instanceof SchemaError ? e.violations.join("; ") : String(e)}`, line); bad = true; }
      }
    }
    if (bad) continue;
    if (states.get(t.from)!.final) err("agent-final-outgoing", `transition #${id} leaves the final state #${t.from}`, line);
    const key = `${t.from}->${t.to}`;
    if (edges.has(key)) err("agent-dup-edge", `transition #${id} duplicates the edge #${t.from} → #${t.to}`, line);
    edges.add(key);
    transitions.push(t);
  }

  if (hasErrors(diagnostics)) return { diagnostics };

  // reachability and dead ends
  const initial = initials[0]!.id;
  const seen = new Set<string>([initial]);
  const queue = [initial];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const t of transitions) if (t.from === cur && !seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
  }
  for (const s of states.values()) {
    if (!seen.has(s.id)) warn("agent-unreachable", `state #${s.id} is not reachable from #${initial}`, s.line);
    if (!s.final && !transitions.some((t) => t.from === s.id)) warn("agent-dead-end", `state #${s.id} is not final and has no outgoing transition`, s.line);
  }
  if (opts.knownTools) {
    const known = new Set(opts.knownTools);
    for (const s of states.values()) {
      for (const name of s.tools ?? defaultTools ?? []) if (!known.has(name)) warn("agent-unknown-tool", `state #${s.id}: tool "${name}" is not registered`, s.line);
    }
  }

  const sc: Statechart = { file, hash: hashText(source), initial, states, transitions };
  if (vars) sc.vars = vars;
  if (defaultTools !== undefined) sc.defaultTools = defaultTools;
  return { statechart: sc, diagnostics };
}

export function outgoing(sc: Statechart, stateId: string): Transition[] {
  return sc.transitions.filter((t) => t.from === stateId);
}

export function effectiveTools(sc: Statechart, state: State): string[] | undefined {
  return state.tools ?? sc.defaultTools;
}

export function allowedVars(sc: Statechart, state: State): string[] {
  return state.vars ?? Object.keys(sc.vars?.properties ?? {});
}
```

`src/index.ts` 追加：`export * from "./core/statechart.js";`

- [ ] **Step 5: 跑测试并按需微调**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: 全部 PASS。可能需要核对两点并据实修实现（不改测试）：① `unitSpans` 的 `Unit.kind` 对 typed block 是否为 `"block"`、`span.start` 是否 0 基行号；② `b.data["tools"]` 对 `tools = "read_file grep"` 是字符串。用 `node -e` 打印一次即可确认。

- [ ] **Step 6: 设计文档 §4.3 表格加一行**

在 `docs/design/specs/2026-09-14-geml-agent-runtime-design.md` §4.3 的 `agent-final-outgoing` 行之后插入：
```
| `agent-dup-edge` | E | 两条跃迁 `from`、`to` 完全相同（`agent_transition` 以目标状态为参数，重边无法区分） |
```

- [ ] **Step 7: 提交**

```bash
cd /c/agentProjects/geml-spec
git add integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test docs/design/specs/2026-09-14-geml-agent-runtime-design.md
git commit -m "feat(agent-runtime): load a geml-agent/v1 statechart and check it statically"
```

---

### Task 5: `core/snapshot.ts` — 快照、哈希链、三个变更动词

**Files:**
- Create: `integrations/geml-agent-runtime/src/core/snapshot.ts`
- Create: `integrations/geml-agent-runtime/test/snapshot.test.mjs`
- Modify: `integrations/geml-agent-runtime/src/index.ts`

**Interfaces:**
- Consumes: Task 3 `validate`、`defaultsOf`、`JsonValue`；Task 4 `Statechart`、`State`、`outgoing`、`allowedVars`。
- Produces:
  ```ts
  export type Cause = "enter" | "transition" | "patch" | "rollback" | "error-rollback";
  export interface Snapshot { v: 1; rev: number; state: string; vars: Record<string, JsonValue>; cause: Cause; parent?: string; hash: string; at: string; call?: string; from?: string; restores?: number }
  export interface Refusal { tool: "agent_transition" | "agent_set" | "agent_rollback"; reason: string; diagnostics: string[] }
  export type Outcome = { ok: true; next: Snapshot } | { ok: false; refusal: Refusal };
  export interface Meta { at: string; call?: string }
  export function canonical(value: JsonValue): string;
  export function hashSnapshot(s: { v: 1; rev: number; parent?: string; state: string; vars: Record<string, JsonValue> }): string;
  export function initialSnapshot(sc: Statechart, at: string): Snapshot;
  export function reenterSnapshot(sc: Statechart, prev: Snapshot, at: string): Snapshot;     // `clear`: back to initial with defaults, cause enter, from = prev.state
  export function applyPatch(sc: Statechart, snap: Snapshot, patch: Record<string, JsonValue>, meta: Meta): Outcome;
  export function applyTransition(sc: Statechart, snap: Snapshot, to: string, meta: Meta): Outcome;
  export function checkpointRev(history: readonly Snapshot[]): number;
  export function applyRollback(sc: Statechart, history: readonly Snapshot[], target: number | "checkpoint", meta: Meta, cause?: "rollback" | "error-rollback"): Outcome;
  ```
- `history` 是到目前为止的全部快照，`rev` 升序，最后一个是当前。

- [ ] **Step 1: 写失败的测试 `test/snapshot.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { canonical, hashSnapshot, initialSnapshot, reenterSnapshot, applyPatch, applyTransition, applyRollback, checkpointRev } from "../dist/core/snapshot.js";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-14T12:00:00Z";
const m = (call) => ({ at: T0, call });

test("canonical sorts keys by code point and emits no whitespace", () => {
  assert.equal(canonical({ b: 1, a: [true, null, { z: "x", y: 2 }] }), '{"a":[true,null,{"y":2,"z":"x"}],"b":1}');
});

test("hashSnapshot is pinned — change the algorithm and this fails on purpose", () => {
  assert.equal(
    hashSnapshot({ v: 1, rev: 0, state: "intake", vars: { amount: 0, approved: false } }),
    "sha256:" + "PINNED_BY_FIRST_RUN",
  );
});

test("initialSnapshot: rev 0, initial state, defaults, no parent", () => {
  const s = initialSnapshot(sc, T0);
  assert.deepEqual(s, { v: 1, rev: 0, state: "intake", vars: { amount: 0, approved: false }, cause: "enter", hash: s.hash, at: T0 });
  assert.equal(s.hash, hashSnapshot({ v: 1, rev: 0, state: "intake", vars: { amount: 0, approved: false } }));
});

test("applyPatch: allowed keys, schema-checked, chained", () => {
  const s0 = initialSnapshot(sc, T0);
  const r = applyPatch(sc, s0, { order: "A-17", amount: 120 }, m("call_01"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.next.vars, { amount: 120, approved: false, order: "A-17" });
  assert.equal(r.next.rev, 1);
  assert.equal(r.next.parent, s0.hash);
  assert.equal(r.next.cause, "patch");
  assert.equal(r.next.call, "call_01");
  assert.equal(r.next.hash, hashSnapshot({ v: 1, rev: 1, parent: s0.hash, state: "intake", vars: r.next.vars }));
});

test("applyPatch refusals: var not allowed here, unknown var, wrong type — nothing changes", () => {
  const s0 = initialSnapshot(sc, T0);
  const notHere = applyPatch(sc, s0, { approved: true }, m());
  assert.equal(notHere.ok, false);
  assert.equal(notHere.refusal.tool, "agent_set");
  assert.match(notHere.refusal.reason, /"approved" cannot be set in state #intake/);
  const unknown = applyPatch(sc, s0, { nope: 1 }, m());
  assert.match(unknown.refusal.reason, /"nope" is not a declared variable/);
  const badType = applyPatch(sc, s0, { amount: "120" }, m());
  assert.deepEqual(badType.refusal.diagnostics, ["$.amount: expected number, got string"]);
});

test("applyTransition: guard, chain, from; refusals for no edge and failed requires", () => {
  const s0 = initialSnapshot(sc, T0);
  const blocked = applyTransition(sc, s0, "review", m());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.refusal.tool, "agent_transition");
  assert.match(blocked.refusal.reason, /requires #has-order failed/);
  assert.deepEqual(blocked.refusal.diagnostics, ['$: missing required property "order"', '$: missing required property "amount"']);
  const noEdge = applyTransition(sc, s0, "done", m());
  assert.match(noEdge.refusal.reason, /no transition from #intake to #done/);

  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, m()).next;
  const r = applyTransition(sc, s1, "review", m("call_02"));
  assert.equal(r.ok, true);
  assert.equal(r.next.state, "review");
  assert.equal(r.next.from, "intake");
  assert.equal(r.next.cause, "transition");
  assert.equal(r.next.rev, 2);
  assert.equal(r.next.parent, s1.hash);
});

test("checkpointRev and applyRollback", () => {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, m()).next;
  const s2 = applyTransition(sc, s1, "review", m()).next;
  const s3 = applyPatch(sc, s2, { approved: true }, m()).next;
  const history = [s0, s1, s2, s3];
  assert.equal(checkpointRev(history), 2, "the revision at which #review was entered");
  const back = applyRollback(sc, history, "checkpoint", m("call_09"));
  assert.equal(back.ok, true);
  assert.deepEqual(back.next.vars, s2.vars);
  assert.equal(back.next.state, "review");
  assert.equal(back.next.rev, 4);
  assert.equal(back.next.restores, 2);
  assert.equal(back.next.cause, "rollback");
  assert.equal(back.next.from, "review");
  const toZero = applyRollback(sc, history, 0, m(), "error-rollback");
  assert.equal(toZero.next.state, "intake");
  assert.equal(toZero.next.cause, "error-rollback");
  assert.equal(toZero.next.restores, 0);
  const bad = applyRollback(sc, history, 9, m());
  assert.equal(bad.ok, false);
  assert.equal(bad.refusal.tool, "agent_rollback");
  assert.match(bad.refusal.reason, /revision 9 does not exist/);
});

test("reenterSnapshot goes back to the initial state with defaults and records where it came from", () => {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, m()).next;
  const s2 = applyTransition(sc, s1, "review", m()).next;
  const re = reenterSnapshot(sc, s2, T0);
  assert.equal(re.rev, 3);
  assert.equal(re.state, "intake");
  assert.equal(re.from, "review");
  assert.equal(re.cause, "enter");
  assert.deepEqual(re.vars, { amount: 0, approved: false });
  assert.equal(re.parent, s2.hash);
});
```

- [ ] **Step 2: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: `snapshot.test.mjs` FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/core/snapshot.ts`**

```ts
// The run's state: one immutable Snapshot per revision, hash-chained. The three
// verbs compute a candidate, validate it, and either return it or a Refusal —
// a refused change produces no snapshot, so the ledger never holds a bad one.
import { createHash } from "node:crypto";
import { defaultsOf, validate, type JsonValue } from "./schema.js";
import { allowedVars, outgoing, type Statechart } from "./statechart.js";

export type Cause = "enter" | "transition" | "patch" | "rollback" | "error-rollback";

export interface Snapshot {
  v: 1;
  rev: number;
  state: string;
  vars: Record<string, JsonValue>;
  cause: Cause;
  parent?: string;
  hash: string;
  at: string;
  call?: string;
  from?: string;
  restores?: number;
}
export interface Refusal { tool: "agent_transition" | "agent_set" | "agent_rollback"; reason: string; diagnostics: string[] }
export type Outcome = { ok: true; next: Snapshot } | { ok: false; refusal: Refusal };
export interface Meta { at: string; call?: string }

/** Canonical JSON: keys sorted by code point, no whitespace. The hashed form. */
export function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k] as JsonValue)).join(",") + "}";
}

export function hashSnapshot(s: { v: 1; rev: number; parent?: string; state: string; vars: Record<string, JsonValue> }): string {
  const payload = canonical({ v: s.v, rev: s.rev, parent: s.parent ?? null, state: s.state, vars: s.vars });
  return "sha256:" + createHash("sha256").update(payload, "utf8").digest("hex");
}

function seal(s: Omit<Snapshot, "hash">): Snapshot {
  const out: Snapshot = { ...s, hash: hashSnapshot({ v: 1, rev: s.rev, ...(s.parent !== undefined ? { parent: s.parent } : {}), state: s.state, vars: s.vars }) };
  return out;
}

function child(prev: Snapshot, meta: Meta, fields: Partial<Snapshot> & { state: string; vars: Record<string, JsonValue>; cause: Cause }): Snapshot {
  const base: Omit<Snapshot, "hash"> = { v: 1, rev: prev.rev + 1, parent: prev.hash, at: meta.at, ...fields };
  if (meta.call !== undefined) base.call = meta.call;
  return seal(base);
}

export function initialSnapshot(sc: Statechart, at: string): Snapshot {
  return seal({ v: 1, rev: 0, state: sc.initial, vars: sc.vars ? defaultsOf(sc.vars) : {}, cause: "enter", at });
}

/** `clear`: a fresh start recorded on the same chain. */
export function reenterSnapshot(sc: Statechart, prev: Snapshot, at: string): Snapshot {
  return child(prev, { at }, { state: sc.initial, vars: sc.vars ? defaultsOf(sc.vars) : {}, cause: "enter", from: prev.state });
}

const refuse = (tool: Refusal["tool"], reason: string, diagnostics: string[] = []): Outcome => ({ ok: false, refusal: { tool, reason, diagnostics } });

export function applyPatch(sc: Statechart, snap: Snapshot, patch: Record<string, JsonValue>, meta: Meta): Outcome {
  const state = sc.states.get(snap.state);
  if (!state) return refuse("agent_set", `current state #${snap.state} is not in the statechart`);
  const declared = new Set(Object.keys(sc.vars?.properties ?? {}));
  const allowed = new Set(allowedVars(sc, state));
  for (const k of Object.keys(patch)) {
    if (!declared.has(k)) return refuse("agent_set", `"${k}" is not a declared variable`);
    if (!allowed.has(k)) return refuse("agent_set", `"${k}" cannot be set in state #${state.id}`);
  }
  const merged: Record<string, JsonValue> = { ...snap.vars, ...patch };
  const diagnostics = sc.vars ? validate(sc.vars, merged) : [];
  if (diagnostics.length) return refuse("agent_set", `patch rejected by agent-vars schema`, diagnostics);
  return { ok: true, next: child(snap, meta, { state: snap.state, vars: merged, cause: "patch" }) };
}

export function applyTransition(sc: Statechart, snap: Snapshot, to: string, meta: Meta): Outcome {
  const t = outgoing(sc, snap.state).find((x) => x.to === to);
  if (!t) return refuse("agent_transition", `no transition from #${snap.state} to #${to}`);
  if (t.requires) {
    const diagnostics = validate(t.requires, snap.vars);
    if (diagnostics.length) return refuse("agent_transition", `transition #${t.id}: requires #${t.requiresId} failed`, diagnostics);
  }
  return { ok: true, next: child(snap, meta, { state: t.to, vars: snap.vars, cause: "transition", from: snap.state }) };
}

/** The revision at which the current state was entered: the last non-patch revision. */
export function checkpointRev(history: readonly Snapshot[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.cause !== "patch") return history[i]!.rev;
  }
  return 0;
}

export function applyRollback(sc: Statechart, history: readonly Snapshot[], target: number | "checkpoint", meta: Meta, cause: "rollback" | "error-rollback" = "rollback"): Outcome {
  const current = history[history.length - 1];
  if (!current) return refuse("agent_rollback", "no revision to roll back from");
  const rev = target === "checkpoint" ? checkpointRev(history) : target;
  const found = history.find((s) => s.rev === rev);
  if (!found) return refuse("agent_rollback", `revision ${rev} does not exist`);
  if (!sc.states.has(found.state)) return refuse("agent_rollback", `revision ${rev} is in state #${found.state}, which the statechart no longer has`);
  return { ok: true, next: child(current, meta, { state: found.state, vars: found.vars, cause, from: current.state, restores: rev }) };
}
```

`src/index.ts` 追加：`export * from "./core/snapshot.js";`

- [ ] **Step 4: 跑测试，钉哈希**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: 只有「hashSnapshot is pinned」FAIL，输出实际值。把测试里的 `"PINNED_BY_FIRST_RUN"` 换成那 64 个十六进制字符，再跑一次全 PASS。（从此算法变了测试必红——这是钉子的意义。）

- [ ] **Step 5: 提交**

```bash
cd /c/agentProjects/geml-spec
git add integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test
git commit -m "feat(agent-runtime): snapshots — canonical hash chain, patch/transition/rollback"
```

---

### Task 6: `core/ledger.ts` — 台账渲染、读取、校验

**Files:**
- Create: `integrations/geml-agent-runtime/src/core/ledger.ts`
- Create: `integrations/geml-agent-runtime/test/ledger.test.mjs`
- Modify: `integrations/geml-agent-runtime/src/index.ts`

**Interfaces:**
- Consumes: Task 5 `Snapshot`、`Refusal`、`canonical`、`hashSnapshot`；Task 4 `Statechart`、`outgoing`；`@geml/geml` `parse`。
- Produces:
  ```ts
  export interface LedgerMeta { session: string; statechart: string; statechartHash: string; created: string }
  export interface Refused { n: number; rev: number; at: string; tool: string; call?: string; reason: string; diagnostics: string[] }
  export interface Ledger { meta: LedgerMeta; snapshots: Snapshot[]; refusals: Refused[]; diagnostics: string[] }
  export function renderLedgerHead(meta: LedgerMeta): string;
  export function renderSnapshotBlock(s: Snapshot): string;
  export function renderRefusedBlock(r: Refused): string;
  export function readLedger(source: string): Ledger;
  export function verifyLedger(ledger: Ledger, sc?: Statechart): string[];   // [] = ok
  ```
- 渲染出的每个块以 `===\n\n` 结束（块后一个空行），首块之前是 head；文件整体 LF。

- [ ] **Step 1: 写失败的测试 `test/ledger.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "@geml/geml";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition, applyRollback } from "../dist/core/snapshot.js";
import { renderLedgerHead, renderSnapshotBlock, renderRefusedBlock, readLedger, verifyLedger } from "../dist/core/ledger.js";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-14T12:00:00Z";
const meta = { session: "session-1", statechart: "refund.geml", statechartHash: sc.hash, created: T0 };

function run() {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, { at: T0, call: "call_01" }).next;
  const refused = applyTransition(sc, s0, "review", { at: T0, call: "call_02" }).refusal;
  const s2 = applyTransition(sc, s1, "review", { at: T0, call: "call_03" }).next;
  const s3 = applyRollback(sc, [s0, s1, s2], 1, { at: T0, call: "call_04" }).next;
  const text = renderLedgerHead(meta) + renderSnapshotBlock(s0) + renderSnapshotBlock(s1)
    + renderRefusedBlock({ n: 1, rev: 1, at: T0, tool: refused.tool, call: "call_02", reason: refused.reason, diagnostics: refused.diagnostics })
    + renderSnapshotBlock(s2) + renderSnapshotBlock(s3);
  return { text, snapshots: [s0, s1, s2, s3] };
}

test("a rendered ledger is a clean geml-agent/v1 document", () => {
  const { text } = run();
  const doc = parse(text);
  assert.deepEqual(doc.diagnostics, []);
  assert.deepEqual(doc.ids.filter((id) => id.startsWith("rev-")), ["rev-0", "rev-1", "rev-2", "rev-3"]);
  assert.ok(doc.ids.includes("refused-1"));
  assert.ok(text.includes("state=#intake cause=enter hash=\"sha256:"), "attributes in the documented spelling");
  assert.ok(!text.includes("\r"), "LF only");
});

test("readLedger round-trips snapshots and refusals", () => {
  const { text, snapshots } = run();
  const ledger = readLedger(text);
  assert.deepEqual(ledger.diagnostics, []);
  assert.deepEqual(ledger.meta, meta);
  assert.deepEqual(ledger.snapshots, snapshots);
  assert.equal(ledger.refusals.length, 1);
  assert.equal(ledger.refusals[0].tool, "agent_transition");
  assert.deepEqual(ledger.refusals[0].diagnostics, ['$: missing required property "order"', '$: missing required property "amount"']);
  assert.equal(ledger.refusals[0].rev, 1);
});

test("verifyLedger passes a genuine chain, with and without the statechart", () => {
  const ledger = readLedger(run().text);
  assert.deepEqual(verifyLedger(ledger), []);
  assert.deepEqual(verifyLedger(ledger, sc), []);
});

test("verifyLedger catches: edited vars, broken parent, missing revision, reordered blocks, unknown state, undeclared edge", () => {
  const { text } = run();
  const tamper = (fn) => verifyLedger(readLedger(fn(text)), sc);
  assert.deepEqual(tamper((t) => t.replace('"amount":120', '"amount":999')), ["#rev-1: hash does not match its content"]);
  assert.deepEqual(tamper((t) => t.replace(/parent="sha256:[0-9a-f]{64}"/, 'parent="sha256:' + "0".repeat(64) + '"')),
    ["#rev-1: parent does not equal the previous hash", "#rev-1: hash does not match its content"]);
  const blocks = text.split("\n\n");
  const dropped = blocks.filter((b) => !b.startsWith("=== agent-snapshot {#rev-2")).join("\n\n");
  assert.deepEqual(tamper(() => dropped), ["#rev-3: rev is not contiguous (expected 2)", "#rev-3: parent does not equal the previous hash"]);
  const swapped = text.replace("{#rev-2 rev=2", "{#rev-X rev=2").replace("{#rev-3 rev=3", "{#rev-2 rev=2").replace("{#rev-X rev=2", "{#rev-3 rev=3");
  assert.ok(tamper(() => swapped).length > 0, "reordering breaks the chain");
  assert.deepEqual(tamper((t) => t.replace("state=#review cause=transition", "state=#nowhere cause=transition")),
    ["#rev-2: hash does not match its content", "#rev-2: state #nowhere is not in the statechart", "#rev-2: no transition #intake → #nowhere in the statechart"]);
});

test("verifyLedger checks cause / from / restores consistency", () => {
  const { text } = run();
  const noFrom = text.replace(/ from=#intake/, "");
  const errs = verifyLedger(readLedger(noFrom), sc);
  assert.ok(errs.includes("#rev-2: hash does not match its content") === false, "from is not hashed");
  assert.ok(errs.includes("#rev-2: cause transition needs from="));
  const badRestore = text.replace("restores=1", "restores=7");
  assert.ok(verifyLedger(readLedger(badRestore)).includes("#rev-3: restores must name an earlier revision"));
});

test("readLedger reports a malformed body without throwing", () => {
  const { text } = run();
  const broken = text.replace('{"amount":0,"approved":false}', "{not json");
  const ledger = readLedger(broken);
  assert.deepEqual(ledger.diagnostics, ["#rev-0: body is not JSON"]);
  assert.equal(ledger.snapshots.length, 3);
});
```

- [ ] **Step 2: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: `ledger.test.mjs` FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/core/ledger.ts`**

```ts
// The ledger: the run's record of truth, a geml-agent/v1 document written by
// blind append. Rendering is text out; reading parses with @geml/geml.
import { parse, type Block } from "@geml/geml";
import { canonical, hashSnapshot, type Cause, type Snapshot } from "./snapshot.js";
import { outgoing, type Statechart } from "./statechart.js";
import type { JsonValue } from "./schema.js";

export interface LedgerMeta { session: string; statechart: string; statechartHash: string; created: string }
export interface Refused { n: number; rev: number; at: string; tool: string; call?: string; reason: string; diagnostics: string[] }
export interface Ledger { meta: LedgerMeta; snapshots: Snapshot[]; refusals: Refused[]; diagnostics: string[] }

const CAUSES: ReadonlySet<string> = new Set(["enter", "transition", "patch", "rollback", "error-rollback"]);

/** Attribute value spelling: bare when it is a plain word, quoted otherwise. Numbers stay bare. */
function attr(v: string | number): string {
  if (typeof v === "number") return String(v);
  return /^[A-Za-z0-9_#-]+$/.test(v) ? v : JSON.stringify(v);
}

export function renderLedgerHead(meta: LedgerMeta): string {
  return [
    "=== meta",
    'title           = "geml-agent ledger"',
    'profile         = "geml-agent/v1"',
    `session         = ${JSON.stringify(meta.session)}`,
    `statechart      = ${JSON.stringify(meta.statechart)}`,
    `statechart-hash = ${JSON.stringify(meta.statechartHash)}`,
    `created         = ${JSON.stringify(meta.created)}`,
    "===",
    "",
    "",
  ].join("\n");
}

export function renderSnapshotBlock(s: Snapshot): string {
  const parts = [`#rev-${s.rev}`, `rev=${s.rev}`, `state=#${s.state}`, `cause=${s.cause}`];
  if (s.parent !== undefined) parts.push(`parent=${attr(s.parent)}`);
  parts.push(`hash=${attr(s.hash)}`, `at=${attr(s.at)}`);
  if (s.call !== undefined) parts.push(`call=${attr(s.call)}`);
  if (s.from !== undefined) parts.push(`from=#${s.from}`);
  if (s.restores !== undefined) parts.push(`restores=${s.restores}`);
  return `=== agent-snapshot {${parts.join(" ")}}\n${canonical(s.vars)}\n===\n\n`;
}

export function renderRefusedBlock(r: Refused): string {
  const parts = [`#refused-${r.n}`, `rev=${r.rev}`, `at=${attr(r.at)}`, `tool=${attr(r.tool)}`];
  if (r.call !== undefined) parts.push(`call=${attr(r.call)}`);
  const body = canonical({ reason: r.reason, diagnostics: r.diagnostics });
  return `=== agent-refused {${parts.join(" ")}}\n${body}\n===\n\n`;
}

type Typed = Extract<Block, { kind: "block" }>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export function readLedger(source: string): Ledger {
  const doc = parse(source);
  const diagnostics: string[] = doc.diagnostics.filter((d) => d.severity === "error").map((d) => `line ${d.line}: ${d.message}`);
  const meta: LedgerMeta = { session: "", statechart: "", statechartHash: "", created: "" };
  const snapshots: Snapshot[] = [];
  const refusals: Refused[] = [];
  for (const b of doc.children) {
    if (b.kind !== "block") continue;
    const blk = b as Typed;
    if (blk.type === "meta" && blk.data) {
      meta.session = str(blk.data["session"]) ?? meta.session;
      meta.statechart = str(blk.data["statechart"]) ?? meta.statechart;
      meta.statechartHash = str(blk.data["statechart-hash"]) ?? meta.statechartHash;
      meta.created = str(blk.data["created"]) ?? meta.created;
      if (str(blk.data["profile"]) !== "geml-agent/v1") diagnostics.push("meta: profile is not geml-agent/v1");
      continue;
    }
    const label = `#${blk.id ?? "?"}`;
    let body: JsonValue;
    try { body = JSON.parse((blk.raw ?? []).join("\n")) as JsonValue; }
    catch { if (blk.type === "agent-snapshot" || blk.type === "agent-refused") diagnostics.push(`${label}: body is not JSON`); continue; }
    if (blk.type === "agent-snapshot") {
      const a = blk.attrs;
      const rev = num(a["rev"]), state = str(a["state"]), cause = str(a["cause"]), hash = str(a["hash"]), at = str(a["at"]);
      if (rev === undefined || !state?.startsWith("#") || !cause || !CAUSES.has(cause) || !hash || !at || typeof body !== "object" || body === null || Array.isArray(body)) {
        diagnostics.push(`${label}: missing or malformed attributes`); continue;
      }
      const s: Snapshot = { v: 1, rev, state: state.slice(1), vars: body as Record<string, JsonValue>, cause: cause as Cause, hash, at };
      const parent = str(a["parent"]); if (parent !== undefined) s.parent = parent;
      const call = str(a["call"]); if (call !== undefined) s.call = call;
      const from = str(a["from"]); if (from !== undefined && from.startsWith("#")) s.from = from.slice(1);
      const restores = num(a["restores"]); if (restores !== undefined) s.restores = restores;
      snapshots.push(s);
    } else if (blk.type === "agent-refused") {
      const a = blk.attrs;
      const rec = body as Record<string, JsonValue>;
      const r: Refused = {
        n: Number((blk.id ?? "refused-0").replace(/^refused-/, "")),
        rev: num(a["rev"]) ?? -1, at: str(a["at"]) ?? "", tool: str(a["tool"]) ?? "",
        reason: str(rec["reason"]) ?? "", diagnostics: Array.isArray(rec["diagnostics"]) ? (rec["diagnostics"] as JsonValue[]).map(String) : [],
      };
      const call = str(a["call"]); if (call !== undefined) r.call = call;
      refusals.push(r);
    }
  }
  return { meta, snapshots, refusals, diagnostics };
}

export function verifyLedger(ledger: Ledger, sc?: Statechart): string[] {
  const errors: string[] = [...ledger.diagnostics];
  let prev: Snapshot | undefined;
  for (const s of ledger.snapshots) {
    const label = `#rev-${s.rev}`;
    const expectedRev = prev ? prev.rev + 1 : 0;
    if (s.rev !== expectedRev) errors.push(`${label}: rev is not contiguous (expected ${expectedRev})`);
    if (prev && s.parent !== prev.hash) errors.push(`${label}: parent does not equal the previous hash`);
    if (!prev && s.parent !== undefined) errors.push(`${label}: the first revision has no parent`);
    const recomputed = hashSnapshot({ v: 1, rev: s.rev, ...(s.parent !== undefined ? { parent: s.parent } : {}), state: s.state, vars: s.vars });
    if (recomputed !== s.hash) errors.push(`${label}: hash does not match its content`);
    if ((s.cause === "transition" || s.cause === "rollback" || s.cause === "error-rollback") && s.from === undefined) errors.push(`${label}: cause ${s.cause} needs from=`);
    if (s.cause === "rollback" || s.cause === "error-rollback") {
      if (s.restores === undefined || s.restores >= s.rev || !ledger.snapshots.some((x) => x.rev === s.restores)) errors.push(`${label}: restores must name an earlier revision`);
    }
    if (sc) {
      if (!sc.states.has(s.state)) errors.push(`${label}: state #${s.state} is not in the statechart`);
      if (s.cause === "transition" && s.from !== undefined && !outgoing(sc, s.from).some((t) => t.to === s.state)) {
        errors.push(`${label}: no transition #${s.from} → #${s.state} in the statechart`);
      }
    }
    prev = s;
  }
  return errors;
}
```

`src/index.ts` 追加：`export * from "./core/ledger.js";`

- [ ] **Step 4: 跑测试并对齐消息**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: 全部 PASS。若「reordered blocks」那条断言因替换字串不精确而没触发，改测试里的替换方式（这一条断言的是「有错」，不是具体文字）；其余消息以测试为合同。

- [ ] **Step 5: 提交**

```bash
cd /c/agentProjects/geml-spec
git add integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test
git commit -m "feat(agent-runtime): ledger — render, read, verify the hash chain"
```

---

### Task 7: `core/prompt.ts` — 模型看到的快照与跃迁说明

**Files:**
- Create: `integrations/geml-agent-runtime/src/core/prompt.ts`
- Create: `integrations/geml-agent-runtime/test/prompt.test.mjs`
- Modify: `integrations/geml-agent-runtime/src/index.ts`

**Interfaces:**
- Consumes: Task 4 `Statechart`、`State`、`outgoing`、`effectiveTools`、`allowedVars`；Task 5 `Snapshot`、`canonical`。
- Produces:
  ```ts
  export function describeTransitions(sc: Statechart, stateId: string): string;   // one line per edge: "#id → #to: body (requires #x; needs approval)"
  export function renderContext(sc: Statechart, snap: Snapshot): string;          // the runtime-context snapshot, ≤ ~400 bytes for the fixture
  export function visibleTools(sc: Statechart, state: State, globalNames: readonly string[]): { kind: "unrestricted" } | { kind: "allow"; names: string[] };
  ```

- [ ] **Step 1: 写失败的测试 `test/prompt.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition } from "../dist/core/snapshot.js";
import { describeTransitions, renderContext, visibleTools } from "../dist/core/prompt.js";

const sc = loadStatechart(readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"), "refund.geml").statechart;
const T0 = "2026-09-14T12:00:00Z";

test("describeTransitions lists each edge with its guard and approval flag", () => {
  assert.equal(describeTransitions(sc, "review"),
    "#to-pay → #pay: Policy allows the refund. A human must approve this step. (requires #is-approved; needs approval)\n"
    + "#to-wait → #wait-human: The amount is above the threshold; hand over to a human.");
  assert.equal(describeTransitions(sc, "done"), "(none — this is a final state)");
});

test("renderContext is small and says where we are, what we hold, where we can go", () => {
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, { at: T0 }).next;
  const s2 = applyTransition(sc, s1, "review", { at: T0 }).next;
  const text = renderContext(sc, s2);
  assert.equal(text,
    `[geml-agent] state #review · rev 2 · ${s2.hash.slice(0, 19)}…\n`
    + 'vars: {"amount":120,"approved":false,"order":"A-17"}\n'
    + "transitions: #to-pay → #pay (requires #is-approved, needs approval) · #to-wait → #wait-human\n"
    + "tools here: read_file grep · settable vars: approved");
  assert.ok(Buffer.byteLength(text, "utf8") < 400);
});

test("renderContext spells out none / unrestricted / final", () => {
  const pay = { ...initialSnapshot(sc, T0), state: "pay" };
  assert.match(renderContext(sc, pay), /tools here: pay_refund · settable vars: none/);
  const done = { ...initialSnapshot(sc, T0), state: "done" };
  assert.match(renderContext(sc, done), /transitions: \(none — this is a final state\)/);
  const open = loadStatechart('=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a initial final}\nx\n===\n', "t").statechart;
  assert.match(renderContext(open, initialSnapshot(open, T0)), /tools here: \(unrestricted\)/);
});

test("visibleTools intersects the state's list with what is registered", () => {
  assert.deepEqual(visibleTools(sc, sc.states.get("intake"), ["grep", "bash", "read_file"]), { kind: "allow", names: ["read_file", "grep"] });
  assert.deepEqual(visibleTools(sc, sc.states.get("pay"), ["grep"]), { kind: "allow", names: [] });
  const open = loadStatechart('=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a initial final}\nx\n===\n', "t").statechart;
  assert.deepEqual(visibleTools(open, open.states.get("a"), ["grep"]), { kind: "unrestricted" });
});
```

- [ ] **Step 2: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: `prompt.test.mjs` FAIL。

- [ ] **Step 3: 实现 `src/core/prompt.ts`**

```ts
// What the model is shown: the per-step context snapshot and the wording of
// the agent_transition tool. Text only; nothing here knows about DSH.
import { canonical, type Snapshot } from "./snapshot.js";
import { allowedVars, effectiveTools, outgoing, type State, type Statechart } from "./statechart.js";

function edgeTail(t: { requiresId?: string; approval: boolean }, sep: string): string {
  const notes: string[] = [];
  if (t.requiresId) notes.push(`requires #${t.requiresId}`);
  if (t.approval) notes.push("needs approval");
  return notes.length ? ` (${notes.join(sep)})` : "";
}

export function describeTransitions(sc: Statechart, stateId: string): string {
  const edges = outgoing(sc, stateId);
  if (edges.length === 0) {
    const s = sc.states.get(stateId);
    return s?.final ? "(none — this is a final state)" : "(none)";
  }
  return edges.map((t) => `#${t.id} → #${t.to}: ${t.body}${edgeTail(t, "; ")}`).join("\n");
}

export function visibleTools(sc: Statechart, state: State, globalNames: readonly string[]): { kind: "unrestricted" } | { kind: "allow"; names: string[] } {
  const wanted = effectiveTools(sc, state);
  if (wanted === undefined) return { kind: "unrestricted" };
  const known = new Set(globalNames);
  return { kind: "allow", names: wanted.filter((n) => known.has(n)) };
}

export function renderContext(sc: Statechart, snap: Snapshot): string {
  const state = sc.states.get(snap.state);
  const edges = outgoing(sc, snap.state);
  const transitions = edges.length
    ? edges.map((t) => `#${t.id} → #${t.to}${edgeTail(t, ", ")}`).join(" · ")
    : state?.final ? "(none — this is a final state)" : "(none)";
  const tools = state ? effectiveTools(sc, state) : undefined;
  const toolsText = tools === undefined ? "(unrestricted)" : tools.length ? tools.join(" ") : "none";
  const vars = state ? allowedVars(sc, state) : [];
  const varsText = vars.length ? vars.join(" ") : "none";
  return `[geml-agent] state #${snap.state} · rev ${snap.rev} · ${snap.hash.slice(0, 19)}…\n`
    + `vars: ${canonical(snap.vars)}\n`
    + `transitions: ${transitions}\n`
    + `tools here: ${toolsText} · settable vars: ${varsText}`;
}
```

`src/index.ts` 追加：`export * from "./core/prompt.js";`

- [ ] **Step 4: 跑测试**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd /c/agentProjects/geml-spec
git add integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test
git commit -m "feat(agent-runtime): prompt text — context snapshot, transition wording, visible tools"
```

---

### Task 8: `host-fs.ts` + `cli.ts` — `geml-agent check|snapshot|verify|export|init`

**Files:**
- Create: `integrations/geml-agent-runtime/src/host-fs.ts`
- Create: `integrations/geml-agent-runtime/src/cli.ts`
- Create: `integrations/geml-agent-runtime/examples/refund/agent.geml`（fixture 的逐字拷贝）
- Create: `integrations/geml-agent-runtime/test/cli.test.mjs`

**Interfaces:**
- Consumes: Task 4–7 全部。
- Produces:
  ```ts
  // host-fs.ts
  export function readText(path: string): string;                 // utf8
  export function writeNew(path: string, text: string): void;      // flag "wx": refuses to overwrite; creates parent dirs
  export function appendText(path: string, text: string): void;    // one appendFileSync call
  ```
  CLI 退出码：0 成功 / 1 文档或校验失败 / 2 用法。诊断行格式 `${severity}: ${code}: ${message} (line N)`，汇总行 `${errs} error(s), ${warns} warning(s)`；stderr 放诊断，stdout 放结果。

- [ ] **Step 1: 写失败的测试 `test/cli.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot, applyPatch, applyTransition } from "../dist/core/snapshot.js";
import { renderLedgerHead, renderSnapshotBlock } from "../dist/core/ledger.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/refund.geml", import.meta.url));
function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const ws = () => mkdtempSync(join(tmpdir(), "geml-agent-"));

test("no verb prints usage and exits 2", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: geml-agent <check\|snapshot\|verify\|export\|init>/);
});

test("check: clean statechart exits 0 and says so", () => {
  const r = run(["check", FIX]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /ok: no diagnostics/);
});

test("check: errors exit 1 with code-tagged lines; --tools adds unknown-tool warnings", () => {
  const dir = ws();
  writeFileSync(join(dir, "bad.geml"), '=== meta\nprofile = "geml-agent/v1"\n===\n=== agent-state {#a final}\nx\n===\n');
  const r = run(["check", "bad.geml"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /^error: agent-no-initial: no state carries `initial` \(line 1\)$/m);
  assert.match(r.err, /1 error\(s\), 0 warning\(s\)/);
  const w = run(["check", FIX, "--tools", "read_file,grep"]);
  assert.equal(w.code, 0);
  assert.match(w.err, /warning: agent-unknown-tool: state #pay: tool "pay_refund" is not registered/);
  rmSync(dir, { recursive: true, force: true });
});

function ledgerIn(dir) {
  const sc = loadStatechart(readFileSync(FIX, "utf8"), "refund.geml").statechart;
  const T0 = "2026-09-14T12:00:00Z";
  const s0 = initialSnapshot(sc, T0);
  const s1 = applyPatch(sc, s0, { order: "A-17", amount: 120 }, { at: T0, call: "call_01" }).next;
  const s2 = applyTransition(sc, s1, "review", { at: T0, call: "call_02" }).next;
  const text = renderLedgerHead({ session: "s1", statechart: FIX, statechartHash: sc.hash, created: T0 })
    + renderSnapshotBlock(s0) + renderSnapshotBlock(s1) + renderSnapshotBlock(s2);
  writeFileSync(join(dir, "ledger.geml"), text);
  return { s2 };
}

test("snapshot prints the last revision, --json gives the object", () => {
  const dir = ws();
  const { s2 } = ledgerIn(dir);
  const r = run(["snapshot", "ledger.geml"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^rev 2 · state #review · cause transition · from #intake/m);
  const j = run(["snapshot", "ledger.geml", "--json"], dir);
  assert.deepEqual(JSON.parse(j.out), s2);
  rmSync(dir, { recursive: true, force: true });
});

test("verify: clean chain exits 0; a tampered one exits 1 listing the errors", () => {
  const dir = ws();
  ledgerIn(dir);
  assert.equal(run(["verify", "ledger.geml", "--statechart", FIX], dir).code, 0);
  const p = join(dir, "ledger.geml");
  writeFileSync(p, readFileSync(p, "utf8").replace('"amount":120', '"amount":1'));
  const r = run(["verify", "ledger.geml"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /#rev-1: hash does not match its content/);
  rmSync(dir, { recursive: true, force: true });
});

test("export --to md renders a revision table with per-step diffs", () => {
  const dir = ws();
  ledgerIn(dir);
  const r = run(["export", "ledger.geml", "--to", "md"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\| rev \| at \| cause \| state \| call \| changes \|$/m);
  assert.match(r.out, /\| 1 \| 2026-09-14T12:00:00Z \| patch \| #intake \| call_01 \| amount: 0 → 120; order: ∅ → "A-17" \|/);
  assert.match(r.out, /\| 2 \| .* \| transition \| #review \| call_02 \| — \|/);
  rmSync(dir, { recursive: true, force: true });
});

test("init writes the example statechart and refuses to overwrite", () => {
  const dir = ws();
  const r = run(["init"], dir);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(dir, "agent.geml")));
  assert.equal(readFileSync(join(dir, "agent.geml"), "utf8"), readFileSync(FIX, "utf8").replace(/\r\n/g, "\n"));
  assert.equal(run(["check", "agent.geml"], dir).code, 0);
  const again = run(["init"], dir);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑一次确认失败**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: `cli.test.mjs` FAIL（`dist/cli.js` 不存在）。

- [ ] **Step 3: 拷贝示例**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && mkdir -p examples/refund && cp test/fixtures/refund.geml examples/refund/agent.geml
```

- [ ] **Step 4: 实现 `src/host-fs.ts`**

```ts
// The only module that touches the file system. Everything under core/ is pure.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/** Create a file that must not exist yet (flag "wx"), making parent directories. */
export function writeNew(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
}

/** Blind append: one call, no read. */
export function appendText(path: string, text: string): void {
  appendFileSync(path, text, "utf8");
}
```

- [ ] **Step 5: 实现 `src/cli.ts`**

```ts
#!/usr/bin/env node
// geml-agent — offline verbs over statecharts and ledgers. Phase C adds `run`.
import { resolve } from "node:path";
import { readText, writeNew } from "./host-fs.js";
import { loadStatechart, hasErrors, type AgentDiagnostic } from "./core/statechart.js";
import { readLedger, verifyLedger } from "./core/ledger.js";
import { canonical } from "./core/snapshot.js";
import type { JsonValue } from "./core/schema.js";

const USAGE = [
  "usage: geml-agent <check|snapshot|verify|export|init> ...",
  "  check <flow.geml> [--tools a,b]        static checks (exit 1 on errors)",
  "  snapshot <ledger.geml> [--json]        the last revision",
  "  verify <ledger.geml> [--statechart f]  hash chain and consistency",
  "  export <ledger.geml> --to md           revision table with per-step diffs",
  "  init [dir]                             write the example agent.geml",
].join("\n");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args: string[], name: string) => args.includes(name);

function printDiagnostics(ds: readonly AgentDiagnostic[]): void {
  for (const d of ds) console.error(`${d.severity}: ${d.code}: ${d.message} (line ${d.line})`);
  const errs = ds.filter((d) => d.severity === "error").length, warns = ds.length - errs;
  console.error(errs || warns ? `${errs} error(s), ${warns} warning(s)` : "ok: no diagnostics");
}

function fail(msg: string, code: 1 | 2): never {
  console.error(msg);
  process.exit(code);
}

function main(argv: string[]): number {
  const [verb, ...rest] = argv;
  if (!verb) fail(USAGE, 2);
  switch (verb) {
    case "check": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      const tools = flag(rest, "--tools");
      const r = loadStatechart(readText(resolve(file)), file, tools ? { knownTools: tools.split(",").map((s) => s.trim()).filter(Boolean) } : {});
      printDiagnostics(r.diagnostics);
      return hasErrors(r.diagnostics) ? 1 : 0;
    }
    case "snapshot": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      const ledger = readLedger(readText(resolve(file)));
      const last = ledger.snapshots[ledger.snapshots.length - 1];
      if (!last) fail(`${file}: no agent-snapshot block`, 1);
      if (has(rest, "--json")) { console.log(JSON.stringify(last)); return 0; }
      const from = last.from !== undefined ? ` · from #${last.from}` : "";
      const restores = last.restores !== undefined ? ` · restores ${last.restores}` : "";
      console.log(`rev ${last.rev} · state #${last.state} · cause ${last.cause}${from}${restores}\nvars: ${canonical(last.vars)}\nhash: ${last.hash}\nat: ${last.at}`);
      return 0;
    }
    case "verify": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      const scPath = flag(rest, "--statechart");
      let sc;
      if (scPath) {
        const r = loadStatechart(readText(resolve(scPath)), scPath);
        if (!r.statechart) { printDiagnostics(r.diagnostics); return 1; }
        sc = r.statechart;
      }
      const errors = verifyLedger(readLedger(readText(resolve(file))), sc);
      for (const e of errors) console.error(e);
      console.error(errors.length ? `${errors.length} error(s)` : "ok: chain verified");
      return errors.length ? 1 : 0;
    }
    case "export": {
      const file = rest[0]; if (!file || file.startsWith("--")) fail(USAGE, 2);
      if (flag(rest, "--to") !== "md") fail("export: only --to md is supported", 2);
      const ledger = readLedger(readText(resolve(file)));
      const lines = [`# geml-agent ledger — ${ledger.meta.session}`, "", `statechart: \`${ledger.meta.statechart}\` (${ledger.meta.statechartHash})`, "", "| rev | at | cause | state | call | changes |", "|---|---|---|---|---|---|"];
      let prev: Record<string, JsonValue> = {};
      for (const s of ledger.snapshots) {
        const changes: string[] = [];
        for (const k of [...new Set([...Object.keys(prev), ...Object.keys(s.vars)])].sort()) {
          const a = prev[k], b = s.vars[k];
          if (canonical(a ?? null) !== canonical(b ?? null) || (a === undefined) !== (b === undefined)) {
            changes.push(`${k}: ${a === undefined ? "∅" : canonical(a)} → ${b === undefined ? "∅" : canonical(b)}`);
          }
        }
        lines.push(`| ${s.rev} | ${s.at} | ${s.cause} | #${s.state} | ${s.call ?? ""} | ${changes.length ? changes.join("; ") : "—"} |`);
        prev = s.vars;
      }
      if (ledger.refusals.length) {
        lines.push("", "## Refused", "");
        for (const r of ledger.refusals) lines.push(`- rev ${r.rev} · ${r.tool}${r.call ? ` (${r.call})` : ""}: ${r.reason}${r.diagnostics.length ? " — " + r.diagnostics.join("; ") : ""}`);
      }
      console.log(lines.join("\n"));
      return 0;
    }
    case "init": {
      const dir = resolve(rest[0] ?? ".");
      const target = resolve(dir, "agent.geml");
      const example = readText(new URL("../examples/refund/agent.geml", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).replace(/\r\n/g, "\n");
      try { writeNew(target, example); }
      catch (e) { fail((e as NodeJS.ErrnoException).code === "EEXIST" ? `${target} already exists; not overwriting` : String(e), 1); }
      console.log(`wrote ${target}`);
      return 0;
    }
    default:
      fail(USAGE, 2);
  }
}

process.exit(main(process.argv.slice(2)));
```

> `init` 读示例文件的那一行用 `fileURLToPath` 更稳：`import { fileURLToPath } from "node:url"` 后写 `readText(fileURLToPath(new URL("../examples/refund/agent.geml", import.meta.url)))`——以此为准，上面 `.pathname.replace(...)` 那种写法在 Windows 上不可靠，不要用。

- [ ] **Step 6: 跑测试**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npm test
```
Expected: 全部 PASS。常见修正：`spawnSync` 在 Windows 下 `process.execPath` 直跑 `dist/cli.js` 没问题（不是 .cmd）；`export` 的 diff 行文字以测试为合同。

- [ ] **Step 7: 提交**

```bash
cd /c/agentProjects/geml-spec
git add integrations/geml-agent-runtime/src integrations/geml-agent-runtime/test integrations/geml-agent-runtime/examples
git commit -m "feat(agent-runtime): geml-agent CLI — check, snapshot, verify, export, init"
```

---

### Task 9: A 期收口 — 示例过 `geml check`，跑一次全量，接入 integrations 跑器

**Files:**
- Verify only（无新文件；若发现问题在对应模块修）

- [ ] **Step 1: 示例状态图过核心 `geml check`（用工作树的 parser）**

```bash
cd /c/agentProjects/geml-spec && node geml-parser/dist/geml.js check integrations/geml-agent-runtime/examples/refund/agent.geml
```
Expected: `ok: no diagnostics`，退出 0。若报 `unknown-block-type`，说明 Task 2 的 profile 没进 `dist`——重新 `npm --prefix geml-parser run build`。

- [ ] **Step 2: integrations 跑器能发现并跑本包**

```bash
cd /c/agentProjects/geml-spec && node integrations/test-all.mjs
```
Expected: 输出里有 `── geml-agent-runtime` 段且通过；不应出现在 `no test script` 列表。其他集成若因未安装依赖被 `skip`，属正常。

- [ ] **Step 3: parser 全量套件跑一次（贵，只此一次）**

```bash
cd /c/agentProjects/geml-spec/geml-parser && node test/all.mjs
```
Expected: 全部通过。关注 `profiles`、`skill-install`（Task 1 改了路径）、`mcp`（守卫四份 vendor manifest，不含 dsh-plugin，应无关）。有失败先读第一条失败，不动阈值。

- [ ] **Step 4: 核心库分支覆盖 ≥ 95%（设计 §10 A 期判据）**

```bash
cd /c/agentProjects/geml-spec/integrations/geml-agent-runtime && npx --yes c8@12 --include="dist/core/**/*.js" --check-coverage --branches 95 --lines 95 --functions 95 --statements 95 node --test test/*.test.mjs
```
Expected: 通过。不够就补测试（通常是 `ledger.ts` 读取端的畸形属性分支和 `schema.ts` 的 `oneOf`/`items` 校验分支），不降阈值。

- [ ] **Step 5: 记 CHANGELOG 草稿并提交**

在仓库根 `CHANGELOG.md` 的 Unreleased 段（没有就在文件顶部新建 `## Unreleased`）追加：
```
- **agent-runtime**: `integrations/dsh-plugin` renamed to `integrations/geml-agent-runtime` (npm `@geml/dsh-plugin` → `@geml/agent-runtime`, not yet published). New `geml-agent/v1` profile (statechart + ledger vocabulary) registered in the parser; `geml-agent check|snapshot|verify|export|init` CLI. Design: `docs/design/specs/2026-09-14-geml-agent-runtime-design.md`.
```
```bash
cd /c/agentProjects/geml-spec
git add CHANGELOG.md
git commit -m "docs(changelog): agent-runtime phase A"
git log --oneline main..HEAD
```
Expected: 从设计文档到本提交共 10 条左右，全部作者 xiongjy2104。

---

## 自审记录

- **覆盖**：设计 §4（词汇、属性细则、静态检查全部码、JSON Schema 子集）→ Task 2/3/4；§5.1–5.2、5.5 → Task 5；§5.4 台账与 verify → Task 6；§6.4 快照文本 → Task 7；§7 除 `run` 外五个动词 → Task 8；§10 A 期判据 → Task 9。`run` 与 DSH 插件属 B/C 期，不在本计划。
- **新增一处设计变更**：`agent-dup-edge`（Task 4 Step 6 回写设计 §4.3），原因：`agent_transition` 以目标状态为参数，同 from/to 的重边无法区分。
- **类型一致性**：`Snapshot`/`Refusal`/`Outcome`/`Meta`（Task 5）被 Task 6/7/8 原名引用；`AgentDiagnostic.code` 为 `string`（既装 `AgentCode` 也装 geml 核心码）；`effectiveTools` 返回 `undefined | string[]`，`visibleTools` 据此产出 `unrestricted | allow`。
- **待实现时核对的事实**（写在对应 Step 里）：`unitSpans` 的 `Unit.kind`/`span.start` 语义；`fileURLToPath` 读示例；哈希钉值首跑后回填。
