#!/usr/bin/env node
// geml codemap refresh — re-run a codemap's RECORDED build recipe so the
// graph stays consistent with the code.
//
//   geml codemap refresh [codemap-dir]                 run the recipe now
//   geml codemap refresh [codemap-dir] --background    detach, return at once
//   geml codemap refresh [codemap-dir] --hook          Claude Code hook adapter
//
// The recipe lives at <codemap-dir>/_index/refresh.json — written once, after
// the first successful build (the geml-code-graph skill records the exact
// index/build/verify commands it ran):
//
//   { "root": "..", "steps": ["npx --yes @sourcegraph/scip-typescript index …",
//     "geml codemap build --adapter scip --raw index.scip --root . --out .geml-code-graph --history",
//     "geml codemap verify .geml-code-graph"] }
//
// Steps run sequentially with the project root as cwd; the run is skipped
// when git HEAD hasn't moved since the last successful refresh (stamped back
// into refresh.json as "last_commit"). Output goes to _index/refresh.log.
// refresh.json is the project's own recorded build recipe — review it like
// any build script.
//
// --hook mode is a PostToolUse adapter: it reads the hook payload from stdin,
// exits 0 immediately unless the tool ran a `git commit`, and otherwise
// starts the refresh DETACHED so the commit is never blocked on an indexer.
// A project without refresh.json is simply not opted in (silent exit 0).
import { readFileSync, writeFileSync, existsSync, appendFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";

const args = process.argv.slice(2);
const hookMode = args.includes("--hook");
const background = args.includes("--background");
// --force: rebuild even when the repo commit is unchanged — the recipe's
// up-to-date check watches the CODE, but a toolchain upgrade (new adapter
// naming, new emit shape) changes the OUTPUT for the same code.
const force = args.includes("--force");
if (args.includes("--help")) {
  console.error("usage: geml codemap refresh [codemap-dir] [--force] [--background|--hook]   (dir defaults to ./.geml-code-graph)");
  process.exit(2);
}
const dir = args.find((a) => !a.startsWith("--")) || ".geml-code-graph";
const cmDir = resolve(dir);
const cfgPath = join(cmDir, "_index", "refresh.json");
const logPath = join(cmDir, "_index", "refresh.log");

if (!existsSync(cfgPath)) {
  if (hookMode) process.exit(0); // no recipe = this project has not opted in
  console.error(`error: ${cfgPath} not found — record the build recipe there first (see the geml-code-graph skill)`);
  process.exit(1);
}

if (hookMode) {
  // PostToolUse payload on stdin; only a git commit warrants a refresh.
  let cmd = "";
  try { cmd = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.command ?? ""; } catch { /* not JSON: ignore */ }
  if (!/(^|[;&|]\s*)(\S+\s+)?git\s+(\S+\s+)*commit\b/.test(cmd)) process.exit(0);
}

if (hookMode || background) {
  const child = spawn(process.execPath, [process.argv[1], cmDir, ...(force ? ["--force"] : [])], { detached: true, stdio: "ignore" });
  child.unref();
  console.error(`codemap refresh: running in background (log: ${logPath})`);
  process.exit(0);
}

const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const root = resolve(cmDir, cfg.root ?? "..");
let head;
try {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  head = r.status === 0 ? r.stdout.trim() : undefined;
} catch { /* no git: refresh unconditionally */ }
if (!force && head && cfg.last_commit === head) {
  console.error(`codemap refresh: up to date at ${head.slice(0, 10)} (--force to rebuild anyway)`);
  process.exit(0);
}

appendFileSync(logPath, `\n[${new Date().toISOString()}] refresh @ ${head ?? "no-git"}\n`);
for (const step of cfg.steps ?? []) {
  appendFileSync(logPath, `$ ${step}\n`);
  // Stream the step's output STRAIGHT into the log file. Capturing it in
  // memory (spawnSync + encoding) hits the default 1MB maxBuffer — Joern's
  // INFO firehose blew it and the child got killed mid-export (exit null).
  // A file descriptor has no such limit, and the log tails live.
  const fd = openSync(logPath, "a");
  const r = spawnSync(step, { shell: true, cwd: root, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  if (r.status !== 0) {
    const why = r.status ?? r.signal ?? r.error?.message ?? "killed";
    appendFileSync(logPath, `FAILED (exit ${why})\n`);
    console.error(`codemap refresh: step failed (exit ${why}): ${step}\n  log: ${logPath}`);
    process.exit(1);
  }
}
if (head) {
  cfg.last_commit = head;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
}
appendFileSync(logPath, "ok\n");
console.error(`codemap refresh: done${head ? ` @ ${head.slice(0, 10)}` : ""} (${(cfg.steps ?? []).length} step(s))`);
