import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const at = (p) => new URL(`../${p}`, import.meta.url);
const json = (p) => JSON.parse(readFileSync(at(p), "utf8"));

test("the plugin manifest names gemflow, keeps the package's version and points at the state contract", () => {
  const plugin = json(".claude-plugin/plugin.json");
  const pkg = json("package.json");
  assert.equal(plugin.name, "gemflow");
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.types, "./types/index.d.ts");
  assert.ok(existsSync(at("types/index.d.ts")));
  assert.equal(plugin.mcpServers, undefined, "the hooks module serves the flow_* tools; a manifest MCP server would list them twice");
});

test("hooks.json names the one hooks module", () => {
  assert.deepEqual(json("hooks/hooks.json"), { modules: ["./register.tsx"] });
  assert.ok(existsSync(at("hooks/register.tsx")));
});

test("no skill shares its name with a command the hooks module registers", () => {
  // Claude Code gives a plugin's skill its bare name as an alias, and refuses
  // `$.command.register` for a name any listed command already answers to:
  // a skill named gemflow kept /gemflow from registering.
  const hooks = readFileSync(at("hooks/register.tsx"), "utf8");
  const commands = [...hooks.matchAll(/\$\.command\.register\(\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(commands.includes("gemflow"), "the hooks module registers /gemflow");
  for (const dir of readdirSync(at("skills"))) {
    const name = readFileSync(at(`skills/${dir}/SKILL.md`), "utf8").match(/^name:\s*(\S+)\s*$/m)?.[1];
    assert.ok(name !== undefined, `skills/${dir} names itself`);
    assert.ok(!commands.includes(name), `skill ${name} takes the name of /${name}`);
  }
});

test("the package ships the plugin folders, builds the bundle and pins esbuild", () => {
  const pkg = json("package.json");
  for (const f of [".claude-plugin/plugin.json", "hooks", "types", "workflows", "dist"]) assert.ok(pkg.files.includes(f), f);
  // Claude Code lays the engine's declarations in .claude-plugin/types/ when it loads the plugin from this folder: never shipped, never committed.
  assert.ok(!pkg.files.includes(".claude-plugin"), "the manifest by name, so .claude-plugin/types/ stays out of the package");
  assert.match(readFileSync(at(".gitignore"), "utf8"), /^\.claude-plugin\/types\/$/m);
  assert.equal(pkg.scripts.build, "tsc && node scripts/bundle.mjs");
  assert.equal(pkg.scripts.test, "npm run build && node --test test/*.test.mjs");
  assert.equal(pkg.scripts["test:claude"], "npm run build && claude plugin validate . && claude plugin test .");
  assert.equal(pkg.devDependencies.esbuild, "0.28.2");
});
