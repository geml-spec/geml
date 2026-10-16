# Gemflow B — The Claude Code Shell, the Dev Workflow, the Cross-Host MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gemflow a Claude Code plugin a person installs with one line: a line above the prompt showing the work item, the stage, the signals the next guard reads and the next step; a board with the tabs 流程 / 工作项 / 记录; `/gemflow`; the five model tools; the stage's context handed to the model whenever it changes. Ship the built-in dev workflow, and a `gemflow mcp` server that gives every other host the same five tools.

**Architecture:** `integrations/gemflow/` is the plugin root. The hooks module `hooks/register.tsx` runs inside Claude Code with no Node. It keeps the latest status and policy snapshot in `$.state`, decides per tool call with Node-free functions (`src/hosts/claude-code/*.ts`, compiled to `dist/` and imported by relative path) whether the workflow can care about the call, and only then asks the bundled CLI over a bridge: `node <plugin>/dist/gemflow.mjs hook`, one JSON request on stdin, one JSON answer on stdout. The CLI side, `src/bridge.ts`, runs each request against A3's `Workspace`, opened afresh for that request as host `claude`; every answer carries a fresh status, policy and context key. The band and the board are pure text models the hooks module only lays out. `src/verbs.ts` answers the five verbs for both the bridge and `gemflow mcp` (`src/mcp.ts`).

**Tech Stack:** TypeScript (tsc) → `dist/`; esbuild 0.28.2 for the one-file CLI bundle `dist/gemflow.mjs`; Node ≥ 22; `node:test`; the Claude Code function-hooks API (`claude-code` declarations of 2.1.295), `claude plugin validate` and `claude plugin test` with `claude-code/testing`.

**Spec:** `docs/design/specs/2026-10-11-gemflow-design.md` §3, §4.1, §5.2–§5.4, §7.1, §8, §9, §12.

**Depends on:** plans A2 and A3, both landed on this branch (A3 ends at `ced07e7`). This plan is written against the code A3 produced, not its plan:

- `src/workspace.ts`: `openWorkspace` and `loadWorkspace` return `Opened` — `{ ok: true, ws }` or `{ ok: false, reason, kind }`, `kind` being `"none"` (no workflow here), `"ambiguous"`, `"invalid"` or `"journal"` (the item's journal will not resume). `WorkspaceOptions` is `{ root, host, capabilities, now?, lastFile?, git?, gh?, getBlock?, approve?, approvalTimeoutMs? }`, `git` returning `RepoInfo` (= `RepoFacts`, with `noCommits`). A `Workspace` has the fields `item`, `sc`, `workflowName`, `workflowPath` and `title`, and `status()` (`Status`; its `gh` is absent when no signal reads gh), `before()`, `after(AfterEvent)` and `refresh()` (both `StageChange`, `{ entered, context? }`), `verb()` (`Invoked`, carrying `context` when an accepted verb changed the stage), `advance()` and `mark()` (`{ ok: true, entered, context? }` or `{ ok: false, reason }`), `context()` and `foreignJournal()`; privately `act`, `readsGh` and `ghFacts`. Every operation, opening included, takes the journal's lock, reads the journal fresh, and brings `.geml/context.geml` in line with it — host-neutral, in the workflow's own tool spelling — so this plan adds no context syncing of its own. The default block reader is in process (`src/core/blocks.ts`, `blockText(source, id, { markdown })`; `resolveContextRef`). A `Workspace` reads git's facts when it opens, so a caller that lives across requests opens one per request. It throws on a journal it cannot read, on a lock held past `withLock`'s 5 s and on a verb that kept conflicting after five attempts.
- `src/core/signals.ts`: the hardened command-line scanner (`simpleCommands` and its helpers `words`, `commandWordIndex`, `speaksForItself`, `withoutAssignments`; `commandSegments`, `withoutQuoting`), `commandSignals`, `fileSignals`, `gitSignals`, `onlyInRefusal`, `personOnlyRefusal`, `personOnlyReason`, `runsGitOrGh`, `MAX_SIGNAL_COMMAND_LENGTH`. There is no person-only regular expression: `personOnlyRefusal` scans every command position.
- `src/core/statechart.ts` (`signalPattern`, `signalPatternAtStart`, `effectiveTools`, `outgoing`), `src/core/supervisor.ts` (`Supervisor` with `owns`, `deny`, the public `refuse`, `onToolResult`, `allowedGlobals`; `openRun`; `VERBS`), `src/core/snapshot.ts` (`stageEntryRev`), `src/core/run.ts` (`Run.deviationLog`), `src/core/stagehand.ts` (`renderContextDoc`, `readContextDoc`), `src/core/unit.ts` (`globToRegExp`, `journalPathFor`), `src/core/backlog.ts` (`readBacklog`, `bindInDocument`), `src/core/journal.ts` (`readJournal`), `src/core/capabilities.ts` (`CLAUDE_CODE_CAPABILITIES`, `HOST_CAPABILITIES`, `NO_CAPABILITIES`, `hostTools`, `capabilityOf`), `src/core/layout.ts`, `src/host-fs.ts` (`withLock`, `writeAtomic`, `writeNew`, `exists`, `readText`), `src/host-git.ts` (`ghFacts`, which finds gh through `GEMFLOW_GH`; `GhFacts`).
- The CLI verbs `init [dir] [--template] [--no-activate]`, `use`, `status`, `mark`, `unmark`, `advance`; the bundled `workflows/coding/` and `workflows/refund/`; the fixture `test/fixtures/ws-dev/`.

`statechart.ts` imports `node:crypto` and `@geml/geml`, so the hooks module never imports `signals.js` or `statechart.js`: Task 2 moves the scanner, unchanged, into `src/core/command-line.ts`, which imports nothing, and ships compiled pattern sources in the policy. Where a name still differs, follow the compiler and keep this plan's behaviour.

**Working directory:** `/Users/xiong/software/geml`, branch `feat/geml-agent-runtime`, in place. Never switch branches, never stash, never push. Stage by explicit path, never `git add -A` / `git add .`; never add anything under `playground/codemap/`.

**Conventions:** English commit messages, no attribution trailers, no version bumps. Run an expensive suite once and take output and exit code from that run. Runtime suite: `cd integrations/gemflow && npm test` (builds — `tsc`, then the bundle — and prints `ℹ pass N` / `ℹ fail N`). One file: `cd integrations/gemflow && npm run build >/dev/null && node --test test/<file>.test.mjs`. Hooks suite (needs the `claude` CLI): `cd integrations/gemflow && npm run test:claude` (prints `N pass` / `N fail`, exits 1 on a failure). Spec and README text states current rules only.

---

## Decisions this plan makes (recorded in the spec by Task 14)

1. **Where the plugin lives.** `integrations/gemflow/` is the plugin root: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming `./register.tsx`, `types/index.d.ts` as the `$.state` contract, all beside `src/`. The root `.claude-plugin/marketplace.json` gains a `gemflow` entry whose source is the npm package `@geml/gemflow`; it works once the package is published, which is the user's call. Development loads the plugin with `claude --plugin-dir integrations/gemflow` after `npm run build`. `package.json` `files` adds `.claude-plugin`, `hooks`, `types`, `workflows`.
2. **One bundled CLI.** `npm run build` runs `tsc` and then `scripts/bundle.mjs`, an esbuild bundle of `src/cli.ts` (ESM, `platform: "node"`, `@geml/geml` inlined, Node's built-ins external) to `dist/gemflow.mjs`. The installed plugin needs no dependency install and starts one file. The parser's CLI hand-off (`if (isCliInvocation()) {`, which would fire inside the bundle because the bundle is "this module") is cut out by an esbuild plugin that fails the build when that line moves. `bin` stays `dist/cli.js`.
3. **The bridge.** The hooks module talks to Node only through `node <plugin>/dist/gemflow.mjs hook`: one request on stdin, one answer line on stdout, exit code 0 whatever the answer. Ops: `status`, `refresh`, `before`, `after`, `verb`, `mark`, `advance`, `bind`, `use`, `add`, `board`. The request and answer types live once, in the Node-free `src/hosts/claude-code/protocol.ts`. The CLI side opens A3's workspace afresh for every request — a `Workspace` reads git's facts when it opens, and another process may have written the journal since the last request — with `host: "claude"` and `CLAUDE_CODE_CAPABILITIES`, and answers every request, a throw included (decision 9). A request carries only the command and the path of a call (`bridgeInput`), never file contents.
4. **The fast path.** Every answer carries the `Status` and a `FlowPolicy` (new, `src/core/policy.ts`), both read from one pass over the journal (`Workspace.view()`; the `before` op uses `beforeView()`, which also says whether the call was recorded): whether there is a work item, the unit, the current state, `strict`, `rollback-on-error`, the Claude tool names the state admits, the command signals — each as two compiled pattern sources, `anywhere` (`signalPattern`, what `only-in` searches the line for) and `start` (`signalPatternAtStart`, what a command signal tests against each simple command) — with their `only-in` states, the file-signal globs, the tools already recorded as deviations since the stage was entered (`stageEntryRev`), and the signals the next guards read. The person-only rule needs no field: A3's command-line scanner moves, unchanged, out of `signals.ts` into `src/core/command-line.ts`, which imports nothing (`signals.ts` re-exports it), so the Node-free `fastpath.ts` asks the supervisor's own `personOnlyRefusal`, searches `only-in` patterns in the line and in its `withoutQuoting` copy as `onlyInRefusal` does, and splits a line with `signalHeads` exactly as `commandSignals` does. It decides per call: `pass` (no spawn) or `consult` (spawn `before`, which decides and records). After a call it spawns `after` only when a command signal's regex matches a Bash command with an exit status, a write-capability call touched a path matching a file-signal glob (or the file unit's glob), the Bash result carries `gitOperation`, the call errored in a `rollback-on-error` state, or `before` recorded something. The hooks module keeps the latest answer's status in `$.state`.
5. **git signals in Claude Code** are re-read at session start, on board open and refresh, and after a call whose result carries `gitOperation` — not after every `git`/`gh` command: a `git status` must not cost a gh round trip. gh is asked live only for `refresh`, `board` and `after` with `gitOperation`; every other op reuses the availability the last answer reported (the request's `gh`), so when A3's `after` applies git's facts after a command that runs git or gh (`runsGitOrGh`), it reads git alone and no gh. `GEMFLOW_GH` names the gh binary (A3's `ghFacts` reads it; tests point it at a stand-in that answers `gh pr list` and `gh run list` as `host-git.ts` asks them).
6. **Context delivery** (spec §5.4, host layer). When an answer reports a stage change — the op's `StageChange`, `Invoked` or `advance`/`mark` result carries `context`, which A3 sets when the op entered a state and only then — the hooks module appends that `#current` text to the tool result's `context` and records the answer's context key (the `<item>@<rev>` of `.geml/context.geml`) as delivered. `prompt.submit` reads `.geml/context.geml` with `$.fs.read`, parses the `flow-context` block with the Node-free `contextOf`, and attaches the text when its key differs from the delivered one and its `item` is the current work item. `session.end` (a `/clear` too) forgets the delivered key. Every workspace operation, opening one included, brings `.geml/context.geml` in line with the current work item (A3), so a document another work item left (a branch switch) is rewritten by the next bridge request; that answer carries no stage text (the document changed while the workspace opened, not during the op), and the next `prompt.submit` delivers it, its key differing from the delivered one.
7. **Gemflow's own tools are never a deviation.** `Supervisor.owns()` takes the five verb names of spec §8.5 — `flow_status` and `flow_context` as well as the three verbs it carries out — bare (dsh, pi, `gemflow mcp`) or as Claude Code lists the plugin's own (`mcp__gemflow__<name>`; `OWN_TOOL_PREFIX` in `src/core/verb-specs.ts`). A call to one is never refused, never recorded as a deviation and never rolled back on error, whichever process reports it. Task 7, which registers the tools, makes the change.
8. **Model verbs.** The hooks module registers the five tools of spec §8.5 with `$.tool.register` at `session.start` (`isDeferred: false`), listed as `mcp__gemflow__flow_status` … `flow_rollback`, served by the bridge's `verb` op. Their schemas are static (`src/core/verb-specs.ts`), shared with `gemflow mcp`: a schema that changed with the state would invalidate the prompt cache. Each is registered with an arrow-function hook: `claude plugin validate` refuses a hook passed as the result of a call. The plugin manifest declares no MCP server, which would list the same names twice. Manual signals are never tools. A model's `flow_transition` over an `approval` edge is refused with a pointer to the board.
9. **Fail open.** When Node is missing or too old, a spawn fails or times out, or an answer does not parse, the call goes through, nothing is recorded, and the band shows one line saying what is wrong. Strict refusals and `only-in` therefore hold only while the bridge is healthy (the README says so). Every gating hook carries `.catch(($, e, next) => next(e))`. The CLI side answers every request: a workspace that does not open is a problem shell (quiet for kind `none`, so the band draws nothing in a project without a workflow), and a throw — a journal that cannot be read, a lock held past its timeout, a verb that kept conflicting — is an error answer whose shell carries the problem for the band. Timeouts: 15 s per bridge call, 45 s for `refresh`, `board` and the command's `use`/`add`.
10. **Node lookup.** At `session.start`: `node --version` (major ≥ 22); otherwise `/bin/sh -lc "command -v node"` and that absolute path, checked the same way. The result is kept in `$.state`. The session's first status is read inside `session.start`; the `refresh` that asks git and gh runs from `$.clock.after(0, …)`, outside the start the first prompt waits on.
11. **The cross-host MCP server.** `gemflow mcp [--host h] [--root dir]` serves the five tools over stdio MCP, written by hand (initialize, ping, tools/list, tools/call; the parser's `mcp-core` dispatch is synchronous and names itself `geml`, so it is not reused). Each call opens the workspace afresh with `--host` (default `mcp`) and that host's own entry in `HOST_CAPABILITIES`, else `NO_CAPABILITIES`, and turns a throw into an error result. A verb that changes the stage appends the new `#current` text (the `context` A3's `Workspace.verb` returns) to its result, since such hosts have no other channel. `skills/gemflow/SKILL.md` tells MCP-only hosts to read `.geml/context.geml#current` every turn. Per-host plugin manifests for Codex, Grok and Gemini are not in this plan.
12. **The dev workflow** (spec §7.1, §4.1): `workflows/dev/flow.geml` with `flow-unit = "branch"`, `#build → #review → #deploy → #release → #done`, the signals table of §4.1, the two blocking points (`staging` `only-in=#deploy #release`, `prod` `only-in=#release`, `#release` entered over an `approval` edge), and every state's context in `workflows/dev/guide.geml` (`context="./guide.geml#…"`). It checks with no diagnostics. `init --template dev` and `/gemflow add dev` copy it. `workflows/coding/` and `workflows/refund/` stay.
13. **Band and board** (spec §8.1, §8.2). Their words are computed by Node-free pure functions over the status and the board data (`band.ts`, `board.ts`, tested with node:test, East Asian wide characters counted as two cells); the hooks module only lays them out with `Box`, `Text` and `Button`, which every surface has. The UI speaks Chinese, as the spec's examples do; model-facing text (tool descriptions, stage context, refusals) and A3's reasons stay English. No surface has a tab element, so the three tabs are a row of `Button`s over a `tab` atom. Board buttons call the bridge: `advance` (a person's move, `by=human`; the press is the approval), `mark` (tick or clear a manual signal), `bind` (bind a to-do to the current work item: A3's `bindInDocument` rewrites that one cell of `.geml/backlog.geml`, written under the backlog's lock). The board opens with `/gemflow board` (`$.ui.open({ id: "gemflow-board", title: "Gemflow" })`) and is never opened unasked. With no workflow in the project the band draws nothing.
14. **`/gemflow`** (spec §8.3): `/gemflow` (status), `/gemflow board`, `/gemflow use <workflow>`, `/gemflow add [workflow]` — the + menu: without a name it lists the bundled workflows; with one it copies it into `.geml/workflows/`, activating it only when the project has no workflow yet, and otherwise offers `/gemflow use <workflow>`.
15. **Purity guard.** A node:test test walks the hooks module's import closure (`hooks/*.tsx` → the `dist/…` files it imports, transitively) and fails on a `node:` import, any bare import other than the engine's `claude-code` (allowed in `hooks/` only), `import()`, or a Node global.
16. **Hooks tests** live in `tests/*.test.ts`, run by `claude plugin test` (which does not descend into `node_modules`) through `npm run test:claude`, outside the node:test suite. They drive the hooks in real event order with a scripted bridge answering `process.run`.

---

## What the sources say (checked while drafting; re-checked when A3 landed)

Read in `plugin-authoring/types/claude-code.d.ts` (2.1.295) and measured with a probe plugin under `claude plugin test` / `claude plugin validate` (Claude Code 2.1.296, 2026-10-12):

- **Bash result** (`BuiltinToolResults.Bash`): `backgroundTaskId?: string`, `returnCodeInterpretation?: string`, `gitOperation?: { commit?, push?, branch?, pr? }`. **`ToolCallResult`** has three arms: `{ deny }`; `{ result, context?, ref?, text?, isReadOnly? }`; `{ isError: true, result: unknown, text?, ref?, context? }` — on an error `result` is the stored error text, never the tool's record, and `text` is what the model read. A hook's own answer is `{ result }` (a string is fine) with optional `context`.
- **Tool inputs:** Bash `command`; Edit and Write `file_path` (absolute); NotebookEdit `notebook_path`. Glob and Grep are not in a native build's table, so compare `String(e.tool)`.
- **No tab element.** Every surface has `Box`, `Text`, `Button`, `Link`, `Code`, `Markdown`; terminal and desktop add `Input`, `Select`, `Client`. `AbovePrompt` is raised on terminal and desktop only, `Pane` on every surface. Both size to `e.props.bodyColumns`; `Pane` has `e.props.scroll.bodyRows`.
- **`command.run`** input carries `args: string` — everything after the name, `""` when nothing — plus `origin` and `presentation`; a hook answers `{ text, context? }`. `CommandSpec` is `{ name, description, argumentHint?, immediate? }`.
- **`ToolSpec.inputSchema`** is `Record<string, unknown>`, "a JSON schema object"; the probe registered `enum`, `required` and `additionalProperties: false`, validated, and served the call.
- **`ProcessRunInit`** is `{ cwd, env, stdin, timeoutMs }` (30 s default, 10 min at most); `$.process.run` rejects when the command cannot start or outlives the timeout. `$.fs.read(path)` resolves a relative path against the session's directory; a hook on `fs.read` sees the absolute path.
- **State:** `atom(ref, initial)`, `read($, atom)`, `update($, atom, fn)` from `'claude-code'`; a render hook never writes. The contract (`plugin.json` `"types"`) must export types and nothing else — `export {}` is refused — and declare every key the module reads or writes.
- **Hook order:** a matcher-less `tool.call` hook registered before a matcher hook runs above it (the probe's generic hook saw the plugin's own tool call first and passed it on with `next(e)`). A throwing hook with `.catch(($, e, next) => next(e))` lets the call proceed.
- **`$.clock.after(ms, fn)`** runs `fn` outside the hook; under `mock.clock(on)` it runs on `clock.settle()`.
- **The testing kit** (`claude-code/testing`): `test(name, ($, on) => …)`, `expect`, `mock.clock/store/env/session`. The test's `$` is the engine: `$.session.start({ cwd, surface, isInteractive })`, `$.tool.call({ tool, tool_use_id, …args })`, `$.prompt.submit({ text, wait, origin })`, `$.command.run({ command, args, origin, presentation })`, `$.ui.mount({ plugin, surface, component, props, requestId? })` → `find`, `findAll`, `press`, `drawn`, `unmount`. Nothing answers an engine call beneath the plugins: a test answers `session.start` (`{ cwd }`), `tool.register`, `command.register`, `ui.open`, `ui.toast`, `process.run`, `fs.read` with its own `on(…)` hooks (`{ value }` or `{ deny }`), else the call fails with "no implementation for …". The test's `$` has no `$.state`: read state through a drawing. A `Text` keeps no `key`; find it by `type` and `text`. `Button` and `Box` keep theirs.
- **`claude plugin test <dir>`** ran `tests/*.test.tsx` and skipped `node_modules/**/*.test.ts`; output ends `N pass` / `N fail`, exit 1 on a failure. **`claude plugin validate <dir>`** exits 1 on an error, refuses a relative import whose file is missing ("cannot import … no such file"), and lists each gating hook with or without `.catch`.

Re-read in A3's code at `ced07e7` (2026-10-12), with what that changes here:

- **Workspace results.** `StageChange.context`, `Invoked.context` and the `context` of `advance`/`mark` are set only when the op changed the stage (a new journal, a transition taken, or another state than before) and the context document holds its text. The bridge and `gemflow mcp` forward that field; neither compares context keys around an op.
- **Context document.** `openWorkspace` and every op reconcile `.geml/context.geml` (`staged` → `reconcile` → `writeContext`, under `.geml/context.geml.lock`); `context()` first rewrites a document that names another item. `buildStageContext` takes no host tool names: "Allowed here:" lists the workflow's own names (capabilities), and each host shows its own names from its policy.
- **Throws.** `withLock` gives up after 5 s with `gemflow: <path>.lock is held by another process …`; `actAsync` after five conflicting attempts with `gemflow: … kept changing while this operation ran …`; a journal path that cannot be read (a directory) throws `EISDIR` out of `openWorkspace`. A journal that will not resume is not a throw: `openWorkspace` answers `{ ok: false, kind: "journal", reason: "<journal> cannot be resumed: … Move it aside …" }`. No workflow: `kind: "none"`, its reason starting `no workflow here`.
- **gh.** `ghFacts(root, branch, { gh? })` runs `o.gh`, else `GEMFLOW_GH`, else `gh`: `pr list --head <branch> --state all --json state,number` (an empty list is a fact: not open, not merged) and `run list --branch <branch> --limit 20 --json workflowName,conclusion,headSha,createdAt` (runs on HEAD only). A missing binary is `{ available: false, reason: "gh is not installed" }`. `Status.gh` is present only when a git signal other than `committed` reads gh.
- **Signals.** `signals.ts` has no `PERSON_ONLY` regex; `personOnlyRefusal` scans command positions (`commandSegments`, `words`, `commandWordIndex`, launchers such as `npx`, shell strings such as `bash -c "…"`). `onlyInRefusal` searches the line and its `withoutQuoting` copy. Lines 19–196 and 251–254 and 289–500 of `signals.ts` (the scanner) import nothing and touch no Node global. `runsGitOrGh` decides whether `Workspace.after` reads git's facts again.
- **Supervisor.** `owns()` is `VERBS.includes(name)`, the three verbs only (Task 7 widens it). Deviations are recorded once per tool per stage entry, counted from `stageEntryRev`; `checkpointRev` is the rollback target and answers a different question.
- **Backlog.** `bindInDocument(source, id, target)` returns the document with one cell rewritten (or why not: `no backlog item <id>`, an id bound elsewhere, a table it cannot write); the caller writes it under the backlog's lock.
- **Files.** `globExists` answers `undefined` when its walk gave up (`fileSignals` then leaves that signal as it was); this plan never calls it — the fast path only matches globs (`globToRegExp`). `writeNew` creates a file that must not exist yet.
- **CLI.** `test/cli.test.mjs` pins `init`'s and `use`'s words: `wrote <dir>/ (active)`, `<path> already exists; not overwriting` (exit 1), `unknown template "<x>"; expected coding or refund` (exit 2; the list is every directory under `workflows/`, so it grows with `dev`), `gemflow: no workflow "<x>" in .geml/workflows (have: …)`. `use` warns when the current item's journal was started under another workflow. `tsconfig.json` sets no `noUnusedLocals`: tsc does not name an import left unused, so the steps that remove code name the imports to remove. `src/index.ts` exports neither `core/blocks.js` nor `workspace.js`.

Measured while revising (Claude Code 2.1.296, esbuild 0.28.2, 2026-10-12): every code step of Tasks 2–13 was run against A3's code in a scratch copy of `integrations/gemflow/` — the node:test files pass, through `dist/gemflow.mjs` where they spawn it; `claude plugin validate .` passes; `claude plugin test .` reports `7 pass`. Found doing so:

- `claude plugin validate` refuses a hook that is the result of a call (`on('tool.call', { tool: … }, serveVerb('flow_status'))`: "the hook is not a function literal or the name of one"), and shows a matcher value taken from an imported constant as `requestId=?`.
- `claude plugin test` refuses a test's `on(…)` made after the test's first `$` call ("the hooks beneath the plugins are registered before that"): a test registers every engine answer before `$.session.start`.
- A module-level read of `../package.json` throws when `dist/gemflow.mjs` runs alone, which is what the bundle test does; `gemflow mcp` reads its version when a client asks.

---

## File map

| Path (under `integrations/gemflow/` unless rooted) | Responsibility | Task |
|---|---|---|
| `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `types/index.d.ts` | the plugin; the hooks module; the `$.state` contract | 1, 7–10 |
| `scripts/bundle.mjs`, `package.json`, `package-lock.json` | `dist/gemflow.mjs`; scripts; `files`; esbuild | 1 |
| `test/bundle.test.mjs`, `test/plugin-files.test.mjs`, `test/hooks-purity.test.mjs`, `test/smoke.test.mjs` | the bundle runs alone; plugin files; purity guard | 1 |
| `src/core/command-line.ts` (new), `src/core/policy.ts` (new), `src/core/signals.ts`, `src/workspace.ts`, `src/index.ts`, `test/policy.test.mjs` | A3's command-line scanner, moved where nothing is imported; the policy snapshot; `policy()`, `view()`, `beforeView()` | 2 |
| `src/core/verb-specs.ts` (new), `src/verbs.ts` (new), `src/project.ts` (new), `src/cli.ts`, `src/index.ts`, `test/project.test.mjs` | five static tool specs and `OWN_TOOL_PREFIX`; verbs as text; add and use workflows | 3 |
| `src/hosts/claude-code/protocol.ts` (new), `src/bridge.ts` (new), `src/cli.ts`, `test/helpers/repo.mjs`, `test/protocol.test.mjs`, `test/bridge.test.mjs` | the bridge, both sides | 4 |
| `src/hosts/claude-code/fastpath.ts` (new), `test/fastpath.test.mjs` | pass or consult; after or not | 5 |
| `src/hosts/claude-code/readers.ts` (new), `test/readers.test.mjs` | exit code, touched path, gitOperation, context document, node version | 6 |
| `hooks/register.tsx`, `src/core/supervisor.ts`, `test/own-tools.test.mjs` | session start, tool calls, prompt submit, the five tools; gemflow's own tools never a deviation | 7 |
| `src/hosts/claude-code/band.ts` (new), `test/band.test.mjs`, `hooks/register.tsx` | the band | 8 |
| `src/hosts/claude-code/board.ts` (new), `test/board.test.mjs`, `hooks/register.tsx` | the board | 9 |
| `src/hosts/claude-code/command.ts` (new), `test/command.test.mjs`, `hooks/register.tsx` | `/gemflow` and the + menu | 10 |
| `workflows/dev/flow.geml`, `workflows/dev/guide.geml` (new), `src/cli.ts`, `test/dev-workflow.test.mjs`, `test/cli.test.mjs` | the dev workflow | 11 |
| `src/mcp.ts` (new), `src/cli.ts`, `skills/gemflow/SKILL.md` (new), `test/mcp.test.mjs` | `gemflow mcp`; the skill | 12 |
| `tests/hooks.test.ts` (new) | the hooks driven in real event order | 13 |
| `README.md`, `README.zh.md`, `/.claude-plugin/marketplace.json`, `/docs/design/specs/2026-10-11-gemflow-design.md` | install, behaviour, the spec's §8 | 14 |

---

### Task 1: The bundle, the plugin skeleton, and the purity guard

**Files:** Create `integrations/gemflow/.claude-plugin/plugin.json`, `integrations/gemflow/hooks/hooks.json`, `integrations/gemflow/hooks/register.tsx`, `integrations/gemflow/types/index.d.ts`, `integrations/gemflow/scripts/bundle.mjs`, `integrations/gemflow/test/bundle.test.mjs`, `integrations/gemflow/test/plugin-files.test.mjs`, `integrations/gemflow/test/hooks-purity.test.mjs`; modify `integrations/gemflow/package.json`, `integrations/gemflow/package-lock.json`, `integrations/gemflow/test/smoke.test.mjs`.

- [ ] **Step 1: Failing tests**

Create `integrations/gemflow/test/bundle.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = fileURLToPath(new URL("../dist/gemflow.mjs", import.meta.url));
const CODING = fileURLToPath(new URL("../workflows/coding/flow.geml", import.meta.url));

test("the bundle is one file that runs with no node_modules beside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "gemflow-bundle-"));
  copyFileSync(BUNDLE, join(dir, "gemflow.mjs"));
  copyFileSync(CODING, join(dir, "flow.geml"));
  const usage = spawnSync(process.execPath, [join(dir, "gemflow.mjs")], { cwd: dir, encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^usage: gemflow /);
  const check = spawnSync(process.execPath, [join(dir, "gemflow.mjs"), "check", "flow.geml"], { cwd: dir, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("the bundle imports only Node's built-ins and carries no parser CLI hand-off", () => {
  const src = readFileSync(BUNDLE, "utf8");
  const specs = [...src.matchAll(/^import\s[^;]*?from\s*"([^"]+)";?$/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.match(s, /^node:/, s);
  assert.doesNotMatch(src, /if \(isCliInvocation\(\)\) \{/);
});
```

Create `integrations/gemflow/test/plugin-files.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const at = (p) => new URL(`../${p}`, import.meta.url);
const json = (p) => JSON.parse(readFileSync(at(p), "utf8"));

test("the plugin manifest names gemflow, keeps the package's version and points at the state contract", () => {
  const plugin = json(".claude-plugin/plugin.json");
  const pkg = json("package.json");
  assert.equal(plugin.name, "gemflow");
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.types, "./types/index.d.ts");
  assert.ok(existsSync(at("types/index.d.ts")));
  assert.equal(plugin.mcpServers, undefined, "the hooks module serves the flow_* tools; a manifest MCP server would list them twice");
});

test("hooks.json names the one hooks module", () => {
  assert.deepEqual(json("hooks/hooks.json"), { modules: ["./register.tsx"] });
  assert.ok(existsSync(at("hooks/register.tsx")));
});

test("the package ships the plugin folders, builds the bundle and pins esbuild", () => {
  const pkg = json("package.json");
  for (const f of [".claude-plugin", "hooks", "types", "workflows", "dist"]) assert.ok(pkg.files.includes(f), f);
  assert.equal(pkg.scripts.build, "tsc && node scripts/bundle.mjs");
  assert.equal(pkg.scripts.test, "npm run build && node --test test/*.test.mjs");
  assert.equal(pkg.scripts["test:claude"], "npm run build && claude plugin validate . && claude plugin test .");
  assert.equal(pkg.devDependencies.esbuild, "0.28.2");
});
```

Create `integrations/gemflow/test/hooks-purity.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The hooks module runs inside Claude Code with no Node and no DOM, and loads
// only files it reaches by static relative import. This walks that closure
// from hooks/*.tsx through the dist/ files it imports.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOKS = resolve(ROOT, "hooks");
// A static import or re-export; group 1 is `type` (erased before the module runs), group 2 the specifier.
const STATIC = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["'][ \t]*;?[ \t]*$/gm;
const NODE_GLOBAL = /(?<![.\w$])(?:process\.\w|Buffer\b|__dirname\b|__filename\b|require\s*\()/;

function closure(entry) {
  const files = new Map();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop();
    if (files.has(file)) continue;
    assert.ok(existsSync(file), `${relative(ROOT, file)} is imported but missing (run npm run build)`);
    const src = readFileSync(file, "utf8");
    const specs = [...src.matchAll(STATIC)].filter((m) => !m[1]).map((m) => m[2]);
    files.set(file, { src, specs });
    for (const s of specs) if (s.startsWith(".")) todo.push(resolve(dirname(file), s));
  }
  return files;
}

test("the hooks module and everything it imports run without Node", () => {
  const entries = readdirSync(HOOKS).filter((n) => /\.(?:tsx?|jsx?|mjs)$/.test(n)).map((n) => resolve(HOOKS, n));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    for (const [file, { src, specs }] of closure(entry)) {
      const name = relative(ROOT, file);
      for (const s of specs) {
        if (s.startsWith(".")) continue;
        assert.ok(dirname(file) === HOOKS && s === "claude-code", `${name} imports "${s}": only the hooks module may import bare, and only the engine's 'claude-code'`);
      }
      assert.doesNotMatch(src, /\bimport\s*\(/, `${name} holds import(), which the engine refuses to load`);
      assert.doesNotMatch(src, NODE_GLOBAL, `${name} reaches for a Node global`);
    }
  }
});
```

- [ ] **Step 2: Watch them fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/bundle.test.mjs test/plugin-files.test.mjs test/hooks-purity.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 6` (no bundle, no plugin files, no hooks folder).

- [ ] **Step 3: Install esbuild, pinned**

Run: `cd integrations/gemflow && npm install --save-dev --save-exact esbuild@0.28.2 && grep '"esbuild"' package.json; cd ../..`
Expected: `    "esbuild": "0.28.2",` (and `package-lock.json` updated).

- [ ] **Step 4: Scripts and files**

In `integrations/gemflow/package.json`, set `scripts` to:

```json
  "scripts": {
    "build": "tsc && node scripts/bundle.mjs",
    "test": "npm run build && node --test test/*.test.mjs",
    "test:claude": "npm run build && claude plugin validate . && claude plugin test .",
    "pack:local": "node scripts/pack-local.mjs",
    "walkthrough": "node examples/walkthrough.mjs"
  },
```

and `files` to:

```json
  "files": [
    "dist",
    "skills",
    "examples",
    "workflows",
    ".claude-plugin",
    "hooks",
    "types",
    "cordis.patch.yml",
    "LICENSE"
  ],
```

- [ ] **Step 5: The bundle script**

Create `integrations/gemflow/scripts/bundle.mjs`:

```js
// One file for the Claude Code plugin: dist/gemflow.mjs is the CLI with
// @geml/geml inlined, so an installed plugin starts it with no dependency
// install. Node's built-ins stay external.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// The parser hands `node …/dist/geml.js` over to its CLI when that file is the
// script being run. Inlined, "that file" is the bundle itself, so the guard
// would fire and start dist/cli.js beside the bundle. The line goes; when it
// moves, the build fails here instead of in a person's session.
const HANDOFF = "if (isCliInvocation()) {";
const noParserHandoff = {
  name: "no-parser-cli-handoff",
  setup(b) {
    b.onLoad({ filter: /[\\/]dist[\\/]geml\.js$/ }, (args) => {
      const src = readFileSync(args.path, "utf8");
      if (!src.includes(HANDOFF)) throw new Error(`${args.path}: the parser's CLI hand-off moved; update scripts/bundle.mjs`);
      return { contents: src.replace(HANDOFF, "if (false) {"), loader: "js" };
    });
  },
};

await build({
  entryPoints: [`${root}src/cli.ts`],
  outfile: `${root}dist/gemflow.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  plugins: [noParserHandoff],
});
```

- [ ] **Step 6: The plugin's files**

Create `integrations/gemflow/.claude-plugin/plugin.json`:

```json
{
  "name": "gemflow",
  "version": "0.1.0",
  "description": "Workflow stages for Claude Code: a GEML statechart says what each stage needs, signals record test, PR, CI and deploy results, a line above the prompt shows where the work stands and a board moves it. Blocks only where the workflow says so.",
  "author": { "name": "geml-spec", "url": "https://github.com/geml-spec" },
  "homepage": "https://github.com/geml-spec/geml",
  "repository": "https://github.com/geml-spec/geml",
  "license": "MIT",
  "keywords": ["geml", "workflow", "statechart", "journal", "hooks"],
  "types": "./types/index.d.ts"
}
```

Create `integrations/gemflow/hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

Create `integrations/gemflow/hooks/register.tsx`:

```tsx
import type { Register } from 'claude-code'

// Gemflow's Claude Code shell. It runs with no Node and no DOM; the bundled
// CLI (dist/gemflow.mjs) does everything that touches the project.
export const register: Register = () => {}
```

Create `integrations/gemflow/types/index.d.ts`:

```ts
// The values Gemflow's hooks module keeps in $.state. What the bridge answers
// is kept as JSON; the module reads it as the protocol's types
// (src/hosts/claude-code/protocol.ts).
export type GemflowJson = null | boolean | number | string | readonly GemflowJson[] | { readonly [key: string]: GemflowJson }
export type GemflowTab = 'flow' | 'items' | 'journal'

declare module 'claude-code' {
  interface PluginState {
    gemflow: {
      shell: GemflowJson
      board: GemflowJson
      problem: string | null
      node: string | null
      root: string | null
      delivered: string | null
      lastFile: string | null
      tab: GemflowTab
    }
  }
}
```

- [ ] **Step 7: The smoke test's file list**

In `integrations/gemflow/test/smoke.test.mjs`, replace the `pkg.files` assertion (whatever list it holds) with:

```js
  assert.deepEqual([...pkg.files].sort(), [".claude-plugin", "LICENSE", "cordis.patch.yml", "dist", "examples", "hooks", "skills", "types", "workflows"]);
```

- [ ] **Step 8: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; ls -la dist/gemflow.mjs; cd ../..`
Expected: `exit=0`, `ℹ fail 0`, and `dist/gemflow.mjs` exists (a few hundred KB).

- [ ] **Step 9: Validate the plugin**

Run: `claude plugin validate integrations/gemflow; echo "exit=$?"`
Expected: `exit=0`; the report lists `types ./types/index.d.ts declares state: gemflow.shell, …` and ends `✔ Validation passed` (possibly `with warnings`).

- [ ] **Step 10: Commit**

```bash
git add integrations/gemflow/.claude-plugin/plugin.json integrations/gemflow/hooks/hooks.json integrations/gemflow/hooks/register.tsx integrations/gemflow/types/index.d.ts integrations/gemflow/scripts/bundle.mjs integrations/gemflow/package.json integrations/gemflow/package-lock.json integrations/gemflow/test/bundle.test.mjs integrations/gemflow/test/plugin-files.test.mjs integrations/gemflow/test/hooks-purity.test.mjs integrations/gemflow/test/smoke.test.mjs
git commit -m "feat(gemflow): the Claude Code plugin skeleton and a one-file CLI bundle

integrations/gemflow is the plugin root: plugin.json, hooks.json, an empty
hooks module and the \$.state contract. npm run build bundles src/cli.ts with
the parser inlined into dist/gemflow.mjs, so an installed plugin needs no
dependency install. A test walks the hooks module's import closure and fails
on anything that needs Node."
```

---

### Task 2: A Node-free command-line scanner, the policy snapshot, and the workspace's view

**Files:** Create `integrations/gemflow/src/core/command-line.ts`, `integrations/gemflow/src/core/policy.ts`, `integrations/gemflow/test/policy.test.mjs`; modify `integrations/gemflow/src/core/signals.ts`, `integrations/gemflow/src/workspace.ts`, `integrations/gemflow/src/index.ts`.

A3 already reads context blocks in process (`src/core/blocks.ts`) and brings the context document in line on every operation; this task adds neither.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/policy.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStatechart, signalPattern, signalPatternAtStart } from "../dist/core/statechart.js";
import { openRun } from "../dist/core/supervisor.js";
import { CLAUDE_CODE_CAPABILITIES } from "../dist/core/capabilities.js";
import * as signals from "../dist/core/signals.js";
import { personOnlyRefusal, runsGitOrGh, signalHeads, simpleCommands, withoutQuoting } from "../dist/core/command-line.js";
import { policyOf, relevantSignals } from "../dist/core/policy.js";
import { openWorkspace } from "../dist/workspace.js";

const LOCK = loadStatechart(
  '=== meta\nprofile = "geml-flow/v1"\nflow-signals = "#signals"\n===\n\n'
  + '=== flow-vars {#vars}\n{"type":"object","properties":{"t":{"type":"boolean","default":false},"o":{"type":"boolean","default":false},"d":{"type":"boolean","default":false}}}\n===\n\n'
  + '=== table {#signals}\n| id | on | match | sets | when | only-in |\n|---|---|---|---|---|---|\n'
  + '| tests | command | npm test | t | exit-zero | |\n| out | file | out/*.mp4 | o | exists | |\n| ship | command | wrangler deploy | d | exit-zero | #done |\n===\n\n'
  + '=== flow-state {#lock initial strict rollback-on-error tools="read"}\nLocked.\n===\n\n=== flow-state {#done final}\nDone.\n===\n\n'
  + '=== data {#green format=json}\n{"type":"object","properties":{"t":{"const":true}}}\n===\n\n'
  + '=== flow-transition {#go from=#lock to=#done auto requires=#green}\nGreen.\n===\n',
  "lock.geml").statechart;

const COMMANDS = [
  { id: "tests", anywhere: "npm test", start: "^(?:npm test)", onlyIn: [] },
  { id: "ship", anywhere: "wrangler deploy", start: "^(?:wrangler deploy)", onlyIn: ["done"] },
];

test("command-line.js is the scanner signals.js used: the same functions, re-exported", () => {
  for (const name of ["simpleCommands", "signalHeads", "personOnlyRefusal", "runsGitOrGh"]) {
    assert.equal(signals[name], { simpleCommands, signalHeads, personOnlyRefusal, runsGitOrGh }[name], name);
  }
  assert.deepEqual(signalHeads("cd x && FOO=1 BAR='a b' npm test"), ["cd x", "npm test"]);
  assert.equal(signalHeads("npm test | tee log"), null);
  assert.equal(signalHeads(`npm test ${"x".repeat(70_000)}`), null, "past the longest line a command signal reads");
  assert.deepEqual(signals.commandSignals(LOCK, { command: "cd x && FOO=1 npm test", exitCode: 0 }), [{ id: "tests", value: true }]);
  assert.deepEqual(signals.commandSignals(LOCK, { command: "echo npm test", exitCode: 0 }), []);
  assert.match(personOnlyRefusal('bash -c "cd x && npx -y @geml/gemflow advance done"'), /is for a person/);
  assert.equal(personOnlyRefusal("echo gemflow mark reviewed"), undefined);
  assert.equal(withoutQuoting('wran"gler"  deploy'), "wrangler deploy");
});

test("the policy's pattern sources are the statechart's own", () => {
  for (const [s, c] of LOCK.signals.filter((x) => x.on === "command").map((x, i) => [x, COMMANDS[i]])) {
    assert.equal(c.anywhere, signalPattern(s.match).source);
    assert.equal(c.start, signalPatternAtStart(s.match).source);
  }
});

test("policyOf: a strict state's tools as Claude names them, and its signals", () => {
  const run = openRun({ sc: LOCK, item: "t", statechartFile: "lock.geml", journalText: null, source: "startup", now: "t0" }).run;
  assert.deepEqual(policyOf(LOCK, run, "claude", CLAUDE_CODE_CAPABILITIES), {
    active: true, unit: { kind: "branch" }, commands: COMMANDS,
    files: [{ id: "out", glob: "out/*.mp4" }],
    state: "lock", strict: true, rollbackOnError: true, tools: ["Read"], deviated: [], relevant: ["tests"],
  });
});

test("policyOf with no run: inactive, nothing admitted or refused, the signals still listed", () => {
  assert.deepEqual(policyOf(LOCK, undefined, "claude", CLAUDE_CODE_CAPABILITIES), {
    active: false, unit: { kind: "branch" }, commands: COMMANDS,
    files: [{ id: "out", glob: "out/*.mp4" }], state: "", strict: false, rollbackOnError: false, deviated: [], relevant: [],
  });
  assert.deepEqual(relevantSignals(LOCK, "lock"), ["tests"]);
  assert.deepEqual(relevantSignals(LOCK, "done"), []);
});

const FIX = new URL("./fixtures/ws-dev/", import.meta.url);

function project({ branch = "feat/x", pr } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gemflow-policy-"));
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(FIX, join(root, ".geml", "workflows", "dev"), { recursive: true });
  writeFileSync(join(root, ".geml", "gemflow.geml"), '=== meta\nprofile = "geml-flow/v1"\nflow-workflow = "dev"\n===\n');
  let now = 0;
  return () => openWorkspace({
    root, host: "claude", capabilities: CLAUDE_CODE_CAPABILITIES,
    now: () => `2026-10-12T00:00:${String(now++).padStart(2, "0")}Z`,
    git: () => ({ branch, defaultBranch: "main", committed: true }),
    gh: () => (pr === undefined ? { available: false, reason: "gh is not installed" } : { available: true, prOpen: pr, prMerged: false, ci: [] }),
  });
}

test("Workspace.policy follows deviations, and a new stage starts it afresh", () => {
  const ws = project({ pr: true })().ws;
  assert.deepEqual(ws.policy().tools, ["Read", "Edit", "Write", "NotebookEdit", "Bash", "Grep", "Glob"]);
  ws.before("WebFetch", "c1", { url: "https://example.com" });
  assert.deepEqual(ws.policy().deviated, ["WebFetch"]);
  ws.after({ tool: "Bash", callId: "c2", isError: false, input: { command: "npm test" }, exitCode: 0 });
  ws.refresh();
  assert.equal(ws.policy().state, "review");
  assert.deepEqual(ws.policy().deviated, []);
});

test("view reads the status and the policy together; beforeView says what the call recorded", () => {
  const ws = project()().ws;
  assert.deepEqual(ws.view(), { status: ws.status(), policy: ws.policy() });
  const first = ws.beforeView("WebFetch", "c1", {});
  assert.deepEqual([first.refusal, first.recorded, first.policy.deviated, first.status.deviations], [undefined, true, ["WebFetch"], 1]);
  assert.equal(ws.beforeView("WebFetch", "c2", {}).recorded, false, "once per tool per stage entry");
  const person = ws.beforeView("Bash", "c3", { command: "gemflow mark reviewed" });
  assert.match(person.refusal, /is for a person/);
  assert.deepEqual([person.recorded, person.status.refusals], [true, 1]);
  assert.deepEqual(ws.beforeView("Edit", "c4", {}), { ...ws.view(), recorded: false }, "an admitted tool records nothing");
});

test("on the default branch the policy is inactive and beforeView records nothing", () => {
  const ws = project({ branch: "main" })().ws;
  assert.equal(ws.policy().active, false);
  assert.equal(ws.beforeView("Bash", "c1", { command: "gemflow mark reviewed" }).recorded, false);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/policy.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/core/command-line.js` (or `…/dist/core/policy.js`).

- [ ] **Step 3: The command-line scanner moves where nothing is imported**

Create `integrations/gemflow/src/core/command-line.ts` — A3's scanner from `signals.ts`, byte for byte, behind a new header, with `signalHeads` added and `withoutQuoting` exported:

```ts
// How a command line is read (spec §5.2): the simple commands of a plain `&&`
// chain for the command signals, every command position for the person-only
// rule and for whether git or gh ran, and a plain copy of the line for only-in.
// A small quote-aware scanner, not a shell parser. It imports nothing, so the
// Claude Code hooks module — which has no Node — reads a line with the very
// functions the signals module and the supervisor use.

/** The longest command line a command signal reads; the scanner is linear, but a signal pattern is the author's regular expression. */
export const MAX_SIGNAL_COMMAND_LENGTH = 65536;

/** The gemflow verbs only a person may run. */
const PERSON_VERBS: ReadonlySet<string> = new Set(["mark", "unmark", "advance"]);

/** A blank is a space or a tab: the only characters the shell splits words at (NBSP, VT, FF and the Unicode spaces are ordinary characters). */
const isBlank = (c: string): boolean => c === " " || c === "\t";

/** `NAME=` at the start of a word: the assignments a signal pattern skips; the looser form also takes `NAME+=` and `NAME[i]=`, which the shell reads as assignments too. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ASSIGNMENT_LIKE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
/** A redirection operator at the start of a word, with its optional file descriptor. */
const REDIRECTION = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<-?|<>|<&|>&|>>|>\||>|<)/;

/** Words that open, close or continue a shell compound command: a line whose command word is one is not a chain of simple commands. */
const COMPOUND_WORDS: ReadonlySet<string> = new Set([
  "[[", "]]", "{", "}", "function", "if", "then", "elif", "else", "fi", "while", "until", "do", "done", "for", "case", "esac", "select", "coproc", "repeat", "foreach",
]);
/** Builtins that can end the shell, or change what a later command word runs, so a chain holding one says nothing about the others. */
const SHELL_CHANGING_WORDS: ReadonlySet<string> = new Set(["exit", "exec", "trap", "return", "logout", "hash", "alias", "unalias", "function", "enable", "eval", "source", "."]);
/** Words that run the word after them: `builtin exit` is `exit`. */
const PREFIX_WORDS: ReadonlySet<string> = new Set(["builtin", "command", "time", "!", "noglob", "nocorrect"]);
/** The same, and the keywords that put a command right after them (`then gemflow mark x`, `{ gemflow mark x; }`). */
const COMMAND_INTRODUCERS: ReadonlySet<string> = new Set([...PREFIX_WORDS, "{", "if", "then", "elif", "else", "while", "until", "do"]);
/** A word that names the gemflow CLI: a command called gemflow (any path, any case, any `@version`) or the package's `cli` script. */
const GEMFLOW_WORD = /(?:^|\/)gemflow(?:@[^/]*)?(?:\.(?:[cm]?js|cmd|ps1))?$/i;
const GEMFLOW_CLI = /(?:^|\/)(?:gemflow\/(?:.*\/)?|(?:dist|src|bin)\/)cli\.[cm]?[jt]s$/i;
/** Commands that run a gemflow named among their arguments: package runners, interpreters and the wrappers that exec the next command. */
const LAUNCHERS: ReadonlySet<string> = new Set([
  "npx", "bunx", "pnpx", "npm", "pnpm", "yarn", "bun", "node", "nodejs", "deno", "tsx", "ts-node",
  "env", "exec", "nohup", "sudo", "doas", "timeout", "nice", "ionice", "xargs", "setsid", "stdbuf", "command", "builtin", "time",
]);
/** Commands that run a string they are given as shell. */
const SHELL_RUNNERS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "eval"]);

interface Word {
  /** The word as written, quotes and all. */
  raw: string;
  /** The word with quotes and backslashes removed. */
  text: string;
  /** Where the word starts in the command. */
  start: number;
  /** A `$` outside single quotes could turn the word into something else. */
  expands: boolean;
}

/** The words of one simple command, split at unquoted blanks. The scanner has already checked the quotes close. */
function words(command: string): Word[] {
  const out: Word[] = [];
  let start = -1, text = "", expands = false;
  let quote: string | null = null;
  const end = (at: number) => {
    if (start < 0) return;
    out.push({ raw: command.slice(start, at), text, start, expands });
    start = -1; text = ""; expands = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (start < 0) {
      if (isBlank(c)) continue;
      start = i;
    }
    if (quote === "'") {
      if (c === "'") quote = null; else text += c;
    } else if (quote === "$'") {
      if (c === "\\") i++; else if (c === "'") quote = null; else text += c;
    } else if (quote === '"') {
      if (c === "\\") text += command.charAt(++i);
      else if (c === '"') quote = null;
      else { if (c === "$") expands = true; text += c; }
    } else if (isBlank(c)) end(i);
    else if (c === "'" || c === '"') quote = c;
    else if (c === "$" && command.charAt(i + 1) === "'") { quote = "$'"; expands = true; i++; }
    else if (c === "\\") text += command.charAt(++i);
    else { if (c === "$") expands = true; text += c; }
  }
  end(command.length);
  return out;
}

/** The index of a simple command's command word — past assignments, redirections and the prefixes that run the next word — or -1 if it has none. */
function commandWordIndex(ws: readonly Word[], through: ReadonlySet<string> = PREFIX_WORDS): number {
  let prefixed = false;
  for (let i = 0; i < ws.length; ) {
    const w = ws[i];
    if (w === undefined) break;
    const redirect = w.raw.match(REDIRECTION);
    if (ASSIGNMENT_LIKE.test(w.raw)) i++;
    else if (redirect) i += redirect[0].length === w.raw.length ? 2 : 1; // `> file` takes the next word; `>file` does not
    else if (prefixed && w.text.startsWith("-")) i++; // an option of command or time
    else if (!w.expands && through.has(w.text)) { prefixed = true; i++; }
    else return i;
  }
  return -1;
}

/** Whether a simple command's exit status is the whole story of the command it names: not a shell keyword, not a builtin that ends the shell or rewrites what runs, not a word built by expansion. */
function speaksForItself(command: string): boolean {
  const ws = words(command);
  const at = commandWordIndex(ws);
  const w = at < 0 ? undefined : ws[at];
  return w === undefined || (!w.expands && !COMPOUND_WORDS.has(w.text) && !SHELL_CHANGING_WORDS.has(w.text));
}

function trimBlanks(s: string): string {
  let a = 0, b = s.length;
  while (a < b && isBlank(s.charAt(a))) a++;
  while (b > a && isBlank(s.charAt(b - 1))) b--;
  return s.slice(a, b);
}

/**
 * The simple commands of a command line that is nothing but simple commands
 * joined by `&&` — the only shape whose exit status speaks for each command in
 * it — or null for any other line. A small quote-aware scanner, not a shell
 * parser. Single quotes hide everything; `$'…'` hides everything but a
 * backslash escape; double quotes hide operators from the split (the shell
 * still runs `$(…)` and backticks inside them, which cannot change the status
 * of the command they sit in) but not `${`; a backslash outside quotes escapes
 * the next character (a backslash-newline is a line continuation). Blanks are
 * the space and the tab only. Outside quotes `;`, `||`, a pipe, a background
 * `&` (`&>` included), a newline, `$(`, `${`, `$[`, a backtick, `(` and a `#`
 * that starts a word (a comment) make the line null; a `&` inside a redirection
 * (`2>&1`, `>&log`) is not a background `&`. So does a simple command whose
 * command word is a shell keyword (`[[`, `{`, `function`, `if`, …), a builtin
 * that can end the shell or rewrite what runs (`exit`, `exec`, `trap`, `eval`,
 * `alias`, …, looking through `builtin` and `command`), or a word built by
 * expansion. A blank line has no commands; an empty command (`a &&`) or an
 * unterminated quote is not a command line at all.
 */
export function simpleCommands(line: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null; // ', " or $'
  let prev = ""; // the last character outside quotes, "" after a quote or an escape
  let wordStart = true; // the next character starts a word
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    const next = line.charAt(i + 1);
    if (quote !== null) {
      if (quote === '"' && c === "$" && next === "{") return null;
      cur += c;
      if (c === "\\" && quote !== "'" && i + 1 < line.length) cur += line.charAt(++i);
      else if (c === quote.slice(-1)) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c; cur += c; prev = ""; wordStart = false;
    } else if (c === "$" && next === "'") {
      quote = "$'"; cur += "$'"; i++; prev = ""; wordStart = false;
    } else if (c === "$" && (next === "(" || next === "{" || next === "[")) {
      return null;
    } else if (c === "\\") {
      if (next === "\n") { i++; continue; }
      cur += c + next; i++; prev = ""; wordStart = false;
    } else if (c === "&") {
      if (next === "&") { parts.push(cur); cur = ""; i++; prev = ""; wordStart = true; continue; }
      if (next === ">" || (prev !== ">" && prev !== "<")) return null;
      cur += c; prev = c; wordStart = true;
    } else if (c === "#" && wordStart) {
      return null;
    } else if (c === ";" || c === "|" || c === "\n" || c === "`" || c === "(") {
      return null;
    } else {
      cur += c; prev = c; wordStart = isBlank(c) || c === "<" || c === ">";
    }
  }
  if (quote !== null) return null;
  parts.push(cur);
  const commands = parts.map(trimBlanks);
  if (commands.length === 1 && commands[0] === "") return [];
  return commands.every((c) => c !== "" && speaksForItself(c)) ? commands : null;
}

/** A simple command without its leading `NAME=value` assignments. */
function withoutAssignments(command: string): string {
  const first = words(command).find((w) => !ASSIGNMENT_WORD.test(w.raw));
  return first === undefined ? "" : command.slice(first.start);
}

/** What a command signal's start-anchored pattern is tested against: each simple command of a plain `&&` chain, without its leading assignments; null when the line speaks for no command signal (too long, or not such a chain). */
export function signalHeads(line: string): string[] | null {
  if (line.length > MAX_SIGNAL_COMMAND_LENGTH) return null;
  const commands = simpleCommands(line);
  return commands === null ? null : commands.map(withoutAssignments);
}

/** The line with line continuations, quotes and backslashes removed and every run of blanks made one space: roughly the text the shell will read as words. */
export function withoutQuoting(command: string): string {
  return command.replace(/\\\n/g, "").replace(/['"\\]/g, "").replace(/[ \t]+/g, " ");
}

/** How many substitutions deep the person-only scan reads; a deeper line is judged loosely. */
const MAX_NESTING = 8;

/** The index of the `)` that closes a `$(` whose body starts at `from`, or -1. Quotes and nested substitutions are skipped. */
function substitutionEnd(line: string, from: number, depth = 0): number {
  if (depth > MAX_NESTING) return -1;
  let open = 1;
  for (let i = from; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === "\\") i++;
    else if (c === "'") { i = line.indexOf("'", i + 1); if (i < 0) return -1; }
    else if (c === '"') {
      for (i++; i < line.length && line.charAt(i) !== '"'; i++) {
        if (line.charAt(i) === "\\") i++;
        else if (line.charAt(i) === "$" && line.charAt(i + 1) === "(") { i = substitutionEnd(line, i + 2, depth + 1); if (i < 0) return -1; }
      }
      if (i >= line.length) return -1;
    } else if (c === "(") open++;
    else if (c === ")" && --open === 0) return i;
  }
  return -1;
}

/** The index of the backtick that closes a backtick substitution whose body starts at `from`, or -1. */
function backtickEnd(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line.charAt(i) === "\\") i++;
    else if (line.charAt(i) === "`") return i;
  }
  return -1;
}

/**
 * Every place a command could start in a line: its text split at `;`, `&`,
 * `|`, a newline, `(`, `)` and a backtick outside quotes, plus the commands
 * inside a `$(…)` or backtick substitution within double quotes. Quoting is
 * the scanner's (single quotes, `$'…'`, double quotes, backslashes); unlike
 * `simpleCommands` it asks for no particular shape. A `&` in a redirection
 * (`2>&1`, `&>log`) does not split. Null when a quote or substitution does
 * not close.
 */
function commandSegments(line: string, depth = 0): string[] | null {
  if (depth > MAX_NESTING) return null;
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let prev = "";
  const flush = () => {
    const text = trimBlanks(cur);
    if (text !== "") out.push(text);
    cur = "";
  };
  const nested = (body: string): boolean => {
    const inner = commandSegments(body, depth + 1);
    if (inner === null) return false;
    out.push(...inner);
    return true;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    const next = line.charAt(i + 1);
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
    } else if (quote === '"' && c === "$" && next === "(") {
      const end = substitutionEnd(line, i + 2, depth);
      if (end < 0 || !nested(line.slice(i + 2, end))) return null;
      cur += line.slice(i, end + 1); i = end;
    } else if (quote === '"' && c === "`") {
      const end = backtickEnd(line, i + 1);
      if (end < 0 || !nested(line.slice(i + 1, end))) return null;
      cur += line.slice(i, end + 1); i = end;
    } else if (quote !== null) {
      cur += c;
      if (c === "\\" && quote !== "'" && i + 1 < line.length) cur += line.charAt(++i);
      else if (c === quote.slice(-1)) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c; cur += c; prev = "";
    } else if (c === "$" && next === "'") {
      quote = "$'"; cur += "$'"; i++; prev = "";
    } else if (c === "\\") {
      if (next === "\n") { i++; continue; }
      cur += c + next; i++; prev = "";
    } else if (c === "&" && next !== "&" && (prev === ">" || prev === "<" || next === ">")) {
      cur += c; prev = c;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "`" || c === "(" || c === ")") {
      flush(); prev = "";
    } else {
      cur += c; prev = c;
    }
  }
  if (quote !== null) return null;
  flush();
  return out;
}

/** The arguments of a command that run gemflow: the first word after `at` that is neither an option, a redirection nor another way of naming gemflow. */
function personVerbAfter(ws: readonly Word[], at: number): string | undefined {
  for (let i = at + 1; i < ws.length; i++) {
    const w = ws[i];
    if (w === undefined) break;
    const redirect = w.raw.match(REDIRECTION);
    if (redirect) { if (redirect[0].length === w.raw.length) i++; continue; }
    if (w.text.startsWith("-") || namesGemflow(w.text)) continue;
    if (w.expands) return "mark|unmark|advance"; // the verb is built by expansion: it could be any of them
    const verb = w.text.toLowerCase();
    return PERSON_VERBS.has(verb) ? verb : undefined;
  }
  return undefined;
}

function namesGemflow(text: string): boolean {
  return GEMFLOW_WORD.test(text) || GEMFLOW_CLI.test(text);
}

/** When quoting or expansion hides the command word: a gemflow word and a verb word anywhere in the line, order aside. */
function personVerbLoosely(line: string): string | undefined {
  const plain = withoutQuoting(line);
  return /\bgemflow\b/i.test(plain) ? plain.match(/\b(mark|unmark|advance)\b/i)?.[1]?.toLowerCase() : undefined;
}

/** How deep a shell string inside a shell string is read before the line is judged loosely. */
const MAX_SHELL_DEPTH = 3;

/** The person-only verb a command line runs, or undefined. */
function personVerb(line: string, depth = 0): string | undefined {
  const segments = depth > MAX_SHELL_DEPTH ? null : commandSegments(line);
  if (segments === null) return personVerbLoosely(line);
  for (const segment of segments) {
    const ws = words(segment);
    const at = commandWordIndex(ws, COMMAND_INTRODUCERS);
    const head = at < 0 ? undefined : ws[at];
    if (head === undefined) continue;
    if (head.expands) {
      const verb = personVerbLoosely(line);
      if (verb !== undefined) return verb;
      continue;
    }
    if (namesGemflow(head.text)) {
      const verb = personVerbAfter(ws, at);
      if (verb !== undefined) return verb;
      continue;
    }
    const name = head.text.slice(head.text.lastIndexOf("/") + 1).toLowerCase();
    if (LAUNCHERS.has(name)) {
      for (let i = at + 1; i < ws.length; i++) {
        const w = ws[i];
        const verb = w !== undefined && namesGemflow(w.text) ? personVerbAfter(ws, i) : undefined;
        if (verb !== undefined) return verb;
      }
    } else if (SHELL_RUNNERS.has(name)) {
      const args = ws.slice(at + 1).map((w) => w.text);
      for (const arg of name === "eval" ? [args.join(" ")] : args) {
        const verb = personVerb(arg, depth + 1);
        if (verb !== undefined) return verb;
      }
    }
  }
  return undefined;
}

/** The person-only refusal's words for one verb: what the model reads, whichever scan found the verb. */
export function personOnlyReason(verb: string): string {
  return `\`gemflow ${verb}\` is for a person, not the model: manual signals and a person's transitions are never taken by the agent`;
}

/** A program name at the end of a path (either separator), without a Windows `.exe`. */
function programName(word: string): string {
  return word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).replace(/\.exe$/i, "");
}

/** git or gh as a word of their own, for a line that does not tokenise. */
const GIT_WORD = /(?:^|[\s;&|(`/\\])(?:git|gh)(?:\.exe)?(?=[\s;&|)`]|$)/i;

/**
 * Whether a command line runs git or gh: a command at any command position
 * (after `;`, `&&`, `|`, a newline, a subshell, a substitution, assignments, a
 * redirection or a prefix such as `command`) whose name is git or gh, at any
 * path. Naming either as an argument (`echo git push`) is not running it. A
 * line that does not tokenise counts when it holds either as a word: the
 * answer decides whether git's facts are read again, so the safe side is yes.
 */
export function runsGitOrGh(line: string): boolean {
  const segments = commandSegments(line);
  if (segments === null) return GIT_WORD.test(line);
  return segments.some((segment) => {
    const ws = words(segment);
    const at = commandWordIndex(ws, COMMAND_INTRODUCERS);
    const head = at < 0 ? undefined : ws[at];
    if (head === undefined || head.expands) return false;
    const name = programName(head.text);
    return name === "git" || name === "gh";
  });
}

/**
 * Why the model may not run this command — a manual signal or a person's
 * transition — or undefined. A command line is refused when one of its commands
 * (found at command position: after `;`, `&&`, `|`, a newline, a subshell, a
 * substitution, a prefix such as `env` or `command`, or a shell string such as
 * `bash -c "…"`) runs gemflow — a command called gemflow at any path, or one of
 * the package runners and interpreters given `@geml/gemflow` or its `cli`
 * script — and the first argument that is not an option is mark, unmark or
 * advance, in any case (or is built by expansion, so could be). Merely naming them (`echo gemflow mark`, a commit
 * message) is not a call. When the command word is built by expansion, or the
 * line does not tokenise, the line is refused if it holds gemflow and one of the
 * verbs as words.
 */
export function personOnlyRefusal(command: string): string | undefined {
  const verb = personVerb(command);
  return verb === undefined ? undefined : personOnlyReason(verb);
}
```

Replace `integrations/gemflow/src/core/signals.ts` with what stays there — the signal readers and `onlyInRefusal`, which compile patterns with `statechart.ts` — re-exporting the scanner so every importer of `signals.js` keeps working:

```ts
// Signals observe facts and turn them into the workflow's boolean variables
// (spec §5.2). Pure: the host gathers the facts — an exit status, whether a
// glob matches, what git and gh say — and these functions decide what each
// signal now reads. Writing the values is the supervisor's job. How a command
// line is read lives in command-line.ts, which imports nothing.
import { signalHeads, withoutQuoting } from "./command-line.js";
import { signalPattern, signalPatternAtStart, type Statechart } from "./statechart.js";

export { MAX_SIGNAL_COMMAND_LENGTH, personOnlyReason, personOnlyRefusal, runsGitOrGh, signalHeads, simpleCommands } from "./command-line.js";

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

/**
 * The command signals a finished call speaks for. A signal applies when its
 * pattern matches the start of some simple command (after leading assignments),
 * and only if the line is a plain `&&` chain; its value is the exit status.
 */
export function commandSignals(sc: Statechart, o: CommandOutcome): SignalValue[] {
  if (o.exitCode === null) return [];
  const heads = signalHeads(o.command);
  if (heads === null) return [];
  return sc.signals
    .filter((s) => {
      if (s.on !== "command") return false;
      const pattern = signalPatternAtStart(s.match);
      return heads.some((h) => pattern.test(h));
    })
    .map((s) => ({ id: s.id, value: o.exitCode === 0 }));
}

/** `exists` answers undefined when the host could not establish it (a walk that gave up): that signal is left as it was. */
export function fileSignals(sc: Statechart, exists: (glob: string) => boolean | undefined): SignalValue[] {
  const out: SignalValue[] = [];
  for (const s of sc.signals) {
    if (s.on !== "file") continue;
    const value = exists(s.match);
    if (value !== undefined) out.push({ id: s.id, value });
  }
  return out;
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
      let runs = f.ci;
      if (s.match) {
        // The check validates a command row's match only; a workflow filter that is not a pattern selects nothing, so the signal reads nothing.
        let filter: RegExp;
        try { filter = signalPattern(s.match); } catch { continue; }
        runs = runs.filter((r) => filter.test(r.workflow));
      }
      value = runs.length > 0 && runs.every((r) => r.success);
    }
    if (value !== undefined) out.push({ id: s.id, value });
  }
  return out;
}

/** The longest stretch of a command the refusals quote. */
const EXCERPT = 200;

/** The command for a message: whole up to EXCERPT characters, then cut (never inside a surrogate pair) and ended with an ellipsis. */
function excerpt(command: string): string {
  if (command.length <= EXCERPT) return command;
  let end = EXCERPT;
  const last = command.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return command.slice(0, end) + "…";
}

/**
 * Why a command may not run in this state because a command signal's only-in
 * excludes it, or undefined. The pattern is searched anywhere in the line, and
 * again in a copy with the quotes and backslashes removed and every run of
 * blanks made one space, so `wran"gler"  deploy` does not slip past
 * `wrangler deploy`. It sees only the text of the line: a variable, an `eval`
 * or a script the model wrote gets past it.
 */
export function onlyInRefusal(sc: Statechart, stateId: string, command: string): string | undefined {
  const plain = withoutQuoting(command);
  for (const s of sc.signals) {
    if (s.on !== "command" || s.onlyIn.length === 0) continue;
    const pattern = signalPattern(s.match);
    if (!pattern.test(command) && !pattern.test(plain)) continue;
    if (!s.onlyIn.includes(stateId)) {
      return `"${excerpt(command)}" may only run in ${s.onlyIn.map((x) => `#${x}`).join(", ")} (signal ${s.id}); the workflow is in #${stateId}`;
    }
  }
  return undefined;
}
```

Check that the scanner moved unchanged (before committing, while `HEAD` still holds A3's `signals.ts`):

Run: `diff <(git show HEAD:integrations/gemflow/src/core/signals.ts | sed -n '19,196p;289,500p') <(sed -n '8,185p;199,410p' integrations/gemflow/src/core/command-line.ts) && echo "moved unchanged"`
Expected: `moved unchanged`.

- [ ] **Step 4: The policy snapshot**

Create `integrations/gemflow/src/core/policy.ts`:

```ts
// What a host shell needs in order to decide, without asking the workspace,
// whether a tool call can matter to the workflow: the current state's tools
// and strictness, the command and file signals, and the tools already recorded
// as deviations since the state was entered. The person-only rule needs no
// field: a shell reads a command line with command-line.ts's personOnlyRefusal,
// the function the supervisor refuses with. Pure: the workspace computes the
// policy from the journal; a shell's fast path reads it.
import type { Run } from "./run.js";
import { hostTools, type CapabilityMap } from "./capabilities.js";
import { stageEntryRev } from "./snapshot.js";
import { effectiveTools, outgoing, signalPattern, signalPatternAtStart, type Statechart, type Unit } from "./statechart.js";

/**
 * A command signal as a shell without the statechart tests it: `anywhere` is
 * the source of the pattern `only-in` searches the whole line for (and the
 * line with its quoting removed, `withoutQuoting`), `start` the source of the
 * one tested against each of `signalHeads`' simple commands. Both are
 * compiled exactly as statechart.ts compiles them, with no flags.
 */
export interface PolicyCommand { id: string; anywhere: string; start: string; onlyIn: string[] }

export interface FlowPolicy {
  /** False when there is no work item (the default branch, no matching file yet): nothing is recorded or refused. */
  active: boolean;
  unit: Unit;
  state: string;
  strict: boolean;
  rollbackOnError: boolean;
  /** The host's tool names the state admits; absent when the state admits anything. */
  tools?: string[];
  commands: PolicyCommand[];
  files: { id: string; glob: string }[];
  /** Host tools recorded as deviations since the current stage was entered. */
  deviated: string[];
  /** Signals whose variable a guard of the current state's outgoing edges reads. */
  relevant: string[];
}

/** The signals whose variable a `requires` schema on one of the state's outgoing edges names. */
export function relevantSignals(sc: Statechart, stateId: string): string[] {
  const read = new Set<string>();
  for (const t of outgoing(sc, stateId)) {
    for (const name of [...Object.keys(t.requires?.properties ?? {}), ...(t.requires?.required ?? [])]) read.add(name);
  }
  return sc.signals.filter((s) => read.has(s.sets)).map((s) => s.id);
}

export function policyOf(sc: Statechart, run: Run | undefined, host: string, capabilities: CapabilityMap): FlowPolicy {
  const commands = sc.signals.filter((s) => s.on === "command").map((s) => ({
    id: s.id, anywhere: signalPattern(s.match).source, start: signalPatternAtStart(s.match).source, onlyIn: [...s.onlyIn],
  }));
  const files = sc.signals.filter((s) => s.on === "file").map((s) => ({ id: s.id, glob: s.match }));
  const base = { unit: sc.unit, commands, files };
  if (!run) return { ...base, active: false, state: "", strict: false, rollbackOnError: false, deviated: [], relevant: [] };
  const state = sc.states.get(run.snapshot.state);
  const names = state ? effectiveTools(sc, state) : sc.defaultTools;
  const entered = stageEntryRev(run.history);
  const deviated = [...new Set(run.deviationLog.filter((d) => d.rev >= entered).map((d) => d.tool))];
  return {
    ...base,
    active: true,
    state: run.snapshot.state,
    strict: state?.strict === true,
    rollbackOnError: state?.rollbackOnError === true,
    ...(names === undefined ? {} : { tools: hostTools(names, host, capabilities) }),
    deviated,
    relevant: relevantSignals(sc, run.snapshot.state),
  };
}
```

- [ ] **Step 5: The workspace's view**

In `integrations/gemflow/src/workspace.ts`:

1. Add, after the `./core/signals.js` import line:

```ts
import { policyOf, type FlowPolicy } from "./core/policy.js";
```

2. Add, right after the closing `}` of `export interface Status { … }`:

```ts

/** What a host shell keeps after every request: the status, and the policy its fast path decides from (core/policy.ts). */
export interface ShellView { status: Status; policy: FlowPolicy }
```

3. Replace the whole `status(): Status { … }` method (from `  status(): Status {` to the line before `  /** Before a tool call: the reason to refuse it, or undefined. */`) with:

```ts
  status(): Status {
    return this.view().status;
  }

  /** What a host shell's fast path decides from: see core/policy.ts. */
  policy(): FlowPolicy {
    return this.view().policy;
  }

  /** The status and the policy together, from one read of the journal: what a host shell keeps after every request. */
  view(): ShellView {
    return this.viewWith(() => undefined).view;
  }

  /**
   * `before` for a host shell: the refusal (or none), whether the call was
   * recorded — refused, or a first deviation in this stage — and the status
   * and policy after it, from one read of the journal.
   */
  beforeView(tool: string, callId?: string, input?: Record<string, unknown>): ShellView & { refusal?: string; recorded: boolean } {
    const r = this.viewWith((sup) => {
      const had = sup.run.deviationLog.length;
      const refusal = sup.deny(tool, callId, input);
      return { refusal, recorded: refusal !== undefined || sup.run.deviationLog.length > had };
    });
    const refusal = r.value?.refusal;
    return { ...r.view, ...(refusal !== undefined ? { refusal } : {}), recorded: r.value?.recorded ?? false };
  }

  /** Run `fn` under the journal's lock, then read the status and the policy from the same Supervisor. gh is asked before the lock is taken. */
  private viewWith<T>(fn: (sup: Supervisor) => T): { value: T | undefined; view: ShellView } {
    const gh = this.readsGh() ? this.ghFacts() : undefined;
    const r = this.act((sup) => {
      const value = fn(sup);
      return { value, view: { status: this.statusFrom(sup, gh), policy: policyOf(this.sc, sup.run, this.o.host, this.o.capabilities) } };
    });
    if (!r) return { value: undefined, view: { status: this.statusFrom(undefined, gh), policy: policyOf(this.sc, undefined, this.o.host, this.o.capabilities) } };
    return r.value;
  }

  /** The status as a Supervisor over this item's journal sees it; no Supervisor, no work item. */
  private statusFrom(sup: Supervisor | undefined, gh: GhFacts | undefined): Status {
    const base = {
      workflow: { name: this.workflowName, path: this.workflowFile, title: this.title },
      item: this.item,
      ...(gh === undefined ? {} : { gh: gh.available ? { available: true as const } : { available: false as const, reason: gh.reason } }),
    };
    if (!sup) return { ...base, vars: {}, signals: [], next: [], refusals: 0, deviations: 0 };
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
```

`status()` keeps its result; it now reads it through `viewWith`, which also computes the policy from the same Supervisor. gh is asked before the journal's lock is taken, as A3's `status()` did.

- [ ] **Step 6: Export it**

In `integrations/gemflow/src/index.ts`, add after the last `export *` line (A3 left `blocks.js` out; `command-line.js` is reached through `signals.js`'s re-exports):

```ts
export * from "./core/blocks.js";
export * from "./core/policy.js";
```

- [ ] **Step 7: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0` (A3's signals, supervisor, workspace and CLI tests pass unchanged).

- [ ] **Step 8: Commit**

```bash
git add integrations/gemflow/src/core/command-line.ts integrations/gemflow/src/core/policy.ts integrations/gemflow/src/core/signals.ts integrations/gemflow/src/workspace.ts integrations/gemflow/src/index.ts integrations/gemflow/test/policy.test.mjs
git commit -m "feat(gemflow): a Node-free command-line scanner, a policy snapshot for shells, and the workspace's view

The scanner A3 hardened moves out of signals.ts, unchanged, into
command-line.ts, which imports nothing; signals.ts re-exports it. A shell
with no Node then reads a line as the supervisor does: the person-only
rule, only-in on the line and its unquoted copy, and the simple commands a
command signal reads. policyOf says what such a shell needs to decide a tool
call without asking: the state's tools and strictness, the command signals
as compiled pattern sources, the file signals and this stage entry's
deviations. Workspace.view() reads the status and the policy from one pass
over the journal; beforeView() does the same after gate 3 and says whether
the call was recorded."
```

---

### Task 3: Static verb specs, verbs as text, and one place that adds and activates workflows

**Files:** Create `integrations/gemflow/src/core/verb-specs.ts`, `integrations/gemflow/src/verbs.ts`, `integrations/gemflow/src/project.ts`, `integrations/gemflow/test/project.test.mjs`; modify `integrations/gemflow/src/cli.ts`, `integrations/gemflow/src/index.ts`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/project.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITIGNORE, addWorkflow, bundledWorkflows, configText, projectWorkflows, useWorkflow } from "../dist/project.js";
import { FLOW_TOOLS, OWN_TOOL_PREFIX } from "../dist/core/verb-specs.js";
import { runVerb, statusForModel } from "../dist/verbs.js";
import { openWorkspace } from "../dist/workspace.js";
import { CLAUDE_CODE_CAPABILITIES } from "../dist/core/capabilities.js";

const tmp = () => mkdtempSync(join(tmpdir(), "gemflow-project-"));

test("bundled workflows are the directories under workflows/, sorted", () => {
  const names = bundledWorkflows();
  for (const n of ["coding", "refund"]) assert.ok(names.includes(n), n);
  assert.deepEqual(names, [...names].sort());
});

test("addWorkflow copies, ignores journals and context, and activates only when asked", () => {
  const root = tmp();
  assert.deepEqual(addWorkflow(root, "coding", { activate: true }), { ok: true, name: "coding", target: join(root, ".geml", "workflows", "coding"), activated: true });
  assert.ok(existsSync(join(root, ".geml", "workflows", "coding", "flow.geml")));
  assert.equal(readFileSync(join(root, ".geml", ".gitignore"), "utf8"), GITIGNORE);
  assert.equal(readFileSync(join(root, ".geml", "gemflow.geml"), "utf8"), configText("coding"));
  assert.equal(addWorkflow(root, "refund", { activate: false }).activated, false);
  assert.equal(readFileSync(join(root, ".geml", "gemflow.geml"), "utf8"), configText("coding"));
  assert.deepEqual(projectWorkflows(root), ["coding", "refund"]);
  const again = addWorkflow(root, "coding", { activate: true });
  assert.deepEqual([again.ok, again.code, again.reason], [false, 1, ".geml/workflows/coding already exists; not overwriting"]);
  const unknown = addWorkflow(root, "nope", { activate: true });
  assert.deepEqual([unknown.ok, unknown.code], [false, 2]);
  assert.match(unknown.reason, /^unknown template "nope"; expected coding or /);
});

test("useWorkflow names an installed workflow and refuses any other", () => {
  const root = tmp();
  addWorkflow(root, "refund", { activate: false });
  assert.deepEqual(useWorkflow(root, "refund"), { ok: true });
  assert.match(readFileSync(join(root, ".geml", "gemflow.geml"), "utf8"), /flow-workflow = "refund"/);
  assert.deepEqual(useWorkflow(root, "coding"), { ok: false, reason: 'no workflow "coding" in .geml/workflows (have: refund)' });
  assert.equal(useWorkflow(root, "../x").ok, false);
});

test("the five verb specs are static: names, and objects that close where they take arguments", () => {
  assert.deepEqual(FLOW_TOOLS.map((t) => t.name), ["flow_status", "flow_context", "flow_transition", "flow_set", "flow_rollback"]);
  for (const t of FLOW_TOOLS) assert.equal(t.inputSchema.type, "object", t.name);
  assert.deepEqual(FLOW_TOOLS.find((t) => t.name === "flow_transition").inputSchema.required, ["to"]);
  assert.deepEqual(FLOW_TOOLS.find((t) => t.name === "flow_rollback").inputSchema.required, ["to"]);
  assert.equal(FLOW_TOOLS.find((t) => t.name === "flow_set").inputSchema.additionalProperties, true);
  assert.equal(OWN_TOOL_PREFIX, "mcp__gemflow__");
});

function devWorkspace(branch, pr) {
  const root = tmp();
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(new URL("./fixtures/ws-dev/", import.meta.url), join(root, ".geml", "workflows", "dev"), { recursive: true });
  writeFileSync(join(root, ".geml", "gemflow.geml"), configText("dev"));
  return openWorkspace({
    root, host: "claude", capabilities: CLAUDE_CODE_CAPABILITIES,
    git: () => ({ branch, defaultBranch: "main", committed: false }),
    gh: () => (pr === undefined ? { available: false, reason: "gh is not installed" } : { available: true, prOpen: pr, prMerged: false, ci: [] }),
  }).ws;
}

test("runVerb answers in text the model reads", async () => {
  const ws = devWorkspace("feat/x");
  const status = await runVerb(ws, "flow_status", {});
  assert.equal(status.ok, true);
  assert.match(status.text, /^\[gemflow\] workflow dev \(\.geml\/workflows\/dev\/flow\.geml\)\nwork item feat\/x · state #build · rev 0\n/);
  assert.match(status.text, /\ngit signals unavailable: gh is not installed\n/);
  assert.match((await runVerb(ws, "flow_context", {})).text, /^\[gemflow\] stage #build/);
  const set = await runVerb(ws, "flow_set", { reviewed: true }, "v1");
  assert.equal(set.ok, false);
  assert.match(set.text, /^refused: /);
  assert.deepEqual(await runVerb(ws, "flow_transition", { to: "done" }, "v2"), { ok: false, text: "refused: no transition from #build to #done" });
});

test("a verb that moves the stage carries the new stage text", async () => {
  const ws = devWorkspace("feat/x", true);
  ws.after({ tool: "Bash", callId: "c1", isError: false, input: { command: "npm test" }, exitCode: 0 });
  assert.deepEqual(ws.refresh().entered, ["review"]);
  const done = await runVerb(ws, "flow_transition", { to: "done" }, "v1");
  assert.equal(done.ok, true);
  assert.match(done.context, /^\[gemflow\] stage #done/);
  assert.equal((await runVerb(ws, "flow_status", {})).context, undefined);
});

test("statusForModel on the default branch says nothing is tracked", () => {
  assert.match(statusForModel(devWorkspace("main").status()), /\nnot tracking: main · not tracked \(work items are branches\)$/);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/project.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/project.js`.

- [ ] **Step 3: The verb specs**

Create `integrations/gemflow/src/core/verb-specs.ts`:

```ts
// The five model verbs of spec §8.5 as every tool host lists them: the Claude
// Code hooks module registers them, `gemflow mcp` serves them. The schemas are
// static — a tool list that changed with the state would invalidate the
// prompt cache — so flow_status says what the current state offers.
export type VerbName = "flow_status" | "flow_context" | "flow_transition" | "flow_set" | "flow_rollback";

export interface FlowToolSpec {
  name: VerbName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** How Claude Code lists a tool the gemflow plugin registers: an MCP client's `mcp__<server>__<tool>`, the server being `gemflow`. */
export const OWN_TOOL_PREFIX = "mcp__gemflow__";

const NONE: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: false };

export const FLOW_TOOLS: readonly FlowToolSpec[] = [
  {
    name: "flow_status",
    description: "Where this project's Gemflow workflow stands: the work item, the current state, each signal's value, and the next states with whether their guards hold. Read-only.",
    inputSchema: NONE,
  },
  {
    name: "flow_context",
    description: "The current stage's context (.geml/context.geml, block #current): the state's instruction, what it allows, where it can go next, and the documents it names. Read-only.",
    inputSchema: NONE,
  },
  {
    name: "flow_transition",
    description: "Move the workflow to one of its next states (flow_status lists them). A guard that does not hold refuses the move. An edge that needs approval is a person's: they approve it on the Gemflow board or with `gemflow advance <state>`.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "The target state, without the leading #." } },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "flow_set",
    description: "Record workflow variables, by name. Variables a signal sets (test results, PR and CI state, a person's checks) are not yours to write; a value the workflow's schema refuses writes nothing.",
    inputSchema: { type: "object", description: "The variables to record, each under its own name.", additionalProperties: true },
  },
  {
    name: "flow_rollback",
    description: 'Restore the variables and state of an earlier revision: a revision number as a string, or "checkpoint" for the revision at which the current state was entered. Undoes recorded state only, never what a command already did.',
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: 'A revision number such as "3", or "checkpoint".' } },
      required: ["to"],
      additionalProperties: false,
    },
  },
];
```

Add `export * from "./core/verb-specs.js";` to `src/index.ts` after the lines Task 2 added.

- [ ] **Step 4: Verbs as text**

Create `integrations/gemflow/src/verbs.ts`:

```ts
// The five model verbs over a workspace, answered as the text a model reads.
// Shared by every host that reaches Gemflow through tools: the Claude Code
// bridge and the MCP server.
import type { VerbName } from "./core/verb-specs.js";
import type { Status, Workspace } from "./workspace.js";

/** A verb's answer; `context` is the new stage text when an accepted verb changed the stage. */
export interface VerbAnswer { ok: boolean; text: string; context?: string }

export function statusForModel(s: Status): string {
  const lines = [`[gemflow] workflow ${s.workflow.name} (${s.workflow.path})`];
  if (s.item.kind === "inactive") {
    lines.push(`not tracking: ${s.item.reason}`);
    return lines.join("\n");
  }
  lines.push(`work item ${s.item.id} · state #${s.state?.id ?? "?"} · rev ${s.state?.rev ?? 0}${s.state?.strict ? " · strict" : ""}`);
  lines.push(`signals: ${s.signals.length ? s.signals.map((x) => `${x.id}=${x.value ? "yes" : "no"} (${x.on})`).join(", ") : "none"}`);
  const next = s.next.map((t) => {
    const how = t.auto ? "on its own" : "by flow_transition or a person";
    const approval = t.approval ? ", needs a person's approval" : "";
    const guard = t.requires ? `, requires #${t.requires} (${t.holds ? "holds" : "does not hold"})` : "";
    return `#${t.to} ${how}${approval}${guard}`;
  });
  lines.push(`next: ${next.length ? next.join("; ") : "none (final state)"}`);
  if (s.gh !== undefined && !s.gh.available) lines.push(`git signals unavailable: ${s.gh.reason}`);
  lines.push(`refusals ${s.refusals} · deviations ${s.deviations}`);
  return lines.join("\n");
}

const APPROVAL_HINT = " — a person approves it on the Gemflow board (/gemflow board) or with `gemflow advance <state>`";

export async function runVerb(ws: Workspace, name: VerbName, args: Record<string, unknown>, callId?: string): Promise<VerbAnswer> {
  switch (name) {
    case "flow_status":
      return { ok: true, text: statusForModel(ws.status()) };
    case "flow_context":
      return { ok: true, text: ws.context() ?? "[gemflow] no stage context yet" };
    default: {
      const r = await ws.verb(name, args, callId);
      if (r.ok) return { ok: true, text: JSON.stringify(r.result), ...(r.context !== undefined ? { context: r.context } : {}) };
      return { ok: false, text: `refused: ${r.reason}${/approval was not granted/.test(r.reason) ? APPROVAL_HINT : ""}` };
    }
  }
}
```

- [ ] **Step 5: Adding and activating workflows**

Create `integrations/gemflow/src/project.ts`:

```ts
// The workflows a project holds and which one is active: copying a bundled
// workflow into .geml/workflows/, and naming the active one in
// .geml/gemflow.geml. Shared by the CLI's init and use and the Claude Code
// bridge's add and use.
import { constants, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, readText, writeAtomic, writeNew } from "./host-fs.js";
import { CONFIG_DOC, FLOW_FILE, GEML_DIR, WORKFLOWS_DIR } from "./core/layout.js";

/** The package's own workflows, beside dist/ — the same path from dist/project.js and from the bundle. */
const BUNDLED = fileURLToPath(new URL("../workflows/", import.meta.url));

/** What a project keeps out of git: the journals, the generated stage document and the lock files. */
export const GITIGNORE = "journals/\ncontext.geml\n*.lock\n";

/** The workflows this package ships: the directories under its `workflows/`. */
export function bundledWorkflows(): string[] {
  return readdirSync(BUNDLED, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** The workflows a project has: the directories of `.geml/workflows/` that hold a flow file. */
export function projectWorkflows(root: string): string[] {
  const dir = join(root, WORKFLOWS_DIR);
  if (!exists(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && exists(join(dir, e.name, FLOW_FILE))).map((e) => e.name).sort();
}

/** Copy a workflow's directory tree; a file that exists is an error. Text is written with LF line ends whatever the checkout used. */
function copyTree(from: string, to: string): void {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    const dest = join(to, e.name);
    if (e.isDirectory()) copyTree(src, dest);
    else if (/\.(geml|md)$/i.test(e.name)) writeNew(dest, readText(src).replace(/\r\n/g, "\n"));
    else { mkdirSync(to, { recursive: true }); copyFileSync(src, dest, constants.COPYFILE_EXCL); }
  }
}

/** The project's config document naming `name` as the active workflow. */
export function configText(name: string): string {
  return ["=== meta", 'title         = "Gemflow"', 'profile       = "geml-flow/v1"', `flow-workflow = ${JSON.stringify(name)}`, "===", ""].join("\n");
}

/** A workflow copied (`target` is its directory), or why not: 2 for a name the package does not ship, 1 for a directory that is already there. */
export type Added =
  | { ok: true; name: string; target: string; activated: boolean }
  | { ok: false; code: 1; reason: string; target: string }
  | { ok: false; code: 2; reason: string };

/** Copy the bundled workflow `name` into the project, add .geml/.gitignore when there is none, and make it active when asked. */
export function addWorkflow(root: string, name: string, o: { activate: boolean }): Added {
  const names = bundledWorkflows();
  if (!names.includes(name)) return { ok: false, code: 2, reason: `unknown template "${name}"; expected ${names.join(" or ")}` };
  const target = join(root, WORKFLOWS_DIR, name);
  const there = { ok: false as const, code: 1 as const, reason: `${WORKFLOWS_DIR}/${name} already exists; not overwriting`, target };
  if (exists(target)) return there;
  try {
    copyTree(join(BUNDLED, name), target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return there;
    throw e;
  }
  if (o.activate) writeAtomic(join(root, CONFIG_DOC), configText(name));
  const ignore = join(root, GEML_DIR, ".gitignore");
  if (!exists(ignore)) writeNew(ignore, GITIGNORE);
  return { ok: true, name, target, activated: o.activate };
}

/** Make an installed workflow the active one. Only a directory that is there is a workflow: a name is not a path out of .geml/workflows. */
export function useWorkflow(root: string, name: string): { ok: true } | { ok: false; reason: string } {
  const have = projectWorkflows(root);
  if (!have.includes(name)) return { ok: false, reason: `no workflow "${name}" in ${WORKFLOWS_DIR} (have: ${have.join(", ") || "none"})` };
  writeAtomic(join(root, CONFIG_DOC), configText(name));
  return { ok: true };
}
```

- [ ] **Step 6: The CLI's init and use go through it**

In `integrations/gemflow/src/cli.ts`:

1. Delete the helpers that moved into `project.ts`, each with its doc comment: `BUNDLED`, `bundledWorkflows`, `projectWorkflows`, `copyTree`, `activate` and `GITIGNORE`. Delete the imports only they used: the whole `node:fs` and `node:url` import lines, `join` from the `node:path` import, `exists`, `writeAtomic` and `writeNew` from `./host-fs.js` (keep `readText`), and `CONFIG_DOC`, `FLOW_FILE` and `GEML_DIR` from `./core/layout.js` (keep `WORKFLOWS_DIR`). The project sets no `noUnusedLocals`, so tsc would not name them.
2. Add, after the `./core/schema.js` import:

```ts
import { addWorkflow, useWorkflow, type Added } from "./project.js";
```

3. Replace the whole `case "init": { … }` and `case "use": { … }` blocks with:

```ts
    case "init": {
      // `coding` is the default because that is what a repository is for: the
      // states are explore / plan / implement / verify / review, and the point
      // of them is that a file cannot be edited before a plan is recorded and
      // nothing reaches "done" without a recorded test result.
      const template = flag(rest, "--template") ?? "coding";
      const pos = positionals("init", rest, ["--no-activate"], ["--template"]);
      if (pos.length > 1) fail(USAGE, 2);
      let r: Added;
      try { r = addWorkflow(resolve(pos[0] ?? "."), template, { activate: !has(rest, "--no-activate") }); }
      catch (e) { return fail(String(e), 1); }
      if (!r.ok) return fail(r.code === 1 ? `${shown(r.target)} already exists; not overwriting` : r.reason, r.code);
      console.log(`wrote ${shown(r.target)}/${r.activated ? " (active)" : ""}`);
      return 0;
    }
    case "use": {
      const pos = positionals("use", rest, [], []);
      if (pos.length !== 1) fail(USAGE, 2);
      const name = pos[0]!;
      const root = process.cwd();
      const r = useWorkflow(root, name);
      if (!r.ok) return fail(`gemflow: ${r.reason}`, 1);
      console.log(`active workflow: ${name}`);
      const foreign = foreignJournal(root);
      if (foreign) {
        console.error(`gemflow: warning: ${foreign.journal} was started under ${foreign.statechart}; under ${name} it resumes only while its current state exists there. Move it aside to start ${foreign.item} over.`);
      }
      return 0;
    }
```

Run: `grep -nE 'copyTree|activate\(|GITIGNORE|bundledWorkflows|projectWorkflows|from "node:(fs|url)"' integrations/gemflow/src/cli.ts; echo "exit=$?"`
Expected: `exit=1` (nothing left).

- [ ] **Step 7: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0` (A3's `init`/`use` CLI tests keep passing: same messages, exit codes, `.gitignore` and config text).

- [ ] **Step 8: Commit**

```bash
git add integrations/gemflow/src/core/verb-specs.ts integrations/gemflow/src/verbs.ts integrations/gemflow/src/project.ts integrations/gemflow/src/cli.ts integrations/gemflow/src/index.ts integrations/gemflow/test/project.test.mjs
git commit -m "feat(gemflow): static specs for the five verbs, verbs answered as text, one place that adds workflows

The flow_* tool schemas do not change with the state, so every tool host can
register them once. runVerb answers a verb in the words a model reads, with
the new stage text when the verb moved the stage. project.ts takes over the
CLI's helpers that copy a bundled workflow and name the active one; init and
use go through it with the same words, as the Claude Code bridge will."
```

---

### Task 4: The bridge — protocol, the CLI's `hook` verb, and every op tested through the bundle

**Files:** Create `integrations/gemflow/src/hosts/claude-code/protocol.ts`, `integrations/gemflow/src/bridge.ts`, `integrations/gemflow/test/helpers/repo.mjs`, `integrations/gemflow/test/protocol.test.mjs`, `integrations/gemflow/test/bridge.test.mjs`; modify `integrations/gemflow/src/cli.ts`.

- [ ] **Step 1: Test helpers**

Create `integrations/gemflow/test/helpers/repo.mjs`:

```js
// Projects on disk for the tests that go through the bundled CLI.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE = fileURLToPath(new URL("../../dist/gemflow.mjs", import.meta.url));

/** A git repository with one empty commit on main, checked out on `branch`. */
export function gitRepo(branch = "feat/x") {
  const root = mkdtempSync(join(tmpdir(), "gemflow-repo-"));
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "init");
  if (branch !== "main") git("checkout", "-qb", branch);
  return root;
}

/** Copy a workflow directory into the project and make it the active one. */
export function withWorkflow(root, dir, name) {
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  cpSync(dir, join(root, ".geml", "workflows", name), { recursive: true });
  writeFileSync(join(root, ".geml", "gemflow.geml"), `=== meta\nprofile = "geml-flow/v1"\nflow-workflow = "${name}"\n===\n`);
}

// What host-git.ts asks gh: `pr list --head <branch> --state all --json state,number`
// and `run list --branch <branch> --limit 20 --json workflowName,conclusion,headSha,createdAt`.
const FAKE_GH = `#!/usr/bin/env node
// A stand-in for gh: answers \`pr list\` and \`run list\` from the JSON file FAKE_GH_STATE names.
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const s = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const [cmd, sub] = process.argv.slice(2);
if (cmd === "pr" && sub === "list") {
  process.stdout.write(JSON.stringify(s.pr ? [{ state: s.pr, number: 7 }] : []) + "\\n");
} else if (cmd === "run" && sub === "list") {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const runs = (s.runs || []).map((r) => ({ workflowName: r.name, conclusion: r.conclusion, headSha: head, createdAt: "2026-10-12T00:00:00Z" }));
  process.stdout.write(JSON.stringify(runs) + "\\n");
} else process.exit(1);
`;

/** A gh stand-in outside any repository; `set` rewrites what it answers. */
export function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), "gemflow-gh-"));
  const bin = join(dir, "fake-gh");
  const state = join(dir, "fake-gh.json");
  writeFileSync(bin, FAKE_GH);
  chmodSync(bin, 0o755);
  const set = (s) => writeFileSync(state, JSON.stringify(s));
  set({});
  return { env: { GEMFLOW_GH: bin, FAKE_GH_STATE: state }, set };
}

/** One bridge request through the bundled CLI: exactly one answer line, parsed. */
export function hook(root, req, env = {}) {
  const r = spawnSync(process.execPath, [BUNDLE, "hook"], {
    cwd: root, input: JSON.stringify({ v: 1, root, ...req }), encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000,
  });
  const lines = r.stdout.trim().split("\n");
  if (r.status !== 0 || lines.length !== 1) throw new Error(`hook exit ${r.status}: ${r.stdout}${r.stderr}`);
  return JSON.parse(lines[0]);
}
```

- [ ] **Step 2: Failing tests**

Create `integrations/gemflow/test/protocol.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, decodeRequest, decodeResponse, encodeRequest } from "../dist/hosts/claude-code/protocol.js";

test("requests: one JSON line; the CLI refuses what it cannot run", () => {
  const req = { v: 1, root: "/r", op: "before", tool: "Bash", callId: "c1", input: { command: "ls" } };
  assert.equal(encodeRequest(req), `${JSON.stringify(req)}\n`);
  assert.deepEqual(decodeRequest(encodeRequest(req)), req);
  assert.deepEqual(decodeRequest("nope"), { error: "the request is not JSON" });
  assert.deepEqual(decodeRequest('{"v":2,"root":"/r","op":"status"}'), { error: "protocol version 2; this CLI speaks 1" });
  assert.deepEqual(decodeRequest('{"v":1,"op":"status"}'), { error: "root is required" });
  assert.deepEqual(decodeRequest('{"v":1,"root":"/r","op":"nope"}'), { error: "unknown op nope" });
  assert.deepEqual(decodeRequest('{"v":1,"root":"/r","op":"before","tool":"Bash"}'), { error: "op before: missing or mistyped fields" });
  assert.deepEqual(decodeRequest('{"v":1,"root":"/r","op":"verb","name":"rm","args":{}}'), { error: "op verb: missing or mistyped fields" });
});

test("answers: the last line that parses as this protocol's version", () => {
  const ok = { v: PROTOCOL_VERSION, ok: true, shell: { status: null, policy: null, contextKey: null } };
  assert.deepEqual(decodeResponse(`noise\n${JSON.stringify(ok)}\n`), ok);
  assert.equal(decodeResponse('{"v":9,"ok":true}\n'), undefined);
  assert.equal(decodeResponse(""), undefined);
});
```

Create `integrations/gemflow/test/bridge.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readContextDoc } from "../dist/core/stagehand.js";
import { fakeGh, gitRepo, hook, withWorkflow } from "./helpers/repo.mjs";

const WS_DEV = fileURLToPath(new URL("./fixtures/ws-dev/", import.meta.url));
const NO_GH = { GEMFLOW_GH: "gh-definitely-not-installed" };
const project = () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  return root;
};

test("status: the shell a hooks module starts from", () => {
  const r = hook(project(), { op: "status" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.shell.status.item, { kind: "item", id: "feat/x" });
  assert.equal(r.shell.status.state.id, "build");
  assert.deepEqual(r.shell.policy.tools, ["Read", "Edit", "Write", "NotebookEdit", "Bash", "Grep", "Glob"]);
  assert.deepEqual(r.shell.policy.relevant, ["tests", "pr"]);
  assert.equal(r.shell.contextKey, "feat/x@0");
  assert.deepEqual(r.shell.status.gh, { available: true }, "a cheap op does not ask gh");
});

test("before: a deviation is recorded once per stage entry; a person's command is refused", () => {
  const root = project();
  const first = hook(root, { op: "before", tool: "WebFetch", callId: "c1", input: {} });
  assert.deepEqual([first.refusal, first.recorded, first.shell.policy.deviated], [undefined, true, ["WebFetch"]]);
  assert.equal(hook(root, { op: "before", tool: "WebFetch", callId: "c2", input: {} }).recorded, false);
  const person = hook(root, { op: "before", tool: "Bash", callId: "c3", input: { command: "gemflow mark reviewed" } });
  assert.match(person.refusal, /for a person/);
  assert.equal(person.recorded, true);
});

test("after, refresh, advance: a test run and an open PR move the workflow; the new stage text comes back", () => {
  const root = project();
  const gh = fakeGh();
  hook(root, { op: "status" });
  const ran = hook(root, { op: "after", tool: "Bash", callId: "c1", input: { command: "npm test" }, isError: false, exitCode: 0, gitOperation: false });
  assert.deepEqual(ran.entered, []);
  assert.equal(ran.shell.status.vars["tests-pass"], true);
  assert.equal(ran.context, undefined);
  gh.set({ pr: "OPEN" });
  const review = hook(root, { op: "refresh" }, gh.env);
  assert.deepEqual(review.entered, ["review"]);
  assert.match(review.context, /^\[gemflow\] stage #review/);
  assert.equal(review.shell.contextKey, "feat/x@3");
  assert.equal(hook(root, { op: "status" }).context, undefined, "an unchanged stage sends no text");
  const done = hook(root, { op: "advance", to: "done" });
  assert.deepEqual(done.entered, ["done"]);
  assert.match(done.context, /^\[gemflow\] stage #done/);
});

test("refresh without gh says why the git signals are unavailable", () => {
  const r = hook(project(), { op: "refresh" }, NO_GH);
  assert.deepEqual(r.shell.status.gh, { available: false, reason: "gh is not installed" });
});

test("a context document another work item left is put right by the next request, which sends no stage text", () => {
  const root = project();
  hook(root, { op: "status" });
  const path = join(root, ".geml", "context.geml");
  writeFileSync(path, readFileSync(path, "utf8").replace('item="feat/x"', 'item="feat/other"'));
  const r = hook(root, { op: "status" });
  assert.equal(readContextDoc(readFileSync(path, "utf8")).item, "feat/x");
  assert.deepEqual([r.shell.contextKey, r.context], ["feat/x@0", undefined], "the next prompt delivers it: its key differs from the one delivered");
});

test("verb: the model's tools answer in text", () => {
  const root = project();
  assert.match(hook(root, { op: "verb", name: "flow_status", args: {} }).text, /work item feat\/x · state #build/);
  assert.match(hook(root, { op: "verb", name: "flow_context", args: {} }).text, /^\[gemflow\] stage #build/);
  assert.match(hook(root, { op: "verb", name: "flow_set", args: { "tests-pass": true }, callId: "v1" }).text, /^refused: /);
  assert.equal(hook(root, { op: "verb", name: "flow_transition", args: { to: "done" }, callId: "v2" }).text, "refused: no transition from #build to #done");
});

test("mark and advance are a person's; a missing edge is an error answer", () => {
  const root = project();
  assert.equal(hook(root, { op: "mark", signal: "reviewed", checked: true }).shell.status.vars.reviewed, true);
  const bad = hook(root, { op: "advance", to: "nowhere" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no transition from #build to #nowhere/);
});

test("board: the graph, the work items and the journal timeline", () => {
  const root = project();
  hook(root, { op: "status" });
  const r = hook(root, { op: "board" }, NO_GH);
  assert.deepEqual(r.board.states.map((s) => s.id), ["build", "review", "done"]);
  assert.deepEqual(r.board.transitions.map((t) => [t.from, t.to, t.auto]), [["build", "review", true], ["review", "done", false]]);
  assert.deepEqual(r.board.onlyIn, []);
  assert.equal(r.board.backlog, null);
  assert.deepEqual(r.board.items, [{ id: "feat/x", state: "build", rev: 0 }]);
  const first = r.board.timeline[0];
  assert.deepEqual(first, { kind: "snapshot", rev: 0, at: first.at, state: "build", cause: "enter" });
});

test("bind: a to-do joins the current work item, one cell rewritten under the backlog's lock", () => {
  const root = project();
  const backlog = join(root, ".geml", "backlog.geml");
  writeFileSync(backlog, '=== meta\ntitle = "Backlog"\nprofile = "geml-flow/v1"\n===\n\n=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| dark-mode | 设置页支持深色模式 | |\n===\n');
  assert.equal(hook(root, { op: "bind", id: "dark-mode" }).ok, true);
  assert.equal(readFileSync(backlog, "utf8"), '=== meta\ntitle = "Backlog"\nprofile = "geml-flow/v1"\n===\n\n=== table {#backlog}\n| id | title | branch |\n|---|---|---|\n| dark-mode | 设置页支持深色模式 | feat/x |\n===\n');
  const again = hook(root, { op: "bind", id: "nope" });
  assert.deepEqual([again.ok, again.error], [false, "no backlog item nope"]);
});

test("add lists the bundled workflows and copies one; use switches", () => {
  const root = gitRepo("main");
  const list = hook(root, { op: "add" });
  assert.ok(list.workflows.includes("coding") && list.workflows.includes("refund"));
  assert.deepEqual(list.installed, []);
  assert.equal(list.shell.problem.quiet, true);
  const added = hook(root, { op: "add", workflow: "coding" });
  assert.deepEqual(added.added, { name: "coding", activated: true });
  assert.deepEqual(added.shell.status.item, { kind: "inactive", reason: "main · not tracked (work items are branches)" });
  assert.deepEqual(hook(root, { op: "add", workflow: "refund" }).added, { name: "refund", activated: false });
  assert.equal(hook(root, { op: "use", workflow: "refund" }).ok, true);
  assert.match(readFileSync(join(root, ".geml", "gemflow.geml"), "utf8"), /flow-workflow = "refund"/);
  assert.equal(hook(root, { op: "use", workflow: "nope" }).ok, false);
});

test("no workflow is a quiet problem; a journal that will not resume, a throw and a bad request are answers, not crashes", () => {
  const empty = gitRepo();
  const r = hook(empty, { op: "status" });
  assert.deepEqual([r.ok, r.shell.status, r.shell.problem.quiet], [true, null, true]);
  assert.equal(hook(empty, { op: "verb", name: "flow_status", args: {} }).ok, false);
  const root = project();
  hook(root, { op: "status" });
  writeFileSync(join(root, ".geml", "journals", "feat", "x.geml"), '=== meta\ntitle = "broken"\n===\n');
  const broken = hook(root, { op: "status" });
  assert.deepEqual([broken.ok, broken.shell.status, broken.shell.problem.quiet], [true, null, false]);
  assert.match(broken.shell.problem.text, /cannot be resumed/);
  const odd = project();
  mkdirSync(join(odd, ".geml", "journals", "feat", "x.geml"), { recursive: true });
  const thrown = hook(odd, { op: "status" });
  assert.deepEqual([thrown.ok, thrown.shell.status, thrown.shell.problem.quiet], [false, null, false]);
  assert.match(thrown.error, /^gemflow: EISDIR/);
  assert.deepEqual(hook(root, { op: "nope" }), { v: 1, ok: false, error: "unknown op nope" });
});
```

- [ ] **Step 3: Watch them fail**

Run: `cd integrations/gemflow && npm run build >/dev/null; node --test test/protocol.test.mjs test/bridge.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/hosts/claude-code/protocol.js`, and the bridge tests fail (`hook exit 2`: `hook` is no verb yet).

- [ ] **Step 4: The protocol**

Create `integrations/gemflow/src/hosts/claude-code/protocol.ts`:

```ts
// The bridge between the Claude Code hooks module (no Node) and the bundled
// CLI (Node): one JSON request on the CLI's stdin, one JSON answer line on its
// stdout, both shaped here. Node-free: the hooks module imports this file.
import type { FlowPolicy } from "../../core/policy.js";
import type { VerbName } from "../../core/verb-specs.js";
import type { Status } from "../../workspace.js";

export type { VerbName } from "../../core/verb-specs.js";

export const PROTOCOL_VERSION = 1;
/** How long one bridge call may take before the hooks module lets the tool call through. */
export const BRIDGE_TIMEOUT_MS = 15_000;
/** Calls that ask git and gh, or copy files: refresh, board, use, add. */
export const SLOW_TIMEOUT_MS = 45_000;

/** gh's availability as the last answer reported it; a request carries it back so cheap ops need not ask gh. */
export type GhSeen = NonNullable<Status["gh"]>;

export type BridgeOp =
  | { op: "status" }
  | { op: "refresh" }
  | { op: "before"; tool: string; callId: string; input: Record<string, unknown> }
  | { op: "after"; tool: string; callId: string; input: Record<string, unknown>; isError: boolean; exitCode?: number | null; wrotePath?: string; gitOperation: boolean }
  | { op: "verb"; name: VerbName; args: Record<string, unknown>; callId?: string }
  | { op: "mark"; signal: string; checked: boolean }
  | { op: "advance"; to: string }
  | { op: "bind"; id: string }
  | { op: "use"; workflow: string }
  | { op: "add"; workflow?: string }
  | { op: "board" };

export type BridgeRequest = { v: 1; root: string; lastFile?: string; gh?: GhSeen } & BridgeOp;

export interface ShellStatus {
  status: Status | null;
  policy: FlowPolicy | null;
  /** `<item>@<rev>` of .geml/context.geml; null when there is none. */
  contextKey: string | null;
  /** Why there is no status; quiet when the project simply has no workflow. */
  problem?: { text: string; quiet: boolean };
}

export type TimelineEntry =
  | { kind: "snapshot"; rev: number; at: string; state: string; cause: string; by?: string; signal?: string }
  | { kind: "refused"; rev: number; at: string; tool: string; reason: string }
  | { kind: "deviation"; rev: number; at: string; tool: string; state: string; capability: string | null };

export interface BoardData {
  states: { id: string; initial: boolean; final: boolean; strict: boolean }[];
  transitions: { id: string; from: string; to: string; auto: boolean; approval: boolean; requires?: string }[];
  onlyIn: { signal: string; match: string; states: string[] }[];
  backlog: { key: "branch" | "file"; items: { id: string; title: string; target: string }[] } | null;
  /** Every work item with a journal, and the state its journal ends in. */
  items: { id: string; state: string; rev: number }[];
  /** The current work item's journal: snapshots, refusals and deviations, by revision. */
  timeline: TimelineEntry[];
}

export type BridgeResponse =
  | {
      v: 1; ok: true; shell: ShellStatus;
      refusal?: string; recorded?: boolean; entered?: string[];
      /** The new #current text, when the stage changed during this request. */
      context?: string;
      text?: string; board?: BoardData;
      workflows?: string[]; installed?: string[]; added?: { name: string; activated: boolean };
    }
  | { v: 1; ok: false; error: string; shell?: ShellStatus };

export function encodeRequest(req: BridgeRequest): string {
  return `${JSON.stringify(req)}\n`;
}

/** The last line of the CLI's stdout that parses as an answer of this version. */
export function decodeResponse(stdout: string): BridgeResponse | undefined {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]!) as { v?: unknown; ok?: unknown };
      if (v !== null && typeof v === "object" && v.v === PROTOCOL_VERSION && typeof v.ok === "boolean") return v as BridgeResponse;
    } catch {
      // not this line
    }
  }
  return undefined;
}

const OPS = new Set(["status", "refresh", "before", "after", "verb", "mark", "advance", "bind", "use", "add", "board"]);
const VERBS = new Set(["flow_status", "flow_context", "flow_transition", "flow_set", "flow_rollback"]);

/** One request, checked; what the CLI cannot run is an error it answers with. */
export function decodeRequest(text: string): BridgeRequest | { error: string } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: "the request is not JSON" };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { error: "the request is not an object" };
  if (v["v"] !== PROTOCOL_VERSION) return { error: `protocol version ${String(v["v"])}; this CLI speaks ${PROTOCOL_VERSION}` };
  if (typeof v["root"] !== "string" || v["root"] === "") return { error: "root is required" };
  const op = v["op"];
  if (typeof op !== "string" || !OPS.has(op)) return { error: `unknown op ${String(op)}` };
  const str = (k: string): boolean => typeof v[k] === "string";
  const obj = (k: string): boolean => typeof v[k] === "object" && v[k] !== null && !Array.isArray(v[k]);
  const fields: Record<string, () => boolean> = {
    before: () => str("tool") && str("callId") && obj("input"),
    after: () => str("tool") && str("callId") && obj("input") && typeof v["isError"] === "boolean" && typeof v["gitOperation"] === "boolean",
    verb: () => str("name") && VERBS.has(v["name"] as string) && obj("args"),
    mark: () => str("signal") && typeof v["checked"] === "boolean",
    advance: () => str("to"),
    bind: () => str("id"),
    use: () => str("workflow"),
  };
  const check = fields[op];
  if (check !== undefined && !check()) return { error: `op ${op}: missing or mistyped fields` };
  return v as unknown as BridgeRequest;
}
```

- [ ] **Step 5: The CLI side**

Create `integrations/gemflow/src/bridge.ts`:

```ts
// The Node side of the Claude Code shell. `gemflow hook` reads one request
// (src/hosts/claude-code/protocol.ts) on stdin, runs it against the project's
// workspace, and writes one answer line. Each request opens the workspace
// afresh — a Workspace reads git's facts when it opens, and another process may
// have written the journal since the last request — and every answer carries a
// fresh ShellStatus: status, policy snapshot and context key, which the hooks
// module keeps for its fast path and its drawings. Nothing here throws to the
// caller: a journal that fails verification, a lock that stays held, a verb
// that kept conflicting with another process are error answers.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { bindInDocument, readBacklog } from "./core/backlog.js";
import { CLAUDE_CODE_CAPABILITIES } from "./core/capabilities.js";
import { readJournal } from "./core/journal.js";
import { BACKLOG_DOC, CONFIG_DOC, CONTEXT_DOC, JOURNALS_DIR } from "./core/layout.js";
import { readContextDoc } from "./core/stagehand.js";
import { journalPathFor } from "./core/unit.js";
import { exists, readText, withLock, writeAtomic } from "./host-fs.js";
import { ghFacts, type GhFacts } from "./host-git.js";
import { addWorkflow, bundledWorkflows, projectWorkflows, useWorkflow } from "./project.js";
import { runVerb } from "./verbs.js";
import { openWorkspace, type Opened, type ShellView, type StageChange, type Workspace } from "./workspace.js";
import type { BoardData, BridgeRequest, BridgeResponse, ShellStatus, TimelineEntry } from "./hosts/claude-code/protocol.js";

type Answered = Extract<BridgeResponse, { ok: true }>;

/**
 * gh is asked live only where its facts can have changed: refresh, the board,
 * and after a git operation (ghFacts finds the binary through GEMFLOW_GH). Any
 * other request reuses the availability the last answer reported.
 */
function ghFor(req: BridgeRequest): (root: string, branch: string) => GhFacts {
  if (req.op === "refresh" || req.op === "board" || (req.op === "after" && req.gitOperation)) {
    const asked = new Map<string, GhFacts>();
    return (root, branch) => {
      const hit = asked.get(branch);
      if (hit) return hit;
      const facts = ghFacts(root, branch);
      asked.set(branch, facts);
      return facts;
    };
  }
  const seen = req.gh ?? { available: true as const };
  return () => (seen.available ? { available: true } : { available: false, reason: seen.reason });
}

/** `<item>@<rev>` of the context document, or null when there is none to read. */
function contextKey(root: string): string | null {
  let text: string;
  try { text = readText(join(root, CONTEXT_DOC)); } catch { return null; }
  const doc = readContextDoc(text);
  return doc ? `${doc.item}@${doc.rev}` : null;
}

function shellOf(view: ShellView, root: string): ShellStatus {
  return { status: view.status, policy: view.policy, contextKey: contextKey(root) };
}

function problemShell(text: string, quiet: boolean): ShellStatus {
  return { status: null, policy: null, contextKey: null, problem: { text, quiet } };
}

/** The shell for a workspace that did not open: quiet when the project simply has no workflow. */
function notOpened(opened: Extract<Opened, { ok: false }>): ShellStatus {
  return problemShell(opened.reason, opened.kind === "none");
}

function openFor(req: BridgeRequest): Opened {
  return openWorkspace({
    root: req.root, host: "claude", capabilities: CLAUDE_CODE_CAPABILITIES, gh: ghFor(req),
    ...(req.lastFile !== undefined ? { lastFile: req.lastFile } : {}),
  });
}

/** The shell after a change made beside the workspace (use, add). */
function shellAt(req: BridgeRequest): ShellStatus {
  const opened = openFor(req);
  return opened.ok ? shellOf(opened.ws.view(), req.root) : notOpened(opened);
}

/** Bind a to-do to the current work item: one cell of .geml/backlog.geml rewritten, under the backlog's lock. */
function bindHere(ws: Workspace, root: string, id: string): { ok: true } | { ok: false; reason: string } {
  const item = ws.item;
  if (item.kind !== "item") return { ok: false, reason: item.reason };
  const path = join(root, BACKLOG_DOC);
  if (!exists(path)) return { ok: false, reason: `no ${BACKLOG_DOC}` };
  return withLock(path, () => {
    const source = readText(path);
    const r = bindInDocument(source, id, item.id);
    if (!r.ok) return r;
    if (r.text !== source) writeAtomic(path, r.text);
    return { ok: true as const };
  });
}

function listItems(root: string): BoardData["items"] {
  const dir = join(root, JOURNALS_DIR);
  if (!exists(dir)) return [];
  const out: BoardData["items"] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !e.name.endsWith(".geml")) continue;
    const full = join(e.parentPath, e.name);
    const last = readJournal(readText(full)).snapshots.at(-1);
    if (last) out.push({ id: relative(dir, full).split("\\").join("/").replace(/\.geml$/, ""), state: last.state, rev: last.rev });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const ORDER: Readonly<Record<TimelineEntry["kind"], number>> = { snapshot: 0, deviation: 1, refused: 2 };

function timelineOf(path: string): TimelineEntry[] {
  if (!exists(path)) return [];
  const j = readJournal(readText(path));
  const entries: TimelineEntry[] = [
    ...j.snapshots.map((s) => ({ kind: "snapshot" as const, rev: s.rev, at: s.at, state: s.state, cause: s.cause, ...(s.by ? { by: s.by } : {}), ...(s.signal ? { signal: s.signal } : {}) })),
    ...j.refusals.map((r) => ({ kind: "refused" as const, rev: r.rev, at: r.at, tool: r.tool, reason: r.reason })),
    ...j.deviations.map((d) => ({ kind: "deviation" as const, rev: d.rev, at: d.at, tool: d.tool, state: d.state, capability: d.capability })),
  ];
  return entries.sort((a, b) => a.rev - b.rev || ORDER[a.kind] - ORDER[b.kind]);
}

function boardOf(ws: Workspace, root: string): BoardData {
  const sc = ws.sc;
  const backlogPath = join(root, BACKLOG_DOC);
  const backlog = exists(backlogPath) ? readBacklog(readText(backlogPath)) : null;
  return {
    states: [...sc.states.values()].map((s) => ({ id: s.id, initial: s.initial, final: s.final, strict: s.strict })),
    transitions: sc.transitions.map((t) => ({ id: t.id, from: t.from, to: t.to, auto: t.auto, approval: t.approval, ...(t.requiresId ? { requires: t.requiresId } : {}) })),
    onlyIn: sc.signals.filter((s) => s.on === "command" && s.onlyIn.length > 0).map((s) => ({ signal: s.id, match: s.match, states: [...s.onlyIn] })),
    backlog: backlog ? { key: backlog.key, items: backlog.items } : null,
    items: listItems(root),
    timeline: ws.item.kind === "item" ? timelineOf(join(root, journalPathFor(ws.item.id))) : [],
  };
}

/** One request, answered. A throw — from opening the workspace or from the op — becomes an error answer whose shell says what is wrong. */
export async function handleRequest(req: BridgeRequest): Promise<BridgeResponse> {
  try {
    return await answer(req);
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).replace(/^gemflow: /, "");
    return { v: 1, ok: false, error: `gemflow: ${message}`, shell: problemShell(message, false) };
  }
}

async function answer(req: BridgeRequest): Promise<BridgeResponse> {
  const root = req.root;
  if (req.op === "use") {
    const r = useWorkflow(root, req.workflow);
    return r.ok ? { v: 1, ok: true, shell: shellAt(req) } : { v: 1, ok: false, error: r.reason };
  }
  if (req.op === "add") {
    const workflows = bundledWorkflows();
    const installed = projectWorkflows(root);
    if (req.workflow === undefined) return { v: 1, ok: true, shell: shellAt(req), workflows, installed };
    const activate = installed.length === 0 && !exists(join(root, CONFIG_DOC));
    const r = addWorkflow(root, req.workflow, { activate });
    if (!r.ok) return { v: 1, ok: false, error: r.reason };
    return { v: 1, ok: true, shell: shellAt(req), workflows, installed: projectWorkflows(root), added: { name: r.name, activated: r.activated } };
  }
  const opened = openFor(req);
  if (!opened.ok) {
    const shell = notOpened(opened);
    const asks = req.op === "verb" || req.op === "mark" || req.op === "advance" || req.op === "bind";
    return asks ? { v: 1, ok: false, error: opened.reason, shell } : { v: 1, ok: true, shell };
  }
  const ws = opened.ws;
  /** The answer: the view after the op, and the new stage text when the op changed the stage. */
  const ok = (view: ShellView, extra: Omit<Answered, "v" | "ok" | "shell" | "context"> = {}, context?: string): Answered =>
    ({ v: 1, ok: true, shell: shellOf(view, root), ...extra, ...(context !== undefined ? { context } : {}) });
  const failed = (reason: string): BridgeResponse => ({ v: 1, ok: false, error: reason, shell: shellOf(ws.view(), root) });
  switch (req.op) {
    case "status":
      return ok(ws.view());
    case "refresh": {
      const change = ws.refresh();
      return ok(ws.view(), { entered: change.entered }, change.context);
    }
    case "before": {
      const { refusal, recorded, ...view } = ws.beforeView(req.tool, req.callId, req.input);
      return ok(view, { ...(refusal !== undefined ? { refusal } : {}), recorded });
    }
    case "after": {
      const ran = ws.after({
        tool: req.tool, callId: req.callId, isError: req.isError, input: req.input,
        ...(req.exitCode !== undefined ? { exitCode: req.exitCode } : {}),
        ...(req.wrotePath !== undefined ? { wrotePath: req.wrotePath } : {}),
      });
      // A git operation's facts are read again whatever command made it (a script can commit or open a PR too).
      const git: StageChange = req.gitOperation ? ws.refresh() : { entered: [] };
      return ok(ws.view(), { entered: [...ran.entered, ...git.entered] }, git.context ?? ran.context);
    }
    case "verb": {
      const a = await runVerb(ws, req.name, req.args, req.callId);
      return ok(ws.view(), { text: a.text }, a.context);
    }
    case "mark": {
      const r = ws.mark(req.signal, req.checked);
      return r.ok ? ok(ws.view(), { entered: r.entered }, r.context) : failed(r.reason);
    }
    case "advance": {
      const r = ws.advance(req.to);
      return r.ok ? ok(ws.view(), { entered: r.entered }, r.context) : failed(r.reason);
    }
    case "bind": {
      const r = bindHere(ws, root, req.id);
      return r.ok ? ok(ws.view()) : failed(r.reason);
    }
    case "board": {
      const change = ws.refresh();
      return ok(ws.view(), { entered: change.entered, board: boardOf(ws, root) }, change.context);
    }
  }
}
```


- [ ] **Step 6: The `hook` verb**

In `integrations/gemflow/src/cli.ts`:

1. Add imports, after the `./project.js` import: `import { handleRequest } from "./bridge.js";` and `import { decodeRequest, type BridgeResponse } from "./hosts/claude-code/protocol.js";`.
2. Add this row to `USAGE`, after the `run` row:

```ts
  "  hook                                    the Claude Code bridge: one JSON request on stdin, one answer on stdout",
```

3. Add, above `main`:

```ts
/** `gemflow hook`: one request in, one answer line out. The exit code is 0 whatever the answer says; handleRequest never throws. */
async function runHook(): Promise<number> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const req = decodeRequest(text);
  const res: BridgeResponse = "error" in req ? { v: 1, ok: false, error: req.error } : await handleRequest(req);
  process.stdout.write(`${JSON.stringify(res)}\n`);
  return 0;
}
```

4. Replace the last line, `process.exit(main(process.argv.slice(2)));`, with:

```ts
const argv = process.argv.slice(2);
// The async verbs end by letting the process drain: process.exit right after a
// write to a pipe can cut the answer short on macOS.
if (argv[0] === "hook") void runHook().then((code) => { process.exitCode = code; });
else process.exit(main(argv));
```

- [ ] **Step 7: Watch them pass, then the whole suite**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`. Every bridge test's `hook()` call asserts exactly one answer line, which is also what shows the parser's hand-off stayed out of the bundle.

- [ ] **Step 8: Commit**

```bash
git add integrations/gemflow/src/hosts/claude-code/protocol.ts integrations/gemflow/src/bridge.ts integrations/gemflow/src/cli.ts integrations/gemflow/test/helpers/repo.mjs integrations/gemflow/test/protocol.test.mjs integrations/gemflow/test/bridge.test.mjs
git commit -m "feat(gemflow): the Claude Code bridge — gemflow hook, one request on stdin, one answer on stdout

status, refresh, before, after, verb, mark, advance, bind, use, add and
board run against a workspace opened afresh for each request as host claude;
every answer carries the status and the policy snapshot, read in one pass
over the journal, the context key, and the new #current text when the op
moved the stage. A throw is an error answer, never a crash. gh is asked live
only on refresh, the board and after a git operation. bind rewrites one cell
of the backlog under its lock. Each op is tested through dist/gemflow.mjs in
a temporary repository."
```

---

### Task 5: The fast path

**Files:** Create `integrations/gemflow/src/hosts/claude-code/fastpath.ts`, `integrations/gemflow/test/fastpath.test.mjs`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/fastpath.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { OWN_TOOL_PREFIX, afterNeeded, beforeDecision, matchesUnit } from "../dist/hosts/claude-code/fastpath.js";

const policy = (over = {}) => ({
  active: true, unit: { kind: "branch" }, state: "build", strict: false, rollbackOnError: false,
  tools: ["Read", "Edit", "Write", "NotebookEdit", "Bash", "Grep", "Glob"],
  commands: [
    { id: "tests", anywhere: "npm (run )?test", start: "^(?:npm (run )?test)", onlyIn: [] },
    { id: "prod", anywhere: "wrangler deploy --env production", start: "^(?:wrangler deploy --env production)", onlyIn: ["release"] },
  ],
  files: [{ id: "render", glob: "out/*.mp4" }],
  deviated: [], relevant: [], ...over,
});
const bash = (command) => ({ tool: "Bash", input: { command } });
const outcome = (over = {}) => ({ isError: false, gitOperation: false, consulted: false, ...over });

test("no policy, no work item, or gemflow's own tool: never a spawn", () => {
  assert.equal(beforeDecision(null, bash("gemflow mark x")), "pass");
  assert.equal(beforeDecision(policy({ active: false }), bash("gemflow mark x")), "pass");
  assert.equal(beforeDecision(policy({ strict: true, tools: ["Read"] }), { tool: `${OWN_TOOL_PREFIX}flow_status`, input: {} }), "pass");
  assert.equal(afterNeeded(null, bash("npm test"), outcome({ exitCode: 0 })), false);
  assert.equal(afterNeeded(policy(), { tool: `${OWN_TOOL_PREFIX}flow_set`, input: {} }, outcome({ consulted: true })), false);
});

test("advisory state: an admitted tool passes; another is consulted until it is recorded for this stage", () => {
  assert.equal(beforeDecision(policy(), { tool: "Edit", input: {} }), "pass");
  assert.equal(beforeDecision(policy(), { tool: "WebFetch", input: {} }), "consult");
  assert.equal(beforeDecision(policy({ deviated: ["WebFetch"] }), { tool: "WebFetch", input: {} }), "pass");
  assert.equal(beforeDecision(policy({ tools: undefined }), { tool: "WebFetch", input: {} }), "pass", "a state that admits anything");
});

test("strict state: every tool it does not admit is consulted, recorded or not", () => {
  const p = policy({ strict: true, tools: ["Read"], deviated: ["Edit"] });
  assert.equal(beforeDecision(p, { tool: "Read", input: {} }), "pass");
  assert.equal(beforeDecision(p, { tool: "Edit", input: {} }), "consult");
  assert.equal(beforeDecision(p, { tool: "TodoWrite", input: {} }), "consult");
});

test("a person's command and an only-in command outside its states are consulted, admitted or not", () => {
  assert.equal(beforeDecision(policy(), bash("cd x && gemflow advance release")), "consult");
  assert.equal(beforeDecision(policy(), bash('bash -c "npx -y @geml/gemflow mark reviewed"')), "consult", "the supervisor's own scan, shell strings included");
  assert.equal(beforeDecision(policy(), bash("echo gemflow mark reviewed")), "pass", "naming a verb is not running it");
  assert.equal(beforeDecision(policy(), bash("npx wrangler deploy --env production")), "consult");
  assert.equal(beforeDecision(policy(), bash('wran"gler" deploy  --env production')), "consult", "only-in reads the line with its quoting removed too");
  assert.equal(beforeDecision(policy({ state: "release" }), bash("npx wrangler deploy --env production")), "pass");
  assert.equal(beforeDecision(policy(), bash("npm test")), "pass");
});

test("after: a command signal with an exit status, a git operation, a recorded before, a rollback-on-error failure", () => {
  assert.equal(afterNeeded(policy(), bash("npm run test -- --grep x"), outcome({ exitCode: 1 })), true);
  assert.equal(afterNeeded(policy(), bash("cd app && CI=1 npm test"), outcome({ exitCode: 0 })), true, "a simple command of an && chain, assignments dropped");
  assert.equal(afterNeeded(policy(), bash("npm test | tee log"), outcome({ exitCode: 0 })), false, "commandSignals reads nothing from a pipeline, so neither does the fast path");
  assert.equal(afterNeeded(policy(), bash("echo npm test"), outcome({ exitCode: 0 })), false, "the pattern matches at the start of a simple command");
  assert.equal(afterNeeded(policy(), bash("npm test"), outcome({ exitCode: null })), false, "backgrounded: no exit status yet");
  assert.equal(afterNeeded(policy(), bash("ls"), outcome({ exitCode: 0 })), false);
  assert.equal(afterNeeded(policy(), bash("git status"), outcome({ exitCode: 0 })), false, "no gh round trip for a git command that changed nothing");
  assert.equal(afterNeeded(policy(), bash("git commit -m x"), outcome({ exitCode: 0, gitOperation: true })), true);
  assert.equal(afterNeeded(policy(), { tool: "WebFetch", input: {} }, outcome({ consulted: true })), true);
  assert.equal(afterNeeded(policy(), bash("make"), outcome({ exitCode: 2, isError: true })), false);
  assert.equal(afterNeeded(policy({ rollbackOnError: true }), { tool: "Edit", input: {} }, outcome({ isError: true })), true);
});

test("after a write: a file signal's glob, or the file unit's glob even before there is a work item", () => {
  assert.equal(afterNeeded(policy(), { tool: "Write", input: {} }, outcome({ wrotePath: "out/ep01.mp4" })), true);
  assert.equal(afterNeeded(policy(), { tool: "Write", input: {} }, outcome({ wrotePath: "src/a.ts" })), false);
  const film = policy({ active: false, unit: { kind: "file", glob: "episodes/*.geml" } });
  assert.equal(afterNeeded(film, { tool: "Edit", input: {} }, outcome({ wrotePath: "episodes/ep02.geml" })), true);
  assert.equal(afterNeeded(film, { tool: "Edit", input: {} }, outcome({ wrotePath: "notes.md" })), false);
  assert.equal(matchesUnit(film, "episodes/ep02.geml"), true);
  assert.equal(matchesUnit(policy(), "episodes/ep02.geml"), false);
  assert.equal(matchesUnit(film, undefined), false);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/fastpath.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/hosts/claude-code/fastpath.js`.

- [ ] **Step 3: Write the module**

Create `integrations/gemflow/src/hosts/claude-code/fastpath.ts`:

```ts
// The fast path: from the latest policy snapshot, decide per tool call whether
// the workflow can care about it, so most calls cost no spawn. Node-free: the
// hooks module imports it. A wrong answer here may cost a spawn, never skip
// one that matters: a call that could be refused or recorded is "consult",
// and the CLI's `before` decides and records it. Command lines are read with
// the functions the supervisor and the signals module use (command-line.ts)
// and the policy's compiled pattern sources, so "consult" covers every line
// `before` refuses and "after" is asked exactly when `commandSignals` would
// answer.
import type { FlowPolicy } from "../../core/policy.js";
import { capabilityOf, CLAUDE_CODE_CAPABILITIES } from "../../core/capabilities.js";
import { personOnlyRefusal, signalHeads, withoutQuoting } from "../../core/command-line.js";
import { globToRegExp } from "../../core/unit.js";
import { OWN_TOOL_PREFIX } from "../../core/verb-specs.js";

export { OWN_TOOL_PREFIX };

export interface CallFacts { tool: string; input: Record<string, unknown> }

export interface CallOutcome {
  isError: boolean;
  /** A run-capability call's exit status; null when it has none (backgrounded, interrupted). */
  exitCode?: number | null;
  /** The project-relative path a write-capability call touched. */
  wrotePath?: string;
  gitOperation: boolean;
  /** `before` was consulted and recorded something. */
  consulted: boolean;
}

function commandOf(call: CallFacts): string | undefined {
  if (capabilityOf(call.tool, CLAUDE_CODE_CAPABILITIES) !== "run") return undefined;
  const c = call.input["command"];
  return typeof c === "string" ? c : undefined;
}

const matches = (pattern: string, text: string): boolean => new RegExp(pattern).test(text);

/** Whether a written path is a work item of a `file:` unit. */
export function matchesUnit(p: FlowPolicy | null, path: string | undefined): boolean {
  return p !== null && path !== undefined && p.unit.kind === "file" && globToRegExp(p.unit.glob).test(path);
}

export function beforeDecision(p: FlowPolicy | null, call: CallFacts): "pass" | "consult" {
  if (p === null || !p.active || call.tool.startsWith(OWN_TOOL_PREFIX)) return "pass";
  const command = commandOf(call);
  if (command !== undefined) {
    if (personOnlyRefusal(command) !== undefined) return "consult";
    // only-in searches the line and its unquoted copy, as onlyInRefusal does.
    const plain = withoutQuoting(command);
    const confined = p.commands.filter((s) => s.onlyIn.length > 0 && !s.onlyIn.includes(p.state));
    if (confined.some((s) => matches(s.anywhere, command) || matches(s.anywhere, plain))) return "consult";
  }
  if (p.tools === undefined || p.tools.includes(call.tool)) return "pass";
  return p.strict || !p.deviated.includes(call.tool) ? "consult" : "pass";
}

export function afterNeeded(p: FlowPolicy | null, call: CallFacts, o: CallOutcome): boolean {
  if (p === null || call.tool.startsWith(OWN_TOOL_PREFIX)) return false;
  if (matchesUnit(p, o.wrotePath)) return true;
  if (!p.active) return false;
  if (o.consulted || o.gitOperation) return true;
  if (o.isError && p.rollbackOnError) return true;
  const command = commandOf(call);
  if (command !== undefined && typeof o.exitCode === "number") {
    const heads = signalHeads(command);
    if (heads !== null && p.commands.some((s) => heads.some((h) => matches(s.start, h)))) return true;
  }
  const path = o.wrotePath;
  return path !== undefined && p.files.some((f) => globToRegExp(f.glob).test(path));
}
```

- [ ] **Step 4: Watch it pass**

Run: `cd integrations/gemflow && npx tsc && node --test test/fastpath.test.mjs test/hooks-purity.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src/hosts/claude-code/fastpath.ts integrations/gemflow/test/fastpath.test.mjs
git commit -m "feat(gemflow): the Claude Code fast path — pass, or consult the CLI

From the policy snapshot, reading command lines with the supervisor's own
scanner: a person's command, an only-in command outside its states, a tool a
strict state does not admit, and a first deviation in an advisory state are
consulted; everything else passes with no spawn. After a call, the CLI hears
only of what can move a signal or needs recording."
```

---

### Task 6: Reading Claude Code's results and the context document without Node

**Files:** Create `integrations/gemflow/src/hosts/claude-code/readers.ts`, `integrations/gemflow/test/readers.test.mjs`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/readers.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContextDoc } from "../dist/core/stagehand.js";
import { bashExitCode, bridgeInput, contextOf, hasGitOperation, nodeMajor, toolArgs, touchedPath } from "../dist/hosts/claude-code/readers.js";

test("exit status (spec §5.2): Exit code n, a clean result, an interpreted one, a backgrounded one", () => {
  assert.equal(bashExitCode({ result: { stdout: "ok", stderr: "", interrupted: false }, text: "ok" }), 0);
  assert.equal(bashExitCode({ result: { stdout: "", stderr: "", interrupted: false, returnCodeInterpretation: "No matches found" } }), 1);
  assert.equal(bashExitCode({ result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b7" } }), null);
  assert.equal(bashExitCode({ isError: true, result: "Exit code 2", text: "Exit code 2\nboom" }), 2);
  assert.equal(bashExitCode({ isError: true, result: "Interrupted", text: "Interrupted by the user" }), null);
  assert.equal(bashExitCode({ deny: "refused" }), null);
});

test("gitOperation is read off a clean Bash result only", () => {
  assert.equal(hasGitOperation({ result: { gitOperation: { commit: { sha: "a", kind: "committed" } } } }), true);
  assert.equal(hasGitOperation({ result: { stdout: "" } }), false);
  assert.equal(hasGitOperation({ isError: true, result: "Exit code 1", text: "Exit code 1" }), false);
});

test("the path a write touched, relative to the project; elsewhere is nothing", () => {
  assert.equal(touchedPath("Edit", { file_path: "/w/app/src/a.ts" }, "/w/app"), "src/a.ts");
  assert.equal(touchedPath("Write", { file_path: "/w/app/out/ep01.mp4" }, "/w/app/"), "out/ep01.mp4");
  assert.equal(touchedPath("NotebookEdit", { notebook_path: "/w/app/n.ipynb" }, "/w/app"), "n.ipynb");
  assert.equal(touchedPath("Write", { file_path: "/tmp/x" }, "/w/app"), undefined);
  assert.equal(touchedPath("Write", { file_path: "./episodes/ep02.geml" }, "/w/app"), "episodes/ep02.geml");
  assert.equal(touchedPath("Edit", { file_path: "C:\\w\\app\\src\\a.ts" }, "C:\\w\\app"), "src/a.ts");
  assert.equal(touchedPath("Read", { file_path: "/w/app/a" }, "/w/app"), undefined);
});

test("a call's own arguments, and the part of them the CLI is sent", () => {
  assert.deepEqual(toolArgs({ tool: "Bash", tool_use_id: "t", agentId: "a", requestMeta: {}, consent: "c", command: "ls", timeout: 5 }), { command: "ls", timeout: 5 });
  assert.deepEqual(bridgeInput({ file_path: "/a", content: "a whole file", old_string: "x" }), { file_path: "/a" });
  assert.deepEqual(bridgeInput({ command: "ls", description: "list" }), { command: "ls" });
});

test("the context document: key, item, state, rev, and the text, even with a fence-like body line", () => {
  const ctx = { state: "review", rev: 7, text: "[gemflow] stage #review · rev 7\n=== looks like a fence\nbody", included: [], truncated: [] };
  const seen = contextOf(renderContextDoc(ctx, { at: "2026-10-12T00:00:00Z", item: "feat/rate-limit" }));
  assert.deepEqual(seen, { key: "feat/rate-limit@7", item: "feat/rate-limit", state: "review", rev: 7, text: ctx.text });
  assert.equal(contextOf('=== meta\ntitle = "x"\n===\n'), undefined);
  assert.equal(contextOf('==== flow-context {#current state=#a rev=1 item="x"}\nunclosed\n'), undefined);
});

test("node --version", () => {
  assert.equal(nodeMajor("v24.15.0\n"), 24);
  assert.equal(nodeMajor("v18.0.0"), 18);
  assert.equal(nodeMajor("command not found"), undefined);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/readers.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/hosts/claude-code/readers.js`.

- [ ] **Step 3: Write the module**

Create `integrations/gemflow/src/hosts/claude-code/readers.ts`:

```ts
// Reading Claude Code's tool calls and results, and the context document,
// without Node: the hooks module imports this file.

/** What a `tool.call` result carries that these readers look at. */
export interface RanLike { deny?: string; isError?: boolean; text?: string; result?: unknown }

const RESERVED = new Set(["tool", "tool_use_id", "agentId", "requestMeta", "consent"]);

/** A tool call's own arguments: the event's input without the keys the engine reserves. */
export function toolArgs(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k) && v !== undefined) out[k] = v;
  return out;
}

const SENT = ["command", "file_path", "notebook_path"] as const;

/** The part of a call's arguments the CLI reads — the command and the path, never file contents. */
export function bridgeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SENT) if (typeof input[k] === "string") out[k] = input[k];
  return out;
}

/**
 * The exit status of a finished Bash call (spec §5.2): `Exit code <n>` on an
 * errored result; 0 for a clean one; non-zero (1) for a clean result Claude
 * Code interpreted (`returnCodeInterpretation`: grep's "No matches found",
 * diff's "Files differ"); null when there is none — the call went to the
 * background, was interrupted, or never ran.
 */
export function bashExitCode(ran: RanLike): number | null {
  if (ran.deny !== undefined) return null;
  if (ran.isError === true) {
    const m = (ran.text ?? "").match(/^Exit code (\d+)/);
    return m ? Number(m[1]) : null;
  }
  const r = (ran.result ?? {}) as { backgroundTaskId?: unknown; returnCodeInterpretation?: unknown };
  if (typeof r.backgroundTaskId === "string") return null;
  if (typeof r.returnCodeInterpretation === "string") return 1;
  return 0;
}

/** Whether a clean Bash result classified a git or gh operation (commit, push, merge, rebase, PR). */
export function hasGitOperation(ran: RanLike): boolean {
  if (ran.isError === true || ran.deny !== undefined) return false;
  const r = ran.result as { gitOperation?: unknown } | null | undefined;
  return typeof r === "object" && r !== null && typeof r.gitOperation === "object" && r.gitOperation !== null;
}

const PATH_FIELD: Readonly<Record<string, string>> = { Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };

/** The project-relative, `/`-separated path a write-capability call touched; undefined for another tool or a path outside the project. */
export function touchedPath(tool: string, input: Record<string, unknown>, root: string): string | undefined {
  const field = PATH_FIELD[tool];
  const raw = field === undefined ? undefined : input[field];
  if (typeof raw !== "string" || raw === "") return undefined;
  const path = raw.split("\\").join("/");
  const base = root.split("\\").join("/").replace(/\/+$/, "");
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return undefined;
  return path.replace(/^\.\//, "");
}

export interface ContextSeen { key: string; item: string; state: string; rev: number; text: string }

function attr(attrs: string, key: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${key}=("(?:[^"\\\\]|\\\\.)*"|\\S+)`));
  if (!m) return undefined;
  const raw = m[1]!;
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}

/** The `flow-context` block `#current` of .geml/context.geml: its item, state and rev, and its text. */
export function contextOf(doc: string): ContextSeen | undefined {
  const lines = doc.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(/^(={3,})[ \t]*flow-context[ \t]*\{(.*)\}[ \t]*$/);
    if (!open || !/(?:^|\s)#current(?:\s|$)/.test(open[2]!)) continue;
    const fence = open[1]!;
    let end = i + 1;
    while (end < lines.length && lines[end] !== fence) end++;
    if (end >= lines.length) return undefined;
    const rev = Number(attr(open[2]!, "rev"));
    if (!Number.isInteger(rev)) return undefined;
    const item = attr(open[2]!, "item") ?? "";
    const state = (attr(open[2]!, "state") ?? "").replace(/^#/, "");
    return { key: `${item}@${rev}`, item, state, rev, text: lines.slice(i + 1, end).join("\n") };
  }
  return undefined;
}

/** The major version in `node --version`'s output. */
export function nodeMajor(text: string): number | undefined {
  const m = text.trim().match(/^v?(\d+)\./);
  return m ? Number(m[1]) : undefined;
}
```

- [ ] **Step 4: Watch it pass**

Run: `cd integrations/gemflow && npx tsc && node --test test/readers.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add integrations/gemflow/src/hosts/claude-code/readers.ts integrations/gemflow/test/readers.test.mjs
git commit -m "feat(gemflow): read Bash exit codes, touched paths, git operations and the context document without Node

The exit status follows spec §5.2: Exit code n on an error, 0 for a clean
result, non-zero for one Claude Code interpreted, none for a backgrounded
call. The context document's flow-context head gives the key that tells the
hooks module whether the model has seen this stage."
```

---

### Task 7: The hooks module — session start, tool calls, prompt submit, the five tools

**Files:** Create `integrations/gemflow/test/own-tools.test.mjs`; modify `integrations/gemflow/src/core/supervisor.ts`, `integrations/gemflow/hooks/register.tsx`.

- [ ] **Step 1: Failing test — gemflow's own tools**

Create `integrations/gemflow/test/own-tools.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStatechart } from "../dist/core/statechart.js";
import { openRun, Supervisor } from "../dist/core/supervisor.js";
import { CLAUDE_CODE_CAPABILITIES } from "../dist/core/capabilities.js";

const flow = (strict) => loadStatechart(
  `=== meta\nprofile = "geml-flow/v1"\n===\n\n=== flow-state {#a initial${strict ? " strict" : ""} rollback-on-error tools="read"}\nA.\n===\n\n`
  + "=== flow-state {#b final}\nB.\n===\n\n=== flow-transition {#go from=#a to=#b}\nGo.\n===\n",
  "own.geml").statechart;

function supervisor(sc) {
  const out = [];
  const run = openRun({ sc, item: "t", statechartFile: "own.geml", journalText: null, source: "startup", now: "t0" }).run;
  const sup = new Supervisor(sc, run, { append: (b) => out.push(b), approve: async () => "denied", now: () => "t1", host: "claude", capabilities: CLAUDE_CODE_CAPABILITIES });
  return { sup, out };
}

const OWN = ["flow_status", "flow_context", "flow_transition", "flow_set", "flow_rollback"];

test("gemflow's own tools, bare or as Claude Code lists them, are never refused, recorded or rolled back", () => {
  for (const strict of [true, false]) {
    const { sup, out } = supervisor(flow(strict));
    for (const name of [...OWN, ...OWN.map((n) => `mcp__gemflow__${n}`)]) {
      assert.equal(sup.owns(name), true, name);
      assert.equal(sup.deny(name, `c-${name}`, {}), undefined, name);
      assert.equal(sup.onToolResult({ name, callId: `c-${name}`, isError: true }, { at: "t2" }), null, `${name} failing rolls nothing back`);
    }
    assert.deepEqual(out, [], "nothing journaled");
  }
});

test("only gemflow's own: another server's flow_status, or a near name, is a tool like any other", () => {
  const { sup } = supervisor(flow(true));
  for (const name of ["mcp__other__flow_status", "mcp__gemflow__flow_stat", "flow_statusx", "WebFetch"]) {
    assert.equal(sup.owns(name), false, name);
    assert.match(sup.deny(name, "c", {}), /is not available in state #a/);
  }
  assert.deepEqual(sup.allowedGlobals(["Read", "WebFetch", "mcp__gemflow__flow_status"]), { kind: "allow", names: ["Read"] });
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/own-tools.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 1` (A3's `owns` knows the three verbs, bare, and nothing else).

- [ ] **Step 3: `Supervisor.owns()` takes gemflow's own tools**

In `integrations/gemflow/src/core/supervisor.ts`:

1. Add after the `./signals.js` import:

```ts
import { FLOW_TOOLS, OWN_TOOL_PREFIX } from "./verb-specs.js";
```

2. Replace the `VERBS` declaration and its doc comment with:

```ts
/** The three verbs this supervisor carries out (`invoke`). Gates 1 and 3 never apply to them, nor to anything else it `owns`. */
export const VERBS: readonly string[] = ["flow_transition", "flow_set", "flow_rollback"];

/**
 * Every tool name gemflow answers itself: the five verbs of spec §8.5 — the
 * three above and the read-only flow_status and flow_context — bare, as dsh,
 * pi and `gemflow mcp` name them, or as Claude Code lists the ones the gemflow
 * plugin registers (`mcp__gemflow__<name>`). A call to one is never refused,
 * never a deviation, and never rolled back on error.
 */
const OWN_TOOLS: ReadonlySet<string> = new Set(FLOW_TOOLS.flatMap((t) => [t.name, `${OWN_TOOL_PREFIX}${t.name}`]));
```

3. Replace the `owns` method with:

```ts
  owns(toolName: string): boolean {
    return OWN_TOOLS.has(toolName);
  }
```

`deny`, `allowedGlobals` and `onToolResult` already ask `owns`, so nothing else changes; A3's supervisor tests pass unchanged.

- [ ] **Step 4: Write the hooks module**

Replace `integrations/gemflow/hooks/register.tsx` with:

```tsx
// Gemflow's Claude Code shell. This module runs with no Node and no DOM: from
// the latest policy snapshot it decides whether a tool call can matter to the
// workflow, and asks the bundled CLI (dist/gemflow.mjs: one JSON request on
// stdin, one JSON answer on stdout) only when it can. It never writes a
// project file — journals, .geml/context.geml and the backlog belong to the
// CLI, which writes them under locks. Gemflow fails open: when Node is
// missing, the bridge fails or times out, or an answer does not parse, the
// call goes through, nothing is recorded, and the band says what is wrong.
import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { GemflowJson } from '../types'
import { capabilityOf, CLAUDE_CODE_CAPABILITIES } from '../dist/core/capabilities.js'
import { FLOW_TOOLS } from '../dist/core/verb-specs.js'
import type { VerbName } from '../dist/core/verb-specs.js'
import { afterNeeded, beforeDecision, matchesUnit, OWN_TOOL_PREFIX } from '../dist/hosts/claude-code/fastpath.js'
import { BRIDGE_TIMEOUT_MS, decodeResponse, encodeRequest, SLOW_TIMEOUT_MS } from '../dist/hosts/claude-code/protocol.js'
import type { BridgeOp, BridgeRequest, BridgeResponse, ShellStatus } from '../dist/hosts/claude-code/protocol.js'
import { bashExitCode, bridgeInput, contextOf, hasGitOperation, nodeMajor, toolArgs, touchedPath } from '../dist/hosts/claude-code/readers.js'

const shellAtom = atom({ plugin: 'gemflow', key: 'shell' } as const, null as GemflowJson)
const problemAtom = atom({ plugin: 'gemflow', key: 'problem' } as const, null as string | null)
const nodeAtom = atom({ plugin: 'gemflow', key: 'node' } as const, null as string | null)
const rootAtom = atom({ plugin: 'gemflow', key: 'root' } as const, null as string | null)
const deliveredAtom = atom({ plugin: 'gemflow', key: 'delivered' } as const, null as string | null)
const lastFileAtom = atom({ plugin: 'gemflow', key: 'lastFile' } as const, null as string | null)

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function readShell($: EngineInterface): Promise<ShellStatus | null> {
  return (await read($, shellAtom)) as unknown as ShellStatus | null
}

/** Node ≥ 22 on the session's PATH, else the one a login shell finds; or why there is none. */
async function findNode($: EngineInterface): Promise<{ node: string } | { problem: string }> {
  const major = async (bin: string): Promise<number | undefined> => {
    try {
      const r = await $.process.run([bin, '--version'], { timeoutMs: 5_000 })
      return r.exitCode === 0 ? nodeMajor(r.stdout) : undefined
    } catch {
      return undefined
    }
  }
  const onPath = await major('node')
  if (onPath !== undefined && onPath >= 22) return { node: 'node' }
  let found: string | undefined
  try {
    const r = await $.process.run(['/bin/sh', '-lc', 'command -v node'], { timeoutMs: 5_000 })
    found = r.exitCode === 0 ? r.stdout.trim().split('\n').pop() : undefined
  } catch {
    found = undefined
  }
  const viaShell = found ? await major(found) : undefined
  if (found && viaShell !== undefined && viaShell >= 22) return { node: found }
  const seen = viaShell ?? onPath
  return { problem: seen !== undefined ? `gemflow：Node ${seen} 太旧，需要 Node ≥ 22` : 'gemflow：找不到 node — 请安装 Node ≥ 22' }
}

/** One request to the CLI. Undefined when the bridge is unavailable; the band then says why. */
async function bridge($: EngineInterface, op: BridgeOp, timeoutMs: number = BRIDGE_TIMEOUT_MS): Promise<BridgeResponse | undefined> {
  const node = await read($, nodeAtom)
  const root = await read($, rootAtom)
  if (node === null || root === null) return undefined
  const lastFile = await read($, lastFileAtom)
  const gh = (await readShell($))?.status?.gh
  const request = { v: 1, root, ...(lastFile !== null ? { lastFile } : {}), ...(gh ? { gh } : {}), ...op } as BridgeRequest
  let out: { exitCode: number; stdout: string; stderr: string }
  try {
    out = await $.process.run([node, `${$.plugin.root}/dist/gemflow.mjs`, 'hook'], { cwd: root, stdin: encodeRequest(request), timeoutMs })
  } catch (err) {
    await update($, problemAtom, () => `gemflow：桥接没有应答（${reasonOf(err)}）`)
    return undefined
  }
  const res = decodeResponse(out.stdout)
  if (res === undefined) {
    const first = out.stderr.trim().split('\n')[0] ?? ''
    await update($, problemAtom, () => `gemflow：桥接的应答无法解析（退出码 ${out.exitCode}${first ? `：${first}` : ''}）`)
    return undefined
  }
  await update($, problemAtom, () => null)
  const shell = res.shell
  if (shell !== undefined) await update($, shellAtom, () => shell as unknown as GemflowJson)
  return res
}

/** A result with the new stage's text after it, for the model only; recorded as delivered. */
async function withStage<T extends { context?: readonly string[] }>($: EngineInterface, ran: T, res: BridgeResponse | undefined): Promise<T> {
  if (res === undefined || !res.ok || res.context === undefined) return ran
  const key = res.shell.contextKey
  if (key !== null) await update($, deliveredAtom, () => key)
  return { ...ran, context: [...(ran.context ?? []), res.context] }
}

/** One of the five model tools, answered by the bridge's verb op. */
async function serveVerb($: EngineInterface, name: VerbName, event: unknown) {
  const e = event as Record<string, unknown>
  const callId = typeof e['tool_use_id'] === 'string' ? e['tool_use_id'] : undefined
  const res = await bridge($, { op: 'verb', name, args: toolArgs(e), ...(callId !== undefined ? { callId } : {}) })
  if (res === undefined) return { result: `gemflow is unavailable: ${(await read($, problemAtom)) ?? 'no workflow here'}` }
  if (!res.ok) return { result: `gemflow: ${res.error}` }
  return withStage($, { result: res.text ?? '' }, res)
}

const VERB_FAILED = { result: 'gemflow failed; the line above the prompt says why' }

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await update($, rootAtom, () => e.cwd)
    for (const t of FLOW_TOOLS) {
      await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
    }
    const found = await findNode($)
    if ('node' in found) {
      await update($, nodeAtom, () => found.node)
      await bridge($, { op: 'status' })
      // git and gh can take seconds: catch up outside the start the first prompt waits on.
      $.clock.after(0, () => {
        void bridge($, { op: 'refresh' }, SLOW_TIMEOUT_MS)
      })
    } else {
      await update($, problemAtom, () => found.problem)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear ends the conversation the model read the stage in: the next prompt delivers it again.
  on('session.end', async ($, e, next) => {
    await update($, deliveredAtom, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every tool call. A broken gemflow never blocks one: where next already ran, next(e) replays its result.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith(OWN_TOOL_PREFIX)) return next(e)
    const input = toolArgs(e as unknown as Record<string, unknown>)
    const call = { tool, input }
    const policy = (await readShell($))?.policy ?? null
    let consulted = false
    if (beforeDecision(policy, call) === 'consult') {
      const res = await bridge($, { op: 'before', tool, callId: e.tool_use_id, input: bridgeInput(input) })
      if (res !== undefined && res.ok && res.refusal !== undefined) return { deny: `gemflow: ${res.refusal}` }
      consulted = res !== undefined && res.ok && res.recorded === true
    }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const wrotePath = touchedPath(tool, input, (await read($, rootAtom)) ?? '')
    if (wrotePath !== undefined && matchesUnit(policy, wrotePath)) await update($, lastFileAtom, () => wrotePath)
    const exitCode = capabilityOf(tool, CLAUDE_CODE_CAPABILITIES) === 'run' ? bashExitCode(ran) : undefined
    const outcome = {
      isError: ran.isError === true,
      gitOperation: hasGitOperation(ran),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(wrotePath !== undefined ? { wrotePath } : {}),
    }
    if (!afterNeeded(policy, call, { ...outcome, consulted })) return ran
    const res = await bridge($, { op: 'after', tool, callId: e.tool_use_id, input: bridgeInput(input), ...outcome })
    return withStage($, ran, res)
  }).catch(($, e, next) => next(e))

  // The five tools. Each hook is a function literal: the engine reads hooks statically and refuses one that is a call's result.
  on('tool.call', { tool: 'mcp__gemflow__flow_status' }, ($, e) => serveVerb($, 'flow_status', e)).catch(() => VERB_FAILED)
  on('tool.call', { tool: 'mcp__gemflow__flow_context' }, ($, e) => serveVerb($, 'flow_context', e)).catch(() => VERB_FAILED)
  on('tool.call', { tool: 'mcp__gemflow__flow_transition' }, ($, e) => serveVerb($, 'flow_transition', e)).catch(() => VERB_FAILED)
  on('tool.call', { tool: 'mcp__gemflow__flow_set' }, ($, e) => serveVerb($, 'flow_set', e)).catch(() => VERB_FAILED)
  on('tool.call', { tool: 'mcp__gemflow__flow_rollback' }, ($, e) => serveVerb($, 'flow_rollback', e)).catch(() => VERB_FAILED)

  // The stage changed between prompts (a person moved it, session start caught up git): the model hears of it now.
  on('prompt.submit', async ($, e, next) => {
    const root = await read($, rootAtom)
    if (root === null) return next(e)
    let doc: string
    try {
      doc = String(await $.fs.read(`${root}/.geml/context.geml`))
    } catch {
      return next(e)
    }
    const seen = contextOf(doc)
    if (seen === undefined || seen.key === (await read($, deliveredAtom))) return next(e)
    const item = (await readShell($))?.status?.item
    if (item === undefined || item.kind !== 'item' || item.id !== seen.item) return next(e)
    await update($, deliveredAtom, () => seen.key)
    return next({ ...e, context: [...(e.context ?? []), seen.text] })
  }).catch(($, e, next) => next(e))
}
```

- [ ] **Step 5: Build, the purity guard, and the engine's own reading**

Run:
```bash
cd integrations/gemflow && npm run build >/dev/null && node --test test/own-tools.test.mjs test/hooks-purity.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..
claude plugin validate integrations/gemflow; echo "exit=$?"
```
Expected: `ℹ fail 0`; `exit=0`; the report lists `./register.tsx hooks: session.start, session.end, tool.call, tool.call{tool=mcp__gemflow__flow_status}, …, tool.call{tool=mcp__gemflow__flow_rollback}, prompt.submit`, `./register.tsx gating hook with .catch: tool.call` (and one such line for each of the five tools and for `prompt.submit`), `./register.tsx state writes: gemflow.delivered, gemflow.lastFile, gemflow.node, gemflow.problem, gemflow.root, gemflow.shell`, and ends `✔ Validation passed` (the contract already declares `gemflow.board` and `gemflow.tab`, which only Task 9 writes; that is no warning).

- [ ] **Step 6: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add integrations/gemflow/hooks/register.tsx integrations/gemflow/src/core/supervisor.ts integrations/gemflow/test/own-tools.test.mjs
git commit -m "feat(gemflow): the hooks module — session start, tool calls, prompt submit and the five flow_* tools

Session start finds Node, registers the five tools, reads the status and
refreshes git and gh outside the start. Each tool call goes through the fast
path; a refusal comes back as a deny, a stage change as context the model
reads after the result. prompt.submit hands over a stage that changed
between prompts. Every gating hook fails open. Supervisor.owns() takes the
five flow_* names, bare or as mcp__gemflow__<name>, so none of them is ever
refused, recorded as a deviation or rolled back."
```

---

### Task 8: The band

**Files:** Create `integrations/gemflow/src/hosts/claude-code/band.ts`, `integrations/gemflow/test/band.test.mjs`; modify `integrations/gemflow/hooks/register.tsx`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/band.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEP, bandSegments, cellWidth, fitSegments, nextText, toneProps, truncate } from "../dist/hosts/claude-code/band.js";

const status = (over = {}) => ({
  workflow: { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程" },
  item: { kind: "item", id: "feat/rate-limit" },
  state: { id: "review", strict: false, rev: 7 },
  vars: {},
  signals: [
    { id: "tests", on: "command", sets: "tests-pass", label: "npm test", value: true },
    { id: "ci", on: "git", sets: "ci-pass", label: "", value: true },
    { id: "merged", on: "git", sets: "pr-merged", label: "", value: false },
  ],
  next: [
    { id: "rework", to: "build", auto: false, approval: false, holds: true },
    { id: "to-deploy", to: "deploy", auto: true, approval: false, requires: "merged-green", holds: false },
  ],
  refusals: 0, deviations: 0, gh: { available: true }, ...over,
});
const shell = (s, policy = {}) => ({ status: s, policy: { relevant: ["ci", "merged"], deviated: [], ...policy }, contextKey: "feat/rate-limit@7" });
const texts = (segs) => segs.map((x) => x.text);

test("item, state, the signals the next guard reads, and the next step (spec §8.1)", () => {
  const segs = bandSegments(shell(status()), null);
  assert.deepEqual(texts(segs), ["⧗ feat/rate-limit", "review", "ci ✓", "merged ✗", "→ #deploy 自动 · 待 #merged-green"]);
  assert.deepEqual(segs.map((x) => x.tone), ["normal", "normal", "success", "dim", "dim"]);
});

test("a deviation and unavailable git signals are yellow; the final state says so", () => {
  const warned = bandSegments(shell(status({ gh: { available: false, reason: "gh is not installed" } }), { deviated: ["WebFetch"] }), null);
  assert.deepEqual(texts(warned).slice(-2), ["git 信号不可用：gh is not installed", "⚠ 偏离 WebFetch"]);
  assert.deepEqual(warned.slice(-2).map((x) => x.tone), ["warning", "warning"]);
  assert.deepEqual(texts(bandSegments(shell(status({ state: { id: "done", strict: false, rev: 9 }, next: [] }), { relevant: [] }), null)), ["⧗ feat/rate-limit", "done", "✓ 完成"]);
});

test("no work item, no workflow, a broken workflow, a broken bridge", () => {
  assert.deepEqual(bandSegments(shell(status({ item: { kind: "inactive", reason: "main · not tracked (work items are branches)" } })), null),
    [{ text: "⧗ main · not tracked (work items are branches)", tone: "dim" }]);
  assert.deepEqual(bandSegments({ status: null, policy: null, contextKey: null, problem: { text: "no workflow here: run `gemflow init`", quiet: true } }, null), []);
  assert.deepEqual(bandSegments({ status: null, policy: null, contextKey: null, problem: { text: "flow.geml: flow-no-initial: …", quiet: false } }, null),
    [{ text: "gemflow：flow.geml: flow-no-initial: …", tone: "error" }]);
  assert.deepEqual(bandSegments(shell(status()), "gemflow：找不到 node — 请安装 Node ≥ 22"), [{ text: "gemflow：找不到 node — 请安装 Node ≥ 22", tone: "error" }]);
  assert.deepEqual(bandSegments(null, null), []);
});

test("cell widths: CJK and fullwidth punctuation take two cells; combining marks none", () => {
  assert.equal(cellWidth("review"), 6);
  assert.equal(cellWidth("流程"), 4);
  assert.equal(cellWidth("⧗ 评审：x"), 9);
  assert.equal(cellWidth("e\u0301"), 1);
});

test("truncate cuts on cells and never inside a wide character", () => {
  assert.equal(truncate("登录接口加限流", 14), "登录接口加限流");
  assert.equal(truncate("登录接口加限流", 7), "登录接…");
  assert.equal(truncate("登录接口加限流", 6), "登录…");
  assert.equal(truncate("abc", 0), "");
});

test("fitSegments keeps whole segments while they fit and cuts the first that does not", () => {
  const segs = [{ text: "⧗ feat/x", tone: "normal" }, { text: "review", tone: "normal" }, { text: "登录接口加限流", tone: "dim" }];
  assert.deepEqual(texts(fitSegments(segs, 20)), ["⧗ feat/x", "review"]);
  assert.deepEqual(texts(fitSegments(segs, 26)), ["⧗ feat/x", "review", "登录…"]);
  const all = fitSegments(segs, 200);
  assert.equal(all.reduce((w, s, i) => w + cellWidth(s.text) + (i > 0 ? cellWidth(SEP) : 0), 0), 8 + 3 + 6 + 3 + 14);
});

test("the next step's words, and each tone's drawing props", () => {
  assert.equal(nextText({ id: "a", to: "release", auto: false, approval: true, holds: true }), "→ #release 需批准");
  assert.equal(nextText({ id: "b", to: "build", auto: false, approval: false, holds: true }), "→ #build 手动");
  assert.equal(nextText({ id: "c", to: "review", auto: true, approval: false, requires: "ready", holds: true }), "→ #review 自动");
  assert.deepEqual([toneProps("dim"), toneProps("warning"), toneProps("normal")], [{ dimColor: true }, { color: "warning" }, {}]);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/band.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/hosts/claude-code/band.js`.

- [ ] **Step 3: Write the model**

Create `integrations/gemflow/src/hosts/claude-code/band.ts`:

```ts
// The line above the prompt (spec §8.1), as text. Pure and Node-free: the
// hooks module lays these segments out with the surface's elements, so the
// terminal and the desktop draw the same words.
import type { Status } from "../../workspace.js";
import type { ShellStatus } from "./protocol.js";

export type Tone = "normal" | "dim" | "success" | "warning" | "error";
export interface Segment { text: string; tone: Tone }

/** Drawn, dim, between two segments. */
export const SEP = " · ";

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

/** Terminal cells a string takes: East Asian wide and fullwidth characters two; joiners, combining marks and variation selectors none. */
export function cellWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x200d || (c >= 0x300 && c <= 0x36f) || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    width += WIDE.some(([a, b]) => c >= a && c <= b) ? 2 : 1;
  }
  return width;
}

/** At most `max` cells, ending in `…` when cut; never half of a wide character. */
export function truncate(text: string, max: number): string {
  if (cellWidth(text) <= max) return text;
  if (max <= 0) return "";
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = cellWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/** Whole segments while they fit in `columns`, separators counted; the first that does not is cut, the rest dropped. */
export function fitSegments(segments: readonly Segment[], columns: number): Segment[] {
  const out: Segment[] = [];
  let used = 0;
  for (const s of segments) {
    const sep = out.length > 0 ? cellWidth(SEP) : 0;
    const width = cellWidth(s.text);
    if (used + sep + width <= columns) {
      out.push(s);
      used += sep + width;
      continue;
    }
    const room = columns - used - sep;
    if (room >= 2) out.push({ ...s, text: truncate(s.text, room) });
    break;
  }
  return out;
}

const TONE_COLOR: Readonly<Record<Tone, string | undefined>> = { normal: undefined, dim: undefined, success: "success", warning: "warning", error: "error" };

/** A `Text`'s props for a tone: a theme color, or dim. */
export function toneProps(tone: Tone): { color?: string; dimColor?: true } {
  if (tone === "dim") return { dimColor: true };
  const color = TONE_COLOR[tone];
  return color !== undefined ? { color } : {};
}

type Edge = Status["next"][number];

export function nextText(t: Edge): string {
  const how = t.approval ? "需批准" : t.auto ? "自动" : "手动";
  const waiting = t.requires !== undefined && !t.holds ? ` · 待 #${t.requires}` : "";
  return `→ #${t.to} ${how}${waiting}`;
}

export function bandSegments(shell: ShellStatus | null, problem: string | null): Segment[] {
  if (problem !== null) return [{ text: problem, tone: "error" }];
  if (shell === null) return [];
  const s = shell.status;
  if (s === null) return shell.problem !== undefined && !shell.problem.quiet ? [{ text: `gemflow：${shell.problem.text}`, tone: "error" }] : [];
  if (s.item.kind === "inactive") return [{ text: `⧗ ${s.item.reason}`, tone: "dim" }];
  const out: Segment[] = [{ text: `⧗ ${s.item.id}`, tone: "normal" }, { text: s.state?.id ?? "?", tone: "normal" }];
  const relevant = new Set(shell.policy?.relevant ?? []);
  for (const sig of s.signals) {
    if (relevant.has(sig.id)) out.push({ text: `${sig.id} ${sig.value ? "✓" : "✗"}`, tone: sig.value ? "success" : "dim" });
  }
  const edge = s.next.find((t) => t.auto) ?? s.next.find((t) => t.approval) ?? s.next[0];
  out.push(edge !== undefined ? { text: nextText(edge), tone: "dim" } : { text: "✓ 完成", tone: "success" });
  if (s.gh !== undefined && !s.gh.available && s.signals.some((x) => x.on === "git")) out.push({ text: `git 信号不可用：${s.gh.reason}`, tone: "warning" });
  const deviated = shell.policy?.deviated ?? [];
  if (deviated.length > 0) out.push({ text: `⚠ 偏离 ${deviated.join(" ")}`, tone: "warning" });
  return out;
}
```

- [ ] **Step 4: Draw it**

In `integrations/gemflow/hooks/register.tsx`, add to the imports:

```tsx
import { bandSegments, fitSegments, SEP, toneProps } from '../dist/hosts/claude-code/band.js'
```

and add, as the last statement inside `register` (after the `prompt.submit` hook):

```tsx
  // The band (spec §8.1): text from band.ts, laid out here. A survey holding the band comes first.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const segments = fitSegments(bandSegments(await readShell($), await read($, problemAtom)), e.props.bodyColumns)
    if (segments.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        {segments.flatMap((s, i) => [
          ...(i > 0 ? [<Text dimColor>{SEP}</Text>] : []),
          <Text {...toneProps(s.tone)}>{s.text}</Text>,
        ])}
      </Box>
    )
  })
```

- [ ] **Step 5: Run the suite once, and validate**

Run:
```bash
cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; cd ../..
claude plugin validate integrations/gemflow; echo "exit=$?"
```
Expected: `exit=0`, `ℹ fail 0`; validate `exit=0`, the hooks list now includes `ui.render{component=AbovePrompt}`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/src/hosts/claude-code/band.ts integrations/gemflow/test/band.test.mjs integrations/gemflow/hooks/register.tsx
git commit -m "feat(gemflow): the band above the prompt

⧗ <item> · <state> · the signals the next guard reads · the next step, with
a yellow segment for a deviation or unavailable git signals and one red line
when the bridge is broken. The words come from a pure model that counts East
Asian wide characters as two cells; the hooks module only lays them out."
```

---

### Task 9: The board

**Files:** Create `integrations/gemflow/src/hosts/claude-code/board.ts`, `integrations/gemflow/test/board.test.mjs`; modify `integrations/gemflow/hooks/register.tsx`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/board.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellWidth } from "../dist/hosts/claude-code/band.js";
import { BOARD_ID, TABS, entryText, flowRows, itemRows, journalRows } from "../dist/hosts/claude-code/board.js";

const BOARD = {
  states: [
    { id: "build", initial: true, final: false, strict: false },
    { id: "review", initial: false, final: false, strict: false },
    { id: "deploy", initial: false, final: false, strict: true },
    { id: "done", initial: false, final: true, strict: false },
  ],
  transitions: [
    { id: "to-review", from: "build", to: "review", auto: true, approval: false, requires: "ready" },
    { id: "to-deploy", from: "review", to: "deploy", auto: true, approval: false, requires: "merged-green" },
    { id: "rework", from: "review", to: "build", auto: false, approval: false },
    { id: "ship", from: "deploy", to: "done", auto: false, approval: true },
  ],
  onlyIn: [{ signal: "staging", match: "wrangler deploy --env staging", states: ["deploy"] }],
  backlog: { key: "branch", items: [
    { id: "rate-limit", title: "登录接口加限流", target: "feat/rate-limit" },
    { id: "dark-mode", title: "设置页支持深色模式和高对比度主题", target: "" },
  ] },
  items: [{ id: "feat/rate-limit", state: "review", rev: 7 }, { id: "feat/x", state: "review", rev: 3 }],
  timeline: [
    { kind: "snapshot", rev: 0, at: "2026-10-12T09:00:00Z", state: "build", cause: "enter" },
    { kind: "snapshot", rev: 1, at: "2026-10-12T09:01:02Z", state: "build", cause: "patch", by: "signal", signal: "tests" },
    { kind: "deviation", rev: 1, at: "2026-10-12T09:02:00Z", tool: "WebFetch", state: "build", capability: "web" },
    { kind: "refused", rev: 1, at: "2026-10-12T09:03:00Z", tool: "Bash", reason: "`gemflow mark reviewed` is for a person" },
    { kind: "snapshot", rev: 3, at: "2026-10-12T09:04:00Z", state: "review", cause: "transition", by: "signal", signal: "pr" },
  ],
};
const status = (item = { kind: "item", id: "feat/x" }) => ({
  workflow: { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程" }, item,
  state: { id: "review", strict: false, rev: 3 }, vars: {},
  signals: [{ id: "reviewed", on: "manual", sets: "review-done", label: "review 意见已处理", value: false }],
  next: [{ id: "to-deploy", to: "deploy", auto: true, approval: false, requires: "merged-green", holds: false }, { id: "rework", to: "build", auto: false, approval: false, holds: true }],
  refusals: 1, deviations: 1, gh: { available: true },
});
const buttons = (rows) => rows.filter((r) => r.kind === "button");
const widths = (rows) => rows.map((r) => cellWidth(r.kind === "text" ? r.text : r.label));

test("the board's id and its three tabs (spec §8.2)", () => {
  assert.equal(BOARD_ID, "gemflow-board");
  assert.deepEqual(TABS.map((t) => [t.id, t.label]), [["flow", "流程"], ["items", "工作项"], ["journal", "记录"]]);
});

test("流程: the current state highlighted, its edges as buttons, only-in commands and manual signals", () => {
  const rows = flowRows(BOARD, status(), 60);
  assert.deepEqual(rows.find((r) => r.kind === "text" && r.text.startsWith("▶")), { kind: "text", text: "▶ #review", tone: "success" });
  assert.deepEqual(buttons(rows).map((b) => [b.key, b.label, b.action]), [
    ["advance-deploy", "→ #deploy  自动  要求 #merged-green（未满足）", { op: "advance", to: "deploy" }],
    ["advance-build", "→ #build  手动", { op: "advance", to: "build" }],
    ["mark-reviewed", "[ ] review 意见已处理", { op: "mark", signal: "reviewed", checked: true }],
  ]);
  assert.ok(rows.some((r) => r.kind === "text" && r.text === "    → #done  需批准" && r.tone === "warning"), "an approval edge has its own style");
  assert.ok(rows.some((r) => r.kind === "text" && r.text === "  staging：wrangler deploy --env staging — 只在 #deploy" && r.tone === "warning"));
  assert.ok(rows.some((r) => r.kind === "text" && r.text === "  #deploy  严格"));
});

test("流程 with no work item: no buttons", () => {
  assert.deepEqual(buttons(flowRows(BOARD, status({ kind: "inactive", reason: "main · not tracked" }), 60)), []);
});

test("工作项: bound items with their state, a to-do offered to the unbound current item, and the rest", () => {
  const rows = itemRows(BOARD, status(), 80);
  assert.deepEqual(buttons(rows).map((b) => [b.key, b.action]), [["bind-dark-mode", { op: "bind", id: "dark-mode" }]]);
  assert.ok(rows.some((r) => r.kind === "text" && r.text === "  rate-limit  登录接口加限流 → feat/rate-limit · #review"));
  assert.ok(rows.some((r) => r.kind === "text" && r.text === "  ▶ feat/x · #review" && r.tone === "success"));
  for (const w of widths(itemRows(BOARD, status(), 24))) assert.ok(w <= 24, `a row is ${w} cells`);
  const bound = itemRows(BOARD, status({ kind: "item", id: "feat/rate-limit" }), 60);
  assert.deepEqual(buttons(bound), []);
  assert.ok(bound.some((r) => r.kind === "text" && r.text.includes("dark-mode") && r.text.endsWith("（待办）")));
});

test("记录: the newest entries that fit, in order, each in words", () => {
  assert.deepEqual(journalRows(BOARD, 80, 3).map((r) => [r.text, r.tone]), [
    ["rev 1  09:02:00  偏离 WebFetch（web）于 #build", "warning"],
    ["rev 1  09:03:00  拒绝 Bash：`gemflow mark reviewed` is for a person", "error"],
    ["rev 3  09:04:00  #review  推进 · 信号 pr", "normal"],
  ]);
  assert.equal(entryText(BOARD.timeline[0]), "rev 0  09:00:00  #build  进入");
  assert.deepEqual(journalRows({ ...BOARD, timeline: [] }, 80, 10), [{ kind: "text", text: "这个工作项还没有记录", tone: "dim" }]);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/board.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/hosts/claude-code/board.js`.

- [ ] **Step 3: Write the model**

Create `integrations/gemflow/src/hosts/claude-code/board.ts`:

```ts
// The board's three tabs (spec §8.2) as rows of text and buttons. Pure and
// Node-free: the hooks module lays the rows out with the surface's elements
// and runs a button's action through the bridge.
import type { Status } from "../../workspace.js";
import type { BoardData, TimelineEntry } from "./protocol.js";
import { truncate, type Tone } from "./band.js";

export const BOARD_ID = "gemflow-board";
export type BoardTab = "flow" | "items" | "journal";
export const TABS: readonly { id: BoardTab; label: string }[] = [
  { id: "flow", label: "流程" },
  { id: "items", label: "工作项" },
  { id: "journal", label: "记录" },
];

export type BoardAction =
  | { op: "advance"; to: string }
  | { op: "mark"; signal: string; checked: boolean }
  | { op: "bind"; id: string }
  | { op: "refresh" };

export type BoardRow =
  | { kind: "text"; text: string; tone: Tone }
  | { kind: "button"; key: string; label: string; action: BoardAction };

const BLANK = " ";
const text = (t: string, columns: number, tone: Tone = "normal"): BoardRow => ({ kind: "text", text: truncate(t, columns), tone });
const button = (key: string, label: string, columns: number, action: BoardAction): BoardRow => ({ kind: "button", key, label: truncate(label, columns), action });
const how = (t: { auto: boolean; approval: boolean }): string => (t.approval ? "需批准" : t.auto ? "自动" : "手动");

export function flowRows(board: BoardData, status: Status | null, columns: number): BoardRow[] {
  const current = status?.state?.id;
  const acting = status?.item.kind === "item";
  const holds = new Map((status?.next ?? []).map((t) => [t.id, t.holds]));
  const rows: BoardRow[] = [];
  for (const s of board.states) {
    const here = s.id === current;
    const marks = [s.initial ? "起点" : "", s.final ? "终点" : "", s.strict ? "严格" : ""].filter((m) => m !== "").join(" · ");
    rows.push(text(`${here ? "▶" : " "} #${s.id}${marks ? `  ${marks}` : ""}`, columns, here ? "success" : "normal"));
    for (const t of board.transitions.filter((x) => x.from === s.id)) {
      const guard = t.requires !== undefined ? `  要求 #${t.requires}${here && holds.get(t.id) === false ? "（未满足）" : ""}` : "";
      const line = `→ #${t.to}  ${how(t)}${guard}`;
      rows.push(here && acting
        ? button(`advance-${t.to}`, line, columns, { op: "advance", to: t.to })
        : text(`    ${line}`, columns, t.approval ? "warning" : "dim"));
    }
  }
  if (board.onlyIn.length > 0) {
    rows.push(text(BLANK, columns), text("封路命令", columns, "warning"));
    for (const c of board.onlyIn) rows.push(text(`  ${c.signal}：${c.match} — 只在 ${c.states.map((x) => `#${x}`).join(" ")}`, columns, "warning"));
  }
  const manual = (status?.signals ?? []).filter((x) => x.on === "manual");
  if (manual.length > 0) {
    rows.push(text(BLANK, columns), text("手动信号（只能由人勾选）", columns));
    for (const m of manual) {
      const label = `${m.value ? "[x]" : "[ ]"} ${m.label || m.id}`;
      rows.push(acting ? button(`mark-${m.id}`, label, columns, { op: "mark", signal: m.id, checked: !m.value }) : text(`  ${label}`, columns, "dim"));
    }
  }
  return rows;
}

export function itemRows(board: BoardData, status: Status | null, columns: number): BoardRow[] {
  const current = status?.item.kind === "item" ? status.item.id : undefined;
  const stateOf = new Map(board.items.map((i) => [i.id, i.state]));
  const rows: BoardRow[] = [text("待办与进行中", columns)];
  const backlog = board.backlog;
  if (backlog === null) rows.push(text("  没有 .geml/backlog.geml", columns, "dim"));
  else {
    const boundHere = current !== undefined && backlog.items.some((i) => i.target === current);
    for (const i of backlog.items) {
      if (i.target !== "") {
        const state = stateOf.get(i.target);
        rows.push(text(`  ${i.id}  ${i.title} → ${i.target}${state !== undefined ? ` · #${state}` : ""}`, columns, i.target === current ? "success" : "normal"));
      } else if (current !== undefined && !boundHere) {
        rows.push(button(`bind-${i.id}`, `绑定 ${i.id}（${i.title}）到 ${current}`, columns, { op: "bind", id: i.id }));
      } else {
        rows.push(text(`  ${i.id}  ${i.title}（待办）`, columns, "dim"));
      }
    }
  }
  const targets = new Set((backlog?.items ?? []).map((i) => i.target).filter((t) => t !== ""));
  const loose = board.items.filter((i) => !targets.has(i.id));
  if (loose.length > 0) {
    rows.push(text(BLANK, columns), text("其他工作项", columns));
    for (const i of loose) rows.push(text(`  ${i.id === current ? "▶" : " "} ${i.id} · #${i.state}`, columns, i.id === current ? "success" : "normal"));
  }
  return rows;
}

const CAUSE: Readonly<Record<string, string>> = { enter: "进入", transition: "推进", patch: "写变量", rollback: "回滚", "error-rollback": "出错回滚" };
const BY: Readonly<Record<string, string>> = { model: "模型", signal: "信号", human: "人" };

export function entryText(e: TimelineEntry): string {
  const at = e.at.length >= 19 ? e.at.slice(11, 19) : e.at;
  if (e.kind === "snapshot") {
    const by = e.by !== undefined ? ` · ${BY[e.by] ?? e.by}${e.signal !== undefined ? ` ${e.signal}` : ""}` : "";
    return `rev ${e.rev}  ${at}  #${e.state}  ${CAUSE[e.cause] ?? e.cause}${by}`;
  }
  if (e.kind === "refused") return `rev ${e.rev}  ${at}  拒绝 ${e.tool}：${e.reason}`;
  return `rev ${e.rev}  ${at}  偏离 ${e.tool}${e.capability !== null ? `（${e.capability}）` : ""}于 #${e.state}`;
}

export function journalRows(board: BoardData, columns: number, maxRows: number): BoardRow[] {
  if (board.timeline.length === 0) return [text("这个工作项还没有记录", columns, "dim")];
  return board.timeline.slice(-Math.max(1, maxRows)).map((e) =>
    text(entryText(e), columns, e.kind === "refused" ? "error" : e.kind === "deviation" ? "warning" : "normal"));
}
```

- [ ] **Step 4: Draw it, and wire its buttons**

In `integrations/gemflow/hooks/register.tsx`:

1. Change `import type { GemflowJson } from '../types'` to `import type { GemflowJson, GemflowTab } from '../types'`, change the protocol type import to `import type { BoardData, BridgeOp, BridgeRequest, BridgeResponse, ShellStatus } from '../dist/hosts/claude-code/protocol.js'`, and add:

```tsx
import { BOARD_ID, flowRows, itemRows, journalRows, TABS } from '../dist/hosts/claude-code/board.js'
import type { BoardAction, BoardRow } from '../dist/hosts/claude-code/board.js'
```

2. After the `lastFileAtom` line add:

```tsx
const boardAtom = atom({ plugin: 'gemflow', key: 'board' } as const, null as GemflowJson)
const tabAtom = atom({ plugin: 'gemflow', key: 'tab' } as const, 'flow' as GemflowTab)
```

3. After `serveVerb`, add:

```tsx
async function loadBoard($: EngineInterface): Promise<void> {
  const res = await bridge($, { op: 'board' }, SLOW_TIMEOUT_MS)
  if (res !== undefined && res.ok && res.board !== undefined) {
    const board = res.board
    await update($, boardAtom, () => board as unknown as GemflowJson)
  }
}

/** A board button: a person's move, tick or binding, through the bridge; then the board is read again. */
async function boardAct($: EngineInterface, action: BoardAction): Promise<void> {
  if (action.op !== 'refresh') {
    const op: BridgeOp = action.op === 'advance' ? { op: 'advance', to: action.to }
      : action.op === 'mark' ? { op: 'mark', signal: action.signal, checked: action.checked }
      : { op: 'bind', id: action.id }
    const res = await bridge($, op)
    if (res !== undefined && !res.ok) $.ui.toast(`gemflow：${res.error}`)
  }
  await loadBoard($)
}
```

4. Add, as the last statement inside `register`:

```tsx
  // The board (spec §8.2): three tabs as a row of buttons over the tab atom; rows from board.ts.
  // The matcher spells BOARD_ID's value: the engine reads matchers statically (an imported constant shows as requestId=?).
  on('ui.render', { component: 'Pane', requestId: 'gemflow-board' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const tab = await read($, tabAtom)
    const board = (await read($, boardAtom)) as unknown as BoardData | null
    const status = (await readShell($))?.status ?? null
    const columns = e.props.bodyColumns
    const rows: BoardRow[] = board === null ? [{ kind: 'text', text: '正在读取看板…', tone: 'dim' }]
      : tab === 'flow' ? flowRows(board, status, columns)
      : tab === 'items' ? itemRows(board, status, columns)
      : journalRows(board, columns, Math.max(1, e.props.scroll.bodyRows - 2))
    return (
      <Box flexDirection="column">
        <Box gap={2}>
          {TABS.map((t) => (
            <Button key={`tab-${t.id}`} plain label={t.id === tab ? `【${t.label}】` : t.label} onPress={() => update($, tabAtom, () => t.id)} />
          ))}
          <Button key="refresh" plain dimColor label="刷新" onPress={() => boardAct($, { op: 'refresh' })} />
        </Box>
        {rows.map((r) => (r.kind === 'text'
          ? <Text {...toneProps(r.tone)}>{r.text}</Text>
          : <Button key={r.key} plain label={r.label} onPress={() => boardAct($, r.action)} />))}
      </Box>
    )
  })
```

- [ ] **Step 5: Run the suite once, and validate**

Run:
```bash
cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; cd ../..
claude plugin validate integrations/gemflow; echo "exit=$?"
```
Expected: `exit=0`, `ℹ fail 0`; validate `exit=0`, the hooks list includes `ui.render{component=Pane, requestId=gemflow-board}` and the state writes list `gemflow.board` and `gemflow.tab`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/src/hosts/claude-code/board.ts integrations/gemflow/test/board.test.mjs integrations/gemflow/hooks/register.tsx
git commit -m "feat(gemflow): the board — 流程, 工作项, 记录

The flow tab highlights the current state, turns its edges into buttons (a
person's move; the press is the approval), styles approval edges and only-in
commands apart, and ticks manual signals. The items tab shows the backlog
with each bound item's state and offers a to-do to an unbound branch. The
journal tab is the current item's timeline. Rows come from a pure model;
every surface draws them with Box, Text and Button."
```

---

### Task 10: `/gemflow` and the + menu

**Files:** Create `integrations/gemflow/src/hosts/claude-code/command.ts`, `integrations/gemflow/test/command.test.mjs`; modify `integrations/gemflow/hooks/register.tsx`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/command.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_HINT, COMMAND_USAGE, addText, boardText, commandText, parseCommand, statusText } from "../dist/hosts/claude-code/command.js";

const status = {
  workflow: { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程" },
  item: { kind: "item", id: "feat/x" }, state: { id: "review", strict: false, rev: 7 }, vars: {},
  signals: [{ id: "tests", on: "command", sets: "tests-pass", label: "npm test", value: true }, { id: "ci", on: "git", sets: "ci-pass", label: "", value: false }],
  next: [{ id: "to-deploy", to: "deploy", auto: true, approval: false, requires: "merged-green", holds: false }, { id: "rework", to: "build", auto: false, approval: false, holds: true }],
  refusals: 1, deviations: 2, gh: { available: false, reason: "gh is not installed" },
};
const shell = { status, policy: { deviated: ["WebFetch"] }, contextKey: "feat/x@7" };

test("the argument string becomes one intent", () => {
  assert.deepEqual(parseCommand(""), { kind: "status" });
  assert.deepEqual(parseCommand("  board "), { kind: "board" });
  assert.deepEqual(parseCommand("use dev"), { kind: "use", workflow: "dev" });
  assert.deepEqual(parseCommand("add"), { kind: "add" });
  assert.deepEqual(parseCommand("add dev"), { kind: "add", workflow: "dev" });
  assert.deepEqual(parseCommand("help"), { kind: "help" });
  assert.deepEqual(parseCommand("use"), { kind: "help", reason: "不认识的用法：/gemflow use" });
  assert.equal(COMMAND_HINT, "[board | use <流程> | add [流程]]");
});

test("/gemflow prints where the work stands", () => {
  assert.equal(statusText(shell), [
    "流程 dev（开发流程）",
    "工作项 feat/x · 阶段 #review · rev 7",
    "信号：tests ✓ · ci ✗",
    "下一步：→ #deploy 自动 · 待 #merged-green；→ #build 手动",
    "git 信号不可用：gh is not installed",
    "拒绝 1 · 偏离 2（本阶段：WebFetch）",
  ].join("\n"));
  assert.equal(statusText({ status: null, policy: null, contextKey: null, problem: { text: "no workflow here: run `gemflow init`", quiet: true } }), "这个项目还没有流程。用 /gemflow add 选一个内置流程。");
  assert.equal(statusText({ ...shell, status: { ...status, item: { kind: "inactive", reason: "main · not tracked (work items are branches)" } } }), "流程 dev（开发流程）\nmain · not tracked (work items are branches)");
});

test("the + menu lists, then copies; use names the active workflow", () => {
  assert.equal(addText({ v: 1, ok: true, shell, workflows: ["coding", "dev", "refund"], installed: ["dev"] }), "内置流程：coding、dev（已在本项目）、refund\n用 /gemflow add <流程> 把一个复制到 .geml/workflows/。");
  assert.equal(addText({ v: 1, ok: true, shell, added: { name: "dev", activated: true } }), "已把内置流程 dev 复制到 .geml/workflows/dev/，并设为当前流程。");
  assert.equal(addText({ v: 1, ok: true, shell, added: { name: "refund", activated: false } }), "已把内置流程 refund 复制到 .geml/workflows/refund/。用 /gemflow use refund 让它成为当前流程。");
  assert.match(commandText({ kind: "use", workflow: "dev" }, { v: 1, ok: true, shell }, null), /^当前流程：dev\n流程 dev/);
});

test("help, a bridge that did not answer, an error answer, the board", () => {
  assert.equal(commandText({ kind: "help" }, undefined, null), COMMAND_USAGE);
  assert.equal(commandText({ kind: "help", reason: "不认识的用法：/gemflow x" }, undefined, null), `不认识的用法：/gemflow x\n${COMMAND_USAGE}`);
  assert.equal(commandText({ kind: "status" }, undefined, "gemflow：找不到 node — 请安装 Node ≥ 22"), "gemflow：找不到 node — 请安装 Node ≥ 22");
  assert.equal(commandText({ kind: "use", workflow: "nope" }, { v: 1, ok: false, error: "no workflow .geml/workflows/nope/flow.geml" }, null), "gemflow：no workflow .geml/workflows/nope/flow.geml");
  assert.equal(boardText(undefined), "已打开 Gemflow 看板。");
  assert.equal(boardText("terminal is 100 columns; 144 needed"), "看板已打开，终端够宽时显示（terminal is 100 columns; 144 needed）。");
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npx tsc && node --test test/command.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find"; cd ../..`
Expected: `Cannot find module …/dist/hosts/claude-code/command.js`.

- [ ] **Step 3: Write the model**

Create `integrations/gemflow/src/hosts/claude-code/command.ts`:

```ts
// `/gemflow` (spec §8.3): parsing its argument string and wording its answers.
// Pure and Node-free: the hooks module runs the intent through the bridge.
import type { BridgeResponse, ShellStatus } from "./protocol.js";
import { nextText, SEP } from "./band.js";

export type CommandIntent =
  | { kind: "status" }
  | { kind: "board" }
  | { kind: "use"; workflow: string }
  | { kind: "add"; workflow?: string }
  | { kind: "help"; reason?: string };

export const COMMAND_HINT = "[board | use <流程> | add [流程]]";

export const COMMAND_USAGE = [
  "/gemflow                 当前工作项、阶段、信号与下一步",
  "/gemflow board           打开流程看板",
  "/gemflow use <流程>      切换当前项目的流程",
  "/gemflow add [流程]      列出内置流程；带名字时复制到 .geml/workflows/",
].join("\n");

export function parseCommand(args: string): CommandIntent {
  const words = args.trim().split(/\s+/).filter((w) => w.length > 0);
  const [head, ...rest] = words;
  if (head === undefined) return { kind: "status" };
  if (head === "help" && rest.length === 0) return { kind: "help" };
  if (head === "board" && rest.length === 0) return { kind: "board" };
  if (head === "use" && rest.length === 1) return { kind: "use", workflow: rest[0]! };
  if (head === "add" && rest.length <= 1) return rest.length === 1 ? { kind: "add", workflow: rest[0]! } : { kind: "add" };
  return { kind: "help", reason: `不认识的用法：/gemflow ${args.trim()}` };
}

export function statusText(shell: ShellStatus): string {
  const s = shell.status;
  if (s === null) {
    return shell.problem?.quiet === true ? "这个项目还没有流程。用 /gemflow add 选一个内置流程。" : `gemflow：${shell.problem?.text ?? "没有状态"}`;
  }
  const head = `流程 ${s.workflow.name}（${s.workflow.title}）`;
  if (s.item.kind === "inactive") return `${head}\n${s.item.reason}`;
  const deviated = shell.policy?.deviated ?? [];
  const lines = [
    head,
    `工作项 ${s.item.id} · 阶段 #${s.state?.id ?? "?"}${s.state?.strict ? "（严格）" : ""} · rev ${s.state?.rev ?? 0}`,
    `信号：${s.signals.length > 0 ? s.signals.map((x) => `${x.id} ${x.value ? "✓" : "✗"}`).join(SEP) : "无"}`,
    `下一步：${s.next.length > 0 ? s.next.map(nextText).join("；") : "无（终点）"}`,
  ];
  if (s.gh !== undefined && !s.gh.available) lines.push(`git 信号不可用：${s.gh.reason}`);
  lines.push(`拒绝 ${s.refusals} · 偏离 ${s.deviations}${deviated.length > 0 ? `（本阶段：${deviated.join(" ")}）` : ""}`);
  return lines.join("\n");
}

export function addText(res: Extract<BridgeResponse, { ok: true }>): string {
  if (res.added !== undefined) {
    const { name, activated } = res.added;
    return activated
      ? `已把内置流程 ${name} 复制到 .geml/workflows/${name}/，并设为当前流程。`
      : `已把内置流程 ${name} 复制到 .geml/workflows/${name}/。用 /gemflow use ${name} 让它成为当前流程。`;
  }
  const installed = new Set(res.installed ?? []);
  const list = (res.workflows ?? []).map((n) => (installed.has(n) ? `${n}（已在本项目）` : n));
  return `内置流程：${list.length > 0 ? list.join("、") : "无"}\n用 /gemflow add <流程> 把一个复制到 .geml/workflows/。`;
}

export function boardText(waitReason: string | undefined): string {
  return waitReason === undefined ? "已打开 Gemflow 看板。" : `看板已打开，终端够宽时显示（${waitReason}）。`;
}

export function commandText(intent: CommandIntent, res: BridgeResponse | undefined, problem: string | null): string {
  if (intent.kind === "help") return intent.reason !== undefined ? `${intent.reason}\n${COMMAND_USAGE}` : COMMAND_USAGE;
  if (res === undefined) return problem ?? "gemflow：桥接不可用";
  if (!res.ok) return `gemflow：${res.error}`;
  if (intent.kind === "use") return `当前流程：${intent.workflow}\n${statusText(res.shell)}`;
  if (intent.kind === "add") return addText(res);
  return statusText(res.shell);
}
```

- [ ] **Step 4: Register and answer the command**

In `integrations/gemflow/hooks/register.tsx`:

1. Add to the imports:

```tsx
import { boardText, COMMAND_HINT, commandText, parseCommand } from '../dist/hosts/claude-code/command.js'
```

2. In the `session.start` hook, right after the `for (const t of FLOW_TOOLS) { … }` loop, add:

```tsx
    await $.command.register({ name: 'gemflow', description: 'Gemflow：当前阶段、看板、切换或添加流程', argumentHint: COMMAND_HINT })
```

3. Add, as the last statement inside `register`:

```tsx
  // /gemflow (spec §8.3). The board opens only when asked, so it is placed at any width.
  on('command.run', { command: 'gemflow' }, async ($, e) => {
    const intent = parseCommand(e.args)
    if (intent.kind === 'board') {
      await loadBoard($)
      const opened = await $.ui.open({ id: BOARD_ID, title: 'Gemflow' })
      return { text: boardText(opened.isPlaced ? undefined : opened.reason) }
    }
    const op: BridgeOp | undefined = intent.kind === 'status' ? { op: 'status' }
      : intent.kind === 'use' ? { op: 'use', workflow: intent.workflow }
      : intent.kind === 'add' ? { op: 'add', ...(intent.workflow !== undefined ? { workflow: intent.workflow } : {}) }
      : undefined
    const res = op === undefined ? undefined : await bridge($, op, intent.kind === 'status' ? BRIDGE_TIMEOUT_MS : SLOW_TIMEOUT_MS)
    return { text: commandText(intent, res, await read($, problemAtom)) }
  }).catch(() => ({ text: 'gemflow：命令没有完成，原因见输入框上方的状态带' }))
```

- [ ] **Step 5: Run the suite once, and validate**

Run:
```bash
cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; cd ../..
claude plugin validate integrations/gemflow; echo "exit=$?"
```
Expected: `exit=0`, `ℹ fail 0`; validate `exit=0` with a line `./register.tsx answers its own command: command.run{command=gemflow}`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/src/hosts/claude-code/command.ts integrations/gemflow/test/command.test.mjs integrations/gemflow/hooks/register.tsx
git commit -m "feat(gemflow): /gemflow — status, board, use, and the + menu

/gemflow prints the work item, stage, signals and next steps; board opens
the board; use switches the project's workflow; add lists the bundled
workflows and copies one into .geml/workflows/, making it active only when
the project has none yet."
```

---

### Task 11: The dev workflow

**Files:** Create `integrations/gemflow/workflows/dev/flow.geml`, `integrations/gemflow/workflows/dev/guide.geml`, `integrations/gemflow/test/dev-workflow.test.mjs`; modify `integrations/gemflow/src/cli.ts` (the `init` usage row), `integrations/gemflow/test/cli.test.mjs` (the template list in one message).

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/dev-workflow.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadStatechart } from "../dist/core/statechart.js";
import { onlyInRefusal } from "../dist/core/signals.js";
import { blockText } from "../dist/core/blocks.js";
import { BUNDLE, fakeGh, gitRepo, hook } from "./helpers/repo.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FLOW = fileURLToPath(new URL("../workflows/dev/flow.geml", import.meta.url));
const GUIDE = readFileSync(new URL("../workflows/dev/guide.geml", import.meta.url), "utf8");
const sc = () => loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml").statechart;

test("the dev workflow checks with no diagnostics, and every context reference resolves to a guide block", () => {
  const r = spawnSync(process.execPath, [CLI, "check", FLOW], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^ok: no diagnostics$/m);
  const resolveRef = (ref) => ref.startsWith("./guide.geml#") && blockText(GUIDE, ref.slice("./guide.geml#".length)) !== undefined;
  assert.deepEqual(loadStatechart(readFileSync(FLOW, "utf8"), "flow.geml", { resolveRef }).diagnostics, []);
});

test("five states in order on a branch unit; the signals table and the two blocking points as spec §4.1 and §7.1 have them", () => {
  const s = sc();
  assert.deepEqual([...s.states.keys()], ["build", "review", "deploy", "release", "done"]);
  assert.deepEqual(s.unit, { kind: "branch" });
  assert.deepEqual([...s.states.values()].map((x) => x.context), [["./guide.geml#build"], ["./guide.geml#review"], ["./guide.geml#deploy"], ["./guide.geml#release"], []]);
  assert.deepEqual(s.signals.map((x) => [x.id, x.on, x.sets, x.when, x.onlyIn]), [
    ["tests", "command", "tests-pass", "exit-zero", []],
    ["pr", "git", "pr-open", "pr-open", []],
    ["ci", "git", "ci-pass", "ci-success", []],
    ["merged", "git", "pr-merged", "pr-merged", []],
    ["reviewed", "manual", "review-done", "checked", []],
    ["staging", "command", "deployed-staging", "exit-zero", ["deploy", "release"]],
    ["prod", "command", "deployed-prod", "exit-zero", ["release"]],
  ]);
  const edge = (id) => s.transitions.find((t) => t.id === id);
  assert.deepEqual([edge("to-review").auto, edge("to-review").requiresId], [true, "ready-for-review"]);
  assert.deepEqual([edge("to-deploy").auto, edge("to-deploy").requiresId], [true, "merged-green"]);
  assert.deepEqual([edge("to-release").auto, edge("to-release").approval], [false, true]);
  assert.deepEqual([edge("ship").auto, edge("ship").requiresId], [true, "prod-live"]);
  assert.match(onlyInRefusal(s, "review", "wrangler deploy --env staging"), /may only run in #deploy, #release/);
  assert.equal(onlyInRefusal(s, "deploy", "wrangler deploy --env staging"), undefined);
  assert.match(onlyInRefusal(s, "deploy", "wrangler deploy --env production"), /may only run in #release/);
  assert.equal(onlyInRefusal(s, "release", "wrangler deploy --env production"), undefined);
});

test("end to end through the bridge: signals advance it, deploys wait for their states, release waits for a person", () => {
  const root = gitRepo();
  const init = spawnSync(process.execPath, [BUNDLE, "init", "--template", "dev"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^wrote \.geml\/workflows\/dev\/ \(active\)$/m);
  const gh = fakeGh();
  const deploy = (command, callId) => hook(root, { op: "before", tool: "Bash", callId, input: { command } });
  assert.equal(hook(root, { op: "status" }).shell.status.state.id, "build");
  assert.match(deploy("npx wrangler deploy --env staging", "d1").refusal, /may only run in #deploy, #release/);

  hook(root, { op: "after", tool: "Bash", callId: "t1", input: { command: "npm test" }, isError: false, exitCode: 0, gitOperation: false });
  gh.set({ pr: "OPEN" });
  const review = hook(root, { op: "refresh" }, gh.env);
  assert.deepEqual(review.entered, ["review"]);
  assert.match(review.context, /PR 已开。处理 review 意见/);
  assert.match(review.context, /--- \.\/guide\.geml#review ---\n# 评审 \{#review\}/, "the guide's block, read in process by the bundle");

  gh.set({ pr: "MERGED", runs: [{ name: "ci", conclusion: "success" }] });
  const merged = hook(root, { op: "after", tool: "Bash", callId: "g1", input: { command: "gh pr merge 7 --squash" }, isError: false, exitCode: 0, gitOperation: true }, gh.env);
  assert.deepEqual(merged.entered, ["deploy"]);
  assert.equal(deploy("wrangler deploy --env staging", "d2").refusal, undefined);
  assert.match(deploy("wrangler deploy --env production", "d3").refusal, /may only run in #release/);

  const model = hook(root, { op: "verb", name: "flow_transition", args: { to: "release" }, callId: "v1" });
  assert.match(model.text, /^refused: transition #to-release: approval was not granted — a person approves it on the Gemflow board/);
  assert.deepEqual(hook(root, { op: "advance", to: "release" }).entered, ["release"]);
  assert.equal(deploy("wrangler deploy --env production", "d4").refusal, undefined);
  const shipped = hook(root, { op: "after", tool: "Bash", callId: "p1", input: { command: "wrangler deploy --env production" }, isError: false, exitCode: 0, gitOperation: false });
  assert.deepEqual(shipped.entered, ["done"]);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npm run build >/dev/null; node --test test/dev-workflow.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|ENOENT"; cd ../..`
Expected: `ENOENT` on `workflows/dev/guide.geml` (the module fails to load).

- [ ] **Step 3: Write the workflow**

Create `integrations/gemflow/workflows/dev/flow.geml`:

```geml
=== meta
title        = "开发流程"
profile      = "geml-flow/v1"
flow-unit    = "branch"
flow-tools   = "read write run search"
flow-signals = "#signals"
===

%% 一个分支是一个工作项：#build → #review → #deploy → #release → #done。
%% 只有两处封路：部署命令只能在 #deploy / #release 运行（进入 #deploy 要求
%% 已合并且 CI 通过），production 部署只能在 #release 运行（进入 #release
%% 要一个人批准）。其余全部只提醒。match 列与 guide.geml 的内容在安装时按
%% 项目实际情况改写：测试命令、部署命令、约定文档。

=== flow-vars {#vars}
{ "type": "object", "additionalProperties": false, "properties": {
    "goal":             { "type": "string", "description": "这个分支要做成什么，一句话" },
    "tests-pass":       { "type": "boolean", "default": false },
    "pr-open":          { "type": "boolean", "default": false },
    "ci-pass":          { "type": "boolean", "default": false },
    "pr-merged":        { "type": "boolean", "default": false },
    "review-done":      { "type": "boolean", "default": false },
    "deployed-staging": { "type": "boolean", "default": false },
    "deployed-prod":    { "type": "boolean", "default": false } } }
===

=== table {#signals caption="阶段信号"}
| id       | on      | match                            | sets             | when       | only-in          |
|----------|---------|----------------------------------|------------------|------------|------------------|
| tests    | command | npm test                         | tests-pass       | exit-zero  |                  |
| pr       | git     |                                  | pr-open          | pr-open    |                  |
| ci       | git     |                                  | ci-pass          | ci-success |                  |
| merged   | git     |                                  | pr-merged        | pr-merged  |                  |
| reviewed | manual  | review 意见已处理                 | review-done      | checked    |                  |
| staging  | command | wrangler deploy --env staging    | deployed-staging | exit-zero  | #deploy #release |
| prod     | command | wrangler deploy --env production | deployed-prod    | exit-zero  | #release         |
===

=== flow-state {#build initial context="./guide.geml#build"}
写代码和测试。测试命令的结果由信号记录，不需要你报告。
===

=== flow-state {#review context="./guide.geml#review"}
PR 已开。处理 review 意见；CI 的结果由信号记录。
===

=== flow-state {#deploy context="./guide.geml#deploy"}
已合并且 CI 通过。可以部署到 staging。
===

=== flow-state {#release context="./guide.geml#release"}
有人批准了上线。部署到 production。
===

=== flow-state {#done final}
===

=== data {#ready-for-review format=json}
{ "type": "object", "properties": { "tests-pass": { "const": true }, "pr-open": { "const": true } } }
===

=== data {#merged-green format=json}
{ "type": "object", "properties": { "pr-merged": { "const": true }, "ci-pass": { "const": true } } }
===

=== data {#prod-live format=json}
{ "type": "object", "properties": { "deployed-prod": { "const": true } } }
===

=== flow-transition {#to-review from=#build to=#review auto requires=#ready-for-review}
测试通过且 PR 已开。
===

=== flow-transition {#rework from=#review to=#build}
review 要求改动。
===

=== flow-transition {#to-deploy from=#review to=#deploy auto requires=#merged-green}
已合并，CI 通过。
===

=== flow-transition {#to-release from=#deploy to=#release approval}
上线 production 需要一个人此刻同意。
===

=== flow-transition {#ship from=#release to=#done auto requires=#prod-live}
production 已部署。
===
```

Create `integrations/gemflow/workflows/dev/guide.geml`:

```geml
=== meta
title   = "开发流程 · 各阶段说明"
profile = "geml-flow/v1"
===

# 构建 {#build}

在这个分支上写代码和测试。测试命令（信号表 `tests` 行的 `match`）每跑一次，
结果都会被记下：退出码为 0 时 `tests-pass` 为真，否则为假。不需要报告测试结果。

开 PR 之后，测试通过且 PR 已开时流程自动进入 #review。

# 评审 {#review}

PR 已开。逐条处理 review 意见；要大改时可以回到 #build。CI 的结论和合并状态由
git 信号读出（需要 `gh` 已登录）。处理完 review 意见后，请人在看板上勾选
"review 意见已处理"——这一项只能由人勾选。

合并且 CI 通过后流程自动进入 #deploy。

# 部署 {#deploy}

已合并且 CI 通过。可以部署到 staging（信号表 `staging` 行的命令）。staging
部署命令只能在 #deploy 与 #release 运行；production 部署命令在这里会被拒绝。

上线 production 前需要一个人在看板上批准，流程才进入 #release。

# 上线 {#release}

有人批准了上线。按项目的发布顺序部署到 production（信号表 `prod` 行的命令）。
部署成功后流程自动进入 #done。
```

- [ ] **Step 4: The usage row names it, and the CLI test lists it**

In `integrations/gemflow/src/cli.ts`, in the `init` row of `USAGE`, change `--template coding|refund` to `--template coding|dev|refund` (keep the row's alignment).

`init` names every bundled workflow when it refuses an unknown template, so in `integrations/gemflow/test/cli.test.mjs` change

```js
  assert.match(bad.err, /unknown template "nonsense"; expected coding or refund/);
```

to

```js
  assert.match(bad.err, /unknown template "nonsense"; expected coding or dev or refund/);
```

- [ ] **Step 5: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; node dist/cli.js check workflows/dev/flow.geml; cd ../..`
Expected: `exit=0`, `ℹ fail 0`; the check prints `ok: no diagnostics`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/workflows/dev/flow.geml integrations/gemflow/workflows/dev/guide.geml integrations/gemflow/src/cli.ts integrations/gemflow/test/dev-workflow.test.mjs integrations/gemflow/test/cli.test.mjs
git commit -m "feat(gemflow): the built-in dev workflow

#build → #review → #deploy → #release → #done on a branch unit, the signals
table of spec §4.1, and two blocking points: deploy commands run only in
#deploy and #release, production only in #release, which a person enters
over an approval edge. Each stage's context lives in the workflow's own
guide.geml. Tested end to end through the bundled bridge."
```

---

### Task 12: `gemflow mcp` and the skill for MCP-only hosts

**Files:** Create `integrations/gemflow/src/mcp.ts`, `integrations/gemflow/skills/gemflow/SKILL.md`, `integrations/gemflow/test/mcp.test.mjs`; modify `integrations/gemflow/src/cli.ts`.

- [ ] **Step 1: Failing test**

Create `integrations/gemflow/test/mcp.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUNDLE, gitRepo, withWorkflow } from "./helpers/repo.mjs";

const WS_DEV = fileURLToPath(new URL("./fixtures/ws-dev/", import.meta.url));

function mcp(root, messages, args = []) {
  const r = spawnSync(process.execPath, [BUNDLE, "mcp", ...args], {
    cwd: root, input: `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return new Map(r.stdout.trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l)).map((m) => [m.id, m]));
}

test("gemflow mcp: the handshake, the five tools, verbs over the project's workspace, errors by code", () => {
  const root = gitRepo();
  withWorkflow(root, WS_DEV, "dev");
  const out = mcp(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "flow_status", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "flow_set", arguments: { reviewed: true } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "flow_context", arguments: {} } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "geml_get", arguments: {} } },
    { jsonrpc: "2.0", id: 7, method: "resources/list" },
  ], ["--host", "codex"]);
  assert.equal(out.size, 7, "a notification gets no answer");
  assert.equal(out.get(1).result.serverInfo.name, "gemflow");
  assert.equal(out.get(1).result.protocolVersion, "2025-06-18");
  assert.deepEqual(out.get(2).result.tools.map((t) => t.name), ["flow_status", "flow_context", "flow_transition", "flow_set", "flow_rollback"]);
  assert.match(out.get(3).result.content[0].text, /work item feat\/x · state #build/);
  assert.equal(out.get(4).result.isError, true);
  assert.match(out.get(4).result.content[0].text, /^refused: /);
  assert.match(out.get(5).result.content[0].text, /^\[gemflow\] stage #build/);
  assert.equal(out.get(6).error.code, -32602);
  assert.equal(out.get(7).error.code, -32601);
});

test("gemflow mcp in a project with no workflow says so in the tool result", () => {
  const out = mcp(gitRepo(), [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "flow_status", arguments: {} } }]);
  assert.equal(out.get(1).result.isError, true);
  assert.match(out.get(1).result.content[0].text, /no workflow here/);
});

test("the skill tells MCP-only hosts to read the stage every turn and leaves a person's verbs alone", () => {
  const skill = readFileSync(new URL("../skills/gemflow/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^---\nname: gemflow\n/);
  for (const needle of [".geml/context.geml", "flow_context", "flow_status", "gemflow advance", "@geml/gemflow mcp"]) assert.ok(skill.includes(needle), needle);
});
```

- [ ] **Step 2: Watch it fail**

Run: `cd integrations/gemflow && npm run build >/dev/null; node --test test/mcp.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"; cd ../..`
Expected: `ℹ fail 3`.

- [ ] **Step 3: The server**

Create `integrations/gemflow/src/mcp.ts`:

```ts
// `gemflow mcp`: the five model verbs (spec §8.5) over stdio MCP, for hosts
// with no Gemflow shell of their own (Codex, Grok, Gemini CLI, …). JSON-RPC
// 2.0, one message per line: initialize, ping, tools/list, tools/call. Each
// call opens the workspace fresh, so the server shares a project with the CLI
// and any other host. A verb that changes the stage appends the new #current
// text to its result: these hosts have no other channel for it.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { HOST_CAPABILITIES, NO_CAPABILITIES } from "./core/capabilities.js";
import { FLOW_TOOLS } from "./core/verb-specs.js";
import { runVerb } from "./verbs.js";
import { openWorkspace } from "./workspace.js";

/** The package's version, read when a client asks: the bundle starts without a package.json beside it (the bundle test copies it alone). */
function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}
const PROTOCOLS: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

export interface McpOptions { root: string; host: string }
type Reply = Record<string, unknown>;

const result = (id: unknown, value: unknown): Reply => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: unknown, code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (id: unknown, body: string, isError: boolean): Reply => result(id, { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) });

/** One parsed message in; the reply, or undefined for a notification. */
export async function answer(msg: unknown, o: McpOptions): Promise<Reply | undefined> {
  const m = msg as { id?: unknown; method?: unknown; params?: Record<string, unknown> } | null;
  const id = m?.id ?? null;
  const method = m?.method;
  if (typeof method !== "string") return failure(id, -32600, "invalid request: `method` is required");
  if (method.startsWith("notifications/")) return undefined;
  if (method === "initialize") {
    const asked = m?.params?.["protocolVersion"];
    const version = typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[PROTOCOLS.length - 1];
    return result(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "gemflow", version: packageVersion() } });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: FLOW_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method !== "tools/call") return failure(id, -32601, `method not found: ${method}`);
  const name = m?.params?.["name"];
  const spec = FLOW_TOOLS.find((t) => t.name === name);
  if (spec === undefined) return failure(id, -32602, `unknown tool: ${String(name)}`);
  const raw = m?.params?.["arguments"];
  const args = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  try {
    const capabilities = Object.hasOwn(HOST_CAPABILITIES, o.host) ? HOST_CAPABILITIES[o.host]! : NO_CAPABILITIES;
    const opened = openWorkspace({ root: o.root, host: o.host, capabilities });
    if (!opened.ok) return text(id, `gemflow: ${opened.reason}`, true);
    const a = await runVerb(opened.ws, spec.name, args);
    return text(id, a.context !== undefined ? `${a.text}\n\n${a.context}` : a.text, !a.ok);
  } catch (e) {
    // A journal that cannot be read, a lock held past its timeout, a verb that kept conflicting: one line, never a crash.
    const message = e instanceof Error ? e.message : String(e);
    return text(id, message.startsWith("gemflow:") ? message : `gemflow: ${message}`, true);
  }
}

/** Serve stdin to stdout, one message at a time and in order; resolves when stdin closes and every answer is out. */
export function serveMcp(o: McpOptions): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    chain = chain.then(async () => {
      const t = line.trim();
      if (t === "") return;
      let msg: unknown;
      try {
        msg = JSON.parse(t);
      } catch {
        process.stdout.write(`${JSON.stringify(failure(null, -32700, "parse error"))}\n`);
        return;
      }
      const reply = await answer(msg, o);
      if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  });
  return new Promise((resolveDone) => {
    rl.on("close", () => {
      void chain.then(() => resolveDone());
    });
  });
}
```

- [ ] **Step 4: The `mcp` verb**

In `integrations/gemflow/src/cli.ts`:

1. Add `import { serveMcp } from "./mcp.js";`.
2. Add this row to `USAGE`, after the `hook` row:

```ts
  "  mcp [--host h] [--root dir]             the five flow_* tools over stdio MCP (host default: mcp)",
```

3. In the dispatcher Task 4 wrote, add a branch before the final `else`:

```ts
else if (argv[0] === "mcp") void serveMcp({ root: resolve(flag(argv, "--root") ?? "."), host: flag(argv, "--host") ?? "mcp" });
```

- [ ] **Step 5: The skill**

Create `integrations/gemflow/skills/gemflow/SKILL.md`:

````markdown
---
name: gemflow
description: >-
  Work inside a project's Gemflow workflow through the gemflow MCP server
  (tools flow_status, flow_context, flow_transition, flow_set, flow_rollback).
  Use when those tools are connected or the project has .geml/gemflow.geml:
  read the current stage before acting, let signals record test, PR, CI and
  deploy results, and move the workflow only along its edges.
---

# Gemflow over MCP

A project's workflow lives in `.geml/workflows/<name>/flow.geml`. The stage it
is in, and what that stage asks of you, is in `.geml/context.geml` — the
`flow-context` block `#current`.

**Every turn, before anything else, read `.geml/context.geml#current`** — with
`geml get .geml/context.geml '#current'`, or by calling `flow_context`. Your
host has no channel that hands it to you. (In Claude Code the Gemflow plugin
delivers it itself; there you need not read it.)

- `flow_status` says where the workflow stands: the work item (usually the branch), the state, each signal's value, and the next states with whether their guards hold.
- Signals record facts: a test command's exit status, an open or merged PR, CI's result, a deploy command's exit status. Run the command; do not report its result, and do not try to write those variables with `flow_set` — they are not yours.
- `flow_transition` moves along an edge whose guard holds. An edge that needs approval is a person's: ask them to approve it on the Gemflow board or with `gemflow advance <state>` in their own terminal.
- `gemflow mark`, `gemflow unmark` and `gemflow advance` are a person's commands; running them yourself is refused.
- A command the workflow confines to some states (`only-in`) is refused in the others; the refusal says where it may run.
- `flow_rollback` restores recorded state only, never what a command already did.

Registering the server (stdio), in the host's MCP configuration:

```text
command: npx
args:    -y @geml/gemflow mcp --host <host>
```
````

- [ ] **Step 6: Run the suite once**

Run: `cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; cd ../..`
Expected: `exit=0`, `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add integrations/gemflow/src/mcp.ts integrations/gemflow/src/cli.ts integrations/gemflow/skills/gemflow/SKILL.md integrations/gemflow/test/mcp.test.mjs
git commit -m "feat(gemflow): gemflow mcp serves the five verbs over stdio, and a skill for MCP-only hosts

initialize, ping, tools/list and tools/call, written by hand; each call
opens the project's workspace afresh as the named host, and a throw is an
error result. A verb that changes the stage appends the new #current text.
The skill tells hosts with no Gemflow shell to read .geml/context.geml#current
every turn."
```

---

### Task 13: The hooks, driven in real event order under `claude plugin test`

**Files:** Create `integrations/gemflow/tests/hooks.test.ts`.

- [ ] **Step 1: Write the tests**

Create `integrations/gemflow/tests/hooks.test.ts`:

```ts
// The hooks module under the engine's own test host. A scripted bridge
// answers `process.run`; nothing here touches a disk or starts a process.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const ROOT = '/work/app'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const PANE = { title: 'Gemflow', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const COMPOSER = { kind: 'composer' as const }
const PRESENTATION = { isFullscreen: true, columns: 160 }
const NEXT: Record<string, unknown[]> = {
  build: [{ id: 'to-review', to: 'review', auto: true, approval: false, requires: 'ready', holds: false }],
  review: [{ id: 'ship', to: 'done', auto: false, approval: false, holds: true }],
  done: [],
}

type Req = { op: string; [key: string]: unknown }

/** A project as the bridge would report it, and the bridge itself, scripted. */
function world(on: On) {
  const w = {
    sent: [] as Req[],
    registered: [] as string[],
    state: 'build',
    rev: 0,
    vars: { 'tests-pass': false, 'pr-open': true } as Record<string, boolean>,
    strict: false,
    node: true,
    bridge: true,
  }
  const stage = () => `[gemflow] stage #${w.state} · rev ${w.rev}`
  const shell = () => ({
    status: {
      workflow: { name: 'dev', path: '.geml/workflows/dev/flow.geml', title: '开发流程' },
      item: { kind: 'item', id: 'feat/x' },
      state: { id: w.state, strict: w.strict, rev: w.rev },
      vars: w.vars,
      signals: [
        { id: 'tests', on: 'command', sets: 'tests-pass', label: 'npm test', value: w.vars['tests-pass'] === true },
        { id: 'pr', on: 'git', sets: 'pr-open', label: '', value: w.vars['pr-open'] === true },
        { id: 'reviewed', on: 'manual', sets: 'review-done', label: 'review 意见已处理', value: false },
      ],
      next: NEXT[w.state] ?? [],
      refusals: 0, deviations: 0, gh: { available: true },
    },
    policy: {
      active: true, unit: { kind: 'branch' }, state: w.state, strict: w.strict, rollbackOnError: false,
      tools: w.strict ? ['Read'] : ['Read', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'Grep', 'Glob'],
      commands: [{ id: 'tests', anywhere: 'npm test', start: '^(?:npm test)', onlyIn: [] }], files: [], deviated: [], relevant: ['tests', 'pr'],
    },
    contextKey: `feat/x@${w.rev}`,
  })
  const board = () => ({
    states: [
      { id: 'build', initial: true, final: false, strict: false },
      { id: 'review', initial: false, final: false, strict: false },
      { id: 'done', initial: false, final: true, strict: false },
    ],
    transitions: [
      { id: 'to-review', from: 'build', to: 'review', auto: true, approval: false, requires: 'ready' },
      { id: 'ship', from: 'review', to: 'done', auto: false, approval: false },
    ],
    onlyIn: [], backlog: null, items: [{ id: 'feat/x', state: w.state, rev: w.rev }], timeline: [],
  })
  const answer = (req: Req) => {
    w.sent.push(req)
    if (req.op === 'after' && req.exitCode === 0 && w.state === 'build') {
      w.vars['tests-pass'] = true
      w.state = 'review'
      w.rev = 3
      return { v: 1, ok: true, shell: shell(), entered: ['review'], context: stage() }
    }
    if (req.op === 'before' && w.strict && req.tool !== 'Read') {
      return { v: 1, ok: true, shell: shell(), refusal: `tool ${String(req.tool)} is not available in state #${w.state}`, recorded: true }
    }
    if (req.op === 'advance') {
      w.state = String(req.to)
      w.rev += 1
      return { v: 1, ok: true, shell: shell(), entered: [w.state] }
    }
    if (req.op === 'verb') return { v: 1, ok: true, shell: shell(), text: `[gemflow] work item feat/x · state #${w.state}` }
    if (req.op === 'board') return { v: 1, ok: true, shell: shell(), board: board() }
    return { v: 1, ok: true, shell: shell(), ...(req.op === 'before' ? { recorded: false } : {}) }
  }
  const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  on('process.run', ($, e) => {
    if (e.argv[1] === '--version') return w.node ? { value: ran('v24.1.0\n') } : { deny: 'spawn node ENOENT' }
    if (e.argv[0] === '/bin/sh') return { value: ran('', 1) }
    if (e.argv[2] === 'hook') {
      return w.bridge ? { value: ran(`${JSON.stringify(answer(JSON.parse(e.init?.stdin ?? '{}') as Req))}\n`) } : { deny: 'timed out after 15000 ms' }
    }
    return { deny: `unexpected ${e.argv.join(' ')}` }
  })
  on('fs.read', ($, e) => (e.path === `${ROOT}/.geml/context.geml`
    ? { value: `=== meta\nprofile = "geml-flow/v1"\n===\n\n==== flow-context {#current state=#${w.state} rev=${w.rev} at="t" item="feat/x"}\n${stage()}\n====\n` }
    : { deny: 'ENOENT' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => {
    w.registered.push(e.name)
    return { value: { tool: `mcp__gemflow__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  return w
}

async function start($: Engine, on: On): Promise<void> {
  const clock = mock.clock(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
}

test('real event order: session start, a test run moves the stage, the board moves it again, the next prompt hears of it', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }
  })
  await start($, on)
  expect(w.sent.map((r) => r.op)).toEqual(['status', 'refresh'])
  expect(w.sent[0]).toMatchObject({ v: 1, root: ROOT })
  expect(w.registered).toEqual(['flow_status', 'flow_context', 'flow_transition', 'flow_set', 'flow_rollback'])

  const tests = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', tool: 'Bash', callId: 'b1', exitCode: 0, isError: false, gitOperation: false, input: { command: 'npm test' } })
  expect(tests.context).toEqual(['[gemflow] stage #review · rev 3'])

  await $.prompt.submit({ text: 'go on', wait: false, origin: COMPOSER })
  expect(seen).toBeUndefined()

  const opened = await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  expect(opened.text).toBe('已打开 Gemflow 看板。')
  const pane = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'Pane', requestId: 'gemflow-board', props: PANE })
  await pane.press({ key: 'advance-done' })
  expect(w.sent.filter((r) => r.op === 'advance').at(-1)).toMatchObject({ to: 'done' })

  await $.prompt.submit({ text: 'and now?', wait: false, origin: COMPOSER })
  expect(seen).toEqual(['[gemflow] stage #done · rev 4'])
})

test('a failing test run reports its exit code; a command no signal reads costs no spawn', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, ($, e) => (e.command === 'npm test'
    ? { isError: true, result: 'Exit code 1', text: 'Exit code 1\n1 failing' }
    : { result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  await start($, on)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })
  expect(w.sent.at(-1)).toMatchObject({ op: 'after', exitCode: 1, isError: true })
  const n = w.sent.length
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'ls -la' })
  expect(w.sent.length).toBe(n)
})

test('a strict state refuses through the bridge; a broken bridge lets the call through and the band says why', async ($, on) => {
  const w = world(on)
  w.strict = true
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: `${ROOT}/a.ts` }, text: 'edited' }))
  await start($, on)
  const refused = await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })
  expect(refused.deny ?? refused.text ?? '').toMatch(/not available in state #build/)
  expect(w.sent.at(-1)).toMatchObject({ op: 'before', tool: 'Edit', input: { file_path: `${ROOT}/a.ts` } })
  w.bridge = false
  const passed = await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })
  expect(passed.text).toBe('edited')
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /桥接没有应答/ })).toBeDefined()
})

test('the five model tools are served by the bridge', async ($, on) => {
  const w = world(on)
  await start($, on)
  const r = await $.tool.call({ tool: 'mcp__gemflow__flow_status', tool_use_id: 'v1' })
  expect(r.result).toBe('[gemflow] work item feat/x · state #build')
  expect(w.sent.at(-1)).toMatchObject({ op: 'verb', name: 'flow_status', callId: 'v1' })
  expect(w.sent.at(-1)?.args).toEqual({})
})

test('the band and /gemflow, on terminal and desktop', async ($, on) => {
  world(on)
  await start($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'gemflow', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: '⧗ feat/x' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'tests ✗' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '→ #review 自动 · 待 #ready' })).toBeDefined()
    await band.unmount()
  }
  const out = await $.command.run({ command: 'gemflow', args: '', origin: COMPOSER, presentation: PRESENTATION })
  expect(out.text).toContain('工作项 feat/x · 阶段 #build')
})

test('no Node: the band says so, tool calls pass untouched, and nothing is sent', async ($, on) => {
  const w = world(on)
  w.node = false
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'ran' }))
  await start($, on)
  expect((await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })).text).toBe('ran')
  expect(w.sent).toEqual([])
  const band = await $.ui.mount({ plugin: 'gemflow', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /找不到 node/ })).toBeDefined()
})

test('the board draws its three tabs on every surface', async ($, on) => {
  world(on)
  await start($, on)
  await $.command.run({ command: 'gemflow', args: 'board', origin: COMPOSER, presentation: PRESENTATION })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const pane = await $.ui.mount({ plugin: 'gemflow', surface, component: 'Pane', requestId: 'gemflow-board', props: PANE })
    for (const key of ['tab-flow', 'tab-items', 'tab-journal', 'refresh', 'advance-review']) {
      expect(await pane.find({ type: 'Button', key })).toBeDefined()
    }
    await pane.press({ key: 'tab-journal' })
    expect(await pane.find({ type: 'Text', text: /还没有记录/ })).toBeDefined()
    await pane.press({ key: 'tab-flow' })
    await pane.unmount()
  }
})
```

- [ ] **Step 2: Run them**

Run: `cd integrations/gemflow && npm run test:claude > /tmp/gemflow-b-claude.log 2>&1; echo "exit=$?"; tail -4 /tmp/gemflow-b-claude.log; cd ../..`
Expected: `exit=0`, ending ` 7 pass`, ` 0 fail`, `Ran 7 tests across 1 file.`

Every engine answer a test needs (`process.run`, `fs.read`, a tool's own result, `prompt.submit` beneath the plugins) is registered with `on(…)` before the test's first `$` call: the kit refuses an `on` made after it. If a test fails because the kit's `$.tool.call` resolves a plugin's deny in another shape, or a mounted drawing has no `unmount`, adapt that assertion to the declaration in `.claude-plugin/types/claude-code/index.d.ts` (the engine lays it beside the plugin when it is loaded with `--plugin-dir`) and keep what the test checks.

- [ ] **Step 3: Commit**

```bash
git add integrations/gemflow/tests/hooks.test.ts
git commit -m "test(gemflow): the hooks module in real event order under claude plugin test

Session start, a test run that sets its signal and fires the auto edge, the
new stage in that result, a board move, and the next prompt carrying the
stage; a failing run's exit code; a strict refusal; a broken bridge and a
missing Node failing open; the five tools; the band and the board on each
surface. A scripted bridge answers process.run. Run with npm run test:claude."
```

---

### Task 14: README, the marketplace entry, and the spec's §8

**Files:** Modify `integrations/gemflow/README.md`, `integrations/gemflow/README.zh.md`, `.claude-plugin/marketplace.json`, `docs/design/specs/2026-10-11-gemflow-design.md`.

- [ ] **Step 1: The marketplace entry**

In `.claude-plugin/marketplace.json`, append to `plugins`:

```json
    {
      "name": "gemflow",
      "source": { "source": "npm", "package": "@geml/gemflow" },
      "description": "Workflow stages for Claude Code: a line above the prompt, a board, /gemflow and five flow_* tools over a GEML statechart; signals record test, PR, CI and deploy results; blocks only where the workflow says so.",
      "strict": true
    }
```

- [ ] **Step 2: README (English)**

In `integrations/gemflow/README.md`:

1. Under `## Install`, before `### DeepSeek Harness`, insert:

````markdown
### Claude Code

```text
/plugin install gemflow --marketplace geml-spec/geml
```

Type it at the prompt of a terminal session; `y` adds the marketplace, then pick a scope. The entry installs the published `@geml/gemflow` package, so it works once that is on npm.

What you get: a line above the prompt — `⧗ feat/rate-limit · review · ci ✓ · merged ✗ · → #deploy 自动 · 待 #merged-green` — with a yellow segment when a call went outside the stage's tools; `/gemflow` (where the work stands), `/gemflow board` (the board: 流程 / 工作项 / 记录, where a person moves the workflow, ticks manual signals and binds to-dos), `/gemflow use <workflow>`, `/gemflow add [workflow]`; and five tools the model calls, `flow_status`, `flow_context`, `flow_transition`, `flow_set`, `flow_rollback` (listed as `mcp__gemflow__flow_*`). When a call moves the stage, the new stage's context reaches the model with that call's result; a change between prompts (a person moved it, or session start caught up git) rides on the next prompt.

Start a repository with `/gemflow add dev` (or `npx -y @geml/gemflow init --template dev`) and set the signals table's `match` column to your test and deploy commands.

**Node ≥ 22 is required.** The hooks module runs inside Claude Code with no Node. Everything that touches the project — journals, `.geml/context.geml`, the backlog — is done by the bundled CLI `dist/gemflow.mjs`, started per request. At session start the plugin looks for `node` on the session's PATH, then asks a login shell (`/bin/sh -lc "command -v node"`).

**It fails open.** When Node is missing, the CLI fails or times out, or its answer does not parse, the tool call goes through, nothing is recorded, and the line above the prompt says what is wrong. Strict refusals and `only-in` blocking therefore hold only while that bridge works.

**What `strict` means here.** Claude Code cannot take a tool away from the model, so a strict state is two things: the stage context names the capabilities the state allows — the signpost the model reads — and every other call is refused before it runs and recorded as `flow-refused`. Outside strict states, a call outside the state's tools runs and is recorded once per tool per stage entry (`flow-deviation`).

Developing the plugin from this repository:

```sh
cd integrations/gemflow && npm install && npm run build
cd ../.. && claude --plugin-dir integrations/gemflow
cd integrations/gemflow && npm run test:claude   # claude plugin validate + claude plugin test
```

### Other hosts (MCP)

`gemflow mcp` serves the same five tools over stdio MCP; register it in the host's MCP configuration as `npx -y @geml/gemflow mcp --host <host>`. The skill `skills/gemflow/SKILL.md` tells the model to read `.geml/context.geml` (`#current`) at the start of every turn, since such a host has no channel that delivers it.
````

2. Wherever the DeepSeek Harness and pi agent paragraphs name the skills under `skills/` as two ("authoring and code-graph"), name three: authoring, code-graph and gemflow.
3. Replace the code block of the `## CLI` section with what `cd integrations/gemflow && node dist/cli.js; true` prints on stderr, exactly.
4. In `## Development`, after the `npm test` line of the code block, add `npm run test:claude   # the hooks module under claude plugin test (needs the claude CLI)`, and add to the prose: "`npm run build` runs `tsc` and then bundles the CLI into `dist/gemflow.mjs`, the one file the Claude Code plugin starts. `hooks/register.tsx` runs with no Node: it imports only Node-free modules from `dist/hosts/claude-code/` and `dist/core/`, and `test/hooks-purity.test.mjs` walks that closure."

- [ ] **Step 3: README (中文)**

In `integrations/gemflow/README.zh.md`:

1. Under `## 安装`, before `### DeepSeek Harness`, insert:

````markdown
### Claude Code

```text
/plugin install gemflow --marketplace geml-spec/geml
```

在终端会话的输入框里输入这一行；按 `y` 添加 marketplace，再选范围。这个条目安装的是已发布的 `@geml/gemflow` 包，包发布到 npm 之后才能装。

装上之后：输入框上方常驻一行——`⧗ feat/rate-limit · review · ci ✓ · merged ✗ · → #deploy 自动 · 待 #merged-green`——调用超出本阶段工具时追加一段黄色提醒；`/gemflow`（当前状态）、`/gemflow board`（看板：流程 / 工作项 / 记录，人在这里推进流程、勾手动信号、绑定待办项）、`/gemflow use <流程>`、`/gemflow add [流程]`；以及模型可调的五个工具 `flow_status`、`flow_context`、`flow_transition`、`flow_set`、`flow_rollback`（列为 `mcp__gemflow__flow_*`）。一次调用让阶段变了，新阶段的上下文随这次调用的结果交给模型；两次提交之间变了（人推进了、会话开始时补齐了 git 信号），随下一次提交交给模型。

在仓库里开始用：`/gemflow add dev`（或 `npx -y @geml/gemflow init --template dev`），再把信号表的 `match` 列改成项目的测试与部署命令。

**需要 Node ≥ 22。** hooks 模块在 Claude Code 里运行，没有 Node；凡是碰项目文件的事——journal、`.geml/context.geml`、backlog——都由打包好的 CLI `dist/gemflow.mjs` 做，每个请求起一次。会话开始时插件先在会话的 PATH 上找 `node`，找不到再问登录 shell（`/bin/sh -lc "command -v node"`）。

**失败放行。** 找不到 Node、CLI 失败或超时、应答无法解析时，工具调用照常执行、什么都不记，输入框上方那一行显示原因。所以 strict 拒绝与 `only-in` 封路只在这座桥正常时生效。

**这里的 `strict` 是什么。** Claude Code 不能把工具从模型的工具表里拿掉，所以 strict 状态由两件事组成：阶段上下文写明本状态允许的能力（模型看得见的告示牌），其余调用在执行前被拒绝并记为 `flow-refused`。非 strict 状态里，超出本状态工具的调用照常执行，每个工具每次进入阶段记一次 `flow-deviation`。

在本仓库里开发这个插件：

```sh
cd integrations/gemflow && npm install && npm run build
cd ../.. && claude --plugin-dir integrations/gemflow
cd integrations/gemflow && npm run test:claude   # claude plugin validate + claude plugin test
```

### 其他宿主（MCP）

`gemflow mcp` 用 stdio MCP 提供同样的五个工具；在宿主的 MCP 配置里登记为 `npx -y @geml/gemflow mcp --host <宿主>`。skill `skills/gemflow/SKILL.md` 要求模型每轮先读 `.geml/context.geml`（`#current`）——这类宿主没有把它交给模型的通道。
````

2. Wherever the DeepSeek Harness and pi agent paragraphs name the skills under `skills/` as two（写作与代码图谱）, name three：写作、代码图谱与 gemflow。
3. Replace the code block of the `## CLI` section with the same `node dist/cli.js` output as the English README.
4. In `## 开发`, add the `npm run test:claude` line and this paragraph: "`npm run build` 先跑 `tsc`，再把 CLI 打成 `dist/gemflow.mjs`——Claude Code 插件启动的就是这一个文件。`hooks/register.tsx` 在没有 Node 的环境里运行：它只 import `dist/hosts/claude-code/` 与 `dist/core/` 下不依赖 Node 的模块，`test/hooks-purity.test.mjs` 沿着这条 import 链逐个检查。"

- [ ] **Step 4: The spec**

In `docs/design/specs/2026-10-11-gemflow-design.md`:

1. §3, paragraph **包与目录**: replace `插件发布在仓库根的 geml marketplace：\`claude plugin install gemflow@geml\`。` with:

   `插件根目录就是 \`integrations/gemflow/\`，发布在仓库根的 geml marketplace，条目以 npm 包 \`@geml/gemflow\` 为来源，安装一行：\`/plugin install gemflow --marketplace geml-spec/geml\`。hooks 模块要用的 Node 一侧打成单文件 \`dist/gemflow.mjs\`（\`@geml/geml\` 内联），装上不需要再装依赖。`

2. §8.1, after the bullet `- 子项目 ⑤ 完成后追加 \`⛁ 少读 182k\`。`, add:

   ```
   - 文字由纯函数从最近一次桥接应答里的状态算出（中日韩字符按两格计宽），hooks 模块只用各界面都有的 `Box`、`Text` 排版；终端与桌面显示同样的文字。
   - 桥接失败（找不到 Node ≥ 22、子进程失败或超时、应答无法解析）时只显示一行原因；项目里没有流程时不显示。
   ```

3. §8.2, after the table, add:

   ```
   各界面都没有现成的标签元素，三个标签页是一排按钮。看板上的操作都经桥接执行：点转换是人推进（`by=human`，`approval` 由这次点击满足），勾选手动信号，把一个待办项绑定到当前工作项（写进 backlog 的 `branch` 或 `file` 列，持 backlog 的文件锁）。看板只在用户用 `/gemflow board` 打开时出现。
   ```

4. §8.3: replace `\`/gemflow add\`（+ 菜单，v1 只有"复制内置流程"一项，市场见 ③）` with `\`/gemflow add [流程]\`（+ 菜单：不带参数列出内置流程，带名字时把它复制进 \`.geml/workflows/\`；项目还没有流程时同时设为当前流程，否则提示 \`/gemflow use <流程>\`；市场见 ③）`.

5. §8.4: insert before the table:

   ```
   hooks 模块运行在没有 Node、没有 DOM 的环境里，`$.fs` 不能追加、改名或加锁，所以它从不写项目里的文件：journal、上下文文档与 backlog 只由 Node 一侧的 CLI 写。两侧之间是一座桥：`node <插件目录>/dist/gemflow.mjs hook`，stdin 一个 JSON 请求，stdout 一行 JSON 应答（op：status、refresh、before、after、verb、mark、advance、bind、use、add、board）；CLI 用 `host: "claude"` 与 Claude Code 的能力映射打开工作区执行。请求只带调用的命令与路径，不带文件内容。

   - **快路径**：每个应答都带一份状态与策略快照（读一遍 journal 得出）——当前状态、是否 strict、`rollback-on-error`、本状态允许的工具名、命令信号的正则及其 `only-in`、文件信号的 glob、本次进入阶段后已记过偏离的工具。调用前由纯函数判断：放行（不起子进程），或请 CLI 的 `before` 定夺并记录。读命令行用的是监督器自己的扫描函数（`src/core/command-line.ts`，不 import 任何东西）：人专属命令、`only-in`（连同去掉引号后的那一份）、命令信号拆出的简单命令，快路径与 CLI 判断得完全一样。调用后只在这几种情况起 `after`：命令信号的正则匹配了带退出码的 Bash 命令；`write` 能力的调用写了匹配文件信号 glob（或 `file:` 单位 glob）的路径；Bash 结果带 `gitOperation`；`rollback-on-error` 状态里调用出错；`before` 刚记过一条。
   - **git 信号**在会话开始、看板打开与刷新、带 `gitOperation` 的调用之后重读；`git status` 之类的命令不触发查询。只有这几处现查 `gh`，其余请求沿用上一次应答报告的可用性。
   - **上下文**：应答报告阶段变化（这次操作进入了新状态，工作区的结果带着新阶段的文字）时，新的 `#current` 放进这次工具结果的 `context`，应答里上下文文档的 `item@rev` 记为已交给模型；`prompt.submit` 读 `.geml/context.geml`，`item@rev` 与已交的不同、且 `item` 是当前工作项时放进 `context`；`session.end`（含 `/clear`）清掉这个记号。工作区的每次操作（含打开）都会让上下文文档对上当前工作项：别的工作项留下的文档（切换了分支）在下一次桥接请求时重写，这次应答不带新阶段文字，由下一次 `prompt.submit` 按记号不同交给模型。
   - **失败放行**：Node 缺失、桥接失败或超时、应答无法解析时，调用照常执行、什么都不记，状态带显示原因；strict 拒绝与 `only-in` 只在桥接正常时生效。CLI 每个请求都重新打开工作区（打开时读 git 的事实），从不把异常抛给 hooks 模块：打不开工作区是一个问题（项目里没有流程时不显示），读不了 journal、锁一直被占、动词反复冲突是错误应答，状态带显示原因。
   ```

   and replace the table's rows for `session.start`, `tool.call`, `prompt.submit` and `command.run` with:

   ```
   | `session.start` | 找 Node（先 `node --version`，主版本 ≥ 22；不行再 `/bin/sh -lc "command -v node"` 取绝对路径）；注册 `/gemflow` 与五个模型工具；经桥接取一次状态；随后在会话开始之外刷新 `git`、`file` 信号 |
   | `session.end` | 清掉"已交给模型的上下文"记号：`/clear` 之后的下一次提交重新带上 `#current` |
   | `tool.call` | 调用前：快路径放行，或请 CLI 的 `before` 定夺（strict、`only-in`、人专属命令、偏离记录）；调用后：按快路径只在需要时请 `after` 求值 `command`、`file`、`git` 信号（退出码判定见 §5.2）；若这次调用触发了状态变化，把新的 `#current` 放进这次结果的 `context`，模型在同一轮就读到新阶段的说明 |
   | `prompt.submit` | `.geml/context.geml` 的 `item@rev` 与已交给模型的不同（人在看板上推进、会话开始时 git 信号补齐），且 `item` 是当前工作项时，把 `#current` 放进 `context` |
   | `command.run` | `/gemflow` 各子命令；`/gemflow board` 调 `$.ui.open({ id: "gemflow-board", title: "Gemflow" })` |
   ```

6. §8.5: replace the paragraph with:

   ```
   五个工具 `flow_status`、`flow_context`、`flow_transition`、`flow_set`、`flow_rollback`，参数结构固定，不随状态变（免得 prompt 缓存失效），`flow_status` 说明当前状态能去哪里。这五个名字（裸名，或 Claude Code 列出的 `mcp__gemflow__<名字>`）是 gemflow 自己的工具：从不拒绝、不记偏离、出错也不回滚。Claude Code 里由 hooks 模块在会话开始时用 `$.tool.register` 注册（列为 `mcp__gemflow__flow_*`），插件清单不声明 MCP 服务，以免同名工具出现两份；模型对 `approval` 边调用 `flow_transition` 会被拒绝，并提示由人在看板上批准。其他宿主用 `gemflow mcp [--host <宿主>]`（stdio MCP），宿主没有能力映射时按"没有工具属于任何能力"处理；改变了阶段的调用把新的 `#current` 附在结果后面。skill `skills/gemflow/SKILL.md` 要求只有 MCP 的宿主每轮先读 `.geml/context.geml#current`。手动信号不暴露为工具。Codex、Grok、Gemini CLI、DeepSeek Harness 装上即有完整的推进与记录功能，只是没有状态带和看板。
   ```

7. §9: replace `- Claude Code 适配器测一个替身：按真实事件顺序驱动 hooks 模块（与 pi agent 替身同一做法）。` with:

   ```
   - Claude Code 外壳：快路径、结果读取、状态带、看板与 `/gemflow` 的文字都是纯函数，用 node:test 测（含中日韩字符宽度）；桥接经打包后的 `dist/gemflow.mjs` 在临时 git 仓库里逐个 op 测；hooks 模块用 `claude plugin test` 按真实事件顺序驱动（会话开始 → Bash 测试命令写信号 → auto 边推进 → 结果里带上新阶段 → 看板推进后的下一次提交带上新阶段），桥接由测试脚本应答；`npm run test:claude` 运行，需要 `claude` CLI。另有一个测试沿 hooks 模块的 import 链检查，不允许任何需要 Node 的东西进来。
   ```

8. §12, table 已查明: add rows after the Codex row:

   ```
   | hooks 模块的运行环境（2026-10-12） | 没有 Node 与 DOM；可以用相对路径 import 插件里的 `.js`；`$.process.run` 按参数向量起本机进程，起不来或超时即 reject；`$.fs` 只能整份读写，不能追加、改名、加锁 | §8.4 |
   | 插件测试（2026-10-12，`claude plugin test`） | 运行插件目录下的 `*.test.ts(x)`，不进 `node_modules`；引擎调用（`process.run`、`fs.read`、`ui.open` 等）由测试自己的 hook 应答；`claude plugin validate` 拒绝找不到文件的相对 import | §9 |
   ```

- [ ] **Step 5: Check and run**

Run:
```bash
for f in integrations/gemflow/README.md integrations/gemflow/README.zh.md docs/design/specs/2026-10-11-gemflow-design.md; do node geml-parser/dist/geml.js check --root . "$f" >/dev/null 2>&1; echo "$f $?"; done
claude plugin validate .; echo "marketplace exit=$?"
cd integrations/gemflow && npm test > /tmp/gemflow-b.log 2>&1; echo "exit=$?"; grep -E "^ℹ (pass|fail)" /tmp/gemflow-b.log; cd ../..
```
Expected: three `0`s; `marketplace exit=0` (the root marketplace lists `geml` and `gemflow`); `exit=0`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add integrations/gemflow/README.md integrations/gemflow/README.zh.md .claude-plugin/marketplace.json docs/design/specs/2026-10-11-gemflow-design.md
git commit -m "docs(gemflow): install Gemflow in Claude Code; the spec's §8 states how the shell works

The geml marketplace lists gemflow with the npm package as its source. Both
READMEs give the install line, how to load the plugin from this repository,
that it needs Node 22 and fails open, and what strict means in Claude Code.
The spec records the bridge, the fast path, context delivery, the + menu and
the MCP server, and what was measured about the hooks environment."
```

---

## Done when

- Fourteen commits on the branch, nothing pushed.
- `cd integrations/gemflow && npm test` passes (`ℹ fail 0`); `npm run test:claude` passes (`0 fail`); `claude plugin validate integrations/gemflow` and `claude plugin validate .` both exit 0.
- `node integrations/gemflow/dist/cli.js check integrations/gemflow/workflows/dev/flow.geml` prints `ok: no diagnostics`.
- `dist/gemflow.mjs`, copied alone into an empty directory, runs `check` (the bundle test does this).
- In a scratch git repository on a feature branch, `claude --plugin-dir <repo>/integrations/gemflow`, then `/gemflow add dev`: the line above the prompt begins `⧗ <branch> · build · tests ✗ · pr ✗ · → #review 自动 · 待 #ready-for-review`; `/gemflow board` opens the board on 流程 with `#build` highlighted; running a passing `npm test` flips `tests ✓` on the next draw.
