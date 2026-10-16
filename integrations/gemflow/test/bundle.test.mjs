import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = fileURLToPath(new URL("../dist/gemflow.mjs", import.meta.url));
const CODING = fileURLToPath(new URL("../workflows/coding/flow.geml", import.meta.url));

test("the bundle is one file that runs with no node_modules beside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "gemflow-bundle-"));
  copyFileSync(BUNDLE, join(dir, "gemflow.mjs"));
  copyFileSync(CODING, join(dir, "flow.geml"));
  const usage = spawnSync(process.execPath, [join(dir, "gemflow.mjs")], { cwd: dir, encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^usage: gemflow /);
  const check = spawnSync(process.execPath, [join(dir, "gemflow.mjs"), "check", "flow.geml"], { cwd: dir, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("the bundle imports only Node's built-ins and carries no parser CLI hand-off", () => {
  const src = readFileSync(BUNDLE, "utf8");
  const specs = [...src.matchAll(/^import\s[^;]*?from\s*"([^"]+)";?$/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.match(s, /^node:/, s);
  assert.doesNotMatch(src, /if \(isCliInvocation\(\)\) \{/);
});
