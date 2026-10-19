import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer } from "../dist/hosts/claude-code/release-notes.js";

test("an update is a later version: a build ahead of the published one is told no update", () => {
  assert.equal(isNewer("0.2.2", "0.2.1"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true, "by number, not by text");
  assert.equal(isNewer("1.0.0", "0.99.0"), true);
  assert.equal(isNewer("0.2.1", "0.2.2"), false, "the published one is older than this build");
  assert.equal(isNewer("0.2.2", "0.2.2"), false);
  assert.equal(isNewer("0.2.2-beta.1", "0.2.2"), false, "a pre-release tag is not weighed");
});
