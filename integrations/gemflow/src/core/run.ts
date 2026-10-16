// One run of one workflow: the snapshot history, the ways to advance it
// (transition, set, rollback, signal, expire, reenter), the refusals it
// numbers, and the journal text each of these produces. Pure — the host
// appends the text and decides where it goes.
//
// The history is held WHOLE rather than just the current snapshot, because
// `applyRollback` and `checkpointRev` are functions of the history and a run
// that re-parsed its journal per rollback would pay O(file) on every undo.
// Resuming parses the journal once; after that the history lives here.
//
// A `Run` is internally mutable: an accepted action pushes onto the log and the
// caller reads `run.snapshot` afterwards. Purity here means no I/O, not
// immutability.
import type { JsonValue } from "./schema.js";
import type { Statechart } from "./statechart.js";
import {
  applyExpiry, applyHold, applyPatch, applyRollback, applySignal, applyTransition, initialSnapshot, isPaused, reenterSnapshot, stageEntryRev,
  type Meta, type Outcome, type Refusal, type Snapshot,
} from "./snapshot.js";
import { readJournal, renderJournalHead, renderRefusedBlock, renderSnapshotBlock, renderWroteBlock, verifyJournal, type JournalMeta } from "./journal.js";

/**
 * What one action produced. `block` is present either way: an accepted action
 * appends a revision, a refused one a refusal, and the caller appends
 * whichever it gets — a refusal that went unrecorded is the one the audit
 * would never see.
 */
export type Advance =
  | { ok: true; snapshot: Snapshot; block: string }
  | { ok: false; refusal: Refusal; block: string };

/** What the run remembers of a recorded refusal: its number, the revision it happened at, and the call it turned away. */
export interface RefusalEntry { n: number; rev: number; call?: string; key?: string }

export interface Run {
  readonly sc: Statechart;
  /** The current revision — the last one on the chain. */
  readonly snapshot: Snapshot;
  /** Every revision, oldest first. Rollback needs all of it. */
  readonly history: readonly Snapshot[];
  /** How many refusals have been recorded, so `#refused-N` keeps counting. */
  readonly refusals: number;
  /** Every recorded refusal, read from the journal and extended as refusals are made. */
  readonly refusalLog: readonly RefusalEntry[];
  /** Every file recorded as written, read from the journal and extended as files are written. */
  readonly writeLog: readonly WroteEntry[];
  /** Whether a person holds the work item (spec §5.5): evidence is still recorded, no transition is taken. */
  readonly paused: boolean;
  /** Evidence observed on content `tree` (when known); null when the variable already held it. */
  signal(name: string, value: boolean, meta: Meta, tree?: string): Advance | null;
  /** The `tool` variables whose content changed since their evidence was written return to their defaults; null when none did. */
  expire(tree: string, meta: Meta): { snapshot: Snapshot; block: string } | null;
  transition(to: string, meta: Meta): Advance;
  set(patch: Record<string, JsonValue>, meta: Meta): Advance;
  rollback(target: number | "checkpoint", meta: Meta): Advance;
  /** A person holds the work item (`true`) or lets it go (`false`). */
  hold(paused: boolean, meta: Meta): Advance;
  /** The session was cleared: start over at the initial state, on the same chain. */
  reenter(at: string): { snapshot: Snapshot; block: string };
  /**
   * Record a refusal that did not come from one of the actions above — a
   * tool call a gate turned away. The numbering lives here so `#refused-N`
   * counts once across every source.
   */
  refuse(refusal: Refusal, meta: Meta): string;
  /**
   * Record that the work wrote `path` (a project path): the block to append,
   * or null when the path is already recorded since the stage was entered —
   * one record per file per stage entry.
   */
  wrote(tool: string, path: string, meta: Meta): string | null;
}

/** A file recorded as written: its number, the revision it was written at, and its path. */
export interface WroteEntry { n: number; rev: number; path: string }

class RunState implements Run {
  readonly sc: Statechart;
  private readonly log: Snapshot[];
  private refused: number;
  private readonly refLog: RefusalEntry[];
  private readonly wroteLog: WroteEntry[];

  constructor(sc: Statechart, history: Snapshot[], refusals: number, refusalLog: RefusalEntry[] = [], wroteLog: WroteEntry[] = []) {
    this.sc = sc;
    this.log = history;
    this.refused = refusals;
    this.refLog = refusalLog;
    this.wroteLog = wroteLog;
  }

  get writeLog(): readonly WroteEntry[] {
    return this.wroteLog;
  }

  wrote(tool: string, path: string, meta: Meta): string | null {
    const since = stageEntryRev(this.log);
    if (this.wroteLog.some((w) => w.path === path && w.rev >= since)) return null;
    const n = this.wroteLog.reduce((max, w) => (w.n > max ? w.n : max), 0) + 1;
    this.wroteLog.push({ n, rev: this.snapshot.rev, path });
    return renderWroteBlock({ n, rev: this.snapshot.rev, at: meta.at, tool, ...(meta.call !== undefined ? { call: meta.call } : {}), path });
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

  get refusalLog(): readonly RefusalEntry[] {
    return this.refLog;
  }

  get paused(): boolean {
    return isPaused(this.log);
  }

  refuse(refusal: Refusal, meta: Meta): string {
    this.refused += 1;
    this.refLog.push({ n: this.refused, rev: this.snapshot.rev, ...(meta.call !== undefined ? { call: meta.call } : {}), ...(refusal.key !== undefined ? { key: refusal.key } : {}) });
    return renderRefusedBlock({
      n: this.refused,
      rev: this.snapshot.rev,
      at: meta.at,
      tool: refusal.tool,
      ...(meta.call !== undefined ? { call: meta.call } : {}),
      reason: refusal.reason,
      diagnostics: refusal.diagnostics,
      ...(refusal.key !== undefined ? { key: refusal.key } : {}),
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

  signal(name: string, value: boolean, meta: Meta, tree?: string): Advance | null {
    const outcome = applySignal(this.sc, this.snapshot, name, value, meta, tree);
    return outcome === null ? null : this.settle(outcome, meta);
  }

  expire(tree: string, meta: Meta): { snapshot: Snapshot; block: string } | null {
    const next = applyExpiry(this.sc, this.log, tree, meta);
    if (next === null) return null;
    this.log.push(next);
    return { snapshot: next, block: renderSnapshotBlock(next) };
  }

  rollback(target: number | "checkpoint", meta: Meta): Advance {
    return this.settle(applyRollback(this.sc, this.log, target, meta), meta);
  }

  hold(paused: boolean, meta: Meta): Advance {
    return this.settle(applyHold(this.sc, this.log, paused, meta), meta);
  }

  reenter(at: string): { snapshot: Snapshot; block: string } {
    const next = reenterSnapshot(this.sc, this.snapshot, at);
    this.log.push(next);
    return { snapshot: next, block: renderSnapshotBlock(next) };
  }
}

/** Open a fresh run: the journal head plus revision 0, in the initial state or in `state`. */
export function startRun(sc: Statechart, meta: JournalMeta, at: string, state: string = sc.initial): { run: Run; head: string; block: string } {
  const first = initialSnapshot(sc, at, state);
  return {
    run: new RunState(sc, [first], 0),
    head: renderJournalHead(meta),
    block: renderSnapshotBlock(first),
  };
}

/** Either a resumed run — with a note when the workflow has changed — or why not. */
export type Resumed = { ok: true; run: Run; note?: string } | { ok: false; reason: string };

/**
 * Reopen a run from its journal. The chain is verified BEFORE it is trusted:
 * a self-contradicting journal is more dangerous than no journal at all.
 * Verification runs without the statechart so that a chain problem and a
 * statechart problem report separately.
 */
export function resumeRun(sc: Statechart, journalSource: string): Resumed {
  const journal = readJournal(journalSource);
  const errors = verifyJournal(journal);
  if (errors.length) return { ok: false, reason: errors.join("; ") };

  const history = [...journal.snapshots].sort((a, b) => a.rev - b.rev);
  const current = history[history.length - 1];
  if (current === undefined) return { ok: false, reason: "the journal holds no revision" };
  if (!sc.states.has(current.state)) return { ok: false, reason: `the statechart no longer has state ${current.state}` };

  const refusals = journal.refusals.reduce((max, r) => (r.n > max ? r.n : max), 0);
  const run = new RunState(sc, history, refusals, journal.refusals.map((r) => ({ n: r.n, rev: r.rev, ...(r.call !== undefined ? { call: r.call } : {}), ...(r.key !== undefined ? { key: r.key } : {}) })), journal.writes.map((w) => ({ n: w.n, rev: w.rev, path: w.path })));
  return journal.meta.workflowHash === sc.hash
    ? { ok: true, run }
    : { ok: true, run, note: `workflow changed: ${journal.meta.workflowHash} → ${sc.hash}` };
}
