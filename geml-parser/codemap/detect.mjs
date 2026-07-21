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

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { globToRegExp } from "./exclude.mjs";

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
  "Cargo.toml": "Rust",
  "pom.xml": "Java",
  "build.gradle": "Java",
  "build.gradle.kts": "Java",
  "go.mod": "Go",
};

// Source extension -> language. scip-typescript indexes JS as well as TS, so
// .js/.jsx map to the same TypeScript/scip job. .vue/.svelte SFCs also belong
// to the TypeScript family: their group's job carries an `sfc` flag and the
// build virtualizes them (codemap/sfc-virtualize.mjs) before scip runs.
const EXT_LANG = {
  ts: "TypeScript", tsx: "TypeScript", js: "TypeScript", jsx: "TypeScript",
  vue: "TypeScript", svelte: "TypeScript",
  rs: "Rust",
  java: "Java",
  c: "C", h: "C",
  py: "Python",
  go: "Go",
  kt: "Kotlin",
  sql: "SQL",
};

// A path counts as "source" if its extension maps to a language we index. Used
// by `refresh` to skip a rebuild when a commit touched only docs/config/CI —
// files that can't change the call graph.
export const isSourcePath = (p) => {
  const dot = p.lastIndexOf(".");
  return dot >= 0 && EXT_LANG[p.slice(dot + 1).toLowerCase()] !== undefined;
};

// Language -> indexer + Joern frontend. scip covers TypeScript/JS (via
// scip-typescript) and Rust (via rust-analyzer — the SCIP adapter reads both
// symbol grammars); SQL runs the shipped sqlglot extractor (sql-export.py,
// lineage-as-callgraph); everything else is a Joern frontend whose --language
// name (UPPERCASE) we pass as GEML_LANG so a mixed repo never falls back to
// Joern's majority-language autodetect.
export const LANG_JOB = {
  TypeScript: { indexer: "scip", gemlLang: undefined },
  Rust: { indexer: "scip", gemlLang: undefined },
  Java: { indexer: "joern", gemlLang: "JAVASRC" },
  C: { indexer: "joern", gemlLang: "NEWC" },
  Python: { indexer: "joern", gemlLang: "PYTHONSRC" },
  Go: { indexer: "joern", gemlLang: "GO" },
  Kotlin: { indexer: "joern", gemlLang: "KOTLIN" },
  SQL: { indexer: "sql", gemlLang: undefined },
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
  const pkgs = [];       // repo-relative POSIX package.json files (TS/JS project roots)
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
      if (e.name === "package.json") pkgs.push(rel);
      const dot = e.name.lastIndexOf(".");
      const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : "";
      if (EXT_LANG[ext]) files.push(rel);
    }
  };
  walk(root);
  return { files, manifests, pkgs };
}

// Group the repo's TS/JS files by their NEAREST project manifest (tsconfig.json
// or package.json) directory — scip-typescript indexes one PROJECT at a time,
// so a monorepo of front-end apps (each its own package.json, maybe no
// tsconfig at all) needs one indexer run per app, not one at the repo root
// (which sees "no files got indexed"). Files with no manifest above them
// group under the root (""). Each group also reports which SFC extensions
// (.vue/.svelte) it contains — the sfc-flag input. Pure; exported for tests.
export function tsProjectGroups(tsFiles, tsconfigDirs, pkgDirs) {
  const dirs = [...new Set([...tsconfigDirs, ...pkgDirs])]
    .sort((a, b) => b.length - a.length); // deepest first → nearest wins
  const withTsconfig = new Set(tsconfigDirs);
  const groups = new Map(); // subroot -> { n, sfcExts:Set }
  for (const f of tsFiles) {
    const home = dirs.find((d) => d === "" || f.startsWith(d + "/")) ?? "";
    if (!groups.has(home)) groups.set(home, { n: 0, sfcExts: new Set() });
    const g = groups.get(home);
    g.n++;
    const m = /\.(vue|svelte)$/i.exec(f);
    if (m) g.sfcExts.add(m[1].toLowerCase());
  }
  return [...groups.keys()].sort().map((subroot) => ({
    subroot,
    hasTsconfig: withTsconfig.has(subroot),
    sfcExts: [...groups.get(subroot).sfcExts].sort(),
  }));
}

// Minimal TOML peek at a Cargo.toml's [workspace] table: its `members` /
// `exclude` string arrays (possibly multi-line, possibly globs like
// "crates/*"). That is exactly what decides which crate dirs one
// `rust-analyzer scip .` run at that directory will load — full TOML parsing
// is not needed. Returns null when the file declares no [workspace] at all.
export function cargoWorkspace(toml) {
  const m = /^[ \t]*\[workspace\][ \t]*\r?$/m.exec(toml);
  if (!m) return null;
  let body = toml.slice(m.index + m[0].length);
  const next = /^[ \t]*\[[^\]]+\][ \t]*\r?$/m.exec(body); // next table header ends the section
  if (next) body = body.slice(0, next.index);
  const list = (key) => {
    const a = new RegExp(`^[ \\t]*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(body);
    return a ? [...a[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  };
  return { members: list("members"), exclude: list("exclude") };
}

// The sfc flag for one TS project group: an SFC extension must be PRESENT in
// the group AND its framework declared in the group's package.json (deps or
// devDeps) — a stray .vue in a repo that never installed vue is not a Vue
// project. `readJson` is injectable for tests.
export function sfcFlagOf(group, pkgJsonPath, readJson) {
  if (!group.sfcExts?.length) return undefined;
  let pkg;
  try { pkg = readJson(pkgJsonPath); } catch { return undefined; }
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const frameworks = group.sfcExts.filter((ext) => deps[ext]); // ext === framework package name
  return frameworks.length ? frameworks.join(",") : undefined;
}

// Decide the indexer jobs for `root`. Returns [] when nothing supported is
// found. Each job: { language, indexer:"scip"|"joern", adapter, gemlLang?,
// signal, subroot?, sfc? } — sfc ("vue"/"svelte"/"vue,svelte") marks a TS
// project whose SFCs the build virtualizes before running scip.
//
// Options:
//   excluder            (relPosixPath) => bool  — drop gitignored/--exclude paths
//   readdir             injected fs.readdirSync (tests)
//   readJson            injected package.json reader (tests) — sfc flag input
//   readText            injected text reader (tests) — root Cargo.toml [workspace] peek
//   files, manifests    precomputed (from collectSourceFiles) to skip the walk
export function detectLanguages(root, { excluder = () => false, readdir, readJson, readText, files, manifests, pkgs } = {}) {
  readJson ??= (p) => JSON.parse(readFileSync(p, "utf8"));
  readText ??= (p) => readFileSync(p, "utf8");
  if (!files || !manifests) {
    const c = collectSourceFiles(root, { readdir });
    files = files ?? c.files;
    manifests = manifests ?? c.manifests;
    pkgs = pkgs ?? c.pkgs;
  }
  const keptFiles = files.filter((f) => !excluder(f));
  const keptManifests = manifests.filter((m) => !excluder(m));
  const keptPkgs = (pkgs ?? []).filter((p) => !excluder(p));

  // 1. manifest languages — strong signal, priority over extension counts.
  const detected = new Map(); // language -> signal string
  for (const m of keptManifests) {
    const name = m.slice(m.lastIndexOf("/") + 1);
    const lang = MANIFEST_LANG[name];
    if (lang && !detected.has(lang)) detected.set(lang, name);
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
      // One scip run per nearest-manifest project (see tsProjectGroups).
      const isTs = (f) => /\.(ts|tsx|js|jsx|vue|svelte)$/i.test(f);
      const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
      const pkgDirs = new Set(keptPkgs.map(dirOf));
      const groups = tsProjectGroups(
        keptFiles.filter(isTs),
        keptManifests.filter((m) => m.endsWith("tsconfig.json")).map(dirOf),
        [...pkgDirs],
      );
      for (const g of groups) {
        // SFCs present + framework declared in the group's own package.json
        // -> the build virtualizes this project before indexing it.
        const sfc = pkgDirs.has(g.subroot)
          ? sfcFlagOf(g, join(root, ...(g.subroot ? g.subroot.split("/") : []), "package.json"), readJson)
          : undefined;
        // A group indexes only if it's a real project: it HAS a tsconfig, or is
        // a Vue/Svelte app (SFC) — the virtualizer gives that one a synthetic
        // tsconfig. A tsconfig-less, non-SFC group is loose files, not a project:
        // skip it. (We don't synthesize a config with scip's --infer-tsconfig —
        // that swept the whole tree and littered a stub tsconfig.json.)
        if (!g.hasTsconfig && !sfc) continue;
        jobs.push({
          language, indexer: spec.indexer, adapter: spec.indexer, gemlLang: spec.gemlLang,
          subroot: g.subroot || undefined,
          sfc,
          signal: (g.hasTsconfig
            ? (g.subroot ? `${g.subroot}/tsconfig.json` : "tsconfig.json")
            // No tsconfig in THIS group (only an SFC app reaches here now — the
            // virtualizer supplies its config): name the package.json so the
            // signal doesn't echo some OTHER group's tsconfig.
            : (g.subroot ? `${g.subroot}/package.json`
              : keptPkgs.includes("package.json") ? "package.json" : `.${extOf(language)}`))
            + (sfc ? ` +${sfc}-sfc` : ""),
        });
      }
      continue;
    }
    if (language === "Rust") {
      // One `rust-analyzer scip .` run loads ONE Cargo workspace: the run at
      // the repo root covers the root package + its [workspace] members and
      // nothing else. A crate that opted out (its own [workspace] table, e.g.
      // a top-level cli/) or was never a member is invisible to that run — it
      // gets its OWN run in its OWN directory. Anchors are crate-qualified
      // ("rust-analyzer cargo <crate> …"), so merged runs never collide.
      const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
      const cargoDirs = [...new Set(keptManifests.filter((m) => m.endsWith("Cargo.toml")).map(dirOf))];
      if (!cargoDirs.length) { // extension-only signal: keep the single root run
        jobs.push({ language, indexer: spec.indexer, adapter: spec.indexer, gemlLang: spec.gemlLang, signal });
        continue;
      }
      const rootHas = cargoDirs.includes("");
      let members = [], excluded = [];
      if (rootHas) {
        try {
          const ws = cargoWorkspace(readText(join(root, "Cargo.toml")));
          if (ws) { members = ws.members; excluded = ws.exclude; }
        } catch { /* unreadable root manifest — treat as memberless */ }
      }
      const rootCovers = (d) =>
        members.some((g) => globToRegExp(g).test(d)) && !excluded.some((g) => globToRegExp(g).test(d));
      let standalone = cargoDirs.filter((d) => d && !(rootHas && rootCovers(d))).sort();
      // A crate nested under another standalone crate belongs to THAT run.
      standalone = standalone.filter((d) => !standalone.some((s) => s !== d && d.startsWith(s + "/")));
      if (rootHas) jobs.push({ language, indexer: spec.indexer, adapter: spec.indexer, gemlLang: spec.gemlLang, signal });
      for (const d of standalone) {
        jobs.push({ language, indexer: spec.indexer, adapter: spec.indexer, gemlLang: spec.gemlLang, subroot: d, signal: `${d}/Cargo.toml` });
      }
      continue;
    }
    jobs.push({ language, indexer: spec.indexer, adapter: spec.indexer, gemlLang: spec.gemlLang, signal });
  }
  // Deterministic order: fast indexers first (scip, then sql), Joern last;
  // within an indexer by GEML_LANG, then language; same-language projects
  // DEEPEST subroot first — a nested project's anchors must win collisions with
  // an enclosing one, so the merge keeps the FIRST (deeper, more precise) index.
  const rank = { scip: 0, sql: 1, joern: 2 };
  jobs.sort((a, b) =>
    ((rank[a.indexer] ?? 9) - (rank[b.indexer] ?? 9))
    || (a.gemlLang ?? "").localeCompare(b.gemlLang ?? "")
    || a.language.localeCompare(b.language)
    || (b.subroot ?? "").length - (a.subroot ?? "").length
    || (a.subroot ?? "").localeCompare(b.subroot ?? ""));
  return jobs;
}

// The npx -p set the SFC virtualizer needs, per framework. typescript is
// pinned @5: typescript@latest is 7.x, which @vue/language-core rejects.
const SFC_NPX_PKGS = {
  vue: ["@vue/language-core"],
  svelte: ["svelte2tsx", "svelte"],
};

// Turn one detection job into the concrete command a subprocess runs. Pure:
// the caller supplies resolved absolute paths. `raw` is what the matching
// adapter consumes downstream — a .scip FILE for scip, the JSONL output DIR
// for joern (joern-export.sc writes methods.jsonl + calls.jsonl there).
//   root           resolved project root (scip cwd; joern/sql GEML_SRC)
//   buildDir       where intermediates land (typically <out>/_build)
//   scriptPath     resolved path to joern-export.sc
//   sfcScript      resolved path to sfc-virtualize.mjs (sfc jobs only)
//   sqlScriptPath  resolved path to sql-export.py (sql jobs only)
//   sqlDialect     optional sqlglot read= dialect (--sql-dialect / GEML_SQL_DIALECT)
//
// An sfc job returns TWO steps: `pre` (the virtualizer, run first — shadows,
// map sidecars and a synthetic tsconfig land in `remapDir`) and the main
// scip run, which executes IN the virtual dir against that tsconfig. The
// build passes `remapDir` through to the scip adapter.
export function indexerCommand(job, { root, buildDir, scriptPath, sfcScript, sqlScriptPath, sqlDialect }) {
  if (job.indexer === "scip") {
    // One .scip per project run — a subrooted job (monorepo app, standalone
    // crate) runs IN that directory and writes a slug-named index; the adapter
    // re-anchors its paths via the index's metadata.project_root, so the merge
    // stays repo-relative.
    const slug = job.subroot ? String(job.subroot).replace(/\//g, "-") : "";
    const subrootAbs = job.subroot ? join(root, ...String(job.subroot).split("/")) : root;
    // rust.scip / rust-<slug>.scip next to index.scip, so a mixed TS + Rust
    // repo never overwrites one index with the other. A subrooted Rust job is
    // a crate OUTSIDE the root workspace: rust-analyzer runs in the crate dir.
    if (job.language === "Rust") {
      const raw = join(buildDir, slug ? `rust-${slug}.scip` : "rust.scip");
      return {
        adapter: "scip",
        raw,
        argv: ["rust-analyzer", "scip", ".", "--output", raw],
        env: undefined,
        cwd: job.subroot ? subrootAbs : root,
      };
    }
    const raw = join(buildDir, slug ? `index-${slug}.scip` : "index.scip");
    if (job.sfc) {
      // Virtualize first, then index the virtual dir: its synthetic tsconfig
      // covers the shadows AND the project's real TS/JS, so this ONE scip run
      // replaces the plain per-project run.
      const remapDir = join(buildDir, slug ? `virtual-${slug}` : "virtual-root");
      const pkgs = [...new Set(String(job.sfc).split(",").flatMap((f) => SFC_NPX_PKGS[f] ?? []))];
      return {
        adapter: "scip",
        raw,
        remapDir,
        pre: {
          argv: ["npx", "-y", ...pkgs.flatMap((p) => ["-p", p]), "-p", "typescript@5", "node", sfcScript],
          env: { GEML_SRC: subrootAbs, GEML_OUT: remapDir },
          cwd: root,
        },
        argv: ["npx", "--yes", "@sourcegraph/scip-typescript", "index", "--output", raw],
        env: undefined,
        cwd: remapDir,
      };
    }
    // A plain TS/JS project: scip-typescript reads the tsconfig in its cwd.
    // detect only emits a scip job for a group that HAS a tsconfig (SFC apps are
    // handled above, indexing their virtual dir's synthetic config), so there is
    // never a config to infer — a tsconfig-less, non-SFC group is loose files,
    // not a project, and was dropped back in detectLanguages.
    return {
      adapter: "scip",
      raw,
      argv: ["npx", "--yes", "@sourcegraph/scip-typescript", "index", "--output", raw],
      env: undefined,
      cwd: job.subroot ? subrootAbs : root,
    };
  }
  if (job.indexer === "sql") {
    // uv self-provisions sqlglot via the script's PEP-723 header; build.mjs
    // swaps the runner for plain `python` when uv is absent but sqlglot isn't.
    const raw = join(buildDir, "sql");
    return {
      adapter: "sql",
      raw,
      argv: ["uv", "run", sqlScriptPath],
      env: { GEML_SRC: root, GEML_OUT: raw, ...(sqlDialect ? { GEML_SQL_DIALECT: sqlDialect } : {}) },
      cwd: root,
    };
  }
  // joern: one output dir per frontend so several Joern jobs never clash.
  const raw = join(buildDir, `joern-${String(job.gemlLang).toLowerCase()}`);
  // Run IN the build dir, not the repo root. Joern's importCode writes its CPG
  // workspace to <cwd>/workspace/; anchoring cwd at buildDir keeps that cache
  // inside .geml-code-graph/_build/workspace/ instead of scattering a stray
  // `workspace/` at the repo root. GEML_SRC/GEML_OUT are absolute and the
  // script path is absolute, so the move never affects what Joern reads or writes.
  return {
    adapter: "joern",
    raw,
    argv: ["joern", "--script", scriptPath],
    env: { GEML_SRC: root, GEML_OUT: raw, GEML_LANG: job.gemlLang },
    cwd: buildDir,
  };
}
