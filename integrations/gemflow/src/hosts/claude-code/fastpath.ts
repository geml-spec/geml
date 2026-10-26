// The fast path: from the latest policy snapshot, decide per tool call whether
// the workflow can care about it, so most calls cost no spawn. Node-free: the
// hooks module imports it. A wrong answer here may cost a spawn, never skip
// one that matters: a call that could be refused or recorded is "consult",
// and the CLI's `before` decides and records it. Command lines are read with
// the functions the supervisor uses (command-line.ts) and the dictionary's own
// decisions (core/dictionary.ts) over the policy's rows, so the fast path and
// the CLI judge a call exactly alike; the person is asked here, in the hooks
// module (spec §5.3 step 6), and the answer goes through the bridge into the
// dictionary. "after" is asked whenever the workspace's `after`, or the fresh
// view of git it opens with, could answer differently. The policy is the
// session's work item's: a call that may act in another checkout
// (`elsewhere`, from checkoutProbe and the hooks module's look for `.git`) is
// always the bridge's to attribute and judge.
// test/fastpath-parity.test.mjs pins all this against a workspace and the
// bridge's attribution.
import type { FlowPolicy } from "../../core/policy.js";
import { changesDirectory, commandOf, personOnlyRefusal, runsGitOrGh, switchesWorkItemOnly } from "../../core/command-line.js";
import { bindingOf, decide, evidenceKeys, fencedRow, keysOf, preferred, type Dictionary, type Scope } from "../../core/dictionary.js";
import { CLAUDE_CODE_TOOLS, HOST_TOOLS } from "../../core/host-tools.js";
import { globToRegExp } from "../../core/unit.js";
import { isOwnTool, OWN_TOOL_PREFIX } from "../../core/verb-specs.js";
import { normalised, writtenPath } from "./readers.js";

export { isOwnTool, OWN_TOOL_PREFIX };

export interface CallFacts { tool: string; input: Record<string, unknown> }

export interface CallOutcome {
  isError: boolean;
  /** A run tool's exit status; null when it has none (backgrounded, interrupted). */
  exitCode?: number | null;
  /** The project-relative path a write tool touched. */
  wrotePath?: string;
  gitOperation: boolean;
  /** `before` was consulted and recorded something. */
  consulted: boolean;
}

/**
 * What the hooks module does before a call: let it through, ask the CLI's
 * `before` (which refuses and records), or ask the person about a tool that
 * is not its use's preferred one (spec §5.3, preferences). A key no row takes
 * passes: whether it is safe to run is the host's permission system's call.
 */
export type BeforeDecision =
  | { kind: "pass" }
  /** `waived`: keys a person let through once (the board's "allow once") that this call would be refused on; the CLI's `before` is told. */
  | { kind: "consult"; waived?: string[] }
  | { kind: "prefer"; key: string; use: string; preferred: string };

const PASS: BeforeDecision = { kind: "pass" };
const CONSULT: BeforeDecision = { kind: "consult" };

const isRun = (call: CallFacts): boolean => CLAUDE_CODE_TOOLS.run.includes(call.tool);

/** The policy's rows as the dictionary's decisions read them. */
const dictOf = (p: FlowPolicy): Dictionary => ({ rows: p.rows, diagnostics: [] });
const scopeOf = (p: FlowPolicy): Scope => ({ state: p.state, uses: p.uses, declaring: (use) => p.fences[use] ?? [], fenced: (use) => (p.rules ?? []).includes(use) });

/** Whether a written path is a work item of a `file:` unit. */
export function matchesUnit(p: FlowPolicy | null, path: string | undefined, units: readonly string[] = []): boolean {
  if (path === undefined) return false;
  if (p !== null && p.unit.kind === "file" && globToRegExp(p.unit.glob).test(path)) return true;
  // A workflow beside the current one takes it: a file of its own is its work item.
  return units.some((glob) => globToRegExp(glob).test(path));
}

/**
 * What tells the hooks module whether a call may act outside the session's
 * checkout: `elsewhere` outright when the command line moves the shell
 * (changesDirectory), or the call's directory — a written file's, else the one
 * the call starts in — is not under the root; otherwise the directories to look
 * in for a `.git` entry, from that directory up to the root, the root's own
 * excluded. A `.git` entry there is a checkout of its own (a worktree, another
 * repository) below the root.
 */
export function checkoutProbe(call: CallFacts, cwd: string, root: string): { elsewhere: true } | { elsewhere: false; dirs: string[] } {
  const command = commandOf(call.input);
  if (command !== undefined && changesDirectory(command)) return { elsewhere: true };
  const start = normalised(cwd);
  const base = normalised(root)?.replace(/\/+$/, "");
  const written = writtenPath(call.tool, call.input);
  const absolute = written !== undefined && /^(?:[A-Za-z]:)?[\\/]/.test(written);
  const file = written === undefined || start === undefined ? undefined : normalised(absolute ? written : `${start}/${written}`);
  const dir = written === undefined ? start : file?.slice(0, file.lastIndexOf("/"));
  if (dir === undefined || base === undefined || (dir !== base && !dir.startsWith(`${base}/`))) return { elsewhere: true };
  const dirs: string[] = [];
  for (let d = dir; d.length > base.length; d = d.slice(0, d.lastIndexOf("/"))) dirs.push(d);
  return { elsewhere: false, dirs };
}

export function beforeDecision(p: FlowPolicy | null, call: CallFacts, elsewhere = false, passes: readonly string[] = []): BeforeDecision {
  if (p === null || isOwnTool(call.tool)) return PASS;
  // Another checkout's work item judges a call made there, whatever this one's policy says.
  if (elsewhere) return CONSULT;
  if (!p.active) return PASS;
  const dict = dictOf(p);
  const scope = scopeOf(p);
  // The rules that hold in every state read the command line of any tool that has one (Bash, Monitor).
  const command = commandOf(call.input);
  if (command !== undefined) {
    if (personOnlyRefusal(command) !== undefined) return CONSULT;
    // Switching the work item is the way out of every state; a bare `git checkout <branch>` needs git to say it is a branch, so the CLI decides it.
    if (switchesWorkItemOnly(command)) return PASS;
    if (switchesWorkItemOnly(command, () => true)) return CONSULT;
    const fenced = fencedRow(dict, scope, command);
    // A fence a person waived for one call: the CLI is told, so it stands aside and records nothing.
    if (fenced !== undefined) return passes.includes(fenced.tool) ? { kind: "consult", waived: [fenced.tool] } : CONSULT;
  }
  const keys = keysOf(call.tool, call.input, CLAUDE_CODE_TOOLS.run, CLAUDE_CODE_TOOLS.write);
  const d = decide(dict, scope, keys);
  if (d.kind === "refuse") {
    const waived = d.keys.filter((k) => passes.includes(k));
    return waived.length === d.keys.length ? { kind: "consult", waived } : CONSULT;
  }
  // Allowed; a tool bound to a use whose preferred tool is another is asked about — by the row that binds it, so an
  // answer is a lesson about that row (`Write`), never about one call's key (`Write(src/a.ts)`). The tools that write
  // files are no choice between one another: Edit changes a file, Write makes one, so either is taken unasked.
  for (const key of keys) {
    const row = bindingOf(dict, key);
    if (row?.for === undefined) continue;
    const pref = preferred(dict, row.for);
    if (pref !== undefined && pref.tool !== row.tool && !(FILE_WRITERS.has(toolOf(row.tool)) && FILE_WRITERS.has(toolOf(pref.tool)))) {
      return { kind: "prefer", key: row.tool, use: row.for, preferred: pref.tool };
    }
  }
  return PASS;
}

/** Every host's tools that write files (Edit, Write, apply_patch, …). */
const FILE_WRITERS: ReadonlySet<string> = new Set(Object.values(HOST_TOOLS).flatMap((h) => h.write));
/** A row's tool name, without the path a write tool's key may carry (`Write(.geml/matters/*)`). */
const toolOf = (pattern: string): string => /^[^()\s]+/.exec(pattern)?.[0] ?? pattern;

export function afterNeeded(p: FlowPolicy | null, call: CallFacts, o: CallOutcome, elsewhere = false): boolean {
  if (p === null || isOwnTool(call.tool)) return false;
  if (elsewhere) return true;
  if (matchesUnit(p, o.wrotePath)) return true;
  const run = isRun(call);
  const command = run ? commandOf(call.input) : undefined;
  // A git operation, or git or gh run anywhere in the line: a branch switch or a reset carries no
  // gitOperation, and the answer's fresh view of git can name another work item, or the first one.
  if (o.gitOperation || (command !== undefined && runsGitOrGh(command))) return true;
  const dict = dictOf(p);
  const evidence = new Set(p.evidence);
  /** Whether a key is bound to a use some `tool` variable reads: the call's outcome is evidence somewhere. */
  const speaks = (key: string): boolean => {
    const row = bindingOf(dict, key);
    return row?.for !== undefined && evidence.has(row.for);
  };
  const keys = command !== undefined && typeof o.exitCode === "number" ? evidenceKeys(command) ?? [] : [];
  const signalled = keys.some(speaks);
  // Under a `file:` unit a command's evidence goes to the file its command names, with a current work item or none.
  if (signalled && p.unit.kind === "file") return true;
  if (!p.active) return false;
  if (o.consulted) return true;
  // A file the work wrote is one of its artifacts, recorded once per stage entry; a policy from before the field records every one.
  if (!o.isError && o.wrotePath !== undefined && !(p.written ?? []).includes(o.wrotePath)) return true;
  // The workspace reads the file variables again after every run tool: a render makes files as a write does.
  if (run && p.files.length > 0) return true;
  if (signalled) return true;
  // Any other tool bound to an evidence use: its error or success is `tool` evidence.
  if (!run && keysOf(call.tool, call.input, CLAUDE_CODE_TOOLS.run, CLAUDE_CODE_TOOLS.write).some(speaks)) return true;
  const path = o.wrotePath;
  return path !== undefined && p.files.some((f) => globToRegExp(f).test(path));
}

/**
 * The parameters a call leaves out that its tool's dictionary row fills in
 * (spec §5.3, preferences): for a tool whose input is structured data, never
 * a command line. Undefined when there is nothing to fill.
 */
export function paramsToFill(p: FlowPolicy | null, call: CallFacts): Record<string, unknown> | undefined {
  if (p === null || !p.active || isOwnTool(call.tool) || isRun(call)) return undefined;
  const row = bindingOf(dictOf(p), call.tool);
  if (row?.params === undefined) return undefined;
  const missing: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row.params)) if (call.input[k] === undefined) missing[k] = v;
  return Object.keys(missing).length > 0 ? missing : undefined;
}

export { preferAnswer, preferQuestion, type Answered } from "../../core/asking.js";
