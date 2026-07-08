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

// dirs: iterable of container directory paths (repo-relative POSIX; the
// emitter's "(root)" sentinel is passed through untouched).
// moduleRoots: from findModuleRoots (deepest first).
// -> Map<dir, normalizedDir>.
export function normalizeDirs(dirs, moduleRoots) {
  const list = [...new Set(dirs)].filter((d) => d && d !== "(root)");
  const moduleOf = (d) => {
    for (const r of moduleRoots) if (d === r || d.startsWith(r + "/")) return r;
    return "";
  };
  // group container dirs by their enclosing module
  const byModule = new Map();
  for (const d of list) {
    const m = moduleOf(d);
    if (!byModule.has(m)) byModule.set(m, []);
    byModule.get(m).push(d);
  }
  const out = new Map();
  for (const [mod, group] of byModule) {
    const base = mod ? mod + "/" : "";
    const rels = group.map((d) => (mod ? d.slice(mod.length + 1) : d));
    // longest common leading SEGMENTS across the module's containers
    const segs = rels.map((r) => r.split("/"));
    let common = segs.length ? [...segs[0]] : [];
    for (const s of segs) {
      let i = 0;
      while (i < common.length && i < s.length && common[i] === s[i]) i++;
      common.length = i;
    }
    // A module with a single container collapses to the module root itself;
    // never strip so far that a container's own leaf segment disappears when
    // it is a proper prefix of its siblings — keep at least the module root.
    for (let k = 0; k < group.length; k++) {
      const tail = segs[k].slice(common.length).join("/");
      out.set(group[k], tail ? base + tail : (mod || group[k]));
    }
  }
  return out;
}

// Convenience: discover roots under `root` and normalise `dirs` in one call.
export function buildNormalizer(root, dirs, deps = {}) {
  return normalizeDirs(dirs, findModuleRoots(root, deps));
}
