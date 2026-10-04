// GEML reference parser — Milestone 3: tables (§6).
//
// A `table` block has two interchangeable body forms that parse to the SAME
// model: a visual pipe grid, or a data form (`format=csv`/`tsv`). The model
// carries column names, per-column alignment, body cells (inline-parsed), and
// columns produced by `compute` formulas (per-row arithmetic over columns, with
// sum/avg/min/max/count aggregates). See §6.

import { type DiagnosticCode } from "./diagnostics.js";
import { type Value, coerce } from "./attrs.js";
import { type Inline, type RefSink, parseInline } from "./inline.js";
import { TABLE_CELLS } from "./bounds.js";

export type Align = "left" | "right" | "center";

export interface TableCell {
  text: string;
  inlines: Inline[];
  align?: Align;
  value?: number;     // numeric value, when the cell is/becomes a number
  computed?: boolean; // produced by a `compute` formula
}

export interface TableModel {
  caption?: string;
  header: boolean;
  columns: string[];                 // header names (or letters A,B,… if none)
  align: (Align | undefined)[];
  rows: TableCell[][];               // body rows (header excluded)
  rowLines?: number[];               // 0-based body line each row was parsed from;
                                     // absent when the rows came from elsewhere
                                     // (`src=`, or borrowed through `src=#id`),
                                     // which is what makes them unwritable here
  summary?: TableCell[];             // single foot row from `summary=` (§6)
  src?: string;                      // external data source (§6); rows/columns are loaded at render time
}

export interface TableDiag { severity: "error" | "warning"; code: DiagnosticCode; message: string; }

export interface TableResult {
  model: TableModel;
  diagnostics: TableDiag[];
}

// ---------------------------------------------------------------------------
// Body-form parsing
// ---------------------------------------------------------------------------

const SEP_CELL = /^:?-+:?$/;

// What a body parser hands back: the grid, plus which body line each data row
// came from (`lines` is parallel to `cells`).
interface RawGrid {
  columns: string[];
  align: (Align | undefined)[];
  header: boolean;
  cells: string[][];
  lines: number[];
}

function alignOf(sep: string): Align | undefined {
  const l = sep.startsWith(":");
  const r = sep.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return undefined;
}

const WHITE = /^\p{White_Space}$/u;

/**
 * [start, end) of `s` without its leading and trailing whitespace — the Unicode
 * White_Space property, the one whitespace §4 and §6 name. Found by scanning:
 * an anchored `\p{White_Space}+$` restarts at every index of a long inner run,
 * which is quadratic. Every White_Space character is in the BMP, so one code
 * unit is one character here.
 */
export function whiteSpaceBounds(s: string): [number, number] {
  let a = 0;
  let b = s.length;
  while (a < b && WHITE.test(s[a]!)) a++;
  while (b > a && WHITE.test(s[b - 1]!)) b--;
  return [a, b];
}
export const trimWhiteSpace = (s: string): string => { const [a, b] = whiteSpaceBounds(s); return s.slice(a, b); };

// Split a visual table row `| a | b |` into trimmed cell strings. §6(a): a `|`
// right after a `\` is part of the cell, code spans included, and that
// backslash goes — GitHub's rule, so a GFM table's `\|` survives `--from md`.
// Every other `|` separates cells.
function splitPipes(line: string): string[] {
  let s = trimWhiteSpace(line);
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { cells.push(trimWhiteSpace(cur)); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(trimWhiteSpace(cur));
  return cells;
}

/** A cell's text written back into a visual row: its pipes escaped, §6(a). */
export const escapeCellPipes = (text: string): string => text.replace(/\|/g, "\\|");

function parseVisual(body: string[]): RawGrid {
  const kept: number[] = [];
  const rows: string[][] = [];
  body.forEach((l, i) => { if (l.trim() !== "") { kept.push(i); rows.push(splitPipes(l)); } });
  let sepIdx = -1;
  for (let r = 0; r < rows.length; r++) {
    if (rows[r]!.length > 0 && rows[r]!.every((c) => SEP_CELL.test(c))) { sepIdx = r; break; }
  }
  if (sepIdx >= 0) {
    const headerRow = sepIdx > 0 ? rows[sepIdx - 1]! : [];
    const align = rows[sepIdx]!.map(alignOf);
    const cells = rows.slice(sepIdx + 1);
    const columns = headerRow.length ? headerRow : letters(cells.length ? cells.reduce((m, r) => Math.max(m, r.length), 0) : align.length);
    return { columns, align, header: headerRow.length > 0, cells, lines: kept.slice(sepIdx + 1) };
  }
  // No separator: headerless, columns are letters.
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { columns: letters(width), align: [], header: false, cells: rows, lines: kept };
}

function parseDelimited(body: string[], sep: string, header: boolean): RawGrid {
  const kept: number[] = [];
  const rows: string[][] = [];
  body.forEach((l, i) => { if (l.trim() !== "") { kept.push(i); rows.push(l.split(sep).map(trimWhiteSpace)); } });
  if (header && rows.length) {
    return { columns: rows[0]!, align: [], header: true, cells: rows.slice(1), lines: kept.slice(1) };
  }
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { columns: letters(width), align: [], header: false, cells: rows, lines: kept };
}

// The character a data body splits on: the format's natural delimiter unless
// `delim=` names another single one — `;` for a European CSV, `|` for a
// pipe-delimited export (§6). Measured in code points, so an astral character
// counts as one. §4 attribute values carry no escape syntax, so a tab
// delimiter is spelled `format=tsv`, never `delim="\t"`; a value that is not
// exactly one character is an error and the natural delimiter is used, which
// keeps the rest of the table readable.
function resolveDelim(fmt: string, raw: Value | undefined, diagnostics: TableDiag[]): string {
  const natural = fmt === "tsv" ? "\t" : ",";
  if (raw === undefined) return natural;
  const d = String(raw);
  if ([...d].length === 1) return d;
  diagnostics.push({
    severity: "error",
    code: "bad-table-delimiter",
    message: `\`delim="${d}"\` must be exactly one character (for a tab use \`format=tsv\`); split on ${fmt === "tsv" ? "a tab" : "`,`"} instead`,
  });
  return natural;
}

// §5.2: spreadsheet column letters — A…Z, AA…ZZ, AAA… (bijective base 26).
function letters(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    for (let k = i; k >= 0; k = Math.floor(k / 26) - 1) s = String.fromCharCode(65 + (k % 26)) + s;
    out.push(s);
  }
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
    // quoted column name: 'Unit Price' (single quotes — the GEML attribute
    // value is already double-quoted and has no escape syntax, §4).
    if (c === "'") {
      let j = i + 1; while (j < s.length && s[j] !== "'") j++;
      out.push({ t: "name", v: s.slice(i + 1, j) }); i = j + 1; continue;
    }
    // identifier: column name or function — run of non-operator chars
    let j = i;
    while (j < s.length && !/[\s+\-*/(),]/.test(s[j]!)) j++;
    out.push({ t: "name", v: s.slice(i, j) }); i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display format: a `[printf]` spec bound to a column/cell name (§6).
//   `FY [%.1f]` → name "FY", fmt "%.1f";  `YoY [%.1f%%]` → "%.1f%%"
// ---------------------------------------------------------------------------

// The bracket suffix has to contain a `%` to be a format (§6). Without that
// test, a column whose own name is bracketed — `[Data] = …` — parses as an
// empty name plus the format `Data`, and the formula silently targets nothing.
function splitName(lhs: string): { name: string; fmt?: string } {
  // Scanned, not matched: the lazy `^(.*?)\s*\[…\]\s*$` this replaces
  // backtracked quadratically, and an attribute value is author input of any
  // length — 128 KB of `%` in a `compute=` name held the parser for 23 seconds.
  // The shape is "the last `[…]` group, at the end, containing a `%`": found by
  // the last `[`, checked once.
  const t = lhs.trim();
  let name = t;
  let fmt: string | undefined;
  if (t.endsWith("]")) {
    const open = t.lastIndexOf("[");
    if (open >= 0) {
      const inner = t.slice(open + 1, -1);
      if (inner.includes("%") && !inner.includes("]")) { fmt = inner; name = t.slice(0, open).trimEnd(); }
    }
  }
  name = name.trim();
  if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  return fmt !== undefined ? { name, fmt } : { name };
}

// A result IEEE-754 produces but a table cannot hold (§6): `x / 0` is ±∞, `0 / 0`
// is NaN. The cell keeps no value and displays `-`, which is what a reader sees;
// naming the cause is the difference between "this row had no data" and "this
// row divided by zero", so it is said out loud like a substituted cell is.
const nanMsg = (where: string, v: number): string =>
  `${where}: ${Number.isNaN(v) ? "result is not a number (0/0)" : "division by zero"}; the cell holds no value and shows \`-\``;

// Default rendering for an unformatted computed number: drop IEEE-754 display
// noise (0.1+0.2 → "0.3", sum of 1-dp inputs → "263.6") without altering the
// stored numeric value.
function defaultNum(v: number): string {
  if (!isFinite(v)) return "-";
  return String(parseFloat(v.toPrecision(12)));
}

// The §6 display format, for a single numeric value: `%.Nf`, `%.Ne`, `%d`,
// `%.Ng`, and `%%` for a literal percent. Nothing else is a conversion, so any
// other `%…` — an upper-case letter, a left-out precision — stays text. Width
// and flags are not part of a format and are ignored.
//
// Rounding is to nearest with ties away from zero on the value's exact binary
// expansion, in every conversion — toFixed and toExponential already round that
// way (they pick the larger magnitude on a tie), so `%d` is the one that needs
// it spelled out: Math.round sends -2.5 to -2, while `%.0f` gives -3.
function applyFormat(fmt: string, v: number): string {
  if (!isFinite(v)) return "-";
  return fmt.replace(/%%|%[-+ 0#]*\d*(?:\.(\d+)([feg])|d)/g, (m, digits: string | undefined, type: string | undefined) => {
    if (m === "%%") return "%";
    if (type === undefined) return String(Math.sign(v) * Math.round(Math.abs(v)) || 0); // %d
    // toFixed and toExponential take at most 100 digits and throw past it.
    const prec = Math.min(parseInt(digits!, 10), 100);
    if (type === "e") return exponent(v.toExponential(prec));
    if (type === "g") return significant(v, prec);
    return v.toFixed(prec);
  });
}

// printf writes at least two exponent digits: `3.333e-01`, not `3.333e-1`.
const exponent = (s: string): string => s.replace(/e([+-])(\d)$/, "e$10$2");

// `%.Ng`: N significant digits (0 counts as 1), in fixed notation unless the
// exponent is below -4 or at least N, trailing zeros and a bare point removed.
function significant(v: number, prec: number): string {
  const p = Math.max(prec, 1);
  const e = v.toExponential(p - 1);
  const x = Number(e.slice(e.indexOf("e") + 1));
  const strip = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (x < -4 || x >= p) {
    const at = e.indexOf("e");
    return exponent(strip(e.slice(0, at)) + e.slice(at));
  }
  return strip(v.toFixed(Math.min(p - 1 - x, 100)));
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
// Public entry
// ---------------------------------------------------------------------------

// §6, §9.2: a table or view holds at most TABLE_CELLS cells — its columns
// times its body rows, padded cells included — and one that would hold more
// keeps no rows. Fixed, because what it refuses is in the model: a header of a few
// thousand columns over a few thousand one-cell rows is a few kilobytes of
// input and, padded, a few hundred megabytes of cells.

function tooLarge(columns: number, rows: number): TableDiag | null {
  return columns * rows > TABLE_CELLS
    ? { severity: "error", code: "table-too-large", message: `${columns} columns × ${rows} rows is more than ${TABLE_CELLS} cells; no rows are kept` }
    : null;
}

export function parseTable(
  body: string[],
  attrs: Record<string, Value>,
  line: number,
  sink: RefSink,
): TableResult {
  const diagnostics: TableDiag[] = [];
  const fmt = typeof attrs["format"] === "string" ? (attrs["format"] as string) : undefined;

  // Data from elsewhere (§6): the caller has normalised `src=`/`data=` into `src`.
  // A local or cross-document target is resolved after the scan (resolveTableSources
  // in geml.ts calls back into this function with the resolved lines, so format,
  // header, compute and summary behave identically); only an `http(s)` URL is still
  // a render-time fetch. Either way the inline body must be empty.
  const src = typeof attrs["src"] === "string" ? (attrs["src"] as string) : undefined;
  if (src !== undefined) {
    if (body.some((l) => l.trim() !== "")) {
      diagnostics.push({ severity: "error", code: "table-src-and-body", message: "table has both `src` and an inline body; provide one, not both" });
    }
    const headerAttr = attrs["header"];
    // §6: a boolean; `false`/`0` reads none, anything else is the default.
    const header = !(headerAttr === false || headerAttr === 0 || headerAttr === "0" || headerAttr === "false");
    const model: TableModel = { header, columns: [], align: [], rows: [], src };
    const caption = attrs["caption"];
    if (typeof caption === "string") model.caption = caption;
    return { model, diagnostics };
  }

  let raw: RawGrid;
  if (fmt === "csv" || fmt === "tsv") {
    const headerAttr = attrs["header"];
    // §6: a boolean; `false`/`0` reads none, anything else is the default.
    const header = !(headerAttr === false || headerAttr === 0 || headerAttr === "0" || headerAttr === "false");
    raw = parseDelimited(body, resolveDelim(fmt, attrs["delim"], diagnostics), header);
  } else {
    if (fmt !== undefined) diagnostics.push({ severity: "warning", code: "unknown-table-format", message: `unknown table format \`${fmt}\`; parsed as visual grid` });
    // `delim` refines the data form; it does not select it. Silently dropping it
    // would leave a `=== table {delim=";"}` parsed as a one-column visual grid
    // with nothing to say why.
    if (attrs["delim"] !== undefined) diagnostics.push({ severity: "warning", code: "ignored-table-delimiter", message: "`delim` applies to a data body (`format=csv`/`tsv`); this body was parsed as a visual grid, so it is ignored" });
    raw = parseVisual(body);
  }

  const columns = [...raw.columns];
  const model: TableModel = { header: raw.header, columns, align: raw.align, rows: [], rowLines: raw.lines };
  const caption = attrs["caption"];
  if (typeof caption === "string") model.caption = caption;
  // Judged before a cell is built or a row is said to be ragged: the rows are not kept.
  const huge = tooLarge(columns.length, raw.cells.length);
  if (huge !== null) {
    diagnostics.push(huge);
    model.rowLines = [];
    return { model, diagnostics };
  }

  // Build body cells with inline content and numeric values.
  for (const [ri, r] of raw.cells.entries()) {
    // §6: a row is cut or padded to the column count — the header's, or a
    // header-less table's widest row — and never silently.
    if (r.length !== columns.length) {
      const n = Math.abs(r.length - columns.length);
      const which = n === 1 ? "cell is" : `${n} cells are`;
      const fix = r.length > columns.length ? `the extra ${which} dropped` : `the missing ${which} empty`;
      diagnostics.push({ severity: "warning", code: "ragged-table-row", message: `table body row ${ri + 1} has ${r.length} cell${r.length === 1 ? "" : "s"} for ${columns.length} column${columns.length === 1 ? "" : "s"}; ${fix}` });
    }
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

  return { model, diagnostics };
}

// A column a §6 expression refers to: by header name, else by spreadsheet
// letter (`A` the first, `AA` the 27th). Only an expression's references read
// letters; a column list, `where=` and an entry's left side take names (§6.1).
function columnRef(columns: string[], name: string): number {
  const byName = columns.indexOf(name);
  if (byName >= 0) return byName;
  if (!/^[A-Z]+$/.test(name)) return -1;
  let n = 0;
  for (const c of name) {
    n = n * 26 + c.charCodeAt(0) - 64;
    if (n > columns.length) return -1;
  }
  return n - 1;
}

// The derivation stage (§6): the `compute=` columns and the `summary=` foot
// row, applied to a grid that is already built. It lives apart from body
// parsing because a table that borrows its rows through `src=#id` has no body
// to parse and must still apply ITS OWN formulas — resolveTableSources calls
// this directly, with the borrowed rows in hand.
export function applyDerivations(
  model: TableModel,
  attrs: Record<string, Value>,
  line: number,
  sink: RefSink,
  diagnostics: TableDiag[],
): void {
  const columns = model.columns;
  const colIndex = (name: string): number => columnRef(columns, name);
  const cellNum = (ci: number, row: number): number | null => {
    const v = model.rows[row]?.[ci]?.value;
    return typeof v === "number" ? v : null;
  };
  // A cell a formula reads but cannot read as a number (`x`, `N/A`, `TBD`, an
  // empty cell) counts as 0, so one dirty row does not void the whole column.
  // But counting it silently is how a table quietly reports the wrong total, so
  // say which cell was substituted. One warning per cell, not per mention: a
  // formula naming the same column twice describes one substitution.
  const substituted = new Set<string>();
  const colResolve: ColResolve = (name, row) => {
    const ci = colIndex(name);
    if (ci < 0) return null;
    const n = cellNum(ci, row);
    if (n !== null) return n;
    const key = `${ci}\0${row}`;
    if (!substituted.has(key)) {
      substituted.add(key);
      const text = model.rows[row]?.[ci]?.text ?? "";
      diagnostics.push({
        severity: "warning",
        code: "compute-non-numeric-cell",
        message: `column \`${name}\` row ${row + 1} is not a number (${text === "" ? "empty" : `\`${text}\``}); counted as 0`,
      });
    }
    return 0;
  };
  const computeAgg = (fn: string, ci: number): number | null => {
    if (fn === "count") {
      let c = 0;
      for (let r = 0; r < model.rows.length; r++) {
        const text = model.rows[r]?.[ci]?.text;
        if (text !== undefined && text !== "") c++;
      }
      return c;
    }
    const vals: number[] = [];
    for (let r = 0; r < model.rows.length; r++) { const v = cellNum(ci, r); if (v !== null) vals.push(v); }
    if (vals.length === 0) return 0;
    if (fn === "sum") return vals.reduce((a, b) => a + b, 0);
    if (fn === "avg") return vals.reduce((a, b) => a + b, 0) / vals.length;
    // Folded, not spread: spread passes one argument per row, and past ~130k
    // rows that is a stack overflow reported as the aggregate's error.
    if (fn === "min") return vals.reduce((a, b) => Math.min(a, b), Infinity);
    if (fn === "max") return vals.reduce((a, b) => Math.max(a, b), -Infinity);
    return null;
  };
  // A given aggregate over a given column is constant across rows, yet the
  // per-row `evalExpr` below used to recompute it with a full-table scan every
  // time — O(R²·M) for a table with R rows and M aggregate uses, so a 5000-row
  // ×100-`sum()` sheet took ~a minute. Memoize each `(fn, column)` result once
  // per formula (`aggReset` clears it). The ONE column whose values genuinely
  // change mid-loop is the column the current formula is writing (`aggBypassCi`)
  // — an aggregate over it is row-dependent, so that one is never cached, which
  // preserves the exact behaviour of in-place / self-referential formulas.
  let aggCache = new Map<string, number | null>();
  let aggBypassCi = -1;
  const aggReset = (bypassCi: number): void => { aggCache = new Map(); aggBypassCi = bypassCi; };
  const aggResolve = (fn: string, name: string): number | null => {
    const ci = colIndex(name);
    if (ci < 0) return null;
    if (ci === aggBypassCi) return computeAgg(fn, ci);
    const key = `${fn}:${ci}`;
    if (aggCache.has(key)) return aggCache.get(key)!;
    const val = computeAgg(fn, ci);
    aggCache.set(key, val);
    return val;
  };

  // `compute="Name = expr; Name2 = expr2"` — `;`-separated; may also appear as
  // compute, compute2, … Each formula adds/overwrites a per-row column.
  const formulas = Object.entries(attrs)
    .filter(([k]) => k === "compute" || /^compute\d+$/.test(k))
    .map(([, v]) => v)
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(";"))
    .map((f) => f.trim())
    .filter((f) => f !== "");

  for (const f of formulas) {
    const eq = f.indexOf("=");
    if (eq <= 0) { diagnostics.push({ severity: "error", code: "bad-compute-formula", message: `bad compute formula \`${f}\` (want \`Name = expr\`)` }); continue; }
    const { name, fmt } = splitName(f.slice(0, eq));
    const expr = f.slice(eq + 1).trim();
    let toks: Tok[];
    toks = lexExpr(expr);

    // Target is a header name (never a letter reference): match by name only.
    let ci = columns.indexOf(name);
    if (ci < 0) { columns.push(name); ci = columns.length - 1; }

    // Fresh aggregate cache per formula; the target column is being written
    // row-by-row so aggregates over it stay uncached.
    aggReset(ci);
    let failed = false;
    for (let r = 0; r < model.rows.length && !failed; r++) {
      try {
        const v = evalExpr(toks, r, colResolve, aggResolve);
        const cell = ensureCell(model.rows[r]!, ci);
        const text = fmt ? applyFormat(fmt, v) : defaultNum(v);
        cell.text = text; cell.computed = true;
        cell.inlines = [{ type: "text", value: text }];
        if (Number.isFinite(v)) cell.value = v;
        else diagnostics.push({ severity: "warning", code: "compute-not-a-number", message: nanMsg(`compute \`${name}\` row ${r + 1}`, v) });
      } catch (e) {
        diagnostics.push({ severity: "error", code: "compute-error", message: `compute \`${name}\`: ${(e as Error).message}` });
        failed = true;
      }
    }
    // A formula in error still adds its column, every cell of it empty (§6.1).
    if (failed) for (const row of model.rows) { ensureCell(row, ci); row[ci] = { text: "", inlines: [] }; }
  }

  // `summary="Cell = value; …"` — one foot row. Each value is a string/number
  // literal (a label) or arithmetic over aggregates (the only cross-row op).
  const summaryDecls = Object.entries(attrs)
    .filter(([k]) => k === "summary" || /^summary\d+$/.test(k))
    .map(([, v]) => v)
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(";"))
    .map((s) => s.trim())
    .filter((s) => s !== "");

  if (summaryDecls.length > 0) {
    const summary: TableCell[] = columns.map(() => ({ text: "", inlines: [] }));
    // In the summary row a bare column has no value: only aggregates resolve.
    const noRow: ColResolve = () => null;
    // No column is mutated while building the summary row, so every aggregate is
    // cacheable against the final table state (no bypass column).
    aggReset(-1);
    for (const s of summaryDecls) {
      const eq = s.indexOf("=");
      if (eq <= 0) { diagnostics.push({ severity: "error", code: "bad-summary-entry", message: `bad summary \`${s}\` (want \`Cell = value\`)` }); continue; }
      const { name, fmt } = splitName(s.slice(0, eq));
      const rhs = s.slice(eq + 1).trim();
      const ci = colIndex(name);

      // String label: `Cell = 'Total'`.
      if (rhs.startsWith("'") && rhs.endsWith("'") && rhs.length >= 2) {
        const text = rhs.slice(1, -1);
        summary[ci] = { text, inlines: [{ type: "text", value: text }] };
        continue;
      }
      // Otherwise an aggregate expression.
      let toks: Tok[];
      toks = lexExpr(rhs);
      try {
        const v = evalExpr(toks, 0, noRow, aggResolve);
        const text = fmt ? applyFormat(fmt, v) : defaultNum(v);
        summary[ci] = { text, inlines: [{ type: "text", value: text }], computed: true };
        if (Number.isFinite(v)) summary[ci].value = v;
        else diagnostics.push({ severity: "warning", code: "compute-not-a-number", message: nanMsg(`summary \`${name}\``, v) });
      } catch (e) {
        const msg = /unknown column `(.+)`/.exec((e as Error).message);
        const hint = msg ? `summary \`${name}\`: column \`${msg[1]}\` must be reduced by an aggregate (e.g. sum(${msg[1]}))` : `summary \`${name}\`: ${(e as Error).message}`;
        diagnostics.push({ severity: "error", code: "summary-error", message: hint });
      }
    }
    model.summary = summary;
  }


}

// ---------------------------------------------------------------------------
// `view` evaluation (GEP-0012)
// ---------------------------------------------------------------------------

// `table` is deliberately only a relation of facts.  A view reuses its model
// (and, therefore, the renderer) but owns every operation which can change the
// relation it publishes.  Keeping this here with the formula evaluator avoids
// two slightly different meanings for `sum(FY)`.

const declarations = (attrs: Record<string, Value>, stem: "compute" | "summary" | "aggregate"): string[] =>
  Object.entries(attrs)
    .filter(([k]) => k === stem || new RegExp(`^${stem}\\d+$`).test(k))
    .map(([, v]) => v)
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(";"))
    .map((v) => v.trim())
    .filter((v) => v !== "");

const formulaName = (formula: string): string | null => {
  const at = formula.indexOf("=");
  return at > 0 ? splitName(formula.slice(0, at)).name : null;
};

const AGG_FNS = new Set(["sum", "avg", "min", "max", "count"]);

const hasAggregate = (formula: string): boolean => /\b(?:sum|avg|min|max|count)\s*\(/i.test(formula);

function computedAttrs(formulas: string[]): Record<string, Value> {
  const out: Record<string, Value> = {};
  formulas.forEach((formula, i) => { out[i === 0 ? "compute" : `compute${i + 1}`] = formula; });
  return out;
}

interface FilterToken { t: "word" | "quote" | "num" | "cmp" | "lp" | "rp"; v: string; }

function lexFilter(source: string): FilterToken[] {
  const out: FilterToken[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(") { out.push({ t: "lp", v: c }); i++; continue; }
    if (c === ")") { out.push({ t: "rp", v: c }); i++; continue; }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) throw new Error("unclosed single-quoted string");
      out.push({ t: "quote", v: source.slice(i + 1, end) }); i = end + 1; continue;
    }
    const cmp = /^(?:!=|<=|>=|=|<|>)/.exec(source.slice(i));
    if (cmp) { out.push({ t: "cmp", v: cmp[0] }); i += cmp[0].length; continue; }
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(i));
    if (num) { out.push({ t: "num", v: num[0] }); i += num[0].length; continue; }
    let end = i;
    while (end < source.length && !/[\s()=!<>]/.test(source[end]!)) end++;
    if (end === i) throw new Error(`unexpected token \`${c}\``);
    out.push({ t: "word", v: source.slice(i, end) }); i = end;
  }
  return out;
}

type Predicate = (row: TableCell[]) => boolean;

function filterPredicate(model: TableModel, source: string, diagnostics: TableDiag[]): Predicate | null {
  let tokens: FilterToken[];
  try { tokens = lexFilter(source); } catch (e) {
    diagnostics.push({ severity: "error", code: "view-where-error", message: `where: ${(e as Error).message}` });
    return null;
  }
  let p = 0;
  const peek = (): FilterToken | undefined => tokens[p];
  const next = (): FilterToken => tokens[p++]!;
  const column = (token: FilterToken): number => {
    if (token.t !== "word" && token.t !== "quote") throw new Error("a comparison starts with a column name");
    const ci = model.columns.indexOf(token.v);
    if (ci < 0) throw new Error(`unknown column \`${token.v}\``);
    return ci;
  };
  const compare = (left: TableCell | undefined, op: string, right: FilterToken): boolean => {
    if (right.t === "num") {
      const n = Number(right.v);
      const v = left?.value;
      if (typeof v !== "number") return false; // dirty cells simply do not match
      return op === "=" ? v === n : op === "!=" ? v !== n : op === "<" ? v < n : op === "<=" ? v <= n : op === ">" ? v > n : v >= n;
    }
    // `right` is a quote here: parsePrimary refused anything else at parse time. This
    // check used to live HERE, inside the comparator — which runs in rows.filter, outside
    // the try — so `where="Status = open"` threw out of parse() instead of diagnosing.
    const v = left?.text ?? "";
    return op === "=" ? v === right.v : op === "!=" ? v !== right.v : op === "<" ? v < right.v : op === "<=" ? v <= right.v : op === ">" ? v > right.v : v >= right.v;
  };
  const numericalColumns = new Set<number>();
  const parsePrimary = (): Predicate => {
    if (peek()?.t === "lp") {
      next(); const inner = parseOr();
      if (peek()?.t !== "rp") throw new Error("missing )");
      next(); return inner;
    }
    const ci = column(next());
    const op = next();
    if (op.t !== "cmp") throw new Error("a column must be followed by a comparison");
    const rhs = next();
    if (rhs === undefined) throw new Error("comparison has no right-hand value");
    if (rhs.t !== "num" && rhs.t !== "quote") throw new Error("the right of a comparison is a number or single-quoted string");
    if (rhs.t === "num") numericalColumns.add(ci);
    return (row) => compare(row[ci], op.v, rhs);
  };
  const parseNot = (): Predicate => {
    if (peek()?.t === "word" && peek()?.v.toLowerCase() === "not") { next(); const f = parseNot(); return (row) => !f(row); }
    return parsePrimary();
  };
  const parseAnd = (): Predicate => {
    let f = parseNot();
    while (peek()?.t === "word" && peek()?.v.toLowerCase() === "and") { next(); const left = f, right = parseNot(); f = (row) => left(row) && right(row); }
    return f;
  };
  const parseOr = (): Predicate => {
    let f = parseAnd();
    while (peek()?.t === "word" && peek()?.v.toLowerCase() === "or") { next(); const left = f, right = parseAnd(); f = (row) => left(row) || right(row); }
    return f;
  };
  try {
    const predicate = parseOr();
    if (p !== tokens.length) throw new Error(`unexpected token \`${tokens[p]!.v}\``);
    for (const ci of numericalColumns) {
      if (!model.rows.some((row) => typeof row[ci]?.value === "number")) {
        diagnostics.push({ severity: "error", code: "view-numeric-column-required", message: `where: column \`${model.columns[ci]}\` has no numeric value to compare against a number` });
      }
    }
    return predicate;
  } catch (e) {
    diagnostics.push({ severity: "error", code: "view-where-error", message: `where: ${(e as Error).message}` });
    return null;
  }
}

function aggregateValue(model: TableModel, rows: TableCell[][], fn: string, name: string): number | null {
  const ci = columnRef(model.columns, name);
  if (ci < 0) return null;
  if (fn === "count") return rows.reduce((n, row) => n + (row[ci]?.text !== "" && row[ci] !== undefined ? 1 : 0), 0);
  const values = rows.map((row) => row[ci]?.value).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return 0;
  if (fn === "sum") return values.reduce((a, b) => a + b, 0);
  if (fn === "avg") return values.reduce((a, b) => a + b, 0) / values.length;
  if (fn === "min") return values.reduce((a, b) => Math.min(a, b), Infinity);
  if (fn === "max") return values.reduce((a, b) => Math.max(a, b), -Infinity);
  return null;
}

function groupView(model: TableModel, by: string[], aggregate: string[], diagnostics: TableDiag[]): void {
  const keyIndexes = by.map((name) => model.columns.indexOf(name));
  if (keyIndexes.some((i) => i < 0)) {
    for (let i = 0; i < keyIndexes.length; i++) if (keyIndexes[i]! < 0) diagnostics.push({ severity: "error", code: "view-unknown-column", message: `by: unknown column \`${by[i]}\`` });
    return;
  }
  // A formula in error still adds its column, every cell of it empty (§6.1).
  const specs: { name: string; fmt?: string; toks: Tok[]; broken: boolean }[] = [];
  for (const declaration of aggregate) {
    const eq = declaration.indexOf("=");
    if (eq <= 0) { diagnostics.push({ severity: "error", code: "bad-aggregate-entry", message: `bad aggregate \`${declaration}\` (want \`Name = sum(Column)\`)` }); continue; }
    const target = splitName(declaration.slice(0, eq));
    const toks = lexExpr(declaration.slice(eq + 1).trim());
    // Read once with every reference standing for 0: what fails now is the
    // formula's grammar, one mistake, not an evaluation failing per group.
    let broken = false;
    try { evalExpr(toks, 0, () => 0, () => 0); } catch (e) {
      diagnostics.push({ severity: "error", code: "bad-aggregate-entry", message: `aggregate \`${target.name}\`: ${(e as Error).message}` });
      broken = true;
    }
    specs.push({ ...target, toks, broken });
  }
  // An aggregate over a column that is not there is ONE mistake, so it is one
  // error, reported before the fold. Left to `aggregateValue`'s null it became
  // an `aggregate-error` per GROUP — three rows, three identical messages, none
  // of which named the column — and every group grew an empty cell.
  // Likewise a column a group has no value for: one read without an aggregate
  // is one mistake, not an `aggregate-error` per group.
  for (const spec of specs) {
    if (spec.broken) continue;
    const refs: string[] = [];
    const bare: string[] = [];
    const toks = spec.toks;
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i]!;
      if (tok.t !== "name") continue;
      if (toks[i + 1]?.t === "lp" && AGG_FNS.has(tok.v.toLowerCase())) {
        const arg = toks[i + 2];
        if (arg?.t === "name") { refs.push(arg.v); i += 2; }
        continue;
      }
      refs.push(tok.v);
      bare.push(tok.v);
    }
    const unknown = refs.find((name) => columnRef(model.columns, name) < 0);
    if (unknown !== undefined) diagnostics.push({ severity: "error", code: "view-unknown-column", message: `aggregate: unknown column \`${unknown}\`` });
    else if (bare.length > 0) diagnostics.push({ severity: "error", code: "aggregate-error", message: `aggregate \`${spec.name}\` reads \`${bare[0]}\` without an aggregate` });
    spec.broken = unknown !== undefined || bare.length > 0;
  }

  const groups = new Map<string, TableCell[][]>();
  for (const row of model.rows) {
    const key = JSON.stringify(keyIndexes.map((ci) => row[ci]?.text ?? ""));
    const rows = groups.get(key);
    if (rows) rows.push(row); else groups.set(key, [row]);
  }
  const sourceColumns = [...model.columns];
  const outputRows: TableCell[][] = [];
  for (const rows of groups.values()) {
    const first = rows[0]!;
    const out = keyIndexes.map((ci) => ({ ...first[ci]!, inlines: [...first[ci]!.inlines] }));
    for (const spec of specs) {
      if (spec.broken) { out.push({ text: "", inlines: [] }); continue; }
      try {
        const value = evalExpr(spec.toks, 0, () => null, (fn, name) => aggregateValue({ ...model, columns: sourceColumns }, rows, fn, name));
        const text = spec.fmt ? applyFormat(spec.fmt, value) : defaultNum(value);
        out.push({ text, inlines: [{ type: "text", value: text }], computed: true, ...(Number.isFinite(value) ? { value } : {}) });
      } catch (e) {
        diagnostics.push({ severity: "error", code: "aggregate-error", message: `aggregate \`${spec.name}\`: ${(e as Error).message}` });
        out.push({ text: "", inlines: [] });
      }
    }
    outputRows.push(out);
  }
  model.columns = [...by, ...specs.map((s) => s.name)];
  model.align = model.columns.map((_, i) => i < keyIndexes.length ? model.align[keyIndexes[i]!] : undefined);
  model.rows = outputRows;
  delete model.rowLines;
}

// §6.1 column lists (`select=`, `by=`, `order=`): entries split on `,`, except
// inside a quote that OPENS an entry — so `'Unit, Price'` is one name while the
// apostrophe in `O'Brien` opens nothing. An unclosed quote runs to the end.
function columnList(source: string): string[] {
  const out: string[] = [];
  let cur = "";
  let blank = true; // `cur` is whitespace so far: a quote here opens the entry
  let quoted = false;
  for (const c of source) {
    if (quoted) { cur += c; if (c === "'") quoted = false; continue; }
    if (c === ",") { out.push(cur); cur = ""; blank = true; continue; }
    if (c === "'" && blank) quoted = true;
    if (!/\s/.test(c)) blank = false;
    cur += c;
  }
  out.push(cur);
  return out.map((e) => e.trim()).filter(Boolean);
}

// An entry quoted whole names the column between its quotes; any other entry
// names the column its text spells, spaces and quotes included.
function columnName(entry: string): { name: string; quoted: boolean } {
  return entry.length >= 2 && entry.startsWith("'") && entry.indexOf("'", 1) === entry.length - 1
    ? { name: entry.slice(1, -1), quoted: true }
    : { name: entry, quoted: false };
}

function orderView(model: TableModel, source: string, diagnostics: TableDiag[]): void {
  const keys: { ci: number; desc: boolean }[] = [];
  for (const part of columnList(source)) {
    // Scanned, not matched: `(.+?)(?:\s+(asc|desc))?$` backtracked quadratically
    // over the key, and 128 KB of spaces in an `order=` held the parser for
    // eight seconds. The direction is a suffix, read first and without a regex
    // (an unanchored `\s+…$` search is quadratic in its own right); the key is
    // whatever remains, unquoted when it was quoted whole.
    const p = part.trim();
    let dirWord: "asc" | "desc" | undefined;
    let head = p;
    for (const w of ["desc", "asc"] as const) {
      if (p.toLowerCase().endsWith(w)) {
        const cut = p.length - w.length;
        if (cut > 0 && /\s/.test(p[cut - 1]!)) { dirWord = w; head = p.slice(0, cut).trimEnd(); }
        break;
      }
    }
    const { name } = columnName(head);
    if (name === "") { diagnostics.push({ severity: "error", code: "view-order-error", message: `order: bad key \`${part}\`` }); continue; }
    const ci = model.columns.indexOf(name);
    if (ci < 0) { diagnostics.push({ severity: "error", code: "view-unknown-column", message: `order: unknown column \`${name}\`` }); continue; }
    keys.push({ ci, desc: dirWord === "desc" });
  }
  // Each key's KIND is decided once, over the whole column, for two reasons.
  //
  // A comparator that chose per pair was not a total order: with `10`, `2` and
  // `1a` in one column, `10 > 2` numerically, `2 > "1a"` textually and
  // `"10" < "1a"` textually — a cycle, which leaves the result up to whichever
  // comparisons the sort implementation happens to make. And the text branch
  // used `localeCompare`, whose answer depends on the host's ICU and default
  // locale: the same document ordered `Ápple, Apple, banana` here and could
  // order it otherwise elsewhere. A format whose premise is that two processors
  // agree cannot have a row order that depends on the machine, so text compares
  // by UTF-16 code unit, which is the same everywhere.
  const numericKey = keys.map((key) =>
    model.rows.length > 0 && model.rows.every((row) => typeof row[key.ci]?.value === "number"));
  const indexed = model.rows.map((row, i) => ({ row, i }));
  indexed.sort((a, b) => {
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k]!;
      const av = a.row[key.ci], bv = b.row[key.ci];
      let c: number;
      if (numericKey[k]) c = (av?.value as number) - (bv?.value as number);
      else {
        const at = av?.text ?? "", bt = bv?.text ?? "";
        c = at < bt ? -1 : at > bt ? 1 : 0;
      }
      if (c !== 0) return key.desc ? -c : c;
    }
    return a.i - b.i;
  });
  model.rows = indexed.map((v) => v.row);
}

function selectView(model: TableModel, source: string, diagnostics: TableDiag[]): void {
  // Each entry stands alone (§6.1): one in error contributes nothing, and a
  // `select=` with no valid entry leaves the view no columns.
  const indexes: number[] = [];
  for (const entry of columnList(source)) {
    const { name, quoted } = columnName(entry);
    if (!quoted && name.includes("=")) { diagnostics.push({ severity: "error", code: "view-select-expression", message: `select: \`${name}\` is an expression; derive columns with \`compute=\`` }); continue; }
    const ci = model.columns.indexOf(name);
    if (ci < 0) { diagnostics.push({ severity: "error", code: "view-unknown-column", message: `select: unknown column \`${name}\`` }); continue; }
    indexes.push(ci);
  }
  model.columns = indexes.map((i) => model.columns[i]!);
  model.align = indexes.map((i) => model.align[i]);
  model.rows = model.rows.map((row) => indexes.map((i) => row[i] ?? { text: "", inlines: [] }));
}

/** Apply GEP-0012's fixed evaluation order to a view's copied source relation. */
export function deriveView(
  model: TableModel,
  attrs: Record<string, Value>,
  line: number,
  sink: RefSink,
  diagnostics: TableDiag[],
): void {
  const originalColumns = new Set(model.columns);
  const formulas = declarations(attrs, "compute");
  const rowFormulas = formulas.filter((formula) => !hasAggregate(formula));
  const aggregateFormulas = formulas.filter(hasAggregate);
  const byRaw = attrs["by"];
  const by = typeof byRaw === "string" ? columnList(byRaw).map((e) => columnName(e).name) : [];

  for (const formula of formulas) {
    const name = formulaName(formula);
    if (name !== null && originalColumns.has(name)) diagnostics.push({ severity: "warning", code: "shadowed-source-column", message: `compute \`${name}\` shadows a column its source publishes` });
  }
  if (by.length > 0 && aggregateFormulas.length > 0) {
    for (const formula of aggregateFormulas) diagnostics.push({ severity: "error", code: "grouping-compute-aggregate", message: `compute \`${formulaName(formula) ?? formula}\` aggregates on a grouping view; use \`aggregate=\`` });
  }
  if (rowFormulas.length) applyDerivations(model, computedAttrs(rowFormulas), line, sink, diagnostics);
  // A source is within the bound; its computed columns can take a view past it.
  const huge = tooLarge(model.columns.length, model.rows.length);
  if (huge !== null) {
    diagnostics.push(huge);
    model.rows = [];
    return;
  }

  const where = attrs["where"];
  if (typeof where === "string" && where.trim() !== "") {
    const aggregateNames = new Set(aggregateFormulas.map(formulaName).filter((v): v is string => v !== null));
    // Which aggregate-derived columns does the filter NAME? Asked of the lexed
    // tokens, not of the raw string: a regex over the text called
    // `where="Name = 'Share'"` circular whenever some aggregate column happened
    // to be called `Share` — a legal document refused because a quoted VALUE
    // matched an identifier. Only a `word` token is a column reference.
    const named = aggregateNames.size === 0 ? [] : (() => {
      let words: string[];
      try { words = lexFilter(where).filter((t) => t.t === "word").map((t) => t.v); }
      catch { return []; } // unlexable: `filterPredicate` reports it properly below
      return [...aggregateNames].filter((name) => words.includes(name));
    })();
    if (named.length > 0) {
      // Reported INSTEAD of building the predicate. Both at once produced two
      // errors for one mistake, the first of them `unknown column \`Share\``,
      // which blames the reference — the thing GEP-0012 says this diagnostic
      // exists not to do: it names the formula that made the filter circular.
      for (const name of named) {
        diagnostics.push({ severity: "error", code: "circular-view-filter", message: `where names aggregate-derived column \`${name}\`; that value depends on which rows the filter keeps` });
      }
    } else {
      const predicate = filterPredicate(model, where, diagnostics);
      if (predicate) model.rows = model.rows.filter(predicate);
    }
  }

  if (by.length === 0 && aggregateFormulas.length) applyDerivations(model, computedAttrs(aggregateFormulas), line, sink, diagnostics);
  const aggregate = declarations(attrs, "aggregate");
  if (by.length > 0) groupView(model, by, aggregate, diagnostics);
  else if (aggregate.length > 0) diagnostics.push({ severity: "error", code: "aggregate-without-by", message: "`aggregate=` names a group's columns, so it needs `by=`; for one aggregate row over every row, that is `summary=`" });

  const order = attrs["order"];
  if (typeof order === "string" && order.trim() !== "") orderView(model, order, diagnostics);
  const limit = attrs["limit"];
  if (limit !== undefined) {
    const n = typeof limit === "number" ? limit : Number(limit);
    if (!Number.isInteger(n) || n < 0) diagnostics.push({ severity: "error", code: "view-limit-error", message: "`limit=` must be a non-negative integer" });
    else model.rows = model.rows.slice(0, n);
  }
  // What the relation carried BEFORE projection, so a `summary=` naming a
  // column can say which of two things went wrong: the column never existed, or
  // `select=` dropped it. Reporting the second for both said "did not survive
  // `select=`" about documents that carry no `select=` at all.
  const beforeSelect = new Set(model.columns);
  const select = attrs["select"];
  if (typeof select === "string" && select.trim() !== "") selectView(model, select, diagnostics);

  const summaries = declarations(attrs, "summary");
  if (summaries.length) {
    const summaryAttrs: Record<string, Value> = {};
    let kept = 0;
    for (const summary of summaries) {
      const name = formulaName(summary);
      if (name !== null && model.columns.indexOf(name) < 0) {
        diagnostics.push(beforeSelect.has(name)
          ? { severity: "error", code: "summary-projected-away", message: `summary targets \`${name}\`, which did not survive \`select=\`` }
          : { severity: "error", code: "summary-unknown-column", message: `summary targets unknown column \`${name}\`` });
        continue;
      }
      summaryAttrs[kept === 0 ? "summary" : `summary${kept + 1}`] = summary;
      kept++;
    }
    // An entry in error contributes nothing, and the row stands (§6.1).
    if (kept === 0) model.summary = model.columns.map(() => ({ text: "", inlines: [] }));
    else applyDerivations(model, summaryAttrs, line, sink, diagnostics);
  }
}

function ensureCell(row: TableCell[], ci: number): TableCell {
  while (row.length <= ci) row.push({ text: "", inlines: [] });
  return row[ci]!;
}
