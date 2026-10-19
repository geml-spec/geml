// Codex's hooks as Gemflow reads and answers them (spec §8.9): one command
// hook, `gemflow codex`, gets one JSON event on stdin — `hook_event_name`,
// `session_id`, `cwd`, and for a tool call `tool_name`, `tool_use_id`,
// `tool_input` (`command` for the shell tool and for `apply_patch`, whose
// "command" is the patch text) and, after it ran, `tool_response` — and
// answers one JSON object: `hookSpecificOutput` with `permissionDecision`
// deny or allow (`updatedInput` rewriting the call) and `additionalContext`
// the model reads. Codex's shell result carries no exit status, so a command
// whose status is evidence is wrapped to print `[gemflow exit N]` last and the
// status is read back from the output. Pure: the CLI side (src/codex.ts) does
// the files and the workspace.
import { CODEX_TOOLS } from "../../core/host-tools.js";
import type { CallFacts } from "../claude-code/fastpath.js";

export interface CodexEvent {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  /** Stop: the turn's last answer. */
  last_assistant_message?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The event Codex wrote to stdin; undefined when it is not one. */
export function readEvent(text: string): CodexEvent | undefined {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return undefined; }
  if (!isObject(v) || typeof v["hook_event_name"] !== "string") return undefined;
  const str = (k: string): string | undefined => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  return {
    hook_event_name: v["hook_event_name"] as string,
    ...(str("session_id") !== undefined ? { session_id: str("session_id") } : {}),
    ...(str("cwd") !== undefined ? { cwd: str("cwd") } : {}),
    ...(str("tool_name") !== undefined ? { tool_name: str("tool_name") } : {}),
    ...(str("tool_use_id") !== undefined ? { tool_use_id: str("tool_use_id") } : {}),
    ...(isObject(v["tool_input"]) ? { tool_input: v["tool_input"] } : {}),
    ...("tool_response" in v ? { tool_response: v["tool_response"] } : {}),
    ...(str("prompt") !== undefined ? { prompt: str("prompt") } : {}),
    ...(str("last_assistant_message") !== undefined ? { last_assistant_message: str("last_assistant_message") } : {}),
  };
}

/** The shell variable the wrapper keeps the status in. */
const STATUS = "__gemflow_status";

/**
 * A shell command that ends by printing its own exit status on a line of its
 * own and exits with it: the command runs in a subshell, so an `exit` inside
 * it ends only that; the status the host sees is the command's own.
 */
export function wrapCommand(command: string): string {
  return `( ${command} ); ${STATUS}=$?; printf '\\n[gemflow exit %s]\\n' "$${STATUS}"; exit $${STATUS}`;
}

export const isWrapped = (command: string): boolean => command.includes(`[gemflow exit %s]`) && command.includes(STATUS);

const WRAPPED = new RegExp(`^\\( ([\\s\\S]*) \\); ${STATUS}=\\$\\?; printf '\\\\n\\[gemflow exit %s\\]\\\\n' "\\$${STATUS}"; exit \\$${STATUS}$`);

/** The command a wrapped one ran: what the gate and the dictionary judge, and what the journal records. A command that was not wrapped is itself. */
export function unwrapCommand(command: string): string {
  const m = command.match(WRAPPED);
  return m !== null ? m[1]! : command;
}

/** The last `[gemflow exit N]` in a tool's response, whatever shape Codex gives it (a string, or strings under any keys); null when there is none. */
export function exitCodeIn(response: unknown): number | null {
  let last: number | null = null;
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\[gemflow exit (\d+)\]/g)) last = Number(m[1]);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (isObject(v)) Object.values(v).forEach(visit);
  };
  visit(response);
  return last;
}

/** The files an `apply_patch` patch adds, updates or deletes, in order, as the patch spells them. */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm)) out.push(m[1]!);
  return out;
}

/**
 * The call as the gate and the dictionary read it: `apply_patch` names its
 * files and no command line, so a patch's text is never scanned for fenced
 * or person-only commands; every other tool's input goes as it is.
 */
export function callOf(tool: string, input: Record<string, unknown>): CallFacts {
  if (CODEX_TOOLS.write.includes(tool)) {
    const patch = typeof input["command"] === "string" ? input["command"] : "";
    return { tool, input: { files: patchPaths(patch) } };
  }
  return { tool, input };
}

export type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse";

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: HookEventName;
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
}

export const denyCall = (reason: string): HookOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `gemflow: ${reason}` } });

/** The call goes on: rewritten when `updatedInput` is given, with a note for the model when `context` is. */
export function allowCall(updatedInput?: Record<string, unknown>, context?: string): HookOutput | undefined {
  if (updatedInput === undefined && context === undefined) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(updatedInput !== undefined ? { permissionDecision: "allow", updatedInput } : {}),
      ...(context !== undefined ? { additionalContext: context } : {}),
    },
  };
}

export const contextFor = (event: Exclude<HookEventName, "PreToolUse">, text: string): HookOutput => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

