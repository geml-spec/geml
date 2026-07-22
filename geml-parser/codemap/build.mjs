#!/usr/bin/env node
// geml-code-graph build — one shot: adapter → exchange format (build/) → GEML tree (graph/).
//
//   geml codemap build --root <repo-root>                               # AUTO: detect languages,
//                                                                       # run the right indexer(s), merge into one map
//   geml codemap build --db <graph.db>  --root <repo-root>              # crg
//   geml codemap build --adapter joern --raw <dir> \
//                                        --adapter scip  --raw <index.scip> --root <repo>  # merged multi-language
//   geml codemap build --adapter joern --raw <dir> --root <repo-root>   # joern
//                                [--out .geml-code-graph] [--build .geml-code-graph/_build]
//                                [--container module|dir|file]   container granularity (default dir)
//                                [--lang <JAVASRC|NEWC|…>]   force the Joern frontend (auto mode,
//                                                            mixed-majority repos)
//                                [--joern <path>]   Joern install (auto mode): the launcher OR the
//                                                   unzipped joern-cli dir; else GEML_JOERN, else PATH
//                                [--history [-m "msg"]]   snapshot changed docs into .gemlhistory
//                                                         sidecars (per-node history + revert)
//
// Auto mode (no --adapter and no --db, just --root): detect.mjs picks the
// indexer per language from manifests + source extensions, we run scip
// (npx @sourcegraph/scip-typescript for TS/JS, rust-analyzer scip for Rust)
// and/or Joern (joern-export.sc) into <out>/_build/, then feed the results
// into the SAME merge as the explicit --adapter path, and record the replay
// recipe into _index/refresh.json.
//
// Output shape: docs/codemap-profile.md — one document per container (single
// meta with module/src/entry, empty-body code blocks with src=/anchor=, and
// the #calls / #called-by / #unresolved CSV edge tables). Verify with
// geml codemap verify (geml check + profile reference checks).
//
// Adapters (docs/DESIGN-geml-code-graph.md §3):
//   crg    code-review-graph SQLite graph.db (tree-sitter level; everything
//          honestly labelled resolution:"heuristic")           [P0, default]
//   joern  Joern CPG export: run geml-parser/codemap/joern-export.sc inside
//          joern first; --raw points at its outDir              [P1]
//
// After building, run:  geml codemap verify <out-dir>
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, basename, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { emit } from "./emit.mjs";
import { makeExcluder } from "./exclude.mjs";
import { detectLanguages, indexerCommand, collectSourceFiles } from "./detect.mjs";
import { loadOrSeedFoldings } from "./foldings.mjs";
import { detectEntries } from "./entries.mjs";
import { discoverModuleRoots } from "./normalize.mjs";
import { recipeFingerprint, trustRecipe, RECIPE_VERSION } from "./recipe-trust.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const USAGE = [
  "usage: geml codemap build [--root <repo-root>]   # auto-detect languages, index, and merge (--root defaults to the current directory)",
  "   or: geml codemap build (--db <graph.db> | --adapter joern|scip --raw <dir|index.scip> [--remap <virtual-dir>])+  [--root <repo-root>] [--out .geml-code-graph] [--build .geml-code-graph/_build] [--container module|dir|file] [--lang <LANG>] [--joern <path>] [--exclude <glob>]... [--no-gitignore] [--history [-m msg]]",
].join("\n");
if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); process.exit(0); }

// --root defaults to the current directory, so `geml codemap build` with no
// arguments indexes the repo you're standing in.
const root = flag("--root", ".");
const outDir = resolve(flag("--out", ".geml-code-graph"));
// Intermediates live INSIDE the codemap dir (alongside _index) so a build
// leaves nothing scattered at the repo root — `.geml-code-graph/_build/`.
const buildDir = resolve(flag("--build", join(outDir, "_build")));

// Adapter inputs are REPEATABLE — one codemap can merge several extractions
// (e.g. Joern for the Java modules + SCIP for the TypeScript ones). Each
// `--adapter X` opens a group; the following `--db`/`--raw` belongs to it.
// A bare `--db` without `--adapter` keeps the historical crg default.
const inputs = [];
{
  let cur = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--adapter") { cur = { adapter: args[++i] }; inputs.push(cur); }
    else if (args[i] === "--db") { if (!cur) { cur = { adapter: "crg" }; inputs.push(cur); } cur.db = args[++i]; cur = null; }
    else if (args[i] === "--raw") { if (!cur) { console.error("--raw needs a preceding --adapter"); process.exit(2); } cur.raw = args[++i]; cur = null; }
    // --remap <virtual dir>: the preceding scip input was produced over an
    // SFC virtual dir (sfc-virtualize.mjs) — the adapter maps shadow paths
    // back to the original .vue/.svelte sources. Recorded into refresh.json
    // so replays keep the remapping.
    else if (args[i] === "--remap") { if (!inputs.length) { console.error("--remap needs a preceding --adapter/--raw group"); process.exit(2); } inputs[inputs.length - 1].remap = args[++i]; }
  }
}
// ---- auto-detect mode -------------------------------------------------------
// A --root with NO --adapter and NO --db (inputs still empty): detect the
// languages ourselves, run the right indexer(s) into <out>/_build/, then push
// the results into `inputs` so the merge below runs UNCHANGED. This is the
// one-command onboarding path; the explicit --adapter/--db paths are untouched.
let recordRecipe = null; // { rootAbs, steps } — written to refresh.json after emit
let detectedLanguages = []; // languages seen in auto-detect; seeds foldings' language conventions
let entryHints = []; // app-entry hints (entries.mjs), matched to symbols in emit
if (root && !inputs.length) {
  const rootAbs = resolve(root);
  const excludeGlobs0 = args.flatMap((v, i) => (args[i - 1] === "--exclude" ? [v] : []));
  const { files, manifests, pkgs } = collectSourceFiles(rootAbs);
  const excluder = makeExcluder({
    root: rootAbs, globs: excludeGlobs0, gitignore: !args.includes("--no-gitignore"),
    files: [...files, ...manifests, ...pkgs], exec: execFileSync,
  });
  const jobs = detectLanguages(rootAbs, { files, manifests, pkgs, excluder });
  detectedLanguages = [...new Set(jobs.map((j) => j.language))];
  // App-entry hints from manifests/layout/source markers — pure detection now,
  // matched to extracted symbols (or noted file-level) inside emit.
  entryHints = detectEntries(rootAbs, {
    files: files.filter((f) => !excluder(f)),
    manifests: manifests.filter((m) => !excluder(m)),
    pkgs: (pkgs ?? []).filter((p) => !excluder(p)),
  });

  // --lang forces the Joern frontend (GEML_LANG) — the escape hatch for a
  // mixed repo whose majority language isn't the one you want. Joern jobs only.
  const langOverride = flag("--lang");
  if (langOverride) {
    const L = langOverride.toUpperCase();
    const touched = jobs.filter((j) => j.indexer === "joern");
    for (const j of touched) { j.gemlLang = L; j.signal += ` --lang ${L}`; }
    if (!touched.length) console.error(`--lang ${langOverride}: no Joern language detected to override (ignored)`);
  }

  if (!jobs.length) {
    console.error(`could not auto-detect a supported language under ${rootAbs}.`);
    console.error("supported: TypeScript/JS, Rust (scip); Java, C, Python, Go, Kotlin (joern).");
    console.error("pass an explicit --adapter scip|joern --raw <in> or --db <graph.db> instead (geml codemap build --help).");
    process.exit(1);
  }

  // Space-aware quote: wrap a token in double quotes only when it contains
  // whitespace or a quote. Used for (a) the PROGRAM token of a spawned command
  // and (b) recording human-readable recipe steps into refresh.json. The
  // program token must NOT be blanket-quoted: a bare launcher name resolved via
  // PATH (npx / joern) whose .cmd/.bat shim uses %~dp0 breaks if the name is
  // quoted — cmd then resolves %~dp0 against the cwd, not the shim's dir. A
  // spaced launcher PATH is a full path, so quoting it keeps %~dp0 correct.
  const q = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
  // Hardened quote for command ARGUMENTS on win32. Node does NOT escape args
  // under shell:true — it only concatenates them (Node DEP0190) — so an
  // unquoted argument such as a source directory named `a&calc` reaching the
  // --output path would break out of the command and run `calc`. ALWAYS wrap in
  // double quotes: inside quotes cmd.exe treats & | < > ( ) ^ and whitespace as
  // literal, neutralizing injection while keeping spaced paths intact. Embedded
  // quotes / trailing backslash runs follow the CRT rules so the child's
  // CommandLineToArgvW recovers the exact token.
  const shq = (s) => `"${String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  // Run a command PORTABLY. On Windows we MUST go through cmd.exe (shell:true):
  // npx.cmd / joern.bat / rust-analyzer.bat are .cmd/.bat launchers and modern
  // Node refuses to spawn those with shell:false (EINVAL). Build ONE pre-escaped
  // command string ourselves (never an args array — that is the unescaped
  // DEP0190 path): the program via q (bare names stay bare so a shim's %~dp0
  // resolves), every argument via shq (always quoted, so no argument can
  // inject). On unix we exec the binary directly (no shell, no injection).
  const runCmd = (argv, opts = {}) =>
    (process.platform === "win32"
      ? spawnSync([q(argv[0]), ...argv.slice(1).map(shq)].join(" "), { shell: true, ...opts })
      : spawnSync(argv[0], argv.slice(1), opts));

  // Resolve the Joern launcher, honoring an explicit install location so users
  // (Windows especially) need not put joern on PATH. A --joern / GEML_JOERN
  // value may be the launcher itself OR the unzipped joern-cli DIRECTORY holding
  // it (joern.bat on Windows, joern on unix). Tried in order — --joern flag,
  // then GEML_JOERN, then `joern` on PATH — and the first that answers
  // `--version` wins. GEML_SRC/GEML_OUT/GEML_LANG always pass as ENV VARS, never
  // --param (the Windows joern.bat -> repl-bridge hop mangles --param).
  const launcherName = process.platform === "win32" ? "joern.bat" : "joern";
  const asLauncher = (v) => {
    try { if (statSync(v).isDirectory()) return join(v, launcherName); } catch { /* not a dir: a launcher path or bare command */ }
    return v;
  };
  let joernBin = null;
  const joernJobs = jobs.filter((j) => j.indexer === "joern");
  if (joernJobs.length) {
    // Joern creates a `workspace/` CPG cache in its CWD on startup — even for
    // `--version`. Probe (and, below, run) it FROM the build dir so that cache
    // lands in _build/, never scattered at the repo root. buildDir must exist
    // first (it is also (re)created before emit); mkdir is idempotent.
    mkdirSync(buildDir, { recursive: true });
    for (const cand of [flag("--joern"), process.env.GEML_JOERN, "joern"].filter((v) => v)) {
      const bin = asLauncher(cand);
      const r = runCmd([bin, "--version"], { stdio: "ignore", cwd: buildDir });
      if (!r.error && r.status === 0) { joernBin = bin; break; }
    }
    if (!joernBin) {
      const langs = [...new Set(joernJobs.map((j) => j.language))].join(", ");
      console.error(
        `Joern is required for ${langs} but was not found (looked at --joern, GEML_JOERN, then PATH).\n`
        + "Install one and retry:\n"
        + "  macOS/Linux:\n"
        + "    mkdir joern && cd joern\n"
        + '    curl -L "https://github.com/joernio/joern/releases/latest/download/joern-install.sh" -o joern-install.sh\n'
        + "    chmod +x joern-install.sh && ./joern-install.sh\n"
        + "  Windows:\n"
        + "    download joern-cli.zip from https://github.com/joernio/joern/releases , unzip it, then\n"
        + "    add that folder to PATH or pass  --joern <unzipped-folder>\n"
        + "Docs: https://docs.joern.io/installation",
      );
      process.exit(1);
    }
  }

  // Same courtesy for Rust: rust-analyzer produces the SCIP index, so probe it
  // BEFORE any slow work and fail with install instructions instead of a
  // mid-build spawn error. (A rustup shim without the component installed also
  // answers `--version` non-zero, so it lands here too.)
  if (jobs.some((j) => j.language === "Rust")) {
    const r = runCmd(["rust-analyzer", "--version"], { stdio: "ignore" });
    if (r.error || r.status !== 0) {
      console.error(
        "rust-analyzer is required for Rust but was not found on PATH (or is not runnable).\n"
        + "Install it and retry:\n"
        + "  rustup component add rust-analyzer      # rustup-managed toolchains\n"
        + "  or download a release binary: https://github.com/rust-lang/rust-analyzer/releases\n"
        + "and make sure `rust-analyzer --version` works in this shell.",
      );
      process.exit(1);
    }
  }

  // Transparent plan before doing any slow work.
  // A monorepo with vendored trees (next.js's src/compiled: 140 package.json
  // bundles) turns the full job list into a wall — summarize past 10.
  if (jobs.length > 10) {
    const byLang = new Map();
    for (const j of jobs) byLang.set(j.language, (byLang.get(j.language) ?? 0) + 1);
    const langs = [...byLang].map(([l, n]) => (n > 1 ? `${l}×${n}` : l)).join(", ");
    const sample = jobs.slice(0, 5).map((j) => j.subroot ?? j.language).join("; ");
    console.error(`detected: ${jobs.length} jobs (${langs}) — e.g. ${sample}; … (vendored trees inflating this? --exclude "path/**" trims them)`);
  } else {
    console.error(`detected: ${jobs.map((j) => `${j.language}${j.subroot ? `[${j.subroot}]` : ""} (${j.signal}) -> ${j.indexer}${j.gemlLang ? `[${j.gemlLang}]` : ""}`).join("; ")}`);
  }

  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "joern-export.sc");
  const scriptPosix = scriptPath.replace(/\\/g, "/");
  const sfcScript = resolve(dirname(fileURLToPath(import.meta.url)), "sfc-virtualize.mjs");
  const sfcScriptPosix = sfcScript.replace(/\\/g, "/");
  const relToRoot = (p) => (relative(rootAbs, p).replace(/\\/g, "/") || ".");
  mkdirSync(buildDir, { recursive: true });
  // Structured recipe steps { cwd?, env?, argv:[...] } (security fix R2-1).
  // Attacker-controllable sub-project dir names appear here ONLY as DISCRETE
  // structured values (a step's cwd, or an argv element) — NEVER concatenated
  // into a shell string at rest. refresh executes each step without building an
  // attacker-influenced command line (see codemap/refresh.mjs).
  const indexSteps = [];
  // Build a recorded step's env map, dropping undefined values so the step's
  // fingerprint stays stable (GEML_LANG is unset for scip jobs).
  const envOf = (obj) => {
    const env = {};
    for (const [k, v] of Object.entries(obj)) if (v != null) env[k] = String(v);
    return env;
  };

  console.error("indexing...");
  const failedLangs = [];
  for (const job of jobs) {
    let cmd = indexerCommand(job, { root: rootAbs, buildDir, scriptPath, sfcScript });
    let preStep = null;
    if (cmd.pre) {
      // SFC job: run the virtualizer first. If it fails (offline npx, exotic
      // SFC syntax), the project must not lose its plain TS coverage — fall
      // back to the sfc-less job and say the gap out loud.
      const pr = runCmd(cmd.pre.argv, {
        cwd: cmd.pre.cwd, stdio: "inherit",
        env: { ...process.env, ...cmd.pre.env },
      });
      if (pr.error || pr.status !== 0) {
        console.error(
          `sfc virtualizer failed for ${job.language}${job.subroot ? `[${job.subroot}]` : ""} `
          + `(${pr.error ? pr.error.message : `exit ${pr.status}`}) — falling back to plain TS indexing; `
          + ".vue/.svelte files stay invisible until this is fixed and build re-runs.",
        );
        cmd = indexerCommand({ ...job, sfc: undefined }, { root: rootAbs, buildDir, scriptPath, sfcScript });
      } else {
        // Runs at root (cmd.pre.cwd === root), so no cwd; the virtualizer reads
        // GEML_SRC/GEML_OUT (relative to root) from env. argv[-1] is the script
        // path — record the forward-slash form.
        preStep = {
          env: envOf({ GEML_SRC: relToRoot(cmd.pre.env.GEML_SRC), GEML_OUT: relToRoot(cmd.pre.env.GEML_OUT) }),
          argv: [...cmd.pre.argv.slice(0, -1), sfcScriptPosix],
        };
      }
    }
    // scip runs the npx launcher; joern runs the resolved launcher. Env
    // (GEML_SRC/OUT/LANG for joern) rides through the spawn options.
    const argv = [job.indexer === "joern" ? joernBin : cmd.argv[0], ...cmd.argv.slice(1)];
    const r = runCmd(argv, {
      cwd: cmd.cwd, stdio: "inherit",
      env: cmd.env ? { ...process.env, ...cmd.env } : process.env,
    });
    if (r.error || r.status !== 0) {
      // One language failing must not sink the others' finished work — keep
      // going, build what succeeded, and say the gap out loud below. Name the
      // subroot so a monorepo says WHICH project's indexer died, not just the
      // language (several TS projects can each have their own scip job).
      const where = job.subroot ? `${job.language} at ${job.subroot}` : job.language;
      console.error(`indexer failed for ${where} (${job.indexer}): ${r.error ? r.error.message : `exit ${r.status}`}`);
      failedLangs.push(job.language);
      continue;
    }
    inputs.push({ adapter: cmd.adapter, raw: cmd.raw, remap: cmd.remapDir });
    // Recipe step (paths relative to <root>, the cwd refresh replays in) —
    // successful steps only, so `refresh` replays a recipe that works.
    if (preStep) indexSteps.push(preStep);
    if (job.indexer === "scip") {
      // Subrooted jobs replay from their own dir (SFC jobs from the virtual
      // dir, standalone crates from the crate dir); the output path is written
      // relative to THAT cwd, recorded as step.cwd (omitted when it is root).
      const relRaw = relative(cmd.cwd, cmd.raw).replace(/\\/g, "/");
      const cwdRel = relToRoot(cmd.cwd);
      const step = {};
      if (cwdRel !== ".") step.cwd = cwdRel;
      step.argv = cmd.argv[0] === "npx"
        ? [...cmd.argv.slice(0, -1), relRaw]
        : ["rust-analyzer", "scip", ".", "--output", relRaw];
      indexSteps.push(step);
    } else {
      // Joern replays IN the build dir (cmd.cwd), so its workspace cache lands
      // under _build/ on refresh too — not at the repo root. Re-base the env
      // paths on that cwd: GEML_SRC climbs back to the root, GEML_OUT is the raw
      // dir's name (a sibling under _build). Mirrors the subrooted-scip step.
      const relRaw = relative(cmd.cwd, cmd.raw).replace(/\\/g, "/");
      const srcRel = relative(cmd.cwd, rootAbs).replace(/\\/g, "/") || ".";
      const cwdRel = relToRoot(cmd.cwd);
      const step = {
        env: envOf({ GEML_SRC: srcRel, GEML_OUT: relRaw, GEML_LANG: job.gemlLang }),
        argv: ["joern", "--script", scriptPosix],
      };
      if (cwdRel !== ".") step.cwd = cwdRel;
      indexSteps.push(step);
    }
  }
  if (!inputs.length) {
    console.error("every indexer failed — nothing to build.");
    process.exit(1);
  }
  if (failedLangs.length) {
    console.error(`WARNING: continuing WITHOUT ${failedLangs.join(", ")} — the codemap covers the remaining language(s) only. Fix that indexer and re-run build to fill the gap.`);
  }
  console.error("merging...");
  recordRecipe = { rootAbs, indexSteps };
}

const bad = inputs.find((s) => !["crg", "joern", "scip"].includes(s.adapter) || (s.adapter === "crg" ? !s.db : !s.raw));
if (!inputs.length || bad) {
  console.error(USAGE);
  process.exit(2);
}

// Extract every input and concatenate — anchors are namespaced by language and
// path, so inputs don't collide; identical anchors across inputs are dropped
// with a warning (first input wins).
const symbols = [];
const edges = [];
const seenAnchors = new Set();
for (const spec of inputs) {
  const { extract } = await import(`./adapters/${spec.adapter}.mjs`);
  const r = extract(spec.adapter === "crg" ? { db: spec.db, root } : { raw: spec.raw, root, remapDir: spec.remap });
  let dropped = 0;
  for (const s of r.symbols) {
    if (seenAnchors.has(s.anchor)) { dropped++; continue; }
    seenAnchors.add(s.anchor);
    symbols.push(s);
  }
  for (const e of r.edges) edges.push(e);
  console.error(`input ${spec.adapter}: ${r.symbols.length} symbols, ${r.edges.length} edges${dropped ? ` (${dropped} duplicate anchors dropped)` : ""}`);
}

// Exclusion: drop symbols whose source file is git-ignored (default) or
// matches an explicit --exclude glob. Vendored copies and third-party dumps
// belong out of the graph; the edge tables key on surviving anchors, so
// dangling references simply vanish (emit skips edges whose endpoints are
// gone). --no-gitignore turns off the git-driven half.
const excludeGlobs = args.flatMap((v, i) => (args[i - 1] === "--exclude" ? [v] : []));
const excluder = makeExcluder({
  root: resolve(root),
  globs: excludeGlobs,
  gitignore: !args.includes("--no-gitignore"),
  files: [...new Set(symbols.map((s) => s.file))],
  exec: execFileSync,
});
const kept = symbols.filter((s) => !excluder(s.file));
const excludedCount = symbols.length - kept.length;

// App-entry hints for the EXPLICIT-adapter path too (auto mode computed them
// alongside language detection): the entry signals live in the repo's
// manifests and sources, not in how the indexes were produced.
if (root && !recordRecipe && !entryHints.length) {
  const rootAbs = resolve(root);
  const c = collectSourceFiles(rootAbs);
  const excl = makeExcluder({
    root: rootAbs, globs: excludeGlobs, gitignore: !args.includes("--no-gitignore"),
    files: [...c.files, ...c.manifests, ...c.pkgs], exec: execFileSync,
  });
  entryHints = detectEntries(rootAbs, {
    files: c.files.filter((f) => !excl(f)),
    manifests: c.manifests.filter((m) => !excl(m)),
    pkgs: c.pkgs.filter((p) => !excl(p)),
  });
}
if (excludedCount) {
  symbols.length = 0;
  for (const s of kept) symbols.push(s);
  console.error(
    `excluded ${excludedCount} symbol(s) via ${!args.includes("--no-gitignore") ? ".gitignore" : "(gitignore off)"}`
    + `${excludeGlobs.length ? ` + ${excludeGlobs.length} --exclude glob(s)` : ""}`,
  );
}

// Exchange format on disk — the layer contract (§3). Deterministic order so
// the jsonl files diff cleanly across builds.
symbols.sort((a, b) => a.anchor.localeCompare(b.anchor));
edges.sort((a, b) =>
  a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind)
  || String(a.to ?? a.to_text).localeCompare(String(b.to ?? b.to_text)));
mkdirSync(buildDir, { recursive: true });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const writeIfChanged = (p, content) => {
  if (existsSync(p) && readFileSync(p, "utf8") === content) return;
  writeFileSync(p, content);
};
writeIfChanged(join(buildDir, "symbols.jsonl"), jsonl(symbols));
writeIfChanged(join(buildDir, "edges.jsonl"), jsonl(edges));

// Container granularity (codemap profile): module = first path segment,
// dir = containing directory (default), file = one document per source file.
const containerGranularity = flag("--container", "dir");
if (!["module", "dir", "file"].includes(containerGranularity)) {
  console.error(`--container must be module|dir|file (got '${containerGranularity}')`);
  process.exit(2);
}
// Best-effort commit stamp for index.geml meta.
let commit;
try {
  commit = execFileSync("git", ["-C", resolve(root), "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch { /* not a git repo */ }

// Ceremony-folding config: read _index/foldings.geml, or seed it on this first
// build from the discovered module roots + detected languages. Human-owned
// once seeded (never rewritten); threaded into emit for display normalisation.
const { config: foldings, seeded: foldingsSeeded } = loadOrSeedFoldings({
  outDir,
  moduleRoots: discoverModuleRoots(resolve(root)),
  languages: detectedLanguages,
});
if (foldingsSeeded) console.error("seeded _index/foldings.geml — edit to tune module folding");

const stats = emit({
  symbols, edges, outDir, buildDir,
  repoName: basename(resolve(root)),
  container: containerGranularity,
  commit,
  root: resolve(root),
  foldings,
  entryHints,
});

// Keep the transient build dir out of version control while the `.geml` graph
// and `_index/` stay committable (the graph is meant to be committed & shared).
// `_build/` holds only regenerable intermediates — the *.jsonl exchange files
// and Joern's `workspace/` CPG cache — so one ignore rule covers them all.
// Written once; a user's later edits to this file are preserved, never clobbered.
const ignoreFile = join(outDir, ".gitignore");
if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, "_build/\n");

console.error(
  `geml-code-graph: ${stats.methods} methods (${stats.symbols} symbols), ${stats.edges} edges `
  + `(${stats.resolved} resolved), ${stats.leaves} leaves, ${stats.entries} app entries -> `
  + `${stats.containers} containers (${stats.written} of ${stats.docs} files written), `
  + `${(stats.bytes / 1048576).toFixed(2)} MB -> ${outDir}`,
);

// --history: snapshot every changed document into its .gemlhistory sidecar —
// the graph's own architectural history (geml history log / revert per node).
// Targets = documents rewritten this build, plus any document that has no
// sidecar yet (first run, or --history adopted later).
if (args.includes("--history")) {
  const histMod = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/history.js");
  if (!existsSync(histMod)) {
    console.error("--history needs the built parser (cd geml-parser && npm install && npm run build)");
    process.exit(1);
  }
  const { commit, isCurrent } = await import(`file://${histMod.replace(/\\/g, "/")}`);
  const message = flag("-m", flag("--message", "graph build"));
  const targets = new Set(stats.writtenDocs);
  for (const d of stats.allDocs) {
    if (targets.has(d)) continue;
    const gemlPath = join(outDir, d);
    const sidecar = gemlPath.replace(/\.geml$/, ".gemlhistory");
    // No sidecar yet, or the sidecar tip drifted from the file (a previous
    // commit attempt was refused): both need a snapshot even though this build
    // did not rewrite the document.
    if (!existsSync(sidecar) || !isCurrent(sidecar, gemlPath)) targets.add(d);
  }
  let committed = 0;
  const histFailed = [];
  for (const d of [...targets].sort()) {
    const gemlPath = join(outDir, d);
    try {
      commit({ gemlPath, historyPath: gemlPath.replace(/\.geml$/, ".gemlhistory"), summary: message });
      committed++;
    } catch (e) {
      // One document's history refusing a commit (e.g. the round-trip gate)
      // must not abort the build or the other documents' snapshots. The
      // failing document's previous revision stays intact.
      histFailed.push(d);
      console.error(`history: ${d}: ${e.message}`);
    }
  }
  console.error(
    `history: committed ${committed} document(s) (${stats.allDocs.length - committed - histFailed.length} unchanged, skipped)`
    + (histFailed.length ? `; FAILED: ${histFailed.join(", ")}` : ""),
  );
}

// Auto mode records the exact replay recipe (index → explicit build → verify)
// into _index/refresh.json on the FIRST build, so `geml codemap refresh` (and
// the commit hook) can reproduce it. An existing recipe is left untouched —
// EXCEPT one whose on-disk schema `version` does not match RECIPE_VERSION:
// refresh refuses an out-of-date recipe, so a rebuild re-records it in the
// current format. Judging by a standalone schema version (not the parser
// version, which bumps every patch) means a FUTURE format change is cleanly
// detected without a parser bump forcing a needless re-index. This is the
// "re-run build" upgrade path refresh points users to; a recipe already at the
// current version stays write-once (not clobbered). Paths are relative to
// <root>, which is the cwd refresh runs each step in.
if (recordRecipe) {
  const cfgPath = join(outDir, "_index", "refresh.json");
  let needsRerecord = false;
  if (existsSync(cfgPath)) {
    try { needsRerecord = JSON.parse(readFileSync(cfgPath, "utf8")).version !== RECIPE_VERSION; }
    catch { needsRerecord = true; }   // unparseable → re-record clean
  }
  if (!existsSync(cfgPath) || needsRerecord) {
    const rel = (p) => (relative(recordRecipe.rootAbs, p).replace(/\\/g, "/") || ".");
    const relOut = rel(outDir);
    // Structured build + verify steps (security fix R2-1): argv arrays, never a
    // shell string. Each `--adapter/--raw[/--remap]` group is discrete tokens.
    const buildArgv = ["geml", "codemap", "build",
      ...inputs.flatMap((s) => ["--adapter", s.adapter, "--raw", rel(s.raw), ...(s.remap ? ["--remap", rel(s.remap)] : [])]),
      "--root", ".", "--out", relOut,
      ...(containerGranularity !== "dir" ? ["--container", containerGranularity] : []),
      ...(args.includes("--history") ? ["--history"] : []),
    ];
    // Parser version — recorded as `generator` PROVENANCE only, never as part of
    // the compatibility check or the fingerprint (it bumps every patch release;
    // judging by it would force a full re-index of every project each release).
    const pkgVersion = (() => {
      try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version; }
      catch { return "?"; }
    })();
    const cfg = {
      version: RECIPE_VERSION,
      generator: `geml ${pkgVersion}`,
      // Project root relative to the codemap dir (refresh runs each step under
      // <root>). Normally outDir is a subdir of root so relative() yields ".."
      // etc.; when --out == --root it yields "" and the project root IS the
      // codemap dir, so record "." — recording ".." would send refresh into
      // the PARENT of the real root.
      root: relative(outDir, recordRecipe.rootAbs).replace(/\\/g, "/") || ".",
      steps: [...recordRecipe.indexSteps, { argv: buildArgv }, { argv: ["geml", "codemap", "verify", relOut] }],
    };
    mkdirSync(join(outDir, "_index"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    console.error(`recorded build recipe -> ${cfgPath}`);
    // Auto-trust the recipe we just authored (security fix C2). The user ran
    // build locally, so their own recipe is trusted by construction and the
    // normal build -> refresh flow needs no prompt. Uses the SAME fingerprint
    // fn as refresh, so the two agree exactly. Best-effort: a trust-store write
    // failure must not fail an otherwise-successful build — the user can still
    // approve later with `geml codemap refresh --trust`.
    try {
      trustRecipe(recipeFingerprint(cfg), outDir);
    } catch (e) {
      console.error(`warning: could not record the codemap recipe as trusted (${e.message}); run \`geml codemap refresh --trust\` after reviewing _index/refresh.json`);
    }
  }
}
console.error(`next: geml codemap verify ${outDir}`);
