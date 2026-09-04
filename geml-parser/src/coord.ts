// GEP 0011: a coordinate addresses a unit INSIDE a block — a table's rows,
// cells and columns, or a node of a `data` block's value tree.
//
// Why this is its own module: every other address in §2 resolves to a unit of
// the document and is answered by slicing the file. A coordinate has no span —
// a cell is a few characters inside a body that a parser had to read to find
// them — so it is answered from the MODEL. Keeping that here leaves cli.ts with
// one shape of answer to print and one shape of refusal to report, and keeps
// this projection testable without a filesystem.
//
// The three token species (§0011: integer, "quoted string", bare word) are the
// selector's business; this module only interprets them against a block.
import { type Block, type DataValue, type Value } from "./geml.js";
import { type CoordStep } from "./selector.js";
import { type TableCell, type TableModel } from "./table.js";

export type CoordResult =
  /** `text` is what `geml get` prints; `json` is what `--json` answers. */
  | { ok: true; text: string; json: unknown }
  /** `why` is a whole sentence: it is the CLI's error message verbatim. */
  | { ok: false; why: string };

const miss = (why: string): CoordResult => ({ ok: false, why });

/** How a coordinate step reads back, for an error message. */
export function stepText(s: CoordStep): string {
  if (s.kind === "index") return `[${s.n}]`;
  if (s.kind === "word") return `[${s.name}]`;
  return `["${s.name}"]`;
}

export const pathText = (path: CoordStep[]): string => path.map(stepText).join("");

// The one column namespace (§6): a header name, or the letter that IS the name
// when the table has no header row. `compute=`/`summary=` resolve a column this
// way, and a coordinate must not invent a second rule for the same thing.
function columnIndex(model: TableModel, name: string): number {
  const byName = model.columns.indexOf(name);
  if (byName >= 0) return byName;
  if (/^[A-Z]$/.test(name)) {
    const i = name.charCodeAt(0) - 65;
    if (i < model.columns.length) return i;
  }
  return -1;
}

// An attribute value as a string, or undefined. Attributes are
// document-controlled, so `format=1` is a legal thing to write and the answer
// has to be "not a string" rather than a cast — asked once here so the two
// answers are exercised once rather than at three call sites.
const attrStr = (attrs: Record<string, Value>, key: string): string | undefined =>
  (typeof attrs[key] === "string" ? (attrs[key] as string) : undefined);

const cellJson = (c: TableCell): unknown => ({ text: c.text, ...(c.value !== undefined ? { value: c.value } : {}) });

// A row printed back as one line, in the body form the block was written in:
// a data body rejoins on its delimiter, a visual grid rebuilds its pipes. This
// is a rendering of the row, not a slice of the file — a borrowed or computed
// row has no line of its own to quote.
function rowText(block: Block & { kind: "block" }, cells: TableCell[]): string {
  const fmt = attrStr(block.attrs, "format");
  const texts = cells.map((c) => c.text);
  if (fmt === "tsv") return texts.join("\t");
  if (fmt === "csv") {
    return texts.join(`${delimOf(block.attrs)} `);
  }
  return `| ${texts.join(" | ")} |`;
}

// Why a `data` block has no value tree to address. GEP-0005 makes `format=`
// DECLARED, never sniffed: `json` (the default) and `jsonl` are parsed here,
// `yaml`/`toml` are reserved names, and anything else is unknown — the last two
// keep the body raw with a warning. Answering "no addressable units" for all of
// them would hide which case a reader is in.
function noValueTree(block: Block & { kind: "block" }): string {
  const fmt = attrStr(block.attrs, "format") ?? "json";
  if (fmt === "json" || fmt === "jsonl") {
    return `this \`data\` block's body did not parse as \`${fmt}\`, so it has no value tree to address`;
  }
  return `this \`data\` block declares \`format=${fmt}\`, which this processor keeps raw — there is no value tree to address`;
}

const delimOf = (attrs: Record<string, Value>): string => {
  const d = attrStr(attrs, "delim");
  return d !== undefined && d.length === 1 ? d : ",";
};

function projectTable(block: Block & { kind: "block" }, model: TableModel, path: CoordStep[]): CoordResult {
  const first = path[0]!;
  let cells: TableCell[] | undefined;
  let whatRow = "";

  if (first.kind === "index") {
    // 1-based over BODY rows: a header is not a row (§6's model draws that line
    // too). `[0]` is a typo rather than "the header", and saying so beats
    // answering with a row the author did not mean.
    if (first.n < 1) return miss(`a row index starts at 1 (the header is not a row), so \`${stepText(first)}\` addresses nothing`);
    cells = model.rows[first.n - 1];
    if (!cells) return miss(`this table has ${model.rows.length} body row${model.rows.length === 1 ? "" : "s"}, so \`${stepText(first)}\` addresses nothing`);
    whatRow = `row ${first.n}`;
  } else if (first.kind === "word") {
    if (first.name !== "summary") {
      return miss(`\`${stepText(first)}\` is not a row this table has — \`[summary]\` is the only reserved row name (GEP 0011)`);
    }
    if (!model.summary) return miss("this table has no `summary=` foot row, so `[summary]` addresses nothing");
    cells = model.summary;
    whatRow = "the summary row";
  } else {
    // A column: every body cell of it, top to bottom.
    if (path.length > 1) return miss(`a column takes no further step, so \`${pathText(path)}\` addresses nothing — write \`[<row>]["${first.name}"]\` for one cell`);
    const ci = columnIndex(model, first.name);
    if (ci < 0) return miss(`this table has no column \`${first.name}\` (it has ${model.columns.map((c) => `\`${c}\``).join(", ")})`);
    const column = model.rows.map((r) => r[ci]).filter((c): c is TableCell => c !== undefined);
    return { ok: true, text: column.map((c) => c.text).join("\n"), json: column.map(cellJson) };
  }

  if (path.length === 1) return { ok: true, text: rowText(block, cells), json: cells.map(cellJson) };

  const second = path[1]!;
  if (second.kind !== "key") return miss(`inside a row, a step names a column: write \`["<column>"]\` rather than \`${stepText(second)}\``);
  if (path.length > 2) return miss(`a cell takes no further step, so \`${pathText(path)}\` addresses nothing`);
  const ci = columnIndex(model, second.name);
  if (ci < 0) return miss(`this table has no column \`${second.name}\` (it has ${model.columns.map((c) => `\`${c}\``).join(", ")})`);
  const cell = cells[ci];
  if (!cell) return miss(`${whatRow} has no cell in column \`${second.name}\``);
  return { ok: true, text: cell.text, json: cellJson(cell) };
}

// A value tree walks by KEY into a map and by INDEX into a sequence, which is
// also how the two are told apart: a quoted step is a name, a bare integer a
// position. Sequences are 0-based here and rows are 1-based above — rows are
// lines a reader counts, a sequence is JSON (GEP 0011 records the asymmetry).
function projectValue(value: DataValue, path: CoordStep[]): CoordResult {
  let cur: DataValue = value;
  const walked: CoordStep[] = [];
  for (const step of path) {
    walked.push(step);
    const so_far = pathText(walked);
    if (step.kind === "word") return miss(`a value tree has no reserved names, so \`${stepText(step)}\` addresses nothing — quote it (\`["${step.name}"]\`) to name a key`);
    if (step.kind === "key") {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return miss(`\`${so_far}\` names a key, but what it steps into is ${describe(cur)}`);
      if (!Object.prototype.hasOwnProperty.call(cur, step.name)) {
        const above = pathText(walked.slice(0, -1));
        return miss(`no key \`${step.name}\` ${above === "" ? "at the root of this value tree" : `at \`${above}\``}`);
      }
      cur = (cur as { [k: string]: DataValue })[step.name]!;
      continue;
    }
    if (!Array.isArray(cur)) return miss(`\`${so_far}\` names a position, but what it steps into is ${describe(cur)}`);
    if (step.n < 0 || step.n >= cur.length) return miss(`\`${so_far}\` is out of range: that sequence has ${cur.length} element${cur.length === 1 ? "" : "s"}`);
    cur = cur[step.n]!;
  }
  return { ok: true, text: typeof cur === "string" ? cur : JSON.stringify(cur), json: cur };
}

function describe(v: DataValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a sequence";
  if (typeof v === "object") return "a map";
  return `a ${typeof v}`;
}

// --------------------------------------------------------------------------
// Writing (GEP 0011). A coordinate write replaces ONE unit and nothing else,
// which is why it is planned as a new BODY for the block rather than as a
// splice of its own: the caller already knows how to put a body back between
// two fences, guarded and re-parsed, and this way a coordinate write cannot
// reach past the block it names.
//
// Everything refused here is refused because the bytes are not there to change
// — a derived column, a foot row declared in an attribute, rows that arrived
// through `src=` — or because changing them would corrupt a neighbour, which
// in a delimited body means re-splitting the row.
// --------------------------------------------------------------------------

export type WritePlan = { ok: true; body: string[] } | { ok: false; why: string };

const oneLine = (v: string): boolean => !/[\r\n]/.test(v);

// The field extents of a delimited line, so a cell can be replaced without
// rejoining the whole row (which would eat the author's spacing).
function replaceField(line: string, sep: string, ci: number, value: string): string | null {
  const parts = line.split(sep);
  if (ci >= parts.length) return null;
  const m = /^(\s*)(.*?)(\s*)$/.exec(parts[ci]!)!;
  parts[ci] = m[1]! + value + m[3]!;
  return parts.join(sep);
}

function writeTable(block: Block & { kind: "block" }, model: TableModel, path: CoordStep[], value: string, body: string[]): WritePlan {
  const first = path[0]!;
  if (first.kind === "word") {
    if (first.name === "summary") {
      return { ok: false, why: "the summary row is declared in `summary=`, not written in the body — edit that attribute" };
    }
    return { ok: false, why: `\`${stepText(first)}\` is not a row this table has — \`[summary]\` is the only reserved row name` };
  }
  if (first.kind === "key") {
    return { ok: false, why: `a column is one unit per row and \`set\` writes one — address a cell: \`[<row>]["${first.name}"]\`` };
  }
  // The second write refusal, and it needs no special case: a grid that arrived
  // through `src=` has no lines here to rewrite.
  if (!model.rowLines) {
    return { ok: false, why: "these rows are not in this document — they arrive through `src=`, so edit the source they come from" };
  }
  if (first.n < 1) return { ok: false, why: `a row index starts at 1 (the header is not a row), so \`${stepText(first)}\` addresses nothing` };
  const cells = model.rows[first.n - 1];
  const lineIdx = model.rowLines[first.n - 1];
  if (!cells || lineIdx === undefined) {
    return { ok: false, why: `this table has ${model.rows.length} body row${model.rows.length === 1 ? "" : "s"}, so \`${stepText(first)}\` addresses nothing` };
  }
  const line = body[lineIdx];
  if (line === undefined) return { ok: false, why: "that row has no line in this body — it was not parsed from one" };
  if (!oneLine(value)) return { ok: false, why: "a row is one line; the replacement spans several" };

  const out = [...body];
  if (path.length === 1) {
    out[lineIdx] = value;
    return { ok: true, body: out };
  }

  const second = path[1]!;
  if (second.kind !== "key") return { ok: false, why: `inside a row, a step names a column: write \`["<column>"]\` rather than \`${stepText(second)}\`` };
  if (path.length > 2) return { ok: false, why: `a cell takes no further step, so \`${pathText(path)}\` addresses nothing` };
  const ci = columnIndex(model, second.name);
  if (ci < 0) return { ok: false, why: `this table has no column \`${second.name}\` (it has ${model.columns.map((c) => `\`${c}\``).join(", ")})` };
  // The first write refusal: a computed column is not in the source at all.
  if (cells[ci]?.computed) {
    return { ok: false, why: `column \`${second.name}\` is produced by \`compute=\`, so it has no bytes in the body — edit the formula` };
  }

  const fmt = attrStr(block.attrs, "format");
  if (fmt === "csv" || fmt === "tsv") {
    const d = fmt === "tsv" ? "\t" : delimOf(block.attrs);
    // The third refusal. A data body splits on the delimiter and does nothing
    // more — it does not dequote — so a value carrying one would silently turn
    // one cell into two and shift every cell after it.
    if (value.includes(d)) {
      const shown = d === "\t" ? "a tab" : `\`${d}\``;
      return { ok: false, why: `that value contains ${shown}, the delimiter this body splits on, so writing it would re-split the row — use a visual pipe grid, or \`delim=\` to split on something the data does not contain` };
    }
    const rewritten = replaceField(line, d, ci, value);
    if (rewritten === null) return { ok: false, why: `row ${first.n} has ${line.split(d).length} field${line.split(d).length === 1 ? "" : "s"}, so column ${ci + 1} has nothing to write` };
    out[lineIdx] = rewritten;
    return { ok: true, body: out };
  }

  // A visual grid: the row is rebuilt from its cells, which is also what
  // re-pads it. `|` cannot appear in a cell of a form whose delimiter it is.
  if (value.includes("|")) {
    return { ok: false, why: "that value contains `|`, which a visual grid splits on — use `format=csv` (with a `delim=` the data does not contain) for cells that carry pipes" };
  }
  const texts = cells.map((c) => c.text);
  texts[ci] = value;
  out[lineIdx] = `| ${texts.join(" | ")} |`;
  return { ok: true, body: out };
}

// A value-tree write rewrites the node and re-serializes the body, which
// GEP-0005 already makes canonical for a JSON body. The new text is read as
// JSON when it parses as JSON and as a string when it does not, so `1.3.0`
// stays a string while `42` and `{"a":1}` arrive as themselves.
// The caller has already established there IS a value tree — a block without
// one never reaches here, it is refused by name above.
function writeValue(block: Block & { kind: "block" }, path: CoordStep[], value: string, root: DataValue): WritePlan {
  let parsed: DataValue;
  try { parsed = JSON.parse(value) as DataValue; } catch { parsed = value; }

  // Walk to the PARENT of the target with the READ projection, so the two
  // paths cannot disagree about what a wrong turn is called. It hands back the
  // node itself, and the node is a reference into `root`, so the write below
  // lands in the tree this function re-serializes. Writing the walk a second
  // time here duplicated every message — and every message's branch.
  const parent = projectValue(root, path.slice(0, -1));
  if (!parent.ok) return { ok: false, why: parent.why };
  const cur = parent.json as DataValue;

  const last = path[path.length - 1]!;
  if (last.kind === "word") return { ok: false, why: `a value tree has no reserved names, so \`${stepText(last)}\` addresses nothing` };
  if (last.kind === "key") {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return { ok: false, why: `\`${pathText(path)}\` names a key, but what it steps into is ${describe(cur)}` };
    // A key that does not exist yet is CREATED: a write that only ever
    // overwrites cannot fill in a document's own configuration.
    (cur as { [k: string]: DataValue })[last.name] = parsed;
  } else {
    if (!Array.isArray(cur)) return { ok: false, why: `\`${pathText(path)}\` names a position, but what it steps into is ${describe(cur)}` };
    if (last.n < 0 || last.n >= cur.length) return { ok: false, why: `\`${pathText(path)}\` is out of range: that sequence has ${cur.length} element${cur.length === 1 ? "" : "s"} — \`set\` replaces a unit, it does not append` };
    cur[last.n] = parsed;
  }

  const fmt = attrStr(block.attrs, "format") ?? "json";
  if (fmt === "jsonl") {
    // One compact record per line, which is what the format is. A jsonl body
    // always parses to a sequence — the engine builds it — so this asserts the
    // shape rather than branching on it: a fallback arm would be a branch no
    // document could reach.
    return { ok: true, body: (root as DataValue[]).map((r) => JSON.stringify(r)) };
  }
  // Any other `format=` leaves the body raw with no value tree at all, so this
  // function was never entered for one: `planCoordWrite` reaches it only when
  // `block.value` is set, and only the json and jsonl engines set it.
  return { ok: true, body: JSON.stringify(root, null, 2).split("\n") };
}

// --------------------------------------------------------------------------
// `#meta` — the merged namespace (GEP 0011)
//
// §4 already defines this view: a document may carry several `meta` blocks and
// they merge key-wise, a later definition of the same key being a warning while
// the FIRST is kept. So every key has one defined value, and that view is what
// an author means by `#meta` — not any one of the blocks. It is the only address
// in §2 that names a derived thing rather than a span of the file, which is why
// `get` answers it with values rather than bytes.
// --------------------------------------------------------------------------

export interface MetaView {
  /** The merged keys, first definition winning. */
  value: Record<string, DataValue>;
  /** Every `meta` block, in document order — index 0 is where a new key goes. */
  blocks: Array<Block & { kind: "block" }>;
  /** Which block holds the definition in force for a key. */
  owner: Map<string, number>;
}

export function metaView(children: Block[]): MetaView {
  const blocks: Array<Block & { kind: "block" }> = [];
  const walk = (bs: Block[]): void => {
    for (const b of bs) {
      if (b.kind !== "block") continue;
      if (b.type === "meta") blocks.push(b);
      if (b.children) walk(b.children);
    }
  };
  walk(children);

  const value: Record<string, DataValue> = {};
  const owner = new Map<string, number>();
  blocks.forEach((b, i) => {
    for (const [k, v] of Object.entries(b.data ?? {})) {
      if (owner.has(k)) continue; // §4: the first definition is the one in force
      value[k] = v as DataValue;
      owner.set(k, i);
    }
  });
  return { value, blocks, owner };
}

/** The view as a `meta` body reads: one `key = value` line per key. */
export function metaText(view: MetaView): string {
  return Object.entries(view.value).map(([k, v]) => `${k} = ${metaLiteral(v)}`).join("\n");
}

// A meta value as §4 writes one: a bare number or boolean, anything else
// quoted. Same rule the value-tree write uses for reading a value back in, so
// `1.3.0` stays a string and `42` is a number.
function metaLiteral(v: DataValue): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
}

/**
 * Plan the write of one meta key into the body of the block that owns it.
 *
 * A key already there keeps its own spelling and spacing — only the value
 * changes. A key defined nowhere is appended, which is how `set` can fill in a
 * document's configuration rather than only overwrite it.
 */
export function planMetaWrite(key: string, value: string, body: string[]): WritePlan {
  if (!oneLine(value)) return { ok: false, why: "a meta value is one line; the replacement spans several" };
  let parsed: DataValue;
  try { parsed = JSON.parse(value) as DataValue; } catch { parsed = value; }
  const literal = metaLiteral(parsed);

  const out = [...body];
  const at = out.findIndex((l) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(l));
  if (at >= 0) {
    out[at] = out[at]!.replace(/^(\s*[^=]*=\s*).*$/, (_m, lead: string) => lead + literal);
    return { ok: true, body: out };
  }
  // Append after the last non-blank line, so a body that ends in a blank line
  // does not grow a gap in the middle of its own keys.
  let end = out.length;
  while (end > 0 && out[end - 1]!.trim() === "") end--;
  out.splice(end, 0, `${key} = ${literal}`);
  return { ok: true, body: out };
}

/**
 * Plan a coordinate write as the block's new body lines.
 *
 * `body` is the block's current body — the lines between its fences — and the
 * plan is the same lines with exactly one unit changed. Every refusal names
 * what is missing rather than what was asked.
 */
export function planCoordWrite(block: Block, path: CoordStep[], value: string, body: string[]): WritePlan {
  if (path.length === 0) return { ok: false, why: "a coordinate needs at least one `[…]` step" };
  if (block.kind !== "block") return { ok: false, why: `a coordinate writes a unit inside a table or a \`data\` block; \`${block.kind}\` has none` };
  if (block.type === "view") return { ok: false, why: "a view has no body rows to write — edit the source relation or this view's attributes" };
  if (block.table) return writeTable(block, block.table, path, value, body);
  if (block.value !== undefined) return writeValue(block, path, value, block.value);
  if (block.type === "meta") {
    // A `meta` block that carries an id of its own is written exactly as the
    // merged `#meta` is: by key, into the body that declares it. Refusing here
    // (as an earlier stage did) made `#m["title"]` and `#meta["title"]` behave
    // differently for what is the same operation on the same bytes.
    if (path.length === 1 && path[0]!.kind === "key") return planMetaWrite(path[0]!.name, value, body);
    return { ok: false, why: `a meta key is written as \`["<key>"]\` — one quoted key, and nothing deeper` };
  }
  if (block.type === "data") return { ok: false, why: noValueTree(block) };
  return { ok: false, why: `\`${block.type}\` carries no addressable units inside it — a coordinate needs a table or a \`data\` block` };
}

/**
 * Project a coordinate onto the block its base resolved to.
 *
 * The block is the one the id names; every refusal here is about what is
 * INSIDE it, so the caller can print `why` without adding context.
 */
export function projectCoord(block: Block, path: CoordStep[]): CoordResult {
  if (path.length === 0) return miss("a coordinate needs at least one `[…]` step");
  if (block.kind !== "block") {
    return miss(`a coordinate addresses a unit inside a table or a \`data\` block; \`${block.kind}\` has none`);
  }
  // A view HAS rows — its model is what the page renders — and GEP-0012 says a
  // coordinate on one "reads and never writes". Refusing the read too would
  // leave a document unable to reference the derived numbers most worth
  // referencing: `[[#busy[1]["Open"]]]` would fail on the very cell the reader
  // is looking at. The write is refused below, in `planCoordWrite`.
  // A view carries an empty model from the scan (like any `src=` block), so an
  // unresolved one has zero COLUMNS — a resolved view always has its source's,
  // even with no rows left. Saying "this table has 0 body rows" there would
  // describe the filter rather than the failure.
  if (block.type === "view" && (block.table === undefined || block.table.columns.length === 0)) {
    return miss("this view's `src=` did not resolve, so it has no rows to address");
  }
  if (block.table) return projectTable(block, block.table, path);
  if (block.value !== undefined) return projectValue(block.value, path);
  if (block.data !== undefined) return projectValue(block.data as DataValue, path);
  if (block.type === "data") return miss(noValueTree(block));
  return miss(`\`${block.type}\` carries no addressable units inside it — a coordinate needs a table or a \`data\` block`);
}
