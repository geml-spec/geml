#!/usr/bin/env node
// geml-code-graph MCP tools — the thin consumption wrapper of DESIGN §8 (P2).
// Navigation over a built graph/ directory, each "give an identifier, get
// readable text back" (the original proposal's 2.6). Every name mirrors its CLI
// path — `geml codemap <sub>` -> `geml_codemap_<sub>` — so one vocabulary covers
// both surfaces:
//   geml_codemap_search     name or substring -> candidates (start here)
//   geml_codemap_list       no arg -> modules; a module -> its symbols
//   geml_codemap_node       doc + id -> that symbol's block, verbatim
//   geml_codemap_callchain  doc + id -> several hops, either direction
//
// The four cover reading the graph, not producing it: building and refreshing
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
// Where the sources live is serve.mjs's rule (the recipe's `root`, else the
// graph dir's parent). Imported, not restated: two copies would drift and the
// source panel and this tool would disagree about which file a symbol is in.
import { resolveSrcRoot } from "./serve.mjs";

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

// ---- CSV-table reading (profile §4) -----------------------------------------
// Serves the edge tables — `#calls` is `from, to, kind, confidence`, `#called-by`
// is `from, to, kind, site`, cells being `#id` (this document) or `doc.geml#id`
// (a sibling) — and the index's `#modules`, which has the same shape: a fence
// line, a header row, then data.
const tableRows = (graphDir, doc, tableId) => {
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
  for (const row of tableRows(graphDir, doc, table)) {
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

// The symbol index: name -> [{ anchor, doc, id }].
const loadLookup = (graphDir) => {
  const lookupPath = join(graphDir, "_index/name-lookup.json");
  if (!existsSync(lookupPath)) throw new Error(`no name-lookup at ${lookupPath} — build the graph first`);
  return JSON.parse(readFileSync(lookupPath, "utf8"));
};

// ---- name search (shared with `geml codemap find`) --------------------------
// One definition of "matches", so the CLI and the tool cannot answer the same
// query differently: case-insensitive substring over the name index, sorted.
// `exact` narrows to the whole name — the former `resolve_name`, now a flag,
// because two tools differing only in strictness is two chances to pick wrong.
export const searchNames = (graphDir, query, exact = false) => {
  const lookup = loadLookup(graphDir);
  if (exact) return { names: lookup[query] ? [query] : [], lookup };
  const q = query.toLowerCase();
  return { names: Object.keys(lookup).filter((n) => n.toLowerCase().includes(q)).sort(), lookup };
};

// The index's `#modules` table: module, doc, methods, entries, tests.
const moduleRows = (graphDir) =>
  tableRows(graphDir, "index.geml", "modules").filter((r) => r[0] && r[1]);

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

// ---- reading the real source a `src=` pointer names -------------------------
// Same two rules `codemap serve` uses for its source panel, imported rather
// than restated: WHERE the sources are (the recipe's `root`, else the graph
// dir's parent) and that a file is only served when it really sits under that
// root, symlinks resolved. What differs is the slice — serve hands the browser
// the whole file and lets the viewer highlight the range; a model wants the
// symbol's own lines and nothing else.
const MAX_SOURCE_LINES = 400;

// `geml mcp` also confines every path to its own --root. The source root is
// derived from `_index/refresh.json`, a file inside the graph — data, not
// configuration this process chose — so a hand-edited `root: "../../.."` must
// not reach outside the server's root. Unset (a bare library use) = no extra
// bound beyond the source root itself.
let SOURCE_BOUND = null;
export const confineSourceTo = (dir) => { SOURCE_BOUND = dir ? realpathSync(dir) : null; };

const underRoot = (real, root) => real === root || real.startsWith(root + sep);

/** The `src=` attribute of a block header: `path` or `path#Lstart-end`. */
const srcPointer = (block) => {
  const m = /\bsrc=(?:"([^"]+)"|([^\s}]+))/.exec(block.split("\n", 1)[0] ?? "");
  if (!m) return null;
  const raw = m[1] || m[2];
  const range = /^(.*?)#L(\d+)(?:-(\d+))?$/.exec(raw);
  return range
    ? { path: range[1], start: Number(range[2]), end: Number(range[3] ?? range[2]) }
    : { path: raw, start: null, end: null };
};

export const readSource = (graphDir, block) => {
  const ptr = srcPointer(block);
  if (!ptr) return "(no `src=` on this block — nothing to read; edge tables and index blocks have no source)";
  const srcRoot = resolveSrcRoot(graphDir);
  let realRoot;
  try { realRoot = realpathSync(srcRoot); } catch { return `(source root ${srcRoot} does not exist — the sources are not next to the graph on this machine)`; }
  if (SOURCE_BOUND && !underRoot(realRoot, SOURCE_BOUND)) {
    return `(refused: the graph's recorded source root ${srcRoot} is outside this server's --root)`;
  }
  let real;
  try { real = realpathSync(resolve(realRoot, ptr.path)); } catch { return `(no such source file: ${ptr.path})`; }
  if (!underRoot(real, realRoot) || (SOURCE_BOUND && !underRoot(real, SOURCE_BOUND))) {
    return `(refused: ${ptr.path} resolves outside the source root)`;
  }
  let text;
  try { text = readFileSync(real, "utf8"); } catch (e) { return `(cannot read ${ptr.path}: ${e.message})`; }
  const all = text.split("\n");
  const start = ptr.start ?? 1;
  const end = Math.min(ptr.end ?? all.length, start + MAX_SOURCE_LINES - 1);
  const slice = all.slice(start - 1, end);
  if (!slice.length) return `(${ptr.path} has no lines ${start}-${end} — the graph is stale; rebuild with \`geml codemap build\`)`;
  const cut = (ptr.end ?? all.length) > end ? `\n… truncated at ${MAX_SOURCE_LINES} lines` : "";
  // Line numbers so a model can cite `file:line` without recounting.
  const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
  return `--- ${ptr.path}:${start}-${end} ---\n${body}${cut}`;
};

export const TOOLS = [
  {
    name: "geml_codemap_search",
    description:
      "Find symbols in the code graph BY NAME — case-insensitive substring by default, or the whole name with `exact: true` when you already know it. Returns `name  doc#id  src` per candidate, the same index the CLI's `geml codemap find` and the viewer's search box use, and `doc`+`id` are what geml_codemap_node and geml_codemap_callchain take. Start here on an unfamiliar codebase (or geml_codemap_list to browse by module). Several candidates for one name is real ambiguity — overloads, or the same name in two modules — so inspect each rather than assuming the first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The symbol name, or a substring of it (e.g. `token` matches issueToken and TokenStore)" },
        exact: { type: "boolean", description: "Match the WHOLE name instead of a substring (default false)" },
        limit: { type: "number", description: "Maximum candidates to return (default 50). Narrow the query rather than raising this." },
        graph_dir: { type: "string", description: "Graph directory (default: $GEML_GRAPH_DIR or ./.geml-code-graph)" },
      },
      required: ["query"],
    },
    run: (args) => {
      const graphDir = graphDirOf(args);
      const query = String(args.query ?? "");
      if (!query) throw new Error("`query` is required");
      const exact = args.exact === true;
      const { names, lookup } = searchNames(graphDir, query, exact);
      if (!names.length) {
        return exact
          ? `no symbol named \`${query}\` in the graph — drop \`exact\` to match substrings`
          : `no symbol matching "${query}" in the graph`;
      }
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
    name: "geml_codemap_callchain",
    description:
      "Walk the call graph SEVERAL hops from one symbol and get the whole chain back as an indented tree — `direction: callees` for what it calls (downstream, for tracing a behaviour), `callers` for what reaches it (upstream, the impact path). Use this instead of opening one symbol per level: one call replaces N round trips and returns only the edges, not each symbol's full block. `depth: 1` with `callers` answers \"who calls this\" alone. A repeated symbol is marked and not expanded twice, so recursion terminates. Call SITES (file:line) are not in the tree — read the `#called-by` table with geml_codemap_node(doc, \"#called-by\") for those.",
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
    name: "geml_codemap_list",
    description:
      "Browse the graph by MODULE. Called with no argument it lists every module with its document and symbol count — the map to open first on an unfamiliar repo, before you know any name to search for. Called with a `module` it lists that module's symbols as `name  doc#id  src`, ready to hand to geml_codemap_node or geml_codemap_callchain. Accepts a module name or its document path.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "Module name (e.g. geml-parser) or its document (geml-parser.geml). Omit to list every module." },
        graph_dir: { type: "string", description: "Graph directory (default: $GEML_GRAPH_DIR or ./.geml-code-graph)" },
      },
    },
    run: (args) => {
      const graphDir = graphDirOf(args);
      const rows = moduleRows(graphDir);
      if (!rows.length) throw new Error(`no #modules table in index.geml (graph dir: ${graphDir}) — build the graph first`);
      const want = String(args.module ?? "").trim();
      if (!want) {
        return rows.map((r) => `${r[0]}\t${r[1]}\t${r[2] || 0} symbol(s)`).join("\n") +
          `\n\n${rows.length} module(s). Pass one as \`module\` to list its symbols.`;
      }
      const row = rows.find((r) => r[0] === want || r[1] === want);
      if (!row) return `no module \`${want}\` in the graph — call this tool with no argument to list them`;
      const doc = row[1];
      // The name index is the symbol list: filtering it by document skips the
      // per-document edge tables (#calls / #called-by) a raw id listing returns.
      const lookup = loadLookup(graphDir);
      const lines = [];
      for (const [name, cands] of Object.entries(lookup)) {
        for (const c of cands) {
          if (c.doc !== doc) continue;
          const src = srcOf(graphDir, doc, c.id);
          lines.push(`${name}\t${doc}#${c.id}${src ? `\t${src}` : ""}`);
        }
      }
      // Name the module CANONICALLY (its #modules name), not however the caller
      // addressed it, so `auth` and `auth.geml` return byte-identical answers.
      if (!lines.length) return `module \`${row[0]}\` (${doc}) has no symbols in the name index`;
      lines.sort();
      return lines.join("\n") + `\n\n${lines.length} symbol(s) in ${row[0]}.`;
    },
  },
  {
    name: "geml_codemap_node",
    description:
      "Open ONE node of the graph verbatim: a symbol's block (its `src=` pointer into the real file, confidence annotations), or a document's edge table — pass `#calls` / `#called-by` / `#unresolved` as the id for those. `#called-by` is where call SITES (file:line) live. Pass `source: true` to also read the REAL SOURCE the `src=` pointer names — the symbol's own lines, the same text the local viewer shows in its source panel — so you do not have to open the file yourself. Get `doc` and `id` from geml_codemap_search or geml_codemap_list.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "Document path relative to the graph dir, e.g. hashtable.c.geml" },
        id: { type: "string", description: "Block id, e.g. hashtableFind (or #calls / #called-by / #unresolved for the edge tables)" },
        source: { type: "boolean", description: "Also return the real source lines that `src=` points at (default false). Off by default because a node is often opened in a loop, where the pointer is enough." },
        graph_dir: { type: "string", description: "Graph directory (default: $GEML_GRAPH_DIR or ./.geml-code-graph)" },
      },
      required: ["doc", "id"],
    },
    run: (args) => {
      const graphDir = graphDirOf(args);
      const block = readBlock(graphDir, args.doc, args.id);
      if (args.source !== true) return block;
      return `${block}\n${readSource(graphDir, block)}`;
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
