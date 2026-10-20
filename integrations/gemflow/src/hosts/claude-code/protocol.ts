// The bridge between the Claude Code hooks module (no Node) and the bundled
// CLI (Node): one JSON request on the CLI's stdin, one JSON answer line on its
// stdout, both shaped here. Node-free: the hooks module imports this file.
import type { Flow, Overlay } from "@geml/geml/dist/statechart-svg.js";
import type { DictRow, Lesson } from "../../core/dictionary.js";
import type { FlowPolicy } from "../../core/policy.js";
import type { JsonValue } from "../../core/schema.js";
import type { Judge } from "../../core/statechart.js";
import type { VerbName } from "../../core/verb-specs.js";
import type { Status } from "../../workspace.js";
import type { Suggestion } from "../../project.js";
import type { AttentionFacts } from "./attention.js";
import type { HostInfo } from "./env.js";

export type { VerbName } from "../../core/verb-specs.js";

export const PROTOCOL_VERSION = 1;
/** How long one bridge call may take before the hooks module lets the tool call through. */
export const BRIDGE_TIMEOUT_MS = 15_000;
/** Calls that ask git and gh, or copy files: refresh, board, use, add. */
export const SLOW_TIMEOUT_MS = 45_000;

/** gh's availability as the last answer reported it; a request carries it back so cheap ops need not ask gh. */
export type GhSeen = NonNullable<Status["gh"]>;

/**
 * `cwd` on before, after and learn: the absolute directory the call starts in —
 * the directory of the loop that makes it (the main loop's shell, a subagent's
 * worktree), read as the call begins. The call is attributed to the checkout
 * and work item it acts in. The CLI reads a request that has none (a test's,
 * another client's) as starting at the root. `delivered` on after and verb,
 * for a call of the main loop only: `<item>@<rev>` of the stage text the main
 * loop last read; an answer on another work item hands that item over
 * (`handoff`).
 */
export type BridgeOp =
  /** `migrate`: a session's first status, which moves the earlier layout into the project's home first. */
  | { op: "status"; migrate?: boolean }
  | { op: "refresh" }
  /** `waived`: keys (dictionary keys, command patterns) a person let through for this one call (the board's "allow once"); nothing is learned. */
  | { op: "before"; tool: string; callId: string; input: Record<string, unknown>; cwd: string; waived?: string[] }
  | { op: "after"; tool: string; callId: string; input: Record<string, unknown>; isError: boolean; exitCode?: number | null; wrotePath?: string; gitOperation: boolean; cwd: string; delivered?: string }
  | { op: "verb"; name: VerbName; args: Record<string, unknown>; callId?: string; delivered?: string }
  /** A person's answer about a call (spec §5.3 step 6), written into the dictionary of the work item the call is attributed to. */
  | { op: "learn"; lessons: Lesson[]; tool: string; input: Record<string, unknown>; cwd: string }
  | { op: "mark"; variable: string; checked: boolean }
  | { op: "advance"; to: string }
  /** A person holds the work item, or lets it go (spec §5.5). */
  | { op: "pause" }
  | { op: "resume" }
  /** A new work item's file, made at a person's word: its meta `title` and `by`, then its text. The path must be one a flow's file unit takes, and not there yet. */
  | { op: "new-item"; path: string; title: string; text: string }
  /** A person restores an earlier revision's state and variables (`gemflow rollback <rev>`). */
  | { op: "rollback"; rev: number }
  | { op: "bind"; id: string }
  | { op: "use"; workflow: string }
  | { op: "add"; workflow?: string }
  /** Write a workflow from a path (a directory with flow.geml, or a .geml file) into the project's .geml/workflows/; answers `added`. */
  | { op: "import"; path: string }
  | { op: "board" }
  /** What the repository says for the band (attention.ts): branches ahead of their upstream, open pull requests and their checks. */
  | { op: "attention" }
  /**
   * Write a file under `.geml/exports/` and answer its path and text: the work
   * item's journal (as GEML, a Markdown revision table, or JSON), a copy of the
   * work item's workflow directory, or `text` the shell built (the share
   * dialog, a session export). `strip` takes the project's and the home
   * directory's absolute paths out of the text first.
   */
  | { op: "export"; kind: "journal" | "workflow" | "text"; format: "geml" | "md" | "json"; name?: string; text?: string; strip?: boolean };

export type BridgeRequest = { v: 1; root: string; lastFile?: string; gh?: GhSeen } & BridgeOp;

export interface ShellStatus {
  status: Status | null;
  policy: FlowPolicy | null;
  /** `<item>@<rev>` of .geml/context.geml; null when there is none. */
  contextKey: string | null;
  /** Why there is no status; quiet when the project simply has no workflow. */
  problem?: { text: string; quiet: boolean };
  /** No workflow yet: the bundled one that fits what the project holds, for the band's offer. */
  suggest?: Suggestion;
  /** The CLI's locale (`Intl`), for a shell that follows the system's language. */
  locale?: string;
  /** The plugin's and the parser's versions, as the CLI runs them. */
  versions?: { gemflow: string; parser: string };
  /** The globs of the workflows whose work items are files, the default's and those beside it: a file one takes is a work item. */
  units?: string[];
}

/** The most to-do items the band counts; past it the band shows `999+` (spec §7.2). */
export const TODO_CAP = 999;

/**
 * The work item's to-do count when its file is a geml-media entry (spec §7.2):
 * display only. `state` is the stage it was read in, and the band shows it only
 * while the work item is still in that stage. `count` stops at TODO_CAP + 1,
 * which reads "more than TODO_CAP".
 */
export interface TodoCount { item: string; state: string; count: number }

export type TimelineEntry =
  /** `changed`: the variables this revision changed, with their new values; `tree`: the content fingerprint `tool` evidence was stamped with. */
  | { kind: "snapshot"; rev: number; at: string; state: string; cause: string; by?: string; signal?: string; from?: string; restores?: number; call?: string; tree?: string; changed?: Record<string, JsonValue> }
  /** `key`: the dictionary key or command pattern the gate judged, when it judged one. */
  | { kind: "refused"; n: number; rev: number; at: string; tool: string; reason: string; call?: string; key?: string };

export interface BoardData {
  /** What one work item is: a branch, a file (`file:` unit), or a session (dsh). */
  unit: "branch" | "file" | "session";
  states: { id: string; title: string; description: string; initial: boolean; final: boolean; uses: string[] }[];
  /** The `elapsed` variables (spec §3.6): the clocks the flow page shows. */
  clocks: { name: string; iso: string; ms: number }[];
  /** The work item's content fingerprint now: a `tool` evidence entry whose `tree` differs has expired or will. */
  tree?: string;
  transitions: { name: string; from: string; to: string; judge: Judge; approval: boolean; guard?: string; note: string }[];
  /** Every use some state declares, with those states: a use is usable only in them. */
  fences: { use: string; states: string[] }[];
  /** The workflow's tool dictionary, as read. */
  tools: DictRow[];
  backlog: { key: "branch" | "file"; items: { id: string; title: string; target: string }[] } | null;
  /**
   * Every work item with a journal, the state its journal ends in, when its
   * journal was last written, whether a person holds it, its workflow when
   * that is not the default, and under a `file:` unit the file it is (when
   * still there), that file's meta `title` and its gist. `asks`: under the current
   * work item's workflow, the ways out of its state a person may take now
   * (theirs to take, the condition holding) while nobody holds it — each with
   * its button's words, its note, and whether it closes the work item.
   */
  items: BoardItem[];
  /** The current work item's journal: revisions and refusals, by revision. */
  timeline: TimelineEntry[];
  /** The flow picture (spec §8.2): what every host draws the flow tab from. */
  picture: FlowPicture;
  /** What the current work item's work made; absent when there is no work item or it has no journal yet. */
  products?: Products;
  /** The CI workflows that finished failing on the branch's head, and the head; absent when none did, or gh is not read. */
  ci?: { head: string; failed: string[] };
}

export interface BoardItem {
  id: string; state: string; rev: number; at: string; paused: boolean; workflow?: string; file?: string; title?: string;
  /** What the item file says first: its `#result` section's first line, else its text's; headings skipped. */
  gist?: string;
  /** The item file's meta `about`: `flow` or `tools` for a suggestion about the workflow or its dictionary. */
  about?: string;
  /** The item file's meta `by`: `model` for a work item the model raised itself. */
  by?: string;
  /** Its workflow's title; when its journal began; whether its state is final; the files it wrote, newest first. */
  flow?: string;
  /** Its state's title in its own flow. */
  stateTitle?: string;
  since?: string;
  final?: true;
  wrote?: string[];
  /** The work items it waits for (its file's meta `depends`), each done or not, and when it last moved. */
  depends?: { id: string; title?: string; done: boolean; at?: string }[];
  asks?: { to: string; label: string; note: string; final: boolean }[];
  /** Where it ended up, by git (the outline): being worked on, merged with its branch still there, closed, dropped. */
  end?: "doing" | "merged" | "closed" | "dropped";
  /** The worktree its branch is checked out in, relative to the main checkout; the commits its branch has of its own; its pull request. */
  worktree?: string;
  commits?: number;
  pr?: { number: number; state: "open" | "merged" | "closed" };
}

/**
 * What a work item's work made: the files its journal records as written,
 * newest first, one line per file; the commits git holds for its window, each
 * marked when it touched one of those files or the item file; and, under a
 * `file:` unit, the item file and its `#result` section.
 */
export interface Products {
  item: string;
  /** Under a `file:` unit: the item file, a project path. */
  file?: string;
  /** The item file's `#result` section without its heading; absent when the file has none. */
  result?: string;
  written: { path: string; rev: number; at: string; tool: string }[];
  /**
   * A branch's own commits; under a `file:` unit the ones made from the
   * journal's start until the item reached a final state, and any that
   * touched the item file. Newest first.
   */
  commits: { sha: string; at: string; subject: string; files: string[]; ours: boolean }[];
}

/**
 * The flow picture (spec §8.2): the chart's topology as the parser lays it
 * out (states by rank, edges by kind), what the runtime lays over it (the
 * current state, which ways out hold, the items per state, a hold, the
 * transition last taken, the ways out a person may take), and the same
 * picture as SVG for a surface that inlines markup. A host paints the first
 * two with its own elements, so a way out a person may take is a real button
 * wherever the board is drawn.
 */
export interface FlowPicture { flow: Flow; overlay: Overlay; svg: string }

export type BridgeResponse =
  | {
      v: 1; ok: true; shell: ShellStatus;
      refusal?: string;
      recorded?: boolean; entered?: string[];
      /** The new #current text, when the stage changed during this request, or the work item's stage text it hands over (`handoff`). */
      context?: string;
      /**
       * after and verb: the answer's work item is not the one whose stage the
       * main loop last read (the request's `delivered`). The line that goes
       * before `context`: `[gemflow] now on <item> · #<state> (new work item)`,
       * or `[gemflow] back on <item> · #<state> · rev <n> · <variable ✓|✗>…`.
       */
      handoff?: string;
      /**
       * after: the new stage text of another work item the call was attributed
       * to — another checkout's, or another file of the unit than the current
       * one. The subagent working there reads it; `shell` and `context` stay
       * the session's current work item's.
       */
      routed?: { item: string; context: string };
      text?: string; board?: BoardData;
      /** refresh and board: the work item's to-do count, or null when its file is no geml-media entry; every other answer leaves it out. */
      todo?: TodoCount | null;
      workflows?: string[]; installed?: string[]; added?: { name: string; activated: boolean };
      /** export: where the file went (project-relative, `/`-separated) and what it holds. */
      exported?: { path: string; text: string };
      /** attention: the repository's facts for the band. */
      attention?: AttentionFacts;
      /** attention: the machine and checkout the session runs on. */
      host?: HostInfo;
      /** The directory of the project's shared session logs (session-log.ts): the main working tree's .geml/sessions/. */
      sessions?: string;
    }
  /** No shell only when the request itself failed — it threw, or did not decode: the hooks module keeps the last shell and shows the error. */
  | { v: 1; ok: false; error: string; shell?: ShellStatus };

export function encodeRequest(req: BridgeRequest): string {
  return `${JSON.stringify(req)}\n`;
}

/** The last line of the CLI's stdout that parses as an answer of this version. */
export function decodeResponse(stdout: string): BridgeResponse | undefined {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]!) as { v?: unknown; ok?: unknown };
      if (v !== null && typeof v === "object" && v.v === PROTOCOL_VERSION && typeof v.ok === "boolean") return v as BridgeResponse;
    } catch {
      // not this line
    }
  }
  return undefined;
}

/**
 * The band's words for a bridge whose stdout held no answer. stderr's error
 * line says what went wrong (`Error: …`, `TypeError: …`, else its first line);
 * a module or package Node could not find means the plugin's bundle was never
 * built, so the words lead with the build to run.
 */
export function unreadableText(exitCode: number, stderr: string, pluginRoot: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const said = lines.find((l) => /^[A-Za-z]*Error\b[^:]*:/.test(l)) ?? lines[0] ?? "";
  if (/Cannot find (?:module|package)/.test(said)) return `gemflow：桥接没有构建 — 在 ${pluginRoot} 运行 npm run build（${said}）`;
  return `gemflow：桥接的应答无法解析（退出码 ${exitCode}${said ? `：${said}` : ""}）`;
}

const OPS = new Set(["status", "refresh", "before", "after", "verb", "learn", "mark", "advance", "pause", "resume", "rollback", "new-item", "bind", "use", "add", "import", "board", "attention", "export"]);
const EXPORT_KINDS = new Set(["journal", "workflow", "text"]);
const EXPORT_FORMATS = new Set(["geml", "md", "json"]);
const VERBS = new Set(["status", "move", "set"]);

/** One lesson as the hooks module sends it: its kind, its key, and the field that kind carries. */
export function isLesson(v: unknown): v is Lesson {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const l = v as Record<string, unknown>;
  if (typeof l["key"] !== "string" || l["key"] === "") return false;
  switch (l["kind"]) {
    case "allow": case "deny": return typeof l["where"] === "string" && l["where"] !== "";
    case "use": case "default": return typeof l["use"] === "string" && l["use"] !== "";
    case "params": return typeof l["params"] === "object" && l["params"] !== null && !Array.isArray(l["params"]);
    case "forget": return true;
    default: return false;
  }
}

/** One request, checked, a before, after or learn without `cwd` starting at the root; what the CLI cannot run is an error it answers with. */
export function decodeRequest(text: string): BridgeRequest | { error: string } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: "the request is not JSON" };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { error: "the request is not an object" };
  if (v["v"] !== PROTOCOL_VERSION) return { error: `protocol version ${String(v["v"])}; this CLI speaks ${PROTOCOL_VERSION}` };
  if (typeof v["root"] !== "string" || v["root"] === "") return { error: "root is required" };
  const op = v["op"];
  if (typeof op !== "string" || !OPS.has(op)) return { error: `unknown op ${String(op)}` };
  const str = (k: string): boolean => typeof v[k] === "string";
  const obj = (k: string): boolean => typeof v[k] === "object" && v[k] !== null && !Array.isArray(v[k]);
  const cwd = (): boolean => v["cwd"] === undefined || (str("cwd") && v["cwd"] !== "");
  const fields: Record<string, () => boolean> = {
    before: () => str("tool") && str("callId") && obj("input") && cwd() && (v["waived"] === undefined || (Array.isArray(v["waived"]) && (v["waived"] as unknown[]).every((k) => typeof k === "string"))),
    after: () => str("tool") && str("callId") && obj("input") && typeof v["isError"] === "boolean" && typeof v["gitOperation"] === "boolean" && cwd(),
    verb: () => str("name") && VERBS.has(v["name"] as string) && obj("args"),
    learn: () => Array.isArray(v["lessons"]) && (v["lessons"] as unknown[]).every(isLesson) && str("tool") && obj("input") && cwd(),
    mark: () => str("variable") && typeof v["checked"] === "boolean",
    advance: () => str("to"),
    rollback: () => Number.isInteger(v["rev"]) && (v["rev"] as number) >= 0,
    "new-item": () => str("path") && v["path"] !== "" && str("title") && str("text"),
    bind: () => str("id"),
    use: () => str("workflow"),
    import: () => str("path") && v["path"] !== "",
    export: () => EXPORT_KINDS.has(v["kind"] as string) && EXPORT_FORMATS.has(v["format"] as string)
      && (v["name"] === undefined || str("name")) && (v["text"] === undefined || str("text")) && (v["strip"] === undefined || typeof v["strip"] === "boolean")
      && (v["kind"] !== "text" || str("text")),
  };
  const check = fields[op];
  if (check !== undefined && !check()) return { error: `op ${op}: missing or mistyped fields` };
  if ((op === "before" || op === "after" || op === "learn") && v["cwd"] === undefined) return { ...v, cwd: v["root"] } as unknown as BridgeRequest;
  return v as unknown as BridgeRequest;
}
