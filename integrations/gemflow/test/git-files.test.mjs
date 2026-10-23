// The branch and the default branch read from .git's files must say what git says: on a branch, detached, in a worktree, on an
// unborn branch (where the files do not say it and git is asked); and a request asks git each of these once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginGitRequest, endGitRequest, forgetGitFacts, repoFacts } from "../dist/host-git.js";

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gf-gitfiles-")));
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  return dir;
};
const fresh = (root) => { forgetGitFacts(); return repoFacts(root); };

test("on the default branch, and on a branch with commits of its own: what git says", () => {
  const root = repo();
  assert.deepEqual(fresh(root), { branch: "main", defaultBranch: "main", committed: false });
  git(root, "switch", "-q", "-c", "feat/x");
  assert.deepEqual(fresh(root), { branch: "feat/x", defaultBranch: "main", committed: false }, "no commit of its own yet");
  git(root, "commit", "-q", "--allow-empty", "-m", "two");
  assert.deepEqual(fresh(root), { branch: "feat/x", defaultBranch: "main", committed: true });
  git(root, "pack-refs", "--all");
  assert.deepEqual(fresh(root), { branch: "feat/x", defaultBranch: "main", committed: true }, "packed refs read too");
});

test("detached, an unborn branch, and a worktree: what git says", () => {
  const root = repo();
  git(root, "checkout", "-q", "--detach");
  assert.deepEqual(fresh(root), { branch: "HEAD", defaultBranch: "main" }, "detached: on no branch");
  git(root, "switch", "-q", "--orphan", "fresh");
  assert.deepEqual(fresh(root), { branch: "fresh", noCommits: true }, "unborn: the files do not say it, git is asked");
  git(root, "switch", "-q", "main");
  const wt = join(root, "..", `${root.split(/[\\/]/).pop()}-wt`);
  git(root, "worktree", "add", "-q", "-b", "feat/wt", wt);
  git(wt, "commit", "-q", "--allow-empty", "-m", "three");
  assert.deepEqual(fresh(wt), { branch: "feat/wt", defaultBranch: "main", committed: true }, "a worktree's .git file and the common directory");
});

test("a request asks git once: a second read in the same request is the first's answer; the next request, and any read outside one, asks again", () => {
  const root = repo();
  forgetGitFacts();
  beginGitRequest();
  assert.equal(repoFacts(root).branch, "main");
  git(root, "switch", "-q", "-c", "feat/y");
  assert.equal(repoFacts(root).branch, "main", "the same request: asked once");
  endGitRequest();
  assert.equal(repoFacts(root).branch, "feat/y", "outside a request: asked every time");
  beginGitRequest();
  git(root, "switch", "-q", "main");
  assert.equal(repoFacts(root).branch, "main", "the next request: asked again");
  endGitRequest();
});
