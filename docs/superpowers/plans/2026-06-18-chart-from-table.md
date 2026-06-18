# Chart-from-Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `diagram` block bind to a `table` via `data=#id` and render it with a built-in `geml-chart` renderer — a single-source-of-truth, build-time-checked chart.

**Architecture:** `geml-chart` is one more entry in the diagram renderer registry; `format` still only selects the renderer. The simple-chart mapping lives in **attributes** (`type`/`x`/`y`/`series`/`size`/`rows`), so the processor validates it without ever interpreting a body (§7 body rule untouched). Because a `data=#id` target can appear anywhere in the document, chart resolution runs in a **second pass** after all blocks (and their table models) are built — mirroring the existing `validateRefs` pass. A new pure function `buildChart(attrs, table)` does validation + dataset normalization; `geml.ts` wires it in and handles dangling/non-table reference errors.

**Tech Stack:** TypeScript, Node 22, `tsc` build, `node:assert` test files run from `package.json`.

**Spec:** `docs/superpowers/specs/2026-06-18-chart-from-table-design.md`

---

## File Structure

- **Create** `geml-parser/src/chart.ts` — `ChartModel`/`ChartDataset` types + pure `buildChart(attrs, table)` (channel/type/rows validation + dataset normalization). Mirrors `table.ts`.
- **Create** `geml-parser/test/m4.test.mjs` — unit tests for `buildChart` and integration tests through `parse()`.
- **Modify** `geml-parser/src/geml.ts` — register `geml-chart`; extend `Ctx` with `tables`/`charts`; record chart blocks in pass 1; add `resolveCharts` pass; attach `block.chart`; add `chart?: ChartModel` to the `Block` block variant.
- **Modify** `geml-parser/package.json` — add `node test/m4.test.mjs` to the `test` script.
- **Modify** `GEML-spec-draft.md`, `GEML-spec-draft_CN.md` — §7 additive paragraph + examples.
- **Modify** `COMPARISON.md`, `COMPARISON_CN.md`, `README.md`, `README_CN.md` — sync the new capability.
- **Modify** `GEML-spec-draft.geml` — dogfood example; verify it parses clean.

All commands below assume the working directory `geml-parser/` unless noted.

---

## Task 1: `buildChart` core — types, x/y validation, rows scope, wide-form dataset

**Files:**
- Create: `geml-parser/src/chart.ts`
- Create: `geml-parser/test/m4.test.mjs`
- Modify: `geml-parser/package.json`

- [ ] **Step 1: Add m4 to the test runner**

In `geml-parser/package.json`, change the `test` script to append `m4`:

```json
"test": "tsc && node test/m2.test.mjs && node test/m3.test.mjs && node test/m4.test.mjs && node test/convert.test.mjs && node test/fixtures.test.mjs",
```

- [ ] **Step 2: Write the failing tests (core)**

Create `geml-parser/test/m4.test.mjs`:

```javascript
// M4 conformance checks: chart-from-table (§7 geml-chart).
import { parse } from "../dist/geml.js";
import { buildChart } from "../dist/chart.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const errs = (ds) => ds.filter((d) => d.severity === "error");
const warns = (ds) => ds.filter((d) => d.severity === "warning");

// Build a TableModel from source for unit-testing buildChart in isolation.
const tableOf = (src) => parse(src).children.find((b) => b.table).table;
const FY = tableOf(
  "=== table {#fy format=csv header=1 compute=\"FY = Q1 + Q2\" summary=\"Segment = 'Total'; Q1 = sum(Q1); FY = sum(FY)\"}\n" +
  "Segment, Q1, Q2\nCloud, 10, 20\nHardware, 30, 40\n===");

test("buildChart: bar, single y, data rows (happy path)", () => {
  const r = buildChart({ data: "#fy", type: "bar", x: "Segment", y: "FY" }, FY);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.equal(r.model.type, "bar");
  assert.deepEqual(r.model.y, ["FY"]);
  assert.equal(r.model.rows, "data");
  assert.deepEqual(r.model.dataset.categories, ["Cloud", "Hardware"]);
  assert.deepEqual(r.model.dataset.numbers.FY, [30, 70]); // 10+20, 30+40
});

test("buildChart: wide-form multi-y becomes multiple series", () => {
  const r = buildChart({ data: "#fy", type: "line", x: "Segment", y: "Q1,Q2" }, FY);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.deepEqual(r.model.y, ["Q1", "Q2"]);
  assert.deepEqual(r.model.dataset.numbers.Q1, [10, 30]);
  assert.deepEqual(r.model.dataset.numbers.Q2, [20, 40]);
});

test("buildChart: missing type / x / y are errors", () => {
  assert.ok(errs(buildChart({ data: "#fy", x: "Segment", y: "FY" }, FY).diagnostics).some((e) => /missing `type`/.test(e.message)));
  assert.ok(errs(buildChart({ data: "#fy", type: "bar", y: "FY" }, FY).diagnostics).some((e) => /`x`/.test(e.message)));
  assert.ok(errs(buildChart({ data: "#fy", type: "bar", x: "Segment" }, FY).diagnostics).some((e) => /`y`/.test(e.message)));
});

test("buildChart: unknown type is an error mentioning vega-lite", () => {
  const r = buildChart({ data: "#fy", type: "heatmap", x: "Segment", y: "FY" }, FY);
  assert.ok(errs(r.diagnostics).some((e) => /unknown type/.test(e.message) && /vega-lite/.test(e.message)));
  assert.equal(r.model, null);
});

test("buildChart: missing column is an error", () => {
  const r = buildChart({ data: "#fy", type: "bar", x: "Segmnt", y: "FY" }, FY);
  assert.ok(errs(r.diagnostics).some((e) => /column `Segmnt` not found/.test(e.message)));
  assert.equal(r.model, null);
});

test("buildChart: rows=summary plots only the summary row", () => {
  const r = buildChart({ data: "#fy", type: "bar", rows: "summary", x: "Segment", y: "FY" }, FY);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.deepEqual(r.model.dataset.categories, ["Total"]);
  assert.deepEqual(r.model.dataset.numbers.FY, [100]); // sum(FY)=30+70
});

test("buildChart: rows=all appends the summary row as a point", () => {
  const r = buildChart({ data: "#fy", type: "bar", rows: "all", x: "Segment", y: "FY" }, FY);
  assert.deepEqual(r.model.dataset.categories, ["Cloud", "Hardware", "Total"]);
  assert.deepEqual(r.model.dataset.numbers.FY, [30, 70, 100]);
});

test("buildChart: rows=summary without a summary row is an error", () => {
  const noSum = tableOf("=== table {#t format=csv header=1}\nSeg, V\na, 1\n===");
  const r = buildChart({ data: "#t", type: "bar", rows: "summary", x: "Seg", y: "V" }, noSum);
  assert.ok(errs(r.diagnostics).some((e) => /no summary row/.test(e.message)));
  assert.equal(r.model, null);
});

test("buildChart: pie with multiple y warns and uses the first", () => {
  const r = buildChart({ data: "#fy", type: "pie", x: "Segment", y: "Q1,Q2" }, FY);
  assert.ok(warns(r.diagnostics).some((w) => /pie uses a single/.test(w.message)));
  assert.deepEqual(r.model.y, ["Q1"]);
});

test("buildChart: non-numeric y cell is an error", () => {
  const txt = tableOf("=== table {#t format=csv header=1}\nSeg, V\na, oops\n===");
  const r = buildChart({ data: "#t", type: "bar", x: "Seg", y: "V" }, txt);
  assert.ok(errs(r.diagnostics).some((e) => /non-numeric/.test(e.message)));
  assert.equal(r.model, null);
});

console.log(`\n${passed} test(s) passed.`);
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run build`
Expected: FAIL — `tsc` errors because `src/chart.ts` does not exist (cannot find module `../dist/chart.js`).

- [ ] **Step 4: Implement `buildChart` core**

Create `geml-parser/src/chart.ts`:

```typescript
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all m4 core tests print `ok`, and every other suite still passes.

- [ ] **Step 6: Commit**

```bash
git add src/chart.ts test/m4.test.mjs package.json
git commit -m "feat(parser): buildChart core — channels, types, rows scope, dataset"
```

---

## Task 2: `buildChart` — `series` and `size` channels

**Files:**
- Modify: `geml-parser/src/chart.ts`
- Modify: `geml-parser/test/m4.test.mjs`

- [ ] **Step 1: Write the failing tests**

Insert these tests into `geml-parser/test/m4.test.mjs` immediately before the final `console.log(...)` line:

```javascript
test("buildChart: series (long-form) is validated and captured", () => {
  const long = tableOf("=== table {#l format=csv header=1}\nQuarter, Dept, Rev\nQ1, Cloud, 10\nQ1, HW, 5\n===");
  const r = buildChart({ data: "#l", type: "bar", x: "Quarter", y: "Rev", series: "Dept" }, long);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.equal(r.model.series, "Dept");
  assert.deepEqual(r.model.dataset.seriesOf, ["Cloud", "HW"]);
  assert.deepEqual(r.model.dataset.numbers.Rev, [10, 5]);
});

test("buildChart: scatter size is validated and captured as numbers", () => {
  const pts = tableOf("=== table {#p format=csv header=1}\nName, X, Y, W\na, 1, 2, 9\nb, 3, 4, 8\n===");
  const r = buildChart({ data: "#p", type: "scatter", x: "X", y: "Y", size: "W" }, pts);
  assert.equal(errs(r.diagnostics).length, 0);
  assert.equal(r.model.size, "W");
  assert.deepEqual(r.model.dataset.numbers.W, [9, 8]);
});

test("buildChart: missing series/size column is an error", () => {
  const r = buildChart({ data: "#fy", type: "bar", x: "Segment", y: "FY", series: "Nope" }, FY);
  assert.ok(errs(r.diagnostics).some((e) => /column `Nope` not found/.test(e.message)));
  assert.equal(r.model, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `r.model.series` / `r.model.size` / `seriesOf` are undefined; the missing-series test fails because `series` is not yet column-checked.

- [ ] **Step 3: Add series/size handling to `buildChart`**

In `geml-parser/src/chart.ts`, after the `y` columns are resolved, capture the optional channels. Replace the column-resolution block:

```typescript
  // Resolve columns by header name.
  const idx = (name: string) => table.columns.indexOf(name);
  for (const name of [x, ...y]) {
    if (idx(name) < 0) err(`chart: column \`${name}\` not found in table`);
  }
  if (diagnostics.some((d) => d.severity === "error")) return fail();
```

with this version that also validates the used optional channels:

```typescript
  // Optional channels, only when used by this type.
  const series = USES[type].has("series") ? str(attrs["series"]) : undefined;
  const size = USES[type].has("size") ? str(attrs["size"]) : undefined;

  // Resolve columns by header name (x, y, and any used optional channels).
  const idx = (name: string) => table.columns.indexOf(name);
  const cols = [x, ...y, ...(series ? [series] : []), ...(size ? [size] : [])];
  for (const name of cols) {
    if (idx(name) < 0) err(`chart: column \`${name}\` not found in table`);
  }
  if (diagnostics.some((d) => d.severity === "error")) return fail();
```

Then extend the normalize loop so `size` is collected as numbers and `series` text is captured. Replace the normalize block:

```typescript
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
```

with:

```typescript
  // Normalize: x text + numeric y/size columns; series text. Empty numeric
  // cell -> skip the point; non-empty non-numeric -> error.
  const numCols = [...y, ...(size ? [size] : [])];
  const xi = idx(x);
  const categories: string[] = [];
  const numbers: Record<string, number[]> = {};
  const seriesOf: string[] = [];
  for (const c of numCols) numbers[c] = [];
  for (const row of picked) {
    const cells = numCols.map((c) => row[idx(c)]);
    if (cells.some((cell) => (cell?.text ?? "") === "")) continue;
    let bad = false;
    for (const cell of cells) if (typeof cell?.value !== "number") { err("chart: non-numeric value in a y column"); bad = true; }
    if (bad) return fail();
    categories.push(row[xi]?.text ?? "");
    numCols.forEach((c) => numbers[c]!.push(row[idx(c)]!.value as number));
    if (series) seriesOf.push(row[idx(series)]?.text ?? "");
  }

  const dataRef = (str(attrs["data"]) ?? "").replace(/^#/, "");
  const dataset: ChartDataset = { categories, numbers };
  if (series) dataset.seriesOf = seriesOf;
  const model: ChartModel = { type, x, y, rows: rowsAttr, dataRef, dataset };
  if (series) model.series = series;
  if (size) model.size = size;
  return { model, diagnostics };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all m4 tests print `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/chart.ts test/m4.test.mjs
git commit -m "feat(parser): buildChart series + size channels"
```

---

## Task 3: Wire `geml-chart` into the document parse (second pass)

**Files:**
- Modify: `geml-parser/src/geml.ts`
- Modify: `geml-parser/test/m4.test.mjs`

- [ ] **Step 1: Write the failing integration tests**

Insert into `geml-parser/test/m4.test.mjs` before the final `console.log(...)`:

```javascript
// --- integration through parse() ---
const DOC =
  "=== table {#fy format=csv header=1 compute=\"FY = Q1 + Q2\"}\n" +
  "Segment, Q1, Q2\nCloud, 10, 20\nHardware, 30, 40\n===\n\n" +
  "=== diagram {#c format=geml-chart data=#fy type=bar x=Segment y=FY}\n===\n";

test("parse: geml-chart attaches a chart model and is clean", () => {
  const d = parse(DOC);
  assert.equal(errs(d.diagnostics).length, 0);
  assert.equal(warns(d.diagnostics).length, 0);
  const chart = d.children.find((b) => b.type === "diagram" && b.chart).chart;
  assert.equal(chart.type, "bar");
  assert.deepEqual(chart.dataset.categories, ["Cloud", "Hardware"]);
});

test("parse: forward reference resolves (chart before table)", () => {
  const d = parse(
    "=== diagram {#c format=geml-chart data=#fy type=bar x=Segment y=FY}\n===\n\n" +
    "=== table {#fy format=csv header=1}\nSegment, FY\nCloud, 5\n===\n");
  assert.equal(errs(d.diagnostics).length, 0);
});

test("parse: dangling data=#id is an error", () => {
  const d = parse("=== diagram {#c format=geml-chart data=#nope type=bar x=a y=b}\n===\n");
  assert.ok(errs(d.diagnostics).some((e) => /unresolved|not found|cannot resolve|`nope`/.test(e.message)));
});

test("parse: data=#id pointing at a non-table is an error", () => {
  const d = parse(
    "=== note {#n}\nhi\n===\n\n" +
    "=== diagram {#c format=geml-chart data=#n type=bar x=a y=b}\n===\n");
  assert.ok(errs(d.diagnostics).some((e) => /not a table|must be a table/.test(e.message)));
});

test("parse: geml-chart with a body warns", () => {
  const d = parse(
    "=== table {#fy format=csv header=1}\nSegment, FY\nCloud, 5\n===\n\n" +
    "=== diagram {#c format=geml-chart data=#fy type=bar x=Segment y=FY}\nstray body\n===\n");
  assert.ok(warns(d.diagnostics).some((w) => /body/.test(w.message)));
});

test("parse: geml-chart does not trigger the unknown-renderer warning", () => {
  const d = parse(DOC);
  assert.ok(!d.diagnostics.some((x) => /no registered renderer/.test(x.message)));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `geml-chart` is reported as an unregistered renderer; `b.chart` is undefined; dangling/non-table/body diagnostics are absent.

- [ ] **Step 3: Import chart module and extend the `Block` type**

In `geml-parser/src/geml.ts`, add to the imports near the top (after the existing `./table.js` import):

```typescript
import { type ChartModel, buildChart } from "./chart.js";
```

Add `chart?: ChartModel;` to the `kind: "block"` variant of the `Block` union (next to `table?: TableModel;`):

```typescript
      table?: TableModel;
      chart?: ChartModel;
    };
```

- [ ] **Step 4: Register the renderer and extend `Ctx`**

In `geml-parser/src/geml.ts`, add `geml-chart` to the renderer registry:

```typescript
const DIAGRAM_RENDERERS = new Set(["mermaid", "graphviz", "dot", "d2", "plantuml", "geml-chart"]);
```

Extend the `Ctx` interface with collectors for the second pass (a table-model index and the chart blocks to resolve):

```typescript
interface Ctx extends RefSink {
  diags: Diagnostic[];
  ids: Map<string, number>;
  tables?: Map<string, TableModel>;
  charts?: { block: Extract<Block, { kind: "block" }>; line: number }[];
}
```

- [ ] **Step 5: Record tables and chart blocks during the scan**

In `geml-parser/src/geml.ts`, in the `type === "table"` branch, index the model by id. Replace:

```typescript
        if (type === "table") {
          // §6: parse the raw body (visual or csv/tsv) into one table model.
          const { model, diagnostics } = parseTable(body, attrs.attrs, openLineNo, ctx);
          block.table = model;
          for (const d of diagnostics) diags.push({ ...d, line: openLineNo });
        } else if (type === "diagram") {
          // §7: warn on a diagram format with no registered renderer.
          const fmt = attrs.attrs["format"];
          if (typeof fmt === "string" && !DIAGRAM_RENDERERS.has(fmt)) {
            diags.push({ severity: "warning", message: `no registered renderer for diagram format \`${fmt}\`; body kept raw`, line: openLineNo });
          }
        }
```

with:

```typescript
        if (type === "table") {
          // §6: parse the raw body (visual or csv/tsv) into one table model.
          const { model, diagnostics } = parseTable(body, attrs.attrs, openLineNo, ctx);
          block.table = model;
          for (const d of diagnostics) diags.push({ ...d, line: openLineNo });
          if (block.id !== undefined) (ctx.tables ??= new Map()).set(block.id, model);
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
```

- [ ] **Step 6: Add the `resolveCharts` second pass**

In `geml-parser/src/geml.ts`, add this function just above `export function parse(...)`:

```typescript
// §7: resolve every geml-chart against its referenced table. Runs after the
// scan so that `data=#id` may point at a table defined anywhere in the doc.
function resolveCharts(ctx: Ctx): void {
  for (const { block, line } of ctx.charts ?? []) {
    const ref = typeof block.attrs["data"] === "string" ? (block.attrs["data"] as string) : "";
    const id = ref.replace(/^#/, "");
    if (id === "") { ctx.diags.push({ severity: "error", message: "geml-chart: missing `data=#id`", line }); continue; }
    const table = ctx.tables?.get(id);
    if (!table) {
      const what = ctx.ids.has(id) ? `data target \`#${id}\` is not a table` : `unresolved reference \`#${id}\``;
      ctx.diags.push({ severity: "error", message: `geml-chart: ${what}`, line });
      continue;
    }
    const { model, diagnostics } = buildChart(block.attrs, table);
    if (model) block.chart = model;
    for (const d of diagnostics) ctx.diags.push({ ...d, line });
  }
}
```

- [ ] **Step 7: Call `resolveCharts` from `parse`**

In `geml-parser/src/geml.ts`, in `export function parse(...)`, add the call between `scanBlocks` and `validateRefs`:

```typescript
  const children = scanBlocks(lines, 0, ctx);
  resolveCharts(ctx);
  validateRefs(ctx, opts);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all m4 integration tests print `ok`, and every other suite still passes.

- [ ] **Step 9: Commit**

```bash
git add src/geml.ts test/m4.test.mjs
git commit -m "feat(parser): wire geml-chart — data=#id binding, second-pass resolution"
```

---

## Task 4: Spec §7 — additive `data=#id` binding + geml-chart (EN + CN)

**Files:**
- Modify: `GEML-spec-draft.md` (§7, repo root)
- Modify: `GEML-spec-draft_CN.md` (§7, repo root)

- [ ] **Step 1: Extend §7 in `GEML-spec-draft.md`**

After the existing diagram bullets (the line ``- `#flow` makes the diagram referenceable: `see [[#flow]]`.``), add:

```markdown

### 7.1 Data-bound charts

A `diagram` MAY declare a data source with `data=#id`. The processor MUST
resolve the reference (a dangling id, or a target that is not a `table`, is a
build **error**) and supply the referenced table's model — computed columns
included — to the renderer. The processor still does NOT interpret the body.

The built-in `geml-chart` renderer draws a table as a chart. `format` still only
selects the renderer; the chart is described entirely in **attributes**, so the
processor validates it (the body stays empty — a non-empty body is a warning):

```
=== diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY caption="FY revenue"}
===
```

- `type` — `bar | line | area | pie | scatter`. It only changes how the channels
  are drawn; it never adds new attributes.
- Encoding channels (a closed set): `x` (category), `y` (value; a comma list is
  multiple series), `series` (group by a column), `size` (scatter bubble).
  Required: `x`, `y`. A channel a type does not use is a warning.
- `rows` — `data` (default, summary row excluded), `all` (data + the summary row
  as one extra point), or `summary` (only the summary row).
- Column names, the `data` id, and `rows` are validated against the table:
  a typo'd column or a dangling id is a build error.
- Charts that need more (annotations, reference lines, heatmaps, …) use a hosted
  DSL instead: `=== diagram {format=vega-lite data=#fy25}` with the spec in the
  body. The body is raw and NOT column-checked.
```

- [ ] **Step 2: Extend §7 in `GEML-spec-draft_CN.md`**

After the matching `#flow` bullet in the Chinese spec, add:

```markdown

### 7.1 绑定数据的图表

`diagram` 可用 `data=#id` 声明数据源。处理器必须解析该引用（悬空 id、或目标不是
`table`，都是构建**错误**），并把被引表的模型（含计算列）提供给渲染器。处理器仍
**不解释 body**。

内置 `geml-chart` 渲染器把表画成图表。`format` 仍只选渲染器；图表完全用**属性**
描述，因此处理器能校验（body 留空——非空 body 给告警）：

```
=== diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY caption="FY 营收"}
===
```

- `type` —— `bar | line | area | pie | scatter`，只改画法，绝不新增属性。
- 编码通道（封闭集）：`x`（类目）、`y`（数值；逗号列表即多系列）、`series`（按列
  分组）、`size`（散点气泡）。必填 `x`、`y`。类型用不到的通道给告警。
- `rows` —— `data`（默认，排除汇总行）、`all`（数据行 + 汇总行作为额外一点）、
  `summary`（只画汇总行）。
- 列名、`data` id、`rows` 都对照表校验：写错列名或悬空 id = 构建错误。
- 更复杂的图（标注、参考线、热力图…）改用托管 DSL：
  `=== diagram {format=vega-lite data=#fy25}`，spec 写进 body。body 为 raw、不校验列名。
```

- [ ] **Step 3: Verify the spec files still describe a consistent model**

Run: `node dist/geml.js ../GEML-spec-draft.geml > /dev/null; echo "exit=$?"`
Expected: `exit=0` (the dogfood is updated in Task 6; this step only confirms the markdown edits did not touch the parser).

- [ ] **Step 4: Commit**

```bash
git add ../GEML-spec-draft.md ../GEML-spec-draft_CN.md
git commit -m "docs(spec): §7.1 data-bound charts (geml-chart)"
```

---

## Task 5: Sync COMPARISON and README (EN + CN)

**Files:**
- Modify: `COMPARISON.md`, `COMPARISON_CN.md` (repo root)
- Modify: `README.md`, `README_CN.md` (repo root)

- [ ] **Step 1: Add a chart row to `COMPARISON.md`**

After the "Diagram (hosting an external DSL)" fenced block, add:

```markdown
### Chart bound to a table (GEML-specific)

```
GEML        === diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY}
            ===                       → draws table #fy25; column refs checked
others      hand-copy data into a chart lib, or a spreadsheet app — no link
```
```

- [ ] **Step 2: Add the same to `COMPARISON_CN.md`**

After the matching diagram block in the Chinese comparison, add:

```markdown
### 绑定数据表的图表（GEML 独有）

```
GEML        === diagram {#rev format=geml-chart data=#fy25 type=bar x=Segment y=FY}
            ===                       → 画 #fy25 表；列引用受校验
其他格式      手抄数据进图表库，或用电子表格 App —— 无链接
```
```

- [ ] **Step 3: Mention charts in `README.md`**

In `README.md`, in the "Diagrams — bring your own DSL" section, after the mermaid example fenced block, add:

```markdown

A diagram can also **draw a table**: `=== diagram {format=geml-chart data=#fy25 type=bar x=Segment y=FY}` binds to table `#fy25` (single source of truth) and validates the column references at build time. Complex charts fall back to a hosted DSL like `format=vega-lite` with the spec in the body.
```

- [ ] **Step 4: Mention charts in `README_CN.md`**

In `README_CN.md`, in the "图形 —— 自带 DSL" section, after the mermaid example, add:

```markdown

图形还能**画数据表**：`=== diagram {format=geml-chart data=#fy25 type=bar x=Segment y=FY}` 绑定到表 `#fy25`（单一真相），并在构建期校验列引用。复杂图退回托管 DSL，如 `format=vega-lite`、spec 写进 body。
```

- [ ] **Step 5: Commit**

```bash
git add ../COMPARISON.md ../COMPARISON_CN.md ../README.md ../README_CN.md
git commit -m "docs: mention data-bound charts in COMPARISON and README"
```

---

## Task 6: Dogfood example + full verification

**Files:**
- Modify: `GEML-spec-draft.geml` (repo root)

- [ ] **Step 1: Add a chart to the dogfood, referencing the existing `#budget` table**

In `GEML-spec-draft.geml`, in §7 (Graphics / 图形), after the existing live mermaid `#flow` diagram block, add a chart bound to the FY table that already has id `#budget`:

```
=== diagram {#rev-chart format=geml-chart data=#budget type=bar x=Segment y=FY caption="FY revenue by segment"}
===
```

- [ ] **Step 2: Parse the dogfood and confirm zero errors**

Run:
```bash
node dist/geml.js ../GEML-spec-draft.geml 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const e=(j.diagnostics||[]).filter(d=>d.severity==="error");console.log("errors:",e.length);e.forEach(x=>console.log("  L"+x.line,x.message));})'
```
Expected: `errors: 0`

- [ ] **Step 3: Confirm the chart model resolved against the table**

Run:
```bash
node dist/geml.js ../GEML-spec-draft.geml 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);let hit=false;(function w(x){if(!x||typeof x!=="object")return;if(x.chart&&x.chart.type){hit=true;console.log("chart:",x.chart.type,"cats=",JSON.stringify(x.chart.dataset.categories));}for(const k in x)w(x[k]);})(j);if(!hit)process.exit(1);})'
```
Expected: a line like `chart: bar cats= ["Cloud","Hardware","Services"]` (the segments from `#budget`).

- [ ] **Step 4: Run the whole test suite**

Run: `npm test`
Expected: PASS — every suite, including m4, prints its `ok` lines and final counts.

- [ ] **Step 5: Commit**

```bash
git add ../GEML-spec-draft.geml
git commit -m "docs(dogfood): add a data-bound chart referencing #budget"
```

---

## Self-Review Notes

- **Spec coverage:** design §3 block shape → Tasks 1–3 + 4; §4 channels → Tasks 1–2; §5 data binding/normalization → Tasks 1–3; §5.1 `rows` → Task 1; §6 error cases → Tasks 1–3 (dangling/non-table in Task 3, column/type/channel/non-numeric in Tasks 1–2, body warning + summary-missing in Tasks 1/3); §7 spec change → Task 4; docs sync → Tasks 5–6.
- **Out of scope (per design §9):** rendering to SVG/pixels, `include-summary` finer filtering, annotations/reference lines, tooltip formatting, cross-document `data=other.geml#id`. The reference parser resolves + validates + normalizes; producing the actual picture is a renderer concern not built here.
- **Type consistency:** `ChartModel`/`ChartDataset`/`buildChart` signatures defined in Task 1 are reused unchanged in Tasks 2–3; `Ctx.tables`/`Ctx.charts` added in Task 3 are consumed only by `resolveCharts`.
