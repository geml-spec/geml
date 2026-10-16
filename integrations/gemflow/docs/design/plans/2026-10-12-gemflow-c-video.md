# Gemflow C — The Built-in Video Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the second built-in workflow: one work item per episode file, `#script → #assets → #cut → #render → #review → #publish → #done` over geml-media, whose rework edges send an episode back with the last pass's evidence cleared. That takes a new `geml-flow/v1` attribute, `resets=` on a transition, used by the dev workflow's rework edge too; the parser's `geml media todo --check` as the exit status the to-do signal reads; the episode's to-do count on the line above the prompt; and the whole path tested end to end through the bridge with the parser's own commands.

**Architecture:** `resets="<var> …"` on a `flow-transition` is vocabulary (both parsers' registries, the profile reference, its conformance case) and runtime: `loadStatechart` reads and checks it, and `applyTransition` — the one function every taking of an edge goes through (a model's verb, a person's move, an auto walk) — writes the listed variables back to their `flow-vars` defaults in the transition's own snapshot. The video workflow is data: `integrations/gemflow/workflows/video/flow.geml` and its `guide.geml`, which `gemflow init --template video` and `/gemflow add video` copy like every directory under `workflows/`. The parser gains `--check` on `geml media todo`. The to-do count is computed in the bridge's Node process: `src/media-todo.ts` calls the parser's own `todo` over the parser's own confined file host, the bridge returns `todo: { item, count } | null` on its `refresh` and `board` answers, the hooks module keeps the last one in a `todo` atom, and the Node-free band model draws it. `Workspace` names a file-unit work item's file (`itemFile`) so the bridge knows what to count.

**Tech Stack:** TypeScript (tsc) → `dist/`; esbuild 0.28.2 for `dist/gemflow.mjs`; Node ≥ 22; `node:test`; the parser's own suite runner (`geml-parser/test/all.mjs`); Rust (cargo) for `geml-parser-rs`; `claude plugin validate` / `claude plugin test` for the hooks module.

**Spec:** `docs/design/specs/2026-10-11-gemflow-design.md` §3, §4.1, §4.3, §4.4, §5.1, §5.2, §5.5, §6 item 8, §7.1, §7.2, §8.1; `spec/profiles/geml-flow/geml-flow-profile.md` §2, §2.2, §2.3, §3.2, §3.7, §4; `spec/profiles/geml-media/geml-media-profile.md` §5, §6, §8.

**Depends on:** plan B, landed on this branch through `0de7cf2` (its Task 14: the READMEs' `### Claude Code` and `## The dev workflow` sections, the spec's §8). This plan is written against `0de7cf2`; `fc54930`, after it, changes no file this plan touches:

- `src/core/statechart.ts`: `Transition` is `{ id, line, from, to, requiresId?, requires?, approval, auto, body }`; `loadStatechart` builds each in one loop over the `flow-transition` blocks; `nameList` splits an attribute at blanks (`none` is the empty list); `FlowCode` lists every check code.
- `src/core/snapshot.ts`: `applyTransition(sc, snap, to, meta)` checks the edge and its guard and returns a child snapshot with `vars: snap.vars`; `defaultsOf(schema)` (from `schema.ts`) gives each declared default. `Supervisor` takes every edge through `Run.transition` → `applyTransition`: `invoke("flow_transition")`, `humanTransition`, and the auto walk (`takeAutoEdges`, which after a transition bars only the first edge back to the state just left).
- `geml-parser/src/profiles.ts` and `geml-parser-rs/src/vocab.rs` both list `flow-transition`'s attributes as `from to requires approval auto`; both implementations replay `spec/profiles/geml-flow/conformance.json` (`test/profile-conformance.test.mjs`, `tests/profiles.rs`); the runtime replays `spec/profiles/geml-flow/checks.json` (`test/checks-conformance.test.mjs`) through `loadStatechart`, whose diagnostics include the parser's own (an unregistered attribute is `warning:unknown-attribute`).
- `workflows/dev/flow.geml`: `#rework from=#review to=#build`, with no attributes; `#to-review`'s guard holds on tests passing with a PR open, a merged PR, or a person's `ready` tick (`review-ready`).
- `src/hosts/claude-code/band.ts`: `bandSegments(shell, problem, setup = null)` returns `[...stageSegments(shell), ...tail]`. `hooks/register.tsx`: atoms `shell`, `problem`, `node`, `root`, `delivered`, `lastFile`, `board`, `tab`, `boardProblem`, `setup`, `startedAt` (declared in `types/index.d.ts`); `bridge()` stores `res.shell`; `startBridge()` asks `status`, then `refresh` from `$.clock.after(0, …)`; the band renders `bandSegments(await readShell($), await read($, problemAtom), await read($, setupAtom))` inside a `try`.
- `src/bridge.ts`: the `refresh` and `board` cases call `ws.refresh()` and answer `ok(ws.view(), { entered, … }, change.context)`. `src/workspace.ts`: `Workspace` resolves `item` in its constructor with the private `resolveItem()`; a file unit's item comes from `lastFile` when it matches the glob, else from the context document's item while its file exists.
- `tests/hooks.test.ts`: `world(on)` scripts the bridge; its `answer` has the line `if (req.op === 'board') return { v: 1, ok: true, shell: shell(), board: board() }`.

Where a name or an anchor differs when this plan runs, follow the compiler and the files as they are, and keep this plan's behaviour.

**Working directory:** `/Users/xiong/software/geml`, branch `feat/geml-agent-runtime`, in place. Never switch branches, never stash, never push. Other agents commit on this branch: stage by explicit path, never `git add -A` / `git add .`, leave modified files no step names, and never add anything under `playground/codemap/`.

**Conventions:** English commit messages, no attribution trailers, no version bumps — the parser release that carries `resets` and `--check` is the user's call. Run an expensive suite once and take output and exit code from that run. Runtime suite: `cd integrations/gemflow && npm test` (builds — `tsc`, then the bundle — and prints `ℹ pass N` / `ℹ fail N`). One file: `cd integrations/gemflow && npm run build >/dev/null && node --test test/<file>.test.mjs`. Hooks suite (needs the `claude` CLI): `cd integrations/gemflow && npm run test:claude` (prints `N pass` / `N fail`, exits 1 on a failure). Parser suite: `cd geml-parser && npm test` (`tsc`, then `node test/all.mjs`, which ends `<N> suites passed in …`); first clear leftover codemap servers, which squat the ports the cli suites pick: `pgrep -f 'codemap/serve.mjs' | while read -r p; do kill "$p"; done`. One parser file: `cd geml-parser && npm run build >/dev/null && node test/<name>.test.mjs` (ends `<N> passed` or `<N> test(s) passed.`; the harness stops at the first failure). Rust: `cd geml-parser-rs && cargo test` (every `test result: ok.`). The runtime reaches the parser through `integrations/gemflow/node_modules/@geml/geml`, a link to `geml-parser/`: rebuild the parser (`npm --prefix geml-parser run build`) after changing it, before a runtime test reads it. Spec and README text states current rules only.

---

## Decisions this plan makes (recorded in the spec and the profile by Tasks 1 and 8)

1. **`resets="<var> …"` on a `flow-transition`.** Whenever the edge is taken — the model's `flow_transition`, a person's move, an `auto` walk, an approval edge — each listed variable returns to its `flow-vars` `default` in the transition's own snapshot; `cause`, `by`, `signal` and `from` are those of any transition. The guard reads the variables as they were before. Any declared variable with a `default` may be listed, a signal's variable included: the workflow resets it, and the model still never writes one. Two errors: `flow-resets-var` (a name `flow-vars` does not declare) and `flow-resets-default` (a declared variable with no `default`). A rollback restores a snapshot and resets nothing. `gemflow verify` needs no change: it constrains no transition's variables. The attribute is registered in both parsers (`geml-parser/src/profiles.ts`, `geml-parser-rs/src/vocab.rs`), pinned by a case in `spec/profiles/geml-flow/conformance.json`, its checks by three cases in `checks.json`, and described in the profile reference, English and Chinese (§2, §2.2, §3.7, §4). The parser change is user-visible (`geml check` stops warning about the attribute), so `CHANGELOG.md` gets an `[Unreleased]` entry.
2. **The dev workflow's `#rework` resets `tests-pass` and `review-ready`**: after a move back, the tests must pass again, or a person tick `ready` again. The git signals (`pr-open`, `pr-merged`, `ci-pass`) are not reset: they mirror facts outside the journal, re-read at the next refresh. `review-done` is a note no guard reads.
3. **`geml media todo --check`** prints the list exactly as without the flag (`--json` included) and exits 1 while items remain, 0 when there are none — the way `geml check` exits on errors. Any other `geml media` verb refuses `--check` (exit 2: `--check 只给 todo 用：有待办时以 1 退出`), and `--check=…` is refused as `--json=…` is. TypeScript only: `geml-parser-rs` has media diagnostics (`src/check/media.rs`) and no media verbs — its one CLI, `examples/geml-rs.rs`, runs `check`, `codemap` and `style`. The parser's MCP servers (`src/mcp.ts`, `src/mcp-core.ts`) expose no media verb, so nothing changes there.
4. **The video workflow** follows spec §7.2: `flow-unit = "file:episodes/*.geml"`; seven states; auto edges `#to-assets` (`#script-ready`), `#to-cut` (`#assets-ready`), `#to-render` (`#cut-fresh`), `#to-review` (`#film-ready`), `#to-publish` (`#film-approved`), `#ship` (`#film-published`); the six signals of §7.2, `rendered` `only-in=#render`. The rework edges reset: `#reshoot` (`#review → #assets`) `assets-done no-stale rendered`, `#recut` (`#review → #cut`) `no-stale rendered`. One edge §7.2 does not have: `#fix-cut` (`#render → #cut`, `resets="no-stale"`), the way back from a failed render whose fix lives in a file. `approved` needs no reset: in `#review` it is always false, since ticking it leaves `#review`. The signals table puts `match` last and writes a regex `|` as `\|`, as the dev workflow does; the three command patterns read `npx`, `bunx`, `pnpm [dlx|exec]`, `yarn [dlx]`, `npm exec`, a path to `geml`, `@geml/geml[@version]` and `node …/geml.js|cli.js` in front of the verb, take `--check` and `--severity media-stale-clip=error` anywhere after it, and end a word at a blank or at `; & | ) ' "`. No state is `strict` (the spec has one blocking point); `#render` and `#review` carry `tools="read run search"` as advice, so an edit there is recorded as a deviation. All six non-final states take their context from `./guide.geml`.
5. **One file per episode is the rule.** `guide.geml` keeps an episode's script, its asset blocks and generation log, and its timeline in `episodes/epNN.geml`, with shared character cards and voice samples elsewhere, reached by `speaker=` / `of=`; and every command names the episode's file and passes `--root .`. References point one way (a library names the script it produced from), so `todo` from an episode sees only the records the episode reaches; and a signal reads the command line, never the file a command worked on. The library-document layout stays a named **待讨论** slot in spec §7.2.
6. **The to-do count** is display only (spec §7.2) and never a signal. The bridge counts on `refresh` and `board` alone — session start, and the board opening or refreshing — because counting hashes every asset file the episode reaches. It counts in process with `todo` from `@geml/geml/dist/media-verbs.js` over `profileIoFor(root)` from `@geml/geml/dist/host-fs.js`, so it answers what `geml media todo <file> --root <project> --json` lists, confinement included; the parser package has no `exports` map, so both deep paths resolve for tsc and esbuild, and the bundle stays Node-built-ins-only. The answer field is `todo: { item, count }`, or `null` when the work item's file declares no geml-media; the hooks module keeps the last one; the band draws `待办 N 项` (or `无待办` at 0) after the state, for the work item the count names only. `flow_status`, `gemflow mcp`, `/gemflow` and the board's rows do not show it.
7. **`Workspace.itemFile`**: under a file unit, the work item's file, project-relative and `/`-separated; `undefined` under a branch unit or with no work item.
8. **End-to-end tests** run the parser's own `todo --check`, `import`, `log` and `check` for real in a temporary project with no git, with `PATH` emptied so no `ffprobe` writes a `duration=`; the render, which needs ffmpeg, is reported to the bridge by its exit status, as the hooks module reports every Bash call. Rework is driven over the edges themselves: the model's `flow_transition` and a person's move.

---

## What the sources say (checked while drafting, against `0de7cf2`)

- Without `resets`, a rework edge cannot hold: signal variables keep their value until observed again, and the walk's bar covers only the first edge after a transition, so `flow_transition { to: "cut" }` from `#review` was measured walking `#cut → #render → #review` on the last pass's `no-stale` and `rendered` (`entered: ["render", "review"]`), and `#review → #assets` the same way on `assets-done`.
- An attribute the registry does not list is a warning in both parsers (``warning: unknown attribute `resets` for block type `flow-transition` `` from the TypeScript CLI, code `unknown-attribute`); the runtime's `checks.json` replay sees that warning among its diagnostics until the parser is rebuilt.
- `geml media todo --check` today exits 2: `MEDIA_FLAGS` is the one flag table of every media verb, and `rejectUnknownFlags` answers `unknown flag '--check' for 'media'`. The CLI makes stdout and stderr blocking before any verb runs, so `process.exit(1)` after printing loses nothing (`runCheck` does the same).
- `loadProject` follows `src`, `of`, `speaker`, `to` and a log's `output` / `prompt` / input refs; an asset's `src` resolves against its own document, so `--root .` changes only what may be read. From `episodes/ep01.geml`, a prompt whose output is logged in the same file is no longer a to-do; after the prompt is edited it is one again (stale), and a clip that uses its output makes `geml check --severity media-stale-clip=error` exit 1. `geml media import` writes `duration=` when `ffprobe` is on PATH; with `PATH` empty it does not. A cell that is one code span reads as the span's text, and `\|` in it reads as `|`.
- Measured in a scratch copy of the repository at `0de7cf2` with every step below applied: the runtime's `npm test` reported 689 tests, 0 failing; `claude plugin test .` passed the new hooks test (one existing test, "a bundle that was never built", failed there only because the scratch path is longer than the band it is drawn into); `cargo test` passed all 216 tests; the parser's suites passed but for three (`mcp`, `skill-install`, `sec-integrations`) that read `integrations/claude-plugin` and `integrations/vscode`, which the scratch copy did not hold; before the registry and runtime changes, the new cases failed as Task 1 Step 2 says; `gemflow check` and `geml check` print `ok: no diagnostics` for both workflow files and every edited document; the bundle grows from about 445 KB to about 500 KB.

---

## File map

| Path | Responsibility | Task |
|---|---|---|
| `geml-parser/src/profiles.ts`, `geml-parser/test/profiles.test.mjs`, `geml-parser-rs/src/vocab.rs`, `spec/profiles/geml-flow/conformance.json`, `spec/profiles/geml-flow/checks.json`, `spec/profiles/geml-flow/geml-flow-profile.md`, `…/geml-flow-profile_CN.md`, `integrations/gemflow/src/core/statechart.ts`, `integrations/gemflow/src/core/snapshot.ts`, `integrations/gemflow/test/supervisor.test.mjs`, `CHANGELOG.md` | `resets=` on a transition: vocabulary, checks, runtime | 1 |
| `integrations/gemflow/workflows/dev/flow.geml`, `…/workflows/dev/guide.geml`, `integrations/gemflow/test/dev-workflow.test.mjs` | the dev workflow's rework resets its evidence | 2 |
| `geml-parser/src/cli.ts`, `geml-parser/test/media-cli.test.mjs`, `CHANGELOG.md` | `geml media todo --check` | 3 |
| `integrations/gemflow/workflows/video/flow.geml`, `…/workflows/video/guide.geml` (new), `integrations/gemflow/test/video-workflow.test.mjs` (new), `integrations/gemflow/src/cli.ts`, `integrations/gemflow/test/cli.test.mjs` | the video workflow; the `init` usage row | 4 |
| `integrations/gemflow/src/media-todo.ts` (new), `integrations/gemflow/src/workspace.ts`, `integrations/gemflow/src/hosts/claude-code/protocol.ts`, `integrations/gemflow/src/bridge.ts`, `integrations/gemflow/test/media-todo.test.mjs` (new) | the episode's to-do count through the bridge | 5 |
| `integrations/gemflow/src/hosts/claude-code/band.ts`, `integrations/gemflow/hooks/register.tsx`, `integrations/gemflow/types/index.d.ts`, `integrations/gemflow/test/band.test.mjs`, `integrations/gemflow/tests/hooks.test.ts` | the count on the band | 6 |
| `integrations/gemflow/test/video-workflow.test.mjs` | end to end through the bridge | 7 |
| `integrations/gemflow/README.md`, `integrations/gemflow/README.zh.md`, `docs/design/specs/2026-10-11-gemflow-design.md` | the READMEs; the spec's §4.1, §4.3, §4.4, §7.2 | 8 |

---

### Task 1: `resets=` on a transition

**Files:** Modify `geml-parser/src/profiles.ts`, `geml-parser/test/profiles.test.mjs`, `geml-parser-rs/src/vocab.rs`, `spec/profiles/geml-flow/conformance.json`, `spec/profiles/geml-flow/checks.json`, `spec/profiles/geml-flow/geml-flow-profile.md`, `spec/profiles/geml-flow/geml-flow-profile_CN.md`, `integrations/gemflow/src/core/statechart.ts`, `integrations/gemflow/src/core/snapshot.ts`, `integrations/gemflow/test/supervisor.test.mjs`, `CHANGELOG.md`.

- [ ] **Step 1: Failing tests**

In `spec/profiles/geml-flow/conformance.json`, append to `cases`, in the file's own layout (both parsers replay it):

```json
    {
      "name": "a transition's resets= is admitted: the edge names the variables it returns to their defaults",
      "geml": "=== meta\nprofile = \"geml-flow/v1\"\n===\n\n=== flow-state {#review initial}\nWatch the film.\n===\n\n=== flow-transition {#recut from=#review to=#cut resets=\"no-stale rendered\"}\nThe cut changes.\n===\n\n=== flow-state {#cut}\nCut it again.\n===\n",
      "diagnostics": {
        "declared": [],
        "undeclared": [
          "unknown-block-type:warning",
          "unknown-block-type:warning",
          "unknown-block-type:warning"
        ]
      },
      "addresses": {
        "declared": [
          "#meta",
          "#review",
          "#recut",
          "#cut"
        ],
        "undeclared": [
          "#meta",
          "#review",
          "#recut",
          "#cut"
        ]
      }
    }
```

In `geml-parser/test/profiles.test.mjs`, in the test `geml-flow/v1：放行的属性键只挂在各自类型上`, after `assert.equal(v.attrs.get("flow-transition")?.has("requires"), true);` add:

```js
  assert.equal(v.attrs.get("flow-transition")?.has("resets"), true);
```

In `spec/profiles/geml-flow/checks.json`, append to `cases`, in the file's own layout:

```json
    {
      "name": "resets names declared variables that have a default, a signal's variable included",
      "meta": "flow-signals = \"#signals\"\n",
      "body": "=== table {#signals}\n| id | on | match | sets | when | only-in |\n|---|---|---|---|---|---|\n| t | command | npm test | ok | exit-zero | |\n===\n\n=== flow-state {#a initial}\nx\n===\n\n=== flow-state {#b}\nx\n===\n\n=== flow-state {#c final}\nx\n===\n\n=== flow-transition {#ab from=#a to=#b}\nx\n===\n\n=== flow-transition {#ba from=#b to=#a resets=\"ok\"}\nx\n===\n\n=== flow-transition {#bc from=#b to=#c}\nx\n===\n",
      "codes": []
    },
    {
      "name": "resets names a variable flow-vars does not declare",
      "meta": "",
      "body": "=== flow-state {#a initial}\nx\n===\n\n=== flow-state {#b final}\nx\n===\n\n=== flow-transition {#ab from=#a to=#b resets=\"gone\"}\nx\n===\n",
      "codes": ["error:flow-resets-var"]
    },
    {
      "name": "resets names a variable with no default to return to",
      "meta": "",
      "body": "=== flow-state {#a initial}\nx\n===\n\n=== flow-state {#b final}\nx\n===\n\n=== flow-transition {#ab from=#a to=#b resets=\"note\"}\nx\n===\n",
      "codes": ["error:flow-resets-default"]
    }
```

In `integrations/gemflow/test/supervisor.test.mjs`, insert before the line `// -- auto edges follow every kind of change -----------------------------------`:

```js
// -- resets: an edge returns variables to their defaults ----------------------------

/** The rework shape again, with the way back resetting the tests signal: after a move back, the tests must pass again. */
const resetChart = () => autoChart(
  state("a", " initial") + state("b") + edge("ab", "a", "b", " auto requires=#gt") + edge("ba", "b", "a", ' resets="t"'),
  "resets.geml");

test("an edge's resets return its variables to their defaults in the transition's own revision, whoever takes it", async () => {
  const chart = resetChart();
  assert.deepEqual(chart.transitions.map((t) => [t.id, t.resets]), [["ab", []], ["ba", ["t"]]]);
  const h = host();
  const sup = supOn(chart, h);
  sup.observeCommand(GREEN, metaFor(AT, "c1"));
  assert.equal(sup.snapshot.state, "b");
  assert.deepEqual(sup.humanTransition("a", metaFor(AT)), { ok: true, entered: ["a"] });
  const back = sup.snapshot;
  assert.deepEqual([back.cause, back.by, back.state, back.vars.t, back.vars.x], ["transition", "human", "a", false, true], "t is back to its default; x was not listed");
  assert.deepEqual(sup.observeCommand(GREEN, metaFor(AT, "c2")), { wrote: ["tests"], entered: ["b"] }, "a green run writes t again, so the edge forward is taken");
  const out = await sup.invoke("flow_transition", { to: "a" }, metaFor(AT, "v1"));
  assert.equal(out.ok, true);
  assert.deepEqual([sup.snapshot.state, sup.snapshot.vars.t, sup.snapshot.by], ["a", false, "model"]);
  assert.deepEqual(verifyJournal(readJournal(h.journal()), chart), []);
});

test("an auto edge resets what it lists before the walk reads the next state's guard", () => {
  // a -> b is auto on t and resets u; b -> c is auto on u: the walk stops in b, because the edge into it put u back.
  const chart = autoChart(
    state("a", " initial") + state("b") + state("c", " final")
    + edge("ab", "a", "b", ' auto requires=#gt resets="u"') + edge("bc", "b", "c", " auto requires=#gu"),
    "auto-resets.geml");
  const sup = supOn(chart, host());
  const LINT = { command: "npm run lint", exitCode: 0 };
  assert.deepEqual(sup.observeCommand(LINT, metaFor(AT, "c1")), { wrote: ["lint"], entered: [] });
  assert.deepEqual(sup.observeCommand(GREEN, metaFor(AT, "c2")), { wrote: ["tests"], entered: ["b"] });
  assert.deepEqual([sup.snapshot.state, sup.snapshot.vars.t, sup.snapshot.vars.u], ["b", true, false]);
  assert.deepEqual(sup.observeCommand(LINT, metaFor(AT, "c3")), { wrote: ["lint"], entered: ["c"] });
});
```

- [ ] **Step 2: Watch them fail**

Run:
```bash
cd geml-parser && npm run build >/dev/null && node test/profile-conformance.test.mjs 2>&1 | grep -m1 AssertionError; node test/profiles.test.mjs 2>&1 | grep -m1 -A3 AssertionError; cd ..
cd geml-parser-rs && cargo test --test profiles 2>&1 | grep -E "got|test result"; cd ..
cd integrations/gemflow && npm run build >/dev/null && node --test test/checks-conformance.test.mjs test/supervisor.test.mjs 2>&1 | grep -E "^ℹ fail|^✖ "; cd ../..
```
Expected: `AssertionError [ERR_ASSERTION]: geml-flow/v1 / a transition's resets= is admitted: …（声明时）`; an `AssertionError` with `false !== true`; Rust prints `diagnostics, declared: got  ["unknown-attribute:warning"]` and `test result: FAILED. 2 passed; 1 failed`; the runtime prints `ℹ fail 5`, naming the three `checks.json: resets …` cases and the two new supervisor tests.

- [ ] **Step 3: The registries**

In `geml-parser/src/profiles.ts`, in `"geml-flow/v1"`'s `attrs`, change

```ts
      "flow-transition": ["from", "to", "requires", "approval", "auto"],
```

to

```ts
      "flow-transition": ["from", "to", "requires", "approval", "auto", "resets"],
```

In `geml-parser-rs/src/vocab.rs`, in the `geml-flow/v1` profile's `attrs`, change

```rust
            ("flow-transition", &["from", "to", "requires", "approval", "auto"]),
```

to

```rust
            ("flow-transition", &["from", "to", "requires", "approval", "auto", "resets"]),
```

- [ ] **Step 4: The runtime**

In `integrations/gemflow/src/core/statechart.ts`:

1. In `interface Transition`, after the `auto: boolean;` field (and its comment), add:

```ts
  /** Variables returned to their flow-vars default when the edge is taken, by anyone; empty when it resets none. */
  resets: string[];
```

2. In `FlowCode`, change the last line `| "flow-signal-match" | "flow-auto-approval" | "flow-auto-cycle" | "flow-strict-no-tools";` to:

```ts
  | "flow-signal-match" | "flow-auto-approval" | "flow-auto-cycle" | "flow-strict-no-tools"
  | "flow-resets-var" | "flow-resets-default";
```

3. In `loadStatechart`'s transitions loop, replace the line that builds `t` with:

```ts
    const t: Transition = { id, line, from: from ?? "", to: to ?? "", approval: b.attrs["approval"] === true, auto: b.attrs["auto"] === true, resets: nameList(b.attrs["resets"]) ?? [], body: bodyOf(b.id) };
    // A reset returns a variable to its default, so it needs a declared variable that has one.
    for (const v of t.resets) {
      const decl = vars?.properties && Object.hasOwn(vars.properties, v) ? vars.properties[v] : undefined;
      if (!decl) err("flow-resets-var", `transition #${id}: resets= names "${v}", which flow-vars does not declare`, line);
      else if (decl.default === undefined) err("flow-resets-default", `transition #${id}: resets= names "${v}", which has no default to return to`, line);
    }
```

In `integrations/gemflow/src/core/snapshot.ts`, in `applyTransition`, replace

```ts
  return { ok: true, next: child(snap, meta, { state: t.to, vars: snap.vars, cause: "transition", from: snap.state }) };
```

with

```ts
  // The guard read the variables as they were; the edge's resets go back to their defaults in this same revision.
  const defaults = t.resets.length > 0 && sc.vars ? defaultsOf(sc.vars) : {};
  const vars = t.resets.length > 0 ? { ...snap.vars, ...Object.fromEntries(t.resets.map((v) => [v, defaults[v]!])) } : snap.vars;
  return { ok: true, next: child(snap, meta, { state: t.to, vars, cause: "transition", from: snap.state }) };
```

- [ ] **Step 5: The profile reference and the changelog**

In `spec/profiles/geml-flow/geml-flow-profile.md`:

1. In the §2 table, change the `flow-transition` row to:

```markdown
| `flow-transition` | **flow** | `from` `to` `requires` `approval` `auto` `resets` | One edge. The body is how the model is told about it. |
```

2. In §2.2, after the `auto` bullet, add:

```markdown
- `resets="x y"` — variables, space separated, that return to their `flow-vars` `default` whenever the edge is taken: by the model, by a person, or by an `auto` walk (§3.7). The guard reads the variables as they were; the transition's own revision carries the reset values, and its `cause`, `by` and `signal` are those of any transition. A signal's variable may be listed: the workflow resets it, and the model still never writes it. Each name must be a declared variable with a `default` (§4). An edge that sends the workflow back for rework uses it, so that what the last pass established must be observed again.
```

3. In §3.7, after the bullet ``- An `auto` edge that needs `approval` is never taken automatically.``, add:

```markdown
- An edge the walk takes resets what its `resets` lists, as any taking of that edge does (§2.2), before the walk reads the next state's `auto` edge.
```

4. In the §4 table, before the `flow-unit` row, add:

```markdown
| `flow-resets-var` | error | `resets=` names a variable `flow-vars` does not declare |
| `flow-resets-default` | error | `resets=` names a declared variable that has no `default` to return to |
```

In `spec/profiles/geml-flow/geml-flow-profile_CN.md`, the same four places:

```markdown
| `flow-transition` | **flow** | `from` `to` `requires` `approval` `auto` `resets` | 一条边。体是告诉模型这条边是什么。 |
```

```markdown
- `resets="x y"` —— 空格分隔的变量名：这条边每被走一次，不论由谁——模型、人，还是 `auto` 边的连走（§3.7）——这些变量都回到 `flow-vars` 里的 `default`。守卫读的是走之前的值；这次转换自己的修订里记的是复位后的值，它的 `cause`、`by`、`signal` 与别的转换一样。可以列信号的变量：复位它的是流程，模型仍然写不了它。每个名字都必须是声明过、带 `default` 的变量（§4）。把流程送回去返工的边用它，让上一轮确立的事实必须重新观测一次。
```

```markdown
- 连走时走过的边同样按它的 `resets` 复位变量（§2.2），然后才看下一个状态的 `auto` 边。
```

```markdown
| `flow-resets-var` | error | `resets=` 里的名字未在 `flow-vars` 声明 |
| `flow-resets-default` | error | `resets=` 里的变量没有 `default`，无处可回 |
```

In `CHANGELOG.md`, insert as the first bullet under `## [Unreleased]` (a blank line after it):

```markdown
- **gemflow**: a `flow-transition` may carry `resets="<var> …"`. Whenever the
  edge is taken — by the model, a person or an `auto` walk — each listed
  variable returns to its `flow-vars` default in the transition's own revision,
  so an edge that sends a workflow back for rework has the last pass's
  evidence observed again. Both parsers admit the attribute on `flow-transition`;
  `gemflow check` reports a name `flow-vars` does not declare
  (`flow-resets-var`) and one with no default to return to
  (`flow-resets-default`).
```

- [ ] **Step 6: Run the suites once**

Run:
```bash
pgrep -f 'codemap/serve.mjs' | while read -r p; do kill "$p"; done
cd geml-parser && npm test > /tmp/gemflow-c-parser.log 2>&1; echo "parser exit=$?"; tail -1 /tmp/gemflow-c-parser.log; cd ..
cd geml-parser-rs && cargo test > /tmp/gemflow-c-rust.log 2>&1; echo "rust exit=$?"; grep -c "test result: ok" /tmp/gemflow-c-rust.log; cd ..
cd integrations/gemflow && npm test > /tmp/gemflow-c.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-c.log; cd ../..
for f in spec/profiles/geml-flow/geml-flow-profile.md spec/profiles/geml-flow/geml-flow-profile_CN.md; do node geml-parser/dist/cli.js check --root . "$f" >/dev/null 2>&1; echo "$f $?"; done
```
Expected: `parser exit=0`, the log ending `<N> suites passed in …`; `rust exit=0`, and no `FAILED` in the log; `exit=0`, `ℹ fail 0`; both profile files ` 0`.

- [ ] **Step 7: Commit**

```bash
git add geml-parser/src/profiles.ts geml-parser/test/profiles.test.mjs geml-parser-rs/src/vocab.rs spec/profiles/geml-flow/conformance.json spec/profiles/geml-flow/checks.json spec/profiles/geml-flow/geml-flow-profile.md spec/profiles/geml-flow/geml-flow-profile_CN.md integrations/gemflow/src/core/statechart.ts integrations/gemflow/src/core/snapshot.ts integrations/gemflow/test/supervisor.test.mjs CHANGELOG.md
git commit -m "feat(gemflow): a transition's resets= returns variables to their defaults

Whenever the edge is taken - the model's flow_transition, a person's move,
an auto walk - each listed variable goes back to its flow-vars default in
the transition's own revision, after the guard read the values as they were.
A rework edge uses it so the last pass's evidence must be observed again.
gemflow check reports an undeclared name (flow-resets-var) and one with no
default (flow-resets-default). Both parsers admit the attribute, pinned by
the profile's conformance case; checks.json pins the two checks, and the
profile reference describes it in both languages."
```

---

### Task 2: The dev workflow's rework resets its evidence

**Files:** Modify `integrations/gemflow/workflows/dev/flow.geml`, `integrations/gemflow/workflows/dev/guide.geml`, `integrations/gemflow/test/dev-workflow.test.mjs`.

- [ ] **Step 1: Failing tests**

In `integrations/gemflow/test/dev-workflow.test.mjs`:

1. In the test `five states in order on a branch unit; …`, after `assert.deepEqual([edge("ship").auto, edge("ship").requiresId], [true, "prod-live"]);` add:

```js
  assert.deepEqual(edge("rework").resets, ["tests-pass", "review-ready"]);
```

2. Replace the whole test `rework: a person's move from #review back to #build stays in #build though #ready-for-review still holds; the next green test run goes forward again` with:

```js
test("rework: a person's move from #review back to #build resets tests-pass and review-ready, so only a new green run goes forward again", () => {
  const root = gitRepo("feat/r");
  assert.equal(spawnSync(process.execPath, [BUNDLE, "init", "--template", "dev"], { cwd: root, encoding: "utf8" }).status, 0);
  const gh = fakeGh();
  const ran = (callId, exitCode) => hook(root, { op: "after", tool: "Bash", callId, input: { command: "npm test" }, isError: exitCode !== 0, exitCode, gitOperation: false });
  ran("t1", 0);
  gh.set({ pr: "OPEN" });
  assert.equal(hook(root, { op: "refresh" }, gh.env).shell.status.state.id, "review");
  const back = hook(root, { op: "advance", to: "build" });
  assert.deepEqual([back.entered, back.shell.status.state.id], [["build"], "build"]);
  const vars = back.shell.status.vars;
  assert.deepEqual([vars["tests-pass"], vars["review-ready"], vars["pr-open"]], [false, false, true], "the edge cleared the last pass's evidence; git's facts stay");
  assert.equal(back.shell.status.next.find((t) => t.to === "review").holds, false);
  assert.equal(ran("t2", 1).shell.status.state.id, "build");
  const again = ran("t3", 0);
  assert.deepEqual([again.entered, again.shell.status.state.id], [["review"], "review"]);
});
```

- [ ] **Step 2: Watch them fail**

Run: `cd integrations/gemflow && npm run build >/dev/null && node --test test/dev-workflow.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 2`.

- [ ] **Step 3: The edge, and its guide**

In `integrations/gemflow/workflows/dev/flow.geml`, replace

```geml
=== flow-transition {#rework from=#review to=#build}
review 要求改动。
===
```

with

```geml
=== flow-transition {#rework from=#review to=#build resets="tests-pass review-ready"}
review 要求改动。测试结果和 ready 的勾选随之清掉：测试要重新跑绿，或者由人重新勾选 ready。
===
```

In `integrations/gemflow/workflows/dev/guide.geml`, in `# 评审 {#review}`, replace the line

```text
PR 已开。逐条处理 review 意见；要大改时可以回到 #build。CI 的结论和合并状态由
```

with

```text
PR 已开。逐条处理 review 意见；要大改时可以回到 #build：这条边把 `tests-pass` 与
`review-ready` 清回 false，回去之后测试要重新跑绿（测试只在 CI 里跑时，请人重新勾选
"可以进入评审"），流程才再进入 #review。CI 的结论和合并状态由
```

- [ ] **Step 4: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-c.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-c.log; node dist/cli.js check workflows/dev/flow.geml; cd ../..`
Expected: `exit=0`, `ℹ fail 0`; `ok: no diagnostics`.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/workflows/dev/flow.geml integrations/gemflow/workflows/dev/guide.geml integrations/gemflow/test/dev-workflow.test.mjs
git commit -m "feat(gemflow): the dev workflow's rework resets tests-pass and review-ready

A move from #review back to #build clears the last pass's green run and
ready tick, so only new evidence takes the branch forward again: a passing
test run, a person's ready, or a merged PR. git's facts are not reset; they
are read again at the next refresh."
```

---

### Task 3: `geml media todo --check`

**Files:** Modify `geml-parser/src/cli.ts`, `geml-parser/test/media-cli.test.mjs`, `CHANGELOG.md`.

- [ ] **Step 1: Failing tests**

In `geml-parser/test/media-cli.test.mjs`, insert before the test `report：cast 与 stats 都出 CSV，别的 --kind 拒绝`:

```js
test("todo --check：清单照常打印，有待办时以 1 退出、没有时以 0 退出 —— 流程的命令信号读这个退出码", () => {
  const p = project();
  try {
    const plain = run(["todo", p.at("lib.geml")]);
    const t = run(["todo", p.at("lib.geml"), "--check"]);
    assert.equal(t.code, 1, t.err);
    assert.equal(t.out, plain.out, "清单和不带 --check 时一字不差");
    const j = run(["todo", "--check", p.at("lib.geml"), "--json"]);
    assert.equal(j.code, 1, j.err);
    assert.ok(JSON.parse(j.out).some((i) => i.kind === "generate"), j.out);

    writeFileSync(p.at("bare.geml"), META
      + `=== media-asset {#only src=clip.mp4 sha256=${sha(CLIP)} kind=video duration=6}\n===\n`);
    const none = run(["todo", p.at("bare.geml"), "--check"]);
    assert.equal(none.code, 0, none.err);
    assert.match(none.err, /没有待办/);
    const noneJson = run(["todo", p.at("bare.geml"), "--check", "--json"]);
    assert.deepEqual([noneJson.code, JSON.parse(noneJson.out)], [0, []]);
  } finally { p.drop(); }
});

test("--check 只给 todo：别的动词拒绝它，写成 --check=… 同样拒绝", () => {
  const p = project();
  try {
    const r = run(["report", p.at("lib.geml"), "--check"]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.err, /--check 只给 todo 用/);
    const eq = run(["todo", p.at("lib.geml"), "--check=yes"]);
    assert.equal(eq.code, 2, eq.out);
    assert.match(eq.err, /--check 不带值：写成 --check/);
  } finally { p.drop(); }
});
```

- [ ] **Step 2: Watch them fail**

Run: `cd geml-parser && npm run build >/dev/null && node test/media-cli.test.mjs 2>&1 | grep -E "AssertionError|!==|passed"; cd ..`
Expected: `AssertionError [ERR_ASSERTION]: error: unknown flag '--check' for 'media'. …` and `2 !== 1`, and no `test(s) passed.` line.

- [ ] **Step 3: The flag**

In `geml-parser/src/cli.ts`:

1. In `MEDIA_HELP`, replace the row

```ts
  "  todo   <entry.geml> [--root d] [--json]        待办：没产出的提示词、没配音的台词",
```

with these two rows (the second is indented by 49 spaces inside the string, like the `build` and `compose` continuations):

```ts
  "  todo   <entry.geml> [--root d] [--json] [--check]",
  "                                                 待办：没产出的提示词、没配音的台词；--check：有待办时以 1 退出",
```

2. In `MEDIA_FLAGS`, change `bool: ["--burn-subs", "--json"],` to `bool: ["--burn-subs", "--check", "--json"],`.

3. In `runMedia`, right after the loop that refuses `--name=value` spellings and before `const root = flag(rest, "--root");`, insert:

```ts
  // --check 只属于 todo：别的动词收下它却不照做，就是「该拒绝的时候静默成功」。
  if (verb !== "todo" && rest.includes("--check")) fail("--check 只给 todo 用：有待办时以 1 退出");
```

4. Replace the `todo` branch

```ts
  if (verb === "todo") {
    const items = mediaTodo(seeds, io);
    if (rest.includes("--json")) { console.log(JSON.stringify(items, null, 2)); return; }
    if (items.length === 0) { console.error("todo: 没有待办"); return; }
    const word = { voice: "配音", composite: "合成", generate: "生成" };
    for (const it of items) console.log(word[it.kind] + "  " + it.address + "  (" + it.mode + ")");
    return;
  }
```

with

```ts
  if (verb === "todo") {
    const items = mediaTodo(seeds, io);
    // --check：清单照常打印，有待办时以 1 退出，和 `geml check` 有错误时一样 —— 流程的命令信号读的就是这个退出码。
    const failing = rest.includes("--check") && items.length > 0;
    if (rest.includes("--json")) { console.log(JSON.stringify(items, null, 2)); if (failing) process.exit(1); return; }
    if (items.length === 0) { console.error("todo: 没有待办"); return; }
    const word = { voice: "配音", composite: "合成", generate: "生成" };
    for (const it of items) console.log(word[it.kind] + "  " + it.address + "  (" + it.mode + ")");
    if (failing) process.exit(1);
    return;
  }
```

- [ ] **Step 4: The changelog**

In `CHANGELOG.md`, insert as the first bullet under `## [Unreleased]` (a blank line after it):

```markdown
- **`geml media todo --check`** exits 1 while to-do items remain and 0 when
  there are none — the way `geml check` exits on errors — and prints the list
  exactly as it does without the flag, `--json` included. A workflow's command
  signal reads that exit status: Gemflow's video workflow moves an episode on
  from its asset stage when the check passes. Any other `geml media` verb
  refuses `--check`, and `--check=…` is refused as `--json=…` is.
```

- [ ] **Step 5: Run the suite once**

Run: `pgrep -f 'codemap/serve.mjs' | while read -r p; do kill "$p"; done; cd geml-parser && npm test > /tmp/gemflow-c-parser.log 2>&1; echo "exit=$?"; tail -1 /tmp/gemflow-c-parser.log; node test/media-cli.test.mjs | tail -1; cd ..`
Expected: `exit=0`, the log ending `<N> suites passed in …`; `44 test(s) passed.`

- [ ] **Step 6: Commit**

```bash
git add geml-parser/src/cli.ts geml-parser/test/media-cli.test.mjs CHANGELOG.md
git commit -m "feat(media): geml media todo --check exits 1 while to-do items remain

The list prints as it does without the flag, --json included; only the exit
status says whether anything is left, the way geml check reports errors. A
workflow's command signal reads it: Gemflow's video workflow leaves its asset
stage when the check passes. Any other media verb refuses --check. The Rust
parser has no media verbs and the MCP servers expose none, so this is the
TypeScript CLI alone."
```

---

### Task 4: The video workflow

**Files:** Create `integrations/gemflow/workflows/video/flow.geml`, `integrations/gemflow/workflows/video/guide.geml`, `integrations/gemflow/test/video-workflow.test.mjs`; modify `integrations/gemflow/src/cli.ts` (the `init` usage row), `integrations/gemflow/test/cli.test.mjs` (the template list in one message).

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/video-workflow.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { commandSignals, onlyInRefusal } from "../dist/core/signals.js";
import { blockText } from "../dist/core/blocks.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FLOW = fileURLToPath(new URL("../workflows/video/flow.geml", import.meta.url));
const GUIDE = readFileSync(new URL("../workflows/video/guide.geml", import.meta.url), "utf8");
const sc = () => loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml").statechart;

test("the video workflow checks with no diagnostics, and every context reference resolves to a guide block", () => {
  const r = spawnSync(process.execPath, [CLI, "check", FLOW], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^ok: no diagnostics$/m);
  const resolveRef = (ref) => ref.startsWith("./guide.geml#") && blockText(GUIDE, ref.slice("./guide.geml#".length)) !== undefined;
  assert.deepEqual(loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml", { resolveRef }).diagnostics, []);
});

test("seven states on an episode-file unit; the signals, the edges with what they reset, and the one blocking point", () => {
  const s = sc();
  assert.deepEqual(s.unit, { kind: "file", glob: "episodes/*.geml" });
  assert.deepEqual([...s.states.values()].map((x) => [x.id, x.context, x.strict, x.tools ?? null]), [
    ["script", ["./guide.geml#script"], false, null],
    ["assets", ["./guide.geml#assets"], false, null],
    ["cut", ["./guide.geml#cut"], false, null],
    ["render", ["./guide.geml#render"], false, ["read", "run", "search"]],
    ["review", ["./guide.geml#review"], false, ["read", "run", "search"]],
    ["publish", ["./guide.geml#publish"], false, null],
    ["done", [], false, null],
  ]);
  assert.deepEqual(s.signals.map((x) => [x.id, x.on, x.sets, x.when, x.onlyIn]), [
    ["script-ok", "manual", "script-final", "checked", []],
    ["todo-clear", "command", "assets-done", "exit-zero", []],
    ["fresh", "command", "no-stale", "exit-zero", []],
    ["rendered", "command", "rendered", "exit-zero", ["render"]],
    ["approved", "manual", "approved", "checked", []],
    ["published", "manual", "published", "checked", []],
  ]);
  assert.deepEqual(s.transitions.map((t) => [t.id, t.from, t.to, t.auto, t.approval, t.requiresId ?? null, t.resets]), [
    ["to-assets", "script", "assets", true, false, "script-ready", []],
    ["to-cut", "assets", "cut", true, false, "assets-ready", []],
    ["to-render", "cut", "render", true, false, "cut-fresh", []],
    ["to-review", "render", "review", true, false, "film-ready", []],
    ["fix-cut", "render", "cut", false, false, null, ["no-stale"]],
    ["reshoot", "review", "assets", false, false, null, ["assets-done", "no-stale", "rendered"]],
    ["recut", "review", "cut", false, false, null, ["no-stale", "rendered"]],
    ["to-publish", "review", "publish", true, false, "film-approved", []],
    ["ship", "publish", "done", true, false, "film-published", []],
  ]);
});

test("the signal patterns read the spellings people type: launchers, node …/cli.js, the flag anywhere after the verb", () => {
  const s = sc();
  const read = (command, exitCode = 0) => Object.fromEntries(commandSignals(s, { command, exitCode }).map((x) => [x.id, x.value]));
  assert.deepEqual(read("geml media todo episodes/ep01.geml --root . --check"), { "todo-clear": true });
  assert.deepEqual(read("geml media todo --check episodes/ep01.geml", 1), { "todo-clear": false });
  assert.deepEqual(read("npx -y @geml/geml media todo episodes/ep01.geml --json --check"), { "todo-clear": true });
  assert.deepEqual(read("pnpm exec geml media todo episodes/ep01.geml --check"), { "todo-clear": true });
  assert.deepEqual(read("node geml-parser/dist/cli.js media todo episodes/ep01.geml --check"), { "todo-clear": true });
  assert.deepEqual(read("cd show && geml media todo episodes/ep01.geml --check"), { "todo-clear": true });
  assert.deepEqual(read("geml media todo episodes/ep01.geml"), {}, "without --check the exit status says nothing");
  assert.deepEqual(read("geml media todo episodes/ep01.geml --checkout"), {});
  assert.deepEqual(read("geml media todo episodes/ep01.geml --check | tee todo.txt"), {}, "a pipe: not a plain && chain");
  assert.deepEqual(read("geml check episodes/ep01.geml --root . --severity media-stale-clip=error"), { fresh: true });
  assert.deepEqual(read("geml check episodes/ep01.geml --severity media-stale-clip=warning"), {});
  assert.deepEqual(read("geml check episodes/ep01.geml"), {});
  assert.deepEqual(read("npx @geml/geml media build episodes/ep01.geml --out renders/ep01.mp4"), { rendered: true });
  assert.deepEqual(read("geml media export episodes/ep01.geml --to player -o play.html"), {});
  for (const command of [
    "geml media build episodes/ep01.geml --out renders/ep01.mp4",
    "cd show && npx @geml/geml media build episodes/ep01.geml --out x.mp4",
    'bash -c "geml media build episodes/ep01.geml"',
    'geml "media" build episodes/ep01.geml',
    "node geml-parser/dist/cli.js media build episodes/ep01.geml",
  ]) {
    assert.match(onlyInRefusal(s, "cut", command), /may only run in #render \(signal rendered\); the workflow is in #cut/, command);
    assert.equal(onlyInRefusal(s, "render", command), undefined, command);
  }
  assert.equal(onlyInRefusal(s, "cut", "geml media export episodes/ep01.geml --to player"), undefined);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npm run build >/dev/null; node --test test/video-workflow.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|ENOENT"; cd ../..`
Expected: `ENOENT` on `workflows/video/guide.geml` (the module fails to load).

- [ ] **Step 3: Write the workflow**

Create `integrations/gemflow/workflows/video/flow.geml`:

```geml
=== meta
title        = "视频流程"
profile      = "geml-flow/v1"
flow-unit    = "file:episodes/*.geml"
flow-tools   = "read write run search"
flow-signals = "#signals"
===

%% 一集是一个工作项：episodes/ 下的每个 .geml 文件，一份 geml-media 文档。
%% #script → #assets → #cut → #render → #review → #publish → #done。封路点只有
%% 一个：geml media build 只能在 #render 运行，而进入 #render 要求 geml check
%% 没有过期片段。#render 与 #review 的工具清单只提醒：这两个阶段改文件会记一次
%% 偏离。三个 manual 信号只能由人勾选。
%%
%% 审片要返工时走 #reshoot 回 #assets（重出镜头）或 #recut 回 #cut（改剪辑）；出片
%% 失败、要改剪辑时走 #fix-cut 回 #cut。这三条边用 resets 把上一轮的信号清回默认值，
%% 所以待办检查、过期检查与出片都要重新过一遍。#review 里 approved 总是 false（勾上
%% 它流程就离开了 #review），不必复位。
%%
%% 命令信号的 match 是正则。有 sets 的信号从 `&&` 链里每一条简单命令的开头匹配，
%% 所以 npx、pnpm、yarn、bunx、node …/cli.js 这类启动器写在正则里；有 only-in
%% 的信号还在整行里搜索。正则看不见命令作用在哪个文件上：guide.geml 要求每条
%% 命令都写本集的文件。表格里正则的 `|` 写成 `\|`。

=== flow-vars {#vars}
{ "type": "object", "additionalProperties": false, "properties": {
    "goal":         { "type": "string", "description": "这一集要讲成什么，一句话" },
    "script-final": { "type": "boolean", "default": false },
    "assets-done":  { "type": "boolean", "default": false },
    "no-stale":     { "type": "boolean", "default": false },
    "rendered":     { "type": "boolean", "default": false },
    "approved":     { "type": "boolean", "default": false },
    "published":    { "type": "boolean", "default": false } } }
===

=== table {#signals caption="阶段信号"}
| id         | on      | sets         | when      | only-in | match |
|------------|---------|--------------|-----------|---------|-------|
| script-ok  | manual  | script-final | checked   |         | 剧本定稿 |
| todo-clear | command | assets-done  | exit-zero |         | `(?:(?:(?:npx\|bunx\|pnpm(?:\s+(?:dlx\|exec))?\|yarn(?:\s+dlx)?\|npm\s+exec)(?:\s+-\S*)*\s+)?(?:\S*/)?geml(?:@\S+)?\|node\s+\S*/(?:geml\|cli)\.js)\s+media\s+todo\s(?:.*\s)?--check(?![^\s;&\|)'"])` |
| fresh      | command | no-stale     | exit-zero |         | `(?:(?:(?:npx\|bunx\|pnpm(?:\s+(?:dlx\|exec))?\|yarn(?:\s+dlx)?\|npm\s+exec)(?:\s+-\S*)*\s+)?(?:\S*/)?geml(?:@\S+)?\|node\s+\S*/(?:geml\|cli)\.js)\s+check\s(?:.*\s)?--severity\s+media-stale-clip=error(?![^\s;&\|)'"])` |
| rendered   | command | rendered     | exit-zero | #render | `(?:(?:(?:npx\|bunx\|pnpm(?:\s+(?:dlx\|exec))?\|yarn(?:\s+dlx)?\|npm\s+exec)(?:\s+-\S*)*\s+)?(?:\S*/)?geml(?:@\S+)?\|node\s+\S*/(?:geml\|cli)\.js)\s+media\s+build(?![^\s;&\|)'"])` |
| approved   | manual  | approved     | checked   |         | 审片通过 |
| published  | manual  | published    | checked   |         | 已发布 |
===

=== flow-state {#script initial context="./guide.geml#script"}
写这一集的剧本：分镜提示词与台词。剧本定稿由人在看板上勾选。
===

=== flow-state {#assets context="./guide.geml#assets"}
按待办清单生成素材、配音，每一次生成都登记进生成日志。待办检查的结果由信号记录，不需要你报告。
===

=== flow-state {#cut context="./guide.geml#cut"}
把素材排上时间线，对齐配音与字幕。过期检查的结果由信号记录。
===

=== flow-state {#render tools="read run search" context="./guide.geml#render"}
出片。这一阶段只运行出片命令，不改剧本和剪辑。
===

=== flow-state {#review tools="read run search" context="./guide.geml#review"}
成片等人审片。
===

=== flow-state {#publish context="./guide.geml#publish"}
审片通过。发布这一集。
===

=== flow-state {#done final}
===

=== data {#script-ready format=json}
{ "type": "object", "properties": { "script-final": { "const": true } } }
===

=== data {#assets-ready format=json}
{ "type": "object", "properties": { "assets-done": { "const": true } } }
===

=== data {#cut-fresh format=json}
{ "type": "object", "properties": { "no-stale": { "const": true } } }
===

=== data {#film-ready format=json}
{ "type": "object", "properties": { "rendered": { "const": true } } }
===

=== data {#film-approved format=json}
{ "type": "object", "properties": { "approved": { "const": true } } }
===

=== data {#film-published format=json}
{ "type": "object", "properties": { "published": { "const": true } } }
===

=== flow-transition {#to-assets from=#script to=#assets auto requires=#script-ready}
剧本定稿。
===

=== flow-transition {#to-cut from=#assets to=#cut auto requires=#assets-ready}
没有待办：提示词都有产出，台词都配了音，过期的都重做了。
===

=== flow-transition {#to-render from=#cut to=#render auto requires=#cut-fresh}
geml check 没有过期片段。
===

=== flow-transition {#to-review from=#render to=#review auto requires=#film-ready}
出片成功。
===

=== flow-transition {#fix-cut from=#render to=#cut resets="no-stale"}
出片失败，要回去改剪辑。过期检查的结果随之清掉，改完要重新检查。
===

=== flow-transition {#reshoot from=#review to=#assets resets="assets-done no-stale rendered"}
要重出镜头。待办检查、过期检查与出片的结果随之清掉，都要重新过一遍。
===

=== flow-transition {#recut from=#review to=#cut resets="no-stale rendered"}
要改剪辑。过期检查与出片的结果随之清掉，都要重新过一遍。
===

=== flow-transition {#to-publish from=#review to=#publish auto requires=#film-approved}
审片通过。
===

=== flow-transition {#ship from=#publish to=#done auto requires=#film-published}
已发布。
===
```

Create `integrations/gemflow/workflows/video/guide.geml`:

```geml
=== meta
title   = "视频流程 · 各阶段说明"
profile = "geml-flow/v1"
===

# 剧本 {#script}

一集一个文件：`episodes/epNN.geml`，它的 `=== meta` 声明 `profile = "geml-media/v1"`。
分镜提示词写成 `media-text {#s01 .prompt shot=1}` 块，台词写成
`media-text {#l01 .line speaker=cast.geml#hero}` 块；几集共用的角色卡与配音样本放在
`cast.geml` 这类文档里，用 `speaker=`、`of=` 引用。本集生成的素材块和生成日志（一个
`data {#gen-log .gen-log format=jsonl}` 块）都写在本集文件里：引用是有方向的，写在
一处，从本集出发才看得见每一次生成。

下面每条命令都在项目根目录运行，写本集的文件，并带 `--root .`：信号只看命令行，
看不见命令作用在哪个文件上。`geml check episodes/epNN.geml --root .` 没有错误之后，
请人在看板上勾选"剧本定稿"（或者在他自己的终端运行 `gemflow mark script-ok`）——
这一项只能由人勾选。勾选后流程自动进入 #assets。

# 素材 {#assets}

`geml media todo episodes/epNN.geml --root . --json` 列出这一集的待办：没有产出的
提示词、没有配音的台词、没有合成的分层镜头，以及输入改过、要重做的（标 `stale`）。
每一项的 `prompt` 是展开之后发给模型的那串字。

每做好一件，登记两样东西：`geml media import <文件> --into episodes/epNN.geml --root .`
加一个带 `sha256` 的素材块；
`geml media log episodes/epNN.geml --root . --output '#素材id' --model <模型> --mode t2i --prompt '#提示词id'`
记下这次生成（配音用 `--mode tts`，`--prompt` 指向那句台词）。一批生成可以先写成
清单 JSON，再用 `geml media import <清单.json> --into episodes/epNN.geml --root .` 一次
登记素材与记录。

都做完之后运行 `geml media todo episodes/epNN.geml --root . --check`：还有待办时它把
清单打出来并以 1 退出；没有待办时以 0 退出，流程自动进入 #cut。

# 剪辑 {#cut}

在本集文件里写时间线：一个 `media {#cut tracks="v:video a:audio s:prose"}` 块，每一刀
是其中的一个 `media-clip`，`src=` 指向素材块，静帧要写 `duration=`。
`geml media lay episodes/epNN.geml --root . --over '#c03'` 按配音时长给出 `offset` 与
`duration` 的初值；`geml media export episodes/epNN.geml --root . --to player -o play.html`
出一个浏览器能放的预览。

剪好之后运行 `geml check episodes/epNN.geml --root . --severity media-stale-clip=error`：
有片段用到过期的素材（提示词或输入改过，却没有重新生成）时报错，有别的错误时同样
以 1 退出；以 0 退出时流程自动进入 #render。

# 出片 {#render}

运行 `geml media build episodes/epNN.geml --root . --out renders/epNN.mp4`（要装 ffmpeg；
字幕默认另出一个 `.srt`，加 `--burn-subs` 才烧进画面）。出片命令只能在这一阶段运行，
在别的阶段会被拒绝；这一阶段也不改剧本和剪辑，改了会记一次偏离。以 0 退出时流程
自动进入 #review。

出片失败、要回去改剪辑时，用 `flow_transition` 走 #fix-cut 回到 #cut：它把 `no-stale`
清回 false，改完要重新跑过期检查，才再进入 #render。

# 审片 {#review}

成片等人看。人看完在看板上勾选"审片通过"，流程进入 #publish——这一项只能由人勾选。

要返工时，重出镜头走 #reshoot 回到 #assets，改剪辑走 #recut 回到 #cut：模型用
`flow_transition`，人在看板上点这条边。#reshoot 把 `assets-done`、`no-stale` 与
`rendered` 清回 false，#recut 清掉 `no-stale` 与 `rendered`，所以待办检查、过期检查与
出片都要重新过一遍，新出的片也要人重新审。

# 发布 {#publish}

把这一集发布出去，发到哪里由项目决定。发布之后请人在看板上勾选"已发布"，流程
进入 #done。
```

No line of either file may begin with `#` unless it is a heading, and no line may begin with `===` inside a block body: rewrap rather than let a `#state` or a quoted fence start a line.

- [ ] **Step 4: The usage row names it, and the CLI test lists it**

In `integrations/gemflow/src/cli.ts`, in the `init` row of `USAGE`, change `--template coding|dev|refund` to `--template coding|dev|refund|video`.

`init` names every bundled workflow when it refuses an unknown template, so in `integrations/gemflow/test/cli.test.mjs` change

```js
  assert.match(bad.err, /unknown template "nonsense"; expected coding or dev or refund/);
```

to

```js
  assert.match(bad.err, /unknown template "nonsense"; expected coding or dev or refund or video/);
```

- [ ] **Step 5: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-c.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-c.log; node dist/cli.js check workflows/video/flow.geml; node ../../geml-parser/dist/cli.js check workflows/video/guide.geml; cd ../..`
Expected: `exit=0`, `ℹ fail 0`; both checks print `ok: no diagnostics`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/workflows/video/flow.geml integrations/gemflow/workflows/video/guide.geml integrations/gemflow/test/video-workflow.test.mjs integrations/gemflow/src/cli.ts integrations/gemflow/test/cli.test.mjs
git commit -m "feat(gemflow): the built-in video workflow

One work item per episode file (flow-unit = \"file:episodes/*.geml\"):
#script → #assets → #cut → #render → #review → #publish → #done over
geml-media, the signals table of spec §7.2 with patterns that read the usual
launchers, and one blocking point: geml media build runs only in #render,
which a clean stale check opens. #reshoot, #recut and #fix-cut go back with
the last pass's signals reset. #render and #review advise read, run and
search. Each stage's context lives in the workflow's guide.geml, which keeps
an episode in one file and has every command on it pass --root ."
```

---

### Task 5: The episode's to-do count through the bridge

**Files:** Create `integrations/gemflow/src/media-todo.ts`, `integrations/gemflow/test/media-todo.test.mjs`; modify `integrations/gemflow/src/workspace.ts`, `integrations/gemflow/src/hosts/claude-code/protocol.ts`, `integrations/gemflow/src/bridge.ts`.

- [ ] **Step 1: Failing tests**

Create `integrations/gemflow/test/media-todo.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { declaresMedia, mediaTodoCount } from "../dist/media-todo.js";
import { openWorkspace } from "../dist/workspace.js";
import { NO_CAPABILITIES } from "../dist/core/capabilities.js";
import { BUNDLE, gitRepo, hook, withWorkflow } from "./helpers/repo.mjs";

const GEML = fileURLToPath(import.meta.resolve("@geml/geml/dist/cli.js"));
const DEV = fileURLToPath(new URL("../workflows/dev/", import.meta.url));
const EPISODE = [
  "=== meta", 'title   = "第 1 集"', 'profile = "geml-media/v1"', "===", "",
  "=== media-text {#s01 .prompt shot=1}", "清晨的码头，雾很浓。", "===", "",
  "=== media-text {#s02 .prompt shot=2}", "一只猫跳上船头。", "===", "",
  "=== data {#gen-log .gen-log format=jsonl}", "===", "",
].join("\n");

/** A project with the bundled video workflow active and episodes/ep01.geml: two shots, nothing generated yet. */
function videoProject() {
  const root = mkdtempSync(join(tmpdir(), "gemflow-todo-"));
  const init = spawnSync(process.execPath, [BUNDLE, "init", "--template", "video"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  mkdirSync(join(root, "episodes"));
  writeFileSync(join(root, "episodes", "ep01.geml"), EPISODE);
  return root;
}

test("a document declares geml-media when its meta's profile names it, alone or among others", () => {
  assert.equal(declaresMedia(EPISODE), true);
  assert.equal(declaresMedia('=== meta\nprofile = "geml-style/v1 geml-media/v1"\n===\n'), true);
  assert.equal(declaresMedia('=== meta\nprofile = "geml-flow/v1"\n===\n'), false);
  assert.equal(declaresMedia("# 只是一份文档\n"), false);
});

test("the count is what geml media todo <file> --root <project> lists; a file that is no media entry, or is not there, has none", () => {
  const root = videoProject();
  const cli = spawnSync(process.execPath, [GEML, "media", "todo", "episodes/ep01.geml", "--root", ".", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).length, 2);
  assert.equal(mediaTodoCount(root, "episodes/ep01.geml"), 2);
  writeFileSync(join(root, "episodes", "notes.geml"), "# 笔记\n");
  assert.equal(mediaTodoCount(root, "episodes/notes.geml"), undefined);
  assert.equal(mediaTodoCount(root, "episodes/missing.geml"), undefined);
});

test("a file-unit workspace names its work item's file, from the call or from the context document; a branch unit names none", () => {
  const root = videoProject();
  const given = openWorkspace({ root, host: "cli", capabilities: NO_CAPABILITIES, lastFile: "episodes/ep01.geml" });
  assert.ok(given.ok);
  assert.deepEqual([given.ws.item, given.ws.itemFile], [{ kind: "item", id: "episodes/ep01" }, "episodes/ep01.geml"]);
  const remembered = openWorkspace({ root, host: "cli", capabilities: NO_CAPABILITIES });
  assert.ok(remembered.ok);
  assert.equal(remembered.ws.itemFile, "episodes/ep01.geml");
  const repo = gitRepo();
  withWorkflow(repo, DEV, "dev");
  const branch = openWorkspace({ root: repo, host: "cli", capabilities: NO_CAPABILITIES });
  assert.ok(branch.ok);
  assert.deepEqual([branch.ws.item, branch.ws.itemFile], [{ kind: "item", id: "feat/x" }, undefined]);
});

test("refresh and board carry the work item's to-do count; other ops leave it out; a work item that is no media entry has none", () => {
  const root = videoProject();
  assert.equal(hook(root, { op: "status", lastFile: "episodes/ep01.geml" }).todo, undefined);
  assert.deepEqual(hook(root, { op: "refresh" }).todo, { item: "episodes/ep01", count: 2 });
  assert.deepEqual(hook(root, { op: "board" }).todo, { item: "episodes/ep01", count: 2 });
  writeFileSync(join(root, "episodes", "ep02.geml"), '=== meta\ntitle = "第 2 集"\n===\n');
  assert.equal(hook(root, { op: "refresh", lastFile: "episodes/ep02.geml" }).todo, null);
});
```

- [ ] **Step 2: Watch them fail**

Run: `cd integrations/gemflow && npm run build >/dev/null; node --test test/media-todo.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|ERR_MODULE_NOT_FOUND"; cd ../..`
Expected: `ERR_MODULE_NOT_FOUND` for `dist/media-todo.js`.

- [ ] **Step 3: The work item's file**

In `integrations/gemflow/src/workspace.ts`, in `class Workspace`:

1. After `readonly item: Item;` add:

```ts
  /** Under `flow-unit = "file:…"`, the work item's file: project-relative, `/`-separated. Undefined under a branch unit or with no work item. */
  readonly itemFile: string | undefined;
```

2. In the constructor, replace `this.item = this.resolveItem();` with:

```ts
    const resolved = this.resolveItem();
    this.item = resolved.item;
    this.itemFile = resolved.file;
```

3. Replace `resolveItem` with:

```ts
  private resolveItem(): { item: Item; file?: string } {
    const unit = this.sc.unit;
    if (unit.kind === "branch") {
      if (this.repo.noCommits) return { item: { kind: "inactive", reason: "no commits yet" } };
      return { item: resolveItem(unit, this.repo) };
    }
    const given = this.o.lastFile === undefined ? undefined : this.projectPath(this.o.lastFile);
    const lastFile = given !== undefined && globToRegExp(unit.glob).test(given) ? given : this.rememberedFile(unit.glob);
    const item = resolveItem(unit, lastFile === undefined ? {} : { lastFile });
    return item.kind === "item" && lastFile !== undefined ? { item, file: lastFile } : { item };
  }
```

- [ ] **Step 4: Counting**

Create `integrations/gemflow/src/media-todo.ts`:

```ts
// The to-do count of a work item whose file is a geml-media entry (spec §7.2):
// what `geml media todo <file> --root <project>` lists, counted in process by
// the parser's own todo over the parser's own confined file host, so the two
// cannot disagree. Display only — no signal reads it; the todo-clear signal is
// the command's exit status. Counting hashes every asset file the entry
// reaches, so the bridge counts on refresh and board only.
import { join } from "node:path";
import { parse } from "@geml/geml";
import { profileIoFor } from "@geml/geml/dist/host-fs.js";
import { todo } from "@geml/geml/dist/media-verbs.js";
import { readText } from "./host-fs.js";

/** The vocabulary whose entries have a to-do list. */
export const MEDIA_PROFILE = "geml-media/v1";

/** Whether a document's `=== meta` declares the geml-media vocabulary, alone or among others. */
export function declaresMedia(source: string): boolean {
  const meta = parse(source).children.find((b) => b.kind === "block" && b.type === "meta");
  const profile = meta && meta.kind === "block" && meta.data ? meta.data["profile"] : undefined;
  return typeof profile === "string" && profile.split(/\s+/).includes(MEDIA_PROFILE);
}

/**
 * How many to-do items `geml media todo <file> --root <root>` lists for the
 * project-relative `file`; undefined when the file cannot be read, does not
 * declare geml-media, or the parser cannot read it as an entry.
 */
export function mediaTodoCount(root: string, file: string): number | undefined {
  let source: string;
  try { source = readText(join(root, file)); } catch { return undefined; }
  if (!declaresMedia(source)) return undefined;
  try { return todo([file], profileIoFor(root)).length; } catch { return undefined; }
}
```

- [ ] **Step 5: The answer field and the bridge**

In `integrations/gemflow/src/hosts/claude-code/protocol.ts`:

1. Before `export type TimelineEntry =`, add:

```ts
/** The work item's to-do count when its file is a geml-media entry (spec §7.2): display only. */
export interface TodoCount { item: string; count: number }

```

2. In the ok arm of `BridgeResponse`, after the line `text?: string; board?: BoardData;`, add:

```ts
      /** refresh and board: the work item's to-do count, or null when its file is no geml-media entry; every other answer leaves it out. */
      todo?: TodoCount | null;
```

In `integrations/gemflow/src/bridge.ts`:

1. After `import { ghOncePerBranch, type GhFacts } from "./host-git.js";` add `import { mediaTodoCount } from "./media-todo.js";`, and add `TodoCount` to the `import type { … } from "./hosts/claude-code/protocol.js";` list.

2. Before `/** One request, answered.`, add:

```ts
/** The work item's to-do count when its file is a geml-media entry (spec §7.2), else null. Display only; it hashes the entry's assets, so only refresh and board ask. */
function todoOf(ws: Workspace, root: string): TodoCount | null {
  const file = ws.itemFile;
  if (ws.item.kind !== "item" || file === undefined) return null;
  const count = mediaTodoCount(root, file);
  return count === undefined ? null : { item: ws.item.id, count };
}

```

3. In `answer`, the `refresh` case becomes `return ok(ws.view(), { entered: change.entered, todo: todoOf(ws, root) }, change.context);` and the `board` case `return ok(ws.view(), { entered: change.entered, board: boardOf(ws, root), todo: todoOf(ws, root) }, change.context);`.

- [ ] **Step 6: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-c.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-c.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0` (`test/bundle.test.mjs` included: the bundle still imports only `node:` built-ins).

- [ ] **Step 7: Commit**

```bash
git add integrations/gemflow/src/media-todo.ts integrations/gemflow/test/media-todo.test.mjs integrations/gemflow/src/workspace.ts integrations/gemflow/src/hosts/claude-code/protocol.ts integrations/gemflow/src/bridge.ts
git commit -m "feat(gemflow): refresh and board count a media episode's to-do items

When the work item's file declares geml-media, the bridge counts what
geml media todo <file> --root <project> lists, in process with the parser's
own todo and file host, and answers todo: { item, count } on refresh and
board (null for any other file). Counting hashes the episode's assets, so no
other op counts. Display only: no signal reads it. A workspace names its
file-unit work item's file."
```

---

### Task 6: The count on the band

**Files:** Modify `integrations/gemflow/src/hosts/claude-code/band.ts`, `integrations/gemflow/hooks/register.tsx`, `integrations/gemflow/types/index.d.ts`, `integrations/gemflow/test/band.test.mjs`, `integrations/gemflow/tests/hooks.test.ts`.

- [ ] **Step 1: Failing tests**

In `integrations/gemflow/test/band.test.mjs`, insert before the test `cell widths: CJK and fullwidth punctuation take two cells; combining marks none`:

```js
test("a media work item's to-do count follows its stage, for that item only (spec §7.2)", () => {
  const s = status({
    item: { kind: "item", id: "episodes/ep02" },
    state: { id: "assets", strict: false, rev: 4 },
    signals: [{ id: "todo-clear", on: "command", sets: "assets-done", label: "", value: false }],
    next: [{ id: "to-cut", to: "cut", auto: true, approval: false, requires: "assets-ready", holds: false }],
  });
  const sh = shell(s, { relevant: ["todo-clear"] });
  assert.deepEqual(texts(bandSegments(sh, null, null, { item: "episodes/ep02", count: 7 })), ["⧗ episodes/ep02", "assets", "待办 7 项", "todo-clear ✗", "→ #cut 自动 · 待 #assets-ready"]);
  assert.deepEqual(bandSegments(sh, null, null, { item: "episodes/ep02", count: 0 })[2], { text: "无待办", tone: "success" });
  assert.deepEqual(texts(bandSegments(sh, null, null, { item: "episodes/ep01", count: 7 })), ["⧗ episodes/ep02", "assets", "todo-clear ✗", "→ #cut 自动 · 待 #assets-ready"], "another item's count is not this one's");
  assert.deepEqual(texts(bandSegments(sh, null)), ["⧗ episodes/ep02", "assets", "todo-clear ✗", "→ #cut 自动 · 待 #assets-ready"]);
});
```

In `integrations/gemflow/tests/hooks.test.ts`:

1. In `world`'s `w` object, after the `error` field, add:

```ts
    /** The to-do count refresh and board answers carry; null when the work item is no media entry. */
    todo: null as { item: string; count: number } | null,
```

2. In `answer`, replace

```ts
    if (req.op === 'board') return { v: 1, ok: true, shell: shell(), board: board() }
```

with

```ts
    if (req.op === 'board') return { v: 1, ok: true, shell: shell(), board: board(), todo: w.todo }
    if (req.op === 'refresh') return { v: 1, ok: true, shell: shell(), todo: w.todo }
```

3. Append:

```ts
test('the to-do count a refresh read stays on the band until a later refresh or board answer replaces it', async ($, on) => {
  const w = world(on)
  w.todo = { item: 'feat/x', count: 7 }
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  await start($, on)
  const drawn = async (text: string | RegExp) => {
    const band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const found = await band.find({ type: 'Text', text })
    await band.unmount()
    return found
  }
  expect(await drawn('待办 7 项')).toBeDefined()
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', callId: 'b1' })
  expect(await drawn('待办 7 项')).toBeDefined()
  w.todo = null
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  expect(await drawn(/待办/)).toBeUndefined()
})
```

- [ ] **Step 2: Watch them fail**

Run: `cd integrations/gemflow && npm run build >/dev/null && node --test test/band.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; npm run test:claude > /tmp/gemflow-c-claude.log 2>&1; echo "exit=$?"; grep -E "^\(fail\)| fail$" /tmp/gemflow-c-claude.log; cd ../..`
Expected: `ℹ fail 1`; `exit=1`, `(fail) the to-do count a refresh read stays on the band until a later refresh or board answer replaces it`, ` 1 fail`.

- [ ] **Step 3: The band**

In `integrations/gemflow/src/hosts/claude-code/band.ts`:

1. Change `import type { ShellStatus } from "./protocol.js";` to `import type { ShellStatus, TodoCount } from "./protocol.js";`.

2. Replace `bandSegments`, its doc comment and the head of `stageSegments` —

```ts
/**
 * The band: the bridge's problem alone when there is one; else the work item,
 * its stage, the signals the next guard reads, the next step and the warnings.
 * `setup` — a tool or command the session would not register — comes last, or
 * alone when there is no stage to show.
 */
export function bandSegments(shell: ShellStatus | null, problem: string | null, setup: string | null = null): Segment[] {
  if (problem !== null) return [{ text: problem, tone: "error" }];
  const tail: Segment[] = setup !== null ? [{ text: setup, tone: "error" }] : [];
  return [...stageSegments(shell), ...tail];
}

function stageSegments(shell: ShellStatus | null): Segment[] {
```

— with

```ts
/** A media work item's to-do count (spec §7.2), as the last refresh or board read it: display only. */
export function todoSegment(count: number): Segment {
  return count > 0 ? { text: `待办 ${count} 项`, tone: "normal" } : { text: "无待办", tone: "success" };
}

/**
 * The band: the bridge's problem alone when there is one; else the work item,
 * its stage, its to-do count when it is a media entry, the signals the next
 * guard reads, the next step and the warnings. `setup` — a tool or command the
 * session would not register — comes last, or alone when there is no stage to
 * show. `todo` counts only for the work item it names.
 */
export function bandSegments(shell: ShellStatus | null, problem: string | null, setup: string | null = null, todo: TodoCount | null = null): Segment[] {
  if (problem !== null) return [{ text: problem, tone: "error" }];
  const tail: Segment[] = setup !== null ? [{ text: setup, tone: "error" }] : [];
  return [...stageSegments(shell, todo), ...tail];
}

function stageSegments(shell: ShellStatus | null, todo: TodoCount | null): Segment[] {
```

3. In `stageSegments`, right after the line

```ts
  const out: Segment[] = [{ text: `⧗ ${s.item.id}`, tone: "normal" }, { text: s.state?.id ?? "?", tone: "normal" }];
```

add:

```ts
  if (todo !== null && todo.item === s.item.id) out.push(todoSegment(todo.count));
```

- [ ] **Step 4: The hooks module keeps the count**

In `integrations/gemflow/types/index.d.ts`, after `tab: GemflowTab`, add `todo: GemflowJson`.

In `integrations/gemflow/hooks/register.tsx`:

1. Add `TodoCount` to the `import type { BoardData, BridgeOp, BridgeRequest, BridgeResponse, ShellStatus } from '../dist/hosts/claude-code/protocol.js'` list.

2. After `const tabAtom = …`, add:

```ts
/** The work item's to-do count as the last refresh or board answer carried it (spec §7.2); null when that work item is no media entry. */
const todoAtom = atom({ plugin: 'gemflow', key: 'todo' } as const, null as GemflowJson)
```

3. In `bridge()`, right after `if (shell !== undefined) await update($, shellAtom, () => shell as unknown as GemflowJson)`, add:

```ts
  // Refresh and board answers carry the to-do count; every other answer leaves the last one standing.
  if (res.ok && res.todo !== undefined) {
    const todo = res.todo
    await update($, todoAtom, () => todo as unknown as GemflowJson)
  }
```

4. In the `AbovePrompt` render, pass the count as `bandSegments`' fourth argument:

```ts
      segments = fitSegments(bandSegments(await readShell($), await read($, problemAtom), await read($, setupAtom), (await read($, todoAtom)) as unknown as TodoCount | null), e.props.bodyColumns)
```

- [ ] **Step 5: Run both suites once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-c.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-c.log; npm run test:claude > /tmp/gemflow-c-claude.log 2>&1; echo "claude exit=$?"; tail -3 /tmp/gemflow-c-claude.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0` (`test/hooks-purity.test.mjs` included: the hooks module imports `TodoCount` as a type only); `claude exit=0`, ` 0 fail`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/src/hosts/claude-code/band.ts integrations/gemflow/hooks/register.tsx integrations/gemflow/types/index.d.ts integrations/gemflow/test/band.test.mjs integrations/gemflow/tests/hooks.test.ts
git commit -m "feat(gemflow): the band shows a media episode's to-do count

待办 N 项 (or 无待办) follows the stage, for the work item the count was
read for. The hooks module keeps the count the last refresh or board answer
carried, so the answers between them leave it standing."
```

---

### Task 7: End to end through the bridge, with the parser's own commands

**Files:** Modify `integrations/gemflow/test/video-workflow.test.mjs`.

- [ ] **Step 1: Write the tests**

In `integrations/gemflow/test/video-workflow.test.mjs`, replace the import block at the top with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { commandSignals, onlyInRefusal } from "../dist/core/signals.js";
import { blockText } from "../dist/core/blocks.js";
import { BUNDLE, hook } from "./helpers/repo.mjs";
```

and append:

```js
// End to end through the bundled bridge, in a project with no git: the parser's own
// todo, import, log and check run for real against episodes/ep01.geml; the render,
// which needs ffmpeg, is reported to the bridge by its exit status, as the hooks
// module reports every Bash call.
const GEML = fileURLToPath(import.meta.resolve("@geml/geml/dist/cli.js"));
const EPISODE = [
  "=== meta", 'title   = "第 1 集"', 'profile = "geml-media/v1"', "===", "",
  "=== media-text {#s01 .prompt shot=1}", "清晨的码头，雾很浓。", "===", "",
  "=== data {#gen-log .gen-log format=jsonl}", "===", "",
].join("\n");
const TIMELINE = ["", '==== media {#cut tracks="v:video"}', "", "=== media-clip {#c1 track=v src=#s01-take1 duration=2}", "===", "", "====", ""].join("\n");
const TODO = "geml media todo episodes/ep01.geml --root . --check";
const FRESH = "geml check episodes/ep01.geml --root . --severity media-stale-clip=error";
const BUILD = "geml media build episodes/ep01.geml --root . --out renders/ep01.mp4";

/** A project with the video workflow active, episodes/ep01.geml (one shot to generate) and the shot's picture on disk. */
function episodeProject() {
  const root = mkdtempSync(join(tmpdir(), "gemflow-video-"));
  const init = spawnSync(process.execPath, [BUNDLE, "init", "--template", "video"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^wrote \.geml\/workflows\/video\/ \(active\)$/m);
  mkdirSync(join(root, "episodes"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "episodes", "ep01.geml"), EPISODE);
  writeFileSync(join(root, "assets", "s01-take1.png"), "PNGBYTES");
  return root;
}

/** The parser's CLI in the project; PATH emptied so no ffprobe answers and every run reads the same. */
const geml = (root, command) => spawnSync(process.execPath, [GEML, ...command.split(" ").slice(1)], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: "" } });

/** A Bash call's outcome, as the hooks module reports it to the bridge. */
const report = (root, callId, command, exitCode) =>
  hook(root, { op: "after", tool: "Bash", callId, input: { command }, isError: exitCode !== 0, exitCode, gitOperation: false });

/** Run a geml command for real and report its exit status. */
function ran(root, callId, command) {
  const r = geml(root, command);
  return { status: r.status, answer: report(root, callId, command, r.status) };
}

const before = (root, callId, command) => hook(root, { op: "before", tool: "Bash", callId, input: { command } });

test("end to end: the parser's own todo and check move an episode to #render; the render's exit status moves it to #review; a person approves and publishes", () => {
  const root = episodeProject();
  const opened = hook(root, { op: "status", lastFile: "episodes/ep01.geml" });
  assert.deepEqual([opened.shell.status.item, opened.shell.status.state.id], [{ kind: "item", id: "episodes/ep01" }, "script"]);
  assert.match(before(root, "b0", BUILD).refusal, /may only run in #render \(signal rendered\); the workflow is in #script/);

  const assets = hook(root, { op: "mark", signal: "script-ok", checked: true });
  assert.deepEqual(assets.entered, ["assets"]);
  assert.match(assets.context, /--- \.\/guide\.geml#assets ---\n# 素材 \{#assets\}/, "the guide's block, read in process by the bundle");

  const pending = ran(root, "t1", TODO);
  assert.deepEqual([pending.status, pending.answer.entered, pending.answer.shell.status.vars["assets-done"]], [1, [], false]);
  assert.equal(geml(root, "geml media import assets/s01-take1.png --into episodes/ep01.geml --root .").status, 0);
  assert.equal(geml(root, "geml media log episodes/ep01.geml --root . --output #s01-take1 --model m --mode t2i --prompt #s01").status, 0);
  const cut = ran(root, "t2", TODO);
  assert.deepEqual([cut.status, cut.answer.entered], [0, ["cut"]]);

  appendFileSync(join(root, "episodes", "ep01.geml"), TIMELINE);
  const render = ran(root, "f1", FRESH);
  assert.deepEqual([render.status, render.answer.entered], [0, ["render"]]);
  assert.equal(before(root, "b1", BUILD).refusal, undefined);
  assert.deepEqual(report(root, "b1", BUILD, 0).entered, ["review"]);

  assert.match(before(root, "p1", "gemflow mark approved").refusal, /for a person/);
  assert.deepEqual(hook(root, { op: "mark", signal: "approved", checked: true }).entered, ["publish"]);
  const done = hook(root, { op: "mark", signal: "published", checked: true });
  assert.deepEqual([done.entered, done.shell.status.next], [["done"], []]);
});

/** An episode driven to #review by the exit statuses alone. */
function atReview() {
  const root = episodeProject();
  hook(root, { op: "status", lastFile: "episodes/ep01.geml" });
  hook(root, { op: "mark", signal: "script-ok", checked: true });
  report(root, "t1", TODO, 0);
  report(root, "f1", FRESH, 0);
  assert.equal(report(root, "b1", BUILD, 0).shell.status.state.id, "review");
  return root;
}

test("rework over #recut and #reshoot clears the last pass's signals, so the stale check, the render and a person's approval come round again", () => {
  const root = atReview();
  const recut = hook(root, { op: "verb", name: "flow_transition", args: { to: "cut" }, callId: "v1" });
  assert.deepEqual([JSON.parse(recut.text).entered, recut.shell.status.state.id], [[], "cut"], "no auto edge carries it on: no-stale was cleared");
  assert.deepEqual(recut.shell.status.vars, { "script-final": true, "assets-done": true, "no-stale": false, rendered: false, approved: false, published: false });
  assert.match(recut.context, /--- \.\/guide\.geml#cut ---/);
  assert.match(before(root, "b2", BUILD).refusal, /may only run in #render/);
  assert.deepEqual(report(root, "f2", FRESH, 0).entered, ["render"]);
  assert.deepEqual(report(root, "b3", BUILD, 0).entered, ["review"], "rendered was cleared, so a clean build writes it again");

  const reshoot = hook(root, { op: "advance", to: "assets" });
  assert.deepEqual([reshoot.entered, reshoot.shell.status.state.id], [["assets"], "assets"], "a person's move on the board");
  const vars = reshoot.shell.status.vars;
  assert.deepEqual([vars["assets-done"], vars["no-stale"], vars.rendered], [false, false, false]);
  assert.deepEqual(report(root, "t3", TODO, 0).entered, ["cut"]);
  assert.deepEqual(report(root, "f3", FRESH, 0).entered, ["render"]);
  assert.deepEqual(report(root, "b4", BUILD, 0).entered, ["review"]);
  assert.equal(hook(root, { op: "status" }).shell.status.vars.approved, false, "the new film waits for a person");
});

test("a failed render goes back to #cut over #fix-cut, which clears the stale check", () => {
  const root = episodeProject();
  hook(root, { op: "status", lastFile: "episodes/ep01.geml" });
  hook(root, { op: "mark", signal: "script-ok", checked: true });
  report(root, "t1", TODO, 0);
  assert.equal(report(root, "f1", FRESH, 0).shell.status.state.id, "render");
  const failed = report(root, "b1", BUILD, 1);
  assert.deepEqual([failed.entered, failed.shell.status.state.id, failed.shell.status.vars.rendered], [[], "render", false]);
  const back = hook(root, { op: "verb", name: "flow_transition", args: { to: "cut" }, callId: "v1" });
  assert.deepEqual([back.shell.status.state.id, back.shell.status.vars["no-stale"]], ["cut", false]);
  assert.deepEqual(report(root, "f2", FRESH, 0).entered, ["render"]);
  assert.deepEqual(report(root, "b2", BUILD, 0).entered, ["review"]);
});
```

- [ ] **Step 2: Run them**

Run: `npm --prefix geml-parser run build >/dev/null && cd integrations/gemflow && npm run build >/dev/null && node --test test/video-workflow.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ pass 6`, `ℹ fail 0`. Against a parser built before Task 3, the first end-to-end test fails at the real `todo --check`: `[2, …]` where `[1, [], false]` was expected — the CLI refuses the flag; without Task 1's runtime, the rework tests fail where `#recut` lands back in `#review`.

- [ ] **Step 3: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-c.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-c.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`.

- [ ] **Step 4: Commit**

```bash
git add integrations/gemflow/test/video-workflow.test.mjs
git commit -m "test(gemflow): the video workflow end to end through the bridge

The parser's own todo --check, import, log and check move an episode to
#render; the render's exit status moves it to #review; a person approves and
publishes. #recut by the model and #reshoot by a person clear the last pass's
signals, so the stale check, the render and the approval come round again,
and a failed render goes back over #fix-cut."
```

---

### Task 8: The READMEs and the spec

**Files:** Modify `integrations/gemflow/README.md`, `integrations/gemflow/README.zh.md`, `docs/design/specs/2026-10-11-gemflow-design.md`.

- [ ] **Step 1: README (English)**

In `integrations/gemflow/README.md`:

1. In the `## CLI` code block, change the row

```text
  init [dir] [--template coding|dev|refund] [--no-activate]  copy a bundled workflow into .geml/workflows/
```

to

```text
  init [dir] [--template coding|dev|refund|video] [--no-activate]  copy a bundled workflow into .geml/workflows/
```

2. In the `init` bullet, change

```text
(`coding` unless `--template` says `dev` or `refund`)
```

to

```text
(`coding` unless `--template` says `dev`, `refund` or `video`)
```

3. In `## The dev workflow`, replace the **Rework.** paragraph

```markdown
**Rework.** `#rework` takes #review back to #build, by the model's
`flow_transition` or a person's move. The `auto` edge forward does not bounce
the workflow straight back although its guard still holds: the first auto edge
after a transition never returns to the state that transition just left. The
workflow stays in #build until something recorded changes — a test run whose
result differs from the recorded one, a git signal that flips, a person's tick,
a variable the model records — and the edge is then taken as usual. A test run
that is green again while `tests-pass` is already true changes nothing. The
model or a person can also move the workflow on directly.
```

with

```markdown
**Rework.** `#rework` takes #review back to #build, by the model's
`flow_transition` or a person's move, and resets `tests-pass` and
`review-ready` to false in the same revision (`resets`): the last pass's green
run and `ready` tick stop counting. The workflow stays in #build until the
tests pass again, a person ticks `ready` again, or the pull request is merged,
and `#to-review` then takes it forward as usual. The first auto edge after a
transition never returns to the state that transition just left, so a guard
that still holds on git's facts alone does not bounce it back at once either.
```

4. Insert right after the `## The dev workflow` section, before `## Development`:

````markdown
## The video workflow

`/gemflow add video` (or `gemflow init --template video`) writes
`.geml/workflows/video/`: `flow.geml`, and `guide.geml` with each stage's
context. Its work item is an episode, each geml-media document under
`episodes/` (`flow-unit = "file:episodes/*.geml"`), the current one being the
episode a write call touched last; it needs no git. Seven states, none of them
`strict`; `#render` and `#review` admit `read run search` as advice, so an
edit there is recorded as a deviation, and the others `read write run search`:

```
#script ─auto─▶ #assets ─auto─▶ #cut ─auto─▶ #render ─auto─▶ #review ─auto─▶ #publish ─auto─▶ #done
                   ▲             ▲ ▲            │               │
                   │             │ └─ fix-cut ──┘               │
                   │             └─────────── recut ────────────┤
                   └───────────────── reshoot ──────────────────┘
```

What moves it without the model's word is the signals table:

| signals | read from | set |
|---|---|---|
| `script-ok`, `approved`, `published` | a person's tick, on the board or with `gemflow mark` | `script-final`, `approved`, `published` |
| `todo-clear` | `geml media todo <episode> --check`, by its exit code | `assets-done` |
| `fresh` | `geml check <episode> --severity media-stale-clip=error`, by its exit code | `no-stale` |
| `rendered` | `geml media build`, by its exit code; `only-in` | `rendered` |

1. **#script.** Write the episode: prompts (`media-text .prompt`) and lines
   (`media-text .line`). An episode is one file — its script, its asset blocks
   and generation log, its timeline — because references point one way and
   `geml media todo` sees only what the episode reaches. A person ticks
   `script-ok` (剧本定稿); the model cannot.
2. **#assets.** Generate what `geml media todo episodes/epNN.geml --root . --json`
   lists, and register each result with `geml media import` and
   `geml media log`. `geml media todo episodes/epNN.geml --root . --check`
   exits 0 once nothing is left, and `#to-cut` takes the workflow to #cut.
3. **#cut.** Lay the timeline (`geml media lay`; `geml media export --to player`
   for a preview).
   `geml check episodes/epNN.geml --root . --severity media-stale-clip=error`
   exits 0 when no clip uses a stale asset, and `#to-render` follows.
4. **#render.** `geml media build` runs here and nowhere else: in any other stage
   it is refused before it runs, whichever way it is spelled — `npx`, `bunx`,
   `pnpm [dlx|exec]`, `yarn [dlx]`, `npm exec` or `node …/cli.js` in front
   of `geml`, inside `bash -c "…"` or a longer command line. #render is
   entered only after a clean stale check, so a prompt edited without
   generating again keeps the film from being made. A clean build takes the
   workflow to #review.
5. **#review.** A person watches the film and ticks `approved` (审片通过),
   which takes the workflow to #publish; once the episode is out, `published`
   (已发布) ends the work item at #done.

The line above the prompt shows the episode's to-do count:
`⧗ episodes/ep02 · assets · 待办 7 项 · todo-clear ✗ · → #cut 自动 · 待 #assets-ready`.
It is counted when a session starts and when the board opens or refreshes, in
process, by the parser's own `todo` — the items
`geml media todo <file> --root . --json` lists. No signal reads it.

**Rework.** `#reshoot` takes #review back to #assets (a shot made again) and
`#recut` back to #cut (the cut changed), by the model's `flow_transition` or a
person's move on the board. Each clears the last pass's evidence in the same
revision (`resets`): `#reshoot` returns `assets-done`, `no-stale` and
`rendered` to false, `#recut` `no-stale` and `rendered`. So the to-do check,
the stale check and the render come round again, and the new film waits for a
person's `approved`. A failed render goes back the same way: `#fix-cut` takes
#render to #cut and clears `no-stale`.

Every command names the episode's file and passes `--root .`: a signal reads
the command line, not the file the command works on.
`geml media todo --check` is in `@geml/geml`'s unreleased changes; until a
release carries it, run the parser from this checkout
(`node geml-parser/dist/cli.js media todo …`), which the patterns read as well.
````

- [ ] **Step 2: README (中文)**

In `integrations/gemflow/README.zh.md`:

1. The same `init` row in the `## CLI` code block.

2. In the `init` bullet, change

```text
`--template dev` 或 `--template refund` 则是那一份
```

to

```text
`--template dev`、`refund` 或 `video` 则是那一份
```

3. In `## 开发流程`, replace the **退回重做。** paragraph

```markdown
**退回重做。** `#rework` 把流程从 #review 退回 #build，由模型的 `flow_transition` 或人
推进。往前的那条 `auto` 边即使守卫仍成立，也不会把流程立刻弹回去：一次转换之后的第一条
auto 边，从不回到这次转换刚离开的状态。流程停在 #build，直到记下的东西有了变化——一次
结果与已记值不同的测试运行、一个翻转的 git 信号、人的一次勾选、模型记下的一个变量——这条
边才照常被带走。`tests-pass` 已经为真时再跑绿一次，什么都没变。模型或人也可以直接把流程
推过去。
```

with

```markdown
**退回重做。** `#rework` 把流程从 #review 退回 #build，由模型的 `flow_transition` 或人
推进，并在同一个修订里把 `tests-pass` 与 `review-ready` 清回 false（`resets`）：上一轮
跑绿的测试和勾过的 ready 都作废。流程停在 #build，直到测试重新跑绿、人重新勾选 ready，
或者 PR 已合并，`#to-review` 才照常把它带回 #review。一次转换之后的第一条 auto 边从不回到
这次转换刚离开的状态，所以单凭 git 的事实仍成立的守卫，也不会把流程立刻弹回去。
```

4. Insert right after the `## 开发流程` section, before `## 开发`:

````markdown
## 视频流程

`/gemflow add video`（或 `gemflow init --template video`）写出
`.geml/workflows/video/`：`flow.geml`，以及放各阶段说明的 `guide.geml`。它的工作项是
一集：`episodes/` 下的每份 geml-media 文档（`flow-unit = "file:episodes/*.geml"`），
当前工作项是写入调用最近一次改动的那一集；它不需要 git。七个状态，都不是 `strict`；
`#render` 与 `#review` 只提醒地允许 `read run search`，在这两个阶段改文件会记一次
偏离，其余允许 `read write run search`：

```
#script ─auto─▶ #assets ─auto─▶ #cut ─auto─▶ #render ─auto─▶ #review ─auto─▶ #publish ─auto─▶ #done
                   ▲             ▲ ▲            │               │
                   │             │ └─ fix-cut ──┘               │
                   │             └─────────── recut ────────────┤
                   └───────────────── reshoot ──────────────────┘
```

不凭模型一句话就推动它的，是信号表：

| 信号 | 从哪读 | 写哪个变量 |
|---|---|---|
| `script-ok`、`approved`、`published` | 人的勾选，在看板上或用 `gemflow mark` | `script-final`、`approved`、`published` |
| `todo-clear` | `geml media todo <本集> --check`，看退出码 | `assets-done` |
| `fresh` | `geml check <本集> --severity media-stale-clip=error`，看退出码 | `no-stale` |
| `rendered` | `geml media build`，看退出码；带 `only-in` | `rendered` |

1. **#script。** 写这一集：分镜提示词（`media-text .prompt`）与台词
   （`media-text .line`）。一集只占一个文件——剧本、本集的素材块与生成日志、时间线都在
   里面——因为引用是有方向的，`geml media todo` 只看得见从这一集出发够得着的东西。
   人勾选 `script-ok`（剧本定稿）；模型勾不了。
2. **#assets。** 按 `geml media todo episodes/epNN.geml --root . --json` 列出的待办
   生成，每做好一件用 `geml media import` 与 `geml media log` 登记。
   `geml media todo episodes/epNN.geml --root . --check` 在没有待办时以 0 退出，
   `#to-cut` 把流程带到 #cut。
3. **#cut。** 排时间线（`geml media lay`；`geml media export --to player` 出预览）。
   `geml check episodes/epNN.geml --root . --severity media-stale-clip=error` 在没有
   片段用到过期素材时以 0 退出，接着走 `#to-render`。
4. **#render。** `geml media build` 只在这里运行：在别的阶段，命令在执行前被拒，怎么写
   都一样——`geml` 前面加 `npx`、`bunx`、`pnpm [dlx|exec]`、`yarn [dlx]`、
   `npm exec` 或 `node …/cli.js`，放进 `bash -c "…"` 或更长的命令行里。进入 #render
   要求过期检查通过，所以改了提示词却没重新生成，就出不了片。出片成功，流程到 #review。
5. **#review。** 人看完成片勾选 `approved`（审片通过），流程到 #publish；这一集发出去
   之后勾选 `published`（已发布），这个工作项到 #done。

输入框上方那一行显示这一集的待办数：
`⧗ episodes/ep02 · assets · 待办 7 项 · todo-clear ✗ · → #cut 自动 · 待 #assets-ready`。
它在会话开始、打开或刷新看板时，由解析器的 `todo` 在进程内算出——就是
`geml media todo <文件> --root . --json` 列出的那些。没有信号读它。

**返工。** `#reshoot` 把流程从 #review 带回 #assets（重出镜头），`#recut` 带回 #cut
（改剪辑），由模型的 `flow_transition` 或人在看板上推进。两条边都在同一个修订里清掉
上一轮的证据（`resets`）：`#reshoot` 把 `assets-done`、`no-stale` 与 `rendered`
清回 false，`#recut` 清 `no-stale` 与 `rendered`。所以待办检查、过期检查与出片都要
重新过一遍，新片也要等人再勾 `approved`。出片失败也这样回去：`#fix-cut` 把流程从
#render 带回 #cut，并清掉 `no-stale`。

每条命令都写本集的文件并带 `--root .`：信号只读命令行，看不见命令作用在哪个文件上。
`geml media todo --check` 在 `@geml/geml` 尚未发布的改动里；发布之前，用本仓库里的
解析器运行（`node geml-parser/dist/cli.js media todo …`），信号的正则同样认得。
````

- [ ] **Step 3: The spec**

In `docs/design/specs/2026-10-11-gemflow-design.md`:

1. §4.1: replace

```geml
=== flow-transition {#rework from=#review to=#build}
review 要求改动。
===
```

with

```geml
=== flow-transition {#rework from=#review to=#build resets="tests-pass review-ready"}
review 要求改动。测试结果和 ready 的勾选随之清掉。
===
```

2. §4.3: after the row

```markdown
| `flow-transition` | `auto` | 任何一次改动（信号写入、模型的动作、人的推进、回滚、进入初始状态）之后 `requires` 成立，即自动推进；带 `approval` 的永远不会自动走 |
```

add

```markdown
| `flow-transition` | `resets` | 空格分隔的变量名：这条边被走时（模型、人或 `auto` 连走），这些变量在同一个修订里回到 `flow-vars` 的 `default`，守卫读的是走之前的值。返工的边用它清掉上一轮确立的事实；信号的变量也可以列，复位它的是流程，模型仍然写不了 |
```

3. §4.4: after the row

```markdown
| `flow-strict-no-tools` | warning | `strict` 状态既没有自己的 `tools=`，meta 也没有 `flow-tools`：没有清单可执行 |
```

add

```markdown
| `flow-resets-var` | error | `resets=` 里的名字未在 `flow-vars` 声明 |
| `flow-resets-default` | error | `resets=` 里的变量没有 `default`，无处可回 |
```

4. §7.2, the first paragraph: replace

```markdown
建立在 geml-media 上：剧本是 `media-text`，素材与生成日志在库文档里，剪辑是 `media` 时间线（见 `spec/profiles/geml-media/`）。
```

with

```markdown
建立在 geml-media 上：剧本是 `media-text`，剪辑是 `media` 时间线（见 `spec/profiles/geml-media/`）。一集只占一个文件：本集的素材块与生成日志也写在里面，几集共用的角色卡、配音样本放在别的文档，用 `speaker=`、`of=` 引用。引用是有方向的，`geml media todo` 从本集出发，只看得见它够得着的生成记录。
```

5. §7.2, the diagram: replace

```text
#script ─→ #assets ─→ #cut ─→ #render ─→ #review ─→ #publish ─→ #done
                ↑                              │
                └──── 重出镜头 / 改剪辑 ─────────┘
```

with

```text
#script ─→ #assets ─→ #cut ─→ #render ─→ #review ─→ #publish ─→ #done
              ↑        ↑ ↑       │          │
              │        │ └───────┘ #fix-cut │
              │        └────── #recut ──────┤
              └───────── #reshoot ──────────┘
```

6. §7.2, between the signals table and the transitions table (after the row `| published | manual | 已发布 | published | checked | |` and its blank line), insert this paragraph and a blank line:

```markdown
上表的正则是示意；内置的视频流程（`integrations/gemflow/workflows/video/flow.geml`）读得出常见写法：`geml` 前面的 `npx`、`pnpm`、`yarn`、`bunx` 与 `node …/cli.js`，`--check` 与 `--severity media-stale-clip=error` 写在动词之后的任何位置；`rendered` 的 `only-in` 在整行里查找，`bash -c "…"` 里的、去掉引号之后的出片命令照样被拒绝。正则看不见命令作用在哪个文件上，所以流程的 `guide.geml` 要求每条命令都写本集的文件并带 `--root .`。
```

7. §7.2, the transitions table: replace the row

```markdown
| `#review → #assets`、`#review → #cut` | 模型或人（要重出镜头、要改剪辑） |
```

with

```markdown
| `#render → #cut`（`#fix-cut`） | 模型或人（出片失败、要改剪辑）；`resets` 清掉 `no-stale` |
| `#review → #assets`（`#reshoot`）、`#review → #cut`（`#recut`） | 模型或人（要重出镜头、要改剪辑）；`#reshoot` 清掉 `assets-done`、`no-stale`、`rendered`，`#recut` 清掉 `no-stale`、`rendered` |
```

8. §7.2, replace the bullet

```markdown
- 各状态的 `context` 引用流程自带的 `./guide.geml`：`#script` 用写台词与分镜的一节，`#assets` 用生成与登记日志（`geml media todo`、`geml media log`）的一节，`#cut` 用时间线与对齐（`geml media lay`）的一节，`#render` 用出片选项的一节。
```

with these three bullets:

```markdown
- 六个非终态的 `context` 都引用流程自带的 `./guide.geml`：`#script` 用写台词与分镜、一集一个文件的一节，`#assets` 用生成与登记（`geml media todo`、`geml media import`、`geml media log`）的一节，`#cut` 用时间线与对齐（`geml media lay`）的一节，`#render` 用出片选项与出片失败的一节，`#review` 用审片与返工的一节，`#publish` 用发布的一节。
- `#render` 与 `#review` 的 `tools` 是 `read run search`，只提醒、不 `strict`：在这两个阶段改剧本或剪辑记一次偏离。封路点仍只有上面那一个。
- **返工**走 `#reshoot`、`#recut`，出片失败走 `#fix-cut`：这三条边用 `resets`（§4.3）把上一轮的信号清回默认值，所以待办检查、过期检查与出片都要重新过一遍，新片也要人重新审。`#review` 里 `approved` 总是 false（勾上它流程就离开了 `#review`），不必复位。
```

9. §7.2, replace the bullet

```markdown
- 状态带示例：`⧗ episodes/ep02 · assets · 待办 7 项`（待办数由 `geml media todo --json` 在看板刷新时读出，只用于显示，不进信号）。
```

with these two bullets:

```markdown
- 状态带示例：`⧗ episodes/ep02 · assets · 待办 7 项`。工作项的文件声明了 geml-media 时，桥接在 `refresh` 与 `board` 两个 op 里用解析器的 `todo` 在进程内数出待办，经的是解析器同一个受限的文件宿主，所以与 `geml media todo <本集文件> --root . --json` 列出的条数相同；数随应答带回，hooks 模块留着最近一次的数，只在它所说的那个工作项上显示。会话开始与打开、刷新看板时会读到它；数待办要给本集够得着的每个素材文件算哈希，所以别的 op 不数。它只用于显示，不进信号。
- **待讨论：库文档布局。** 素材块与生成日志放在几集共用的库文档里时，是库引用剧本、剧本不引用库，从本集出发的 `geml media todo` 看不见那些生成记录，待办永远清不掉；交一个目录给它，又会把别的集的待办算进来。要支持这种布局，`todo` 需要一个“从本集出发、连同引用了本集的库文档”的入口（比如一个指名库文档的参数，或者沿反向引用把库收进来），过期检查也一样。在那之前，规则是上面的一集一个文件。
```

- [ ] **Step 4: Check**

Run: `for f in integrations/gemflow/README.md integrations/gemflow/README.zh.md docs/design/specs/2026-10-11-gemflow-design.md; do node geml-parser/dist/cli.js check --root . "$f" >/dev/null 2>&1; echo "$f $?"; done`
Expected: three lines ending ` 0`.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/README.md integrations/gemflow/README.zh.md docs/design/specs/2026-10-11-gemflow-design.md
git commit -m "docs(gemflow): the video workflow and resets= in both READMEs and the spec

Both READMEs describe the video workflow - the episode work item, the stages
and their signals, the one blocking point, the to-do count on the band, the
rework edges and what they reset, the parser release --check needs - and
say that the dev workflow's rework resets tests-pass and review-ready. The
spec records resets= (§4.1, §4.3, §4.4) and, in §7.2, the one-file episode
as the rule, the wider patterns, #fix-cut, the advice tools of #render and
#review, how the count is read, and the library-document layout as an open
question."
```

---

## Done when

- Eight commits on the branch, nothing pushed.
- `cd geml-parser && npm test` passes (`<N> suites passed`); `cd geml-parser-rs && cargo test` passes; in a project holding `episodes/ep01.geml` with one prompt and nothing logged, `node geml-parser/dist/cli.js media todo episodes/ep01.geml --root . --check` prints `生成  episodes/ep01.geml#s01  (t2i)` and exits 1; `node geml-parser/dist/cli.js check` of a `geml-flow/v1` document whose transition carries `resets=` reports nothing about it.
- `cd integrations/gemflow && npm test` passes (`ℹ fail 0`); `npm run test:claude` passes (` 0 fail`).
- `node integrations/gemflow/dist/cli.js check` prints `ok: no diagnostics` for `workflows/video/flow.geml` and `workflows/dev/flow.geml`; `node <repo>/integrations/gemflow/dist/cli.js init --template video` in an empty directory prints `wrote .geml/workflows/video/ (active)`.
- In an empty directory, `claude --plugin-dir <repo>/integrations/gemflow`, then `/gemflow add video`, then ask the model to write `episodes/ep01.geml` with one `.prompt` block: the line above the prompt reads `⧗ episodes/ep01 · script · script-ok ✗ · → #assets 自动 · 待 #script-ready`; `/gemflow board` adds `待办 1 项` after `script`; ticking 剧本定稿 on the board moves it to `assets` with `todo-clear ✗ · → #cut 自动 · 待 #assets-ready`.
