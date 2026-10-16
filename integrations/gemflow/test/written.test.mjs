import { test } from "node:test";
import assert from "node:assert/strict";
import { writtenProjectPath } from "../dist/core/written.js";

test("the project path a write tool's call names: under the root, with forward slashes; relative as given; outside, none", () => {
  assert.equal(writtenProjectPath({ file_path: "/w/app/src/a.ts" }, "/w/app"), "src/a.ts");
  assert.equal(writtenProjectPath({ path: "C:\\w\\app\\src\\a.ts" }, "c:/w/app/"), "src/a.ts", "a drive letter either way, either separator");
  assert.equal(writtenProjectPath({ path: "./src/a.ts" }, "/w/app"), "src/a.ts");
  assert.equal(writtenProjectPath({ notebook_path: "nb.ipynb" }, "/w/app"), "nb.ipynb");
  assert.equal(writtenProjectPath({ file_path: "/w/application/a.ts" }, "/w/app"), undefined, "a sibling that shares the prefix is outside");
  assert.equal(writtenProjectPath({ file_path: "/tmp/x" }, "/w/app"), undefined);
  assert.equal(writtenProjectPath({ path: "../x" }, "/w/app"), undefined);
  assert.equal(writtenProjectPath({ content: "x" }, "/w/app"), undefined);
  assert.equal(writtenProjectPath(undefined, "/w/app"), undefined);
});

test("a root reached through a link: with the host's resolver, an absolute path is compared as both resolve", () => {
  // macOS: the temporary directory is /var/…, which is /private/var/…; a host may name the root one way and the file the other.
  const real = (p) => p.replace(/^\/var\//, "/private/var/");
  assert.equal(writtenProjectPath({ path: "/var/t/app/src/a.ts" }, "/private/var/t/app", real), "src/a.ts");
  assert.equal(writtenProjectPath({ path: "/private/var/t/app/src/a.ts" }, "/var/t/app", real), "src/a.ts");
  assert.equal(writtenProjectPath({ path: "/var/t/app/src/a.ts" }, "/private/var/t/app"), undefined, "without a resolver, only the spelling counts");
  assert.equal(writtenProjectPath({ path: "/var/t/other/a.ts" }, "/private/var/t/app", real), undefined, "resolved, still outside");
});
