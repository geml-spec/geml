// The backlog: what is still to do, as one table (spec §5.6). A row with an
// empty branch (or file) column is a to-do; binding it to a work item fills
// the column. Progress is read from the item's journal, never stored here.
import { parse, splitLines, unitSpans, type Block } from "@geml/geml";
import { escapeCellPipes } from "@geml/geml/dist/table.js";

export interface BacklogItem { id: string; title: string; target: string }
export type BacklogKey = "branch" | "file";

type TableBlock = Extract<Block, { kind: "block" }>;
type TableRow = NonNullable<TableBlock["table"]>["rows"][number];

/** The `#backlog` table as the document holds it: its block, which column is the target, and the rows read. */
interface Loaded { tb: TableBlock; cols: string[]; key: BacklogKey; items: BacklogItem[]; diagnostics: string[] }

function load(source: string): Loaded | undefined {
  const tb = parse(source).children.find((b): b is TableBlock => b.kind === "block" && b.type === "table" && b.id === "backlog");
  if (!tb?.table) return undefined;
  const cols = tb.table.columns.map((c) => c.trim().toLowerCase());
  const key: BacklogKey = cols.includes("file") ? "file" : "branch";
  const at = (name: string) => cols.indexOf(name);
  // The signals table's cell reading: a cell that is exactly one code span reads as the span's text.
  const cell = (row: TableRow, name: string): string => {
    const c = at(name) >= 0 ? row[at(name)] : undefined;
    if (!c) return "";
    const only = c.inlines.length === 1 ? c.inlines[0] : undefined;
    return (only?.type === "code" && only.value !== undefined ? only.value : c.text).trim();
  };
  const items = tb.table.rows.map((row) => ({ id: cell(row, "id"), title: cell(row, "title"), target: cell(row, key) }));
  const diagnostics = at("id") < 0 || at("title") < 0 ? ["#backlog needs id and title columns"] : [];
  const seen = new Set<string>(), repeated = new Set<string>();
  for (const { id } of items) if (id !== "") (seen.has(id) ? repeated : seen).add(id);
  for (const id of repeated) diagnostics.push(`#backlog repeats id ${JSON.stringify(id)}`);
  // A row nobody can name cannot be bound or found again. (Without an id column every row is nameless; that is said once, above.)
  if (at("id") >= 0) items.forEach((item, i) => { if (item.id === "") diagnostics.push(`#backlog row ${i + 1} has no id`); });
  return { tb, cols, key, items, diagnostics };
}

export function readBacklog(source: string): { key: BacklogKey; items: BacklogItem[]; diagnostics: string[] } {
  const l = load(source);
  return l ? { key: l.key, items: l.items, diagnostics: l.diagnostics } : { key: "branch", items: [], diagnostics: ["no table block #backlog"] };
}

/**
 * A cell as written: a newline becomes a space, so a row can never break, and
 * a pipe is escaped the parser's way (§6(a): `\|` is the one escape, a
 * backslash anywhere else is itself, so none is doubled).
 */
const esc = (s: string): string => escapeCellPipes(s.replace(/\r\n|[\r\n]/g, " "));

export function renderBacklog(items: readonly BacklogItem[], key: BacklogKey): string {
  const rows = items.map((i) => `| ${esc(i.id)} | ${esc(i.title)} | ${esc(i.target)} |`);
  return [
    "=== meta", 'title   = "Backlog"', "===", "",
    "=== table {#backlog}", `| id | title | ${key} |`, "|---|---|---|", ...rows, "===", "",
  ].join("\n");
}

export function bindItem(items: readonly BacklogItem[], id: string, target: string): { ok: true; items: BacklogItem[] } | { ok: false; reason: string } {
  if (id === "") return { ok: false, reason: "an empty id names no backlog item" };
  if (target === "") return { ok: false, reason: "a work item to bind is needed" };
  const matches = items.filter((i) => i.id === id);
  const found = matches[0];
  if (!found) return { ok: false, reason: `no backlog item ${id}` };
  if (matches.length > 1) return { ok: false, reason: `backlog id ${id} is not unique` };
  if (found.target && found.target !== target) return { ok: false, reason: `${id} is already bound to ${found.target}` };
  return { ok: true, items: items.map((i) => (i.id === id ? { ...i, target } : i)) };
}

const BLANK = /^\p{White_Space}$/u;

/**
 * `line` (one table row, no line end) with the text of its `ci`-th cell
 * replaced by `value`, everything else in it as written. A cell ends at a `|`
 * that no backslash escapes (§6(a)); the leading and trailing pipe are optional;
 * a row with fewer cells than `ci` is grown, its missing cells empty.
 */
function withCell(line: string, ci: number, value: string): string {
  let a = 0, b = line.length;
  while (a < b && BLANK.test(line[a]!)) a++;
  while (b > a && BLANK.test(line[b - 1]!)) b--;
  if (line[a] === "|") a++;
  const end = b > a && line[b - 1] === "|" && line[b - 2] !== "\\" ? b - 1 : b;
  const starts = [a], ends: number[] = [];
  for (let i = a; i < end; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") i++;
    else if (line[i] === "|") { ends.push(i); starts.push(i + 1); }
  }
  ends.push(end);
  if (ci >= starts.length) {
    // The cells before this one that the row lacks are empty ones.
    const head = line.slice(0, end);
    return head + (BLANK.test(head.slice(-1)) ? "" : " ") + "| ".repeat(ci - starts.length) + "| " + value + " " + line.slice(end);
  }
  const s = starts[ci]!, e = ends[ci]!;
  let ts = s, te = e;
  while (ts < te && BLANK.test(line[ts]!)) ts++;
  while (te > ts && BLANK.test(line[te - 1]!)) te--;
  if (te > ts) return line.slice(0, ts) + value + line.slice(te);
  // An empty cell keeps the room it had, a space either side at least.
  return line.slice(0, s) + (e - s >= 1 ? line[s] : " ") + value + (e - s >= 2 ? line.slice(s + 1, e) : " ") + line.slice(e);
}

/**
 * Bind backlog item `id` to `target` in the document text: the one cell of the
 * `target` column (`branch` or `file`) in that row is rewritten and every other
 * byte stays - the other columns and their padding, the other rows, the prose,
 * the meta, the other blocks, the line ends. Returns the new text for the
 * caller to write, under the lock of the backlog file. It refuses what
 * `bindItem` refuses (no such item, an id that is not unique or empty, the row
 * already bound elsewhere; binding to the target it already has returns the
 * text unchanged), and what it cannot write: a table with no such column, one
 * whose rows are not a pipe grid in this document (`format=csv`, `src=`, a
 * computed column), or a target that would not read back as itself. The
 * result is re-read and must differ from the original in that one cell, or
 * nothing is returned.
 */
export function bindInDocument(source: string, id: string, target: string): { ok: true; text: string } | { ok: false; reason: string } {
  const before = load(source);
  if (!before) return { ok: false, reason: "no table block #backlog" };
  const bound = bindItem(before.items, id, target);
  if (!bound.ok) return bound;
  const row = before.items.findIndex((i) => i.id === id);
  if (before.items[row]!.target === target) return { ok: true, text: source };

  const { tb, key } = before;
  const col = before.cols.indexOf(key);
  const unwritable = (why: string) => ({ ok: false as const, reason: `#backlog ${why}` });
  if (col < 0) return unwritable(`has no ${key} column`);
  const format = String(tb.attrs["format"] ?? "");
  if (format === "csv" || format === "tsv" || !tb.table?.rowLines) return unwritable("rows are not a pipe table written in this document, so a cell cannot be rewritten");
  if (tb.table.rows[row]?.[col]?.computed) return unwritable(`column ${key} is computed, so it has no bytes to rewrite`);

  const span = unitSpans(source).find((u) => u.kind === "block" && u.id === "backlog")?.span;
  const lines = splitLines(source);
  const at = span === undefined ? undefined : span.start + 1 + tb.table.rowLines[row]!;
  const old = at === undefined ? undefined : lines[at];
  if (at === undefined || old === undefined) return unwritable("row could not be found in the text");
  const eol = /(?:\r\n|\r|\n)$/.exec(old)?.[0] ?? "";
  lines[at] = withCell(old.slice(0, old.length - eol.length), col, esc(target)) + eol;
  const text = lines.join("");

  // Whatever the splice did, the document must now read as it did, with that one cell filled.
  const after = load(text);
  const same = after !== undefined && after.key === key && after.items.length === before.items.length
    && after.diagnostics.join("\n") === before.diagnostics.join("\n")
    && after.items.every((item, i) => (i === row ? item.id === id && item.title === before.items[i]!.title && item.target === target : JSON.stringify(item) === JSON.stringify(before.items[i])));
  return same ? { ok: true, text } : unwritable(`row ${row + 1}: ${JSON.stringify(target)} cannot be written into its cell and read back as itself`);
}

/** The item bound to `target`. An empty target is no binding: an unbound row is a to-do, and it matches nothing. */
export function itemFor(items: readonly BacklogItem[], target: string): BacklogItem | undefined {
  return target === "" ? undefined : items.find((i) => i.target === target);
}
