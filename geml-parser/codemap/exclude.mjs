// Source exclusion for the codemap build.
//
// Two mechanisms, both matching on a symbol's repo-relative POSIX file path:
//   1. .gitignore — the default. Whatever git ignores (vendored copies, build
//      output, dependency dumps) never enters the graph. Uses `git check-ignore`
//      so the semantics are exactly git's, including un-committed .gitignore
//      edits (check-ignore reads the working tree).
//   2. --exclude <glob> — explicit, repeatable, for paths git still tracks that
//      you nonetheless don't want in the graph.
// Neither touches the raw indexer output; excluded symbols are dropped before
// emit, and the edge tables (which key on surviving anchors) follow.

import { execFileSync as _execFileSync } from "node:child_process";

// Minimal gitignore-flavoured glob: `**` spans path separators, `*` stays
// within a segment, everything else is literal. Anchored to the whole path.
export function globToRegExp(glob) {
  // The glob comes from a `--exclude` argument, so nothing in it may reach the
  // compiled pattern as *syntax*. Split on the wildcards, keeping them (the
  // capture group), which leaves the array strictly alternating: even indices
  // are literal text, odd indices are `*`, `**` or `**/`. Literals go through a
  // total regex-metacharacter escape; wildcards map to fixed patterns. Neither
  // path can carry an unescaped metacharacter through.
  const parts = String(glob).split(/(\*\*\/?|\*)/);
  let re = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) re += parts[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else re += parts[i] === "*" ? "[^/]*" : ".*"; // `**` and `**/` span separators
  }
  return new RegExp("^" + re + "$");
}

// Ask git which of `files` it ignores. Returns a Set of the ignored paths.
// check-ignore exits 1 when nothing matches and 128 when git is unavailable /
// the dir is not a repo — both mean "ignore nothing", not a build failure.
// The injected runner is named `run`, not `exec`: it is always an execFile-shaped
// (program, args[]) call that spawns NO shell, whereas a callback named `exec`
// reads — to a human skimming, and to a static analyser — as the shell-string
// child_process API. The name should not imply the dangerous one.
export function gitIgnored(root, files, run = _execFileSync) {
  if (!files.length) return new Set();
  try {
    const out = run("git", ["-C", root, "check-ignore", "--stdin"], { input: files.join("\n"), encoding: "utf8" });
    return new Set(out.split(/\r?\n/).filter(Boolean));
  } catch (e) {
    const out = e && e.stdout ? String(e.stdout) : "";
    return new Set(out.split(/\r?\n/).filter(Boolean));
  }
}

// Build a predicate (file) => shouldExclude.
export function makeExcluder({ root, globs = [], gitignore = true, files = [], run } = {}) {
  const res = globs.map(globToRegExp);
  const ignored = gitignore ? gitIgnored(root, files, run) : new Set();
  return (file) => ignored.has(file) || res.some((r) => r.test(file));
}
