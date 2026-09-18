import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const here = new URL(".", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", here), "utf8"));

test("package identity: the renamed bundle", () => {
  assert.equal(pkg.name, "@geml/agent-runtime");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.bin["geml-agent"], "dist/cli.js");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.deepEqual(pkg.files, ["dist", "skills", "examples", "cordis.patch.yml", "LICENSE"]);
  assert.equal(pkg.scripts.postinstall, undefined, "no lifecycle scripts: installing must never need allowBuilds");
});

test("the two dsh-plugin skills travelled with the rename", () => {
  assert.ok(existsSync(new URL("../skills/geml/SKILL.md", here)));
  assert.ok(existsSync(new URL("../skills/geml-code-graph/SKILL.md", here)));
  assert.ok(existsSync(new URL("../cordis.patch.yml", here)));
});

test("one package, two hosts: a subpath each, and both peers optional", () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./dsh", "./package.json", "./pi"]);
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

  for (const id of ["mcp-geml", "skill-geml", "geml-agent"]) {
    assert.ok(lines.includes(`- id: ${id}`), `row ${id}`);
  }
  // The subpath, not the package root: Cordis needs a module whose namespace
  // has `apply` (lib/index.js isApplicable), and the root is the host-agnostic
  // library. It is also what keeps the DSH import out of a Pi-only install.
  assert.ok(lines.includes("name: '@geml/agent-runtime/dsh'"), "the runtime row names the DSH adapter");
  assert.ok(lines.includes("ledgerDir: !!js dshHomePath('geml-agent')"), "the ledger directory is deployment config, not a constant");
  assert.ok(lines.includes("onMissing: skip"), "a session with no statechart is left alone by default");
});
