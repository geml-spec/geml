#!/usr/bin/env node
// graph2geml — serialize a code-review-graph (SQLite `graph.db`, built by the
// tree-sitter–based code-review-graph tool) into GEML.
//
// Encoding ⓪ (see proposals/0002-code-graph-representation.md): each node is a
// `=== note {#id .Kind}` block; each INTERNAL edge (target is also a node) is a
// verifiable reference — `[[#id]]` within a document, `[name](doc.geml#id)`
// across documents. `geml check` then proves the graph has no broken internal
// edge (cross-document refs are fully checked too: a missing file or a missing
// id in the sibling document is an error). External targets (stdlib headers,
// unresolved symbols) are counted, NOT emitted as refs — they legitimately live
// outside the graph, so encoding them would be tens of thousands of false
// "dangling" errors.
//
// Node ids are `n<rowid>` because a node's qualified_name is a file path, which
// is not a valid GEML id (`[A-Za-z][A-Za-z0-9_-]*`).
//
// Requires Node's built-in SQLite (Node >= 22.5), so run with the flag:
//   node --experimental-sqlite tools/graph2geml.mjs <graph.db> <out> [mode] [arg]
//
// Modes (out = one .geml file, except partition where it is a directory):
//   full                 every node in one document (default)
//   dir <substr>         only nodes whose file path contains <substr>
//   flow <id>            only the nodes of flow <id> (an execution path)
//   partition <root>     one document per source DIRECTORY (paths relative to
//                        <root>), organized: a `##` heading per file with its
//                        member nodes under it (containment = document
//                        structure, not edges), cross-directory edges as
//                        checked cross-document refs, plus an index.geml.
//
// Then: `geml check <out.geml>` (0 = every internal edge resolves), and
// `geml history commit <out.geml> -m "…"` to version the graph per code commit.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , dbPath, outPath, mode = "full", arg] = process.argv;
if (!dbPath || !outPath) {
  console.error("usage: node --experimental-sqlite tools/graph2geml.mjs <graph.db> <out> [full | dir <substr> | flow <id> | partition <root>]");
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
const gid = (id) => "n" + id;
const esc = (s) => String(s).replace(/`/g, "'");          // a backtick would close the code span
const linkText = (s) => esc(s).replace(/[\[\]]/g, "");    // brackets would break the link

// ---------------------------------------------------------------------------
// partition mode — one organized document per source directory + an index
// ---------------------------------------------------------------------------
if (mode === "partition") {
  if (!arg) { console.error("partition mode needs the repo root (to relativize paths)"); process.exit(2); }
  const root = arg.replace(/\\/g, "/").replace(/\/?$/, "/");
  const rel = (p) => { p = p.replace(/\\/g, "/"); return p.startsWith(root) ? p.slice(root.length) : p; };
  const dirOf = (r) => { const i = r.lastIndexOf("/"); return i < 0 ? "(root)" : r.slice(0, i); };

  const nodes = db.prepare("SELECT id, kind, name, qualified_name, file_path, line_start FROM nodes").all();
  const idByQual = new Map(nodes.map((n) => [n.qualified_name, n.id]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const partOf = new Map(nodes.map((n) => [n.id, dirOf(rel(n.file_path))]));

  // Directory -> unique document filename (sanitized; collisions suffixed).
  const docNames = new Map();
  const taken = new Set(["index.geml"]);
  for (const part of new Set(partOf.values())) {
    const base = (part === "(root)" ? "root" : part).replace(/[\/\\]/g, "--").replace(/[^A-Za-z0-9_.-]/g, "-");
    let name = base + ".geml";
    for (let k = 2; taken.has(name); k++) name = `${base}-${k}.geml`;
    taken.add(name);
    docNames.set(part, name);
  }

  // Semantic edges grouped by source node and kind. CONTAINS is intentionally
  // NOT an edge here — the document structure (file heading -> member blocks)
  // already states containment.
  const KIND_LABEL = { CALLS: "calls", IMPORTS_FROM: "imports", INHERITS: "inherits", TESTED_BY: "tested-by", REFERENCES: "references" };
  const outEdges = new Map(); // sourceId -> Map(kindLabel -> Set<targetId>)
  let internal = 0, external = 0, crossDoc = 0;
  for (const e of db.prepare("SELECT kind, source_qualified, target_qualified FROM edges").all()) {
    const label = KIND_LABEL[e.kind];
    if (!label) continue;
    const sid = idByQual.get(e.source_qualified);
    const tid = idByQual.get(e.target_qualified);
    if (sid === undefined) continue;
    if (tid === undefined) { external++; continue; }
    internal++;
    if (partOf.get(sid) !== partOf.get(tid)) crossDoc++;
    if (!outEdges.has(sid)) outEdges.set(sid, new Map());
    const m = outEdges.get(sid);
    if (!m.has(label)) m.set(label, new Set());
    m.get(label).add(tid);
  }

  // A reference to `tid` as seen from document `fromPart`: same doc -> [[#id]]
  // auto-ref; other doc -> checked cross-document link.
  const refTo = (tid, fromPart) => {
    const tPart = partOf.get(tid);
    if (tPart === fromPart) return `[[#${gid(tid)}]]`;
    return `[${linkText(byId.get(tid).name)}](${docNames.get(tPart)}#${gid(tid)})`;
  };
  const edgeLines = (nid, fromPart) => {
    const m = outEdges.get(nid);
    if (!m) return "";
    return [...m.entries()].map(([label, tids]) => `\n${label}: ${[...tids].map((t) => refTo(t, fromPart)).join(" ")}`).join("");
  };

  // Group nodes per partition, per file; File nodes become `##` headings.
  const parts = new Map(); // part -> Map(filePath -> {fileNode, members[]})
  for (const n of nodes) {
    const part = partOf.get(n.id);
    if (!parts.has(part)) parts.set(part, new Map());
    const files = parts.get(part);
    if (!files.has(n.file_path)) files.set(n.file_path, { fileNode: undefined, members: [] });
    const slot = files.get(n.file_path);
    if (n.kind === "File") slot.fileNode = n;
    else slot.members.push(n);
  }

  mkdirSync(outPath, { recursive: true });
  let totalBytes = 0;
  const indexRows = [];
  for (const [part, files] of [...parts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const docName = docNames.get(part);
    const nodeCount = [...files.values()].reduce((a, f) => a + f.members.length + (f.fileNode ? 1 : 0), 0);
    const chunks = [
      `=== meta\ngraph-of = "${esc(rel(dbPath))}"\npartition = "${esc(part)}"\nnodes = ${nodeCount}\n===\n`,
      `# ${esc(part)}\n`,
    ];
    for (const [, { fileNode, members }] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const base = fileNode ? rel(fileNode.file_path).split("/").pop() : rel(members[0].file_path).split("/").pop();
      chunks.push(fileNode ? `## ${esc(base)} {#${gid(fileNode.id)}}\n` : `## ${esc(base)}\n`);
      if (fileNode) {
        const fe = edgeLines(fileNode.id, part);
        if (fe) chunks.push(fe.trimStart() + "\n");
      }
      members.sort((a, b) => (a.line_start ?? 0) - (b.line_start ?? 0));
      for (const n of members) {
        chunks.push(`=== note {#${gid(n.id)} .${n.kind}}\n\`${esc(n.name)}\`${edgeLines(n.id, part)}\n===\n`);
      }
    }
    const doc = chunks.join("\n");
    writeFileSync(join(outPath, docName), doc);
    totalBytes += doc.length;
    indexRows.push({ part, docName, nodeCount });
  }

  indexRows.sort((a, b) => b.nodeCount - a.nodeCount);
  const index = [
    `=== meta\ngraph-of = "${esc(rel(dbPath))}"\nkind = "partition-index"\ndocuments = ${indexRows.length}\nnodes = ${nodes.length}\n===\n`,
    `# Code graph — partition index\n`,
    `One document per source directory; containment is document structure (file\nheadings), semantic edges are checked references (cross-document included).\n`,
    ...indexRows.map((r) => `- [${linkText(r.part)}](${r.docName}) — ${r.nodeCount} nodes`),
    "",
  ].join("\n");
  writeFileSync(join(outPath, "index.geml"), index);
  totalBytes += index.length;

  console.error(
    `graph2geml: partition root=${arg} docs=${indexRows.length}+index nodes=${nodes.length} `
    + `internal=${internal} (cross-doc=${crossDoc}) external=${external} `
    + `bytes=${totalBytes} (${(totalBytes / 1048576).toFixed(2)} MB) -> ${outPath}/`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// single-document modes: full | dir <substr> | flow <id>
// ---------------------------------------------------------------------------
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
