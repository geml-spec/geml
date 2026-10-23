// The files a shell command hands to git commit as its message: drafts for the commit, never the work item's artifacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitMessageFiles } from "../dist/core/commit-message.js";

test("a commit's message file: -F, -F attached, --file and --file=, quoted or not; -F - is none", () => {
  assert.deepEqual(commitMessageFiles("git commit -F /tmp/msg.txt"), ["/tmp/msg.txt"]);
  assert.deepEqual(commitMessageFiles("git commit -F/tmp/a.txt"), ["/tmp/a.txt"]);
  assert.deepEqual(commitMessageFiles("git commit --file /tmp/b.txt && git push"), ["/tmp/b.txt"]);
  assert.deepEqual(commitMessageFiles('git commit --file="C:/Users/me/scratch pad/c.txt"'), ["C:/Users/me/scratch pad/c.txt"]);
  assert.deepEqual(commitMessageFiles("git commit -F - <<'EOF'"), []);
  assert.deepEqual(commitMessageFiles("git commit -m 'no file'"), []);
});

test("a variable the same command assigns is expanded; git's own options and a prefix like rtk do not hide the commit", () => {
  assert.deepEqual(commitMessageFiles("cd /w && S=C:/Users/me/scratchpad && rtk git commit -F $S/msg59.txt 2>&1 | tail -1"), ["C:/Users/me/scratchpad/msg59.txt"]);
  assert.deepEqual(commitMessageFiles("export D=/tmp/x; git -C /w/repo commit -F ${D}/m.txt"), ["/tmp/x/m.txt"]);
  assert.deepEqual(commitMessageFiles("git commit -F $UNSET/m.txt"), ["$UNSET/m.txt"], "one it does not assign is left as written");
});

test("other git commands that take -F are not a commit's message", () => {
  assert.deepEqual(commitMessageFiles("git log -F --grep=commit"), []);
  assert.deepEqual(commitMessageFiles("grep -F commit notes.txt"), []);
});
