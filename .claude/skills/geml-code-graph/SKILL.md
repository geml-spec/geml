---
name: geml-code-graph
description: >-
  Build, view, update, and navigate a project's call graph as GEML codemap
  documents. Use when asked to see/update/build a project's code graph or
  codemap (看下/更新下 code-graph), when asked "who calls X" / "what does X
  call" / to trace a call chain or impact path, or whenever a codemap/ (or
  graph/) directory with index.geml and _index/name-lookup.json exists.
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
node -e "console.log(JSON.stringify(require('./codemap/_index/name-lookup.json')['hashtableFind'],null,1))"
#   → [{"anchor":"c:hashtable.c#hashtableFind(…)","doc":"hashtable.c.geml","id":"hashtableFind"}, …]
#   Multiple entries = real ambiguity (e.g. a .c definition and a .h inline) — inspect each.

# 2. container overview — the module's surface, one glance
head -8 codemap/hashtable.c.geml          # meta: entry = the externally-called methods

# 3. open the method block (src= tells you exactly where the code is)
geml get codemap/hashtable.c.geml '#hashtableFind'

# 4. forward: what it calls (grep your method's rows; follow doc.geml#id refs)
geml get codemap/hashtable.c.geml '#calls'

# 5. reverse: who calls it (aggregated, with file:line sites)
geml get codemap/hashtable.c.geml '#called-by'
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

Symbol classes: `.leaf` (calls nothing, only called — usually skippable when
tracing logic) · `.test` (test territory) · `.flow-entry` (critical-flow start).

## "看下/更新下 X 项目的 code-graph" — the end-to-end move

The toolkit ships inside the `@geml/geml` package: `geml codemap …`
(without a global install: `npx -y @geml/geml codemap …`; inside the geml
repo: `node geml-parser/dist/geml.js codemap …`).

1. **Have a codemap?** `<proj>/codemap/index.geml` exists → skip to step 4
   (view) or step 3 (update was asked).
2. **Detect the language(s) — NEVER ask the user.** Judge from manifests
   first, then source-file counts (`Glob`/`ls`). Multiple languages with
   real code (≥ a handful of files each) → one build with REPEATED
   `--adapter` groups; the codemap merges them (Java+TS validated).

   | Signal | Indexer → adapter |
   |---|---|
   | `tsconfig.json` / mostly `.ts` `.tsx` `.js` | `npx --yes @sourcegraph/scip-typescript index --output index.scip` (run IN the target repo/subproject) → `--adapter scip --raw index.scip` |
   | `pom.xml` / `build.gradle` / `.java` | Joern (`C:\joern\joern-cli` here, JDK required): `GEML_SRC=<abs-src> GEML_OUT=<abs-raw> GEML_LANG=javasrc joern --script <pkg>/codemap/joern-export.sc` → `--adapter joern --raw <raw>` |
   | `.c` / `.h` | same Joern route, `GEML_LANG=c` (valkey-validated) |
   | `.py` / `go.mod` / `.kt` | Joern frontends (usable tier — SAY SO in your report) |
   | only a code-review-graph `graph.db` | `--db <graph.db>` (heuristic tier — say so) |
   | none of the above | report honestly which languages are unsupported; do not guess |

   `.vue` SFCs: scip-typescript cannot index them — cover the TS/JS parts,
   state the gap.
3. **Build + verify** (also the "更新" path — builds are deterministic,
   only changed documents are rewritten):

   ```sh
   geml codemap build --adapter scip --raw index.scip --root <proj> \
        --out <proj>/codemap --history      # --container module|dir|file: match
                                            # the layout (default dir; flat C repo → file)
   geml codemap verify <proj>/codemap       # MUST exit 0 before showing anyone
   ```

   **First successful build: record the recipe** so `refresh` (and the
   commit hook) can replay it — write `<proj>/codemap/_index/refresh.json`
   with the EXACT commands you ran:

   ```json
   { "root": "..",
     "steps": ["npx --yes @sourcegraph/scip-typescript index --output index.scip",
               "geml codemap build --adapter scip --raw index.scip --root . --out codemap --history",
               "geml codemap verify codemap"] }
   ```

   From then on, "更新下" = `geml codemap refresh <proj>/codemap` (skips
   itself when git HEAD hasn't moved; log at `_index/refresh.log`).
4. **View — finish with the browser OPEN, not with instructions.**

   ```sh
   geml codemap serve <proj>/codemap        # background it; http://localhost:8140
                                            # pages render live from .geml — rebuild + F5, never stale
   geml codemap render <proj>/codemap       # serverless alternative: bake .html next to
                                            # each doc; open file:///…/codemap/index.html
   ```

   Then open it for the user: Windows `start "" <url>` (or
   `Start-Process <url>`), macOS `open <url>`, Linux `xdg-open <url>`.
   Port taken → pick another (`--port`), open that one.

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
  { "type": "command", "command": "geml codemap refresh codemap --hook" }
] } ] } }
```

(`codemap` = the codemap dir relative to the project root; use an absolute
path if the hook cwd differs. The refreshed documents land in the working
tree — include them in the next commit.)

Add `--history [-m msg]` to build to snapshot changed documents into
`.gemlhistory` sidecars — then `geml history log codemap/<doc>.geml` shows
the graph's evolution and `geml revert codemap/<doc>.geml '#method' --to -1`
rolls one method's edges back. Language maturity tiers and the smoke-test
gate: `docs/DESIGN-geml-code-graph.md` §3.4. An MCP wrapper with the same
three moves exists (`geml codemap mcp`, env `GEML_GRAPH_DIR`); the CLI path
works without it.
