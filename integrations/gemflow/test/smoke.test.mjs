import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const here = new URL(".", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", here), "utf8"));

test("package identity: the renamed bundle", () => {
  assert.equal(pkg.name, "@geml/gemflow");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", here), "utf8"));
  const claude = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", here), "utf8"));
  const codex = JSON.parse(readFileSync(new URL("../.codex-plugin/plugin.json", here), "utf8"));
  assert.deepEqual([lock.version, lock.packages[""].version, claude.version, codex.version], Array(4).fill(pkg.version), "every manifest names the package's version: the board shows the plugin's, so a bump that missed one would say the wrong version");
  assert.equal(pkg.bin["gemflow"], "dist/cli.js");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.deepEqual([...pkg.files].sort(), [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".codexignore", "LICENSE", "client.js", "coach", "codex", "cordis.patch.yml", "dist", "examples", "hooks", "skills", "spec", "types", "workflows"]);
  assert.equal(pkg.scripts.postinstall, undefined, "no lifecycle scripts: installing must never need allowBuilds");
});

test("the split-session skill ships with the plugin: the board's 从这里拆分 and 删除 hand the model its script", () => {
  const skill = readFileSync(new URL("../skills/split-session/SKILL.md", here), "utf8");
  assert.match(skill, /^name: split-session$/m);
  assert.match(skill, /split-session\.mjs/);
  const script = readFileSync(new URL("../skills/split-session/split-session.mjs", here), "utf8");
  assert.match(script, /^import fs from 'node:fs';$/m, "plain Node, no dependencies");
  assert.match(script, /if \(cmd === 'list'\) cmdList\(\);/);
  assert.match(script, /else if \(cmd === 'split'\) cmdSplit\(\);/);
});

test("the two dsh-plugin skills travelled with the rename", () => {
  assert.ok(existsSync(new URL("../skills/geml/SKILL.md", here)));
  assert.ok(existsSync(new URL("../skills/geml-code-graph/SKILL.md", here)));
  assert.ok(existsSync(new URL("../cordis.patch.yml", here)));
});

test("one package, two hosts: a subpath each, and both peers optional", () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./client", "./dsh", "./package.json", "./pi"]);
  assert.equal(pkg.exports["./dsh"].default, "./dist/hosts/dsh/plugin.js");
  assert.equal(pkg.exports["./pi"].default, "./dist/hosts/pi/extension.js");
  // Pi's docs/packages.md: its own packages go in peerDependencies with a "*"
  // range and are not bundled.
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(pkg.peerDependencies["typebox"], "*");
  for (const name of Object.keys(pkg.peerDependencies)) {
    assert.equal(pkg.peerDependenciesMeta[name]?.optional, true, name);
  }
  assert.equal(pkg.bundledDependencies, undefined);
});

test("the pi manifest points at the extension and reuses the existing skills", () => {
  assert.deepEqual(pkg.pi.extensions, ["./dist/hosts/pi/extension.js"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.ok(pkg.keywords.includes("pi-package"), "the gallery keys on this keyword");
  assert.ok(pkg.keywords.includes("dsh-plugin"), "the dsh catalogue keys on this one");
});

test("dist/index.js exports the runtime version", async () => {
  const mod = await import(new URL("../dist/index.js", here));
  assert.equal(mod.RUNTIME_VERSION, pkg.version);
});

test("the bundle patch contributes the runtime row alongside the MCP server and the skills", () => {
  // Compared line by line rather than with a regex built in a template literal:
  // `\s` inside one is not an escape and collapses to `s`, so the obvious
  // `new RegExp(\`^\\s*- id: …$\`)` silently matches nothing. Trailing carriage
  // returns are stripped because this file is CRLF in a Windows checkout.
  const lines = readFileSync(new URL("../cordis.patch.yml", here), "utf8")
    .split("\n")
    .map((line) => line.trim().replace(/\r$/, ""));

  for (const id of ["mcp-geml", "skill-geml", "gemflow"]) {
    assert.ok(lines.includes(`- id: ${id}`), `row ${id}`);
  }
  // The adapter module by path, not the package root and not a subpath:
  // Cordis needs a module whose namespace has `apply` (lib/index.js
  // isApplicable), the root is the host-agnostic library, and
  // dsh-client-modules finds the browser half (`dsh.client`) only for rows
  // named by a bare package name or a path — `@geml/gemflow/dsh` gave no tab.
  assert.ok(lines.includes("name: ./dist/hosts/dsh/plugin.js"), "the runtime row names the DSH adapter module by path");
  assert.ok(lines.includes("journalDir: !!js dshHomePath('gemflow')"), "the journal directory is deployment config, not a constant");
  assert.ok(lines.includes("onMissing: skip"), "a session with no statechart is left alone by default");
  assert.ok(!lines.some((l) => l.startsWith("statechart:")), "the workflow is resolved from the project, not pinned to one path");
});
