import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { globToRegExp, hiddenDir, resolveItem, journalPathFor, isSafeItemId, IGNORED_DIRS } from "../dist/core/unit.js";
import { JOURNALS_DIR, CONTEXT_DOC, PROJECT_DOC, LEGACY_CONFIG_DOC, TOOLS_DOC, BACKLOG_DOC, WORKFLOWS_DIR, FLOW_FILE } from "../dist/core/layout.js";

test("globs: * stays in a segment, ** crosses them, ? is one character", () => {
  assert.ok(globToRegExp("episodes/*.geml").test("episodes/ep02.geml"));
  assert.ok(!globToRegExp("episodes/*.geml").test("episodes/s1/ep02.geml"));
  assert.ok(globToRegExp("episodes/**/*.geml").test("episodes/s1/ep02.geml"));
  assert.ok(globToRegExp("episodes/**/*.geml").test("episodes/ep02.geml"));
  assert.ok(globToRegExp("out/ep0?.mp4").test("out/ep01.mp4"));
  assert.ok(!globToRegExp("a.b").test("axb"), "dots are literal");
});

test("branch unit: the branch is the item; the default branch and a detached head are not tracked", () => {
  assert.deepEqual(resolveItem({ kind: "branch" }, { branch: "feat/x", defaultBranch: "main" }), { kind: "item", id: "feat/x" });
  assert.deepEqual(resolveItem({ kind: "branch" }, { branch: "main", defaultBranch: "main" }), { kind: "inactive", reason: "main · not tracked (work items are branches)" });
  assert.deepEqual(resolveItem({ kind: "branch" }, { branch: "HEAD", defaultBranch: "main" }), { kind: "inactive", reason: "detached HEAD · not tracked" });
  assert.deepEqual(resolveItem({ kind: "branch" }, {}), { kind: "inactive", reason: "not a git repository" });
});

test("file unit: the last matching file, without its extension", () => {
  const unit = { kind: "file", glob: "episodes/*.geml" };
  assert.deepEqual(resolveItem(unit, { lastFile: "episodes/ep02.geml" }), { kind: "item", id: "episodes/ep02" });
  assert.deepEqual(resolveItem(unit, { lastFile: "notes.md" }), { kind: "inactive", reason: "no work item yet: edit a file matching episodes/*.geml" });
  assert.deepEqual(resolveItem(unit, {}), { kind: "inactive", reason: "no work item yet: edit a file matching episodes/*.geml" });
});

test("file unit: a glob that names .geml/ outright reaches inside it, never its journals; .git and node_modules stay out", () => {
  const matters = { kind: "file", glob: ".geml/matters/*.geml" };
  assert.deepEqual(resolveItem(matters, { lastFile: ".geml/matters/band-entry.geml" }), { kind: "item", id: ".geml/matters/band-entry" });
  assert.deepEqual(resolveItem({ kind: "file", glob: "**/*.geml" }, { lastFile: ".geml/matters/band-entry.geml" }), { kind: "inactive", reason: ".geml/matters/band-entry.geml · under .geml, not a work item" });
  assert.deepEqual(resolveItem({ kind: "file", glob: ".geml/**/*.geml" }, { lastFile: ".geml/journals/feat/x.geml" }), { kind: "inactive", reason: ".geml/journals/feat/x.geml · under .geml, not a work item" });
  assert.deepEqual(resolveItem({ kind: "file", glob: "**/*.geml" }, { lastFile: "a/node_modules/b.geml" }), { kind: "inactive", reason: "a/node_modules/b.geml · under node_modules, not a work item" });
  assert.equal(hiddenDir(".geml/matters/*.geml", ".geml/matters/a.geml"), undefined);
  assert.equal(hiddenDir("matters/*.geml", ".geml/matters/a.geml"), ".geml");
  assert.equal(hiddenDir(".geml/*.geml", "src/.geml/a.geml"), ".geml", "only the project's own .geml/, at the root");
  assert.equal(hiddenDir(".geml/**", ".geml/x/.git/y"), ".git");
});

test("file unit: a Windows path (backslashes) names the same item as its POSIX spelling", () => {
  const unit = { kind: "file", glob: "episodes/**/*.geml" };
  assert.deepEqual(resolveItem(unit, { lastFile: "episodes\\s1\\ep02.geml" }), { kind: "item", id: "episodes/s1/ep02" });
});

test("paths", () => {
  assert.equal(journalPathFor("feat/x"), ".geml/journals/feat/x.geml");
  assert.deepEqual([JOURNALS_DIR, CONTEXT_DOC, PROJECT_DOC, LEGACY_CONFIG_DOC, TOOLS_DOC, BACKLOG_DOC, WORKFLOWS_DIR, FLOW_FILE],
    [".geml/journals", ".geml/context.geml", ".geml/project.geml", ".geml/gemflow.geml", ".geml/tools.geml", ".geml/backlog.geml", ".geml/workflows", "flow.geml"]);
});

// An item id comes from a branch name or a matched file name: not something
// the journal directory may trust. Whatever it holds, the journal must land
// under .geml/journals/, on a POSIX and on a Windows file system alike.
const HOSTILE = [
  "..", "../x", "a/../../x", "a/..", "./x", "a/./b", ".",
  "/etc/passwd", "//server/share/x", "a//b", "a/", "",
  "..\\x", "a\\b", "a\\..\\..\\x", "\\\\server\\share\\x",
  "C:", "C:x", "C:/x", "C:\\x", "a/C:/x", "x:stream",
  "a\0b", "a\0", "\0",
  "a\nb", "a\tb", "a\x7fb",
  "a/b.", "a. /b", "a /b", "...", "a/.../b",
  "con", "a/NUL", "aux.txt", "com1", "a/LPT9/b", "Con.tar",
  'a<b', 'a>b', 'a"b', "a|b", "a?b", "a*b",
];

test("a hostile item id is not a safe id", () => {
  for (const id of HOSTILE) assert.equal(isSafeItemId(id), false, JSON.stringify(id));
});

test("the ordinary ids stay safe", () => {
  for (const id of ["feat/x", "fix/issue-12", "release/1.2.3", "episodes/ep02", "episodes/s1/ep02", "a.b/c.d", "特性/第二集", "x", "console/x", "auxiliary", "comet/1"])
    assert.equal(isSafeItemId(id), true, id);
});

test("journalPathFor refuses a hostile id instead of building a path from it", () => {
  for (const id of HOSTILE) assert.throws(() => journalPathFor(id), /work item id/, JSON.stringify(id));
});

test("a hostile branch or file name never becomes a work item", () => {
  const unit = { kind: "file", glob: "**/*.geml" };
  for (const id of HOSTILE) {
    const asBranch = resolveItem({ kind: "branch" }, { branch: id, defaultBranch: "main" });
    // An empty branch means "no git repository", not a work item; every other hostile one is refused by name.
    assert.equal(asBranch.kind, "inactive", `branch ${JSON.stringify(id)}`);
    // A file path arrives in the host's spelling; a backslash there is a Windows separator, so `a\b` is the item `a/b`.
    if (isSafeItemId(id.replace(/\\/g, "/"))) continue;
    const asFile = resolveItem(unit, { lastFile: `${id}.geml` });
    assert.equal(asFile.kind, "inactive", `file ${JSON.stringify(id)}`);
  }
  // The path a glob such as ** lets through must not become the journal.
  assert.deepEqual(resolveItem(unit, { lastFile: "../outside.geml" }),
    { kind: "inactive", reason: '"../outside" · not a safe work item id' });
  assert.deepEqual(resolveItem({ kind: "branch" }, { branch: "a/../../x", defaultBranch: "main" }),
    { kind: "inactive", reason: '"a/../../x" · not a safe work item id' });
});

test("every journal path resolves inside .geml/journals, as a POSIX and as a Windows path", () => {
  const ids = ["feat/x", "episodes/s1/ep02", "a.b/c.d", "release/1.2.3", "x"];
  for (const flavour of [path.posix, path.win32]) {
    const root = flavour === path.win32 ? "C:\\proj" : "/proj";
    const journals = flavour.resolve(root, JOURNALS_DIR) + flavour.sep;
    for (const id of ids) {
      const p = flavour.resolve(root, journalPathFor(id));
      assert.ok(p.startsWith(journals), `${flavour.sep} ${id} -> ${p}`);
      assert.ok(p.endsWith(".geml"));
    }
  }
});

test("file unit: a file under .geml, .git or node_modules is never a work item, whatever the glob matches", () => {
  const unit = { kind: "file", glob: "**/*.geml" };
  for (const file of [".geml/journals/ep1.geml", ".geml/codemap/index.geml", ".git/x.geml", "node_modules/pkg/y.geml", "docs/node_modules/z.geml", "a\\.geml\\b.geml"]) {
    const got = resolveItem(unit, { lastFile: file });
    assert.equal(got.kind, "inactive", file);
    assert.match(got.reason, /not a work item/, file);
  }
  assert.deepEqual(resolveItem(unit, { lastFile: "episodes/ep1.geml" }), { kind: "item", id: "episodes/ep1" });
  assert.deepEqual(resolveItem(unit, { lastFile: "my.geml.d/ep1.geml" }), { kind: "item", id: "my.geml.d/ep1" }, "a name that merely contains one of them is fine");
  assert.equal(resolveItem(unit, { lastFile: ".gitignore.geml" }).kind, "item", "a file name is not a directory name");
});

test("the directories no work item or file signal looks into are one set, shared with the project walk", () => {
  assert.deepEqual([...IGNORED_DIRS].sort(), [".geml", ".git", "node_modules"]);
});
