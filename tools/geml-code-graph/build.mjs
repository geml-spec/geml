#!/usr/bin/env node
// geml-code-graph build — one shot: adapter → exchange format (build/) → GEML tree (graph/).
//
//   node tools/geml-code-graph/build.mjs --db <graph.db>  --root <repo-root>              # crg (default)
//   node tools/geml-code-graph/build.mjs --adapter joern --raw <dir> --root <repo-root>   # joern
//                                [--out graph] [--build build]
//                                [--history [-m "msg"]]   snapshot changed docs into .gemlhistory
//                                                         sidecars (per-node history + revert)
//
// Adapters (docs/DESIGN-geml-code-graph.md §3):
//   crg    code-review-graph SQLite graph.db (tree-sitter level; everything
//          honestly labelled resolution:"heuristic")           [P0, default]
//   joern  Joern CPG export: run tools/geml-code-graph/joern-export.sc inside
//          joern first; --raw points at its outDir              [P1]
//
// After building, run:  node tools/geml-code-graph/verify.mjs <out-dir>
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { emit } from "./emit.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const adapter = flag("--adapter", "crg");
const dbPath = flag("--db");
const rawDir = flag("--raw");
const root = flag("--root");
const outDir = resolve(flag("--out", "graph"));
const buildDir = resolve(flag("--build", join(dirname(outDir), "build")));

if (!root || (adapter === "crg" && !dbPath) || (adapter === "joern" && !rawDir)) {
  console.error("usage: node tools/geml-code-graph/build.mjs --db <graph.db> | --adapter joern --raw <dir>  --root <repo-root> [--out graph] [--build build]");
  process.exit(2);
}

let extracted;
if (adapter === "crg") {
  const { extract } = await import("./adapters/crg.mjs");
  extracted = extract({ db: dbPath, root });
} else if (adapter === "joern") {
  const { extract } = await import("./adapters/joern.mjs");
  extracted = extract({ raw: rawDir, root });
} else {
  console.error(`unknown adapter '${adapter}' (available: crg, joern)`);
  process.exit(2);
}

// Exchange format on disk — the layer contract (§3). Deterministic order so
// the jsonl files diff cleanly across builds.
const { symbols, edges } = extracted;
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

const stats = emit({ symbols, edges, outDir, buildDir, repoName: basename(resolve(root)) });

console.error(
  `geml-code-graph: ${stats.symbols} symbols, ${stats.edges} edges (${stats.resolved} resolved), `
  + `${stats.leaves} leaves -> ${stats.docs} docs (${stats.written} written, rest unchanged), `
  + `${stats.backlinkDocs} backlink docs, ${(stats.bytes / 1048576).toFixed(2)} MB -> ${outDir}`,
);

// --history: snapshot every changed document into its .gemlhistory sidecar —
// the graph's own architectural history (geml history log / revert per node).
// Targets = documents rewritten this build, plus any document that has no
// sidecar yet (first run, or --history adopted later).
if (args.includes("--history")) {
  const histMod = resolve(dirname(fileURLToPath(import.meta.url)), "../../geml-parser/dist/history.js");
  if (!existsSync(histMod)) {
    console.error("--history needs the built parser (cd geml-parser && npm install && npm run build)");
    process.exit(1);
  }
  const { commit } = await import(`file://${histMod.replace(/\\/g, "/")}`);
  const message = flag("-m", flag("--message", "graph build"));
  const targets = new Set(stats.writtenDocs);
  for (const d of stats.allDocs) {
    if (!existsSync(join(outDir, d).replace(/\.geml$/, ".gemlhistory"))) targets.add(d);
  }
  let committed = 0;
  for (const d of [...targets].sort()) {
    const gemlPath = join(outDir, d);
    commit({ gemlPath, historyPath: gemlPath.replace(/\.geml$/, ".gemlhistory"), summary: message });
    committed++;
  }
  console.error(`history: committed ${committed} document(s) (${stats.allDocs.length - committed} unchanged, skipped)`);
}
console.error(`next: node tools/geml-code-graph/verify.mjs ${outDir}`);
