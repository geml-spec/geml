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
// The same ceremony rule covers Cargo workspaces: member crates conventionally
// live under a bare `crates/` directory that declares no manifest of its own,
// so a leading `crates/` is stripped from the module's display name
// (crates/foo -> foo). If stripping would make two modules collide (crates/util
// next to a real util), both keep their full paths — ambiguity is worse than
// ceremony.
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
// -> Map<dir, normalizedDisplayPath>.
//
// Display path = [test?] / <module> / <package tail>. The module segment is the
// enclosing module root, or repoName when the container belongs to the repo
// root itself. Test containers get a leading `test` segment so they collect
// under one top-level branch, mirroring the main structure beneath it.
export function normalizeDirs(dirs, moduleRoots, repoName, fileMode) {
  const list = [...new Set(dirs)].filter((d) => d && d !== "(root)");
  const moduleOf = (d) => {
    for (const r of moduleRoots) if (d === r || d.startsWith(r + "/")) return r;
    return "";
  };
  // Cargo workspaces park member crates under a bare `crates/` directory — no
  // manifest of its own, pure ceremony like `src/main/java`. Strip that leading
  // segment from the module's DISPLAY name, unless the stripped name collides
  // with another module root (crates/util next to a real util): then both keep
  // their full paths.
  const stripCrates = (r) => r.replace(/^crates\//, "");
  const strippedCounts = new Map();
  for (const r of moduleRoots) {
    const s = stripCrates(r);
    strippedCounts.set(s, (strippedCounts.get(s) ?? 0) + 1);
  }
  const displayOf = (r) => {
    const s = stripCrates(r);
    return s !== r && strippedCounts.get(s) > 1 ? r : s;
  };
  // Group by (module, main|test); each group strips its OWN common prefix so a
  // module's main and test trees normalise independently.
  const groups = new Map(); // key -> { mod, kind, members:[{dir, segs}] }
  for (const d of list) {
    const mod = moduleOf(d);
    const rel = mod ? d.slice(mod.length + 1) : d;
    const { kind, tail } = splitSourceRoot(rel, { sourceRoots: DEFAULT_SOURCE_ROOTS, testRoots: DEFAULT_TEST_ROOTS });
    const key = mod + "\0" + kind;
    if (!groups.has(key)) groups.set(key, { mod, kind, members: [] });
    const segs0 = tail.split("/").filter(Boolean);
    const leaf = fileMode && segs0.length ? segs0.pop() : null; // filename kept aside
    groups.get(key).members.push({ dir: d, dirSegs: segs0, leaf });
  }
  const out = new Map();
  for (const { mod, kind, members } of groups.values()) {
    let common = members.length ? [...members[0].dirSegs] : [];
    for (const { dirSegs } of members) {
      let i = 0;
      while (i < common.length && i < dirSegs.length && common[i] === dirSegs[i]) i++;
      common.length = i;
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
export function buildNormalizer(root, dirs, { repoName, fileMode, ...deps } = {}) {
  return normalizeDirs(dirs, findModuleRoots(root, deps), repoName, fileMode);
}
