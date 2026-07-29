#!/usr/bin/env node
// geml-code-graph MCP tools — the thin consumption wrapper of DESIGN §8 (P2).
// Navigation over a built graph/ directory, each "give an identifier, get
// readable text back" (the original proposal's 2.6):
//   search_symbols  partial name -> candidates (start here when exploring)
//   resolve_name    exact name -> candidate anchors (doc + block id)
//   open_symbol     doc + id -> that symbol's block, verbatim
//   get_backlinks   doc + id -> the symbol's backlink block (who calls it)
//   trace_calls     doc + id -> several hops of the chain, either direction
//
// The five cover reading the graph, not producing it: building and refreshing
// stay CLI-only on purpose (both run indexers or recorded shell steps, which is
// not something a model should trigger), and `codemap serve` renders HTML for a
// human, which a model cannot consume. See DESIGN §8.
//
// This file is a LIBRARY, not a server entry point. `geml codemap mcp` was
// removed: `geml mcp --root <dir>` serves these three tools next to the
// document tools, importing the TOOLS table below rather than duplicating it,
// so a client registers one server instead of two.
//
//   claude mcp add geml -- geml mcp --root /abs/path/to/repo
//
// `graphDirOf` still honours GEML_GRAPH_DIR and a per-call `graph_dir`. Nothing
// reaches those defaults through `geml mcp`, which resolves the directory
// against its own --root before calling a tool — a client-chosen directory is
// safe only on a process that cannot write, and that one can.
//
// Zero dependencies; the handlers speak newline-delimited JSON-RPC 2.0 (the MCP
// stdio transport) and `handleLine` is exported so both `geml mcp` and the test
// suite drive it in-process.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

// blockSpans from the reference parser (its CLI entry is guarded, so importing
// is side-effect free). Falls back with a clear error if the parser isn't built.
const parserPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/geml.js");
if (!existsSync(parserPath)) {
  console.error("geml-code-graph mcp: build the parser first (cd geml-parser && npm install && npm run build)");
  process.exit(1);
}
const { blockSpans } = await import(`file://${parserPath.replace(/\\/g, "/")}`);
const splitLines = (s) => s.split(/(?<=\n)/);

export const graphDirOf = (args) => resolve(args?.graph_dir ?? process.env.GEML_GRAPH_DIR ?? ".geml-code-graph");

export const readBlock = (graphDir, doc, id) => {
  const p = join(graphDir, doc);
  // Confine `doc` to the graph dir. `doc` is client-supplied, so a value like
  // ../../../etc/hosts joins OUT of the dir; realpathSync canonicalizes both
  // sides (also defeating symlink escapes and normalizing Windows casing) and
  // we verify the real doc path stays within the real graph dir. A missing
  // file makes realpathSync throw — that is the normal "no such document"
  // miss. (graph_dir itself is intentionally client-chosen — the server is
  // pointed at a graph — so only the doc path is confined, to that dir.)
  let realDir;
  try { realDir = realpathSync(graphDir); } catch { realDir = resolve(graphDir); }
  let realP;
  try { realP = realpathSync(p); } catch { throw new Error(`no such document: ${doc} (graph dir: ${graphDir})`); }
  if (realP !== realDir && !realP.startsWith(realDir + sep)) {
    throw new Error(`document escapes the graph dir: ${doc} (graph dir: ${graphDir})`);
  }
  const source = readFileSync(realP, "utf8");
  const span = blockSpans(source).get(id.replace(/^#/, ""));
  if (!span) throw new Error(`no block with id \`${id}\` in ${doc}`);
  return splitLines(source).slice(span.start, span.end).join("");
};

// ---- edge-table reading (profile §4) ----------------------------------------
// `#calls` is `from, to, kind, confidence`; `#called-by` is `from, to, kind,
// site`. Cells are `#id` (this document) or `doc.geml#id` (a sibling), so one
// parser serves both directions.
const edgeRows = (graphDir, doc, tableId) => {
  let raw;
  try { raw = readBlock(graphDir, doc, tableId); } catch { return []; }
  // readBlock returns the whole block: fence line, header row, data, close.
  return raw.split("\n").slice(2)
    .filter((l) => l.trim() && !l.trimStart().startsWith("==="))
    .map((l) => l.split(",").map((c) => c.trim()));
};

// A from/to cell as a target, or null when it is plain text (an `#unresolved`
// target or a `file:line` site — profile §4 says those are unchecked).
const refTarget = (cell, fromDoc) => {
  const m = /^([^#]*)#(.+)$/.exec(cell ?? "");
  return m ? { doc: m[1] || fromDoc, id: m[2] } : null;
};

// One hop. `callees` reads this document's out-edges; `callers` reads the
// in-edge table, which the generator aggregates per document, so both
// directions are a single read of the symbol's OWN document.
const neighbours = (graphDir, doc, id, direction) => {
  const table = direction === "callers" ? "called-by" : "calls";
  const [self, other] = direction === "callers" ? [1, 0] : [0, 1];
  const want = `#${id.replace(/^#/, "")}`;
  const out = [];
  const seen = new Set();
  for (const row of edgeRows(graphDir, doc, table)) {
    if (row[self] !== want) continue;
    const t = refTarget(row[other], doc);
    // A symbol called from three sites yields three identical rows; the caller
    // wants the shape of the graph, not the call count.
    if (!t) continue;
    const key = `${t.doc}#${t.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...t, kind: row[2] || "call" });
  }
  return out;
};

// ---- name search (shared with `geml codemap find`) --------------------------
// One definition of "matches", so the CLI and the tool cannot answer the same
// query differently: case-insensitive substring over the name index, sorted.
export const searchNames = (graphDir, query) => {
  const lookupPath = join(graphDir, "_index/name-lookup.json");
  if (!existsSync(lookupPath)) throw new Error(`no name-lookup at ${lookupPath} — build the graph first`);
  const lookup = JSON.parse(readFileSync(lookupPath, "utf8"));
  const q = query.toLowerCase();
  return { names: Object.keys(lookup).filter((n) => n.toLowerCase().includes(q)).sort(), lookup };
};

// `src=` lives on the block header line; read each doc once and index by id.
// The id charset excludes `.`, and src may be quoted or a bare token.
const srcCache = new Map(); // `${graphDir}\0${doc}` -> Map(id -> src)
export const srcOf = (graphDir, doc, id) => {
  const key = `${graphDir}\0${doc}`;
  if (!srcCache.has(key)) {
    const map = new Map();
    try {
      const text = readFileSync(join(graphDir, doc), "utf8");
      const re = /\{#([A-Za-z0-9._-]+)\b[^}]*?\bsrc=(?:"([^"]+)"|([^\s}]+))/g;
      let m;
      while ((m = re.exec(text))) map.set(m[1], m[2] || m[3]);
    } catch { /* doc unreadable — a src is a nicety, not the answer */ }
    srcCache.set(key, map);
  }
  return srcCache.get(key).get(id) || "";
};

export const TOOLS = [
  {
    name: "search_symbols",
    description:
      "Find symbols by PARTIAL name (case-insensitive substring) — use this when you do not know the exact short name, which is what `resolve_name` requires. Returns `name  doc#id  src` per candidate, the same index the CLI's `geml codemap find` and the viewer's search box use. Start here when exploring an unfamiliar codebase; switch to `resolve_name` once you have an exact name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring of the symbol name, case-insensitive (e.g. `token` matches issueToken and TokenStore)" },
        limit: { type: "number", description: "Maximum candidates to return (default 50). Narrow the query rather than raising this." },
        graph_dir: { type: "string", description: "Graph directory (default: $GEML_GRAPH_DIR or ./.geml-code-graph)" },
      },
      required: ["query"],
    },
    run: (args) => {
      const graphDir = graphDirOf(args);
      const query = String(args.query ?? "");
      if (!query) throw new Error("`query` is required");
      const { names, lookup } = searchNames(graphDir, query);
      if (!names.length) return `no symbol matching "${query}" in the graph`;
      const limit = Math.max(1, Math.min(Number(args.limit) || 50, 500));
      const lines = [];
      let total = 0;
      for (const name of names) {
        for (const c of lookup[name]) {
          total++;
          if (lines.length < limit) {
            const src = srcOf(graphDir, c.doc, c.id);
            lines.push(`${name}\t${c.doc}#${c.id}${src ? `\t${src}` : ""}`);
          }
        }
      }
      const tail = total > lines.length
        ? `\n\n${lines.length} of ${total} match(es) shown — narrow the query.`
        : `\n\n${total} match(es) across ${names.length} name(s).`;
      return lines.join("\n") + tail;
    },
  },
  {
    name: "trace_calls",
    description:
      "Walk the call graph SEVERAL hops from one symbol and get the whole chain back as an indented tree — `direction: callees` for what it calls (downstream), `callers` for what reaches it (upstream, the impact path). Use this instead of calling open_symbol/get_backlinks once per level: one call replaces N round trips and returns only the edges, not each symbol's full block. A repeated symbol is marked and not expanded twice, so recursion terminates.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "The symbol's document path, e.g. hashtable.c.geml" },
        id: { type: "string", description: "The symbol's block id, e.g. hashtableFind" },
        direction: { type: "string", enum: ["callees", "callers"], description: "`callees` = what this calls (default); `callers` = what calls this" },
        depth: { type: "number", description: "How many hops to follow (default 3, max 6)" },
        graph_dir: { type: "string", description: "Graph directory (default: $GEML_GRAPH_DIR or ./.geml-code-graph)" },
      },
      required: ["doc", "id"],
    },
    run: (args) => {
      const graphDir = graphDirOf(args);
      const direction = args.direction === "callers" ? "callers" : "callees";
      const depth = Math.max(1, Math.min(Number(args.depth) || 3, 6));
      const rootId = String(args.id ?? "").replace(/^#/, "");
      if (!args.doc || !rootId) throw new Error("`doc` and `id` are required");
      // Prove the symbol exists before reporting an empty chain: "no edges" and
      // "no such symbol" are different answers and a model must not conflate them.
      readBlock(graphDir, args.doc, rootId);

      const MAX_NODES = 200;
      const lines = [];
      const expanded = new Set();
      let truncated = false;

      // EVERY line carries the full `doc.geml#id`, including same-document
      // targets that profile §4 would abbreviate to `#id`. The reader here is
      // an agent, and each line has to be usable as-is for the next
      // `open_symbol`/`trace_calls` call. A bare id would make it infer the
      // document from the line's ancestors — cheaper output, one more thing to
      // get wrong.
      const walk = (doc, id, level, prefix, last) => {
        const key = `${doc}#${id}`;
        const label = level === 0 ? `${key}` : `${prefix}${last ? "└─ " : "├─ "}${key}`;
        if (lines.length >= MAX_NODES) { truncated = true; return; }
        if (expanded.has(key)) { lines.push(`${label}  (already shown)`); return; }
        lines.push(label);
        expanded.add(key);
        if (level >= depth) {
          // Say whether the cut hides anything, so a model knows to go deeper.
          if (neighbours(graphDir, doc, id, direction).length) lines.push(`${prefix}${last ? "   " : "│  "}   … (depth limit)`);
          return;
        }
        const next = neighbours(graphDir, doc, id, direction);
        const childPrefix = level === 0 ? "" : prefix + (last ? "   " : "│  ");
        next.forEach((n, i) => walk(n.doc, n.id, level + 1, childPrefix, i === next.length - 1));
      };
      walk(args.doc, rootId, 0, "", true);

      const noun = direction === "callers" ? "callers" : "callees";
      if (lines.length === 1) {
        return `${lines[0]}\n\nno resolved ${noun} — under heuristic extraction that is a blind spot, not proof of none (see the #unresolved table).`;
      }
      return lines.join("\n") +
        `\n\n${direction}, depth ${depth}${truncated ? `, truncated at ${MAX_NODES} nodes` : ""}. ` +
        "Resolved edges only: `#unresolved` holds the blind spots.";
    },
  },
  {
    name: "resolve_name",
    description: "Find a function/class by name in the code graph. Returns candidate anchors with the document and block id to open. Multiple candidates = real ambiguity (overloads/same name) — inspect each, never assume.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact symbol name (function/class short name)" },
        graph_dir: { type: "string", description: "Graph directory (default: $GEML_GRAPH_DIR or ./.geml-code-graph)" },
      },
      required: ["name"],
    },
    run: (args) => {
      const lookupPath = join(graphDirOf(args), "_index/name-lookup.json");
      if (!existsSync(lookupPath)) throw new Error(`no name-lookup at ${lookupPath} — build the graph first`);
      const lookup = JSON.parse(readFileSync(lookupPath, "utf8"));
      const hits = lookup[args.name];
      if (!hits?.length) return `no symbol named \`${args.name}\` in the graph`;
      return JSON.stringify(hits, null, 1);
    },
  },
  {
    name: "open_symbol",
    description: "Open ONE symbol's block from the code graph (its callees as checked references, confidence annotations, called-by pointer). Equivalent to following a link. Get doc+id from resolve_name.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "Document path relative to the codemap dir, e.g. hashtable.c.geml" },
        id: { type: "string", description: "Block id, e.g. hashtableFind (or #calls / #called-by for the edge tables)" },
        graph_dir: { type: "string", description: "Graph directory (default: $GEML_GRAPH_DIR or ./.geml-code-graph)" },
      },
      required: ["doc", "id"],
    },
    run: (args) => readBlock(graphDirOf(args), args.doc, args.id),
  },
  {
    name: "get_backlinks",
    description: "Who calls this symbol: opens its backlink block (callers with file:line sites, each a followable reference). Absence means no RESOLVED callers — never proof of none.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "The symbol's document path, e.g. hashtable.c.geml" },
        id: { type: "string", description: "The symbol's block id (e.g. hashtableFind); omit to get the whole #called-by table" },
        graph_dir: { type: "string", description: "Codemap directory (default: $GEML_GRAPH_DIR or ./.geml-code-graph)" },
      },
      required: ["doc"],
    },
    run: (args) => {
      // codemap profile: in-edges live in the SAME document's #called-by table.
      let table;
      try {
        table = readBlock(graphDirOf(args), args.doc, "called-by");
      } catch {
        return `no #called-by table in ${args.doc} — no resolved callers recorded (under heuristic extraction this is a blind spot, not proof of none)`;
      }
      if (!args.id) return table;
      const id = args.id.replace(/^#/, "");
      // `id` is client-supplied and goes straight into a RegExp: escape every
      // regex metacharacter so it matches LITERALLY (an id like `.*` or a
      // catastrophic-backtracking pattern can neither widen the match nor cause
      // ReDoS — the pattern is a fixed string wrapped in `,\s*#…\s*,`).
      const escId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`,\\s*#${escId}\\s*,`);
      const lines = table.split("\n");
      const hits = lines.filter((l, i) => i < 2 || re.test(l));
      return hits.length > 2 ? hits.join("\n")
        : `no resolved callers of #${id} in ${args.doc} (blind spots live in the #unresolved table)`;
    },
  },
];

// ---- newline-delimited JSON-RPC 2.0 over stdio ----
// One frame in, zero or one frame out via `write` (stdout in production).
export function handleLine(line, write = (s) => process.stdout.write(s)) {
  const reply = (id, result) => write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const replyError = (id, code, message) =>
    write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "geml-code-graph", version: "0.2.0" },
      });
    } else if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
      // notifications get no response
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    } else if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) { replyError(id, -32602, `unknown tool: ${params?.name}`); return; }
      try {
        reply(id, { content: [{ type: "text", text: tool.run(params?.arguments ?? {}) }] });
      } catch (e) {
        reply(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
      }
    } else if (id !== undefined) {
      replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) replyError(id, -32603, String(e?.message ?? e));
  }
}

// No main-module block: this file no longer starts a server. Running it
// directly used to serve the three tools on stdio, and leaving that in would
// keep the removed entry point alive as a back door — `node codemap/
// mcp-server.mjs` reachable from any client config. `geml mcp` owns the
// transport now.
