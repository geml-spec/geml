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

import { readFileSync, writeFileSync, realpathSync, statSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { save, restore, verify, isCurrent, listRevisions, resolveContent, firstChangedContent } from "./history.js";
import { renderHtml } from "./render-html.js";
import { normalizeBlockId } from "./block-edit.js";
import { type Diagnostic, normalizeSource } from "./diagnostics.js";
import type { DiagnosticCode } from "./diagnostics.js";
import { type Value, coerce, parseAttrs } from "./attrs.js";
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
function reLit(s: string): string {
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
  ids: Map<string, number>;
  meta: Map<string, string>; // merged `=== meta` keys, for `{{key}}` interpolation
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
const REGISTRY: Record<string, BodyMode> = {
  code: "raw",
  diagram: "raw",
  math: "raw",
  table: "raw", // structured table parsing lands in M3
  data: "raw", // GEP-0005: value tree — a format engine parses the raw body in a second stage
  embed: "raw", // block transclusion: `src=` points at the content, body unused
  note: "flow",
  text: "flow", // addressable prose container: an id/attrs for a run of flow, no callout chrome
  meta: "data",
};

// §7: built-in diagram renderer registry. Unknown formats are a warning (the
// processor keeps the body raw rather than interpreting it).
const DIAGRAM_RENDERERS = new Set(["mermaid", "graphviz", "dot", "d2", "plantuml", "geml-chart", "geml-code-graph"]);

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^(={3,})[ \t]+([A-Za-z][A-Za-z0-9_-]*)[ \t]*(\{.*\})?[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*(\{[^}]*\})?[ \t]*$/;
// A line with the exact shape of a labeled close (§3): a `=` run and a `#id`,
// nothing else. Matched against lines that fell through to paragraph text,
// where such a line means the close closed nothing (stray-labeled-fence).
const STRAY_LABELED_FENCE = /^={3,}[ \t]+#(\S+)[ \t]*$/;
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
const FENCE_LIKE = /^={3,}[ \t]+([A-Za-z][A-Za-z0-9_-]*)\b/;
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]+(.*)$/;

// Maximum block/list nesting depth the recursive-descent scanner will build
// before emitting a diagnostic instead of recursing further. Guards parse()
// (scanBlocks / parseList) and, in step, the renderer against a deeply nested
// document overflowing the call stack (DoS). 256 is far past any real document.
const MAX_NESTING = 256;

function isCloseFence(line: string, openLen: number): boolean {
  const t = line.replace(/\s+$/, "");
  return /^=+$/.test(t) && t.length === openLen;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`[^`]*`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
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
  if (ctx.ids.has(id)) {
    ctx.diags.push({ severity: "error", code: "duplicate-id", message: `duplicate id \`#${id}\` (first defined at line ${ctx.ids.get(id)})`, line });
  } else {
    ctx.ids.set(id, line);
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

function makeListItem(mk: Marker, lineNo: number, ctx: Ctx): ListItem {
  let text = interpolate(mk.rest, lineNo, ctx);
  // Task list item: a leading `[ ]` (open) or `[x]`/`[X]` (done) marker.
  const task = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(text);
  const item: ListItem = { text, inlines: [] };
  if (task) { item.checked = task[1] !== " "; text = task[2] ?? ""; item.text = text; }
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
    cur.items.push(makeListItem(mk, base + i + 1, ctx));
    prevBlank = false;
    i++;
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

      // Collect the body. A block closes on the FIRST line that is a bare fence
      // of exactly the opening length, OR — when it has an id — a labeled fence
      // `=== #id` (a `=` run of any length ≥ 3 followed by the block's id). The
      // labeled close can't be gotten wrong by miscounting `=`, but it does NOT
      // shadow the bare close: a same-length bare fence in the body still ends
      // the block first, so nesting needs a longer outer fence (§3).
      const labeled = attrs.id !== undefined ? new RegExp(`^={3,}[ \\t]+#${reLit(attrs.id)}[ \\t]*$`) : null;
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
      if (closedByBare && attrs.id !== undefined && !ctx.bareClosed?.has(attrs.id)) {
        (ctx.bareClosed ??= new Map()).set(attrs.id, base + j + 1);
      }
      if (!closed) {
        const how = attrs.id !== undefined ? `${"=".repeat(openLen)} or \`=== #${attrs.id}\`` : "=".repeat(openLen);
        diags.push({ severity: "error", code: "unterminated-block", message: `unterminated \`${type}\` block (no matching ${how})`, line: openLineNo });
      }

      let mode = REGISTRY[type];
      if (mode === undefined) {
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
        // `src`/`anchor` on a `code` block are the code-graph profile's
        // (docs/codemap-profile.md): every document `geml codemap build` writes
        // carries them, so warning on them would warn on our own output.
        else if (type === "code") validRe = /^(lang|src|anchor|name|entry-via)$/;
        else validRe = /^$/;

        const universal = /^(hidden|caption)$/;

        for (const key of Object.keys(attrs.attrs)) {
          if (!universal.test(key) && !validRe.test(key)) {
            diags.push({ severity: "warning", code: "unknown-attribute", message: `unknown attribute \`${key}\` for block type \`${type}\``, line: openLineNo });
          }
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
          if (block.id !== undefined && block.value !== undefined && !ctx.dataValues?.has(block.id)) {
            (ctx.dataValues ??= new Map()).set(block.id, block.value);
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
          if (block.id !== undefined && !ctx.tables?.has(block.id)) {
            (ctx.tables ??= new Map()).set(block.id, model);
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
          } else if (typeof fmt === "string" && !DIAGRAM_RENDERERS.has(fmt)) {
            // §7: warn on a diagram format with no registered renderer.
            diags.push({ severity: "warning", code: "unknown-diagram-format", message: `no registered renderer for diagram format \`${fmt}\`; body kept raw`, line: openLineNo });
          }
        }
      }

      blocks.push(block);
      i = closed ? j + 1 : j;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const lineNo = base + i + 1;
      const level = h[1]!.length;
      const rawText = h[2]!;
      const a = parseAttrs(h[3] ?? "");
      const text = interpolate(rawText, lineNo, ctx);
      const id = a.id ?? slug(rawText);
      registerId(ctx, id, lineNo);
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
      !HEADING.test(lines[i]!) &&
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
      const closedAt = ctx.bareClosed?.get(id);
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
      if (like && REGISTERED_TYPES.has(like[1]!)) {
        diags.push({
          severity: "warning", code: "fence-like-line", line: paraStart + k,
          message: `line looks like an open fence for \`${like[1]}\` but is not one — attributes must be braced (\`=== ${like[1]} {…}\`); the line reads as plain paragraph text`,
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
const EMBED_DEPTH_LIMIT = 8;

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
  const found = (function find(bs: Block[]): Block | undefined {
    for (const b of bs) {
      if ((b.kind === "block" || b.kind === "heading") && b.id === id) return b;
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
function relJoinPath(base: string, target: string): string {
  if (base === "" || target === "" || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  const out: string[] = [];
  for (const s of (base + "/" + target).split("/")) {
    if (s === "" || s === ".") continue;
    if (s === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

function relDirPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

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
  const braces = /\{[^}]*\}/.exec(sliceUnit(source, unit.span, true, false));
  if (!braces) return undefined;
  const v = parseAttrs(braces[0]).attrs["src"];
  return typeof v === "string" ? v : undefined;
}

function gatherEmbeds(source: string): { doc: string; anchor?: string }[] {
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: new Map(), embeds: [] };
  scanBlocks(normalizeSource(source).split("\n"), 0, ctx);
  return (ctx.embeds ?? []).map((e) => (e.anchor === undefined ? { doc: e.doc } : { doc: e.doc, anchor: e.anchor }));
}

// One rule for "where this data comes from", shared by a table's `src=`
// and a chart's `data=`. Three target forms: a data file, `#id` naming a table
// block in this document, or `doc.geml#id` naming one in another document. An
// unresolvable target is an error — a table whose source silently produced no
// rows used to render as an empty table with no diagnostic at all.
function tableFromDocument(source: string, id: string): TableModel | { records: DataValue } | "not-a-table" | null {
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: new Map() };
  const blocks = scanBlocks(normalizeSource(source).split("\n"), 0, ctx);
  const found = ctx.tables?.get(id);
  if (found !== undefined) return found;
  // GEP-0005: a remote `data` block is the other chart-source form; its value
  // is projected by the CALLER (recordsToTable needs the chart's attributes).
  const dv = ctx.dataValues?.get(id);
  if (dv !== undefined) return { records: dv };
  const anyBlock = (function find(bs: Block[]): Block | undefined {
    for (const b of bs) {
      if ((b.kind === "block" || b.kind === "heading") && b.id === id) return b;
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
    if (block.id !== undefined) (ctx.tables ??= new Map()).set(block.id, model);
  }

  for (const { block, line, target } of pending) {
    const hash = target.indexOf("#");
    if (hash < 0) continue;
    const docPath = target.slice(0, hash);
    const id = target.slice(hash + 1);
    let model: TableModel | undefined;
    if (docPath === "") {
      const local = ctx.tables?.get(id);
      if (local === undefined) {
        if (ctx.ids.has(id)) err(line, "table-source-not-a-table", `table source \`#${id}\` is not a table`);
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
    if (block.id !== undefined) (ctx.tables ??= new Map()).set(block.id, block.table);
  }
}

function gatherIds(source: string): Set<string> {
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: new Map() };
  scanBlocks(normalizeSource(source).split("\n"), 0, ctx);
  return new Set(ctx.ids.keys());
}

// Pre-scan for `=== meta` blocks (at any fence depth) and merge their
// `key=val` lines, so `{{key}}` interpolation can resolve forward references.
function collectMeta(lines: string[]): Map<string, string> {
  const meta = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]!);
    if (!open || open[2] !== "meta") continue;
    const len = open[1]!.length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !isCloseFence(lines[j]!, len); j++) body.push(lines[j]!);
    for (const [k, v] of Object.entries(parseData(body))) meta.set(k, String(v));
    i = j;
  }
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
      if (!opts.resolveDoc) {
        ctx.diags.push({ severity: "warning", code: "unchecked-cross-document-reference", message: `cross-document reference \`${ref.doc}${ref.anchor ? "#" + ref.anchor : ""}\` not checked (no document resolver)`, line: ref.line });
        continue;
      }
      let ids = docIds.get(ref.doc);
      if (ids === undefined) {
        const src = opts.resolveDoc(ref.doc);
        if (src === null) {
          ctx.diags.push({ severity: "error", code: "unresolvable-document", message: `cannot resolve document \`${ref.doc}\``, line: ref.line });
          docIds.set(ref.doc, new Set());
          continue;
        }
        ids = gatherIds(src);
        docIds.set(ref.doc, ids);
      }
      if (ref.anchor !== undefined && !ids.has(ref.anchor)) {
        ctx.diags.push({ severity: "error", code: "unresolved-cross-document-reference", message: `unresolved reference \`${ref.doc}#${ref.anchor}\``, line: ref.line });
      }
      continue;
    }
    // internal, autoref, footnote — anchor must be a known id in this document.
    if (ref.anchor !== undefined && !ctx.ids.has(ref.anchor)) {
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
    if (!hasBody) {
      block.raw = slice;
    } else if ((block.raw ?? []).join("\n") !== slice.join("\n")) {
      // A body alongside `src=` is a cached snapshot, kept for offline reading.
      // Silence would let the two drift — the very thing the route prevents.
      ctx.diags.push({ severity: "warning", code: "stale-code-snapshot", message: `code block body differs from its source \`${target}\` — the body is a snapshot and is now out of date`, line });
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
      if (block.id !== undefined && !ctx.dataValues?.has(block.id)) {
        (ctx.dataValues ??= new Map()).set(block.id, parsed.value);
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
      table = ctx.tables?.get(id);
      if (!table && ctx.dataValues?.has(id)) {
        // GEP-0005: the target is a `data` block. A RECORD ARRAY projects to
        // the table model (keys -> columns) and feeds the unchanged chart
        // machinery, so column checks and rendering stay single-sourced.
        const projected = recordsToTable(ctx.dataValues.get(id)!, block.attrs, line, ctx);
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
          const known = ctx.ids.has(id);
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
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: collectMeta(lines), resolveDoc: opts.resolveDoc };
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
  return { kind: "document", children, ids: [...ctx.ids.keys()], diagnostics: ctx.diags };
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
    const h = HEADING.exec(lines[j]!);
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
      if ((REGISTRY[type] ?? "raw") === "flow" && depth < MAX_NESTING) {
        collectSpans(lines.slice(i + 1, closed ? end - 1 : end), base + i + 1, out, ctx, depth + 1, units);
      }
      i = end;
      continue;
    }

    const h = HEADING.exec(line);
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
export function blockSpans(source: string): Map<string, Span> {
  const out = new Map<string, Span>();
  const lines = normalizeSource(source).split("\n");
  // Inert context: heading auto-ids slug the raw text, but parseDoc still
  // requires a valid context to parse the document.
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: collectMeta(lines) };
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
function addressedUnits(source: string): Addressed[] {
  const lines = normalizeSource(source).split("\n");
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: collectMeta(lines) };
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
function splitLines(source: string): string[] {
  return source.split(/(?<=\n|\r(?!\n))/);
}

// Newline handling lives HERE, in one place, because it is easy to get subtly
// wrong in each caller. Content reaching a mutation is often LF even when the
// document is not: a history revision is stored newline-normalized, `--in` may
// come from either kind of file, stdin from anywhere. So: detect the DOCUMENT's
// style, compare on the normalized (LF) form, and convert back on the way in —
// which is what keeps a CRLF document from ending up half CRLF, half LF.
function newlineOf(text: string): string {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}
function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
function toNewline(text: string, nl: string): string {
  const lf = toLf(text);
  return nl === "\n" ? lf : lf.replace(/\n/g, nl);
}

// `--head`: narrow any id's span to its HEAD line — the single declaring line
// (a heading's `# … {#id}` line, or a typed block's opening fence). The head is
// by construction the FIRST line of the span, so
// the narrowing is parse-free and needs no type check. Main use: `set --head`
// edits a block's attributes (caption/compute/lang/…) without re-sending its
// body, or renames a heading without rewriting its section.
function narrowToHead(span: Span): Span {
  return { start: span.start, end: span.start + 1 };
}

// The unit's CLOSING fence line, or null when it has none — a heading section,
// or a fence left unclosed at EOF. Extracted so `get --body` and `set --body`
// decide it in ONE place: the selector design's §4 defines HEAD/BODY by the
// round-trip invariant `get X --body | set X --body` leaving the file
// byte-identical, and two copies of this judgement is exactly how that breaks.
function closeFenceLine(lines: string[], span: Span): string | null {
  const open = FENCE_OPEN.exec(stripEol(lines[span.start] ?? ""));
  if (!open) return null;
  const lastText = stripEol(lines[span.end - 1] ?? "").replace(/[ \t]+$/, "");
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

// Slice one unit's output bytes, honouring --head / --body.
function sliceUnit(source: string, span: Span, headOnly: boolean, bodyOnly: boolean): string {
  const lines = splitLines(source);
  const s = headOnly ? narrowToHead(span) : bodyOnly ? narrowToBody(lines, span) : span;
  return lines.slice(s.start, s.end).join("");
}

// Depth-first search for the document-model node carrying `id`, descending into
// flow-block children (and list-item children) so a nested id is found too.
// Returns the containing sibling array and index, not just the node: the model
// is FLAT — a heading does not own its section; the section's prose and blocks
// are its FOLLOWING SIBLINGS — so a section consumer needs the array.
function findBlockSite(blocks: Block[], id: string): { siblings: Block[]; index: number } | undefined {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if ((b.kind === "heading" || b.kind === "block") && b.id === id) return { siblings: blocks, index: i };
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
function sectionEndIndex(siblings: Block[], k: number): number {
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

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function historyPathFor(geml: string): string {
  return geml.replace(/\.geml$/, "") + ".gemlhistory";
}

// (A `YYYYMMDDTHHMMSSZ` parser lived here for `history commit --at`. That flag
// left the CLI with design §9-Q4 — the library API takes a real Date — so the parser
// went with it rather than staying as an uncalled branch.)

const VERSION = "1.0";          // GEML spec version this CLI targets
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
  geml get    <file.geml|-> [#id] [--json] [--head]   with #id: print that block
                                             (a heading id = its whole section; --head = head line;
                                             --json = model node). Without #id: list all addressable
                                             ids (--json = array).
  geml set    <file.geml|-> #id [--head|--body] [--in f[#src]|-] [-o f]   replace ONE block by id
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
                                             (10 tools, each geml_ + its CLI command path: list/get/check/history/to +
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
  get: "usage: geml get <file.geml|-> [<selector>] [--head|--body] [--view [--root <dir>]] [--json]  (selector = a filter over blocks: #id | '## Heading' (its whole section) | '=== type' (every block of that type — N matches print N contents, count on stderr) | '=== type@<hex>[~n]' or '@<hex>[~n]' (content address, for blocks with no #id); --head = head line, --body = body; --view = read THROUGH an `embed` to the entity block it stands for, following a chain to its end (the identity on any other block, and on a section selector — it never splices two documents' bytes together); provenance goes to stderr as `view: <sel> -> <doc>[#<id>]`; read-only, `set` refuses it; chain reads are confined to --root (default: the document's own directory) and never fetched over the network; without a selector: list every addressable block with its shortest unique address, --json = array)",
  set: "usage: geml set <file.geml|-> <selector> [--head|--body] [--in F | --in F#src | --in -] [-o out.geml]  (selector as in `get`, but it must match exactly ONE block — '=== type' matching several is refused; content: --in F takes F's block #id, --in F#src takes #src, else stdin raw; default = whole block, --head = head line — both normalize the id when the target has one — --body = body; guarded splice, refused if it breaks the doc; writing through an @<hex> address prints the new address on stderr)",
  add: "usage: geml add <file.geml|-> (--append | --before #id | --after #id) [--in F | --in F#src | --in -] [-o out.geml]  (insert a GEML fragment — 1+ blocks and/or prose — at a position; --in F takes all of F, --in F#src takes #src, else stdin raw; content keeps its own ids, a collision is refused)",
  delete: "usage: geml delete <file.geml|-> #id [#id2 …] [-o out.geml]  (remove one or more blocks; a missing id is skipped with a note, not an error; a reference left dangling is a warning, not a refusal — delete never fails on a live reference)",
  rename: "usage: geml rename <file.geml|-> #old #new [-o out.geml]  (rewrite an id's declaration AND every reference — [[#id]], [text](#id), chart data=#id, footnote [^id] — id-boundary safe, skipping raw block bodies; #new must be free; refused if it breaks the doc)",
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
  Ten tools: geml_list · geml_get · geml_check · geml_history · geml_to
             geml_set · geml_add · geml_delete · geml_rename · geml_revert
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
  skill: `usage: geml skill install [--dest <skillsDir>] [--no-global] [--no-mcp]

  One command, three things, all user-global — so any Claude Code session can
  author, validate, and blockwise-edit GEML:
    1. the authoring skill -> <skillsDir>/geml   (default ~/.claude/skills/geml)
    2. the geml CLI        -> npm i -g @geml/geml   (skipped when already on PATH)
    3. the MCP server      -> claude mcp add --scope user geml -- npx -y @geml/geml mcp --root .
  Touches no settings.json and installs no hooks. Idempotent — re-run after an
  upgrade to refresh the skill text alongside the CLI it teaches.

  --dest <dir>   install the skill under <dir> instead of ~/.claude/skills
  --no-global    skip the global npm install
  --no-mcp       skip the MCP server registration`,
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
  const doc = parse(readInput(file), { resolveDoc: resolverFor(file, root), self: file === "-" ? undefined : basename(file) });
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
            console.log(`${sel.padEnd(7)} ${r.id}  ${r.author ?? "-"}  ${r.summary ?? ""}`.replace(/\s+$/, ""));
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
          if (headOnly && bodyOnly) fail("--head and --body are mutually exclusive", 2);
          if (json && (headOnly || bodyOnly)) {
            fail(`--json cannot be combined with ${headOnly ? "--head" : "--body"} — --json returns the model node, which has no sub-node for one part of a block`, 2);
          }
          const { units, all } = selectUnits(text, file, blockSel, `revision ${id}`);
          if (json) {
            // §3.2's tier table: the revision id travels with the block, so the
            // caller can tell WHICH version it is holding.
            const nodes = units.map((u) => unitNode(text, file, u, all));
            console.log(JSON.stringify({ id, block: units.length === 1 ? nodes[0] : nodes }, null, 2));
          } else {
            if (units.length > 1) reportMatches(units[0]!.type ?? "", units);
            for (const u of units) process.stdout.write(sliceUnit(text, u.span, headOnly, bodyOnly));
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
  const [file] = positionals(argv, ["-o", "--out", "--from", "--to", "--root"]);
  if (!file) fail("no input file (use '-' to read from stdin)", 2);
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
    doc = parse(conv.geml, { resolveDoc: resolverFor(file, root), self: file === "-" ? undefined : basename(file) });
  } else {
    doc = parse(src, { resolveDoc: resolverFor(file, root), self: file === "-" ? undefined : basename(file) });
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
        parseDoc: (s) => parse(s, { resolveDoc: resolverFor(file, root) }),
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
  const doc = parse(source, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
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
  const doc = parse(source, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });

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
  for (const r of rows) {
    const mark = r.kind === "heading" ? `h${r.level}` : r.anon ? "anon" : "";
    const tail = r.kind === "heading" ? r.text ?? "" : `L${r.lines[0]}-${r.lines[1]}`;
    const line = `${r.address.padEnd(addrW)}  ${r.kind.padEnd(kindW)}  ${mark.padEnd(4)}  ${tail}`
      + (r.footnote ? "  footnote" : "");
    console.log(line.replace(/\s+$/, ""));
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
  const doc = parse(source, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
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
function runGet(args: string[]): void {
  const json = args.includes("--json");
  const headOnly = args.includes("--head");
  const bodyOnly = args.includes("--body");
  const view = args.includes("--view");
  const [file, rawSel] = positionals(args, ["--root"]);
  if (!file) fail(SUBHELP.get);
  if (headOnly && bodyOnly) fail("--head and --body are mutually exclusive", 2);
  if (json && (headOnly || bodyOnly)) {
    fail(`--json cannot be combined with ${headOnly ? "--head" : "--body"} — --json returns the model node, which has no sub-node for one part of a block`, 2);
  }
  // One read: stdin can only be consumed once, and the selector resolver needs
  // the same bytes the slice below works on.
  const source = readInput(file);
  const where = file === "-" ? "stdin" : file;
  const sel: Selector = parseSelector(rawSel, (braces) => parseAttrs(braces).id);

  if (sel.form === "list") {
    // §5.1: nothing here to narrow, and ignoring the flag would make
    // `get f --head` print byte-for-byte what `get f` prints.
    if (headOnly || bodyOnly) {
      fail(`${headOnly ? "--head" : "--body"} names part of ONE block, so it needs a selector — run \`geml get ${where}\` to list what to address`, 2);
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
          out.push(sliceUnit(res.text, res.unit.span, headOnly, bodyOnly));
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
  for (const u of units) process.stdout.write(sliceUnit(source, u.span, headOnly, bodyOnly));
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
  if (headOnly && bodyOnly) fail("--head and --body are mutually exclusive", 2);
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
  const beforeIds = parse(source, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) }).ids;
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

  const reparsed = parse(updated, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
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
  const reparsed = parse(updated, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
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
  const before = parse(source, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
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
  const reparsed = parse(updated, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
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
  const doc = parse(source, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
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
function stripEol(line: string): string {
  return line.replace(/(\r\n|\r|\n)$/, "");
}

// The body sub-range of a block span: [head+1, close) for a closed typed block,
// otherwise [head+1, end) — a heading section (no close fence) or an
// unterminated block whose span already runs to end-of-scope.
function bodyRange(text: string, span: Span): Span {
  const lines = splitLines(text);
  const open = FENCE_OPEN.exec(stripEol(lines[span.start] ?? ""));
  if (open) {
    const lastText = stripEol(lines[span.end - 1] ?? "").replace(/[ \t]+$/, "");
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
function spliceSpan(
  source: string, found: Span, replacement: string, file: string,
  headOnly = false, guardCount = false, id?: string,
): string {
  const beforeDoc = parse(source, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
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
  // Then require the target id to survive, and — because a malformed replacement
  // can swallow a neighbour — that every other pre-existing id survives too.
  const reparsed = parse(updated, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
  const errs = reparsed.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    const first = errs[0]!;
    refuseBroken(`replacement would break the document: ${first.message} (line ${first.line}); not written`, errs);
  }
  const now = new Set(reparsed.ids);
  if (id !== undefined && !now.has(id)) fail(`replacement removes id \`${id}\`; not written`, 1);
  const dropped = beforeIds.find((x) => x !== id && !now.has(x));
  if (dropped !== undefined) {
    fail(`replacement would drop block \`#${dropped}\` (malformed content?); not written`, 1);
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
  const beforeIds = parse(source, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) }).ids;
  const updated = splitLines(source).filter((_, i) => i < span.start || i >= span.end).join("");
  const reparsed = parse(updated, { resolveDoc: resolverFor(file), self: file === "-" ? undefined : basename(file) });
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
  try {
    copyTree(src, target);
  } catch (e) {
    // A clean one-liner, never a raw stack: --dest may name a file, a
    // read-only tree, or a path whose ancestor is not a directory.
    fail(`cannot install skill to ${target}: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
  console.log(`skill  installed -> ${target}  (${copied.join(", ")})`);

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
  console.log("done — new Claude Code sessions pick up the skill.");
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
// `entry` must be non-empty: in a browser bundle both sides degenerate to ""
// (esbuild defines process.argv=[] and import.meta.url="", and the node-stub's
// fileURLToPath is String()), which would run the CLI at import time and crash
// the page. A real CLI invocation always has argv[1].
if (entry && (entry === fileURLToPath(import.meta.url) || entry.endsWith("geml.ts"))) {
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
  } else if (cmd === "set") {
    runSet(argv.slice(1));
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
