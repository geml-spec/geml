// The status a host shell shows (spec §8.1, §8.2): the work item, the state,
// every variable with where it reads from, and each way out with whether its
// guard holds — built from a statechart and a run by every host alike: the
// workspace over a work item's journal, the DeepSeek Harness adapter over a
// session's. Pure.
import { guardText } from "@geml/geml/dist/statechart.js";
import type { Run } from "./run.js";
import type { JsonValue } from "./schema.js";
import { checkpointRev, guardHolds } from "./snapshot.js";
import { outgoing, sourceLabel, type Judge, type Statechart } from "./statechart.js";
import type { Item } from "./unit.js";

/** One way out of the current state, as the status reports it. */
export interface NextStep {
  name: string;
  to: string;
  judge: Judge;
  approval: boolean;
  /** The guard in words (guardText); absent when there is none. */
  guard?: string;
  /** The variables a machine guard reads. */
  reads: string[];
  /** Of those, the ones not holding a true value now. */
  missing: string[];
  /** Whether the guard holds for the variables as they stand (true when there is none the machine judges). */
  holds: boolean;
  note: string;
  /** The words on a person's button for this way out: the transition's `label`, else the target state's title. */
  label: string;
  /** The target state is final: taking this way out closes the work item. */
  toFinal: boolean;
  /** The target state is the initial one: this way out goes back to the start (reopening, starting over), not on. */
  toStart: boolean;
}

/** A work item another waits for (its file's meta `depends`): its name and flow, whether it is done, when it began and last moved, what it wrote. */
export interface Dependency { id: string; title?: string; flow?: string; done: boolean; since?: string; at?: string; wrote: string[] }

export interface Status {
  /** The work item's workflow: the one its journal was started under, else the project's default; `default` names the default when it is another. */
  workflow: { name: string; path: string; title: string; default?: string };
  item: Item;
  /** What the work item is called: the item file's meta `title` under a `file:` unit; absent, its id is its name. */
  title?: string;
  /** The work items it waits for; absent when it waits for none. Until each is done, nobody moves it on, only back to the start. */
  depends?: Dependency[];
  /** `final`: the state is marked final, and the work item is closed in it. `since`: when the state was entered (the checkpoint revision's time). */
  state?: { id: string; title: string; rev: number; uses: string[]; final: boolean; since: string };
  vars: Record<string, JsonValue>;
  /** Where each variable with a source reads from (`tool:test`, `file:out/*.mp4`, `git:pr-open`, `human`); the others are the model's to set. */
  sources: Record<string, string>;
  next: NextStep[];
  refusals: number;
  /** A person holds the work item (spec §5.5): evidence is recorded, no transition is taken until they resume it. */
  paused: boolean;
  /** What gh says about the branch; absent when no variable reads gh (a git fact other than `committed`), and then gh is not asked. */
  gh?: { available: true } | { available: false; reason: string };
}

/** What the host knows of the work item before any run: its workflow, its item, and gh's word when a variable reads it. */
export interface StatusBase { workflow: Status["workflow"]; item: Item; title?: string; depends?: Dependency[]; gh?: Status["gh"] }

/** A variable holds for a machine guard's `missing` list when it is not false, null or absent. */
export const truthy = (v: JsonValue | undefined): boolean => v !== undefined && v !== null && v !== false;

/** The status of a run — or, with none, of a work item nothing has recorded yet. */
export function statusOf(sc: Statechart, base: StatusBase, run: Run | undefined): Status {
  const sources: Record<string, string> = {};
  for (const v of sc.vars.values()) if (v.source !== undefined) sources[v.name] = sourceLabel(v.source);
  const head = { ...base, sources };
  if (run === undefined) return { ...head, vars: {}, next: [], refusals: 0, paused: false };
  const snap = run.snapshot;
  const state = sc.states.get(snap.state);
  return {
    ...head,
    ...(state ? { state: { id: state.id, title: state.title, rev: snap.rev, uses: state.uses, final: state.final, since: run.history.find((s) => s.rev === checkpointRev(run.history))?.at ?? snap.at } } : {}),
    vars: snap.vars,
    next: outgoing(sc, snap.state).map((t) => ({
      name: t.name, to: t.to, judge: t.judge, approval: t.approval,
      ...(t.guard !== undefined ? { guard: guardText(t.guard) } : {}),
      reads: t.reads,
      missing: t.judge === "machine" ? t.reads.filter((r) => !truthy(snap.vars[r])) : [],
      holds: guardHolds(sc, t, snap.vars),
      note: t.note,
      label: t.label ?? sc.states.get(t.to)?.title ?? t.to,
      toFinal: sc.states.get(t.to)?.final === true,
      toStart: t.to === sc.initial,
    })),
    refusals: run.refusals,
    paused: run.paused,
  };
}
