#!/usr/bin/env node
// `geml mcp` — MCP server for GEML documents and the code graph, over stdio.
//
// Eleven tools over a confined root directory of `.geml` documents: six
// read-only, five that write, each named after the CLI verb it wraps (`geml set`
// -> `geml_set`, the bare transform entry -> `geml_to`). When that root holds a
// code graph, the four read-only code-graph tools from `codemap/mcp-server.mjs`
// are served from this SAME process, so a client registers one server instead
// of two. That file stays a standalone `geml codemap mcp` entry point; this one
// imports its tool table rather than copying it, which is cheap because the two
// were deliberately built to the same shape (newline-delimited JSON-RPC 2.0 over
// stdio, zero dependencies, an exported `handleLine` so the suite can drive it
// in-process).
//
//   claude mcp add geml -- geml mcp --root /abs/path/to/repo
//
// This file is the DISK HOST: what `mcp-core.ts` (the tool table, the write
// pipeline, the JSON-RPC dispatch) needs to know about a root directory on
// disk. The verbs themselves run in-process (verbs.ts) — there is no CLI child
// per tool call any more.
//
// Three invariants make this worth more than letting a model `str_replace` the
// file itself:
//
//   1. A WRITE IS VALIDATED BEFORE IT REACHES DISK. Every mutation is first
//      produced in memory, the RESULT is parsed, and the file is only
//      overwritten when the result is clean. A bad generation is refused with
//      the diagnostics that refused it — it does not land and then wait for a
//      human to notice.
//   2. EVERY WRITE IS PRECEDED BY A HISTORY COMMIT, so `geml_revert` can
//      always undo the block that was just touched. Without this the strongest
//      tool in the set would have nothing to revert to.
//   3. EVERY PATH IS CONFINED to a server-side `--root` directory the client
//      cannot override or widen. This is where the two servers disagreed, and
//      merging had to pick one: standalone `codemap mcp` lets the client name
//      `graph_dir` per call (it is pointed AT a graph and only reads). Here the
//      same process can write, so a client-named directory is narrowed to the
//      server root like every other path — a read-anywhere argument does not
//      belong on a server that also writes.
import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { save, listRevisions, isCurrent, resolveContent, firstChangedContent } from "./history.js";
import { type VerbContext, type FindHit, findInSource } from "./verbs.js";
import { docOptsFor, fsFiles, gemlFilesUnder, historyError } from "./host-fs.js";
import {
  type McpHost, type OpenedDoc, type Tool, type WriteResult,
  createHandler, toolsFor,
} from "./mcp-core.js";

export { type Tool, type WriteResult } from "./mcp-core.js";

export interface McpOptions {
  root: string;       // absolute, canonicalized; every `file` lives under it
  history: boolean;   // save a revision before each write (default true)
  graph?: string;     // absolute, canonicalized code-graph dir INSIDE root; unset = no graph tools
}

let OPTS: McpOptions = { root: process.cwd(), history: true };

/** Configure the server. Exported so the suite can point it at a temp dir. */
export function configure(o: Partial<McpOptions>): McpOptions {
  OPTS = { ...OPTS, ...o };
  return OPTS;
}

// ---------------------------------------------------------------------------
// Workspace confinement
// ---------------------------------------------------------------------------

// `file` is client-supplied, so `../../../etc/passwd` — or a symlink planted
// inside the root that points out of it — must not resolve. Canonicalize
// BOTH sides with realpathSync (which follows every link component) and require
// the real target to sit at or under the real root. Unlike the code-graph
// server, whose `graph_dir` is intentionally client-chosen, the root here is
// fixed by the operator at startup: this server WRITES, so a client that could
// name its own root could write anywhere.
export function resolveInRoot(file: string): string {
  if (typeof file !== "string" || file === "") throw new Error("`file` is required");
  const root = realpathSync(OPTS.root);
  const target = resolve(root, file);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error(`no such file under the server root: ${file}`);
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`path escapes the server root: ${file}`);
  }
  if (!statSync(real).isFile()) throw new Error(`not a file: ${file}`);
  return real;
}

// A client-named directory may only NARROW to one inside the server root — it
// can never widen or escape it. `label` names the argument in the error so the
// model can tell which of its arguments was refused.
function narrowToRoot(dir: string, label: string): string {
  const serverRoot = realpathSync(OPTS.root);
  const target = resolve(serverRoot, dir);
  let real: string;
  try { real = realpathSync(target); } catch { throw new Error(`no such directory under the server root: ${dir}`); }
  if (real !== serverRoot && !real.startsWith(serverRoot + sep)) throw new Error(`${label} escapes the server root: ${dir}`);
  return real;
}

// Cross-document references resolve against the SERVER root, never against
// a client-named directory.
function resolveRoot(root: string | undefined): string {
  if (root === undefined || root === "") return realpathSync(OPTS.root);
  return narrowToRoot(root, "root");
}

// The code-graph directory for one call: the server's `--graph` unless the
// client named one, and a client-named one is narrowed like any other path.
function resolveGraphDir(graphDir: unknown): string {
  if (graphDir === undefined || graphDir === "") {
    if (!OPTS.graph) throw new Error("this server has no code graph; start it with --graph <dir> under --root");
    return OPTS.graph;
  }
  return narrowToRoot(String(graphDir), "graph_dir");
}

// The server root as the filesystem really spells it. Falls back to the stored
// value when it cannot be canonicalized: an unusable root is the caller's
// problem to hear about from the verb, not something to throw from here.
function rootReal(): string {
  try { return realpathSync(OPTS.root); } catch { return OPTS.root; }
}

// ---------------------------------------------------------------------------
// The disk host
// ---------------------------------------------------------------------------

// Save the file's CURRENT bytes as a revision, so the about-to-happen write
// has something to revert to. A file already identical to its tip needs no
// second revision.
function snapshot(realPath: string, summary: string): string | undefined {
  const historyPath = realPath.replace(/\.geml$/, "") + ".gemlhistory";
  try {
    if (existsSync(historyPath) && isCurrent(historyPath, realPath)) return undefined;
    return save({ gemlPath: realPath, historyPath, summary }).id;
  } catch {
    // A sidecar that cannot be written must not cost the caller their edit;
    // the write still proceeds, just without a revert point.
    return undefined;
  }
}

// A cross-document reference resolves FROM THE DOCUMENT'S OWN DIRECTORY, which is
// what the CLI resolver and the renderer both do. Resolving from the server root
// instead made the validator inspect a different file than the renderer expands:
// for `sub/a.geml` naming `b.geml`, it validated `<root>/b.geml` while the render
// pulled in `<root>/sub/b.geml` — phantom errors in one direction, and in the other
// a write signed off against a file that was never the target. The root stays the
// confinement boundary.
function docResolver(root: string, fromFile: string): (doc: string) => string | null {
  const base = dirname(fromFile);
  return (doc: string) => {
    try {
      const target = realpathSync(resolve(base, doc));
      if (target !== root && !target.startsWith(root + sep)) return null;
      return readFileSync(target, "utf8");
    } catch {
      return null;
    }
  };
}

// A refusal tells the model, in so many words, that the file did not change.
// Without that sentence a model reads "error" and still assumes its edit landed.
const UNCHANGED = "The write was refused; the file on disk is unchanged.";

// The verbs' view of one document on this disk. The server root IS the
// resolution root: every `file` already lives under it, so a reference
// reaching a sibling directory is in scope by definition — and it is passed
// CANONICALIZED, because `resolveInRoot` canonicalizes every `file` it hands
// over. A root reached through a symlink is lexically outside a canonical
// target (macOS: `/var/folders` -> `/private/var/folders`), and mixing the two
// spellings made every cross-document reference in the workspace resolve to
// nothing — on CI, never on Windows.
function ctxFor(root: string): VerbContext {
  return {
    docOpts: (file, r) => docOptsFor(file, r ?? root),
    // A verb's side remarks (`dropped #x`, `3 note blocks`) have no channel
    // across an MCP call: the result carries what the model needs.
    note: () => {},
    files: fsFiles,
  };
}

const fsHost: McpHost = {
  docArg: "path",
  docNote: "",
  unchangedHint: UNCHANGED,
  open(args): OpenedDoc {
    const real = resolveInRoot(args.file);
    const root = rootReal();
    return {
      text: readFileSync(real, "utf8"),
      file: args.file,
      label: real,
      ctx: ctxFor(root),
      validate: { resolveDoc: docResolver(root, real) },
      root,
    };
  },
  write(doc, text, summary) {
    const revision = summary && OPTS.history ? snapshot(doc.label, summary) : undefined;
    writeFileSync(doc.label, text, "utf8");
    return { revision };
  },
  find(args) {
    // `path` goes through the same confinement gate as every other file
    // argument; omitting it searches the root, which is confined by being it.
    const where = args.path === undefined ? OPTS.root : resolveInRoot(args.path);
    const files: string[] = [];
    gemlFilesUnder(where, files, true);
    const hits: FindHit[] = [];
    for (const f of files) {
      let source: string;
      // An unreadable file mid-walk must not abort the search — report nothing
      // for it and keep going, the way every search tool behaves.
      try { source = readFileSync(f, "utf8"); } catch { continue; }
      hits.push(...findInSource(source, f, String(args.pattern), { sensitive: !!args.case, withLine: !!args.head }));
    }
    // Every other tool in this server speaks paths relative to the root, and a
    // model is meant to paste a row's file straight into geml_get — so put the
    // rows in those coordinates, and keep the server's own layout out of the
    // client's view while we are at it. A walked path carries the RAW root
    // spelling when `path` was omitted but resolveInRoot's realpath-anchored one
    // when it was not, and on a symlinked root (macOS /var -> /private/var)
    // those two differ — so strip whichever spelling a row actually carries.
    const bases = [...new Set([resolve(OPTS.root) + sep, realpathSync(OPTS.root) + sep])];
    return hits.map((h) => {
      const b = bases.find((x) => h.file.startsWith(x));
      return b ? { ...h, file: h.file.slice(b.length).replace(/\\/g, "/") } : h;
    });
  },
  checkOpts(doc, root) {
    return { resolveDoc: docResolver(resolveRoot(root === undefined ? undefined : String(root)), doc.label) };
  },
  history(doc) {
    const historyPath = doc.label.replace(/\.geml$/, "") + ".gemlhistory";
    return {
      exists: () => existsSync(historyPath),
      list: () => listRevisions(historyPath),
      // resolveContent() is the CLI's own path for `geml history get <file>
      // <rev>`, so one selector grammar answers on both surfaces.
      resolve: (rev) => resolveContent(historyPath, rev),
      reader: {
        resolve: (sel) => resolveContent(historyPath, sel),
        firstChanged: (current, pick) => firstChangedContent(historyPath, current, pick),
      },
      historyError: (e) => historyError(e, doc.label, historyPath),
    };
  },
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** The eleven document tools, bound to the disk host. */
export const TOOLS: Tool[] = toolsFor(fsHost);

// The four read-only code-graph tools, re-served here with this
// server's confinement. Empty until `loadGraphTools()` runs — the import is
// dynamic because `codemap/mcp-server.mjs` is a plain .mjs script that itself
// top-level-awaits the parser, and because a server started without a graph
// should not pay for loading it at all.
let GRAPH_TOOLS: Tool[] = [];

/** Tools served right now: the eleven document tools, plus the graph tools when a graph is configured. */
export function allTools(): Tool[] {
  return OPTS.graph ? [...TOOLS, ...GRAPH_TOOLS] : TOOLS;
}

// The upstream `graph_dir` description advertises `$GEML_GRAPH_DIR or
// ./.geml/codemap`, neither of which applies here — the env var is bypassed
// (we always pass a resolved directory) and the default is this server's
// --graph. A tool description that names something the server will refuse is
// the exact failure `eb7390a` fixed for `latest`, so rewrite it rather than
// re-serve it.
function confineSchema(schema: any): unknown {
  const props = schema?.properties;
  if (!props?.graph_dir) return schema;
  return {
    ...schema,
    properties: {
      ...props,
      graph_dir: {
        type: "string",
        description:
          "Code-graph directory, relative to the server's --root (defaults to the server's --graph). Paths outside --root are refused.",
      },
    },
  };
}

/**
 * Load and confine the code-graph tools. Idempotent; awaited at startup and by
 * the suite, which drives `handleLine` in-process.
 */
export async function loadGraphTools(): Promise<Tool[]> {
  if (GRAPH_TOOLS.length) return GRAPH_TOOLS;
  // Non-literal specifier on purpose: this resolves at RUNTIME from dist/ to
  // the sibling codemap/ directory (both are shipped), and it keeps tsc from
  // demanding types for an untyped .mjs script.
  const spec = new URL("../codemap/mcp-server.mjs", import.meta.url).href;
  const mod: any = await import(spec);
  // `geml_codemap_node(source: true)` reads the real sources, and WHERE those
  // are comes from `_index/refresh.json` inside the graph — data this server
  // did not choose. Bound it to --root like every other path, so a hand-edited
  // recipe cannot point the reader out of the tree the operator opened.
  mod.confineSourceTo(OPTS.root);
  GRAPH_TOOLS = (mod.TOOLS as any[]).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: confineSchema(t.inputSchema),
    // Resolve the directory HERE, then hand the tool an absolute path: its own
    // `graphDirOf` prefers an explicit `graph_dir`, so this shuts out both the
    // env var and the relative default without touching that file.
    run: (args: Record<string, any>) => t.run({ ...args, graph_dir: resolveGraphDir(args.graph_dir) }),
  }));
  return GRAPH_TOOLS;
}

// ---------------------------------------------------------------------------
// newline-delimited JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

const handle = createHandler(allTools);

export function handleLine(line: string, write: (s: string) => void = (s) => process.stdout.write(s)): void {
  handle(line, write);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export const MCP_USAGE = `usage: geml mcp --root <dir> [--graph <dir>] [--no-history]

  Serve GEML document CRUD over the MCP stdio transport (JSON-RPC 2.0), plus the
  read-only code-graph tools when the root holds a code graph.

  --root <dir>        REQUIRED. Root directory holding the .geml documents.
                      Relative paths resolve against the server process's CWD,
                      which the CLIENT chooses — pass an absolute path.
                      Every path a client names is confined to this directory;
                      a client cannot widen or override it.
  --graph <dir>       Code-graph directory, inside --root. Defaults to
                      <root>/.geml/codemap when that holds an index.geml.
                      With no graph, the code-graph tools are not served
                      at all (a client sees only the document tools).
  --no-history        Do not save a .gemlhistory revision before each
                      write. Default is to save one, so geml_revert always
                      has a revision to undo to.

  Register with a client:
    claude mcp add geml -- geml mcp --root /abs/path/to/repo`;

export function parseArgs(args: string[]): McpOptions {
  let root: string | undefined;
  let graph: string | undefined;
  let history = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--root" || a === "-r") root = args[++i];
    else if (a.startsWith("--root=")) root = a.slice("--root=".length);
    else if (a === "--graph") graph = args[++i];
    else if (a.startsWith("--graph=")) graph = a.slice("--graph=".length);
    else if (a === "--no-history") history = false;
    // The flag used to be --workspace/-w. Name the replacement instead of
    // failing with a bare `unknown option`: this runs inside a client's server
    // config, where the only thing the user sees is that the server did not
    // start, and guessing from `unknown option '--workspace'` is a bad evening.
    else if (a === "--workspace" || a === "-w" || a.startsWith("--workspace=")) {
      throw new Error("--workspace is now --root (same meaning: the one directory the server may read and write)");
    }
    else throw new Error(`unknown option '${a}'`);
  }
  if (!root) throw new Error("--root <dir> is required (the one directory the server may read and write)");
  // Relative paths resolve against THIS process's cwd, which an MCP client
  // picks — so they work from a shell and are a coin flip from a client config.
  const abs = resolve(root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`--root is not a directory: ${root}`);
  const realRoot = realpathSync(abs);
  return { root: realRoot, history, graph: resolveGraphOpt(realRoot, graph) };
}

// An EXPLICIT --graph is trusted to be a graph (the operator said so) and only
// has to exist inside the root — failing fast beats starting a server whose
// graph tools all error. The IMPLICIT default has to be sure it found one, so
// it requires an index.geml: an unrelated `.geml/codemap` directory must not
// make three broken tools appear.
function resolveGraphOpt(realRoot: string, graph: string | undefined): string | undefined {
  if (graph === undefined || graph === "") {
    const guess = resolve(realRoot, ".geml/codemap");
    return existsSync(resolve(guess, "index.geml")) ? realpathSync(guess) : undefined;
  }
  const abs = resolve(realRoot, graph);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`--graph is not a directory: ${graph}`);
  const real = realpathSync(abs);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`--graph must live inside --root: ${graph}`);
  return real;
}

// Auto-run only as a MAIN module: the CLI dispatcher spawns this file as a
// child's entry script, while an in-process `import` (the test suite) stays inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(MCP_USAGE);
    process.exit(0);
  }
  try {
    configure(parseArgs(args));
  } catch (e) {
    console.error(`geml mcp: ${(e as Error).message}\n\n${MCP_USAGE}`);
    process.exit(2);
  }
  // Load the graph tools BEFORE the first frame can arrive: `tools/list` is
  // synchronous, so a client that lists during the load would be told the
  // server has no code graph and would never ask again.
  if (OPTS.graph) await loadGraphTools();
  createInterface({ input: process.stdin }).on("line", (line) => handleLine(line));
}
