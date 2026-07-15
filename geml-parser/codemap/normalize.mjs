// Container-path normalisation (GEP-0003 §4, "module root + common prefix").
//
// A container's raw path is its directory relative to the repo root, e.g.
//   magic-api/src/main/java/org/ssssssss/magicapi/core/config
// The leading run `src/main/java/org/ssssssss/magicapi` is pure ceremony: the
// build-system source root (`src/main/java`) plus the group-id package root
// (`org/ssssssss/magicapi`) that EVERY container in the module shares. It
// carries no navigational information — it only buries the real structure.
//
// The fix is language-agnostic and data-driven: within each MODULE (a
// directory that declares itself one via pom.xml / build.gradle /
// package.json / tsconfig.json), strip the longest common directory prefix
// shared by all of that module's containers. `magic-api` then opens straight
// onto `core / backup / modules …` instead of a chain of empty ceremony
// layers. A module that vendored several group-ids (netty's shaded jars) has
// a short common prefix and keeps its `com / io / org` fork — that is real
// package structure, and such vendored trees are meant to be EXCLUDED, not
// normalised.
//
// A further layer of PURE ceremony can sit ABOVE the module root itself —
// Cargo's bare `crates/` directory (crates/foo -> foo), a vendored fork like
// `libs/vendor/`, or whatever a given repo's layout adds. That layer is no
// longer hardcoded: `foldPrefixes`, sourced from `foldings.geml` (see
// foldings.mjs), lists the leading segment-runs to fold off a module's
// display name — entries may be multi-segment (`libs/vendor`), and the
// longest match wins. The same collision guard applies: if folding would
// make two modules collide (crates/util next to a real util), both keep
// their full paths — ambiguity is worse than ceremony.
//
// Normalisation only rewrites the container's DISPLAY path (its `module=` and
// document name). Each block's `src=` / `anchor` keep the true file path.

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const MODULE_MARKERS = /^(pom\.xml|build\.gradle|build\.gradle\.kts|package\.json|tsconfig\.json|go\.mod|Cargo\.toml)$/;
// Never descend into these — dependency dumps and build output are not source.
const SKIP_DIRS = new Set([
  "node_modules", "target", "dist", "out", "build", ".git",
  ".geml-code-graph", ".geml-build", ".idea", ".gradle", "bin_",
]);

// Discover module roots under `root`: every directory holding a build manifest.
// Returned as repo-relative POSIX paths, DEEPEST first, so `moduleOf` can pick
// the most specific enclosing module.
export function findModuleRoots(root, { readdir = readdirSync } = {}) {
  const roots = [];
  const walk = (dir) => {
    let ents;
    try { ents = readdir(dir, { withFileTypes: true }); } catch { return; }
    let isRoot = false;
    for (const e of ents) if (e.isFile() && MODULE_MARKERS.test(e.name)) { isRoot = true; break; }
    if (isRoot) {
      const rel = relative(root, dir).replace(/\\/g, "/");
      roots.push(rel); // "" for the repo root itself
    }
    for (const e of ents) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name));
    }
  };
  walk(root);
  return roots.filter((r) => r !== "").sort((a, b) => b.length - a.length);
}

export const DEFAULT_SOURCE_ROOTS = ["src/main/*", "src/main", "src"];
export const DEFAULT_TEST_ROOTS = ["src/test/*", "test", "tests", "__tests__", "spec", "specs"];
export const LANG_FOLD_PREFIXES = { Rust: ["crates"] };

// Above-root ceremony: a top-level directory (direct repo-root child) that is
// NOT itself a module root but is the ancestor of one — integrations/, crates/,
// modules/, apps/, packages/. Seeded into foldings.geml; the human edits from
// there. Flat multi-module repos (core/, web/ each a module root) seed nothing.
export function deriveFoldLayers(moduleRoots) {
  const isRoot = new Set(moduleRoots);
  const seed = new Set();
  for (const m of moduleRoots) {
    const top = m.split("/")[0];
    if (top && top !== m && !isRoot.has(top)) seed.add(top);
  }
  return [...seed].sort();
}

// Match a leading source/test root by PATTERN. A pattern is a "/"-joined run of
// segments; "*" matches exactly one segment, others match literally. Returns
// the number of leading segments consumed, or -1 for no match.
function matchLeading(segs, pattern) {
  const p = pattern.split("/");
  if (p.length > segs.length) return -1;
  for (let i = 0; i < p.length; i++) if (p[i] !== "*" && p[i] !== segs[i]) return -1;
  return p.length;
}
// Strip the build-system SOURCE ROOT from a module-relative path and classify
// the container as main vs test. Patterns come from foldings.geml (seeded from
// DEFAULT_SOURCE_ROOTS / DEFAULT_TEST_ROOTS) — the algorithm is unchanged, only
// the pattern lists moved out of hardcoded regexes. Longest leading match wins;
// a test-root match routes the container to the test branch.
export function splitSourceRoot(rel, { sourceRoots, testRoots }) {
  const segs = rel.split("/").filter(Boolean);
  const cands = [
    ...testRoots.map((p) => ({ p, kind: "test" })),
    ...sourceRoots.map((p) => ({ p, kind: "main" })),
  ]
    .map((c) => ({ ...c, n: matchLeading(segs, c.p) }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n); // longest match first
  let kind = "main", tail = rel;
  if (cands.length) { kind = cands[0].kind; tail = segs.slice(cands[0].n).join("/"); }
  // A test dir sitting just inside the (main) source root reclassifies to test.
  const tm = tail.match(/^(test|tests|__tests__|spec|specs)(\/|$)/);
  if (tm) { kind = "test"; tail = tail.slice(tm[0].length); }
  return { kind, tail };
}

// dirs: iterable of container directory paths (repo-relative POSIX; the
// emitter's "(root)" sentinel is passed through untouched).
// moduleRoots: from findModuleRoots (deepest first).
// repoName: display name for the implicit root module (single-module repos
//   whose only build manifest sits at the repo root).
// config: { foldPrefixes?, sourceRoots?, testRoots?, stripSharedPrefix? } — see
//   foldings.mjs. Defaults reproduce the pre-config behaviour verbatim: no
//   ceremony folding, the built-in source/test root patterns, common prefix
//   stripped.
// -> Map<dir, normalizedDisplayPath>.
//
// Display path = [test?] / <module> / <package tail>. The module segment is the
// enclosing module root, or repoName when the container belongs to the repo
// root itself. Test containers get a leading `test` segment so they collect
// under one top-level branch, mirroring the main structure beneath it.

// Strip the leading run of ceremony segments matching any fold-prefix (entries
// may be multi-segment; longest match first), until the front no longer matches.
export function foldPrefix(modPath, foldPrefixes) {
  let segs = modPath.split("/");
  for (let changed = true; changed && segs.length > 1; ) {
    changed = false;
    const hit = foldPrefixes
      .map((f) => f.split("/"))
      .filter((f) => f.length < segs.length && f.every((s, i) => s === segs[i]))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) { segs = segs.slice(hit.length); changed = true; }
  }
  return segs.join("/");
}

export function normalizeDirs(dirs, moduleRoots, repoName, fileMode, config = {}) {
  const foldPrefixes = config.foldPrefixes ?? [];
  const sourceRoots = config.sourceRoots ?? DEFAULT_SOURCE_ROOTS;
  const testRoots = config.testRoots ?? DEFAULT_TEST_ROOTS;
  const stripSharedPrefix = config.stripSharedPrefix ?? true;
  const list = [...new Set(dirs)].filter((d) => d && d !== "(root)");
  const moduleOf = (d) => {
    for (const r of moduleRoots) if (d === r || d.startsWith(r + "/")) return r;
    return "";
  };
  // Fold ceremony prefixes off each module-root DISPLAY name, then guard: if two
  // modules fold to the same name, revert BOTH to their full paths.
  const foldedCounts = new Map();
  for (const r of moduleRoots) {
    const f = foldPrefix(r, foldPrefixes);
    foldedCounts.set(f, (foldedCounts.get(f) ?? 0) + 1);
  }
  const displayOf = (r) => {
    const f = foldPrefix(r, foldPrefixes);
    return f !== r && foldedCounts.get(f) > 1 ? r : f;
  };
  // Group by (module, main|test); each group strips its OWN common prefix so a
  // module's main and test trees normalise independently.
  const groups = new Map(); // key -> { mod, kind, members:[{dir, segs}] }
  for (const d of list) {
    const mod = moduleOf(d);
    const rel = mod ? d.slice(mod.length + 1) : d;
    const { kind, tail } = splitSourceRoot(rel, { sourceRoots, testRoots });
    const key = mod + "\0" + kind;
    if (!groups.has(key)) groups.set(key, { mod, kind, members: [] });
    const segs0 = tail.split("/").filter(Boolean);
    const leaf = fileMode && segs0.length ? segs0.pop() : null; // filename kept aside
    groups.get(key).members.push({ dir: d, dirSegs: segs0, leaf });
  }
  const out = new Map();
  for (const { mod, kind, members } of groups.values()) {
    let common = stripSharedPrefix && members.length ? [...members[0].dirSegs] : [];
    if (stripSharedPrefix) {
      for (const { dirSegs } of members) {
        let i = 0;
        while (i < common.length && i < dirSegs.length && common[i] === dirSegs[i]) i++;
        common.length = i;
      }
    }
    const moduleSeg = (mod && displayOf(mod)) || repoName || "";
    for (const { dir, dirSegs, leaf } of members) {
      const tail = dirSegs.slice(common.length);
      if (leaf !== null) tail.push(leaf);
      const parts = [];
      if (kind === "test") parts.push("test");
      if (moduleSeg) parts.push(moduleSeg);
      parts.push(...tail);
      out.set(dir, parts.join("/") || mod || dir);
    }
  }
  return out;
}

// Convenience: discover roots under `root` and normalise `dirs` in one call.
export function buildNormalizer(root, dirs, { repoName, fileMode, config, ...deps } = {}) {
  return normalizeDirs(dirs, findModuleRoots(root, deps), repoName, fileMode, config);
}
