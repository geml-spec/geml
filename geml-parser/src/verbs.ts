// The document verbs, as pure functions: text in, text (or a report) out.
//
// `list / find / get / check / to / replace / set / add / delete / rename /
// revert` used to live in cli.ts, interleaved with the reading of files, the
// writing of stdout and the exit codes — which is why `geml mcp` had to start a
// CLI child per tool call and fish a JSON frame out of its stderr. This module
// is the same logic with every host concern lifted out:
//
//   • nothing here imports `node:fs`, touches `process`, or exits. A refusal
//     is a thrown `VerbError` carrying the exit status the CLI has always used
//     (2 = usage, 1 = document/operation) and, for a guarded write, the full
//     diagnostic list the `--json` refusal frame carried;
//   • what used to go to stderr as a side remark — "dropped `#x`", "3 `note`
//     blocks", "new address: …" — goes through `ctx.note()`, so a host decides
//     whether that is stderr, a result field, or nothing;
//   • the document the verb needs and cannot see — a cross-document target, a
//     `--in F#src` file, the `.gemlhistory` sidecar — arrives through the
//     context or through a reader the host binds, never through a path this
//     module opens itself.
//
// Two hosts consume it: the CLI (cli.ts — argv, files, stdout, exit codes) and
// the stdio MCP server (mcp.ts — a confined root on disk); a host whose
// documents arrive as text would need nothing more. The wording of every
// message is unchanged from the CLI: it is what the tests pin and what the
// agents reading these messages have learned.
import {
  type Document, type Block, type Diagnostic, type Value, type Span, type UnitPart,
  EMBED_DEPTH_LIMIT, FENCE_OPEN,
  parse, blockSpans, sliceUnit, addressedUnits, relJoinPath, relDirPath,
  closeFenceLine, findBlockSite, isCloseFence, narrowToHead, newlineOf,
  narrowToIntro, reLit, sectionEndIndex, splitLines, stripEol, toLf, toNewline, trimSpaceTabEnd,
  nameKey, resolveTarget, vocabularyOf } from "./geml.js";
import { type Unit, type Addressed, type Selector } from "./selector.js";
import { schemeOf } from "./inline.js";
import { parseAttrs } from "./attrs.js";
import { addressUnits, discoveryHint, matchContent, matchLine, matchType, parseSelector, shortestAddress } from "./selector.js";
import { type MetaView, metaText, metaView, planCoordWrite, planMetaWrite, projectCoord } from "./coord.js";
import { mdToGeml } from "./from-md.js";
import { serialize } from "./serialize.js";
import { gemlToMd } from "./to-md.js";
import { renderHtml } from "./render-html.js";
import { codeGraphDiagram } from "./codemap-render.js";
import { normalizeBlockId } from "./block-edit.js";

void addressUnits;

// ---------------------------------------------------------------------------
// The contract with a host
// ---------------------------------------------------------------------------

/**
 * A refusal. `exit` is the status the CLI reports it with — 2 for a usage
 * error, 1 for a document/operation error — and `diagnostics` is present when
 * a guarded write was refused by the re-parse of its result, so a programmatic
 * host can hand the codes of Appendix A to its caller instead of the prose.
 */
export class VerbError extends Error {
  constructor(message: string, public readonly exit: 1 | 2 = 2, public readonly diagnostics?: Diagnostic[]) {
    super(message);
  }
}

// A `--view` chain that cannot reach an entity block. Carries the diagnostic
// code it corresponds to (§3) so the message can name it without inventing a
// new one. A failed READ, reported the way `get` reports a selector that
// matches nothing: one line, exit 1.
export class ViewError extends VerbError {
  constructor(public readonly code: string, message: string) { super(message, 1); }
}

/** The two halves of cross-document resolution a parse takes. */
export interface DocOpts {
  resolveDoc: (d: string) => string | null;
  docExists: (d: string) => boolean;
}

/**
 * Document-driven file access for the `--view` chain and the Markdown export's
 * embed expansion: `src=` comes from file content, so the host confines it to
 * a root and refuses what lies outside. A host with no other documents leaves
 * this out, and every chain that would need one is refused.
 */
export interface FileAccess {
  /** The text at `rel` (root-relative), or throw a ViewError naming why not. */
  readConfined(rel: string, root: string): string;
  /** How `rel` is shown in provenance: relative to the root, not as composed. */
  shownPath(rel: string, root: string): string;
}

export interface VerbContext {
  /** Resolution for a parse of `file`; `root` overrides the host's default root. */
  docOpts(file: string, root?: string): DocOpts;
  /** A side remark — the CLI's stderr line. */
  note(line: string): void;
  files?: FileAccess;
}

/**
 * The new content a write takes. `raw` is bytes (stdin); `file` is the
 * `--in F[#src]` channel — the host binds `read` so the verb can open F at the
 * moment the CLI did, and a refusal to read is a VerbError from the host.
 */
export type Content =
  | { kind: "raw"; text: string }
  | { kind: "file"; spec: string; read: (path: string) => string };

/** The `.gemlhistory` side of `revert`, bound by the host to one sidecar. */
export interface HistoryReader {
  resolve(sel: string): { id: string; text: string };
  firstChanged(current: string, pick: (text: string) => string | undefined): { id: string; text: string } | undefined;
}

function fail(msg: string, code: 1 | 2 = 2): never { throw new VerbError(msg, code); }
function refuseBroken(prose: string, errs: Diagnostic[]): never { throw new VerbError(prose, 1, errs); }

// The last path segment, on either separator. A host label may be a POSIX
// path, a Windows path or `-`; `self` (the document's own name for §5.2
// self-references) is the name alone.
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
const selfOf = (file: string): string | undefined => (file === "-" ? undefined : baseName(file));
const whereOf = (file: string): string => (file === "-" ? "stdin" : file);

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

function filesOf(ctx: VerbContext): FileAccess {
  if (!ctx.files) {
    throw new ViewError("unresolvable-document",
      "unresolvable-document: this host holds no other documents, so a chain cannot be followed");
  }
  return ctx.files;
}

// One hop: read the target document and select what the fragment names. Several
// units come back when the fragment names a section (§4.3).
function oneHop(file: string, src: string, root: string, ctx: VerbContext):
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
  const files = filesOf(ctx);
  const text = files.readConfined(rel, root);
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
    return { doc: rel, text, units: top.filter((u) => !(u.kind === "block" && u.type === "meta")), all: [], from: files.shownPath(rel, root) };
  }
  const { units, all } = selectUnits(text, rel, `#${frag}`, rel, ctx);
  return { doc: rel, text, units, all, from: `${files.shownPath(rel, root)}#${frag}` };
}

function viewResolve(source: string, file: string, unit: Unit, root: string, ctx: VerbContext,
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
  const hop = oneHop(file, src, root, ctx);
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
  return hop.units.flatMap((u) => viewResolve(hop.text, hop.doc, u, root, ctx, depth + 1, nextSeen)
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

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

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
function resolveSelector(source: string, file: string, raw: string, ctx: VerbContext): string {
  const bare = raw.replace(/^#/, "");
  const m = /^(#{1,6})[ \t]*(.+?)[ \t]*$/.exec(raw);
  if (!m) return bare; // not a `#`-run form: an id, verbatim
  // 1. The id is canonical and always wins. Checked without a parse, so the
  //    common `get #id` stays a byte-slice on a document with diagnostics.
  if (blockSpans(source).has(bare)) return bare;

  const level = m[1]!.length;
  const want = m[2]!;
  const doc = parse(source, { ...ctx.docOpts(file), self: selfOf(file) });
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
  return fail(`no id or heading matches \`${raw}\` — run \`geml get ${file === "-" ? "-" : file}\` to list every addressable id`, 1);
}

// Terminal columns a string occupies, which is not its length: an East Asian
// wide or fullwidth code point takes two cells and a combining mark none, so
// `padEnd` — counting UTF-16 code units — pushed every column after a CJK id
// or heading out of true (`#实现前必须在提案里定下的三件事` is 15 characters
// and 30 cells). Ranges are the wide/fullwidth blocks of UAX #11 plus the
// emoji planes; anything outside them is one cell, which is right for Latin,
// Cyrillic, Greek and the punctuation that appears in an id.
function columns(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x200b && c <= 0x200f)) continue;
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x303e)
      || (c >= 0x3041 && c <= 0x33ff) || (c >= 0x3400 && c <= 0x4dbf)
      || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa000 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe10 && c <= 0xfe19) || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
      || (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff)
      || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}
function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - columns(s)));
}

/**
 * `geml list <file>` / `geml get <file>` with no selector: every addressable
 * block — the document's table of contents — as the text the CLI prints.
 * `json` is the machine-readable array. An empty document is a legitimate
 * empty answer (§6.6): `--json` prints `[]`, the text form is empty with a
 * note, and neither is a failure.
 */
export function list(source: string, file: string, json: boolean, ctx: VerbContext): string {
  const where = whereOf(file);
  const all = addressedUnits(source);
  const doc = parse(source, { ...ctx.docOpts(file), self: selfOf(file) });

  interface Row {
    address: string; kind: string; anon?: boolean; id?: string;
    level?: number; text?: string; lines: [number, number]; footnote?: boolean;
    unknownType?: boolean;
  }
  // Which rows carry a type neither §3 registers nor a declared profile admits.
  // Taken from the parse's OWN `unknown-block-type` diagnostics rather than a
  // second copy of the registry, so the listing can never disagree with what
  // `geml check` says about the same document — and a `.gemlhistory` whose
  // profile admits `history-revision` is correctly left unflagged.
  const unregistered = new Set(
    doc.diagnostics.filter((d) => d.code === "unknown-block-type").map((d) => d.line),
  );
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
    if (unregistered.has(u.span.start + 1)) row.unknownType = true;
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

  if (json) return JSON.stringify(rows, null, 2) + "\n";
  if (rows.length === 0) { ctx.note(`no addressable blocks in ${where}`); return ""; }

  const addrW = Math.max(...rows.map((r) => columns(r.address)));
  const kindW = Math.max(...rows.map((r) => columns(r.kind)));
  // The line range belongs on EVERY row, headings included. It used to be the
  // alternative to a heading's text, so the one kind of block whose range you
  // most want — a whole section — was the one kind that did not print it, and
  // `L11-493` is itself an address you can paste back into `get`. The heading's
  // text follows it rather than replacing it.
  const lineW = Math.max(...rows.map((r) => `L${r.lines[0]}-${r.lines[1]}`.length));
  const out: string[] = [];
  for (const r of rows) {
    const mark = r.kind === "heading" ? `h${r.level}` : r.anon ? "anon" : "";
    const span = `L${r.lines[0]}-${r.lines[1]}`;
    const tail = r.kind === "heading" ? `${pad(span, lineW)}  ${r.text ?? ""}` : span;
    // A block whose type nothing admits is worth saying so on its own row: the
    // address and the line range look ordinary, and the one fact that changes
    // how the body was read — verbatim, because no registry claimed the type —
    // is otherwise only in `check`'s output.
    const note = [r.footnote ? "footnote" : "", r.unknownType ? "unknown type" : ""].filter(Boolean).join("  ");
    const line = `${pad(r.address, addrW)}  ${pad(r.kind, kindW)}  ${pad(mark, 4)}  ${tail}`
      + (note ? `  ${note}` : "");
    out.push(line.trimEnd());
  }
  return out.join("\n") + "\n";
}

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
export function selectUnits(source: string, file: string, rawSel: string, where: string, ctx: VerbContext, allowCoord = false): { units: Unit[]; all: Addressed[]; sel: Selector } {
  const sel: Selector = parseSelector(rawSel, (braces) => parseAttrs(braces).id);
  // Callers handle the empty selector themselves (list for `get`, usage error
  // for `set`); reaching here with one is a caller bug surfaced as usage.
  if (sel.form === "list") fail(`no selector given — run \`geml get ${where}\` to list addressable blocks`, 2);
  // A coordinate (GEP 0011) names a unit inside a block, and every command but
  // `get` here acts on a block's SPAN. Resolving the base and proceeding would
  // have been the worst of both: `set '#fy[2]["Q1"]'` would have replaced the
  // whole table, silently and byte-exactly. Refused in one place so no call
  // site can forget, and the message names the address that does work.
  if (sel.form === "coord" && !allowCoord) {
    fail(`\`${rawSel.trim()}\` addresses a unit INSIDE a block (GEP 0011), and this command takes a block address — write \`${sel.base}\` for the whole block`, 2);
  }
  if (sel.form === "attr") {
    // §7: the wording says "not implemented yet", not "braces are meaningless" —
    // §2 declares attribute keys as part of the model, so implementing them
    // later fills in a declared slot rather than reversing this message.
    // `#id` and `@<hex>` ARE implemented in braces now; a third key is not.
    const byType = sel.type === undefined
      ? ""
      : ` — use \`=== ${sel.type}\` for every ${sel.type} block, or address one by \`#id\` / \`@<hex>\``;
    fail(`only \`#id\` and \`@<hex>\` are supported as filter keys today (got \`${sel.key}\`)${byType || " — address a block by `#id` / `@<hex>`, or `=== <type>` for every block of a type"}`, 2);
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
    return { units: [hit.unit], all, sel };
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
    return { units: [hit], all, sel };
  }

  if (sel.form === "type") {
    const hits = matchType(sel.type, all);
    if (!hits.length) fail(`no \`${sel.type}\` block in ${where}${discoveryHint(where)}`, 1);
    return { units: hits, all, sel };
  }

  // `#id` / bare id / a pasted `## Heading` line — resolveSelector needs a parse
  // to match heading TEXT, so it stays the one path that reaches the model.
  //
  // A coordinate (GEP 0011) resolves its BASE right here, through the same id
  // grammar: `#fy[2]["Q1"]` finds `#fy` and hands the path to the caller,
  // because a unit inside a block names no span of the file and so cannot be
  // sliced out of one the way every other form is.
  const id = resolveSelector(source, file, sel.form === "coord" ? sel.base : sel.raw, ctx);
  const hits = all.filter((a) => a.unit.id !== undefined && nameKey(a.unit.id) === nameKey(id));
  const unit = hits[0]?.unit;
  // Bare `no block with id \`x\`` — the phrasing every caller of a missing id
  // has always seen, and which `set`'s own tests pin. `where` is appended only
  // when it is NOT the file the caller already named (a revision), so the
  // common case reads the same as before this selector grammar existed.
  if (!unit) fail(`no block with id \`${id}\`${where.startsWith("revision ") ? ` in ${where}` : ""}`, 1);
  // A duplicate id is a build error, so this address names more than one block
  // and the first is a guess at which was meant. A WRITE through it is refused
  // (`duplicate-id` is UNFORGIVEN below); a READ used to take the first in
  // silence, which is the worse failure of the two — the caller gets a
  // different block and no signal at all. Said here so no verb can forget, and
  // as a warning rather than a refusal: `geml check` is where an ambiguous
  // document earns its non-zero exit, and holding a reader hostage over a
  // defect elsewhere in the file is the thing `forgives()` exists to stop.
  if (hits.length > 1) {
    const at = hits.map((h) => h.unit.span.start + 1).join(", ");
    ctx.note(`warning: \`#${id}\` names ${hits.length} blocks (lines ${at}) — answering the first; a duplicate id is a build error, so this address stays ambiguous until it is repaired`);
  }
  return { units: [unit!], all, sel };
}

// GEP 0011 reserves `#meta` for the merged meta namespace. A document whose
// single `meta` block declares `{#meta}` resolves through the ordinary id path
// — the block IS the view there, so both readings agree — and only an
// unclaimed `#meta` is answered from the merge below. `reserved-id` is the
// parse-time error for the case where the two could disagree.
function reservedMeta(source: string, file: string, base: string, ctx: VerbContext): { view: MetaView; children: Block[] } | null {
  if (nameKey(base.replace(/^#/, "")) !== nameKey("meta")) return null;
  const doc = parse(source, { ...ctx.docOpts(file), self: selfOf(file) });
  if (findBlockSite(doc.children, "meta")) return null; // a block claims the id
  const view = metaView(doc.children);
  if (view.blocks.length === 0) return null;            // nothing to merge
  return { view, children: doc.children };
}

// The document-model node for one unit; a heading yields its SECTION envelope,
// so --json covers the same content as the raw span. `kind:"section"` lets a
// consumer branch — every other unit yields the single node (the model is flat).
export function unitNode(source: string, file: string, unit: Unit, all: Addressed[], ctx: VerbContext): unknown {
  const doc = parse(source, { ...ctx.docOpts(file), self: selfOf(file) });
  if (unit.id !== undefined) {
    const site = findBlockSite(doc.children, unit.id);
    if (!site) fail(`no block with id \`${unit.id}\``, 1);
    const block = site!.siblings[site!.index]!;
    if (block.kind !== "heading") return block;
    const end = sectionEndIndex(site!.siblings, site!.index);
    return { kind: "section", id: block.id, level: block.level, blocks: site!.siblings.slice(site!.index, end) };
  }
  const node = blocksOfType(doc.children, unit.type ?? "")[typeIndex(all, unit)];
  if (!node) fail(`could not locate the \`${unit.type}\` block in the document model`, 1);
  return node;
}

// stderr line for an N-match selector: content stays on stdout, so a redirect
// captures document bytes only, and the caller still learns how many it got (§5).
export function reportMatches(type: string, units: Unit[], ctx: VerbContext): void {
  const at = units.map((u) => `L${u.span.start + 1}-${u.span.end}${u.id ? ` #${u.id}` : ""}`).join(" · ");
  ctx.note(`${units.length} \`${type}\` blocks (${at})`);
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

export interface GetOptions {
  part: UnitPart;
  /** The flag that named `part`, for messages (`--head`); undefined for whole. */
  partFlag?: string;
  json: boolean;
  view: boolean;
  /** `--root`: where the `--view` chain is confined; default the document's own directory. */
  root?: string;
}

/**
 * `geml get <file> <selector> [--head|--body|--intro] [--json] [--view]` — one
 * or several blocks out of the document. Returns the exact bytes the CLI
 * writes to stdout; `from` is the provenance of every `--view` hop, which the
 * CLI also notes as `view: <sel> -> <doc>#<id>`.
 */
export function get(source: string, file: string, rawSel: string, o: GetOptions, ctx: VerbContext): { output: string; from: string[] } {
  const { json, view, part, partFlag } = o;
  const where = whereOf(file);
  const sel: Selector = parseSelector(rawSel, (braces) => parseAttrs(braces).id);
  if (sel.form === "list") fail(`no selector given — run \`geml get ${where}\` to list addressable blocks`, 2);
  // `#meta` answers the VIEW rather than a span: there may be no block with
  // that id at all, and when there are several `meta` blocks there is no one
  // span that means what the reader asked for.
  const metaBase = sel.form === "coord" ? sel.base : sel.form === "id" ? sel.raw : "";
  const reserved = metaBase === "" ? null : reservedMeta(source, file, metaBase, ctx);
  if (reserved) {
    if (partFlag) fail(`${partFlag} names part of a block, and \`#meta\` names a merged view rather than one block`, 2);
    if (sel.form === "id") {
      return { output: json ? `${JSON.stringify(reserved.view.value, null, 2)}\n` : `${metaText(reserved.view)}\n`, from: [] };
    }
    const node: Block = { kind: "block", type: "meta", mode: "data", classes: [], attrs: {}, data: reserved.view.value as Record<string, Value> };
    const hit = projectCoord(node, (sel as Extract<Selector, { form: "coord" }>).path);
    if (!hit.ok) fail(`\`${rawSel.trim()}\`: ${hit.why}`, 1);
    return { output: json ? `${JSON.stringify(hit.json, null, 2)}\n` : `${hit.text}\n`, from: [] };
  }

  const { units, all } = selectUnits(source, file, rawSel, where, ctx, true);
  // The chain is composed with `/` — relJoinPath's rule, and `src=` values are
  // always `/`-separated — so normalize the PLATFORM path at this boundary. On
  // Windows `sub\host.geml` otherwise has no directory as far as relDirPath can
  // tell, and a relative `src=` resolves against the wrong base.
  const startDoc = where.replace(/\\/g, "/");
  const viewRoot = o.root ?? (relDirPath(startDoc) || ".");

  // GEP 0011: a coordinate is answered from the MODEL, because the unit it
  // names — a row, a cell, a column, a value-tree node — has no span of the
  // file to slice. It arrives here with its base already resolved to the block
  // that holds it, so everything below (parts, --view, N-match counting) is
  // about blocks and does not apply.
  if (sel.form === "coord") {
    if (partFlag) {
      fail(`${partFlag} names part of a BLOCK, and a coordinate already names a unit inside one`, 2);
    }
    if (view) {
      fail("--view reads THROUGH an embed to a block; a coordinate addresses a unit inside the block it names", 2);
    }
    const hit = projectCoord(unitNode(source, file, units[0]!, all, ctx) as Block, sel.path);
    if (!hit.ok) fail(`\`${rawSel.trim()}\`: ${hit.why}`, 1);
    return { output: json ? `${JSON.stringify(hit.json, null, 2)}\n` : `${hit.text}\n`, from: [] };
  }
  if (json) {
    // §7: N matches yield N model nodes. The old `{kind:"blocks",
    // matches:[{lines}]}` coordinate envelope is gone — it answered "where are
    // they" when the question is "what are they" (§9 change 2).
    const nodes: unknown[] = units.flatMap((u) => {
      if (!view) return [unitNode(source, file, u, all, ctx)];
      return viewResolve(source, startDoc, u, viewRoot, ctx).map((res) => {
        const node = unitNode(res.text, res.doc, res.unit, res.all, ctx) as Record<string, unknown>;
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
    return { output: JSON.stringify(nodes.length === 1 ? nodes[0] : nodes, null, 2) + "\n", from: [] };
  }
  if (units.length > 1) reportMatches(units[0]!.type ?? "", units, ctx);
  if (view) {
    // All-or-nothing (§3.3): resolve EVERYTHING before writing a byte, so a
    // chain that breaks halfway cannot leave a partial read on stdout for a
    // caller that ignores the exit code. Partial scenery is not scenery.
    const out: string[] = [];
    const from: string[] = [];
    for (const u of units) {
      for (const res of viewResolve(source, startDoc, u, viewRoot, ctx)) {
        if (res.from !== "") from.push(res.from);
        out.push(sliceUnit(res.text, res.unit.span, part));
      }
    }
    for (const f of from) ctx.note(`view: ${rawSel} -> ${f}`);
    return { output: out.join(""), from };
  }
  // A block has no intro: the region is "what this heading says before its
  // first subheading", and only a heading has subheadings. Silently handing
  // back the body instead would answer a question that was not asked.
  for (const u of units) {
    if (part === "intro" && u.kind !== "heading") {
      fail(`--intro names a heading's opening region, and \`${rawSel}\` is a \`${u.type ?? u.kind}\` block — use --body for a block's content`, 2);
    }
  }
  return { output: units.map((u) => sliceUnit(source, u.span, part)).join(""), from: [] };
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

export interface FindHit { file: string; address: string; kind: string; lines: [number, number]; line?: string }

/**
 * `geml find <pattern>` over ONE document: the innermost block holding each
 * matching line, once per block. Walking a directory is the host's job — this
 * is `grep` composed with the `L` selector, and nothing more.
 */
export function findInSource(source: string, file: string, pattern: string, o: { sensitive: boolean; withLine: boolean }): FindHit[] {
  const needle = o.sensitive ? pattern : pattern.toLowerCase();
  const hits: FindHit[] = [];
  const all = addressedUnits(source);
  // Match by LINE, then resolve each line to the innermost unit holding it —
  // exactly what the `L` selector does, so `find` is `grep` composed with
  // `L` rather than a second notion of "which block is this in". Testing the
  // units directly instead would report every ancestor: a heading's span
  // covers its whole section, so the h1 spans the file and would match every
  // search ever run.
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const seen = new Map<string, FindHit>();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!(o.sensitive ? raw : raw.toLowerCase()).includes(needle)) continue;
    const unit = matchLine({ form: "line", from: i + 1, to: i + 1 }, all);
    if (!unit) continue;
    const a = all.find((x) => x.unit === unit)!;
    const address = shortestAddress(a, all);
    // One unit, one hit, however many lines inside it matched — a search that
    // reports the same block eight times is a search you stop reading.
    const key = `${a.unit.span.start}:${a.unit.span.end}`;
    if (seen.has(key)) continue;
    const hit: FindHit = {
      file,
      address,
      kind: unit.kind === "block" ? unit.type ?? "block" : unit.kind,
      lines: [unit.span.start + 1, unit.span.end],
    };
    if (o.withLine) hit.line = raw.trim();
    seen.set(key, hit);
    hits.push(hit);
  }
  return hits;
}

/** The two-column rows `geml find` prints: `file<TAB>address[<TAB>line]`. */
export function formatFindRows(hits: FindHit[], withLine: boolean): string {
  return hits.map((h) => {
    // Two columns, `file` then the address EXACTLY as the listing prints it,
    // so a hit is `geml get <col1> '<col2>'` with no editing. Not glued into
    // one `file#addr` token: an id-less block's address is `=== code@a3f9`,
    // which has a space in it and can never be one token — and a format that
    // is only pasteable for half the rows is worse than one that is uniform.
    const row = `${h.file}\t${h.address}`;
    return withLine && h.line !== undefined ? `${row}\t${h.line}` : row;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/** `geml check <file>` — the parse whose diagnostics are the whole answer. */
export function check(source: string, file: string, ctx: VerbContext, root?: string): Document {
  return parse(source, { ...ctx.docOpts(file, root), self: selfOf(file) });
}

// ---------------------------------------------------------------------------
// transform (`geml <file> --to <fmt>`)
// ---------------------------------------------------------------------------

export type InFmt = "geml" | "md" | "json";
export type OutFmt = "json" | "html" | "md" | "geml";

export interface TransformOptions {
  inFmt: InFmt;
  outFmt: OutFmt;
  /** `--to html --fragment`: body-only markup. */
  fragment: boolean;
  /** `--root`: cross-document resolution root; default the document's own directory. */
  root?: string;
}

export interface TransformResult {
  output: string;
  /** Converter/export notes, printed as `note: …` after the output. */
  notes: string[];
  /** The document that was projected — absent for the direct md -> geml path, which parses nothing. */
  doc?: Document;
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

/**
 * The transform entry: project a document to json / html / md / geml. The
 * caller has already settled the formats (extension inference and flag
 * validation are argv work); this does the conversion the CLI does.
 */
export function transform(src: string, file: string, o: TransformOptions, ctx: VerbContext): TransformResult {
  const { inFmt, outFmt, fragment, root } = o;
  const opts = (): DocOpts => ctx.docOpts(file, root);

  // md -> geml is a direct projection, not a parse/serialize round-trip: emit
  // the converter's GEML verbatim (the old `convert`; no diagnostics to raise).
  if (inFmt === "md" && outFmt === "geml") {
    const { geml, notes } = mdToGeml(src);
    return { output: geml, notes: [...notes] };
  }

  // Otherwise load a document — a md input is converted to GEML first — and
  // project it to the target.
  let notes: string[] = [];
  let doc: Document;
  if (inFmt === "json") {
    doc = loadModelJson(src, file); // the inverse of `--to json`
  } else if (inFmt === "md") {
    const conv = mdToGeml(src);
    notes = [...conv.notes];
    doc = parse(conv.geml, { ...opts(), self: selfOf(file) });
  } else {
    doc = parse(src, { ...opts(), self: selfOf(file) });
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
        source: file === "-" ? "stdin" : baseName(file),
        fragment,
        // geml-code-graph embeds load + parse sibling codemap docs on demand.
        loadDoc: opts().resolveDoc,
        parseDoc: (s) => parse(s, { ...opts() }),
        // `geml-codemap/v1`'s diagram format, registered rather than built in.
        diagrams: { "geml-code-graph": codeGraphDiagram },
      });
      break;
    case "md": {
      // `--to html` expands an `embed` (loadDoc/parseDoc above); Markdown got a
      // link to the target instead, so the same document exported two ways
      // disagreed about whether the reader should see the projected text. It
      // should: an export is a snapshot, and a snapshot carries content. The
      // walk is the one `--view` uses — chains followed, cycles refused, reads
      // confined to --root — and losses inside projected content are collected
      // so they are reported like any other.
      const inner: string[] = [];
      const mdRoot = root ?? (relDirPath(file.replace(/\\/g, "/")) || ".");
      // The document default (`translate-to` on `=== meta`) that an embed may
      // override — read from the projection itself, once.
      const docMeta = (doc.children.find((b) => b.kind === "block" && b.type === "meta") as { data?: Record<string, unknown> } | undefined)?.data;
      // GEP 0010 — an export is a SNAPSHOT of the source text. A projection's
      // `lang=` is honoured where a translator exists, which is the viewer (the
      // browser's built-in Translator); this path has none, so it inlines the
      // source and says so rather than shipping a stand-in that would make an
      // export look translated when nothing translated it.
      const expand = (at: string, atText: string, depth: number) =>
        (target: string, embedAttrs?: Record<string, Value>): string | undefined => {
        if (depth >= EMBED_DEPTH_LIMIT) return undefined;
        // GEP 0010 — `part=` narrows a heading's section, and the span layer has
        // drawn exactly these three lines since `geml get --head` existed. So the
        // export honours a document address the same way the CLI honours a flag.
        const asked = typeof embedAttrs?.["part"] === "string" ? String(embedAttrs["part"]).trim() : "whole";
        const part: UnitPart = asked === "head" || asked === "body" || asked === "intro" ? asked : "whole";
        const wantLang = resolveTarget(docMeta, embedAttrs);
        if (wantLang !== null) {
          inner.push(`\`translate-to=${wantLang}\` was not applied: this export has no translator, so the source text stands`);
        }
        const render = (docPath: string, text: string, units: Unit[]): string | undefined => {
          const out: string[] = [];
          for (const u of units) {
            // 切片带不走文档的 `=== meta`，所以把宿主已经算好的词汇表交给子解析 ——
            // 否则 profile 的类型在这里全都变回未知类型，散文块会渲染成一个空围栏。
            const sub = parse(sliceUnit(text, u.span, part), { ...ctx.docOpts(docPath, mdRoot), vocab: vocabularyOf(text) });
            const r = gemlToMd(sub, { resolveEmbed: expand(docPath, text, depth + 1) });
            inner.push(...r.notes);
            if (r.md.trim() !== "") out.push(r.md.trim());
          }
          return out.length === 0 ? undefined : out.join("\n\n");
        };
        try {
          // `src=#id` names a block in THIS document. `oneHop` refuses it (an
          // empty document path), so the same-document case is selected here —
          // the renderer has always expanded it, which is the behaviour being
          // matched.
          if (target.startsWith("#")) {
            const { units } = selectUnits(atText, at, target, at, ctx);
            return render(at, atText, units);
          }
          const hop = oneHop(at, target, mdRoot, ctx);
          const ends = hop.units.flatMap((u) => viewResolve(hop.text, hop.doc, u, mdRoot, ctx));
          const out: string[] = [];
          for (const res of ends) {
            const one = render(res.doc, res.text, [res.unit]);
            if (one !== undefined) out.push(one);
          }
          return out.length === 0 ? undefined : out.join("\n\n");
        } catch {
          return undefined;   // unreachable, non-local, cyclic — the caller links instead
        }
      };
      const r = gemlToMd(doc, { resolveEmbed: expand(file, src, 0) }); // == the former `export`
      notes = notes.concat(r.notes, inner);
      output = r.md;
      break;
    }
  }
  return { output, notes, doc };
}

// ---------------------------------------------------------------------------
// replace (EXPERIMENTAL)
// ---------------------------------------------------------------------------

/**
 * `geml replace <file> <old> <new> [--within <selector>]` — swap a literal
 * string, everywhere or inside named blocks. Returns the new text and the
 * one-line report the CLI prints once the write has landed.
 */
export function replace(source: string, file: string, oldText: string, newText: string, within: string | undefined, ctx: VerbContext): { text: string; summary: string } {
  const where = whereOf(file);
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
    const { units } = selectUnits(source, file, within, where, ctx);
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
  const before = parse(source, { ...ctx.docOpts(file) });
  const after = parse(updated, { ...ctx.docOpts(file), self: selfOf(file) });
  const goneIds = before.ids.filter((x) => !new Set(after.ids).has(x));
  const newIds = after.ids.filter((x) => !new Set(before.ids).has(x));
  if (goneIds.length && newIds.length) {
    fail(`that would rename \`#${goneIds[0]}\` to \`#${newIds[0]}\` — an id is not text: use \`geml rename ${where} '#${goneIds[0]}' '#${newIds[0]}'\`, which fixes every reference too. Nothing written`, 2);
  }

  const errs = errorsAdded(before, after, file);
  if (errs.length) {
    refuseBroken(refusalProse(before, errs, "the replacement would break the document"), errs);
  }

  // Blocks the replacement removed follow `set`'s rule: carried out, and named.
  const droppedAnon = Math.max(0, countBlockUnits(source) - countBlockUnits(updated) - goneIds.length);
  if (goneIds.length || droppedAnon) {
    const named = goneIds.map((x) => `\`#${x}\``).join(", ");
    const anon = droppedAnon ? `${droppedAnon} unnamed block${droppedAnon > 1 ? "s" : ""}` : "";
    ctx.note(`dropped ${[named, anon].filter(Boolean).join(" and ")} — run 'geml revert' to put them back`);
  }

  const list = [...touched].join(", ");
  return { text: updated, summary: `replaced ${hits.length} occurrence${hits.length > 1 ? "s" : ""}${list ? ` in ${list}` : ""}` };
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export const NO_CONTENT = "no replacement content (use --in FILE or pipe it on stdin)";

export interface SetOptions {
  part: "whole" | "head" | "body" | "intro";
  /** The part flags as named on the command line, for messages (`["--head"]`). */
  named: string[];
  content: Content;
}

// Extract one block from a GEML file for `--in`. `spec` is `F` (block whose id
// == the target) or `F#src` (block #src) — the last `#` splits path from id, so
// a `#` inside the path is tolerated; F is read as GEML regardless of extension
// (blockSpans + splitLines, no parse — same slice `geml get` prints). `part`
// selects the whole span, its head line, or its body. A missing file or absent
// id is an operation error (exit 1); the caller writes nothing.
function extractBlock(content: Extract<Content, { kind: "file" }>, targetId: string, part: "whole" | "head" | "body"): string {
  const spec = content.spec;
  const hash = spec.lastIndexOf("#");
  const fragFile = hash >= 0 ? spec.slice(0, hash) : spec;
  const fragId = hash >= 0 ? spec.slice(hash + 1).replace(/^#/, "") : targetId;
  const text = content.read(fragFile);
  const span = blockSpans(text).get(fragId);
  if (!span) fail(`no block with id \`${fragId}\` in ${fragFile}`, 1);
  const lines = splitLines(text);
  if (part === "head") return lines.slice(span!.start, span!.start + 1).join("");
  if (part === "body") { const b = bodyRange(text, span!); return lines.slice(b.start, b.end).join(""); }
  return lines.slice(span!.start, span!.end).join("");
}

// The raw text of the content channel: stdin bytes, or the whole `--in` file.
function contentText(content: Content): string {
  return content.kind === "raw" ? content.text : content.read(content.spec);
}

// A `set` target: exactly one unit, plus how the caller named it (for messages)
// and whether it was named by content address (which §5.3 reports back).
interface SetTarget { unit: Unit; label: string; byContent: boolean }

// Resolve a selector to the ONE unit `set` will overwrite. `get` may answer with
// N blocks; `set` may not — §5: with N targets there is no single id to
// normalize the content to, so multi-target `set` is undefined, not merely
// risky. Refused with exit 2 (a usage error), not exit 1.
function resolveSetTarget(source: string, file: string, rawSel: string, ctx: VerbContext): SetTarget {
  const where = file === "-" ? "<file>" : file;
  const sel: Selector = parseSelector(rawSel, (braces) => parseAttrs(braces).id);
  if (sel.form === "list") fail(`no selector given — run 'geml get ${where}' to list addressable blocks`, 2);
  const { units, all } = selectUnits(source, file, rawSel, where, ctx);

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
function reportNewAddress(updated: string, target: SetTarget, ctx: VerbContext): void {
  if (!target.byContent) return;
  const after = addressedUnits(updated).find((a) => a.unit.span.start === target.unit.span.start);
  if (after) ctx.note(`new address: ${shortestAddress(after, addressedUnits(updated))}`);
}

/**
 * `geml set <file> <selector> [--head|--body|--intro] [--in F|F#src|-]` —
 * replace ONE existing block with new content, preserving every other byte.
 * Two content CHANNELS × four MODES:
 *
 *   channels · `--in F[#src]` extracts a BLOCK from GEML file F (F is always
 *              read as GEML — extension ignored, no md conversion): `--in F`
 *              takes the block whose id == the target #id; `--in F#src` takes
 *              #src. stdin (default, or `--in -`) is raw bytes.
 *   modes    · default replaces the WHOLE block, `--head` only the head line,
 *              `--body` only the body, `--intro` a heading's opening region.
 *              Default and `--head` NORMALIZE the content's id to #id (its
 *              source id is irrelevant); `--body` keeps the target's head
 *              verbatim, so #id is preserved naturally.
 *
 * Every splice is guarded — re-parsed and refused if it broke the document.
 * Returns the updated text; the host decides where it lands.
 */
export function set(source: string, file: string, rawSel: string, o: SetOptions, ctx: VerbContext): { text: string } {
  const headOnly = o.part === "head";
  const { named, content } = o;
  const rawChannel = content.kind === "raw";

  // GEP 0011: `set '#fy[2]["Q1"]'` writes ONE unit inside a block. It is
  // planned as a new body for that block and put back through the same guarded
  // splice `--body` uses, so a coordinate write cannot reach past the block it
  // names — and every case where the bytes are not here to change is refused
  // rather than approximated.
  const setSel: Selector = parseSelector(rawSel, (braces) => parseAttrs(braces).id);
  if (setSel.form === "coord") {
    const reserved = reservedMeta(source, file, setSel.base, ctx);
    if (reserved) return setMeta(source, file, rawSel, setSel, reserved.view, content, named, ctx);
    return setCoord(source, file, rawSel, setSel, content, named, ctx);
  }

  const target = resolveSetTarget(source, file, rawSel, ctx);

  if (o.part === "intro") return setIntro(source, file, target, content, ctx);
  if (o.part === "body") return setBody(source, file, target, content, ctx);

  let text: string;
  if (rawChannel) {
    text = content.text;
    if (text === "") fail(NO_CONTENT, 1);
    // Default mode wants exactly ONE block. Pure prose has no head to carry the
    // id (steer to --body); multiple blocks are `add`'s job. --head takes a
    // lone head line, so it skips the whole-block shape check.
    //
    // 除非**目标本身就是一段散文**（GEP-0010 的散文运行）：那时散文正是它该有的
    // 内容，也没有 id 要扛——它的地址由前后邻居决定，不写在文本里。以前这里一律
    // 让人改用 --body，而散文没有 body，于是那条建议把新内容**追加**在旧散文后面，
    // 旧的一个字没删。
    const targetIsProse = target.unit.kind === "prose";
    if (!headOnly) {
      const shape = contentShape(text);
      if (shape === "empty") fail(NO_CONTENT, 1);
      if (shape === "prose" && !targetIsProse) fail(`content is prose, not a block — use --body to set the body of ${target.label}`, 1);
      if (shape === "multi") fail("set replaces ONE block, but the content has multiple blocks (use add)", 1);
    }
  } else {
    text = extractBlock(content, target.unit.id ?? "", headOnly ? "head" : "whole");
  }
  // §5.2: `@<hex>` is not an id, so "normalize the content's id to the target's"
  // has no subject — the content is used verbatim, and an id it brings that
  // collides is caught by the splice guard like any other. An id target keeps
  // normalizing: naming an id on the command line IS the instruction that the
  // result carries that id (block-mutation design §4.0).
  // …but content that ALREADY resolves to that id needs no rewrite. A heading
  // derives its id from its own text, so `## Alpha` is already `#alpha`, and
  // stamping `{#alpha}` onto it would only add an attribute object — invisible
  // to GEML, visible junk in the GitHub-Flavored Markdown these verbs also
  // address. The judge is the parser itself, never a second copy of the slug
  // rule: whatever id the content parses to is the id it has.
  // 散文运行的地址是位置派生的，没有 id 可往内容里盖——盖了只会在散文里多出一个
  // `{#…}`。所以这一步跳过它。
  const carries = target.unit.id !== undefined && addressedUnits(text)[0]?.unit.id === target.unit.id;
  const stamp = target.unit.id !== undefined && !carries && target.unit.kind !== "prose";
  const replacement = stamp ? normalizeBlockId(text, target.unit.id as string) : text;
  const updated = spliceSpan(source, target.unit.span, replacement, file, ctx, headOnly, false, target.unit.id);
  reportNewAddress(updated, target, ctx);
  return { text: updated };
}

// `set --intro` — replace only what a heading says before its first subheading.
// The heading line and everything from that subheading down stay byte-identical,
// which is the whole point: the region `get --intro` hands out is the region
// `set --intro` puts back, so a read-edit-write round trip cannot swallow the
// subsections. When the region is EMPTY (a subheading follows the heading
// immediately) this inserts there — writing an opening for a section that had
// none is the same operation as replacing one that did.
function setIntro(source: string, file: string, target: SetTarget, content: Content, ctx: VerbContext): { text: string } {
  if (target.unit.kind !== "heading") {
    fail(`--intro names a heading's opening region, and \`${target.label}\` is a \`${target.unit.type ?? target.unit.kind}\` block — use --body for a block's content`, 2);
  }
  const region = narrowToIntro(source, target.unit.span);
  let body = content.kind === "raw" ? content.text : extractBlock(content, target.unit.id ?? "", "body");
  if (content.kind === "raw" && body === "") fail(NO_CONTENT, 1);
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
  const updated = spliceSpan(source, region, body, file, ctx, false, false, target.unit.id);
  reportNewAddress(updated, target, ctx);
  return { text: updated };
}

// `--body`: swap ONLY the target block's body, keeping its head (and #id) and,
// for a typed block, its close fence. Assembles head + new body + close and
// reuses the guarded splice — the head carries #id, so the id survives with no
// normalization needed.
function setBody(source: string, file: string, target: SetTarget, content: Content, ctx: VerbContext): { text: string } {
  const found = target.unit.span;
  const lines = splitLines(source);
  const headLine = lines[found.start] ?? "";

  // A typed block keeps its closing fence; a heading section has none. Decided
  // by the same helper `get --body` uses, so the two agree on the span and the
  // §4 round-trip invariant holds.
  const closeLine = closeFenceLine(lines, found);

  let body: string;
  if (content.kind === "raw") {
    body = content.text;
    if (body === "") fail(NO_CONTENT, 1);
  } else {
    body = extractBlock(content, target.unit.id ?? "", "body");
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
  const updated = spliceSpan(source, found, replacement, file, ctx, false, closeLine !== null, target.unit.id);
  reportNewAddress(updated, target, ctx);
  return { text: updated };
}

// `set '#meta["key"]'` (GEP 0011). First definition wins, so the write has to
// land where the value is actually READ from, or it would not take effect: the
// block that owns the definition in force. A key defined nowhere is created in
// the first `meta` block — the only place a new key is guaranteed to win.
//
// Landing everything on the first block instead would also take effect, but it
// would demote an author's existing definition into a `duplicate-meta-key`
// warning nobody wrote.
function setMeta(
  source: string,
  file: string,
  rawSel: string,
  sel: Extract<Selector, { form: "coord" }>,
  view: MetaView,
  content: Content,
  named: string[],
  ctx: VerbContext,
): { text: string } {
  if (named.length > 0) {
    fail(`${named.join(" and ")} names part of a block, and \`#meta\` names a merged view rather than one block`, 2);
  }
  if (sel.path.length !== 1 || sel.path[0]!.kind !== "key") {
    fail(`\`${rawSel.trim()}\`: a meta key is written as \`#meta["<key>"]\` — one quoted key, and nothing deeper`, 1);
  }
  const key = (sel.path[0] as { kind: "key"; name: string }).name;
  const value = contentText(content).replace(/\r?\n$/, "");
  if (value === "") fail(NO_CONTENT, 1);

  const ownerIdx = view.owner.get(key) ?? 0;
  const all = addressedUnits(source);
  const metaUnits = all.filter((a) => a.unit.type === "meta").map((a) => a.unit);
  const unit = metaUnits[ownerIdx];
  if (!unit) fail(`\`${rawSel.trim()}\`: this document has no \`meta\` block to write into`, 1);

  const lines = splitLines(source);
  const closeLine = closeFenceLine(lines, unit!.span);
  const bodyEnd = closeLine !== null ? unit!.span.end - 1 : unit!.span.end;
  const bodyLines = lines.slice(unit!.span.start + 1, bodyEnd).map((l) => toLf(l).replace(/\n$/, ""));

  const plan = planMetaWrite(key, value, bodyLines);
  if (!plan.ok) fail(`\`${rawSel.trim()}\`: ${plan.why}`, 1);

  let head = lines[unit!.span.start] ?? "";
  if (head !== "" && !/(\r\n|\r|\n)$/.test(head)) head += "\n";
  // Every line carries its own terminator: `join("\n")` would collapse a body
  // whose last line is empty — ["a", ""] is `a\n\n` in the file and joins back
  // to `a\n` — and a coordinate write may not move a byte it was not asked to.
  const bodyEndsInNewline = /(\r\n|\r|\n)$/.test(lines[bodyEnd - 1] ?? "");
  let body = plan.body.map((l) => `${l}\n`).join("");
  if (!bodyEndsInNewline) body = body.replace(/\n$/, "");
  const replacement = closeLine !== null ? head + body + closeLine : head + body;
  return { text: spliceSpan(source, unit!.span, replacement, file, ctx, false, closeLine !== null, unit!.id) };
}

// A coordinate write (GEP 0011). The unit is inside a block, so what changes
// is the block's BODY: plan the new body from the old one, then hand it to the
// same span splice `set --body` uses — re-parsed and block-count guarded, so a
// value carrying a fence cannot inject siblings.
function setCoord(
  source: string,
  file: string,
  rawSel: string,
  sel: Extract<Selector, { form: "coord" }>,
  content: Content,
  named: string[],
  ctx: VerbContext,
): { text: string } {
  if (named.length > 0) {
    fail(`${named.join(" and ")} names part of a BLOCK, and a coordinate already names a unit inside one`, 2);
  }
  const where = file === "-" ? "<file>" : file;
  const { units, all } = selectUnits(source, file, rawSel, where, ctx, true);
  const unit = units[0]!;
  const node = unitNode(source, file, unit, all, ctx) as Block;

  const value = contentText(content).replace(/\r?\n$/, "");
  if (value === "") fail(NO_CONTENT, 1);

  // The same slicing `--body` uses, so the lines handed to the planner are the
  // lines the parser numbered its rows against.
  const lines = splitLines(source);
  const closeLine = closeFenceLine(lines, unit.span);
  const bodyEnd = closeLine !== null ? unit.span.end - 1 : unit.span.end;
  const bodyLines = lines.slice(unit.span.start + 1, bodyEnd).map((l) => toLf(l).replace(/\n$/, ""));

  const plan = planCoordWrite(node, sel.path, value, bodyLines);
  if (!plan.ok) fail(`\`${rawSel.trim()}\`: ${plan.why}`, 1);

  let head = lines[unit.span.start] ?? "";
  if (head !== "" && !/(\r\n|\r|\n)$/.test(head)) head += "\n";
  // Every line carries its own terminator: `join("\n")` would collapse a body
  // whose last line is empty — ["a", ""] is `a\n\n` in the file and joins back
  // to `a\n` — and a coordinate write may not move a byte it was not asked to.
  const bodyEndsInNewline = /(\r\n|\r|\n)$/.test(lines[bodyEnd - 1] ?? "");
  let body = plan.body.map((l) => `${l}\n`).join("");
  if (!bodyEndsInNewline) body = body.replace(/\n$/, "");
  const replacement = closeLine !== null ? head + body + closeLine : head + body;
  return { text: spliceSpan(source, unit.span, replacement, file, ctx, false, closeLine !== null, unit.id) };
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export interface AddOptions {
  content: Content;
  append: boolean;
  before?: string;
  after?: string;
}

/**
 * `geml add <file> (--append | --before #x | --after #x) [--in F|F#src|-]` —
 * insert a GEML fragment (1+ blocks and/or prose) at a position. Unlike `set`,
 * `add` names no target id, so content keeps its OWN ids (no normalization); an
 * id colliding with the document (or duplicated within the fragment) makes the
 * re-parse fail and nothing is written. Bare prose is a valid fragment.
 */
export function add(source: string, file: string, o: AddOptions, ctx: VerbContext): { text: string } {
  const { content, append, before, after } = o;
  // Content: --in F#src -> block #src; --in F -> all of F (a multi-block
  // fragment is fine here); stdin -> raw. No id-normalization: add keeps ids.
  let text: string;
  if (content.kind === "raw") text = content.text;
  else if (content.spec.includes("#")) text = extractBlock(content, "", "whole");
  else {
    // A whole file that cannot be read is the usage error `readInput` has
    // always reported (exit 2); a block that cannot be extracted stays exit 1.
    try { text = content.read(content.spec); }
    catch (e) { throw e instanceof VerbError ? new VerbError(e.message, 2) : e; }
  }
  if (text.trim() === "") fail("no content to add (use --in FILE or pipe it on stdin)", 1);

  // Resolve the physical-line insertion point.
  const lines = splitLines(source);
  let at: number;
  if (append) {
    at = lines.length;
  } else {
    const anchorId = (before ?? after)!.replace(/^#/, "");
    const span = blockSpans(source).get(anchorId);
    if (!span) fail(`no block with id \`${anchorId}\` in ${whereOf(file)}`, 1);
    at = before !== undefined ? span!.start : span!.end;
  }

  return { text: insertFragment(source, lines, at, text, file, ctx) };
}

// Splice `fragment` into `source` at physical-line index `at` (splitLines
// coords), separating it from adjacent content with a single blank line so
// blocks don't fuse, then GUARD: the re-parse must be error-free (a colliding
// or duplicate id surfaces as an error diagnostic) and no pre-existing id may
// vanish. Returns the updated text; on any violation fail()s and writes nothing.
function insertFragment(source: string, lines: string[], at: number, fragment: string, file: string, ctx: VerbContext): string {
  const beforeIds = parse(source, { ...ctx.docOpts(file), self: selfOf(file) }).ids;
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

  const reparsed = parse(updated, { ...ctx.docOpts(file), self: selfOf(file) });
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

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

/**
 * `geml delete <file> #id [#id2 …]` — remove one or more blocks. A missing id
 * is SKIPPED with a note (declarative "ensure absent", not an error). Unlike
 * set/add, delete's write is LENIENT: removing a complete block can't break the
 * parse structurally, but it may leave a reference dangling — that is a WARNING,
 * never a refusal (delete is reversible via revert + history, and `geml check`
 * still flags the dangling ref afterward). Contained/overlapping spans (a
 * nested block inside a deleted heading section) are handled by deleting the
 * UNION of target lines, so a line is never spliced twice. With nothing to
 * remove, the text comes back unchanged.
 */
export function del(source: string, file: string, ids: string[], ctx: VerbContext): { text: string } {
  const spans = blockSpans(source);
  const toDelete = new Set<number>();
  let found = 0;
  for (const raw of ids) {
    const id = raw.replace(/^#/, "");
    const span = spans.get(id);
    if (!span) { ctx.note(`skipped #${id}: no such block`); continue; }
    found++;
    for (let i = span.start; i < span.end; i++) toDelete.add(i);
  }
  if (found === 0) return { text: source }; // nothing to remove

  const updated = splitLines(source).filter((_, i) => !toDelete.has(i)).join("");
  // Lenient guard: surface any resulting error diagnostic (a reference now
  // dangling) as a WARNING, but write regardless.
  const reparsed = parse(updated, { ...ctx.docOpts(file), self: selfOf(file) });
  for (const d of reparsed.diagnostics.filter((x) => x.severity === "error")) {
    ctx.note(`warning: ${d.message} (line ${d.line}) — left dangling by delete; run 'geml check' to see it as an error`);
  }
  return { text: updated };
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

export interface RenameOptions {
  /**
   * The tip revision of the document's `.gemlhistory`, when the host has one:
   * renaming an id that has recorded history breaks the revert-lineage for it
   * (revert keys by id and can't follow #old -> #new across the boundary), so
   * the caller is warned that a later `revert #new` won't reach pre-rename
   * revisions.
   */
  historyTip?: string;
}

/**
 * `geml rename <file> #old #new` — the one verb that reaches OUTSIDE a block:
 * it rewrites #old's declaration AND every reference to it. #new must be free;
 * the guarded re-parse refuses anything that would break the doc.
 */
export function rename(source: string, file: string, rawOld: string, rawNew: string, o: RenameOptions, ctx: VerbContext): { text: string } {
  const oldId = rawOld.replace(/^#/, "");
  const newId = rawNew.replace(/^#/, "");
  if (oldId === newId) fail("#old and #new are the same id — nothing to rename", 2);

  const before = parse(source, { ...ctx.docOpts(file), self: selfOf(file) });
  const hasName = (ids: string[], n: string) => ids.some((x) => nameKey(x) === nameKey(n));
  if (!hasName(before.ids, oldId)) fail(`no block with id \`${oldId}\``, 1);
  if (hasName(before.ids, newId)) fail(`id \`${newId}\` already exists; not written`, 1);

  if (o.historyTip !== undefined && blockSpans(o.historyTip).has(oldId)) {
    ctx.note(`warning: #${oldId} has history; revert across this rename is not tracked — see docs`);
  }

  const updated = rewriteId(source, oldId, newId, file, ctx);
  const reparsed = parse(updated, { ...ctx.docOpts(file), self: selfOf(file) });
  const errs = reparsed.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) { const e = errs[0]!; refuseBroken(`rename would break the document: ${e.message} (line ${e.line}); not written`, errs); }
  if (!hasName(reparsed.ids, newId)) fail(`rename did not produce #${newId}; not written`, 1);
  if (hasName(reparsed.ids, oldId)) fail(`#${oldId} still present after rename; not written`, 1);
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
  return { text: updated };
}

// Rewrite id `old` -> `new` everywhere it is a declaration or reference, id-
// boundary-safe: `#old` is replaced only when NOT followed by an id char, so a
// longer id like `#old2` / `#old-x` is untouched. Covers the declaration
// (`{#old …}`, labeled close `=== #old`), block references (`[[#old]]`,
// `[t](#old)`, chart `data=#old`) and footnotes (`[^old]`). RAW / data block
// BODIES (code/diagram/math/table/meta) are skipped — a `#old` there is literal
// text, not a reference. (Known residual: id-less raw bodies and inline
// code/math spans in flow content — see design §8.)
function rewriteId(source: string, oldId: string, newId: string, file: string, ctx: VerbContext): string {
  const doc = parse(source, { ...ctx.docOpts(file), self: selfOf(file) });
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

// ---------------------------------------------------------------------------
// The guarded splice — shared by set, replace and revert
// ---------------------------------------------------------------------------

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
// violation it fails and never returns a corrupt document. Shared by `set` and
// `revert`.
function spliceBlock(source: string, id: string, replacement: string, file: string, ctx: VerbContext, headOnly = false, guardCount = false): string {
  const found = blockSpans(source).get(id);
  if (!found) fail(`no block with id \`${id}\``, 1);
  return spliceSpan(source, found!, replacement, file, ctx, headOnly, guardCount, id);
}

// How many typed blocks a document holds. Ids only account for the named ones,
// so this is what makes an unnamed block's removal reportable instead of silent
// — the whole point of treating both the same.
function countBlockUnits(source: string): number {
  let n = 0;
  for (const a of addressedUnits(source)) if (a.unit.kind === "block") n++;
  return n;
}

// The error diagnostics an edit ADDED. A defect the document already carried is
// not this edit's doing, and refusing on it made any document with an older
// problem permanently unwritable — while saying "would break the document"
// about an edit that broke nothing. It bites hardest on the plain Markdown
// these verbs also address: a `[…](#anchor)` aimed at an `<a id>` GEML does not
// model reads as an unresolved reference here and as perfectly good Markdown on
// GitHub, so a single such link in a README blocked every write to the file.
// "A broken reference is a build error" is a promise `geml check` keeps — not a
// licence to hold a document hostage.
//
// Counted rather than matched by text: a SECOND `#foo` introduced beside a
// pre-existing one is new breakage and is still refused.
//
// `duplicate-id` is never forgiven, old or new. Every other defect is somewhere
// ELSE in the document; a duplicate id is the one that empties the address this
// write is aimed at — `#intro` naming two blocks means the splice may land on
// the block the caller did not mean. Writing through an ambiguous address is
// refused for the same reason a selector matching several blocks is.
const UNFORGIVEN = new Set(["duplicate-id"]);

// …and only OUTSIDE a GEML document. Inside one, "every reference resolves" is
// the contract its author opted into, and a document that stops honouring it
// stays locked until it is repaired — the MCP server builds on that, telling
// the model the errors predate its edit and to repair them first. A `.md` file
// carries no such contract: it is someone's Markdown, and GEML is reading it as
// a courtesy.
const forgives = (file: string): boolean => file !== "-" && !file.endsWith(".geml");

// Whether EVERY diagnostic that refused this write was already in the document
// before it. When it was, the edit broke nothing, and "would break the
// document" sends the author hunting for a defect in what they just wrote.
// The refusal itself is right and unchanged: inside a `.geml` nothing is
// forgiven, and `duplicate-id` is forgiven nowhere. Only the sentence changes.
// The MCP surface already draws this distinction for the model (mcp-core
// computes it from the diagnostics, not from this prose, so it is unaffected).
const errorKey = (d: Diagnostic): string => `${d.code ?? ""}:${d.message}`;
function predated(before: { diagnostics: readonly Diagnostic[] }, errs: readonly Diagnostic[]): boolean {
  const had = new Set(before.diagnostics.filter((d) => d.severity === "error").map(errorKey));
  return errs.length > 0 && errs.every((d) => had.has(errorKey(d)));
}

// The refusal sentence for a guarded write: what refused it, and whose fault it
// is. `verb` names the edit for the case where the edit really did break it.
function refusalProse(
  before: { diagnostics: readonly Diagnostic[] },
  errs: Diagnostic[],
  verb: string,
): string {
  const first = errs[0]!;
  const what = `${first.message} (line ${first.line})`;
  return predated(before, errs)
    ? `refused by an error the document ALREADY had, which this edit did not cause: ${what}; not written — repair it first (\`geml check\` lists them), until then no write to this document can be validated`
    : `${verb}: ${what}; not written`;
}

function errorsAdded(
  before: { diagnostics: readonly Diagnostic[] },
  after: { diagnostics: readonly Diagnostic[] },
  file: string,
  exclude: (d: Diagnostic) => boolean = () => false,
): Diagnostic[] {
  if (!forgives(file)) {
    return after.diagnostics.filter((d) => d.severity === "error" && !exclude(d));
  }
  const had = new Map<string, number>();
  for (const d of before.diagnostics) {
    if (d.severity === "error" && !UNFORGIVEN.has(d.code ?? "")) had.set(d.message, (had.get(d.message) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return after.diagnostics.filter((d) => {
    if (d.severity !== "error" || exclude(d)) return false;
    const n = (seen.get(d.message) ?? 0) + 1;
    seen.set(d.message, n);
    return n > (had.get(d.message) ?? 0);
  });
}

// The same guarded splice addressed by SPAN rather than by id, because an
// anonymous block (addressed by `@<hex>`) has no id to look one up with. `id`
// is the survival guard's subject and is simply absent for those: every OTHER
// pre-existing id must still survive, which the `dropped` check below covers.
function spliceSpan(
  source: string, found: Span, replacement: string, file: string, ctx: VerbContext,
  headOnly = false, guardCount = false, id?: string,
): string {
  const beforeDoc = parse(source, { ...ctx.docOpts(file), self: selfOf(file) });
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
  const reparsed = parse(updated, { ...ctx.docOpts(file), self: selfOf(file) });
  const now = new Set(reparsed.ids);
  // GEP-0010 的散文地址不在 `ids` 里：它是**位置**派生的（`#容器-before-下一个`），
  // 由前后邻居决定，不写在文本里。只问 `ids` 的话，换掉一段散文永远被判成"把 id 弄
  // 没了"——而位置根本没动，那个地址一个字都不会变。`ids` 里没有时再问一次散文地址。
  const survives = (name: string): boolean =>
    now.has(name) || addressedUnits(updated).some((a) => a.unit.id === name);
  if (id !== undefined && !survives(id)) fail(`replacement removes id \`${id}\`; not written`, 1);
  const droppedIds = beforeIds.filter((x) => x !== id && !now.has(x));
  const droppedAnon = Math.max(0, countBlockUnits(source) - countBlockUnits(updated) - droppedIds.length);

  // A reference left dangling BY THE REMOVAL is a consequence the caller is
  // being told about, exactly as `delete` tells them. A reference the new
  // content itself introduces is a broken write and is still refused — the
  // difference is whether the missing target is one of the blocks this splice
  // took away.
  const collateral = (d: Diagnostic): boolean =>
    droppedIds.some((x) => d.message.includes(`\`#${x}\``) || d.message.includes(`#${x}\``));
  const errs = errorsAdded(beforeDoc, reparsed, file, collateral);
  if (errs.length) {
    refuseBroken(refusalProse(beforeDoc, errs, "replacement would break the document"), errs);
  }
  if (droppedIds.length || droppedAnon) {
    const named = droppedIds.map((x) => `\`#${x}\``).join(", ");
    const anon = droppedAnon ? `${droppedAnon} unnamed block${droppedAnon > 1 ? "s" : ""}` : "";
    ctx.note(`dropped ${[named, anon].filter(Boolean).join(" and ")} — run 'geml revert' to put them back`);
    for (const d of reparsed.diagnostics.filter((x) => x.severity === "error" && collateral(x))) {
      ctx.note(`warning: ${d.message} (line ${d.line}) — left dangling by the replacement; run 'geml check' to see it as an error`);
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
  // The count above sees only TOP-LEVEL children. A block nested in a note is
  // not one of them, so a body fence that closed it early and planted an
  // id-less `=== meta` beside it — inside the note — left that count untouched
  // and the write went through (R5-1). The invariant that actually holds for
  // every guarded splice, top-level or nested: the target block, re-parsed, must
  // span EXACTLY the region that was spliced in. A body that closed it early
  // ends it short of that; whatever follows is the injection.
  if (guardCount) {
    const expectedEnd = span.start + splitLines(inject).length;
    const target = addressedUnits(updated).find((a) =>
      a.unit.kind === "block" && a.unit.span.start === span.start && (id === undefined || a.unit.id === undefined || nameKey(a.unit.id) === nameKey(id)));
    if (!target || target.unit.span.end !== expectedEnd) {
      fail(`replacement does not stay one block (a fence in the body closed ${id !== undefined ? `#${id}` : "the target"} early and injected sibling block(s)?); not written`, 1);
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------

export interface RevertOptions {
  /** `--rev`: `0` | `-N` | id prefix | `changed` (default `-1`). */
  rev: string;
  dryRun: boolean;
  headOnly: boolean;
  before?: string;
  after?: string;
  append: boolean;
  history: HistoryReader;
  /** Word a history-layer failure as the CLI does (no stack, no absolute path). */
  historyError: (e: unknown) => string;
}

/** What `revert` decided; the host performs the write and prints the lines. */
export type RevertResult =
  | { kind: "unchanged"; message: string }
  | { kind: "dry-run"; message: string; preview?: string }
  | { kind: "write"; text: string; verb: string };

/**
 * `geml revert <file> #id [--rev <sel>] [--dry-run] [--head]` — restore ONE
 * block to a past revision's version: a targeted, guarded splice that leaves
 * the rest of the document untouched. <sel> (default `-1`): `0` (the tip),
 * `-N` (N revisions back), an id prefix/suffix, or `changed` — a content
 * selector that skips revisions which never touched the block, landing on its
 * previous *distinct* version.
 */
export function revert(source: string, file: string, rawId: string, o: RevertOptions, ctx: VerbContext): RevertResult {
  const { dryRun, headOnly, before, after, append } = o;
  const to = o.rev;
  // `--rev changed` is a CONTENT selector, not a position: skip commits that
  // never touched this block, landing on its previous *distinct* version. It is
  // just a `--rev` value, so it cannot conflict with a positional `-N`.
  const changed = to === "changed";
  const id = rawId.replace(/^#/, "");

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
        const found = o.history.firstChanged(curBlock === undefined ? "" : norm(curBlock), pick);
        if (!found) fail(`no earlier revision changes \`${id}\``, 1);
        return found!;
      }
      return o.history.resolve(to);
    } catch (e) {
      if (e instanceof VerbError) throw e;
      return fail(o.historyError(e), 1);
    }
  })();

  const oldBlock = pick(target.text);                     // undefined => absent at R

  // Reconcile #id between now and revision R across the four presence cells.
  if (curBlock === undefined && oldBlock === undefined) {
    fail(`\`${id}\` exists in neither the document nor ${target.id} (try --rev changed)`, 1);
  }

  // both present -> SPLICE (undo set)
  if (curBlock !== undefined && oldBlock !== undefined) {
    if (norm(oldBlock) === norm(curBlock)) {
      return { kind: "unchanged", message: `#${id} is unchanged at ${target.id}; nothing to revert${changed ? "" : " (try --rev -2, or --rev changed)"}` };
    }
    const replacement = toFileNl(oldBlock);   // keep the file's newline style
    if (dryRun) {
      return { kind: "dry-run", message: `would revert #${id} to ${target.id}:`, preview: replacement.endsWith("\n") ? replacement : replacement + "\n" };
    }
    return { kind: "write", text: spliceBlock(source, id, replacement, file, ctx, headOnly), verb: `reverted #${id} to ${target.id}` };
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
      return { kind: "dry-run", message: `would resurrect #${id} from ${target.id} at ${where}:`, preview: fragment.endsWith("\n") ? fragment : fragment + "\n" };
    }
    if (warn) ctx.note(`warning: anchors for #${id} are gone; appended at end`);
    return {
      kind: "write",
      text: insertFragment(source, splitLines(source), at, fragment, file, ctx),
      verb: `resurrected #${id} from ${target.id} at ${where}`,
    };
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
    return { kind: "dry-run", message: `would remove #${id} (absent at ${target.id})` };
  }
  const span = curFull!;
  const beforeIds = parse(source, { ...ctx.docOpts(file), self: selfOf(file) }).ids;
  const updated = splitLines(source).filter((_, i) => i < span.start || i >= span.end).join("");
  const reparsed = parse(updated, { ...ctx.docOpts(file), self: selfOf(file) });
  const errs = reparsed.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    const first = errs[0]!;
    refuseBroken(`removing #${id} would break the document: ${first.message} (line ${first.line}); not written`, errs);
  }
  const now = new Set(reparsed.ids);
  const dropped = beforeIds.find((x) => x !== id && !now.has(x));
  if (dropped !== undefined) fail(`removing #${id} would drop block \`#${dropped}\`; not written`, 1);
  return { kind: "write", text: updated, verb: `removed #${id} (absent at ${target.id})` };
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
    return { at: s!.start, where: `before #${a}`, warn: false };
  }
  if (after !== undefined) {
    const a = after.replace(/^#/, "");
    const s = here.get(a);
    if (!s) fail(`no block with id \`${a}\` in ${file}`, 1);
    return { at: s!.end, where: `after #${a}`, warn: false };
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
