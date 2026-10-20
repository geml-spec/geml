// The outline on disk: the `#items` table of the home's project.geml, brought
// in line with git each time the board reads the work items (spec: the
// project's outline). Only that table is rewritten, and only when it changed;
// what a person wrote around it stays. A work item gone from the journals
// keeps its row.
import { join, relative, sep } from "node:path";
import { exists, readText, withLock, writeAtomic } from "./host-fs.js";
import { branchesFacts, holdsCommit } from "./host-git.js";
import { PROJECT_DOC } from "./core/layout.js";
import { branchRow, byLast, fileRow, readOutline, withOutline, type BranchFacts, type ItemFacts, type OutlineRow, type PrFact } from "./core/outline.js";
import { projectDocOf } from "./project-home.js";

/** A work item as the outline takes it: its journal's facts, the kind of its unit, and its flow's say on it. */
export interface OutlineEntry extends ItemFacts { kind: "branch" | "file"; final: boolean; state: string }

const lf = (s: string): string => s.replace(/\r\n?/g, "\n");
const slashed = (p: string): string => p.split(sep).join("/");

/**
 * The outline's rows for `entries`, every other row the table had kept, the
 * table written back when it changed. `prs` is gh's word on the branches'
 * pull requests, when it was asked; without it a row keeps the one it had.
 * Answers the rows by item.
 */
export function updateOutline(root: string, home: string, entries: readonly OutlineEntry[], prs?: ReadonlyMap<string, PrFact>): Map<string, OutlineRow> {
  const path = join(home, PROJECT_DOC);
  // A project still on the earlier document starts its project.geml from it, so the default it names stays.
  const from = exists(path) ? path : projectDocOf(root, home);
  const source = from === undefined ? null : readText(from);
  const before = new Map((source === null ? [] : readOutline(source)).map((r) => [r.item, r]));
  const git = entries.some((e) => e.kind === "branch") ? branchesFacts(root) : undefined;
  const rows = new Map(before);
  for (const e of entries) {
    const prev = before.get(e.id);
    if (e.kind === "file") { rows.set(e.id, fileRow(e, e.final, e.state)); continue; }
    // git that could not be read says nothing of the branches: each keeps the row it had.
    if (git?.ok !== true) continue;
    const b = git?.branches.get(e.id);
    const facts: BranchFacts = b === undefined ? { exists: false } : {
      exists: true, tip: b.tip, ...(b.ahead !== undefined ? { ahead: b.ahead } : {}), inDefault: b.inDefault,
      ...(b.worktree !== undefined ? { worktree: slashed(relative(home, b.worktree)) || "." } : {}),
    };
    // A branch gone since the table last saw it: whether its last tip reached the default branch.
    if (!facts.exists && git?.base !== undefined && prev?.tip && (prev.state === "doing" || prev.state === "merged")) {
      const held = holdsCommit(root, git.base, prev.tip);
      if (held !== undefined) facts.tipInDefault = held;
    }
    rows.set(e.id, branchRow(prev, e, facts, prs?.get(e.id)));
  }
  if (rows.size === 0) return rows;
  const ordered = [...rows.values()].sort(byLast);
  try {
    // Read again under the lock: a `use` may have changed the default meanwhile, and only the table is ours.
    withLock(path, () => {
      const at = exists(path) ? path : projectDocOf(root, home);
      const now = at === undefined ? null : readText(at);
      const text = withOutline(now, ordered);
      if (now === null || at !== path || lf(text) !== lf(now)) writeAtomic(path, text);
    });
  } catch { /* a home that cannot be written keeps the table it had; the board still shows what git says */ }
  return rows;
}
