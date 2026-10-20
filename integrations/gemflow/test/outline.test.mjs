// The project's outline: where each work item ended up, read off git and kept
// in project.geml's #items table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchRow, branchState, fileState, prOf, readOutline, renderOutline, withOutline } from "../dist/core/outline.js";
import { updateOutline } from "../dist/outline-store.js";
import { realPath } from "../dist/host-fs.js";
import { gitRepo } from "./helpers/repo.mjs";

const row = (over = {}) => ({ item: "feat/x", state: "doing", flow: "dev", stage: "build", worktree: "", commits: null, pr: "", tip: "", since: "2026-10-16", last: "2026-10-19", ...over });
const item = { id: "feat/x", flow: "dev", stage: "review", since: "2026-10-16", last: "2026-10-20" };
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

test("a branch item: being worked on while its branch has commits of its own; merged once main holds them, or its pull request is merged", () => {
  assert.equal(branchState(undefined, { exists: true, ahead: 3, inDefault: false }, undefined), "doing");
  assert.equal(branchState(undefined, { exists: true, ahead: 0, inDefault: true }, undefined), "doing", "a branch with no commit of its own is not merged: nothing was done");
  assert.equal(branchState(row({ commits: 3 }), { exists: true, ahead: 0, inDefault: true }, undefined), "merged", "it had commits, and main holds its tip");
  assert.equal(branchState(undefined, { exists: true, ahead: 2, inDefault: false }, { number: 7, state: "merged" }), "merged", "squashed: its tip is not in main, its pull request says so");
  assert.equal(branchState(row({ state: "merged", commits: 3 }), { exists: true, ahead: 1, inDefault: false }, undefined), "doing", "it went on after its merge");
});

test("a branch item whose branch is gone: closed when it was merged, dropped when not or when it never had a commit", () => {
  assert.equal(branchState(row({ state: "merged", commits: 3 }), { exists: false }, undefined), "closed");
  assert.equal(branchState(row({ commits: 3, tip: "abc" }), { exists: false, tipInDefault: true }, undefined), "closed", "merged and deleted between two looks");
  assert.equal(branchState(row({ commits: 3, tip: "abc" }), { exists: false, tipInDefault: false }, undefined), "dropped");
  assert.equal(branchState(row({ commits: 0, tip: "abc" }), { exists: false, tipInDefault: true }, undefined), "dropped", "nothing was done on it");
  assert.equal(branchState(row({ commits: 2 }), { exists: false }, { number: 7, state: "merged" }), "closed");
  assert.equal(branchState(undefined, { exists: false }, undefined), "dropped");
});

test("a file item: its flow's final state closes it, parked drops it", () => {
  assert.equal(fileState(true, "done"), "closed");
  assert.equal(fileState(false, "parked"), "dropped");
  assert.equal(fileState(false, "doing"), "doing");
});

test("a row remembers what git forgets: the commits a merged branch had, the tip of one that is gone, its pull request", () => {
  const live = branchRow(undefined, item, { exists: true, tip: "a1b2", ahead: 4, inDefault: false, worktree: "../wt" }, { number: 9, state: "open" });
  assert.deepEqual(live, { item: "feat/x", state: "doing", flow: "dev", stage: "review", worktree: "../wt", commits: 4, pr: "#9 open", tip: "a1b2", since: "2026-10-16", last: "2026-10-20" });
  const merged = branchRow(live, item, { exists: true, tip: "a1b2", ahead: 0, inDefault: true, worktree: "../wt" }, undefined);
  assert.deepEqual([merged.state, merged.commits, merged.pr], ["merged", 4, "#9 open"], "the count it had; the pull request until gh is asked again");
  const gone = branchRow(merged, item, { exists: false }, undefined);
  assert.deepEqual([gone.state, gone.worktree, gone.tip, gone.commits], ["closed", "", "a1b2", 4]);
  assert.deepEqual(prOf("#32 merged"), { number: 32, state: "merged" });
  assert.equal(prOf("nonsense"), undefined);
});

test("the #items table reads back what it wrote; only that block is rewritten, a person's text around it stays", () => {
  const rows = [row(), row({ item: "feat/y", state: "dropped", commits: 0, tip: "ff00" })];
  assert.deepEqual(readOutline(renderOutline(rows)), rows);
  const doc = '=== meta\ntitle = "P"\nflow-workflow = "dev"\n===\n\n# Notes\n\nmine\n';
  const once = withOutline(doc, rows);
  assert.ok(once.startsWith(doc), "appended after what was there");
  const twice = withOutline(once, [row({ state: "merged" })]);
  assert.match(twice, /flow-workflow = "dev"/);
  assert.match(twice, /# Notes\n\nmine/);
  assert.deepEqual(readOutline(twice).map((r) => r.state), ["merged"]);
  assert.match(withOutline(null, rows), /^=== meta\ntitle = "Gemflow"\n===\n\n=== table \{#items\}/);
});

const git = (root, ...a) => {
  const r = spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (root, file) => { writeFileSync(join(root, file), file); git(root, "add", file); git(root, "commit", "-qm", file); };
const entry = (id) => ({ id, kind: "branch", final: false, state: "build", flow: "dev", stage: "build", since: "2026-10-16", last: "2026-10-20" });

test("in a repository: merged, then closed once the branch is deleted; a branch deleted unmerged is dropped; project.geml keeps the default it names", () => {
  const root = realPath(gitRepo("main"));
  mkdirSync(join(root, ".geml"), { recursive: true });
  writeFileSync(join(root, ".geml", "project.geml"), '=== meta\ntitle = "Gemflow"\nflow-workflow = "dev"\n===\n');
  git(root, "switch", "-qc", "feat/a"); commit(root, "a.txt");
  git(root, "switch", "-q", "main"); git(root, "switch", "-qc", "feat/b"); commit(root, "b.txt");
  git(root, "switch", "-q", "main");
  const wt = join(realPath(mkdtempSync(join(tmpdir(), "gemflow-wt-"))), "wt");
  git(root, "worktree", "add", "-q", wt, "feat/b");
  const ids = ["feat/a", "feat/b"];
  let rows = updateOutline(root, root, ids.map(entry));
  assert.deepEqual(ids.map((id) => [rows.get(id).state, rows.get(id).commits]), [["doing", 1], ["doing", 1]]);
  assert.match(rows.get("feat/b").worktree, /wt$/, "where its branch is checked out");
  git(root, "merge", "-q", "--no-ff", "-m", "merge a", "feat/a");
  rows = updateOutline(root, root, ids.map(entry));
  assert.equal(rows.get("feat/a").state, "merged");
  git(root, "branch", "-q", "-d", "feat/a");
  git(root, "worktree", "remove", wt);
  git(root, "branch", "-q", "-D", "feat/b");
  rows = updateOutline(root, root, ids.map(entry));
  assert.deepEqual(ids.map((id) => rows.get(id).state), ["closed", "dropped"]);
  const doc = read(join(root, ".geml", "project.geml"));
  assert.match(doc, /flow-workflow = "dev"/, "the default stays");
  assert.deepEqual(readOutline(doc).map((r) => [r.item, r.state]), [["feat/a", "closed"], ["feat/b", "dropped"]]);
  rows = updateOutline(root, root, []);
  assert.equal(rows.get("feat/a").state, "closed", "a row whose journal is gone stays");
});
