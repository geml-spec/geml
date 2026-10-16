// Where a file unit's work item stands, kept in the item file's own meta under
// the key the workflow names (`flow-state-key`) — so it travels with the file
// through git to a machine the journal never reached. The journal stays the
// record of how it got there. Pure: text in, text out; the workspace reads and
// writes the file.
import { unitSpans } from "@geml/geml";
import { planMetaWrite } from "@geml/geml/dist/coord.js";

/** A meta line of `key`. */
const keyLine = (key: string): RegExp => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);

/** The text split into lines with `\n`, whether it used CRLF, and its meta block's span (start line, end line exclusive), if it has one. */
function read(source: string): { lines: string[]; crlf: boolean; meta?: { start: number; end: number } } {
  const crlf = source.includes("\r\n");
  const text = source.replace(/\r\n?/g, "\n");
  const unit = unitSpans(text).find((u) => u.kind === "block" && u.type === "meta");
  return { lines: text.split("\n"), crlf, ...(unit !== undefined ? { meta: unit.span } : {}) };
}

const joined = (lines: readonly string[], crlf: boolean): string => {
  const text = lines.join("\n");
  return crlf ? text.replace(/\n/g, "\r\n") : text;
};

/**
 * The item file's text with its meta's `key` set to `state` — only that
 * value changes when the key is there; it is appended to the meta otherwise,
 * and a file with no meta gets one first. Undefined when the meta cannot take
 * the value.
 */
export function withItemState(source: string, key: string, state: string): string | undefined {
  const { lines, crlf, meta } = read(source);
  if (meta === undefined) return joined(["=== meta", `${key} = ${JSON.stringify(state)}`, "===", "", ...lines], crlf);
  const plan = planMetaWrite(key, state, lines.slice(meta.start + 1, meta.end - 1));
  if (!plan.ok) return undefined;
  return joined([...lines.slice(0, meta.start + 1), ...plan.body, ...lines.slice(meta.end - 1)], crlf);
}

/** The state the item file's meta names under `key`, or undefined. */
export function itemState(source: string, key: string): string | undefined {
  const { lines, meta } = read(source);
  if (meta === undefined) return undefined;
  const line = lines.slice(meta.start + 1, meta.end - 1).find((l) => keyLine(key).test(l));
  const value = line?.replace(keyLine(key), "").trim();
  if (value === undefined || value === "") return undefined;
  try {
    const v: unknown = JSON.parse(value);
    return typeof v === "string" ? v : undefined;
  } catch {
    return value;
  }
}

/**
 * The text without its meta's `key` line: what the work item holds, apart
 * from where it stands — so writing the state back is no change of the item
 * that would expire its evidence.
 */
export function withoutItemState(source: string, key: string): string {
  const { lines, crlf, meta } = read(source);
  if (meta === undefined) return source;
  const kept = lines.filter((l, i) => !(i > meta.start && i < meta.end - 1 && keyLine(key).test(l)));
  return kept.length === lines.length ? source : joined(kept, crlf);
}
