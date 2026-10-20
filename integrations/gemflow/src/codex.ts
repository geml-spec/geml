// `gemflow codex`: Gemflow's Codex adapter (spec §8.9). Codex runs one command
// hook per event — a fresh process each time — so there is no module keeping
// a policy between calls: each event opens the workspace through the bridge's
// own `handleRequest`, in this process, and decides with the same functions
// the Claude Code module decides with. SessionStart and UserPromptSubmit hand
// the model the stage text (`.geml/context.geml` `#current`) when it is not
// what it last read; PreToolUse refuses what the gate refuses, fills a tool's
// default parameters, and wraps a shell command whose exit status is evidence
// so the status comes back in its output; PostToolUse reads it back and asks
// `after`, whose new stage text reaches the model as developer context. What
// the model last read is kept per session under `PLUGIN_DATA` (Codex's data
// directory for the plugin), else the temp directory. A person cannot be
// asked from a hook, so a call the dictionary has no decision on goes
// through with a note saying so. Nothing here ends the session: an event the
// adapter cannot read, a project with no workflow, an error — exit 0, no
// output, the reason on stderr.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { handleRequest } from "./bridge.js";
import { commandOf } from "./core/command-line.js";
import { bindingOf, evidenceKeys, TOOLS_FILE, type Dictionary } from "./core/dictionary.js";
import { dictionaryPathOf } from "./project-home.js";
import { CODEX_TOOLS } from "./core/host-tools.js";
import { CONTEXT_DOC } from "./core/layout.js";
import type { FlowPolicy } from "./core/policy.js";
import { isOwnTool } from "./core/verb-specs.js";
import { exists, readText } from "./host-fs.js";
import { afterNeeded, beforeDecision, paramsToFill } from "./hosts/claude-code/fastpath.js";
import type { BridgeOp, BridgeResponse } from "./hosts/claude-code/protocol.js";
import { contextOf, normalised } from "./hosts/claude-code/readers.js";
import { allowCall, callOf, contextFor, denyCall, exitCodeIn, isWrapped, patchPaths, readEvent, unwrapCommand, wrapCommand, type HookOutput } from "./hosts/codex/hook.js";
import type { Status } from "./workspace.js";
import { decisionsContext } from "./core/session-log.js";
import { appendSession, commits, decisionsFor, hostLabel, recordAnswer, recordFile, recordPrompt } from "./session-store.js";

export interface CodexRun { stdout: string; code: number }
const NOTHING: CodexRun = { stdout: "", code: 0 };


/** What the model has already read, kept per Codex session: the stage text, the other sessions' decisions up to a time; and whether a command in this turn committed. */
interface SessionState { delivered: string | null; decisionsSeen: string | null; committed: boolean }

function stateFileFor(env: NodeJS.ProcessEnv, session: string): string {
  const dir = env["PLUGIN_DATA"] !== undefined && env["PLUGIN_DATA"] !== "" ? env["PLUGIN_DATA"] : join(tmpdir(), "gemflow-codex");
  return join(dir, `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function readState(file: string): SessionState {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { delivered?: unknown; decisionsSeen?: unknown; committed?: unknown };
    return { delivered: typeof v.delivered === "string" ? v.delivered : null, decisionsSeen: typeof v.decisionsSeen === "string" ? v.decisionsSeen : null, committed: v.committed === true };
  } catch {
    return { delivered: null, decisionsSeen: null, committed: false };
  }
}

function writeState(file: string, state: SessionState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state), "utf8");
}

/** Whether a shell command's exit status is `tool` evidence: a key of it is bound to a use some `tool` variable reads. */
function speaksEvidence(policy: FlowPolicy, command: string): boolean {
  const keys = evidenceKeys(command);
  if (keys === null) return false;
  const dict: Dictionary = { rows: policy.rows, diagnostics: [] };
  const evidence = new Set(policy.evidence);
  return keys.some((k) => { const row = bindingOf(dict, k); return row?.for !== undefined && evidence.has(row.for); });
}

/** A patch's path as the bridge wants it: project-relative, `/`-separated; undefined outside the project. */
function projectPath(root: string, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const p = normalised(path);
  const base = normalised(root)?.replace(/\/+$/, "");
  if (p === undefined || base === undefined) return undefined;
  if (p.startsWith(`${base}/`)) return p.slice(base.length + 1);
  if (p.startsWith("/") || /^[A-Z]:/.test(p)) return undefined;
  return p === "" ? undefined : p;
}

const out = (o: HookOutput | undefined): CodexRun => (o === undefined ? NOTHING : { stdout: `${JSON.stringify(o)}\n`, code: 0 });

export async function runCodex(text: string, env: NodeJS.ProcessEnv, platform: string = process.platform): Promise<CodexRun> {
  const ev = readEvent(text);
  if (ev === undefined) return NOTHING;
  const root = resolve(ev.cwd ?? process.cwd());
  const file = stateFileFor(env, ev.session_id ?? "codex");
  const state = readState(file);
  const ask = (op: BridgeOp): Promise<BridgeResponse> => handleRequest({ v: 1, root, ...op });
  // The project's shared session record (session-store.ts): what fails to be written there is missed, never a broken hook.
  const sid = ev.session_id ?? "codex";
  const record = (f: () => void): void => { try { f(); } catch { /* the record misses this one */ } };

  /** The stage text, when the model has not read this `item@rev` yet and the item is the session's current one. */
  const deliver = (event: "SessionStart" | "UserPromptSubmit" | "PostToolUse", status: Status | null, always = false): HookOutput | undefined => {
    const doc = join(root, CONTEXT_DOC);
    if (!exists(doc)) return undefined;
    const seen = contextOf(readText(doc));
    if (seen === undefined || (!always && seen.key === state.delivered)) return undefined;
    const item = status?.item;
    if (item === undefined || item.kind !== "item" || item.id !== seen.item) return undefined;
    state.delivered = seen.key;
    writeState(file, state);
    return contextFor(event, seen.text);
  };

  switch (ev.hook_event_name) {
    case "SessionStart": {
      record(() => { appendSession(root, "codex", sid, () => []); });
      const res = await ask({ op: "status" });
      if (!res.ok || res.shell.status === null) return NOTHING;
      // The git facts first: a PR merged or CI finished since the last session may move the stage now.
      const fresh = await ask({ op: "refresh" });
      return out(deliver("SessionStart", (fresh.ok ? fresh.shell.status : null) ?? res.shell.status, true));
    }
    case "UserPromptSubmit": {
      // The prompt into the record; the other sessions' decisions not yet read beside it.
      let shared: string | undefined;
      record(() => {
        const now = new Date().toISOString();
        if (ev.prompt !== undefined && ev.prompt.trim() !== "") recordPrompt(root, "codex", sid, ev.prompt, now);
        const fresh = decisionsFor(root, sid, state.decisionsSeen, now);
        state.decisionsSeen = now;
        writeState(file, state);
        if (fresh.length > 0) shared = decisionsContext(fresh, (d) => `${hostLabel(d.host)}${d.branch !== undefined ? ` · ${d.branch}` : ""}，${new Date(d.at).toTimeString().slice(0, 5)}`);
      });
      const res = await ask({ op: "status" });
      const stage = res.ok && res.shell.status !== null ? deliver("UserPromptSubmit", res.shell.status) : undefined;
      if (shared === undefined) return out(stage);
      const before = stage?.hookSpecificOutput.additionalContext;
      return out(contextFor("UserPromptSubmit", before !== undefined ? `${before}\n\n${shared}` : shared));
    }
    case "PreToolUse": {
      const tool = ev.tool_name;
      if (tool === undefined || isOwnTool(tool)) return NOTHING;
      const input = ev.tool_input ?? {};
      const call = callOf(tool, input);
      const res = await ask({ op: "status" });
      if (!res.ok || res.shell.policy === null) return NOTHING;
      const { policy, status } = res.shell;
      const dictionary = status !== null ? dictionaryPathOf(status.workflow.path).split("\\").join("/") : TOOLS_FILE;
      let context: string | undefined;
      const decision = beforeDecision(policy, call);
      // The file-writing tools are no preference over one another (beforeDecision): apply_patch is taken as Edit is.
      if (decision.kind === "prefer") context = `[gemflow] ${decision.use}'s preferred tool is ${decision.preferred}; this call uses ${decision.key}.`;
      else if (decision.kind === "consult") {
        const before = await ask({ op: "before", tool, callId: ev.tool_use_id ?? "codex", input: call.input, cwd: root, ...(decision.waived !== undefined ? { waived: decision.waived } : {}) });
        if (before.ok && before.refusal !== undefined) return out(denyCall(before.refusal));
      }
      let updated: Record<string, unknown> | undefined;
      const fill = paramsToFill(policy, call);
      if (fill !== undefined) updated = { ...input, ...fill };
      // A shell command whose exit status is evidence prints it last, since Codex's result does not carry it. Not on Windows: the wrapper is POSIX shell.
      const command = CODEX_TOOLS.run.includes(tool) ? commandOf(input) : undefined;
      if (command !== undefined && policy.active && platform !== "win32" && !isWrapped(command) && speaksEvidence(policy, command)) updated = { ...(updated ?? input), command: wrapCommand(command) };
      return out(allowCall(updated, context));
    }
    case "PostToolUse": {
      const tool = ev.tool_name;
      if (tool === undefined || isOwnTool(tool)) return NOTHING;
      // Codex reports the command as it ran it — wrapped, when PreToolUse wrapped it; the journal records the command itself.
      const given = ev.tool_input ?? {};
      const raw = CODEX_TOOLS.run.includes(tool) ? commandOf(given) : undefined;
      const input = raw !== undefined && isWrapped(raw) ? { ...given, command: unwrapCommand(raw) } : given;
      const call = callOf(tool, input);
      // What the call made, into the record: the files a patch wrote; a commit, read at the turn's end.
      record(() => {
        if (CODEX_TOOLS.write.includes(tool)) for (const p of patchPaths(typeof input["command"] === "string" ? input["command"] : "")) { const path = projectPath(root, p); if (path !== undefined) recordFile(root, "codex", sid, path); }
        const command = CODEX_TOOLS.run.includes(tool) ? commandOf(input) : undefined;
        if (command !== undefined && commits(command) && !state.committed) { state.committed = true; writeState(file, state); }
      });
      const res = await ask({ op: "status" });
      if (!res.ok || res.shell.policy === null) return NOTHING;
      const exitCode = CODEX_TOOLS.run.includes(tool) ? exitCodeIn(ev.tool_response) : undefined;
      const wrotePath = CODEX_TOOLS.write.includes(tool) ? projectPath(root, patchPaths(typeof input["command"] === "string" ? input["command"] : "")[0]) : undefined;
      const isError = typeof exitCode === "number" && exitCode !== 0;
      if (!afterNeeded(res.shell.policy, call, { isError, gitOperation: false, consulted: false, ...(exitCode !== undefined ? { exitCode } : {}), ...(wrotePath !== undefined ? { wrotePath } : {}) })) return NOTHING;
      const after = await ask({
        op: "after", tool, callId: ev.tool_use_id ?? "codex", input: call.input, isError, gitOperation: false, cwd: root,
        ...(exitCode !== undefined ? { exitCode } : {}), ...(wrotePath !== undefined ? { wrotePath } : {}), ...(state.delivered !== null ? { delivered: state.delivered } : {}),
      });
      if (!after.ok || after.context === undefined) return NOTHING;
      if (after.shell.contextKey !== null) { state.delivered = after.shell.contextKey; writeState(file, state); }
      return out(contextFor("PostToolUse", after.handoff !== undefined ? `${after.handoff}\n${after.context}` : after.context));
    }
    // The turn's end: its answer, and the commits a command in it made, into the record. Nothing is said back.
    case "Stop": {
      record(() => {
        recordAnswer(root, "codex", sid, ev.last_assistant_message ?? "", state.committed);
        if (state.committed) { state.committed = false; writeState(file, state); }
      });
      return NOTHING;
    }
    default:
      return NOTHING;
  }
}
