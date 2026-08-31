#!/usr/bin/env node
// GEML reference parser — Milestones 1 & 2: block scanner + inline content.
//
// M1: typed-block fences (equal-length close + longer-fence nesting), the
// `meta` data block, ATX headings, lists and paragraphs, the attribute object
// with §4 value typing, and a document-model JSON serialization.
//
// M2: inline parsing of unfenced blocks (§5 — emphasis/strong/strike, code,
// math, media embeds, links, auto-references, footnotes) and build-time
// reference validation (§8 — unique ids, resolvable internal/cross-document
// references).

// The library needs almost nothing from Node: PARSER_VERSION reads the
// package.json beside dist/ at runtime (so it never needs hand-bumping), and
// path joins are pure string math. Everything that touches the filesystem, the
// home directory or a child process now lives in cli.ts — which is what keeps
// this module safe to bundle for a browser.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { save, restore, verify, isCurrent, listRevisions, resolveContent, firstChangedContent } from "./history.js";
import { renderHtml } from "./render-html.js";
import { normalizeBlockId } from "./block-edit.js";
import { type Diagnostic, normalizeSource } from "./diagnostics.js";
import type { DiagnosticCode } from "./diagnostics.js";
import { type Attrs, type Value, coerce, oddNames, parseAttrs } from "./attrs.js";
import { type Inline, type RefSink, META_REF_SRC, parseInline , isSafeUrl, schemeOf } from "./inline.js";
import { type TableCell, type TableModel, parseTable } from "./table.js";
import { type ChartModel, USES, buildChart } from "./chart.js";
import { mdToGeml } from "./from-md.js";
import { serialize } from "./serialize.js";
import {
  type Addressed, type Selector, type Unit,
  addressUnits, discoveryHint, matchContent, matchType, parseSelector, shortestAddress,
} from "./selector.js";
import { gemlToMd } from "./to-md.js";

export { type Value } from "./attrs.js";
export { type Inline } from "./inline.js";
export { type TableModel } from "./table.js";
export { mdToGeml, type ConvertResult } from "./from-md.js";
export { renderHtml, pageAssets } from "./render-html.js";
export { type RenderOptions } from "./render.js";
export { serialize } from "./serialize.js";
export { gemlToMd } from "./to-md.js";

// A block id is any non-whitespace run (§4), so it may contain regex
// metacharacters. Every place that builds a RegExp from an id MUST run it
// through this first, or a crafted id (`#a(`, `#(x+x+)+y`) turns a labeled-close
// or reference match into an uncaught `SyntaxError` or a ReDoS on the main
// parse path (SEC: document-controlled RegExp injection).
export function reLit(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type BodyMode = "raw" | "flow" | "data";

// GEP-0005: the value tree a `data` block's format engine parses its body
// into — exactly JSON's value domain, which is also why `json` is the type's
// default format (the model's own serialization).
export type DataValue = null | boolean | number | string | DataValue[] | { [key: string]: DataValue };

// The `data` block's format engines (GEP-0005), shared by the inline-body
// path and the `src=` pass: parse `body` under `fmt`, returning the value
// and/or diagnostics. `openLineNo` anchors line numbers — the open fence for
// an inline body, the block's own line for external content.
function parseDataBody(fmt: string, body: string[], openLineNo: number): { value?: DataValue; diags: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  if (fmt === "json") {
    const text = body.join("\n");
    try { return { value: JSON.parse(text) as DataValue, diags }; }
    catch (e) {
      diags.push({ severity: "error", code: "data-parse", message: `data: body is not valid JSON (${e instanceof Error ? e.message : String(e)})`, line: jsonErrorLine(e, text, openLineNo) });
    }
  } else if (fmt === "jsonl") {
    const values: DataValue[] = [];
    let ok = true;
    for (let li = 0; li < body.length; li++) {
      const t = body[li]!.trim();
      if (t === "") continue; // blank lines are permitted and ignored
      try { values.push(JSON.parse(t) as DataValue); }
      catch {
        diags.push({ severity: "error", code: "data-parse", message: `data: body line ${li + 1} is not one JSON value`, line: openLineNo + 1 + li });
        ok = false;
      }
    }
    if (ok) return { value: values, diags };
  } else if (fmt === "yaml" || fmt === "toml") {
    diags.push({ severity: "warning", code: "data-format-no-engine", message: `data: no \`${fmt}\` engine in this processor; body kept raw, not verified`, line: openLineNo });
  } else {
    diags.push({ severity: "warning", code: "unknown-data-format", message: `unknown data format \`${fmt}\`; body kept raw`, line: openLineNo });
  }
  return { diags };
}

// Map a JSON.parse failure to the document line it happened on. V8 messages
// carry "at position N" (newer Nodes add line/column, but position is the
// stable token); counting newlines up to it gives the 1-based body line, and
// the open fence line offsets it into the document. No position -> the fence.
function jsonErrorLine(e: unknown, text: string, openLineNo: number): number {
  const m = /position (\d+)/.exec(e instanceof Error ? e.message : "");
  if (!m) return openLineNo;
  return openLineNo + text.slice(0, Number(m[1])).split("\n").length;
}

export interface ListItem {
  text: string;
  inlines: Inline[];
  checked?: boolean; // set when the item is a task list item (§5): `[ ]`/`[x]`
  children?: Block[]; // nested sub-list(s) under this item, by indentation (§5)
}

export type Block =
  | { kind: "heading"; level: number; text: string; inlines: Inline[]; id?: string; classes: string[]; attrs: Record<string, Value>; hidden?: boolean }
  | { kind: "paragraph"; text: string; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start?: number; loose?: boolean; items: ListItem[] }
  | { kind: "hidden"; text: string } // a `%%` line: present in the model, never rendered
  | {
      kind: "block";
      type: string;
      mode: BodyMode;
      id?: string;
      classes: string[];
      attrs: Record<string, Value>;
      raw?: string[];
      children?: Block[];
      data?: Record<string, Value>;
      table?: TableModel;
      chart?: ChartModel;
      value?: DataValue; // `data` block: the parsed value tree (GEP-0005); absent when no engine ran
      hidden?: boolean; // `{hidden}`: in the model & referenceable, not rendered
    };

// Re-exported from ./diagnostics.js so that `Diagnostic` stays importable from
// the package root. The catalogue of codes lives there (spec Appendix A).
export { type Diagnostic, type DiagnosticCode, SEVERITY } from "./diagnostics.js";

import { vocabularyFor, EMPTY_VOCABULARY, type Vocabulary } from "./profiles.js";

export interface Document {
  kind: "document";
  children: Block[];
  ids: string[];
  diagnostics: Diagnostic[];
}

// Optional hook for resolving cross-document references (other.geml#id) at
// build time. Returns the target file's source, or null if it cannot be found.
export interface ParseOptions {
  resolveDoc?: (doc: string) => string | null;
  // Does this target exist at all, even though `resolveDoc` could read no text
  // from it? Only link checking asks — a link to a directory is ordinary and
  // must not be reported as broken, while `src=`/`data=`/`embed` still need
  // bytes and still fail on one. Confinement is the caller's job here exactly
  // as it is for `resolveDoc`: answering `true` for a path outside the root
  // would leak whether it exists.
  docExists?: (doc: string) => boolean;
  // This document's own path in the same coordinates `resolveDoc` uses. Without
  // it the transclusion graph has no name for its root, so a chain that returns
  // to the document it started from (A → B → C → A) walks straight past the
  // cycle: the root is not on the stack under any name it could match.
  self?: string;
}

// Parse context threaded through the scanner: diagnostics, the id registry
// (id -> defining line, for uniqueness), and discovered references.
interface Ctx extends RefSink {
  diags: Diagnostic[];
  ids: Map<string, { line: number; as: string }>;
  meta: Map<string, string>; // merged `=== meta` keys, for `{{key}}` interpolation
  vocab: Vocabulary; // 本文档 `profile=` 声明放行的块类型与属性键（§3.3）
  tables?: Map<string, TableModel>;
  dataValues?: Map<string, DataValue>; // id -> parsed `data` block value (GEP-0005), for chart binding
  // `src=` on a data block: resolved after the scan, like tableSources; ids
  // whose source is render-time (http, or no resolver) land in dataSrcPending
  // so a chart over them defers instead of erroring.
  dataSources?: { block: Extract<Block, { kind: "block" }>; line: number; target: string }[];
  dataSrcPending?: Set<string>;
  charts?: { block: Extract<Block, { kind: "block" }>; line: number }[];
  // `src=`/`data=` on a table: resolved after the scan, because a `#id` target
  // may be defined further down the document (same reason charts get a pass).
  tableSources?: { block: Extract<Block, { kind: "block" }>; line: number; target: string }[];
  codeSources?: { block: Extract<Block, { kind: "block" }>; line: number; target: string }[];
  // id -> the 1-based line of the BARE fence that closed that block. Feeds the
  // stray-labeled-fence warning: a later `=== #id` line that fell through to
  // paragraph text can then name the close that actually ended the block.
  bareClosed?: Map<string, number>;
  resolveDoc?: (doc: string) => string | null; // threaded from ParseOptions
}

// Type registry: which body mode each typed block uses. Unknown types are a
// warning and fall back to `raw` (forward compatibility, §3/§8).
//
// A Map, not an object, because the key is the type name off a fence head — i.e.
// document-controlled. Indexing a plain object with it answered for the whole
// prototype chain: `=== constructor` (also toString, valueOf, hasOwnProperty,
// isPrototypeOf, propertyIsEnumerable, toLocaleString) returned an inherited
// FUNCTION, which is not undefined, so the unknown-block-type warning never
// fired and a function reached the model's `mode` field — a value the published
// `BodyMode` type says cannot occur, and one JSON.stringify silently drops.
// Every other document-keyed registry here is already a Set or a Map.
const REGISTRY = new Map<string, BodyMode>([
  ["code", "raw"],
  ["diagram", "raw"],
  ["math", "raw"],
  ["table", "raw"], // structured table parsing lands in M3
  ["data", "raw"], // GEP-0005: value tree — a format engine parses the raw body in a second stage
  ["embed", "raw"], // block transclusion: `src=` points at the content, body unused
  ["note", "flow"],
  ["text", "flow"], // addressable prose container: an id/attrs for a run of flow, no callout chrome
  ["meta", "data"],
]);

// §7: built-in diagram renderer registry. Unknown formats are a warning (the
// processor keeps the body raw rather than interpreting it).
const DIAGRAM_RENDERERS = new Set(["mermaid", "graphviz", "dot", "d2", "plantuml", "geml-chart", "geml-code-graph"]);

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

// The trailing `[ \t]*` lives INSIDE the optional attrs group on purpose. As
// `…[ \t]*(\{.*\})?[ \t]*$` a head with no attrs had TWO runs competing for the
// same whitespace, and the engine tried every split of it: `=== note` plus 40k
// tabs and one stray byte took 750 ms, growing with the square. With the run
// nested, the no-attrs case has exactly one way to match. Same language —
// checked over a case set plus 60k random strings, byte-identical groups.
export const FENCE_OPEN = /^(={3,})[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*(?:(\{.*\})[ \t]*)?$/;
// Heading head, matched by SCAN rather than by one regular expression. As
// `^(#{1,6})[ \t]+(.*?)[ \t]*(\{[^}]*\})?[ \t]*$` this was the worst expression
// in the parser: a lazy run and two whitespace runs all competing for the same
// characters, so the engine tried every way to divide them. `# T` followed by
// 8k tabs and one `{` took 84 SECONDS — an 8 KB line is a denial-of-service
// payload, and headings are tested against every line of every document.
// Nesting the trailing run only takes it from cubic to quadratic (still 18 s at
// 128k), so the ambiguity has to go, not merely shrink.
//
// The scan reproduces the expression EXACTLY, and the two rules that make it
// exact are both easy to get wrong:
//   * `[^}]*` forbids a `}` INSIDE the group but happily allows `{`, so the
//     group may swallow further open braces;
//   * `(.*?)` is LAZY, so among the possible groups the engine takes the one
//     leaving the SHORTEST text — the FIRST `{` that still works, not the last.
// Together: the group runs to the end of the line and starts at the first `{`
// after the last OTHER `}`. Returns the RegExpExecArray shape the call sites
// already destructure.
// A name in the attribute object that is not a NAME (§4). A WARNING, not an
// error: it has always parsed, documents in the wild rely on the leniency, and
// what the author needs is to be told — `{#a & b}` gives the id `a` and two
// flags called `&` and `b`, which is a legal parse of something nobody wrote.
function reportOddNames(a: Attrs, line: number, diags: Diagnostic[]): void {
  for (const { kind, name } of oddNames(a)) {
    diags.push({
      severity: "warning",
      code: "name-not-a-name",
      message: `${kind} \`${name}\` is not a NAME (§4: letters, digits, \`-\`, \`_\`)`
        + (kind === "flag" ? " — an attribute object is whitespace-separated, so a space in an id or class splits it into flags like this one" : ""),
      line,
    });
  }
}

const HEADING_HEAD = /^(#{1,6})[ \t]+/;
type HeadingMatch = [full: string, hashes: string, text: string, attrs: string | undefined];
function matchHeading(line: string): HeadingMatch | null {
  const m = HEADING_HEAD.exec(line);
  if (!m) return null;
  const rest = trimSpaceTabEnd(line.slice(m[0].length));
  if (rest.endsWith("}")) {
    const lastClose = rest.lastIndexOf("}", rest.length - 2); // the final `}` is the group's own
    const open = rest.indexOf("{", lastClose + 1);
    if (open >= 0) return [line, m[1]!, trimSpaceTabEnd(rest.slice(0, open)), rest.slice(open)];
  }
  return [line, m[1]!, rest, undefined];
}

// Does the text inside a `{…}` group read as an ATTRIBUTE OBJECT (§4), or as
// prose that merely happens to contain braces? Gate for the heading diagnostic
// below: `## Using {#hash} in URLs` really has lost its id and must warn, while
// `# The {{key}} interpolation` and `## Set {a, b} notation` must not. Anchored
// and linear — no lazy run — so the DoS note on matchHeading still holds.
const ATTR_KEY_EQ = /^[A-Za-z][A-Za-z0-9_-]*=/;
function looksLikeAttrObject(inner: string): boolean {
  const t = inner.trim();
  return t !== "" && (t.startsWith("#") || t.startsWith(".") || ATTR_KEY_EQ.test(t));
}
// The last `{…}` group on a heading line that reads as an ATTRIBUTE OBJECT
// (§4), plus whether an object was left unclosed — found in ONE left-to-right
// pass that skips `\` escapes and the §5.3(1) verbatim atoms (a code span or
// inline math: GEML prose documents this very syntax, so
// `## Embed — \`=== embed {src=doc.geml#id}\` explained` QUOTES an object
// rather than losing one). matchHeading only accepts an object that ENDS the
// line, so a group found here with text after it is one the author wrote and
// the parser did not take. Scanning for the GROUP — rather than looking at the
// last `}`, which is what the first version of this check did — is what catches
// `{#top}aaa}`: there the final `}` pairs with nothing and the object that lost
// the id sits further left. One pass, no lazy run, so the DoS note on
// matchHeading still holds.
interface AttrObjectLike { open: number; close: number; inner: string }
function lastAttrObjectLike(text: string): { group: AttrObjectLike | null; unclosed: string | null } {
  let i = 0;
  let pending = -1;                       // the `{` of a group still being read
  let group: AttrObjectLike | null = null;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      let n = 0;
      while (text[i + n] === "`") n++;
      const close = text.indexOf("`".repeat(n), i + n);
      i = close >= 0 ? close + n : i + n;
      continue;
    }
    if (c === "$") {
      const close = text.indexOf("$", i + 1);
      i = close > i + 1 ? close + 1 : i + 1;
      continue;
    }
    // §4's `[^}]*` forbids a `}` inside the object but allows a `{`, so a group
    // runs from the FIRST unmatched `{` to the next `}`.
    if (c === "{") { if (pending < 0) pending = i; i++; continue; }
    if (c === "}") {
      if (pending >= 0) {
        const inner = text.slice(pending + 1, i);
        if (looksLikeAttrObject(inner)) group = { open: pending, close: i, inner };
        pending = -1;
      }
      i++;
      continue;
    }
    i++;
  }
  const tail = pending >= 0 ? text.slice(pending + 1) : "";
  return { group, unclosed: looksLikeAttrObject(tail) ? tail : null };
}
// Clip an author's own text quoted back at them in a message: a heading line is
// unbounded, and a diagnostic gets read in a terminal.
function clip(s: string, max = 48): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
// A line with the exact shape of a labeled close (§3): a `=` run and a `#id`,
// nothing else. Matched against lines that fell through to paragraph text,
// where such a line means the close closed nothing (stray-labeled-fence).
const STRAY_LABELED_FENCE = /^={3,}[ \t]*#(\S+)[ \t]*$/;
// The registered block types (§3's registry), for the fence-like check below:
// an unknown word after `===` is likelier a wall of `=` art or foreign syntax,
// so only a KNOWN type name earns the warning.
const REGISTERED_TYPES = new Set(["code", "diagram", "table", "math", "embed", "note", "text", "meta", "data"]);
// A line that WANTS to open a fence — a `=` run and a registered type name —
// but failed the fence production. The classic shape is bare, unbraced
// attributes (`=== embed src=#a`): the line silently became prose and any
// reference in it was never checked, which buried a real bug (all eight
// embeds of the playground showcase shipped in this shape, rendering as
// paragraphs under a green `check`). Matched, like STRAY_LABELED_FENCE, only
// against lines that fell through to paragraph text — raw block bodies and
// `\`-folded fence lines never reach that position, so the measured corpus
// false-positive rate is zero.
const FENCE_LIKE = /^={3,}[ \t]*([A-Za-z][A-Za-z0-9_-]*)\b/;
// There was a `fence-glued-text` warning here, for a `=` run glued straight to
// its type or id (`===note`, `===#sec`). It existed because the fence
// productions demanded whitespace after the run, so those lines silently became
// prose: a would-be OPEN turned its body into paragraphs, and a would-be CLOSE
// stopped closing, surfacing hundreds of lines later as `unterminated-block`.
// The productions accept them now — §3's grammar (`=== <type> <attrs>?`) never
// required that whitespace, and `\===` is how a line is kept literal (§9) — so
// the failure mode is gone rather than merely reported. What stays invalid is
// a type name that does not start with a letter, and that is diagnosed the same
// whether or not a space precedes it: not at all, exactly as `=== 3col {#a}`
// has always behaved. A glued-only warning would have been the asymmetry.
// Attribute evidence on a fence-like line whose type name is NOT registered: a
// brace, or a `key=` token. With it, `=== aaa}` and `=== aaa src=#a` are
// reported like their registered-type siblings (`=== note}`, `=== note src=#a`)
// — one stray `}` used to buy total silence. Without it, a wall of `=` stays
// quiet: `=== decorative divider ===` has no brace, and `divider ===` is not a
// `key=` token.
const ATTR_EVIDENCE = /[{}]|[A-Za-z][A-Za-z0-9_-]*=/;
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]+(.*)$/;

// Maximum block/list nesting depth the recursive-descent scanner will build
// before emitting a diagnostic instead of recursing further. Guards parse()
// (scanBlocks / parseList) and, in step, the renderer against a deeply nested
// document overflowing the call stack (DoS). 256 is far past any real document.
const MAX_NESTING = 256;

export function isCloseFence(line: string, openLen: number): boolean {
  // trimEnd(), not /\s+$/: the regex is polynomial on a whitespace run that
  // never reaches the end of the line, and this runs once PER LINE of every
  // document parsed. Both strip the same set — JS `\s` and trimEnd's
  // WhiteSpace ∪ LineTerminator are the same code points — so this is an exact
  // swap, just without the backtracking.
  const t = line.trimEnd();
  return /^=+$/.test(t) && t.length === openLen;
}

// The id a heading derives when it carries no explicit `{#id}`.
//
// §4 makes this derivation NORMATIVE and spells it out as five ordered steps,
// because `[[#id]]`, `other.geml#id` and a URL fragment have to name the same
// block in every implementation. The five steps below ARE those steps, in that
// order. Do not improve them here: an "improvement" makes this parser resolve
// references differently from a conforming one, which is the one thing the
// normative wording exists to prevent. Three such improvements were written and
// reverted, and each is a real consequence the spec accepts rather than a defect:
//
//   • `## A - B` derives `a---b`, not `a-b`. Step 5 replaces runs of WHITESPACE;
//     a literal `-` is content, and the spaces flanking it each become their own
//     separator. Likewise `## --root` and `## root` stay distinct ids.
//   • A heading that is only a code span derives the EMPTY id — step 2 deletes a
//     code span "its backticks and its content alike". §4 says so in as many
//     words: such an id "is a derived id like any other and therefore collides
//     with a second such heading; give either one an explicit `{#id}`". Deriving
//     a name from the code span instead also suppresses that `duplicate-id`
//     error, which is a specified diagnostic.
//   • A DERIVED id carries no diacritics: step 2 decomposes and step 4 then
//     deletes every combining mark, so `## Café` derives `#cafe`. Normalising to
//     NFC instead would keep the ones Unicode happens to have a precomposed form
//     for and drop the rest — the same kind of input with two fates, decided by a
//     lookup table. The cost is that headings differing only in their diacritics
//     collide (`duplicate-id`, an error), which in a language where diacritics
//     distinguish words is the normal case; such documents carry explicit ids.
//     An EXPLICIT id is untouched by any of this — it is stored and reported
//     verbatim, and only the NFD comparison in nameKey() makes its two spellings
//     one name.
function slug(text: string): string {
  return text
    .toLowerCase()                                  // §4 step 1
    .normalize("NFD")                                // step 2
    .replace(/`[^`]*`/g, "")                         // step 3
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")            // step 4
    .trim()                                          // step 5
    .replace(/\s+/g, "-");                           // step 6
}

// §4: two NAMEs are the same name when equal after NFD normalization. Every
// comparison of an id, class or attribute key goes through this — never `===` on
// the raw strings, or `Café` written with U+00E9 fails to match the identical
// `Café` written as `e` + U+0301. NFD and not NFC only because decomposing is
// cheaper; the form never escapes, because §4 also requires an id be REPORTED as
// the document wrote it, and §0.5 forbids normalizing the stream itself (it would
// move byte offsets inside a line and break byte-faithful block editing).
export function nameKey(name: string): string {
  return name.normalize("NFD");
}

// ---------------------------------------------------------------------------
// Block scanner
// ---------------------------------------------------------------------------

// §4: substitute `{{key}}` in flow text with the matching `=== meta` value.
// An unknown key is a build error (single-source-of-truth, fail loudly).
// The scan mirrors the §5.3(1) verbatim atoms: a `{{key}}` inside a code span
// or inline math is left untouched (so GEML prose can document this very
// syntax), and a backslash-escaped character can neither open a span nor a
// `{{…}}` reference — `\{{key}}` renders as the literal text `{{key}}`.
const META_REF = new RegExp(META_REF_SRC, "y");
function interpolate(text: string, line: number, ctx: Ctx): string {
  if (!text.includes("{{")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length) {
      out += c + text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 0;
      while (text[i + n] === "`") n++;
      const close = text.indexOf("`".repeat(n), i + n);
      if (close >= 0) { out += text.slice(i, close + n); i = close + n; continue; }
      out += text.slice(i, i + n);   // unclosed run: literal, keep scanning
      i += n;
      continue;
    }
    if (c === "$") {
      const close = text.indexOf("$", i + 1);
      if (close > i + 1) { out += text.slice(i, close + 1); i = close + 1; continue; }
      out += c;
      i++;
      continue;
    }
    if (c === "{" && text[i + 1] === "{") {
      META_REF.lastIndex = i;
      const m = META_REF.exec(text);
      if (m) {
        const key = m[1]!;
        if (ctx.meta.has(key)) out += ctx.meta.get(key)!;
        else {
          ctx.diags.push({ severity: "error", code: "unknown-metadata-reference", message: `unknown metadata reference \`{{${key}}}\``, line });
          out += m[0];
        }
        i = META_REF.lastIndex;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// Register a block id, flagging duplicates as errors (§4: ids unique per doc).
function registerId(ctx: Ctx, id: string, line: number): void {
  const key = nameKey(id);
  const first = ctx.ids.get(key);
  if (first !== undefined) {
    ctx.diags.push({ severity: "error", code: "duplicate-id", message: `duplicate id \`#${id}\` (first defined at line ${first.line})`, line });
  } else {
    ctx.ids.set(key, { line, as: id });
  }
}

// §5: a list marker — `-`/`*` (unordered) or `N.` (ordered) — capturing the
// leading indent (in spaces; a tab counts as 4) and the item content. Nesting
// is decided by that indent.
const MARKER = /^([ \t]*)(?:[-*]|(\d+)\.)[ \t]+(.*)$/;

interface Marker { indent: number; ordered: boolean; start?: number; rest: string; }

function matchMarker(line: string): Marker | null {
  const m = MARKER.exec(line);
  if (!m) return null;
  const ordered = m[2] !== undefined;
  let indent = 0;
  for (const ch of m[1]!) {
    if (ch === '\t') indent += 4;
    else indent += 1;
  }
  const mk: Marker = { indent, ordered, rest: m[3]! };
  if (ordered) mk.start = parseInt(m[2]!, 10);
  return mk;
}

// Leading indentation in COLUMNS (a tab counts as 4), the same measure the
// marker regex feeds into nesting decisions.
function indentColumns(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function makeListItem(mk: Marker, lineNo: number, ctx: Ctx): ListItem {
  let text = interpolate(mk.rest, lineNo, ctx);
  // Task list item: a leading `[ ]` (open) or `[x]`/`[X]` (done) marker — on
  // the item's FIRST line; continuation lines (§2.2) are already joined in,
  // and a `[x]` there is content.
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  const task = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(first);
  const item: ListItem = { text, inlines: [] };
  if (task) {
    item.checked = task[1] !== " ";
    text = (task[2] ?? "") + (nl === -1 ? "" : text.slice(nl));
    item.text = text;
  }
  item.inlines = parseInline(text, lineNo, ctx);
  return item;
}

// §5: parse one list, nesting sub-lists by indentation. A list is a run of marker
// lines; a deeper indent opens a sub-list under the preceding item, a shallower
// indent closes back to an outer list, a blank line between siblings makes the
// list *loose*, and any non-marker line ends the list.
function parseList(lines: string[], i: number, base: number, ctx: Ctx): { block: Block; next: number } {
  const mkList = (m: Marker): Extract<Block, { kind: "list" }> => {
    const l: Extract<Block, { kind: "list" }> = { kind: "list", ordered: m.ordered, items: [] };
    if (m.ordered && m.start !== undefined) l.start = m.start;
    return l;
  };
  const root = mkList(matchMarker(lines[i]!)!);
  const stack: { list: Extract<Block, { kind: "list" }>; indent: number }[] = [{ list: root, indent: matchMarker(lines[i]!)!.indent }];
  let prevBlank = false;
  let tooDeep = false;

  while (i < lines.length) {
    if (lines[i]!.trim() === "") { prevBlank = true; i++; continue; }
    const mk = matchMarker(lines[i]!);
    if (!mk) break; // a non-marker line ends the list
    while (stack.length > 1 && mk.indent < stack[stack.length - 1]!.indent) stack.pop();
    const top = stack[stack.length - 1]!;
    let cur: Extract<Block, { kind: "list" }>;
    if (mk.indent > top.indent) {
      const parent = top.list.items[top.list.items.length - 1];
      if (!parent) break; // deeper indent with no parent item: defensive stop
      if (stack.length >= MAX_NESTING) {
        // Refuse to nest deeper than the cap: keep the item at the current level
        // rather than building a model that overflows the renderer (DoS). One
        // diagnostic per over-deep list; content is preserved, just flattened.
        if (!tooDeep) { ctx.diags.push({ severity: "error", code: "list-nesting-too-deep", message: `list nesting too deep (max ${MAX_NESTING})`, line: base + i + 1 }); tooDeep = true; }
        cur = top.list;
      } else {
        cur = mkList(mk);
        (parent.children ??= []).push(cur);
        stack.push({ list: cur, indent: mk.indent });
      }
    } else {
      // §5: a change of marker type (bullet ↔ ordered) at the same level ends
      // this list; scanBlocks then opens a fresh one at this marker. Without it,
      // `- a` then `1. b` would merge into one mis-typed list (CommonMark §5.3).
      if (mk.ordered !== top.list.ordered) break;
      cur = top.list;
    }
    if (prevBlank && cur.items.length > 0) cur.loose = true;
    // §2.2 continuation lines: a non-blank line directly below the
    // item, indented past its MARKER, that is neither an item line nor a `%%`
    // comment, continues the item's inline content as a soft wrap — the same
    // join a paragraph gives its lines. A blank line still ends the item, so
    // multi-paragraph items remain outside the language.
    let j = i + 1;
    while (j < lines.length) {
      const cand = lines[j]!;
      const body = cand.trim();
      if (body === "" || body.startsWith("%%") || matchMarker(cand) !== null || indentColumns(cand) <= mk.indent) break;
      mk.rest += "\n" + body;
      j++;
    }
    cur.items.push(makeListItem(mk, base + i + 1, ctx));
    prevBlank = false;
    i = j;
  }
  return { block: root, next: i };
}

function scanBlocks(lines: string[], base: number, ctx: Ctx, depth = 0): Block[] {
  const blocks: Block[] = [];
  const diags = ctx.diags;
  let i = 0;

  while (i < lines.length) {
    let line = lines[i]!;
    let consumed = 1;

    // C-01: Attribute line continuation via `\`.
    // If a line looks like a fence or heading and ends with `\`, fold subsequent lines.
    if ((line.startsWith("===") || line.startsWith("#")) && line.endsWith("\\")) {
      let folded = line.slice(0, -1).trimEnd();
      while (i + consumed < lines.length) {
        const next = lines[i + consumed]!.trim();
        if (next.endsWith("\\")) {
          folded += " " + next.slice(0, -1).trimEnd();
          consumed++;
        } else {
          folded += " " + next;
          consumed++;
          break;
        }
      }
      line = folded;
    }

    if (line.trim() === "") { i++; continue; }

    // A `%%` line is hidden: kept in the model (tools can find it), never
    // rendered, and not inline-parsed (so a scratch note can't break the build).
    const hid = /^[ \t]*%%[ \t]?(.*)$/.exec(line);
    if (hid) { blocks.push({ kind: "hidden", text: hid[1]! }); i += consumed; continue; }



    const open = FENCE_OPEN.exec(line);
    if (open) {
      const openLen = open[1]!.length;
      const type = open[2]!;
      const attrs = open[3] ? parseAttrs(open[3]) : { classes: [], attrs: {} };
      const openLineNo = base + i + 1;
      reportOddNames(attrs, openLineNo, diags);

      // Collect the body. A block closes on the FIRST line that is a bare fence
      // of exactly the opening length, OR — when it has an id — a labeled fence
      // `=== #id` (a `=` run of any length ≥ 3 followed by the block's id). The
      // labeled close can't be gotten wrong by miscounting `=`, but it does NOT
      // shadow the bare close: a same-length bare fence in the body still ends
      // the block first, so nesting needs a longer outer fence (§3).
      const labeled = attrs.id !== undefined ? new RegExp(`^={3,}[ \\t]*#${reLit(attrs.id)}[ \\t]*$`) : null;
      const body: string[] = [];
      let j = i + consumed;
      let closed = false;
      let closedByBare = false;
      for (; j < lines.length; j++) {
        if (isCloseFence(lines[j]!, openLen)) { closed = true; closedByBare = true; break; }
        if (labeled && labeled.test(lines[j]!)) { closed = true; break; }
        body.push(lines[j]!);
      }
      // Remember a bare close of an id-bearing block (first definition wins,
      // mirroring ctx.ids): if a `=== #id` line for it turns up later as plain
      // text, the stray-labeled-fence warning can name the line that really
      // closed the block.
      if (closedByBare && attrs.id !== undefined && !ctx.bareClosed?.has(nameKey(attrs.id))) {
        (ctx.bareClosed ??= new Map()).set(nameKey(attrs.id), base + j + 1);
      }
      if (!closed) {
        const how = attrs.id !== undefined ? `${"=".repeat(openLen)} or \`=== #${attrs.id}\`` : "=".repeat(openLen);
        diags.push({ severity: "error", code: "unterminated-block", message: `unterminated \`${type}\` block (no matching ${how})`, line: openLineNo });
      }

      let mode = REGISTRY.get(type);
      if (mode === undefined && ctx.vocab.types.has(type)) {
        // 一个 profile 放行的类型：不再算 unknown。v1 只放行名字，
        // body 仍按 §3 当 raw —— 放宽它影响解析结果，不只是诊断。
        mode = "raw";
      } else if (mode === undefined) {
        diags.push({ severity: "warning", code: "unknown-block-type", message: `unknown block type \`${type}\`; body kept as raw`, line: openLineNo });
        mode = "raw";
      } else {
        // `hidden` (§4) and `caption` (§4, and the label an auto-reference takes
        // per §5.2) are not type-specific: every typed block may carry them. Only
        // the extras below are per type.
        let validRe: RegExp;
        if (type === "table") validRe = /^(src|format|delim|header|format-data|compute\d*|summary\d*|span\d*)$/;
        else if (type === "data") validRe = /^(format|schema|src)$/;
        else if (type === "embed") validRe = /^(src)$/;
        else if (type === "diagram") validRe = /^(src|data|format|format-data|delim|header|type|rows|x|y|size|series)$/;
        else if (type === "code") validRe = /^(lang|src)$/;
        else validRe = /^$/;

        const universal = /^(hidden|caption)$/;
        // 本文档声明的 profile 额外放行的键（§3.3）。在此之前 codemap 的
        // `anchor`/`name`/`entry-via` 硬编码在上面的 `code` 分支里，于是它们在
        // 每份文档的每个 code 块上都静默通过 —— 现在只对声明了 codemap/v1 的
        // 文档放行，其余文档拿回拼写检查。
        const licensed = ctx.vocab.attrs.get(type);

        for (const key of Object.keys(attrs.attrs)) {
          if (universal.test(key) || validRe.test(key)) continue;
          if (licensed?.has(key) === true) continue;
          diags.push({ severity: "warning", code: "unknown-attribute", message: `unknown attribute \`${key}\` for block type \`${type}\``, line: openLineNo });
        }
      }

      const block: Extract<Block, { kind: "block" }> = {
        kind: "block", type, mode, classes: attrs.classes, attrs: attrs.attrs,
      };
      if (attrs.id !== undefined) { block.id = attrs.id; registerId(ctx, attrs.id, openLineNo); }
      if (attrs.attrs["hidden"] === true) block.hidden = true; // §4: not rendered, still in model

      // Block transclusion: `src=` names the content this block stands for, and
      // is registered as an ordinary reference so the existing §8 resolver
      // validates the document and the id. Without that, an embed would be the
      // one reference shape whose rot is silent.
      if (type === "embed") {
        const src = typeof attrs.attrs["src"] === "string" ? (attrs.attrs["src"] as string).trim() : "";
        if (src === "") {
          diags.push({ severity: "error", code: "embed-missing-src", message: "embed: missing `src=`", line: openLineNo });
        } else {
          const hash = src.indexOf("#");
          const docPath = hash < 0 ? src : src.slice(0, hash);
          const anchor = hash < 0 ? undefined : src.slice(hash + 1);
          // §9.5: a destination naming a scheme outside the allowlist MUST NOT be
          // emitted as a navigable or loadable target, and the check belongs HERE —
          // when the model is built — so no consumer of the model can reintroduce
          // it. The attribute is blanked as well as reported, the same treatment a
          // media `src` already gets: a diagnostic alone would still leave the
          // string in `attrs` for a renderer to put in an href.
          if (!isSafeUrl(src)) {
            diags.push({ severity: "error", code: "unsafe-embed-scheme", message: `embed: \`src=${src}\` names a disallowed URL scheme`, line: openLineNo });
            block.attrs = { ...block.attrs, src: "" };
          } else if (docPath !== "" && !/\.geml$/i.test(docPath)) {
            diags.push({ severity: "error", code: "embed-target-not-geml", message: `embed: \`${docPath}\` is not a GEML document; \`src=\` names a \`.geml\` file (optionally with a #fragment)`, line: openLineNo });
          } else if (docPath === "") {
            // Recorded with an empty doc so the self-cycle pass can see it.
            if (anchor !== undefined) (ctx.embeds ??= []).push({ doc: "", anchor, line: openLineNo });
            // `src=#id`: a block of THIS document. Validated against local ids.
            if (anchor !== undefined) ctx.refs.push({ kind: "internal", anchor, line: openLineNo });
          } else {
            ctx.refs.push({ kind: "cross", doc: docPath, anchor, line: openLineNo });
            // Kept apart from refs: a transclusion can pull in a document that
            // transcludes further, so cycle detection has to walk the graph.
            (ctx.embeds ??= []).push(anchor === undefined ? { doc: docPath, line: openLineNo } : { doc: docPath, anchor, line: openLineNo });
          }
        }
        if (body.some((l) => l.trim() !== "")) {
          diags.push({ severity: "warning", code: "ignored-embed-body", message: "embed body is ignored; the target lives in `src=`", line: openLineNo });
        }
      }

      if (mode === "flow") {
        if (depth >= MAX_NESTING) {
          // Refuse to recurse past the cap: emit a diagnostic and keep the body
          // as raw so the parser returns cleanly instead of overflowing the
          // call stack on a pathologically nested document (DoS).
          diags.push({ severity: "error", code: "block-nesting-too-deep", message: `block nesting too deep (max ${MAX_NESTING}); body kept as raw`, line: openLineNo });
          block.raw = body;
        } else {
          block.children = scanBlocks(body, base + i + 1, ctx, depth + 1);
        }
      } else if (mode === "data") {
        block.data = parseData(body);
      } else {
        block.raw = body;
        if (type === "data") {
          // §GEP-0005: the value tree. The body stayed raw at scan time; a
          // format engine parses it here — the same two-stage shape `table`
          // uses. Admission to the format registry requires a SELF-DESCRIBING
          // syntax (bytes alone determine the value): the core ships `json`
          // (default — the model's own serialization) and `jsonl`; `yaml` and
          // `toml` are reserved names with no engine here, and degrade exactly
          // like an unknown `diagram` format: body kept raw, one warning.
          const fmtRaw = attrs.attrs["format"];
          const fmt = fmtRaw === undefined ? "json" : String(fmtRaw);
          // `src=` names external content — the same one-source rule tables
          // have (§6): exactly one of `src=` and an inline body. The engine
          // runs over the file in a second pass (resolveDataSources); running
          // it here over the empty body would report a spurious parse error.
          const srcAttr = typeof attrs.attrs["src"] === "string" ? (attrs.attrs["src"] as string).trim() : undefined;
          const hasBody = body.some((l) => l.trim() !== "");
          if (srcAttr !== undefined && srcAttr !== "" && hasBody) {
            diags.push({ severity: "error", code: "data-src-and-body", message: "data: carries both `src=` and an inline body; exactly one is permitted (the body wins here)", line: openLineNo });
          }
          if (srcAttr !== undefined && srcAttr !== "" && !hasBody) {
            (ctx.dataSources ??= []).push({ block, line: openLineNo, target: srcAttr });
          } else {
            const parsed = parseDataBody(fmt, body, openLineNo);
            for (const d of parsed.diags) diags.push(d);
            if (parsed.value !== undefined) block.value = parsed.value;
          }
          // `schema=` is reference-checked ONLY (GEP-0005): it must name a
          // block or a GEML document; validating the value against it is a
          // later GEP. The reference goes through the ordinary §8 resolver so
          // a dangling schema rots loudly like any other reference.
          const schema = attrs.attrs["schema"];
          if (schema !== undefined) {
            const s = typeof schema === "string" ? schema.trim() : "";
            if (s.startsWith("#") && s.length > 1) {
              ctx.refs.push({ kind: "internal", anchor: s.slice(1), line: openLineNo });
            } else if (/\.geml(#|$)/i.test(s)) {
              const h = s.indexOf("#");
              if (h < 0) ctx.refs.push({ kind: "cross", doc: s, anchor: undefined, line: openLineNo });
              else ctx.refs.push({ kind: "cross", doc: s.slice(0, h), anchor: s.slice(h + 1), line: openLineNo });
            } else {
              diags.push({ severity: "error", code: "bad-data-schema", message: `data: \`schema=${s}\` must name a block (\`#id\`) or a GEML document (\`doc.geml[#id]\`)`, line: openLineNo });
            }
          }
          // First definition wins, matching ctx.ids/ctx.tables.
          if (block.id !== undefined && block.value !== undefined && !ctx.dataValues?.has(nameKey(block.id))) {
            (ctx.dataValues ??= new Map()).set(nameKey(block.id), block.value);
          }
        } else if (type === "code") {
          // `src=` on a code block is a ROUTE to the code it shows —
          // `<path>[#L<start>[-<end>]]` — resolved in a second pass, like a
          // table's `src=`. The code-graph runtime has always fetched and
          // sliced it at render time; checking it here is what makes a stale
          // range a build error instead of a panel that silently shows a path.
          const srcAttr = typeof attrs.attrs["src"] === "string" ? (attrs.attrs["src"] as string).trim() : undefined;
          if (srcAttr !== undefined && srcAttr !== "") (ctx.codeSources ??= []).push({ block, line: openLineNo, target: srcAttr });
        } else if (type === "table") {
          const srcAttr = typeof attrs.attrs["src"] === "string" ? (attrs.attrs["src"] as string).trim() : undefined;
          // §6: parse the raw body (visual or csv/tsv) into one table model.
          const { model, diagnostics } = parseTable(body, attrs.attrs, openLineNo, ctx);
          if (srcAttr !== undefined) (ctx.tableSources ??= []).push({ block, line: openLineNo, target: srcAttr });
          block.table = model;
          for (const d of diagnostics) diags.push({ ...d, line: openLineNo });
          // First definition wins, matching ctx.ids (a duplicate id is already
          // reported as an error by registerId).
          if (block.id !== undefined && !ctx.tables?.has(nameKey(block.id))) {
            (ctx.tables ??= new Map()).set(nameKey(block.id), model);
          }
        } else if (type === "diagram") {
          const fmt = attrs.attrs["format"];
          if (fmt === "geml-chart") {
            // §7: native chart — resolved in a second pass (data=#id may be
            // defined later in the document).
            if (body.length > 0 && body.some((l) => l.trim() !== "")) {
              diags.push({ severity: "warning", code: "ignored-diagram-body", message: "geml-chart body is ignored; the chart spec lives in attributes", line: openLineNo });
            }
            (ctx.charts ??= []).push({ block, line: openLineNo });
          } else if (fmt === "geml-code-graph") {
            // Code-graph embed (GEP-0003): the ONLY attribute is src=, pointing
            // at a codemap document; roots/depth come from that document's meta
            // ("view config travels with the data"). Body is empty.
            const src = attrs.attrs["src"];
            if (typeof src !== "string" || src === "") {
              diags.push({ severity: "warning", code: "code-graph-missing-src", message: "geml-code-graph: missing `src=` (nothing to render)", line: openLineNo });
            } else if (ctx.resolveDoc && ctx.resolveDoc(src) === null) {
              diags.push({ severity: "warning", code: "code-graph-unresolvable-document", message: `geml-code-graph: cannot resolve document \`${src}\``, line: openLineNo });
            }
            if (body.length > 0 && body.some((l) => l.trim() !== "")) {
              diags.push({ severity: "warning", code: "ignored-diagram-body", message: "geml-code-graph body is ignored; the embed is configured by `src=` alone", line: openLineNo });
            }
          } else if (typeof fmt === "string" && !DIAGRAM_RENDERERS.has(fmt) && !ctx.vocab.formats.has(fmt)) {
            // §7: warn on a diagram format with no registered renderer — unless a
            // declared vocabulary admits it (§8.6.1). A diagram's format selects a
            // RENDERER and its body is raw either way, so admitting one cannot move
            // the document model; `table`/`data` formats choose how the body parses
            // and are deliberately not admissible.
            diags.push({ severity: "warning", code: "unknown-diagram-format", message: `no registered renderer for diagram format \`${fmt}\`; body kept raw`, line: openLineNo });
          }
        }
      }

      blocks.push(block);
      i = closed ? j + 1 : j;
      continue;
    }

    const h = matchHeading(line);
    if (h) {
      const lineNo = base + i + 1;
      const level = h[1]!.length;
      const rawText = h[2]!;
      const a = parseAttrs(h[3] ?? "");
      reportOddNames(a, lineNo, diags);
      const text = interpolate(rawText, lineNo, ctx);
      const id = a.id ?? slug(rawText);
      registerId(ctx, id, lineNo);
      // Sibling trap to fence-like-line: an attribute object that does not END
      // the heading line is not an attribute object at all — matchHeading
      // requires the `}` to be last (§4) — so `# T {#top}aaa` keeps the DERIVED
      // id and the explicit one becomes unaddressable, silently. Worse than a
      // lost id: a heading's section runs to the next heading of its level, so
      // `geml get`/`set`/`revert` on what is left resolves to the whole rest of
      // the document, and a one-block revert becomes a whole-document one.
      if (h[3] === undefined) {
        const { group, unclosed } = lastAttrObjectLike(rawText);
        const wrote = (inner: string): string | undefined => parseAttrs(`{${inner}}`).id;
        const lost = (meant: string | undefined): string =>
          meant !== undefined
            ? ` — the explicit id \`#${meant}\` is lost and the heading keeps its derived id \`#${id}\``
            : ` — its attributes are dropped and the object reads as heading text`;
        if (group !== null && group.close < rawText.length - 1) {
          diags.push({
            severity: "warning", code: "heading-attrs-trailing-text", line: lineNo,
            message: `attribute object \`{${clip(group.inner)}}\` is followed by text on this heading line, so it is NOT parsed as attributes (§4: it has to end the line)`
              + lost(wrote(group.inner)),
          });
        } else if (unclosed !== null) {
          diags.push({
            severity: "warning", code: "heading-attrs-unclosed", line: lineNo,
            message: `attribute object \`{${clip(unclosed)}\` is never closed by \`}\` on this heading line, so it is NOT parsed as attributes (§4)`
              + lost(wrote(unclosed)),
          });
        }
      }
      const block: Extract<Block, { kind: "heading" }> = {
        kind: "heading", level, text, inlines: parseInline(text, lineNo, ctx), id, classes: a.classes, attrs: a.attrs,
      };
      if (a.attrs["hidden"] === true) block.hidden = true;
      blocks.push(block);
      i += consumed;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i, base, ctx);
      blocks.push(block);
      i = next;
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other construct.
    const paraStart = base + i + 1;
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^[ \t]*%%/.test(lines[i]!) &&
      !FENCE_OPEN.test(lines[i]!) &&
      matchHeading(lines[i]!) === null &&
      !LIST_ITEM.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    // A line shaped exactly like a labeled close (`=== #id`) that got this far
    // closed nothing — when the id's block was already ended by a same-length
    // bare fence in its body (§3), everything from that fence on silently fell
    // out of the block. Warn: "ok: no diagnostics" over a truncated document is
    // the failure mode this diagnostic exists for. The id is used only as a Map
    // key here — no RegExp is built from it, so reLit() does not apply.
    for (let k = 0; k < para.length; k++) {
      const stray = STRAY_LABELED_FENCE.exec(para[k]!);
      if (!stray) continue;
      const id = stray[1]!;
      const lineNo = paraStart + k;
      const closedAt = ctx.bareClosed?.get(nameKey(id));
      diags.push({
        severity: "warning", code: "stray-labeled-fence", line: lineNo,
        message: closedAt !== undefined
          ? `labeled fence for \`#${id}\` at line ${lineNo}, but block \`#${id}\` was already closed by a bare fence at line ${closedAt} — body may be silently truncated`
          : `labeled fence for \`#${id}\` closes no block; the line is plain paragraph text`,
      });
    }
    for (let k = 0; k < para.length; k++) {
      // Sibling trap to the stray labeled close: a would-be OPEN fence that
      // missed the production and silently became prose (§3 requires braced
      // attributes; `=== embed src=#a` is the classic miss).
      const like = FENCE_LIKE.exec(para[k]!);
      // A registered type name is evidence by itself; an unregistered one
      // earns the warning only when the rest of the line reads as attributes.
      if (like && (REGISTERED_TYPES.has(like[1]!) || ATTR_EVIDENCE.test(para[k]!.slice(like[0].length)))) {
        // One code, four causes — and the cause decides what the author has to
        // DO, so the message says which one it is. `=== code {` is the common
        // habit (brace opened, closed on a later line): telling its author that
        // "attributes must be braced" is telling them to do what they just did.
        const rest = para[k]!.slice(like[0].length);
        const open = rest.lastIndexOf("{");
        const close = open >= 0 ? rest.indexOf("}", open) : -1;
        const why =
          open >= 0 && close < 0
            ? "its attribute object is never closed by `}` on this line — close it, or end the line with `\\` to fold the object onto the next line"
            : open >= 0 && rest.slice(close + 1).trim() !== ""
              ? "text follows its attribute object, which has to be the last thing on the line"
              : open < 0 && rest.includes("}")
                ? "the `}` on it pairs with no `{`"
                : `attributes must be braced (\`=== ${like[1]} {…}\`)`;
        diags.push({
          severity: "warning", code: "fence-like-line", line: paraStart + k,
          message: `line looks like an open fence for \`${like[1]}\` but is not one — ${why}; the line reads as plain paragraph text`,
        });
      }
    }
    const text = interpolate(para.join("\n"), paraStart, ctx);
    blocks.push({ kind: "paragraph", text, inlines: parseInline(text, paraStart, ctx) });
  }

  return blocks;
}

// Parse `key = val` lines of a `data`-mode block (e.g. meta), §4 value typing.
function parseData(lines: string[]): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    out[raw.slice(0, eq).trim()] = coerce(raw.slice(eq + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Collect the block ids of a (cross-document) source, without validation, for
// resolving `other.geml#id` references.
// S5/S6: a transclusion may pull in a document that transcludes further, so a
// cycle is only visible by walking the graph. Reported at check time — before
// any rendering — so a build fails on the cycle rather than on a placeholder in
// the output. Paths compose the way the renderer composes them: a target inside
// a borrowed document is relative to THAT document.
// `data=rows.csv` on a chart, desugared: the anonymous table it stands for. Built
// by handing the loaded lines to the SAME body parser a `=== table {src=…}` uses,
// with the chart's own `format=`/`header=` carried over, so nothing about how the
// data is read is specific to charts. Returns null when the source could not be
// resolved — the diagnostic is already pushed, in the table rules' own words.
function chartSourceTable(
  ctx: Ctx,
  opts: ParseOptions,
  block: Extract<Block, { kind: "block" }>,
  target: string,
  line: number,
): TableModel | null {
  const scheme = schemeOf(target);
  if (scheme === "http" || scheme === "https") {
    // §9.4: fetched at render time, so there is nothing to chart at build time —
    // the same state a remote-sourced table leaves behind.
    return null;
  }
  if (!opts.resolveDoc) {
    ctx.diags.push({ severity: "warning", code: "unchecked-cross-document-reference", message: `geml-chart: data source \`${target}\` not checked (no document resolver)`, line });
    return null;
  }
  const text = opts.resolveDoc(target);
  if (text === null) {
    ctx.diags.push({ severity: "error", code: "unresolvable-table-source", message: `geml-chart: cannot resolve data source \`${target}\``, line });
    return null;
  }
  const attrs: Record<string, Value> = {
    format: typeof block.attrs["format-data"] === "string" ? block.attrs["format-data"] : inferDataFormat(target),
    header: block.attrs["header"] === undefined ? true : block.attrs["header"],
  };
  // A chart reading a `;`-delimited export needs the same delimiter override a
  // table does; the table rules validate it (§6).
  const delim = block.attrs["delim"];
  if (delim !== undefined) attrs["delim"] = delim;
  const { model, diagnostics } = parseTable(normalizeSource(text).split("\n"), attrs, line, ctx);
  for (const d of diagnostics) ctx.diags.push({ ...d, line });
  model.src = target;
  return model;
}

const inferDataFormat = (target: string): string => (/\.tsv$/i.test(target) ? "tsv" : "csv");

// The renderer's own cap (render.ts EMBED_DEPTH_CAP). Kept in step here so the
// check and the render agree on which documents are reachable at all.
export const EMBED_DEPTH_LIMIT = 8;

function detectTransclusionCycles(ctx: Ctx, opts: ParseOptions): void {
  if (!opts.resolveDoc || ctx.embeds === undefined || ctx.embeds.length === 0) return;
  const resolve = opts.resolveDoc;
  const embedsOf = new Map<string, { doc: string; anchor?: string }[]>(); // memoized per path
  const reported = new Set<string>();

  // A three-colour DFS over DOCUMENTS, not over paths. Enumerating every path
  // through the graph is exponential in its fan-out: a chain of 21 tiny files,
  // each embedding the next three times, took over two minutes — and `check` is
  // the CI gate and the validator every MCP write runs twice. Grey means "on the
  // current stack" and is the cycle; black means already fully explored, so each
  // edge is walked once and the whole traversal is O(V+E).
  const colour = new Map<string, "grey" | "black">();

  const walk = (path: string, base: string, stack: string[], line: number): void => {
    const rel = relJoinPath(base, path);
    if (colour.get(rel) === "grey") {
      const chain = [...stack, rel].join(" → ");
      if (reported.has(chain)) return;
      reported.add(chain);
      ctx.diags.push({ severity: "error", code: "transclusion-cycle", message: `transclusion cycle: ${chain}`, line });
      return;
    }
    if (colour.get(rel) === "black") return;
    // Agree with the renderer about what is even reachable, instead of exploring
    // eight times deeper than it will ever expand.
    if (stack.length >= EMBED_DEPTH_LIMIT) return;

    colour.set(rel, "grey");
    let inner = embedsOf.get(rel);
    if (inner === undefined) {
      const src = resolve(rel);
      inner = src === null ? [] : gatherEmbeds(src); // an unresolvable doc is already an error
      embedsOf.set(rel, inner);
    }
    for (const e of inner) walk(e.doc, relDirPath(rel), [...stack, rel], line);
    colour.set(rel, "black");
  };

  // The root is named so a chain can be seen returning to it. Falling back to ""
  // only loses the A→…→A case, which is what happened before `self` existed.
  const root = opts.self ?? "";
  for (const e of ctx.embeds) walk(e.doc, relDirPath(root), [root], e.line);
}

// The smallest cycle of all, and the one the cross-document walk above cannot
// see: `=== embed {src=#sec}` written INSIDE the section `#sec` selects the slice
// that contains it. Decided on spans, so the boundary is exactly the one `geml
// get` uses — a heading id spans its whole section, so an embed anywhere in that
// section is inside its own target.
function detectSelfEmbedCycles(source: string, ctx: Ctx): void {
  const selfEmbeds = (ctx.embeds ?? []).filter((e) => e.doc === "" && e.anchor !== undefined);
  if (selfEmbeds.length === 0) return;
  const spans = blockSpans(source);
  for (const e of selfEmbeds) {
    const span = spans.get(e.anchor!);
    if (span === undefined) continue; // a missing id is already an unresolved reference
    const line = e.line - 1; // spans are 0-based line indices
    if (line >= span.start && line <= span.end) {
      ctx.diags.push({
        severity: "error",
        code: "transclusion-cycle",
        message: `transclusion cycle: \`#${e.anchor}\` selects the content this embed is part of`,
        line: e.line,
      });
    }
  }
}

// A phrase that projects itself. The same shape as detectSelfEmbedCycles, and
// deliberately the same machinery rather than a second parallel one: decided on
// spans, so a projection written anywhere inside its own target is caught.
function detectSelfProjectionCycles(source: string, ctx: Ctx): void {
  const local = (ctx.projections ?? []).filter((p) => p.doc === undefined);
  if (local.length === 0) return;
  const spans = blockSpans(source);
  for (const p of local) {
    const span = spans.get(p.anchor);
    if (span === undefined) continue;
    const line = p.line - 1;
    if (line >= span.start && line <= span.end) {
      ctx.diags.push({
        severity: "error",
        code: "transclusion-cycle",
        message: `transclusion cycle: \`![[#${p.anchor}]]\` projects the content it is part of`,
        line: p.line,
      });
    }
  }
}

// Inline content that a projection may stand for: a `text` block whose body is a
// single paragraph. Returned so the renderer and this validator agree on one
// definition. Anything else — a heading (and so a whole section), a table, a
// diagram, a multi-paragraph body — is block content, and no amount of syntax
// makes it fit inside a sentence.
export function projectableInlines(blocks: Block[], id: string): { inlines: Inline[] } | "not-inline" | null {
  const key = nameKey(id);
  const found = (function find(bs: Block[]): Block | undefined {
    for (const b of bs) {
      if ((b.kind === "block" || b.kind === "heading") && b.id !== undefined && nameKey(b.id) === key) return b;
      if (b.kind === "block" && b.children) { const inner = find(b.children); if (inner) return inner; }
    }
    return undefined;
  })(blocks);
  if (found === undefined) return null;
  if (found.kind !== "block" || found.type !== "text") return "not-inline";
  const kids = (found.children ?? []).filter((c) => !(c.kind === "paragraph" && c.text.trim() === ""));
  if (kids.length !== 1 || kids[0]!.kind !== "paragraph") return "not-inline";
  return { inlines: (kids[0] as Extract<Block, { kind: "paragraph" }>).inlines };
}

// A projection may only stand for inline content, and the target decides — the
// same shape of rule as `table-source-not-a-table`, not a rule about where the
// reference was written.
function validateProjections(children: Block[], ctx: Ctx, opts: ParseOptions): void {
  for (const p of ctx.projections ?? []) {
    let blocks: Block[] | null = null;
    if (p.doc === undefined) blocks = children;
    else if (opts.resolveDoc) {
      const src = opts.resolveDoc(p.doc);
      if (src === null) continue; // already an unresolvable-document error
      blocks = parse(src).children;
    }
    if (blocks === null) continue; // unchecked without a resolver, like any cross-doc ref
    const got = projectableInlines(blocks, p.anchor);
    if (got === null) continue; // already an unresolved-reference error
    if (got === "not-inline") {
      const target = p.doc === undefined ? `#${p.anchor}` : `${p.doc}#${p.anchor}`;
      ctx.diags.push({
        severity: "error",
        code: "inline-transclusion-not-inline",
        message: `\`![[${target}]]\` projects inline content, but the target is not a single-paragraph \`text\` block; for block content use \`=== embed {src=${target}}\``,
        line: p.line,
      });
    }
  }
}

// Same pure-string path composition the renderer uses (relJoin/relDir there).
export function relJoinPath(base: string, target: string): string {
  if (base === "" || target === "" || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  // A POSIX-absolute base must stay absolute. The segment loop below drops empty
  // segments, and the leading "" of "/tmp/x" IS the root — dropping it silently
  // turned `/tmp/x/part.geml` into the relative `tmp/x/part.geml`, which then
  // resolved against the wrong directory. Windows never showed it: a `C:\…` base
  // has no "/", so relDirPath returns "" and the early return above takes over.
  const rooted = base.startsWith("/");
  const out: string[] = [];
  for (const s of (base + "/" + target).split("/")) {
    if (s === "" || s === ".") continue;
    if (s === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(s);
  }
  return (rooted ? "/" : "") + out.join("/");
}

export function relDirPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}


export function gatherEmbeds(source: string): { doc: string; anchor?: string }[] {
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: new Map(), vocab: EMPTY_VOCABULARY, embeds: [] };
  scanBlocks(normalizeSource(source).split("\n"), 0, ctx);
  return (ctx.embeds ?? []).map((e) => (e.anchor === undefined ? { doc: e.doc } : { doc: e.doc, anchor: e.anchor }));
}

// One rule for "where this data comes from", shared by a table's `src=`
// and a chart's `data=`. Three target forms: a data file, `#id` naming a table
// block in this document, or `doc.geml#id` naming one in another document. An
// unresolvable target is an error — a table whose source silently produced no
// rows used to render as an empty table with no diagnostic at all.
function tableFromDocument(source: string, id: string): TableModel | { records: DataValue } | "not-a-table" | null {
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: new Map(), vocab: EMPTY_VOCABULARY };
  const blocks = scanBlocks(normalizeSource(source).split("\n"), 0, ctx);
  const found = ctx.tables?.get(nameKey(id));
  if (found !== undefined) return found;
  // GEP-0005: a remote `data` block is the other chart-source form; its value
  // is projected by the CALLER (recordsToTable needs the chart's attributes).
  const dv = ctx.dataValues?.get(nameKey(id));
  if (dv !== undefined) return { records: dv };
  const anyBlock = (function find(bs: Block[]): Block | undefined {
    for (const b of bs) {
      if ((b.kind === "block" || b.kind === "heading") && b.id !== undefined && nameKey(b.id) === nameKey(id)) return b;
      if (b.kind === "block" && b.children) { const inner = find(b.children); if (inner) return inner; }
    }
    return undefined;
  })(blocks);
  return anyBlock === undefined ? null : "not-a-table";
}

function resolveTableSources(ctx: Ctx, opts: ParseOptions): void {
  const pending = ctx.tableSources ?? [];
  if (pending.length === 0) return;
  const err = (line: number, code: DiagnosticCode, message: string): void =>
    void ctx.diags.push({ severity: "error", code, message, line });

  // Data files first: a `#id` target may point at a table whose OWN rows come
  // from a file, and this way that table is already populated when it is read.
  for (const { block, line, target } of pending) {
    if (target.includes("#")) continue;
    // §9.4: a remote source is fetched by the RENDERER, not the parser. Leaving
    // `model.src` set with no columns is the state resolveCharts already handles,
    // so a chart over it defers too. Passing it to resolveDoc treated a URL as a
    // filesystem path and failed a spec-conformant document.
    const scheme = schemeOf(target);
    if (scheme === "http" || scheme === "https") continue;
    if (scheme !== null) {
      err(line, "unresolvable-table-source", `table source \`${target}\` names a disallowed URL scheme`);
      continue;
    }
    // A data source is data. Without this the loader read any file under the base
    // — a `.env`, a private key — split it into rows, and put it in the model and
    // the page, with no diagnostic. `embed` already applies the same shape of rule.
    if (!/\.(csv|tsv)$/i.test(target)) {
      err(line, "unresolvable-table-source", `table source \`${target}\` is not a \`.csv\`/\`.tsv\` data file`);
      continue;
    }
    if (!opts.resolveDoc) {
      ctx.diags.push({ severity: "warning", code: "unchecked-cross-document-reference", message: `table source \`${target}\` not checked (no document resolver)`, line });
      continue;
    }
    const text = opts.resolveDoc(target);
    if (text === null) { err(line, "unresolvable-table-source", `cannot resolve table source \`${target}\``); continue; }
    // Reuse the body parser: with `src` dropped, the file's lines are just
    // this table's body, so format/header/compute/summary all behave identically.
    const attrs: Record<string, Value> = { ...block.attrs };
    delete attrs["src"];

    const { model, diagnostics } = parseTable(normalizeSource(text).split("\n"), attrs, line, ctx);
    model.src = target;
    block.table = model;
    for (const d of diagnostics) ctx.diags.push({ ...d, line });
    if (block.id !== undefined) (ctx.tables ??= new Map()).set(nameKey(block.id), model);
  }

  for (const { block, line, target } of pending) {
    const hash = target.indexOf("#");
    if (hash < 0) continue;
    const docPath = target.slice(0, hash);
    const id = target.slice(hash + 1);
    let model: TableModel | undefined;
    if (docPath === "") {
      const local = ctx.tables?.get(nameKey(id));
      if (local === undefined) {
        if (ctx.ids.has(nameKey(id))) err(line, "table-source-not-a-table", `table source \`#${id}\` is not a table`);
        else err(line, "unresolved-reference", `unresolved reference \`#${id}\``);
        continue;
      }
      model = local;
    } else {
      if (!opts.resolveDoc) {
        ctx.diags.push({ severity: "warning", code: "unchecked-cross-document-reference", message: `table source \`${target}\` not checked (no document resolver)`, line });
        continue;
      }
      const text = opts.resolveDoc(docPath);
      if (text === null) { err(line, "unresolvable-document", `cannot resolve document \`${docPath}\``); continue; }
      const remote = tableFromDocument(text, id);
      if (remote === null) { err(line, "unresolved-cross-document-reference", `unresolved reference \`${target}\``); continue; }
      // A table's `src=` names a TABLE. A `data` block is a chart-source form
      // (§7.1, GEP-0005), not a table-source form — the column algebra a
      // borrowing table implies (compute/summary against named columns) has
      // no defined meaning over a value tree.
      if (remote === "not-a-table" || "records" in remote) { err(line, "table-source-not-a-table", `table source \`${target}\` is not a table`); continue; }
      model = remote;
    }
    // Borrowed, not copied in the source: the model is shared, so the borrowing
    // table means exactly what the original means. Its own caption still wins.
    const caption = block.table?.caption;
    block.table = caption === undefined ? model : { ...model, caption };
    if (block.id !== undefined) (ctx.tables ??= new Map()).set(nameKey(block.id), block.table);
  }
}

function gatherIds(source: string): Set<string> {
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: new Map(), vocab: EMPTY_VOCABULARY };
  scanBlocks(normalizeSource(source).split("\n"), 0, ctx);
  return new Set(ctx.ids.keys()); // already NFD keys — compare with nameKey()
}

// Pre-scan for `=== meta` blocks and merge their `key=val` lines, so `{{key}}`
// interpolation can resolve forward references.
//
// The walk descends exactly as scanBlocks/collectSpans do — into FLOW bodies
// only, because a raw or data body is opaque (§3). This used to be a flat regex
// sweep over every line, which read a `=== meta` shown as an EXAMPLE inside a
// longer-fenced `==== code` as a real definition: its keys supplied live
// `{{key}}` values (`geml check` clean, so nothing said so), and a key the
// document also defined at top level warned `duplicate-meta-key` against a
// definition that does not exist. Closing is fenceClose's job too now, so a
// `=== meta {#m}` may close on its labeled fence `=== #m` like any other block.
function collectMeta(lines: string[], diags?: Ctx["diags"]): Map<string, string> {
  const meta = new Map<string, string>();
  const firstLine = new Map<string, number>(); // key → 1-based line of the defining fence
  const walk = (ls: string[], base: number, depth: number): void => {
    for (let i = 0; i < ls.length; i++) {
      const open = FENCE_OPEN.exec(ls[i]!);
      if (!open) continue;
      const type = open[2]!;
      const { end, closed } = fenceClose(ls, i, open);
      const body = ls.slice(i + 1, closed ? end - 1 : end);
      if (type === "meta") {
        const line = base + i + 1; // 1-based, in the original stream
        for (const [k, v] of Object.entries(parseData(body))) {
          if (meta.has(k)) {
            diags?.push({ severity: "warning", code: "duplicate-meta-key",
              message: `meta key \`${k}\` already defined at line ${firstLine.get(k)!}; later definition at line ${line} is ignored`,
              line });
          } else {
            meta.set(k, String(v));
            firstLine.set(k, line);
          }
        }
      } else if ((REGISTRY.get(type) ?? "raw") === "flow" && depth < MAX_NESTING) {
        walk(body, base + i + 1, depth + 1);
      }
      i = end - 1; // the loop's ++ lands on `end`
    }
  };
  walk(lines, 0, 0);
  return meta;
}

// §8: resolve every discovered reference. Internal/autoref/footnote anchors
// must exist in this document; cross-document anchors must resolve in the
// target file when a `resolveDoc` hook is supplied (else reported as unchecked).
function validateRefs(ctx: Ctx, opts: ParseOptions): void {
  const docIds = new Map<string, Set<string>>(); // memoized cross-doc id sets
  for (const ref of ctx.refs) {
    if (ref.kind === "cross") {
      if (!ref.doc) continue;
      // WHAT `#frag` MEANS IS THE TARGET FORMAT'S BUSINESS, and GEML only
      // defines it for GEML. In `page.html#sec` the fragment is an element id;
      // in `notes.md#sec` it is a forge's heading slug or an `<a id>`. Reading
      // either with GEML's own rules got both directions wrong: it accepted
      // `{#brace}` that no forge resolves, refused `<a id="x">` and slug
      // anchors that every forge does, and — this is the part that makes the
      // check untrustworthy rather than merely strict — passed by ACCIDENT
      // whenever the name happened to appear anywhere in the target, which is
      // how this repo's own `../GEML-spec.md#appendix-a-diagnostic-catalogue`
      // was green: that string is in a LINK there, not a definition.
      //
      // So the document must still resolve — a link to a file that is not
      // there is broken whatever its format — and the fragment is left to the
      // format that owns it. Same lesson as directories: do not judge another
      // convention by GEML's rules; a check that guesses teaches people to
      // ignore it.
      const gemlTarget = /\.geml$/i.test(ref.doc);
      if (!gemlTarget && ref.anchor !== undefined && opts.resolveDoc) {
        // The document still has to be there — a link to a missing file is
        // broken whatever its format — but nothing here reads its fragment.
        if (opts.resolveDoc(ref.doc) === null && !opts.docExists?.(ref.doc)) {
          ctx.diags.push({ severity: "error", code: "unresolvable-document", message: `cannot resolve document \`${ref.doc}\``, line: ref.line });
        }
        continue;
      }
      if (!opts.resolveDoc) {
        ctx.diags.push({ severity: "warning", code: "unchecked-cross-document-reference", message: `cross-document reference \`${ref.doc}${ref.anchor ? "#" + ref.anchor : ""}\` not checked (no document resolver)`, line: ref.line });
        continue;
      }
      let ids = docIds.get(ref.doc);
      if (ids === undefined) {
        const src = opts.resolveDoc(ref.doc);
        if (src === null) {
          // A LINK may point at something that exists but has no text to read —
          // a directory, above all: `[the extension](integrations/vscode/)` is
          // an ordinary link that a forge renders as a listing, and calling it
          // broken would fail every real project's README. It carries no ids,
          // so an anchor into it is still an error, and a target that is simply
          // absent still is too. Content routes (`src=`, `data=`, `embed`) do
          // not come through here: they need bytes, and a directory has none.
          if (opts.docExists?.(ref.doc)) {
            docIds.set(ref.doc, new Set());
            if (ref.anchor !== undefined) {
              ctx.diags.push({ severity: "error", code: "unresolved-cross-document-reference", message: `unresolved reference \`${ref.doc}#${ref.anchor}\` (\`${ref.doc}\` has no addressable content)`, line: ref.line });
            }
            continue;
          }
          ctx.diags.push({ severity: "error", code: "unresolvable-document", message: `cannot resolve document \`${ref.doc}\``, line: ref.line });
          docIds.set(ref.doc, new Set());
          continue;
        }
        ids = gatherIds(src);
        docIds.set(ref.doc, ids);
      }
      if (ref.anchor !== undefined && !ids.has(nameKey(ref.anchor))) {
        ctx.diags.push({ severity: "error", code: "unresolved-cross-document-reference", message: `unresolved reference \`${ref.doc}#${ref.anchor}\``, line: ref.line });
      }
      continue;
    }
    // internal, autoref, footnote — anchor must be a known id in this document.
    if (ref.anchor !== undefined && !ctx.ids.has(nameKey(ref.anchor))) {
      const footnote = ref.kind === "footnote";
      const what = footnote ? `footnote \`[^${ref.anchor}]\`` : `reference \`#${ref.anchor}\``;
      const code = footnote ? "unresolved-footnote" : "unresolved-reference";
      ctx.diags.push({ severity: "error", code, message: `unresolved ${what}`, line: ref.line });
    }
  }
}

// `src=` on a `code` block: the route to the code the block shows,
// `<path>[#L<start>[-<end>]]` (1-based, inclusive). The code-graph runtime has
// always fetched and sliced this at render time; resolving it here is what
// turns a range that no longer exists — the source moved or shrank — from a
// silently empty panel into a build error. There is no extension gate (code is
// any language); the safety rule is the resolver's confinement to the document
// tree, widened only by `--root`.
const SOURCE_RANGE = /^L(\d+)(?:-(\d+))?$/;

// One route syntax for the two types whose `src=` fragment position is free —
// `code` and `data`. (A table's is already taken: `src=doc.geml#id` names a
// block.) `<path>[#L<start>[-<end>]]`, 1-based and inclusive; `to === 0` means
// "through end of file". Returns null after reporting, so callers just skip.
function parseSourceRoute(target: string, kind: "code" | "data", line: number, ctx: Ctx): { path: string; from: number; to: number } | null {
  const hash = target.indexOf("#");
  const path = hash < 0 ? target : target.slice(0, hash);
  const frag = hash < 0 ? "" : target.slice(hash + 1);
  if (frag === "") return { path, from: 1, to: 0 };
  const m = SOURCE_RANGE.exec(frag);
  if (!m) {
    ctx.diags.push({ severity: "error", code: "bad-source-range", message: `${kind} source \`${target}\`: unrecognised fragment (expected \`#L<start>\` or \`#L<start>-<end>\`)`, line });
    return null;
  }
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 1 || to < from) {
    ctx.diags.push({ severity: "error", code: "bad-source-range", message: `${kind} source \`${target}\`: line range is empty or starts before line 1`, line });
    return null;
  }
  return { path, from, to };
}

// Slice a resolved file to a route's range, or report that the range no longer
// exists — the signal a stale reference exists at all.
function sliceSourceRange(text: string, route: { from: number; to: number }, target: string, kind: "code" | "data", line: number, ctx: Ctx): string[] | null {
  const all = normalizeSource(text).split("\n");
  // A trailing newline yields a final empty element; it is not a line.
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  if (route.to > all.length) {
    ctx.diags.push({ severity: "error", code: "bad-source-range", message: `${kind} source \`${target}\`: the file has ${all.length} line(s), so lines ${route.from}-${route.to} no longer exist — the range is stale`, line });
    return null;
  }
  return all.slice(route.from - 1, route.to === 0 ? all.length : route.to);
}

function resolveCodeSources(ctx: Ctx, opts: ParseOptions): void {
  for (const { block, line, target } of ctx.codeSources ?? []) {
    const scheme = schemeOf(target);
    // A remote source is fetched by the RENDERER (§9.4), as for a table.
    if (scheme === "http" || scheme === "https") continue;
    if (scheme !== null) {
      ctx.diags.push({ severity: "error", code: "bad-code-source", message: `code source \`${target}\` names a disallowed URL scheme`, line });
      continue;
    }
    const route = parseSourceRoute(target, "code", line, ctx);
    if (route === null) continue;
    const { path, from, to } = route;
    if (!opts.resolveDoc) {
      ctx.diags.push({ severity: "warning", code: "unchecked-cross-document-reference", message: `code source \`${target}\` not checked (no document resolver)`, line });
      continue;
    }
    const text = opts.resolveDoc(path);
    if (text === null) {
      // A WARNING, not an error, and the code/value model split is the reason:
      // a value that cannot be loaded is a promise the document failed to keep
      // (an error — see `unresolvable-data-source`), while a code region that
      // cannot be reached right now is still a code region at a location. A
      // generated code graph read away from its sources — published on its own,
      // or describing another checkout — must stay valid, exactly as the
      // render-time runtime degrades to showing the path.
      ctx.diags.push({ severity: "warning", code: "unresolvable-code-source", message: `cannot resolve code source \`${path}\` — not checked`, line });
      continue;
    }
    const slice = sliceSourceRange(text, { from, to }, target, "code", line, ctx);
    if (slice === null) continue;
    const hasBody = (block.raw ?? []).some((l) => l.trim() !== "");
    if (hasBody) {
      // A code block must not carry both src= and an inline body (§3.3).
      ctx.diags.push({ severity: "error", code: "code-src-and-body",
        message: `code: carries both \`src=\` and an inline body; exactly one is permitted`,
        line });
    } else {
      block.raw = slice;
    }
  }
}

// GEP-0005: `src=` on a `data` block names external content — the same
// external-source discipline tables have (§6, §9.4): an http(s) source is
// fetched by the RENDERER, never the parser (the block defers, and so does a
// chart over it); any other scheme is refused; the file must look like data
// (`.json`/`.jsonl`); a missing resolver leaves it unchecked with a warning.
function resolveDataSources(ctx: Ctx, opts: ParseOptions): void {
  for (const { block, line, target } of ctx.dataSources ?? []) {
    const defer = (): void => { if (block.id !== undefined) (ctx.dataSrcPending ??= new Set()).add(block.id); };
    const scheme = schemeOf(target);
    if (scheme === "http" || scheme === "https") { defer(); continue; }
    if (scheme !== null) {
      ctx.diags.push({ severity: "error", code: "unresolvable-data-source", message: `data source \`${target}\` names a disallowed URL scheme`, line });
      continue;
    }
    // The route shares `code`'s syntax (§3.2): a line range MAY narrow the file.
    const route = parseSourceRoute(target, "data", line, ctx);
    if (route === null) continue;
    const { path } = route;
    // A data source is data — the same shape rule table sources enforce, so
    // the loader cannot be pointed at a `.env` or a private key.
    if (!/\.(json|jsonl)$/i.test(path)) {
      ctx.diags.push({ severity: "error", code: "bad-data-source", message: `data source \`${path}\` is not a \`.json\`/\`.jsonl\` data file`, line });
      continue;
    }
    // Explicit format= wins; otherwise the (already-gated) extension names it.
    const fmtAttr = block.attrs["format"];
    const fmt = typeof fmtAttr === "string" ? fmtAttr : /\.jsonl$/i.test(path) ? "jsonl" : "json";
    // A range narrows the file to lines; what those lines mean is then the
    // format's business, unchanged. Slicing a `jsonl` log is the obvious use;
    // slicing a `json` file works whenever the slice is itself a value, and
    // when it is not, the ordinary data-parse error already names the line.
    // No extra rule.
    if (!opts.resolveDoc) {
      ctx.diags.push({ severity: "warning", code: "unchecked-cross-document-reference", message: `data source \`${target}\` not checked (no document resolver)`, line });
      defer();
      continue;
    }
    const text = opts.resolveDoc(path);
    if (text === null) {
      ctx.diags.push({ severity: "error", code: "unresolvable-data-source", message: `cannot resolve data source \`${path}\``, line });
      continue;
    }
    const lines = sliceSourceRange(text, route, target, "data", line, ctx);
    if (lines === null) continue;
    const parsed = parseDataBody(fmt, lines, line);
    for (const d of parsed.diags) ctx.diags.push(d);
    if (parsed.value !== undefined) {
      block.value = parsed.value;
      if (block.id !== undefined && !ctx.dataValues?.has(nameKey(block.id))) {
        (ctx.dataValues ??= new Map()).set(nameKey(block.id), parsed.value);
      }
    }
  }
}

// GEP-0005: a chart's `data=` may target a `data` block whose value is a
// RECORD ARRAY — a non-empty array of objects. Keys project to columns in
// first-seen order; every column the chart actually references (x/y/size/
// series) must be present with a SCALAR value in every record, and a
// violation is an error naming the first offending record. Columns the chart
// does not reference may hold anything (nested values project as compact
// JSON text). The projection feeds the unchanged table machinery.
function recordsToTable(value: DataValue, attrs: Record<string, Value>, line: number, ctx: Ctx): TableModel | null {
  const fail = (msg: string): null => {
    ctx.diags.push({ severity: "error", code: "chart-data-not-records", message: `geml-chart: ${msg}`, line });
    return null;
  };
  if (!Array.isArray(value) || value.length === 0) return fail("data target is not a non-empty record array");
  const columns: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const r = value[i];
    if (r === null || typeof r !== "object" || Array.isArray(r)) return fail(`record ${i + 1} is not an object`);
    for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  }
  // Only the channels this chart TYPE reads are "referenced" (§7.1): a stray
  // size= on a bar chart is buildChart's chart-unused-channel WARNING, and the
  // projection must not turn it into an error a table source would not raise.
  // An unknown/missing type validates x/y only; buildChart reports the type.
  const typeAttr = String(attrs["type"] ?? "");
  const uses = (USES as Partial<Record<string, Set<string>>>)[typeAttr] ?? new Set(["x", "y"]);
  const channels: string[] = [];
  for (const c of ["x", "y", "size", "series"]) {
    if (!uses.has(c)) continue;
    const v = attrs[c];
    if (typeof v === "string") for (const name of v.split(",").map((s) => s.trim()).filter(Boolean)) channels.push(name);
  }
  for (const col of channels) {
    for (let i = 0; i < value.length; i++) {
      const v = (value[i] as { [k: string]: DataValue })[col];
      if (v === undefined || v === null || typeof v === "object") {
        return fail(`column \`${col}\` is missing or non-scalar in record ${i + 1}`);
      }
    }
  }
  const rows: TableCell[][] = value.map((r) => columns.map((c) => {
    const v = (r as { [k: string]: DataValue })[c];
    const text = v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    // Data, not prose: cells carry plain-text inlines, never inline-parsed —
    // the same treatment `format=csv` cells get (a `*` in a value is a `*`).
    const cell: TableCell = { text, inlines: text === "" ? [] : [{ type: "text", value: text }] };
    if (typeof v === "number" && Number.isFinite(v)) cell.value = v;
    return cell;
  }));
  return { header: true, columns, align: columns.map(() => undefined), rows };
}

// §7: resolve every geml-chart against its referenced table. Runs after the
// scan so that `data=#id` may point at a table defined anywhere in the doc.
function resolveCharts(ctx: Ctx, opts: ParseOptions): void {
  for (const { block, line } of ctx.charts ?? []) {
    const ref = typeof block.attrs["data"] === "string" ? (block.attrs["data"] as string).trim() : "";
    if (ref === "" || ref === "#") { ctx.diags.push({ severity: "error", code: "chart-missing-data", message: "geml-chart: missing `data=#id`", line }); continue; }

    // `data=` resolves by the same rule as a table's source: `#id` (or a bare id)
    // names a table in THIS document, `doc.geml#id` one in another. Splitting on
    // the LAST `#` is what the old code got wrong — it stripped the leading one
    // and reported `#other.geml#fy25`, a target that never existed.
    const hash = ref.indexOf("#");
    const docPath = hash <= 0 ? "" : ref.slice(0, hash);
    const id = hash < 0 ? ref : ref.slice(hash + 1);

    let table: TableModel | undefined;
    if (docPath === "") {
      table = ctx.tables?.get(nameKey(id));
      if (!table && ctx.dataValues?.has(nameKey(id))) {
        // GEP-0005: the target is a `data` block. A RECORD ARRAY projects to
        // the table model (keys -> columns) and feeds the unchanged chart
        // machinery, so column checks and rendering stay single-sourced.
        const projected = recordsToTable(ctx.dataValues.get(nameKey(id))!, block.attrs, line, ctx);
        if (projected === null) continue; // reported by the projection
        table = projected;
      }
      if (!table && ctx.dataSrcPending?.has(id)) {
        // GEP-0005: the target is a `data` block whose `src=` is render-time
        // (http, or no resolver) — defer exactly like a src table with no
        // columns; the renderer checks it when the data actually arrives.
        continue;
      }
      if (!table) {
        // A chart is a view of a table, and a data file is one of the three ways
        // §6 lets a table name its content. So `data=rows.csv` desugars: it is an
        // anonymous table with that source, feeding this chart. Nothing new is
        // invented — the resolution, the `.csv`/`.tsv` gate, the §9.4 remote rule
        // and `format=` all come from the table rules, which is what makes the one
        // source rule hold for charts too instead of charts being its exception.
        if (hash < 0 && /\.(csv|tsv)$/i.test(id)) {
          const sugar = chartSourceTable(ctx, opts, block, id, line);
          if (sugar === null) continue; // already reported by the table rules
          table = sugar;
        } else if (hash < 0 && /\.(json|jsonl)$/i.test(id) && schemeOf(id) === null) {
          // GEP-0005 sugar, the json/jsonl twin of the csv path: an anonymous
          // LOCAL data source projected through the record-array rules. A
          // remote URL needs a NAMED `data` block with `src=` — its fetch is
          // render-time, and an anonymous source has no block to defer on.
          if (!opts.resolveDoc) {
            ctx.diags.push({ severity: "warning", code: "unchecked-cross-document-reference", message: `geml-chart: data source \`${id}\` not checked (no document resolver)`, line });
            continue;
          }
          const text = opts.resolveDoc(id);
          if (text === null) { ctx.diags.push({ severity: "error", code: "unresolvable-data-source", message: `geml-chart: cannot resolve data source \`${id}\``, line }); continue; }
          const parsed = parseDataBody(/\.jsonl$/i.test(id) ? "jsonl" : "json", normalizeSource(text).split("\n"), line);
          for (const d of parsed.diags) ctx.diags.push(d);
          if (parsed.value === undefined) continue;
          const projected = recordsToTable(parsed.value, block.attrs, line, ctx);
          if (projected === null) continue; // reported by the projection
          table = projected;
        } else if (hash < 0 && /\.(json|jsonl)$/i.test(id)) {
          ctx.diags.push({ severity: "error", code: "bad-data-source", message: `geml-chart: \`data=${id}\`: a remote json/jsonl source needs a named \`data\` block with \`src=\``, line });
          continue;
        } else if (hash < 0 && /\.[a-z0-9]+$/i.test(id)) {
          ctx.diags.push({ severity: "error", code: "unresolvable-table-source", message: `geml-chart: \`data=${id}\` is not a \`.csv\`/\`.tsv\`/\`.json\`/\`.jsonl\` data file, and not a \`#id\` naming a table or data block`, line });
          continue;
        } else {
          const known = ctx.ids.has(nameKey(id));
          const what = known ? `data target \`#${id}\` is not a table` : `unresolved reference \`#${id}\``;
          const code = known ? "chart-data-not-a-table" : "unresolved-reference";
          ctx.diags.push({ severity: "error", code, message: `geml-chart: ${what}`, line });
          continue;
        }
      }
    } else {
      if (!opts.resolveDoc) {
        ctx.diags.push({ severity: "warning", code: "unchecked-cross-document-reference", message: `geml-chart: data target \`${ref}\` not checked (no document resolver)`, line });
        continue;
      }
      const text = opts.resolveDoc(docPath);
      if (text === null) { ctx.diags.push({ severity: "error", code: "unresolvable-document", message: `geml-chart: cannot resolve document \`${docPath}\``, line }); continue; }
      const remote = tableFromDocument(text, id);
      if (remote === null) { ctx.diags.push({ severity: "error", code: "unresolved-cross-document-reference", message: `geml-chart: unresolved reference \`${ref}\``, line }); continue; }
      if (remote === "not-a-table") { ctx.diags.push({ severity: "error", code: "chart-data-not-a-table", message: `geml-chart: data target \`${ref}\` is neither a table nor a data block`, line }); continue; }
      if ("records" in remote) {
        const projected = recordsToTable(remote.records, block.attrs, line, ctx);
        if (projected === null) continue; // reported by the projection
        table = projected;
      } else {
        table = remote;
      }
    }

    if (table.src !== undefined && table.columns.length === 0) {
      // §6: the table names a source whose data did not arrive at build time — a
      // remote URL, or any source with no document resolver supplied. The chart is
      // therefore resolved at render time, and its column names are checked there.
      // The test is whether the data is actually here, not what the source looks
      // like: skipping every `src` table unconditionally is what left a chart
      // unbuilt with no diagnostic while the page said to go and read one.
      continue;
    }
    const { model, diagnostics } = buildChart(block.attrs, table);
    if (model) block.chart = model;
    for (const d of diagnostics) ctx.diags.push({ ...d, line });
  }
}

export function parse(source: string, opts: ParseOptions = {}): Document {
  const lines = normalizeSource(source).split("\n");
  const diags: Ctx["diags"] = [];
  const meta = collectMeta(lines, diags);
  const ctx: Ctx = { diags, ids: new Map(), refs: [], meta, vocab: vocabularyFor(meta), resolveDoc: opts.resolveDoc };
  const children = scanBlocks(lines, 0, ctx);
  // Table sources first: a chart reads the build-time model of the table it
  // charts, so that model has to be filled before charts are resolved.
  resolveTableSources(ctx, opts);
  resolveDataSources(ctx, opts);
  resolveCodeSources(ctx, opts);
  resolveCharts(ctx, opts);
  validateRefs(ctx, opts);
  detectTransclusionCycles(ctx, opts);
  detectSelfEmbedCycles(source, ctx);
  validateProjections(children, ctx, opts);
  detectSelfProjectionCycles(source, ctx);
  for (const m of ctx.mediaDocTargets ?? []) {
    ctx.diags.push({
      severity: "error",
      code: "media-target-is-document",
      // `!` projects, so a GEML target here is a near-miss an author will reach for
      // once that reading is established. Name both forms it could have meant.
      message: `\`![](${m.src})\` projects a GEML document, which is not media: for block content use \`=== embed {src=${m.src}}\`, for a phrase use \`![[${m.src}]]\``,
      line: m.line,
    });
  }
  return { kind: "document", children, ids: [...ctx.ids.values()].map((v) => v.as), diagnostics: ctx.diags };
}

// ---------------------------------------------------------------------------
// Source spans (§ addressable blocks) — the byte range each `#id` occupies.
// ---------------------------------------------------------------------------

// A half-open [start, end) range of 0-based *line* indices. Because parse()
// applies normalizeSource() before splitting, and every step of that
// normalization rewrites bytes only *within* a line (never splitting or joining
// one, so the line count is preserved), these indices apply unchanged to the
// original bytes — so `get`/`set` can splice by span without re-serializing.
export interface Span { start: number; end: number; }

// The id that a fence/heading line defines, matching how scanBlocks derives it
// (parseAttrs for the attribute object; heading text slug when no explicit id).
// The slug MUST come from the RAW text, before interpolation, so that changing
// a meta variable does not silently change the block's addressable id.
// `ctx` is passed just in case future features need context.
function idOfHeading(braces: string | undefined, text: string, line: number, ctx: Ctx): string {
  return (braces ? parseAttrs(braces).id : undefined) ?? slug(text);
}

// The matching close of the fence opened at lines[i] (equal-length run, or the
// labeled `=== #id` close when the block carries an id): the index just past
// the close line, and whether one was found — an unterminated block runs to
// the end of the scope.
function fenceClose(lines: string[], i: number, open: RegExpExecArray): { end: number; closed: boolean } {
  const openLen = open[1]!.length;
  const id = open[3] ? parseAttrs(open[3]).id : undefined;
  const labeled = id !== undefined ? new RegExp(`^={3,}[ \\t]+#${reLit(id)}[ \\t]*$`) : null;
  for (let j = i + 1; j < lines.length; j++) {
    if (isCloseFence(lines[j]!, openLen) || (labeled && labeled.test(lines[j]!))) return { end: j + 1, closed: true };
  }
  return { end: lines.length, closed: false };
}

// A heading's span covers its whole SECTION: the heading line through the line
// just before the next heading of same-or-higher level (fewer-or-equal `#`) in
// the current scope, or end-of-scope. Fenced blocks are skipped whole — a `#`
// line inside a `=== code` body is content, never a boundary.
function sectionEnd(lines: string[], i: number, level: number): number {
  let j = i + 1;
  while (j < lines.length) {
    const open = FENCE_OPEN.exec(lines[j]!);
    if (open) { j = fenceClose(lines, j, open).end; continue; }
    const h = matchHeading(lines[j]!);
    if (h && h[1]!.length <= level) return j;
    j++;
  }
  return lines.length;
}

// Walk `lines` exactly as scanBlocks does — same fence close rules (equal-length
// or labeled `=== #id`), same flow-only recursion via REGISTRY — recording the
// source span of every addressable id (typed block, heading).
// First definition wins, mirroring ctx.ids (a duplicate id is a build error, so
// `get`/`set` operate on the one the parser actually registered). `base` is the
// absolute line offset of this slice within the whole document.
function collectSpans(
  lines: string[], base: number, out: Map<string, Span>, ctx: Ctx, depth = 0,
  // Optional second index: every addressable unit in document order — typed
  // blocks (id-bearing or not, so a block the author never named is still
  // addressable), headings, footnote definitions. A second SINK on the one
  // walk, not a second walk: the selector design's "one definition, one
  // implementation" applies to the scan as much as to the syntax.
  units?: Unit[],
): void {
  const add = (id: string, start: number, end: number): void => {
    if (!out.has(id)) out.set(id, { start, end });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }

    const fndef = /^\[\^([^\]]+)\]:[ \t]?(.*)$/.exec(line);
    if (fndef) {
      add(fndef[1]!.trim(), base + i, base + i + 1);
      units?.push({ span: { start: base + i, end: base + i + 1 }, kind: "footnote", id: fndef[1]!.trim() });
      i++; continue;
    }

    if (/^[ \t]*%%/.test(line)) { i++; continue; } // hidden line: no id

    const open = FENCE_OPEN.exec(line);
    if (open) {
      const type = open[2]!;
      const id = open[3] ? parseAttrs(open[3]).id : undefined;
      const { end, closed } = fenceClose(lines, i, open);
      if (id !== undefined) add(id, base + i, base + end);
      units?.push({ span: { start: base + i, end: base + end }, kind: "block", type, ...(id !== undefined ? { id } : {}) });
      // Only a flow body is scanned for nested blocks (raw/data bodies are
      // opaque), so an id inside a `code` body is *not* addressable — exactly
      // the parser's contract.
      if ((REGISTRY.get(type) ?? "raw") === "flow" && depth < MAX_NESTING) {
        collectSpans(lines.slice(i + 1, closed ? end - 1 : end), base + i + 1, out, ctx, depth + 1, units);
      }
      i = end;
      continue;
    }

    const h = matchHeading(line);
    if (h) {
      // Section span (heading through its prose and nested blocks). The walk
      // still advances one line at a time so every nested id inside the
      // section registers its own span — spans intentionally OVERLAP: #sec
      // contains #code, and each remains addressable on its own.
      const hid = idOfHeading(h[3], h[2]!, base + i + 1, ctx);
      const hend = base + sectionEnd(lines, i, h[1]!.length);
      add(hid, base + i, hend);
      units?.push({ span: { start: base + i, end: hend }, kind: "heading", id: hid, level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }

    i++;
  }
}

// Map every addressable id in `source` to its source span. Line indices align
// with the physical lines produced by splitLines(source).
export function stripEol(line: string): string {
  return line.replace(/(\r\n|\r|\n)$/, "");
}

// Drop trailing spaces and tabs, in LINEAR time. `/[ \t]+$/` is polynomial: on
// a line whose run of tabs does not reach the end, the engine starts the run
// again at every index inside it — 40k tabs took 750 ms here, and the cost
// grows with the SQUARE, so a document is a denial-of-service payload rather
// than a slow parse. `trimEnd()` is not the substitute: it also strips \v, \f,
// NBSP and the Unicode spaces, which would silently widen what counts as a
// closing fence. This strips exactly the two bytes the callers mean.
export function trimSpaceTabEnd(s: string): string {
  let i = s.length;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    if (c !== 0x20 && c !== 0x09) break;
    i--;
  }
  return i === s.length ? s : s.slice(0, i);
}

export function blockSpans(source: string): Map<string, Span> {
  const out = new Map<string, Span>();
  const lines = normalizeSource(source).split("\n");
  // Inert context: heading auto-ids slug the raw text, but parseDoc still
  // requires a valid context to parse the document.
  const spanMeta = collectMeta(lines);
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: spanMeta, vocab: vocabularyFor(spanMeta) };
  collectSpans(lines, 0, out, ctx);
  return out;
}

// Every addressable unit, in document order, each decorated with its content
// address (§3.2). Ids are OPTIONAL in GEML (§1: a block MAY carry one), so
// `meta`, a callout `note`, a `table` — anything the author had no reason to
// name — has no id to address it by; this index is what makes those addressable
// anyway, by type (`=== meta`) or by content (`@<hex>`). No block type is
// special-cased; meta is merely the one that is usually unique.
//
// The ONE index selector matching and the listing both work from, so `get`,
// `set` and the listing can never disagree about what exists.
// The same scan WITHOUT the content addresses. `addressedUnits` hashes every
// unit to give the id-less ones an `@<hex>` address, and that hash runs on
// node's Buffer — so calling it in a browser bundle throws. A caller that only
// needs to know where the blocks are (which block holds this line, how many
// bytes it is) does not need the hashes, and this is the honest way to say so
// rather than making the browser pay for an address it will not use.
export function unitSpans(source: string): Unit[] {
  const lines = normalizeSource(source).split("\n");
  const spanMeta = collectMeta(lines);
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: spanMeta, vocab: vocabularyFor(spanMeta) };
  const units: Unit[] = [];
  collectSpans(lines, 0, new Map(), ctx, 0, units);
  return units;
}

export function addressedUnits(source: string): Addressed[] {
  const lines = normalizeSource(source).split("\n");
  const spanMeta = collectMeta(lines);
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: spanMeta, vocab: vocabularyFor(spanMeta) };
  const units: Unit[] = [];
  collectSpans(lines, 0, new Map(), ctx, 0, units);
  // The address hashes the block's own source text — the exact bytes `get`
  // would print for it — so an address can be recomputed from `get` output.
  return addressUnits(units, (u) => lines.slice(u.span.start, u.span.end).join("\n"));
}

// Split into physical lines while *keeping* each line's terminator, so
// join("") is byte-exact and slicing by span never rewrites line endings.
// A line ends at `\n` or at a LONE `\r` (old-Mac style) — the same boundaries
// the span scan's `\r\n?` -> `\n` normalization sees, so span indices always
// address the same lines the parser counted.
export function splitLines(source: string): string[] {
  return source.split(/(?<=\n|\r(?!\n))/);
}

// Newline handling lives HERE, in one place, because it is easy to get subtly
// wrong in each caller. Content reaching a mutation is often LF even when the
// document is not: a history revision is stored newline-normalized, `--in` may
// come from either kind of file, stdin from anywhere. So: detect the DOCUMENT's
// style, compare on the normalized (LF) form, and convert back on the way in —
// which is what keeps a CRLF document from ending up half CRLF, half LF.
export function newlineOf(text: string): string {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
export function toNewline(text: string, nl: string): string {
  const lf = toLf(text);
  return nl === "\n" ? lf : lf.replace(/\n/g, nl);
}

// `--head`: narrow any id's span to its HEAD line — the single declaring line
// (a heading's `# … {#id}` line, or a typed block's opening fence). The head is
// by construction the FIRST line of the span, so
// the narrowing is parse-free and needs no type check. Main use: `set --head`
// edits a block's attributes (caption/compute/lang/…) without re-sending its
// body, or renames a heading without rewriting its section.
export function narrowToHead(span: Span): Span {
  return { start: span.start, end: span.start + 1 };
}

// The unit's CLOSING fence line, or null when it has none — a heading section,
// or a fence left unclosed at EOF. Extracted so `get --body` and `set --body`
// decide it in ONE place: the selector design's §4 defines HEAD/BODY by the
// round-trip invariant `get X --body | set X --body` leaving the file
// byte-identical, and two copies of this judgement is exactly how that breaks.
export function closeFenceLine(lines: string[], span: Span): string | null {
  const open = FENCE_OPEN.exec(stripEol(lines[span.start] ?? ""));
  if (!open) return null;
  const lastText = trimSpaceTabEnd(stripEol(lines[span.end - 1] ?? ""));
  const bid = open[3] ? parseAttrs(open[3]).id : undefined;
  const labeled = bid !== undefined && new RegExp(`^={3,}[ \\t]+#${reLit(bid)}[ \\t]*$`).test(lastText);
  return isCloseFence(lastText, open[1]!.length) || labeled ? lines[span.end - 1] ?? "" : null;
}

// BODY span: a fenced block's lines BETWEEN the fences; a heading's lines after
// the heading through the section boundary — trailing blank lines included,
// because that is the span `set --body` replaces (§4's table).
function narrowToBody(lines: string[], span: Span): Span {
  return { start: span.start + 1, end: closeFenceLine(lines, span) !== null ? span.end - 1 : span.end };
}

// The INTRO sub-range of a heading's section: what the heading says before it
// says anything under a subheading. Bounded by the next heading of ANY level,
// which is the same line either way — a deeper heading opens a subsection, a
// same-or-higher one ends this section. Empty when a heading follows
// immediately; the whole body when the section has no further heading.
//
// The bound comes from the parsed units, never from scanning for `#`: a `#`
// inside a fenced block is body text, and a line scan would cut the section in
// half there.
export function narrowToIntro(source: string, span: Span): Span {
  const body = narrowToBody(splitLines(source), span);
  let end = body.end;
  for (const a of addressedUnits(source)) {
    const u = a.unit;
    if (u.kind !== "heading") continue;
    if (u.span.start > span.start && u.span.start < body.end) { end = u.span.start; break; }
  }
  return { start: body.start, end: Math.max(body.start, end) };
}

/** Which part of one unit to output. `intro` applies to headings only. */
export type UnitPart = "whole" | "head" | "body" | "intro";

// Slice one unit's output bytes, honouring --head / --body / --intro.
export function sliceUnit(source: string, span: Span, part: UnitPart = "whole"): string {
  const lines = splitLines(source);
  const s = part === "head" ? narrowToHead(span)
    : part === "body" ? narrowToBody(lines, span)
    : part === "intro" ? narrowToIntro(source, span)
    : span;
  return lines.slice(s.start, s.end).join("");
}

// Depth-first search for the document-model node carrying `id`, descending into
// flow-block children (and list-item children) so a nested id is found too.
// Returns the containing sibling array and index, not just the node: the model
// is FLAT — a heading does not own its section; the section's prose and blocks
// are its FOLLOWING SIBLINGS — so a section consumer needs the array.
export function findBlockSite(blocks: Block[], id: string): { siblings: Block[]; index: number } | undefined {
  const key = nameKey(id);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if ((b.kind === "heading" || b.kind === "block") && b.id !== undefined && nameKey(b.id) === key) return { siblings: blocks, index: i };
    if (b.kind === "block" && b.children) {
      const hit = findBlockSite(b.children, id);
      if (hit) return hit;
    }
    if (b.kind === "list") {
      for (const it of b.items) {
        if (it.children) {
          const hit = findBlockSite(it.children, id);
          if (hit) return hit;
        }
      }
    }
  }
  return undefined;
}

// Model-side section boundary: within one sibling array, the section opened by
// the heading at index k runs to the next sibling heading of same-or-higher
// level, or the array end. This is the SAME rule sectionEnd() applies to raw
// source lines (where skipping fenced bodies makes "next heading" well-defined)
// — the two sides must stay in lockstep; the get-set suite pins their parity
// (ids covered by the raw slice == ids covered by the --json envelope).
export function sectionEndIndex(siblings: Block[], k: number): number {
  const level = (siblings[k] as Extract<Block, { kind: "heading" }>).level;
  for (let m = k + 1; m < siblings.length; m++) {
    const b = siblings[m]!;
    if (b.kind === "heading" && b.level <= level) return m;
  }
  return siblings.length;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------


export function historyPathFor(geml: string): string {
  return geml.replace(/\.geml$/, "") + ".gemlhistory";
}

// (A `YYYYMMDDTHHMMSSZ` parser lived here for `history commit --at`. That flag
// left the CLI with design §9-Q4 — the library API takes a real Date — so the parser
// went with it rather than staying as an uncalled branch.)

export const VERSION = "1.0";          // GEML spec version this CLI targets
// The published version, read from package.json rather than restated here.
// "Keep in sync with package.json" was a comment, and comments do not run: this
// literal said 1.4.3 while the MCP server's own copy still said 0.1.0.
// Resolved from this module's location — `dist/geml.js` -> `../package.json`,
// and npm always ships package.json whatever `files` says. In a browser bundle
// `import.meta.url` degenerates to "" (see the `entry` note below), so every
// lookup fails and we fall back rather than throw at import time.
export const PARSER_VERSION: string = (() => {
  let dir: string;
  try { dir = dirname(fileURLToPath(import.meta.url)); } catch { return "0.0.0"; }
  for (let i = 0; i < 3 && dir; i++) {
    try {
      const v = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      if (typeof v === "string" && v) return v;
    } catch { /* not here — walk up */ }
    dir = dirname(dir);
  }
  return "0.0.0";
})();

// Is this process being run as the `geml` command? npm's unix bin shim is a
// symlink named plain `geml`, so the test resolves argv[1] rather than
// comparing spellings. In a browser bundle argv is [] and this is false, which
// is what keeps the CLI hand-off below out of a page.
function isCliInvocation(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // THIS file, run as the script — not "a file whose name ends in geml.js".
  // Someone's own `geml.js` that imports the library would otherwise trip the
  // hand-off below and have the CLI exit their process. It also keeps
  // `dist/cli.js` from coming back through here: cli.js imports this module,
  // so re-importing it would be a cycle.
  //
  // Both sides go through realpathSync, because the shim this has to recognise
  // IS a symlink: `path.resolve` only absolutises the spelling it is handed, so
  // `/tmp/x/geml -> …/dist/geml.js` compared unequal, the hand-off never ran,
  // and `geml --version` through npm's bin exited 0 having printed nothing.
  // Canonicalising this file too covers a dist/ reached through a symlinked
  // directory, and the macOS /tmp -> /private/tmp case the test walks into.
  try {
    return realOf(argv1) === realOf(fileURLToPath(import.meta.url));
  } catch {
    return false; // no URL support (a bundle) — never the CLI
  }
}

// Canonical path, falling back to the absolute spelling when the target cannot
// be realpath'd (it may not exist — that is not an error here, just a miss).
function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

// Backwards compatibility: the CLI moved to cli.ts, but `node …/dist/geml.js`
// is what this repo's hooks, the codemap recipes and older instructions all
// invoke. Hand those off — a dynamic, non-literal specifier, so a bundler
// leaves it alone and the browser never resolves it (argv is [] there, so the
// guard is false and this line never runs).
if (isCliInvocation()) {
  void import(new URL("./cli.js", import.meta.url).href);
}
