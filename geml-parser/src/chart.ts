// GEML reference parser — chart-from-table (§7 geml-chart renderer).
//
// A `diagram {format=geml-chart data=#id ...}` binds to a table and is drawn
// from a closed set of encoding channels (x, y, series, size). `type` only
// changes how those channels are drawn; it never adds new attributes. The
// processor validates the attributes against the referenced table's model and
// normalizes the selected rows into a dataset for a renderer. See the design
// doc and §7.

import { type Value } from "./attrs.js";
import { type TableModel, type TableCell } from "./table.js";

export type ChartType = "bar" | "line" | "area" | "pie" | "scatter";
export type RowScope = "data" | "all" | "summary";

const TYPES = new Set<ChartType>(["bar", "line", "area", "pie", "scatter"]);

// Channels each type can use; supplying any other is a warning (ignored).
const USES: Record<ChartType, Set<string>> = {
  bar:     new Set(["x", "y", "series"]),
  line:    new Set(["x", "y", "series"]),
  area:    new Set(["x", "y", "series"]),
  scatter: new Set(["x", "y", "series", "size"]),
  pie:     new Set(["x", "y"]),
};

export interface ChartDataset {
  categories: string[];                 // x label per plotted row (cell text)
  numbers: Record<string, number[]>;    // y (+ size) column -> values, row-aligned
  seriesOf?: string[];                  // series column text per row, if series set
}

export interface ChartModel {
  type: ChartType;
  x: string;
  y: string[];
  series?: string;
  size?: string;
  rows: RowScope;
  dataRef: string;                      // referenced table id (without '#')
  dataset: ChartDataset;
}

export interface ChartDiag { severity: "error" | "warning"; message: string; }
export interface ChartResult { model: ChartModel | null; diagnostics: ChartDiag[]; }

function str(v: Value | undefined): string | undefined {
  return v === undefined ? undefined : typeof v === "string" ? v : String(v);
}

export function buildChart(attrs: Record<string, Value>, table: TableModel): ChartResult {
  const diagnostics: ChartDiag[] = [];
  const err = (m: string) => diagnostics.push({ severity: "error", message: m });
  const warn = (m: string) => diagnostics.push({ severity: "warning", message: m });
  const fail = (): ChartResult => ({ model: null, diagnostics });

  const typeRaw = str(attrs["type"]);
  if (!typeRaw) { err("chart: missing `type`"); return fail(); }
  if (!TYPES.has(typeRaw as ChartType)) {
    err(`chart: unknown type \`${typeRaw}\` (supported: bar, line, area, pie, scatter; use format=vega-lite for others)`);
    return fail();
  }
  const type = typeRaw as ChartType;

  const x = str(attrs["x"]);
  const yRaw = str(attrs["y"]);
  if (!x) err("chart: missing required channel `x`");
  if (!yRaw) err("chart: missing required channel `y`");
  if (!x || !yRaw) return fail();

  let y = yRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (y.length === 0) { err("chart: `y` lists no columns"); return fail(); }

  // Wrong-channel warnings (channel present but unused by this type).
  if (attrs["size"] !== undefined && !USES[type].has("size")) warn(`chart: \`size\` is ignored for type \`${type}\``);
  if (attrs["series"] !== undefined && !USES[type].has("series")) warn(`chart: \`series\` is ignored for type \`${type}\``);
  if (type === "pie" && y.length > 1) { warn("chart: pie uses a single `y`; extra columns ignored"); y = [y[0]!]; }

  // Resolve columns by header name.
  const idx = (name: string) => table.columns.indexOf(name);
  for (const name of [x, ...y]) {
    if (idx(name) < 0) err(`chart: column \`${name}\` not found in table`);
  }
  if (diagnostics.some((d) => d.severity === "error")) return fail();

  // Select rows per scope.
  const rowsAttr = (str(attrs["rows"]) ?? "data") as RowScope;
  if (!["data", "all", "summary"].includes(rowsAttr)) { err(`chart: unknown rows scope \`${rowsAttr}\` (data|all|summary)`); return fail(); }
  let picked: TableCell[][];
  if (rowsAttr === "summary") {
    if (!table.summary) { err("chart: rows=summary but the table has no summary row"); return fail(); }
    picked = [table.summary];
  } else if (rowsAttr === "all") {
    if (!table.summary) warn("chart: rows=all but the table has no summary row; using data rows");
    picked = table.summary ? [...table.rows, table.summary] : table.rows;
  } else {
    picked = table.rows;
  }

  // Normalize: x text + numeric y columns. Empty y cell -> skip the point;
  // non-empty non-numeric -> error.
  const xi = idx(x);
  const categories: string[] = [];
  const numbers: Record<string, number[]> = {};
  for (const c of y) numbers[c] = [];
  for (const row of picked) {
    const cells = y.map((c) => row[idx(c)]);
    if (cells.some((cell) => (cell?.text ?? "") === "")) continue;
    let bad = false;
    for (const cell of cells) if (typeof cell?.value !== "number") { err("chart: non-numeric value in a y column"); bad = true; }
    if (bad) return fail();
    categories.push(row[xi]?.text ?? "");
    y.forEach((c) => numbers[c]!.push(row[idx(c)]!.value as number));
  }

  const dataRef = (str(attrs["data"]) ?? "").replace(/^#/, "");
  const model: ChartModel = { type, x, y, rows: rowsAttr, dataRef, dataset: { categories, numbers } };
  return { model, diagnostics };
}
