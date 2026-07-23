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
import { recipeFingerprint, isRecipeTrusted, trustRecipe, trustStorePath, RECIPE_VERSION } from "./recipe-trust.mjs";

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

// --- structured-step execution (security fix R2-1) --------------------------
// A recipe step is a structured object { cwd?, env?, argv:[...] }. We run argv
// WITHOUT ever concatenating an attacker-controllable value into a shell
// string (the R2-1 RCE was a recorded `cd <dir-name> && …` string run under a
// shell, where <dir-name> was attacker-chosen).
//   POSIX: spawn the program directly (shell:false) — no shell, no injection.
//   win32: npx.cmd / geml.cmd / rust-analyzer / joern.bat are .cmd/.bat shims
//     that modern Node refuses to spawn with shell:false (EINVAL), so we go
//     through cmd.exe. Node does NOT escape args under shell:true — it only
//     concatenates them (DEP0190) — so we build the command line ourselves and
//     quote EACH argv element: the program via q (a bare launcher name stays
//     bare so its .cmd shim's %~dp0 resolves against the shim dir; a spaced
//     full path is quoted), every argument via shq (ALWAYS double-quoted, so
//     cmd.exe treats & | < > ( ) ^ and whitespace as literal). An injected
//     metachar inside a dir-name argument is therefore inert.
const q = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
const shq = (s) => `"${String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
// Human-readable render of a step for the log / refusal message — DISPLAY ONLY,
// never executed. Falls back to String() for a stale (non-structured) step.
const renderStep = (s) => {
  if (!s || typeof s !== "object" || !Array.isArray(s.argv)) return String(s);
  const parts = [];
  if (s.cwd && s.cwd !== ".") parts.push(`cd ${s.cwd} &&`);
  if (s.env) for (const [k, v] of Object.entries(s.env)) parts.push(`${k}=${v}`);
  parts.push(...s.argv.map(String));
  return parts.join(" ");
};
// A step is executable only when it is a structured object with a non-empty
// argv array. Anything else is a stale pre-R2-1 shell string (or malformed);
// it must be REFUSED, never run as a shell string.
const isStructuredStep = (s) => !!s && typeof s === "object" && Array.isArray(s.argv) && s.argv.length > 0;

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
  for (const s of steps) console.error(`    $ ${renderStep(s)}`);
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

// VERSION GATE. The on-disk step schema is versioned (RECIPE_VERSION): refuse a
// recipe recorded in any other format so a FUTURE format change is cleanly
// detected and the user is pointed at `geml codemap build` to regenerate it. A
// pre-versioning recipe (no `version` at all) is likewise refused. This judges
// the STANDALONE schema version, never the parser/`generator` version — the
// parser bumps every patch release, so using it here would force a full
// re-index of every project on each release. Reached only on the exec path
// (after the skips above, which never run steps).
if (cfg.version !== RECIPE_VERSION) {
  console.error(`codemap refresh: REFUSING — recipe format out of date (${cfgPath})`);
  console.error(`  recorded format: v${cfg.version ?? "(pre-versioning)"}; this geml expects v${RECIPE_VERSION}`);
  console.error("re-run `geml codemap build` to regenerate refresh.json.");
  process.exit(1);
}
// STRUCTURE GUARD (the R2-1 invariant). Even a current-version recipe must not
// hand a non-structured step to the exec loop: a legacy shell STRING run through
// a shell is the exact RCE R2-1 closed. Refuse any step that is not a
// { argv: [...] } object rather than execute it.
const badIdx = steps.findIndex((s) => !isStructuredStep(s));
if (badIdx >= 0) {
  console.error(`codemap refresh: REFUSING — step ${badIdx + 1} is not a { argv: [...] } step (${cfgPath})`);
  console.error("re-run `geml codemap build` to regenerate refresh.json.");
  process.exit(1);
}

appendFileSync(logPath, `\n[${new Date().toISOString()}] refresh @ ${head ?? "no-git"}\n`);
for (const step of steps) {
  appendFileSync(logPath, `$ ${renderStep(step)}\n`);
  // Per-step cwd (relative to the project root, forward-slash) and env, merged
  // over the current environment. Both may hold attacker-controlled dir names —
  // they ride as a real cwd PATH / discrete argv elements, never shell syntax.
  const stepCwd = resolve(root, step.cwd || ".");
  const stepEnv = step.env ? { ...process.env, ...step.env } : process.env;
  const argv = step.argv.map(String);
  // Stream the step's output STRAIGHT into the log file. Capturing it in
  // memory (spawnSync + encoding) hits the default 1MB maxBuffer — Joern's
  // INFO firehose blew it and the child got killed mid-export (exit null).
  // A file descriptor has no such limit, and the log tails live.
  const fd = openSync(logPath, "a");
  const r = process.platform === "win32"
    // win32: build ONE pre-escaped command line (each element quoted so no arg
    // can inject), run it through cmd.exe for the .cmd/.bat launchers.
    ? spawnSync([q(argv[0]), ...argv.slice(1).map(shq)].join(" "),
      { shell: true, cwd: stepCwd, env: stepEnv, stdio: ["ignore", fd, fd] })
    // POSIX: exec the program directly with an args array — no shell involved.
    : spawnSync(argv[0], argv.slice(1),
      { shell: false, cwd: stepCwd, env: stepEnv, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  if (r.status !== 0) {
    const why = r.status ?? r.signal ?? r.error?.message ?? "killed";
    appendFileSync(logPath, `FAILED (exit ${why})\n`);
    console.error(`codemap refresh: step failed (exit ${why}): ${renderStep(step)}\n  log: ${logPath}`);
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
    // Exclude-pathspec prefix: empty when the codemap IS the repo root. A `./`
    // prefix (what `${rel}/…` yields at rel=".") is rejected by some git
    // versions inside `:(exclude)…`, silently un-excluding the logs or failing
    // the commit — so build `_index/…` bare at root, `<rel>/_index/…` in a subdir.
    const relPrefix = rel === "." ? "" : `${rel}/`;
    // Runtime noise in _index (refresh/serve logs, serve.pid) never belongs in
    // the commit — and this very run appends to refresh.log after committing.
    const spec = ["--", rel, `:(exclude)${relPrefix}_index/refresh.log`, `:(exclude)${relPrefix}_index/serve.log`, `:(exclude)${relPrefix}_index/serve.pid`];
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
