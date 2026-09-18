// Sigma and the five gates, with no host in sight.
//
// Design section 3 gives this module one job: answer "what is allowed right
// now". An adapter translates those answers into its host's API and translates
// the host's tool events back into this alphabet. Nothing here knows whether it
// is running under a Cordis microkernel or a Pi extension, and nothing here
// touches the file system - test/purity.test.mjs pins both.
//
// The rule that makes two adapters safe: every gate DECISION lives here, so a
// host difference can only ever be a difference in mechanism, never in policy.
// The one place that is not true is stated in the design (6.5, gate 2: Pi
// cannot re-register a tool mid-session, so its `to` enum is wider) and the
// narrowing is still enforced here, by `invoke`.
import type { JsonValue } from "./schema.js";
import { effectiveTools, outgoing, type State, type Statechart } from "./statechart.js";
import type { Meta, Refusal, Snapshot } from "./snapshot.js";
import { resumeRun, startRun, type Run } from "./run.js";
import type { LedgerMeta } from "./ledger.js";
import { rollbackSpec, setSpec, transitionSpec, type ToolSpec } from "./tools.js";
import { renderContext } from "./prompt.js";

/** The three verbs this supervisor owns. Gates 1 and 3 never apply to them. */
export const VERBS: readonly string[] = ["agent_transition", "agent_set", "agent_rollback"];

export interface ApprovalRequest {
  /** The agent the question is asked on behalf of, when the host has such a thing. */
  agent?: unknown;
  /** The tool the question is about, for the audit record and any UI. */
  toolName: string;
  /** Why it is being asked, in words a person can act on. */
  reason: string;
}

/**
 * Ask a human. Anything other than `allowed-once` denies - a gate that fails
 * open is not a gate, so an absent service, a throw and an unrecognised answer
 * are all the same answer.
 */
export type ApprovalGate = (req: ApprovalRequest) => Promise<"allowed-once" | "denied">;

/** What the supervisor needs from its host: four callbacks and an identity. */
export interface SupervisorHost {
  /** Append one ledger block. Where it goes is the host's business (5.4). */
  append(block: string): void;
  approve: ApprovalGate;
  /** The clock, as an ISO string. */
  now(): string;
  /** Sigma changed: gates 1 and 2 must be recomputed. Called after every accepted action. */
  changed?(): void;
  /** Tell the model something that happened between its turns. */
  notify?(summary: string, body: string): void;
  /** Passed through to approval requests; opaque here. */
  agent?: unknown;
}

/** Gate 1's answer about the host's *global* tools. The verbs are never in it. */
export type Visibility =
  | { kind: "unrestricted" }
  | { kind: "allow"; names: string[] }
  | { kind: "deny"; names: string[] };

/** Gate 2's answer: the three verbs as the model should see them for sigma now. */
export interface Specs {
  transition: ToolSpec | null;
  set: ToolSpec | null;
  rollback: ToolSpec;
}

export type Invoked =
  | { ok: true; result: Record<string, JsonValue>; concludesTurn: boolean }
  | { ok: false; reason: string };

/** One finished tool call, in the host-neutral terms the supervisor reasons about. */
export interface ToolOutcome {
  name: string;
  callId: string;
  isError: boolean;
  /** The host's error code when it has one; UNKNOWN_TOOL never reached a body. */
  code?: string;
}

/** A refusal's text as the model should read it: the reason, then the detail. */
function refusalText(reason: string, diagnostics: readonly string[]): string {
  return diagnostics.length ? `${reason}\n${diagnostics.join("\n")}` : reason;
}

/** `{at, call}` for the ledger; `call` is omitted rather than left undefined. */
export function metaFor(at: string, callId?: unknown): Meta {
  return callId === undefined ? { at } : { at, call: String(callId) };
}

export class Supervisor {
  readonly sc: Statechart;
  readonly run: Run;
  private readonly host: SupervisorHost;
  /**
   * Calls gate 3 turned away. A denial and a tool body throwing produce the
   * same shape on both hosts - a message, no code - so the only way to tell
   * them apart is to remember which ones we refused ourselves. It matters:
   * nothing ran, so there is nothing for `rollback-on-error` to undo.
   */
  private readonly denied = new Set<string>();
  private notice = "";

  constructor(sc: Statechart, run: Run, host: SupervisorHost) {
    this.sc = sc;
    this.run = run;
    this.host = host;
  }

  get verbs(): readonly string[] {
    return VERBS;
  }

  owns(toolName: string): boolean {
    return VERBS.includes(toolName);
  }

  get snapshot(): Snapshot {
    return this.run.snapshot;
  }

  state(): State | undefined {
    return this.sc.states.get(this.run.snapshot.state);
  }

  /** A line appended to every context snapshot - used when the statechart changed. */
  setNotice(text: string): void {
    this.notice = text;
  }

  /** The tools sigma admits, expressed over the host's global names. */
  private wanted(): string[] | undefined {
    const state = this.state();
    return state ? effectiveTools(this.sc, state) : this.sc.defaultTools;
  }

  /**
   * Gate 1. `unrestricted` also covers "sigma names tools but the host has no
   * global ones to hide", which is the same instruction to either adapter: do
   * nothing. An empty `allow` would be a filter both hosts refuse.
   */
  allowedGlobals(globalNames: readonly string[]): Visibility {
    const wanted = this.wanted();
    if (wanted === undefined) return { kind: "unrestricted" };
    const globals = globalNames.filter((n) => !this.owns(n));
    const allow = wanted.filter((n) => globals.includes(n));
    if (allow.length > 0) return { kind: "allow", names: allow };
    if (globals.length > 0) return { kind: "deny", names: globals };
    return { kind: "unrestricted" };
  }

  /**
   * Gate 3: why this call must not be dispatched, or undefined. Deny-only by
   * construction - there is no return value that grants anything.
   */
  deny(toolName: string, callId?: unknown): string | undefined {
    if (this.owns(toolName)) return undefined;
    const wanted = this.wanted();
    if (wanted === undefined || wanted.includes(toolName)) return undefined;
    if (callId !== undefined) this.denied.add(String(callId));
    return `tool ${toolName} is not available in state #${this.run.snapshot.state}`;
  }

  /** Gate 2. Recomputed from sigma, so the enum cannot drift from the edges. */
  specs(): Specs {
    return {
      transition: transitionSpec(this.sc, this.run.snapshot),
      set: setSpec(this.sc, this.run.snapshot),
      rollback: rollbackSpec(),
    };
  }

  /** Gates 4 and 5, the ledger append, and whether the turn ends here. */
  async invoke(name: string, args: Record<string, unknown>, meta: Meta): Promise<Invoked> {
    switch (name) {
      case "agent_transition": return this.doTransition(args, meta);
      case "agent_set": return this.doSet(args, meta);
      case "agent_rollback": return this.doRollback(args, meta);
      default: return { ok: false, reason: `geml-agent does not own the tool ${name}` };
    }
  }

  private record(refusal: Refusal, meta: Meta): void {
    this.host.append(this.run.refuse(refusal, meta));
  }

  private async doTransition(args: Record<string, unknown>, meta: Meta): Promise<Invoked> {
    const to = String(args["to"]);
    const edge = outgoing(this.sc, this.run.snapshot.state).find((t) => t.to === to);
    // Gate 2's backstop. On DSH the enum already made this unreachable; on Pi
    // it is the line that does the narrowing (design 6.5).
    if (!edge) return { ok: false, reason: `no transition from #${this.run.snapshot.state} to #${to}` };

    if (edge.approval) {
      const req: ApprovalRequest = {
        toolName: "agent_transition",
        reason: `transition #${edge.id} -> #${to} needs approval`,
        ...(this.host.agent !== undefined ? { agent: this.host.agent } : {}),
      };
      if ((await this.host.approve(req)) !== "allowed-once") {
        const reason = `transition #${edge.id}: approval was not granted`;
        this.record({ tool: "agent_transition", reason, diagnostics: [] }, meta);
        return { ok: false, reason };
      }
    }

    const advance = this.run.transition(to, meta);
    this.host.append(advance.block);
    if (!advance.ok) return { ok: false, reason: refusalText(advance.refusal.reason, advance.refusal.diagnostics) };
    this.host.changed?.();
    const target = this.sc.states.get(to);
    return {
      ok: true,
      concludesTurn: target?.pause === true || target?.final === true,
      result: {
        from: advance.snapshot.from ?? "",
        to,
        rev: advance.snapshot.rev,
        hash: advance.snapshot.hash,
      },
    };
  }

  private async doSet(args: Record<string, unknown>, meta: Meta): Promise<Invoked> {
    const patch: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) patch[key] = value as JsonValue;
    }
    const advance = this.run.set(patch, meta);
    this.host.append(advance.block);
    if (!advance.ok) return { ok: false, reason: refusalText(advance.refusal.reason, advance.refusal.diagnostics) };
    // A guard reads the variables, so writing one can open or close an edge.
    this.host.changed?.();
    return {
      ok: true,
      concludesTurn: false,
      result: { rev: advance.snapshot.rev, hash: advance.snapshot.hash, vars: advance.snapshot.vars },
    };
  }

  private async doRollback(args: Record<string, unknown>, meta: Meta): Promise<Invoked> {
    const raw = String(args["to"]).trim();
    const target: number | "checkpoint" = raw === "checkpoint" ? "checkpoint" : Number(raw);
    if (target !== "checkpoint" && !Number.isInteger(target)) {
      return { ok: false, reason: `"${raw}" is neither a revision number nor "checkpoint"` };
    }
    const advance = this.run.rollback(target, meta);
    this.host.append(advance.block);
    if (!advance.ok) return { ok: false, reason: refusalText(advance.refusal.reason, advance.refusal.diagnostics) };
    this.host.changed?.();
    return {
      ok: true,
      concludesTurn: false,
      result: {
        rev: advance.snapshot.rev,
        restores: advance.snapshot.restores ?? advance.snapshot.rev,
        state: advance.snapshot.state,
        hash: advance.snapshot.hash,
      },
    };
  }

  /**
   * An uncontrollable event: a tool failed. The supervisor cannot prevent it,
   * only respond - which is what `rollback-on-error` is. Returns the rollback
   * that happened, or null when there was nothing to undo.
   */
  onToolResult(ev: ToolOutcome, meta: Meta): { rev: number; restores: number; state: string } | null {
    const wasDenied = this.denied.delete(ev.callId);
    if (!ev.isError || this.owns(ev.name)) return null;
    // A call the supervisor itself turned away, and one for a tool that does
    // not exist, never reached a body: there is no effect to compensate for,
    // and rolling back would burn a revision over the gate doing its job.
    if (wasDenied || ev.code === "UNKNOWN_TOOL") return null;
    if (this.state()?.rollbackOnError !== true) return null;

    const from = this.run.snapshot.rev;
    const advance = this.run.errorRollback(meta);
    this.host.append(advance.block);
    if (!advance.ok) return null;
    this.host.changed?.();
    const restores = advance.snapshot.restores ?? from;
    this.host.notify?.(
      `${ev.name} failed; variables rolled back to rev ${restores}`,
      `[geml-agent] \`${ev.name}\` failed in state #${advance.snapshot.state}. The workflow variables were rolled back to revision ${restores}. Recorded state is restored; anything the tool already did in the outside world is not.`,
    );
    return { rev: advance.snapshot.rev, restores, state: advance.snapshot.state };
  }

  /** The state's own instruction, byte for byte. */
  instruction(): string {
    return this.state()?.body ?? "";
  }

  /** The per-step snapshot, a few hundred bytes. */
  context(): string {
    const text = renderContext(this.sc, this.run.snapshot);
    return this.notice ? `${text}\n${this.notice}` : text;
  }
}

export interface OpenOptions {
  sc: Statechart;
  /** The session this run belongs to; goes in the ledger head. */
  session: string;
  /** The statechart's path, for the ledger head. */
  statechartFile: string;
  /** The ledger as it stands, or null when there is none yet. */
  ledgerText: string | null;
  /** Why the session started. `clear` re-enters the initial state on the same chain. */
  source: string;
  now: string;
}

export type Opened =
  | { ok: true; run: Run; head: string; blocks: string[]; notice: string; note?: string }
  | { ok: false; reason: string };

/**
 * Decide, without any I/O, what opening a run means: fresh or resumed, which
 * blocks the host must append, and whether the statechart moved underneath it.
 * The chain is verified before it is trusted - `resumeRun` does that, and a
 * ledger that contradicts itself refuses here rather than putting the agent in
 * a state nobody wrote (design decision D-B2).
 */
export function openRun(o: OpenOptions): Opened {
  const meta: LedgerMeta = {
    session: o.session,
    statechart: o.statechartFile,
    statechartHash: o.sc.hash,
    created: o.now,
  };
  const fresh = startRun(o.sc, meta, o.now);
  if (o.ledgerText === null) {
    return { ok: true, run: fresh.run, head: fresh.head, blocks: [fresh.block], notice: "" };
  }

  const resumed = resumeRun(o.sc, o.ledgerText);
  if (!resumed.ok) return { ok: false, reason: resumed.reason };

  const blocks: string[] = [];
  if (o.source === "clear") blocks.push(resumed.run.reenter(o.now).block);
  return {
    ok: true,
    run: resumed.run,
    head: fresh.head,
    blocks,
    notice: resumed.note
      ? "[geml-agent] the statechart changed since this run started; the current state still exists and the run continues."
      : "",
    ...(resumed.note ? { note: resumed.note } : {}),
  };
}
