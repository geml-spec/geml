// Evidence: the variables with a `source` (spec §4.2, §5.2), written from
// facts the host observed — a finished tool call bound to a use, whether a
// glob matches, what git and gh say. Pure: the host gathers the facts, these
// functions say which variables now read what, and the supervisor writes them.
import { evidenceKeys as keysOfLine, usesOf, type Dictionary } from "./dictionary.js";
import { scopeIn } from "./policy.js";
import { checkpointRev, type Snapshot } from "./snapshot.js";
import { varsBySource, type Statechart } from "./statechart.js";

export { MAX_SIGNAL_COMMAND_LENGTH, personOnlyReason, personOnlyRefusal, runsGitOrGh, signalHeads, simpleCommands } from "./command-line.js";

/** A variable and the value its evidence now reads. */
export interface SignalValue { id: string; value: boolean }

/**
 * One finished call that ran a command line. `exitCode` null: no exit status
 * (the call went to the background). `commands`: which of the line's simple
 * commands (signalHeads' order) this work item takes — the others ran for
 * another one, or nowhere a work item is — absent, every one.
 */
export interface CommandOutcome { command: string; exitCode: number | null; commands?: readonly number[] }

/** What git and gh say about the current branch. An absent field is a fact nobody could establish. */
export interface GitFacts {
  committed?: boolean;
  prOpen?: boolean;
  prMerged?: boolean;
  /** CI runs on the branch head; `success` is false for a run still going or one that failed, `failed` marks one that finished failing. */
  ci?: readonly { workflow: string; success: boolean; failed?: true }[];
  /** The commit the runs are on: the branch's head. */
  head?: string;
}

/**
 * The keys of a finished command line that may speak for evidence: one
 * `Bash(<command>)` per simple command this work item takes, and only when
 * the line is a plain `&&` chain — otherwise its exit status says nothing
 * about the command that matched. Null when the line speaks for none.
 */
export function commandKeys(o: CommandOutcome): string[] | null {
  return keysOfLine(o.command, o.commands);
}

/** The `tool` evidence a finished call speaks for: the variables whose use one of its keys is bound to, in the current state, reading `ok`. */
export function toolSignals(sc: Statechart, dict: Dictionary, stateId: string, keys: readonly string[], ok: boolean): SignalValue[] {
  const uses = new Set(usesOf(dict, scopeIn(sc, stateId), keys));
  return varsBySource(sc, "tool").filter((v) => uses.has(v.source.use)).map((v) => ({ id: v.name, value: ok }));
}

/** The `tool` evidence of a finished command line: its keys (evidenceKeys), reading the exit status. */
export function commandSignals(sc: Statechart, dict: Dictionary, stateId: string, o: CommandOutcome): SignalValue[] {
  if (o.exitCode === null) return [];
  const keys = commandKeys(o);
  return keys === null ? [] : toolSignals(sc, dict, stateId, keys, o.exitCode === 0);
}

/** `exists` answers undefined when the host could not establish it (a walk that gave up): that variable is left as it was. */
export function fileSignals(sc: Statechart, exists: (glob: string) => boolean | undefined): SignalValue[] {
  const out: SignalValue[] = [];
  for (const v of varsBySource(sc, "file")) {
    const value = exists(v.source.glob);
    if (value !== undefined) out.push({ id: v.name, value });
  }
  return out;
}

export function gitSignals(sc: Statechart, f: GitFacts): SignalValue[] {
  const out: SignalValue[] = [];
  for (const v of varsBySource(sc, "git")) {
    let value: boolean | undefined;
    switch (v.source.fact) {
      case "committed": value = f.committed; break;
      case "pr-open": value = f.prOpen; break;
      case "pr-merged": value = f.prMerged; break;
      case "ci-success": value = f.ci === undefined ? undefined : f.ci.length > 0 && f.ci.every((r) => r.success); break;
    }
    if (value !== undefined) out.push({ id: v.name, value });
  }
  return out;
}

/** Whether any variable reads git, and whether one reads gh (a git fact other than `committed`). */
export function readsGit(sc: Statechart): { git: boolean; gh: boolean } {
  const facts = varsBySource(sc, "git").map((v) => v.source.fact);
  return { git: facts.length > 0, gh: facts.some((f) => f !== "committed") };
}

/**
 * The clock's evidence (spec §3.6): each `elapsed` variable is true once the
 * current state has been held at least its duration — from the revision that
 * entered the state (checkpointRev) to `now`. Every such variable is returned;
 * writing one that holds its value already adds no revision.
 */
export function elapsedSignals(sc: Statechart, history: readonly Snapshot[], now: string): SignalValue[] {
  const vars = varsBySource(sc, "elapsed");
  if (vars.length === 0) return [];
  const entered = history.find((s) => s.rev === checkpointRev(history))?.at;
  const held = entered === undefined ? NaN : Date.parse(now) - Date.parse(entered);
  if (!Number.isFinite(held)) return [];
  return vars.map((v) => ({ id: v.name, value: held >= v.source.ms }));
}
