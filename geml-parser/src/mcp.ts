#!/usr/bin/env node
// `geml mcp` — MCP server for GEML documents and the code graph.
//
// Eleven tools over a confined root directory of `.geml` documents: six
// read-only, five that write, each named after the CLI verb it wraps (`geml set`
// -> `geml_set`, the bare transform entry -> `geml_to`). When that root holds a code graph, the four read-only
// code-graph tools from `codemap/mcp-server.mjs` are served from this SAME
// process, so a client registers one server instead of two. That file stays a
// standalone `geml codemap mcp` entry point; this one imports its tool table
// rather than copying it, which is cheap because the two were deliberately
// built to the same shape (newline-delimited JSON-RPC 2.0 over stdio, zero
// dependencies, an exported `handleLine` so the suite can drive it in-process).
//
//   claude mcp add geml -- geml mcp --root /abs/path/to/repo
//
// Three invariants make this worth more than letting a model `str_replace` the
// file itself:
//
//   1. A WRITE IS VALIDATED BEFORE IT REACHES DISK. Every mutation is first
//      run to stdout (`geml <op> … -o -`), the RESULT is parsed, and the file
//      is only overwritten when the result is clean. A bad generation is
//      refused with the diagnostics that refused it — it does not land and
//      then wait for a human to notice.
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
//
// The mutations run through the CLI rather than re-implementing block editing:
// the tool table is *defined* as CLI equivalences, and `-o -` already yields
// the mutated document without touching the file — exactly the "produce, then
// validate, then save" order invariant 1 needs.
import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { type Diagnostic, parse, PARSER_VERSION } from "./geml.js";
import { save, listRevisions, isCurrent, resolveContent } from "./history.js";

// One version for the whole package: `geml --version` and the MCP handshake
// must not disagree. This used to be its own literal and had drifted to 0.1.0
// against a 1.4.x package — invisible to everyone except the user reading their
// client's server list.
const SERVER_VERSION = PARSER_VERSION;

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

// ---------------------------------------------------------------------------
// Driving the CLI
// ---------------------------------------------------------------------------

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "geml.js");

interface CliRun { ok: boolean; stdout: string; stderr: string }

// Verbs whose cross-document reference resolution takes a root. The write ones
// matter most: a write is refused when the result would not parse, so without a
// root the guard reads its own blind spot as breakage and a document whose
// `../sibling.md` links only resolve from the server root cannot be edited at
// all. The server has always known that root and simply never handed it over.
// NOT `find`: it searches block CONTENT and resolves no references, while its
// positionals are the places to look — a stray `--root` reads as one more of
// them, widening the very search the caller narrowed. A test caught exactly
// that when this list was written without the exception.
const ROOT_VERBS = new Set([
  "get", "list", "check", "set", "replace", "add", "delete", "rename", "revert",
]);

// The server root as the filesystem really spells it. Falls back to the stored
// value when it cannot be canonicalized: an unusable root is the caller's
// problem to hear about from the verb, not something to throw from here.
function rootReal(): string {
  try { return realpathSync(OPTS.root); } catch { return OPTS.root; }
}

function runCli(args: string[], input?: string): CliRun {
  // The server root IS the resolution root: every `file` already lives under it,
  // so a reference reaching a sibling directory is in scope by definition.
  if (ROOT_VERBS.has(args[0] ?? "") && !args.includes("--root")) {
    // CANONICALIZED, because `resolveInRoot` already canonicalizes every `file`
    // it hands over. Passing the root raw mixes the two: the CLI's cheap lexical
    // gate compares the reference's absolute path against the root with
    // `relative()`, and a root reached through a symlink is lexically outside a
    // canonical target, so every cross-document reference in the workspace
    // resolves to nothing. On macOS that is the default state of affairs —
    // `os.tmpdir()` is `/var/folders/…`, a symlink to `/private/var/folders/…`
    // — which is why this passed on Windows and failed in CI.
    args = [...args, "--root", rootReal()];
  }
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
// The write pipeline: produce -> validate -> save -> write
// ---------------------------------------------------------------------------

// `dangling` marks the tools for which a reference left pointing at nothing is
// reported but not blocking. Deleting a referenced block is a legitimate,
// deliberate act (the CLI documents it as "a warning, not a refusal") — the
// caller is told what broke and decides. Every OTHER new error blocks the write.
interface WriteSpec {
  file: string;
  cliArgs: string[];      // an `-o -` invocation: mutate to stdout, touch nothing
  input?: string;
  summary: string;        // history summary for the saved PRE-write state
  danglingIsWarning?: boolean;
}

function applyWrite(spec: WriteSpec): WriteResult {
  const real = resolveInRoot(spec.file);
  const before = readFileSync(real, "utf8");

  const root = realpathSync(OPTS.root);
  const errorKey = (d: Diagnostic) => `${d.code}:${d.message}`;
  const preexisting = new Set(
    parse(before, { resolveDoc: docResolver(root, real) }).diagnostics
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
  const diags = parse(after, { resolveDoc: docResolver(root, real) }).diagnostics;
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

  // 3. Save the PRE-write state so this edit is revertible, then write.
  const revision = spec.summary && OPTS.history ? snapshot(real, spec.summary) : undefined;
  writeFileSync(real, after, "utf8");
  return { ok: true, file: spec.file, diagnostics: diags, revision };
}

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

const hashId = (id: string) => (id.startsWith("#") ? id : `#${id}`);

// `geml get`/`geml set` take a full block SELECTOR, not only an id: a content
// address reaches a block the author never named, which is the whole point of
// `geml_list` now reporting one for those. So a value that is ALREADY a
// selector must pass through untouched — hashId would turn `@a3f9c1d2` into
// `#@a3f9c1d2` and address nothing. A bare word is still an id, so the
// long-standing "id with or without #" contract is unchanged.
//
// The parameter is still NAMED `id`: renaming it to `selector` would break
// every registered client for a cosmetic gain, and both design docs park that
// rename as a follow-up. The other verbs keep hashId — their CLI counterparts
// (add/delete/rename/revert) take ids only, so accepting a selector here would
// promise something the CLI would then refuse.
// A selector starts with `#` (id or heading line), `@` (content address), or a
// `=` fence run (type filter). Anything else is a bare id.
const selectorArg = (s: string) => (/^([#@]|={3,})/.test(s.trim()) ? s.trim() : `#${s}`);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  run: (args: Record<string, any>) => unknown;
}

const FILE_ARG = { type: "string", description: "Document path relative to the server's --root directory, e.g. notes/spec.geml" };

export const TOOLS: Tool[] = [
  // ----- read -----
  {
    name: "geml_list",
    description:
      "List every addressable block in a GEML document: its address, kind, and heading text. Call this FIRST — the `id` values it returns are what every other tool in this server addresses. Cheaper and more reliable than reading the file to find out what is in it. Rows marked `anon` have no `#id` (their `address` is a type or content address the CLI understands); this server's other tools take an `id`, so give such a block an id before addressing it here.",
    inputSchema: { type: "object", properties: { file: FILE_ARG }, required: ["file"] },
    run: (args) => {
      const real = resolveInRoot(args.file);
      const run = runCli(["get", real, "--json"]);
      if (!run.ok) throw new Error(run.stderr || "could not list ids");
      return run.stdout.trim();
    },
  },
  {
    name: "geml_find",
    description:
      "Search block CONTENT across the served documents and get back ADDRESSES, one row of `<file>\\t<address>` per hit. This is the other half of geml_list: `list` says what a document contains, `find` says which block holds the words you are looking for — and it answers with an address that pastes straight into geml_get or geml_set, never a line number that the next edit invalidates. The address is the innermost block holding the match, and a block that matches on many lines is reported once. Substring, case-insensitive unless `case` is true. Omit `path` to search every `*.geml` under the server root, or give a file or directory to narrow it — a file you name is searched whatever its extension, Markdown included, while a directory walks `*.geml` only. No match is not an error: the result is empty.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text to look for inside block bodies" },
        path: { type: "string", description: "Optional file or directory under the server root; default: the whole root" },
        case: { type: "boolean", description: "Match case exactly (default: case-insensitive)" },
        head: { type: "boolean", description: "Add the matching line as a third column" },
      },
      required: ["pattern"],
    },
    run: (args) => {
      if (typeof args.pattern !== "string" || args.pattern === "") throw new Error("`pattern` is required");
      // `path` goes through the same confinement gate as every other file
      // argument; omitting it searches the root, which is confined by being it.
      const where = args.path === undefined ? OPTS.root : resolveInRoot(args.path);
      const flags = [...(args.case ? ["--case"] : []), ...(args.head ? ["--head"] : [])];
      const run = runCli(["find", args.pattern, where, ...flags]);
      // Exit 1 means "nothing matched" — a result, not a failure. Anything on
      // stderr is the real error case.
      if (!run.ok && run.stderr) throw new Error(run.stderr);
      // The CLI prints the path it was given. Every other tool in this server
      // speaks paths relative to the root, and a model is meant to paste a
      // row's file straight into geml_get — so put the rows in those
      // coordinates, and keep the server's own layout out of the client's
      // view while we are at it. The given path carries the RAW root spelling
      // when `path` was omitted but resolveInRoot's realpath-anchored one when
      // it was not, and on a symlinked root (macOS /var -> /private/var) those
      // two differ — so strip whichever spelling a row actually carries.
      const bases = [...new Set([resolve(OPTS.root) + sep, realpathSync(OPTS.root) + sep])];
      return run.stdout
        .split("\n")
        .map((line) => {
          const b = bases.find((x) => line.startsWith(x));
          return b ? line.slice(b.length).replace(/\\/g, "/") : line;
        })
        .join("\n")
        .trim();
    },
  },
  {
    name: "geml_get",
    description:
      "Read ONE block from a GEML document. Use this instead of reading the whole file: it returns only that block, typically a few percent of the document. Call `geml_list` first and pass back the `address` it gives — that also reaches blocks with no `#id`, which an id alone cannot.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        id: {
          type: "string",
          description: "What to read: a block id (with or without `#`), a `## Heading` line (its whole section), `=== type` for every block of a type, a `@<hex>` content address for a block with no id, or `L27`/`L27-58` for the smallest block holding those lines — the forms `geml_list` prints, plus the line numbers an editor or a diff hunk speaks",
        },
        view: {
          type: "boolean",
          description: "Read THROUGH an `embed` block to the entity block it stands for, following a multi-layer chain to its end. An `embed` has no content of its own, so this is the only way to see what it points at; on any other block it changes nothing. Returns {from, content}: `from` names the document the content actually came from, and its references and relative paths resolve against THAT document, not this one.",
        },
        part: {
          type: "string",
          enum: ["whole", "head", "intro", "body"],
          description: "How much of the block to return (default: whole). For a SECTION these cut it three ways: `head` is the heading line, `intro` everything under it up to its first subheading, `body` everything under it — so `body` always contains `intro`, and equals it when the section has no subheading. Reach for `intro` to read a section's opening without pulling its subsections into the conversation; a whole `#id` on a top-level heading is often the entire document. Only a heading has an intro. `body` is usually what you want together with `view`.",
        },
      },
      required: ["file", "id"],
    },
    run: (args) => {
      const real = resolveInRoot(args.file);
      const sel = selectorArg(args.id);
      // Same name, same enum, same validation as `geml_set` — one concept for a
      // model to learn, and `body` is already taken there for the replacement text.
      const part = args.part ?? "whole";
      if (!["whole", "head", "body"].includes(part)) throw new Error(`part must be whole|head|body, got \`${part}\``);
      const flag = part === "head" ? ["--head"] : part === "body" ? ["--body"] : [];
      const run = runCli(["get", real, sel, ...flag, ...(args.view ? ["--view"] : [])]);
      if (!run.ok) throw new Error(run.stderr || `nothing matches ${sel}`);
      if (!args.view) return run.stdout;
      // There is no stderr across an MCP call, and provenance is mandatory: lift
      // it out of the CLI's pinned `view: <sel> -> <doc>[#<id>]` line into a
      // field of its own.
      const m = /^view: .*? -> (.+)$/m.exec(run.stderr);
      return { from: m ? m[1]!.trim() : null, content: run.stdout };
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
        root: { type: "string", description: "Directory (inside the server root) against which cross-document references resolve. Defaults to the server root itself. This is a REFERENCE root and is distinct from the server's own --root sandbox, which it can only narrow." },
      },
      required: ["file"],
    },
    run: (args) => {
      const real = resolveInRoot(args.file);
      const root = resolveRoot(args.root);
      const doc = parse(readFileSync(real, "utf8"), { resolveDoc: docResolver(root, real) });
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
    name: "geml_history",
    // The name mirrors the CLI COMMAND PATH (`geml history`), not a verb: this
    // group's only read verb is `get`, and it is the only one that belongs on a
    // server an agent drives (`save` would insert hand-made revisions between
    // the automatic pre-write ones, and `restore` rewrites a whole file where
    // the agent already has block-level geml_revert). So there will be no second
    // history tool to disambiguate from, and `_get` would be a suffix that
    // distinguishes nothing — design §5.
    description:
      "Read a document's recorded history. WITHOUT `rev`: list every revision, newest first — each entry's `offset` is the selector `geml_revert` takes as `rev` (-1 is the revision before the current one), and an empty list means the document has no sidecar yet and nothing can be reverted. WITH `rev`: the full text of that one revision, for reading what the document looked like then without restoring it.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        rev: { type: "string", description: "Revision selector — `0` for the current tip, `-N` for N revisions back, or a revision id from the list. Omit it to get the list instead of one revision's text." },
      },
      required: ["file"],
    },
    run: (args) => {
      const real = resolveInRoot(args.file);
      const historyPath = real.replace(/\.geml$/, "") + ".gemlhistory";
      const rev = args.rev === undefined ? undefined : String(args.rev);
      if (!existsSync(historyPath)) {
        // Naming a revision of a document that has no history at all is an
        // error, not an empty result: the caller asked for specific content.
        // The LIST tier stays a plain empty answer — "nothing yet" is a real,
        // useful state there.
        if (rev !== undefined) throw new Error(`no .gemlhistory sidecar for ${args.file} yet, so revision ${rev} does not exist — the first write through this server creates one`);
        return { file: args.file, revisions: [], note: "no .gemlhistory sidecar yet — the first write through this server creates one" };
      }
      if (rev === undefined) return { file: args.file, revisions: listRevisions(historyPath) };
      // resolveContent() is the CLI's own path for `geml history get <file>
      // <rev>`, so one selector grammar answers on both surfaces.
      const { id, text } = resolveContent(historyPath, rev);
      return { file: args.file, id, text };
    },
  },
  {
    name: "geml_to",
    description:
      "Convert a WHOLE document and get the result back as text — the read half of the CLI's `geml <file> --to <fmt>`. `to: \"geml\"` on a Markdown file is the importer, the one thing the block tools cannot do; `to: \"md\"` projects a GEML document out (lossy); `to: \"json\"` returns the full document model, for when geml_list plus geml_get is not enough. Nothing is written — pass the result to geml_add or geml_set to land it. `to: \"html\"` also works but returns a whole self-contained page, usually tens of kilobytes this server cannot save for you: prefer the CLI (`geml <file> --to html -o out.html`) unless you really want the markup in the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        to: {
          type: "string",
          enum: ["json", "md", "geml", "html"],
          description: "Target format. Default is the CLI's: a GEML input becomes json, a Markdown input becomes geml. `html` is a whole page — large, and not writable from here.",
        },
        from: {
          type: "string",
          enum: ["geml", "md", "json"],
          description: "Override the input format, which is otherwise inferred from the extension (.md -> md, .json -> json, else geml).",
        },
      },
      required: ["file"],
    },
    run: (args) => {
      const real = resolveInRoot(args.file);
      // Enforce the enums here too: a client is free to ignore the schema, and a
      // typo'd format should come back as this server's clear error rather than
      // whatever the CLI makes of it.
      const to = args.to === undefined ? undefined : String(args.to);
      const from = args.from === undefined ? undefined : String(args.from);
      if (to !== undefined && !["json", "md", "geml", "html"].includes(to)) throw new Error(`unknown \`to\` format: ${to} (want json | md | geml | html)`);
      if (from !== undefined && !["geml", "md", "json"].includes(from)) throw new Error(`unknown \`from\` format: ${from} (want geml | md | json)`);
      const argv = [real];
      if (to !== undefined) argv.push("--to", to);
      if (from !== undefined) argv.push("--from", from);
      const run = runCli(argv);
      // The transform exits 1 on a document with errors but still prints the
      // result; surface the diagnostics rather than the text in that case, so a
      // model is never handed the output of a document it was told nothing about.
      if (!run.ok) throw new Error(run.stderr || `could not convert ${args.file}`);
      return run.stdout;
    },
  },

  // ----- write -----
  {
    name: "geml_set",
    description:
      "Replace ONE block, leaving every other byte of the document untouched. Prefer this over rewriting a file. The replacement is VALIDATED BEFORE it is written: if it would break the document, nothing is written and you get the diagnostics back — re-read them and fix the body rather than retrying the same content. Breaking the document is what gets refused — removing content is not: if your replacement drops blocks, the write goes through and the result names every block that went, unnamed ones included, so check that line whenever you shortened a section. `geml_revert` puts one back. The way to keep a block is to keep it in the text you send; `geml_get` on the same address just handed it to you. `part` selects whole block (default), the head/fence line, a section's `intro`, or the body. An address matching SEVERAL blocks is refused — this writes one block, so narrow it first.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        id: {
          type: "string",
          description: "Which block to replace: an id (with or without `#`), or a `@<hex>` content address from `geml_list` for a block with no id. Must match exactly one block",
        },
        body: { type: "string", description: "The replacement text" },
        part: { type: "string", enum: ["whole", "head", "intro", "body"], description: "What to replace (default: whole). `intro` replaces a section's opening — everything under the heading up to its first subheading — and leaves every subsection byte-identical, which is what makes a read-edit-write cycle on a long section safe. An empty intro (a subheading follows the heading immediately) is written into, so this also adds an opening where there was none." },
      },
      required: ["file", "id", "body"],
    },
    run: (args) => {
      const real = resolveInRoot(args.file);
      const part = args.part ?? "whole";
      if (!["whole", "head", "body"].includes(part)) throw new Error(`part must be whole|head|body, got \`${part}\``);
      const flag = part === "head" ? ["--head"] : part === "body" ? ["--body"] : [];
      return applyWrite({
        file: args.file,
        cliArgs: ["set", real, selectorArg(args.id), ...flag, "--in", "-", "-o", "-"],
        input: args.body,
        summary: `mcp: before write to ${selectorArg(args.id)}`,
      });
    },
  },
  {
    name: "geml_add",
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
      const real = resolveInRoot(args.file);
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
    name: "geml_delete",
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
      const real = resolveInRoot(args.file);
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
    name: "geml_rename",
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
      const real = resolveInRoot(args.file);
      return applyWrite({
        file: args.file,
        cliArgs: ["rename", real, hashId(args.old), hashId(args.new), "-o", "-"],
        summary: `mcp: before rename ${hashId(args.old)} -> ${hashId(args.new)}`,
      });
    },
  },
  {
    name: "geml_revert",
    description:
      "Undo ONE block, leaving every other block byte-for-byte unchanged — recover a single block after a bad edit without losing the good edits around it. `rev` defaults to undoing this block's LAST change (its previous distinct version), which holds even when other blocks were edited afterwards; or pass `0` for the tip, a `-N` offset, or a revision id from `geml_history`. Reverting across a revision where the block was deleted restores it; across one where it did not exist removes it.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_ARG,
        id: { type: "string", description: "Block id to revert" },
        rev: { type: "string", description: "Revision selector: 0 (the tip) | -N (N revisions back) | id prefix. Omit to undo this block's last change (robust to edits of other blocks since)." },
      },
      required: ["file", "id"],
    },
    run: (args) => {
      const real = resolveInRoot(args.file);
      // Default to `--rev changed`, NOT the tip (`0`) or the CLI's own `-1`. Each
      // write commits the PRE-write state, so the tip undoes the block only when
      // it was the MOST RECENT write — a later write to ANOTHER block moves the
      // tip, and the revert then silently degrades to a no-op (ok:true, nothing
      // undone). `changed` walks back to THIS block's previous distinct version,
      // so it undoes the block's last edit regardless of intervening writes.
      const sel = ["--rev", args.rev ? String(args.rev) : "changed"];
      return applyWrite({
        file: args.file,
        cliArgs: ["revert", real, hashId(args.id), ...sel, "-o", "-"],
        summary: `mcp: before revert ${hashId(args.id)}`,
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Code-graph tools, imported from the standalone server
// ---------------------------------------------------------------------------

// The four read-only code-graph tools, re-served here with this
// server's confinement. Empty until `loadGraphTools()` runs — the import is
// dynamic because `codemap/mcp-server.mjs` is a plain .mjs script that itself
// top-level-awaits the parser, and because a server started without a graph
// should not pay for loading it at all.
let GRAPH_TOOLS: Tool[] = [];

/** Tools served right now: the ten document tools, plus the graph tools when a graph is configured. */
export function allTools(): Tool[] {
  return OPTS.graph ? [...TOOLS, ...GRAPH_TOOLS] : TOOLS;
}

// The upstream `graph_dir` description advertises `$GEML_GRAPH_DIR or
// ./.geml-code-graph`, neither of which applies here — the env var is bypassed
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
        serverInfo: { name: "geml", version: SERVER_VERSION },
      });
    } else if (method?.startsWith("notifications/")) {
      // notifications get no response
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: allTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    } else if (method === "tools/call") {
      const tool = allTools().find((t) => t.name === params?.name);
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

export const MCP_USAGE = `usage: geml mcp --root <dir> [--graph <dir>] [--no-history]

  Serve GEML document CRUD over the MCP stdio transport (JSON-RPC 2.0), plus the
  read-only code-graph tools when the root holds a code graph.

  --root <dir>        REQUIRED. Root directory holding the .geml documents.
                      Relative paths resolve against the server process's CWD,
                      which the CLIENT chooses — pass an absolute path.
                      Every path a client names is confined to this directory;
                      a client cannot widen or override it.
  --graph <dir>       Code-graph directory, inside --root. Defaults to
                      <root>/.geml-code-graph when that holds an index.geml.
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
// it requires an index.geml: an unrelated `.geml-code-graph` directory must not
// make three broken tools appear.
function resolveGraphOpt(realRoot: string, graph: string | undefined): string | undefined {
  if (graph === undefined || graph === "") {
    const guess = resolve(realRoot, ".geml-code-graph");
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
