// One run of one statechart: the snapshot history, the three actions, and the
// ledger text each action produces. Pure — the host appends the text and
// decides where it goes.
//
// The history is held WHOLE rather than just the current snapshot, because
// `applyRollback` and `checkpointRev` are functions of the history and a run
// that re-parsed its ledger per rollback would pay O(file) on every undo, growing
// with the run. Resuming parses the ledger once; after that the history lives
// here (design decision D-B1).
//
// A `Run` is internally mutable: an accepted action pushes onto the log and the
// caller reads `run.snapshot` afterwards. Purity here means no I/O, not
// immutability — the plugin holds exactly one of these per agent, and threading
// a replacement value through five call sites would buy nothing.
import type { JsonValue } from "./schema.js";
import type { Statechart } from "./statechart.js";
import {
  applyPatch, applyRollback, applyTransition, checkpointRev, initialSnapshot, reenterSnapshot,
  type Meta, type Outcome, type Refusal, type Snapshot,
} from "./snapshot.js";
import {
  readLedger, renderLedgerHead, renderRefusedBlock, renderSnapshotBlock, verifyLedger,
  type LedgerMeta,
} from "./ledger.js";

/**
 * What one action produced. `block` is present either way: an accepted action
 * appends an `agent-snapshot`, a refused one an `agent-refused`, and the caller
 * appends whichever it gets without asking which happened — a refusal that went
 * unrecorded is the one the audit would never see.
 */
export type Advance =
  | { ok: true; snapshot: Snapshot; block: string }
  | { ok: false; refusal: Refusal; block: string };

export interface Run {
  readonly sc: Statechart;
  /** The current revision — the last one on the chain. */
  readonly snapshot: Snapshot;
  /** Every revision, oldest first. Rollback needs all of it. */
  readonly history: readonly Snapshot[];
  /** How many refusals have been recorded, so `#refused-N` keeps counting. */
  readonly refusals: number;
  transition(to: string, meta: Meta): Advance;
  set(patch: Record<string, JsonValue>, meta: Meta): Advance;
  rollback(target: number | "checkpoint", meta: Meta): Advance;
  /** An external tool failed in a `rollback-on-error` state: return to this state's entry. */
  errorRollback(meta: Meta): Advance;
  /** The session was cleared: start over at the initial state, on the same chain. */
  reenter(at: string): { snapshot: Snapshot; block: string };
  /**
   * Record a refusal that did not come from one of the actions above — an
   * approval the host denied before the action was ever attempted. The
   * numbering lives here so `#refused-N` counts once across every source.
   */
  refuse(refusal: Refusal, meta: Meta): string;
}

class RunState implements Run {
  readonly sc: Statechart;
  private readonly log: Snapshot[];
  private refused: number;

  constructor(sc: Statechart, history: Snapshot[], refusals: number) {
    this.sc = sc;
    this.log = history;
    this.refused = refusals;
  }

  get snapshot(): Snapshot {
    // The log is never empty: every constructor path seeds it with one revision.
    return this.log[this.log.length - 1] as Snapshot;
  }

  get history(): readonly Snapshot[] {
    return this.log;
  }

  get refusals(): number {
    return this.refused;
  }

  refuse(refusal: Refusal, meta: Meta): string {
    this.refused += 1;
    return renderRefusedBlock({
      n: this.refused,
      rev: this.snapshot.rev,
      at: meta.at,
      tool: refusal.tool,
      ...(meta.call !== undefined ? { call: meta.call } : {}),
      reason: refusal.reason,
      diagnostics: refusal.diagnostics,
    });
  }

  /** Commit an outcome: extend the chain on success, only number it on refusal. */
  private settle(outcome: Outcome, meta: Meta): Advance {
    if (outcome.ok) {
      this.log.push(outcome.next);
      return { ok: true, snapshot: outcome.next, block: renderSnapshotBlock(outcome.next) };
    }
    return { ok: false, refusal: outcome.refusal, block: this.refuse(outcome.refusal, meta) };
  }

  transition(to: string, meta: Meta): Advance {
    return this.settle(applyTransition(this.sc, this.snapshot, to, meta), meta);
  }

  set(patch: Record<string, JsonValue>, meta: Meta): Advance {
    return this.settle(applyPatch(this.sc, this.snapshot, patch, meta), meta);
  }

  rollback(target: number | "checkpoint", meta: Meta): Advance {
    return this.settle(applyRollback(this.sc, this.log, target, meta), meta);
  }

  errorRollback(meta: Meta): Advance {
    return this.settle(applyRollback(this.sc, this.log, checkpointRev(this.log), meta, "error-rollback"), meta);
  }

  reenter(at: string): { snapshot: Snapshot; block: string } {
    const next = reenterSnapshot(this.sc, this.snapshot, at);
    this.log.push(next);
    return { snapshot: next, block: renderSnapshotBlock(next) };
  }
}

/** Open a fresh run: the ledger head plus revision 0. */
export function startRun(sc: Statechart, meta: LedgerMeta, at: string): { run: Run; head: string; block: string } {
  const first = initialSnapshot(sc, at);
  return {
    run: new RunState(sc, [first], 0),
    head: renderLedgerHead(meta),
    block: renderSnapshotBlock(first),
  };
}

/** Either a resumed run — with a note when the statechart has changed — or why not. */
export type Resumed = { ok: true; run: Run; note?: string } | { ok: false; reason: string };

/**
 * Reopen a run from its ledger.
 *
 * The chain is verified BEFORE it is trusted (design decision D-B2). A
 * self-contradicting ledger is more dangerous than no ledger at all: resuming
 * from it would put the agent in a state nobody ever wrote, with the audit
 * trail asserting otherwise. Verification runs without the statechart so that a
 * chain problem and a statechart problem report separately.
 */
export function resumeRun(sc: Statechart, ledgerSource: string): Resumed {
  const ledger = readLedger(ledgerSource);
  const errors = verifyLedger(ledger);
  if (errors.length) return { ok: false, reason: errors.join("; ") };

  // Highest rev, not document order. Verification has already established that
  // the two agree, but reading it the documented way keeps that a consequence
  // rather than a coincidence.
  const history = [...ledger.snapshots].sort((a, b) => a.rev - b.rev);
  const current = history[history.length - 1];
  if (current === undefined) return { ok: false, reason: "the ledger holds no revision" };
  if (!sc.states.has(current.state)) {
    return { ok: false, reason: `the statechart no longer has state #${current.state}` };
  }

  const refusals = ledger.refusals.reduce((max, r) => (r.n > max ? r.n : max), 0);
  const run = new RunState(sc, history, refusals);
  return ledger.meta.statechartHash === sc.hash
    ? { ok: true, run }
    : { ok: true, run, note: `statechart changed: ${ledger.meta.statechartHash} → ${sc.hash}` };
}
