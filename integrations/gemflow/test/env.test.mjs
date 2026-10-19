import { test } from "node:test";
import assert from "node:assert/strict";
import { envParts, remoteInPlay } from "../dist/hosts/claude-code/env.js";

test("the environment in a few words: the machine the session runs on, the checkout's folder, the branch, 远程控制 when in play", () => {
  const host = { name: "GEORGE-PC", platform: "win32", user: "george", branch: "feat/gemflow" };
  assert.deepEqual(envParts({ host, root: "C:\\agentProjects\\geml-gemflow", remote: false }), ["运行于 GEORGE-PC", "geml-gemflow", "feat/gemflow"]);
  assert.deepEqual(envParts({ host, root: "/home/g/geml-gemflow/", remote: true }), ["运行于 GEORGE-PC", "geml-gemflow", "feat/gemflow", "远程控制"]);
  assert.deepEqual(envParts({ host: null, root: null, remote: false }), [], "nothing known, nothing said");
});

test("Remote Control is in play when the band is drawn on a phone, a phone is attached, or the last prompt came over it", () => {
  assert.equal(remoteInPlay({ surface: "desktop", clients: [] }), false);
  assert.equal(remoteInPlay({ surface: "mobile", clients: [] }), true);
  assert.equal(remoteInPlay({ clients: [{ clientId: "p", surface: "mobile" }] }), true);
  assert.equal(remoteInPlay({ clients: [], origin: "bridge" }), true);
  assert.equal(remoteInPlay({ clients: [], origin: "composer" }), false);
});
