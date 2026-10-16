// What a journal is about: a branch, or one file of a set (spec §5.5). Pure:
// the host says which branch is checked out and which file was written last.
import type { Unit } from "./statechart.js";
import { GEML_DIR, JOURNALS_DIR } from "./layout.js";

export interface ItemFacts { branch?: string; defaultBranch?: string; lastFile?: string }
export type Item = { kind: "item"; id: string } | { kind: "inactive"; reason: string };

/** A glob as a whole-path regular expression: `*` within a segment, `**` across segments, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// A Windows device name is reserved with any extension (`nul.geml` is the NUL device).
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// Control characters, and what no Windows file name may hold; `\` is a separator there, `:` a drive or stream.
const FORBIDDEN_CHAR = /[\x00-\x1f\x7f<>:"|?*\\]/;

/**
 * Whether an item id can name a journal on every file system the project may
 * live on. An id is a branch name or a file path without its extension, so it
 * is whatever someone typed: a safe one is `/`-separated, with no empty, `.` or
 * `..` segment, no leading `/`, no control or Windows-reserved character, no
 * segment ending in `.` or a space, and no Windows device name. The journal
 * path is built from it, so this is what keeps a journal under `.geml/journals/`.
 */
export function isSafeItemId(id: string): boolean {
  if (id === "" || FORBIDDEN_CHAR.test(id)) return false;
  return id.split("/").every((seg) =>
    seg !== "" && seg !== "." && seg !== ".." && !/[. ]$/.test(seg) && !RESERVED_NAME.test(seg.split(".")[0]!.trimEnd()));
}

/**
 * Directories whose files are never a work item and never a file signal's:
 * the runtime's own (`.geml` holds the journals), git's, and installed packages.
 * The project walk (`globExists`) skips them at any depth, and so does a path here.
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([".geml", ".git", "node_modules"]);

/**
 * The ignored directory that keeps `path` out of `glob`'s reach, or undefined
 * when none does. `.git` and `node_modules` always do. The project's `.geml`
 * does unless the glob names it outright as its first segment
 * (`.geml/matters/*.geml`): the author pointed inside it on purpose — though
 * never at its journals, the runtime's own record.
 */
export function hiddenDir(glob: string, path: string): string | undefined {
  const segs = path.split("/");
  const named = glob.split("/")[0] === GEML_DIR && !`${path}/`.startsWith(`${JOURNALS_DIR}/`);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (!IGNORED_DIRS.has(seg)) continue;
    if (seg === GEML_DIR && i === 0 && named) continue;
    return seg;
  }
  return undefined;
}

const unsafe = (id: string): Item =>({ kind: "inactive", reason: `${JSON.stringify(id)} · not a safe work item id` });

export function resolveItem(unit: Unit, f: ItemFacts): Item {
  if (unit.kind === "branch") {
    if (!f.branch) return { kind: "inactive", reason: "not a git repository" };
    if (f.branch === "HEAD") return { kind: "inactive", reason: "detached HEAD · not tracked" };
    if (f.branch === f.defaultBranch) return { kind: "inactive", reason: `${f.branch} · not tracked (work items are branches)` };
    return isSafeItemId(f.branch) ? { kind: "item", id: f.branch } : unsafe(f.branch);
  }
  // A path may arrive in the host's spelling; a backslash is a Windows separator, and ids use `/`.
  const file = f.lastFile?.replace(/\\/g, "/");
  const hidden = file === undefined ? undefined : hiddenDir(unit.glob, file);
  if (file && hidden !== undefined) return { kind: "inactive", reason: `${file} · under ${hidden}, not a work item` };
  if (file && globToRegExp(unit.glob).test(file)) {
    const id = file.replace(/\.[^./]+$/, "");
    return isSafeItemId(id) ? { kind: "item", id } : unsafe(id);
  }
  return { kind: "inactive", reason: `no work item yet: edit a file matching ${unit.glob}` };
}

/** The journal of a work item, relative to the project root: its `/` become subdirectories. Throws on an id that is not safe. */
export function journalPathFor(itemId: string): string {
  if (!isSafeItemId(itemId)) throw new Error(`work item id ${JSON.stringify(itemId)} cannot name a journal`);
  return `${JOURNALS_DIR}/${itemId}.geml`;
}
