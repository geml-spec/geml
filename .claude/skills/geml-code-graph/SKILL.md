---
name: geml-code-graph
description: >-
  Build, view, update, and navigate a project's call graph as GEML codemap
  documents. Use when asked to see/update/build a project's code graph or
  codemap (看下/更新下 code-graph), when asked "who calls X" / "what does X
  call" / to trace a call chain or impact path, or whenever a
  .geml-code-graph/ directory with index.geml and _index/name-lookup.json
  exists.
  Detects the project's languages itself — never asks the user; viewing ends
  with the browser OPEN on the graph.
---

# Code-graph navigation (codemap profile)

The call graph lives as **text documents, not a database** (profile:
`docs/codemap-profile.md`): one GEML document per container (module / dir /
file), each with ONE meta (`module`, `src`, `entry`, `resolution-default`),
empty-body `code` blocks per method, and up to three CSV edge tables —
`#calls` (out), `#called-by` (in), `#unresolved` (blind spots). The build's
`verify` has checked that every edge reference resolves.

## The moves

```sh
# 1. resolve_name — where does a symbol live
node -e "console.log(JSON.stringify(require('./.geml-code-graph/_index/name-lookup.json')['hashtableFind'],null,1))"
#   → [{"anchor":"c:hashtable.c#hashtableFind(…)","doc":"hashtable.c.geml","id":"hashtableFind"}, …]
#   Multiple entries = real ambiguity (e.g. a .c definition and a .h inline) — inspect each.

# 2. container overview — the module's surface, one glance
head -8 .geml-code-graph/hashtable.c.geml          # meta: entry = the externally-called methods

# 3. open the method block (src= tells you exactly where the code is)
geml get .geml-code-graph/hashtable.c.geml '#hashtableFind'

# 4. forward: what it calls (grep your method's rows; follow doc.geml#id refs)
geml get .geml-code-graph/hashtable.c.geml '#calls'

# 5. reverse: who calls it (aggregated, with file:line sites)
geml get .geml-code-graph/hashtable.c.geml '#called-by'
```

A reference is `#id` (same document) or `sibling.geml#id` (that document, that
block) — `geml get` it the same way. `index.geml` holds the repo-level view:
app entries in its meta, `#modules` / `#module-edges` aggregate tables.

## Reading the tables

| Line | Meaning |
|---|---|
| `#calls` row, empty confidence | resolved at the document's `resolution-default`, high confidence |
| `#calls` row `kind=candidate` | dispatch ambiguity: one of several implementations, right after its main `call` row. Treat the SET as the answer, never just the first |
| `#calls` row confidence `medium`/`low` | the extractor is less sure — say so when reporting |
| `#unresolved` rows (hidden table) | calls the extractor could NOT resolve — **blind spots, not evidence of absence**; fall back to grep when one matters |
| `#called-by` absent for a method | no *resolved* callers. Under `resolution-default = heuristic` that means little; under `cpg` it is strong (but pointer/dynamic dispatch still lands in `#unresolved`) |

Symbol classes: `.accessor` (bean get/set/is leaves — the graph view hides
them by default, tables keep them) · `.leaf` (calls nothing, only called — usually skippable when
tracing logic) · `.test` (test territory) · `.flow-entry` (critical-flow start).

## "看下/更新下 X 项目的 code-graph" — the end-to-end move

The toolkit ships inside the `@geml/geml` package: `geml codemap …`
(without a global install: `npx -y @geml/geml codemap …`; inside the geml
repo: `node geml-parser/dist/geml.js codemap …`).

### Dispatch first — generation is slow, the conversation must not block on it

Indexers take real time (scip: seconds–minutes; Joern on a repo: minutes).
Pick the executor BEFORE starting:

- **Codemap exists, user wants to look** → inline, seconds:
  `serve --background` + open the browser. No subagent.
- **Update asked and `_index/refresh.json` exists** → no subagent either:
  `geml codemap refresh <dir> --background` (detached process, costs the
  conversation nothing). Open the CURRENT graph immediately — serve renders
  live, so when the refresh lands, F5 shows it; say exactly that.
- **geml files must be (re)generated agentically** — first build, no recipe
  recorded, adapters change, or a refresh failed → hand the WHOLE generation
  to ONE subagent (Agent tool; `run_in_background: true` so the user can keep
  working). Its prompt must be self-contained: project root; detect the
  languages per the table below (never ask); the exact indexer +
  `geml codemap build --history` + `geml codemap verify` commands; verify
  MUST exit 0; write `_index/refresh.json` with the exact commands used;
  return container/method/entry counts, verify result, and any language
  gaps. The MAIN conversation does the last mile itself when the subagent
  reports: `serve --background`, open the browser (if an older codemap was
  already on screen, telling the user to F5 is the whole move).

1. **Have a codemap?** `<proj>/.geml-code-graph/index.geml` exists → skip to
   step 4 (view) or step 3 (update was asked). An older `codemap/`/`graph/`
   tree from before the rename is not special: regenerate into
   `.geml-code-graph/` (one build; carry the `*.gemlhistory` sidecars over
   first if they matter) and remove the old directory.
2. **Detect the language(s) — NEVER ask the user.** (Steps 2–3 are the
   generation work — per Dispatch above they normally run inside the
   subagent.) Judge from manifests
   first, then source-file counts (`Glob`/`ls`). Multiple languages with
   real code (≥ a handful of files each) → one build with REPEATED
   `--adapter` groups; the codemap merges them (Java+TS validated).

   | Signal | Indexer → adapter |
   |---|---|
   | `tsconfig.json` / mostly `.ts` `.tsx` `.js` | `npx --yes @sourcegraph/scip-typescript index --output index.scip` (run IN the target repo/subproject) → `--adapter scip --raw index.scip` |
   | React / JSX (`.tsx` `.jsx`) | same scip route, verified tier: `<Child />` render edges, custom-hook calls, and `useReducer(reducer, …)` wiring all resolve high — arrow components (`const Foo = () =>`) included. Indirect dispatch is **absent, not `#unresolved`**: callback-prop calls (`onToggle(…)`), `dispatch()`→reducer case handling, and context-injected functions ride scip locals/members and leave NO edge — grep when one matters. Also invisible: `memo()`/`forwardRef()`-wrapped components (const = call, inner fn is a local) and module-scope `render(<App />)` callers |
   | `Cargo.toml` / `.rs` | `rust-analyzer scip . --output rust.scip` (run IN the crate/workspace root; missing → `rustup component add rust-analyzer` or the rust-analyzer GitHub releases page) → `--adapter scip --raw rust.scip`. Precise tier: rust-analyzer-resolved, cross-file/cross-crate calls included; calls into std/external crates land in `#unresolved` |
   | `pom.xml` / `build.gradle` / `.java` | Joern (locate per **Locating Joern** below; JDK required): `GEML_SRC=<abs-src> GEML_OUT=<abs-raw> GEML_LANG=JAVASRC joern --script <pkg>/codemap/joern-export.sc` → `--adapter joern --raw <raw>`. GEML_LANG takes Joern's `--language` names, UPPERCASE — lowercase `javasrc` fails with "No CPG generator exists" |
   | `.c` / `.h` | same Joern route, `GEML_LANG=NEWC` (valkey-validated) |
   | `.py` / `go.mod` / `.kt` | Joern frontends, `GEML_LANG=PYTHONSRC` etc. (usable tier — SAY SO in your report) |
   | only a code-review-graph `graph.db` | `--db <graph.db>` (heuristic tier — say so) |
   | none of the above | report honestly which languages are unsupported; do not guess |

   `.vue` / `.svelte` SFCs: covered — use the AUTO build (`geml codemap
   build --root <proj>`), not the manual per-indexer route. It virtualizes
   each SFC project (Volar / svelte2tsx, fetched hermetically via npx) into
   shadow TS with line-map sidecars, runs one scip pass over shadows + the
   project's real TS/JS, and attributes every symbol back to the original
   file and line. Template event handlers surface as edges from a synthetic
   `<Component>.template` node (`@click="save"` → `#App-template, #save`;
   mustapi-validated across three Vue apps, 85/85 SFCs). Honest residuals —
   say them when reporting: component-TAG usage (`<Child/>`) is not a call
   edge; Nuxt auto-imports (unimported `ref`, auto-registered components)
   don't resolve, so those references drop; top-level `<script setup>`
   calls, including `computed(() => …)` bodies, drop exactly like
   module-level calls in plain TS; a failed virtualization falls back to
   plain TS indexing and says so.

   **Locating Joern — never hardcode a path.** Resolve it fresh on each run,
   in this order: (1) `joern` on PATH — if `joern --version` works, use it;
   (2) else read `~/.claude/skills/geml-code-graph/config.json` (`{"joern": "<launcher-or-dir>"}`)
   and pass it as `geml codemap build … --joern <path>` (or export `GEML_JOERN`);
   (3) else ASK the user for the joern-cli location (Windows: the folder unzipped
   from joern-cli.zip; macOS/Linux: the joern-install.sh install dir), WRITE it
   into that JSON file, then reuse it. `<path>` may be the launcher itself or the
   directory holding it (`joern.bat` on Windows, `joern` on unix). Ask at most
   once per machine — after that the JSON answers. Mirrors the CLI's own
   `--joern` / `GEML_JOERN` resolution.
3. **Build + verify** (also the "更新" path — builds are deterministic,
   only changed documents are rewritten):

   ```sh
   geml codemap build --adapter scip --raw index.scip --root <proj> \
        --out <proj>/.geml-code-graph --history      # --container module|dir|file: match
                                            # the layout (default dir; flat C repo → file)
   geml codemap verify <proj>/.geml-code-graph       # MUST exit 0 before showing anyone
   ```

   **First successful build: record the recipe** so `refresh` (and the
   commit hook) can replay it — write `<proj>/.geml-code-graph/_index/refresh.json`
   with the EXACT commands you ran:

   ```json
   { "root": "..",
     "steps": ["npx --yes @sourcegraph/scip-typescript index --output index.scip",
               "geml codemap build --adapter scip --raw index.scip --root . --out .geml-code-graph --history",
               "geml codemap verify .geml-code-graph"] }
   ```

   From then on, "更新下" = `geml codemap refresh <proj>/.geml-code-graph` (skips
   itself when git HEAD hasn't moved; log at `_index/refresh.log`).
4. **View — finish with the browser OPEN, not with instructions.**

   ```sh
   geml codemap serve <proj>/.geml-code-graph --background   # detached: SURVIVES the agent session;
                                                    # http://localhost:8140, pages render live
                                                    # from .geml — rebuild + F5, never stale.
                                                    # already-running port → reused, not stacked.
   geml codemap serve <proj>/.geml-code-graph --stop         # stop it (pid: .geml-code-graph/_index/serve.pid)
   geml codemap render <proj>/.geml-code-graph               # serverless alternative: bake .html next to
                                                    # each doc; open file:///…/.geml-code-graph/index.html
   ```

   Always `--background` (a viewer must not die with the session). Then open
   it for the user: Windows `start "" <url>` (or `Start-Process <url>`),
   macOS `open <url>`, Linux `xdg-open <url>`. Port taken by something
   else → pick another (`--port`), open that one.

`index.html` is the module overview; clicking a module opens its page inside
the graph area (nested view). Method pages: click = callee chain, ⊕ on an
entry = full caller chain, breadcrumb walks back up.

## Keep it in sync on every commit (optional per-project hook)

With the recipe recorded (step 3), a Claude Code PostToolUse hook makes any
`git commit` Claude runs in that project refresh the codemap in the
BACKGROUND (never blocks the commit; non-commit commands exit instantly;
projects without `refresh.json` are silently skipped). Add to the project's
`.claude/settings.json`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "geml codemap refresh .geml-code-graph --hook --commit" }
] } ] } }
```

(`.geml-code-graph` = the codemap dir relative to the project root; use an absolute
path if the hook cwd differs.) With `--commit`, the refreshed documents land
as their own follow-up commit — `chore(codemap): refresh for <sha>`, codemap
dir only — so the next push carries code + graph together. It is loop-safe
(the follow-up commit changes no source file, so the refresh it triggers
skips) and it stands down when HEAD moved during the refresh or a merge is in
progress. Drop `--commit` to keep the old behavior: refreshed files stay in
the working tree for you to include in a later commit.

Between commits (editing-time sync), `geml codemap serve <dir> --watch`
re-runs the recipe after 30s of quiet whenever an indexed source file
changes — pages render live, so a browser reload shows the new graph.

Add `--history [-m msg]` to build to snapshot changed documents into
`.gemlhistory` sidecars — then `geml history log .geml-code-graph/<doc>.geml` shows
the graph's evolution and `geml revert .geml-code-graph/<doc>.geml '#method' --to -1`
rolls one method's edges back. Language maturity tiers and the smoke-test
gate: `docs/DESIGN-geml-code-graph.md` §3.4. An MCP wrapper with the same
three moves exists (`geml codemap mcp`, env `GEML_GRAPH_DIR`); the CLI path
works without it.
