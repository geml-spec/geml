// The to-do count of a work item whose file is a geml-media entry (spec §7.2):
// what `geml media todo <file> --root <project>` lists, counted in process by
// the parser's own todo over the parser's own confined file host, so the two
// cannot disagree. Display only — no signal reads it; the todo-clear signal is
// the command's exit status. Counting hashes every asset file the entry
// reaches, so the bridge counts on refresh and board only, and within a time
// budget: refresh and board must answer well inside the hooks module's timeout.
import { parse } from "@geml/geml";
import { profileIoFor } from "@geml/geml/dist/host-fs.js";
import { todo } from "@geml/geml/dist/media-verbs.js";
import { TODO_CAP } from "./hosts/claude-code/protocol.js";

/** The vocabulary whose entries have a to-do list. */
export const MEDIA_PROFILE = "geml-media/v1";

/** How long one count may take before it gives up and there is none. */
export const TODO_BUDGET_MS = 10_000;

/** Whether a document's `=== meta` declares the geml-media vocabulary, alone or among others. */
export function declaresMedia(source: string): boolean {
  const meta = parse(source).children.find((b) => b.kind === "block" && b.type === "meta");
  const profile = meta && meta.kind === "block" && meta.data ? meta.data["profile"] : undefined;
  return typeof profile === "string" && profile.split(/\s+/).includes(MEDIA_PROFILE);
}

/** Thrown by the file host once the budget is spent: the parser's todo gives up at its next read or hash. */
class OverBudget extends Error {}

/**
 * How many to-do items `geml media todo <file> --root <root>` lists for the
 * project-relative `file`, counted up to TODO_CAP + 1 ("more than TODO_CAP").
 * Undefined when the parser's confined host cannot read the file (missing, not
 * a file, or a link out of the project), the file does not declare geml-media,
 * the count throws, or it runs past `budgetMs`. The budget is checked at every
 * read and hash, and once more at the end.
 */
export function mediaTodoCount(root: string, file: string, opts: { budgetMs?: number } = {}): number | undefined {
  const io = profileIoFor(root);
  const source = io.readDoc(file);
  if (source === null || !declaresMedia(source)) return undefined;
  const deadline = Date.now() + (opts.budgetMs ?? TODO_BUDGET_MS);
  const inBudget = (): void => { if (Date.now() >= deadline) throw new OverBudget(); };
  const timed = {
    readDoc: (rel: string): string | null => { inBudget(); return io.readDoc(rel); },
    hashFile: (rel: string): string | null => { inBudget(); return io.hashFile(rel); },
    hashText: (text: string): string => io.hashText(text),
  };
  try {
    const n = todo([file], timed).length;
    inBudget();
    return Math.min(n, TODO_CAP + 1);
  } catch {
    return undefined;
  }
}
