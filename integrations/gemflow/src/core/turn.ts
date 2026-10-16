// Whose turn it is on a work item: the person's, the model's, or the
// evidence's. Pure, and importing nothing at run time: the band and the board
// read it in the hooks module, the bridge for every work item it lists.
import type { NextStep } from "./status.js";

/** What deciding whose turn it is reads of a way out. */
export type WayOut = Pick<NextStep, "approval" | "holds" | "judge" | "reads" | "toStart">;

/**
 * Whether the work item waits on a person (the board's 待处理, the band's one
 * thing): some way on — a way out that does not go back to the start — is
 * theirs to take (an approval whose condition holds, or one whose condition
 * reads only what a person ticks), and nobody else has one (the model's
 * judgement, or evidence the machine reads). A way back to the start alone,
 * reopening what was put aside, is no waiting.
 */
export function waitsOnPerson(next: readonly WayOut[], sources: Readonly<Record<string, string>>): boolean {
  const ticked = (x: WayOut): boolean => x.judge === "machine" && x.reads.length > 0 && x.reads.every((r) => sources[r] === "human");
  const on = next.filter((x) => !x.toStart);
  return !on.some((x) => !x.approval && !ticked(x)) && on.some((x) => (x.approval ? x.holds : ticked(x)));
}
