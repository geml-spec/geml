// The file a write tool's call names, as a project path: what every host
// records as written (the journal's `#wrote-N`, the board's artifacts). Pure.

/** The keys write tools name their file under, across the hosts. */
const PATH_KEYS = ["file_path", "path", "filePath", "notebook_path"] as const;

/** `path` under `base`, both with forward slashes: what follows the root, or undefined. */
function under(path: string, base: string): string | undefined {
  const b = base.replace(/\/+$/, "");
  // A Windows drive letter is spelled either way.
  const same = (x: string, y: string): boolean => (/^[A-Za-z]:/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y);
  return path.length > b.length + 1 && path[b.length] === "/" && same(path.slice(0, b.length), b) ? path.slice(b.length + 1) : undefined;
}

const slashed = (p: string): string => p.replace(/\\/g, "/");

/**
 * The project path a write tool's call names: its file under `root`, with
 * forward slashes; a relative path as given; undefined for a path outside
 * the root, or a call that names none. With `real` (a host's resolver of
 * links), an absolute path that is not under the root as written is compared
 * as both resolve: a root reached through a link (macOS's /var is
 * /private/var) still holds the files written in it.
 */
export function writtenProjectPath(input: Readonly<Record<string, unknown>> | undefined, root: string, real?: (path: string) => string): string | undefined {
  const raw = PATH_KEYS.map((k) => input?.[k]).find((v): v is string => typeof v === "string" && v !== "");
  if (raw === undefined) return undefined;
  const path = slashed(raw);
  const direct = under(path, slashed(root));
  if (direct !== undefined) return direct;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return real !== undefined ? under(slashed(real(raw)), slashed(real(root))) : undefined;
  const rel = path.replace(/^(\.\/)+/, "");
  return rel === "" || rel.startsWith("../") ? undefined : rel;
}
