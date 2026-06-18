// GEML reference parser — Milestone 3: tables (§6).
//
// A `table` block has two interchangeable body forms that parse to the SAME
// model: a visual pipe grid, or a data form (`format=csv`/`tsv`). The model
// carries column names, per-column alignment, body cells (inline-parsed),
// merged-cell spans (`span="r2c1:2x1"`), and columns produced by `compute`
// formulas (per-row arithmetic over columns, with sum/avg/min/max/count
// aggregates). See §6.

import { type Value, coerce } from "./attrs.js";
import { type Inline, type RefSink, parseInline } from "./inline.js";

export type Align = "left" | "right" | "center";

export interface TableCell {
  text: string;
  inlines: Inline[];
  align?: Align;
  value?: number;     // numeric value, when the cell is/becomes a number
  computed?: boolean; // produced by a `compute` formula
  span?: { rows: number; cols: number };
}

export interface TableModel {
  caption?: string;
  header: boolean;
  columns: string[];                 // header names (or letters A,B,… if none)
  align: (Align | undefined)[];
  rows: TableCell[][];               // body rows (header excluded)
}

export interface TableDiag { severity: "error" | "warning"; message: string; }

export interface TableResult {
  model: TableModel;
  diagnostics: TableDiag[];
}

// ---------------------------------------------------------------------------
// Body-form parsing
// ---------------------------------------------------------------------------

const SEP_CELL = /^:?-+:?$/;

function alignOf(sep: string): Align | undefined {
  const l = sep.startsWith(":");
  const r = sep.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return undefined;
}

// Split a visual table row `| a | b |` into trimmed cell strings.
function splitPipes(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseVisual(body: string[]): { columns: string[]; align: (Align | undefined)[]; header: boolean; cells: string[][] } {
  const rows = body.filter((l) => l.trim() !== "").map(splitPipes);
  let sepIdx = -1;
  for (let r = 0; r < rows.length; r++) {
    if (rows[r]!.length > 0 && rows[r]!.every((c) => SEP_CELL.test(c))) { sepIdx = r; break; }
  }
  if (sepIdx >= 0) {
    const headerRow = sepIdx > 0 ? rows[sepIdx - 1]! : [];
    const align = rows[sepIdx]!.map(alignOf);
    const cells = rows.slice(sepIdx + 1);
    const columns = headerRow.length ? headerRow : letters(cells[0]?.length ?? align.length);
    return { columns, align, header: headerRow.length > 0, cells };
  }
  // No separator: headerless, columns are letters.
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { columns: letters(width), align: [], header: false, cells: rows };
}

function parseDelimited(body: string[], sep: string, header: boolean): { columns: string[]; align: (Align | undefined)[]; header: boolean; cells: string[][] } {
  const rows = body.filter((l) => l.trim() !== "").map((l) => l.split(sep).map((c) => c.trim()));
  if (header && rows.length) {
    return { columns: rows[0]!, align: [], header: true, cells: rows.slice(1) };
  }
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { columns: letters(width), align: [], header: false, cells: rows };
}

function letters(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

// ---------------------------------------------------------------------------
// `compute` formulas (§6)
// ---------------------------------------------------------------------------

type ColResolve = (name: string, row: number) => number | null;

const AGGS = new Set(["sum", "avg", "min", "max", "count"]);

interface Tok { t: "num" | "name" | "op" | "lp" | "rp" | "comma"; v: string; }

function lexExpr(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if ("+-*/".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    if (c === "(") { out.push({ t: "lp", v: c }); i++; continue; }
    if (c === ")") { out.push({ t: "rp", v: c }); i++; continue; }
    if (c === ",") { out.push({ t: "comma", v: c }); i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
      out.push({ t: "num", v: s.slice(i, j) }); i = j; continue;
    }
    // identifier: column name or function — run of non-operator chars
    let j = i;
    while (j < s.length && !/[\s+\-*/(),]/.test(s[j]!)) j++;
    out.push({ t: "name", v: s.slice(i, j) }); i = j;
  }
  return out;
}

// Recursive-descent evaluator restricted to + - * / ( ) and aggregate funcs.
function evalExpr(toks: Tok[], row: number, col: ColResolve, agg: (fn: string, name: string) => number | null): number {
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++]!;

  function parseExpr(): number {
    let v = parseTerm();
    while (peek() && peek()!.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = next().v;
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function parseTerm(): number {
    let v = parseFactor();
    while (peek() && peek()!.t === "op" && (peek()!.v === "*" || peek()!.v === "/")) {
      const op = next().v;
      const r = parseFactor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function parseFactor(): number {
    const tk = peek();
    if (!tk) throw new Error("unexpected end of formula");
    if (tk.t === "op" && tk.v === "-") { next(); return -parseFactor(); }
    if (tk.t === "lp") { next(); const v = parseExpr(); if (peek()?.t !== "rp") throw new Error("missing )"); next(); return v; }
    if (tk.t === "num") { next(); return parseFloat(tk.v); }
    if (tk.t === "name") {
      next();
      if (peek()?.t === "lp" && AGGS.has(tk.v.toLowerCase())) {
        next();
        const arg = peek();
        if (arg?.t !== "name") throw new Error(`bad argument to ${tk.v}()`);
        next();
        if (peek()?.t !== "rp") throw new Error("missing )");
        next();
        const a = agg(tk.v.toLowerCase(), arg.v);
        if (a === null) throw new Error(`unknown column \`${arg.v}\``);
        return a;
      }
      const cv = col(tk.v, row);
      if (cv === null) throw new Error(`unknown column \`${tk.v}\``);
      return cv;
    }
    throw new Error(`unexpected token \`${tk.v}\``);
  }

  const v = parseExpr();
  if (p !== toks.length) throw new Error("trailing tokens in formula");
  return v;
}

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

// Parse `r2c1:2x1` → target cell (1-based row/col over body) + size.
function parseSpan(s: string): { row: number; col: number; rows: number; cols: number } | null {
  const m = /^r(\d+)c(\d+):(\d+)x(\d+)$/.exec(s.trim());
  if (!m) return null;
  return { row: +m[1]!, col: +m[2]!, rows: +m[3]!, cols: +m[4]! };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function parseTable(
  body: string[],
  attrs: Record<string, Value>,
  line: number,
  sink: RefSink,
): TableResult {
  const diagnostics: TableDiag[] = [];
  const fmt = typeof attrs["format"] === "string" ? (attrs["format"] as string) : undefined;

  let raw: { columns: string[]; align: (Align | undefined)[]; header: boolean; cells: string[][] };
  if (fmt === "csv" || fmt === "tsv") {
    const headerAttr = attrs["header"];
    const header = headerAttr === undefined ? true : headerAttr === true || headerAttr === 1 || headerAttr === "1";
    raw = parseDelimited(body, fmt === "tsv" ? "\t" : ",", header);
  } else {
    if (fmt !== undefined) diagnostics.push({ severity: "warning", message: `unknown table format \`${fmt}\`; parsed as visual grid` });
    raw = parseVisual(body);
  }

  const columns = [...raw.columns];
  const model: TableModel = { header: raw.header, columns, align: raw.align, rows: [] };
  const caption = attrs["caption"];
  if (typeof caption === "string") model.caption = caption;

  // Build body cells with inline content and numeric values.
  for (const r of raw.cells) {
    const row: TableCell[] = [];
    for (let c = 0; c < columns.length; c++) {
      const text = r[c] ?? "";
      const cell: TableCell = { text, inlines: parseInline(text, line, sink) };
      const align = raw.align[c];
      if (align) cell.align = align;
      const v = coerce(text);
      if (typeof v === "number") cell.value = v;
      row.push(cell);
    }
    model.rows.push(row);
  }

  // Column lookup by header name or single letter (A=0).
  const colIndex = (name: string): number => {
    const byName = columns.indexOf(name);
    if (byName >= 0) return byName;
    if (/^[A-Z]$/.test(name)) return name.charCodeAt(0) - 65;
    return -1;
  };
  const cellNum = (ci: number, row: number): number | null => {
    const v = model.rows[row]?.[ci]?.value;
    return typeof v === "number" ? v : null;
  };
  const colResolve: ColResolve = (name, row) => {
    const ci = colIndex(name);
    return ci < 0 ? null : cellNum(ci, row);
  };
  const aggResolve = (fn: string, name: string): number | null => {
    const ci = colIndex(name);
    if (ci < 0) return null;
    const vals: number[] = [];
    for (let r = 0; r < model.rows.length; r++) { const v = cellNum(ci, r); if (v !== null) vals.push(v); }
    if (fn === "count") return vals.length;
    if (vals.length === 0) return 0;
    if (fn === "sum") return vals.reduce((a, b) => a + b, 0);
    if (fn === "avg") return vals.reduce((a, b) => a + b, 0) / vals.length;
    if (fn === "min") return Math.min(...vals);
    if (fn === "max") return Math.max(...vals);
    return null;
  };

  // `compute="Name = expr"` — may appear once or as compute, compute2, …
  const formulas = Object.entries(attrs)
    .filter(([k]) => k === "compute" || /^compute\d+$/.test(k))
    .map(([, v]) => v)
    .filter((v): v is string => typeof v === "string");

  for (const f of formulas) {
    const eq = f.indexOf("=");
    if (eq <= 0) { diagnostics.push({ severity: "error", message: `bad compute formula \`${f}\` (want \`Name = expr\`)` }); continue; }
    const name = f.slice(0, eq).trim();
    const expr = f.slice(eq + 1).trim();
    let toks: Tok[];
    try { toks = lexExpr(expr); } catch { diagnostics.push({ severity: "error", message: `cannot lex formula \`${f}\`` }); continue; }

    // Target is a header name (never a letter reference): match by name only.
    let ci = columns.indexOf(name);
    if (ci < 0) { columns.push(name); ci = columns.length - 1; }

    let failed = false;
    for (let r = 0; r < model.rows.length && !failed; r++) {
      try {
        const v = evalExpr(toks, r, colResolve, aggResolve);
        const cell = ensureCell(model.rows[r]!, ci);
        if (Number.isFinite(v)) { cell.value = v; cell.text = String(v); cell.computed = true; cell.inlines = [{ type: "text", value: String(v) }]; }
      } catch (e) {
        diagnostics.push({ severity: "error", message: `compute \`${name}\`: ${(e as Error).message}` });
        failed = true;
      }
    }
  }

  // Spans: `span="r2c1:2x1"` (one or many: span, span2, …).
  const spanDecls = Object.entries(attrs)
    .filter(([k]) => k === "span" || /^span\d+$/.test(k))
    .map(([, v]) => v)
    .filter((v): v is string => typeof v === "string");
  for (const sd of spanDecls) {
    const sp = parseSpan(sd);
    if (!sp) { diagnostics.push({ severity: "error", message: `bad span \`${sd}\` (want \`rNcM:RxC\`)` }); continue; }
    const cell = model.rows[sp.row - 1]?.[sp.col - 1];
    if (!cell) { diagnostics.push({ severity: "warning", message: `span \`${sd}\` targets a cell outside the table` }); continue; }
    cell.span = { rows: sp.rows, cols: sp.cols };
  }

  return { model, diagnostics };
}

function ensureCell(row: TableCell[], ci: number): TableCell {
  while (row.length <= ci) row.push({ text: "", inlines: [] });
  return row[ci]!;
}
