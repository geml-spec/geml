// What a host shell needs in order to decide, without asking the workspace,
// whether a tool call can matter to the workflow: the current state and the
// uses it declares, which states declare each use (a use is fenced to them),
// the dictionary's rows, the file globs and whether git is read, and the
// variables the current state's guards read, and the files already recorded
// as written since the stage was entered. The person-only rule needs no
// field: a shell reads a command line with command-line.ts's
// personOnlyRefusal, the function the supervisor refuses with. Pure: the
// workspace computes the policy from the journal and the dictionary; a shell's
// fast path reads it.
import type { Run } from "./run.js";
import type { DictRow, Dictionary, Scope } from "./dictionary.js";
import { declaredUses, outgoing, statesDeclaring, varsBySource, type Statechart, type Unit } from "./statechart.js";
import { stageEntryRev } from "./snapshot.js";

export interface FlowPolicy {
  /** False when there is no work item (the default branch, no matching file yet): nothing is recorded or refused. */
  active: boolean;
  unit: Unit;
  state: string;
  /** The uses the current state declares. */
  uses: string[];
  /** Every use some state declares, with those states. */
  fences: Record<string, string[]>;
  /** The uses some state declares as a rule: only these are refused outside their states. */
  rules: string[];
  /** The dictionary's rows, as read. */
  rows: DictRow[];
  /** The globs of the `file` variables. */
  files: string[];
  /** Whether a variable reads git. */
  git: boolean;
  /** The variables a guard of the current state's outgoing transitions reads. */
  relevant: string[];
  /** The uses a `tool` variable reads: a finished call bound to one of them is evidence. */
  evidence: string[];
  /** The project paths recorded as written since the stage was entered: writing one again records nothing. */
  written: string[];
}

/** The variables a machine guard on one of the state's outgoing transitions reads. */
export function relevantVars(sc: Statechart, stateId: string): string[] {
  const read = new Set<string>();
  for (const t of outgoing(sc, stateId)) for (const name of t.reads) read.add(name);
  return [...read];
}

export function policyOf(sc: Statechart, dict: Dictionary, run: Run | undefined): FlowPolicy {
  const fences: Record<string, string[]> = {};
  for (const use of declaredUses(sc)) fences[use] = statesDeclaring(sc, use);
  const base = {
    unit: sc.unit, fences, rules: [...sc.rules], rows: dict.rows, files: varsBySource(sc, "file").map((v) => v.source.glob), git: varsBySource(sc, "git").length > 0,
    evidence: [...new Set(varsBySource(sc, "tool").map((v) => v.source.use))],
  };
  if (!run) return { ...base, active: false, state: "", uses: [], relevant: [], written: [] };
  const state = sc.states.get(run.snapshot.state);
  const since = stageEntryRev(run.history);
  const written = run.writeLog.filter((w) => w.rev >= since).map((w) => w.path);
  return { ...base, active: true, state: run.snapshot.state, uses: state?.uses ?? [], relevant: relevantVars(sc, run.snapshot.state), written };
}

/** The policy as the dictionary's decisions read it. */
export function scopeOf(p: FlowPolicy): Scope {
  return { state: p.state, uses: p.uses, declaring: (use) => p.fences[use] ?? [], fenced: (use) => (p.rules ?? []).includes(use) };
}

/** The statechart as the dictionary's decisions read it, in `stateId`. */
export function scopeIn(sc: Statechart, stateId: string): Scope {
  return { state: stateId, uses: sc.states.get(stateId)?.uses ?? [], declaring: (use) => statesDeclaring(sc, use), fenced: (use) => sc.rules.has(use) };
}
