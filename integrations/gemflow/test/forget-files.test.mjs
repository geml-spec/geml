// What is not an artifact after all: a draft handed to git commit as its message, taken out of the table again, its copy in the trash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetFiles, isUnder, readArtifactRows, recordFile } from "../dist/artifacts-store.js";
import { folderLabel } from "../dist/hosts/claude-code/board.js";

test("a draft recorded as an artifact is taken out again, every version under any work item; its copy goes to the trash, a copy another row keeps stays", () => {
  const base = mkdtempSync(join(tmpdir(), "gf-forget-"));
  const root = join(base, "repo");
  const home = root;
  const scratch = join(base, "scratch");
  mkdirSync(root, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const draft = join(scratch, "msg60.txt");
  const page = join(scratch, "mockup.html");
  writeFileSync(draft, "gemflow 0.2.60: one");
  recordFile(root, home, "feat/x", draft, "file");
  writeFileSync(draft, "gemflow 0.2.60: two");
  recordFile(root, home, "feat/y", draft, "file");
  writeFileSync(page, "<title>样稿</title>");
  recordFile(root, home, "feat/x", page, "file");
  const before = readArtifactRows(home);
  assert.equal(before.length, 3);
  const copies = before.filter((r) => r.name.endsWith("msg60.txt")).map((r) => join(home, ".geml", r.where));
  const trash = join(base, "trash");
  assert.equal(forgetFiles(root, home, [draft], trash), 2, "both versions, both work items");
  assert.deepEqual(readArtifactRows(home).map((r) => r.name.split("/").pop()), ["mockup.html"]);
  for (const c of copies) assert.ok(!existsSync(c), "its copy left the artifacts folder");
  assert.ok(existsSync(trash), "into the trash");
  assert.equal(forgetFiles(root, home, [join(scratch, "none.txt")], trash), 0);
});

test("Claude's own folder: a path in it or it itself is under it, a sibling with the same start is not", () => {
  assert.equal(isUnder("/home/me/.claude/projects/x/memory/a.md", "/home/me/.claude"), true);
  assert.equal(isUnder("/home/me/.claude", "/home/me/.claude/"), true);
  assert.equal(isUnder("/home/me/.claude-other/a.md", "/home/me/.claude"), false);
  assert.equal(isUnder("C:\\Users\\me\\.claude\\x.md", "C:/Users/me/.claude"), true, "separators aside");
});

test("an artifact file's folder, in short: in the project its folder, outside its own folder name, at the top nothing", () => {
  assert.equal(folderLabel(".geml/exports/s.geml"), ".geml/exports");
  assert.equal(folderLabel("C:/Users/me/AppData/Local/Temp/claude/x/scratchpad/memory-mockup.html"), "…/scratchpad");
  assert.equal(folderLabel("/tmp/scratch/icon.svg"), "…/scratch");
  assert.equal(folderLabel("README.md"), "");
});
