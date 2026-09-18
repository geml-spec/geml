// The `run` verb: how dsh is found and invoked. The spawn is substituted, so
// these tests never start a harness — what is under test is the argv, the exit
// code, and what happens when dsh is not there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { launcherFor, resolveOnPath, run, warnAboutPercent } from "../dist/hosts/dsh/launch.js";

const WIN = process.platform === "win32";

/** A directory on PATH holding an executable named `dsh`, shaped for this OS. */
function shimDir() {
  const dir = mkdtempSync(join(tmpdir(), "geml-agent-shim-"));
  if (WIN) {
    writeFileSync(join(dir, "dsh.cmd"), "@echo off\r\nexit /b 0\r\n");
  } else {
    const file = join(dir, "dsh");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

/** A spawnSync stand-in that records its calls and answers with fixed results. */
function recorder(results = []) {
  const calls = [];
  let n = 0;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return results[n++] ?? { status: 0, stdout: "", stderr: "" };
  };
  return { calls, spawn };
}

test("resolveOnPath finds an executable and honours PATHEXT on Windows", () => {
  const dir = shimDir();
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const found = resolveOnPath("dsh", env);
  assert.ok(found, "the shim is on PATH");
  assert.match(found, WIN ? /dsh\.cmd$/i : /dsh$/);
  assert.equal(resolveOnPath("definitely-not-here", env), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("launcherFor prefers dsh on PATH", () => {
  const dir = shimDir();
  const l = launcherFor({ PATH: dir, PATHEXT: ".CMD" });
  assert.equal(l.how, "PATH");
  assert.deepEqual(l.prefix, []);
  assert.equal(l.shell, WIN, "a .cmd shim needs a shell; a POSIX script does not");
  rmSync(dir, { recursive: true, force: true });
});

test("launcherFor falls back to npx when dsh is not installed", () => {
  const empty = mkdtempSync(join(tmpdir(), "geml-agent-empty-"));
  const l = launcherFor({ PATH: empty, PATHEXT: ".CMD" });
  assert.equal(l.how, "npx");
  assert.deepEqual(l.prefix, ["-y", "@deepseek-ai/dsh"]);
  rmSync(empty, { recursive: true, force: true });
});

test("run adds the bundle to the profile, then runs the task, and passes the code through", () => {
  const dir = shimDir();
  const { calls, spawn } = recorder([{ status: 0, stdout: "", stderr: "" }, { status: 7 }]);
  const code = run({ profile: "headless", task: "refund order A-17", spawn, env: { PATH: dir, PATHEXT: ".CMD" }, note: () => {} });
  assert.equal(code, 7, "dsh's exit code is the verb's exit code");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(-5), ["plugin", "--profile", "headless", "add", "@geml/agent-runtime"]);
  assert.deepEqual(calls[1].args.slice(-3), ["--profile", "headless", "refund order A-17"]);
  assert.equal(calls[1].options.stdio, "inherit", "the model's output goes straight to the terminal");
  rmSync(dir, { recursive: true, force: true });
});

test("run reports a failed add and hands back the two commands, without running the task", () => {
  const dir = shimDir();
  const lines = [];
  const { calls, spawn } = recorder([{ status: 1, stdout: "", stderr: "no such profile" }]);
  const code = run({ profile: "web", task: "hello", spawn, env: { PATH: dir, PATHEXT: ".CMD" }, note: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.equal(calls.length, 1, "the task must not run when the bundle is not in place");
  assert.ok(lines.some((l) => l.includes("no such profile")), "dsh's own words are shown");
  assert.ok(lines.some((l) => l.includes("plugin --profile web add @geml/agent-runtime")));
  rmSync(dir, { recursive: true, force: true });
});

test("run reports a launcher that cannot start at all", () => {
  const dir = shimDir();
  const lines = [];
  const { spawn } = recorder([{ status: 0 }, { error: new Error("spawn ENOENT") }]);
  const code = run({ profile: "headless", task: "hello", spawn, env: { PATH: dir, PATHEXT: ".CMD" }, note: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes("could not be started")));
  rmSync(dir, { recursive: true, force: true });
});

test("a task containing % is flagged only where a shell is involved", () => {
  assert.equal(warnAboutPercent("refund 50% of A-17", false), undefined, "no shell, nothing to warn about");
  assert.match(warnAboutPercent("refund 50% of A-17", true), /expand/);
  assert.equal(warnAboutPercent("refund A-17", true), undefined);
});

test("the npx route carries its own arguments before dsh's", () => {
  const empty = mkdtempSync(join(tmpdir(), "geml-agent-empty-"));
  const { calls, spawn } = recorder();
  run({ profile: "headless", task: "hello", spawn, env: { PATH: empty, PATHEXT: ".CMD" }, note: () => {} });
  assert.deepEqual(calls[0].args.slice(0, 2), ["-y", "@deepseek-ai/dsh"]);
  rmSync(empty, { recursive: true, force: true });
});
