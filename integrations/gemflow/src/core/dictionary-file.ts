// The dictionary as a file: `tools.geml` read and written. The decisions live
// in dictionary.ts, which imports no parser, so a host shell can decide from
// its policy snapshot without one.
import { parse, unitSpans, type Block } from "@geml/geml";
import { COLUMNS, NAME, TOOLS_TABLE, type DictRow, type Dictionary } from "./dictionary.js";
import type { JsonValue } from "./schema.js";
import type { FlowDiagnostic, Statechart } from "./statechart.js";

type Typed = Extract<Block, { kind: "block" }>;

/**
 * The `#tools` table of `source`, checked (`flow-tools`); against `sc`, its
 * states must be the workflow's and its uses declared somewhere
 * (`flow-source`) — against several (a project's one dictionary), a state or
 * use of any of them.
 */
export function readDictionary(source: string, sc?: Statechart | readonly Statechart[]): Dictionary {
  const doc = parse(source);
  const diagnostics: FlowDiagnostic[] = doc.diagnostics.filter((d) => d.severity === "error").map((d) => ({ severity: "error", code: d.code, message: d.message, line: d.line }));
  const err = (message: string, line = 1) => diagnostics.push({ severity: "error", code: "flow-tools", message, line });
  const tb = doc.children.find((b): b is Typed => b.kind === "block" && b.type === "table" && b.id === TOOLS_TABLE);
  if (!tb?.table) { err(`no \`table {#${TOOLS_TABLE}}\` block`); return { rows: [], diagnostics }; }
  const { columns, rows, header } = tb.table;
  if (!header) { err(`#${TOOLS_TABLE}: the table has no header row`); return { rows: [], diagnostics }; }
  const cols = columns.map((c) => c.trim().toLowerCase());
  const missing = COLUMNS.filter((c) => !cols.includes(c));
  const unknown = cols.filter((c) => c !== "" && !(COLUMNS as readonly string[]).includes(c));
  if (missing.length) err(`#${TOOLS_TABLE}: missing column(s) ${missing.join(", ")}`);
  if (unknown.length) err(`#${TOOLS_TABLE}: unknown column(s) ${unknown.join(", ")} (the columns are ${COLUMNS.join(", ")})`);
  if (missing.length || unknown.length) return { rows: [], diagnostics };
  const cell = (row: (typeof rows)[number], name: string): string => {
    const c = row[cols.indexOf(name)];
    if (!c) return "";
    const only = c.inlines.length === 1 ? c.inlines[0] : undefined;
    return (only?.type === "code" ? only.value : c.text).trim();
  };
  const charts = sc === undefined ? undefined : Array.isArray(sc) ? sc : [sc as Statechart];
  const declared = charts === undefined ? undefined : new Set(charts.flatMap((c) => [...c.states.values()].flatMap((s) => s.uses)));
  const states = charts === undefined ? undefined : new Set(charts.flatMap((c) => [...c.states.keys()]));
  const out: DictRow[] = [];
  const defaults = new Map<string, number>();
  rows.forEach((row, i) => {
    const n = i + 1;
    const tool = cell(row, "tool");
    if (tool === "") { err(`#${TOOLS_TABLE} row ${n}: no tool`); return; }
    const entry: DictRow = { tool, allow: [], deny: [], default: false, row: n };
    const use = cell(row, "for");
    if (use !== "") {
      if (!NAME.test(use)) { err(`#${TOOLS_TABLE} row ${n}: for = "${use}" is not a name`); return; }
      entry.for = use;
      if (declared !== undefined && !declared.has(use)) diagnostics.push({ severity: "warning", code: "flow-source", message: `#${TOOLS_TABLE} row ${n}: the use \`${use}\` is declared by no state, so ${tool} can be used nowhere`, line: 1 });
    }
    for (const col of ["allow", "deny"] as const) {
      const names = cell(row, col).match(/\S+/g) ?? [];
      for (const s of names) {
        if (s !== "*" && states !== undefined && !states.has(s)) err(`#${TOOLS_TABLE} row ${n}: ${col} names ${s}, which is not a state of the workflow`);
      }
      entry[col] = names;
    }
    const def = cell(row, "default");
    if (def !== "" && def !== "yes") err(`#${TOOLS_TABLE} row ${n}: default = "${def}" is not yes (or empty)`);
    entry.default = def === "yes";
    if (entry.default) {
      if (entry.for === undefined) err(`#${TOOLS_TABLE} row ${n}: default without a use (for)`);
      else if (defaults.has(entry.for)) err(`#${TOOLS_TABLE} row ${n}: a second default for the use ${entry.for} (row ${defaults.get(entry.for)})`);
      else defaults.set(entry.for, n);
    }
    const params = cell(row, "params");
    if (params !== "") {
      try {
        const v = JSON.parse(params) as JsonValue;
        if (typeof v !== "object" || v === null || Array.isArray(v)) err(`#${TOOLS_TABLE} row ${n}: params is not a JSON object`);
        else entry.params = v as Record<string, JsonValue>;
      } catch { err(`#${TOOLS_TABLE} row ${n}: params is not JSON`); }
    }
    out.push(entry);
  });
  return { rows: out, diagnostics };
}

/** A cell's text: a value that holds the table's own `|` goes in code. */
const cellText = (s: string): string => (s.includes("|") ? `\`${s}\`` : s);

/** The `#tools` table block, every row rewritten. */
export function renderToolsTable(rows: readonly DictRow[]): string {
  const lines = rows.map((r) => [
    cellText(r.tool), r.for ?? "", r.allow.join(" "), r.deny.join(" "), r.default ? "yes" : "",
    r.params === undefined ? "" : `\`${JSON.stringify(r.params)}\``,
  ]);
  const widths = COLUMNS.map((c, i) => Math.max(c.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cells: readonly string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  return [
    `=== table {#${TOOLS_TABLE}}`,
    fmt(COLUMNS), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`,
    ...lines.map(fmt),
    "===",
  ].join("\n");
}

/** A whole dictionary document: a title and the table. */
export function renderDictionary(rows: readonly DictRow[]): string {
  return ["=== meta", 'title = "Gemflow tool dictionary"', "===", "", renderToolsTable(rows), ""].join("\n");
}

/**
 * `source` with its `#tools` table replaced by `rows` — only that block is
 * rewritten; what a person wrote around it stays. A document without the
 * table gets it appended; no document at all becomes a fresh one.
 */
export function withToolsTable(source: string | null, rows: readonly DictRow[]): string {
  if (source === null) return renderDictionary(rows);
  const src = source.replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const unit = unitSpans(src).find((u) => u.kind === "block" && u.id === TOOLS_TABLE);
  const table = renderToolsTable(rows).split("\n");
  if (unit === undefined) return `${src.replace(/\n*$/, "\n\n")}${table.join("\n")}\n`;
  // A span ends on the line after its closing fence.
  return [...lines.slice(0, unit.span.start), ...table, ...lines.slice(unit.span.end)].join("\n");
}
