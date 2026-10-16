// The DeepSeek Harness adapter: Cordis on one side, the Supervisor on the other.
//
// Everything registers through `agent.ctx`, so a disposed agent takes its
// restriction, its guard, its three tools and its prompt contributions with it
// - the kernel's cascading teardown is the cleanup, and this module writes none
// of its own beyond ordering.
//
// No gate is decided here. The five gates of design 1.4.2 are answered by
// core/supervisor.ts and only translated here:
//   1  visibility      sup.allowedGlobals() -> agent.ctx.tools.restrict()
//   2  argument domain sup.specs()          -> re-registered scoped tools
//   3  cut-out         sup.deny()           -> agent.ctx.tools.guard()
//   4  human           sup.invoke()         -> the ApprovalGate (./approval.ts)
//   5  verb validation sup.invoke()         -> a thrown Error the model reads
import { resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { gateFor } from "./approval.js";
import { appendOrCreate, exists, readText } from "../../host-fs.js";
import { hasErrors, loadStatechart, type Statechart } from "../../core/statechart.js";
import type { Run } from "../../core/run.js";
import { metaFor, openRun, Supervisor, type ApprovalGate } from "../../core/supervisor.js";
import type { ToolSpec } from "../../core/tools.js";
import type { JsonValue } from "../../core/schema.js";
import { DEFAULT_STATECHART } from "../../core/layout.js";

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
  statechart: z.string().default(DEFAULT_STATECHART),
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

const nowIso = (): string => new Date().toISOString();

export function apply(ctx: Context, config: Config): void {
  ctx.on("agent/session-start", ({ agent, source }) => {
    // Synchronously, on purpose. `agent/session-start` is an `emit`: the loop
    // does not await its listeners, so an attach that yielded would leave the
    // first step of the first turn running against the unrestricted tool set.
    // Nothing in `attach` needs to await - the reads, the parse and the first
    // ledger append are all synchronous - so the window simply does not exist.
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
  const file = resolve(cwd, config.statechart ?? DEFAULT_STATECHART);

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
  const opened = openRun({
    sc,
    session: String(agent.id),
    statechartFile: file,
    ledgerText: exists(ledgerPath) ? readText(ledgerPath) : null,
    source,
    now: nowIso(),
  });
  if (!opened.ok) {
    // D-B2: a ledger that contradicts itself is worse than none - resuming
    // from it would put the agent in a state nobody wrote, with the audit
    // trail asserting otherwise.
    log.error(`${ledgerPath}: ${opened.reason}; leaving this agent unsupervised`);
    return null;
  }
  if (opened.note) log.warn(`${ledgerPath}: ${opened.note}`);

  const head = opened.head;
  const append = (block: string): void => appendOrCreate(ledgerPath, head, block);

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

  const sup = new Supervisor(sc, opened.run, {
    append,
    approve: gate,
    now: nowIso,
    changed: () => refresh(),
    notify: tell,
    agent,
  });
  sup.setNotice(opened.notice);
  for (const block of opened.blocks) append(block);

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

  function toolFor(spec: ToolSpec): () => void {
    return agent.ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: spec.output.schema,
        render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: (async (args: Record<string, unknown>, exec: { callId: unknown; concludeTurn(): void }) => {
        const outcome = await sup.invoke(spec.name, args, metaFor(nowIso(), exec.callId));
        if (!outcome.ok) throw new Error(outcome.reason);
        if (outcome.concludesTurn) exec.concludeTurn();
        return outcome.result as Record<string, JsonValue>;
      }) as never,
    } as never));
  }

  /**
   * Recompute everything that depends on sigma: which global tools this agent
   * may see, and the three tools whose shape the state decides. Called after
   * every accepted action, which is what keeps gates 1 and 2 honest.
   */
  function refresh(): void {
    if (stopped) return;
    refreshing = true;
    try {
      for (const dispose of toolDisposers.splice(0)) dispose();
      restriction?.();
      restriction = undefined;

      const visibility = sup.allowedGlobals(ctx.tools.schemas().map((s) => s.name));
      // `restrict` refuses an empty filter, and the supervisor never hands one
      // over: a state that admits nothing denies every global instead.
      if (visibility.kind === "allow") restriction = agent.ctx.tools.restrict({ allow: visibility.names });
      else if (visibility.kind === "deny") restriction = agent.ctx.tools.restrict({ deny: visibility.names });

      const specs = sup.specs();
      if (specs.transition) toolDisposers.push(toolFor(specs.transition));
      if (specs.set) toolDisposers.push(toolFor(specs.set));
      toolDisposers.push(toolFor(specs.rollback));
    } finally {
      refreshing = false;
    }
  }

  // Gate 3. Monotonic by construction: a guard may only deny, so nothing
  // registered later can turn one of these refusals back into permission.
  disposers.push(agent.ctx.tools.guard((exec) => sup.deny(exec.name, exec.callId)));

  // The state's own instruction, byte for byte, and the snapshot beneath it.
  disposers.push(agent.ctx.systemPrompt.section({
    name: "geml-agent:state",
    order: 400,
    text: () => sup.instruction(),
  }));
  disposers.push(agent.ctx.systemPrompt.context({
    name: "geml-agent:snapshot",
    order: 130,
    text: () => sup.context(),
  }));

  // An uncontrollable event: a tool failed. The supervisor cannot prevent it,
  // only respond - which is what `rollback-on-error` is. Serialised through
  // `settled` so a burst of failures appends in order.
  disposers.push(agent.ctx.on("tools/result", (exec, result) => {
    const code = result.error?.info?.code;
    const ev = {
      name: exec.name,
      callId: String(exec.callId),
      isError: result.isError,
      ...(code !== undefined ? { code: String(code) } : {}),
    };
    settled = settled.then(() => {
      sup.onToolResult(ev, metaFor(nowIso(), exec.callId));
    });
  }));

  // A tool registered after us - an MCP server, say - changes what `allow` can
  // name, so the restriction is recomputed. `refreshing` keeps our own
  // re-registration from re-entering this.
  disposers.push(ctx.on("tools/change", () => {
    if (!refreshing) refresh();
  }));

  refresh();

  return {
    run: sup.run,
    ledgerPath,
    whenSettled: () => settled,
    dispose: () => {
      // Order matters: the listeners come off FIRST. Unregistering a tool fires
      // `tools/change`, and a live listener would answer it by putting the whole
      // set back - measured, not hypothetical.
      stopped = true;
      for (const dispose of disposers.splice(0)) dispose();
      for (const dispose of toolDisposers.splice(0)) dispose();
      restriction?.();
      restriction = undefined;
    },
  };
}
