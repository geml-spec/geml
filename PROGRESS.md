# feat/codemap-sfc — progress log (kill-safe handover)

Branch: `feat/codemap-sfc` (forked from feat/codemap-rust @ 3c41352).
Goal: Vue + Svelte SFC support for geml-code-graph via FULL virtualization
(shadow TS + line-map sidecars + scip remap). A successor must be able to
resume from this file + the commit history alone.

## 2026-07-14 — decisions locked by spikes (all four succeeded)

1. **npx -p resolution mechanism (PROVEN on this Windows box)**:
   `npx -y -p <pkgs> node <script>` does NOT set NODE_PATH (plain import
   fails). It PREPENDS `<npm-cache>\_npx\<hash>\node_modules\.bin` to PATH.
   Ship: find the PATH entry matching `_npx` + trailing `\.bin`, strip
   `\.bin`, `createRequire(<dir>/x.js)`. Fallbacks: target project's own
   node_modules (walk up from GEML_SRC), then this script's context.
   **typescript must be pinned `typescript@5`** — typescript@latest is 7.0.2
   and @vue/language-core rejects it.
2. **Volar API (@vue/language-core, npx installs 3.3.7)**:
   `createVueLanguagePlugin(ts, {allowJs:true}, vueOptions, id=>id)
   .createVirtualCode(absPosix, "vue", ts.ScriptSnapshot.fromString(text))`,
   then `forEachEmbeddedCode(code)` and take the embedded with id
   `script_(ts|tsx|js|jsx)`. vueOptions: `resolveVueCompilerOptions({})` on
   2.x, `getDefaultCompilerOptions()` on 3.x (guard both — 3.x REMOVED
   resolveVueCompilerOptions). The embedded text = verbatim <script> +
   template projection; its `mappings` ({sourceOffsets, generatedOffsets,
   lengths}) become the line map. KEY empirical fact: the generated
   `[save,count,reset,]` usage-array refs are DIRECT references to the real
   function symbols and map back to TEMPLATE usage lines — that is what
   makes `@click="save"` an edge. Template projection is TOP-LEVEL
   statements (no wrapper fn) in both 2.2.12 and 3.3.7.
3. **svelte2tsx (0.7.57)**: `svelte2tsx(text, {filename, isTsFile,
   mode:"ts"})` → `{code, map}` (source-map v3; hand-rolled VLQ decoder, no
   deps). EVERYTHING lands inside generated `$$render()`, so user functions
   are scip `local N` symbols with NO display_name and NO enclosing_range —
   the adapter admits function-shaped locals by reading the shadow text at
   the def range (name) + a small brace scan (span).
4. **scip-typescript over a virtual dir (PROVEN)**: files OUTSIDE the
   project root (listed via `../..` relative paths in tsconfig `files`) ARE
   indexed; their doc paths come back `../`-relative (normalize via
   resolve/relative against remapDir); their SYMBOL descriptors are
   package-root-relative — identical to a plain run's, so cross-job anchor
   dedupe works. `rootDirs: [".", <rel src>]` makes relative imports
   resolve across virtual/real trees; shadow naming `App.vue.ts` makes
   `import './App.vue'` resolve to the shadow by TS extension probing.

## Shipped (each committed + pushed at completion)

- `07d7480` virtualizer `geml-parser/codemap/sfc-virtualize.mjs`
  (GEML_SRC/GEML_OUT env; per SFC: shadow + `<shadow>.map.json`
  {original, framework, component, lines:[[gen,orig]…] 1-based first-wins,
  regions:[{name:"template",start,end}] original-space}; one
  sfc-manifest.json; synthetic tsconfig: explicit files only, rootDirs,
  paths → every node_modules up from GEML_SRC; svelte shims copied in when
  findable).
- `a3dbda6` detect: EXT_LANG += vue/svelte (TS family, refresh triggers);
  per-group sfc flag = extension present AND framework in the group's own
  package.json deps/devDeps (injectable readJson); sfc jobs return a `pre`
  (virtualizer) step + scip with cwd=virtualDir (replaces the plain
  per-project run); npx -p set per framework.
- `ea42c30` build: runs pre before scip; virtualizer failure → warn + fall
  back to the plain (sfc-less) job; recipe records env-prefixed virtualize
  step + `cd <virtual> && npx scip-typescript` + `--remap` on the build
  step; `--remap` also parses as explicit CLI flag (refresh replays).
- `909e335` adapter scip.mjs: `extract({raw, root, remapDir})` — shadow
  docs remap to original path+line via sidecars; unmappable = dropped
  (never misattributed); scaffolding inside the virtual dir dropped;
  generated names (`$$*`, `__VLS_*`, `__sveltets*`) never surface;
  synthetic `<Component>.template` node (anchor `sfc:<orig>#template`)
  gains the template-region edges; svelte local admission as above;
  generated-helper unresolved noise filtered. Without remapDir: byte-level
  unchanged behavior.
- `397298a` tests: 8 new (detect flag ×4, sfc indexerCommand, remap unit
  over synthesized scip + hand-built virtual dir, inert-remapDir, npx-gated
  live Volar smoke). Suite 58/58 green. Full `npm test` green.
  `coverage:check` green FROM POWERSHELL (93.45/83.34/94.33/93.45 ≥
  90/80/92/90) — from Git Bash in this deep temp worktree it false-fails
  with "tsc not recognized" (cmd.exe 8191-char PATH overflow; predates the
  test/all.mjs fix).

## mustapi field gate: PASSED (2026-07-14)

- BEFORE (measured on the existing pre-SFC codemap): console=3, editor=51,
  supervisor=3 `=== code` blocks; name-lookup contained ZERO "vue".
- Stale rust-only `_index/refresh.json` deleted (build re-records).
- Build exit 0. Virtualized 85/85 .vue, ZERO failures (supervisor 16,
  console 26, editor 43). Six inputs merged; the root sweep's 84 duplicate
  anchors dropped by the merge as designed. 3315 symbols, 16199 edges.
  `codemap verify` exit 0: 50/50 documents, all references resolve.
- AFTER: console=117, editor=157, supervisor=57 code blocks; 362 ".vue"
  entries in name-lookup; 74 distinct `<Component>.template` nodes.
- Pinned relations (grep-verified in the produced docs):
  - `#DebugPanel-template → #run` site `…/DebugPanel.vue:5` (the @click)
  - `#SearchPalette-template → #commit / #moveSel / #kindType`
  - `#ApiEditView-template → #save-2ae422 / #onForceSave / #onPushed …`
  - `#SchedulesView-template → apps--mustapi-editor--composables.geml#describeCron`
    (cross-FILE, cross-container .vue→.ts edge)
  - Nuxt console: `#ApiTree-template → #newApi/#showMenu/#toggleGroup`,
    `#ApiIpAllowlist-template → #emitUpdate`
  - Nuxt supervisor: `#SupervisorLayout-template → #logout`,
    `#oncall-template → #add/#confirmRemove`
  - .vue method→method: `#invoicePillClass → #s`
    (src=apps/mustapi-console/pages/console/billing.vue#L131-136)
  - name-lookup: `ApiTree.template` answers with BOTH apps' ApiTree
    (disambiguated), `describeCron` → composables/cronHumanize.ts.
- Recipe recorded with three virtualize+scip step pairs and `--remap` on
  the build step. NOTE: the recipe's virtualizer path points into THIS
  worktree (same convention as joern's absolute script path — recipes are
  machine-local); therefore the worktree is LEFT IN PLACE. After this
  branch merges/publishes, a rebuild on mustapi re-records against the
  installed geml.
- Known cosmetic pre-existing issue (NOT introduced here): real files
  indexed by both an app job and the root sweep contribute duplicate edge
  ROWS (anchors dedupe, edge rows don't) — e.g. `#buildGroupTree →
  #createsCycle` twice with the same site. Predates this branch (any
  overlapping-input build has it); out of scope.

## Honest residuals (for SKILL.md; verify wording against field results)

- Component-TAG usage is not a call edge (`<Child/>` → no #calls row; the
  import is visible at file level only).
- Nuxt auto-imports (unimported `ref`, auto-registered components) resolve
  to nothing → those refs drop (console/supervisor).
- Vue script-setup TOP-LEVEL calls (incl. computed(() => …) bodies at top
  level) drop — same as module-level calls in plain TS.
- Svelte top-level init calls after function defs: dropped (region rule
  only rescues markup refs).
- Per-line mapping granularity: multiple template refs on one generated
  line share the first mapping's line (site may point at the first row).

## If resuming after a kill

1. `git checkout feat/codemap-sfc && cd geml-parser && npm run build`.
2. Re-run suite: `node test/codemap.test.mjs` (bash OK), coverage from
   PowerShell only.
3. Field gate state: mustapi build done; continue at "verify + counts +
   pins + SKILL.md" above. mustapi's .geml-code-graph is regenerable at
   will (untracked, generated).
