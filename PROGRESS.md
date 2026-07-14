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

## In flight NOW: mustapi field gate (acceptance)

- BEFORE (measured on the existing pre-SFC codemap in
  C:\IdeaProjects\mustapi\.geml-code-graph): console=3, editor=51,
  supervisor=3 `=== code` blocks; name-lookup contains ZERO "vue".
  (Task-stated baseline 5/74/5 counts a different derivation; I compare
  code-block counts before/after consistently.)
- Stale rust-only `_index/refresh.json` deleted (build re-records).
- `node <worktree>/geml-parser/dist/geml.js codemap build --root . --history`
  from mustapi root JUST COMPLETED exit 0 (rust 41.7s with known
  rust-analyzer duplicate-symbol warnings — pre-existing; supervisor
  virtualized 16/16 vue). NEXT: parse tail of build output, run
  `codemap verify` (must exit 0), count per-app AFTER, grep 5-10 pinned
  relations (SearchPalette.vue `@click="commit(it)"` →
  `SearchPalette.template→commit`; DebugPanel `@click="run"`; a vue method
  → composable/util cross-file edge; svelte covered by unit tests — mustapi
  has no svelte), then SKILL.md rewrite (retire the .vue-gap line, honest
  residuals below) + final push.

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
