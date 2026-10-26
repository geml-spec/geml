// The tool dictionary (spec §5.3): the project's `.geml/tools.geml`, a `#tools`
// table with one row per tool — which use it is bound to (`for`), the states
// it is allowed or denied in, whether it is the use's preferred tool, and the
// parameters filled in when the model leaves them out. The workflow names
// uses; the dictionary binds them to this project's tools, and grows as the
// person answers. Pure: text in, rows and decisions out; the workspace reads
// and writes the file.
import { signalHeads, simpleCommands, withoutDataHereDocs, withoutQuoting } from "./command-line.js";
import { globToRegExp } from "./unit.js";
import type { JsonValue } from "./schema.js";
import type { FlowDiagnostic } from "./statechart.js";

export const TOOLS_FILE = "tools.geml";
export const TOOLS_TABLE = "tools";
export const COLUMNS = ["tool", "for", "allow", "deny", "default", "params"] as const;

export interface DictRow {
  /** The key pattern: a tool name (`Read`, `mcp__geml__*`) or a command (`Bash(npm test)`, `Bash(geml media todo * --check)`). */
  tool: string;
  /** The use it is bound to, when any. */
  for?: string;
  /** State ids, or `*`. */
  allow: string[];
  deny: string[];
  /** The use's preferred tool. */
  default: boolean;
  params?: Record<string, JsonValue>;
  /** 1-based row in the table. */
  row: number;
}

export interface Dictionary { rows: DictRow[]; diagnostics: FlowDiagnostic[] }

export const NAME = /^[\p{L}\p{N}_-]+$/u;

/** An empty dictionary: every call is the dictionary's to learn. */
export const EMPTY_DICTIONARY: Dictionary = { rows: [], diagnostics: [] };

// ---- keys and patterns ----------------------------------------------------------

export const RUN_KEY = /^Bash\((.*)\)$/s;

/** A command as a key reads: quoting removed, each run of blanks (the space and the tab: what the shell splits words at) one space. */
export const normalizedCommand = (command: string): string => withoutQuoting(command).replace(/[ \t]+/g, " ").trim();

/** A key of a tool that writes files: `<tool>(<path>)`, the path with `/` for separators. */
const PATH_KEY = /^([^()\s]+)\((.*)\)$/s;

/** Where a tool that writes files names the file: Claude Code's `file_path` and `notebook_path`, pi's and dsh's `path`. */
const PATH_FIELDS = ["file_path", "notebook_path", "path"] as const;

/**
 * The keys of one call (spec §5.3): the tool's name; for a tool that runs a
 * command line (`runTools`) one `Bash(<command>)` per simple command of the
 * line — the whole line as one key when it cannot be read as commands; for a
 * tool that writes files (`writeTools`) `<tool>(<path>)`, so a row can tell
 * one file from another (writing a matter from writing the code).
 */
export function keysOf(tool: string, input: Readonly<Record<string, unknown>> | undefined, runTools: readonly string[], writeTools: readonly string[] = []): string[] {
  if (writeTools.includes(tool)) {
    const path = PATH_FIELDS.map((f) => input?.[f]).find((v): v is string => typeof v === "string" && v !== "");
    return [path === undefined ? tool : `${tool}(${path.replace(/\\/g, "/")})`];
  }
  const command = typeof input?.["command"] === "string" ? (input["command"] as string) : undefined;
  if (command === undefined || !runTools.includes(tool)) return [tool];
  const parts = simpleCommands(command);
  return (parts === null || parts.length === 0 ? [command] : parts).map((c) => `Bash(${normalizedCommand(c)})`);
}

/**
 * The keys of a finished command line that may speak for evidence (spec
 * §5.2): one `Bash(<command>)` per simple command of a plain `&&` chain —
 * `commands` picks which (signalHeads' order) — and none when the line is
 * anything else, since its exit status says nothing about the command that
 * matched.
 */
export function evidenceKeys(command: string, commands?: readonly number[]): string[] | null {
  const all = signalHeads(command);
  if (all === null) return null;
  const heads = commands === undefined ? all : all.filter((_, i) => commands.includes(i));
  return heads.map((h) => `Bash(${normalizedCommand(h)})`);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A row's pattern as a regular expression over a key: `*` is any run of text;
 * a command pattern without `*` matches a prefix, whole words only — `wrangler
 * deploy` takes `wrangler deploy --env x`, not `wrangler deployments list`.
 */
function patternRe(pattern: string, anchoredStart: boolean): RegExp {
  const m = RUN_KEY.exec(pattern);
  if (m) {
    const inner = normalizedCommand(m[1]!);
    if (inner === "") return new RegExp(anchoredStart ? "^Bash\\(" : ""); // `Bash()`: every command
    const body = inner.split("*").map(escapeRe).join("[\\s\\S]*");
    return new RegExp(anchoredStart ? `^Bash\\(${body}(?=[\\s)]|$)` : `(?<![^\\s(])${body}(?=[\\s)]|$)`);
  }
  return new RegExp(`^${pattern.split("*").map(escapeRe).join("[\\s\\S]*")}$`);
}

/** A path pattern's glob as a test of a path's end: the match starts at a segment, `*` stays in one, `**` crosses them. */
const pathTailRe = (glob: string): RegExp => new RegExp(`(?:^|/)${globToRegExp(glob).source.replace(/^\^/, "")}`);

/**
 * Whether a row's `tool` pattern takes `key`. A command pattern takes a
 * command; a tool's name takes the tool, with any path; `<tool>(<glob>)` takes
 * the tool's calls on a path that ends in a match of the glob, so one row
 * holds for the file wherever the project lies.
 */
export function keyMatches(pattern: string, key: string): boolean {
  if (RUN_KEY.test(pattern) || RUN_KEY.test(key)) return RUN_KEY.test(pattern) === RUN_KEY.test(key) && patternRe(pattern, true).test(key);
  const k = PATH_KEY.exec(key);
  const p = PATH_KEY.exec(pattern);
  if (p) return k !== null && patternRe(p[1]!, true).test(k[1]!) && pathTailRe(p[2]!).test(k[2]!);
  return patternRe(pattern, true).test(k ? k[1]! : key);
}

/** The literal part of a pattern, for "the longest literal wins". */
export function literalLength(pattern: string): number {
  const m = RUN_KEY.exec(pattern);
  const s = m ? normalizedCommand(m[1]!) : pattern;
  return s.replace(/\*/g, "").length;
}

/** The row that takes `key`: among the matching rows, the one with the longest literal; undefined when none. */
export function bindingOf(dict: Dictionary, key: string): DictRow | undefined {
  let best: DictRow | undefined;
  for (const r of dict.rows) {
    if (!keyMatches(r.tool, key)) continue;
    if (best === undefined || literalLength(r.tool) > literalLength(best.tool)) best = r;
  }
  return best;
}

/** The preferred tool of a use: its `default` row, else the first row bound to it. */
export function preferred(dict: Dictionary, use: string): DictRow | undefined {
  return dict.rows.find((r) => r.for === use && r.default) ?? dict.rows.find((r) => r.for === use);
}

// ---- the decision (spec §5.3, steps 3–5) ------------------------------------------

export type KeyVerdict =
  | { key: string; kind: "allow"; use?: string }
  | { key: string; kind: "refuse"; reason: string }
  /** No row takes the key: the call is not the workflow's business, and goes through unclassified. */
  | { key: string; kind: "unknown" };

export type Decision =
  /** `unknown`: the keys no row takes — let through, unclassified (spec §5.3). */
  | { kind: "allow"; uses: string[]; unknown: string[] }
  /** `keys`: the keys refused, one reason each. */
  | { kind: "refuse"; reasons: string[]; keys: string[] };

/** Where a decision is made: the current state, the uses it declares, which states declare any use, and whether a use is a rule (fenced to them). */
export interface Scope { state: string; uses: readonly string[]; declaring: (use: string) => readonly string[]; fenced: (use: string) => boolean }

/**
 * One key against the dictionary in state S: bound to a use S declares →
 * allowed; bound to a use S does not → refused; else a written allow or deny;
 * else unknown. Whether an unknown command is safe to run is the host's
 * permission system's to judge, by its arguments' values; the dictionary only
 * says which use a call is, and so where it may run.
 */
export function judgeKey(dict: Dictionary, scope: Scope, key: string): KeyVerdict {
  const row = bindingOf(dict, key);
  const stateId = scope.state;
  // A reason names a file tool's call by the row that judged it (`Edit`, `Edit(.geml/matters/*)`), not by its path.
  const named = row !== undefined && PATH_KEY.test(key) && !RUN_KEY.test(key) ? row.tool : key;
  if (row?.for !== undefined) {
    if (scope.uses.includes(row.for)) return { key, kind: "allow", use: row.for };
    // Only a rule keeps a use to the states that declare it; any other use runs here too (its evidence counts only there).
    if (!scope.fenced(row.for)) return { key, kind: "allow" };
    const where = scope.declaring(row.for);
    return { key, kind: "refuse", reason: `${named} is ${row.for}, which is used only in ${where.length ? where.map((s) => `#${s}`).join(", ") : "no state"}; the workflow is in #${stateId}` };
  }
  if (row !== undefined) {
    if (row.deny.includes(stateId) || row.deny.includes("*")) return { key, kind: "refuse", reason: `you denied ${named} in ${row.deny.includes("*") ? "every state" : `#${stateId}`}` };
    if (row.allow.includes(stateId) || row.allow.includes("*")) return { key, kind: "allow" };
  }
  return { key, kind: "unknown" };
}

/** The call's decision from its keys: any key refused refuses the call; otherwise it is allowed, the keys no row takes named as unknown. */
export function decide(dict: Dictionary, scope: Scope, keys: readonly string[]): Decision {
  const verdicts = keys.map((k) => judgeKey(dict, scope, k));
  const refused = verdicts.filter((v): v is Extract<KeyVerdict, { kind: "refuse" }> => v.kind === "refuse");
  if (refused.length) return { kind: "refuse", reasons: refused.map((v) => v.reason), keys: refused.map((v) => v.key) };
  const unknown = verdicts.filter((v) => v.kind === "unknown").map((v) => v.key);
  return { kind: "allow", uses: [...new Set(verdicts.flatMap((v) => (v.kind === "allow" && v.use !== undefined ? [v.use] : [])))], unknown };
}

/**
 * Fenced uses, searched anywhere in a command line (spec §5.2): a command
 * pattern bound to a use the state does not declare, found in the line or in
 * its copy without quoting, refuses the call — so a wrapped deployment
 * (`bash -c "…"`, `npx …`) is refused too. Among the command patterns found
 * in the line the one with the longest literal speaks, as it does for a key:
 * `wrangler deploy*--env staging` (staging) wins over `wrangler deploy`
 * (production) in a staging deploy. A line that wraps two commands is read as
 * its longest one; the keys of a plain `&&` chain are judged one by one.
 */
export function fencedRefusal(dict: Dictionary, scope: Scope, command: string): string | undefined {
  const best = fencedRow(dict, scope, command);
  if (best?.for === undefined) return undefined;
  const where = scope.declaring(best.for);
  return `"${excerpt(command)}" is ${best.for}, which is used only in ${where.length ? where.map((s) => `#${s}`).join(", ") : "no state"}; the workflow is in #${scope.state}`;
}

/** The dictionary row that fences a command line in this state (fencedRefusal's reading), or undefined: its `tool` is the key a person waives. */
export function fencedRow(dict: Dictionary, scope: Scope, whole: string): DictRow | undefined {
  // The line's code: a here-document it writes as text (a test that mentions a deploy) runs nothing.
  const command = withoutDataHereDocs(whole) ?? whole;
  const plain = normalizedCommand(command);
  let best: DictRow | undefined;
  for (const r of dict.rows) {
    if (!RUN_KEY.test(r.tool)) continue;
    const re = patternRe(r.tool, false);
    if (!re.test(command) && !re.test(plain)) continue;
    if (best === undefined || literalLength(r.tool) > literalLength(best.tool)) best = r;
  }
  return best?.for === undefined || scope.uses.includes(best.for) || !scope.fenced(best.for) ? undefined : best;
}

const EXCERPT = 200;
function excerpt(command: string): string {
  if (command.length <= EXCERPT) return command;
  let end = EXCERPT;
  const last = command.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return command.slice(0, end) + "…";
}

/** The uses a finished call's keys are bound to, for the `tool` evidence: only keys bound to a use the state declares. */
export function usesOf(dict: Dictionary, scope: Scope, keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    const row = bindingOf(dict, k);
    if (row?.for !== undefined && scope.uses.includes(row.for)) out.add(row.for);
  }
  return [...out];
}

// ---- learning (spec §5.3, step 6) ----------------------------------------------------

export type Lesson =
  | { kind: "allow"; key: string; where: string | "*" }
  | { kind: "deny"; key: string; where: string | "*" }
  | { kind: "use"; key: string; use: string }
  | { kind: "default"; key: string; use: string }
  | { kind: "params"; key: string; params: Record<string, JsonValue> }
  /** The row of exactly that key goes: the tool is judged as if nobody had written it. */
  | { kind: "forget"; key: string };

/**
 * The dictionary with one lesson written in: an existing row of exactly that
 * key is changed, else a row is added. A key with a line break (a command
 * line that spans lines) is not learned: no table cell can hold it, and the
 * answer still decides the call it was given for.
 */
export function learn(dict: Dictionary, lesson: Lesson): Dictionary {
  if (/[\r\n]/.test(lesson.key)) return dict;
  if (lesson.kind === "forget") {
    const kept = dict.rows.filter((r) => r.tool !== lesson.key).map((r, i) => ({ ...r, allow: [...r.allow], deny: [...r.deny], row: i + 1 }));
    return { rows: kept, diagnostics: dict.diagnostics };
  }
  const rows = dict.rows.map((r) => ({ ...r, allow: [...r.allow], deny: [...r.deny] }));
  let row = rows.find((r) => r.tool === lesson.key);
  if (row === undefined) {
    row = { tool: lesson.key, allow: [], deny: [], default: false, row: rows.length + 1 };
    rows.push(row);
  }
  switch (lesson.kind) {
    case "allow":
      if (!row.allow.includes(lesson.where)) row.allow.push(lesson.where);
      row.deny = row.deny.filter((s) => s !== lesson.where);
      break;
    case "deny":
      if (!row.deny.includes(lesson.where)) row.deny.push(lesson.where);
      row.allow = row.allow.filter((s) => s !== lesson.where);
      break;
    case "use":
      row.for = lesson.use;
      if (!rows.some((r) => r !== row && r.for === lesson.use)) row.default = true;
      break;
    case "default":
      row.for = lesson.use;
      for (const r of rows) if (r.for === lesson.use) r.default = r === row;
      break;
    case "params":
      row.params = lesson.params;
      break;
  }
  return { rows, diagnostics: dict.diagnostics };
}
