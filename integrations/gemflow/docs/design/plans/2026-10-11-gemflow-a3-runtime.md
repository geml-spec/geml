# Gemflow A3 — Runtime: Signals, Supervisor, Stagehand, Work Items, CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the vocabulary of plan A2 *do* something: signals turn observed facts into variables, the supervisor advises by default and enforces only where a workflow says `strict` or `only-in`, auto edges advance on their own, Stagehand writes the current stage's context to `.geml/context.geml`, each work item gets one journal, and a person can mark manual signals and move the workflow from the terminal.

**Architecture:** Pure decisions stay in `src/core/` (new: `signals.ts`, `stagehand.ts`, `unit.ts`, `backlog.ts`; changed: `supervisor.ts`, `run.ts`, `journal.ts`, `layout.ts`). A new impure layer `src/workspace.ts` runs one operation at a time against a project on disk: take the journal's lock, read it fresh, act through the `Supervisor`, append, rewrite the context document when the stage changed, release. Because every operation starts from disk, the CLI, an MCP server and a host's hooks process can share a project without sharing memory. Git and `gh` facts come from `src/host-git.ts`. The DeepSeek Harness and pi agent adapters keep their per-session journals and pick up the new supervisor semantics.

**Tech Stack:** TypeScript (tsc), Node ≥ 22, `node:test`; `@geml/geml` for parsing; `git` and (optionally) `gh` on PATH for git signals.

**Spec:** `docs/design/specs/2026-10-11-gemflow-design.md` §3, §5.1–§5.6, §6, §8.5 (the workspace is what the MCP tools and the Claude Code shell call in plan B).

**Depends on:** plans A1 and A2 (capabilities, signals table, `strict`, `auto`, `context`, `by`/`signal`, `applySignal`, `run.signal`, `run.deviate`, `flow-deviation`, prefixed meta keys).

**Working directory:** `/Users/xiong/software/geml`, branch `feat/geml-agent-runtime`, in place. Never switch branches, never stash, never push. Stage by explicit path, never `git add -A` / `git add .`; never add anything under `playground/codemap/`.

**Conventions:** English commit messages, no attribution trailers, no version bumps. Run an expensive suite once and take output and exit code from that run. Runtime suite: `cd integrations/gemflow && npm test` (runs `tsc` first; prints `ℹ pass N` / `ℹ fail N`). One file: `cd integrations/gemflow && npx tsc && node --test test/<file>.test.mjs`. Parser suite: `cd geml-parser && npm run build && node test/all.mjs`. Rust: `cd geml-parser-rs && cargo test --quiet && cargo fmt --check && cargo clippy --all-targets --features wasm -- -D warnings`.

---

## Decisions this plan makes (recorded in the spec by Task 1)

1. The manual-signal and person-transition commands are `gemflow mark <signal>`, `gemflow unmark <signal>` and `gemflow advance <state>` (`gemflow check` is already the static-check verb).
2. An auto edge taken right after a change records the actor of that change: `by=signal signal=<id>` after a signal write, `by=model` after the model's verb, `by=human` after a person's move. Auto edges that need `approval` are never taken automatically.
3. The context document is one `flow-context` block (raw body) with attributes `state`, `rev`, `at`, `item`; the document is regenerated, not versioned (no `.gemlhistory`).
4. Every `=== meta` key the runtime reads carries the `flow-` prefix: the journal head's keys become `flow-item`, `flow-statechart`, `flow-statechart-hash`, `flow-created`; the project config document `.geml/gemflow.geml` names the active workflow with `flow-workflow`.
5. Strict refusals and `only-in` refusals are recorded in the journal as `flow-refused` (the gates used to refuse silently).
6. Deviations are recorded once per tool per stage entry.
7. The DeepSeek Harness and pi agent adapters keep their per-session journals (`flow-item = "session:<id>"`); work-item journals arrive there with their board (spec §10).

---

## File map

| Path | Responsibility | Task |
|---|---|---|
| `geml-parser/src/profiles.ts`, `geml-parser-rs/src/vocab.rs`, `geml-parser/test/profiles.test.mjs`, `spec/profiles/geml-flow/conformance.json`, `spec/profiles/README.md` | `flow-context` block, new meta keys | 1 |
| `docs/design/specs/2026-10-11-gemflow-design.md` | the decisions above | 1 |
| `integrations/gemflow/src/core/journal.ts` | journal head keys `flow-*` | 2 |
| `integrations/gemflow/src/core/signals.ts` (new) | evaluate signals; `only-in` and person-only refusals | 3 |
| `integrations/gemflow/src/core/run.ts`, `snapshot.ts` | deviation log; refusal tool is any tool | 4 |
| `integrations/gemflow/src/core/supervisor.ts` | advisory/strict, deviations, refusals, `by=model` | 4 |
| `integrations/gemflow/src/core/supervisor.ts` | `applySignals`, `observeCommand`, `humanTransition`, `mark`, auto-advance | 5 |
| `integrations/gemflow/src/core/stagehand.ts` (new) | stage context text; context document render/read | 6 |
| `integrations/gemflow/src/core/unit.ts` (new), `src/core/layout.ts` | glob, work item, paths | 7 |
| `integrations/gemflow/src/core/backlog.ts` (new) | backlog table read/render/bind | 8 |
| `integrations/gemflow/src/host-fs.ts`, `src/host-git.ts` (new) | lock, atomic write, glob search; git/gh facts | 9 |
| `integrations/gemflow/src/workspace.ts` (new) | one operation at a time against a project | 10 |
| `integrations/gemflow/src/cli.ts`, `workflows/` (new dir) | `init`, `use`, `status`, `mark`, `unmark`, `advance`; `check` resolves context | 11 |
| `integrations/gemflow/src/hosts/dsh/plugin.ts`, `src/hosts/pi/extension.ts`, fixtures | new semantics, workflow resolution | 12 |
| `spec/profiles/geml-flow/geml-flow-profile*.md`, `integrations/gemflow/README*.md` | runtime behaviour documented | 13 |

---

### Task 1: Vocabulary and spec record the decisions

**Files:** `geml-parser/src/profiles.ts`, `geml-parser/test/profiles.test.mjs`, `geml-parser-rs/src/vocab.rs`, `spec/profiles/geml-flow/conformance.json`, `spec/profiles/README.md`, `docs/design/specs/2026-10-11-gemflow-design.md`

- [ ] **Step 1: Failing test**

Append to `geml-parser/test/profiles.test.mjs` before the final `console.log`:

```js
test("geml-flow/v1：flow-context 与 journal / 配置文档的 meta 键", () => {
  const v = vocabularyFor(meta({ profile: "geml-flow/v1" }));
  assert.equal(v.types.has("flow-context"), true);
  for (const k of ["state", "rev", "at", "item"]) assert.equal(v.attrs.get("flow-context")?.has(k), true, k);
  assert.deepEqual(PROFILES["geml-flow/v1"].metaKeys, [
    "flow-tools", "flow-signals", "flow-unit", "flow-context-budget",
    "flow-workflow", "flow-item", "flow-statechart", "flow-statechart-hash", "flow-created",
  ]);
  const src = '=== meta\nprofile = "geml-flow/v1"\nflow-item = "feat/x"\nflow-statechart = ".geml/workflows/dev/flow.geml"\nflow-statechart-hash = "sha256:00"\nflow-created = "t0"\nflow-workflow = "dev"\n===\n\n'
    + '==== flow-context {#current state=#review rev=7 at="t1" item="feat/x"}\n[gemflow] stage #review\n=== not a fence here\n====\n';
  assert.deepEqual(parse(src).diagnostics, [], "declared: every key and the widened raw body are clean");
  const ctx = parse(src).children.find((b) => b.kind === "block" && b.type === "flow-context");
  assert.equal(ctx.mode, "raw");
  assert.deepEqual(ctx.raw, ["[gemflow] stage #review", "=== not a fence here"]);
});
```

(If `PROFILES` is not imported in the file yet, add it to the existing import from `../dist/profiles.js`.)

- [ ] **Step 2: Watch it fail**

Run: `cd geml-parser && npm run build >/dev/null && node test/profiles.test.mjs 2>&1 | tail -4; cd ..`
Expected: failure at `v.types.has("flow-context")`.

- [ ] **Step 3: Extend the TypeScript entry**

In `geml-parser/src/profiles.ts`, `"geml-flow/v1"`: add `"flow-context"` at the end of `types`; add `"flow-context": ["state", "rev", "at", "item"],` at the end of `attrs`; replace `metaKeys` with:

```ts
    metaKeys: [
      "flow-tools", "flow-signals", "flow-unit", "flow-context-budget",
      "flow-workflow", "flow-item", "flow-statechart", "flow-statechart-hash", "flow-created",
    ],
```

and in the entry's comment change "The other four carry JSON the runtime parses itself, so they stay raw." to "The other five are raw: four carry JSON the runtime parses itself, and `flow-context` carries the stage text Stagehand writes."

- [ ] **Step 4: Mirror it in Rust**

In `geml-parser-rs/src/vocab.rs`, `geml-flow/v1`: add `("flow-context", Raw)` to `types`, `("flow-context", &["state", "rev", "at", "item"])` to `attrs`, the same nine keys to `meta_keys`, and the same comment change.

- [ ] **Step 5: Update the index row**

In `spec/profiles/README.md`, the `geml-flow/v1` row also names `flow-context` and its keys (the `profiles` suite checks the row against the registry; read its failure message if you miss one).

- [ ] **Step 6: Conformance case**

Append to `spec/profiles/geml-flow/conformance.json` `cases` (same schema as its other cases):

```json
    {
      "name": "the context document: a flow-context block under a widened fence keeps a raw body, even a line that looks like a fence",
      "geml": "=== meta\nprofile = \"geml-flow/v1\"\nflow-item = \"feat/x\"\n===\n\n==== flow-context {#current state=#review rev=7 at=\"t1\" item=\"feat/x\"}\n[gemflow] stage #review\n=== not a fence here\n====\n",
      "diagnostics": { "declared": [], "undeclared": ["unknown-block-type:warning"] },
      "addresses": { "declared": ["#meta", "#current"], "undeclared": ["#meta", "#current"] }
    }
```

If `profile-conformance` disagrees on `undeclared` (an undeclared reading may also report the prefixed meta key), compute the values with that test's helpers, check them by hand, and use them.

- [ ] **Step 7: Record the decisions in the spec**

In `docs/design/specs/2026-10-11-gemflow-design.md`:
- §3 data layout: add the line `  gemflow.geml                 项目配置：meta flow-workflow 指定当前流程；提交进仓库` after `backlog.geml`; and `context.geml` is described as "当前阶段的上下文（一个 flow-context 块 #current），Stagehand 重新生成；默认 gitignore".
- §4.3 table: add rows `| journal 头 | \`flow-item\` \`flow-statechart\` \`flow-statechart-hash\` \`flow-created\` | 工作项、流程文件、流程哈希、创建时间 |`, `| 配置文档 | \`flow-workflow\` | 当前流程的目录名 |`, `| 上下文文档 | \`flow-context\` 块 | 属性 \`state\` \`rev\` \`at\` \`item\`；正文是 Stagehand 拼好的阶段说明 |`.
- §5.1: under the table add: "auto 边在一次改动之后被带走时，记录的是那次改动的来源：信号写入后是 `by=signal signal=<id>`，模型动作后是 `by=model`，人推进后是 `by=human`。需要 `approval` 的 auto 边永远不会自动走。"
- §5.2: every `gemflow check <id>` becomes `gemflow mark <id>` (and `gemflow unmark <id>` clears it); add: "人在终端推进用 `gemflow advance <state>`；模型通过 `run` 调用 `gemflow mark|unmark|advance` 一律被拒绝。"
- §5.3: add: "strict 拒绝与 `only-in` 拒绝都记入 journal（`flow-refused`）；偏离每个工具每次进入阶段只记一次。"
- §5.4: replace "（整块替换，`.gemlhistory` 照常记版本）" with "（一个 `flow-context` 块 `#current`，整份重新生成，不记版本）".
- §10 table, row "DeepSeek Harness 界面": append "；这两个宿主在有看板之前仍按会话记 journal（`flow-item = \"session:<id>\"`）".

- [ ] **Step 8: Run the three suites once**

Run:
```bash
cd geml-parser && npm run build >/dev/null && node test/all.mjs > /tmp/gemflow-a3.log 2>&1; echo "parser exit=$?"; tail -1 /tmp/gemflow-a3.log; cd ..
cd geml-parser-rs && cargo test --quiet 2>&1 | tail -3; cargo fmt --check; echo "fmt=$?"; cargo clippy --quiet --all-targets --features wasm -- -D warnings; echo "clippy=$?"; cd ..
```
Expected: `parser exit=0`; cargo tests pass; `fmt=0`; `clippy=0`.

- [ ] **Step 9: Commit**

```bash
git add geml-parser/src/profiles.ts geml-parser/test/profiles.test.mjs geml-parser-rs/src/vocab.rs spec/profiles/geml-flow/conformance.json spec/profiles/README.md docs/design/specs/2026-10-11-gemflow-design.md
git commit -m "feat(profiles): geml-flow/v1 gains the flow-context block and the flow- keys of journals and the project config

The spec records plan A3's decisions: gemflow mark/unmark/advance, who an
auto edge is recorded as taken by, the context document's shape, and that
strict and only-in refusals reach the journal."
```

---

### Task 2: The journal head's keys take the prefix

**Files:** `integrations/gemflow/src/core/journal.ts`, `integrations/gemflow/src/core/supervisor.ts` (`OpenOptions`), `integrations/gemflow/src/core/run.ts`, `integrations/gemflow/src/hosts/dsh/plugin.ts`, `integrations/gemflow/src/hosts/pi/extension.ts`, `integrations/gemflow/src/cli.ts`, tests that build heads.

- [ ] **Step 1: Failing test**

Append to `integrations/gemflow/test/journal.test.mjs`:

```js
test("the journal head names its work item with flow- keys", () => {
  const head = renderJournalHead({ item: "feat/x", statechart: ".geml/workflows/dev/flow.geml", statechartHash: "sha256:ab", created: "t0" });
  assert.match(head, /^=== meta\ntitle += "gemflow journal"\nprofile += "geml-flow\/v1"\nflow-item += "feat\/x"\nflow-statechart += "\.geml\/workflows\/dev\/flow\.geml"\nflow-statechart-hash += "sha256:ab"\nflow-created += "t0"\n===\n/);
  const j = readJournal(head);
  assert.deepEqual(j.meta, { item: "feat/x", statechart: ".geml/workflows/dev/flow.geml", statechartHash: "sha256:ab", created: "t0" });
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/journal.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 1` (or a tsc error that `item` is not in `JournalMeta`).

- [ ] **Step 3: Rename the field and the keys**

In `src/core/journal.ts`:
- `export interface JournalMeta { item: string; statechart: string; statechartHash: string; created: string }`
- `renderJournalHead` writes:
  ```ts
    "=== meta",
    'title                = "gemflow journal"',
    'profile              = "geml-flow/v1"',
    `flow-item            = ${JSON.stringify(meta.item)}`,
    `flow-statechart      = ${JSON.stringify(meta.statechart)}`,
    `flow-statechart-hash = ${JSON.stringify(meta.statechartHash)}`,
    `flow-created         = ${JSON.stringify(meta.created)}`,
    "===",
  ```
  (keep the two trailing `""` entries the function already joins).
- `readJournal`: `const meta: JournalMeta = { item: "", statechart: "", statechartHash: "", created: "" };` and read `flow-item`, `flow-statechart`, `flow-statechart-hash`, `flow-created` into the four fields.

Then follow the compiler: `OpenOptions.session` in `src/core/supervisor.ts` becomes `item: string` (doc: "The work item this run belongs to; goes in the journal head."), and `openRun` builds `JournalMeta` with `item: o.item`. The dsh adapter passes `item: \`session:${String(agent.id)}\``; the pi adapter passes `item: \`session:${session}\``. `src/cli.ts` `export` prints `# gemflow journal — ${journal.meta.item}`. Every test that builds a `JournalMeta` or passes `session:` to `openRun` changes `session` to `item` (search: `git grep -n "session:" integrations/gemflow/test | grep -v sessionManager`).

- [ ] **Step 4: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a3.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a3.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`. A test that greps a journal for `session = ` changes to `flow-item = "session:…"`.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src integrations/gemflow/test
git commit -m "refactor(gemflow): the journal head names its work item with flow- keys

flow-item, flow-statechart, flow-statechart-hash, flow-created, as the
profile naming rule requires. The dsh and pi adapters still write one
journal per session, as flow-item = \"session:<id>\"."
```

---

### Task 3: Signal evaluation

**Files:** Create `integrations/gemflow/src/core/signals.ts`, `integrations/gemflow/test/signals.test.mjs`; modify `src/index.ts`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/signals.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStatechart } from "../dist/core/statechart.js";
import { commandSignals, fileSignals, gitSignals, onlyInRefusal, personOnlyRefusal } from "../dist/core/signals.js";

const SC = loadStatechart(
  '=== meta\nprofile = "geml-flow/v1"\nflow-signals = "#signals"\n===\n\n'
  + '=== flow-vars {#vars}\n{"type":"object","properties":{"t":{"type":"boolean","default":false},"m":{"type":"boolean","default":false},"r":{"type":"boolean","default":false},"p":{"type":"boolean","default":false},"g":{"type":"boolean","default":false},"c":{"type":"boolean","default":false},"d":{"type":"boolean","default":false},"k":{"type":"boolean","default":false}}}\n===\n\n'
  + '=== table {#signals}\n| id | on | match | sets | when | only-in |\n|---|---|---|---|---|---|\n'
  + '| tests | command | npm (run )?test | t | exit-zero | |\n'
  + '| render | file | out/*.mp4 | r | exists | |\n'
  + '| pr | git | | p | pr-open | |\n'
  + '| merged | git | | g | pr-merged | |\n'
  + '| ci | git | ^build$ | c | ci-success | |\n'
  + '| deploy | command | wrangler deploy | d | exit-zero | #release |\n'
  + '| ok | manual | 审片通过 | m | checked | |\n'
  + '| any-ci | git | | k | ci-success | |\n'
  + '===\n\n=== flow-state {#build initial}\nx\n===\n\n=== flow-state {#release final}\nx\n===\n\n=== flow-transition {#go from=#build to=#release}\nx\n===\n',
  "f.geml").statechart;

test("command signals read the exit status; a backgrounded call reads nothing", () => {
  assert.deepEqual(commandSignals(SC, { command: "npm test", exitCode: 0 }), [{ id: "tests", value: true }]);
  assert.deepEqual(commandSignals(SC, { command: "cd x && npm run test -- --grep y", exitCode: 1 }), [{ id: "tests", value: false }]);
  assert.deepEqual(commandSignals(SC, { command: "npm test", exitCode: null }), []);
  assert.deepEqual(commandSignals(SC, { command: "ls", exitCode: 0 }), []);
});

test("file signals ask the host whether the glob matches", () => {
  assert.deepEqual(fileSignals(SC, (g) => g === "out/*.mp4"), [{ id: "render", value: true }]);
  assert.deepEqual(fileSignals(SC, () => false), [{ id: "render", value: false }]);
});

test("git signals read the facts; ci-success filters by workflow name; unknown facts read nothing", () => {
  assert.deepEqual(gitSignals(SC, { prOpen: true, prMerged: false }), [{ id: "pr", value: true }, { id: "merged", value: false }]);
  const ci = [{ workflow: "build", success: true }, { workflow: "lint", success: false }];
  assert.deepEqual(gitSignals(SC, { ci }), [{ id: "ci", value: true }, { id: "any-ci", value: false }]);
  assert.deepEqual(gitSignals(SC, { ci: [] }), [{ id: "ci", value: false }, { id: "any-ci", value: false }]);
  assert.deepEqual(gitSignals(SC, {}), []);
});

test("only-in refuses a matching command outside its states", () => {
  assert.match(onlyInRefusal(SC, "build", "npx wrangler deploy --env production"), /may only run in #release \(signal deploy\)/);
  assert.equal(onlyInRefusal(SC, "release", "wrangler deploy"), undefined);
  assert.equal(onlyInRefusal(SC, "build", "npm test"), undefined);
});

test("person-only commands are refused to the model", () => {
  for (const c of ["gemflow mark ok", "npx -y @geml/gemflow advance release", "cd x; gemflow unmark ok"]) assert.match(personOnlyRefusal(c), /for a person/, c);
  for (const c of ["gemflow status", "echo gemflow mark", "mygemflow mark x"]) assert.equal(personOnlyRefusal(c), c === "echo gemflow mark" ? personOnlyRefusal(c) : undefined, c);
});
```

(The last loop documents that `echo gemflow mark` is refused too — a shell cannot tell an echo from a call cheaply, and refusing a harmless echo is the safe side.)

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/signals.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/core/signals.js`.

- [ ] **Step 3: Write the module**

Create `integrations/gemflow/src/core/signals.ts`:

```ts
// Signals observe facts and turn them into the workflow's boolean variables
// (spec §5.2). Pure: the host gathers the facts — an exit status, whether a
// glob matches, what git and gh say — and these functions decide what each
// signal now reads. Writing the values is the supervisor's job.
import type { Statechart } from "./statechart.js";

export interface SignalValue { id: string; value: boolean }
/** One finished run-capability call. `exitCode` null: no exit status yet (the call went to the background). */
export interface CommandOutcome { command: string; exitCode: number | null }
/** What git and gh say about the current branch. An absent field is a fact nobody could establish. */
export interface GitFacts {
  committed?: boolean;
  prOpen?: boolean;
  prMerged?: boolean;
  /** CI runs on the branch head; `success` is false for a run still going or one that failed. */
  ci?: readonly { workflow: string; success: boolean }[];
}

const PERSON_ONLY = /(?:^|[\s;&|(`])(?:npx\s+(?:-y\s+)?@geml\/gemflow|gemflow)\s+(mark|unmark|advance)\b/;

export function commandSignals(sc: Statechart, o: CommandOutcome): SignalValue[] {
  if (o.exitCode === null) return [];
  return sc.signals
    .filter((s) => s.on === "command" && new RegExp(s.match).test(o.command))
    .map((s) => ({ id: s.id, value: o.exitCode === 0 }));
}

export function fileSignals(sc: Statechart, exists: (glob: string) => boolean): SignalValue[] {
  return sc.signals.filter((s) => s.on === "file").map((s) => ({ id: s.id, value: exists(s.match) }));
}

export function gitSignals(sc: Statechart, f: GitFacts): SignalValue[] {
  const out: SignalValue[] = [];
  for (const s of sc.signals) {
    if (s.on !== "git") continue;
    let value: boolean | undefined;
    if (s.when === "committed") value = f.committed;
    else if (s.when === "pr-open") value = f.prOpen;
    else if (s.when === "pr-merged") value = f.prMerged;
    else if (s.when === "ci-success" && f.ci) {
      const runs = s.match ? f.ci.filter((r) => new RegExp(s.match).test(r.workflow)) : f.ci;
      value = runs.length > 0 && runs.every((r) => r.success);
    }
    if (value !== undefined) out.push({ id: s.id, value });
  }
  return out;
}

/** Why a command may not run in this state because a command signal's only-in excludes it, or undefined. */
export function onlyInRefusal(sc: Statechart, stateId: string, command: string): string | undefined {
  for (const s of sc.signals) {
    if (s.on !== "command" || s.onlyIn.length === 0 || !new RegExp(s.match).test(command)) continue;
    if (!s.onlyIn.includes(stateId)) {
      return `\`${command}\` may only run in ${s.onlyIn.map((x) => `#${x}`).join(", ")} (signal ${s.id}); the workflow is in #${stateId}`;
    }
  }
  return undefined;
}

/** Why the model may not run this command — a manual signal or a person's transition — or undefined. */
export function personOnlyRefusal(command: string): string | undefined {
  const m = command.match(PERSON_ONLY);
  return m ? `\`gemflow ${m[1]}\` is for a person, not the model: manual signals and a person's transitions are never taken by the agent` : undefined;
}
```

Add `export * from "./core/signals.js";` to `src/index.ts` after the capabilities export.

- [ ] **Step 4: Watch it pass**

Run: `cd integrations/gemflow && npx tsc && node --test test/signals.test.mjs test/purity.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src/core/signals.ts integrations/gemflow/src/index.ts integrations/gemflow/test/signals.test.mjs
git commit -m "feat(gemflow): signal evaluation — command, file, git and the two refusals"
```

---

### Task 4: The supervisor advises by default and enforces where told

**Files:** `integrations/gemflow/src/core/snapshot.ts`, `src/core/run.ts`, `src/core/supervisor.ts`, `test/supervisor.test.mjs`, `test/run.test.mjs`, and whatever adapter tests the new journal records touch (`test/plugin.test.mjs`, `test/pi.test.mjs`).

Behaviour after this task: in a non-strict state, a call outside the state's tools runs and is recorded once per tool per stage entry as `flow-deviation`; in a strict state it is refused (gate 3) and recorded as `flow-refused`; gate 1 hides tools only in strict states; a run-capability call whose command a command signal's `only-in` excludes is refused and recorded, strict or not; `gemflow mark|unmark|advance` from the model is refused and recorded; the model's verbs record `by=model`.

- [ ] **Step 1: Failing tests**

Append to `integrations/gemflow/test/supervisor.test.mjs` (it already has `host()`, `PI_CAPABILITIES`, `AT` and the refund fixture; add `loadStatechart` and `readJournal` to imports if missing):

```js
const ADVISE = loadStatechart(
  '=== meta\nprofile = "geml-flow/v1"\nflow-tools = "read search"\nflow-signals = "#signals"\n===\n\n'
  + '=== flow-vars {#vars}\n{"type":"object","properties":{"d":{"type":"boolean","default":false},"note":{"type":"string"}}}\n===\n\n'
  + '=== table {#signals}\n| id | on | match | sets | when | only-in |\n|---|---|---|---|---|---|\n| deploy | command | wrangler deploy | d | exit-zero | #ship |\n===\n\n'
  + '=== flow-state {#work initial}\nWork.\n===\n\n=== flow-state {#lock strict tools="read"}\nLocked.\n===\n\n=== flow-state {#ship final}\nShip.\n===\n\n'
  + '=== flow-transition {#to-lock from=#work to=#lock}\nx\n===\n\n=== flow-transition {#to-ship from=#lock to=#ship}\nx\n===\n',
  "advise.geml").statechart;

function supOn(sc, h) {
  const opened = openRun({ sc, item: "t", statechartFile: "advise.geml", journalText: null, source: "startup", now: AT });
  h.blocks.push(opened.head, ...opened.blocks);
  return new Supervisor(sc, opened.run, h.port);
}

test("non-strict: a call outside the tools runs, recorded once per tool per stage entry", () => {
  const h = host();
  const sup = supOn(ADVISE, h);
  assert.deepEqual(sup.allowedGlobals(["read", "grep", "edit"]), { kind: "unrestricted" }, "gate 1 only hides in strict states");
  assert.equal(sup.deny("edit", "c1"), undefined);
  assert.equal(sup.deny("edit", "c2"), undefined);
  assert.equal(sup.deny("bash", "c3", { command: "ls" }), undefined);
  const j = readJournal(h.journal());
  assert.deepEqual(j.deviations.map((d) => [d.tool, d.capability, d.state]), [["edit", "write", "work"], ["bash", "run", "work"]]);
  assert.equal(h.deviations().length, 2, "the host hears about each recorded deviation");
});

test("strict: gate 1 hides, gate 3 refuses and the refusal is recorded", async () => {
  const h = host();
  const sup = supOn(ADVISE, h);
  await sup.invoke("flow_transition", { to: "lock" }, metaFor(AT, "v1"));
  assert.deepEqual(sup.allowedGlobals(["read", "grep", "edit"]), { kind: "allow", names: ["read"] });
  assert.match(sup.deny("edit", "c4"), /not available in state #lock/);
  const j = readJournal(h.journal());
  assert.equal(j.refusals.at(-1).tool, "edit");
  assert.equal(j.deviations.length, 0);
});

test("only-in and person-only refusals hold in any state, and are recorded", () => {
  const h = host();
  const sup = supOn(ADVISE, h);
  assert.match(sup.deny("bash", "c5", { command: "npx wrangler deploy" }), /may only run in #ship/);
  assert.match(sup.deny("bash", "c6", { command: "gemflow mark ok" }), /for a person/);
  assert.deepEqual(readJournal(h.journal()).refusals.map((r) => r.tool), ["bash", "bash"]);
});

test("the model's verbs are recorded by=model", async () => {
  const h = host();
  const sup = supOn(ADVISE, h);
  await sup.invoke("flow_set", { note: "n" }, metaFor(AT, "v2"));
  await sup.invoke("flow_transition", { to: "lock" }, metaFor(AT, "v3"));
  assert.deepEqual(readJournal(h.journal()).snapshots.slice(1).map((s) => s.by), ["model", "model"]);
});
```

and extend the file's `host()` helper so the recording host exposes `journal: () => blocks.join("")` (rename the existing `ledger` accessor if A1 left it as `journal`), keeps a `deviations` list, and its `port` gains `deviated: (tool, capability) => deviations.push({ tool, capability })` and `now: () => AT`. (If the refund fixture's states lost their gating because they are not `strict`, see Step 4.)

- [ ] **Step 2: Watch them fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/supervisor.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: non-zero `ℹ fail`.

- [ ] **Step 3: Implement**

`src/core/snapshot.ts`: `export interface Refusal { tool: string; reason: string; diagnostics: string[] }` (any tool: the verbs, `flow_signal`, or a host tool a gate refused).

`src/core/run.ts`:
- `interface Run` gains `readonly deviationLog: readonly { n: number; tool: string; rev: number }[];` and `deviations` becomes the highest `n` (keep the getter).
- `class RunState`: replace the `devs` counter with `private readonly devLog: { n: number; tool: string; rev: number }[]` set from a constructor parameter `deviationLog: { n: number; tool: string; rev: number }[] = []`; `get deviations()` returns `this.devLog.reduce((m, d) => Math.max(m, d.n), 0)`; `get deviationLog()` returns `this.devLog`; `deviate()` computes `n = this.deviations + 1`, pushes `{ n, tool, rev: this.snapshot.rev }`, and renders as before.
- `startRun` passes `[]`; `resumeRun` passes `journal.deviations.map((d) => ({ n: d.n, tool: d.tool, rev: d.rev }))`.

`src/core/supervisor.ts`:
- imports: `capabilityOf` from `./capabilities.js`; `onlyInRefusal`, `personOnlyRefusal` from `./signals.js`; `checkpointRev` from `./snapshot.js`.
- `SupervisorHost` gains `/** A call outside a non-strict state's tools was recorded (once per tool per stage entry). */ deviated?(tool: string, capability: string | null): void;`
- `allowedGlobals`: first line `const state = this.state(); if (state && !state.strict) return { kind: "unrestricted" };`
- replace `deny` with:

```ts
  /**
   * Gate 3 and the two refusals that hold in every state. Deny-only by
   * construction: no return value grants anything. In a non-strict state a
   * call outside the tools is allowed and recorded as a deviation.
   */
  deny(toolName: string, callId?: unknown, input?: Record<string, unknown>): string | undefined {
    if (this.owns(toolName)) return undefined;
    const command = this.commandOf(toolName, input);
    if (command !== undefined) {
      const hard = personOnlyRefusal(command) ?? onlyInRefusal(this.sc, this.run.snapshot.state, command);
      if (hard) return this.refuseCall(toolName, hard, callId);
    }
    const wanted = this.wanted();
    if (wanted === undefined || wanted.includes(toolName)) return undefined;
    if (this.state()?.strict) return this.refuseCall(toolName, `tool ${toolName} is not available in state #${this.run.snapshot.state}`, callId);
    this.recordDeviation(toolName, callId);
    return undefined;
  }

  /** The command a run-capability call would execute, when the host passed its input. */
  private commandOf(toolName: string, input?: Record<string, unknown>): string | undefined {
    if (capabilityOf(toolName, this.host.capabilities) !== "run") return undefined;
    const c = input?.["command"];
    return typeof c === "string" ? c : undefined;
  }

  private refuseCall(toolName: string, reason: string, callId?: unknown): string {
    if (callId !== undefined) this.denied.add(String(callId));
    this.host.append(this.run.refuse({ tool: toolName, reason, diagnostics: [] }, metaFor(this.host.now(), callId)));
    return reason;
  }

  private recordDeviation(toolName: string, callId?: unknown): void {
    const entered = checkpointRev(this.run.history);
    if (this.run.deviationLog.some((d) => d.tool === toolName && d.rev >= entered)) return;
    const capability = capabilityOf(toolName, this.host.capabilities) ?? null;
    this.host.append(this.run.deviate(toolName, capability, metaFor(this.host.now(), callId)));
    this.host.deviated?.(toolName, capability);
  }
```

- in `invoke`, pass `{ ...meta, by: "model" }` to each of the three `do*` calls.

- [ ] **Step 4: Keep the adapters' tests meaningful**

The refund workflow is a payment flow: its gating is the point, so mark its states strict. In `test/fixtures/refund.geml` and `examples/refund/agent.geml`, add `strict` to every `flow-state` header except the final one. Then run the full suite; where an adapter test now sees an extra `flow-refused` block after a denied call (Step 3 records gate refusals), update the expectation — the denial itself must not change. Tests that assert the denial left no block at all change to assert exactly one `flow-refused` block naming the tool.

- [ ] **Step 5: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a3.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a3.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/src/core integrations/gemflow/test integrations/gemflow/examples
git commit -m "feat(gemflow): the supervisor advises by default and enforces where the workflow says

Non-strict states let a call outside their tools run and record it once per
tool per stage entry (flow-deviation); strict states hide and refuse; a
command a signal's only-in excludes, and gemflow mark/unmark/advance from
the model, are refused in every state. Refusals reach the journal. The
model's verbs record by=model. The refund workflow is strict throughout."
```

---

### Task 5: Signals advance the workflow

**Files:** `integrations/gemflow/src/core/supervisor.ts`, `test/supervisor.test.mjs`

- [ ] **Step 1: Failing tests**

Append to `integrations/gemflow/test/supervisor.test.mjs`:

```js
const AUTO = loadStatechart(
  '=== meta\nprofile = "geml-flow/v1"\nflow-signals = "#signals"\n===\n\n'
  + '=== flow-vars {#vars}\n{"type":"object","properties":{"t":{"type":"boolean","default":false},"m":{"type":"boolean","default":false},"note":{"type":"string"}}}\n===\n\n'
  + '=== table {#signals}\n| id | on | match | sets | when |\n|---|---|---|---|---|\n| tests | command | npm test | t | exit-zero |\n| ok | manual | 通过 | m | checked |\n===\n\n'
  + '=== flow-state {#build initial}\nx\n===\n\n=== flow-state {#review}\nx\n===\n\n=== flow-state {#gate}\nx\n===\n\n=== flow-state {#done final}\nx\n===\n\n'
  + '=== data {#green format=json}\n{"type":"object","properties":{"t":{"const":true}}}\n===\n\n'
  + '=== data {#ok format=json}\n{"type":"object","properties":{"m":{"const":true}}}\n===\n\n'
  + '=== flow-transition {#to-review from=#build to=#review auto requires=#green}\nx\n===\n\n'
  + '=== flow-transition {#to-gate from=#review to=#gate auto requires=#green}\nx\n===\n\n'
  + '=== flow-transition {#back from=#gate to=#build}\nx\n===\n\n'
  + '=== flow-transition {#ship from=#gate to=#done auto approval requires=#ok}\nx\n===\n',
  "auto.geml").statechart;

test("a command's exit status writes its signal and auto edges chain while they hold", () => {
  const h = host();
  const sup = supOn(AUTO, h);
  const r = sup.observeCommand({ command: "npm test", exitCode: 0 }, metaFor(AT, "c1"));
  assert.deepEqual(r, { wrote: ["tests"], entered: ["review", "gate"] });
  assert.equal(sup.snapshot.state, "gate");
  const snaps = readJournal(h.journal()).snapshots;
  assert.deepEqual(snaps.slice(1).map((s) => [s.cause, s.by, s.signal, s.state]), [
    ["patch", "signal", "tests", "build"], ["transition", "signal", "tests", "review"], ["transition", "signal", "tests", "gate"],
  ]);
  assert.deepEqual(sup.observeCommand({ command: "npm test", exitCode: 0 }, metaFor(AT, "c2")), { wrote: [], entered: [] }, "no change, no revision");
});

test("an auto edge that needs approval is never taken on its own", () => {
  const h = host();
  const sup = supOn(AUTO, h);
  sup.observeCommand({ command: "npm test", exitCode: 0 }, metaFor(AT, "c1"));
  const r = sup.mark("ok", true, metaFor(AT));
  assert.deepEqual(r, { ok: true, wrote: ["ok"], entered: [] });
  assert.equal(sup.snapshot.state, "gate");
});

test("a person moves the workflow; approval is the act itself; auto edges then follow as that person", () => {
  const h = host();
  const sup = supOn(AUTO, h);
  sup.observeCommand({ command: "npm test", exitCode: 0 }, metaFor(AT, "c1"));
  sup.mark("ok", true, metaFor(AT));
  assert.deepEqual(sup.humanTransition("done", metaFor(AT)), { ok: true, entered: ["done"] });
  const back = supOn(AUTO, host());
  back.observeCommand({ command: "npm test", exitCode: 0 }, metaFor(AT, "c1"));
  const moved = back.humanTransition("build", metaFor(AT));
  assert.deepEqual(moved, { ok: true, entered: ["build", "review", "gate"] }, "tests still green, so the chain runs again");
  assert.equal(readJournal(h.journal()).snapshots.at(-1).by, "human");
});

test("mark refuses non-manual signals; humanTransition refuses a missing edge", () => {
  const sup = supOn(AUTO, host());
  assert.deepEqual(sup.mark("tests", true, metaFor(AT)), { ok: false, reason: "signal tests is a command signal; only manual signals are set by hand" });
  assert.match(sup.humanTransition("done", metaFor(AT)).reason, /no transition from #build to #done/);
});

test("the model's verb that makes a guard hold carries the auto edge as by=model", async () => {
  const SET = loadStatechart(
    '=== meta\nprofile = "geml-flow/v1"\n===\n\n=== flow-vars {#vars}\n{"type":"object","properties":{"ready":{"type":"boolean","default":false}}}\n===\n\n'
    + '=== flow-state {#a initial}\nx\n===\n\n=== flow-state {#b final}\nx\n===\n\n'
    + '=== data {#r format=json}\n{"type":"object","properties":{"ready":{"const":true}}}\n===\n\n'
    + '=== flow-transition {#ab from=#a to=#b auto requires=#r}\nx\n===\n', "set.geml").statechart;
  const h = host();
  const sup = supOn(SET, h);
  await sup.invoke("flow_set", { ready: true }, metaFor(AT, "v1"));
  assert.equal(sup.snapshot.state, "b");
  assert.deepEqual(readJournal(h.journal()).snapshots.slice(1).map((s) => [s.cause, s.by]), [["patch", "model"], ["transition", "model"]]);
});
```

- [ ] **Step 2: Watch them fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/supervisor.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: non-zero `ℹ fail`.

- [ ] **Step 3: Implement**

In `src/core/supervisor.ts`: import `validate` from `./schema.js` and `commandSignals, type CommandOutcome, type SignalValue` from `./signals.js`. Add to `class Supervisor`:

```ts
  /** Write each signal's value; then take auto edges while one holds. */
  applySignals(values: readonly SignalValue[], meta: Meta): { wrote: string[]; entered: string[] } {
    const wrote: string[] = [];
    for (const v of values) {
      const adv = this.run.signal(v.id, v.value, meta);
      if (adv === null) continue;
      this.host.append(adv.block);
      if (adv.ok) wrote.push(v.id);
    }
    const last = wrote[wrote.length - 1];
    const entered = last === undefined ? [] : this.autoAdvance({ ...meta, by: "signal", signal: last });
    if (wrote.length > 0) this.host.changed?.();
    return { wrote, entered };
  }

  /** A run-capability call finished: its exit status feeds the command signals. */
  observeCommand(outcome: CommandOutcome, meta: Meta): { wrote: string[]; entered: string[] } {
    return this.applySignals(commandSignals(this.sc, outcome), meta);
  }

  /** A person moved the workflow (board or terminal). Approval is the act itself. */
  humanTransition(to: string, meta: Meta): { ok: true; entered: string[] } | { ok: false; reason: string } {
    if (!outgoing(this.sc, this.run.snapshot.state).some((t) => t.to === to)) {
      return { ok: false, reason: `no transition from #${this.run.snapshot.state} to #${to}` };
    }
    const actor: Meta = { ...meta, by: "human" };
    const adv = this.run.transition(to, actor);
    this.host.append(adv.block);
    if (!adv.ok) return { ok: false, reason: refusalText(adv.refusal.reason, adv.refusal.diagnostics) };
    const entered = [to, ...this.autoAdvance(actor)];
    this.host.changed?.();
    return { ok: true, entered };
  }

  /** A person ticked or cleared a manual signal. */
  mark(id: string, checked: boolean, meta: Meta): { ok: true; wrote: string[]; entered: string[] } | { ok: false; reason: string } {
    const sig = this.sc.signals.find((s) => s.id === id);
    if (!sig) return { ok: false, reason: `no signal "${id}" in the statechart` };
    if (sig.on !== "manual") return { ok: false, reason: `signal ${id} is a ${sig.on} signal; only manual signals are set by hand` };
    return { ok: true, ...this.applySignals([{ id, value: checked }], meta) };
  }

  /**
   * Take the current state's auto edge while its guard holds, recording the
   * actor whose change made it hold. An auto edge that needs approval waits
   * for a person. Bounded by the number of states, so a cycle cannot spin.
   */
  private autoAdvance(actor: Meta): string[] {
    const entered: string[] = [];
    for (let i = 0; i < this.sc.states.size; i++) {
      const edge = outgoing(this.sc, this.run.snapshot.state).find((t) => t.auto && !t.approval);
      if (!edge?.requires || validate(edge.requires, this.run.snapshot.vars).length > 0) break;
      const adv = this.run.transition(edge.to, actor);
      this.host.append(adv.block);
      if (!adv.ok) break;
      entered.push(edge.to);
    }
    return entered;
  }
```

In `doTransition` and `doSet`, after the successful `this.host.append(advance.block)` and before building the result, call `this.autoAdvance(meta)` (the `meta` there already carries `by: "model"` from `invoke`). In `doTransition`, compute `concludesTurn` from the state the workflow ends in (`this.run.snapshot.state`), not only `to`.

- [ ] **Step 4: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a3.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a3.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src/core/supervisor.ts integrations/gemflow/test/supervisor.test.mjs
git commit -m "feat(gemflow): signals advance the workflow — observeCommand, mark, humanTransition, auto edges

A signal write, the model's verb or a person's move can make an auto edge's
guard hold; the edge is then taken, recorded as taken by that actor, and
chains while the next one holds. Auto edges that need approval wait."
```

---

### Task 6: Stagehand

**Files:** Create `integrations/gemflow/src/core/stagehand.ts`, `test/stagehand.test.mjs`; modify `src/index.ts`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/stagehand.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStatechart } from "../dist/core/statechart.js";
import { initialSnapshot } from "../dist/core/snapshot.js";
import { buildStageContext, renderContextDoc, readContextDoc } from "../dist/core/stagehand.js";

const src = (budget) => '=== meta\nprofile = "geml-flow/v1"\nflow-tools = "read search"\n' + (budget ? `flow-context-budget = "${budget}"\n` : "") + '===\n\n'
  + '=== flow-state {#review initial context="docs/a.md#one ./guide.geml#two docs/c.md#three"}\nHandle the review comments.\n===\n\n'
  + '=== flow-state {#done final}\nx\n===\n\n=== data {#ok format=json}\n{"type":"object"}\n===\n\n'
  + '=== flow-transition {#ship from=#review to=#done auto requires=#ok}\nx\n===\n';
const blocks = { "docs/a.md#one": "A".repeat(40), "./guide.geml#two": "=== x\nfence-looking\n===", "docs/c.md#three": "C".repeat(40) };

test("the stage context: instruction, what is allowed, where next, then the blocks in order", () => {
  const sc = loadStatechart(src(), "f.geml").statechart;
  const ctx = buildStageContext(sc, initialSnapshot(sc, "t0"), (ref) => blocks[ref]);
  assert.equal(ctx.state, "review");
  assert.deepEqual(ctx.included, ["docs/a.md#one", "./guide.geml#two", "docs/c.md#three"]);
  assert.deepEqual(ctx.truncated, []);
  assert.match(ctx.text, /^\[gemflow\] stage #review · rev 0\nHandle the review comments\.\n\nAllowed here: read search \(advice; other tools are recorded\)\nNext: #done \(on its own, when #ok holds\)/);
  assert.ok(ctx.text.indexOf("--- docs/a.md#one ---") < ctx.text.indexOf("--- ./guide.geml#two ---"));
});

test("the budget cuts the later references, and says which", () => {
  const sc = loadStatechart(src(260), "f.geml").statechart;
  const ctx = buildStageContext(sc, initialSnapshot(sc, "t0"), (ref) => blocks[ref]);
  assert.ok(ctx.truncated.length >= 1);
  assert.deepEqual(ctx.included.concat(ctx.truncated), ["docs/a.md#one", "./guide.geml#two", "docs/c.md#three"]);
  assert.match(ctx.text, /left out to stay within 260 bytes: .*docs\/c\.md#three/);
});

test("a missing block is named, not fatal", () => {
  const sc = loadStatechart(src(), "f.geml").statechart;
  const ctx = buildStageContext(sc, initialSnapshot(sc, "t0"), () => undefined);
  assert.match(ctx.text, /--- docs\/a\.md#one ---\n\(not found\)/);
});

test("the context document round-trips, with a fence wider than any fence-like body line", () => {
  const sc = loadStatechart(src(), "f.geml").statechart;
  const ctx = buildStageContext(sc, initialSnapshot(sc, "t0"), (ref) => blocks[ref]);
  const doc = renderContextDoc(ctx, { at: "t1", item: "feat/x" });
  assert.match(doc, /\n==== flow-context \{#current state=#review rev=0 at="t1" item="feat\/x"\}\n/);
  assert.deepEqual(readContextDoc(doc), { state: "review", rev: 0, at: "t1", item: "feat/x", text: ctx.text });
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/stagehand.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/core/stagehand.js`.

- [ ] **Step 3: Write the module**

Create `integrations/gemflow/src/core/stagehand.ts`:

```ts
// Stagehand: when the workflow enters a state, put together what the model
// should have in front of it — the state's instruction, what it may do, where
// it can go next, and the blocks the state's `context=` names, in order,
// within the workflow's byte budget. Pure: the host supplies the block text.
import { parse, type Block } from "@geml/geml";
import type { Snapshot } from "./snapshot.js";
import { effectiveTools, outgoing, type Statechart } from "./statechart.js";

export interface StageContext { state: string; rev: number; text: string; included: string[]; truncated: string[] }

const bytes = (s: string): number => new TextEncoder().encode(s).length;

export function buildStageContext(sc: Statechart, snap: Snapshot, getBlock: (ref: string) => string | undefined): StageContext {
  const state = sc.states.get(snap.state);
  const tools = state ? effectiveTools(sc, state) : undefined;
  const allowed = tools === undefined ? "anything" : tools.length ? tools.join(" ") : "nothing";
  const next = outgoing(sc, snap.state).map((t) => {
    const how = [t.auto ? "on its own" : "", t.requiresId ? `when #${t.requiresId} holds` : "", t.approval ? "with a person's approval" : ""].filter((x) => x).join(", ");
    return `#${t.to}${how ? ` (${how})` : ""}`;
  });
  const nextText = next.length ? next.join(" · ") : state?.final ? "nothing — this is the final stage" : "nothing";
  let text = [
    `[gemflow] stage #${snap.state} · rev ${snap.rev}`,
    state?.body ?? "",
    "",
    `Allowed here: ${allowed}${state?.strict ? " (enforced)" : " (advice; other tools are recorded)"}`,
    `Next: ${nextText}`,
  ].join("\n");
  const included: string[] = [];
  const truncated: string[] = [];
  for (const ref of state?.context ?? []) {
    const piece = `\n\n--- ${ref} ---\n${getBlock(ref) ?? "(not found)"}`;
    if (truncated.length > 0 || bytes(text) + bytes(piece) > sc.contextBudget) { truncated.push(ref); continue; }
    text += piece;
    included.push(ref);
  }
  if (truncated.length > 0) text += `\n\n(left out to stay within ${sc.contextBudget} bytes: ${truncated.join(", ")} — read them with geml get when you need them)`;
  return { state: snap.state, rev: snap.rev, text, included, truncated };
}

/** `.geml/context.geml`: one raw `flow-context` block, fenced wider than any `=`-run that starts a body line. */
export function renderContextDoc(ctx: StageContext, o: { at: string; item: string }): string {
  const longest = Math.max(0, ...ctx.text.split("\n").map((l) => l.match(/^=+/)?.[0].length ?? 0));
  const fence = "=".repeat(Math.max(3, longest + 1));
  return [
    "=== meta",
    'title   = "Gemflow — current stage"',
    'profile = "geml-flow/v1"',
    "===",
    "",
    `${fence} flow-context {#current state=#${ctx.state} rev=${ctx.rev} at=${JSON.stringify(o.at)} item=${JSON.stringify(o.item)}}`,
    ctx.text,
    fence,
    "",
  ].join("\n");
}

type Typed = Extract<Block, { kind: "block" }>;

export function readContextDoc(source: string): { state: string; rev: number; at: string; item: string; text: string } | undefined {
  const b = parse(source).children.find((x): x is Typed => x.kind === "block" && x.type === "flow-context" && x.id === "current");
  if (!b) return undefined;
  const state = String(b.attrs["state"] ?? "");
  return {
    state: state.startsWith("#") ? state.slice(1) : state,
    rev: Number(b.attrs["rev"] ?? -1),
    at: String(b.attrs["at"] ?? ""),
    item: String(b.attrs["item"] ?? ""),
    text: (b.raw ?? []).join("\n"),
  };
}
```

Add `export * from "./core/stagehand.js";` to `src/index.ts`.

- [ ] **Step 4: Watch it pass**

Run: `cd integrations/gemflow && npx tsc && node --test test/stagehand.test.mjs test/purity.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 0`. If the round-trip test fails because the parser keeps a trailing empty raw line, trim one trailing `""` in `readContextDoc` and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src/core/stagehand.ts integrations/gemflow/src/index.ts integrations/gemflow/test/stagehand.test.mjs
git commit -m "feat(gemflow): Stagehand builds the stage context and the context document"
```

---

### Task 7: Work items and paths

**Files:** Create `integrations/gemflow/src/core/unit.ts`, `test/unit.test.mjs`; modify `src/core/layout.ts`, `src/index.ts`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/unit.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, resolveItem, journalPathFor } from "../dist/core/unit.js";
import { JOURNALS_DIR, CONTEXT_DOC, CONFIG_DOC, BACKLOG_DOC, WORKFLOWS_DIR, FLOW_FILE } from "../dist/core/layout.js";

test("globs: * stays in a segment, ** crosses them, ? is one character", () => {
  assert.ok(globToRegExp("episodes/*.geml").test("episodes/ep02.geml"));
  assert.ok(!globToRegExp("episodes/*.geml").test("episodes/s1/ep02.geml"));
  assert.ok(globToRegExp("episodes/**/*.geml").test("episodes/s1/ep02.geml"));
  assert.ok(globToRegExp("episodes/**/*.geml").test("episodes/ep02.geml"));
  assert.ok(globToRegExp("out/ep0?.mp4").test("out/ep01.mp4"));
  assert.ok(!globToRegExp("a.b").test("axb"), "dots are literal");
});

test("branch unit: the branch is the item; the default branch and a detached head are not tracked", () => {
  assert.deepEqual(resolveItem({ kind: "branch" }, { branch: "feat/x", defaultBranch: "main" }), { kind: "item", id: "feat/x" });
  assert.deepEqual(resolveItem({ kind: "branch" }, { branch: "main", defaultBranch: "main" }), { kind: "inactive", reason: "main · not tracked (work items are branches)" });
  assert.deepEqual(resolveItem({ kind: "branch" }, { branch: "HEAD", defaultBranch: "main" }), { kind: "inactive", reason: "detached HEAD · not tracked" });
  assert.deepEqual(resolveItem({ kind: "branch" }, {}), { kind: "inactive", reason: "not a git repository" });
});

test("file unit: the last matching file, without its extension", () => {
  const unit = { kind: "file", glob: "episodes/*.geml" };
  assert.deepEqual(resolveItem(unit, { lastFile: "episodes/ep02.geml" }), { kind: "item", id: "episodes/ep02" });
  assert.deepEqual(resolveItem(unit, { lastFile: "notes.md" }), { kind: "inactive", reason: "no work item yet: edit a file matching episodes/*.geml" });
  assert.deepEqual(resolveItem(unit, {}), { kind: "inactive", reason: "no work item yet: edit a file matching episodes/*.geml" });
});

test("paths", () => {
  assert.equal(journalPathFor("feat/x"), ".geml/journals/feat/x.geml");
  assert.deepEqual([JOURNALS_DIR, CONTEXT_DOC, CONFIG_DOC, BACKLOG_DOC, WORKFLOWS_DIR, FLOW_FILE],
    [".geml/journals", ".geml/context.geml", ".geml/gemflow.geml", ".geml/backlog.geml", ".geml/workflows", "flow.geml"]);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/unit.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find|has no exported"; cd ../..`
Expected: a missing-module or missing-export failure.

- [ ] **Step 3: Write the code**

Replace `src/core/layout.ts` with:

```ts
// Where a project's GEML files live, as one convention rather than literals
// repeated across adapters. Everything goes under one dotted directory, the
// way `.pi/` and `.claude/` do.
export const GEML_DIR = ".geml";
export const WORKFLOWS_DIR = `${GEML_DIR}/workflows`;
/** A workflow is a directory: this file plus the documents its states' `context=` names with `./`. */
export const FLOW_FILE = "flow.geml";
export const JOURNALS_DIR = `${GEML_DIR}/journals`;
export const CONTEXT_DOC = `${GEML_DIR}/context.geml`;
export const BACKLOG_DOC = `${GEML_DIR}/backlog.geml`;
/** Project configuration: meta `flow-workflow` names the active workflow's directory. */
export const CONFIG_DOC = `${GEML_DIR}/gemflow.geml`;
/** Where `geml codemap build` writes this project's code graph. */
export const DEFAULT_CODEMAP_DIR = `${GEML_DIR}/codemap`;
```

(`DEFAULT_STATECHART` goes; Task 12 moves its two adapter users to workflow resolution. Until then, `tsc` will fail on those imports — so do Task 7 and Task 12's Step 1 in the same sitting, or keep a temporary `export const DEFAULT_STATECHART = \`${GEML_DIR}/agent.geml\`;` line that Task 12 deletes. Prefer the temporary line; Task 12 removes it.)

Create `src/core/unit.ts`:

```ts
// What a journal is about: a branch, or one file of a set (spec §5.5). Pure:
// the host says which branch is checked out and which file was written last.
import type { Unit } from "./statechart.js";
import { JOURNALS_DIR } from "./layout.js";

export interface ItemFacts { branch?: string; defaultBranch?: string; lastFile?: string }
export type Item = { kind: "item"; id: string } | { kind: "inactive"; reason: string };

/** A glob as a whole-path regular expression: `*` within a segment, `**` across segments, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function resolveItem(unit: Unit, f: ItemFacts): Item {
  if (unit.kind === "branch") {
    if (!f.branch) return { kind: "inactive", reason: "not a git repository" };
    if (f.branch === "HEAD") return { kind: "inactive", reason: "detached HEAD · not tracked" };
    if (f.branch === f.defaultBranch) return { kind: "inactive", reason: `${f.branch} · not tracked (work items are branches)` };
    return { kind: "item", id: f.branch };
  }
  if (f.lastFile && globToRegExp(unit.glob).test(f.lastFile)) return { kind: "item", id: f.lastFile.replace(/\.[^./]+$/, "") };
  return { kind: "inactive", reason: `no work item yet: edit a file matching ${unit.glob}` };
}

export function journalPathFor(itemId: string): string {
  return `${JOURNALS_DIR}/${itemId}.geml`;
}
```

Add `export * from "./core/unit.js";` to `src/index.ts`.

- [ ] **Step 4: Watch it pass**

Run: `cd integrations/gemflow && npx tsc && node --test test/unit.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src/core/unit.ts integrations/gemflow/src/core/layout.ts integrations/gemflow/src/index.ts integrations/gemflow/test/unit.test.mjs
git commit -m "feat(gemflow): work items — a branch or one file of a set — and the project layout"
```

---

### Task 8: The backlog

**Files:** Create `integrations/gemflow/src/core/backlog.ts`, `test/backlog.test.mjs`; modify `src/index.ts`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/backlog.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readBacklog, renderBacklog, bindItem, itemFor } from "../dist/core/backlog.js";

const DOC = '=== meta\ntitle = "Backlog"\nprofile = "geml-flow/v1"\n===\n\n=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| rate-limit | 登录接口加限流 | feat/rate-limit |\n| dark-mode | 设置页支持深色模式 | |\n===\n';

test("read: rows become items; an empty target is a to-do", () => {
  const b = readBacklog(DOC);
  assert.deepEqual(b.diagnostics, []);
  assert.equal(b.key, "branch");
  assert.deepEqual(b.items, [
    { id: "rate-limit", title: "登录接口加限流", target: "feat/rate-limit" },
    { id: "dark-mode", title: "设置页支持深色模式", target: "" },
  ]);
  assert.equal(itemFor(b.items, "feat/rate-limit").id, "rate-limit");
});

test("bind, then render round-trips", () => {
  const b = readBacklog(DOC);
  const bound = bindItem(b.items, "dark-mode", "feat/dark");
  assert.equal(bound.ok, true);
  const text = renderBacklog(bound.items, "branch");
  assert.deepEqual(readBacklog(text).items[1], { id: "dark-mode", title: "设置页支持深色模式", target: "feat/dark" });
  assert.deepEqual(bindItem(bound.items, "dark-mode", "feat/other"), { ok: false, reason: "dark-mode is already bound to feat/dark" });
  assert.deepEqual(bindItem(b.items, "nope", "x"), { ok: false, reason: "no backlog item nope" });
});

test("a file-unit backlog uses a file column; a pipe in a title survives", () => {
  const items = [{ id: "ep03", title: "第三集 | 雨夜", target: "" }];
  const text = renderBacklog(items, "file");
  assert.match(text, /\| id \| title \| file \|/);
  assert.deepEqual(readBacklog(text), { key: "file", items, diagnostics: [] });
});

test("no backlog table is a diagnostic, not a throw", () => {
  assert.deepEqual(readBacklog("=== meta\ntitle = \"x\"\n===\n").diagnostics, ["no table block #backlog"]);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/backlog.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: missing module.

- [ ] **Step 3: Write the module**

Create `integrations/gemflow/src/core/backlog.ts`:

```ts
// The backlog: what is still to do, as one table (spec §5.6). A row with an
// empty branch (or file) column is a to-do; binding it to a work item fills
// the column. Progress is read from the item's journal, never stored here.
import { parse, type Block } from "@geml/geml";

export interface BacklogItem { id: string; title: string; target: string }
export type BacklogKey = "branch" | "file";

type TableBlock = Extract<Block, { kind: "block" }> & { table?: { columns: string[]; rows: { text: string }[][] } };

export function readBacklog(source: string): { key: BacklogKey; items: BacklogItem[]; diagnostics: string[] } {
  const tb = parse(source).children.find((b): b is TableBlock => b.kind === "block" && b.type === "table" && b.id === "backlog");
  if (!tb?.table) return { key: "branch", items: [], diagnostics: ["no table block #backlog"] };
  const cols = tb.table.columns.map((c) => c.trim().toLowerCase());
  const key: BacklogKey = cols.includes("file") ? "file" : "branch";
  const at = (name: string) => cols.indexOf(name);
  const cell = (row: { text: string }[], name: string) => (at(name) >= 0 ? (row[at(name)]?.text ?? "").trim() : "");
  const items = tb.table.rows.map((row) => ({ id: cell(row, "id"), title: cell(row, "title"), target: cell(row, key) }));
  const diagnostics = at("id") < 0 || at("title") < 0 ? ["#backlog needs id and title columns"] : [];
  return { key, items, diagnostics };
}

const esc = (s: string): string => s.replace(/\|/g, "\\|");

export function renderBacklog(items: readonly BacklogItem[], key: BacklogKey): string {
  const rows = items.map((i) => `| ${esc(i.id)} | ${esc(i.title)} | ${esc(i.target)} |`);
  return [
    "=== meta", 'title   = "Backlog"', 'profile = "geml-flow/v1"', "===", "",
    "=== table {#backlog}", `| id | title | ${key} |`, "|---|---|---|", ...rows, "===", "",
  ].join("\n");
}

export function bindItem(items: readonly BacklogItem[], id: string, target: string): { ok: true; items: BacklogItem[] } | { ok: false; reason: string } {
  const found = items.find((i) => i.id === id);
  if (!found) return { ok: false, reason: `no backlog item ${id}` };
  if (found.target && found.target !== target) return { ok: false, reason: `${id} is already bound to ${found.target}` };
  return { ok: true, items: items.map((i) => (i.id === id ? { ...i, target } : i)) };
}

export function itemFor(items: readonly BacklogItem[], target: string): BacklogItem | undefined {
  return items.find((i) => i.target === target);
}
```

Add `export * from "./core/backlog.js";` to `src/index.ts`.

- [ ] **Step 4: Watch it pass**

Run: `cd integrations/gemflow && npx tsc && node --test test/backlog.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 0`. If the parser keeps `\|` escaped in a cell's `text`, unescape in `cell()` (`.replace(/\\\|/g, "|")`) and say so.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src/core/backlog.ts integrations/gemflow/src/index.ts integrations/gemflow/test/backlog.test.mjs
git commit -m "feat(gemflow): the backlog table — read, bind, render"
```

---

### Task 9: Locks, atomic writes, glob search, git and gh facts

**Files:** Modify `integrations/gemflow/src/host-fs.ts`; create `src/host-git.ts`, `test/host.test.mjs`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/host.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { withLock, writeAtomic, globExists } from "../dist/host-fs.js";
import { repoFacts, ghFacts } from "../dist/host-git.js";

const tmp = () => mkdtempSync(join(tmpdir(), "gemflow-host-"));

test("withLock runs the function under a lock file and removes it", () => {
  const d = tmp(); const p = join(d, "j.geml");
  const v = withLock(p, () => { assert.ok(existsSync(p + ".lock")); return 7; });
  assert.equal(v, 7);
  assert.ok(!existsSync(p + ".lock"));
});

test("withLock waits out a held lock and breaks a stale one", () => {
  const d = tmp(); const p = join(d, "j.geml");
  writeFileSync(p + ".lock", "999999");
  assert.throws(() => withLock(p, () => 1, { timeoutMs: 100, staleMs: 60_000 }), /is held/);
  const old = new Date(Date.now() - 120_000);
  utimesSync(p + ".lock", old, old);
  assert.equal(withLock(p, () => 2, { timeoutMs: 100, staleMs: 60_000 }), 2);
});

test("writeAtomic creates parents and replaces the file whole", () => {
  const d = tmp(); const p = join(d, "a", "b", "c.geml");
  writeAtomic(p, "one"); writeAtomic(p, "two");
  assert.equal(readFileSync(p, "utf8"), "two");
});

test("globExists searches the project, skipping .git, node_modules and .geml", () => {
  const d = tmp();
  mkdirSync(join(d, "out"), { recursive: true }); writeFileSync(join(d, "out", "ep01.mp4"), "");
  mkdirSync(join(d, "node_modules", "x"), { recursive: true }); writeFileSync(join(d, "node_modules", "x", "y.mp4"), "");
  assert.equal(globExists(d, "out/*.mp4"), true);
  assert.equal(globExists(d, "**/y.mp4"), false);
});

test("repoFacts reads branch, default branch and whether the branch has commits", () => {
  const d = tmp();
  const git = (...a) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(d, "f"), "1"); git("add", "f"); git("commit", "-qm", "one");
  assert.deepEqual(repoFacts(d), { branch: "main", defaultBranch: "main", committed: false });
  git("checkout", "-qb", "feat/x");
  assert.deepEqual(repoFacts(d), { branch: "feat/x", defaultBranch: "main", committed: false });
  writeFileSync(join(d, "f"), "2"); git("commit", "-qam", "two");
  assert.deepEqual(repoFacts(d), { branch: "feat/x", defaultBranch: "main", committed: true });
  assert.deepEqual(repoFacts(tmp()), {});
});

test("ghFacts reports itself unavailable when gh is missing", () => {
  const r = ghFacts(tmp(), "feat/x", { gh: "gh-definitely-not-installed" });
  assert.equal(r.available, false);
  assert.match(r.reason, /gh is not installed/);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/host.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|has no exported|Cannot find"; cd ../..`
Expected: missing exports/module.

- [ ] **Step 3: Write the code**

Append to `integrations/gemflow/src/host-fs.ts` (keep its existing functions; extend its `node:fs` import with `openSync`, `closeSync`, `writeSync`, `unlinkSync`, `statSync`, `renameSync`, `readdirSync`, and add `import { join, relative } from "node:path";` and `import { globToRegExp } from "./core/unit.js";`):

```ts
const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Run `fn` holding `<path>.lock` (created with "wx"). Waits up to `timeoutMs`
 * for another holder; a lock older than `staleMs` is a crashed holder's and is
 * broken. The lock is removed however `fn` ends.
 */
export function withLock<T>(path: string, fn: () => T, o: { timeoutMs?: number; staleMs?: number } = {}): T {
  const lock = `${path}.lock`;
  const timeoutMs = o.timeoutMs ?? 5000, staleMs = o.staleMs ?? 30_000;
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > staleMs) { try { unlinkSync(lock); } catch { /* another process broke it first */ } continue; }
      if (Date.now() - start > timeoutMs) throw new Error(`gemflow: ${lock} is held by another process`);
      sleepMs(25);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

/** Replace a file whole: write a sibling temp file, then rename over the target. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

const SKIP = new Set([".git", "node_modules", ".geml"]);

/** Whether any file under `root` matches `glob` (project-relative, `/`-separated). Stops at the first match. */
export function globExists(root: string, glob: string, limit = 50_000): boolean {
  const re = globToRegExp(glob);
  let seen = 0;
  const walk = (dir: string): boolean => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (++seen > limit) return false;
      if (SKIP.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) { if (walk(full)) return true; }
      else if (re.test(relative(root, full).split("\\").join("/"))) return true;
    }
    return false;
  };
  try { return walk(root); } catch { return false; }
}
```

Create `integrations/gemflow/src/host-git.ts`:

```ts
// What git and gh say about the project, for the branch unit and the git
// signals. Every call is an argument vector (no shell) with a timeout; a tool
// that is missing or fails reads as "not established", never as false.
import { spawnSync } from "node:child_process";
import type { GitFacts } from "./core/signals.js";

export interface RepoFacts { branch?: string; defaultBranch?: string; committed?: boolean }
export type GhFacts = ({ available: true } & GitFacts) | { available: false; reason: string };

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string; missing: boolean } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 10_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), missing: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" };
}

export function repoFacts(root: string): RepoFacts {
  const head = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (!head.ok) return {};
  const facts: RepoFacts = { branch: head.out };
  const origin = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  if (origin.ok) facts.defaultBranch = origin.out.replace(/^origin\//, "");
  else for (const name of ["main", "master"]) {
    if (run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], root).ok) { facts.defaultBranch = name; break; }
  }
  if (facts.defaultBranch && facts.branch !== facts.defaultBranch && facts.branch !== "HEAD") {
    const ahead = run("git", ["rev-list", "--count", `${facts.defaultBranch}..HEAD`], root);
    if (ahead.ok) facts.committed = Number(ahead.out) > 0;
  } else if (facts.defaultBranch) facts.committed = false;
  return facts;
}

export function ghFacts(root: string, branch: string, o: { gh?: string } = {}): GhFacts {
  const gh = o.gh ?? "gh";
  const pr = run(gh, ["pr", "view", branch, "--json", "state"], root);
  if (pr.missing) return { available: false, reason: "gh is not installed" };
  const facts: { available: true } & GitFacts = { available: true };
  if (pr.ok) {
    const state = (JSON.parse(pr.out) as { state?: string }).state;
    facts.prOpen = state === "OPEN";
    facts.prMerged = state === "MERGED";
  } else if (/no pull requests? found/i.test(pr.out + run(gh, ["pr", "view", branch], root).out)) {
    facts.prOpen = false; facts.prMerged = false;
  } else {
    return { available: false, reason: "gh could not be queried (not logged in, or no GitHub remote)" };
  }
  const head = run("git", ["rev-parse", "HEAD"], root).out;
  const runs = run(gh, ["run", "list", "--branch", branch, "--limit", "20", "--json", "workflowName,conclusion,headSha"], root);
  if (runs.ok) {
    const list = JSON.parse(runs.out) as { workflowName: string; conclusion: string; headSha: string }[];
    facts.ci = list.filter((r) => r.headSha === head).map((r) => ({ workflow: r.workflowName, success: r.conclusion === "success" }));
  }
  return facts;
}
```

- [ ] **Step 4: Watch it pass**

Run: `cd integrations/gemflow && npx tsc && node --test test/host.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 0`. (`purity.test.mjs` scans only `dist/core/`; these two files sit outside it on purpose.)

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src/host-fs.ts integrations/gemflow/src/host-git.ts integrations/gemflow/test/host.test.mjs
git commit -m "feat(gemflow): journal locks, atomic writes, glob search, and git/gh facts"
```

---

### Task 10: The workspace — one operation at a time

**Files:** Create `integrations/gemflow/src/workspace.ts`, `test/workspace.test.mjs`, `test/fixtures/ws-dev/flow.geml`; modify `src/core/capabilities.ts` (add `NO_CAPABILITIES`), `src/index.ts` is NOT changed (the workspace is impure and reached by path).

- [ ] **Step 1: Fixture workflow**

Create `integrations/gemflow/test/fixtures/ws-dev/flow.geml`:

```geml
=== meta
title        = "Test dev flow"
profile      = "geml-flow/v1"
flow-tools   = "read write run search"
flow-signals = "#signals"
===

=== flow-vars {#vars}
{ "type": "object", "properties": {
    "tests-pass": { "type": "boolean", "default": false },
    "pr-open":    { "type": "boolean", "default": false },
    "reviewed":   { "type": "boolean", "default": false } } }
===

=== table {#signals}
| id       | on      | match    | sets       | when      |
|----------|---------|----------|------------|-----------|
| tests    | command | npm test | tests-pass | exit-zero |
| pr       | git     |          | pr-open    | pr-open   |
| reviewed | manual  | 已处理    | reviewed   | checked   |
===

=== flow-state {#build initial context="./guide.geml#build"}
Write the code and its tests.
===

=== flow-state {#review}
Handle the review.
===

=== flow-state {#done final}
Done.
===

=== data {#ready format=json}
{ "type": "object", "properties": { "tests-pass": { "const": true }, "pr-open": { "const": true } } }
===

=== flow-transition {#to-review from=#build to=#review auto requires=#ready}
Tests pass and the PR is open.
===

=== flow-transition {#ship from=#review to=#done}
Merged.
===
```

and `integrations/gemflow/test/fixtures/ws-dev/guide.geml`:

```geml
=== meta
title = "Guide"
===

# Build {#build}

Run npm test before you push.
```

- [ ] **Step 2: Failing test**

Create `integrations/gemflow/test/workspace.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "../dist/workspace.js";
import { CLAUDE_CODE_CAPABILITIES } from "../dist/core/capabilities.js";
import { readJournal } from "../dist/core/journal.js";
import { readContextDoc } from "../dist/core/stagehand.js";

const FIX = new URL("./fixtures/ws-dev/", import.meta.url);

function project({ branch = "feat/x", pr } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gemflow-ws-"));
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(FIX, join(root, ".geml", "workflows", "dev"), { recursive: true });
  writeFileSync(join(root, ".geml", "gemflow.geml"), '=== meta\nprofile = "geml-flow/v1"\nflow-workflow = "dev"\n===\n');
  let now = 0;
  const open = () => openWorkspace({
    root, host: "claude", capabilities: CLAUDE_CODE_CAPABILITIES,
    now: () => `2026-10-11T00:00:${String(now++).padStart(2, "0")}Z`,
    git: () => ({ branch, defaultBranch: "main", committed: true }),
    gh: () => (pr === undefined ? { available: false, reason: "gh is not installed" } : { available: true, prOpen: pr, prMerged: false, ci: [] }),
    getBlock: (ref) => (ref === "./guide.geml#build" ? "Run npm test before you push." : undefined),
  });
  return { root, open };
}

test("open: the workflow, the item, and a fresh journal and context on first use", () => {
  const p = project();
  const o = p.open();
  assert.equal(o.ok, true);
  const s = o.ws.status();
  assert.equal(s.workflow.name, "dev");
  assert.deepEqual(s.item, { kind: "item", id: "feat/x" });
  assert.equal(s.state.id, "build");
  assert.ok(existsSync(join(p.root, ".geml", "journals", "feat", "x.geml")));
  const ctx = readContextDoc(readFileSync(join(p.root, ".geml", "context.geml"), "utf8"));
  assert.equal(ctx.state, "build");
  assert.match(ctx.text, /Run npm test before you push\./);
});

test("on the default branch nothing is tracked", () => {
  const o = project({ branch: "main" }).open();
  assert.equal(o.ok, true);
  assert.deepEqual(o.ws.status().item, { kind: "inactive", reason: "main · not tracked (work items are branches)" });
  assert.equal(o.ws.before("Edit", "c1", {}), undefined, "an inactive workspace never refuses");
});

test("after: a test run and a PR advance the workflow, and the context follows", () => {
  const p = project({ pr: true });
  const ws = p.open().ws;
  const r1 = ws.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.deepEqual(r1.entered, []);
  const r2 = ws.refresh();
  assert.deepEqual(r2.entered, ["review"]);
  assert.match(r2.context, /\[gemflow\] stage #review/);
  const j = readJournal(readFileSync(join(p.root, ".geml", "journals", "feat", "x.geml"), "utf8"));
  assert.deepEqual(j.snapshots.map((s) => [s.state, s.by ?? "", s.signal ?? ""]), [
    ["build", "", ""], ["build", "signal", "tests"], ["build", "signal", "pr"], ["review", "signal", "pr"],
  ]);
  assert.equal(readContextDoc(readFileSync(join(p.root, ".geml", "context.geml"), "utf8")).state, "review");
});

test("a second workspace on the same project sees the first one's writes", () => {
  const p = project({ pr: true });
  p.open().ws.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "npm test" }, exitCode: 0 });
  const s = p.open().ws.status();
  assert.equal(s.vars["tests-pass"], true);
});

test("mark and advance are a person's; verbs are the model's", async () => {
  const p = project({ pr: true });
  const ws = p.open().ws;
  ws.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "npm test" }, exitCode: 0 });
  ws.refresh();
  assert.deepEqual(ws.mark("reviewed", true).ok, true);
  assert.deepEqual(ws.advance("done"), { ok: true, entered: ["done"], context: ws.context() });
  const bad = await ws.verb("flow_transition", { to: "build" }, "v1");
  assert.equal(bad.ok, false, "done is final");
});

test("status lists signals with their values and the next edges with whether their guard holds", () => {
  const ws = project({ pr: false }).open().ws;
  const s = ws.status();
  assert.deepEqual(s.signals.map((x) => [x.id, x.value]), [["tests", false], ["pr", false], ["reviewed", false]]);
  assert.deepEqual(s.next, [{ id: "to-review", to: "review", auto: true, approval: false, requires: "ready", holds: false }]);
  assert.equal(s.gh.available, true);
});
```

- [ ] **Step 3: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/workspace.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: missing module.

- [ ] **Step 4: Write the workspace**

Append to `src/core/capabilities.ts`:

```ts
/** For callers that never see tool calls (the CLI): no tool belongs to any capability. */
export const NO_CAPABILITIES: CapabilityMap = { read: [], write: [], run: [], search: [], web: [] };
```

Create `integrations/gemflow/src/workspace.ts`:

```ts
// One project's Gemflow, one operation at a time. Every call that can change
// the workflow takes the journal's lock, reads the journal fresh, acts through
// the Supervisor, appends what it produced, and rewrites .geml/context.geml
// when the stage changed — so the CLI, an MCP server and a host's hooks can
// share a project without sharing memory.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@geml/geml";
import { appendOrCreate, exists, globExists, readText, withLock, writeAtomic } from "./host-fs.js";
import { ghFacts as realGh, repoFacts as realRepo, type GhFacts, type RepoFacts } from "./host-git.js";
import { capabilityOf, type CapabilityMap } from "./core/capabilities.js";
import { CONFIG_DOC, CONTEXT_DOC, FLOW_FILE, WORKFLOWS_DIR } from "./core/layout.js";
import { validate, type JsonValue } from "./core/schema.js";
import { fileSignals, gitSignals } from "./core/signals.js";
import { buildStageContext, readContextDoc, renderContextDoc } from "./core/stagehand.js";
import { hasErrors, loadStatechart, outgoing, type Statechart } from "./core/statechart.js";
import { metaFor, openRun, Supervisor, type ApprovalGate, type Invoked } from "./core/supervisor.js";
import { journalPathFor, resolveItem, type Item } from "./core/unit.js";

export interface WorkspaceOptions {
  root: string;
  /** The host's name as `<host>:<tool>` spells it, and its capability map. */
  host: string;
  capabilities: CapabilityMap;
  now?: () => string;
  /** For `flow-unit = "file:…"`: the file a write-capability call touched last. */
  lastFile?: string;
  git?: (root: string) => RepoFacts;
  gh?: (root: string, branch: string) => GhFacts;
  /** One block's text for Stagehand; defaults to the parser CLI's `geml get`. */
  getBlock?: (ref: string, workflowDir: string, root: string) => string | undefined;
  /** Approval for a model verb on an `approval` edge; absent, every such request is denied. */
  approve?: ApprovalGate;
}

export interface AfterEvent {
  tool: string;
  callId?: string;
  isError: boolean;
  input?: Record<string, unknown>;
  /** The run-capability call's exit status; null when it went to the background. */
  exitCode?: number | null;
  /** The project-relative path a write-capability call touched. */
  wrotePath?: string;
}

export interface StageChange { entered: string[]; context?: string }

export interface Status {
  workflow: { name: string; path: string; title: string };
  item: Item;
  state?: { id: string; strict: boolean; rev: number };
  vars: Record<string, JsonValue>;
  signals: { id: string; on: string; sets: string; label: string; value: boolean }[];
  next: { id: string; to: string; auto: boolean; approval: boolean; requires?: string; holds: boolean }[];
  refusals: number;
  deviations: number;
  gh: { available: true } | { available: false; reason: string };
}

export type Opened = { ok: true; ws: Workspace } | { ok: false; reason: string };

const parserCli = (): string => createRequire(import.meta.url).resolve("@geml/geml/dist/geml.js");

function defaultGetBlock(ref: string, workflowDir: string, root: string): string | undefined {
  const hash = ref.indexOf("#");
  const file = ref.startsWith("./") ? join(workflowDir, ref.slice(2, hash)) : join(root, ref.slice(0, hash));
  const r = spawnSync(process.execPath, [parserCli(), "get", file, ref.slice(hash)], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.replace(/\n$/, "") : undefined;
}

/** Which workflow is active: GEMFLOW_STATECHART, else the config document, else the only workflow. */
export function resolveWorkflow(root: string, env: Record<string, string | undefined> = process.env): { name: string; path: string } | { error: string } {
  if (env["GEMFLOW_STATECHART"]) {
    const path = resolve(root, env["GEMFLOW_STATECHART"]);
    return { name: relative(root, dirname(path)) || ".", path };
  }
  const configPath = join(root, CONFIG_DOC);
  if (exists(configPath)) {
    const meta = parse(readText(configPath)).children.find((b) => b.kind === "block" && b.type === "meta");
    const name = meta && meta.kind === "block" && meta.data ? meta.data["flow-workflow"] : undefined;
    if (typeof name === "string" && name) {
      const path = join(root, WORKFLOWS_DIR, name, FLOW_FILE);
      return exists(path) ? { name, path } : { error: `${CONFIG_DOC} names workflow "${name}", but ${relative(root, path)} does not exist` };
    }
  }
  const dir = join(root, WORKFLOWS_DIR);
  const names = exists(dir) ? listDirs(dir).filter((n) => exists(join(dir, n, FLOW_FILE))) : [];
  if (names.length === 1) return { name: names[0]!, path: join(dir, names[0]!, FLOW_FILE) };
  return { error: names.length === 0 ? "no workflow here: run `gemflow init`" : `several workflows (${names.join(", ")}): choose one with \`gemflow use <name>\`` };
}

function listDirs(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}
```

Correct the last helper to use an ES import instead of `require` (this package is ESM): add `readdirSync` to a `import { readdirSync } from "node:fs";` line at the top and write `listDirs` as `return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();`.

Continue the file with the class:

```ts
export function openWorkspace(o: WorkspaceOptions): Opened {
  const wf = resolveWorkflow(o.root);
  if ("error" in wf) return { ok: false, reason: wf.error };
  const workflowDir = dirname(wf.path);
  const getBlock = o.getBlock ?? defaultGetBlock;
  const loaded = loadStatechart(readText(wf.path), relative(o.root, wf.path), { host: o.host });
  if (!loaded.statechart || hasErrors(loaded.diagnostics)) {
    return { ok: false, reason: `${relative(o.root, wf.path)}: ${loaded.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`).join("; ")}` };
  }
  const ws = new Workspace(o, wf.name, wf.path, workflowDir, loaded.statechart, getBlock);
  ws.ensureStarted();
  return { ok: true, ws };
}

export class Workspace {
  readonly item: Item;
  private readonly now: () => string;
  private readonly repo: RepoFacts;

  constructor(
    private readonly o: WorkspaceOptions,
    readonly workflowName: string,
    readonly workflowPath: string,
    private readonly workflowDir: string,
    readonly sc: Statechart,
    private readonly getBlock: (ref: string, workflowDir: string, root: string) => string | undefined,
  ) {
    this.now = o.now ?? (() => new Date().toISOString());
    this.repo = (o.git ?? realRepo)(o.root);
    const remembered = this.readContext()?.item;
    const lastFile = o.lastFile ?? (sc.unit.kind === "file" && remembered ? `${remembered}.geml` : undefined);
    this.item = resolveItem(sc.unit, { ...this.repo, ...(lastFile ? { lastFile } : {}) });
  }

  private get journalPath(): string | undefined {
    return this.item.kind === "item" ? join(this.o.root, journalPathFor(this.item.id)) : undefined;
  }

  private readContext() {
    const p = join(this.o.root, CONTEXT_DOC);
    return exists(p) ? readContextDoc(readText(p)) : undefined;
  }

  /** Create the journal and the context document if this item has none yet. */
  ensureStarted(): void {
    if (this.journalPath && !exists(this.journalPath)) this.act(() => undefined);
  }

  /**
   * Lock, read the journal, build a Supervisor over it, run `fn`, append what
   * it produced, and rewrite the context document if the stage changed.
   */
  private act<T>(fn: (sup: Supervisor) => T): { value: T; change: StageChange } | undefined {
    const path = this.journalPath;
    if (!path || this.item.kind !== "item") return undefined;
    const item = this.item.id;
    return withLock(path, () => {
      const text = exists(path) ? readText(path) : null;
      const at = this.now();
      const opened = openRun({ sc: this.sc, item, statechartFile: relative(this.o.root, this.workflowPath), journalText: text, source: "resume", now: at });
      if (!opened.ok) throw new Error(`gemflow: ${relative(this.o.root, path)}: ${opened.reason}`);
      const out: string[] = text === null ? [opened.head, ...opened.blocks] : [...opened.blocks];
      const before = text === null ? undefined : opened.run.snapshot.state;
      const sup = new Supervisor(this.sc, opened.run, {
        append: (b) => out.push(b),
        approve: this.o.approve ?? (async () => "denied"),
        now: () => this.now(),
        host: this.o.host,
        capabilities: this.o.capabilities,
      });
      const value = fn(sup);
      if (out.length) appendOrCreate(path, "", out.join(""));
      const after = sup.snapshot.state;
      const change: StageChange = { entered: [] };
      if (after !== before) {
        const ctx = buildStageContext(this.sc, sup.snapshot, (ref) => this.getBlock(ref, this.workflowDir, this.o.root));
        const doc = renderContextDoc(ctx, { at: this.now(), item });
        writeAtomic(join(this.o.root, CONTEXT_DOC), doc);
        change.context = ctx.text;
      }
      return { value, change };
    });
  }

  status(): Status {
    const base = {
      workflow: { name: this.workflowName, path: relative(this.o.root, this.workflowPath), title: this.title() },
      item: this.item,
      gh: this.ghStatus(),
    };
    const r = this.act((sup) => sup);
    if (!r) return { ...base, vars: {}, signals: [], next: [], refusals: 0, deviations: 0 };
    const sup = r.value;
    const snap = sup.snapshot;
    const state = this.sc.states.get(snap.state);
    return {
      ...base,
      ...(state ? { state: { id: state.id, strict: state.strict, rev: snap.rev } } : {}),
      vars: snap.vars,
      signals: this.sc.signals.map((s) => ({ id: s.id, on: s.on, sets: s.sets, label: s.match, value: snap.vars[s.sets] === true })),
      next: outgoing(this.sc, snap.state).map((t) => ({
        id: t.id, to: t.to, auto: t.auto, approval: t.approval,
        ...(t.requiresId ? { requires: t.requiresId } : {}),
        holds: t.requires ? validate(t.requires, snap.vars).length === 0 : true,
      })),
      refusals: sup.run.refusals,
      deviations: sup.run.deviations,
    };
  }

  /** Before a tool call: the reason to refuse it, or undefined. */
  before(tool: string, callId?: string, input?: Record<string, unknown>): string | undefined {
    return this.act((sup) => sup.deny(tool, callId, input))?.value;
  }

  /** After a tool call: signals, rollback-on-error, and what the stage became. */
  after(ev: AfterEvent): StageChange {
    const cap = capabilityOf(ev.tool, this.o.capabilities);
    const r = this.act((sup) => {
      const meta = metaFor(this.now(), ev.callId);
      sup.onToolResult({ name: ev.tool, callId: ev.callId ?? "", isError: ev.isError }, meta);
      const command = typeof ev.input?.["command"] === "string" ? (ev.input["command"] as string) : undefined;
      if (cap === "run" && command !== undefined && ev.exitCode !== undefined) sup.observeCommand({ command, exitCode: ev.exitCode }, meta);
      if (cap === "write") sup.applySignals(fileSignals(this.sc, (g) => globExists(this.o.root, g)), meta);
      if (cap === "run" && command !== undefined && /^\s*(git|gh)\s/.test(command)) sup.applySignals(gitSignals(this.sc, this.gitFacts()), meta);
    });
    return r?.change ?? { entered: [] };
  }

  /** Re-read git, gh and file facts (session start, board refresh). */
  refresh(): StageChange {
    const r = this.act((sup) => {
      const meta = metaFor(this.now());
      sup.applySignals([...gitSignals(this.sc, this.gitFacts()), ...fileSignals(this.sc, (g) => globExists(this.o.root, g))], meta);
    });
    return this.withEntered(r);
  }

  async verb(name: string, args: Record<string, unknown>, callId?: string): Promise<Invoked> {
    let pending: Promise<Invoked> | undefined;
    this.act((sup) => { pending = sup.invoke(name, args, metaFor(this.now(), callId)); });
    return pending ?? { ok: false, reason: this.item.kind === "inactive" ? this.item.reason : "no workflow" };
  }

  /** A person moves the workflow. */
  advance(to: string): ({ ok: true; entered: string[] } | { ok: false; reason: string }) & { context?: string } {
    const r = this.act((sup) => sup.humanTransition(to, metaFor(this.now())));
    if (!r) return { ok: false, reason: this.item.kind === "inactive" ? this.item.reason : "no workflow" };
    return { ...r.value, ...(r.change.context ? { context: r.change.context } : {}) };
  }

  /** A person ticks or clears a manual signal. */
  mark(id: string, checked: boolean): ({ ok: true; entered: string[] } | { ok: false; reason: string }) & { context?: string } {
    const r = this.act((sup) => sup.mark(id, checked, metaFor(this.now())));
    if (!r) return { ok: false, reason: this.item.kind === "inactive" ? this.item.reason : "no workflow" };
    const v = r.value;
    return v.ok ? { ok: true, entered: v.entered, ...(r.change.context ? { context: r.change.context } : {}) } : v;
  }

  /** The current stage text from .geml/context.geml. */
  context(): string | undefined {
    return this.readContext()?.text;
  }

  private withEntered(r: { value: void; change: StageChange } | undefined): StageChange {
    if (!r) return { entered: [] };
    return r.change;
  }

  private gitFacts() {
    const branch = this.repo.branch;
    const gh = branch ? (this.o.gh ?? realGh)(this.o.root, branch) : { available: false as const, reason: "not a git repository" };
    return { ...(this.repo.committed !== undefined ? { committed: this.repo.committed } : {}), ...(gh.available ? gh : {}) };
  }

  private ghStatus(): Status["gh"] {
    const branch = this.repo.branch;
    if (!branch) return { available: false, reason: "not a git repository" };
    const g = (this.o.gh ?? realGh)(this.o.root, branch);
    return g.available ? { available: true } : { available: false, reason: g.reason };
  }

  private title(): string {
    const meta = parse(readText(this.workflowPath)).children.find((b) => b.kind === "block" && b.type === "meta");
    const t = meta && meta.kind === "block" && meta.data ? meta.data["title"] : undefined;
    return typeof t === "string" ? t : this.workflowName;
  }
}
```

Two corrections the code above needs, both deliberate so you read it rather than paste it:
1. `StageChange.entered` must list the states entered. Have `act` capture `sup.snapshot.state` before `fn` runs and collect, after it, every `flow-snapshot` block in `out` whose `cause` is `transition` (parse the `state=#…` attribute from each appended block string with `/cause=transition/` and `/state=#([^ }]+)/`), in order. Use that list as `change.entered`, and set `context` when it is non-empty or the journal was new.
2. `gitFacts()` passes the gh facts object including its `available` key into `gitSignals`; strip it: build `{ prOpen, prMerged, ci }` from `gh` when `gh.available`.

Then make the six tests pass. Keep `status()` read-only in effect: it takes the lock and appends nothing unless the journal is new.

- [ ] **Step 5: Watch it pass, then the whole suite**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a3.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a3.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/src/workspace.ts integrations/gemflow/src/core/capabilities.ts integrations/gemflow/test/workspace.test.mjs integrations/gemflow/test/fixtures/ws-dev
git commit -m "feat(gemflow): the workspace — one locked operation at a time against a project

Resolves the active workflow (GEMFLOW_STATECHART, .geml/gemflow.geml, or the
only workflow), the work item, and its journal; every operation reads the
journal fresh under its lock, acts through the Supervisor, appends, and
rewrites .geml/context.geml when the stage changed. status() is what UIs
draw; before/after feed tool calls in; refresh re-reads git, gh and files."
```

---

### Task 11: The CLI — `init`, `use`, `status`, `mark`, `unmark`, `advance`

**Files:** Modify `integrations/gemflow/src/cli.ts`, `test/cli.test.mjs`; move `integrations/gemflow/examples/coding/agent.geml` → `integrations/gemflow/workflows/coding/flow.geml` and `examples/refund/agent.geml` → `workflows/refund/flow.geml`; modify `package.json` `files` (add `"workflows"`), `examples/walkthrough.mjs` (new path).

- [ ] **Step 1: Move the bundled workflows**

```bash
git mv integrations/gemflow/examples/coding/agent.geml integrations/gemflow/workflows/coding/flow.geml
git mv integrations/gemflow/examples/refund/agent.geml integrations/gemflow/workflows/refund/flow.geml
```

Update every reference (`git grep -n "examples/coding/agent.geml\|examples/refund/agent.geml\|examples/\${template}" -- integrations/gemflow`), including `examples/walkthrough.mjs` and `package.json` `files` (add `"workflows"`).

- [ ] **Step 2: Failing tests**

Append to `integrations/gemflow/test/cli.test.mjs` (it has a `run(args, opts)` helper that spawns `dist/cli.js`; if it does not accept a `cwd`, extend it to pass `{ cwd }` to `spawnSync`):

```js
import { mkdtempSync as mkd, readFileSync as rf, existsSync as ex } from "node:fs";
import { tmpdir as td } from "node:os";
import { join as jn } from "node:path";
import { spawnSync as sp } from "node:child_process";

function repo() {
  const d = mkd(jn(td(), "gemflow-cli-"));
  const git = (...a) => sp("git", ["-C", d, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "init"); git("checkout", "-qb", "feat/x");
  return d;
}

test("init copies a workflow, records it as active, and ignores journals and context", () => {
  const d = repo();
  const r = run(["init", "--template", "coding"], { cwd: d });
  assert.equal(r.status, 0, r.err);
  assert.ok(ex(jn(d, ".geml", "workflows", "coding", "flow.geml")));
  assert.match(rf(jn(d, ".geml", "gemflow.geml"), "utf8"), /flow-workflow = "coding"/);
  assert.equal(rf(jn(d, ".geml", ".gitignore"), "utf8"), "journals/\ncontext.geml\n*.lock\n");
  assert.equal(run(["init", "--template", "coding"], { cwd: d }).status, 1, "refuses to overwrite");
});

test("status prints the stage; --json prints the workspace status", () => {
  const d = repo();
  run(["init", "--template", "coding"], { cwd: d });
  const s = run(["status", "--json"], { cwd: d });
  assert.equal(s.status, 0, s.err);
  const j = JSON.parse(s.out);
  assert.deepEqual(j.item, { kind: "item", id: "feat/x" });
  assert.equal(j.state.id, "explore");
  assert.match(run(["status"], { cwd: d }).out, /feat\/x · #explore/);
});

test("advance moves the workflow as a person; mark refuses a signal that is not manual", () => {
  const d = repo();
  run(["init", "--template", "refund"], { cwd: d });
  const a = run(["advance", "nowhere"], { cwd: d });
  assert.equal(a.status, 1);
  assert.match(a.err, /no transition from/);
  const m = run(["mark", "nope"], { cwd: d });
  assert.equal(m.status, 1);
  assert.match(m.err, /no signal "nope"/);
});

test("use switches the active workflow", () => {
  const d = repo();
  run(["init", "--template", "coding"], { cwd: d });
  run(["init", "--template", "refund", "--no-activate"], { cwd: d });
  assert.equal(run(["use", "refund"], { cwd: d }).status, 0);
  assert.match(rf(jn(d, ".geml", "gemflow.geml"), "utf8"), /flow-workflow = "refund"/);
  assert.equal(run(["use", "nope"], { cwd: d }).status, 1);
});
```

(If the existing `init` tests in the file assert the old `.geml/agent.geml` target, change them to the new layout as part of this task.)

- [ ] **Step 3: Watch them fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/cli.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: non-zero `ℹ fail`.

- [ ] **Step 4: Implement the verbs**

In `src/cli.ts`:
- USAGE gains (aligned with the existing rows):
  ```
  "  init [dir] [--template coding|refund] [--no-activate]  copy a bundled workflow into .geml/workflows/",
  "  use <workflow>                         make a workflow the active one",
  "  status [--json]                        the work item, the stage, its signals and next steps",
  "  mark <signal> | unmark <signal>        a person sets or clears a manual signal",
  "  advance <state>                        a person moves the workflow",
  ```
  and `check` keeps its line; `run`, `snapshot`, `verify`, `export` stay.
- `init`: template names come from the directories under the package's `workflows/` (read with `readdirSync(fileURLToPath(new URL("../workflows/", import.meta.url)))`); copy the chosen directory recursively to `<dir>/.geml/workflows/<name>/` (refuse with exit 1 if it exists); unless `--no-activate`, write `<dir>/.geml/gemflow.geml`:
  ```
  === meta
  title         = "Gemflow"
  profile       = "geml-flow/v1"
  flow-workflow = "<name>"
  ===
  ```
  and create `<dir>/.geml/.gitignore` containing `journals/\ncontext.geml\n*.lock\n` if absent. Print `wrote .geml/workflows/<name>/ (active)` or without `(active)`.
- `use <name>`: refuse with exit 1 if `.geml/workflows/<name>/flow.geml` does not exist; else rewrite `.geml/gemflow.geml` as above.
- `status`, `mark`, `unmark`, `advance` open `openWorkspace({ root: process.cwd(), host: "cli", capabilities: NO_CAPABILITIES })`; on `!ok` print the reason and exit 1. `status --json` prints `JSON.stringify(ws.status())`; plain `status` prints one line `<item id> · #<state>` (or the inactive reason), then one line per signal `  <id> (<on>): <yes|no>` and one per next edge `  → #<to>  <auto|by hand>  <guard holds|guard does not hold>`. `mark`/`unmark` call `ws.mark(id, true|false)`; `advance` calls `ws.advance(to)`; on `ok: false` print the reason to stderr, exit 1; on success print the entered states and exit 0.
- `run` (dsh launcher): its "no statechart here" warning now checks `resolveWorkflow(process.cwd())` and prints its error.

- [ ] **Step 5: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a3.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a3.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/src/cli.ts integrations/gemflow/test/cli.test.mjs integrations/gemflow/workflows integrations/gemflow/examples integrations/gemflow/package.json
git commit -m "feat(gemflow): init, use, status, mark, unmark and advance; bundled workflows are directories"
```

---

### Task 12: The dsh and pi adapters follow

**Files:** `integrations/gemflow/src/hosts/dsh/plugin.ts`, `src/hosts/pi/extension.ts`, `src/core/layout.ts` (drop the temporary `DEFAULT_STATECHART`), their tests and helpers, `cordis.patch.yml`.

- [ ] **Step 1: Resolve the workflow like everyone else**

Replace each adapter's use of `DEFAULT_STATECHART` with `resolveWorkflow(cwd)` from `../../workspace.js` (dsh: honour its `statechart` config option first when set, as the env variable is honoured in pi). An unresolved workflow leaves the session unsupervised with the same notice the adapters print today for a missing statechart, now carrying `resolveWorkflow`'s error text. Remove `DEFAULT_STATECHART` from `src/core/layout.ts`. In `cordis.patch.yml`, the `statechart` default comment points at `.geml/workflows/<name>/flow.geml`.

- [ ] **Step 2: Pass tool input to gate 3**

dsh: `agent.ctx.tools.guard((exec) => sup.deny(exec.name, exec.callId, exec.arguments as Record<string, unknown>))`. pi: in the `tool_call` handler, `sup.deny(event.toolName, event.toolCallId, event.input as Record<string, unknown>)` (use the field the handler already reads for input; check with `grep -n "event\.\(input\|args\|arguments\)" src/hosts/pi/extension.ts`).

- [ ] **Step 3: Update the tests**

Tests that write `.geml/agent.geml` into a temp project write `.geml/workflows/refund/flow.geml` (or set `GEMFLOW_STATECHART`, as they already may). Expectations follow Task 4's semantics (strict refund states: unchanged gating; one `flow-refused` per denied call).

- [ ] **Step 4: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a3.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a3.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`. Also `npm run walkthrough` exits 0.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src integrations/gemflow/test integrations/gemflow/cordis.patch.yml
git commit -m "refactor(gemflow): the dsh and pi adapters resolve the workflow like the CLI and pass tool input to gate 3"
```

---

### Task 13: Documentation follows the runtime

**Files:** `spec/profiles/geml-flow/geml-flow-profile.md`, `_CN.md`, `integrations/gemflow/README.md`, `README.zh.md`

- [ ] **Step 1: Profile**

In both profile documents add a short section "Runtime semantics" (EN) / 「运行时语义」 (CN) after the journal section, stating as rules: advisory by default, strict states enforce, `only-in` and person-only refusals hold in every state, refusals are journal records, deviations once per tool per stage entry, signals write booleans, auto edges chain and record the actor of the change that made them hold, approval edges never auto-advance, the context document's shape, the project config document. Add `flow-context` to the blocks table and the five new meta keys to the meta keys table (Task 1 added them to the registry).

- [ ] **Step 2: README**

In both READMEs: the CLI usage block shows the new verbs (copy `USAGE` from `src/cli.ts` exactly); a "Project layout" subsection shows `.geml/workflows/<name>/flow.geml`, `.geml/gemflow.geml`, `.geml/journals/`, `.geml/context.geml`, `.geml/backlog.geml`; the statechart example uses the coding workflow's current text; remove `.geml/agent.geml` everywhere.

- [ ] **Step 3: Check and run**

Run:
```bash
for f in spec/profiles/geml-flow/geml-flow-profile.md spec/profiles/geml-flow/geml-flow-profile_CN.md integrations/gemflow/README.md integrations/gemflow/README.zh.md; do node geml-parser/dist/geml.js check --root . "$f" >/dev/null 2>&1; echo "$f $?"; done
cd integrations/gemflow && npm test > /tmp/gemflow-a3.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a3.log; cd ../..
```
Expected: four `0`s; `exit=0`, `ℹ fail 0`.

- [ ] **Step 4: Commit**

```bash
git add spec/profiles/geml-flow/geml-flow-profile.md spec/profiles/geml-flow/geml-flow-profile_CN.md integrations/gemflow/README.md integrations/gemflow/README.zh.md
git commit -m "docs(gemflow): runtime semantics in the profile; the README shows the new verbs and the project layout"
```

---

## Done when

- Thirteen commits on the branch, nothing pushed.
- `cd integrations/gemflow && npm test` passes; parser and Rust suites pass.
- In a scratch git repository on a feature branch: `gemflow init --template coding && gemflow status` prints the item and `#explore`; `.geml/context.geml` holds a `flow-context` block for `#explore`.
