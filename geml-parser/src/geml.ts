#!/usr/bin/env node
// GEML reference parser — Milestones 1 & 2: block scanner + inline content.
//
// M1: typed-block fences (equal-length close + longer-fence nesting), the
// `meta` data block, ATX headings, lists and paragraphs, the attribute object
// with §4 value typing, and a document-model JSON serialization.
//
// M2: inline parsing of flow blocks (§5 — emphasis/strong/strike, code, math,
// media embeds, links, auto-references, footnotes) and build-time reference
// validation (§8 — unique ids, resolvable internal/cross-document references).

import { readFileSync, writeFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { commit, restore, verify, listRevisions, resolveContent, firstChangedContent } from "./history.js";
import { renderHtml } from "./render.js";
import { type Value, coerce, parseAttrs } from "./attrs.js";
import { type Inline, type RefSink, parseInline } from "./inline.js";
import { type TableModel, parseTable } from "./table.js";
import { type ChartModel, buildChart } from "./chart.js";
import { mdToGeml } from "./from-md.js";
import { serialize } from "./serialize.js";
import { gemlToMd } from "./to-md.js";

export { type Value } from "./attrs.js";
export { type Inline } from "./inline.js";
export { type TableModel } from "./table.js";
export { mdToGeml, type ConvertResult } from "./from-md.js";
export { renderHtml, type RenderOptions } from "./render.js";
export { serialize } from "./serialize.js";
export { gemlToMd } from "./to-md.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type BodyMode = "raw" | "flow" | "data";

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
      hidden?: boolean; // `{hidden}`: in the model & referenceable, not rendered
    };

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  line: number; // 1-based
}

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
}

// Parse context threaded through the scanner: diagnostics, the id registry
// (id -> defining line, for uniqueness), and discovered references.
interface Ctx extends RefSink {
  diags: Diagnostic[];
  ids: Map<string, number>;
  meta: Map<string, string>; // merged `=== meta` keys, for `{{key}}` interpolation
  tables?: Map<string, TableModel>;
  charts?: { block: Extract<Block, { kind: "block" }>; line: number }[];
  resolveDoc?: (doc: string) => string | null; // threaded from ParseOptions
}

// Type registry: which body mode each typed block uses. Unknown types are a
// warning and fall back to `raw` (forward compatibility, §3/§8).
const REGISTRY: Record<string, BodyMode> = {
  code: "raw",
  diagram: "raw",
  math: "raw",
  table: "raw", // structured table parsing lands in M3
  output: "raw", // captured result of a code block (stored, never executed)
  note: "flow",
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
function interpolate(text: string, line: number, ctx: Ctx): string {
  if (!text.includes("{{")) return text;
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g, (full, key: string) => {
    if (ctx.meta.has(key)) return ctx.meta.get(key)!;
    ctx.diags.push({ severity: "error", message: `unknown metadata reference \`{{${key}}}\``, line });
    return full;
  });
}

// Register a block id, flagging duplicates as errors (§4: ids unique per doc).
function registerId(ctx: Ctx, id: string, line: number): void {
  if (ctx.ids.has(id)) {
    ctx.diags.push({ severity: "error", message: `duplicate id \`#${id}\` (first defined at line ${ctx.ids.get(id)})`, line });
  } else {
    ctx.ids.set(id, line);
  }
}

// §5: a list marker — `-`/`*` (unordered) or `N.` (ordered) — capturing the
// leading indent (in spaces; a tab counts as one) and the item content. Nesting
// is decided by that indent.
const MARKER = /^([ \t]*)(?:[-*]|(\d+)\.)[ \t]+(.*)$/;

interface Marker { indent: number; ordered: boolean; start?: number; rest: string; }

function matchMarker(line: string): Marker | null {
  const m = MARKER.exec(line);
  if (!m) return null;
  const ordered = m[2] !== undefined;
  const mk: Marker = { indent: m[1]!.length, ordered, rest: m[3]! };
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
        if (!tooDeep) { ctx.diags.push({ severity: "error", message: `list nesting too deep (max ${MAX_NESTING})`, line: base + i + 1 }); tooDeep = true; }
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
    const line = lines[i]!;

    if (line.trim() === "") { i++; continue; }

    // A `%%` line is hidden: kept in the model (tools can find it), never
    // rendered, and not inline-parsed (so a scratch note can't break the build).
    const hid = /^[ \t]*%%[ \t]?(.*)$/.exec(line);
    if (hid) { blocks.push({ kind: "hidden", text: hid[1]! }); i++; continue; }

    // §5.2: a Markdown-style footnote definition `[^id]: text` defines the
    // target a `[^id]` reference points at — recorded as a note block with that
    // id, so the reference resolves. (A model that reaches for Markdown
    // footnotes by habit then "just works" instead of leaving a dangling ref.)
    const fndef = /^\[\^([^\]]+)\]:[ \t]?(.*)$/.exec(line);
    if (fndef) {
      const id = fndef[1]!.trim();
      const lineNo = base + i + 1;
      registerId(ctx, id, lineNo);
      const text = interpolate(fndef[2]!, lineNo, ctx);
      blocks.push({
        kind: "block", type: "note", mode: "flow", id, classes: ["footnote"], attrs: {},
        children: [{ kind: "paragraph", text, inlines: parseInline(text, lineNo, ctx) }],
      });
      i++;
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open) {
      const openLen = open[1]!.length;
      const type = open[2]!;
      const attrs = open[3] ? parseAttrs(open[3]) : { classes: [], attrs: {} };
      const openLineNo = base + i + 1;

      // Collect the body. A block closes on a bare fence of exactly the opening
      // length, OR — when it has an id — on a labeled fence `=== #id` (a `=` run
      // of any length ≥ 3 followed by the block's id). The labeled close is a
      // *local* close: it can't be gotten wrong by miscounting `=`, so it is the
      // safe way to nest (§3).
      const labeled = attrs.id !== undefined ? new RegExp(`^={3,}[ \\t]+#${attrs.id}[ \\t]*$`) : null;
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (isCloseFence(lines[j]!, openLen) || (labeled && labeled.test(lines[j]!))) { closed = true; break; }
        body.push(lines[j]!);
      }
      if (!closed) {
        const how = attrs.id !== undefined ? `${"=".repeat(openLen)} or \`=== #${attrs.id}\`` : "=".repeat(openLen);
        diags.push({ severity: "error", message: `unterminated \`${type}\` block (no matching ${how})`, line: openLineNo });
      }

      let mode = REGISTRY[type];
      if (mode === undefined) {
        diags.push({ severity: "warning", message: `unknown block type \`${type}\`; body kept as raw`, line: openLineNo });
        mode = "raw";
      }

      const block: Extract<Block, { kind: "block" }> = {
        kind: "block", type, mode, classes: attrs.classes, attrs: attrs.attrs,
      };
      if (attrs.id !== undefined) { block.id = attrs.id; registerId(ctx, attrs.id, openLineNo); }
      if (attrs.attrs["hidden"] === true) block.hidden = true; // §4: not rendered, still in model

      // §3: an `output` block stores a code block's captured result; `of=#id`
      // (when present) binds it to that block and is checked like any reference.
      if (type === "output" && typeof attrs.attrs["of"] === "string") {
        const of = attrs.attrs["of"] as string;
        if (of.startsWith("#")) ctx.refs.push({ kind: "internal", anchor: of.slice(1), line: openLineNo });
      }

      if (mode === "flow") {
        if (depth >= MAX_NESTING) {
          // Refuse to recurse past the cap: emit a diagnostic and keep the body
          // as raw so the parser returns cleanly instead of overflowing the
          // call stack on a pathologically nested document (DoS).
          diags.push({ severity: "error", message: `block nesting too deep (max ${MAX_NESTING}); body kept as raw`, line: openLineNo });
          block.raw = body;
        } else {
          block.children = scanBlocks(body, base + i + 1, ctx, depth + 1);
        }
      } else if (mode === "data") {
        block.data = parseData(body);
      } else {
        block.raw = body;
        if (type === "table") {
          // §6: parse the raw body (visual or csv/tsv) into one table model.
          const { model, diagnostics } = parseTable(body, attrs.attrs, openLineNo, ctx);
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
              diags.push({ severity: "warning", message: "geml-chart body is ignored; the chart spec lives in attributes", line: openLineNo });
            }
            (ctx.charts ??= []).push({ block, line: openLineNo });
          } else if (fmt === "geml-code-graph") {
            // Code-graph embed (GEP-0003): the ONLY attribute is src=, pointing
            // at a codemap document; roots/depth come from that document's meta
            // ("view config travels with the data"). Body is empty.
            const src = attrs.attrs["src"];
            if (typeof src !== "string" || src === "") {
              diags.push({ severity: "warning", message: "geml-code-graph: missing `src=` (nothing to render)", line: openLineNo });
            } else if (ctx.resolveDoc && ctx.resolveDoc(src) === null) {
              diags.push({ severity: "warning", message: `geml-code-graph: cannot resolve document \`${src}\``, line: openLineNo });
            }
            if (body.length > 0 && body.some((l) => l.trim() !== "")) {
              diags.push({ severity: "warning", message: "geml-code-graph body is ignored; the embed is configured by `src=` alone", line: openLineNo });
            }
          } else if (typeof fmt === "string" && !DIAGRAM_RENDERERS.has(fmt)) {
            // §7: warn on a diagram format with no registered renderer.
            diags.push({ severity: "warning", message: `no registered renderer for diagram format \`${fmt}\`; body kept raw`, line: openLineNo });
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
      const a = h[3] ? parseAttrs(h[3]) : { classes: [], attrs: {} };
      const text = interpolate(h[2]!, lineNo, ctx);
      const id = a.id ?? slug(text);
      registerId(ctx, id, lineNo);
      const block: Extract<Block, { kind: "heading" }> = {
        kind: "heading", level, text, inlines: parseInline(text, lineNo, ctx), id, classes: a.classes, attrs: a.attrs,
      };
      if (a.attrs["hidden"] === true) block.hidden = true;
      blocks.push(block);
      i++;
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
function gatherIds(source: string): Set<string> {
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: new Map() };
  scanBlocks(source.replace(/\r\n?/g, "\n").split("\n"), 0, ctx);
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
        ctx.diags.push({ severity: "warning", message: `cross-document reference \`${ref.doc}${ref.anchor ? "#" + ref.anchor : ""}\` not checked (no document resolver)`, line: ref.line });
        continue;
      }
      let ids = docIds.get(ref.doc);
      if (ids === undefined) {
        const src = opts.resolveDoc(ref.doc);
        if (src === null) {
          ctx.diags.push({ severity: "error", message: `cannot resolve document \`${ref.doc}\``, line: ref.line });
          docIds.set(ref.doc, new Set());
          continue;
        }
        ids = gatherIds(src);
        docIds.set(ref.doc, ids);
      }
      if (ref.anchor !== undefined && !ids.has(ref.anchor)) {
        ctx.diags.push({ severity: "error", message: `unresolved reference \`${ref.doc}#${ref.anchor}\``, line: ref.line });
      }
      continue;
    }
    // internal, autoref, footnote — anchor must be a known id in this document.
    if (ref.anchor !== undefined && !ctx.ids.has(ref.anchor)) {
      const what = ref.kind === "footnote" ? `footnote \`[^${ref.anchor}]\`` : `reference \`#${ref.anchor}\``;
      ctx.diags.push({ severity: "error", message: `unresolved ${what}`, line: ref.line });
    }
  }
}

// §7: resolve every geml-chart against its referenced table. Runs after the
// scan so that `data=#id` may point at a table defined anywhere in the doc.
function resolveCharts(ctx: Ctx): void {
  for (const { block, line } of ctx.charts ?? []) {
    const ref = typeof block.attrs["data"] === "string" ? block.attrs["data"] : "";
    const id = ref.replace(/^#/, "");
    if (id === "") { ctx.diags.push({ severity: "error", message: "geml-chart: missing `data=#id`", line }); continue; }
    const table = ctx.tables?.get(id);
    if (!table) {
      const what = ctx.ids.has(id) ? `data target \`#${id}\` is not a table` : `unresolved reference \`#${id}\``;
      ctx.diags.push({ severity: "error", message: `geml-chart: ${what}`, line });
      continue;
    }
    if (table.src !== undefined) {
      // §6: the table's data is external (src=), loaded at render time. The
      // chart is therefore resolved at render time too — its column references
      // are checked there, not here — so skip build-time chart resolution.
      continue;
    }
    const { model, diagnostics } = buildChart(block.attrs, table);
    if (model) block.chart = model;
    for (const d of diagnostics) ctx.diags.push({ ...d, line });
  }
}

export function parse(source: string, opts: ParseOptions = {}): Document {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: collectMeta(lines), resolveDoc: opts.resolveDoc };
  const children = scanBlocks(lines, 0, ctx);
  resolveCharts(ctx);
  validateRefs(ctx, opts);
  return { kind: "document", children, ids: [...ctx.ids.keys()], diagnostics: ctx.diags };
}

// ---------------------------------------------------------------------------
// Source spans (§ addressable blocks) — the byte range each `#id` occupies.
// ---------------------------------------------------------------------------

// A half-open [start, end) range of 0-based *line* indices. Because parse()
// normalizes `\r\n?` -> `\n` before splitting, and normalization changes only a
// line's trailing bytes (never the line count), these indices apply unchanged to
// the original bytes — so `get`/`set` can splice by span without re-serializing.
export interface Span { start: number; end: number; }

// The id that a fence/heading line defines, matching how scanBlocks derives it
// (parseAttrs for the attribute object; heading text slug when no explicit id).
function idOfHeading(braces: string | undefined, text: string): string {
  return (braces ? parseAttrs(braces).id : undefined) ?? slug(text);
}

// Walk `lines` exactly as scanBlocks does — same fence close rules (equal-length
// or labeled `=== #id`), same flow-only recursion via REGISTRY — recording the
// source span of every addressable id (typed block, heading, footnote def).
// First definition wins, mirroring ctx.ids (a duplicate id is a build error, so
// `get`/`set` operate on the one the parser actually registered). `base` is the
// absolute line offset of this slice within the whole document.
function collectSpans(lines: string[], base: number, out: Map<string, Span>, depth = 0): void {
  const add = (id: string, start: number, end: number): void => {
    if (!out.has(id)) out.set(id, { start, end });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }

    const fndef = /^\[\^([^\]]+)\]:[ \t]?(.*)$/.exec(line);
    if (fndef) { add(fndef[1]!.trim(), base + i, base + i + 1); i++; continue; }

    if (/^[ \t]*%%/.test(line)) { i++; continue; } // hidden line: no id

    const open = FENCE_OPEN.exec(line);
    if (open) {
      const openLen = open[1]!.length;
      const type = open[2]!;
      const id = open[3] ? parseAttrs(open[3]).id : undefined;
      const labeled = id !== undefined ? new RegExp(`^={3,}[ \\t]+#${id}[ \\t]*$`) : null;
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (isCloseFence(lines[j]!, openLen) || (labeled && labeled.test(lines[j]!))) { closed = true; break; }
      }
      const end = closed ? j + 1 : j;
      if (id !== undefined) add(id, base + i, base + end);
      // Only a flow body is scanned for nested blocks (raw/data bodies are
      // opaque), so an id inside a `code` body is *not* addressable — exactly
      // the parser's contract.
      if ((REGISTRY[type] ?? "raw") === "flow" && depth < MAX_NESTING) {
        collectSpans(lines.slice(i + 1, closed ? j : end), base + i + 1, out, depth + 1);
      }
      i = end;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) { add(idOfHeading(h[3], h[2]!), base + i, base + i + 1); i++; continue; }

    i++;
  }
}

// Map every addressable id in `source` to its source span. Line indices align
// with the physical lines produced by splitLines(source).
export function blockSpans(source: string): Map<string, Span> {
  const out = new Map<string, Span>();
  collectSpans(source.replace(/\r\n?/g, "\n").split("\n"), 0, out);
  return out;
}

// Split into physical lines while *keeping* each line's terminator, so
// join("") is byte-exact and slicing by span never rewrites line endings.
function splitLines(source: string): string[] {
  return source.split(/(?<=\n)/);
}

// Depth-first search for the document-model node carrying `id`, descending into
// flow-block children (and list-item children) so a nested id is found too.
function findBlockById(blocks: Block[], id: string): Block | undefined {
  for (const b of blocks) {
    if ((b.kind === "heading" || b.kind === "block") && b.id === id) return b;
    if (b.kind === "block" && b.children) {
      const hit = findBlockById(b.children, id);
      if (hit) return hit;
    }
    if (b.kind === "list") {
      for (const it of b.items) {
        if (it.children) {
          const hit = findBlockById(it.children, id);
          if (hit) return hit;
        }
      }
    }
  }
  return undefined;
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

function parseStamp(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new Error(`bad --at timestamp: ${s} (want YYYYMMDDTHHMMSSZ)`);
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +se!));
}

const VERSION = "1.0";          // GEML spec version this CLI targets
const PARSER_VERSION = "1.2.2";       // reference implementation; keep in sync with package.json

const USAGE = `geml — GEML reference CLI

Usage:
  geml <file.geml|->                         parse -> document-model JSON (stdout)
  geml get <file.geml|-> #id [--json]        print ONE block by id (raw span, or --json node)
  geml set <file.geml|-> #id [--from f][-o f] replace ONE block by id (new content: --from/stdin)
  geml revert <file.geml> #id [--to <sel>]   restore ONE block to a past revision (sel: -N|latest|id)
  geml check <file.geml|-> [--root d][--json] validate only: diagnostics + exit code
                                             (--root widens cross-doc refs to dir d, e.g. the repo root)
  geml render <file.geml|-> [-o out.html]    render to one self-contained HTML file
  geml fmt <file.geml|-> [-o out.geml]       re-serialize to canonical GEML
  geml convert <file.md|-> [-o out.geml]     Markdown -> GEML
  geml export <file.geml|-> [-o out.md]      GEML -> Markdown (lossy)
  geml history <commit|verify|show|restore|log> <file.geml> [...]
  geml codemap <build|verify|render|serve|refresh|find|mcp> [...]   code-graph toolkit (alias: codegraph)
  geml --help | --version [--json]

Use '-' as the file to read from stdin.
Exit codes: 0 ok · 1 document/operation error · 2 usage error.`;

// One-line usage for each subcommand — the single source for both the error
// shown on misuse and the `<cmd> --help` text.
const SUBHELP = {
  get: "usage: geml get <file.geml|-> #id [--json]",
  set: "usage: geml set <file.geml|-> #id [--from FILE] [-o out.geml]",
  check: "usage: geml check <file.geml|-> [--root <dir>] [--json]  (--root: resolve cross-doc refs within <dir> instead of the file's own directory)",
  render: "usage: geml render <file.geml|-> [-o out.html]",
  convert: "usage: geml convert <file.md|-> [-o out.geml]",
  export: "usage: geml export <file.geml|-> [-o out.md]",
  fmt: "usage: geml fmt <file.geml|-> [-o out.geml]",
  revert: "usage: geml revert <file.geml> #id [--to <sel>] [--changed] [--dry-run] [-o out]  (sel: -N | latest | id-prefix; default -1)",
  history: "usage: geml history <commit|verify|show|restore|log> <file.geml> [...]",
  codemap: `usage: geml codemap build  [--root <repo>]   # auto-detect languages, run the indexer(s), and merge into one codemap (--root defaults to the current directory)
       geml codemap build  (--db <graph.db> | --adapter joern|scip --raw <in>)+ [--root <repo>] [--out .geml-code-graph] [--container module|dir|file] [--lang <JAVASRC|NEWC|…>] [--joern <path>] [--history [-m msg]]
       geml codemap verify [dir]                 geml check + profile reference checks
       geml codemap render [dir]                 every doc -> sibling .html (open index.html from disk)
       geml codemap serve  [dir] [--port 8140] [--watch] [--background|--stop]   live viewer: pages render from .geml on request; --watch re-runs the recipe when sources change
       geml codemap refresh [dir] [--force] [--commit] [--background|--hook]   re-run the recorded build recipe (_index/refresh.json); --commit lands it as its own commit
       geml codemap find <name> [dir]            locate a symbol by substring name -> doc#id + src (stdout, no browser)
       geml codemap mcp                          stdio MCP server (GEML_GRAPH_DIR or graph_dir arg)
       (<dir> for verify/render/serve/refresh/find defaults to ./.geml-code-graph; codegraph and code-graph are accepted as aliases of codemap)`,
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
    const targetAbs = resolvePath(dirAbs, d);
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
  const doc = parse(readInput(file), { resolveDoc: resolverFor(file, root) });
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

function runHistory(args: string[]): void {
  const sub = args[0];
  const file = args[1];
  if (!sub || !file) fail(SUBHELP.history);
  const historyPath = flag(args, "--history") ?? historyPathFor(file);

  try {
    if (sub === "commit") {
      const at = flag(args, "--at");
      const r = commit({
        gemlPath: file,
        historyPath,
        summary: flag(args, "-m") ?? flag(args, "--message") ?? "",
        author: flag(args, "--author"),
        at: at ? parseStamp(at) : undefined,
      });
      console.log(`committed ${r.id}`);
    } else if (sub === "verify") {
      const res = verify(historyPath, file);
      for (const e of res.errors) console.error(`error: ${e}`);
      for (const w of res.warnings) console.error(`warning: ${w}`);
      console.log(`verify: ${res.ok ? "OK" : "FAILED"} (${res.checked} revisions reconstructed & hashed)`);
      if (!res.ok) process.exit(1);
    } else if (sub === "show") {
      const rev = args[2];
      if (!rev) fail("usage: geml history show <file.geml> <revision>");
      process.stdout.write(restore({ historyPath, gemlPath: file, revision: rev }));
    } else if (sub === "restore") {
      const rev = args[2];
      if (!rev) fail("usage: geml history restore <file.geml> <revision> [--force]");
      restore({ historyPath, gemlPath: file, revision: rev, write: true, force: args.includes("--force") });
      console.log(`restored ${file} to ${rev}`);
    } else if (sub === "log") {
      // Newest-first, with the `--to` selector for each row in the first column
      // (`latest` for the tip, then `-1`, `-2`, …) so the output is copy-paste.
      for (const r of listRevisions(historyPath)) {
        const sel = r.current ? "latest" : `-${r.offset}`;
        console.log(`${sel.padEnd(7)} ${r.id}  ${r.author ?? "-"}  ${r.summary ?? ""}`.replace(/\s+$/, ""));
      }
    } else {
      fail(`unknown history subcommand: ${sub}. Run 'geml --help'.`);
    }
  } catch (e) {
    fail(historyError(e, file, historyPath));
  }
}

// `geml convert <file.md|-> [-o out.geml]` — Markdown -> GEML.
function runConvert(args: string[]): void {
  const file = args.find((a) => a === "-" || (!a.startsWith("-") && a !== flag(args, "-o")));
  if (!file) fail(SUBHELP.convert);
  const { geml, notes } = mdToGeml(readInput(file));
  for (const n of notes) console.error(`note: ${n}`);
  const outPath = flag(args, "-o") ?? flag(args, "--out");
  if (outPath) {
    writeFileSync(outPath, geml);
    console.error(`wrote ${outPath}`);
  } else {
    process.stdout.write(geml);
  }
}

// `geml export <file.geml|-> [-o out.md]` — GEML -> Markdown (lossy). Writes
// the output even with diagnostics, prints any lossy-projection notes, and
// exits non-zero on a parse error — same contract as render.
function runExport(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const file = args.find((a) => a === "-" || (!a.startsWith("-") && a !== out));
  if (!file) fail(SUBHELP.export);
  const doc = parse(readInput(file), { resolveDoc: resolverFor(file) });
  const { md, notes } = gemlToMd(doc);
  if (out) { writeFileSync(out, md); console.error(`wrote ${out}`); }
  else process.stdout.write(md);
  for (const n of notes) console.error(`note: ${n}`);
  for (const d of doc.diagnostics) console.error(`${d.severity}: ${d.message} (line ${d.line})`);
  if (doc.diagnostics.some((d) => d.severity === "error")) process.exit(1);
}

// `geml render <file.geml> [-o out.html]` — GEML -> one self-contained,
// interactive HTML artifact (the P0 runtime). Writes the file even when there
// are diagnostics (a viewer should still show what it can), but exits non-zero
// on any error so CI and agents get a hard signal.
function runRender(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const file = args.find((a) => a === "-" || (!a.startsWith("-") && a !== out));
  if (!file) fail(SUBHELP.render);
  const doc = parse(readInput(file), { resolveDoc: resolverFor(file) });
  const html = renderHtml(doc, {
    source: file === "-" ? "stdin" : basename(file),
    // geml-code-graph embeds load + parse sibling codemap documents on demand.
    loadDoc: resolverFor(file),
    parseDoc: (s) => parse(s),
  });
  if (out) { writeFileSync(out, html); console.error(`wrote ${out}`); }
  else process.stdout.write(html);
  for (const d of doc.diagnostics) console.error(`${d.severity}: ${d.message} (line ${d.line})`);
  if (doc.diagnostics.some((d) => d.severity === "error")) process.exit(1);
}

// `geml fmt <file.geml> [-o out.geml]` — re-serialize the document model into
// canonical GEML. Because `serialize` is the inverse of `parse`, `fmt` is a
// pretty-printer whose output parses back to the same model (round-trip stable).
function runFmt(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const file = args.find((a) => a === "-" || (!a.startsWith("-") && a !== out));
  if (!file) fail(SUBHELP.fmt);
  const doc = parse(readInput(file), { resolveDoc: resolverFor(file) });
  const text = serialize(doc);
  if (out) { writeFileSync(out, text); console.error(`wrote ${out}`); }
  else process.stdout.write(text);
  // A broken document must not be reported as a clean format. Surface the
  // diagnostics and exit non-zero, matching parse/render/check.
  for (const d of doc.diagnostics) console.error(`${d.severity}: ${d.message} (line ${d.line})`);
  if (doc.diagnostics.some((d) => d.severity === "error")) process.exit(1);
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

// `geml get <file.geml|-> #id [--json]` — print ONE block, addressed by id,
// without loading the rest of the document into context. Default output is the
// block's exact source bytes (its full `=== … ===` span, or the source line for
// a heading/footnote); `--json` prints that block's document-model node.
function runGet(args: string[]): void {
  const json = args.includes("--json");
  const [file, rawId] = positionals(args, []);
  if (!file || !rawId) fail(SUBHELP.get);
  const id = rawId.replace(/^#/, "");

  const source = readInput(file);
  if (json) {
    // The model node — same shape `geml <file>` emits for it. Parsing is needed
    // to resolve the tree (and nested-block ids), but only the one node prints.
    const doc = parse(source, { resolveDoc: resolverFor(file) });
    const block = findBlockById(doc.children, id);
    if (!block) fail(`no block with id \`${id}\``, 1);
    console.log(JSON.stringify(block, null, 2));
    return;
  }
  // Raw: slice the source span byte-for-byte. No parse required, so `get` still
  // returns the exact bytes even if the document has diagnostics elsewhere.
  const span = blockSpans(source).get(id);
  if (!span) fail(`no block with id \`${id}\``, 1);
  process.stdout.write(splitLines(source).slice(span.start, span.end).join(""));
}

// `geml set <file.geml|-> #id [--from FILE] [-o out]` — replace ONLY that
// block's source span with new content (from --from or stdin), preserving every
// other byte. Prints the full updated document, or writes in place with -o. The
// splice is re-parsed and rejected if it broke the doc: `set` never writes a
// corrupt file.
function runSet(args: string[]): void {
  const out = flag(args, "-o") ?? flag(args, "--out");
  const from = flag(args, "--from");
  const [file, rawId] = positionals(args, ["-o", "--out", "--from"]);
  if (!file || !rawId) fail(SUBHELP.set);
  const id = rawId.replace(/^#/, "");

  // Both the document and the replacement can't come from stdin. Reject that up
  // front — before consuming stdin — so the document read below is unambiguous.
  if (file === "-" && from === undefined) {
    fail("reading the document from stdin needs --from for the new content", 2);
  }

  const source = readInput(file);
  // New content: an explicit --from file, else stdin.
  let replacement: string;
  if (from !== undefined) {
    replacement = readInput(from);
  } else {
    replacement = readInput("-");
    if (replacement === "") fail("no replacement content (use --from FILE or pipe it on stdin)", 1);
  }

  const updated = spliceBlock(source, id, replacement, file);
  if (out) { writeFileSync(out, updated); console.error(`wrote ${out}`); }
  else process.stdout.write(updated);
}

// Replace block #id's source span in `source` with `replacement`, preserving
// every other byte, and GUARD the result: the re-parse must be error-free, #id
// must survive, and no other pre-existing id may vanish (a malformed replacement
// can silently swallow a neighbour). Returns the updated document text; on any
// violation it calls fail() and never returns a corrupt document. Shared by
// `set` and `revert`.
function spliceBlock(source: string, id: string, replacement: string, file: string): string {
  const span = blockSpans(source).get(id);
  if (!span) fail(`no block with id \`${id}\``, 1);
  const beforeIds = parse(source, { resolveDoc: resolverFor(file) }).ids;

  // Keep the bytes before and after the target span exactly; give the new block
  // a single trailing newline so the following block still starts on its own
  // line (unless it is the file's last line, which may legitimately lack one).
  const orig = splitLines(source);
  const before = orig.slice(0, span.start);
  const after = orig.slice(span.end);
  let inject = replacement.replace(/\r\n?/g, "\n");
  const lastLine = span.end >= orig.length;
  if (!inject.endsWith("\n") && !lastLine) inject += "\n";
  const updated = before.join("") + inject + after.join("");

  // Re-parse and refuse a broken result. A parse error or a duplicate id both
  // surface as error diagnostics (registerId flags dups); one check covers both.
  // Then require the target id to survive, and — because a malformed replacement
  // can swallow a neighbour — that every other pre-existing id survives too.
  const reparsed = parse(updated, { resolveDoc: resolverFor(file) });
  const errs = reparsed.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    const first = errs[0]!;
    fail(`replacement would break the document: ${first.message} (line ${first.line}); not written`, 1);
  }
  const now = new Set(reparsed.ids);
  if (!now.has(id)) fail(`replacement removes id \`${id}\`; not written`, 1);
  const dropped = beforeIds.find((x) => x !== id && !now.has(x));
  if (dropped !== undefined) {
    fail(`replacement would drop block \`#${dropped}\` (malformed content?); not written`, 1);
  }
  return updated;
}

// `geml revert <file.geml> #id [--to <sel>] [--changed] [--dry-run] [-o out] [--history PATH]`
// Restore ONE block to a past revision's version — a targeted, guarded splice
// that leaves the rest of the document untouched. <sel> (default `-1`): `-N` (N
// revisions back from current), `latest`, or an id prefix/suffix. `--changed`
// skips revisions that never touched the block, landing on its previous
// *distinct* version. `--dry-run` prints what would be spliced in, writing
// nothing. Writes in place by default (revert is a mutation); `-o` redirects.
function runRevert(args: string[]): void {
  const changed = args.includes("--changed");
  const dryRun = args.includes("--dry-run");
  const out = flag(args, "-o") ?? flag(args, "--out");
  const to = flag(args, "--to") ?? "-1";
  const [file, rawId] = positionals(args, ["--to", "--history", "-o", "--out"]);
  if (!file || !rawId) fail(SUBHELP.revert);
  if (file === "-") fail("revert needs a real file (it reads that file's .gemlhistory)", 2);
  const id = rawId.replace(/^#/, "");
  const historyPath = flag(args, "--history") ?? historyPathFor(file);

  const source = readInput(file);
  const curSpan = blockSpans(source).get(id);
  if (!curSpan) fail(`no block with id \`${id}\` in ${file}`, 1);
  const curBlock = splitLines(source).slice(curSpan.start, curSpan.end).join("");

  // Extract block #id's source from a reconstructed revision (undefined if the
  // block did not exist there).
  const pick = (text: string): string | undefined => {
    const s = blockSpans(text).get(id);
    return s ? splitLines(text).slice(s.start, s.end).join("") : undefined;
  };

  // Resolve the source revision, formatting any history-layer error cleanly.
  const target = ((): { id: string; text: string } => {
    try {
      if (changed) {
        const found = firstChangedContent(historyPath, curBlock, pick);
        if (!found) fail(`no earlier revision changes \`${id}\``, 1);
        return found;
      }
      return resolveContent(historyPath, to);
    } catch (e) {
      fail(historyError(e, file, historyPath), 1);
    }
  })();

  const oldBlock = pick(target.text);
  if (oldBlock === undefined) fail(`block \`${id}\` does not exist at revision ${target.id}`, 1);
  if (oldBlock === curBlock) {
    console.error(`#${id} is unchanged at ${target.id}; nothing to revert${changed ? "" : " (try --to -2, or --changed)"}`);
    return;
  }
  if (dryRun) {
    console.error(`would revert #${id} to ${target.id}:`);
    process.stdout.write(oldBlock.endsWith("\n") ? oldBlock : oldBlock + "\n");
    return;
  }

  const updated = spliceBlock(source, id, oldBlock, file);
  const dest = out ?? file;
  writeFileSync(dest, updated);
  console.error(`reverted #${id} to ${target.id}${dest === file ? "" : ` -> ${dest}`}`);
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
    mcp: "mcp-server.mjs",
  };
  const sub = args[0] ?? "";
  const script = scripts[sub];
  if (!script) fail(`unknown codemap subcommand '${sub}'.\n${SUBHELP.codemap}`);
  const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "codemap", script);
  const r = spawnSync(process.execPath, [mod, ...args.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
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
if (entry === fileURLToPath(import.meta.url) || entry.endsWith("geml.ts")) {
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
  } else if (cmd === "revert") {
    runRevert(argv.slice(1));
  } else if (cmd === "history") {
    runHistory(argv.slice(1));
  } else if (cmd === "convert") {
    runConvert(argv.slice(1));
  } else if (cmd === "export") {
    runExport(argv.slice(1));
  } else if (cmd === "render") {
    runRender(argv.slice(1));
  } else if (cmd === "fmt") {
    runFmt(argv.slice(1));
  } else if (cmd === "check") {
    runCheck(argv.slice(1));
  } else if (cmd === "codemap") {
    runCodemap(argv.slice(1));
  } else if (cmd !== "-" && !/[.\/\\]/.test(cmd)) {
    // A bare word that is neither a known command nor a path is almost always
    // a mistyped command — say so, don't try to read it as a file.
    fail(`unknown command '${cmd}'. Run 'geml --help'.`);
  } else {
    // Default: parse a file (or stdin via '-') to the document-model JSON.
    const doc = parse(readInput(cmd), { resolveDoc: resolverFor(cmd) });
    console.log(JSON.stringify(doc, null, 2));
    if (doc.diagnostics.some((d) => d.severity === "error")) process.exit(1);
  }
}
