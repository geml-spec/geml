// geml-code-graph adapter: SQL lineage export → exchange format
// (docs/DESIGN-codemap-sql.md).
//
// Consumes the raw JSONL written by sql-export.py (objects.jsonl +
// refs.jsonl) — sqlglot runs once, up front; the node side never touches
// Python. SQL has no call graph, so every dependency/lineage edge maps onto
// `calls`, direction referencer → referenced (D2). Resolution is name-based
// within the indexed file set, so everything is honestly `heuristic` (D3):
//   exactly one object matches the name        → to, high
//   several match (same bare name, N schemas)  → first as `to` + the rest as
//                                                `candidates`, medium
//   nothing matches (external/undefined)       → to_text, low (unresolved)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

export function extract({ raw }) {
  const objects = readJsonl(join(raw, "objects.jsonl"));
  const refs = readJsonl(join(raw, "refs.jsonl"));

  // Anchors: "sql:<relpath>#<object-name>"; same-file same-name duplicates
  // (a CREATE TABLE re-stated, say) get ~2, ~3 by line order — the joern rule.
  const byAnchorBase = new Map();
  for (const o of objects) {
    const base = `sql:${o.file}#${o.name}`;
    if (!byAnchorBase.has(base)) byAnchorBase.set(base, []);
    byAnchorBase.get(base).push(o);
  }
  const anchorOf = new Map(); // `${file}\u0000${uid}` -> anchor
  const keyOf = (file, uid) => `${file}\u0000${uid}`;
  for (const [base, list] of byAnchorBase) {
    list.sort((a, b) => (a.lineStart ?? 0) - (b.lineStart ?? 0));
    list.forEach((o, i) => anchorOf.set(keyOf(o.file, o.uid), i === 0 ? base : `${base}~${i + 1}`));
  }

  // Resolution maps: exact qualified name first, then the bare last segment
  // (`analytics.daily_sales` answers both "analytics.daily_sales" and
  // "daily_sales"; statement nodes are not referenceable — no qualified key).
  const byQualified = new Map();
  const byBare = new Map();
  const addKey = (map, key, anchor) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(anchor);
  };
  for (const o of objects) {
    if (!o.qualified) continue;
    const anchor = anchorOf.get(keyOf(o.file, o.uid));
    addKey(byQualified, o.qualified, anchor);
    const bare = o.qualified.slice(o.qualified.lastIndexOf(".") + 1);
    if (bare !== o.qualified) addKey(byBare, bare, anchor);
  }
  const resolve = (to) => {
    const exact = byQualified.get(to);
    if (exact?.size) return [...exact];
    const bare = to.slice(to.lastIndexOf(".") + 1);
    // Bare fallback, direction-aware: a QUALIFIED reference may still mean an
    // object DEFINED without a schema (keyed bare in byQualified) — but never
    // another schema's object (a false edge is worse than a blind spot). An
    // UNQUALIFIED reference matches any schema's object of that name.
    const fallback = to.includes(".") ? byQualified.get(bare) : byBare.get(bare);
    return fallback?.size ? [...fallback] : [];
  };

  const symbols = [];
  const seenFiles = new Set();
  for (const o of objects) {
    symbols.push({
      anchor: anchorOf.get(keyOf(o.file, o.uid)),
      lang: "sql",
      kind: "Function",
      name: o.name,
      file: o.file,
      line_start: o.lineStart ?? undefined,
      line_end: o.lineEnd ?? undefined,
      signature: o.kind, // the SQL object kind (table/view/procedure/…) — D1
      resolution: "heuristic",
    });
    if (!seenFiles.has(o.file)) {
      seenFiles.add(o.file);
      symbols.push({
        anchor: `sql:${o.file}`,
        lang: "sql",
        kind: "File",
        name: o.file.split("/").pop(),
        file: o.file,
        resolution: "heuristic",
      });
    }
  }

  const edges = [];
  for (const r of refs) {
    const from = anchorOf.get(keyOf(r.file, r.fromUid));
    if (!from) continue;
    const site = { file: r.file, line: r.line ?? 0 };
    const targets = resolve(r.to);
    if (targets.length === 0) {
      edges.push({ kind: "calls", from, to_text: r.toText, resolution: "heuristic", confidence: "low", site });
    } else if (targets.length === 1) {
      edges.push({ kind: "calls", from, to: targets[0], resolution: "heuristic", confidence: "high", site });
    } else {
      const [first, ...rest] = targets.sort();
      edges.push({
        kind: "calls", from, to: first, resolution: "heuristic", confidence: "medium",
        note: `name ambiguity, ${targets.length} candidates`, candidates: rest, site,
      });
    }
  }

  return { symbols, edges };
}
