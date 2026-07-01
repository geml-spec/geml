#!/usr/bin/env node
// graph2geml — serialize a code-review-graph (SQLite `graph.db`, built by the
// tree-sitter–based code-review-graph tool) into a GEML document.
//
// Encoding ⓪ (see proposals/0002-code-graph-representation.md): each node is a
// `=== note {#id .Kind}` block; each INTERNAL edge (target is also a node) is a
// verifiable `[[#id]]` reference. `geml check` then proves the graph has no
// broken internal edge. External targets (stdlib headers, unresolved symbols)
// are counted, NOT emitted as refs — they legitimately live outside the graph,
// so encoding them would be tens of thousands of false "dangling" errors.
//
// Node ids are `n<rowid>` because a node's qualified_name is a file path, which
// is not a valid GEML id (`[A-Za-z][A-Za-z0-9_-]*`).
//
// Requires Node's built-in SQLite (Node >= 22.5), so run with the flag:
//   node --experimental-sqlite tools/graph2geml.mjs <graph.db> <out.geml> [mode] [arg]
//
// Modes:
//   full            every node (default)
//   dir <substr>    only nodes whose file path contains <substr>
//   flow <id>       only the nodes of flow <id> (a code-review-graph execution path)
//
// Then: `geml check <out.geml>` (0 = every internal edge resolves), and
// `geml history commit <out.geml> -m "…"` to version the graph per code commit.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const [, , dbPath, outPath, mode = "full", arg] = process.argv;
if (!dbPath || !outPath) {
  console.error("usage: node --experimental-sqlite tools/graph2geml.mjs <graph.db> <out.geml> [full | dir <substr> | flow <id>]");
  process.exit(2);
}

const db = new DatabaseSync(dbPath);

let nodes = db.prepare("SELECT id, kind, name, file_path FROM nodes").all();
if (mode === "dir") {
  if (!arg) { console.error("dir mode needs a path substring"); process.exit(2); }
  nodes = nodes.filter((n) => n.file_path.replace(/\\/g, "/").includes(arg));
} else if (mode === "flow") {
  const f = db.prepare("SELECT path_json FROM flows WHERE id = ?").get(Number(arg));
  if (!f) { console.error(`no flow with id ${arg}`); process.exit(1); }
  const ids = new Set(JSON.parse(f.path_json));
  nodes = nodes.filter((n) => ids.has(n.id));
} else if (mode !== "full") {
  console.error(`unknown mode: ${mode}`); process.exit(2);
}

const keep = new Set(nodes.map((n) => n.id));
const idByQual = new Map(db.prepare("SELECT id, qualified_name FROM nodes").all().map((r) => [r.qualified_name, r.id]));

// Group internal, in-slice edges by source node.
const outEdges = new Map(); // sourceId -> Set<targetId>
let internal = 0, external = 0, crossSlice = 0;
for (const e of db.prepare("SELECT source_qualified, target_qualified FROM edges").all()) {
  const sid = idByQual.get(e.source_qualified);
  const tid = idByQual.get(e.target_qualified);
  if (sid === undefined) continue;
  if (tid === undefined) { external++; continue; }           // target outside the graph
  internal++;
  if (!keep.has(sid) || !keep.has(tid)) { crossSlice++; continue; } // edge leaves the slice
  if (!outEdges.has(sid)) outEdges.set(sid, new Set());
  outEdges.get(sid).add(tid);
}

const gid = (id) => "n" + id;
const esc = (s) => String(s).replace(/`/g, "'"); // a backtick would close the code span
const parts = [
  `=== meta\ngraph-of = "${esc(dbPath)}"\nkind = "${mode}-graph"\nnodes = ${nodes.length}\n===\n`,
  `# Code graph (${mode}${arg ? " " + arg : ""})\n`,
  "Each node is a function/file; each `[[#id]]` is a verifiable internal edge, so "
    + "`geml check` proves no internal edge dangles. External edges (stdlib, "
    + "unresolved) are omitted by design.\n",
];
for (const n of nodes) {
  const tids = [...(outEdges.get(n.id) ?? [])];
  const edges = tids.length ? "\n-> " + tids.map((t) => `[[#${gid(t)}]]`).join(" ") : "";
  parts.push(`=== note {#${gid(n.id)} .${n.kind}}\n\`${esc(n.name)}\`${edges}\n===\n`);
}
const doc = parts.join("\n");
writeFileSync(outPath, doc);

const refs = [...outEdges.values()].reduce((a, s) => a + s.size, 0);
console.error(
  `graph2geml: mode=${mode}${arg ? " " + arg : ""} nodes=${nodes.length} refs=${refs} `
  + `internal=${internal} external=${external} cross_slice=${crossSlice} `
  + `bytes=${doc.length} (${(doc.length / 1048576).toFixed(2)} MB) -> ${outPath}`,
);
