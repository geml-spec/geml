# Gemflow workflows — a workflow as a GEML document, and its journal

*English | [中文](workflow_CN.md)*

- Status: **draft**: this may still change. Design rationale:
  [`docs/design/specs/2026-10-11-gemflow-design.md`](../docs/design/specs/2026-10-11-gemflow-design.md).
- Nature: **Gemflow's own format, not a GEML profile.** It adds no block type,
  no attribute key and no diagram format to GEML, so it needs no vocabulary:
  a workflow declares [`geml-statechart/v1`](../../../spec/profiles/geml-statechart/geml-statechart-profile.md)
  and nothing else. That format — the body's shape, the three ways to write a
  guard, the `reset` action, the drawing, the `statechart-*` checks — is
  GEML's; what this document adds are the keys that hang Gemflow on that
  statechart's states, variables and transitions, which the format already
  admits as attributes, and one `=== meta` key, `flow-unit`, which is the
  author's metadata as far as GEML is concerned. GEML's parsers know nothing of
  Gemflow. A workflow is an ordinary GEML document: one `diagram`
  block holding the statechart, the prompt documents and guard `data`
  blocks it references, and beside it a tool dictionary that is one `table`.
  The journal and the context document are ordinary `data` and `text` blocks.
  GEML never reads a new syntax in any of them. The runtime that interprets
  them is `@geml/gemflow` (`integrations/gemflow/`): the Claude Code plugin,
  the `gemflow` CLI and its MCP server (`gemflow mcp`), and adapters for
  DeepSeek Harness and pi agent.
- Runtime coverage: the DeepSeek Harness and pi agent adapters keep one journal
  per session (`item` is `session:<id>`), evaluate no signals and write no
  context document. A host that only speaks MCP hands Gemflow none of its tool
  calls, so on it the tool dictionary, the fenced uses and the person-only
  refusals do nothing (§3.11).

## 0. What it is in one paragraph

A workflow is a GEML document that declares `profile = "geml-statechart/v1"`
and holds one `diagram` block of format `geml-statechart`: a state machine whose
states are the stages, whose transitions are the edges between them, and whose
variables are what the guards read. On each state Gemflow hangs what the
model gets there — a `prompt` to load, `skills` to enable, and the `tools` it
may use, named by **use** (`edit`, `test`, `pr`, …); on each variable, where
its value comes from (`source`: a tool call bound to a use, a file, git and
CI, or a person's check — or nothing, and the model writes it); on each
transition, whether a person must say yes at that moment (`approval`). A
guard that is an object over the variables is judged by the
machine and taken on its own as soon as it holds, so the workflow moves on
observed facts, not on what the model says; a guard that is a sentence is
judged by the model; an approval is judged by a person. Which concrete tool a
use means in this project, which of them comes first and what arguments it
takes by default are not written in the workflow: they live in its **tool
dictionary**, `tools.geml`, which grows from the choices a person makes while
working. Each work item — a branch, or one file such as an episode — has a
**journal**: a hash-chained run of `data` blocks recording every revision and
every refusal. Every one of these documents is ordinary GEML: `geml check`
validates them, `geml get journal.geml '#rev-7'` reads one revision, and
`geml --to md` draws the statechart as a Mermaid picture.

## 1. The meta block

```geml
=== meta
title     = "Video workflow"
profile   = "geml-statechart/v1"
flow-unit = "file:episodes/*.geml"
===
```

| key | meaning | value | default |
|---|---|---|---|
| `flow-state-key` | for a file unit, the meta key the item file keeps its work item's state under | a key name | none: the item file is not written |
| `flow-unit` | what one work item is, and so what one journal records | `branch` (one work item per branch) or `file:<glob>` (one per matching file, e.g. `file:episodes/*.geml`; the glob dialect is in §3.6) | `branch` |

`flow-unit` and `flow-state-key` are the `=== meta` keys Gemflow reads in a
workflow, and a workflow writes them only when its unit is `file:<glob>`. GEML leaves a meta key
no declared vocabulary owns to the author, so `geml check` says nothing about
it; `gemflow check` checks its value (§4).

The split is the point: the statechart's structure is GEML's, so any GEML
processor checks it — `geml check flow.geml` reports the `statechart-*` codes
with no Gemflow installed — while what Gemflow's keys mean is Gemflow's,
checked by `gemflow check`, which reports the `statechart-*` codes before its
own (§4).

The journal (§2.4), the context document (§2.5), the tool dictionary (§2.3),
the backlog (§3.12) and the project configuration (§3.1) declare no profile.

## 2. Documents

### 2.1 A whole workflow

The bundled dev workflow, in full:

```geml
=== meta
title   = "Dev workflow"
profile = "geml-statechart/v1"
===

=== diagram {#flow format=geml-statechart caption="Dev workflow"}
{
  "initial": "build",

  "states": {
    "build": {
      "title": "Build",
      "description": "Write the code and its tests, until the tests pass and a pull request is open.",
      "prompt": "./guide.geml#build",
      "skills": ["test-driven-development"],
      "tools": ["edit", "test", "pr"]
    },
    "review": {
      "title": "Review",
      "description": "Address the review comments; wait for CI to go green and the pull request to merge.",
      "prompt": "./guide.geml#review",
      "tools": ["edit", "test"]
    },
    "deploy": {
      "title": "Deploy",
      "description": "Deploy to staging and verify.",
      "tools": ["deploy-staging"]
    },
    "release": {
      "title": "Release",
      "description": "Deploy to production.",
      "tools": ["deploy-prod"]
    },
    "done": { "title": "Done", "final": true }
  },

  "vars": {
    "tests-pass":       { "default": false, "source": { "tool": "test" } },
    "pr-open":          { "default": false, "source": "pr-open" },
    "pr-merged":        { "default": false, "source": "pr-merged" },
    "ci-pass":          { "default": false, "source": "ci-success" },
    "review-ready":     { "default": false, "source": "human", "note": "A person checks it when the tests run only in CI" },
    "deployed-staging": { "default": false, "source": { "tool": "deploy-staging" } },
    "deployed-prod":    { "default": false, "source": { "tool": "deploy-prod" } }
  },

  "transitions": [
    { "from": "build", "to": "review",
      "guard": { "anyOf": [
        { "properties": { "tests-pass": { "const": true }, "pr-open": { "const": true } } },
        { "properties": { "pr-merged": { "const": true } } },
        { "properties": { "review-ready": { "const": true } } } ] } },

    { "from": "review", "to": "build",
      "guard": "the review asks for changes",
      "actions": [ { "reset": ["tests-pass", "review-ready"] } ] },

    { "from": "review", "to": "deploy",
      "guard": { "properties": { "pr-merged": { "const": true }, "ci-pass": { "const": true } } } },

    { "from": "deploy", "to": "release",
      "guard": { "properties": { "deployed-staging": { "const": true } } },
      "approval": true },

    { "from": "release", "to": "done",
      "guard": { "properties": { "deployed-prod": { "const": true } } } }
  ]
}
===
```

The chain is **state → tool → variable → transition → state**: `build`
declares the use `test`, and the dictionary binds it to this project's
`npm test`; that command exits 0, and `tests-pass` becomes true; the guard
of `build→review` reads it, holds, and the edge is taken on its own; the
workflow enters `review`, and the model gets another prompt and another set of
uses. The workflow names uses, never commands, so the same workflow moved to a
Rust project changes not a character: there the dictionary binds `test` to
`cargo test`.

`build` never gets stuck: when the pull request is merged before Gemflow sees
it open, or the tests run only in CI and no test evidence ever appears locally,
the guard's other two branches — merged, or a person checked
`review-ready` — let the workflow on. `./guide.geml` is the prompt document in
the workflow's directory; `prompt` names its sections, and Stagehand expands
the one of the state entered (§3.10).

The starter dictionary beside it, `tools.geml`, binds the workflow's uses to
this project's tools (§2.3):

```geml
=== table {#tools}
| tool                                | for            | allow | deny | default | params |
|-------------------------------------|----------------|-------|------|---------|--------|
| Read                                |                | *     |      |         |        |
| Edit                                | edit           |       |      |         |        |
| Bash(npm test)                      | test           |       |      | yes     |        |
| Bash(gh pr create)                  | pr             |       |      |         |        |
| Bash(wrangler deploy --env staging) | deploy-staging |       |      |         |        |
| Bash(wrangler deploy)               | deploy-prod    |       |      |         |        |
===
```

`Bash(wrangler deploy)` is a prefix of whole words, so it matches a deploy with
`--env production` and one with no `--env` at all, which counts as production,
and not `wrangler deployments list`;
`wrangler deploy --env staging` goes to the key with the longer literal part.
The bundled dictionary (`integrations/gemflow/workflows/dev/tools.geml`)
carries one row more per spelling: `npx`, `pnpm` and `bunx` in front of
`wrangler`, and `pnpm test`, `yarn test`, `cargo test`, `pytest` and `go test`
for `test`.

### 2.2 Constructs

| construct | written as | meaning |
|---|---|---|
| statechart | `diagram {format=geml-statechart}`, its body JSON | the states, the transitions and the variables. The format's rules — the reserved keys, the three ways to write a guard, `reset`, the drawing, `data=` — are in [its own vocabulary](../../../spec/profiles/geml-statechart/geml-statechart-profile.md) |
| state | an entry of `states` | `title` and `description` are for people and for the model alike. Gemflow's keys: `prompt`, the prompt: a section (`#id` in this document, or `doc.geml#id`) or a whole document (`./guide.geml`; a Markdown file works too) — a path that starts with `./` resolves against the workflow's directory, any other against the project root — loaded when the state is entered; `skills`, a list of skill names, handed to the host; `tools`, a list of uses. The format's `final: true` marks a final state: a work item that enters one is closed (§3.5) |
| variable | an entry of `vars` | `default` fixes the type. Gemflow's keys: `source`, where the value comes from (below); `note` |
| transition | an entry of `transitions` | `guard`, and `reset` in `actions`: when the edge is taken, the variables listed return to their default in the same revision, and the guard reads the values as they were before — an edge that sends the work back for rework uses it to clear the last pass's evidence. Gemflow's keys: `approval: true`, a person must say yes at that moment; `note`, what the model is told about the edge |
| guard block | a `data` block, `format=json`, that a `guard` names by `#id` | a long guard, or one several transitions share |
| prompt | an ordinary section or document that a `prompt` names | expanded into the context when the state is entered |
| work-item unit | meta `flow-unit` | `branch` (the default: one work item per branch) or `file:<glob>` (one per matching file, e.g. `file:episodes/*.geml`) |

A guard that is an object is a JSON Schema over the variables, in the
subset geml-statechart §4 fixes, whose instance is the object "variable name →
current value". When the definition sits in a `data` block that the diagram
names by `data=` (geml-statechart §2.8), a coordinate (GEML §5.2) reaches each
value: `geml get flow.geml '#flow-def["vars"]["tests-pass"]["default"]'` reads
one, and `geml set` changes that one and leaves every other byte as it was.

**`source`: where a variable's value comes from.**

| written as | when it is written | value |
|---|---|---|
| no `source` | when the model calls `set` | what the model wrote, of the default's type |
| `{ "tool": "<use>" }` | when a tool call bound to that use ends (§3.6) | true on success, false on failure |
| `{ "file": "<glob>" }` | when a call that writes a file or runs a command ends, when a session starts, and when the board refreshes | true when a file matches |
| `"committed"` `"pr-open"` `"pr-merged"` `"ci-success"` | when a session starts, when a call that ran `git` or `gh` ends, and when the board refreshes | the facts of git and CI (§3.6) |
| `"human"` | a person checks it on the board, or runs `gemflow mark` | checked true, unchecked false |
| `{ "elapsed": "<ISO 8601 duration>" }` | when the work item is opened, and at the start of every writing operation (§3.6) | true once the current state has been held at least that long; false again on entering a state |

A variable with a `source` is **evidence**: the model cannot write it, and its
default must be `false`. A variable without one is the model's own notebook.

**Three kinds of guard, three judges.**

| guard | judged by | how the edge is taken |
|---|---|---|
| an object, or a reference to a guard block | the machine | on its own, as soon as it holds after a change; a state has at most one such out-edge that needs no approval |
| a sentence | the model | the text goes to the model with the stage text; when the model judges it holds, it calls `move` |
| `approval: true` | a person | on the board, or with `gemflow advance`; a guard written beside it must hold too; never on its own |

A transition with no guard and no approval is taken by the model with
`move`, or by a person.

**Uses.** A state's `tools` lists the uses the stage needs — `edit`, `test`,
`pr`, `deploy-prod`, `image` — words the author picks. The tool dictionary
binds a use to this project's concrete tools (§2.3). A use is usable only in
the states that declare it: that is how the author fences a path, and why a
production deploy runs only in `release`. A tool bound to no use is decided by
what the dictionary has learned (§3.7).

### 2.3 The tool dictionary

Which tools each state may use, which tool of a use comes first, and what
arguments a tool takes by default are not written in the workflow. They live in
the workflow's tool dictionary, `tools.geml` beside `flow.geml`, a `#tools`
table committed with the workflow, which grows from the choices a person makes
while working (§3.7):

```geml
=== table {#tools}
| tool                        | for   | allow | deny | default | params |
|-----------------------------|-------|-------|------|---------|--------|
| Read                        |       | *     |      |         |        |
| Edit                        | edit  |       |      |         |        |
| Bash(npm test)              | test  |       |      | yes     |        |
| Bash(gh pr create)          | pr    |       |      |         |        |
| mcp__jimeng__generate_image | image |       |      | yes     | `{"ratio": "9:16", "model": "seedream-4.0"}` |
| mcp__flux__generate         | image |       |      |         | `{"steps": 28}` |
===
```

- `tool` — a tool name, which may hold a `*` wildcard (`mcp__geml__*`). A tool that runs commands is recorded by command: `Bash(npm test)` matches a command that starts with it and ends the match at a word boundary (`npm test -- --watch`, not `npm tests`); `*` matches any run of text (`Bash(geml media todo * --check)`); the key with the longest literal part wins (§3.6); `Bash()` stands for every command.
- `for` — the use: a word the workflow declares in a state's `tools` (`edit`, `test`, `image`, …). Tools of the same use stand in for each other. A tool bound to a use is usable only in the states that declare the use (§2.2).
- `allow`, `deny` — lists of state ids; `*` stands for every state.
- `default` — `yes` makes the tool the first choice of its use. A use has at most one; the first tool registered for a use becomes its first choice on its own.
- `params` — a JSON object: when the tool is called, the arguments the model did not give are filled from it.

The table is read as every table Gemflow reads: column names are
case-insensitive; no column outside the header's list, no empty column name
and no repeated column is allowed; a cell that is exactly one code span reads
as the span's text; a literal `|` inside a cell, code spans included, is
written `\|` (GEML §6).

**The starter dictionary.** `gemflow init` and `/gemflow add` copy a bundled
workflow with its starter dictionary: a `*` row admits the host's read-only
tools (`Read`, `Grep`, `Glob`) in every state; the uses the workflow declares
come bound to the common tools — the dev workflow's `test` to `npm test`,
`pnpm test`, `yarn test`, `cargo test`, `pytest` and `go test`, its `pr` to
`gh pr create`, its `deploy-staging` and `deploy-prod` to the spellings of
`wrangler deploy` (one row each for an `npx`, `pnpm` or `bunx` prefix; a
deploy without `--env` counts as production); a workflow that wants to be
strict writes its refusals ahead (the bundled coding workflow denies `Edit` and
`Write` in `explore`); every other tool runs as usual.

### 2.4 The journal

A journal is an ordinary GEML document of appended `data` blocks:

```geml
=== data {#journal}
{ "item": "feat/rate-limit", "workflow": ".geml/workflows/dev/flow.geml", "workflow-hash": "sha256:…", "created": "2026-10-12T09:00:00Z" }
===

=== data {#rev-0}
{ "rev": 0, "state": "build", "cause": "enter", "at": "2026-10-12T09:00:00Z",
  "vars": { "tests-pass": false, "pr-open": false }, "parent": null, "hash": "sha256:…" }
===

=== data {#rev-1}
{ "rev": 1, "state": "build", "cause": "patch", "by": "signal", "signal": "tests-pass", "call": "toolu_…",
  "tree": "tree:…", "at": "…", "vars": { "tests-pass": true, "pr-open": false }, "parent": "sha256:…", "hash": "sha256:…" }
===

=== data {#refused-1}
{ "rev": 1, "at": "…", "tool": "Edit", "call": "toolu_…", "reason": "you denied Edit in #explore" }
===
```

- `#journal` — the work item (`item`), the workflow file it started under (`workflow`, relative to the project root), that file's hash (`workflow-hash`) and when the journal was started (`created`, an ISO 8601 UTC timestamp). The work item goes on under that workflow for good (§3.2).
- `#rev-N` — one revision. `rev` starts at 0 and is contiguous; `state` is the state's id; `vars` the variables after the revision; `at` its time.
  - `cause` — what happened: `enter`, `transition`, `patch`, `rollback`, `expire`, `pause` or `resume`. A `pause` or `resume` revision is a person's hold on the work item (§3.8): the same state and variables as the revision before it, `by=human`; while held, evidence is still recorded and no transition is taken, the model's, a person's or the machine's. An `enter` lifts a hold.
  - `by` — who did it: `model`, `human` or `signal`. Revision 0 carries none.
  - `signal` — the signal variable that caused it, present exactly when `by=signal`.
  - `from` — the state left, on a `transition` and a `rollback`. `restores` — on a `rollback`, the revision restored.
  - `call` — the tool call that caused it, when there was one.
  - `tree` — the content fingerprint of `tool` evidence (§3.6), on a revision in which a variable whose `source` is a tool takes a value other than its default.
  - `hash` — `"sha256:"` + the SHA-256 of the block's canonical JSON without `hash` (keys sorted by code point, no whitespace). `parent` is the previous revision's `hash`, `null` on revision 0. Reordering, deleting or editing a revision breaks the chain. Deleting a **trailing** run of blocks is the one edit the chain cannot detect, so a journal's tail is only as trustworthy as the storage under it.
- `#refused-N` — one refusal, numbered from 1: `rev` is the revision it happened after, `tool` the tool or verb refused, `call` its call id (absent for a person's command), `reason` why, and `key` the dictionary key or command pattern the gate judged, when it judged one (absent for a person-only command or a verb). A refusal adds no revision.
- `#wrote-N` — one file the work item's work wrote, numbered from 1: `rev` is the revision it was written at, `at` when, `tool` the tool that wrote it, `path` its path from the project root, and `call` the call id. A file is recorded once per stage, and the item file itself not at all. Like a refusal, it is outside the hash chain and adds no revision.
- A coordinate reads any value: `geml get .geml/journals/feat/a.geml '#rev-3["vars"]["tests-pass"]'`.
- A journal is written by **blind append**: each block is complete on its own, so the writer never reads the file to write a block (GEP-0005).

The journal is created at the first Gemflow event on a work item, with revision
0 `cause=enter`. Where it lives depends on the unit:

- `branch` — `.geml/journals/<branch>.geml`, in the repository's **main working tree** (the directory above `git rev-parse --git-common-dir`), which every checkout shares: a branch has one journal whichever checkout it is worked in, and removing a worktree loses none of it. That `journals/` directory carries its own `.gitignore`, whose content is `*`. On `main` (or the repository's default branch) the engine does not run, and the status line says `main · not tracked`.
- `file:<glob>` — `.geml/journals/<the file's relative path without its extension>.geml`, each checkout its own. It does not depend on git.
- A project outside git keeps its journals in `.geml/journals/` under its root.

In each path a `/` of the work item's id becomes a directory.

### 2.5 The context document

`.geml/context.geml` holds what Stagehand wrote for the current stage (§3.10):

```geml
=== text {#current}
Write the code and its tests, until the tests pass and a pull request is open.
===

=== data {#stage}
{ "item": "feat/rate-limit", "state": "build", "rev": 0, "at": "2026-10-12T09:00:00Z" }
===

=== data {#vars}
{ "tests-pass": false, "pr-open": false }
===
```

- `#current` — a `text` block holding the stage text. Its fence is one `=` longer than the longest run of `=` that starts a line of the text, and at least three, so no line of the text can close the block.
- `#stage` — `item`, `state`, `rev` (the revision that entered this stage) and `at`.
- `#vars` — the current variables. A revision inside the same stage rewrites only this block. It is a view to read: `geml get .geml/context.geml '#vars["tests-pass"]'` reads one value. Variables are written only through the verbs and signals, because the journal is append-only and hash-chained, and every write must pass the variable's type and the rule that the model never writes a variable with a `source`.
- One per checkout, regenerated whole, never versioned, and kept out of git by default.

## 3. Runtime semantics

### 3.1 The project

```
.geml/
  workflows/<name>/flow.geml   the workflow; beside it, its prompt documents and its tool dictionary tools.geml; committed
  journals/<item>.geml         one journal per work item; a branch unit's in the main working tree (§2.4); ignored by git
  backlog.geml                 the backlog (§3.12); committed
  gemflow.geml                 the project configuration; committed
  context.geml                 the current stage (§2.5); one per checkout; ignored by git
```

The project configuration is one `data` block, `#gemflow`, whose `default`
names the workflow a new work item starts under:

```geml
=== data {#gemflow}
{ "default": "dev" }
===
```

The default workflow is, in this order: the flow file the environment variable
`GEMFLOW_STATECHART` names (it names the session's workflow, and a project in
another checkout ignores it, §3.3); else the `default` of `.geml/gemflow.geml`;
else the only `.geml/workflows/<name>/flow.geml`. `gemflow init --template
<name>` copies a bundled workflow's whole directory into
`.geml/workflows/<name>/` and makes it the default; `gemflow use <name>` and
`/gemflow use` change the default and leave every work item already started on
its own workflow (§3.2).

### 3.2 Work items

The current work item is found by the unit of the default workflow.

- `flow-unit = "branch"`: the work item is the checked-out branch. There is none on the repository's default branch (the remote's `HEAD`, else a local `main` or `master`), on a detached `HEAD`, on a branch with no commit yet, or outside a git repository.
- `flow-unit = "file:<glob>"`: the work item is the matching file written last; until a call writes one, the work item the context document names, while its file still exists and matches. A person can also switch it on the board. A file under a `.git` or `node_modules` directory is never a work item, nor one under `.geml` unless the glob's first segment is `.geml`, and never one under `.geml/journals/`.
- With `flow-state-key`, the item file says where its work item stands, under that meta key: after an operation that leaves it saying otherwise it is written back, only that value changing; a work item with no journal starts in the state it names, when the workflow has that state.
- The id is the branch name, or the file's path without its extension. An id names a journal only when every file system can hold it: `/`-separated, with no empty, `.` or `..` segment, no leading `/`, no control character and none of `<` `>` `:` `"` `|` `?` `*` `\`, no segment that ends in `.` or a space, and no Windows device name (`con`, `nul`, `com1`, …, with any extension). Any other id is no work item.
- Without a work item nothing is recorded, and the hosts say why (`main · not tracked (work items are branches)`).

**Each work item keeps its own workflow.** One that has a journal goes on under
the workflow its `#journal` names; a new one starts under the default workflow.
`gemflow use` changes only the default, so a side task can run under another
workflow while the work item it interrupted keeps its own, and finds it again on
the way back. When the workflow file a journal names is missing, every
operation on that work item fails, naming the file; the way out is to restore
it, or to move the journal aside and start over under the default workflow. A
host that shows the work item names its workflow when it is not the default.

### 3.3 Which work item a call acts on

Work on one item is often broken into by another task — a fix noticed on the
way, a rebase, a pull request — and returns to the item afterwards. The work
item is the unit of isolation: each has its own journal and its own variables,
so a task that lands on another work item (another branch, another checkout,
another file of a `file:` unit) leaves the first one as it was. The rules below
attribute every call to the work item it really acts on.

**Where a call starts, and where each command runs.** The host reports the
directory each call starts in (Claude Code: `$.session.cwd()` read in the hook,
which answers for the loop that makes the call). A simple command of a plain
`&&` chain (§3.6) runs in the start directory as the `cd`, `pushd` and `chdir`
before it in the chain change it. A target that is not written out — it holds
`$`, `~` or a backtick, is `-`, or is missing — leaves that command's directory
unknown. A call that writes a file (Edit, Write, NotebookEdit) acts in its
target file's directory. A directory belongs to the checkout its git top level
names.

**Recording, only when sure.** A signal is written only to a work item the call
surely acts on:

| the call acts in | recorded in |
|---|---|
| the session's checkout, its subdirectories included | the session's current work item |
| another checkout that has a workflow and a current work item | that checkout's current work item, under its own workflow |
| anywhere else, or a directory not known | nothing |

**Gating, strict where unsure.**

- A command only a person may run (§3.8) is refused wherever it runs, and so is a write to a journal or a context document, any checkout's.
- A call that writes a file is held to the gates of the work item its target file belongs to.
- A command line is held to another checkout's gates only when every command of it surely runs in one and the same other checkout that has a current work item. Any other line — one that runs elsewhere, in a directory not known or in several places, or in another checkout whose work item is not current or whose workflow fails to load — is held to the gates of the session's current work item: where a command starts is not where it acts, and `cd /tmp && rm -rf <project>/src` is refused all the same.

**Facts read again follow the session.** The git and `file` sources read again
after a call act on the session's work item whenever the call does not surely
act in another checkout: they read the facts as they are, which is never
wrong. The walk of a `file` source does not enter a nested checkout (a
directory below the project root that holds a `.git`). A project in another
checkout finds its workflow in its own `.geml/`; `GEMFLOW_STATECHART` names the
session's only.

**Verbs.** When the calling loop's directory is surely in another checkout that
has a current work item — a subagent in an isolated worktree, say — the verbs
act on that checkout's work item; otherwise on the session's.

**Under a `file:` unit.** A command's `tool` evidence and its gates follow the
episode its command line writes, when the line writes exactly one of this
checkout's files of the unit. A line that writes a file that is not this
checkout's, or a glob or brace pattern in place of a file of the unit, records
nothing; a line that writes none acts on the current work item.

**A command line that only switches the work item is admitted in every
state**, before the tool dictionary is consulted (§3.7): it is never refused. It is a plain `&&` chain each of whose simple commands is one
of:

- `git switch <branch>`, or `git switch -c|-C|--create|--force-create <branch> [<start>]`;
- `git checkout -b|-B <branch> [<start>]`, or `git checkout <branch>` when `<branch>` is an existing local branch;
- `git worktree add [-b|-B <branch>] [--detach] <path> [<start>]`;
- `cd <path>`.

A command with any other option or argument — `-f`, `--force`,
`--discard-changes`, `--merge`, `--`, a path — is not one. So even when a person
denied `Bash(git)` in some state, there is always a way to leave and do
something else, and a refusal's reason names it. `git switch` carries
uncommitted changes over to the branch switched to: that is git's behavior.

**Handing over.** A change of work item is handed to the model at once (§3.10).

**Limits.** Directories are read from the text of the command line: a
variable, a script, or a directory passed as an argument (`npm --prefix`,
`git -C`) is not followed. A host that decides some calls without asking the
runtime (Claude Code's fast path) may place a path that passes through a
symbolic link differently from the runtime.

### 3.4 One operation at a time

Every operation on a work item — a tool call's check or its result, a verb, a
person's command, a refresh — takes the lock `<journal>.lock`, reads the
journal afresh, acts, appends what it produced and releases the lock, so the
CLI, the MCP server and a host's hooks can share a project without sharing
memory. Several sessions on the same work item append to the same journal, and
the chain stays unbroken. Another holder is waited for and the lock retried;
when it is not released in time, the write fails and the status line says so —
nothing is dropped silently. An operation first expires `tool` evidence when
the work item's content has changed (§3.6), under the same lock.

A journal that fails verification (§4), or whose current state its workflow
does not have, is not resumed: every operation on that work item fails, naming
the journal and the way out — move it aside, and the next operation starts the
work item over at the initial state of the default workflow.

### 3.5 Moving on

| who | how | `by` |
|---|---|---|
| the model | `move` takes an edge of the current state: one whose guard is a sentence, or one with no guard; a machine-judged edge is not its to take (it is taken on its own when its guard holds), and an edge that needs approval is refused | `model` |
| a person | clicks an edge on the board, or runs `gemflow advance <state>` in their own terminal; that is the approval | `human` |
| on its own | after a change, the current state's machine-judged edge that needs no approval is taken at once when its guard holds | the source of that change: `signal` after a signal's write (with `signal=<variable>`), `model` after a model's action, `human` after a person's move |

The guard holds the same whoever takes the edge.

- When one change writes several signals, an edge taken on its own is recorded under the signal of a variable its guard reads (the first that appears in the guard's `properties` or `required`), else under the last signal written.
- A run of edges taken on its own stops before a state it has already entered during this change, the one it started from included. An edge back to its own state is therefore never taken on its own.
- After a transition — a model's `move` or a person's move — the first edge taken on its own never takes the workflow straight back to the state that transition left. A person who sends the dev workflow back from review to build (`review→build`) stays in build while the guard of `build→review` still holds. Only the state just left is held back, and only during this change: the next change (the tests passing again, say) takes the edge as usual, and so does a chain that returns to the state a step later. A rollback is no such transition: an edge that holds in the state it restores is taken.
- An edge taken on its own runs its `reset` action, as any taking of that edge does, before the next state's edges are read.
- A signal write that leaves its variable as it was is no change, and takes no edge.

A model's `move` along an edge that needs approval is refused and recorded as
`refused`; the answer tells the model that a person approves it on the board or
with `gemflow advance <state>`.

**Final states.** A work item that enters a state marked `final` (geml-statechart §2.1) is closed: the state has no transition out, so neither the model, a person nor the machine moves it; `tool` evidence no longer expires there (§3.6); the band shows ✓ and the state's `title`. The gate judges as it does in any state, by the uses this state declares — an episode is not edited once published, and a change to a finished branch is a new change; the ways out are another work item (a new branch, the next episode) or a person's `rollback` to an earlier revision. The model cannot reach a final state unless the author gives it a model-judged transition into one.

### 3.6 Variables and evidence at run time

| `source` | read | value |
|---|---|---|
| none | when the model calls `set` | the value the model wrote, of the default's type |
| `{ "tool": "<use>" }` | when a tool call bound to that use ends (how a call is bound to a use is below) | true on success, false on failure: a command by its exit status, any other tool by its `isError` |
| `{ "file": "<glob>" }` | when a call that writes a file or runs a command ends (a build or a render makes files as surely as an edit; a path outside the project or under `.geml`, `.git` or `node_modules` does not count), when a session starts, and when the board refreshes | true when a file matches the glob |
| `"committed"` `"pr-open"` `"pr-merged"` `"ci-success"` | when a session starts; when a call ends whose command line runs `git` or `gh` at any command position, at any path (through a launcher such as `sudo git switch main` or `timeout 30 git pull`, and in a string handed to a shell such as `bash -c "git checkout -b x"`, too; naming either as another command's argument is not running it); when the board refreshes | queried for the current branch; `ci-success` is the conclusion of the latest run of each CI workflow on the branch head |
| `"human"` | only from a person: a checkbox on the board, or `gemflow mark <variable>` (`gemflow unmark <variable>` to uncheck) in the person's own terminal | checked true, unchecked false |
| `{ "elapsed": "<ISO 8601 duration>" }` | the clock: whenever the work item is opened (any command, any request) and at the start of every writing operation, together with `tool` evidence's expiry, under the lock | true once the time from the revision that entered the current state (§3.8's checkpoint) to now reaches the duration, else false |

A signal writes only booleans. Its write is a revision with `cause=patch`,
`by=signal` and `signal=<variable>`; a write that leaves the variable unchanged
adds no revision.

**`elapsed` evidence reads the clock.** The duration is the days, hours,
minutes and seconds subset of ISO 8601 (`PT2H`, `P1DT12H`, `PT30M`), above
zero; months and years are not what a clock adds, so they are not read. It
measures **how long the current state has been held**: every transition that
enters a state, and every rollback, returns all `elapsed` variables to false in
the same revision, and the clock starts from that revision — so "review has
waited two hours" is read on an edge out of `review`, and a return to build and
back starts the count again. It is evaluated whenever the work item is opened (any command, any request,
`gemflow status` included) and when a writing operation begins, so the band,
the board and `status` always show the value as of now. Nothing is evaluated
in a final state (§3.5).

**`tool` evidence expires.** When a variable whose `source` is a tool takes a
value other than its default, that revision records the fingerprint of the work
item's content as `tree`. At the start of every later operation on the work
item, under its lock, when the fingerprint has changed, those variables return
to their defaults in one revision (`cause=expire`, `by=signal`, `signal=` the
first of them), and the edges are then read as after any change. The
fingerprint: under a `branch` unit, the git tree of the checkout's working
content — every tracked and untracked file git does not ignore, as it is on
disk, written with `git add -A` and `git write-tree` from a copy of the index,
so the real index is untouched and only changed files are hashed; `.geml` and
`node_modules` left out; under a `file:` unit, a hash of the episode file's
content. So when the tests pass and more edits, a rebase or a pull follow, the
tests must run again; a commit alone changes nothing. `file` and git sources
are read afresh from the facts anyway; `human` is a person's judgment and does
not expire.

**The exit status.** On Claude Code, a call that ended in error carries
`isError` and a `text` that starts with `Exit code <n>`, and that `n` is the
status; a call that did not end in error and whose result carries no
`returnCodeInterpretation` exited 0. Claude Code reports a few non-zero
statuses as normal ends (`grep` finding nothing is `No matches found`, `diff`
finding differences is `Files differ`); they count as non-zero here, so `tool`
evidence never reads a `grep` that found nothing inside a test command as a
pass.

**How a call is bound to a use.** For a tool that runs commands, the command
line is split into its simple commands (leading `NAME=value` assignments
skipped; a blank is a space or a tab), and each simple command, its quotes and
escapes removed and each run of blanks made one space, is matched against the
dictionary's `Bash(…)` keys: a key is a pattern in which `*` matches any run of
text, a key without `*` matches a prefix that ends at a word boundary
(`Bash(npm test)` takes `npm test -- --watch`, not `npm tests`; `Bash()` takes
every command), and the key with the longest literal part wins
(`Bash(wrangler deploy --env staging)` beats `Bash(wrangler deploy)`).
Any other tool is matched by its name, which may hold a `*`. The matched key's
`for` is the use the call belongs to. The exit status counts only when the
command line is nothing but simple commands joined by `&&`; any other line
writes no `tool` evidence, because its exit status does not speak for the
matched command. A line is not a plain `&&` chain when, outside quotes, it
contains:

- `;`, `||`, a pipe, a background `&` (`&>` included; a `&` inside a redirection such as `2>&1` or `>&log` is not one), a newline, `$(`, `${`, `$[`, a backtick or `(`;
- a `#` that starts a word, which begins a comment;
- an unterminated quote, or an empty command (`a &&`).

Quoting is the shell's: single quotes hide everything, `$'…'` hides everything
but a backslash escape, double quotes hide the operators above from the split
(the shell still runs `$(…)` and backticks inside them, and `${` is not hidden),
and a backslash outside quotes escapes the next character (a backslash-newline
is a line continuation). A line is also not a plain chain when the command word
of one of its simple commands — after assignments, redirections and the
prefixes `builtin`, `command`, `time`, `!`, `noglob` and `nocorrect` — is a
shell keyword (`[[`, `]]`, `{`, `}`, `function`, `if`, `while`, `for`, `case`
and their kin), a builtin that can end the shell or change what runs (`exit`,
`exec`, `trap`, `return`, `logout`, `hash`, `alias`, `unalias`, `enable`,
`eval`, `source`, `.`), or a word built by expansion (one containing `$`): any
of them can make the line exit 0 without the matched command speaking for it.

A call that went to the background (its result carries a background task id)
has no exit status when it ends, and writes no `tool` evidence. A subagent's
calls pass through the main session's hooks, so a test a subagent runs is
recorded too — in the work item of the checkout it runs in (§3.3).

**A fenced use**, by contrast, is looked for anywhere in the command line, and
again in a copy of the line with its quotes and backslashes removed and each
run of blanks made one space, so a deploy inside a compound command line or a
wrapper (`npx …`, `bash -c "…"`) is still refused outside the states that
declare its use, and so is `wran"gler"  deploy`.

A tool whose command line is PowerShell — DeepSeek Harness's `pwsh` — is never
read by these sh rules. It writes no `tool` evidence, and its fence check looks
for the key in the line as written and again with PowerShell's backtick
escapes removed (a backtick-newline joins two lines).

**The limits of both.** `tool` evidence means "a command bound to this use
exited 0", not "the suite passed": arguments, the environment and edited
scripts change what a command runs, so write the dictionary's keys long enough
(`Bash(npm test)`, not `Bash(npm)`). A fence sees only the text of the line, and
compares it case-sensitively: a variable, `eval`, an encoded string or a script
the model wrote gets past it, so fence the names of scripts that run the
command as well; stopping a command for real takes credentials the agent does
not hold.

**The glob dialect.** A `file` source's glob, and the glob of
`flow-unit = "file:<glob>"`, is matched against a whole path, relative to the
project root and `/`-separated. `*` matches any run of characters within one
path segment, `**` any run of characters across segments (`**/` may also match
nothing, so `docs/**/*.md` finds `docs/a.md`), and `?` one character other than
`/`. There are no character classes and no braces: `[`, `]`, `{` and `}` match
themselves. `*` and `?` match a leading `.`, so `*` finds dotfiles. Names
compare case-sensitively, whatever the file system does. A file under a `.geml`,
`.git` or `node_modules` directory, at any depth, never matches; the walk does
not follow a symbolic link to a directory, and does not enter a nested
checkout; a walk that gives up after 50 000 entries leaves the variable as it
was.

**The git and CI facts**, for the current branch:

- `committed`: the branch has a commit its default branch has not. git answers it alone.
- `pr-open`, `pr-merged`: the state of the newest pull request whose head is the branch; a branch with none has neither.
- `ci-success`: the newest run of each CI workflow on the commit the branch is at: true when there is at least one and every one ended `success`, `skipped` or `neutral`; a run still going is not a success.

`gh` is asked only when `vars` has a variable whose source is `pr-open`,
`pr-merged` or `ci-success` (the program `GEMFLOW_GH` names, else `gh`). When
`gh` is missing, not logged in, or has no GitHub remote to ask, those variables
are not written, keep their values and are marked unavailable, and the status
line says why. A fact nobody could establish never reads as false.

### 3.7 Tools: the dictionary, asking, preferences

**How a call is decided**, in the current state S of the work item the call
belongs to (§3.3):

1. First the rules that hold in every state: a command only a person may run is refused (§3.8); a command line that only switches the work item is admitted (§3.3); Gemflow's own three tools (§3.11) are admitted.
2. The call's keys: the tool's name; for a tool that writes files, `<tool>(<path>)` — a row naming the tool alone takes it with any path, a row `<tool>(<glob>)` the calls on a path that ends in a match of the glob, starting at a segment; for a tool that runs commands, a `Bash(…)` key for each simple command of the command line, the key with the longest literal part first (§3.6).
3. Each key is judged on its own: a key bound to a use (`for`) is admitted when S declares the use and refused when it does not (the reason says "`deploy-prod` is used only in #release"); a key bound to no use is refused when it was denied in S or in `*` (the reason says "you denied it in #S"), admitted when it was allowed, and unknown when no row takes it.
4. Any key refused: the call is refused, its reason naming every refused key, and a `refused` is recorded.
5. Otherwise — every key admitted or unknown — the call runs, and the host's own permission rules apply as usual: whether a command no row takes may run, and whether it is safe, is theirs to judge from its actual arguments, not Gemflow's. When it ends, evidence is written for the keys bound to a use, as the variables' `source` says.
6. Gemflow asks nobody whether an unknown key may run. Binding it to a use, or denying it, is a row a person writes, on the board or in `tools.geml`.

**Preferences.**

- The stage text lists the stage's tools: each use's first choice with its default arguments, and the tools denied in this stage (§3.10). The model usually follows it.
- When a tool with `params` is called, Gemflow fills in the arguments the model did not give, rewriting the call's input; an argument the model gave is never overridden. This applies only to tools whose input is structured data (MCP tools, built-in tools); a command line is never rewritten.
- When the model uses a tool that has a use but is not its first choice, the person is asked: allow this time / make it the default from now on / deny (so the model uses the first choice). The choice is written back to the dictionary.
- A use is bound or unbound on the board, or by a row written into `tools.geml`. Default arguments are edited on the board, or saved from one call with "set as default".

### 3.8 What only a person does

`gemflow mark <variable>` and `gemflow unmark <variable>` write a variable
whose `source` is `human`, true and false; a variable with another source is
refused. `gemflow advance <state>` takes an edge of the current state as a
person: the revision says `by=human`, the edge's guard must hold, and an
`approval` edge is taken without asking — the command is the approval.
`gemflow rollback <revision|checkpoint>` restores the state and variables of a
revision (`checkpoint` is the revision that entered the current stage); it
never undoes a side effect that already happened. `gemflow pause` holds the
work item (a `pause` revision, §2.4): evidence goes on being recorded, no
transition is taken — the model's `move` is refused and recorded, a person's
`advance` is refused, the machine's transitions wait — until `gemflow resume`
lets it go, which takes the machine-judged transition that came to hold
meanwhile, as the person's.

The model may not run `mark`, `unmark`, `advance`, `pause` or `resume`. A
call that runs one of them is refused, in every state, and recorded as
`refused`:

- **Where a command starts.** The line is split at `;`, `&`, `|`, a newline, parentheses and a backtick, and the commands inside a `$(…)` within double quotes are read too. A command's command word is its first word past assignments, redirections and prefixes that run the next word — `builtin`, `command`, `time`, `env`, `sudo` and their kin — with its quotes and escapes removed.
- **What runs gemflow.** A command word that is `gemflow` (the last segment of a path, in any case: `./node_modules/.bin/gemflow`); or a launcher — `npx`, `bunx`, `npm exec`, `pnpm dlx`, `pnpm exec`, `yarn dlx`, `node` and their kin — one of whose arguments is `@geml/gemflow` (with an optional `@version`) or the package's `cli` script.
- **The verb.** The first argument after it that is not an option is `mark`, `unmark` or `advance`, in any case — or is built by expansion, so could be any of them.
- **Strings handed to a shell.** The argument of `bash -c "…"`, `pwsh -c "…"` and `eval`, and the strings launchers hand to a shell (`sudo sh -c "…"`, `timeout 5 bash -c "…"`, `npx -c "…"`, `npm exec --call=…`, `env -S "…"`), are read again by these rules. A PowerShell string is read by the same rules, and searched once more word by word as a fallback.
- **A line the scan cannot read.** When the command word is built by expansion (it holds `$`) or a quote does not close, the line is refused when, its quotes removed, it holds `gemflow` and one of the three verbs.

So `npx @geml/gemflow mark x` and `bash -c 'gemflow mark x'` are refused;
`echo gemflow mark` and a commit message that mentions `gemflow` and `advance`
are not. Like a fence, the rule sees only the text of the line.

### 3.9 `by` is a claim

`by=human` records that the change came through a person's command —
`gemflow advance` in a terminal, or the board — and nothing more: the runtime
authenticates nobody. The chain proves what happened and in which order; read
`by` as a claim, not as evidence.

### 3.10 Stagehand

Stagehand has two layers: the core writes a file, and the host hands the file
to the model.

- **The core.** When the workflow enters a state, from any source, Stagehand takes the state's `description`, expands the section or whole document its `prompt` names — a path that starts with `./` resolves against the workflow's directory, any other against the project root; an `embed` inside it is expanded in process — and appends the skills to enable, the stage's uses with the tools bound to each (the first choice and its default arguments, §3.7), the variables' current values, and the states it can go to next: for each outgoing edge, the variables a machine-judged guard still lacks, the text of a sentence guard, whether it needs approval, and its `note`. A file that, its symbolic links resolved, lies outside the project is never read.
- **The budget.** The whole text is at most 16 KB, counted in bytes. The `description`, the skills, the tools, the variables and the edges are always in; the prompt's content gets the rest, and when it does not fit it is listed only by its address, for the model to read when it needs it.
- **The document.** The result is written to `.geml/context.geml` (§2.5). A change of stage writes it whole; a revision inside the stage rewrites only `#vars`.
- **The host.** Claude Code's hooks module hands `#current` to the model, with the tool result of the call that changed the stage, or with the next prompt when the stage changed elsewhere (the board, a session start, a subagent). A host with no channel into the model's context has its skill tell the model to read `.geml/context.geml` first on every turn, and `status` returns the same text.

**Handing over on a change of work item.** When a call is answered on another
work item than the one whose stage text the main loop last received (its
`item@rev`), the new work item's stage text goes to the model with that call's
tool result, after one line:

```
[gemflow] now on fix/doc-b · #build (new work item)
[gemflow] back on feat/a · #build · rev 3 · tests ✓ · pr ✗
```

A subagent's call gets the stage text of its own work item, and that does not
count as handed to the main loop.

### 3.11 The verbs

Three tools, whose parameters are fixed and never change with the state:

- `status` — read only: the work item, the stage, the variables, each outgoing edge and whether its guard holds, and the stage text.
- `move {to}` — takes an outgoing edge (§3.5).
- `set {variable: value, …}` — writes variables the model writes: of the default's type, never a variable with a `source`.

Claude Code lists them as `mcp__gemflow__status`, `mcp__gemflow__move` and
`mcp__gemflow__set`; a host that only speaks MCP sees the same three names
through `gemflow mcp`; DeepSeek Harness and pi agent register `gemflow_status`,
`gemflow_move` and `gemflow_set`. They are Gemflow's own tools: the tool
dictionary does not apply to them, and their own rules — guards, approval,
variable types — always do. The variables a person checks, and rollback, are
not the model's tools.

A host that only speaks MCP hands Gemflow none of its own tool calls, so on it:

- `tool` sources are never observed, so no `tool` evidence is ever established, and the tool dictionary, the fenced uses and the person-only rule refuse nothing. A guard holds for a person's move as for any other, so a transition whose guard reads `tool` evidence is taken only when the guard also accepts a variable a person checks: in the dev workflow a person checking `review-ready` lets `build` enter `review`, while the exit status of the production deploy is never read on such a host, so `release` never reaches `done` unless the workflow adds a variable a person checks to that transition's guard.
- git and `file` sources are read again only when the model calls `status`; when that moves the workflow, the answer carries the new stage text.
- There is no status line and no board; a person moves the workflow on and checks the variables a person checks with `gemflow` in a terminal.

### 3.12 The backlog

`.geml/backlog.geml` holds one `table` block, `#backlog`, with the columns
`id`, `title` and a target column: `branch`, or `file` for a workflow whose
unit is `file:…`. A cell reads as a tool dictionary cell does (§2.3). A row
whose target cell is empty is a to-do. When a work item's journal is first
created and there are to-dos, the board offers to bind one to it; a row can
also be bound by hand on the board. Binding fills that one cell, and every
other byte of the document stays as it was — the other columns and their
padding, the other rows, the prose, the meta, the other blocks, the line
endings. A row is not bound when its id is empty or repeated, or when it is
already bound elsewhere. Reading the table reports a row with no id. A bound
item's progress is read from its journal, never stored in the table.

## 4. Static checks

`gemflow check <flow.geml>` runs `geml check` first — an error there refuses
the document, and with `geml-statechart/v1` declared that includes the statechart's
own checks, `statechart-body`, `statechart-initial`, `statechart-state`,
`statechart-transition`, `statechart-guard`, `statechart-actions`,
`statechart-vars`, `statechart-current` and `statechart-unreachable`, defined
in [geml-statechart §3](../../../spec/profiles/geml-statechart/geml-statechart-profile.md) — then
reads the tool dictionary beside the workflow, and reports Gemflow's own:

| code | severity | when |
|---|---|---|
| `flow-attr` | error | a `prompt` does not resolve; a `skills` or `tools` is not an array of strings; an `approval` is not `true`; a `source` is none of the forms of §2.2; a variable with a `source` has a default other than `false`; a `note` is not a string |
| `flow-source` | warning | a variable's `source.tool` names a use no state declares, so the variable can never be established; the dictionary's `for` names a use no state declares |
| `flow-dup-edge` | error | two transitions between the same two states (the journal records a transition as `from→to`) |
| `flow-auto-ambiguous` | error | a state has more than one machine-judged outgoing edge that needs no approval |
| `flow-auto-cycle` | warning | edges taken on their own form a cycle: if their guards held together, the workflow would go round in place, so the runtime stops before the first state it would enter twice |
| `flow-unit` | error | `flow-unit` is neither `branch` nor `file:` followed by a non-empty glob; or `flow-state-key` is on a branch unit, or not a key name |
| `flow-tools` | error | the tool dictionary's (§2.3) header is wrong; `allow` or `deny` names a state the workflow does not have; `params` is not a JSON object; a use has two `default`s |

A diagnostic names a transition `from→to`. Every check is pinned in
[`checks.json`](checks.json), beside this document, and the runtime's tests
replay each case: a document and the `severity:code` list the loader must
report.

`gemflow verify` checks a journal: the chain; `cause` consistent with `from`
and `restores`; every transition recorded is a transition of the statechart;
where `by=signal`, `signal` is a variable with a `source`; and a `pause` or
`resume` is `by=human`, keeps the state and the variables, and holds a free
item or releases a held one.

The JSON Schema subset a guard is written in is geml-statechart §4, and the
cases that pin it are that vocabulary's. Only the runtime reads the
statechart's Gemflow keys, the guard blocks and the tool dictionary, and only
`gemflow verify` checks the chain.
