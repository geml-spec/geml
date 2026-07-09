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
// (npx @sourcegraph/scip-typescript) and/or Joern (joern-export.sc) into
// <out>/_build/, then feed the results into the SAME merge as the explicit
// --adapter path, and record the replay recipe into _index/refresh.json.
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

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const root = flag("--root");
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
  }
}
// ---- auto-detect mode -------------------------------------------------------
// A --root with NO --adapter and NO --db (inputs still empty): detect the
// languages ourselves, run the right indexer(s) into <out>/_build/, then push
// the results into `inputs` so the merge below runs UNCHANGED. This is the
// one-command onboarding path; the explicit --adapter/--db paths are untouched.
let recordRecipe = null; // { rootAbs, steps } — written to refresh.json after emit
if (root && !inputs.length) {
  const rootAbs = resolve(root);
  const excludeGlobs0 = args.flatMap((v, i) => (args[i - 1] === "--exclude" ? [v] : []));
  const { files, manifests } = collectSourceFiles(rootAbs);
  const excluder = makeExcluder({
    root: rootAbs, globs: excludeGlobs0, gitignore: !args.includes("--no-gitignore"),
    files: [...files, ...manifests], exec: execFileSync,
  });
  const jobs = detectLanguages(rootAbs, { files, manifests, excluder });

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
    console.error("supported: TypeScript/JS (scip); Java, C, Python, Go, Kotlin (joern).");
    console.error("pass an explicit --adapter scip|joern --raw <in> or --db <graph.db> instead (geml codemap build --help).");
    process.exit(1);
  }

  // Shell-quote a single token so a spaced path (e.g. C:\Program Files\…) or
  // the codemap dir survives cmd.exe / sh word-splitting.
  const q = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
  // Run a command PORTABLY: on Windows go through cmd.exe (shell) so npx.cmd /
  // joern.bat resolve, quoting each token so spaced paths survive; on unix exec
  // the binary directly (execvp searches PATH, no quoting pitfalls). Mirrors the
  // `shell: process.platform === "win32"` pattern verify.mjs uses.
  const runCmd = (argv, opts = {}) =>
    (process.platform === "win32"
      ? spawnSync(argv.map(q).join(" "), { shell: true, ...opts })
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
    for (const cand of [flag("--joern"), process.env.GEML_JOERN, "joern"].filter((v) => v)) {
      const bin = asLauncher(cand);
      const r = runCmd([bin, "--version"], { stdio: "ignore" });
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

  // Transparent plan before doing any slow work.
  console.error(`detected: ${jobs.map((j) => `${j.language} (${j.signal}) -> ${j.indexer}${j.gemlLang ? `[${j.gemlLang}]` : ""}`).join("; ")}`);

  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "joern-export.sc");
  const scriptPosix = scriptPath.replace(/\\/g, "/");
  const relToRoot = (p) => (relative(rootAbs, p).replace(/\\/g, "/") || ".");
  mkdirSync(buildDir, { recursive: true });
  const indexSteps = [];

  console.error("indexing...");
  for (const job of jobs) {
    const cmd = indexerCommand(job, { root: rootAbs, buildDir, scriptPath });
    // scip runs the npx launcher; joern runs the resolved launcher. Env
    // (GEML_SRC/OUT/LANG for joern) rides through the spawn options.
    const argv = [job.indexer === "joern" ? joernBin : cmd.argv[0], ...cmd.argv.slice(1)];
    const r = runCmd(argv, {
      cwd: cmd.cwd, stdio: "inherit",
      env: cmd.env ? { ...process.env, ...cmd.env } : process.env,
    });
    if (r.error || r.status !== 0) {
      console.error(`indexer failed for ${job.language} (${job.indexer}): ${r.error ? r.error.message : `exit ${r.status}`}`);
      process.exit(1);
    }
    inputs.push({ adapter: cmd.adapter, raw: cmd.raw });
    // Recipe step (paths relative to <root>, the cwd refresh replays in). The
    // Joern env is written in the RECORDING host's native shell syntax —
    // refresh.json is machine-local (it re-invokes locally-installed indexers),
    // and cmd.exe ignores the POSIX `VAR=val cmd` prefix.
    if (job.indexer === "scip") {
      indexSteps.push(`npx --yes @sourcegraph/scip-typescript index --output ${relToRoot(cmd.raw)}`);
    } else {
      const relOut = relToRoot(cmd.raw);
      indexSteps.push(process.platform === "win32"
        ? `set "GEML_SRC=." && set "GEML_OUT=${relOut}" && set "GEML_LANG=${job.gemlLang}" && joern --script ${q(scriptPosix)}`
        : `GEML_SRC=. GEML_OUT=${relOut} GEML_LANG=${job.gemlLang} joern --script ${q(scriptPosix)}`);
    }
  }
  console.error("merging...");
  recordRecipe = { rootAbs, indexSteps };
}

const bad = inputs.find((s) => !["crg", "joern", "scip"].includes(s.adapter) || (s.adapter === "crg" ? !s.db : !s.raw));
if (!root || !inputs.length || bad) {
  console.error("usage: geml codemap build --root <repo-root>   # auto-detect languages, index, and merge");
  console.error("   or: geml codemap build (--db <graph.db> | --adapter joern|scip --raw <dir|index.scip>)+  --root <repo-root> [--out .geml-code-graph] [--build .geml-code-graph/_build] [--container module|dir|file] [--lang <LANG>] [--joern <path>] [--exclude <glob>]... [--no-gitignore] [--history [-m msg]]");
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
  const r = extract(spec.adapter === "crg" ? { db: spec.db, root } : { raw: spec.raw, root });
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

const stats = emit({
  symbols, edges, outDir, buildDir,
  repoName: basename(resolve(root)),
  container: containerGranularity,
  commit,
  root: resolve(root),
});

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
// the commit hook) can reproduce it. An existing recipe — and its last_commit
// stamp — is left untouched. Paths are relative to <root>, which is the cwd
// refresh runs each step in.
if (recordRecipe) {
  const cfgPath = join(outDir, "_index", "refresh.json");
  if (!existsSync(cfgPath)) {
    const rel = (p) => (relative(recordRecipe.rootAbs, p).replace(/\\/g, "/") || ".");
    const relOut = rel(outDir);
    const buildStep = ["geml codemap build",
      ...inputs.map((s) => `--adapter ${s.adapter} --raw ${rel(s.raw)}`),
      "--root .", `--out ${relOut}`,
      containerGranularity !== "dir" ? `--container ${containerGranularity}` : "",
      args.includes("--history") ? "--history" : "",
    ].filter(Boolean).join(" ");
    const cfg = {
      root: relative(outDir, recordRecipe.rootAbs).replace(/\\/g, "/") || "..",
      steps: [...recordRecipe.indexSteps, buildStep, `geml codemap verify ${relOut}`],
    };
    mkdirSync(join(outDir, "_index"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    console.error(`recorded build recipe -> ${cfgPath}`);
  }
}
console.error(`next: geml codemap verify ${outDir}`);
