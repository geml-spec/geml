# Changelog

## [0.2.1] — 2026-10-16

- **gemflow**: the board shows what a work item's work made. The files its
  work writes go into its journal as `#wrote-N` blocks, once per file per
  stage, outside the hash chain; the item file itself is not one of them.
  The items tab opens on the current work item's artifacts — under a file
  unit the item file's `#result` section, then the files written and the
  commits of its window — and names its unit; an approval card has a button
  to the artifacts. The matter workflow asks for a `# 结果 {#result}`
  section.

- **gemflow**: the matter workflow, a fifth bundled template. One matter is
  one work item, a file under `.geml/matters/`: noted → deciding → doing →
  checking → done, with parked beside. The model moves a noted matter on
  once its cause and options are written in it; every other way out is a
  person's button, and doing moves to checking when the check passes or a
  person ticks `accept-now`. Its uses are `note` (the matter file itself),
  `edit` (any other file, only in doing) and `check`.

- **gemflow**: a tool that writes files is keyed by the file, `<tool>(<path>)`.
  A row naming the tool alone takes it with any path, so every dictionary
  written so far reads as before; `<tool>(<glob>)` takes the calls on a path
  that ends in a match of the glob, and the longest literal wins, so
  `Edit(.geml/matters/*)` and `Edit` can be two uses. A file unit's glob that
  names `.geml` as its first segment reaches inside it, never its journals.

- **gemflow**: a file unit may keep its state in the item file. With
  `flow-state-key` in the workflow's meta, the item file says where its work
  item stands under that key, written back after an operation that leaves it
  saying otherwise; where there is no journal the item starts in that state.
  The item's fingerprint leaves the line out, so writing it back expires no
  evidence. A workflow without the key never writes its item files.

- **gemflow**: the band ends with a Board button whenever there is a
  workflow, and the board's tabs wrap instead of running off a narrow pane.

- **gemflow**: the band is there by default, and a project with no workflow
  is offered one. Before the bridge answers the band says it is starting;
  with no workflow it says so, names the bundled workflow that fits what the
  directory holds — `suggestWorkflow` in the CLI, carried as
  `ShellStatus.suggest`: `episodes/` or a geml-media document → video, a
  deploy configuration (wrangler, fly, vercel, netlify, render, a Dockerfile
  or compose file) → dev, a build manifest (package.json, Cargo.toml,
  pyproject.toml, go.mod, …) → coding, nothing recognisable → dev — and
  offers two buttons: add that one, or open the settings to pick another;
  `/gemflow` says the same. Finding Node is cross-OS now: after the PATH, a
  login shell on Unix or `where` through cmd.exe on Windows, then the
  installers' places (`%ProgramFiles%\nodejs`, `%LOCALAPPDATA%\Programs\nodejs`,
  nvm-windows, Volta, Homebrew, `/usr/local/bin`); each probe gets ten seconds
  instead of five, since a first run of node.exe behind an antivirus is slow,
  and a start that found no Node is retried after ten seconds instead of a
  minute. (On a fresh Windows machine the start probe failed, the band stayed
  empty since the project had no workflow, and `/gemflow add dev` sat on the
  retries.)

- **gemflow**: the flow picture is drawn from the model, so a way out a
  person may take is a button on every host. The board's flow tab no longer
  carries SVG markup for a surface to show as an image: `BoardData.picture`
  is now the chart's topology (`flowOf`, new in the parser's renderer: the
  states by rank and every edge with its kind, no pixels), the runtime's
  overlay, and the SVG of both. The Claude Code pane paints the first two
  with its own elements on every surface, the terminal included: each rank a
  row of state boxes (the current one in the accent, a final one
  double-framed, a badge for the items standing there), under it the ways
  out of its states one line each, and a way out a person may take now is a
  numbered button whose number is its hotkey. The `flow` row replaces the
  `svg` row and the state list under it; the dsh web board draws the same
  row's SVG, where the same way out takes a click.

- **gemflow**: the flow picture on the board. The flow tab opens on the
  statechart drawn by the parser's renderer, top to bottom for a narrow pane,
  with the runtime laid over it: the current state ringed (held: `paused`),
  each machine-judged way out green or grey for whether its condition holds,
  a badge for the items in a state, and the transition last taken in the
  accent. The bridge sends it as `BoardData.picture`; the Claude Code pane
  draws it through the `Svg` element where the surface has one (desktop,
  editor, phone; the terminal keeps the text list), and the DeepSeek Harness
  web board inlines it — and there a transition a person may take now is
  drawn pressable: a click on it is the board's advance (the Claude Code
  pane's `Svg` is drawn isolated, so its picture takes no clicks; the
  buttons stay in the list under it). The renderer gained `direction:
  "down"` and an `overlay` for this, and lanes now start past the widest
  pill in the band.

- **gemflow**: the board on DeepSeek Harness. In dsh's web GUI the board is a
  tab in the right sidebar, drawn from the same rows the Claude Code board
  draws: five of its six tabs (the sessions tab is Claude Code's transcript
  actions), the presses this host runs — a person's transition, a tick, a
  hold, and the lessons into `tools.geml` from "set as preferred", "allow
  here too" and the add-a-row field — and no button for what it cannot. The
  host half serves `GET /api/gemflow/board` and `POST /api/gemflow/act`
  (`src/hosts/dsh/board.ts`); the browser half is `client.js`, the package's
  `dsh.client` bundle, which opens a file link through dsh's own session API.
  The bundle's supervisor row is now named by path (`./dist/hosts/dsh/plugin.js`)
  instead of the `@geml/gemflow/dsh` subpath, because dsh-client-modules finds
  a package's browser half only for rows named by a bare package name or a
  path. The status builder and the journal timeline moved into
  `src/core/status.ts` and `src/timeline.ts`, shared by the workspace, the
  bridge and the dsh board; the `tools.geml` link of a workflow file at the
  project root no longer names the file as its directory.

- **gemflow**: Codex gets the gate. The package carries a Codex plugin
  manifest (`.codex-plugin/plugin.json`: the same skills, `codex/mcp.json`
  starting `gemflow mcp --host codex`, `codex/hooks.json` running
  `gemflow codex` on SessionStart, UserPromptSubmit, PreToolUse and
  PostToolUse) and the repository's Codex marketplace lists it. With the
  hooks trusted, each event opens the workspace in its own process and
  decides as the Claude Code module does: the stage text reaches the model
  as developer context at the start, after it changes and in the result of
  the call that changed it; a refused call is `permissionDecision: "deny"`
  with the reason; a tool the dictionary has no row for runs as usual;
  default parameters are filled in
  through `updatedInput`; and a shell command whose exit status is evidence
  is wrapped to print `[gemflow exit N]` last, read back after the call —
  Codex's result carries no status. `apply_patch` is Codex's editor: the
  bundled dictionaries bind it to `edit`, and a patch is judged by its
  paths, never scanned as a command line. Host table `codex`: `Bash` runs,
  `apply_patch` writes.

- **gemflow**: the sessions tab's three row actions. A prompt's record learns
  the id of its row in the host's transcript when the host stores it
  (`session.append`, door `prompt`), the export's GEML index carries it, and
  a selected prompt offers 定位 (`$.ui.scroll` to that row — a press is the
  person's own input, which is when a transcript row may move), 从这里拆分
  and 删除. The last two do not touch the record themselves: after a yes in
  the engine's own dialog the plugin submits a prompt that hands the model
  the bundled `split-session` skill (`skills/split-session/`, the one its
  author uses by hand: turns along the active chain, a turn the compaction
  machinery pins stays, the record is backed up under
  `~/.claude/session-split-backups/` and then rewritten with the gap closed,
  the desktop sidebar entry cloned) — 从这里拆分 moves this turn and the
  turns after it, all but the last, into a new session; 删除 moves this one
  turn into a session of its own, so nothing is lost. The plugin now ships
  four skills.

- **gemflow**: the Claude Code shell is the one the interface design settles
  (`docs/design/ui/2026-10-13-gemflow-ui/`). The band above the prompt leads
  with GEML's G mark and ends with the one or two actions the moment needs
  (approve, send back, tick, allow once, resume, retry) and a red pending
  count. The board opens on the inbox — everything only a person can do:
  approvals whose guard holds, variables to tick, a model stuck on one
  refused key, a bridge that is down — then work items
  by stage (with pause and resume), the journal with a "since you left"
  digest, filters and expandable evidence, the flow with its clocks, the
  tools with what a person can change in place and a field to add a row, and
  the session's prompts by stage with an export. A header carries share,
  settings (notifications, what the band shows, the project's default
  workflow, adding a bundled one or importing one from a path, the
  language), upgrade and about. Every word the shell draws comes from one
  table in Chinese, English and Japanese, following the setting or the
  system's locale. New inbox items, refusals and stage changes can raise
  desktop notifications. The bridge gains `import`.

- **gemflow**: a person can hold a work item. `gemflow pause` records a
  `pause` revision (same state and variables, `by=human`): evidence goes on
  being recorded, but no transition is taken — the model's `move` is refused
  and recorded, a person's `advance` is refused, the machine's edges wait —
  until `gemflow resume`, which takes the machine-judged edge that holds by
  then as the person's. Both are person-only commands like `mark`, `unmark`
  and `advance`. The bridge serves `pause`, `resume` and `export` (the
  journal as GEML, a Markdown revision table or JSON; a copy of the workflow
  directory; or a text the shell built — under `.geml/exports/`, absolute
  paths optionally stripped). The flow profile's journal `cause` list and
  `gemflow verify` say so.

- **gemflow**: a work-item switch is handed over on the spot. A main-loop
  tool call's `after` and verb requests carry `delivered`, the `item@rev` whose
  stage the main loop last read; when the answer is on another work item (a
  branch switched, another episode written) the CLI answers `handoff` with the
  item's stage text, and the Claude Code hooks module puts both in that tool
  result: `[gemflow] now on <item> · #<state> (new work item)` or
  `[gemflow] back on <item> · #<state> · rev <n> · <signal ✓/✗>…`. A subagent's
  call asks for no handoff and marks nothing delivered.

- **gemflow**: a strict state has a way out. A command line whose every
  `&&`-chained command only switches the work item — `git switch <branch>`,
  `git switch -c|-C|--create|--force-create <branch> [<start>]`,
  `git checkout -b|-B <branch> [<start>]`, `git checkout <branch>` of an
  existing local branch, `git worktree add [-b|-B <branch>] [--detach] <path>
  [<start>]`, `cd <path>` — is neither refused nor recorded as a deviation in
  any state (`switchesWorkItemOnly`, read by the supervisor and the Claude Code
  fast path, which leaves a bare `git checkout` to the CLI to check). The
  strict refusal names this exit.

- **gemflow**: each work item keeps its workflow. An item with a journal goes
  on under the workflow file its journal head names; a new item starts under
  the project's default (`.geml/gemflow.geml`), which still resolves which item is
  current. `gemflow use` and `/gemflow use` change only the default and no
  longer warn; a journal whose workflow file is gone does not open and says to
  restore the file or move the journal aside. The band, the board's work items
  and `/gemflow` (and `gemflow status`) name an item's workflow when it is not
  the default.

- **gemflow**: evidence expires. A variable whose `source` is a tool, when it
  takes a value other than its default, is stamped with the work item's
  content fingerprint (the revision's `tree`) — under a branch unit the git
  tree of the working content (every file git does not ignore, written from a
  copy of the index; `.geml` and `node_modules` excluded), so a commit changes
  nothing while an edit, a rebase or a pull does; under a file unit the
  episode file's text — and at the start of each operation a value whose
  content has changed returns to its default in one `cause=expire by=signal`
  revision, which the journal reader and `gemflow verify` accept; the auto
  edges are then evaluated. The dev workflow's `tests-pass` and the video
  workflow's `assets-done`, `no-stale` and `rendered` expire so.

- **gemflow**: a sixth `source`, `{ "elapsed": "<ISO 8601 duration>" }` — the
  clock's evidence: true once the current state has been held that long,
  evaluated whenever the work item is opened and at the start of every
  writing operation, beside `tool` evidence's expiry, and returned to false by every transition and rollback that enters a
  state. A guard that reads it is a timeout ("review has waited two hours").

- **gemflow**: a work item that enters a state marked `final` is closed:
  the state has no transition out, `tool` evidence no longer expires there,
  and the band shows ✓ with the state's title; the gate judges by the uses
  the state declares as in any other, and a person's `rollback` reopens the
  work item. The bundled workflows mark their `done` states final.

- **gemflow**: a workflow is one statechart. A workflow declares
  `geml-statechart/v1` alone and holds one `diagram {format=geml-statechart}`
  block — `initial`, `states`, `vars` and `transitions` as that format
  defines them — with the prompt documents and guard `data` blocks it
  references. Gemflow adds no vocabulary to GEML: its keys are the format's
  attributes, the meta key `flow-unit` (`branch`, the default, or
  `file:<glob>`) is the author's metadata to GEML, and the format and
  runtime rules live with Gemflow, in `integrations/gemflow/spec/`; GEML's
  parsers know nothing of Gemflow. On a state it hangs `prompt` (a
  section loaded on entry), `skills` (handed to the host) and `tools` (the
  uses the state declares — `edit`, `test`, `pr`, `deploy-prod`, words the
  author picks); on a variable, `source` — absent, and the model writes it
  with `set`; `{ "tool": "<use>" }`, the success of a call bound to that use;
  `{ "file": "<glob>" }`; `"committed"`, `"pr-open"`, `"pr-merged"`,
  `"ci-success"`; `"human"`, a person's check — and `note`; on a transition,
  `approval: true` and `note`. A variable with a `source` is evidence the
  model cannot write, default `false`. Three kinds of guard, three
  judges: an object (or a `#id` reference) is the machine's and taken on its
  own, at most one such edge without approval per state; a sentence is the
  model's, taken with `move`; `approval: true` is a person's, on the board or
  with `gemflow advance`. The tool dictionary `tools.geml` beside the
  workflow binds uses to this project's tools in its `for` column
  (`Bash(npm test)` → `test`; a `Bash(…)` key is a pattern, `*` any run, the
  longest literal part wins), so the same workflow on a Rust project binds
  `test` to `cargo test` and changes nothing; a use is usable only in the
  states that declare it, and a tool bound to none follows the dictionary's
  learned `allow` and `deny`, or asks. `gemflow check` reports the
  statechart's `statechart-*` codes and then `flow-attr`, `flow-source`,
  `flow-dup-edge`, `flow-auto-ambiguous`, `flow-auto-cycle`, `flow-unit` and
  `flow-tools`. `.geml/context.geml` carries the stage text, the stage and
  the work item's variables (`data {#vars}`), so
  `geml get .geml/context.geml '#vars["tests-pass"]'` reads one value; writes
  go through the verbs. The model's verbs are three — `status`, `move` and
  `set` (`mcp__gemflow__status`… as Claude Code lists them, `gemflow_status`…
  on dsh and pi, bare over `gemflow mcp`) in place of the five `flow_*` tools:
  `status` carries the stage text, and a rollback is a person's (`gemflow
  rollback`). A `Bash(…)` key without `*` matches a prefix of whole words
  (`Bash(wrangler deploy)` takes `wrangler deploy --env x`, not `wrangler
  deployments list`), and `Bash()` every command. A key no row takes runs
  as usual on every host, unasked: whether a command is safe to run is the
  host's permission system's to judge from its arguments, and the dictionary
  only says which use a call is. The bundled workflows and their
  dictionaries are written so; `integrations/gemflow/spec/checks.json` pins
  each static check.

- **gemflow**: a tool call is attributed to the checkout and work item it acts
  in. The Claude Code hooks module reads the directory each call starts in
  (`$.session.cwd()`: the main loop's shell directory, an isolated subagent's
  worktree) and sends it as `cwd` on `before` and `after`; each simple command
  of an `&&` chain runs where the `cd`s before it took the shell, and an Edit,
  Write or NotebookEdit acts in its file's directory. In the session's checkout
  that is the current work item; in another checkout whose project has a
  workflow, that checkout's current work item, whose journal is started only
  when something is recorded in it; anywhere else no work item — nothing is
  recorded and only the person-only refusal applies; where a `cd` leaves the
  directory unknown (`$…`, `~`, `-`), no signal is written. A test run in a
  worktree, or after a `cd` into one, no longer flips the session's
  `tests-pass`. The band and the main loop's stage text stay the session's
  work item's; a subagent gets its own work item's. Journals live in the main
  working tree's `.geml/journals/` (its copy of the project directory), shared
  by every checkout of the repository, their locks beside them; a project
  outside git keeps its own, and `.geml/context.geml` stays per checkout.
  Under a `file:` unit a command signal goes to the file its command names — a
  check of `episodes/ep02.geml` is ep02's even when ep03 was written last — and
  nowhere when it names several.

- **gemflow**: the agent runtime is renamed for the product it now serves —
  `integrations/geml-agent-runtime` → `integrations/gemflow`, npm `@geml/agent-runtime` →
  `@geml/gemflow` (still unpublished), CLI `geml-agent` → `gemflow`, and the `geml-agent/v1`
  vocabulary is gone — a workflow declares `geml-statechart/v1`, and the dsh tools take the
  `flow_` prefix; the ledger is called the journal. Visible to anyone who tried the branch: the environment variables are
  `GEMFLOW_STATECHART`, `GEMFLOW_VISIBILITY` and `GEMFLOW_JOURNAL_DIR`, the DeepSeek Harness
  config key is `journalDir`, journals live under a `gemflow` directory, and pi agent session
  entries are `gemflow/snapshot`. Journals written under the old names are not read.

- **gemflow**: one supervisor, two hosts. Every gate decision moves into
  `src/core/supervisor.ts`, which knows nothing about its host; `src/hosts/dsh/`
  keeps the Cordis plugin and `src/hosts/pi/` adds a pi agent extension, and each is now
  an `exports` subpath (`@geml/gemflow/dsh`, `/pi`) so an install with one
  harness never resolves the other's packages — both host families are optional
  peers. On pi agent, the journal is written twice: to the same `.geml` file, and to one
  session entry per block, which is what lets a forked session inherit the chain
  (a file cannot express a tree). Two gates are weaker there and both are
  documented: the `to` enum names every target in the statechart because a pi agent tool
  cannot be re-registered mid-session, and the state instruction plus snapshot
  refresh once per user turn rather than once per step.

- **gemflow**: `gemflow run` starts dsh with the bundle in place. Publishing is blocked
  on a parser release that carries `geml-statechart/v1`: the package carries `@geml/geml`
  as a `file:` dependency until then.

- **gemflow**: the DeepSeek Harness plugin lands — per-state tool restriction and a
  monotonic guard, the three `flow_*` tools regenerated on every state change, the
  state's instruction and a few-hundred-byte snapshot injected per step, `pause`/`final`
  concluding the turn, `rollback-on-error`, and a blind-appended hash-chained journal that
  resume reads back only after verifying it.

- **gemflow**: a new package, `integrations/gemflow` (npm `@geml/gemflow`, not yet published), beside `integrations/dsh-plugin`, which stays its own package, `@geml/dsh-plugin`. `gemflow check|snapshot|verify|export|init` CLI. Design: `docs/design/specs/2026-09-14-geml-agent-runtime-design.md`.
