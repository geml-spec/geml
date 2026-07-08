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
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// Ask git which of `files` it ignores. Returns a Set of the ignored paths.
// check-ignore exits 1 when nothing matches and 128 when git is unavailable /
// the dir is not a repo — both mean "ignore nothing", not a build failure.
export function gitIgnored(root, files, exec = _execFileSync) {
  if (!files.length) return new Set();
  try {
    const out = exec("git", ["-C", root, "check-ignore", "--stdin"], { input: files.join("\n"), encoding: "utf8" });
    return new Set(out.split(/\r?\n/).filter(Boolean));
  } catch (e) {
    const out = e && e.stdout ? String(e.stdout) : "";
    return new Set(out.split(/\r?\n/).filter(Boolean));
  }
}

// Build a predicate (file) => shouldExclude.
export function makeExcluder({ root, globs = [], gitignore = true, files = [], exec } = {}) {
  const res = globs.map(globToRegExp);
  const ignored = gitignore ? gitIgnored(root, files, exec) : new Set();
  return (file) => ignored.has(file) || res.some((r) => r.test(file));
}
