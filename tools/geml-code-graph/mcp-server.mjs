#!/usr/bin/env node
// geml-code-graph MCP server — the thin consumption wrapper of DESIGN §8 (P2).
// Three navigation tools over a built graph/ directory, each "give an
// identifier, get readable text back" (the original proposal's 2.6):
//   resolve_name   name -> candidate anchors (doc + block id)
//   open_symbol    doc + id -> that symbol's block, verbatim
//   get_backlinks  doc + id -> the symbol's backlink block (who calls it)
//
// Zero dependencies: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio
// transport). Register e.g.:
//   claude mcp add geml-code-graph -e GEML_GRAPH_DIR=/abs/path/to/graph \
//     -- node tools/geml-code-graph/mcp-server.mjs
// The graph dir comes from GEML_GRAPH_DIR or a per-call `graph_dir` argument.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// blockSpans from the reference parser (its CLI entry is guarded, so importing
// is side-effect free). Falls back with a clear error if the parser isn't built.
const parserPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../geml-parser/dist/geml.js");
if (!existsSync(parserPath)) {
  console.error("geml-code-graph mcp: build the parser first (cd geml-parser && npm install && npm run build)");
  process.exit(1);
}
const { blockSpans } = await import(`file://${parserPath.replace(/\\/g, "/")}`);
const splitLines = (s) => s.split(/(?<=\n)/);

const graphDirOf = (args) => resolve(args?.graph_dir ?? process.env.GEML_GRAPH_DIR ?? "codemap");

const readBlock = (graphDir, doc, id) => {
  const p = join(graphDir, doc);
  if (!existsSync(p)) throw new Error(`no such document: ${doc} (graph dir: ${graphDir})`);
  const source = readFileSync(p, "utf8");
  const span = blockSpans(source).get(id.replace(/^#/, ""));
  if (!span) throw new Error(`no block with id \`${id}\` in ${doc}`);
  return splitLines(source).slice(span.start, span.end).join("");
};

const TOOLS = [
  {
    name: "resolve_name",
    description: "Find a function/class by name in the code graph. Returns candidate anchors with the document and block id to open. Multiple candidates = real ambiguity (overloads/same name) — inspect each, never assume.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact symbol name (function/class short name)" },
        graph_dir: { type: "string", description: "Graph directory (default: $GEML_GRAPH_DIR or ./codemap)" },
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
        graph_dir: { type: "string", description: "Graph directory (default: $GEML_GRAPH_DIR or ./codemap)" },
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
        graph_dir: { type: "string", description: "Codemap directory (default: $GEML_GRAPH_DIR or ./codemap)" },
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
      const lines = table.split("\n");
      const hits = lines.filter((l, i) => i < 2 || new RegExp(`,\\s*#${id}\\s*,`).test(l));
      return hits.length > 2 ? hits.join("\n")
        : `no resolved callers of #${id} in ${args.doc} (blind spots live in the #unresolved table)`;
    },
  },
];

// ---- newline-delimited JSON-RPC 2.0 over stdio ----
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const replyError = (id, code, message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
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
});
