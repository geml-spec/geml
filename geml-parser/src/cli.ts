#!/usr/bin/env node
// The GEML command line. Split out of geml.ts so that file can be what the
// viewer imports: a parser LIBRARY. Everything CLI-side lives here — argv
// dispatch, the verbs, file and stdin I/O, spawning `codemap`/`mcp`, and
// `skill install`. The browser bundle never reaches this module, so a new
// node:* import here can no longer break the extension build (it did three
// times in one day: node:os for homedir, pageAssets, renameSync).

import { readFileSync, writeFileSync, realpathSync, statSync, existsSync, mkdirSync, readdirSync, copyFileSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  type Document, type Block, type Diagnostic, type Value, type TableModel,
  type DataValue, type ParseOptions, type Span, type UnitPart,
  PARSER_VERSION, VERSION, EMBED_DEPTH_LIMIT, FENCE_OPEN,
  parse, blockSpans, sliceUnit, addressedUnits, relJoinPath, relDirPath, gatherEmbeds,
  closeFenceLine, findBlockSite, historyPathFor, isCloseFence, narrowToHead, newlineOf,
  narrowToIntro, reLit, sectionEndIndex, splitLines, stripEol, toLf, toNewline, trimSpaceTabEnd,
} from "./geml.js";
import { type Unit, type Addressed, type Selector } from "./selector.js";
import { schemeOf } from "./inline.js";
import { parseAttrs } from "./attrs.js";
import { type DiagnosticCode } from "./diagnostics.js";
import { save, restore, verify, isCurrent, listRevisions, resolveContent, firstChangedContent } from "./history.js";
import { renderHtml } from "./render-html.js";
import { normalizeBlockId } from "./block-edit.js";
import { normalizeSource } from "./diagnostics.js";
import { addressUnits, discoveryHint, matchContent, matchLine, matchType, parseSelector, shortestAddress } from "./selector.js";
import { mdToGeml } from "./from-md.js";
import { serialize } from "./serialize.js";
import { gemlToMd } from "./to-md.js";
// ---------------------------------------------------------------------------
// `get --view` (design: docs/design/specs/2026-08-05-geml-get-view-design.md)
// ---------------------------------------------------------------------------

// An `embed` block has no content of its own — §3 leaves its body unused — so
// "read what is here" cannot be answered from the block itself. `--view`
// resolves a unit to the ENTITY block it stands for: it follows `src=` into the
// target document, which §3 requires be parsed as a document in its own right.
// Each hop re-selects with the SAME selector grammar `get` uses, which is what
// makes a heading fragment select its whole section for free — render.ts's
// findEmbedTarget documents that boundary as the one `geml get` already uses.
//
// Defined as "resolve to the entity block" rather than "an embed switch", so it
// is the IDENTITY on every other block type: a caller never has to classify its
// target first, and a newly registered type needs no code here.
interface ViewResult { doc: string; text: string; unit: Unit; all: Addressed[]; from: string }

// A chain that cannot reach an entity block. Carries the diagnostic code it
// corresponds to (§3) so the message can name it without inventing a new one.
class ViewError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// Walking a chain is DOCUMENT-DRIVEN file access: `src=` comes from file
// content, so without a confinement root a document could name any path on the
// machine. And never a URL — `geml get` is a read command that agents and
// editors call constantly, so letting content steer it at the network would turn
// it into an SSRF entry point (§3.1). Both refusals reuse existing codes (§3).
function readConfined(rel: string, root: string): string {
  if (!/\.geml$/i.test(rel)) {
    throw new ViewError("embed-target-not-geml", `embed-target-not-geml: \`${rel}\` is not a \`.geml\` document`);
  }
  const base = resolvePath(root);
  const abs = resolvePath(root, rel);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new ViewError("unresolvable-document",
      `unresolvable-document: \`${rel}\` lies outside the confinement root \`${root}\``);
  }
  try { return readFileSync(abs, "utf8"); }
  catch { throw new ViewError("unresolvable-document", `unresolvable-document: cannot resolve \`${rel}\``); }
}

// One hop: read the target document and select what the fragment names. Several
// units come back when the fragment names a section (§4.3).
function oneHop(file: string, src: string, root: string):
    { doc: string; text: string; units: Unit[]; all: Addressed[]; from: string } {
  const hash = src.indexOf("#");
  const docPath = hash < 0 ? src : src.slice(0, hash);
  const frag = hash < 0 ? undefined : src.slice(hash + 1);
  // Check the scheme on what the DOCUMENT wrote, before composition: a URL can
  // only arrive through `src=`, never from joining relative paths — and testing
  // the composed path instead would read a Windows drive letter (`C:/…`) as a
  // scheme and refuse every absolute path, which is exactly what the MCP layer
  // hands the CLI.
  if (schemeOf(docPath) !== null) {
    throw new ViewError("unchecked-cross-document-reference",
      `unchecked-cross-document-reference: \`${docPath}\` is not local; \`--view\` never fetches over the network`);
  }
  const rel = relJoinPath(relDirPath(file), docPath);
  const text = readConfined(rel, root);
  if (frag === undefined) {
    // `src=other.geml`: the frame looks onto the WHOLE document. Every block
    // comes from the same target, so the resolution base stays uniform — unlike
    // a host-side section selector, where splicing would mix two documents.
    // `meta` is frontmatter, not content (render.ts's selectEmbed).
    //
    // Only TOP-LEVEL units: a heading's unit spans its whole section, so taking
    // every addressed unit would emit the blocks inside a section twice.
    const every = addressedUnits(text).map((a) => a.unit);
    const top = every.filter((u) => !every.some((o) =>
      o !== u && o.span.start <= u.span.start && o.span.end >= u.span.end
      && (o.span.start < u.span.start || o.span.end > u.span.end)));
    return { doc: rel, text, units: top.filter((u) => !(u.kind === "block" && u.type === "meta")), all: [], from: shownPath(rel, root) };
  }
  const { units, all } = selectUnits(text, rel, `#${frag}`, rel);
  return { doc: rel, text, units, all, from: `${shownPath(rel, root)}#${frag}` };
}

// Provenance is stated relative to the confinement root, not as the path the
// walk happens to have composed. The MCP layer hands the CLI an ABSOLUTE path,
// so without this `from` would be `C:/Users/…/part.geml#tip` — leaking the
// server's layout, and not a path any caller could pass back in.
function shownPath(rel: string, root: string): string {
  const r = relative(root, rel).replace(/\\/g, "/");
  return r === "" ? rel : r;
}

function viewResolve(source: string, file: string, unit: Unit, root: string,
                     depth = 0, seen: ReadonlySet<string> = new Set()): ViewResult[] {
  const src = unit.kind === "block" && unit.type === "embed" ? embedSrcOf(source, unit) : undefined;
  if (src === undefined) return [{ doc: file, text: source, unit, all: [], from: "" }];
  // The renderer expands no deeper either (EMBED_DEPTH_LIMIT), but where the
  // cycle detector may stop SILENTLY — a 9-deep chain is legal and simply is
  // not expanded — `--view` may not: stopping here means what we are holding is
  // still a frame, and returning it would break the contract silently.
  if (depth >= EMBED_DEPTH_LIMIT) {
    throw new ViewError("depth",
      `chain still not on an entity block after ${EMBED_DEPTH_LIMIT} hops (the renderer expands no deeper either)`);
  }
  const hop = oneHop(file, src, root);
  // Same key shape as the check's cycle detector: a document plus what was
  // selected in it.
  const key = `${hop.doc}#${hop.units.map((u) => u.id ?? "").join(",")}`;
  if (seen.has(key)) {
    throw new ViewError("transclusion-cycle",
      `transclusion-cycle: \`${hop.from}\` is already being expanded in this chain`);
  }
  const nextSeen = new Set(seen).add(key);
  // Per-unit application, recursively: what a frame looks onto may itself be a
  // frame, and a section may hold a mix (§4.3).
  return hop.units.flatMap((u) => viewResolve(hop.text, hop.doc, u, root, depth + 1, nextSeen)
    // An inner identity step has no provenance of its own, so carry this hop's:
    // `from` must always name where the bytes actually came from.
    .map((r) => (r.from === "" ? { ...r, from: hop.from } : r)));
}

// The `src=` of an embed unit, read off its head line: a Unit carries the span,
// not parsed attributes.
function embedSrcOf(source: string, unit: Unit): string | undefined {
  const braces = /\{[^}]*\}/.exec(sliceUnit(source, unit.span, "head"));
  if (!braces) return undefined;
  const v = parseAttrs(braces[0]).attrs["src"];
  return typeof v === "string" ? v : undefined;
}
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
                                             (--root widens cross-doc refs to dir d, e.g. the repo root)
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
  get: "usage: geml get <file.geml|-> [<selector>] [--head|--intro|--body] [--view [--root <dir>]] [--json]  (selector = a filter over blocks: #id | '## Heading' (its whole section) | '=== type' (every block of that type — N matches print N contents, count on stderr) | '=== type@<hex>[~n]' or '@<hex>[~n]' (content address, for blocks with no #id) | L<n> or L<n>-<m> (position — the smallest block that fully contains those lines, so the `L27-58` the listing prints pastes straight back, and a line number from an editor, a linter or a diff hunk becomes a block); a section cuts three ways — --head = the heading line, --intro = its opening region: everything under it up to its FIRST SUBHEADING (empty when one follows immediately, the whole body when none does; a block has no intro and is refused), --body = everything under it; --view = read THROUGH an `embed` to the entity block it stands for, following a chain to its end (the identity on any other block, and on a section selector — it never splices two documents' bytes together); provenance goes to stderr as `view: <sel> -> <doc>[#<id>]`; read-only, `set` refuses it; chain reads are confined to --root (default: the document's own directory) and never fetched over the network; without a selector: list every addressable block with its shortest unique address, --json = array)",
  set: "usage: geml set <file.geml|-> <selector> [--head|--intro|--body] [--in F | --in F#src | --in -] [-o out.geml]  (selector as in `get`, but it must match exactly ONE block — '=== type' matching several is refused; content: --in F takes F's block #id, --in F#src takes #src, else stdin raw; default = whole block, --head = head line — both normalize the id when the target has one — --body = body, --intro = a heading's opening region up to its first subheading (an empty region INSERTS there); guarded splice, refused if it breaks the doc — but a replacement that REMOVES blocks is carried out and reported on stderr, named ones and unnamed alike, with `geml revert` as the way back (the same stance `delete` takes; the ordinary read-edit-write cycle removes nothing, since `get` handed those blocks over); writing through an @<hex> address prints the new address on stderr)",
  add: "usage: geml add <file.geml|-> (--append | --before #id | --after #id) [--in F | --in F#src | --in -] [-o out.geml]  (insert a GEML fragment — 1+ blocks and/or prose — at a position; --in F takes all of F, --in F#src takes #src, else stdin raw; content keeps its own ids, a collision is refused)",
  delete: "usage: geml delete <file.geml|-> #id [#id2 …] [-o out.geml]  (remove one or more blocks; a missing id is skipped with a note, not an error; a reference left dangling is a warning, not a refusal — delete never fails on a live reference)",
  rename: "usage: geml rename <file.geml|-> #old #new [-o out.geml]  (rewrite an id's declaration AND every reference — [[#id]], [text](#id), chart data=#id, footnote [^id] — id-boundary safe, skipping raw block bodies; #new must be free; refused if it breaks the doc)",
  list: "usage: geml list <file.geml|-> [--json]  (list every addressable block with its shortest unique address, its kind and its line range — the same listing `geml get <file>` prints with no selector, under the name the MCP surface already uses. Call it FIRST: the addresses it prints are what get/set/add/delete/rename/revert all take)",
  find: "usage: geml find <pattern> [<file|dir> …] [--json] [--case] [--head]  (search block CONTENT and print `<file>TAB<address>` per hit — an address, never a line number, so a hit is `geml get <file> '<address>'` with no editing. The address is the INNERMOST block holding the match, never its enclosing section, and a block is reported once however many lines in it matched. Substring, case-insensitive unless --case; a file you NAME is searched whatever its extension, including Markdown, while a directory is walked for *.geml only; no path = the current directory; --head adds the matching line as a third column. Exit 1 when nothing matched, so `if geml find …` works in a script)",
  replace: "usage: geml replace <file.geml|-> <old> <new> [--within <selector>] [-o out.geml]  (EXPERIMENTAL — this verb MAY BE WITHDRAWN in a later release; it is here to find out whether an addressed, checked replacement earns its place beside `sed`, and if it does not, it goes. Build nothing on it you cannot change, and say so in a discussion if it is doing real work for you. Swaps a LITERAL string — never a pattern, that is what `sed` is for and where the footguns are. Without --within the whole document; with it, only inside the blocks that selector matches, and unlike `set` it may match several: `--within '=== table'` means every table. What this buys over `sed -i`, at the same cost of two short strings and nothing read: the result is re-parsed and refused if it would break the document, the blocks it touched are NAMED on stderr, and the write lands in .gemlhistory where `revert` can undo it. An id is not text — a replacement that would rename one is refused and points at `geml rename`, which fixes every reference too. Exit 1 when nothing matched, so `if geml replace …` works in a script)",
  check: "usage: geml check <file.geml|-> [--root <dir>] [--json]  (--root: resolve cross-doc refs within <dir> instead of the file's own directory)",
  revert: "usage: geml revert <file.geml> #id [--rev <sel>] [--append|--before #x|--after #x] [--head] [--dry-run] [-o out]  (reconcile #id to a revision: splice / resurrect / remove; sel: 0 | -N | id-prefix | changed; default -1)",
  history: `usage: geml history save    <file.geml> [-m <msg>]      append the working file as a new revision (identical to the tip = no-op)
       geml history get     <file.geml> [<rev>] [--json]   NO <rev>: every revision, newest first, first column = the selector; WITH <rev>: that revision's full text
       geml history restore <file.geml> <rev> [--force]    overwrite the working file with a revision (--force discards unsaved changes)
       geml history verify  <file.geml>                    rebuild and re-hash every revision in the chain
       (<rev>: 0 = the tip | -N = N revisions back | an unambiguous revision id — the strings 'get' prints.
        All four take --history <path> to point at a sidecar other than <file>.gemlhistory.)`,
  codemap: `usage: geml codemap build  [--root <repo>]   # auto-detect languages, run the indexer(s), and merge into one codemap (--root defaults to the current directory)
       geml codemap build  (--db <graph.db> | --adapter joern|scip --raw <in>)+ [--root <repo>] [--out .geml-code-graph] [--container module|dir|file] [--lang <JAVASRC|NEWC|…>] [--joern <path>] [--history [-m msg]]
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
    2. the geml CLI        -> npm i -g @geml/geml   (skipped when already on PATH)
    3. the MCP server      -> claude mcp add --scope user geml -- npx -y @geml/geml mcp --root .
  Touches no settings.json and installs no hooks. Idempotent — re-run after an
  upgrade to refresh the skill text alongside the CLI it teaches.

  --dest <dir>   install the skill under <dir> instead of ~/.claude/skills
  --no-global    skip the global npm install
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

// A cross-document resolver rooted at the input's directory (cwd for stdin),
// CONFINED to that directory's subtree. A reference that resolves outside the
// base — via a `..` escape, an absolute path, or (on Windows) a different drive
// — is refused (returns null, i.e. an unresolvable ref) so a crafted document
// cannot turn `geml check`/parse into an arbitrary local-file read oracle. §8.
//
// A purely LEXICAL check is not enough: a symlink that sits lexically inside the
// subtree but points to `../../outside.geml` passes `path.relative` yet reads an
// external target. So after the cheap lexical gate we resolve BOTH the base and
// the target through `realpathSync` (following every symlink component) and
// re-check that the REAL target still lies within the REAL base subtree before
// reading. A target that does not exist makes `realpathSync` throw — handled as
// an ordinary unresolvable ref (null), never a crash.
//
// `root` (CLI `--root`, an explicit per-invocation user grant — never
// document-controlled) widens the confinement base from the input's own
// directory to an ancestor the user names, so repo-relative `../` references
// between sibling directories can be checked. It moves WHERE the boundary
// stands, never whether it is enforced: both gates below run against the
// widened base, so escapes past the root are refused exactly as above. The
// viewer/web surfaces never pass a root — their boundary is unchanged.
function resolverFor(file: string, root?: string): (d: string) => string | null {
  const dirAbs = resolvePath(file === "-" ? "." : dirname(file));
  const baseAbs = root === undefined ? dirAbs : resolvePath(root);
  // Canonicalise the base once. If the base itself cannot be realpath'd, no
  // cross-doc ref can be safely confined — resolve nothing.
  let realBase: string | null = null;
  try { realBase = realpathSync(baseAbs); } catch { realBase = null; }
  const outside = (from: string, to: string): boolean => {
    const rel = relative(from, to);
    return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
  };
  return (d) => {
    if (realBase === null) return null;
    // References resolve FROM the document's own directory; the gates below
    // confine them to the (possibly widened) base.
    let targetAbs = resolvePath(dirAbs, d);
    // A SOURCE route (`code`/`data` `src=`) may instead be written relative to
    // the resolution root — that is how the code-graph profile writes them
    // (`geml-parser/src/attrs.ts` from a document two levels down). So when
    // the document-relative path does not exist and a root was named, try the
    // root as the base. Only a widened `--root` can enable this, and both
    // confinement gates below still apply, so it cannot reach further than a
    // document-relative reference already could.
    if (baseAbs !== dirAbs && !existsSync(targetAbs)) {
      const fromBase = resolvePath(baseAbs, d);
      if (existsSync(fromBase)) targetAbs = fromBase;
    }
    // Cheap lexical gate: reject an obvious `..`/absolute/other-drive escape
    // before touching the filesystem.
    if (outside(baseAbs, targetAbs)) return null;
    // Real (symlink-resolved) gate: a symlink pointing out of the subtree
    // resolves to a real path outside `realBase` and is refused here.
    let realTarget: string;
    try { realTarget = realpathSync(targetAbs); }
    catch { return null; }
    if (outside(realBase, realTarget)) return null;
    try { return readFileSync(realTarget, "utf8"); }
    catch { return null; }
  };
}

// The existence half of the same question, behind the SAME gates. A link may
// point at a directory — `[the extension](integrations/vscode/)` — which has no
// text for `resolverFor` to return but is not a broken link. Answering this
// outside the confinement root would turn link checking into a probe for what
// exists on the machine, so every gate above is repeated rather than skipped.
function existsFor(file: string, root?: string): (d: string) => boolean {
  const read = resolverFor(file, root);
  const dirAbs = resolvePath(file === "-" ? "." : dirname(file));
  const baseAbs = root === undefined ? dirAbs : resolvePath(root);
  let realBase: string | null = null;
  try { realBase = realpathSync(baseAbs); } catch { realBase = null; }
  const outside = (from: string, to: string): boolean => {
    const rel = relative(from, to);
    return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
  };
  return (d) => {
    if (realBase === null) return false;
    // Readable already means it exists; this only has to answer for the rest.
    if (read(d) !== null) return true;
    let targetAbs = resolvePath(dirAbs, d);
    if (baseAbs !== dirAbs && !existsSync(targetAbs)) {
      const fromBase = resolvePath(baseAbs, d);
      if (existsSync(fromBase)) targetAbs = fromBase;
    }
    if (outside(baseAbs, targetAbs)) return false;
    let realTarget: string;
    try { realTarget = realpathSync(targetAbs); } catch { return false; }
    if (outside(realBase, realTarget)) return false;
    return existsSync(realTarget);
  };
}

// Both halves for a parse: every call site wants them together, and pairing
// them here keeps a resolver from being wired up without its existence probe.
function docOpts(file: string, root?: string): { resolveDoc: (d: string) => string | null; docExists: (d: string) => boolean } {
  return { resolveDoc: resolverFor(file, root), docExists: existsFor(file, root) };
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
  const doc = parse(readInput(file), { ...docOpts(file, root), self: file === "-" ? undefined : basename(file) });
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

// Map a thrown error from the history layer to a clean one-line message —
// never a raw node:fs stack trace, and without leaking the absolute path the
// runtime resolved (we report the relative path the user actually passed).
function historyError(e: unknown, file: string, historyPath: string): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") {
    const p = err.path ?? "";
    if (p.endsWith(basename(historyPath))) return `cannot read history ${historyPath}`;
    return `cannot read ${file}`;
  }
  return err?.message ?? String(e);
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
          const { units, all } = selectUnits(text, file, blockSel, `revision ${id}`);
          if (json) {
            // §3.2's tier table: the revision id travels with the block, so the
            // caller can tell WHICH version it is holding.
            const nodes = units.map((u) => unitNode(text, file, u, all));
            console.log(JSON.stringify({ id, block: units.length === 1 ? nodes[0] : nodes }, null, 2));
          } else {
            if (units.length > 1) reportMatches(units[0]!.type ?? "", units);
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
type OutFmt = "json" | "html" | "md" | "geml";

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
  let inFmt: "geml" | "md" | "json";
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

  // md -> geml is a direct projection, not a parse/serialize round-trip: emit
  // the converter's GEML verbatim (the old `convert`; no diagnostics to raise).
  if (inFmt === "md" && outFmt === "geml") {
    const { geml, notes } = mdToGeml(src);
    writeOut(geml, out);
    for (const n of notes) console.error(`note: ${n}`);
    return;
  }

  // Otherwise load a document — a md input is converted to GEML first — and
  // project it to the target.
  let notes: string[] = [];
  let doc: Document;
  if (inFmt === "json") {
    doc = loadModelJson(src, file); // the inverse of `--to json`
  } else if (inFmt === "md") {
    const conv = mdToGeml(src);
    notes = conv.notes;
    doc = parse(conv.geml, { ...docOpts(file, root), self: file === "-" ? undefined : basename(file) });
  } else {
    doc = parse(src, { ...docOpts(file, root), self: file === "-" ? undefined : basename(file) });
  }

  let output: string;
  switch (outFmt) {
    case "json":
      output = JSON.stringify(doc, null, 2) + "\n"; // == the former bare parse
      break;
    case "geml":
      output = serialize(doc); // == the former `fmt`
      break;
    case "html":
      output = renderHtml(doc, {
        source: file === "-" ? "stdin" : basename(file),
        fragment,
        // geml-code-graph embeds load + parse sibling codemap docs on demand.
        loadDoc: resolverFor(file, root),
        parseDoc: (s) => parse(s, { ...docOpts(file, root) }),
      });
      break;
    case "md": {
      const r = gemlToMd(doc); // == the former `export`
      notes = notes.concat(r.notes);
      output = r.md;
      break;
    }
  }

  writeOut(output, out);
  for (const n of notes) console.error(`note: ${n}`);
  for (const d of doc.diagnostics) console.error(`${d.severity}: ${d.message} (line ${d.line})`);
  if (doc.diagnostics.some((d) => d.severity === "error")) process.exit(1);
}

// Load a document-model JSON (the exact output of `--to json`) back into a
// Document, so `--from json --to geml` is the inverse of a prior `--to json`.
// The model is trusted as-is — no re-parse — so a clean round-trip is byte-stable
// with `--to geml`. Anything that is not a document model is refused, and any
// carried diagnostics are preserved (so a broken doc's JSON stays flagged).
function loadModelJson(src: string, file: string): Document {
  let obj: unknown;
  try {
    obj = JSON.parse(src);
  } catch (e) {
    fail(`--from json: ${file === "-" ? "stdin" : file} is not valid JSON (${(e as Error).message})`, 1);
  }
  const d = obj as Partial<Document> | null;
  if (!d || typeof d !== "object" || d.kind !== "document" || !Array.isArray(d.children)) {
    fail(`--from json: not a GEML document-model JSON (expected {"kind":"document","children":[…]})`, 1);
  }
  const doc = d as Document;
  if (!Array.isArray(doc.diagnostics)) doc.diagnostics = [];
  return doc;
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

// Resolve a block SELECTOR to an id. Three spellings address the same block:
//
//   `#intro` / `intro`        the id — the CANONICAL address
//   `## Getting Started`      the heading LINE, copied out of the document
//   `##Getting Started`       …the space after the `#` run is optional
//
// Why more than one form: the id is what `[[#id]]` references, codemap tables
// and URL fragments (§0.6) all carry, so it must stay accepted verbatim — an id
// copied out of a reference or out of `geml get <file>` has to work. But a
// heading's id is AUTO-DERIVED from its text (`## API 设计 (v1)` → `#api-设计-v1`),
// and nobody can be expected to hand-derive that slug for a heading they can
// read on screen. So the heading line itself is accepted too.
//
// Resolution order, first match wins:
//   1. the id, exactly — a pasted id is NEVER reinterpreted as prose. (When a
//      heading's TEXT happens to equal another block's ID, the id wins.)
//   2. the exact heading LINE: `#` count AND text both match.
//   3. the text alone, at any level — a heading remembered at the wrong depth
//      still resolves while its text is unique.
//   4. text shared by several headings: the `#` count picks one, or the
//      candidates are listed. Never guessed at.
function resolveSelector(source: string, file: string, raw: string): string {
  const bare = raw.replace(/^#/, "");
  const m = /^(#{1,6})[ \t]*(.+?)[ \t]*$/.exec(raw);
  if (!m) return bare; // not a `#`-run form: an id, verbatim
  // 1. The id is canonical and always wins. Checked without a parse, so the
  //    common `get #id` stays a byte-slice on a document with diagnostics.
  if (blockSpans(source).has(bare)) return bare;

  const level = m[1]!.length;
  const want = m[2]!;
  const doc = parse(source, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  const heads = doc.ids.flatMap((id) => {
    const site = findBlockSite(doc.children, id);
    const b = site?.siblings[site.index];
    return b?.kind === "heading" ? [{ id, level: b.level, text: b.text.trim() }] : [];
  });
  // 2. exact line — what the caller actually typed.
  const line = heads.find((h) => h.level === level && h.text === want);
  if (line) return line.id;
  // 3. the text alone (exact, then case-insensitive).
  let byText = heads.filter((h) => h.text === want);
  if (!byText.length) {
    const lc = want.toLocaleLowerCase();
    byText = heads.filter((h) => h.text.toLocaleLowerCase() === lc);
  }
  if (byText.length === 1) return byText[0]!.id;
  // 4. shared text: the level disambiguates, else show the candidates.
  if (byText.length > 1) {
    const atLevel = byText.filter((h) => h.level === level);
    if (atLevel.length === 1) return atLevel[0]!.id;
    const list = byText.map((h) => `  #${h.id}  (h${h.level})`).join("\n");
    fail(`\`${want}\` matches ${byText.length} headings — address one by its id:\n${list}`, 1);
  }
  // Nothing matched. A lone `#` with no whitespace was almost certainly meant as
  // an id, so hand it back and let the caller's own `no block with id` error
  // stand — the precise diagnosis for a typo'd id. Only a heading-SHAPED
  // selector gets the heading-flavoured message.
  if (level === 1 && !/\s/.test(bare)) return bare;
  fail(`no id or heading matches \`${raw}\` — run \`geml get ${file === "-" ? "-" : file}\` to list every addressable id`, 1);
}

// `geml get <file>` with no id: list every addressable id — the document's
// table of contents. Default output is one id per line with its kind (and, for
// a heading, its level and text); `--json` is a machine-readable array so an
// agent can pick its next `get #id` target. Ids are listed in document order
// (the registration order parse() records), covering the same set `get #id`
// resolves against: typed blocks and headings. A `[^id]` reference names one
// of those (§5.2); the `[^id]: text` definition line was withdrawn.
function listIds(source: string, file: string, json: boolean): void {
  const where = file === "-" ? "stdin" : file;
  const all = addressedUnits(source);
  const doc = parse(source, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });

  interface Row {
    address: string; kind: string; anon?: boolean; id?: string;
    level?: number; text?: string; lines: [number, number]; footnote?: boolean;
  }
  const rows: Row[] = all.map((a) => {
    const u = a.unit;
    const row: Row = {
      address: shortestAddress(a, all),
      kind: u.kind === "block" ? u.type ?? "block" : u.kind,
      lines: [u.span.start + 1, u.span.end],
    };
    // §6.3: EVERY id-less block is flagged, including one whose address works
    // only because its type happens to be unique (`=== meta`) — that it has no
    // id yet is precisely the fact you might want to act on (§5.2).
    if (u.id === undefined) row.anon = true; else row.id = u.id;
    if (u.kind === "heading") { row.level = u.level; row.text = u.text; }
    // `.footnote` is authored, not synthesized (the `[^id]: text` definition
    // line was withdrawn) — but it still marks a block meant as a footnote.
    if (u.id !== undefined) {
      const site = findBlockSite(doc.children, u.id);
      const b = site?.siblings[site.index];
      if (b?.kind === "block" && b.classes.includes("footnote")) row.footnote = true;
    }
    return row;
  });

  // §6.6: the empty document is a legitimate empty answer to "list everything",
  // not a lookup failure — exit 0, and `--json` prints `[]` so a `| jq length`
  // over a prose-only document does not blow up.
  if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (rows.length === 0) { console.error(`no addressable blocks in ${where}`); return; }

  const addrW = Math.max(...rows.map((r) => r.address.length));
  const kindW = Math.max(...rows.map((r) => r.kind.length));
  // The line range belongs on EVERY row, headings included. It used to be the
  // alternative to a heading's text, so the one kind of block whose range you
  // most want — a whole section — was the one kind that did not print it, and
  // `L11-493` is itself an address you can paste back into `get`. The heading's
  // text follows it rather than replacing it.
  const lineW = Math.max(...rows.map((r) => `L${r.lines[0]}-${r.lines[1]}`.length));
  for (const r of rows) {
    const mark = r.kind === "heading" ? `h${r.level}` : r.anon ? "anon" : "";
    const span = `L${r.lines[0]}-${r.lines[1]}`;
    const tail = r.kind === "heading" ? `${span.padEnd(lineW)}  ${r.text ?? ""}` : span;
    const line = `${r.address.padEnd(addrW)}  ${r.kind.padEnd(kindW)}  ${mark.padEnd(4)}  ${tail}`
      + (r.footnote ? "  footnote" : "");
    console.log(line.trimEnd());
  }
}

// `geml get <file.geml|-> #id [--json]` — print ONE block, addressed by id,
// without loading the rest of the document into context. Default output is the
// block's exact source bytes: a typed block's full `=== … ===` span, a
// footnote's line, or — for a heading — its whole SECTION (heading line through
// the line before the next same-or-higher heading). `--json` covers the same
// content: a block/footnote id prints its document-model node; a heading id
// prints a section envelope `{kind:"section", id, level, blocks:[heading,
// …siblings up to the boundary]}`.
// `geml get <file> '=== <type>'` — address a block by its TYPE. One match is
// the block itself; several are LISTED with their line ranges rather than
// guessed between, so a document with three notes answers "which one" instead
// of failing. The uniqueness that makes `=== meta` work is checked here, at
// resolve time — nothing in the format has to promise a document holds only one.
// Every block of `type` in document order, nested flow children included —
// exactly the span scan's reach and order, so the k-th scan match and the k-th
// model node are the same block. That correspondence is what lets an ANONYMOUS
// block's `--json` find its node without an id to look it up by.
function blocksOfType(blocks: Block[], type: string): Block[] {
  const hits: Block[] = [];
  const walk = (list: Block[]): void => {
    for (const b of list) {
      if (b.kind === "block") {
        if (b.type === type) hits.push(b);
        if (b.children) walk(b.children);
      }
    }
  };
  walk(blocks);
  return hits;
}

// A unit's index among the units of its own type, for the positional lookup above.
function typeIndex(all: Addressed[], u: Unit): number {
  return all.filter((a) => a.unit.type === u.type).findIndex((a) => a.unit === u);
}

// Resolve a NON-list selector to the units it matches, or fail with the reason.
// `where` names the haystack for the error messages — a file for `geml get`, a
// revision for `geml history get`'s tier 2. Shared by both so the one selector
// grammar has one implementation: history's design §10.1 asks for exactly this,
// and its §3.2 records what happened the last time a selector grammar was
// written twice (the printed selectors stopped being readable back).
function selectUnits(source: string, file: string, rawSel: string, where: string): { units: Unit[]; all: Addressed[] } {
  const sel: Selector = parseSelector(rawSel, (braces) => parseAttrs(braces).id);
  // Callers handle the empty selector themselves (list for `get`, usage error
  // for `set`); reaching here with one is a caller bug surfaced as usage.
  if (sel.form === "list") fail(`no selector given — run \`geml get ${where}\` to list addressable blocks`, 2);
  if (sel.form === "attr") {
    // §7: the wording says "not implemented yet", not "braces are meaningless" —
    // §2 declares attribute keys as part of the model, so implementing them
    // later fills in a declared slot rather than reversing this message.
    fail(`only \`#id\` is supported as a filter key today (got \`${sel.key}\`) — use \`=== ${sel.type}\` for every ${sel.type} block, or address one by \`#id\` / \`@<hex>\``, 2);
  }
  const all = addressedUnits(source);

  if (sel.form === "content") {
    const hit = matchContent(sel, all);
    if (!hit.ok) {
      if (hit.why === "wrong-type") {
        // §3.3: the type prefix is a CHECK. Ignoring a wrong one would make it
        // a decoration that is allowed to lie, and would silently accept a
        // hand-edited address.
        fail(`\`@${sel.hex}\` addresses a \`${hit.found}\` block, not \`${sel.type}\` — drop the type prefix to address it by content alone`, 1);
      }
      const suffix = sel.nth ? `~${sel.nth}` : "";
      fail(`no block matching \`@${sel.hex}${suffix}\` in ${where} — a content address goes stale when the block's content changes (that is the point: §3.2); run \`geml get ${where}\` for current addresses`, 1);
    }
    return { units: [hit.unit], all };
  }

  if (sel.form === "line") {
    const hit = matchLine(sel, all);
    // A range that straddles two blocks contains no single unit — say which
    // case it is, because "no match" reads like "your line number is wrong"
    // when the real answer is "that range is not one block".
    if (!hit) {
      const span = sel.from === sel.to ? `L${sel.from}` : `L${sel.from}-${sel.to}`;
      fail(`no block contains ${span} in ${where} — a position selector names ONE block, so a range spanning two of them (or a line past the end) has no answer${discoveryHint(where)}`, 1);
    }
    return { units: [hit], all };
  }

  if (sel.form === "type") {
    const hits = matchType(sel.type, all);
    if (!hits.length) fail(`no \`${sel.type}\` block in ${where}${discoveryHint(where)}`, 1);
    return { units: hits, all };
  }

  // `#id` / bare id / a pasted `## Heading` line — resolveSelector needs a parse
  // to match heading TEXT, so it stays the one path that reaches the model.
  const id = resolveSelector(source, file, sel.raw);
  const unit = all.find((a) => a.unit.id === id)?.unit;
  // Bare `no block with id \`x\`` — the phrasing every caller of a missing id
  // has always seen, and which `set`'s own tests pin. `where` is appended only
  // when it is NOT the file the caller already named (a revision), so the
  // common case reads the same as before this selector grammar existed.
  if (!unit) fail(`no block with id \`${id}\`${where.startsWith("revision ") ? ` in ${where}` : ""}`, 1);
  return { units: [unit], all };
}

// The document-model node for one unit; a heading yields its SECTION envelope,
// so --json covers the same content as the raw span. `kind:"section"` lets a
// consumer branch — every other unit yields the single node (the model is flat).
function unitNode(source: string, file: string, unit: Unit, all: Addressed[]): unknown {
  const doc = parse(source, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  if (unit.id !== undefined) {
    const site = findBlockSite(doc.children, unit.id);
    if (!site) fail(`no block with id \`${unit.id}\``, 1);
    const block = site.siblings[site.index]!;
    if (block.kind !== "heading") return block;
    const end = sectionEndIndex(site.siblings, site.index);
    return { kind: "section", id: block.id, level: block.level, blocks: site.siblings.slice(site.index, end) };
  }
  const node = blocksOfType(doc.children, unit.type ?? "")[typeIndex(all, unit)];
  if (!node) fail(`could not locate the \`${unit.type}\` block in the document model`, 1);
  return node;
}

// stderr line for an N-match selector: content stays on stdout, so a redirect
// captures document bytes only, and the caller still learns how many it got (§5).
function reportMatches(type: string, units: Unit[]): void {
  const at = units.map((u) => `L${u.span.start + 1}-${u.span.end}${u.id ? ` #${u.id}` : ""}`).join(" · ");
  console.error(`${units.length} \`${type}\` blocks (${at})`);
}

// `geml get <file.geml|-> [<selector>] [--head|--body] [--json]` — read the
// document's addressable structure, or one/several blocks out of it.
//
// The selector is a FILTER (§2 of the get/set selector design): no selector
// LISTS every addressable block with its shortest unique address; `#id` /
// `## Heading` / `=== type@<hex>` name at most one; `=== type` matches 0..N.
// Cardinality is uniform (§5): 0 → exit 1, 1 → the content, N → N contents in
// document order with the count on stderr. `--head`/`--body` narrow to one part
// of each match, and every flag combination that used to be half-honoured is
// now a usage error (§7) — a discarded flag is a command that quietly did
// something else.
// `geml list <file>` — the same listing `get` prints with no selector, under
// the name the MCP surface has always used for it (`geml_list`). One operation
// had two names across two surfaces; this makes the CLI agree with the tool
// descriptions agents are already reading. `get <file>` keeps working.
function runList(args: string[]): void {
  const [file, extra] = positionals(args, ["--root"]);
  if (!file) fail(SUBHELP.list);
  // `list` IS the empty filter, so a selector here means the caller wanted
  // `get`. Naming the command they meant beats ignoring the argument.
  if (extra !== undefined) {
    fail(`\`list\` takes no selector — it lists every block. To read one: \`geml get ${file} '${extra}'\``, 2);
  }
  listIds(readInput(file), file, args.includes("--json"));
}

// Walk for `.geml` files. Depth-first, sorted, so output order is stable across
// platforms — a listing that reorders between machines is a listing nobody can
// diff. Hidden directories and `node_modules` are skipped: a search verb that
// dredges up vendored copies trains people to stop reading its output.
// `explicit` marks a path the caller NAMED, as opposed to one this walk found.
// A named file is searched whatever it is called: `get` and `list` already read
// a `.md` this way, and having only `find` refuse meant
// `geml find GEML README.md` exited 1 against a file holding forty-four
// matches — a search that answers "no" about a file you pointed straight at.
// The `.geml` filter belongs to the DIRECTORY walk, where taking every file
// would drag the whole source tree through the parser.
function gemlFilesUnder(path: string, out: string[], explicit = false): void {
  let dir = false;
  try { dir = statSync(path).isDirectory(); } catch { return; }
  if (!dir) { if (explicit || path.endsWith(".geml")) out.push(path); return; }
  for (const e of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    gemlFilesUnder(join(path, e.name), out);
  }
}

// `geml find <pattern> [path…]` — search block CONTENT, print ADDRESSES.
//
// This is the half of the workflow that had no verb. `geml list` says what is
// addressable and `geml get` reads one block, but "which block mentions X" fell
// back to `grep -n`, which answers in line numbers — and a line number stops
// being true the moment anything above it changes. `codemap find` already
// resolves a substring to `doc#id` for symbols; this is the same move for prose.
function runFind(args: string[]): void {
  const pos = positionals(args, []);
  const pattern = pos[0];
  if (pattern === undefined) fail(SUBHELP.find);
  const sensitive = args.includes("--case");
  const withLine = args.includes("--head");
  const json = args.includes("--json");
  const needle = sensitive ? pattern : pattern.toLowerCase();

  const files: string[] = [];
  const named = pos.slice(1);
  for (const p of named.length ? named : ["."]) gemlFilesUnder(p, files, named.length > 0);

  interface Hit { file: string; address: string; kind: string; lines: [number, number]; line?: string }
  const hits: Hit[] = [];
  for (const f of files) {
    let source: string;
    // An unreadable file mid-walk must not abort the search — report nothing
    // for it and keep going, the way every search tool behaves.
    try { source = readFileSync(f, "utf8"); } catch { continue; }
    const all = addressedUnits(source);
    // Match by LINE, then resolve each line to the innermost unit holding it —
    // exactly what the `L` selector does, so `find` is `grep` composed with
    // `L` rather than a second notion of "which block is this in". Testing the
    // units directly instead would report every ancestor: a heading's span
    // covers its whole section, so the h1 spans the file and would match every
    // search ever run.
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const seen = new Map<string, Hit>();
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      if (!(sensitive ? raw : raw.toLowerCase()).includes(needle)) continue;
      const unit = matchLine({ form: "line", from: i + 1, to: i + 1 }, all);
      if (!unit) continue;
      const a = all.find((x) => x.unit === unit)!;
      const address = shortestAddress(a, all);
      // One unit, one hit, however many lines inside it matched — a search that
      // reports the same block eight times is a search you stop reading.
      const key = `${a.unit.span.start}:${a.unit.span.end}`;
      if (seen.has(key)) continue;
      const hit: Hit = {
        file: f,
        address,
        kind: unit.kind === "block" ? unit.type ?? "block" : unit.kind,
        lines: [unit.span.start + 1, unit.span.end],
      };
      if (withLine) hit.line = raw.trim();
      seen.set(key, hit);
      hits.push(hit);
    }
  }

  if (json) {
    console.log(JSON.stringify(hits, null, 2));
  } else {
    for (const h of hits) {
      // Two columns, `file` then the address EXACTLY as the listing prints it,
      // so a hit is `geml get <col1> '<col2>'` with no editing. Not glued into
      // one `file#addr` token: an id-less block's address is `=== code@a3f9`,
      // which has a space in it and can never be one token — and a format that
      // is only pasteable for half the rows is worse than one that is uniform.
      const row = `${h.file}\t${h.address}`;
      console.log(withLine && h.line !== undefined ? `${row}\t${h.line}` : row);
    }
  }
  // Exit 1 on no match, like grep: it makes `if geml find …; then` mean what a
  // shell author expects. An empty `--json` array still prints, so a JSON
  // consumer sees `[]` rather than nothing.
  if (!hits.length) process.exit(1);
}

function runGet(args: string[]): void {
  const json = args.includes("--json");
  const headOnly = args.includes("--head");
  const bodyOnly = args.includes("--body");
  const introOnly = args.includes("--intro");
  const view = args.includes("--view");
  const [file, rawSel] = positionals(args, ["--root"]);
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
  const sel: Selector = parseSelector(rawSel, (braces) => parseAttrs(braces).id);

  if (sel.form === "list") {
    // §5.1: nothing here to narrow, and ignoring the flag would make
    // `get f --head` print byte-for-byte what `get f` prints.
    if (partFlag) {
      fail(`${partFlag} names part of ONE block, so it needs a selector — run \`geml list ${where}\` to see what to address`, 2);
    }
    listIds(source, file, json);
    return;
  }
  const { units, all } = selectUnits(source, file, rawSel!, where);
  // The chain is composed with `/` — relJoinPath's rule, and `src=` values are
  // always `/`-separated — so normalize the PLATFORM path at this boundary. On
  // Windows `sub\host.geml` otherwise has no directory as far as relDirPath can
  // tell, and a relative `src=` resolves against the wrong base.
  const startDoc = where.replace(/\\/g, "/");
  const viewRoot = flag(args, "--root") ?? (relDirPath(startDoc) || ".");
  if (json) {
    // §7: N matches yield N model nodes. The old `{kind:"blocks",
    // matches:[{lines}]}` coordinate envelope is gone — it answered "where are
    // they" when the question is "what are they" (§9 change 2).
    let nodes: unknown[];
    try {
      nodes = units.flatMap((u) => {
        if (!view) return [unitNode(source, file, u, all)];
        return viewResolve(source, startDoc, u, viewRoot).map((res) => {
          const node = unitNode(res.text, res.doc, res.unit, res.all) as Record<string, unknown>;
          // Provenance is mandatory (§4): the node's references and relative
          // paths resolve against ITS document, not the one asked about. A
          // whole-document target has no `#`, so it carries `doc` alone.
          if (res.from !== "") {
            const h = res.from.lastIndexOf("#");
            node["from"] = h < 0 ? { doc: res.from }
                                 : { doc: res.from.slice(0, h), id: res.from.slice(h + 1) };
          }
          return node;
        });
      });
    } catch (e) {
      if (e instanceof ViewError) fail(e.message, 1);
      throw e;
    }
    console.log(JSON.stringify(nodes.length === 1 ? nodes[0] : nodes, null, 2));
    return;
  }
  if (units.length > 1) reportMatches(units[0]!.type ?? "", units);
  if (view) {
    // All-or-nothing (§3.3): resolve EVERYTHING before writing a byte, so a
    // chain that breaks halfway cannot leave a partial read on stdout for a
    // caller that ignores the exit code. Partial scenery is not scenery.
    const out: string[] = [];
    const notes: string[] = [];
    try {
      for (const u of units) {
        for (const res of viewResolve(source, startDoc, u, viewRoot)) {
          if (res.from !== "") notes.push(`view: ${rawSel} -> ${res.from}`);
          out.push(sliceUnit(res.text, res.unit.span, part));
        }
      }
    } catch (e) {
      // A chain that cannot reach an entity block is a failed READ, reported the
      // way `get` reports a selector that matches nothing: one line, exit 1.
      if (e instanceof ViewError) fail(e.message, 1);
      throw e;
    }
    for (const n of notes) console.error(n);
    process.stdout.write(out.join(""));
    return;
  }
  // A block has no intro: the region is "what this heading says before its
  // first subheading", and only a heading has subheadings. Silently handing
  // back the body instead would answer a question that was not asked.
  for (const u of units) {
    if (part === "intro" && u.kind !== "heading") {
      fail(`--intro names a heading's opening region, and \`${rawSel}\` is a \`${u.type ?? u.kind}\` block — use --body for a block's content`, 2);
    }
  }
  for (const u of units) process.stdout.write(sliceUnit(source, u.span, part));
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
  const [file, oldText, newText] = positionals(args, ["-o", "--out", "--within"]);
  if (!file || oldText === undefined || newText === undefined) fail(SUBHELP.replace);
  if (oldText === "") fail("the text to replace is empty — that would match everywhere", 2);

  const source = readInput(file);
  const where = file === "-" ? "stdin" : file;
  const all = addressedUnits(source);

  // Scope: the whole document, or every block a selector matches. Several
  // matches are fine here — `replace … --within '=== table'` meaning "in all
  // the tables" is the useful reading, and unlike `set` there is no ambiguity
  // about which one receives the write.
  const lines = splitLines(source);
  const lineStart: number[] = [];
  { let at = 0; for (const l of lines) { lineStart.push(at); at += l.length; } }
  let scopes: { from: number; to: number }[];
  if (within === undefined) {
    scopes = [{ from: 0, to: source.length }];
  } else {
    // `selectUnits` already refuses a selector that matches nothing, with the
    // message the other verbs give, so there is no empty case to handle here.
    const { units } = selectUnits(source, file, within, where);
    scopes = units.map((u) => ({
      from: lineStart[u.span.start]!,
      to: u.span.end >= lineStart.length ? source.length : lineStart[u.span.end]!,
    }));
  }

  // Find every occurrence inside the scopes, right to left, so replacing one
  // cannot move the ones not yet done.
  const hits: number[] = [];
  for (const s of scopes) {
    let at = source.indexOf(oldText, s.from);
    while (at !== -1 && at + oldText.length <= s.to) {
      hits.push(at);
      at = source.indexOf(oldText, at + oldText.length);
    }
  }
  hits.sort((a, b) => a - b);
  if (hits.length === 0) {
    // Exit 1 like `find`, so `if geml replace …` means what it looks like.
    fail(`\`${oldText}\` does not occur in ${within === undefined ? where : `\`${within}\` of ${where}`} — nothing written`, 1);
  }

  let updated = source;
  for (const at of [...hits].reverse()) {
    updated = updated.slice(0, at) + newText + updated.slice(at + oldText.length);
  }

  // Which blocks were touched — the report has to speak in addresses, or this
  // is just `sed` with a longer name.
  const lineOf = (off: number): number => {
    let lo = 0, hi = lineStart.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid]! <= off) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const touched = new Set<string>();
  for (const at of hits) {
    const ln = lineOf(at);
    let best: Addressed | undefined;
    for (const a of all) {
      if (a.unit.span.start <= ln && ln < a.unit.span.end) {
        if (!best || (a.unit.span.end - a.unit.span.start) < (best.unit.span.end - best.unit.span.start)) best = a;
      }
    }
    if (best) touched.add(shortestAddress(best, all));
  }

  // An id is not text to be swapped: changing one silently cuts every reference
  // to it, which is precisely what `rename` exists to do properly.
  const before = parse(source, { ...docOpts(file) });
  const after = parse(updated, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  const goneIds = before.ids.filter((x) => !new Set(after.ids).has(x));
  const newIds = after.ids.filter((x) => !new Set(before.ids).has(x));
  if (goneIds.length && newIds.length) {
    fail(`that would rename \`#${goneIds[0]}\` to \`#${newIds[0]}\` — an id is not text: use \`geml rename ${where} '#${goneIds[0]}' '#${newIds[0]}'\`, which fixes every reference too. Nothing written`, 2);
  }

  const errs = after.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    refuseBroken(`the replacement would break the document: ${errs[0]!.message} (line ${errs[0]!.line}); nothing written`, errs);
  }

  // Blocks the replacement removed follow `set`'s rule: carried out, and named.
  const droppedAnon = Math.max(0, countBlockUnits(source) - countBlockUnits(updated) - goneIds.length);
  if (goneIds.length || droppedAnon) {
    const named = goneIds.map((x) => `\`#${x}\``).join(", ");
    const anon = droppedAnon ? `${droppedAnon} unnamed block${droppedAnon > 1 ? "s" : ""}` : "";
    console.error(`dropped ${[named, anon].filter(Boolean).join(" and ")} — run 'geml revert' to put them back`);
  }

  resolveOutTarget(file, out).write(updated);
  const list = [...touched].join(", ");
  console.error(`replaced ${hits.length} occurrence${hits.length > 1 ? "s" : ""}${list ? ` in ${list}` : ""}`);
}

const NO_CONTENT = "no replacement content (use --in FILE or pipe it on stdin)";

// `geml set <file.geml|-> #id [--head|--body] [--in F|F#src|-] [-o out]` —
// replace ONE existing block, addressed by #id, with new content, preserving
// every other byte. Two content CHANNELS × three MODES:
//
//   channels · `--in F[#src]` extracts a BLOCK from GEML file F (F is always
//              read as GEML — extension ignored, no md conversion): `--in F`
//              takes the block whose id == the target #id; `--in F#src` takes
//              #src. stdin (default, or `--in -`) is raw bytes.
//   modes    · default replaces the WHOLE block, `--head` only the head line,
//              `--body` only the body. Default and `--head` NORMALIZE the
//              content's id to #id (its source id is irrelevant); `--body`
//              keeps the target's head verbatim, so #id is preserved naturally.
//
// Output follows resolveOutTarget (file -> in place, stdin -> stdout, `-o`/`-o -`
// override) and every splice is guarded — re-parsed and rejected if it broke
// the doc, so `set` never writes a corrupt file.
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
  const [file, rawSel] = positionals(args, ["-o", "--out", "--in"]);
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
  const target = resolveSetTarget(source, file, rawSel);

  if (introOnly) { runSetIntro(source, target, from, rawChannel, file, out); return; }
  if (bodyOnly) { runSetBody(source, target, from, rawChannel, file, out); return; }

  let content: string;
  if (rawChannel) {
    content = readInput("-");
    if (content === "") fail(NO_CONTENT, 1);
    // Default mode wants exactly ONE block. Pure prose has no head to carry the
    // id (steer to --body); multiple blocks are `add`'s job. --head takes a
    // lone head line, so it skips the whole-block shape check.
    if (!headOnly) {
      const shape = contentShape(content);
      if (shape === "empty") fail(NO_CONTENT, 1);
      if (shape === "prose") fail(`content is prose, not a block — use --body to set the body of ${target.label}`, 1);
      if (shape === "multi") fail("set replaces ONE block, but the content has multiple blocks (use add)", 1);
    }
  } else {
    content = extractBlock(from!, target.unit.id ?? "", headOnly ? "head" : "whole");
  }
  // §5.2: `@<hex>` is not an id, so "normalize the content's id to the target's"
  // has no subject — the content is used verbatim, and an id it brings that
  // collides is caught by the splice guard like any other. An id target keeps
  // normalizing: naming an id on the command line IS the instruction that the
  // result carries that id (block-mutation design §4.0).
  const replacement = target.unit.id !== undefined ? normalizeBlockId(content, target.unit.id) : content;
  const updated = spliceSpan(source, target.unit.span, replacement, file, headOnly, false, target.unit.id);
  resolveOutTarget(file, out).write(updated);
  reportNewAddress(updated, target);
}

// A `set` target: exactly one unit, plus how the caller named it (for messages)
// and whether it was named by content address (which §5.3 reports back).
interface SetTarget { unit: Unit; label: string; byContent: boolean }

// Resolve a selector to the ONE unit `set` will overwrite. `get` may answer with
// N blocks; `set` may not — §5: with N targets there is no single id to
// normalize the content to, so multi-target `set` is undefined, not merely
// risky. Refused with exit 2 (a usage error), not exit 1.
function resolveSetTarget(source: string, file: string, rawSel: string): SetTarget {
  const where = file === "-" ? "<file>" : file;
  const sel: Selector = parseSelector(rawSel, (braces) => parseAttrs(braces).id);
  if (sel.form === "list") fail(`no selector given — run 'geml get ${where}' to list addressable blocks`, 2);
  const { units, all } = selectUnits(source, file, rawSel, where);

  if (units.length > 1) {
    // §5: with N targets there is no single id to normalize the content to, so
    // multi-target `set` is UNDEFINED, not merely risky. The addresses are
    // printed because they ARE the fix — each is unique and pastes straight
    // back into this same command (§6.2).
    const opts = units.map((u) => {
      const a = all.find((x) => x.unit === u)!;
      return `  ${shortestAddress(a, all)}  L${u.span.start + 1}-${u.span.end}`;
    }).join("\n");
    fail(`\`${rawSel.trim()}\` matches ${units.length} blocks — set writes ONE; address it uniquely:\n${opts}`, 2);
  }
  const unit = units[0]!;
  const label = unit.id !== undefined && sel.form === "id" ? `#${unit.id}` : `\`${rawSel.trim()}\``;
  return { unit, label, byContent: sel.form === "content" };
}

// §5.3: writing through a content address CHANGES it, so print the new one —
// otherwise a script editing the same block twice has to re-list in between.
// stderr, because stdout may be the document itself (`-o -`).
function reportNewAddress(updated: string, target: SetTarget): void {
  if (!target.byContent) return;
  const after = addressedUnits(updated).find((a) => a.unit.span.start === target.unit.span.start);
  if (after) console.error(`new address: ${shortestAddress(after, addressedUnits(updated))}`);
}

// `--body`: swap ONLY the target block's body, keeping its head (and #id) and,
// for a typed block, its close fence. Assembles head + new body + close and
// reuses the guarded spliceBlock — the head carries #id, so the id survives
// with no normalization needed.
// `set --intro` — replace only what a heading says before its first subheading.
// The heading line and everything from that subheading down stay byte-identical,
// which is the whole point: the region `get --intro` hands out is the region
// `set --intro` puts back, so a read-edit-write round trip cannot swallow the
// subsections. When the region is EMPTY (a subheading follows the heading
// immediately) this inserts there — writing an opening for a section that had
// none is the same operation as replacing one that did.
function runSetIntro(source: string, target: SetTarget, from: string | undefined, rawChannel: boolean, file: string, out: string | undefined): void {
  if (target.unit.kind !== "heading") {
    fail(`--intro names a heading's opening region, and \`${target.label}\` is a \`${target.unit.type ?? target.unit.kind}\` block — use --body for a block's content`, 2);
  }
  const region = narrowToIntro(source, target.unit.span);
  let body = rawChannel ? readInput("-") : extractBlock(from!, target.unit.id ?? "", "body");
  if (rawChannel && body === "") fail(NO_CONTENT, 1);
  body = toLf(body);
  if (body !== "" && !body.endsWith("\n")) body += "\n";

  // Give the opening its blank lines back. `get --intro` hands the region over
  // WITH the blank lines that separated it, so round-tripping that text lands
  // byte-identical and this adds nothing. Content typed by hand has no such
  // padding, and without it the result fuses: `# H1` then the text then `## H2`
  // on consecutive lines. `add` already settled this — one blank separator on
  // a side whose neighbour is not blank — so the two agree.
  const around = splitLines(source);
  const blankLine = (s: string | undefined) => s === undefined || stripEol(s).trim() === "";
  if (body !== "" && !blankLine(body.split("\n")[0])) body = "\n" + body;
  // A following heading needs the separation; end-of-document does not.
  if (body !== "" && region.end < around.length && !blankLine(body.split("\n").slice(-2)[0])) body += "\n";
  const updated = spliceSpan(source, region, body, file, false, false, target.unit.id);
  resolveOutTarget(file, out).write(updated);
  reportNewAddress(updated, target);
}

function runSetBody(source: string, target: SetTarget, from: string | undefined, rawChannel: boolean, file: string, out: string | undefined): void {
  const found = target.unit.span;
  const lines = splitLines(source);
  const headLine = lines[found.start] ?? "";

  // A typed block keeps its closing fence; a heading section has none. Decided
  // by the same helper `get --body` uses, so the two agree on the span and the
  // §4 round-trip invariant holds.
  const closeLine = closeFenceLine(lines, found);

  let body: string;
  if (rawChannel) {
    body = readInput("-");
    if (body === "") fail(NO_CONTENT, 1);
  } else {
    body = extractBlock(from!, target.unit.id ?? "", "body");
  }

  let head = headLine;
  if (head !== "" && !/(\r\n|\r|\n)$/.test(head)) head += "\n";
  let b = toLf(body);   // spliceBlock converts the result to the document's style
  if (closeLine !== null && b !== "" && !b.endsWith("\n")) b += "\n";
  const replacement = closeLine !== null ? head + b + closeLine : head + b;

  // A typed block (closeLine !== null) must stay ONE block: enforce the
  // block-count invariant so a `===` fence in the raw body can't close it early
  // and inject siblings (SEC F2). A heading section body has no close fence and
  // may legitimately contain blocks, so it is not count-guarded.
  const updated = spliceSpan(source, found, replacement, file, false, closeLine !== null, target.unit.id);
  resolveOutTarget(file, out).write(updated);
  reportNewAddress(updated, target);
}

// `geml add <file|-> (--append | --before #x | --after #x) [--in F|F#src|-] [-o]`
// — insert a GEML fragment (1+ blocks and/or prose) at a position. Unlike `set`,
// `add` names no target id, so content keeps its OWN ids (no normalization); an
// id colliding with the document (or duplicated within the fragment) makes the
// re-parse fail and nothing is written. Bare prose is a valid fragment.
function runAdd(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const from = flag(args, "--in");
  const before = flag(args, "--before");
  const after = flag(args, "--after");
  const append = args.includes("--append");
  const posCount = (append ? 1 : 0) + (before !== undefined ? 1 : 0) + (after !== undefined ? 1 : 0);
  if (posCount !== 1) fail("add needs exactly one position: --append | --before #id | --after #id", 2);
  const [file] = positionals(args, ["-o", "--out", "--in", "--before", "--after"]);
  if (!file) fail(SUBHELP.add);

  const rawChannel = from === undefined || from === "-";
  if (file === "-" && rawChannel) fail("reading the document from stdin needs --in for the new content", 2);
  const source = readInput(file);

  // Content: --in F#src -> block #src; --in F -> all of F (a multi-block
  // fragment is fine here); stdin -> raw. No id-normalization: add keeps ids.
  let content: string;
  if (rawChannel) content = readInput("-");
  else if (from!.includes("#")) content = extractBlock(from!, "", "whole");
  else content = readInput(from!);
  if (content.trim() === "") fail("no content to add (use --in FILE or pipe it on stdin)", 1);

  // Resolve the physical-line insertion point.
  const lines = splitLines(source);
  let at: number;
  if (append) {
    at = lines.length;
  } else {
    const anchorId = (before ?? after)!.replace(/^#/, "");
    const span = blockSpans(source).get(anchorId);
    if (!span) fail(`no block with id \`${anchorId}\` in ${file === "-" ? "stdin" : file}`, 1);
    at = before !== undefined ? span.start : span.end;
  }

  const updated = insertFragment(source, lines, at, content, file);
  resolveOutTarget(file, out).write(updated);
}

// Splice `fragment` into `source` at physical-line index `at` (splitLines
// coords), separating it from adjacent content with a single blank line so
// blocks don't fuse, then GUARD: the re-parse must be error-free (a colliding
// or duplicate id surfaces as an error diagnostic) and no pre-existing id may
// vanish. Returns the updated text; on any violation fail()s and writes nothing.
function insertFragment(source: string, lines: string[], at: number, fragment: string, file: string): string {
  const beforeIds = parse(source, { ...docOpts(file), self: file === "-" ? undefined : basename(file) }).ids;
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  const nl = newlineOf(source);   // the fragment AND every separator we add
  // The preceding line must end in a newline so the fragment starts on its own.
  if (before.length && !/(\r\n|\r|\n)$/.test(before[before.length - 1]!)) {
    before[before.length - 1] += nl;
  }
  let frag = toNewline(fragment, nl);
  if (!frag.endsWith("\n")) frag += nl;
  // A single blank separator on each side that has adjacent content and isn't
  // already blank — keeps a following head / preceding block from fusing.
  const blank = (s: string) => stripEol(s).trim() === "";
  const sepBefore = before.length && !blank(before[before.length - 1]!) ? nl : "";
  const sepAfter = after.length && !blank(after[0]!) ? nl : "";
  const updated = before.join("") + sepBefore + frag + sepAfter + after.join("");

  const reparsed = parse(updated, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  const errs = reparsed.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    const first = errs[0]!;
    refuseBroken(`adding the content would break the document: ${first.message} (line ${first.line}); not written`, errs);
  }
  const now = new Set(reparsed.ids);
  const dropped = beforeIds.find((x) => !now.has(x));
  if (dropped !== undefined) fail(`adding the content would drop block \`#${dropped}\`; not written`, 1);
  return updated;
}

// `geml delete <file|-> #id [#id2 …] [-o]` — remove one or more blocks. A
// missing id is SKIPPED with a note (declarative "ensure absent", not an
// error). Unlike set/add, delete's write is LENIENT: removing a complete block
// can't break the parse structurally, but it may leave a reference dangling —
// that is a WARNING, never a refusal (delete is reversible via revert + history,
// and `geml check` still flags the dangling ref afterward). Contained/overlapping
// spans (a nested block inside a deleted heading section) are handled by deleting
// the UNION of target lines, so a line is never spliced twice.
function runDelete(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const pos = positionals(args, ["-o", "--out"]);
  const file = pos[0];
  if (!file) fail(SUBHELP.delete);
  const ids = pos.slice(1).map((s) => s.replace(/^#/, ""));
  if (ids.length === 0) fail("delete needs at least one #id (run 'geml get <file>' to list ids)", 2);

  const source = readInput(file);
  const spans = blockSpans(source);
  const toDelete = new Set<number>();
  let found = 0;
  for (const id of ids) {
    const span = spans.get(id);
    if (!span) { console.error(`skipped #${id}: no such block`); continue; }
    found++;
    for (let i = span.start; i < span.end; i++) toDelete.add(i);
  }
  if (found === 0) { resolveOutTarget(file, out).write(source); return; } // nothing to remove

  const updated = splitLines(source).filter((_, i) => !toDelete.has(i)).join("");
  // Lenient guard: surface any resulting error diagnostic (a reference now
  // dangling) as a WARNING, but write regardless.
  const reparsed = parse(updated, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  for (const d of reparsed.diagnostics.filter((x) => x.severity === "error")) {
    console.error(`warning: ${d.message} (line ${d.line}) — left dangling by delete; run 'geml check' to see it as an error`);
  }
  resolveOutTarget(file, out).write(updated);
}

// `geml rename <file|-> #old #new [-o]` — the one verb that reaches OUTSIDE a
// block: it rewrites #old's declaration AND every reference to it. #new must be
// free; the guarded re-parse refuses anything that would break the doc.
function runRename(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const [file, rawOld, rawNew] = positionals(args, ["-o", "--out"]);
  if (!file || !rawOld || !rawNew) fail(SUBHELP.rename);
  const oldId = rawOld.replace(/^#/, "");
  const newId = rawNew.replace(/^#/, "");
  if (oldId === newId) fail("#old and #new are the same id — nothing to rename", 2);

  const source = readInput(file);
  const before = parse(source, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  if (!before.ids.includes(oldId)) fail(`no block with id \`${oldId}\``, 1);
  if (before.ids.includes(newId)) fail(`id \`${newId}\` already exists; not written`, 1);

  // Renaming an id that has recorded history breaks the revert-lineage for it
  // (revert keys by id and can't follow #old -> #new across the boundary). Warn
  // so the user knows a later `revert #new` won't reach pre-rename revisions.
  if (file !== "-") {
    const hp = historyPathFor(file);
    if (existsSync(hp)) {
      try {
        if (blockSpans(resolveContent(hp, "0").text).has(oldId)) {
          console.error(`warning: #${oldId} has history; revert across this rename is not tracked — see docs`);
        }
      } catch { /* unreadable/empty history: no warning */ }
    }
  }

  const updated = rewriteId(source, oldId, newId, file);
  const reparsed = parse(updated, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  const errs = reparsed.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) { const e = errs[0]!; refuseBroken(`rename would break the document: ${e.message} (line ${e.line}); not written`, errs); }
  if (!reparsed.ids.includes(newId)) fail(`rename did not produce #${newId}; not written`, 1);
  if (reparsed.ids.includes(oldId)) fail(`#${oldId} still present after rename; not written`, 1);
  // Every OTHER id must be untouched. The `#old` match boundary treats a char
  // outside [A-Za-z0-9_-] as an id terminator, but ids may contain e.g. `.`
  // (`#foo.bar`), so renaming `#foo` could silently rewrite the *different* id
  // `#foo.bar` -> `#baz.bar`. Reject when the set of ids other than the rename
  // pair changed at all (SEC/correctness: collateral id corruption).
  const othersBefore = before.ids.filter((id) => id !== oldId).sort().join("\n");
  const othersAfter = reparsed.ids.filter((id) => id !== newId).sort().join("\n");
  if (othersBefore !== othersAfter) {
    fail(`rename would also change other ids sharing the \`${oldId}\` prefix (e.g. \`#${oldId}…\`); not written`, 1);
  }
  resolveOutTarget(file, out).write(updated);
}

// Rewrite id `old` -> `new` everywhere it is a declaration or reference, id-
// boundary-safe: `#old` is replaced only when NOT followed by an id char, so a
// longer id like `#old2` / `#old-x` is untouched. Covers the declaration
// (`{#old …}`, labeled close `=== #old`), block references (`[[#old]]`,
// `[t](#old)`, chart `data=#old`) and footnotes (`[^old]`). RAW / data block
// BODIES (code/diagram/math/table/meta) are skipped — a `#old` there is literal
// text, not a reference. (Known residual: id-less raw bodies and inline
// code/math spans in flow content — see design §8.)
function rewriteId(source: string, oldId: string, newId: string, file: string): string {
  const doc = parse(source, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  const spans = blockSpans(source);
  const protectedLines = new Set<number>();
  for (const b of doc.children) {
    if (b.kind === "block" && (b.mode === "raw" || b.mode === "data") && b.id) {
      const span = spans.get(b.id);
      if (span) { const br = bodyRange(source, span); for (let i = br.start; i < br.end; i++) protectedLines.add(i); }
    }
  }
  const esc = reLit(oldId);
  const hashRe = new RegExp(`#${esc}(?![A-Za-z0-9_-])`, "g");
  const fnRe = new RegExp(`(\\[\\^)${esc}(?![A-Za-z0-9_-])`, "g");
  const lines = splitLines(source);
  for (let i = 0; i < lines.length; i++) {
    if (protectedLines.has(i)) continue;
    lines[i] = lines[i]!.replace(hashRe, `#${newId}`).replace(fnRe, `$1${newId}`);
  }
  return lines.join("");
}

// Extract one block from a GEML file for `--in`. `spec` is `F` (block whose id
// == the target) or `F#src` (block #src) — the last `#` splits path from id, so
// a `#` inside the path is tolerated; F is read as GEML regardless of extension
// (blockSpans + splitLines, no parse — same slice `geml get` prints). `part`
// selects the whole span, its head line, or its body. A missing file or absent
// id is an operation error (exit 1); the caller writes nothing.
function extractBlock(spec: string, targetId: string, part: "whole" | "head" | "body"): string {
  const hash = spec.lastIndexOf("#");
  const fragFile = hash >= 0 ? spec.slice(0, hash) : spec;
  const fragId = hash >= 0 ? spec.slice(hash + 1).replace(/^#/, "") : targetId;
  let text: string;
  try { text = readFileSync(fragFile, "utf8"); }
  catch { fail(`cannot read ${fragFile}`, 1); }
  const span = blockSpans(text).get(fragId);
  if (!span) fail(`no block with id \`${fragId}\` in ${fragFile}`, 1);
  const lines = splitLines(text);
  if (part === "head") return lines.slice(span.start, span.start + 1).join("");
  if (part === "body") { const b = bodyRange(text, span); return lines.slice(b.start, b.end).join(""); }
  return lines.slice(span.start, span.end).join("");
}

// Strip a single trailing terminator (`\r\n`, `\r`, or `\n`) from one line.
// One flag's value out of argv — the CLI's own tiny parser.
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}


// The body sub-range of a block span: [head+1, close) for a closed typed block,
// otherwise [head+1, end) — a heading section (no close fence) or an
// unterminated block whose span already runs to end-of-scope.
function bodyRange(text: string, span: Span): Span {
  const lines = splitLines(text);
  const open = FENCE_OPEN.exec(stripEol(lines[span.start] ?? ""));
  if (open) {
    const lastText = trimSpaceTabEnd(stripEol(lines[span.end - 1] ?? ""));
    const bid = open[3] ? parseAttrs(open[3]).id : undefined;
    const labeled = bid !== undefined && new RegExp(`^={3,}[ \\t]+#${reLit(bid)}[ \\t]*$`).test(lastText);
    const closed = isCloseFence(lastText, open[1]!.length) || labeled;
    return { start: span.start + 1, end: closed ? span.end - 1 : span.end };
  }
  return { start: span.start + 1, end: span.end };
}

// The shape of default-mode stdin content, section-aware: a heading OWNS its
// section (`# H …blocks…` is ONE unit, not many), matching sectionEnd/blockSpans.
// Used to reject pure prose (-> --body) and multi-block content (-> add) before
// the splice — extraction via --in is inherently one block and skips this.
function contentShape(content: string): "empty" | "prose" | "single" | "multi" {
  const bs = parse(content).children;
  let blockUnits = 0, proseUnits = 0, i = 0;
  while (i < bs.length) {
    const b = bs[i]!;
    if (b.kind === "heading") { i = sectionEndIndex(bs, i); blockUnits++; }
    else if (b.kind === "block") { i++; blockUnits++; }
    else { i++; proseUnits++; }
  }
  if (blockUnits === 0) return proseUnits === 0 ? "empty" : "prose";
  return blockUnits + proseUnits === 1 ? "single" : "multi";
}

// Replace block #id's source span in `source` with `replacement`, preserving
// every other byte, and GUARD the result: the re-parse must be error-free, #id
// must survive, and no other pre-existing id may vanish (a malformed replacement
// can silently swallow a neighbour). Returns the updated document text; on any
// violation it calls fail() and never returns a corrupt document. Shared by
// `set` and `revert`.
function spliceBlock(source: string, id: string, replacement: string, file: string, headOnly = false, guardCount = false): string {
  const found = blockSpans(source).get(id);
  if (!found) fail(`no block with id \`${id}\``, 1);
  return spliceSpan(source, found, replacement, file, headOnly, guardCount, id);
}

// The same guarded splice addressed by SPAN rather than by id, because an
// anonymous block (addressed by `@<hex>`) has no id to look one up with. `id`
// is the survival guard's subject and is simply absent for those: every OTHER
// pre-existing id must still survive, which the `dropped` check below covers.
// How many typed blocks a document holds. Ids only account for the named ones,
// so this is what makes an unnamed block's removal reportable instead of silent
// — the whole point of treating both the same.
function countBlockUnits(source: string): number {
  let n = 0;
  for (const a of addressedUnits(source)) if (a.unit.kind === "block") n++;
  return n;
}

function spliceSpan(
  source: string, found: Span, replacement: string, file: string,
  headOnly = false, guardCount = false, id?: string,
): string {
  const beforeDoc = parse(source, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  const beforeIds = beforeDoc.ids;

  // Keep the bytes before and after the target span exactly; give the new block
  // a single trailing newline so the following block still starts on its own
  // line (unless it is the file's last line, which may legitimately lack one).
  const orig = splitLines(source);
  // `--head`: splice only the id's head line; everything below stays
  // byte-identical. The guard below still applies — the replacement must
  // re-declare `{#id}` and, for a typed block, keep the fence pairing intact
  // (an opening line that no longer matches the untouched close fence breaks
  // the re-parse), or the splice is refused.
  const span = headOnly ? narrowToHead(found) : found;
  const before = orig.slice(0, span.start);
  const after = orig.slice(span.end);
  const nl = newlineOf(source);           // adopt the document's style, not LF
  let inject = toNewline(replacement, nl);
  const lastLine = span.end >= orig.length;
  if (!inject.endsWith("\n") && !lastLine) inject += nl;
  const updated = before.join("") + inject + after.join("");

  // Re-parse and refuse a broken result. A parse error or a duplicate id both
  // surface as error diagnostics (registerId flags dups); one check covers both.
  //
  // Blocks the replacement REMOVES are a different matter, and they are reported
  // rather than refused. Refusing made the region unreachable: a section whose
  // opening held a `=== note {#n}` could not have that opening replaced at all,
  // while the same note without an id was dropped in silence — the block's fate
  // turned on whether someone had named it. `delete` already settled the stance
  // for a destructive edit: do it, and say what it cost (it writes, and warns
  // about references it left dangling). This follows that, so there is one rule
  // for removing content instead of two.
  //
  // Note the ordinary read-edit-write cycle never reaches this: `get --intro`
  // hands the blocks over, sending them back keeps them, and nothing is dropped.
  const reparsed = parse(updated, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  const now = new Set(reparsed.ids);
  if (id !== undefined && !now.has(id)) fail(`replacement removes id \`${id}\`; not written`, 1);
  const droppedIds = beforeIds.filter((x) => x !== id && !now.has(x));
  const droppedAnon = Math.max(0, countBlockUnits(source) - countBlockUnits(updated) - droppedIds.length);

  // A reference left dangling BY THE REMOVAL is a consequence the caller is
  // being told about, exactly as `delete` tells them. A reference the new
  // content itself introduces is a broken write and is still refused — the
  // difference is whether the missing target is one of the blocks this splice
  // took away.
  const collateral = (d: Diagnostic): boolean =>
    droppedIds.some((x) => d.message.includes(`\`#${x}\``) || d.message.includes(`#${x}\``));
  const errs = reparsed.diagnostics.filter((d) => d.severity === "error" && !collateral(d));
  if (errs.length) {
    const first = errs[0]!;
    refuseBroken(`replacement would break the document: ${first.message} (line ${first.line}); not written`, errs);
  }
  if (droppedIds.length || droppedAnon) {
    const named = droppedIds.map((x) => `\`#${x}\``).join(", ");
    const anon = droppedAnon ? `${droppedAnon} unnamed block${droppedAnon > 1 ? "s" : ""}` : "";
    console.error(`dropped ${[named, anon].filter(Boolean).join(" and ")} — run 'geml revert' to put them back`);
    for (const d of reparsed.diagnostics.filter((x) => x.severity === "error" && collateral(x))) {
      console.error(`warning: ${d.message} (line ${d.line}) — left dangling by the replacement; run 'geml check' to see it as an error`);
    }
  }
  // For a typed block with a close fence, the body is opaque and swapping it
  // keeps exactly ONE block. A raw `--body` can embed a `===` fence of the
  // block's length that closes the target early and turns the remainder — plus
  // the close line we re-appended — into NEW sibling blocks, including an id-less
  // `=== meta` that redefines document metadata (the dropped-id check above
  // cannot see an id-less injection). Guarded callers refuse any count change.
  // (Not enforced for heading sections / whole-block set, whose replacement may
  // legitimately span several top-level blocks.)
  if (guardCount && reparsed.children.length !== beforeDoc.children.length) {
    fail(`replacement changes the block count (a fence in the body closed ${id !== undefined ? `#${id}` : "the target"} early and injected sibling block(s)?); not written`, 1);
  }
  return updated;
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
  // `--rev changed` is a CONTENT selector, not a position: skip commits that
  // never touched this block, landing on its previous *distinct* version. It is
  // just a `--rev` value, so it cannot conflict with a positional `-N`.
  const changed = to === "changed";
  // The former standalone `--changed` flag is now this value; refuse the old
  // spelling loudly rather than silently ignoring it (and reverting to -1).
  if (args.includes("--changed")) fail("--changed is now `--rev changed`", 2);
  const before = flag(args, "--before");
  const after = flag(args, "--after");
  const append = args.includes("--append");
  if ((append ? 1 : 0) + (before !== undefined ? 1 : 0) + (after !== undefined ? 1 : 0) > 1) {
    fail("revert takes at most one position: --append | --before #id | --after #id", 2);
  }
  const [file, rawId] = positionals(args, ["--rev", "--history", "-o", "--out", "--before", "--after"]);
  if (!file || !rawId) fail(SUBHELP.revert);
  if (file === "-") fail("revert needs a real file (it reads that file's .gemlhistory)", 2);
  const id = rawId.replace(/^#/, "");
  const historyPath = flag(args, "--history") ?? historyPathFor(file);

  const source = readInput(file);
  // The sidecar stores every revision newline-NORMALIZED (history.ts), so a
  // revision's text always comes back LF while the working file may be CRLF.
  // Comparing those raw would make EVERY block look changed on a CRLF document
  // (`--rev changed` reverting blocks nobody touched, and the no-op check never
  // firing), so compare normalized and write back in the file's own style.
  const norm = toLf;                              // compare on the LF form
  const toFileNl = (s: string) => toNewline(s, newlineOf(source));
  const curFull = blockSpans(source).get(id);            // undefined => absent now
  const curBlock = curFull === undefined ? undefined : ((): string => {
    const span = headOnly ? narrowToHead(curFull) : curFull;
    return splitLines(source).slice(span.start, span.end).join("");
  })();

  // Extract #id's block from a reconstructed revision (undefined => absent
  // there). Under `--head`, extract only the head line.
  const pick = (text: string): string | undefined => {
    const s = blockSpans(text).get(id);
    if (!s) return undefined;
    const span = headOnly ? narrowToHead(s) : s;
    return splitLines(text).slice(span.start, span.end).join("");
  };

  // Resolve the source revision, formatting any history-layer error cleanly.
  const target = ((): { id: string; text: string } => {
    try {
      if (changed) {
        // `pick` reads normalized revision text, so normalize this side too.
        const found = firstChangedContent(historyPath, curBlock === undefined ? "" : norm(curBlock), pick);
        if (!found) fail(`no earlier revision changes \`${id}\``, 1);
        return found;
      }
      return resolveContent(historyPath, to);
    } catch (e) {
      fail(historyError(e, file, historyPath), 1);
    }
  })();

  const oldBlock = pick(target.text);                     // undefined => absent at R

  // Common write path (bespoke message; -o path redirects; -o - -> stdout).
  const emit = (updated: string, verb: string): void => {
    const dest = out ?? file;
    if (dest === "-") process.stdout.write(updated);
    else writeFileSync(dest, updated);
    console.error(`${verb}${dest === file ? "" : dest === "-" ? " -> stdout" : ` -> ${dest}`}`);
  };

  // Reconcile #id between now and revision R across the four presence cells.
  if (curBlock === undefined && oldBlock === undefined) {
    fail(`\`${id}\` exists in neither the document nor ${target.id} (try --rev changed)`, 1);
  }

  // both present -> SPLICE (undo set)
  if (curBlock !== undefined && oldBlock !== undefined) {
    if (norm(oldBlock) === norm(curBlock)) {
      console.error(`#${id} is unchanged at ${target.id}; nothing to revert${changed ? "" : " (try --rev -2, or --rev changed)"}`);
      // A no-op still has to PRODUCE the document when an output destination was
      // asked for: `-o` means "write the result somewhere", and the result of a
      // no-op revert is the unchanged document. Returning silently here left
      // `-o -` consumers with exit 0 and empty stdout, which reads as "success,
      // and the document is now empty".
      if (out !== undefined) emit(source, `#${id} unchanged`);
      return;
    }
    const replacement = toFileNl(oldBlock);   // keep the file's newline style
    if (dryRun) {
      console.error(`would revert #${id} to ${target.id}:`);
      process.stdout.write(replacement.endsWith("\n") ? replacement : replacement + "\n");
      return;
    }
    emit(spliceBlock(source, id, replacement, file, headOnly), `reverted #${id} to ${target.id}`);
    return;
  }

  // --head is only meaningful for the splice cell (it can't resurrect or remove).
  if (headOnly) {
    fail("--head only applies when the block exists in both the document and the target revision", 2);
  }

  // absent now, present at R -> RESURRECT (undo delete)
  if (curBlock === undefined && oldBlock !== undefined) {
    // Guard: if the block we'd resurrect is the same (modulo id) as one already
    // present under a different id, #id was likely renamed away — resurrecting
    // would duplicate it. Point at `rename` instead of writing.
    const cmpKey = normalizeBlockId(norm(oldBlock), "__cmp__");
    for (const [cid, cs] of blockSpans(source)) {
      if (cid === id) continue;
      const csrc = splitLines(source).slice(cs.start, cs.end).join("");
      if (normalizeBlockId(norm(csrc), "__cmp__") === cmpKey) {
        fail(`#${id} looks renamed to #${cid}; use 'rename #${cid} #${id}' to undo the rename`, 1);
      }
    }
    const { at, where, warn } = resurrectPosition(source, target.text, id, before, after, append, file);
    const fragment = toFileNl(oldBlock);      // keep the file's newline style
    if (dryRun) {
      console.error(`would resurrect #${id} from ${target.id} at ${where}:`);
      process.stdout.write(fragment.endsWith("\n") ? fragment : fragment + "\n");
      return;
    }
    if (warn) console.error(`warning: anchors for #${id} are gone; appended at end`);
    emit(insertFragment(source, splitLines(source), at, fragment, file), `resurrected #${id} from ${target.id} at ${where}`);
    return;
  }

  // present now, absent at R -> REMOVE (undo add)
  // Guard: if the block we'd remove is the same (modulo id) as one present at R
  // under a different id, #id was likely renamed IN — removing would delete a
  // renamed block. Point at `rename` instead (the dangerous direction).
  {
    const cmpKey = normalizeBlockId(norm(curBlock!), "__cmp__");
    for (const [rid, rs] of blockSpans(target.text)) {
      if (rid === id) continue;
      const rsrc = splitLines(target.text).slice(rs.start, rs.end).join("");
      if (normalizeBlockId(rsrc, "__cmp__") === cmpKey) {
        fail(`#${id} looks renamed from #${rid}; revert would delete it — use 'rename #${id} #${rid}'`, 1);
      }
    }
  }
  if (dryRun) {
    console.error(`would remove #${id} (absent at ${target.id})`);
    return;
  }
  const span = curFull!;
  const beforeIds = parse(source, { ...docOpts(file), self: file === "-" ? undefined : basename(file) }).ids;
  const updated = splitLines(source).filter((_, i) => i < span.start || i >= span.end).join("");
  const reparsed = parse(updated, { ...docOpts(file), self: file === "-" ? undefined : basename(file) });
  const errs = reparsed.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    const first = errs[0]!;
    refuseBroken(`removing #${id} would break the document: ${first.message} (line ${first.line}); not written`, errs);
  }
  const now = new Set(reparsed.ids);
  const dropped = beforeIds.find((x) => x !== id && !now.has(x));
  if (dropped !== undefined) fail(`removing #${id} would drop block \`#${dropped}\`; not written`, 1);
  emit(updated, `removed #${id} (absent at ${target.id})`);
}

// Choose the physical-line insertion point for a resurrected block. Explicit
// --append/--before/--after win; otherwise infer from the block's neighbours in
// revision R: the nearest id BEFORE it that still exists now (insert after it),
// else the nearest id AFTER it that still exists (insert before it), else append
// at end (warn=true). The deleted block's own former descendants are absent now
// too, so they are naturally skipped as anchors.
function resurrectPosition(
  source: string, revText: string, id: string,
  before: string | undefined, after: string | undefined, append: boolean, file: string,
): { at: number; where: string; warn: boolean } {
  const lines = splitLines(source);
  const here = blockSpans(source);
  if (append) return { at: lines.length, where: "end", warn: false };
  if (before !== undefined) {
    const a = before.replace(/^#/, "");
    const s = here.get(a);
    if (!s) fail(`no block with id \`${a}\` in ${file}`, 1);
    return { at: s.start, where: `before #${a}`, warn: false };
  }
  if (after !== undefined) {
    const a = after.replace(/^#/, "");
    const s = here.get(a);
    if (!s) fail(`no block with id \`${a}\` in ${file}`, 1);
    return { at: s.end, where: `after #${a}`, warn: false };
  }
  const revIds = [...blockSpans(revText).keys()];
  const idx = revIds.indexOf(id);
  for (let i = idx - 1; i >= 0; i--) {
    const s = here.get(revIds[i]!);
    if (s) return { at: s.end, where: `after #${revIds[i]}`, warn: false };
  }
  for (let i = idx + 1; i < revIds.length; i++) {
    const s = here.get(revIds[i]!);
    if (s) return { at: s.start, where: `before #${revIds[i]}`, warn: false };
  }
  return { at: lines.length, where: "end", warn: true };
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
    fail("geml codemap mcp was removed: use `geml mcp --root <dir>`, which serves the three code-graph tools alongside the document tools (graph: <root>/.geml-code-graph, or --graph <dir>).");
  }
  const script = scripts[sub];
  if (!script) fail(`unknown codemap subcommand '${sub}'.\n${SUBHELP.codemap}`);
  const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "codemap", script);
  const r = spawnSync(process.execPath, [mod, ...args.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
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
    const have = run("geml", ["--version"]);
    if (have.status === 0) {
      console.log(`cli    ${String(have.stdout ?? "").trim()} already on PATH`);
    } else {
      console.log("cli    installing @geml/geml globally (npm i -g)...");
      const r = run("npm", ["install", "-g", "@geml/geml", "--no-audit", "--no-fund", "--loglevel=error"], true);
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
  } else if (cmd === "get") {
    runGet(argv.slice(1));
  } else if (cmd === "list") {
    runList(argv.slice(1));
  } else if (cmd === "find") {
    runFind(argv.slice(1));
  } else if (cmd === "set") {
    runSet(argv.slice(1));
  } else if (cmd === "replace") {
    runReplace(argv.slice(1));
  } else if (cmd === "add") {
    runAdd(argv.slice(1));
  } else if (cmd === "delete") {
    runDelete(argv.slice(1));
  } else if (cmd === "rename") {
    runRename(argv.slice(1));
  } else if (cmd === "revert") {
    runRevert(argv.slice(1));
  } else if (cmd === "history") {
    runHistory(argv.slice(1));
  } else if (cmd === "check") {
    runCheck(argv.slice(1));
  } else if (cmd === "codemap") {
    runCodemap(argv.slice(1));
  } else if (cmd === "mcp") {
    runMcp(argv.slice(1));
  } else if (cmd === "skill") {
    runSkill(argv.slice(1));
  } else if (cmd !== "-" && !/[.\/\\]/.test(cmd)) {
    // A bare word that is neither a known command nor a path is almost always
    // a mistyped command — say so, don't try to read it as a file. (The
    // reclaimed verbs render/export/fmt/convert land here too.)
    fail(`unknown command '${cmd}'. Run 'geml --help'.`);
  } else {
    // A file (or stdin via '-') is the transform entry: `--to`/`--from`/`-o`,
    // default `--to json`. The single door for every format conversion.
    runTransform(argv);
  }
}
