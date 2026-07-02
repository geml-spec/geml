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
// Navigation anchors are marked as semantic classes in every mode:
//   .entry        a `main` function (program entry point)
//   .flow-entry   entry of a high-criticality flow (>= 0.6, when the db has `flows`)
//   .Test         a recognized test case (the db's kind = 'Test')
//   .test         anything in test territory — a test/tests/spec directory
//                 segment or a test-named file (an avowed path heuristic: the
//                 db does not flag test *code*, only recognized test cases)
//   .leaf         a call-graph leaf: called but calls nothing (not even an
//                 unresolved call) — a terminal helper. Partition mode also
//                 emits edges INTO leaves on separate `calls-leaf:` lines, a
//                 rendering hint so viewers can restyle or default-hide them.
// Partition mode additionally surfaces them: an "Entry points:" line under each
// document title; index.geml gets program vs test entry-point sections, the
// critical-flow list, and the partition list split into source vs tests
// (a partition is "tests" when >= 50% of its nodes are in test territory).
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

// Entry-point marking, for navigation. Two signals, no semantic guessing:
// - `.entry`      — a `main` function: a program entry point (all of them; in a
//                   repo with vendored deps most are test/example mains, which
//                   is the truth of the graph, so they are grouped, not hidden).
// - `.flow-entry` — the entry of a high-criticality execution flow (>= 0.6), if
//                   the db has the `flows` table: where the important paths start.
const mains = new Set(
  db.prepare("SELECT id FROM nodes WHERE kind = 'Function' AND name = 'main'").all().map((r) => r.id),
);
const flowCrit = new Map(); // nodeId -> max criticality (only >= 0.6 kept)
try {
  for (const r of db.prepare("SELECT entry_point_id id, max(criticality) c FROM flows GROUP BY 1 HAVING c >= 0.6").all()) {
    flowCrit.set(r.id, r.c);
  }
} catch { /* no flows table in this db */ }

// Test territory. The db marks recognized test CASES (kind='Test', emitted as
// the `.Test` class), but not test *code*: helpers in a test file are plain
// Functions. That territory is derivable only from the repo's own path
// conventions — a `test`/`tests`/... directory segment or a test-named file.
// An avowed heuristic (path conventions, not intent), kept conservative.
const TEST_DIR = /(^|\/)(test|tests|testing|__tests__|spec|specs)(\/|$)/i;
const TEST_FILE = /(^test_|^tests?\.|[._-]tests?\.|\.test\.|\.spec\.)/i;
const isTestPath = (p) => {
  p = p.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  return TEST_DIR.test(p) || TEST_FILE.test(base);
};

// Call-graph leaves: functions that are called but call nothing themselves —
// terminal utility helpers. A rendering hint: a viewer may de-emphasize or
// default-hide them (and the edges into them) to declutter. Out-degree 0 must
// count UNRESOLVED calls too — with tree-sitter extraction most calls don't
// resolve, and a function whose calls are merely unresolved is NOT a leaf.
// (This is the structural notion only; visibility-`private`/`static` is a
// different property the current extraction doesn't populate.)
const leaves = new Set(db.prepare(`
  SELECT n.id FROM nodes n
  WHERE n.kind IN ('Function', 'Test')
    AND NOT EXISTS (SELECT 1 FROM edges o
                    WHERE o.kind = 'CALLS' AND o.source_qualified = n.qualified_name)
    AND EXISTS (SELECT 1 FROM edges i JOIN nodes s ON s.qualified_name = i.source_qualified
                WHERE i.kind = 'CALLS' AND i.target_qualified = n.qualified_name)
`).all().map((r) => r.id));

const classesOf = (n) =>
  `.${n.kind}${mains.has(n.id) ? " .entry" : ""}${flowCrit.has(n.id) ? " .flow-entry" : ""}`
  + (isTestPath(n.file_path) ? " .test" : "") + (leaves.has(n.id) ? " .leaf" : "");

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
  // Edges into call-graph leaves go on their own `calls-leaf:` line, so a
  // renderer can restyle or default-hide them without resolving the targets.
  const edgeLines = (nid, fromPart) => {
    const m = outEdges.get(nid);
    if (!m) return "";
    const lines = [];
    for (const [label, tids] of m.entries()) {
      const groups = label === "calls"
        ? [["calls", [...tids].filter((t) => !leaves.has(t))], ["calls-leaf", [...tids].filter((t) => leaves.has(t))]]
        : [[label, [...tids]]];
      for (const [lab, list] of groups) {
        if (list.length) lines.push(`\n${lab}: ${list.map((t) => refTo(t, fromPart)).join(" ")}`);
      }
    }
    return lines.join("");
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
    const testCount = [...files.entries()].reduce(
      (a, [fp, f]) => a + (isTestPath(fp) ? f.members.length + (f.fileNode ? 1 : 0) : 0), 0);
    const chunks = [
      `=== meta\ngraph-of = "${esc(rel(dbPath))}"\npartition = "${esc(part)}"\nnodes = ${nodeCount}\n`
        + (testCount ? `tests = ${testCount}\n` : "") + `===\n`,
      `# ${esc(part)}\n`,
    ];
    // Navigation line: this partition's program entry points, right under the title.
    const partMains = [];
    for (const { members } of files.values()) for (const m of members) if (mains.has(m.id)) partMains.push(m);
    if (partMains.length) {
      chunks.push(`Entry points: ${partMains.map((m) => `[main — ${linkText(rel(m.file_path).split("/").pop())}](#${gid(m.id)})`).join(" · ")}\n`);
    }
    for (const [, { fileNode, members }] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const base = fileNode ? rel(fileNode.file_path).split("/").pop() : rel(members[0].file_path).split("/").pop();
      chunks.push(fileNode ? `## ${esc(base)} {#${gid(fileNode.id)}}\n` : `## ${esc(base)}\n`);
      if (fileNode) {
        const fe = edgeLines(fileNode.id, part);
        if (fe) chunks.push(fe.trimStart() + "\n");
      }
      members.sort((a, b) => (a.line_start ?? 0) - (b.line_start ?? 0));
      for (const n of members) {
        chunks.push(`=== note {#${gid(n.id)} ${classesOf(n)}}\n\`${esc(n.name)}\`${edgeLines(n.id, part)}\n===\n`);
      }
    }
    const doc = chunks.join("\n");
    writeFileSync(join(outPath, docName), doc);
    totalBytes += doc.length;
    indexRows.push({ part, docName, nodeCount, testCount });
  }

  indexRows.sort((a, b) => b.nodeCount - a.nodeCount);

  // Navigation: program entry points grouped by partition (few-main partitions
  // first — in a repo with vendored deps those are usually the product's real
  // entries, while test/example mains pile up in big buckets at the end), and
  // the entries of the most critical execution flows.
  const CAP = 6;
  const groupMains = (ids) => {
    const byPart = new Map();
    for (const id of ids) {
      const p = partOf.get(id);
      if (p === undefined) continue;
      if (!byPart.has(p)) byPart.set(p, []);
      byPart.get(p).push(id);
    }
    return [...byPart.entries()]
      .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))
      .map(([p, list]) => {
        const doc = docNames.get(p);
        const shown = list.slice(0, CAP)
          .map((id) => `[${linkText(rel(byId.get(id).file_path).split("/").pop())}](${doc}#${gid(id)})`)
          .join(" · ");
        const more = list.length > CAP ? ` · +${list.length - CAP} more in [${linkText(p)}](${doc})` : "";
        return `- **${linkText(p)}**: ${shown}${more}`;
      });
  };
  const srcMains = [...mains].filter((id) => !isTestPath(byId.get(id).file_path));
  const testMains = [...mains].filter((id) => isTestPath(byId.get(id).file_path));
  const entrySection = [
    ...(srcMains.length ? [`## Program entry points (\`main\`)\n`, ...groupMains(srcMains), ""] : []),
    ...(testMains.length ? [`## Test entry points (\`main\`)\n`, ...groupMains(testMains), ""] : []),
  ];
  const critTop = [...flowCrit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const flowSection = critTop.length === 0 ? [] : [
    `## Critical flow entries\n`,
    ...critTop.map(([id, c]) => {
      const n = byId.get(id);
      return `- [${linkText(n.name)}](${docNames.get(partOf.get(id))}#${gid(id)}) — criticality ${c} — ${linkText(rel(n.file_path))}`;
    }),
    "",
  ];

  const partRow = (r) => `- [${linkText(r.part)}](${r.docName}) — ${r.nodeCount} nodes`
    + (r.testCount && r.testCount < r.nodeCount ? ` (${r.testCount} test)` : "");
  const srcParts = indexRows.filter((r) => r.testCount / r.nodeCount < 0.5);
  const testParts = indexRows.filter((r) => r.testCount / r.nodeCount >= 0.5);
  const index = [
    `=== meta\ngraph-of = "${esc(rel(dbPath))}"\nkind = "partition-index"\ndocuments = ${indexRows.length}\nnodes = ${nodes.length}\n===\n`,
    `# Code graph — partition index\n`,
    `One document per source directory; containment is document structure (file\nheadings), semantic edges are checked references (cross-document included).\nSemantic classes mark navigation anchors: \`.entry\` (a \`main\`), \`.flow-entry\`\n(start of a high-criticality flow), \`.Test\` (a recognized test case), \`.test\`\n(anything in test territory — a test directory or test-named file), \`.leaf\`\n(called but calls nothing — terminal helper; its incoming edges sit on\n\`calls-leaf:\` lines, so a renderer can restyle or default-hide them).\n`,
    ...entrySection,
    ...flowSection,
    ...(srcParts.length ? [`## Partitions — source\n`, ...srcParts.map(partRow), ""] : []),
    ...(testParts.length ? [`## Partitions — tests\n`, ...testParts.map(partRow), ""] : []),
  ].join("\n");
  writeFileSync(join(outPath, "index.geml"), index);
  totalBytes += index.length;

  console.error(
    `graph2geml: partition root=${arg} docs=${indexRows.length}+index nodes=${nodes.length} `
    + `internal=${internal} (cross-doc=${crossDoc}) external=${external} `
    + `entries: main=${mains.size} flow>=0.6=${flowCrit.size} test-nodes=${nodes.filter((n) => isTestPath(n.file_path)).length} leaves=${leaves.size} `
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
  parts.push(`=== note {#${gid(n.id)} ${classesOf(n)}}\n\`${esc(n.name)}\`${edges}\n===\n`);
}
const doc = parts.join("\n");
writeFileSync(outPath, doc);

const refs = [...outEdges.values()].reduce((a, s) => a + s.size, 0);
console.error(
  `graph2geml: mode=${mode}${arg ? " " + arg : ""} nodes=${nodes.length} refs=${refs} `
  + `internal=${internal} external=${external} cross_slice=${crossSlice} `
  + `bytes=${doc.length} (${(doc.length / 1048576).toFixed(2)} MB) -> ${outPath}`,
);
