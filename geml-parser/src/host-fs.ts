import { type ProfileIO } from "./profiles.js";
import { createHash } from "node:crypto";
// The filesystem host for the verbs (verbs.ts): how a document on disk reaches
// its cross-document targets, how `--view` reads a confined sibling, and how a
// directory is walked for `find`. Shared by the CLI and the stdio MCP server —
// the two hosts whose documents live on disk — so the confinement gates are
// written once and both surfaces refuse the same escapes.
//
// Nothing here parses. This module answers "may this path be read, and what is
// in it"; what to make of the bytes is the verbs' business.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { type DocOpts, type FileAccess, ViewError } from "./verbs.js";
import { isMarkdownPath } from "./geml.js";

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
export function resolverFor(file: string, root?: string): (d: string) => string | null {
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
export function existsFor(file: string, root?: string): (d: string) => boolean {
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
export function docOptsFor(file: string, root?: string): DocOpts {
  const markdown = isMarkdownPath(file);
  return {
    resolveDoc: resolverFor(file, root), docExists: existsFor(file, root), markdown,
    ...(markdown ? { findNote: noteFinderFor(file, root) } : {}),
  };
}

// Obsidian's lookup for a wikilink name — inside the confinement base, never
// beyond it. First the name as written and with `.md`, from the document's
// directory and from the base: existsFor, so the same two starting points and
// the same gates as every other reference. Failing those, by name anywhere
// under the base, the way a vault resolves `[[Note]]` to `projects/2026/Note.md`
// — a file called `<name>` or `<name>.md`, or for a name with a `/`, a path
// ending in it; compared case-insensitively, as Obsidian compares. The walk
// skips dot-directories, `node_modules` and EVERY symlink, a link being the one
// thing that could carry it outside the base. Widening what a note may probe
// stays the user's `--root` to grant (resolverFor), never the vault's.
export function noteFinderFor(file: string, root?: string): (name: string) => boolean {
  const exists = existsFor(file, root);
  const dirAbs = resolvePath(file === "-" ? "." : dirname(file));
  const baseAbs = root === undefined ? dirAbs : resolvePath(root);
  return (name) => {
    const n = name.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (n === "") return false;
    if (exists(n) || exists(`${n}.md`)) return true;
    const want = n.toLowerCase();
    const index = notesUnder(baseAbs);
    if (!want.includes("/")) return index.names.has(want) || index.names.has(`${want}.md`);
    return index.paths.some((r) => r === want || r === `${want}.md` || r.endsWith(`/${want}`) || r.endsWith(`/${want}.md`));
  };
}

// Every file under a base, lower-cased: its name, and its base-relative path.
// Cached briefly, keyed by the real base: one verb parses a file more than once,
// and a long-running MCP server still sees a note created a moment ago.
const NOTE_INDEX = new Map<string, { at: number; names: Set<string>; paths: string[] }>();
const NOTE_INDEX_TTL_MS = 5000;
const NOTE_INDEX_MAX = 200_000;
function notesUnder(baseAbs: string): { names: Set<string>; paths: string[] } {
  let real: string;
  try { real = realpathSync(baseAbs); } catch { return { names: new Set(), paths: [] }; }
  const hit = NOTE_INDEX.get(real);
  if (hit !== undefined && Date.now() - hit.at < NOTE_INDEX_TTL_MS) return hit;
  const names = new Set<string>();
  const paths: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (paths.length >= NOTE_INDEX_MAX) return;
      if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.isFile()) { names.add(e.name.toLowerCase()); paths.push(r.toLowerCase()); }
    }
  };
  walk(real, "");
  const index = { at: Date.now(), names, paths };
  NOTE_INDEX.set(real, index);
  return index;
}

// The Obsidian vault a document sits in, when its root lies ABOVE the base —
// where wikilinks to notes elsewhere in the vault cannot resolve. The host says
// so; it never widens the base itself (see noteFinderFor).
export function obsidianVaultAbove(file: string, root?: string): string | null {
  const dirAbs = resolvePath(file === "-" ? "." : dirname(file));
  const baseAbs = root === undefined ? dirAbs : resolvePath(root);
  for (let d = dirname(baseAbs); ; d = dirname(d)) {
    if (existsSync(join(d, ".obsidian"))) return d;
    if (dirname(d) === d) return null;
  }
}

// Walking a `--view` chain is DOCUMENT-DRIVEN file access: `src=` comes from
// file content, so without a confinement root a document could name any path on
// the machine. And never a URL — `geml get` is a read command that agents and
// editors call constantly, so letting content steer it at the network would turn
// it into an SSRF entry point (§3.1). Both refusals reuse existing codes (§3).
export function readConfined(rel: string, root: string): string {
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

// Provenance is stated relative to the confinement root, not as the path the
// walk happens to have composed. The MCP layer hands the verbs an ABSOLUTE
// path, so without this `from` would be `C:/Users/…/part.geml#tip` — leaking
// the server's layout, and not a path any caller could pass back in.
export function shownPath(rel: string, root: string): string {
  const r = relative(root, rel).replace(/\\/g, "/");
  return r === "" ? rel : r;
}

/** The verbs' view of a disk: confined sibling reads for `--view` and the Markdown export. */
export const fsFiles: FileAccess = { readConfined, shownPath };

// The extensions a directory walk admits: the two input formats the parser
// reads from a path. Compared case-insensitively because a vault written on a
// case-insensitive filesystem can hand `readdir` back `NOTES.MD`, and a search
// that skips a file the user can see is the same silent "no" this walk used to
// answer for Markdown.
const WALKED = [".geml", ".md"];
const walkable = (path: string): boolean => {
  const lower = path.toLowerCase();
  return WALKED.some((ext) => lower.endsWith(ext));
};

// Walk for the formats the parser reads. Depth-first, sorted, so output order is
// stable across platforms — a listing that reorders between machines is a
// listing nobody can diff. Hidden directories and `node_modules` are skipped: a
// search verb that dredges up vendored copies trains people to stop reading its
// output.
// `explicit` marks a path the caller NAMED, as opposed to one this walk found.
// A named file is searched whatever it is called: `get` and `list` already read
// a `.md` this way, and having only `find` refuse meant
// `geml find GEML README.md` exited 1 against a file holding forty-four
// matches — a search that answers "no" about a file you pointed straight at.
// The DIRECTORY walk still filters, or it would drag the whole source tree
// through the parser — but it filters to BOTH formats the parser reads. Taking
// only `.geml` made a directory of Markdown answer "no matches" to a pattern
// on every page of it, and answer it silently: `list`, `get` and `set` all
// accept those files, and only the walk that has to FIND them refused. That is
// not a narrower search, it is a wrong one.
// `.gemlhistory` does not end in `.geml`, so sidecars stay out of the walk.
export function gemlFilesUnder(path: string, out: string[], explicit = false): void {
  let dir = false;
  try { dir = statSync(path).isDirectory(); } catch { return; }
  if (!dir) { if (explicit || walkable(path)) out.push(path); return; }
  for (const e of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    gemlFilesUnder(join(path, e.name), out);
  }
}

// Map a thrown error from the history layer to a clean one-line message —
// never a raw node:fs stack trace, and without leaking the absolute path the
// runtime resolved (we report the relative path the user actually passed).
export function historyError(e: unknown, file: string, historyPath: string): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") {
    const p = err.path ?? "";
    if (p.endsWith(basename(historyPath))) return `cannot read history ${historyPath}`;
    return `cannot read ${file}`;
  }
  return err?.message ?? String(e);
}

/**
 * geml-media 的检查器要读文档、算文件哈希，而它自己不能碰 node:fs —— 浏览器打包
 * （geml-viewer）会把那个模块一起吃进去，一个 node:* 依赖就够让整份扩展构建失败。
 * 所以文件访问由宿主给，这里是宿主端：路径一律受根目录限定（规范 §9.4）。
 */
export function profileIoFor(root: string): ProfileIO {
  const base = resolvePath(root);
  const confined = (rel: string): string | null => {
    const abs = resolvePath(base, rel);
    return abs === base || abs.startsWith(base + sep) ? abs : null;
  };
  return {
    readDoc(rel: string): string | null {
      const abs = confined(rel);
      if (abs === null) return null;
      try { return readFileSync(abs, "utf8"); } catch { return null; }
    },
    hashText(text: string): string {
      return createHash("sha256").update(text, "utf8").digest("hex");
    },
    hashFile(rel: string): string | null {
      const abs = confined(rel);
      if (abs === null) return null;
      try { return createHash("sha256").update(readFileSync(abs)).digest("hex"); } catch { return null; }
    },
  };
}
