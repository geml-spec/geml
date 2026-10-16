# Gemflow A1 — Baseline and Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `feat/geml-agent-runtime` up to date with `main` and rename the runtime to Gemflow (`geml-agent/v1` → `geml-flow/v1`, ledger → journal, `@geml/agent-runtime` → `@geml/gemflow`) with every existing test still green.

**Architecture:** Pure mechanics, no behaviour change. One merge commit, then three rename commits: the parser's vocabulary entry (TDD), the runtime package (scripted, tests ride along), and the repository's living docs and CI paths. The profile document moves with the package but keeps its current content; rewriting it to the new vocabulary is plan A2.

**Tech Stack:** TypeScript (tsc), Node ≥ 22, `node:test`; the parser's single runner `geml-parser/test/all.mjs`; Python 3 for the one-off rename script.

**Spec:** `docs/design/specs/2026-10-11-gemflow-design.md` §3 (package and directory), §4.2 (rename table), §6 items 1–2 and 6.

**Series:** A1 (this) → A2 vocabulary, statechart checks and journal → A3 signals, supervisor, Stagehand, unit, backlog, CLI → B Claude Code shell + dev workflow → C video workflow. Each plan leaves both test suites green.

**Working directory:** `/Users/xiong/software/geml`, branch `feat/geml-agent-runtime`, checked out in place (no worktree). Another session may be working on `main` in the same repository: never switch branches, never run `git checkout main`, never `git stash`.

**Conventions that apply to every commit:** English commit messages; no `Co-Authored-By` or "Generated with" lines; never bump a version number; run an expensive suite once and take output and exit code from that same run.

---

## File map

| Path | Change |
|---|---|
| everything `main` changed since `7fe644a` | Task 1: merged in |
| `geml-parser/src/profiles.ts` | Task 2: `geml-agent/v1` entry → `geml-flow/v1` |
| `geml-parser/test/profiles.test.mjs` | Task 2: the three `geml-agent/v1` tests → `geml-flow/v1` |
| `integrations/geml-agent-runtime/` → `integrations/gemflow/` | Task 3: `git mv`, then scripted renames inside |
| `integrations/gemflow/src/core/ledger.ts` → `journal.ts` | Task 3 |
| `integrations/gemflow/src/hosts/pi/ledger-entries.ts` → `journal-entries.ts` | Task 3 |
| `integrations/gemflow/test/ledger.test.mjs` → `journal.test.mjs` | Task 3 |
| `spec/profiles/geml-agent/` → `spec/profiles/geml-flow/` (files renamed `geml-flow-profile*.md`) | Task 3 |
| `spec/profiles/README.md`, `README.md`, `README_CN.md`, `docs/PUBLISHING.geml` (+ regenerated `docs/PUBLISHING.md`), `docs/PUBLISHING_CN.md`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.claude/hooks/geml-autocommit.mjs`, `geml-parser/test/skill-install.test.mjs`, `CHANGELOG.md` | Task 4 |

Left alone on purpose: `docs/design/plans/2026-09-*` and `docs/design/specs/2026-09-14-geml-agent-runtime-design.md` (records of the earlier phase), the gemflow spec itself (its §4.2 names the old spellings on purpose), and every `.gemlhistory` sidecar.

---

### Task 1: Merge `main` into the branch

**Files:** whatever `git merge` reports as conflicted. Known in advance: `CHANGELOG.md`, `README.md`, `geml-parser/src/profiles.ts` (all three changed on both sides).

- [ ] **Step 1: Confirm the starting point**

Run:
```bash
git status --short --branch | head -3
git log --oneline -1
```
Expected: `## feat/geml-agent-runtime...origin/feat/geml-agent-runtime [ahead 2]`, head `c13dd76 docs(design): Gemflow design spec`. Untracked `docs/research/`, `geml-parser-rs/`, `integrations/chrome-geml-viewer/`, `integrations/geml-mcp-worker/` are expected and harmless (build output and research notes).

- [ ] **Step 2: Merge**

Run:
```bash
git merge --no-ff main -m "Merge branch 'main' into feat/geml-agent-runtime"
```
Expected: either a clean merge, or `CONFLICT` lines naming files. If clean, skip to Step 4.

- [ ] **Step 3: Resolve conflicts with these rules**

- `CHANGELOG.md`: keep every released section from `main` exactly as `main` has it. The branch's `agent-runtime` bullets were written under `## [Unreleased]`; put them under `main`'s `## [Unreleased]` heading (create it directly above the newest release heading if `main` has none), keeping their order.
- `geml-parser/src/profiles.ts`: keep every entry from both sides. The branch adds one entry, `"geml-agent/v1"`, at the end of `PROFILES`; it must sit after all of `main`'s entries, inside the same object literal.
- `README.md` / `README_CN.md`: take `main`'s text, then re-apply the branch's agent-runtime paragraph(s) where they were (search the branch side for `geml-agent-runtime`).
- `integrations/dsh-plugin/` stays as its own package, exactly as `main` has it (decided 2026-10-11): the branch once moved it into the runtime, but it is now a separate directory beside the runtime, not merged into it. Restore every file of it from `main` with `git checkout main -- integrations/dsh-plugin` (this resolves the modify/delete conflicts on its `README.md`, `README.zh.md` and `package.json` too). The runtime keeps its own copies of the skills and cordis patch; where git carried `main`'s edits to `dsh-plugin` files over to the runtime's renamed copies, keep them.
- Where a file lists packages (`.github/workflows/ci.yml`, `.github/dependabot.yml`, `geml-parser/test/skill-install.test.mjs`, `README.md`, `README_CN.md`, `docs/PUBLISHING*`), keep both: every `dsh-plugin` entry `main` has, plus the branch's `geml-agent-runtime` entry as a separate item.
- Modify/delete on `docs/illustrated/*`: take `main`'s deletion (the website moved out of this repository).
- Any other file: prefer `main` unless the hunk touches `integrations/geml-agent-runtime/`, `spec/profiles/geml-agent/` or `geml-agent`; for those, prefer the branch.

After editing each file, run `git add <file>`. Then:
```bash
git diff --name-only --diff-filter=U
```
Expected: no output (nothing left unmerged). Then `git commit --no-edit`.

- [ ] **Step 4: Build and run the parser suite once**

Run:
```bash
cd geml-parser && npm run build && node test/all.mjs > /tmp/gemflow-a1-parser.log 2>&1; echo "exit=$?"; tail -2 /tmp/gemflow-a1-parser.log; cd ..
```
Expected: `exit=0` and a final line `<N> suites passed in …`. If a suite fails, read its block in the log; fix only merge mistakes (a dropped profile entry, a duplicated CHANGELOG heading), commit the fix as `fix: merge leftovers from main`, rerun.

- [ ] **Step 5: Build and run the runtime suite once**

Run:
```bash
cd integrations/geml-agent-runtime && npm install --no-audit --no-fund && npm test > /tmp/gemflow-a1-runtime.log 2>&1; echo "exit=$?"; grep -E "^# (pass|fail)" /tmp/gemflow-a1-runtime.log; cd ../..
```
Expected: `exit=0`, `# fail 0`. (`npm install` refreshes the `file:../../geml-parser` dependency link against the merged parser.)

- [ ] **Step 6: Confirm the two fixes from `main` arrived**

Run:
```bash
grep -c '"mcpServers"' integrations/codex-plugin/.mcp.json
grep -n '"authentication"' .agents/plugins/marketplace.json
```
Expected: `1`, and `"authentication": "ON_USE"`.

---

### Task 2: The parser's vocabulary entry becomes `geml-flow/v1`

**Files:**
- Modify: `geml-parser/src/profiles.ts` (the `"geml-agent/v1"` entry, at the end of `PROFILES`)
- Test: `geml-parser/test/profiles.test.mjs` (the three tests whose names start with `geml-agent/v1：`)

The entry's types and keys are renamed one for one. The keys plan A2 adds (`context`, `strict`, `auto`, `by`, `signal`, `flow-deviation`) are not part of this task.

- [ ] **Step 1: Rewrite the three tests to the new names**

In `geml-parser/test/profiles.test.mjs`, replace the three tests named `geml-agent/v1：五个 agent-* 类型被放行，声明与否只差诊断`, `geml-agent/v1：agent-state / agent-transition 的体是 flow，其余是 raw` and `geml-agent/v1：放行的属性键只挂在各自类型上` with:

```js
test("geml-flow/v1：五个 flow-* 类型被放行，声明与否只差诊断", () => {
  const doc = (declared) =>
    "=== meta\n" + (declared ? 'profile = "geml-flow/v1"\n' : "") + 'title = "t"\n===\n\n'
    + '=== flow-vars {#vars}\n{"type":"object","properties":{}}\n===\n\n'
    + '=== flow-state {#a initial tools="read_file" vars=none rollback-on-error}\nDo the thing.\n===\n\n'
    + '=== flow-state {#b final}\nStop.\n===\n\n'
    + '=== flow-transition {#a-b from=#a to=#b requires=#g approval}\nGo.\n===\n\n'
    + '=== data {#g format=json}\n{"type":"object"}\n===\n\n'
    + '=== flow-snapshot {#rev-0 rev=0 state=#a cause=enter hash="sha256:00" at="2026-01-01T00:00:00Z"}\n{}\n===\n\n'
    + '=== flow-refused {#refused-1 rev=0 at="2026-01-01T00:00:00Z" tool=flow_set}\n{"reason":"r","diagnostics":[]}\n===\n';
  assert.deepEqual(parse(doc(true)).diagnostics, [], "declared: no diagnostics at all");
  const undeclared = parse(doc(false)).diagnostics.map((d) => d.code);
  assert.equal(undeclared.filter((c) => c === "unknown-block-type").length, 6, "undeclared: every flow-* block warns");
});

test("geml-flow/v1：flow-state / flow-transition 的体是 flow，其余是 raw", () => {
  const src = '=== meta\nprofile = "geml-flow/v1"\n===\n\n'
    + '=== flow-state {#a initial}\nRead [[#a]] first.\n\n- one\n- two\n===\n\n'
    + '=== flow-vars {#v}\n{"type":"object"}\n===\n';
  const d = parse(src);
  const state = d.children.find((b) => b.kind === "block" && b.type === "flow-state");
  const vars = d.children.find((b) => b.kind === "block" && b.type === "flow-vars");
  assert.equal(state.mode, "flow");
  assert.equal(state.children.some((c) => c.kind === "list"), true, "flow body parsed the list");
  assert.equal(vars.mode, "raw");
  assert.deepEqual(vars.raw, ['{"type":"object"}']);
});

test("geml-flow/v1：放行的属性键只挂在各自类型上", () => {
  const v = vocabularyFor(meta({ profile: "geml-flow/v1" }));
  assert.equal(v.attrs.get("flow-state")?.has("rollback-on-error"), true);
  assert.equal(v.attrs.get("flow-transition")?.has("requires"), true);
  assert.equal(v.attrs.get("flow-snapshot")?.has("restores"), true);
  assert.equal(v.attrs.get("flow-refused")?.has("tool"), true);
  assert.equal(v.attrs.get("flow-vars"), undefined, "flow-vars declares no keys");
  assert.equal(v.attrs.get("flow-state")?.has("requires"), false);
  assert.equal(vocabularyFor(meta({ profile: "geml-agent/v1" })).types.has("flow-state"), false, "the old name is not an alias");
});
```

- [ ] **Step 2: Run the profiles suite and watch it fail**

Run:
```bash
cd geml-parser && npm run build >/dev/null && node test/profiles.test.mjs 2>&1 | tail -5; cd ..
```
Expected: an assertion failure in `geml-flow/v1：五个 flow-* 类型被放行…` (the declared document reports `unknown-block-type`, because the vocabulary is still `geml-agent/v1`). `vocabularyFor(...)` returns a `Vocabulary` whose `types` is a `Set<string>` (`geml-parser/src/profiles.ts`, `interface Vocabulary`), so the last assertion is well-typed.

- [ ] **Step 3: Rename the entry**

In `geml-parser/src/profiles.ts`, replace the whole `"geml-agent/v1": { … },` entry and the comment block directly above it with:

```ts
  // spec/profiles/geml-flow/geml-flow-profile.md — Gemflow's workflow statechart
  // and journal vocabulary (docs/design/specs/2026-10-11-gemflow-design.md §4).
  // Two bodies are flow on purpose: a state's body is the prose the model is
  // given while in that state, a transition's body is how the model is told
  // about it — both want reference checking and rendering. The other three
  // carry JSON the runtime parses itself, so they stay raw.
  "geml-flow/v1": {
    // `since` 留空：这份词汇表还没随任何一个解析器版本发出去（CHANGELOG 里它在
    // Unreleased 下），填一个尚不存在的版本号就是把索引表写成假话。
    state: "draft",
    types: ["flow-vars", "flow-state", "flow-transition", "flow-snapshot", "flow-refused"],
    bodies: { "flow-state": "flow", "flow-transition": "flow" },
    attrs: {
      "flow-state": ["initial", "final", "pause", "tools", "vars", "rollback-on-error"],
      "flow-transition": ["from", "to", "requires", "approval"],
      "flow-snapshot": ["rev", "state", "cause", "parent", "hash", "at", "call", "from", "restores"],
      "flow-refused": ["rev", "at", "tool", "call"],
    },
  },
```

- [ ] **Step 4: Run the profiles suite and watch it pass**

Run:
```bash
cd geml-parser && npm run build >/dev/null && node test/profiles.test.mjs 2>&1 | tail -2; cd ..
```
Expected: last line `<N> passed`, no assertion output.

- [ ] **Step 5: Run the whole parser suite once**

Run:
```bash
cd geml-parser && node test/all.mjs > /tmp/gemflow-a1-parser.log 2>&1; echo "exit=$?"; tail -1 /tmp/gemflow-a1-parser.log; cd ..
```
Expected: `exit=0`. A failure that names `geml-agent` outside `profiles.test.mjs` belongs to Task 4; note it and continue (Task 4 fixes `skill-install.test.mjs`).

- [ ] **Step 6: Commit**

```bash
git add geml-parser/src/profiles.ts geml-parser/test/profiles.test.mjs
git commit -m "feat(profiles): the geml-agent/v1 vocabulary is renamed geml-flow/v1

The statechart and journal vocabulary now serves Gemflow, whose workflows
cover human and CI steps as well as the agent's. Types and keys are renamed
one for one (agent-* -> flow-*); the old name is not kept as an alias, as it
never shipped in a release."
```

---

### Task 3: The runtime package becomes `@geml/gemflow`

**Files:**
- Move: `integrations/geml-agent-runtime/` → `integrations/gemflow/`
- Move: `integrations/gemflow/src/core/ledger.ts` → `integrations/gemflow/src/core/journal.ts`
- Move: `integrations/gemflow/src/hosts/pi/ledger-entries.ts` → `integrations/gemflow/src/hosts/pi/journal-entries.ts`
- Move: `integrations/gemflow/test/ledger.test.mjs` → `integrations/gemflow/test/journal.test.mjs`
- Move: `spec/profiles/geml-agent/` → `spec/profiles/geml-flow/`, with `geml-agent-profile.md` → `geml-flow-profile.md` and `geml-agent-profile_CN.md` → `geml-flow-profile_CN.md`
- Modify (scripted): every text file under the two moved directories

The existing tests are the safety net: they move and are renamed by the same script, and must pass unchanged in meaning.

- [ ] **Step 1: Move the directories and files**

Run:
```bash
git mv integrations/geml-agent-runtime integrations/gemflow
git mv integrations/gemflow/src/core/ledger.ts integrations/gemflow/src/core/journal.ts
git mv integrations/gemflow/src/hosts/pi/ledger-entries.ts integrations/gemflow/src/hosts/pi/journal-entries.ts
git mv integrations/gemflow/test/ledger.test.mjs integrations/gemflow/test/journal.test.mjs
git mv spec/profiles/geml-agent spec/profiles/geml-flow
git mv spec/profiles/geml-flow/geml-agent-profile.md spec/profiles/geml-flow/geml-flow-profile.md
git mv spec/profiles/geml-flow/geml-agent-profile_CN.md spec/profiles/geml-flow/geml-flow-profile_CN.md
rm -rf integrations/gemflow/dist
git status --short | grep -c '^R'
```
Expected: the last line prints a count greater than 40 (every tracked file under the package and the profile shows as renamed). `node_modules/` moved with the directory and stays untracked.

- [ ] **Step 2: Write the rename script**

Create `/tmp/gemflow-rename.py` (not committed) with exactly this content:

```python
#!/usr/bin/env python3
"""One-off rename for Gemflow plan A1. Usage: gemflow-rename.py <file>..."""
import re
import sys

# Order matters: longer and more specific spellings first.
PAIRS = [
    ("@geml/agent-runtime", "@geml/gemflow"),
    ("integrations/geml-agent-runtime", "integrations/gemflow"),
    ("geml-agent-runtime", "gemflow"),
    ("spec/profiles/geml-agent/", "spec/profiles/geml-flow/"),
    ("geml-agent-profile", "geml-flow-profile"),
    ("geml-agent/v1", "geml-flow/v1"),
    ("geml-agent ledger", "gemflow journal"),
    ("[geml-agent]", "[gemflow]"),
    ("geml-agent", "gemflow"),
    ("agent_transition", "flow_transition"),
    ("agent_set", "flow_set"),
    ("agent_rollback", "flow_rollback"),
    ("agent-vars", "flow-vars"),
    ("agent-state", "flow-state"),
    ("agent-transition", "flow-transition"),
    ("agent-snapshot", "flow-snapshot"),
    ("agent-refused", "flow-refused"),
    ("AgentCode", "FlowCode"),
    ("AgentDiagnostic", "FlowDiagnostic"),
    ("ledger-entries", "journal-entries"),
    ("LedgerMeta", "JournalMeta"),
    ("renderLedgerHead", "renderJournalHead"),
    ("readLedger", "readJournal"),
    ("verifyLedger", "verifyJournal"),
    ("LEDGER", "JOURNAL"),
    ("Ledger", "Journal"),
    ("ledger", "journal"),
    ("台账", "journal"),
]
CODES = re.compile(
    r"\bagent-(no-initial|many-initial|bad-ref|final-outgoing|dup-edge|requires-schema|"
    r"unknown-var|unreachable|dead-end|unknown-tool)\b"
)

changed = 0
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as f:
        before = f.read()
    after = before
    for old, new in PAIRS:
        after = after.replace(old, new)
    after = CODES.sub(lambda m: "flow-" + m.group(1), after)
    if after != before:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(after)
        changed += 1
print(f"rewrote {changed} file(s)")
```

- [ ] **Step 3: Run it over the two moved directories**

Run:
```bash
git ls-files integrations/gemflow spec/profiles/geml-flow | grep -v -E '\.(png|jpg|zip)$' | xargs python3 /tmp/gemflow-rename.py
git grep -n -E 'geml-agent|agent_(transition|set|rollback)|agent-(vars|state|transition|snapshot|refused)|[Ll]edger' -- integrations/gemflow spec/profiles/geml-flow | head
```
Expected: `rewrote <N> file(s)` with N above 40, then no output from `git grep`.

- [ ] **Step 4: Check the package manifest by eye**

Run:
```bash
node -e 'const p=require("./integrations/gemflow/package.json");console.log(p.name,JSON.stringify(p.bin),p.repository.directory)'
grep -n '"name"' integrations/gemflow/package-lock.json | head -2
```
Expected: `@geml/gemflow {"gemflow":"dist/cli.js"} integrations/gemflow`, and both lock-file `name` lines read `@geml/gemflow`. Leave `version` as it is.

- [ ] **Step 5: Build and run the runtime suite once**

Run:
```bash
cd integrations/gemflow && npm install --no-audit --no-fund && npm test > /tmp/gemflow-a1-runtime.log 2>&1; echo "exit=$?"; grep -E "^# (pass|fail)" /tmp/gemflow-a1-runtime.log; cd ../..
```
Expected: `exit=0`, `# fail 0`, and the pass count equal to the one Task 1 Step 5 printed.

If `tsc` reports an unknown export, a name in `src/index.ts` still points at `./core/ledger.js`; the script changes it to `./core/journal.js`, so check that the file was in the `git ls-files` list. If a test fails on a string such as `[gemflow] the statechart changed…`, the test and the source were both rewritten by the same pairs; read the failing assertion and fix the one place the script could not see (a string built by concatenation), then rerun.

- [ ] **Step 6: Run the walkthrough as a smoke test**

Run:
```bash
cd integrations/gemflow && npm run walkthrough > /tmp/gemflow-a1-walk.log 2>&1; echo "exit=$?"; tail -3 /tmp/gemflow-a1-walk.log; cd ../..
```
Expected: `exit=0`. The output names `gemflow` and `flow_transition`, never `geml-agent`.

- [ ] **Step 7: Commit**

```bash
git add -A integrations/gemflow spec/profiles/geml-flow integrations/geml-agent-runtime spec/profiles/geml-agent
git commit -m "refactor: geml-agent-runtime becomes gemflow

integrations/geml-agent-runtime -> integrations/gemflow, npm @geml/gemflow,
CLI gemflow; the vocabulary's block types, verbs and diagnostic codes take
the flow- prefix, and the ledger is called the journal throughout
(journal.ts, journal-entries.ts, readJournal, verifyJournal). The profile
directory moves to spec/profiles/geml-flow; its content is rewritten to the
new vocabulary in the next plan. No behaviour changes."
```

---

### Task 4: Living docs, CI and the parser's install test follow the rename

**Files:**
- Modify: `spec/profiles/README.md`, `README.md`, `README_CN.md`, `docs/PUBLISHING.geml`, `docs/PUBLISHING_CN.md`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.claude/hooks/geml-autocommit.mjs`, `geml-parser/test/skill-install.test.mjs`
- Regenerate: `docs/PUBLISHING.md`
- Modify by hand: `CHANGELOG.md`

- [ ] **Step 1: List what still names the old spellings**

Run:
```bash
git grep -l -E 'geml-agent|agent-runtime|agent_(transition|set|rollback)|agent-(vars|state|transition|snapshot|refused)' -- . ':!docs/design/plans/2026-09-*' ':!docs/design/specs/2026-09-14-geml-agent-runtime-design.md' ':!docs/design/specs/2026-10-11-gemflow-design.md' ':!CHANGELOG.md' ':!*.gemlhistory'
```
Expected: the nine files in this task's **Files** list (after the merge there may be one or two more, such as a `README` section `main` added; treat any extra file the same way).

- [ ] **Step 2: Rewrite them with the same script**

Run (the command reuses Step 1's list):
```bash
git grep -l -E 'geml-agent|agent-runtime|agent_(transition|set|rollback)|agent-(vars|state|transition|snapshot|refused)' -- . ':!docs/design/plans/2026-09-*' ':!docs/design/specs/2026-09-14-geml-agent-runtime-design.md' ':!docs/design/specs/2026-10-11-gemflow-design.md' ':!CHANGELOG.md' ':!*.gemlhistory' | xargs python3 /tmp/gemflow-rename.py
```
Expected: `rewrote <N> file(s)`, N equal to Step 1's count.

- [ ] **Step 3: Read the README and PUBLISHING diffs by eye**

Run:
```bash
git diff -- README.md README_CN.md docs/PUBLISHING.geml docs/PUBLISHING_CN.md spec/profiles/README.md | head -120
```
Check: every changed line still reads as a sentence; a word like `journal` in Chinese prose sits where `台账` was. Fix any sentence the mechanical rename made awkward with a direct edit. Do not touch lines the rename did not change.

- [ ] **Step 4: Regenerate `docs/PUBLISHING.md`**

Run:
```bash
node geml-parser/dist/geml.js docs/PUBLISHING.geml --to md > /tmp/PUBLISHING.md 2>/dev/null && mv /tmp/PUBLISHING.md docs/PUBLISHING.md
node geml-parser/dist/geml.js check docs/PUBLISHING.geml; echo "check exit=$?"
git diff --stat -- docs/PUBLISHING.md
```
Expected: `check exit=0`, and `docs/PUBLISHING.md` changed only where `docs/PUBLISHING.geml` did.

- [ ] **Step 5: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add this bullet directly above the first existing `agent-runtime` bullet:

```markdown
- **gemflow**: the agent runtime is renamed for the product it now serves —
  `integrations/geml-agent-runtime` → `integrations/gemflow`, npm
  `@geml/agent-runtime` → `@geml/gemflow` (still unpublished), CLI `geml-agent` →
  `gemflow`, and the `geml-agent/v1` vocabulary → `geml-flow/v1` (types and verbs take
  the `flow-` / `flow_` prefix; the ledger is called the journal). The earlier
  `agent-runtime` bullets below describe the same work under its old names.
```

- [ ] **Step 6: Run both suites once**

Run:
```bash
cd geml-parser && npm run build >/dev/null && node test/all.mjs > /tmp/gemflow-a1-parser.log 2>&1; echo "parser exit=$?"; tail -1 /tmp/gemflow-a1-parser.log; cd ..
cd integrations/gemflow && npm test > /tmp/gemflow-a1-runtime.log 2>&1; echo "runtime exit=$?"; grep -E "^# fail" /tmp/gemflow-a1-runtime.log; cd ../..
```
Expected: `parser exit=0`, `runtime exit=0`, `# fail 0`.

- [ ] **Step 7: Confirm nothing outside the records still uses the old names**

Run the Step 1 command again.
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add spec/profiles/README.md README.md README_CN.md docs/PUBLISHING.geml docs/PUBLISHING.md docs/PUBLISHING_CN.md .github/workflows/ci.yml .github/dependabot.yml .claude/hooks/geml-autocommit.mjs geml-parser/test/skill-install.test.mjs CHANGELOG.md
git commit -m "docs: the repository follows the gemflow rename

README, PUBLISHING, the profile index, CI's working directory, Dependabot's
package path, the autocommit hook's fixture exclusion and the parser's
skill-install test name integrations/gemflow and geml-flow/v1."
```

---

## Done when

- `git log --oneline -5` shows the merge and the three commits above, nothing pushed.
- Both suites pass from one run each (Task 4 Step 6).
- `git grep` from Task 4 Step 1 prints nothing.
- `ls integrations/gemflow/src/core/` lists `journal.ts` and no `ledger.ts`.
