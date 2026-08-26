// Tests for bin/geml-sync.mjs CLI: argument parsing, validation, error exits, and execution.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(here, "..", "bin", "geml-sync.mjs");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("ok", name);
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    ...opts,
  });
}

async function run() {
  await test("CLI: exits 2 when required positional arguments are missing", () => {
    const res0 = runCli([]);
    assert.equal(res0.status, 2);
    assert.ok(res0.stderr.includes("Usage:"));

    const res1 = runCli(["only-one-arg"]);
    assert.equal(res1.status, 2);
    assert.ok(res1.stderr.includes("Usage:"));
  });

  await test("CLI: exits 2 on invalid --interval (0, negative, non-integer, missing value)", () => {
    // 0
    const res0 = runCli(["graph", "dir", "--interval", "0"]);
    assert.equal(res0.status, 2);
    assert.ok(res0.stderr.includes("--interval must be a positive integer"));

    // Negative
    const resNeg = runCli(["graph", "dir", "--interval", "-5"]);
    assert.equal(resNeg.status, 2);
    assert.ok(resNeg.stderr.includes("--interval must be a positive integer"));

    // Non-integer
    const resFloat = runCli(["graph", "dir", "--interval", "abc"]);
    assert.equal(resFloat.status, 2);
    assert.ok(resFloat.stderr.includes("--interval must be a positive integer"));

    // Missing value
    const resMissing = runCli(["graph", "dir", "--interval"]);
    assert.equal(resMissing.status, 2);
    assert.ok(resMissing.stderr.includes("--interval requires a value"));
  });

  await test("CLI: exits 2 on invalid graph name (command/shell injection protection)", () => {
    const resInjection = runCli(["foo;calc", "dir"]);
    assert.equal(resInjection.status, 2);
    assert.ok(resInjection.stderr.includes("Invalid graph name"));

    const resAmpersand = runCli(["foo&whoami", "dir"]);
    assert.equal(resAmpersand.status, 2);
    assert.ok(resAmpersand.stderr.includes("Invalid graph name"));

    const resSlash = runCli(["foo/bar", "dir"]);
    assert.equal(resSlash.status, 2);
    assert.ok(resSlash.stderr.includes("Invalid graph name"));
  });

  await test("CLI: exits 2 on unknown flags", () => {
    const res = runCli(["graph", "dir", "--nonexistent-flag"]);
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes('Unknown flag "--nonexistent-flag"'));
  });

  await test("CLI: one-shot sync exits 1 on failure (Issue 3: non-zero exit on error)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "geml-cli-fail-"));
    try {
      // Pointing to a completely non-existent CLI / graph will fail
      const res = runCli(["non-existent-graph-xyz-999", tmp], {
        env: { ...process.env, LOGSEQ_CLI_DIR: tmp }, // no @logseq/cli installed here
      });
      assert.equal(res.status, 1, "Failed one-shot sync MUST exit 1, not 0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} CLI tests passed.`);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
