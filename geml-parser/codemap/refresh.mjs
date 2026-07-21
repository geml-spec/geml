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
// when git HEAD hasn't moved past the commit the codemap was built from —
// read from index.geml's own meta (`commit = <sha>`, stamped by build), so
// refresh.json stays a pure, human-reviewable recipe that no tool rewrites.
// Output goes to _index/refresh.log.
//
// --hook mode is a PostToolUse adapter: it reads the hook payload from stdin,
// exits 0 immediately unless the tool ran a `git commit`, and otherwise
// starts the refresh DETACHED so the commit is never blocked on an indexer.
// A project without refresh.json is simply not opted in (silent exit 0).
//
// --commit: after a successful refresh, commit the refreshed codemap files as
// their own follow-up commit (chore(codemap): …), so the graph travels with
// the code on the next push instead of lingering as working-tree churn. The
// commit is surgical (pathspec = the codemap dir only) and guarded: it is
// skipped when HEAD moved mid-refresh or a merge is in progress. Loop-safe by
// construction — the follow-up commit changes no indexed source file, so the
// refresh it triggers takes the no-source-change skip and stops.
import { readFileSync, existsSync, appendFileSync, openSync, closeSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { isSourcePath } from "./detect.mjs";
import { recipeFingerprint, isRecipeTrusted, trustRecipe, trustStorePath } from "./recipe-trust.mjs";

const args = process.argv.slice(2);
const hookMode = args.includes("--hook");
const background = args.includes("--background");
// --force: rebuild even when the repo commit is unchanged — the recipe's
// up-to-date check watches the CODE, but a toolchain upgrade (new adapter
// naming, new emit shape) changes the OUTPUT for the same code.
const force = args.includes("--force");
const autoCommit = args.includes("--commit");
// --trust: approve THIS recipe (by fingerprint) so refresh will run it. The
// gate below refuses any recipe whose fingerprint is not in the trust store.
const trustFlag = args.includes("--trust");
if (args.includes("--help")) {
  console.error("usage: geml codemap refresh [codemap-dir] [--trust] [--force] [--commit] [--background|--hook]   (dir defaults to ./.geml-code-graph)");
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

// Parse the recipe UP FRONT: its fingerprint drives the TRUST GATE (security
// fix C2). refresh.json is committed data whose steps run through a shell, so
// an untrusted recipe must never reach the exec loop on ANY path — the
// foreground run, the --hook/--background re-spawn, or serve --watch (which
// spawns this script). See codemap/recipe-trust.mjs.
let cfg;
try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); }
catch (e) {
  if (hookMode) process.exit(0); // a broken recipe must not block a commit
  console.error(`error: cannot parse recipe ${cfgPath}: ${e.message}`);
  process.exit(1);
}
const steps = cfg.steps ?? [];
const fingerprint = recipeFingerprint(cfg);
let trusted = isRecipeTrusted(fingerprint);

// --trust: record this exact recipe as approved (content-addressed), then
// proceed. Recorded in the PARENT so every downstream path — including a
// detached --hook/--background child that re-runs this script — sees it as
// trusted via the persistent store. Fail LOUDLY if the store cannot be
// written: a caller that asked to trust must not be told it worked and then
// silently keep refusing.
if (trustFlag) {
  if (trusted) {
    console.error(`codemap refresh: recipe already trusted (${fingerprint.slice(0, 12)})`);
  } else {
    let where;
    try { where = trustRecipe(fingerprint, cmDir); }
    catch (e) {
      console.error(`codemap refresh: FAILED to record trust in ${trustStorePath()}: ${e.message}`);
      process.exit(1);
    }
    console.error(`codemap refresh: recipe trusted (${fingerprint.slice(0, 12)}) — recorded in ${where}`);
    trusted = true;
  }
}

// The refusal: show the exact steps that WOULD run so the user can review
// them, then how to approve. Non-zero exit so the skill/automation notices and
// surfaces it rather than silently doing nothing.
const refuseUntrusted = () => {
  console.error(`codemap refresh: REFUSING to run an untrusted recipe (${cfgPath})`);
  console.error(`  fingerprint: ${fingerprint}`);
  console.error("  steps that would run:");
  for (const s of steps) console.error(`    $ ${s}`);
  console.error("this codemap recipe is not trusted; review the steps above and re-run with");
  console.error("--trust to approve, or run `geml codemap build` to regenerate it.");
};

if (hookMode) {
  // PostToolUse payload on stdin; only a git commit warrants a refresh.
  let cmd = "";
  try { cmd = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.command ?? ""; } catch { /* not JSON: ignore */ }
  if (!/(^|[;&|]\s*)(\S+\s+)?git\s+(\S+\s+)*commit\b/.test(cmd)) process.exit(0);
}

if (hookMode || background) {
  // Never launch an exec child for an untrusted recipe. An empty recipe execs
  // nothing, so it is not gated. --hook is automatic and must not block the
  // commit: warn and no-op (exit 0). An explicit --background run surfaces the
  // refusal with a non-zero exit.
  if (steps.length && !trusted) {
    if (hookMode) {
      console.error(`codemap refresh: recipe not trusted — skipping (review it, then run \`geml codemap refresh ${dir} --trust\`)`);
      process.exit(0);
    }
    refuseUntrusted();
    process.exit(3);
  }
  const child = spawn(process.execPath, [process.argv[1], cmDir, ...(force ? ["--force"] : []), ...(autoCommit ? ["--commit"] : [])], { detached: true, stdio: "ignore" });
  child.unref();
  console.error(`codemap refresh: running in background (log: ${logPath})`);
  process.exit(0);
}

const root = resolve(cmDir, cfg.root ?? "..");
let head;
try {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  head = r.status === 0 ? r.stdout.trim() : undefined;
} catch { /* no git: refresh unconditionally */ }
// The commit this codemap was built from: build stamps it into index.geml's
// meta (`commit = <short-sha>`), so the graph itself carries the baseline and
// refresh.json is never rewritten. A legacy `last_commit` in refresh.json is
// honored as a fallback for codemaps built before the meta stamp.
let builtFrom;
try {
  const m = /^commit = "?([0-9a-fA-F]{4,40})"?\r?$/m.exec(readFileSync(join(cmDir, "index.geml"), "utf8").slice(0, 4000));
  if (m) builtFrom = m[1];
} catch { /* no index yet: first build */ }
if (!builtFrom && cfg.last_commit) builtFrom = cfg.last_commit;
if (!force && head && builtFrom && head.startsWith(builtFrom)) {
  console.error(`codemap refresh: up to date at ${head.slice(0, 10)} (--force to rebuild anyway)`);
  process.exit(0);
}

// HEAD moved past the built-from commit, but if no INDEXED source file
// changed in between (docs, config, CI only) the graph can't have changed —
// skip the slow re-index. --force, a first build (no baseline), or an
// uncomputable diff all fall through and rebuild.
if (!force && head && builtFrom) {
  let changed;
  try {
    const r = spawnSync("git", ["-C", root, "diff", "--name-only", builtFrom, head], { encoding: "utf8" });
    if (r.status === 0) changed = r.stdout.split("\n").filter(Boolean);
  } catch { /* diff unavailable: fall through and rebuild */ }
  if (changed && !changed.some(isSourcePath)) {
    console.error(`codemap refresh: no source files changed since ${builtFrom.slice(0, 10)} — skipped (${changed.length} non-source file(s); --force to rebuild)`);
    process.exit(0);
  }
}

// TRUST GATE (foreground exec path). Reached only when the recipe is about to
// RUN its steps — after the up-to-date / no-source-change skips above, which
// never exec and so need no gate. This gate is INDEPENDENT of those checks, so
// forging index.geml's `commit` (or removing git) to force a rebuild cannot
// bypass it: it only changes which skip is taken, never whether an untrusted
// recipe may exec. An empty recipe execs nothing and is not gated.
if (steps.length && !trusted) {
  refuseUntrusted();
  process.exit(3);
}

appendFileSync(logPath, `\n[${new Date().toISOString()}] refresh @ ${head ?? "no-git"}\n`);
for (const step of steps) {
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
appendFileSync(logPath, "ok\n");
console.error(`codemap refresh: done${head ? ` @ ${head.slice(0, 10)}` : ""} (${steps.length} step(s))`);

// --commit: land the refreshed codemap as its own follow-up commit so it
// rides the next push with the code. Guards: HEAD must not have moved while
// the indexer ran (a switched branch or new commit means these files belong
// to a different base — leave them in the tree), and never during a merge.
if (autoCommit && head) {
  const g = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  const headNow = g("rev-parse", "HEAD").stdout?.trim();
  const merging = g("rev-parse", "-q", "--verify", "MERGE_HEAD").status === 0;
  if (headNow !== head || merging) {
    console.error(`codemap refresh: not auto-committing (${merging ? "merge in progress" : "HEAD moved during the refresh"}) — refreshed files left in the working tree`);
  } else {
    const rel = relative(root, cmDir).replace(/\\/g, "/") || ".";
    // Runtime noise in _index (refresh/serve logs, serve.pid) never belongs in
    // the commit — and this very run appends to refresh.log after committing.
    const spec = ["--", rel, `:(exclude)${rel}/_index/refresh.log`, `:(exclude)${rel}/_index/serve.log`, `:(exclude)${rel}/_index/serve.pid`];
    g("add", "-A", ...spec); // new pages need staging; pathspec keeps it surgical
    const c = g("commit", "-m", `chore(codemap): refresh for ${head.slice(0, 7)}`, ...spec);
    if (c.status === 0) {
      const sha = g("rev-parse", "--short", "HEAD").stdout?.trim();
      appendFileSync(logPath, `auto-commit ${sha}\n`);
      console.error(`codemap refresh: committed as ${sha} (chore(codemap): refresh for ${head.slice(0, 7)})`);
    } else {
      console.error(`codemap refresh: nothing to commit (codemap unchanged)`);
    }
  }
}
