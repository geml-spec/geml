# DESIGN — codemap foldings (`_index/foldings.geml`)

Status: design (brainstormed 2026-07-15) — pending implementation plan.

## Problem

A codemap container's module *display* name is the module root's repo-relative
path. Real repos wrap module roots in **ceremony directories** that carry no
navigational meaning:

- `integrations/geml-viewer` — geml's own `integrations/` is a management dir,
  not a module layer; the container reads clearer as just `geml-viewer`.
- `crates/core` — a Cargo workspace parks member crates under a bare `crates/`.
- `modules/foo`, `apps/web`, `packages/ui` — the same shape in other ecosystems.

`crates/` was handled by a hardcoded special-case in `normalize.mjs`
(commit 29effab). That does not scale: `integrations/` is repo-specific, no
language convention names it, and hardcoding every ecosystem's grouping dir is
a losing game.

Separately, the *below-the-module-root* ceremony (`src/main/java`, `src/test/*`,
and the shared group-id prefix `com/acme/app`) is stripped by `splitSourceRoot`
+ longest-common-prefix logic inside `normalize.mjs`. That logic is correct but
**implicit and hardcoded** — a non-standard layout (`src/production/java`) can
only be adjusted by editing parser source, and a reader cannot see *why* a path
was shortened. Having some folding driven by a visible file and some done
invisibly by the parser is a split mental model.

## Goal

One **visible, editable** place that declares every list-based ceremony rule for
a repo, seeded automatically on first build, owned by the human thereafter —
mirroring how `_index/refresh.json` already works (written once, never
rewritten by any tool, human-reviewable).

## The three kinds of ceremony

| Kind | Examples | List-able? | Today | Under this design |
|------|----------|-----------|-------|-------------------|
| **Above-root prefix** | `integrations/`, `crates/`, `modules/` | yes | hardcoded `crates` special-case | seeded into `foldings.geml` |
| **Source / test roots** | `src/main/java`, `src/test/*`, `test/` | yes | hardcoded in `splitSourceRoot` | seeded into `foldings.geml` |
| **Shared package prefix (group-id)** | `com/acme/app` | **no** | data-driven common-prefix strip | **stays algorithmic** (a visible note in the file; no list) |

The group-id prefix is *not* a fixed set — it is "strip whatever directory
prefix all of a module's containers share." Turning it into a list would force
the user to enumerate `com/acme/app` per module, which is worse than the
automatic behaviour. It remains an algorithm; only its *existence* is surfaced
in the file (an informational note / a `strip-shared-prefix` toggle defaulting
on).

## The file

- **Path:** `<codemap-out>/_index/foldings.geml` (beside `refresh.json`).
- **Format:** GEML (dogfoods the language; the parser is already imported by
  `render-all.mjs`, `serve.mjs`, `verify.mjs`, `mcp-server.mjs`, so reading it
  adds no new dependency edge).
- **Lifecycle (refresh.json contract):** seeded on first build **iff absent**;
  **read on every build/refresh; never rewritten by any tool.** The human owns
  it after seeding.
- **Robustness:** a parse error or missing file must **never crash the build** —
  warn and fall back to the built-in default rule set (the same lists we seed).
  An empty/rule-less file therefore means "fold nothing extra," an explicit
  off-switch.

### Shape (illustrative — exact block types validated with the `geml` skill at implementation)

```geml
=== meta
title = "codemap foldings"
strip-shared-prefix = true   # group-id / longest-common package prefix (algorithmic)
note = "Ceremony folded out of module display names. Seeded on first build; edit freely — build never rewrites this."
===

=== fold-prefixes
# above the module root: integrations/geml-viewer -> geml-viewer
integrations
crates
===

=== source-roots
# stripped between the module root and its package tree; `*` = one segment
src/main/*
src/main
src
===

=== test-roots
# like source-roots, but the container is grouped under the test/ branch
src/test/*
test
tests
__tests__
spec
specs
===
```

`build.mjs`/`emit.mjs` reads the file via the bundled parser and extracts the
three lists plus the toggle. The precise GEML representation (custom typed
blocks with line bodies vs. a table vs. meta arrays) is chosen at implementation
for whatever the parser extracts most cleanly; the design commitment is "GEML,
three lists + a group-id toggle."

## Matching semantics

Two coordinate spaces, both **leading-anchored**, so neither can reach into the
other:

1. **`fold-prefixes`** apply to the **module-root path** (`mod`). Strip the
   leading run of segments matching a listed prefix (single or multi-segment,
   e.g. `libs/vendor`). `integrations/geml-viewer` → `geml-viewer`.
2. **`source-roots` / `test-roots`** apply to the **module-relative path**
   (`rel`, i.e. the path *below* the module root). Strip the leading matching
   source/test root; a `test-root` match additionally routes the container to
   the `test/` display branch. This reproduces today's `splitSourceRoot`
   behaviour, now driven by the config lists (`*` matches exactly one segment —
   the `java`/`kotlin`/… language dir).

Because `fold-prefixes` only ever see `mod` and source/test roots only ever see
`rel`, **`src/main` is structurally unreachable by a `fold-prefixes` entry** and
vice-versa — the safety the earlier discussion asked for is structural, not a
matter of pattern discipline.

3. **Shared package prefix** (group-id) — after source/test-root stripping, the
   longest common directory prefix within each `(module, main|test)` group is
   removed, exactly as today. Not listed; governed by `strip-shared-prefix`.

**Collision guard (preserved, generalised from the `crates` special-case):**
after folding, if two module display names collide, **both** revert to their
full paths — ambiguity is worse than ceremony.

## Seeding (first build only)

The seeded file is the union of:

- **Structural (above-root):** each module root's leading run of segments that
  are **not themselves module roots** — top-level scope (the direct repo-root
  child), which cleanly catches `integrations`, `crates`, `modules`, `apps`,
  `packages`. (Verified: a flat multi-module Java repo seeds **nothing** here —
  `core`/`web` are themselves module roots — so `src/main` handling is
  untouched; a `modules/`-nested layout seeds `modules`.)
- **Language conventions (belt-and-suspenders):** small map, e.g. Rust → `crates`.
- **Source/test-root defaults:** the current `splitSourceRoot` constants, now
  written out as `source-roots` / `test-roots` so they are visible and editable.

On first seed, `build` prints one line: `seeded _index/foldings.geml — edit to
tune module folding`.

## Architecture / change points

- **`normalize.mjs` (stays pure — no IO):**
  - new `deriveFoldLayers(moduleRoots, { languages })` → structural + language
    above-root prefixes.
  - `splitSourceRoot` keeps its *algorithm* (strip leading source/test root,
    classify main/test) but takes its **patterns as arguments** instead of
    hardcoded regex constants.
  - `normalizeDirs(dirs, moduleRoots, repoName, fileMode, config)` where
    `config = { foldPrefixes, sourceRoots, testRoots, stripSharedPrefix }`.
    Folding replaces the hardcoded `stripCrates`; the `crates` special-case is
    **deleted** (its behaviour now comes from seeding).
- **`build.mjs` (IO home, beside `refresh.json`):** compute `moduleRoots`
  (`findModuleRoots`), read `_index/foldings.geml` or seed-and-write it, parse to
  `config`, pass down. `languages` come from the detection `jobs`.
- **`emit.mjs`:** thread `config` through to `normalizeDirs` (when `root` is
  absent — crg tier / older callers — folding is the identity, unchanged).

## Testing

- **Pure unit (`normalize.mjs`):** `deriveFoldLayers` structural detection
  (integrations/crates/modules → right names; flat Java → empty); `normalizeDirs`
  above-root fold + multi-segment prefix + collision revert; source/test-root
  folding + `test/` classification driven by config lists (port the existing
  `splitSourceRoot` cases to config-fed inputs). Rewrite the two `crates` tests
  (29effab) as general fold tests.
- **Integration (`build`/`emit`):** first build seeds `foldings.geml` containing
  `integrations`; second build does **not** overwrite a user edit; a
  parse-error / empty file falls back without crashing; `refresh` respects the
  file; a real multi-module Java fixture keeps `src/main` + group-id stripping
  intact end-to-end.

## Migration

- Replaces the **mechanism** of 29effab (hardcoded `crates`) and ab5b3a9's
  crates tests; `crates` *behaviour* is preserved via seeding. ab5b3a9's NUL
  hygiene fix is unrelated and untouched.
- Externalising `splitSourceRoot`'s constants touches a well-tested Java path;
  the algorithm is unchanged (only its inputs move to config), and the existing
  `splitSourceRoot` test cases are re-run against config-fed patterns to prove
  parity before the hardcoded constants are removed.

## Out of scope (YAGNI)

- Group-id / shared-prefix as a list (kept algorithmic).
- Full gitignore/glob semantics (`**`, `!` negation, anchoring). Patterns are
  literal segments plus a single-segment `*`. Because folding only sees the
  short `mod` / `rel` strings, richer matching can be added later with no risk
  to `src/main`, if a real case ever needs it.
- Making `strip-shared-prefix` anything more than an on/off toggle.
