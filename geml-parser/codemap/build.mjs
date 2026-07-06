#!/usr/bin/env node
// geml-code-graph build — one shot: adapter → exchange format (build/) → GEML tree (graph/).
//
//   geml codemap build --db <graph.db>  --root <repo-root>              # crg (default)
//   geml codemap build --adapter joern --raw <dir> \
//                                        --adapter scip  --raw <index.scip> --root <repo>  # merged multi-language
//   geml codemap build --adapter joern --raw <dir> --root <repo-root>   # joern
//                                [--out codemap] [--build build]
//                                [--container module|dir|file]   container granularity (default dir)
//                                [--history [-m "msg"]]   snapshot changed docs into .gemlhistory
//                                                         sidecars (per-node history + revert)
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
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { emit } from "./emit.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const root = flag("--root");
const outDir = resolve(flag("--out", "graph"));
const buildDir = resolve(flag("--build", join(dirname(outDir), "build")));

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
const bad = inputs.find((s) => !["crg", "joern", "scip"].includes(s.adapter) || (s.adapter === "crg" ? !s.db : !s.raw));
if (!root || !inputs.length || bad) {
  console.error("usage: geml codemap build (--db <graph.db> | --adapter joern|scip --raw <dir|index.scip>)+  --root <repo-root> [--out graph] [--build build]");
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
  edges.push(...r.edges);
  console.error(`input ${spec.adapter}: ${r.symbols.length} symbols, ${r.edges.length} edges${dropped ? ` (${dropped} duplicate anchors dropped)` : ""}`);
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
console.error(`next: geml codemap verify ${outDir}`);
