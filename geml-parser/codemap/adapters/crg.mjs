// geml-code-graph adapter: code-review-graph SQLite (`graph.db`, tree-sitter based) →
// the exchange format of docs/DESIGN-geml-code-graph.md §3 (symbols + edges).
//
// Everything this adapter emits is syntax-level extraction, so per §3.3 every
// symbol and edge carries resolution:"heuristic"; resolved targets get
// confidence:"medium", unresolved ones become `to_text` rows (confidence:"low").
// CONTAINS is not an edge — containment is document structure (GEP-0002).
//
// Beyond the core schema, symbols may carry optional navigation flags the
// engine knows about: `entry` (a `main` function) and `flow_crit` (max
// criticality of execution flows entered at this symbol, when >= 0.6).
import { DatabaseSync } from "node:sqlite";

const EDGE_KIND = {
  CALLS: "calls",
  IMPORTS_FROM: "imports",
  INHERITS: "inherits",
  TESTED_BY: "tested-by",
  REFERENCES: "references",
};

export function extract({ db: dbPath, root }) {
  const db = new DatabaseSync(dbPath);
  try {
    return extractFrom(db, root);
  } finally {
    // Always release the handle: an open DatabaseSync keeps graph.db locked for
    // the process lifetime, so on Windows the caller cannot delete or replace
    // it (EPERM). try/finally closes it even if extraction throws.
    db.close();
  }
}

function extractFrom(db, root) {
  const rootFs = root.replace(/\\/g, "/").replace(/\/?$/, "/");
  const rel = (p) => {
    p = String(p).replace(/\\/g, "/");
    return p.startsWith(rootFs) ? p.slice(rootFs.length) : p;
  };

  const rows = db.prepare(
    "SELECT id, kind, name, qualified_name, file_path, line_start, line_end, language, is_test FROM nodes",
  ).all();

  // anchor = "<lang>:<relfile>#<name>", File symbols just "<lang>:<relfile>".
  // Same-file same-name collisions get ~2, ~3 … ordered by line_start so the
  // numbering is stable across rebuilds (§4.2 / risk 3).
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.language ?? "unknown"}:${rel(r.file_path)}#${r.name}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const anchorOf = new Map(); // node rowid -> anchor
  for (const [key, list] of byKey) {
    list.sort((a, b) => (a.line_start ?? 0) - (b.line_start ?? 0) || a.id - b.id);
    list.forEach((r, i) => {
      const base = r.kind === "File" ? key.slice(0, key.lastIndexOf("#")) : key;
      anchorOf.set(r.id, i === 0 ? base : `${base}~${i + 1}`);
    });
  }

  // Navigation flags from engine-specific tables.
  const mains = new Set(
    db.prepare("SELECT id FROM nodes WHERE kind='Function' AND name='main'").all().map((r) => r.id),
  );
  const flowCrit = new Map();
  try {
    for (const r of db.prepare(
      "SELECT entry_point_id id, max(criticality) c FROM flows GROUP BY 1 HAVING c >= 0.6",
    ).all()) flowCrit.set(r.id, r.c);
  } catch { /* no flows table */ }

  const symbols = rows.map((r) => {
    const s = {
      anchor: anchorOf.get(r.id),
      lang: r.language ?? "unknown",
      kind: r.kind,
      name: r.name,
      file: rel(r.file_path),
      line_start: r.line_start ?? undefined,
      line_end: r.line_end ?? undefined,
      is_test: r.is_test ? true : undefined,
      entry: mains.has(r.id) ? true : undefined,
      flow_crit: flowCrit.get(r.id),
      resolution: "heuristic",
    };
    return s;
  });

  const idByQual = new Map(rows.map((r) => [r.qualified_name, r.id]));
  const edges = [];
  for (const e of db.prepare(
    "SELECT kind, source_qualified, target_qualified, file_path, line FROM edges",
  ).all()) {
    const kind = EDGE_KIND[e.kind];
    if (!kind) continue; // CONTAINS and anything unknown
    const fromId = idByQual.get(e.source_qualified);
    if (fromId === undefined) continue; // dangling source: nothing to attach to
    const toId = idByQual.get(e.target_qualified);
    const edge = {
      kind,
      from: anchorOf.get(fromId),
      resolution: "heuristic",
      site: { file: rel(e.file_path), line: e.line ?? 0 },
    };
    if (toId !== undefined) {
      edge.to = anchorOf.get(toId);
      edge.confidence = "medium";
    } else {
      // Keep only a readable short name for the unresolved target (§5.2's
      // calls-unresolved line) — qualified names here are often paths.
      edge.to_text = String(e.target_qualified).replace(/\\/g, "/").split("/").pop();
      edge.confidence = "low";
    }
    edges.push(edge);
  }

  return { symbols, edges };
}
