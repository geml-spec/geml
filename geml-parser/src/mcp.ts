#!/usr/bin/env node
// `geml mcp` — MCP server for GEML document CRUD.
//
// Nine tools over a confined workspace of `.geml` documents: four read-only,
// five that write. It is the document-editing counterpart to the read-only
// code-graph server in `codemap/mcp-server.mjs`, and deliberately mirrors its
// shape (newline-delimited JSON-RPC 2.0 over stdio, zero dependencies, an
// exported `handleLine` so the suite can drive it in-process).
//
//   claude mcp add geml-docs -- geml mcp --workspace /abs/path/to/docs
//
// Three invariants make this worth more than letting a model `str_replace` the
// file itself:
//
//   1. A WRITE IS VALIDATED BEFORE IT REACHES DISK. Every mutation is first
//      run to stdout (`geml <op> … -o -`), the RESULT is parsed, and the file
//      is only overwritten when the result is clean. A bad generation is
//      refused with the diagnostics that refused it — it does not land and
//      then wait for a human to notice.
//   2. EVERY WRITE IS PRECEDED BY A HISTORY COMMIT, so `geml_revert_block` can
//      always undo the block that was just touched. Without this the strongest
//      tool in the set would have nothing to revert to.
//   3. EVERY PATH IS CONFINED to a server-side `--workspace` root the client
//      cannot override or widen.
//
// The mutations run through the CLI rather than re-implementing block editing:
// the tool table is *defined* as CLI equivalences, and `-o -` already yields
// the mutated document without touching the file — exactly the "produce, then
// validate, then commit" order invariant 1 needs.
import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { type Diagnostic, parse } from "./geml.js";
import { commit, listRevisions, isCurrent } from "./history.js";

const SERVER_VERSION = "0.1.0";

export interface McpOptions {
  workspace: string;  // absolute, canonicalized root; every `file` lives under it
  history: boolean;   // auto-commit before each write (default true)
}

let OPTS: McpOptions = { workspace: process.cwd(), history: true };

/** Configure the server. Exported so the suite can point it at a temp dir. */
export function configure(o: Partial<McpOptions>): McpOptions {
  OPTS = { ...OPTS, ...o };
  return OPTS;
}

// ---------------------------------------------------------------------------
// Workspace confinement
// ---------------------------------------------------------------------------

// `file` is client-supplied, so `../../../etc/passwd` — or a symlink planted
// inside the workspace that points out of it — must not resolve. Canonicalize
// BOTH sides with realpathSync (which follows every link component) and require
// the real target to sit at or under the real root. Unlike the code-graph
// server, whose `graph_dir` is intentionally client-chosen, the root here is
// fixed by the operator at startup: this server WRITES, so a client that could
// name its own root could write anywhere.
export function resolveInWorkspace(file: string): string {
  if (typeof file !== "string" || file === "") throw new Error("`file` is required");
  const root = realpathSync(OPTS.workspace);
  const target = resolve(root, file);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error(`no such file in the workspace: ${file}`);
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`path escapes the workspace: ${file}`);
  }
  if (!statSync(real).isFile()) throw new Error(`not a file: ${file}`);
  return real;
}

// Cross-document references resolve against the workspace root, never against
// a client-named directory: `root` may only NARROW to a directory inside it.
function resolveRoot(root: string | undefined): string {
  const ws = realpathSync(OPTS.workspace);
  if (root === undefined || root === "") return ws;
  const target = resolve(ws, root);
  let real: string;
  try { real = realpathSync(target); } catch { throw new Error(`no such directory in the workspace: ${root}`); }
  if (real !== ws && !real.startsWith(ws + sep)) throw new Error(`root escapes the workspace: ${root}`);
  return real;
}

// ---------------------------------------------------------------------------
// Driving the CLI
// ---------------------------------------------------------------------------

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "geml.js");

interface CliRun { ok: boolean; stdout: string; stderr: string }

function runCli(args: string[], input?: string): CliRun {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: input ?? "",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`cannot run the geml CLI: ${r.error.message}`);
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").trim() };
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

// A refusal tells the model, in so many words, that the file did not change.
// Without that sentence a model reads "error" and still assumes its edit landed.
const UNCHANGED = "The write was refused; the file on disk is unchanged.";

interface WriteResult {
  ok: boolean;
  file: string;
  diagnostics: Diagnostic[];
  hint?: string;
  revision?: string;
}

function refuse(file: string, diagnostics: Diagnostic[], hint = UNCHANGED): WriteResult {
  return { ok: false, file, diagnostics, hint };
}

// The CLI's `--json` refusal: {error, code, diagnostics?}. A usage error (bad
// id, prose where a block was wanted) carries no diagnostics — it never got as
// far as parsing a candidate — so the message alone is the whole answer.
function parseRefusal(stderr: string): { message: string; diagnostics: Diagnostic[] } {
  for (const line of stderr.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      if (typeof j?.error === "string") {
        return { message: j.error, diagnostics: Array.isArray(j.diagnostics) ? j.diagnostics : [] };
      }
    } catch { /* not the JSON frame; keep looking */ }
  }
  return { message: stderr || "the operation was refused", diagnostics: [] };
}

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 1));

// ---------------------------------------------------------------------------
// The write pipeline: produce -> validate -> commit -> write
// ---------------------------------------------------------------------------

// `dangling` marks the tools for which a reference left pointing at nothing is
// reported but not blocking. Deleting a referenced block is a legitimate,
// deliberate act (the CLI documents it as "a warning, not a refusal") — the
// caller is told what broke and decides. Every OTHER new error blocks the write.
interface WriteSpec {
  file: string;
  cliArgs: string[];      // an `-o -` invocation: mutate to stdout, touch nothing
  input?: string;
  summary: string;        // history commit message for the PRE-write state
  danglingIsWarning?: boolean;
}

function applyWrite(spec: WriteSpec): WriteResult {
  const real = resolveInWorkspace(spec.file);
  const before = readFileSync(real, "utf8");

  const root = realpathSync(OPTS.workspace);
  const errorKey = (d: Diagnostic) => `${d.code}:${d.message}`;
  const preexisting = new Set(
    parse(before, { resolveDoc: docResolver(root) }).diagnostics
      .filter((d) => d.severity === "error")
      .map(errorKey),
  );

  // 1. Produce the mutated document WITHOUT touching the file. `--json` makes
  //    a refusal machine-readable: the CLI runs its pre-write check and reports
  //    every diagnostic with its Appendix A code.
  const run = runCli([...spec.cliArgs, "--json"], spec.input);
  if (!run.ok) {
    const { message, diagnostics } = parseRefusal(run.stderr);
    // A refusal caused ENTIRELY by errors the document already had is worth
    // saying out loud: the model did not break anything, and retrying this
    // edit will keep failing until the pre-existing errors are repaired.
    const stale = diagnostics.length > 0 && diagnostics.every((d) => preexisting.has(errorKey(d)));
    const why = stale
      ? "These errors were ALREADY in the document before this edit — your content did not cause them. Repair them first (geml_check lists them); until then no write to this document can be validated."
      : UNCHANGED;
    return refuse(spec.file, diagnostics, `${message}. ${why}`);
  }
  const after = run.stdout;

  // A CLI that exits 0 having written nothing must never be read as "the new
  // document is empty" — an empty document parses clean, so validation below
  // would wave it through and the write would destroy the file.
  if (before.trim() !== "" && after.trim() === "") {
    return refuse(spec.file, [], `the command produced no output, so nothing was written. ${UNCHANGED}`);
  }

  // 2. Validate the RESULT independently of the CLI. This is what catches the
  //    tools the CLI lets through — deleting a referenced block, above all.
  const diags = parse(after, { resolveDoc: docResolver(root) }).diagnostics;
  let blocking = diags.filter((d) => d.severity === "error" && !preexisting.has(errorKey(d)));
  if (spec.danglingIsWarning) {
    blocking = blocking.filter(
      (d) => d.code !== "unresolved-reference" && d.code !== "unresolved-footnote",
    );
  }
  if (blocking.length) return refuse(spec.file, blocking);

  if (after === before) {
    return { ok: true, file: spec.file, diagnostics: diags, hint: "No change: the document already had this content." };
  }

  // 3. Commit the PRE-write state so this edit is revertible, then write.
  const revision = spec.summary && OPTS.history ? snapshot(real, spec.summary) : undefined;
  writeFileSync(real, after, "utf8");
  return { ok: true, file: spec.file, diagnostics: diags, revision };
}

// Commit the file's CURRENT bytes as a revision, so the about-to-happen write
// has something to revert to. A file already identical to its tip needs no
// second revision.
function snapshot(realPath: string, summary: string): string | undefined {
  const historyPath = realPath.replace(/\.geml$/, "") + ".gemlhistory";
  try {
    if (existsSync(historyPath) && isCurrent(historyPath, realPath)) return undefined;
    return commit({ gemlPath: realPath, historyPath, summary }).id;
  } catch {
    // A sidecar that cannot be written must not cost the caller their edit;
    // the write still proceeds, just without a revert point.
    return undefined;
  }
}

function docResolver(root: string): (doc: string) => string | null {
  return (doc: string) => {
    try {
      const target = realpathSync(resolve(root, doc));
      if (target !== root && !target.startsWith(root + sep)) return null;
      return readFileSync(target, "utf8");
    } catch {
      return null;
    }
  };
}

const hashId = (id: string) => (id.startsWith("#") ? id : `#${id}`);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  run: (args: Record<string, any>) => unknown;
}

const FILE_ARG = { type: "string", description: "Document path relative to the server's --workspace root, e.g. notes/spec.geml" };

export const TOOLS: Tool[] = [
  // ----- read -----
  {
    name: "geml_list_ids",
    description:
      "List every addressable block in a GEML document: its `#id`, kind, and heading text. Call this FIRST — the ids it returns are what every other tool in this server addresses. Cheaper and more reliable than reading the file to find out what is in it.",
    inputSchema: { type: "object", properties: { file: FILE_ARG }, required: ["file"] },
    run: (args) => {
      const real = resolveInWorkspace(args.file);
      const run = runCli(["get", real, "--json"]);
      if (!run.ok) throw new Error(run.stderr || "could not list ids");
      return run.stdout.trim();
    },
  },
  {
    name: "geml_read_block",
    description:
      "Read ONE block from a GEML document by its `#id`. Use this instead of reading the whole file: it returns only that block, typically a few percent of the document. Get available ids from `geml_list_ids` first. Reading the whole file to change one block wastes context and risks modifying unrelated content.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        id: { type: "string", description: "Block id, with or without the leading `#`" },
      },
      required: ["file", "id"],
    },
    run: (args) => {
      const real = resolveInWorkspace(args.file);
      const run = runCli(["get", real, hashId(args.id)]);
      if (!run.ok) throw new Error(run.stderr || `no block with id ${hashId(args.id)}`);
      return run.stdout;
    },
  },
  {
    name: "geml_check",
    description:
      "Validate a GEML document: returns every diagnostic with a stable `code`, a severity, and a line. An empty list means the document is valid. Use this to confirm a document is sound before reporting work as finished — and note that writes through this server are already checked, so a refusal from a write tool is the same information delivered earlier.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        root: { type: "string", description: "Directory (inside the workspace) against which cross-document references resolve. Defaults to the workspace root." },
      },
      required: ["file"],
    },
    run: (args) => {
      const real = resolveInWorkspace(args.file);
      const root = resolveRoot(args.root);
      const doc = parse(readFileSync(real, "utf8"), { resolveDoc: docResolver(root) });
      const errors = doc.diagnostics.filter((d) => d.severity === "error").length;
      return {
        ok: errors === 0,
        file: args.file,
        errors,
        warnings: doc.diagnostics.length - errors,
        diagnostics: doc.diagnostics,
      };
    },
  },
  {
    name: "geml_history_log",
    description:
      "List the recorded revisions of a document, newest first. Each entry's `offset` is the selector `geml_revert_block` takes as `rev` (-1 is the revision before the current one). Use this to find WHICH revision to revert a block to; an empty list means the document has no sidecar yet and nothing can be reverted.",
    inputSchema: { type: "object", properties: { file: FILE_ARG }, required: ["file"] },
    run: (args) => {
      const real = resolveInWorkspace(args.file);
      const historyPath = real.replace(/\.geml$/, "") + ".gemlhistory";
      if (!existsSync(historyPath)) return { file: args.file, revisions: [], note: "no .gemlhistory sidecar yet — the first write through this server creates one" };
      return { file: args.file, revisions: listRevisions(historyPath) };
    },
  },

  // ----- write -----
  {
    name: "geml_write_block",
    description:
      "Replace ONE block, addressed by `#id`, leaving every other byte of the document untouched. Prefer this over rewriting a file. The replacement is VALIDATED BEFORE it is written: if it would break the document, nothing is written and you get the diagnostics back — re-read them and fix the body rather than retrying the same content. `part` selects whole block (default), just the head/fence line, or just the body.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        id: { type: "string", description: "Block id to replace, with or without `#`" },
        body: { type: "string", description: "The replacement text" },
        part: { type: "string", enum: ["whole", "head", "body"], description: "What to replace (default: whole)" },
      },
      required: ["file", "id", "body"],
    },
    run: (args) => {
      const real = resolveInWorkspace(args.file);
      const part = args.part ?? "whole";
      if (!["whole", "head", "body"].includes(part)) throw new Error(`part must be whole|head|body, got \`${part}\``);
      const flag = part === "head" ? ["--head"] : part === "body" ? ["--body"] : [];
      return applyWrite({
        file: args.file,
        cliArgs: ["set", real, hashId(args.id), ...flag, "--in", "-", "-o", "-"],
        input: args.body,
        summary: `mcp: before write to ${hashId(args.id)}`,
      });
    },
  },
  {
    name: "geml_add_block",
    description:
      "Insert new content — one or more blocks, or prose — at a chosen point. `position` is append (end of document), or before/after a block named by `anchor`. Ids inside the content are kept, and a clash with an existing id is refused. Validated before writing, like every write here.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        content: { type: "string", description: "The GEML fragment to insert" },
        position: { type: "string", enum: ["append", "before", "after"], description: "Where to insert" },
        anchor: { type: "string", description: "Block id the insertion is relative to; required for before/after" },
      },
      required: ["file", "content", "position"],
    },
    run: (args) => {
      const real = resolveInWorkspace(args.file);
      let where: string[];
      if (args.position === "append") where = ["--append"];
      else if (args.position === "before" || args.position === "after") {
        if (!args.anchor) throw new Error(`position \`${args.position}\` needs an \`anchor\` block id`);
        where = [`--${args.position}`, hashId(args.anchor)];
      } else throw new Error(`position must be append|before|after, got \`${args.position}\``);
      return applyWrite({
        file: args.file,
        cliArgs: ["add", real, ...where, "--in", "-", "-o", "-"],
        input: args.content,
        summary: `mcp: before insert (${args.position}${args.anchor ? " " + hashId(args.anchor) : ""})`,
      });
    },
  },
  {
    name: "geml_delete_block",
    description:
      "Remove one or more blocks by id. References left pointing at a removed block are reported as diagnostics but do NOT block the deletion — read them and decide whether to repair or restore. A missing id is skipped, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        ids: { type: "array", items: { type: "string" }, description: "Block ids to remove" },
      },
      required: ["file", "ids"],
    },
    run: (args) => {
      const real = resolveInWorkspace(args.file);
      const ids = Array.isArray(args.ids) ? args.ids : [args.ids];
      if (!ids.length) throw new Error("`ids` must name at least one block");
      return applyWrite({
        file: args.file,
        cliArgs: ["delete", real, ...ids.map((i: string) => hashId(i)), "-o", "-"],
        summary: `mcp: before delete ${ids.map((i: string) => hashId(i)).join(" ")}`,
        danglingIsWarning: true,
      });
    },
  },
  {
    name: "geml_rename_id",
    description:
      "Rename a block id AND every reference to it in the same document, in one id-boundary-safe operation. Use this instead of a text search-and-replace, which would also hit ids that merely share a prefix.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        old: { type: "string", description: "Current id" },
        new: { type: "string", description: "New id" },
      },
      required: ["file", "old", "new"],
    },
    run: (args) => {
      const real = resolveInWorkspace(args.file);
      return applyWrite({
        file: args.file,
        cliArgs: ["rename", real, hashId(args.old), hashId(args.new), "-o", "-"],
        summary: `mcp: before rename ${hashId(args.old)} -> ${hashId(args.new)}`,
      });
    },
  },
  {
    name: "geml_revert_block",
    description:
      "Undo ONE block, leaving every other block byte-for-byte unchanged — recover a single block after a bad edit without losing the good edits around it. `rev` defaults to undoing this block's LAST change (its previous distinct version), which holds even when other blocks were edited afterwards; or pass a `-N` offset, `latest`, or a revision id from `geml_history_log`. Reverting across a revision where the block was deleted restores it; across one where it did not exist removes it.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        id: { type: "string", description: "Block id to revert" },
        rev: { type: "string", description: "Revision selector: -N | latest | id prefix. Omit to undo this block's last change (robust to edits of other blocks since)." },
      },
      required: ["file", "id"],
    },
    run: (args) => {
      const real = resolveInWorkspace(args.file);
      // Default to `--changed`, NOT `latest` or the CLI's own `-1`. Each write
      // commits the PRE-write state, so `latest` (the tip) undoes the block only
      // when it was the MOST RECENT write — a later write to ANOTHER block moves
      // the tip, and `latest` then silently degrades to a no-op (ok:true, nothing
      // undone). `--changed` walks back to THIS block's previous distinct version,
      // so it undoes the block's last edit regardless of intervening writes.
      const sel = args.rev ? ["--rev", String(args.rev)] : ["--changed"];
      return applyWrite({
        file: args.file,
        cliArgs: ["revert", real, hashId(args.id), ...sel, "-o", "-"],
        summary: `mcp: before revert ${hashId(args.id)}`,
      });
    },
  },
];

// ---------------------------------------------------------------------------
// newline-delimited JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

export function handleLine(line: string, write: (s: string) => void = (s) => process.stdout.write(s)): void {
  const reply = (id: unknown, result: unknown) => write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const replyError = (id: unknown, code: number, message: string) =>
    write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  line = line.trim();
  if (!line) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "geml-docs", version: SERVER_VERSION },
      });
    } else if (method?.startsWith("notifications/")) {
      // notifications get no response
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    } else if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) { replyError(id, -32602, `unknown tool: ${params?.name}`); return; }
      try {
        const out = tool.run(params?.arguments ?? {});
        // A refused write is a RESULT, not a protocol error: the model must be
        // able to read the diagnostics that refused it.
        const isError = typeof out === "object" && out !== null && (out as WriteResult).ok === false;
        reply(id, { content: [{ type: "text", text: asText(out) }], ...(isError ? { isError: true } : {}) });
      } catch (e) {
        reply(id, { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true });
      }
    } else if (id !== undefined) {
      replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) replyError(id, -32603, String((e as Error)?.message ?? e));
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export const MCP_USAGE = `usage: geml mcp --workspace <dir> [--no-history]

  Serve GEML document CRUD over the MCP stdio transport (JSON-RPC 2.0).

  --workspace <dir>   REQUIRED. Root directory holding the .geml documents.
                      Every path a client names is confined to this directory;
                      a client cannot widen or override it.
  --no-history        Do not auto-commit a .gemlhistory revision before each
                      write. Default is to commit, so geml_revert_block always
                      has a revision to undo to.

  Register with a client:
    claude mcp add geml-docs -- geml mcp --workspace /abs/path/to/docs`;

export function parseArgs(args: string[]): McpOptions {
  let workspace: string | undefined;
  let history = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--workspace" || a === "-w") workspace = args[++i];
    else if (a.startsWith("--workspace=")) workspace = a.slice("--workspace=".length);
    else if (a === "--no-history") history = false;
    else throw new Error(`unknown option '${a}'`);
  }
  if (!workspace) throw new Error("--workspace <dir> is required (the root the server may read and write)");
  const abs = resolve(workspace);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`--workspace is not a directory: ${workspace}`);
  return { workspace: realpathSync(abs), history };
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
  createInterface({ input: process.stdin }).on("line", (line) => handleLine(line));
}
