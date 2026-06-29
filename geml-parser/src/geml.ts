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

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { commit, restore, verify } from "./history.js";
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
  aside: "flow",
  meta: "data",
};

// §7: built-in diagram renderer registry. Unknown formats are a warning (the
// processor keeps the body raw rather than interpreting it).
const DIAGRAM_RENDERERS = new Set(["mermaid", "graphviz", "dot", "d2", "plantuml", "geml-chart"]);

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^(={3,})[ \t]+([A-Za-z][A-Za-z0-9_-]*)[ \t]*(\{.*\})?[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*(\{[^}]*\})?[ \t]*$/;
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]+(.*)$/;

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
      cur = mkList(mk);
      (parent.children ??= []).push(cur);
      stack.push({ list: cur, indent: mk.indent });
    } else {
      cur = top.list;
    }
    if (prevBlank && cur.items.length > 0) cur.loose = true;
    cur.items.push(makeListItem(mk, base + i + 1, ctx));
    prevBlank = false;
    i++;
  }
  return { block: root, next: i };
}

function scanBlocks(lines: string[], base: number, ctx: Ctx): Block[] {
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
        block.children = scanBlocks(body, base + i + 1, ctx);
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
  const ctx: Ctx = { diags: [], ids: new Map(), refs: [], meta: collectMeta(lines) };
  const children = scanBlocks(lines, 0, ctx);
  resolveCharts(ctx);
  validateRefs(ctx, opts);
  return { kind: "document", children, ids: [...ctx.ids.keys()], diagnostics: ctx.diags };
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

const VERSION = "1.0-draft";          // GEML spec version this CLI targets
const PARSER_VERSION = "0.1.0";       // reference implementation; keep in sync with package.json

const USAGE = `geml — GEML reference CLI

Usage:
  geml <file.geml|->                         parse -> document-model JSON (stdout)
  geml check <file.geml|-> [--json]          validate only: diagnostics + exit code
  geml render <file.geml|-> [-o out.html]    render to one self-contained HTML file
  geml fmt <file.geml|-> [-o out.geml]       re-serialize to canonical GEML
  geml convert <file.md|-> [-o out.geml]     Markdown -> GEML
  geml export <file.geml|-> [-o out.md]      GEML -> Markdown (lossy)
  geml history <commit|verify|show|restore> <file.geml> [...]
  geml --help | --version [--json]

Use '-' as the file to read from stdin.
Exit codes: 0 ok · 1 document/operation error · 2 usage error.`;

// One-line usage for each subcommand — the single source for both the error
// shown on misuse and the `<cmd> --help` text.
const SUBHELP = {
  check: "usage: geml check <file.geml|-> [--json]",
  render: "usage: geml render <file.geml|-> [-o out.html]",
  convert: "usage: geml convert <file.md|-> [-o out.geml]",
  export: "usage: geml export <file.geml|-> [-o out.md]",
  fmt: "usage: geml fmt <file.geml|-> [-o out.geml]",
  history: "usage: geml history <commit|verify|show|restore> <file.geml> [...]",
};

// Set from argv at dispatch time; when true, errors are emitted as a JSON
// envelope so an agent that standardizes on --json never has to parse text.
let jsonMode = false;

// Clean one-line error + non-zero exit — never a raw Node stack trace.
function fail(msg: string): never {
  if (jsonMode) console.error(JSON.stringify({ error: msg, code: 2 }));
  else console.error(`error: ${msg}`);
  process.exit(2);
}

// Read a file, or stdin when the path is "-". On failure emit a clean error.
function readInput(file: string): string {
  try {
    return readFileSync(file === "-" ? 0 : file, "utf8");
  } catch {
    fail(file === "-" ? "cannot read stdin" : `cannot read ${file}`);
  }
}

// A cross-document resolver rooted at the input's directory (cwd for stdin).
function resolverFor(file: string): (d: string) => string | null {
  const baseDir = file === "-" ? "." : dirname(file);
  return (d) => {
    try { return readFileSync(resolvePath(baseDir, d), "utf8"); }
    catch { return null; }
  };
}

// `geml check <file>` — validate only: diagnostics + exit code, no document
// dump (cheap for agents). `--json` prints the diagnostics array for machines.
function runCheck(args: string[]): void {
  const json = args.includes("--json");
  const file = args.find((a) => a === "-" || !a.startsWith("-"));
  if (!file) fail(SUBHELP.check);
  const doc = parse(readInput(file), { resolveDoc: resolverFor(file) });
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
  const html = renderHtml(doc, { source: file === "-" ? "stdin" : basename(file) });
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

const entry = process.argv[1] ?? "";
if (entry.endsWith("geml.js") || entry.endsWith("geml.ts")) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
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
