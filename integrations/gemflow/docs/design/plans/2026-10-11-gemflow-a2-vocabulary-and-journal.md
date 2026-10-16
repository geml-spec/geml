# Gemflow A2 — Vocabulary, Static Checks and Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `geml-flow/v1` its full vocabulary — portable tool capabilities, the signals table, `unit`, `context`, `strict`, `auto`, the snapshot's `by`/`signal`, the `flow-deviation` journal block — with every static check of spec §4.4 implemented and pinned, and the profile document rewritten to match.

**Architecture:** Everything lands in the pure core (`integrations/gemflow/src/core/`) plus the parser's vocabulary table. Behaviour that *uses* the new fields (strict gating, signal evaluation, auto-advance, Stagehand) is plan A3; here the supervisor changes only in one place — it expands capability names into the host's tool names, so the existing gates keep working on the new spelling. Static checks are pinned twice: unit tests next to the code, and a table-driven conformance file in the profile directory that a runtime test replays.

**Tech Stack:** TypeScript (tsc), Node ≥ 22, `node:test` (runtime package), the parser's custom test files run directly with `node`.

**Spec:** `docs/design/specs/2026-10-11-gemflow-design.md` §4.1, §4.3, §4.4, §5.3 (capability names), §5.5 (journal checks), §12 (host tool names).

**Depends on:** plan A1 (names: `integrations/gemflow`, `geml-flow/v1`, `flow-*` blocks, `flow_*` verbs, `journal.ts`, `readJournal`, `verifyJournal`, `FlowDiagnostic`, `FlowCode`).

**Working directory:** `/Users/xiong/software/geml`, branch `feat/geml-agent-runtime`, in place. Never switch branches, never stash, never push. A project hook in older sessions rewrites `playground/codemap/` after Bash calls; never `git add` anything under it — stage by explicit path, never `git add -A` or `git add .`.

**Conventions:** English commit messages, no attribution trailers, no version bumps. Run an expensive suite once and take output and exit code from that run. The runtime suite: `cd integrations/gemflow && npm test` (it runs `tsc` first). One test file: `cd integrations/gemflow && npx tsc && node --test test/<file>.test.mjs`.

---

## File map

| Path | Responsibility | Task |
|---|---|---|
| `geml-parser/src/profiles.ts` | admit the new keys and `flow-deviation` | 1 |
| `geml-parser/test/profiles.test.mjs` | pin them | 1 |
| `spec/profiles/geml-flow/conformance.json` | parser-level case for `flow-deviation` | 1 |
| `geml-parser-rs/src/vocab.rs` | the Rust registry mirrors every vocabulary change | 1 |
| `integrations/gemflow/src/core/capabilities.ts` (new) | capability names, host maps, expansion | 2 |
| `integrations/gemflow/test/capabilities.test.mjs` (new) | | 2 |
| `integrations/gemflow/src/core/statechart.ts` | tool-name checks; signals, unit, context, strict, auto, budget | 3, 4 |
| `integrations/gemflow/src/core/supervisor.ts` | `SupervisorHost.host` + `.capabilities`; gates expand names | 3 |
| `integrations/gemflow/src/core/prompt.ts` | `visibleTools` takes host + map | 3 |
| `integrations/gemflow/src/hosts/dsh/plugin.ts`, `src/hosts/pi/extension.ts` | pass host name and map | 3 |
| `integrations/gemflow/src/cli.ts` | `check --host`; info diagnostics | 3 |
| `integrations/gemflow/test/fixtures/refund.geml`, `examples/refund/agent.geml`, `examples/coding/agent.geml` | capability spelling | 3 |
| `integrations/gemflow/test/*.test.mjs`, `test/helpers/*.mjs` | follow the spelling | 3 |
| `integrations/gemflow/src/core/snapshot.ts` | `by`, `signal`, `applySignal` | 5 |
| `integrations/gemflow/src/core/journal.ts` | render/read/verify `by`, `signal`, `flow-deviation` | 5 |
| `integrations/gemflow/src/core/run.ts` | `signal()`, `deviate()` | 5 |
| `spec/profiles/geml-flow/checks.json` (new) | table of statecharts → expected codes | 4 |
| `integrations/gemflow/test/checks-conformance.test.mjs` (new) | replays it | 4 |
| `spec/profiles/geml-flow/geml-flow-profile.md`, `_CN.md` | rewritten to the vocabulary | 6 |
| `docs/design/specs/2026-10-11-gemflow-design.md` | §4.4 gains `flow-context-budget` | 4 |

---

### Task 1: The parser admits the new keys and `flow-deviation`

**Files:**
- Modify: `geml-parser/src/profiles.ts` (the `"geml-flow/v1"` entry)
- Test: `geml-parser/test/profiles.test.mjs`
- Modify: `spec/profiles/geml-flow/conformance.json`

- [ ] **Step 1: Add the failing test**

Append to `geml-parser/test/profiles.test.mjs`, directly after the test named `geml-flow/v1：放行的属性键只挂在各自类型上` (before the final `console.log`):

```js
test("geml-flow/v1：context / strict / auto / by / signal 与 flow-deviation", () => {
  const v = vocabularyFor(meta({ profile: "geml-flow/v1" }));
  assert.equal(v.attrs.get("flow-state")?.has("context"), true);
  assert.equal(v.attrs.get("flow-state")?.has("strict"), true);
  assert.equal(v.attrs.get("flow-transition")?.has("auto"), true);
  assert.equal(v.attrs.get("flow-snapshot")?.has("by"), true);
  assert.equal(v.attrs.get("flow-snapshot")?.has("signal"), true);
  assert.equal(v.types.has("flow-deviation"), true);
  for (const k of ["rev", "at", "tool", "call", "state"]) assert.equal(v.attrs.get("flow-deviation")?.has(k), true, k);
  const src = '=== meta\nprofile = "geml-flow/v1"\n===\n\n'
    + '=== flow-state {#a initial strict context="docs/x.md#y"}\nGo.\n===\n\n'
    + '=== flow-transition {#t from=#a to=#a auto requires=#g}\nAgain.\n===\n\n'
    + '=== data {#g format=json}\n{"type":"object"}\n===\n\n'
    + '=== flow-snapshot {#rev-1 rev=1 state=#a cause=patch by=signal signal=tests parent="sha256:00" hash="sha256:01" at="2026-01-01T00:00:00Z"}\n{}\n===\n\n'
    + '=== flow-deviation {#deviation-1 rev=1 at="2026-01-01T00:00:00Z" tool=Edit call=c1 state=#a}\n{"capability":"write"}\n===\n';
  assert.deepEqual(parse(src).diagnostics, [], "declared: every new key and block is admitted");
  const dev = parse(src).children.find((b) => b.kind === "block" && b.type === "flow-deviation");
  assert.equal(dev.mode, "raw");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd geml-parser && npm run build >/dev/null && node test/profiles.test.mjs 2>&1 | tail -4; cd ..`
Expected: assertion failure at `v.attrs.get("flow-state")?.has("context")`.

- [ ] **Step 3: Extend the vocabulary entry**

In `geml-parser/src/profiles.ts`, inside the `"geml-flow/v1"` entry, replace the `types`, `bodies` and `attrs` lines with:

```ts
    types: ["flow-vars", "flow-state", "flow-transition", "flow-snapshot", "flow-refused", "flow-deviation"],
    bodies: { "flow-state": "flow", "flow-transition": "flow" },
    attrs: {
      "flow-state": ["initial", "final", "pause", "tools", "vars", "rollback-on-error", "context", "strict"],
      "flow-transition": ["from", "to", "requires", "approval", "auto"],
      "flow-snapshot": ["rev", "state", "cause", "parent", "hash", "at", "call", "from", "restores", "by", "signal"],
      "flow-refused": ["rev", "at", "tool", "call"],
      "flow-deviation": ["rev", "at", "tool", "call", "state"],
    },
    metaKeys: ["flow-tools", "flow-signals", "flow-unit", "flow-context-budget"],
```

The meta keys carry the vocabulary's prefix: spec/profiles/README's Naming section requires every `=== meta` key a vocabulary reads to start with `flow-`, and `metaKeys` is what lets `unknown-meta-key` catch a misspelled one. Add to the Step 1 test, before its closing `});`:

```js
  assert.deepEqual(PROFILES["geml-flow/v1"].metaKeys, ["flow-tools", "flow-signals", "flow-unit", "flow-context-budget"]);
  const typo = parse('=== meta\nprofile = "geml-flow/v1"\nflow-signal = "#s"\n===\n').diagnostics.map((d) => d.code);
  assert.ok(typo.includes("unknown-meta-key"), "a misspelled flow- meta key is reported");
```

(`PROFILES` is already imported by the test file; `unknown-meta-key` is the parser's warning for a prefixed meta key the vocabulary does not declare, `geml-parser/src/geml.ts`.)

- [ ] **Step 4: Run it and watch it pass**

Run: `cd geml-parser && npm run build >/dev/null && node test/profiles.test.mjs 2>&1 | tail -1; cd ..`
Expected: `<N> passed`.

- [ ] **Step 4b: Mirror the entry in the Rust parser**

In `geml-parser-rs/src/vocab.rs`, the `geml-flow/v1` `Profile` (last in `PROFILES`, added in plan A1) gets the same changes: the type `("flow-deviation", Raw)`; `"context"`, `"strict"` on `flow-state`; `"auto"` on `flow-transition`; `"by"`, `"signal"` on `flow-snapshot`; `("flow-deviation", &["rev", "at", "tool", "call", "state"])`; and `meta_keys: Some(&["flow-tools", "flow-signals", "flow-unit", "flow-context-budget"])`. Run `cd geml-parser-rs && cargo test --quiet 2>&1 | tail -5; cd ..` after Step 5 adds the conformance case — it replays every profile's `conformance.json`, so both parsers must agree on the new case.

- [ ] **Step 5: Add a parser-level conformance case**

`spec/profiles/geml-flow/conformance.json` uses the repository's current fixture schema (read its two existing cases first): each case has `name`, `geml`, `diagnostics` (`declared` / `undeclared`, each a list of `code:severity`) and `addresses` (`declared` / `undeclared`, `#`-only, prose runs included). Append one case to `cases`:

```json
    {
      "name": "the journal's deviation block keeps a raw body, and the snapshot's by= and signal= are admitted",
      "geml": "=== meta\nprofile = \"geml-flow/v1\"\n===\n\n=== flow-deviation {#deviation-1 rev=1 at=\"2026-01-01T00:00:00Z\" tool=Edit state=#a}\n{\"capability\":\"write\"}\n===\n\n=== flow-snapshot {#rev-1 rev=1 state=#a cause=patch by=signal signal=tests parent=\"sha256:00\" hash=\"sha256:01\" at=\"2026-01-01T00:00:00Z\"}\n{}\n===\n",
      "diagnostics": {
        "declared": [],
        "undeclared": ["unknown-block-type:warning", "unknown-block-type:warning"]
      },
      "addresses": {
        "declared": ["#meta", "#deviation-1", "#rev-1"],
        "undeclared": ["#meta", "#deviation-1", "#rev-1"]
      }
    }
```

The expected values follow the two existing cases' pattern (declared: nothing; undeclared: one `unknown-block-type` per `flow-*` block; raw bodies add no prose-run addresses). If `profile-conformance` disagrees, compute the values with that test's own helpers, check them by hand against this reasoning, and use them.

- [ ] **Step 6: Run the parser suite once**

Run: `cd geml-parser && node test/all.mjs > /tmp/gemflow-a2.log 2>&1; echo "exit=$?"; tail -1 /tmp/gemflow-a2.log; cd ..`
Expected: `exit=0`. If `profile-conformance` fails on the new case, its message names the field that differs; fix the case, not the runner.

- [ ] **Step 7: Commit**

```bash
git add geml-parser/src/profiles.ts geml-parser/test/profiles.test.mjs spec/profiles/geml-flow/conformance.json geml-parser-rs/src/vocab.rs
git commit -m "feat(profiles): geml-flow/v1 admits context, strict, auto, by, signal and flow-deviation, and declares its flow- meta keys"
```

---

### Task 2: Capability names

**Files:**
- Create: `integrations/gemflow/src/core/capabilities.ts`
- Create: `integrations/gemflow/test/capabilities.test.mjs`
- Modify: `integrations/gemflow/src/index.ts` (export it)

The host tool names in the maps are measured: Claude Code from its tool list, pi agent from its built-ins (`read edit write bash grep find ls`), DeepSeek Harness 0.1.5-rc.2 from its tool packages (`dsh-tool-fs`: read, read_image, write, edit; `dsh-tool-str-replace-editor`: str_replace_editor; `dsh-tool-bash`: bash; `dsh-tool-pwsh`: pwsh; `dsh-tool-fs-search`: grep, glob; `dsh-tool-web`: web_fetch, web_search).

- [ ] **Step 1: Write the failing test**

Create `integrations/gemflow/test/capabilities.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES, isCapability, parseToolName, hostTools, capabilityOf,
  CLAUDE_CODE_CAPABILITIES, PI_CAPABILITIES, DSH_CAPABILITIES,
} from "../dist/core/capabilities.js";

test("the five capabilities, in a fixed order", () => {
  assert.deepEqual([...CAPABILITIES], ["read", "write", "run", "search", "web"]);
  assert.equal(isCapability("run"), true);
  assert.equal(isCapability("bash"), false);
});

test("parseToolName: capability, host tool, or nothing", () => {
  assert.deepEqual(parseToolName("write"), { kind: "capability", capability: "write" });
  assert.deepEqual(parseToolName("claude:WebFetch"), { kind: "host", host: "claude", tool: "WebFetch" });
  assert.deepEqual(parseToolName("dsh:pay_refund"), { kind: "host", host: "dsh", tool: "pay_refund" });
  assert.equal(parseToolName("pay_refund"), undefined, "a bare non-capability name is not portable");
  assert.equal(parseToolName("Claude:Bash"), undefined, "host names are lower case");
  assert.equal(parseToolName("claude:"), undefined);
});

test("hostTools expands in order, drops other hosts, never repeats", () => {
  assert.deepEqual(hostTools(["read", "search"], "pi", PI_CAPABILITIES), ["read", "grep", "find", "ls"]);
  assert.deepEqual(hostTools(["write", "run"], "claude", CLAUDE_CODE_CAPABILITIES), ["Edit", "Write", "NotebookEdit", "Bash"]);
  assert.deepEqual(hostTools(["dsh:pay_refund", "pi:pay_refund"], "pi", PI_CAPABILITIES), ["pay_refund"]);
  assert.deepEqual(hostTools(["web"], "pi", PI_CAPABILITIES), [], "pi agent has no web tools");
  assert.deepEqual(hostTools(["read", "read"], "dsh", DSH_CAPABILITIES), ["read", "read_image"]);
  assert.deepEqual(hostTools(["nonsense"], "pi", PI_CAPABILITIES), [], "unknown names contribute nothing");
});

test("capabilityOf maps a host tool back", () => {
  assert.equal(capabilityOf("Bash", CLAUDE_CODE_CAPABILITIES), "run");
  assert.equal(capabilityOf("str_replace_editor", DSH_CAPABILITIES), "write");
  assert.equal(capabilityOf("TodoWrite", CLAUDE_CODE_CAPABILITIES), undefined);
});

test("the three measured maps", () => {
  assert.deepEqual(CLAUDE_CODE_CAPABILITIES, {
    read: ["Read"], write: ["Edit", "Write", "NotebookEdit"], run: ["Bash"], search: ["Grep", "Glob"], web: ["WebFetch", "WebSearch"],
  });
  assert.deepEqual(PI_CAPABILITIES, {
    read: ["read"], write: ["edit", "write"], run: ["bash"], search: ["grep", "find", "ls"], web: [],
  });
  assert.deepEqual(DSH_CAPABILITIES, {
    read: ["read", "read_image"], write: ["write", "edit", "str_replace_editor"], run: ["bash", "pwsh"],
    search: ["grep", "glob"], web: ["web_fetch", "web_search"],
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/capabilities.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/core/capabilities.js`.

- [ ] **Step 3: Write the module**

Create `integrations/gemflow/src/core/capabilities.ts`:

```ts
// Portable tool names. A workflow says what a state may do — read, write,
// run, search, web — and each host adapter says which of its own tools that
// is. A tool only one host has is written `<host>:<tool>` and is simply absent
// on every other host. Pure: no host is imported here.
export const CAPABILITIES = ["read", "write", "run", "search", "web"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityMap = Readonly<Record<Capability, readonly string[]>>;

export type ToolName =
  | { kind: "capability"; capability: Capability }
  | { kind: "host"; host: string; tool: string };

const HOST_TOOL = /^([a-z][a-z0-9-]*):(.+)$/;

export function isCapability(name: string): name is Capability {
  return (CAPABILITIES as readonly string[]).includes(name);
}

/** "read" → a capability; "claude:WebFetch" → one host's tool; anything else → undefined. */
export function parseToolName(name: string): ToolName | undefined {
  if (isCapability(name)) return { kind: "capability", capability: name };
  const m = name.match(HOST_TOOL);
  return m ? { kind: "host", host: m[1]!, tool: m[2]! } : undefined;
}

/** The host's own tool names for a list of workflow tool names: in order, each once. */
export function hostTools(names: readonly string[], host: string, map: CapabilityMap): string[] {
  const out: string[] = [];
  for (const name of names) {
    const t = parseToolName(name);
    if (t === undefined) continue;
    const add = t.kind === "capability" ? map[t.capability] : t.host === host ? [t.tool] : [];
    for (const tool of add) if (!out.includes(tool)) out.push(tool);
  }
  return out;
}

/** The capability a host tool belongs to, or undefined for a tool outside all five. */
export function capabilityOf(tool: string, map: CapabilityMap): Capability | undefined {
  return CAPABILITIES.find((c) => map[c].includes(tool));
}

export const CLAUDE_CODE_CAPABILITIES: CapabilityMap = {
  read: ["Read"], write: ["Edit", "Write", "NotebookEdit"], run: ["Bash"], search: ["Grep", "Glob"], web: ["WebFetch", "WebSearch"],
};

export const PI_CAPABILITIES: CapabilityMap = {
  read: ["read"], write: ["edit", "write"], run: ["bash"], search: ["grep", "find", "ls"], web: [],
};

export const DSH_CAPABILITIES: CapabilityMap = {
  read: ["read", "read_image"], write: ["write", "edit", "str_replace_editor"], run: ["bash", "pwsh"],
  search: ["grep", "glob"], web: ["web_fetch", "web_search"],
};
```

In `integrations/gemflow/src/index.ts`, add after the `export * from "./core/schema.js";` line:

```ts
export * from "./core/capabilities.js";
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd integrations/gemflow && npx tsc && node --test test/capabilities.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Confirm the module is pure**

Run: `cd integrations/gemflow && node --test test/purity.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 0` (the purity test scans `dist/core/` for file-system imports).

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/src/core/capabilities.ts integrations/gemflow/src/index.ts integrations/gemflow/test/capabilities.test.mjs
git commit -m "feat(gemflow): portable tool capabilities and the three measured host maps"
```

---

### Task 3: Workflows name capabilities; the gates expand them

**Files:**
- Modify: `integrations/gemflow/src/core/statechart.ts`
- Modify: `integrations/gemflow/src/core/supervisor.ts`
- Modify: `integrations/gemflow/src/core/prompt.ts`
- Modify: `integrations/gemflow/src/hosts/dsh/plugin.ts`, `integrations/gemflow/src/hosts/pi/extension.ts`
- Modify: `integrations/gemflow/src/cli.ts`
- Modify: `integrations/gemflow/test/fixtures/refund.geml`, `integrations/gemflow/examples/refund/agent.geml`, `integrations/gemflow/examples/coding/agent.geml`
- Modify: `integrations/gemflow/test/{statechart,supervisor,prompt,plugin,pi,cli}.test.mjs`, `integrations/gemflow/test/helpers/{harness,pi}.mjs`

Rule of the change: in workflow text, `tools=` and meta `flow-tools` (renamed from the unprefixed `tools`, per the profile naming rule) hold capability names or `<host>:<tool>`; anything else is error `flow-tools-capability`; a host-prefixed name is info `flow-tools-host`. Test worlds register the hosts' real names (`read`, `grep`) plus the domain tool `pay_refund`, which workflows name as `dsh:pay_refund pi:pay_refund`.

- [ ] **Step 1: Convert the fixtures and examples**

Edit `integrations/gemflow/test/fixtures/refund.geml` and `integrations/gemflow/examples/refund/agent.geml` identically:
- the meta line `tools   = "read_file grep"` → `flow-tools = "read search"`
- the state line `=== flow-state {#pay tools="pay_refund" vars=none rollback-on-error}` → `=== flow-state {#pay tools="dsh:pay_refund pi:pay_refund" vars=none rollback-on-error}`

Edit `integrations/gemflow/examples/coding/agent.geml`:
- meta `tools   = "read grep find ls"` → `flow-tools = "read search"`
- `=== flow-state {#implement tools="read edit write grep ls" vars=none}` → `=== flow-state {#implement tools="read write search" vars=none}`
- `=== flow-state {#verify tools="read bash grep" vars="tests-pass touched"}` → `=== flow-state {#verify tools="read run search" vars="tests-pass touched"}`
- the `%%` comment paragraph that begins `The tool names are pi agent's built-ins.` → replace that paragraph with:
  ```
  %% The tools are capabilities — read, write, run, search, web — so the same
  %% statechart runs on every host; each host's adapter knows its own tool names.
  ```

- [ ] **Step 2: Update the test worlds and expectations**

Apply exactly these edits:

1. `test/helpers/harness.mjs` and `test/helpers/pi.mjs`: the default tool list `["read_file", "grep", "pay_refund"]` → `["read", "grep", "pay_refund"]`.
2. In `test/plugin.test.mjs`, `test/pi.test.mjs`, `test/supervisor.test.mjs`: replace every string literal `"read_file"` with `"read"`. Sorted lists stay sorted (`"grep"` < `"read"`), so no reordering is needed.
3. `test/supervisor.test.mjs`: `GLOBALS` becomes `["read", "grep", "pay_refund"]`; import `PI_CAPABILITIES` from `../dist/core/capabilities.js`; in the `host()` helper's `port` object add `host: "pi", capabilities: PI_CAPABILITIES,`. The comment `// #intake inherits the document default, tools = "read_file grep".` → `// #intake inherits the document default, tools = "read search" (pi: read, grep, find, ls).`
4. `test/statechart.test.mjs`, the first test (`the refund statechart loads clean…`):
   - `assert.deepEqual(r.diagnostics, []);` →
     ```js
     assert.deepEqual(r.diagnostics.filter((d) => d.severity !== "info"), []);
     assert.deepEqual(r.diagnostics.map((d) => d.code), ["flow-tools-host", "flow-tools-host"], "#pay names two host-only tools");
     ```
   - `assert.deepEqual(sc.states.get("pay").tools, ["pay_refund"]);` → `assert.deepEqual(sc.states.get("pay").tools, ["dsh:pay_refund", "pi:pay_refund"]);`
   - `assert.deepEqual(sc.defaultTools, ["read_file", "grep"]);` → `assert.deepEqual(sc.defaultTools, ["read", "search"]);`
   In the second test: `["read_file", "grep"]` → `["read", "search"]` and `["pay_refund"]` → `["dsh:pay_refund", "pi:pay_refund"]`.
   In the test `warnings: unreachable, dead-end, unknown tool (only with knownTools)`: replace its body with
   ```js
   const src = HEAD + "=== flow-state {#a initial tools=\"run pi:jq\"}\nx\n===\n=== flow-state {#b final}\nx\n===\n=== flow-state {#c}\nx\n===\n";
   const plain = loadStatechart(src, "t");
   assert.deepEqual(codes(plain).filter((c) => !c.startsWith("info:")), ["warning:flow-unreachable", "warning:flow-dead-end"]);
   const withTools = loadStatechart(src, "t", { knownTools: ["bash"], host: "pi" });
   assert.ok(codes(withTools).includes("warning:flow-unknown-tool"), "pi:jq is not registered on pi");
   const otherHost = loadStatechart(src, "t", { knownTools: ["bash"], host: "dsh" });
   assert.ok(!codes(otherHost).includes("warning:flow-unknown-tool"), "a pi-only tool is not checked on dsh");
   ```
   (Keep the test's name; if the original test used a different state layout, keep its states and change only the `tools=` value and the assertions as above.)
5. `test/prompt.test.mjs`: `tools here: read_file grep` → `tools here: read search`; `tools here: pay_refund` → `tools here: dsh:pay_refund pi:pay_refund`; every `visibleTools(sc, state, names)` call gains two arguments `"pi", PI_CAPABILITIES` (import it from `../dist/core/capabilities.js`), and its expected `names` are the expanded pi names intersected with the given globals, e.g. `visibleTools(sc, sc.states.get("intake"), ["grep", "bash", "read"], "pi", PI_CAPABILITIES)` → `{ kind: "allow", names: ["read", "grep"] }`.
6. `test/cli.test.mjs`: the call `run(["check", FIX, "--tools", "read_file,grep"])` → `run(["check", FIX, "--host", "pi", "--tools", "read,grep"])`, and its expected warning → `/warning: flow-unknown-tool: state #pay: tool "pi:pay_refund" is not registered/`. Any assertion that the refund check prints `ok: no diagnostics` → `/ok: no errors or warnings \(2 info\)/`.

- [ ] **Step 3: Run the suite and watch it fail**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a2.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a2.log; cd ../..`
Expected: `exit=1` with failures in statechart, supervisor, prompt, plugin, pi and cli tests (the source still treats tool names literally).

- [ ] **Step 4: Change the statechart loader**

In `integrations/gemflow/src/core/statechart.ts`:

Add the import: `import { parseToolName } from "./capabilities.js";`

Widen the diagnostic and code types:

```ts
export type FlowCode =
  | "flow-no-initial" | "flow-many-initial" | "flow-bad-ref" | "flow-final-outgoing" | "flow-dup-edge"
  | "flow-vars-schema" | "flow-requires-schema" | "flow-unknown-var"
  | "flow-unreachable" | "flow-dead-end" | "flow-unknown-tool"
  | "flow-tools-capability" | "flow-tools-host";
export interface FlowDiagnostic { severity: "error" | "warning" | "info"; code: string; message: string; line: number }
```

Change the `loadStatechart` signature's options to `opts: { knownTools?: readonly string[]; host?: string } = {}` and add, next to `err` and `warn`:

```ts
  const info = (code: FlowCode, message: string, line: number) => diagnostics.push({ severity: "info", code, message, line });
  /** Each tools= name is a capability or <host>:<tool>; anything else cannot run on more than one host. */
  const checkTools = (names: readonly string[] | undefined, where: string, line: number) => {
    for (const name of names ?? []) {
      const t = parseToolName(name);
      if (t === undefined) err("flow-tools-capability", `${where}: tool "${name}" is neither a capability (read write run search web) nor <host>:<tool>`, line);
      else if (t.kind === "host") info("flow-tools-host", `${where}: "${name}" exists only on ${t.host}, so this workflow does not run the same on every host`, line);
    }
  };
```

In the `// meta defaults` loop, read the key `flow-tools` instead of `tools` (`if (b.type === "meta" && b.data && "flow-tools" in b.data) { defaultTools = nameList(b.data["flow-tools"]); break; }`). Right after the loop, add: `checkTools(defaultTools, "meta flow-tools", 1);`

In the states loop, after `const tools = nameList(a["tools"]); if (tools !== undefined) st.tools = tools;`, add: ``checkTools(tools, `state #${st.id}`, st.line);``

Replace the `if (opts.knownTools) { … }` block at the end with:

```ts
  if (opts.knownTools && opts.host) {
    const known = new Set(opts.knownTools);
    for (const s of states.values()) {
      for (const name of s.tools ?? defaultTools ?? []) {
        const t = parseToolName(name);
        if (t?.kind === "host" && t.host === opts.host && !known.has(t.tool)) {
          warn("flow-unknown-tool", `state #${s.id}: tool "${name}" is not registered`, s.line);
        }
      }
    }
  }
```

- [ ] **Step 5: Change the supervisor**

In `integrations/gemflow/src/core/supervisor.ts`:

Add the import: `import { hostTools, type CapabilityMap } from "./capabilities.js";`

In `interface SupervisorHost`, add after `agent?: unknown;`:

```ts
  /** This host's name as workflows spell it in `<host>:<tool>` (`claude`, `dsh`, `pi`, …). */
  host: string;
  /** This host's tools for each capability. */
  capabilities: CapabilityMap;
```

Replace the body of `private wanted()` with:

```ts
    const state = this.state();
    const names = state ? effectiveTools(this.sc, state) : this.sc.defaultTools;
    return names === undefined ? undefined : hostTools(names, this.host.host, this.host.capabilities);
```

and its doc comment with `/** The tools sigma admits, as this host's own tool names. */`.

- [ ] **Step 6: Change `visibleTools`**

In `integrations/gemflow/src/core/prompt.ts`, add `import { hostTools, type CapabilityMap } from "./capabilities.js";` and replace `visibleTools` with:

```ts
export function visibleTools(sc: Statechart, state: State, globalNames: readonly string[], host: string, map: CapabilityMap): { kind: "unrestricted" } | { kind: "allow"; names: string[] } {
  const wanted = effectiveTools(sc, state);
  if (wanted === undefined) return { kind: "unrestricted" };
  const known = new Set(globalNames);
  return { kind: "allow", names: hostTools(wanted, host, map).filter((n) => known.has(n)) };
}
```

- [ ] **Step 7: Wire the adapters**

`integrations/gemflow/src/hosts/dsh/plugin.ts`:
- add `import { DSH_CAPABILITIES } from "../../core/capabilities.js";`
- the `loadStatechart(text, file, { knownTools: … })` call gains `host: "dsh"` inside the options object;
- the object passed to `new Supervisor(sc, opened.run, { … })` gains `host: "dsh", capabilities: DSH_CAPABILITIES,`.

`integrations/gemflow/src/hosts/pi/extension.ts`:
- add `import { PI_CAPABILITIES } from "../../core/capabilities.js";`
- the object passed to `new Supervisor(sc, opened.run, { … })` gains `host: "pi", capabilities: PI_CAPABILITIES,`.
- If the file calls `visibleTools`, pass `"pi", PI_CAPABILITIES` as the two new arguments (it does not at 7fe644a; check with `grep -n visibleTools src/hosts/pi/extension.ts src/hosts/dsh/plugin.ts`).

- [ ] **Step 8: Teach the CLI `--host` and info lines**

In `integrations/gemflow/src/cli.ts`:
- In `USAGE`, the `check` line becomes `"  check <flow.geml> [--host h --tools a,b]  static checks (exit 1 on errors)",`.
- In `case "check"`, replace the `loadStatechart(...)` line with:
  ```ts
      const host = flag(rest, "--host");
      const r = loadStatechart(readOrFail(resolve(file)), file, tools && host ? { knownTools: tools.split(",").map((s) => s.trim()).filter(Boolean), host } : {});
  ```
- Replace `printDiagnostics` with:
  ```ts
  function printDiagnostics(ds: readonly FlowDiagnostic[]): void {
    for (const d of ds) console.error(`${d.severity}: ${d.code}: ${d.message} (line ${d.line})`);
    const errs = ds.filter((d) => d.severity === "error").length;
    const warns = ds.filter((d) => d.severity === "warning").length;
    const infos = ds.length - errs - warns;
    if (errs || warns) console.error(`${errs} error(s), ${warns} warning(s)${infos ? `, ${infos} info` : ""}`);
    else console.error(infos ? `ok: no errors or warnings (${infos} info)` : "ok: no diagnostics");
  }
  ```

- [ ] **Step 9: Run the suite and watch it pass**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a2.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a2.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`. If a test outside the six named files fails on a tool name, it is a literal Step 2 missed: apply rule 2 to it.

- [ ] **Step 10: Commit**

```bash
git add integrations/gemflow/src integrations/gemflow/test integrations/gemflow/examples
git commit -m "feat(gemflow): workflows name capabilities, and the gates expand them per host

tools= and meta flow-tools hold read/write/run/search/web or <host>:<tool>;
The meta key takes the vocabulary's prefix (spec/profiles/README, Naming).
anything else is flow-tools-capability, a host-only tool is the info
flow-tools-host. The supervisor expands names with the host's map
(SupervisorHost.host and .capabilities), so the dsh and pi gates keep
working; check --host --tools reports unregistered host tools."
```

---

### Task 4: Signals table, `unit`, `context`, `strict`, `auto` and their checks

**Files:**
- Modify: `integrations/gemflow/src/core/statechart.ts`
- Create: `spec/profiles/geml-flow/checks.json`
- Create: `integrations/gemflow/test/checks-conformance.test.mjs`
- Modify: `integrations/gemflow/test/statechart.test.mjs`
- Modify: `docs/design/specs/2026-10-11-gemflow-design.md` (§4.4 table: one row)

- [ ] **Step 1: Write the conformance table**

Create `spec/profiles/geml-flow/checks.json`. Each case is the body of a workflow after a fixed head; the test builds `=== meta\nprofile = "geml-flow/v1"\n<meta lines>===\n\n=== flow-vars {#vars}\n<vars>\n===\n\n<body>` and compares the sorted list of `severity:code` (infos included) with `codes`.

```json
{
  "profile": "geml-flow/v1",
  "about": "Static checks of the Gemflow runtime (gemflow check). Each case: meta lines, the flow-vars schema, the rest of the document, and the sorted severity:code list loadStatechart must report.",
  "defaultVars": { "type": "object", "properties": { "ok": { "type": "boolean", "default": false }, "note": { "type": "string" } } },
  "cases": [
    {
      "name": "a clean signals table, an auto edge and a strict state",
      "meta": "flow-signals = \"#signals\"\n",
      "body": "=== table {#signals}\n| id | on | match | sets | when | only-in |\n|---|---|---|---|---|---|\n| t | command | npm test | ok | exit-zero | #a |\n===\n\n=== flow-state {#a initial strict}\nx\n===\n\n=== flow-state {#b final}\nx\n===\n\n=== data {#g format=json}\n{\"type\":\"object\",\"properties\":{\"ok\":{\"const\":true}}}\n===\n\n=== flow-transition {#ab from=#a to=#b auto requires=#g}\nx\n===\n",
      "codes": []
    },
    {
      "name": "signals points at a missing block",
      "meta": "flow-signals = \"#nope\"\n",
      "body": "=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-signals-table"]
    },
    {
      "name": "the table lacks a required column",
      "meta": "flow-signals = \"#signals\"\n",
      "body": "=== table {#signals}\n| id | on | sets |\n|---|---|---|\n| t | manual | ok |\n===\n\n=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-signals-table"]
    },
    {
      "name": "unknown on, and a when that does not fit its on",
      "meta": "flow-signals = \"#signals\"\n",
      "body": "=== table {#signals}\n| id | on | match | sets | when |\n|---|---|---|---|---|\n| a | webhook | x | ok | fired |\n| b | file | out/*.mp4 | ok | exit-zero |\n===\n\n=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-signal-on", "error:flow-signal-when"]
    },
    {
      "name": "sets names an undeclared variable, then a non-boolean one",
      "meta": "flow-signals = \"#signals\"\n",
      "body": "=== table {#signals}\n| id | on | match | sets | when |\n|---|---|---|---|---|\n| a | manual | x | missing | checked |\n| b | manual | y | note | checked |\n===\n\n=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-signal-var", "error:flow-signal-var"]
    },
    {
      "name": "a signal variable listed as writable by the model",
      "meta": "flow-signals = \"#signals\"\n",
      "body": "=== table {#signals}\n| id | on | match | sets | when |\n|---|---|---|---|---|\n| a | manual | x | ok | checked |\n===\n\n=== flow-state {#a initial final vars=\"ok note\"}\nx\n===\n",
      "codes": ["error:flow-signal-var-writable"]
    },
    {
      "name": "duplicate and missing ids",
      "meta": "flow-signals = \"#signals\"\n",
      "body": "=== table {#signals}\n| id | on | match | sets | when |\n|---|---|---|---|---|\n| a | manual | x | ok | checked |\n| a | manual | y | ok | checked |\n|  | manual | z | ok | checked |\n===\n\n=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-signal-id", "error:flow-signal-id"]
    },
    {
      "name": "only-in names a missing state, and sits on a non-command row",
      "meta": "flow-signals = \"#signals\"\n",
      "body": "=== table {#signals}\n| id | on | match | sets | when | only-in |\n|---|---|---|---|---|---|\n| a | command | deploy | ok | exit-zero | #nowhere |\n| b | manual | x | ok | checked | #a |\n===\n\n=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-only-in", "error:flow-only-in"]
    },
    {
      "name": "a command row without match, and one whose match is not a regular expression",
      "meta": "flow-signals = \"#signals\"\n",
      "body": "=== table {#signals}\n| id | on | match | sets | when |\n|---|---|---|---|---|\n| a | command |  | ok | exit-zero |\n| b | command | npm (test | ok | exit-zero |\n===\n\n=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-signals-table", "error:flow-signals-table"]
    },
    {
      "name": "auto without requires, and two auto edges out of one state",
      "meta": "",
      "body": "=== flow-state {#a initial}\nx\n===\n\n=== flow-state {#b final}\nx\n===\n\n=== flow-state {#c final}\nx\n===\n\n=== data {#g format=json}\n{\"type\":\"object\"}\n===\n\n=== flow-transition {#ab from=#a to=#b auto}\nx\n===\n\n=== flow-transition {#ac from=#a to=#c auto requires=#g}\nx\n===\n",
      "codes": ["error:flow-auto-ambiguous", "error:flow-auto-requires"]
    },
    {
      "name": "unit must be branch or file:<glob>",
      "meta": "flow-unit = \"episode\"\n",
      "body": "=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-unit"]
    },
    {
      "name": "unit file with a glob is fine",
      "meta": "flow-unit = \"file:episodes/*.geml\"\n",
      "body": "=== flow-state {#a initial final}\nx\n===\n",
      "codes": []
    },
    {
      "name": "context-budget must be a positive integer",
      "meta": "flow-context-budget = \"0\"\n",
      "body": "=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-context-budget"]
    },
    {
      "name": "a malformed context reference",
      "meta": "",
      "body": "=== flow-state {#a initial final context=\"README.md\"}\nx\n===\n",
      "codes": ["error:flow-context-ref"]
    },
    {
      "name": "a state names a tool that is neither a capability nor <host>:<tool>",
      "meta": "",
      "body": "=== flow-state {#a initial final tools=\"bash\"}\nx\n===\n",
      "codes": ["error:flow-tools-capability"]
    },
    {
      "name": "meta flow-tools names a bare host tool",
      "meta": "flow-tools = \"bash\"\n",
      "body": "=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["error:flow-tools-capability"]
    },
    {
      "name": "a host-prefixed tool in meta flow-tools is an info",
      "meta": "flow-tools = \"read dsh:pay_refund\"\n",
      "body": "=== flow-state {#a initial final}\nx\n===\n",
      "codes": ["info:flow-tools-host"]
    }
  ]
}
```

- [ ] **Step 2: Write the replay test**

Create `integrations/gemflow/test/checks-conformance.test.mjs`:

```js
// Replays spec/profiles/geml-flow/checks.json: the profile's table of static
// checks is the source of truth, and this file only proves the loader agrees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadStatechart } from "../dist/core/statechart.js";

const table = JSON.parse(readFileSync(new URL("../../../spec/profiles/geml-flow/checks.json", import.meta.url), "utf8"));

for (const c of table.cases) {
  test(`checks.json: ${c.name}`, () => {
    const vars = JSON.stringify(c.vars ?? table.defaultVars);
    const src = `=== meta\nprofile = "geml-flow/v1"\n${c.meta}===\n\n=== flow-vars {#vars}\n${vars}\n===\n\n${c.body}`;
    const r = loadStatechart(src, "case.geml");
    const got = r.diagnostics.map((d) => `${d.severity}:${d.code}`).sort();
    assert.deepEqual(got, [...c.codes].sort(), r.diagnostics.map((d) => d.message).join("\n"));
  });
}
```

- [ ] **Step 3: Add unit tests for the parsed model**

Append to `integrations/gemflow/test/statechart.test.mjs`:

```js
const FLOW = '=== meta\nprofile = "geml-flow/v1"\nflow-signals = "#signals"\nflow-unit = "file:episodes/*.geml"\nflow-context-budget = "4096"\n===\n\n'
  + '=== flow-vars {#vars}\n{"type":"object","properties":{"ok":{"type":"boolean","default":false},"note":{"type":"string"}}}\n===\n\n'
  + '=== table {#signals}\n| id | on | match | sets | when | only-in |\n|---|---|---|---|---|---|\n| t | command | npm test | ok | exit-zero | #a #b |\n| r | manual | 审片通过 | ok | checked | |\n===\n\n'
  + '=== flow-state {#a initial strict context="docs/x.md#y ./guide.geml#cut"}\nx\n===\n\n'
  + '=== flow-state {#b final}\nx\n===\n\n'
  + '=== data {#g format=json}\n{"type":"object","properties":{"ok":{"const":true}}}\n===\n\n'
  + '=== flow-transition {#ab from=#a to=#b auto requires=#g}\nx\n===\n';

test("the parsed model carries signals, unit, budget, context, strict and auto", () => {
  const r = loadStatechart(FLOW, "flow.geml");
  assert.deepEqual(r.diagnostics, []);
  const sc = r.statechart;
  assert.deepEqual(sc.signals, [
    { id: "t", on: "command", match: "npm test", sets: "ok", when: "exit-zero", onlyIn: ["a", "b"], row: 1 },
    { id: "r", on: "manual", match: "审片通过", sets: "ok", when: "checked", onlyIn: [], row: 2 },
  ]);
  assert.deepEqual([...sc.signalVars], ["ok"]);
  assert.deepEqual(sc.unit, { kind: "file", glob: "episodes/*.geml" });
  assert.equal(sc.contextBudget, 4096);
  assert.deepEqual(sc.states.get("a").context, ["docs/x.md#y", "./guide.geml#cut"]);
  assert.equal(sc.states.get("a").strict, true);
  assert.equal(sc.states.get("b").strict, false);
  assert.equal(sc.transitions[0].auto, true);
});

test("signal variables are never writable by the model", () => {
  const sc = loadStatechart(FLOW, "flow.geml").statechart;
  assert.deepEqual(allowedVars(sc, sc.states.get("a")), ["note"], "absent vars= means every non-signal variable");
});

test("defaults: unit branch, budget 16384, no signals", () => {
  const sc = loadStatechart(HEAD + "=== flow-state {#a initial final}\nx\n===\n", "t.geml").statechart;
  assert.deepEqual(sc.unit, { kind: "branch" });
  assert.equal(sc.contextBudget, 16384);
  assert.deepEqual(sc.signals, []);
});

test("context references resolve through the caller when it asks", () => {
  const src = HEAD + '=== flow-state {#a initial final context="docs/x.md#y docs/z.md#w"}\nx\n===\n';
  const r = loadStatechart(src, "t.geml", { resolveRef: (ref) => ref === "docs/x.md#y" });
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["flow-context-ref"]);
  assert.match(r.diagnostics[0].message, /docs\/z\.md#w/);
});
```

- [ ] **Step 4: Run both and watch them fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/checks-conformance.test.mjs test/statechart.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: a non-zero `ℹ fail`.

- [ ] **Step 5: Extend the model types**

In `integrations/gemflow/src/core/statechart.ts`:

Add to `interface State`:

```ts
  /** `<file>#<block-id>` references Stagehand injects on entry, in order. */
  context: string[];
  /** The tools list is enforced (gates 1 and 3), not only advised. */
  strict: boolean;
```

Add to `interface Transition`: `/** Taken as soon as a signal makes \`requires\` hold. */ auto: boolean;`

Add above `interface Statechart`:

```ts
export type SignalOn = "command" | "file" | "git" | "manual";
export interface Signal {
  id: string; on: SignalOn; match: string; sets: string; when: string;
  /** States a command signal's command may run in; empty = any. */
  onlyIn: string[];
  /** 1-based row in the signals table, for messages. */
  row: number;
}
export type Unit = { kind: "branch" } | { kind: "file"; glob: string };

/** The `when` values each kind of signal admits (spec §5.2). */
export const SIGNAL_WHEN: Readonly<Record<SignalOn, readonly string[]>> = {
  command: ["exit-zero"],
  file: ["exists"],
  git: ["committed", "pr-open", "pr-merged", "ci-success"],
  manual: ["checked"],
};
export const DEFAULT_CONTEXT_BUDGET = 16384;
```

Add to `interface Statechart`: `signals: Signal[]; signalVars: Set<string>; unit: Unit; contextBudget: number;`

Extend `FlowCode` with:

```ts
  | "flow-signals-table" | "flow-signal-on" | "flow-signal-when" | "flow-signal-var" | "flow-signal-var-writable"
  | "flow-signal-id" | "flow-only-in" | "flow-context-ref" | "flow-auto-requires" | "flow-auto-ambiguous"
  | "flow-unit" | "flow-context-budget"
```

Change the options type to `opts: { knownTools?: readonly string[]; host?: string; resolveRef?: (ref: string) => boolean } = {}`.

- [ ] **Step 6: Read meta `signals`, `unit`, `context-budget`**

Replace the `// meta defaults` loop with:

```ts
  // meta defaults
  let defaultTools: string[] | undefined;
  let signalsRef: string | undefined;
  let unit: Unit = { kind: "branch" };
  let contextBudget = DEFAULT_CONTEXT_BUDGET;
  const meta = blocks.find((b) => b.type === "meta" && b.data);
  if (meta?.data) {
    if ("flow-tools" in meta.data) defaultTools = nameList(meta.data["flow-tools"]);
    if ("flow-signals" in meta.data) signalsRef = String(meta.data["flow-signals"]);
    if ("flow-unit" in meta.data) {
      const u = String(meta.data["flow-unit"]).trim();
      const file = u.match(/^file:(.+)$/);
      if (u === "branch") unit = { kind: "branch" };
      else if (file && file[1]!.trim().length > 0) unit = { kind: "file", glob: file[1]!.trim() };
      else err("flow-unit", `meta flow-unit = "${u}": expected branch or file:<glob>`, 1);
    }
    if ("flow-context-budget" in meta.data) {
      const n = Number(meta.data["flow-context-budget"]);
      if (Number.isInteger(n) && n > 0) contextBudget = n;
      else err("flow-context-budget", `meta flow-context-budget = "${String(meta.data["flow-context-budget"])}": expected a positive integer (bytes)`, 1);
    }
  }
```

(Keep the existing `checkTools(defaultTools, "meta flow-tools", 1);` line from Task 3 right after this block.)

- [ ] **Step 7: Read `context` and `strict` on states**

In the states loop, the `st` object literal gains `context: [], strict: a["strict"] === true,`. After the `vars` handling inside the loop add:

```ts
    for (const ref of nameList(a["context"]) ?? []) {
      const hash = ref.indexOf("#");
      if (hash <= 0 || hash === ref.length - 1) { err("flow-context-ref", `state #${st.id}: context "${ref}" is not <file>#<block-id>`, st.line); continue; }
      if (opts.resolveRef && !opts.resolveRef(ref)) { err("flow-context-ref", `state #${st.id}: context ${ref} does not resolve to a block`, st.line); continue; }
      st.context.push(ref);
    }
```

- [ ] **Step 8: Read `auto` on transitions and check it**

In the transitions loop, the `t` object literal gains `auto: b.attrs["auto"] === true,`. After the whole transitions loop (before `if (hasErrors(diagnostics)) return { diagnostics };`), add:

```ts
  const autoFrom = new Map<string, number>();
  for (const t of transitions) {
    if (!t.auto) continue;
    if (!t.requires) err("flow-auto-requires", `transition #${t.id} is auto but has no requires=, so it would fire at once`, t.line);
    autoFrom.set(t.from, (autoFrom.get(t.from) ?? 0) + 1);
  }
  for (const [from, n] of autoFrom) {
    if (n > 1) err("flow-auto-ambiguous", `state #${from} has ${n} auto transitions; at most one may leave a state`, states.get(from)?.line ?? 1);
  }
```

- [ ] **Step 9: Read and check the signals table**

Add above `loadStatechart`:

```ts
const SIGNAL_REQUIRED = ["id", "on", "sets", "when"] as const;

type TableBlock = Typed & { table?: { columns: string[]; rows: { text: string }[][] } };
```

Inside `loadStatechart`, after the states loop and the initial-state checks, and before the transitions loop, add:

```ts
  // signals
  const signals: Signal[] = [];
  const signalVars = new Set<string>();
  if (signalsRef !== undefined) {
    const id = refId(signalsRef);
    const tb = id ? (byId.get(id) as TableBlock | undefined) : undefined;
    const line = at(id);
    if (!tb || tb.type !== "table" || !tb.table) {
      err("flow-signals-table", `meta flow-signals = "${signalsRef}" must be #id of a table block`, line);
    } else {
      const cols = tb.table.columns.map((c) => c.trim().toLowerCase());
      const missing = SIGNAL_REQUIRED.filter((c) => !cols.includes(c));
      if (missing.length) err("flow-signals-table", `#${id}: missing column(s) ${missing.join(", ")}`, line);
      else {
        const cell = (row: { text: string }[], name: string) => (cols.indexOf(name) >= 0 ? (row[cols.indexOf(name)]?.text ?? "").trim() : "");
        const seen = new Set<string>();
        tb.table.rows.forEach((row, i) => {
          const n = i + 1;
          const sig: Signal = {
            id: cell(row, "id"), on: cell(row, "on") as SignalOn, match: cell(row, "match"), sets: cell(row, "sets"),
            when: cell(row, "when"), onlyIn: (cell(row, "only-in").match(/\S+/g) ?? []).map((s) => s.replace(/^#/, "")), row: n,
          };
          let bad = false;
          if (!sig.id) { err("flow-signal-id", `#${id} row ${n}: no id`, line); bad = true; }
          else if (seen.has(sig.id)) { err("flow-signal-id", `#${id} row ${n}: id "${sig.id}" repeats an earlier row`, line); bad = true; }
          seen.add(sig.id);
          if (!(sig.on in SIGNAL_WHEN)) { err("flow-signal-on", `#${id} row ${n}: on = "${sig.on}" is not command, file, git or manual`, line); bad = true; }
          else if (!SIGNAL_WHEN[sig.on].includes(sig.when)) { err("flow-signal-when", `#${id} row ${n}: when = "${sig.when}" does not fit on = ${sig.on} (expected ${SIGNAL_WHEN[sig.on].join(" | ")})`, line); bad = true; }
          if ((sig.on === "command" || sig.on === "file") && !sig.match) { err("flow-signals-table", `#${id} row ${n}: a ${sig.on} signal needs match`, line); bad = true; }
          if (sig.on === "command" && sig.match) {
            try { new RegExp(sig.match); } catch { err("flow-signals-table", `#${id} row ${n}: match "${sig.match}" is not a regular expression`, line); bad = true; }
          }
          const decl = vars?.properties?.[sig.sets];
          if (!decl) { err("flow-signal-var", `#${id} row ${n}: sets "${sig.sets}", which flow-vars does not declare`, line); bad = true; }
          else if (decl.type !== "boolean") { err("flow-signal-var", `#${id} row ${n}: sets "${sig.sets}", which is not boolean`, line); bad = true; }
          if (sig.onlyIn.length && sig.on !== "command") { err("flow-only-in", `#${id} row ${n}: only-in applies to command signals only`, line); bad = true; }
          for (const s of sig.onlyIn) if (!states.has(s)) { err("flow-only-in", `#${id} row ${n}: only-in names #${s}, which is not a flow-state`, line); bad = true; }
          if (!bad) { signals.push(sig); signalVars.add(sig.sets); }
        });
      }
    }
  }
  for (const s of states.values()) {
    for (const v of s.vars ?? []) {
      if (signalVars.has(v)) err("flow-signal-var-writable", `state #${s.id}: vars= lists "${v}", which a signal sets; the model may not write it`, s.line);
    }
  }
```

- [ ] **Step 10: Put the new fields on the result, and keep signal variables out of `allowedVars`**

Replace `const sc: Statechart = { file, hash: hashText(src), initial, states, transitions };` with:

```ts
  const sc: Statechart = { file, hash: hashText(src), initial, states, transitions, signals, signalVars, unit, contextBudget };
```

Replace `allowedVars` with:

```ts
export function allowedVars(sc: Statechart, state: State): string[] {
  return state.vars ?? Object.keys(sc.vars?.properties ?? {}).filter((v) => !sc.signalVars.has(v));
}
```

- [ ] **Step 11: Run both and watch them pass, then the whole suite**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a2.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a2.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`. A `checks.json` case that fails prints every diagnostic message in the assertion text; fix the loader unless the case contradicts spec §4.4.

- [ ] **Step 12: Bring the design spec in line**

In `docs/design/specs/2026-10-11-gemflow-design.md`: the meta keys take the vocabulary's prefix everywhere they appear — `tools` → `flow-tools`, `signals` → `flow-signals`, `unit` → `flow-unit`, `context-budget` → `flow-context-budget` (§4.1's example meta block, the §4.3 table, §5.5, §7.1, §7.2, and any prose that names them; the state attribute `tools=` is an attribute key and stays). Under the §4.3 table add one sentence: the keys carry the `flow-` prefix because spec/profiles/README's Naming section requires it of every `=== meta` key a vocabulary reads. Then, in §4.4, add a row after `flow-unit`:

```markdown
| `flow-context-budget` | error | `flow-context-budget` 不是正整数 |
```

- [ ] **Step 13: Commit**

```bash
git add integrations/gemflow/src/core/statechart.ts integrations/gemflow/test/statechart.test.mjs integrations/gemflow/test/checks-conformance.test.mjs spec/profiles/geml-flow/checks.json docs/design/specs/2026-10-11-gemflow-design.md
git commit -m "feat(gemflow): the signals table, unit, context, strict, auto and their static checks

Every check of spec 4.4 is implemented in loadStatechart and pinned by
spec/profiles/geml-flow/checks.json, which a runtime test replays. Signal
variables are never writable by the model: allowedVars leaves them out and
listing one in vars= is an error. flow-context-budget joins the spec table."
```

---

### Task 5: Snapshot `by` / `signal`, `applySignal`, and the deviation block

**Files:**
- Modify: `integrations/gemflow/src/core/snapshot.ts`
- Modify: `integrations/gemflow/src/core/journal.ts`
- Modify: `integrations/gemflow/src/core/run.ts`
- Test: `integrations/gemflow/test/snapshot.test.mjs`, `integrations/gemflow/test/journal.test.mjs`, `integrations/gemflow/test/run.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `integrations/gemflow/test/snapshot.test.mjs` (add `applySignal`, `loadStatechart`, `initialSnapshot`, `applyTransition`, `hashSnapshot` to the file's existing imports if missing):

```js
const SIGFLOW = '=== meta\nprofile = "geml-flow/v1"\nflow-signals = "#signals"\n===\n\n'
  + '=== flow-vars {#vars}\n{"type":"object","properties":{"ok":{"type":"boolean","default":false}}}\n===\n\n'
  + '=== table {#signals}\n| id | on | match | sets | when |\n|---|---|---|---|---|\n| t | command | npm test | ok | exit-zero |\n===\n\n'
  + '=== flow-state {#a initial}\nx\n===\n\n=== flow-state {#b final}\nx\n===\n\n'
  + '=== flow-transition {#ab from=#a to=#b}\nx\n===\n';

test("applySignal writes the signal's variable, marked by=signal", () => {
  const sc = loadStatechart(SIGFLOW, "f.geml").statechart;
  const s0 = initialSnapshot(sc, "2026-01-01T00:00:00Z");
  const out = applySignal(sc, s0, "t", true, { at: "2026-01-01T00:00:01Z" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.next.vars, { ok: true });
  assert.equal(out.next.cause, "patch");
  assert.equal(out.next.by, "signal");
  assert.equal(out.next.signal, "t");
  assert.equal(applySignal(sc, out.next, "t", true, { at: "x" }), null, "a value that already holds records nothing");
  const unknown = applySignal(sc, s0, "zz", true, { at: "x" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.refusal.tool, "flow_signal");
});

test("by and signal stay out of the hash, like cause", () => {
  const sc = loadStatechart(SIGFLOW, "f.geml").statechart;
  const s0 = initialSnapshot(sc, "2026-01-01T00:00:00Z");
  const viaSignal = applySignal(sc, s0, "t", true, { at: "t1" }).next;
  const viaHuman = applyTransition(sc, s0, "b", { at: "t1", by: "human" }).next;
  assert.equal(viaHuman.by, "human");
  assert.equal(viaSignal.hash, hashSnapshot({ v: 1, rev: 1, parent: s0.hash, state: "a", vars: { ok: true } }));
});
```

Append to `integrations/gemflow/test/journal.test.mjs` (add `renderDeviationBlock`, `renderJournalHead`, `renderSnapshotBlock`, `readJournal`, `verifyJournal`, `hashSnapshot` to its imports if missing):

```js
test("by, signal and flow-deviation round-trip through the journal", () => {
  const head = renderJournalHead({ session: "s", statechart: "f.geml", statechartHash: "sha256:00", created: "t0" });
  const s0 = { v: 1, rev: 0, state: "a", vars: { ok: false }, cause: "enter", at: "t0" };
  s0.hash = hashSnapshot(s0);
  const s1 = { v: 1, rev: 1, parent: s0.hash, state: "a", vars: { ok: true }, cause: "patch", at: "t1", by: "signal", signal: "t" };
  s1.hash = hashSnapshot(s1);
  const dev = renderDeviationBlock({ n: 1, rev: 1, at: "t2", tool: "Edit", call: "c9", state: "a", capability: "write" });
  const text = head + renderSnapshotBlock(s0) + renderSnapshotBlock(s1) + dev;
  const j = readJournal(text);
  assert.deepEqual(j.diagnostics, []);
  assert.equal(j.snapshots[1].by, "signal");
  assert.equal(j.snapshots[1].signal, "t");
  assert.deepEqual(j.deviations, [{ n: 1, rev: 1, at: "t2", tool: "Edit", call: "c9", state: "a", capability: "write" }]);
  assert.deepEqual(verifyJournal(j), []);
});

test("verifyJournal: by=signal needs signal=, and the statechart must know it", () => {
  const s0 = { v: 1, rev: 0, state: "a", vars: {}, cause: "enter", at: "t0" };
  s0.hash = hashSnapshot(s0);
  const s1 = { v: 1, rev: 1, parent: s0.hash, state: "a", vars: {}, cause: "patch", at: "t1", by: "signal" };
  s1.hash = hashSnapshot(s1);
  const j = { meta: {}, snapshots: [s0, s1], refusals: [], deviations: [], diagnostics: [] };
  assert.deepEqual(verifyJournal(j), ["#rev-1: by=signal needs signal="]);
  const sc = { states: new Map([["a", {}]]), transitions: [], signals: [{ id: "known" }] };
  const s2 = { ...s1, signal: "zz" };
  assert.deepEqual(verifyJournal({ ...j, snapshots: [s0, s2] }, sc), ["#rev-1: signal zz is not in the statechart's signals table"]);
});
```

Append to `integrations/gemflow/test/run.test.mjs` (add `startRun`, `loadStatechart` to its imports if missing):

```js
test("Run.signal advances by=signal and returns null when nothing changes; Run.deviate numbers its blocks", () => {
  const SIG = '=== meta\nprofile = "geml-flow/v1"\nflow-signals = "#signals"\n===\n\n'
    + '=== flow-vars {#vars}\n{"type":"object","properties":{"ok":{"type":"boolean","default":false}}}\n===\n\n'
    + '=== table {#signals}\n| id | on | match | sets | when |\n|---|---|---|---|---|\n| t | manual | done | ok | checked |\n===\n\n'
    + '=== flow-state {#a initial final}\nx\n===\n';
  const sc = loadStatechart(SIG, "f.geml").statechart;
  const { run } = startRun(sc, { session: "s", statechart: "f.geml", statechartHash: sc.hash, created: "t0" }, "t0");
  const adv = run.signal("t", true, { at: "t1" });
  assert.equal(adv.ok, true);
  assert.match(adv.block, /by=signal signal=t/);
  assert.equal(run.signal("t", true, { at: "t2" }), null);
  const d1 = run.deviate("Edit", "write", { at: "t3", call: "c1" });
  const d2 = run.deviate("Bash", "run", { at: "t4" });
  assert.match(d1, /^=== flow-deviation \{#deviation-1 rev=1 at=t3 tool=Edit call=c1 state=#a\}\n\{"capability":"write"\}\n===\n\n$/);
  assert.match(d2, /#deviation-2/);
  assert.equal(run.deviations, 2);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/snapshot.test.mjs test/journal.test.mjs test/run.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: non-zero `ℹ fail` (no `applySignal`, no `renderDeviationBlock`, no `run.signal`).

- [ ] **Step 3: Snapshot fields and `applySignal`**

In `integrations/gemflow/src/core/snapshot.ts`:

Add `export type By = "model" | "signal" | "human";`

Add to `interface Snapshot`, after `restores?: number;`: `by?: By;` and `signal?: string;`

Change `Refusal.tool` to `"flow_transition" | "flow_set" | "flow_rollback" | "flow_signal"`.

Change `Meta` to `export interface Meta { at: string; call?: string; by?: By; signal?: string }`.

In `child()`, after `if (meta.call !== undefined) base.call = meta.call;` add:

```ts
  if (meta.by !== undefined) base.by = meta.by;
  if (meta.signal !== undefined) base.signal = meta.signal;
```

Add after `applyPatch`:

```ts
/**
 * A signal observed a fact: write its variable. Bypasses `vars=` on purpose —
 * signal variables are the ones the model may not write. Returns null when the
 * variable already holds the value, so repeated observations add no revision.
 */
export function applySignal(sc: Statechart, snap: Snapshot, signalId: string, value: boolean, meta: Meta): Outcome | null {
  const sig = sc.signals.find((s) => s.id === signalId);
  if (!sig) return refuse("flow_signal", `no signal "${signalId}" in the statechart`);
  if (snap.vars[sig.sets] === value) return null;
  const merged: Record<string, JsonValue> = { ...snap.vars, [sig.sets]: value };
  const diagnostics = sc.vars ? validate(sc.vars, merged) : [];
  if (diagnostics.length) return refuse("flow_signal", `signal ${signalId}: rejected by flow-vars schema`, diagnostics);
  return { ok: true, next: child(snap, { ...meta, by: "signal", signal: signalId }, { state: snap.state, vars: merged, cause: "patch" }) };
}
```

- [ ] **Step 4: Journal rendering, reading and verification**

In `integrations/gemflow/src/core/journal.ts`:

Change the snapshot import to `import { canonical, hashSnapshot, type By, type Cause, type Snapshot } from "./snapshot.js";`

Add the deviation type and extend `Journal`:

```ts
export interface Deviation { n: number; rev: number; at: string; tool: string; call?: string; state: string; capability: string | null }
export interface Journal { meta: JournalMeta; snapshots: Snapshot[]; refusals: Refused[]; deviations: Deviation[]; diagnostics: string[] }
const BYS: ReadonlySet<string> = new Set(["model", "signal", "human"]);
```

In `renderSnapshotBlock`, after the `restores` line add:

```ts
  if (s.by !== undefined) parts.push(`by=${s.by}`);
  if (s.signal !== undefined) parts.push(`signal=${attr(s.signal)}`);
```

Add after `renderRefusedBlock`:

```ts
export function renderDeviationBlock(d: Deviation): string {
  const parts = [`#deviation-${d.n}`, `rev=${d.rev}`, `at=${attr(d.at)}`, `tool=${attr(d.tool)}`];
  if (d.call !== undefined) parts.push(`call=${attr(d.call)}`);
  parts.push(`state=#${d.state}`);
  return `=== flow-deviation {${parts.join(" ")}}\n${canonical({ capability: d.capability })}\n===\n\n`;
}
```

In `readJournal`: declare `const deviations: Deviation[] = [];`; extend the JSON-body error condition to `if (blk.type === "flow-snapshot" || blk.type === "flow-refused" || blk.type === "flow-deviation")`; in the `flow-snapshot` branch, after `restores`, add:

```ts
      const by = str(a["by"]);
      if (by !== undefined) {
        if (!BYS.has(by)) { diagnostics.push(`${label}: by=${by} is not model, signal or human`); continue; }
        s.by = by as By;
      }
      const signal = str(a["signal"]); if (signal !== undefined) s.signal = signal;
```

and add a branch after the `flow-refused` one:

```ts
    } else if (blk.type === "flow-deviation") {
      const a = blk.attrs;
      const rec = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, JsonValue>;
      const state = str(a["state"]);
      const d: Deviation = {
        n: Number((blk.id ?? "deviation-0").replace(/^deviation-/, "")),
        rev: num(a["rev"]) ?? -1, at: str(a["at"]) ?? "", tool: str(a["tool"]) ?? "",
        state: state?.startsWith("#") ? state.slice(1) : "", capability: str(rec["capability"]) ?? null,
      };
      const call = str(a["call"]); if (call !== undefined) d.call = call;
      deviations.push(d);
```

and return `{ meta, snapshots, refusals, deviations, diagnostics }`.

In `verifyJournal`, inside the per-snapshot loop after the `restores` check, add:

```ts
    if (s.by === "signal" && s.signal === undefined) errors.push(`${label}: by=signal needs signal=`);
    if (sc && s.signal !== undefined && !sc.signals.some((x) => x.id === s.signal)) errors.push(`${label}: signal ${s.signal} is not in the statechart's signals table`);
```

- [ ] **Step 5: `Run.signal` and `Run.deviate`**

In `integrations/gemflow/src/core/run.ts`:

Import `applySignal` from `./snapshot.js` and `renderDeviationBlock` from `./journal.js`.

Add to `interface Run`:

```ts
  /** How many deviations have been recorded, so `#deviation-N` keeps counting. */
  readonly deviations: number;
  /** A signal observed a fact; null when the variable already held it. */
  signal(id: string, value: boolean, meta: Meta): Advance | null;
  /** Record a call outside the current state's tools in a non-strict state. */
  deviate(tool: string, capability: string | null, meta: Meta): string;
```

In `class RunState`: add `private devs: number;`, a constructor parameter `deviations = 0` after `refusals` that sets it, a getter `get deviations(): number { return this.devs; }`, and:

```ts
  signal(id: string, value: boolean, meta: Meta): Advance | null {
    const outcome = applySignal(this.sc, this.snapshot, id, value, meta);
    return outcome === null ? null : this.settle(outcome, meta);
  }

  deviate(tool: string, capability: string | null, meta: Meta): string {
    this.devs += 1;
    return renderDeviationBlock({
      n: this.devs, rev: this.snapshot.rev, at: meta.at, tool,
      ...(meta.call !== undefined ? { call: meta.call } : {}),
      state: this.snapshot.state, capability,
    });
  }
```

Update the two constructor call sites: `startRun` → `new RunState(sc, [first], 0, 0)`; `resumeRun` → add `const deviations = journal.deviations.reduce((max, d) => (d.n > max ? d.n : max), 0);` next to `refusals` and pass it as the fourth argument. (`resumeRun`'s local holding the parsed journal is named `journal` after plan A1's rename.)

- [ ] **Step 6: Run the three and watch them pass, then the whole suite**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-a2.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-a2.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add integrations/gemflow/src/core/snapshot.ts integrations/gemflow/src/core/journal.ts integrations/gemflow/src/core/run.ts integrations/gemflow/test/snapshot.test.mjs integrations/gemflow/test/journal.test.mjs integrations/gemflow/test/run.test.mjs
git commit -m "feat(gemflow): snapshots record who advanced them; signals and deviations reach the journal

flow-snapshot gains by= (model | signal | human) and signal=, both outside
the hash like cause=. applySignal writes a signal variable, bypassing vars=
and recording nothing when the value already holds. flow-deviation records
a call outside a non-strict state's tools. verifyJournal checks by=signal
against the statechart's signals table."
```

---

### Task 6: The profile document follows the vocabulary

**Files:**
- Modify: `spec/profiles/geml-flow/geml-flow-profile.md`
- Modify: `spec/profiles/geml-flow/geml-flow-profile_CN.md`
- Modify: `spec/profiles/README.md` (the `geml-flow/v1` row)

The profile is the reference; the design spec is the rationale. The profile states rules only, with no history (no "formerly", no "renamed from").

- [ ] **Step 1: Read the current profile's outline**

Run: `node geml-parser/dist/geml.js list spec/profiles/geml-flow/geml-flow-profile.md | grep heading`
Expected: sections 0 (one paragraph), 1 (declaring), 2 (blocks, with 2.1 state, 2.2 transition, 2.3 the journal), 3 (static checks), 4 (JSON Schema subset), 5 (conformance).

- [ ] **Step 2: Rewrite section by section (English)**

Keep the numbering. Make these changes, each a full replacement of the named part:

1. **§0** — one paragraph: a `geml-flow/v1` document is a workflow statechart (states, transitions, variables, the signals that observe facts, the tools each state allows) or a journal (one work item's hash-chained record of snapshots, refusals and deviations). It is read by the Gemflow runtime; the model sees a state's body as its instruction.
2. **§1** — declaring: `profile = "geml-flow/v1"`; a meta keys table with `flow-tools`, `flow-signals`, `flow-unit`, `flow-context-budget` (meaning, value, default) exactly as spec §4.3; one sentence: the keys carry the vocabulary's prefix, as spec/profiles/README's Naming section requires.
3. **§2 blocks table** — the six types (`flow-vars`, `flow-state`, `flow-transition`, `flow-snapshot`, `flow-refused`, `flow-deviation`) with body kind and keys, matching `geml-parser/src/profiles.ts` after Task 1.
4. **§2.1 `flow-state`** — add `context` (space-separated `<file>#<block-id>`; `./` resolves against the workflow's own directory, any other path against the project root) and `strict` (the `tools` list is enforced; otherwise it is advice and a call outside it is recorded as a deviation). Replace the tool-name paragraph with the capability rule: `read write run search web`, or `<host>:<tool>`, plus the host map table from spec §4.3.
5. **§2.2 `flow-transition`** — add `auto` (taken when a signal write makes `requires` hold; needs `requires`; at most one per state).
6. **New §2.3 The signals table** — a plain `table` block named by meta `flow-signals`; columns `id on match sets when` required, `only-in` optional; the `when` table per `on` from spec §5.2; `sets` must be a boolean variable that no state lists in `vars`; `match` is a regular expression for `command` (a literal `|` inside a cell is written `\|`) and a glob for `file`; `only-in` is for `command` rows only.
7. **§2.4 The journal** (renumbered from 2.3) — add `by` (`model`, `signal`, `human`; outside the hash), `signal` (the signal id when `by=signal`), and the `flow-deviation` block with its keys and body `{"capability": <name or null>}`. Path rule: one journal per work item, `.geml/journals/<item>.geml`.
8. **§3 static checks** — the full code table: the eleven codes the profile listed (with the `flow-` prefix) plus `flow-tools-capability` (error), `flow-tools-host` (info), and every row of spec §4.4 including `flow-context-budget`. One sentence under it: `spec/profiles/geml-flow/checks.json` holds a case for each code and the runtime replays it.
9. **§5 conformance** — both files: `conformance.json` (parser: what the vocabulary admits, how addresses change) and `checks.json` (runtime: static checks).

- [ ] **Step 3: Mirror it in Chinese**

Apply the same nine changes to `spec/profiles/geml-flow/geml-flow-profile_CN.md`, in Chinese, with identical tables (identifiers, codes and values unchanged). Use 「journal」 for the journal, as the design spec does.

- [ ] **Step 4: Update the profile index row**

In `spec/profiles/README.md`, the `geml-flow/v1` row lists types `flow-vars`, `flow-state`, `flow-transition`, `flow-snapshot`, `flow-refused`, `flow-deviation` and the keys from Task 1.

- [ ] **Step 5: Check both profile documents parse**

Run:
```bash
node geml-parser/dist/geml.js check spec/profiles/geml-flow/geml-flow-profile.md; echo "en exit=$?"
node geml-parser/dist/geml.js check spec/profiles/geml-flow/geml-flow-profile_CN.md; echo "cn exit=$?"
```
Expected: `en exit=0`, `cn exit=0`.

- [ ] **Step 6: Run both suites once**

Run:
```bash
cd geml-parser && node test/all.mjs > /tmp/gemflow-a2.log 2>&1; echo "parser exit=$?"; tail -1 /tmp/gemflow-a2.log; cd ..
cd integrations/gemflow && npm test > /tmp/gemflow-a2-rt.log 2>&1; echo "runtime exit=$?"; grep -E "^ℹ fail" /tmp/gemflow-a2-rt.log; cd ../..
```
Expected: both `exit=0`, `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add spec/profiles/geml-flow/geml-flow-profile.md spec/profiles/geml-flow/geml-flow-profile_CN.md spec/profiles/README.md
git commit -m "docs(profiles): geml-flow/v1 reference covers capabilities, signals, unit, context, strict, auto and the journal"
```

---

## Done when

- Six commits on the branch, nothing pushed.
- `cd integrations/gemflow && npm test` passes; `checks-conformance.test.mjs` runs one test per `checks.json` case (33 after the review follow-ups).
- `node geml-parser/dist/geml.js check` is clean on both profile documents.
- From `integrations/gemflow`, `node dist/cli.js check examples/coding/agent.geml` prints `ok: no diagnostics`.
