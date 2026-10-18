import { test } from "node:test";
import assert from "node:assert/strict";
import { clientsWords, envParts, originWords, remoteInPlay, surfaceWords } from "../dist/hosts/claude-code/env.js";

test("the environment in one line: machine · system · account, checkout, branch, session, clients, the last prompt's origin", () => {
  const host = { name: "GEORGE-PC", platform: "win32", user: "george", branch: "feat/gemflow" };
  assert.deepEqual(envParts({ host, root: "C:/agentProjects/geml-gemflow", session: "3f70c07c-a125", clients: [{ clientId: "d", surface: "desktop" }, { clientId: "p1", surface: "mobile" }, { clientId: "p2", surface: "mobile" }], origin: "bridge" }),
    ["GEORGE-PC · Windows · george", "C:/agentProjects/geml-gemflow", "feat/gemflow", "会话 3f70c07c", "连着 桌面端、手机 ×2", "上一句来自 远程控制"]);
  assert.deepEqual(envParts({ host: null, root: null, clients: [] }), [], "nothing known, nothing said");
  assert.deepEqual(envParts({ host: { name: "box", platform: "freebsd" }, root: "/w", clients: [], origin: "loop_wakeup" }), ["box · freebsd", "/w"], "an unknown system by its own name; an origin with no words is left out");
});

test("words: surfaces, origins, clients by surface", () => {
  assert.equal(surfaceWords("vscode"), "VS Code");
  assert.equal(originWords("composer"), "本机输入框");
  assert.equal(originWords("system"), undefined);
  assert.equal(clientsWords([{ clientId: "a", surface: "desktop" }]), "桌面端");
});

test("the band names the machine only when a person may be away from it: drawn on a phone, a phone attached, a prompt over Remote Control", () => {
  assert.equal(remoteInPlay({ surface: "desktop", clients: [] }), false);
  assert.equal(remoteInPlay({ surface: "mobile", clients: [] }), true);
  assert.equal(remoteInPlay({ clients: [{ clientId: "p", surface: "mobile" }] }), true);
  assert.equal(remoteInPlay({ clients: [], origin: "bridge" }), true);
});
