#!/usr/bin/env node
// The GEML command line. Split out of geml.ts so that file can be what the
// viewer imports: a parser LIBRARY. Everything CLI-side lives here — argv
// dispatch, file and stdin I/O, stdout and the exit codes, spawning
// `codemap`/`mcp`, and `skill install`. The VERBS themselves — what `get`,
// `set`, `add`… do to a document's text — are the pure functions of verbs.ts,
// so the stdio MCP server (and any other host) runs the same code in-process
// instead of driving this program. The browser bundle never reaches this
// module, so a new node:* import here can no longer break the extension build
// (it did three times in one day: node:os for homedir, pageAssets, renameSync).

import { readFileSync, writeFileSync, realpathSync, statSync, existsSync, mkdirSync, readdirSync, copyFileSync, renameSync } from "node:fs";
import { loadStylesheet, resolveStyle } from "./style-resolve.js";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  type Diagnostic, type UnitPart,
  PARSER_VERSION, VERSION, parse, historyPathFor, sliceUnit,
} from "./geml.js";
import { parseSelector } from "./selector.js";
import { parseAttrs } from "./attrs.js";
import { save, restore, verify, isCurrent, listRevisions, resolveContent, firstChangedContent } from "./history.js";
import {
  type Content, type DocOpts, type FindHit, type HistoryReader, type InFmt, type OutFmt, type VerbContext,
  VerbError, add, check, del, findInSource, formatFindRows, get, list, rename, replace, reportMatches,
  revert, selectUnits, set, transform, unitNode,
} from "./verbs.js";
import { docOptsFor, fsFiles, gemlFilesUnder, historyError, resolverFor } from "./host-fs.js";

const USAGE = `geml — GEML reference CLI

Usage:
  geml <file.geml|-> [--to <fmt>] [--from <fmt>] [--root d] [-o out]   transform a document (default: --to json)
                                             (--root widens cross-doc resolution to dir d, as on check — an
                                              === embed whose target sits above the file's own directory
                                              needs it, or it renders unresolved)
                                             --to  <output>: json | html | md | geml
                                               --to md    -> Markdown (lossy)
                                               --to html  -> self-contained HTML
                                               --to html --fragment -> body-only markup, no page shell
                                                            (embed in your own layout; assets via pageAssets)
                                               --to geml  -> canonical re-format
                                               --to json  -> document-model JSON (default)
                                             --from <input>: geml | md | json   (overrides extension; html is output-only)
                                               geml notes.md                -> GEML   (md inferred from extension)
                                               geml model.json --to geml    -> GEML   (round-trips a prior --to json)
                                               geml - --from md             read Markdown on stdin
  geml list   <file.geml|-> [--json]                  list every addressable block: address, kind, lines
                                             (call this first — its addresses are what every verb below takes)
  geml find   <pattern> [<file|dir> …] [--json] [--case] [--head]   search block content -> file#address
                                             (an address, not a line number, so a hit pastes into get/set;
                                              a named file is searched whatever its extension, a dir walks
                                              *.geml only; exit 1 when nothing matched)
  geml get    <file.geml|-> [#id] [--json] [--head|--intro|--body]   with #id: print that block
                                             (a heading id = its whole section; --head = head line;
                                             --json = model node). Without #id: list all addressable
                                             ids (--json = array). A selector may also be a POSITION,
                                             'L27' or 'L27-58' — the smallest block containing those
                                             lines, which is how a grep hit or a stack trace becomes
                                             an address.
  geml set    <file.geml|-> #id [--head|--intro|--body] [--in f[#src]|-] [-o f]   replace ONE block by id
  geml replace <file.geml|-> <old> <new> [--within <selector>] [-o f]   EXPERIMENTAL: swap a literal string, checked and reported
                                             (--in F takes F's block #id, F#src takes #src, else stdin raw;
                                              default = whole block · --head = head line · --body = body)
  geml add    <file.geml|-> (--append | --before #id | --after #id) [--in f[#src]|-] [-o f]   insert a fragment
                                             (1+ blocks and/or prose; content keeps its own ids, a clash is refused)
  geml delete <file.geml|-> #id [#id2 …] [-o f]   remove one or more blocks
                                             (a missing id is skipped; a dangling reference is a warning, not a refusal)
  geml rename <file.geml|-> #old #new [-o f]   rename an id and every reference to it (id-boundary safe)
  geml revert <file.geml> #id [--rev <sel>] [--head]   undo one block to a past revision (splice / resurrect / remove)
                                             (sel: 0 | -N | id-prefix | changed; default -1)
  geml check  <file.geml|-> [--root d] [--json]   validate only: diagnostics + exit code
                                             (--root widens cross-doc refs to dir d, e.g. the repo root;
                                              every read and write verb takes it. A write is REFUSED when
                                              the result would not parse, so a document whose ../x.md
                                              links only resolve from the repo root needs --root to be
                                              editable at all — otherwise the guard reads its own blind
                                              spot as breakage)
  geml style check <stylesheet.geml> <corpus…> [--json] [--components=a,b] [--handlers=x,y]   resolve a geml-style sheet against content
                                             (EXPERIMENTAL. An application-layer profile, not part of the
                                              GEML spec: rules select into documents they never modify.
                                              Only the subset codemap's display knobs use — style-rule,
                                              match=, attribute pass-through — is stable; the rest of the
                                              vocabulary moves with the first real use case. --json prints
                                              the view model — bindings, states, screens — which is the
                                              profile's conformance surface.
                                              See spec/profiles/geml-style/)
  geml history <save|get|restore|verify> <file.geml> [...]   .gemlhistory version sidecar
                                             (save = append the file as a revision · get = list revisions, or
                                              print one · restore = overwrite the file with one · verify = rebuild
                                              and re-hash the whole chain)
  geml codemap <build|verify|render|serve|refresh|find> [...]       code-graph toolkit (alias: codegraph)
  geml mcp    --root <dir> [--graph <dir>] [--no-history]   serve documents (and the code graph) over MCP (stdio)
                                             (11 tools, each geml_ + its CLI command path: list/find/get/check/history/to +
                                              set/add/delete/rename/revert; every write is validated before it
                                              reaches disk. A code graph under --root adds four read-only
                                              geml_codemap_* tools to the same server)
  geml skill  install [--dest <dir>] [--no-global] [--no-mcp]   set up GEML for Claude Code, user-global
                                             (authoring skill -> ~/.claude/skills/geml, CLI -> npm i -g,
                                              MCP server registered at user scope; touches no settings.json,
                                              installs no hooks; idempotent — re-run to update)
  geml --help | --version [--json]

Use '-' as the file to read from stdin.
Mutations (set/add/delete/rename) write the whole updated document in place for a
file, or to stdout for '-' input; -o redirects it (-o - = stdout).
Exit codes:
  0 ok
  1 document/operation error
  2 command usage error.
`;

// One-line usage for each subcommand — the single source for both the error
// shown on misuse and the `<cmd> --help` text.
const SUBHELP = {
  get: "usage: geml get <file.geml|-> [<selector>] [--head|--intro|--body] [--view [--root <dir>]] [--json]  (selector = a filter over blocks: #id | '## Heading' (its whole section) | '=== type' (every block of that type — N matches print N contents, count on stderr) | '=== type@<hex>[~n]' or '@<hex>[~n]' (content address, for blocks with no #id) | L<n> or L<n>-<m> (position — the smallest block that fully contains those lines, so the `L27-58` the listing prints pastes straight back, and a line number from an editor, a linter or a diff hunk becomes a block) | <block>[2][\"name\"] (a unit INSIDE a block, GEP 0011: a table's rows, cells and columns, a `data` block's value tree, and `meta`'s keys as `#meta[\"title\"]` — answered from the model, so it names no span and `--head`/`--body` do not apply); `#id` and `@<hex>` are the short spellings of the brace keys `{#id}` and `{@<hex>}`, which are equally legal with or without a `=== type` in front, and any OTHER key in braces is declared but not implemented; a section cuts three ways — --head = the heading line, --intro = its opening region: everything under it up to its FIRST SUBHEADING (empty when one follows immediately, the whole body when none does; a block has no intro and is refused), --body = everything under it; --view = read THROUGH an `embed` to the entity block it stands for, following a chain to its end (the identity on any other block, and on a section selector — it never splices two documents' bytes together); provenance goes to stderr as `view: <sel> -> <doc>[#<id>]`; read-only, `set` refuses it; chain reads are confined to --root (default: the document's own directory) and never fetched over the network; without a selector: list every addressable block with its shortest unique address, --json = array)",
  set: "usage: geml set <file.geml|-> <selector> [--head|--intro|--body] [--in F | --in F#src | --in -] [-o out.geml] [--root d]  (selector as in `get`, but it must match exactly ONE block — '=== type' matching several is refused; content: --in F takes F's block #id, --in F#src takes #src, else stdin raw; default = whole block, --head = head line — both normalize the id when the target has one — --body = body, --intro = a heading's opening region up to its first subheading (an empty region INSERTS there); guarded splice, refused if it breaks the doc — but a replacement that REMOVES blocks is carried out and reported on stderr, named ones and unnamed alike, with `geml revert` as the way back (the same stance `delete` takes; the ordinary read-edit-write cycle removes nothing, since `get` handed those blocks over); writing through an @<hex> address prints the new address on stderr)",
  add: "usage: geml add <file.geml|-> (--append | --before #id | --after #id) [--in F | --in F#src | --in -] [-o out.geml] [--root d]  (insert a GEML fragment — 1+ blocks and/or prose — at a position; --in F takes all of F, --in F#src takes #src, else stdin raw; content keeps its own ids, a collision is refused)",
  delete: "usage: geml delete <file.geml|-> #id [#id2 …] [-o out.geml] [--root d]  (remove one or more blocks; a missing id is skipped with a note, not an error; a reference left dangling is a warning, not a refusal — delete never fails on a live reference)",
  rename: "usage: geml rename <file.geml|-> #old #new [-o out.geml] [--root d]  (rewrite an id's declaration AND every reference — [[#id]], [text](#id), chart data=#id, footnote [^id] — id-boundary safe, skipping raw block bodies; #new must be free; refused if it breaks the doc)",
  list: "usage: geml list <file.geml|-> [--json]  (list every addressable block with its shortest unique address, its kind and its line range — the same listing `geml get <file>` prints with no selector, under the name the MCP surface already uses. Call it FIRST: the addresses it prints are what get/set/add/delete/rename/revert all take)",
  find: "usage: geml find <pattern> [<file|dir> …] [--json] [--case] [--head]  (search block CONTENT and print `<file>TAB<address>` per hit — an address, never a line number, so a hit is `geml get <file> '<address>'` with no editing. The address is the INNERMOST block holding the match, never its enclosing section, and a block is reported once however many lines in it matched. Substring, case-insensitive unless --case; a file you NAME is searched whatever its extension, including Markdown, while a directory is walked for *.geml only; no path = the current directory; --head adds the matching line as a third column. Exit 1 when nothing matched, so `if geml find …` works in a script)",
  replace: "usage: geml replace <file.geml|-> <old> <new> [--within <selector>] [-o out.geml] [--root d]  (EXPERIMENTAL — this verb MAY BE WITHDRAWN in a later release; it is here to find out whether an addressed, checked replacement earns its place beside `sed`, and if it does not, it goes. Build nothing on it you cannot change, and say so in a discussion if it is doing real work for you. Swaps a LITERAL string — never a pattern, that is what `sed` is for and where the footguns are. Without --within the whole document; with it, only inside the blocks that selector matches, and unlike `set` it may match several: `--within '=== table'` means every table. What this buys over `sed -i`, at the same cost of two short strings and nothing read: the result is re-parsed and refused if it would break the document, the blocks it touched are NAMED on stderr, and the write lands in .gemlhistory where `revert` can undo it. An id is not text — a replacement that would rename one is refused and points at `geml rename`, which fixes every reference too. Exit 1 when nothing matched, so `if geml replace …` works in a script)",
  check: "usage: geml check <file.geml|-> [--root <dir>] [--json]  (--root: resolve cross-doc refs within <dir> instead of the file's own directory)",
  revert: "usage: geml revert <file.geml> #id [--rev <sel>] [--append|--before #x|--after #x] [--head] [--dry-run] [-o out] [--root d]  (reconcile #id to a revision: splice / resurrect / remove; sel: 0 | -N | id-prefix | changed; default -1)",
  history: `usage: geml history save    <file.geml> [-m <msg>]      append the working file as a new revision (identical to the tip = no-op)
       geml history get     <file.geml> [<rev>] [--json]   NO <rev>: every revision, newest first, first column = the selector; WITH <rev>: that revision's full text
       geml history restore <file.geml> <rev> [--force]    overwrite the working file with a revision (--force discards unsaved changes)
       geml history verify  <file.geml>                    rebuild and re-hash every revision in the chain
       (<rev>: 0 = the tip | -N = N revisions back | an unambiguous revision id — the strings 'get' prints.
        All four take --history <path> to point at a sidecar other than <file>.gemlhistory.)`,
  codemap: `usage: geml codemap build  [--root <repo>] [--exclude <glob>]… [--no-gitignore]   # auto-detect languages, run the indexer(s), and merge into one codemap (--root defaults to the current directory)
       geml codemap build  (--db <graph.db> | --adapter joern|scip --raw <in> [--remap <virtual-dir>])+ [--root <repo>] [--repo-name <name>] [--out .geml-code-graph] [--build <out>/_build] [--container module|dir|file] [--lang <JAVASRC|NEWC|…>] [--joern <path>] [--exclude <glob>]… [--no-gitignore] [--history [-m msg]]
       geml codemap verify [dir]                 geml check + profile reference checks
       geml codemap render [dir]                 every doc -> sibling .html (open index.html from disk)
       geml codemap serve  [dir] [--port 8140] [--watch] [--background|--stop]   live viewer: pages render from .geml on request; --watch re-runs the recipe when sources change
       geml codemap refresh [dir] [--force] [--commit] [--background|--hook]   re-run the recorded build recipe (_index/refresh.json); --commit lands it as its own commit
       geml codemap find <name> [dir]            locate a symbol by substring name -> doc#id + src (stdout, no browser)
       (<dir> for verify/render/serve/refresh/find defaults to ./.geml-code-graph; codegraph and code-graph are accepted as aliases of codemap)`,
  mcp: `usage: geml mcp --root <dir> [--graph <dir>] [--no-history]

  Serve GEML document CRUD over the MCP stdio transport (JSON-RPC 2.0).
  Every tool is geml_ + its CLI COMMAND PATH, so the terminal and the assistant
  share one vocabulary — geml_history mirrors the "geml history" command group,
  whose read verb (get) is the only one of the four served here.
  Eleven tools: geml_list · geml_find · geml_get · geml_check · geml_history
                geml_to · geml_set · geml_add · geml_delete · geml_rename
                geml_revert
  With a code graph under --root, four more (read-only), so one client entry
  covers both: geml_codemap_search · geml_codemap_callchain
               geml_codemap_list · geml_codemap_node

  --root <dir>        REQUIRED. Root holding the .geml documents. Every path a
                      client names is confined here; a client cannot widen it.
  --graph <dir>       Code-graph directory, inside --root. Defaults to
                      <root>/.geml-code-graph when it holds an index.geml; with
                      no graph the four graph tools are not served at all.
  --no-history        Skip the .gemlhistory revision saved before each write
                      (default: save one, so geml_revert always has a revision
                      to undo to).

  Register with a client:
    claude mcp add geml -- geml mcp --root /abs/path/to/repo`,
  skill: `usage: geml skill install [--dest <skillsDir>] [--no-global] [--no-mcp] [--dry-run]

  One command, three things, all user-global — so any Claude Code session can
  author, validate, and blockwise-edit GEML:
    1. the authoring skill -> <skillsDir>/geml   (default ~/.claude/skills/geml)
    2. the geml CLI        -> npm i -g @geml/geml@<this version>   (skipped when PATH already has it)
    3. the MCP server      -> claude mcp add --scope user geml -- npx -y @geml/geml mcp --root .
  Touches no settings.json and installs no hooks. Idempotent — and it is the
  whole upgrade: a re-run refreshes the skill text AND brings the global CLI to
  the version that text documents, so "npx -y @geml/geml skill install" is one
  step, not two.

  --dest <dir>   install the skill under <dir> instead of ~/.claude/skills
  --no-global    leave the global CLI alone — no install, no version change
  --no-mcp       skip the MCP server registration
  --dry-run      report what would be written, change nothing

  Other agent tools are installed by DETECTION: a tool's own context file gets
  the skill text inside a marker pair (refreshed on a re-run, nothing else in
  the file touched) when its directory is already there — ~/.gemini, ~/.qwen,
  and an AGENTS.md in the current project. A tool that is not installed is
  skipped and named; no tool directory is ever created for you.`,
};

// Set from argv at dispatch time; when true, errors are emitted as a JSON
// envelope so an agent that standardizes on --json never has to parse text.
let jsonMode = false;

// Clean one-line error + non-zero exit — never a raw Node stack trace. `code`
// is the process exit status: 2 for a usage error (the default), 1 for a
// document/operation error. `--json` wraps it in the same {error, code} envelope.
// Which flags each verb owns — the allowlist rejectUnknownFlags() enforces.
// For years every positional scanner just stepped over dash-arguments, so an
// unknown flag was silently ignored on every verb: `geml check f --wat`
// exited 0, a mistyped `--josn` fell back to the other output format, and a
// selector typed as `-hi` instead of `#hi` quietly turned `get` into `list`.
// codemap is absent on purpose: it forwards argv to its own toolkit, whose
// subcommands own their (many, evolving) flags. `set` lists --view only to
// reach its own, better refusal ("set refuses --view").
const VERB_FLAGS: Record<string, { bool: readonly string[]; valued: readonly string[] }> = {
  get: { bool: ["--json", "--head", "--body", "--intro", "--view"], valued: ["--root"] },
  list: { bool: ["--json"], valued: ["--root"] },
  find: { bool: ["--json", "--case", "--head"], valued: ["--root"] },
  set: { bool: ["--head", "--body", "--intro", "--view"], valued: ["--in", "-o", "--out", "--root"] },
  replace: { bool: [], valued: ["--within", "-o", "--out", "--root"] },
  add: { bool: ["--append"], valued: ["--in", "--before", "--after", "-o", "--out", "--root"] },
  delete: { bool: [], valued: ["-o", "--out", "--root"] },
  rename: { bool: [], valued: ["-o", "--out", "--root"] },
  revert: {
    bool: ["--dry-run", "--head", "--append"],
    valued: ["--rev", "--before", "--after", "-o", "--out", "--history", "--root"],
  },
  check: { bool: ["--json"], valued: ["--root"] },
  history: {
    bool: ["--json", "--head", "--body", "--intro", "--force"],
    valued: ["-m", "--message", "--at", "--author", "--history"],
  },
  mcp: { bool: ["--no-history"], valued: ["--root", "--graph"] },
  skill: {
    bool: ["--no-global", "--no-mcp", "--dry-run", "--no-audit", "--no-fund", "-y", "-g"],
    valued: ["--dest", "--version", "--scope", "--root"],
  },
  // The transform entry (`geml <file> …`) — the verb is the file itself.
  convert: { bool: [], valued: ["--to", "--from", "-o", "--out", "--fragment", "--root"] },
};

// Nothing dash-shaped may go unclaimed. Exemptions that are arguments, not
// flags: `-` (stdin) and `-N` (a history revision selector — the first column
// `history get` prints). `--help`/`-h` answer with the verb's own usage.
// A bare `--` is refused with the working alternative, not silently dropped.
function rejectUnknownFlags(verb: string, args: string[]): void {
  const table = VERB_FLAGS[verb];
  if (!table) return;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-") || a === "-" || /^-\d+$/.test(a)) continue;
    if (a === "--help" || a === "-h") {
      console.log((SUBHELP as Record<string, string>)[verb] ?? USAGE);
      process.exit(0);
    }
    if (a === "--") fail(`'--' is not supported; write a dash-leading path as ./<name>`);
    // `--json` is read at dispatch, before any verb: it switches errors to the
    // JSON channel, and the MCP layer passes it to every verb it drives.
    if (a === "--json") continue;
    // `--name=value`: check the name and let the VERB judge the form — history
    // rejects `--at=…` with its own migration message, which must keep firing.
    const eq = a.indexOf("=");
    const name = eq > 1 ? a.slice(0, eq) : a;
    if (table.valued.includes(name)) { if (eq < 0) i++; continue; }
    if (table.bool.includes(name)) continue;
    fail(
      verb === "convert"
        ? `unknown flag '${name}'. Run 'geml --help'.`
        : `unknown flag '${name}' for '${verb}'. Run 'geml ${verb} --help', or 'geml --help' for the verb list.`
    );
  }
}

function fail(msg: string, code = 2): never {
  if (jsonMode) console.error(JSON.stringify({ error: msg, code }));
  else console.error(`error: ${msg}`);
  process.exit(code);
}

// Refuse a mutation whose RESULT would be broken (the pre-write check every
// mutation runs). Prose mode is the long-standing wording: the first error,
// phrased by the call site. `--json` additionally carries the FULL diagnostic
// list with the stable codes of spec Appendix A, so a programmatic caller —
// `geml mcp` above all — reports what actually broke instead of re-parsing
// English out of stderr.
function refuseBroken(prose: string, errs: Diagnostic[]): never {
  if (jsonMode) {
    console.error(JSON.stringify({ error: prose, code: 1, diagnostics: errs }));
    process.exit(1);
  }
  fail(prose, 1);
}

// Read a file, or stdin when the path is "-". On failure emit a clean error.
function readInput(file: string): string {
  try {
    return readFileSync(file === "-" ? 0 : file, "utf8");
  } catch {
    fail(file === "-" ? "cannot read stdin" : `cannot read ${file}`);
  }
}

// The root that cross-document references resolve against for the rest of this
// process, taken from `--root` by whichever verb is running.
//
// Why a module-level value rather than a parameter: the verbs re-parse through
// a dozen call sites, and threading a root through those signatures would
// deliver the same value to the same place by a longer route. It is safe to
// hold here because a verb is one process: the verbs themselves receive it
// through the context `ctxFor()` builds, and never read it from here.
let CLI_ROOT: string | undefined;

// Read `--root` and make it this process's root. Verbs call this before they
// parse anything; `--root` present with no directory is a usage error, the same
// as it is on `check`.
function useRoot(args: string[]): string | undefined {
  const r = flag(args, "--root");
  if (args.includes("--root") && r === undefined) fail("--root needs a directory", 2);
  CLI_ROOT = r;
  return r;
}

function docOpts(file: string, root = CLI_ROOT): DocOpts {
  return docOptsFor(file, root);
}

// The verbs' view of this process: cross-document resolution under CLI_ROOT
// (or an explicit root), side remarks to stderr, and confined sibling reads for
// `--view` and the Markdown export.
function ctxFor(): VerbContext {
  return {
    docOpts: (file, root) => docOpts(file, root),
    note: (line) => console.error(line),
    files: fsFiles,
  };
}

// Run a verb, mapping its refusal onto the CLI's channels: a guarded write's
// diagnostics travel on the `--json` refusal frame, everything else is the
// one-line error with the verb's exit status. Anything that is not a VerbError
// is a bug and keeps its stack.
function verb<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof VerbError) {
      if (e.diagnostics) refuseBroken(e.message, e.diagnostics);
      fail(e.message, e.exit);
    }
    throw e;
  }
}

// The content channel of `set`/`add`: stdin bytes, or `--in F[#src]` — a file
// the verb opens through `read`, at the moment the CLI always did, so a missing
// file is reported after the selector is resolved, not before.
function contentFrom(from: string | undefined): Content {
  if (from === undefined || from === "-") return { kind: "raw", text: readInput("-") };
  return {
    kind: "file",
    spec: from,
    read: (path) => {
      try { return readFileSync(path, "utf8"); }
      catch { throw new VerbError(`cannot read ${path}`, 1); }
    },
  };
}

// `geml check <file>` — validate only: diagnostics + exit code, no document
// dump (cheap for agents). `--json` prints the diagnostics array for machines.
function runCheck(args: string[]): void {
  const json = args.includes("--json");
  const root = flag(args, "--root");
  const file = args.find((a) => a === "-" || (!a.startsWith("-") && a !== root));
  if (!file) fail(SUBHELP.check);
  // A mistyped --root must be a usage error (exit 2), not a wall of misleading
  // "cannot resolve document" errors from a resolver confined to nothing.
  if (root !== undefined) {
    let isDir = false;
    try { isDir = statSync(root).isDirectory(); } catch { /* missing -> not a dir */ }
    if (!isDir) fail(`--root ${root} is not a directory`);
  }
  const doc = verb(() => check(readInput(file), file, ctxFor(), root));
  if (json) {
    console.log(JSON.stringify(doc.diagnostics, null, 2));
  } else {
    for (const d of doc.diagnostics) console.error(`${d.severity}: ${d.message} (line ${d.line})`);
    const errs = doc.diagnostics.filter((d) => d.severity === "error").length;
    const warns = doc.diagnostics.filter((d) => d.severity === "warning").length;
    console.error(errs || warns ? `${errs} error(s), ${warns} warning(s)` : "ok: no diagnostics");
  }
  if (doc.diagnostics.some((d) => d.severity === "error")) process.exit(1);
}

// Subcommand, file and revision, read positionally around the options —
// `--history <path>` and `-m <msg>` may sit anywhere, and the old args[0..2]
// indexing read `--history` itself as the file.
//
// The generic `positionals()` cannot be reused: it drops every `-`-leading token,
// and a revision selector `-N` LOOKS exactly like a flag. That is the whole point
// of the first column `history get` prints, so `-N` is admitted and every other
// `-`-leading token is treated as an option.
function historyPositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--history" || a === "-m" || a === "--message") { i++; continue; } // flag AND its value
    if (a.startsWith("-") && !/^-\d+$/.test(a)) continue;                        // --json, --force, …
    out.push(a);
  }
  return out;
}

function runHistory(args: string[]): void {
  const [sub, file, rev, ...extra] = historyPositionals(args);
  if (!sub || !file) fail(SUBHELP.history);
  const historyPath = flag(args, "--history") ?? historyPathFor(file);
  const json = args.includes("--json");

  try {
    if (sub === "save") {
      // design §3.1/§9-Q4: `--author` and `--at` were withdrawn from the CLI (nothing
      // outside tests ever passed either). Refusing beats ignoring for the same
      // reason the retired verbs above refuse: a silently dropped `--author
      // alice` discards precisely the value the caller went out of their way to
      // type. Both stay on the library API (save({ author, at })).
      for (const gone of ["--author", "--at"]) {
        if (args.some((a) => a === gone || a.startsWith(`${gone}=`))) {
          fail(`${gone} is no longer accepted by 'geml history save' — the only option is -m/--message. (Both remain on the library API, save({ author, at }), for embedders and for tests that pin a revision id.)`);
        }
      }
      // design §3.1: an empty save is a NO-OP. `save` is the one non-idempotent verb,
      // so an agent retrying a save it is unsure landed must not lengthen the
      // chain by a revision with no ops. `geml mcp` already gated its
      // pre-write snapshot on this exact predicate (mcp.ts snapshot()); this is
      // the same `isCurrent()`, not a second hash comparison.
      if (existsSync(historyPath) && isCurrent(historyPath, file)) {
        console.log(`already saved as ${listRevisions(historyPath)[0]!.id} (no changes)`);
        return;
      }
      const r = save({
        gemlPath: file,
        historyPath,
        summary: flag(args, "-m") ?? flag(args, "--message") ?? "",
      });
      console.log(`saved ${r.id}`);
    } else if (sub === "get") {
      // Three tiers, split by how many addresses were given — the same rule the
      // top-level `geml get` follows (design §1.2). Tier 2 takes a BLOCK
      // selector inside the revision and reuses the top-level grammar verbatim
      // (§10.1): a revision rebuilt is just a document's text, so there is no
      // new algorithm here, and the two selector namespaces cannot collide —
      // position is fixed and the lexis does not overlap (§10.2).
      if (extra.length > 1) {
        fail(`history get takes ONE revision selector and ONE block selector; got ${extra.length + 1} positionals after the file`, 2);
      }
      if (rev === undefined) {
        // Newest-first, with each row's selector in the first column (`0` for
        // the tip, then `-1`, `-2`, …) so the output is copy-paste into `get`,
        // `restore` and `revert --rev` alike.
        const revs = listRevisions(historyPath);
        if (json) {
          console.log(JSON.stringify(revs, null, 2));
        } else {
          for (const r of revs) {
            const sel = r.current ? "0" : `-${r.offset}`;
            console.log(`${sel.padEnd(7)} ${r.id}  ${r.author ?? "-"}  ${r.summary ?? ""}`.trimEnd());
          }
        }
      } else {
        // resolveContent() routes through the ONE selector grammar
        // (resolveRevision) that the list above prints — see its comment for
        // what happened the last time that was written twice.
        const { id, text } = resolveContent(historyPath, rev);
        const blockSel = extra[0];
        if (blockSel === undefined) {
          if (json) console.log(JSON.stringify({ id, text }, null, 2));
          else process.stdout.write(text);
        } else {
          // Tier 2 (§10.1). Cardinality and the flag rules are the top-level
          // ones, checked here because this tier has its own argument list.
          const headOnly = args.includes("--head");
          const bodyOnly = args.includes("--body");
          const introOnly = args.includes("--intro");
          const named = [headOnly && "--head", introOnly && "--intro", bodyOnly && "--body"].filter(Boolean) as string[];
          const part: UnitPart = headOnly ? "head" : bodyOnly ? "body" : introOnly ? "intro" : "whole";
          if (named.length > 1) fail(`${named.join(" and ")} are mutually exclusive — they name different parts of one block`, 2);
          if (json && named.length > 0) {
            fail(`--json cannot be combined with ${named[0]} — --json returns the model node, which has no sub-node for one part of a block`, 2);
          }
          const { units, all } = verb(() => selectUnits(text, file, blockSel, `revision ${id}`, ctxFor()));
          if (json) {
            // §3.2's tier table: the revision id travels with the block, so the
            // caller can tell WHICH version it is holding.
            const nodes = verb(() => units.map((u) => unitNode(text, file, u, all, ctxFor())));
            console.log(JSON.stringify({ id, block: units.length === 1 ? nodes[0] : nodes }, null, 2));
          } else {
            if (units.length > 1) reportMatches(units[0]!.type ?? "", units, ctxFor());
            for (const u of units) process.stdout.write(sliceUnit(text, u.span, part));
          }
        }
      }
    } else if (sub === "restore") {
      if (!rev) fail("usage: geml history restore <file.geml> <revision> [--force]");
      restore({ historyPath, gemlPath: file, revision: rev, write: true, force: args.includes("--force") });
      console.log(`restored ${file} to ${rev}`);
    } else if (sub === "verify") {
      const res = verify(historyPath, file);
      for (const e of res.errors) console.error(`error: ${e}`);
      for (const w of res.warnings) console.error(`warning: ${w}`);
      console.log(`verify: ${res.ok ? "OK" : "FAILED"} (${res.checked} revisions reconstructed & hashed)`);
      if (!res.ok) process.exit(1);
    } else {
      fail(`unknown history subcommand: ${sub}. Run 'geml --help'.`);
    }
  } catch (e) {
    fail(historyError(e, file, historyPath));
  }
}

// `geml <file.geml|-> [--to <fmt>] [--from <fmt>] [--root d] [-o out]` — the ONE transform
// entry, reached whenever the first argument is a file (or `-`) rather than a
// known subcommand. It subsumes the former render/export/fmt/convert verbs and
// the bare parse: any input format (geml | md) × any output (json | html | md |
// geml).
//
// Direction is inferred from the INPUT (`--from` overrides > extension > geml),
// and the TARGET from `--to` (default: a geml input -> json, a md input ->
// geml). `-o` only names the output path — the format's single source is `--to`.
// Diagnostics go to stderr and any error exits 1 — the render/export/fmt
// contract, now uniform across all four targets.
function runTransform(argv: string[]): void {
  const out = flag(argv, "-o") ?? flag(argv, "--out");
  const fromRaw = flag(argv, "--from");
  const toRaw = flag(argv, "--to");
  // `--to html --fragment`: body-only markup for embedding in an existing
  // layout (library parity: RenderOptions.fragment). Consumed here so it can
  // be rejected on any other target — a discarded flag is a silent lie.
  const fragIdx = argv.indexOf("--fragment");
  const fragment = fragIdx >= 0;
  if (fragment) argv.splice(fragIdx, 1);
  // Same `--root` as `check`, and for the same reason: cross-document resolution is
  // fail-closed at the document's own directory, so a reference that climbs out of
  // it needs the tree's root named. Without this the transform silently ignored the
  // flag — a document whose embeds `check --root .` validated still rendered with
  // every one of them unresolved, which reads as "transclusion does not work".
  const root = flag(argv, "--root");
  if (argv.includes("--root") && root === undefined) fail("--root needs a directory", 2);
  // Dispatch only lands here when argv[0] is `-` or carries a path character,
  // and `positionals` keeps both — so there is always a file. A guard for the
  // empty case would read as a possibility that does not exist; a caller who
  // writes `geml --to md` is told `unknown command '--to'` at the door.
  const file = positionals(argv, ["-o", "--out", "--from", "--to", "--root"])[0]!;
  // A bare `--to`/`--from` (no following value) is a mistyped flag, not a
  // silent fall-through to the default — flag() would return undefined and we
  // must not quietly ignore it.
  if (argv.includes("--from") && fromRaw === undefined) fail("--from needs a format (geml | md | json)", 2);
  if (argv.includes("--to") && toRaw === undefined) fail("--to needs a format (json | html | md | geml)", 2);

  // Input format: an explicit --from wins (for any input, file or stdin), else
  // the file extension, else GEML (covers .geml, unknown extensions, and stdin).
  let inFmt: InFmt;
  if (fromRaw !== undefined) {
    if (fromRaw !== "geml" && fromRaw !== "md" && fromRaw !== "json") {
      fail(`--from: unknown input format '${fromRaw}' (want geml | md | json)`, 2);
    }
    inFmt = fromRaw;
  } else if (/\.(md|markdown)$/i.test(file)) {
    inFmt = "md";
  } else if (/\.json$/i.test(file)) {
    inFmt = "json";
  } else {
    inFmt = "geml";
  }

  // Output format: an explicit --to wins, else md input -> geml, geml -> json.
  let outFmt: OutFmt;
  if (toRaw !== undefined) {
    if (toRaw !== "json" && toRaw !== "html" && toRaw !== "md" && toRaw !== "geml") {
      fail(`--to: unknown output format '${toRaw}' (want json | html | md | geml)`, 2);
    }
    outFmt = toRaw;
  } else {
    outFmt = inFmt === "geml" ? "json" : "geml"; // geml->json; md/json->geml
  }
  if (fragment && outFmt !== "html") fail("--fragment only applies to --to html", 2);

  const src = readInput(file);
  const r = verb(() => transform(src, file, { inFmt, outFmt, fragment, root }, ctxFor()));
  writeOut(r.output, out);
  for (const n of r.notes) console.error(`note: ${n}`);
  // md -> geml is a direct projection: no document, no diagnostics to raise.
  if (!r.doc) return;
  for (const d of r.doc.diagnostics) console.error(`${d.severity}: ${d.message} (line ${d.line})`);
  if (r.doc.diagnostics.some((d) => d.severity === "error")) process.exit(1);
}

// Write to `-o out` (with a `wrote` note on stderr) or to stdout.
function writeOut(text: string, out: string | undefined): void {
  if (out) { writeFileSync(out, text); console.error(`wrote ${out}`); }
  else process.stdout.write(text);
}

// Output-target rule shared by the MUTATION verbs (set, and — soon — add,
// delete, rename, revert): a real file input with no `-o` is edited IN PLACE
// (it's the obvious target, and it's what lets an agent chain edits without
// re-reading a path back out of stdout); stdin (`file === "-"`) has no such
// target, so it falls back to stdout. `-o` always wins when given: `-o -`
// explicitly requests stdout (even for a file input), `-o <path>` writes
// there. Every write announces itself with `wrote <path>` on stderr; stdout
// stays reserved for the document bytes so it's still pipeable.
function resolveOutTarget(file: string, oFlag: string | undefined): { write(text: string): void } {
  const toFile = (path: string) => ({
    write(text: string) { writeFileSync(path, text); console.error(`wrote ${path}`); },
  });
  const toStdout = { write(text: string) { process.stdout.write(text); } };
  if (oFlag === "-") return toStdout;
  if (oFlag !== undefined) return toFile(oFlag);
  if (file === "-") return toStdout;
  return toFile(file);
}

// Positional args (a file, an id) are the non-flag tokens that aren't the value
// of a value-taking flag. `-` (stdin) is a positional, not a flag. An id may be
// written `#id` or `id`; a leading `-` never begins an id, so this stays
// unambiguous. `valued` lists the flags that consume the following token.
function positionals(args: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) { i++; continue; } // skip the flag *and* its value
    if (a === "-") { out.push(a); continue; }
    if (a.startsWith("-")) continue;           // a bare flag (e.g. --json)
    out.push(a);
  }
  return out;
}

// `geml list <file>` — the same listing `get` prints with no selector, under
// the name the MCP surface has always used for it (`geml_list`). One operation
// had two names across two surfaces; this makes the CLI agree with the tool
// descriptions agents are already reading. `get <file>` keeps working.
function runList(args: string[]): void {
  const [file, extra] = positionals(args, ["--root"]);
  useRoot(args);
  if (!file) fail(SUBHELP.list);
  // `list` IS the empty filter, so a selector here means the caller wanted
  // `get`. Naming the command they meant beats ignoring the argument.
  if (extra !== undefined) {
    fail(`\`list\` takes no selector — it lists every block. To read one: \`geml get ${file} '${extra}'\``, 2);
  }
  process.stdout.write(verb(() => list(readInput(file), file, args.includes("--json"), ctxFor())));
}

// `geml find <pattern> [path…]` — search block CONTENT, print ADDRESSES.
//
// This is the half of the workflow that had no verb. `geml list` says what is
// addressable and `geml get` reads one block, but "which block mentions X" fell
// back to `grep -n`, which answers in line numbers — and a line number stops
// being true the moment anything above it changes. `codemap find` already
// resolves a substring to `doc#id` for symbols; this is the same move for prose.
function runFind(args: string[]): void {
  // `--root` is declared here, and ignored, so that it cannot be mistaken for
  // one more path to search: `find` resolves no cross-document references, and
  // swallowing the directory as a search path widens what a caller narrowed.
  const pos = positionals(args, ["--root"]);
  const pattern = pos[0];
  if (pattern === undefined) fail(SUBHELP.find);
  const sensitive = args.includes("--case");
  const withLine = args.includes("--head");
  const json = args.includes("--json");

  const files: string[] = [];
  const named = pos.slice(1);
  for (const p of named.length ? named : ["."]) gemlFilesUnder(p, files, named.length > 0);

  const hits: FindHit[] = [];
  for (const f of files) {
    let source: string;
    // An unreadable file mid-walk must not abort the search — report nothing
    // for it and keep going, the way every search tool behaves.
    try { source = readFileSync(f, "utf8"); } catch { continue; }
    hits.push(...findInSource(source, f, pattern, { sensitive, withLine }));
  }

  if (json) console.log(JSON.stringify(hits, null, 2));
  else if (hits.length) console.log(formatFindRows(hits, withLine));
  // Exit 1 on no match, like grep: it makes `if geml find …; then` mean what a
  // shell author expects. An empty `--json` array still prints, so a JSON
  // consumer sees `[]` rather than nothing.
  if (!hits.length) process.exit(1);
}

// `geml get <file.geml|-> [<selector>] [--head|--body|--intro] [--json] [--view]`
// — read the document's addressable structure, or one/several blocks out of it.
//
// The selector is a FILTER (§2 of the get/set selector design): no selector
// LISTS every addressable block with its shortest unique address; `#id` /
// `## Heading` / `=== type@<hex>` name at most one; `=== type` matches 0..N.
// Cardinality is uniform (§5): 0 → exit 1, 1 → the content, N → N contents in
// document order with the count on stderr. `--head`/`--body` narrow to one part
// of each match, and every flag combination that used to be half-honoured is
// now a usage error (§7) — a discarded flag is a command that quietly did
// something else.
function runGet(args: string[]): void {
  const json = args.includes("--json");
  const headOnly = args.includes("--head");
  const bodyOnly = args.includes("--body");
  const introOnly = args.includes("--intro");
  const view = args.includes("--view");
  const [file, rawSel] = positionals(args, ["--root"]);
  useRoot(args);
  if (!file) fail(SUBHELP.get);
  const parts = [headOnly && "--head", introOnly && "--intro", bodyOnly && "--body"].filter(Boolean) as string[];
  if (parts.length > 1) fail(`${parts.join(" and ")} are mutually exclusive — they name different parts of one block`, 2);
  const partFlag = parts[0];
  if (json && partFlag) {
    fail(`--json cannot be combined with ${partFlag} — --json returns the model node, which has no sub-node for one part of a block`, 2);
  }
  const part: UnitPart = headOnly ? "head" : bodyOnly ? "body" : introOnly ? "intro" : "whole";
  // One read: stdin can only be consumed once, and the selector resolver needs
  // the same bytes the slice below works on.
  const source = readInput(file);
  const where = file === "-" ? "stdin" : file;
  const sel = parseSelector(rawSel, (braces) => parseAttrs(braces).id);

  if (sel.form === "list") {
    // §5.1: nothing here to narrow, and ignoring the flag would make
    // `get f --head` print byte-for-byte what `get f` prints.
    if (partFlag) {
      fail(`${partFlag} names part of ONE block, so it needs a selector — run \`geml list ${where}\` to see what to address`, 2);
    }
    process.stdout.write(verb(() => list(source, file, json, ctxFor())));
    return;
  }
  const r = verb(() => get(source, file, rawSel!, { part, partFlag, json, view, root: flag(args, "--root") }, ctxFor()));
  process.stdout.write(r.output);
}

// `geml replace <file> <old> <new> [--within <selector>]` — swap a literal
// string, everywhere or inside named blocks, without reading the document.
//
// This is the one operation where GEML can beat `sed` outright rather than
// imitate it. The cost is the same — two short strings out, nothing read in —
// and three things come back that `sed -i` cannot give: the write is re-parsed
// and refused if it would break the document, the blocks it touched are named,
// and it lands in `.gemlhistory` where `revert` can undo it. Measured on a real
// day of editing, ten of fourteen changes were bulk blind replacement done with
// the original commands; every one of those was an edit that escaped all three.
//
// LITERAL, never a pattern. Regular expressions are where `sed` is genuinely
// better and where the footguns live, and the moment this grows them it stops
// being "GEML, addressed" and becomes a worse `sed`.
function runReplace(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const within = flag(args, "--within");
  const [file, oldText, newText] = positionals(args, ["-o", "--out", "--within", "--root"]);
  useRoot(args);
  if (!file || oldText === undefined || newText === undefined) fail(SUBHELP.replace);
  if (oldText === "") fail("the text to replace is empty — that would match everywhere", 2);

  const source = readInput(file);
  const r = verb(() => replace(source, file, oldText, newText, within, ctxFor()));
  resolveOutTarget(file, out).write(r.text);
  console.error(r.summary);
}

// `geml set <file.geml|-> #id [--head|--body|--intro] [--in F|F#src|-] [-o out]`
// — replace ONE existing block, addressed by a selector, with new content,
// preserving every other byte. The channels and modes are documented on the
// verb (verbs.ts `set`); this end owns the argv rules and the output target:
// resolveOutTarget (file -> in place, stdin -> stdout, `-o`/`-o -` override).
function runSet(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const from = flag(args, "--in");
  const headOnly = args.includes("--head");
  const bodyOnly = args.includes("--body");
  const introOnly = args.includes("--intro");
  const named = [headOnly && "--head", introOnly && "--intro", bodyOnly && "--body"].filter(Boolean) as string[];
  if (named.length > 1) fail(`${named.join(" and ")} are mutually exclusive — they name different parts of one block`, 2);
  // `--view` reads THROUGH an embed (see runGet). Writing through one would mean
  // one `set` silently editing a different file, so it is refused rather than
  // ignored — and the message has to point the way, not just say no.
  if (args.includes("--view")) {
    fail("--view is read-only. To edit the target, read the frame's `src` and edit that document.", 2);
  }
  const [file, rawSel] = positionals(args, ["-o", "--out", "--in", "--root"]);
  useRoot(args);
  if (!file) fail(SUBHELP.set);
  // No selector: there is no block to replace. Point the way to discovery, not a
  // bare usage line — `geml get <file>` lists every address `set` can target.
  if (!rawSel) fail(`no selector given — run 'geml get ${file === "-" ? "<file>" : file}' to list addressable blocks`, 2);

  // The raw channel is stdin — `--in` omitted or `--in -`; anything else sources
  // a block from a file. Document and content can't BOTH be stdin: reject that
  // up front, before consuming stdin, so the document read below is unambiguous.
  const rawChannel = from === undefined || from === "-";
  if (file === "-" && rawChannel) {
    fail("reading the document from stdin needs --in for the new content", 2);
  }

  const source = readInput(file);
  const part = headOnly ? "head" : bodyOnly ? "body" : introOnly ? "intro" : "whole";
  const r = verb(() => set(source, file, rawSel, { part, named, content: contentFrom(from) }, ctxFor()));
  resolveOutTarget(file, out).write(r.text);
}

// `geml add <file|-> (--append | --before #x | --after #x) [--in F|F#src|-] [-o]`
// — insert a GEML fragment (1+ blocks and/or prose) at a position; see the verb.
function runAdd(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const from = flag(args, "--in");
  const before = flag(args, "--before");
  const after = flag(args, "--after");
  const append = args.includes("--append");
  const posCount = (append ? 1 : 0) + (before !== undefined ? 1 : 0) + (after !== undefined ? 1 : 0);
  if (posCount !== 1) fail("add needs exactly one position: --append | --before #id | --after #id", 2);
  const [file] = positionals(args, ["-o", "--out", "--in", "--before", "--after", "--root"]);
  useRoot(args);
  if (!file) fail(SUBHELP.add);

  const rawChannel = from === undefined || from === "-";
  if (file === "-" && rawChannel) fail("reading the document from stdin needs --in for the new content", 2);
  const source = readInput(file);

  const r = verb(() => add(source, file, { content: contentFrom(from), append, before, after }, ctxFor()));
  resolveOutTarget(file, out).write(r.text);
}

// `geml delete <file|-> #id [#id2 …] [-o]` — remove one or more blocks; see the
// verb for the lenient guard (a dangling reference is a warning, not a refusal).
function runDelete(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const pos = positionals(args, ["-o", "--out", "--root"]);
  useRoot(args);
  const file = pos[0];
  if (!file) fail(SUBHELP.delete);
  const ids = pos.slice(1).map((s) => s.replace(/^#/, ""));
  if (ids.length === 0) fail("delete needs at least one #id (run 'geml get <file>' to list ids)", 2);

  const source = readInput(file);
  const r = verb(() => del(source, file, ids, ctxFor()));
  resolveOutTarget(file, out).write(r.text);
}

// `geml rename <file|-> #old #new [-o]` — the one verb that reaches OUTSIDE a
// block: it rewrites #old's declaration AND every reference to it. #new must be
// free; the guarded re-parse refuses anything that would break the doc.
function runRename(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const [file, rawOld, rawNew] = positionals(args, ["-o", "--out", "--root"]);
  useRoot(args);
  if (!file || !rawOld || !rawNew) fail(SUBHELP.rename);
  if (rawOld.replace(/^#/, "") === rawNew.replace(/^#/, "")) fail("#old and #new are the same id — nothing to rename", 2);

  const source = readInput(file);
  // Renaming an id that has recorded history breaks the revert-lineage for it
  // (revert keys by id and can't follow #old -> #new across the boundary). The
  // verb warns when the sidecar's tip still carries #old; reading that tip is
  // this end's job. An unreadable or empty history means no warning.
  let historyTip: string | undefined;
  if (file !== "-") {
    const hp = historyPathFor(file);
    if (existsSync(hp)) {
      try { historyTip = resolveContent(hp, "0").text; } catch { /* unreadable/empty history: no warning */ }
    }
  }
  const r = verb(() => rename(source, file, rawOld, rawNew, { historyTip }, ctxFor()));
  resolveOutTarget(file, out).write(r.text);
}

// One flag's value out of argv — the CLI's own tiny parser.
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// `geml revert <file.geml> #id [--rev <sel>] [--dry-run] [-o out] [--history PATH]`
// Restore ONE block to a past revision's version — a targeted, guarded splice
// that leaves the rest of the document untouched. <sel> (default `-1`): `0` (the
// tip), `-N` (N revisions back), an id prefix/suffix, or `changed` — a content
// selector that skips revisions which never touched the block, landing on its
// previous *distinct* version. `--dry-run` prints what would be spliced in,
// writing nothing. Writes in place by default (revert is a mutation); `-o` redirects.
function runRevert(args: string[]): void {
  const dryRun = args.includes("--dry-run");
  const headOnly = args.includes("--head");
  const out = flag(args, "-o") ?? flag(args, "--out");
  const to = flag(args, "--rev") ?? "-1";
  const before = flag(args, "--before");
  const after = flag(args, "--after");
  const append = args.includes("--append");
  if ((append ? 1 : 0) + (before !== undefined ? 1 : 0) + (after !== undefined ? 1 : 0) > 1) {
    fail("revert takes at most one position: --append | --before #id | --after #id", 2);
  }
  const [file, rawId] = positionals(args, ["--rev", "--history", "-o", "--out", "--before", "--after", "--root"]);
  useRoot(args);
  if (!file || !rawId) fail(SUBHELP.revert);
  if (file === "-") fail("revert needs a real file (it reads that file's .gemlhistory)", 2);
  const id = rawId.replace(/^#/, "");
  const historyPath = flag(args, "--history") ?? historyPathFor(file);

  const source = readInput(file);
  // The sidecar, bound for the verb: one selector grammar (resolveContent) and
  // the `changed` walk, both reading THIS file's history.
  const history: HistoryReader = {
    resolve: (sel) => resolveContent(historyPath, sel),
    firstChanged: (current, pick) => firstChangedContent(historyPath, current, pick),
  };
  const r = verb(() => revert(source, file, id, {
    rev: to, dryRun, headOnly, before, after, append, history,
    historyError: (e) => historyError(e, file, historyPath),
  }, ctxFor()));

  // Common write path (bespoke message; -o path redirects; -o - -> stdout).
  const emit = (updated: string, what: string): void => {
    const dest = out ?? file;
    if (dest === "-") process.stdout.write(updated);
    else writeFileSync(dest, updated);
    console.error(`${what}${dest === file ? "" : dest === "-" ? " -> stdout" : ` -> ${dest}`}`);
  };

  if (r.kind === "unchanged") {
    console.error(r.message);
    // A no-op still has to PRODUCE the document when an output destination was
    // asked for: `-o` means "write the result somewhere", and the result of a
    // no-op revert is the unchanged document. Returning silently here left
    // `-o -` consumers with exit 0 and empty stdout, which reads as "success,
    // and the document is now empty".
    if (out !== undefined) emit(source, `#${id} unchanged`);
    return;
  }
  if (r.kind === "dry-run") {
    console.error(r.message);
    if (r.preview !== undefined) process.stdout.write(r.preview);
    return;
  }
  emit(r.text, r.verb);
}

// geml codemap <sub>: the code-graph toolkit ships as plain scripts in the
// package's codemap/ directory (they are argv-driven programs, some
// long-running like `serve`) — dispatch = run the script in a child node
// with the remaining arguments, propagating the exit code.
function runCodemap(args: string[]): void {
  const scripts: Record<string, string> = {
    build: "build.mjs",
    verify: "verify.mjs",
    render: "render-all.mjs",
    serve: "serve.mjs",
    refresh: "refresh.mjs",
    find: "find.mjs",
  };
  const sub = args[0] ?? "";
  // `codemap mcp` was a second stdio server over the same repository. It is
  // gone, not renamed, so name the replacement instead of letting it fall into
  // `unknown codemap subcommand`: this string is what an operator sees in a
  // client's server log when the entry they registered stops starting.
  if (sub === "mcp") {
    fail("geml codemap mcp was removed: use `geml mcp --root <dir>`, which serves the four code-graph tools alongside the document tools (graph: <root>/.geml-code-graph, or --graph <dir>).");
  }
  const script = scripts[sub];
  if (!script) fail(`unknown codemap subcommand '${sub}'.\n${SUBHELP.codemap}`);
  const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "codemap", script);
  const r = spawnSync(process.execPath, [mod, ...args.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// geml style check <stylesheet.geml> <corpus…> [--json]
//
// 样式表对着语料求解（设计 §4.3：冲突对着语料判，不静态判）。
// 退出码沿用 check 的约定：error → 1，warning → 0，用法错误 → 2。
function runStyle(args: string[]): void {
  const sub = args[0];
  if (sub !== "check") fail(`unknown style subcommand '${sub ?? ""}'. Run 'geml style check <stylesheet.geml> <corpus…>'.`, 2);
  const files = args.slice(1).filter((a) => !a.startsWith("--"));
  const sheetPath = files[0];
  const corpusPaths = files.slice(1);
  if (sheetPath === undefined) fail("geml style check needs a stylesheet", 2);
  if (corpusPaths.length === 0) fail("geml style check needs at least one content document to resolve against", 2);

  // 宿主的注册表只有宿主知道，CLI 不知道 —— 所以 `unknown-component` /
  // `unknown-handler` 在命令行上必须由调用方声明才可能触发。不声明就不检查，
  // 而不是假装检查过：一条从不触发的诊断比没有这条诊断更糟。
  const listFlag = (name: string): string[] | undefined => {
    const pre = `--${name}=`;
    const hit = args.find((a) => a.startsWith(pre));
    return hit === undefined ? undefined : hit.slice(pre.length).split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  };
  const opts: { components?: string[]; handlers?: string[] } = {};
  const comps = listFlag("components"); if (comps !== undefined) opts.components = comps;
  const hands = listFlag("handlers"); if (hands !== undefined) opts.handlers = hands;

  // 样式表可以用 `embed` 组合（共享的默认层 + 本地例外），所以装载器要拿到和
  // `--to html` 一样的两个钩子。读取像别处一样在样式表自己的目录上 fail-closed。
  //
  // `forDoc`：样式入口的 `#sitemap` 是「文档 → 额外样式表」，所以只有在知道**为哪
  // 一份文档**装载时才可能命中。语料恰好一份时它就是那一份；给了多份就只剩
  // `default-style` 那一层 —— 一份规则表服务整个语料，无法逐文档不同，所以这里
  // 说出来而不是悄悄取第一份。
  const styleOpts: Parameters<typeof loadStylesheet>[1] = {
    loadDoc: resolverFor(sheetPath, undefined),
    parseDoc: (s) => parse(s, { ...docOpts(sheetPath, undefined) }),
  };
  if (corpusPaths.length === 1) styleOpts.forDoc = basename(corpusPaths[0]!);
  const sheet = loadStylesheet(parse(readFileSync(sheetPath, "utf8")), styleOpts);
  const corpus = corpusPaths.map((f) => ({ path: f, doc: parse(readFileSync(f, "utf8")) }));
  const vm = resolveStyle(sheet, corpus, opts);

  if (jsonMode) {
    console.log(JSON.stringify(vm, null, 2));
  } else {
    for (const d of vm.diagnostics) {
      const where = d.rule === undefined ? "" : ` (#${d.rule})`;
      const line = `${d.severity}: ${d.code}: ${d.message}${where}`;
      if (d.severity === "error") console.error(line); else console.log(line);
    }
    const errs = vm.diagnostics.filter((d) => d.severity === "error").length;
    const warns = vm.diagnostics.length - errs;
    console.log(`${errs} error(s), ${warns} warning(s)`);
  }
  process.exit(vm.diagnostics.some((d) => d.severity === "error") ? 1 : 0);
}

// geml mcp: the MCP server — document CRUD, plus the code-graph tools when the
// root holds a graph. It runs as a child's MAIN module because it owns
// stdin/stdout for the whole session (the stdio transport), and dispatching by
// spawn keeps this module free of a runtime import cycle (mcp.js imports the
// parser from here).
function runMcp(args: string[]): void {
  const mod = join(dirname(fileURLToPath(import.meta.url)), "mcp.js");
  const r = spawnSync(process.execPath, [mod, ...args], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// geml skill install: one command that makes GEML usable everywhere for a
// Claude Code user — the authoring skill resident under ~/.claude/skills/geml,
// the CLI on the global PATH, and the MCP server registered at user scope.
// Deliberately quiet: no settings.json edits, no hooks, no .gemlhistory
// sidecars. Idempotent, so re-running after an upgrade refreshes everything.
// The other agent tools: install by DETECTION, never by creation. A tool's
// own context file is the one place it is guaranteed to read, so the skill
// text goes there — inside a marker pair, so a re-run refreshes our block and
// nothing a person wrote is ever touched. If the tool's directory is absent
// the tool is absent: skip it and say so. Creating `~/.gemini/` for someone
// who does not use Gemini would be a lie on disk.
const SKILL_MARK_START = "<!-- geml:skill:start -->";
const SKILL_MARK_END = "<!-- geml:skill:end -->";

// Where each tool reads its instructions from. `dir` is the detection probe:
// present means the tool is installed for this user (or, for a project file,
// that the project already keeps one).
const SKILL_TARGETS: { name: string; dir: string; file: string; scope: "user" | "project" }[] = [
  { name: "gemini", dir: join(homedir(), ".gemini"), file: join(homedir(), ".gemini", "GEMINI.md"), scope: "user" },
  { name: "qwen", dir: join(homedir(), ".qwen"), file: join(homedir(), ".qwen", "QWEN.md"), scope: "user" },
  // AGENTS.md is read by several tools and lives in a project, so the probe is
  // the file itself: we add our block to one that exists, never start one.
  { name: "agents-md", dir: resolvePath("AGENTS.md"), file: resolvePath("AGENTS.md"), scope: "project" },
];

// The skill text as another tool should see it: the packaged SKILL.md without
// its Claude-only frontmatter, with `<skill-base>` resolved to where the
// reference document actually landed, so `geml get …/authoring.geml '#tables'`
// is a command the reader can paste.
function skillTextFor(src: string, installedAt: string): string {
  const body = readFileSync(join(src, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");
  return `${SKILL_MARK_START}\n<!-- Written by \`geml skill install\`. Edit the source, not this block: it is replaced on the next run. -->\n\n${
    body.replace(/<skill-base>/g, installedAt.replace(/\\/g, "/")).trimEnd()
  }\n${SKILL_MARK_END}\n`;
}

function installOtherTools(src: string, installedAt: string, dryRun: boolean): { ok: number; failed: number } {
  const block = skillTextFor(src, installedAt);
  let ok = 0;
  let failed = 0;
  for (const t of SKILL_TARGETS) {
    if (!existsSync(t.dir)) {
      console.log(`${t.name.padEnd(6)} not detected — skipped (${t.scope === "project" ? "no AGENTS.md here" : `no ${t.dir}`})`);
      continue;
    }
    // Reading is as failure-prone as writing — the name may be a directory, or
    // unreadable — so the WHOLE per-target step sits inside the guard. One bad
    // path is reported and stepped over; it never reaches the next target as a
    // stack trace.
    try {
      const had = existsSync(t.file) ? readFileSync(t.file, "utf8") : "";
      const s = had.indexOf(SKILL_MARK_START);
      const e = had.indexOf(SKILL_MARK_END);
      // A marker pair means we have been here: replace just that span, so the
      // file's own content survives an upgrade untouched.
      const next = s >= 0 && e > s
        ? had.slice(0, s) + block + had.slice(e + SKILL_MARK_END.length).replace(/^\r?\n/, "")
        : (had.trimEnd() ? `${had.trimEnd()}\n\n${block}` : block);
      if (next === had) { console.log(`${t.name.padEnd(6)} already current -> ${t.file}`); continue; }
      if (dryRun) { console.log(`${t.name.padEnd(6)} would ${s >= 0 ? "refresh" : "add"} the skill block -> ${t.file}`); continue; }
      // Atomic: this file can hold the person's own rules, and a half-written
      // one would destroy them. Write beside it, then rename over.
      const tmp = `${t.file}.geml-tmp`;
      writeFileSync(tmp, next);
      renameSync(tmp, t.file);
      console.log(`${t.name.padEnd(6)} ${s >= 0 ? "refreshed" : "added"} the skill block -> ${t.file}`);
      ok++;
    } catch (err) {
      // A read-only home, a file another process holds open, a name that is
      // not a file — say which target and why, then carry on.
      console.error(`${t.name.padEnd(6)} could not update ${t.file}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  return { ok, failed };
}

function runSkill(args: string[]): void {
  const sub = args[0];
  if (sub !== "install") fail(`unknown skill subcommand '${sub ?? ""}'.\n${SUBHELP.skill}`);
  const rest = args.slice(1);
  const flag = (name: string): boolean => {
    const i = rest.indexOf(name);
    if (i >= 0) rest.splice(i, 1);
    return i >= 0;
  };
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    if (!v) fail(`${name} needs a value.\n${SUBHELP.skill}`);
    rest.splice(i, 2);
    return v;
  };
  const noGlobal = flag("--no-global");
  const noMcp = flag("--no-mcp");
  const dryRun = flag("--dry-run");
  const dest = opt("--dest") ?? join(homedir(), ".claude", "skills");
  if (rest.length) fail(`unexpected argument '${rest[0]}'.\n${SUBHELP.skill}`);

  // The skill ships inside the npm package, next to dist/ — the installed
  // skill text always matches the CLI version it teaches.
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
  if (!existsSync(join(src, "SKILL.md"))) fail(`bundled skill not found at ${src} (broken install?)`, 1);
  const target = join(dest, "geml");
  const copied: string[] = [];
  const copyTree = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      // Never ship a history sidecar — skill and config docs carry none.
      if (e.name.endsWith(".gemlhistory")) continue;
      const f = join(from, e.name);
      const t = join(to, e.name);
      if (e.isDirectory()) copyTree(f, t);
      else { copyFileSync(f, t); copied.push(relative(dest, t)); }
    }
  };
  let ok = 0;
  let failed = 0;
  if (dryRun) {
    console.log(`skill  would install -> ${target}`);
  } else {
    try {
      copyTree(src, target);
      console.log(`skill  installed -> ${target}  (${copied.join(", ")})`);
      ok++;
    } catch (e) {
      // Not fatal, and deliberately so: an unwritable `~/.claude` — a locked
      // file, a read-only home, a name that is not a directory — must not stop
      // the tools that CAN be installed. A clean one-liner, never a raw stack.
      console.error(`skill  could not install to ${target}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  const other = installOtherTools(src, target, dryRun);
  ok += other.ok;
  failed += other.failed;

  // Windows npm/claude/geml are .cmd shims: they need a shell. Every argument
  // below is a fixed literal, so shell:true adds no injection surface.
  const sh = process.platform === "win32";
  const run = (cmd: string, a: string[], inherit = false) =>
    spawnSync(cmd, a, { shell: sh, encoding: "utf8" as const, ...(inherit ? { stdio: "inherit" as const } : {}) });

  if (!noGlobal) {
    // The skill text just written came out of THIS package (`skill/` next to
    // dist/), so the CLI it teaches is this package's version. Anything else on
    // PATH is a mismatch — which is why the test is an equality and not an
    // ordering: "different version" and "not installed" both mean "put the
    // version the skill documents there", and pinning the spec is what makes
    // one `npx -y @geml/geml skill install` a complete upgrade.
    //
    // The version is read back out of `geml --version` ("geml 1.2.3 (GEML spec
    // …)") rather than trusted as a whole string: an unreadable or unexpected
    // line is simply not a match, and lands in the install branch.
    const have = run("geml", ["--version"]);
    const onPath = have.status === 0
      ? /\b\d+\.\d+\.\d+[^\s)]*/.exec(String(have.stdout ?? ""))?.[0]
      : undefined;
    if (onPath === PARSER_VERSION) {
      console.log(`cli    ${PARSER_VERSION} already on PATH`);
    } else {
      console.log(`cli    installing @geml/geml globally (npm i -g)${onPath ? `, ${onPath} -> ${PARSER_VERSION}` : ""}...`);
      const r = run("npm", ["install", "-g", `@geml/geml@${PARSER_VERSION}`, "--no-audit", "--no-fund", "--loglevel=error"], true);
      if (r.status !== 0) console.error("cli    global install failed — install later with: npm i -g @geml/geml");
    }
  }

  if (!noMcp) {
    const REG = "claude mcp add --scope user geml -- npx -y @geml/geml mcp --root .";
    const claude = run("claude", ["--version"]);
    if (claude.status !== 0) {
      console.log(`mcp    claude CLI not found — register later with: ${REG}`);
    } else if (run("claude", ["mcp", "get", "geml"]).status === 0) {
      console.log("mcp    server 'geml' already registered");
    } else {
      const r = run("claude", ["mcp", "add", "--scope", "user", "geml", "--", "npx", "-y", "@geml/geml", "mcp", "--root", "."]);
      if (r.status === 0) console.log("mcp    registered user-scope server 'geml' (confined to each session's project directory)");
      else console.error(`mcp    registration failed (${String(r.stderr ?? "").trim() || "unknown"}) — register later with: ${REG}`);
    }
  }
  // Every step is independent, so a single unwritable path is reported and
  // stepped over. Exit non-zero only when NOTHING landed — that is the one
  // outcome a caller has to react to; a partial install is still an install.
  if (failed > 0 && ok === 0) {
    console.error(`nothing was installed (${failed} target(s) failed) — see the messages above.`);
    process.exit(1);
  }
  if (failed > 0) console.log(`done — ${ok} target(s) installed, ${failed} skipped after an error.`);
  else console.log("done — new Claude Code sessions pick up the skill.");
  process.exit(0);
}

// npm's unix bin shim is a symlink named plain `geml`, so detect "run as a
// CLI" by resolving argv[1] to its real path, not by its spelling.
const entry = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return "";
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
})();
// This module IS the command line — importing it means running it. There is no
// entry test any more, and there must not be: the legacy `dist/geml.js` entry
// reaches this file through a dynamic import, so argv[1] names *that* file, and
// a test comparing it against this one would silently do nothing (it did).
// `entry` is still computed above, because a couple of messages report it.
{
  void entry;
  const argv = process.argv.slice(2);
  // The on-disk artifact is `.geml-code-graph/`, so people reconstruct the
  // command from the directory name — accept those spellings as `codemap`.
  const cmd = argv[0] === "codegraph" || argv[0] === "code-graph" ? "codemap" : argv[0];
  jsonMode = argv.includes("--json");
  const rest = argv.slice(1);
  if (cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
  } else if (cmd === "--version" || cmd === "-V") {
    if (jsonMode) console.log(JSON.stringify({ parser: PARSER_VERSION, spec: VERSION }));
    else console.log(`geml ${PARSER_VERSION} (GEML spec ${VERSION})`);
  } else if (cmd === undefined) {
    console.error(USAGE);
    process.exit(2);
  } else if (SUBHELP[cmd as keyof typeof SUBHELP] && (rest.includes("--help") || rest.includes("-h"))) {
    // `geml <cmd> --help` is a help request, not a usage error: usage to
    // stdout, exit 0 — never the `error:`-prefixed exit-2 path.
    console.log(SUBHELP[cmd as keyof typeof SUBHELP]);
  } else if (cmd !== undefined && Object.hasOwn(VERB_FLAGS, cmd) && cmd !== "convert") {
    rejectUnknownFlags(cmd, argv.slice(1));
    const rest = argv.slice(1);
    if (cmd === "get") runGet(rest);
    else if (cmd === "list") runList(rest);
    else if (cmd === "find") runFind(rest);
    else if (cmd === "set") runSet(rest);
    else if (cmd === "replace") runReplace(rest);
    else if (cmd === "add") runAdd(rest);
    else if (cmd === "delete") runDelete(rest);
    else if (cmd === "rename") runRename(rest);
    else if (cmd === "revert") runRevert(rest);
    else if (cmd === "history") runHistory(rest);
    else if (cmd === "check") runCheck(rest);
    else if (cmd === "mcp") runMcp(rest);
    else runSkill(rest);
  } else if (cmd === "style") {
    runStyle(argv.slice(1));
  } else if (cmd === "codemap") {
    // Not flag-checked here: codemap forwards to its own toolkit, whose
    // subcommands own their flags.
    runCodemap(argv.slice(1));
  } else if (cmd !== "-" && !/[.\/\\]/.test(cmd)) {
    // A bare word that is neither a known command nor a path is almost always
    // a mistyped command — say so, don't try to read it as a file. (The
    // reclaimed verbs render/export/fmt/convert land here too.)
    fail(`unknown command '${cmd}'. Run 'geml --help'.`);
  } else {
    // A file (or stdin via '-') is the transform entry: `--to`/`--from`/`-o`,
    // default `--to json`. The single door for every format conversion.
    rejectUnknownFlags("convert", argv);
    runTransform(argv);
  }
}
