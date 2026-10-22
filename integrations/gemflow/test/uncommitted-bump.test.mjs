// A version bumped in the checkout and not committed (host-git.ts, uncommittedBump).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRepo } from "./helpers/repo.mjs";
import { uncommittedBump } from "../dist/host-git.js";

const git = (root, ...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });

test("the first package.json or plugin.json whose version is above HEAD's; none once committed, none for a version not above, none in a clean checkout", () => {
  const root = gitRepo("feat/x");
  mkdirSync(join(root, "sub", ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, "sub", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x", version: "0.2.9" }));
  writeFileSync(join(root, "sub", "package.json"), JSON.stringify({ name: "x", version: "0.2.9" }));
  writeFileSync(join(root, "sub", "notes.json"), "{}");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "0.2.9");
  assert.equal(uncommittedBump(root), undefined, "clean");
  writeFileSync(join(root, "sub", "notes.json"), '{"a":1}');
  assert.equal(uncommittedBump(root), undefined, "a change without a version bump");
  writeFileSync(join(root, "sub", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x", version: "0.2.10" }));
  assert.deepEqual(uncommittedBump(root), { path: "sub/.claude-plugin/plugin.json", version: "0.2.10", was: "0.2.9" }, "0.2.10 is above 0.2.9, number by number");
  writeFileSync(join(root, "sub", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x", version: "0.2.8" }));
  assert.equal(uncommittedBump(root), undefined, "a version below HEAD's is no bump");
  writeFileSync(join(root, "sub", "package.json"), JSON.stringify({ name: "x", version: "0.3.0" }));
  assert.equal(uncommittedBump(root)?.version, "0.3.0");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "0.3.0");
  assert.equal(uncommittedBump(root), undefined, "committed: none");
});
