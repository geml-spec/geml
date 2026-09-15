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
  assert.ok(lines.includes("name: '@geml/agent-runtime'"), "the runtime row names this package");
  assert.ok(lines.includes("ledgerDir: !!js dshHomePath('geml-agent')"), "the ledger directory is deployment config, not a constant");
  assert.ok(lines.includes("onMissing: skip"), "a session with no statechart is left alone by default");
});
