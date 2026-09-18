// What the Pi adapter assumes about Pi, asserted against the installed package.
//
// Same purpose as dsh-parity.test.mjs: a host that changes one of these should
// turn this suite red here, not turn a user's session red out there. Types
// alone would not do it - `tsc` already checks the tool definition, but nothing
// in the type system says "the `tool_call` handler may return `block`", and the
// doubles in test/helpers/pi.mjs are only honest if the real shapes agree with
// them.
//
// Read a failure here as "Pi moved", then fix the adapter - never the other way
// round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { toTypeBox, verbSpecs } from "../dist/hosts/pi/extension.js";
import { loadStatechart } from "../dist/core/statechart.js";
import { rollbackSpec, setSpec, transitionSpec } from "../dist/core/tools.js";
import { initialSnapshot } from "../dist/core/snapshot.js";

// Located on disk rather than resolved: Pi exports neither "./package.json"
// nor a `require` condition, and it ships an npm-shrinkwrap that nests its own
// packages under itself instead of hoisting them - so both layouts are tried
// and a miss fails loudly instead of skipping the checks.
const here = fileURLToPath(new URL("../", import.meta.url));
function rootOf(name) {
  const candidates = [
    join(here, "node_modules", name),
    join(here, "node_modules/@earendil-works/pi-coding-agent/node_modules", name),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, "package.json")));
  assert.ok(found, `cannot find ${name}; looked in ${candidates.join(" and ")}`);
  return found;
}
const read = (base, relative) => readFileSync(join(base, relative), "utf8");

const root = rootOf("@earendil-works/pi-coding-agent");
const pkg = JSON.parse(read(root, "package.json"));
const types = read(root, "dist/core/extensions/types.d.ts");

const sc = loadStatechart(
  readFileSync(new URL("./fixtures/refund.geml", import.meta.url), "utf8"),
  "agent.geml",
).statechart;

test("the host is the version this adapter was written against", () => {
  assert.equal(pkg.name, "@earendil-works/pi-coding-agent");
  // Pinned to the minor, not the patch: 0.x carries no semver promise, and a
  // minor bump is exactly when to re-read these declarations.
  assert.match(pkg.version, /^0\.85\./, `Pi is now ${pkg.version}: re-read dist/core/extensions/types.d.ts`);
  assert.equal(pkg.license, "MIT");
});

test("every event the adapter listens for exists on ExtensionAPI", () => {
  for (const event of ["session_start", "tool_call", "tool_result", "before_agent_start"]) {
    assert.match(types, new RegExp(`on\\(event: "${event}"`), `Pi no longer has ${event}`);
  }
});

test("every ExtensionAPI method the adapter calls is still declared", () => {
  for (const method of ["getAllTools", "getActiveTools", "setActiveTools", "appendEntry", "registerTool", "sendMessage"]) {
    assert.match(types, new RegExp(`${method}[<(]`), `Pi no longer has ${method}`);
  }
});

test("gate 3's answer shape: tool_call may block with a reason", () => {
  const result = types.match(/export interface ToolCallEventResult \{[\s\S]*?\n\}/);
  assert.ok(result, "ToolCallEventResult is gone");
  assert.match(result[0], /block\?: boolean/);
  assert.match(result[0], /reason\?: string/);
});

test("the pause mechanism: a tool result may ask the agent to stop", () => {
  const agentCore = read(rootOf("@earendil-works/pi-agent-core"), "dist/types.d.ts");
  const result = agentCore.match(/export interface AgentToolResult<T> \{[\s\S]*?\n\}/);
  assert.ok(result, "AgentToolResult is gone");
  assert.match(result[0], /terminate\?: boolean/, "no terminate: pause states would have no mechanism on Pi");
  assert.match(result[0], /content:/);
  assert.match(result[0], /details:/);
});

test("gate 4's mechanism: confirm is on the UI context, and hasUI says whether to ask", () => {
  assert.match(types, /confirm\(title: string, message: string/);
  assert.match(types, /hasUI: boolean/);
  // Why the adapter fails closed instead of asking: two of these modes have no
  // dialog at all. Pi's own words are in its docs/extensions.md.
  assert.match(types, /export type ExtensionMode = "tui" \| "rpc" \| "json" \| "print"/);
});

test("the recovery source: a custom entry is data, and a branch is a list of them", () => {
  assert.match(types, /appendEntry<T = unknown>\(customType: string, data\?: T\): void/);
  const manager = read(root, "dist/core/session-manager.d.ts");
  assert.match(manager, /getBranch\(fromId\?: string\): SessionEntry\[\]/);
  assert.match(manager, /getSessionId\(\): string/);
  assert.match(manager, /getSessionDir\(\): string/);
  // `type: "custom"` plus `customType` is what ledger-entries.ts matches on.
  assert.match(manager, /interface CustomEntry<T = unknown> extends SessionEntryBase \{[\s\S]*?type: "custom";[\s\S]*?customType: string;/);
});

test("gate 2 survives the projection: typebox enforces the enum we generate", () => {
  const transition = verbSpecs(sc).find((v) => v.name === "agent_transition");
  const schema = toTypeBox(transition.parameters);
  assert.deepEqual(schema.required, ["to"]);
  assert.ok(Value.Check(schema, { to: "review" }));
  assert.equal(Value.Check(schema, { to: "atlantis" }), false, "the enum is enforced by the host's own validator");
  assert.equal(Value.Check(schema, {}), false, "and so is required");
});

test("the DSH-shaped specs project onto typebox unchanged", () => {
  // One ToolSpec vocabulary feeds both hosts; this is the check that the
  // projection loses nothing that matters - the type, the description, the
  // enum and whether the parameter is required.
  const snap = initialSnapshot(sc, "2026-09-18T00:00:00.000Z");
  for (const spec of [transitionSpec(sc, snap), setSpec(sc, snap), rollbackSpec()]) {
    const schema = toTypeBox(spec.parameters);
    for (const [name, entry] of Object.entries(spec.parameters)) {
      const projected = schema.properties[name];
      assert.equal(projected.type, entry.type, `${spec.name}.${name} type`);
      assert.equal(projected.description, entry.description, `${spec.name}.${name} description`);
      if (entry.enum) assert.deepEqual(projected.enum, entry.enum, `${spec.name}.${name} enum`);
      assert.equal((schema.required ?? []).includes(name), entry.required === true, `${spec.name}.${name} required`);
    }
  }
});

test("Type.Unsafe is still the way to hand typebox a JSON Schema verbatim", () => {
  // If this stops holding, entrySchema() is where to look: the adapter relies
  // on typebox reading plain JSON Schema keywords out of an Unsafe node.
  const schema = Type.Object({ x: Type.Unsafe({ type: "string", enum: ["a"] }) });
  assert.equal(Value.Check(schema, { x: "a" }), true);
  assert.equal(Value.Check(schema, { x: "b" }), false);
});
