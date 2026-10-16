// The three model verbs over a workspace, answered as the text a model reads.
// Shared by every host that reaches Gemflow through tools: the Claude Code
// bridge and the MCP server.
import type { VerbName } from "./core/verb-specs.js";
import type { Status, Workspace } from "./workspace.js";

/** A verb's answer; `context` is the new stage text when an accepted verb changed the stage. */
export interface VerbAnswer { ok: boolean; text: string; context?: string }

export function statusForModel(s: Status): string {
  const lines = [`[gemflow] workflow ${s.workflow.name} (${s.workflow.path})`];
  if (s.item.kind === "inactive") {
    lines.push(`not tracking: ${s.item.reason}`);
    return lines.join("\n");
  }
  lines.push(`work item ${s.item.id} · state ${s.state?.id ?? "?"} · rev ${s.state?.rev ?? 0}`);
  const vars = Object.entries(s.vars).map(([k, v]) => `${k}=${JSON.stringify(v)}${s.sources[k] !== undefined ? ` (${s.sources[k]})` : ""}`);
  lines.push(`variables: ${vars.length ? vars.join(", ") : "none"}`);
  const next = s.next.map((t) => {
    const who = t.approval ? "a person approves it" : t.judge === "machine" ? "on its own" : "by move";
    const guard = t.guard !== undefined ? `, when ${t.guard}${t.judge === "machine" ? ` (${t.holds ? "holds" : `does not hold: ${t.missing.join(", ")}`})` : ""}` : "";
    return `${t.to} ${who}${guard}`;
  });
  lines.push(`next: ${next.length ? next.join("; ") : "none (final state)"}`);
  if (s.paused) lines.push("paused: a person holds this work item; evidence is recorded, no transition is taken until they resume it (gemflow resume)");
  if (s.gh !== undefined && !s.gh.available) lines.push(`git evidence unavailable: ${s.gh.reason}`);
  lines.push(`refusals ${s.refusals}`);
  return lines.join("\n");
}

/** What `status` answers for the stage text before the first one exists. */
export const NO_STAGE_CONTEXT = "[gemflow] no stage context yet";

const APPROVAL_HINT = " — a person approves it on the Gemflow board (/gemflow board) or with `gemflow advance <state>`";

export function runVerb(ws: Workspace, name: VerbName, args: Record<string, unknown>, callId?: string): VerbAnswer {
  switch (name) {
    case "status":
      return { ok: true, text: `${statusForModel(ws.status())}\n\n${ws.context() ?? NO_STAGE_CONTEXT}` };
    default: {
      const r = ws.verb(name, args, callId);
      if (r.ok) return { ok: true, text: JSON.stringify(r.result), ...(r.context !== undefined ? { context: r.context } : {}) };
      return { ok: false, text: `refused: ${r.reason}${/needs a person/.test(r.reason) ? APPROVAL_HINT : ""}` };
    }
  }
}
