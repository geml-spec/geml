// The supervisor, wired into DeepSeek Harness.
//
// Everything registers through `agent.ctx`, so a disposed agent takes its
// restriction, its guard, its three tools and its prompt contributions with it
// — the kernel's cascading teardown is the cleanup, and this module writes none
// of its own beyond ordering.
//
// The five gates of design §1.4.2 land here as:
//   1  visibility      agent.ctx.tools.restrict({ allow })
//   2  argument domain the `to` enum of the regenerated agent_transition
//   3  cut-out         agent.ctx.tools.guard() — monotonic, deny-only
//   4  human           the ApprovalGate (see ./approval.ts)
//   5  verb validation core/run.ts, which validates before it writes
import { resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { gateFor, type ApprovalGate } from "./approval.js";
import { appendOrCreate, exists, readText } from "./host-fs.js";
import { hasErrors, loadStatechart, outgoing, type State, type Statechart } from "./core/statechart.js";
import { resumeRun, startRun, type Run } from "./core/run.js";
import { renderContext } from "./core/prompt.js";
import { rollbackSpec, setSpec, transitionSpec, type ToolSpec } from "./core/tools.js";
import type { JsonValue } from "./core/schema.js";

/** Cordis plugin name, used by loader diagnostics. */
export const name = "geml-agent";

/** Services this plugin calls into. */
export const inject = ["tools", "agents", "systemPrompt"];

export interface Config {
  /** Statechart path; relative ones resolve against the session's working directory. */
  statechart?: string;
  /** Where each session's ledger is written, as `<ledgerDir>/<sessionId>.geml`. */
  ledgerDir: string;
  /** What to do when the session has no statechart: leave the agent alone, or fail its startup. */
  onMissing?: "skip" | "fail";
}

export const Config: z<Config> = z.object({
  statechart: z.string().default("agent.geml"),
  ledgerDir: z.string().required(),
  onMissing: z.union([z.const("skip"), z.const("fail")]).default("skip"),
});

/** A live supervision: the run, where it is being recorded, and how to stop. */
export interface Attached {
  readonly run: Run;
  readonly ledgerPath: string;
  /** Resolves once every deferred append (an error-rollback) has settled. */
  whenSettled(): Promise<void>;
  dispose(): void;
}

/** The names this plugin owns; the state gate never applies to them. */
const OURS = new Set(["agent_transition", "agent_set", "agent_rollback"]);

const nowIso = (): string => new Date().toISOString();

/** A refusal's text as the model should read it: the reason, then the detail. */
function refusalText(reason: string, diagnostics: readonly string[]): string {
  return diagnostics.length ? `${reason}\n${diagnostics.join("\n")}` : reason;
}

export function apply(ctx: Context, config: Config): void {
  ctx.on("agent/session-start", ({ agent, source }) => {
    // Synchronously, on purpose. `agent/session-start` is an `emit`: the loop
    // does not await its listeners, so an attach that yielded would leave the
    // first step of the first turn running against the unrestricted tool set.
    // Nothing in `attach` needs to await — the reads, the parse and the first
    // ledger append are all synchronous — so the window simply does not exist.
    try {
      attach(ctx, agent, source, config);
    } catch (error: unknown) {
      ctx.logger(name).error(error);
    }
  });
}

/**
 * Put one agent under supervision. Exported so tests can drive it directly:
 * the harness testkit publishes an agent without running a turn, and this is
 * the same entry point `agent/session-start` uses.
 *
 * @returns the live supervision, or null when this agent is left unsupervised
 *   (no statechart, or a ledger that does not verify).
 */
export function attach(
  ctx: Context,
  agent: Agent,
  source: string,
  config: Config,
  gate: ApprovalGate = gateFor(ctx as unknown as { approval?: { request(req: unknown): Promise<string> } }),
): Attached | null {
  const log = ctx.logger(name);
  const onMissing = config.onMissing ?? "skip";
  const cwd = agent.session.header.cwd ?? process.cwd();
  const file = resolve(cwd, config.statechart ?? "agent.geml");

  let text: string;
  try {
    text = readText(file);
  } catch {
    if (onMissing === "fail") throw new Error(`geml-agent: no statechart at ${file}`);
    log.debug(`no statechart at ${file}; leaving this agent unsupervised`);
    return null;
  }

  const loaded = loadStatechart(text, file, { knownTools: ctx.tools.schemas().map((s) => s.name) });
  for (const d of loaded.diagnostics) {
    if (d.severity === "error") log.error(`${file}:${d.line}: ${d.code}: ${d.message}`);
    else log.warn(`${file}:${d.line}: ${d.code}: ${d.message}`);
  }
  if (!loaded.statechart || hasErrors(loaded.diagnostics)) {
    if (onMissing === "fail") throw new Error(`geml-agent: ${file} does not check out`);
    return null;
  }
  const sc: Statechart = loaded.statechart;

  // --- the run, fresh or resumed -------------------------------------------
  const ledgerPath = resolve(config.ledgerDir, `${String(agent.id)}.geml`);
  const ledgerMeta = {
    session: String(agent.id),
    statechart: file,
    statechartHash: sc.hash,
    created: nowIso(),
  };
  const opened = startRun(sc, ledgerMeta, nowIso());
  const head = opened.head;
  let run: Run;
  let notice = "";

  if (exists(ledgerPath)) {
    const resumed = resumeRun(sc, readText(ledgerPath));
    if (!resumed.ok) {
      // D-B2: a ledger that contradicts itself is worse than none — resuming
      // from it would put the agent in a state nobody wrote, with the audit
      // trail asserting otherwise.
      log.error(`${ledgerPath}: ${resumed.reason}; leaving this agent unsupervised`);
      return null;
    }
    run = resumed.run;
    if (resumed.note) {
      log.warn(`${ledgerPath}: ${resumed.note}`);
      notice = `[geml-agent] the statechart changed since this run started; the current state still exists and the run continues.`;
    }
    if (source === "clear") {
      const re = run.reenter(nowIso());
      appendOrCreate(ledgerPath, head, re.block);
    }
  } else {
    run = opened.run;
    appendOrCreate(ledgerPath, head, opened.block);
  }

  // --- registrations, all on agent.ctx -------------------------------------
  const disposers: (() => void)[] = [];
  const toolDisposers: (() => void)[] = [];
  let restriction: (() => void) | undefined;
  // `refreshing` keeps our own re-registration from re-entering the
  // `tools/change` listener; `stopped` keeps TEARDOWN from doing the same, which
  // it otherwise does: unregistering the first tool fires the change, and a
  // listener that is still live puts everything straight back.
  let refreshing = false;
  let stopped = false;
  let settled: Promise<void> = Promise.resolve();

  const stateNow = (): State | undefined => sc.states.get(run.snapshot.state);
  const append = (block: string): void => appendOrCreate(ledgerPath, head, block);
  const meta = (callId: unknown): { at: string; call?: string } =>
    callId === undefined ? { at: nowIso() } : { at: nowIso(), call: String(callId) };

  /** Tell the model something happened between its turns. */
  const tell = (summary: string, body: string): void => {
    try {
      agent.inject(createUserMessage({
        content: [{ type: "text", text: body }],
        source: { kind: "plugin", plugin: name, form: "notice", summary: summary.slice(0, 120) },
      }));
    } catch (error: unknown) {
      // An agent that cannot take context still has the snapshot, which carries
      // the same facts on its next step. Never let a notice break a tool call.
      log.debug(error);
    }
  };

  function toolFor(spec: ToolSpec, execute: (args: Record<string, unknown>, exec: { callId: unknown; concludeTurn(): void }) => Promise<Record<string, JsonValue>>): () => void {
    return agent.ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: spec.output.schema,
        render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: execute as never,
    } as never));
  }

  /**
   * Recompute everything that depends on σ: which global tools this agent may
   * see, and the three tools whose shape the state decides. Called after every
   * accepted action, which is what keeps gate 1 and gate 2 honest.
   */
  function refresh(): void {
    if (stopped) return;
    refreshing = true;
    try {
      for (const dispose of toolDisposers.splice(0)) dispose();
      restriction?.();
      restriction = undefined;

      const state = stateNow();
      const wanted = state?.tools ?? sc.defaultTools;
      if (wanted !== undefined) {
        const globals = ctx.tools.schemas().map((s) => s.name).filter((n) => !OURS.has(n));
        const allow = wanted.filter((n) => globals.includes(n));
        // `restrict` refuses an empty filter, so a state that admits nothing
        // denies everything global instead of allowing nothing.
        if (allow.length > 0) restriction = agent.ctx.tools.restrict({ allow });
        else if (globals.length > 0) restriction = agent.ctx.tools.restrict({ deny: globals });
      }

      const transition = transitionSpec(sc, run.snapshot);
      if (transition) {
        toolDisposers.push(toolFor(transition, async (args, exec) => {
          const to = String(args["to"]);
          const edge = outgoing(sc, run.snapshot.state).find((t) => t.to === to);
          if (!edge) throw new Error(`no transition from #${run.snapshot.state} to #${to}`);

          if (edge.approval) {
            const verdict = await gate({
              agent,
              toolName: "agent_transition",
              reason: `transition #${edge.id} → #${to} needs approval`,
            });
            if (verdict !== "allowed-once") {
              const reason = `transition #${edge.id}: approval was not granted`;
              append(run.refuse({ tool: "agent_transition", reason, diagnostics: [] }, meta(exec.callId)));
              throw new Error(reason);
            }
          }

          const advance = run.transition(to, meta(exec.callId));
          append(advance.block);
          if (!advance.ok) throw new Error(refusalText(advance.refusal.reason, advance.refusal.diagnostics));
          refresh();
          const target = sc.states.get(to);
          if (target?.pause === true || target?.final === true) exec.concludeTurn();
          return {
            from: advance.snapshot.from ?? "",
            to,
            rev: advance.snapshot.rev,
            hash: advance.snapshot.hash,
          };
        }));
      }

      const set = setSpec(sc, run.snapshot);
      if (set) {
        toolDisposers.push(toolFor(set, async (args, exec) => {
          const patch: Record<string, JsonValue> = {};
          for (const [key, value] of Object.entries(args)) {
            if (value !== undefined) patch[key] = value as JsonValue;
          }
          const advance = run.set(patch, meta(exec.callId));
          append(advance.block);
          if (!advance.ok) throw new Error(refusalText(advance.refusal.reason, advance.refusal.diagnostics));
          // A guard reads the variables, so writing one can open or close an edge.
          refresh();
          return { rev: advance.snapshot.rev, hash: advance.snapshot.hash, vars: advance.snapshot.vars };
        }));
      }

      toolDisposers.push(toolFor(rollbackSpec(), async (args, exec) => {
        const raw = String(args["to"]).trim();
        const target: number | "checkpoint" = raw === "checkpoint" ? "checkpoint" : Number(raw);
        if (target !== "checkpoint" && !Number.isInteger(target)) {
          throw new Error(`"${raw}" is neither a revision number nor "checkpoint"`);
        }
        const advance = run.rollback(target, meta(exec.callId));
        append(advance.block);
        if (!advance.ok) throw new Error(refusalText(advance.refusal.reason, advance.refusal.diagnostics));
        refresh();
        return {
          rev: advance.snapshot.rev,
          restores: advance.snapshot.restores ?? advance.snapshot.rev,
          state: advance.snapshot.state,
          hash: advance.snapshot.hash,
        };
      }));
    } finally {
      refreshing = false;
    }
  }

  // Calls this guard turned away. A denial and a tool body throwing produce the
  // same shape on `tools/result` — a message, no code — so the only way to tell
  // them apart is to remember which ones we refused ourselves. It matters:
  // nothing ran, so there is nothing for `rollback-on-error` to undo.
  const denied = new Set<string>();

  // Gate 3. Monotonic by construction: a guard may only deny, so nothing
  // registered later can turn one of these refusals back into permission.
  disposers.push(agent.ctx.tools.guard((exec) => {
    if (OURS.has(exec.name)) return undefined;
    const state = stateNow();
    const wanted = state?.tools ?? sc.defaultTools;
    if (wanted === undefined || wanted.includes(exec.name)) return undefined;
    denied.add(String(exec.callId));
    return `tool ${exec.name} is not available in state #${run.snapshot.state}`;
  }));

  // The state's own instruction, byte for byte, and the snapshot beneath it.
  disposers.push(agent.ctx.systemPrompt.section({
    name: "geml-agent:state",
    order: 400,
    text: () => stateNow()?.body ?? "",
  }));
  disposers.push(agent.ctx.systemPrompt.context({
    name: "geml-agent:snapshot",
    order: 130,
    text: () => (notice ? `${renderContext(sc, run.snapshot)}\n${notice}` : renderContext(sc, run.snapshot)),
  }));

  // An uncontrollable event: a tool failed. The supervisor cannot prevent it,
  // only respond — which is what `rollback-on-error` is.
  disposers.push(agent.ctx.on("tools/result", (exec, result) => {
    const callId = String(exec.callId);
    const wasDenied = denied.delete(callId);
    if (!result.isError || OURS.has(exec.name)) return;
    // A call the supervisor itself turned away, and one for a tool that does not
    // exist, never reached a body: there is no effect to compensate for, and
    // rolling back would burn a revision over the gate doing its job.
    if (wasDenied || result.error?.info?.code === "UNKNOWN_TOOL") return;
    if (stateNow()?.rollbackOnError !== true) return;
    const from = run.snapshot.rev;
    settled = settled.then(() => {
      const advance = run.errorRollback(meta(exec.callId));
      append(advance.block);
      if (!advance.ok) return;
      refresh();
      tell(
        `${exec.name} failed; variables rolled back to rev ${advance.snapshot.restores ?? from}`,
        `[geml-agent] \`${exec.name}\` failed in state #${advance.snapshot.state}. The workflow variables were rolled back to revision ${advance.snapshot.restores ?? from}. Recorded state is restored; anything the tool already did in the outside world is not.`,
      );
    });
  }));

  // A tool registered after us — an MCP server, say — changes what `allow` can
  // name, so the restriction is recomputed. `refreshing` keeps our own
  // re-registration from re-entering this.
  disposers.push(ctx.on("tools/change", () => {
    if (!refreshing) refresh();
  }));

  refresh();

  return {
    run,
    ledgerPath,
    whenSettled: () => settled,
    dispose: () => {
      // Order matters: the listeners come off FIRST. Unregistering a tool fires
      // `tools/change`, and a live listener would answer it by putting the whole
      // set back — measured, not hypothetical.
      stopped = true;
      for (const dispose of disposers.splice(0)) dispose();
      for (const dispose of toolDisposers.splice(0)) dispose();
      restriction?.();
      restriction = undefined;
    },
  };
}
