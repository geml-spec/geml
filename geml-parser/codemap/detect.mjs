// geml-code-graph language auto-detection — the `geml codemap build --root <dir>`
// "fastest onboarding" path: no --adapter, no --db, no --lang, one command.
//
// detectLanguages walks the project tree and decides, per language, which
// indexer runs and — for Joern — which frontend (GEML_LANG). It mirrors the
// geml-code-graph skill's detection table: MANIFESTS first (a pom.xml means
// Java even if generated .js outnumber .java), THEN source-file EXTENSIONS.
// A repo can yield several jobs (TypeScript via SCIP + Java via Joern);
// build.mjs runs each and merges every extraction into ONE codemap.
//
// Pure by design: given a precomputed { files, manifests } it touches no
// filesystem, so it unit-tests without any indexer installed. indexerCommand
// turns one job into the argv/env/raw a subprocess (and the refresh recipe)
// needs — also pure. Neither ever spawns a process.

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Directories that never hold first-party source: pruned during the walk so a
// vendored dependency tree or build output can't swing the extension counts
// (and drag a whole Joern frontend into the build). Mirrors normalize.mjs
// SKIP_DIRS plus the codemap's own output dir.
export const SKIP_DIRS = new Set([
  "node_modules", "target", "dist", "out", "build", ".git", "vendor",
  ".geml-code-graph", ".geml-build", ".idea", ".gradle",
]);

// Manifest filename -> the language it declares. Presence is a STRONG signal
// (no threshold): it fires even for a single source file, and takes priority
// over the extension count.
const MANIFEST_LANG = {
  "tsconfig.json": "TypeScript",
  "pom.xml": "Java",
  "build.gradle": "Java",
  "build.gradle.kts": "Java",
  "go.mod": "Go",
};

// Source extension -> language. scip-typescript indexes JS as well as TS, so
// .js/.jsx map to the same TypeScript/scip job.
const EXT_LANG = {
  ts: "TypeScript", tsx: "TypeScript", js: "TypeScript", jsx: "TypeScript",
  java: "Java",
  c: "C", h: "C",
  py: "Python",
  go: "Go",
  kt: "Kotlin",
};

// A path counts as "source" if its extension maps to a language we index. Used
// by `refresh` to skip a rebuild when a commit touched only docs/config/CI —
// files that can't change the call graph.
export const isSourcePath = (p) => {
  const dot = p.lastIndexOf(".");
  return dot >= 0 && EXT_LANG[p.slice(dot + 1).toLowerCase()] !== undefined;
};

// Language -> indexer + Joern frontend. scip covers TypeScript/JS; everything
// else is a Joern frontend whose --language name (UPPERCASE) we pass as
// GEML_LANG so a mixed repo never falls back to Joern's majority-language
// autodetect.
export const LANG_JOB = {
  TypeScript: { indexer: "scip", gemlLang: undefined },
  Java: { indexer: "joern", gemlLang: "JAVASRC" },
  C: { indexer: "joern", gemlLang: "NEWC" },
  Python: { indexer: "joern", gemlLang: "PYTHONSRC" },
  Go: { indexer: "joern", gemlLang: "GO" },
  Kotlin: { indexer: "joern", gemlLang: "KOTLIN" },
};

// A language detected ONLY by file extension (no manifest) must clear a small
// presence bar, so a stray helper script (one .py in a big TS repo) can't drag
// a whole Joern frontend into the build. Manifests bypass the bar entirely.
export const MIN_EXT_SHARE = 0.05;

// Representative extension for a language (for the human-readable plan signal).
const extOf = (lang) => Object.keys(EXT_LANG).find((e) => EXT_LANG[e] === lang);

// Walk `root`, returning repo-relative POSIX source files and manifest files.
// SKIP_DIRS and dotdirs are pruned structurally (a gitignored path is dropped
// later by the caller's excluder). `readdir` is injectable for tests.
export function collectSourceFiles(root, { readdir = readdirSync } = {}) {
  const files = [];      // repo-relative POSIX source files
  const manifests = [];  // repo-relative POSIX manifest files
  const walk = (dir) => {
    let ents;
    try { ents = readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(root, join(dir, e.name)).replace(/\\/g, "/");
      if (MANIFEST_LANG[e.name]) manifests.push(rel);
      const dot = e.name.lastIndexOf(".");
      const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : "";
      if (EXT_LANG[ext]) files.push(rel);
    }
  };
  walk(root);
  return { files, manifests };
}

// Decide the indexer jobs for `root`. Returns [] when nothing supported is
// found. Each job: { language, indexer:"scip"|"joern", adapter, gemlLang?, signal }.
//
// Options:
//   excluder            (relPosixPath) => bool  — drop gitignored/--exclude paths
//   readdir             injected fs.readdirSync (tests)
//   files, manifests    precomputed (from collectSourceFiles) to skip the walk
export function detectLanguages(root, { excluder = () => false, readdir, files, manifests } = {}) {
  if (!files || !manifests) {
    const c = collectSourceFiles(root, { readdir });
    files = files ?? c.files;
    manifests = manifests ?? c.manifests;
  }
  const keptFiles = files.filter((f) => !excluder(f));
  const keptManifests = manifests.filter((m) => !excluder(m));

  // 1. manifest languages — strong signal, priority over extension counts.
  // TypeScript additionally records WHERE each tsconfig.json lives: scip must
  // run inside the tsconfig's directory (a nested web app in a Java monorepo —
  // think flink-runtime-web — has no tsconfig at the repo root, and
  // scip-typescript exits 1 when its cwd lacks one).
  const detected = new Map(); // language -> signal string
  const tsProjects = [];      // repo-relative dirs holding a tsconfig.json ("." = root)
  for (const m of keptManifests) {
    const name = m.slice(m.lastIndexOf("/") + 1);
    const lang = MANIFEST_LANG[name];
    if (!lang) continue;
    if (name === "tsconfig.json") tsProjects.push(m.includes("/") ? m.slice(0, m.lastIndexOf("/")) : ".");
    if (!detected.has(lang)) detected.set(lang, name);
  }

  // 2. extension counts across the surviving source files.
  const counts = new Map(); // language -> file count
  for (const f of keptFiles) {
    const dot = f.lastIndexOf(".");
    const lang = EXT_LANG[dot >= 0 ? f.slice(dot + 1).toLowerCase() : ""];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  // 3. extension-only languages that clear the presence bar and weren't
  //    already established by a manifest.
  for (const [lang, n] of counts) {
    if (detected.has(lang)) continue;
    if (total > 0 && n / total >= MIN_EXT_SHARE) detected.set(lang, `.${extOf(lang)}`);
  }

  const jobs = [];
  for (const [language, signal] of detected) {
    const spec = LANG_JOB[language];
    if (!spec) continue;
    if (language === "TypeScript") {
      // One scip job PER tsconfig project, each running in its own directory.
      // A root tsconfig governs the whole tree (project references), so it
      // subsumes the nested ones; likewise a nested project inside another
      // kept project is dropped. No tsconfig at all (extension-only JS/TS):
      // index the root with --infer-tsconfig so scip doesn't exit 1.
      const dirs = tsProjects.includes(".") || !tsProjects.length
        ? ["."]
        : [...new Set(tsProjects)].sort().filter((d, _, all) => !all.some((p) => p !== d && d.startsWith(p + "/")));
      for (const project of dirs) {
        jobs.push({
          language, indexer: "scip", adapter: "scip", gemlLang: undefined, project,
          inferTsconfig: !tsProjects.length || undefined,
          signal: project === "." ? signal : `${project}/tsconfig.json`,
        });
      }
    } else {
      jobs.push({ language, indexer: spec.indexer, adapter: spec.indexer, gemlLang: spec.gemlLang, signal });
    }
  }
  // Deterministic order: scip before joern, then by GEML_LANG, then language,
  // then (several scip projects) by project dir.
  jobs.sort((a, b) =>
    (a.indexer === b.indexer ? 0 : a.indexer === "scip" ? -1 : 1)
    || (a.gemlLang ?? "").localeCompare(b.gemlLang ?? "")
    || a.language.localeCompare(b.language)
    || (a.project ?? "").localeCompare(b.project ?? ""));
  return jobs;
}

// Turn one detection job into the concrete command a subprocess runs. Pure:
// the caller supplies resolved absolute paths. `raw` is what the matching
// adapter consumes downstream — a .scip FILE for scip, the JSONL output DIR
// for joern (joern-export.sc writes methods.jsonl + calls.jsonl there).
//   root        resolved project root (scip cwd; joern GEML_SRC)
//   buildDir    where intermediates land (typically <out>/_build)
//   scriptPath  resolved path to joern-export.sc
export function indexerCommand(job, { root, buildDir, scriptPath }) {
  if (job.indexer === "scip") {
    // scip runs INSIDE the tsconfig project dir (job.project, "." = root); the
    // adapter re-anchors document paths to the repo via metadata.project_root.
    // One .scip file per project so a multi-project repo's runs never clash.
    const project = job.project && job.project !== "." ? job.project : "";
    const raw = join(buildDir, project
      ? `index-${project.replace(/\//g, "__").replace(/[^A-Za-z0-9._-]/g, "-")}.scip`
      : "index.scip");
    return {
      adapter: "scip",
      raw,
      argv: ["npx", "--yes", "@sourcegraph/scip-typescript", "index",
        ...(job.inferTsconfig ? ["--infer-tsconfig"] : []), "--output", raw],
      env: undefined,
      cwd: project ? join(root, project) : root,
    };
  }
  // joern: one output dir per frontend so several Joern jobs never clash.
  const raw = join(buildDir, `joern-${String(job.gemlLang).toLowerCase()}`);
  return {
    adapter: "joern",
    raw,
    argv: ["joern", "--script", scriptPath],
    env: { GEML_SRC: root, GEML_OUT: raw, GEML_LANG: job.gemlLang },
    cwd: root,
  };
}
