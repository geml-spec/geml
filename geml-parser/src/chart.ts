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

  // Validate rows scope up front so a bad value is reported even when a column
  // name is also wrong.
  const rowsAttr = (str(attrs["rows"]) ?? "data") as RowScope;
  if (!["data", "all", "summary"].includes(rowsAttr)) { err(`chart: unknown rows scope \`${rowsAttr}\` (data|all|summary)`); return fail(); }

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

  // Optional channels, only when used by this type.
  const series = USES[type].has("series") ? str(attrs["series"]) : undefined;
  const size = USES[type].has("size") ? str(attrs["size"]) : undefined;

  // Resolve columns by header name (x, y, and any used optional channels).
  const idx = (name: string) => table.columns.indexOf(name);
  for (const name of [x, ...y, ...(series ? [series] : []), ...(size ? [size] : [])]) {
    if (idx(name) < 0) err(`chart: column \`${name}\` not found in table`);
  }
  if (diagnostics.some((d) => d.severity === "error")) return fail();

  // Select rows per scope.
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

  // Normalize: x text + numeric y/size columns; series text. A non-empty
  // non-numeric value in a numeric column is always an error; a row with an
  // empty numeric cell is skipped (no data point).
  const numCols = [...y, ...(size ? [size] : [])];
  const xi = idx(x);
  const si = series ? idx(series) : -1;
  const numIs = numCols.map(idx);
  const categories: string[] = [];
  const numbers: Record<string, number[]> = {};
  const seriesOf: string[] = [];
  for (const c of numCols) numbers[c] = [];
  for (const row of picked) {
    const cells = numIs.map((i) => row[i]);
    if (cells.some((cell) => (cell?.text ?? "") !== "" && typeof cell?.value !== "number")) {
      err("chart: non-numeric value in a y column"); return fail();
    }
    if (cells.some((cell) => (cell?.text ?? "") === "")) continue;
    categories.push(row[xi]?.text ?? "");
    numIs.forEach((i, j) => numbers[numCols[j]!]!.push(row[i]!.value as number));
    if (series) seriesOf.push(row[si]?.text ?? "");
  }

  const dataRef = (str(attrs["data"]) ?? "").replace(/^#/, "");
  const dataset: ChartDataset = { categories, numbers };
  if (series) dataset.seriesOf = seriesOf;
  const model: ChartModel = { type, x, y, rows: rowsAttr, dataRef, dataset };
  if (series) model.series = series;
  if (size) model.size = size;
  return { model, diagnostics };
}
