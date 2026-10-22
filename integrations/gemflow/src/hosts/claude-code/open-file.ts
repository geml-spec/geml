/**
 * Opening a local file from the board. A `file:` link opens nothing on the
 * desktop, phone or VS Code panes: the engine draws any href but `https:`
 * there as plain text. So a press runs the machine's own opener instead, by
 * its argument vector (no shell).
 *
 * On Windows the opener is PowerShell's Start-Process, never explorer.exe
 * itself: the engine starts its commands with their windows hidden, and
 * Explorer builds the folder window it opens hidden too (it exists and never
 * shows). Start-Process starts what it opens in a normal window. The path
 * travels in an environment variable, so no quoting can break it.
 */

/** The environment variable that carries the path to the Windows opener. */
export const OPEN_PATH_VAR = "GEMFLOW_OPEN_PATH";

const POWERSHELL = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
/** The file or folder the variable names, opened with its default app in a normal window. */
const WIN_OPEN = `Start-Process -FilePath $env:${OPEN_PATH_VAR} -WindowStyle Normal`;
/** Explorer at the item's folder with the item selected, in a normal window; the quotes are [char]34, so no double quote crosses the command line. */
const WIN_REVEAL = `Start-Process -FilePath explorer.exe -ArgumentList ('/select,' + [char]34 + $env:${OPEN_PATH_VAR} + [char]34) -WindowStyle Normal`;

/** One way to open a path: the command, and what it adds to the environment. */
export interface Opener { argv: string[]; env?: Record<string, string> }

/** A path's folder, in forward slashes. */
function folderOf(path: string): string {
  const p = path.split("\\").join("/").replace(/\/+$/, "");
  const cut = p.lastIndexOf("/");
  return cut <= 0 ? "/" : p.slice(0, cut);
}

/**
 * The ways to open `path` on the machine the session runs on, in the order
 * to try them; with `reveal`, its folder is shown with it selected where the
 * system can (Explorer, Finder), else its folder is opened. Windows goes
 * through Start-Process (backslashes), macOS through `open` (`-R` reveals),
 * elsewhere `xdg-open`. With no platform known, a drive letter says Windows;
 * otherwise `xdg-open` comes before `open`, which on Debian is openvt.
 */
export function openersFor(platform: string | undefined, path: string, reveal = false): Opener[] {
  const os = platform ?? (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") ? "win32" : undefined);
  if (os === "win32") return [{ argv: [...POWERSHELL, reveal ? WIN_REVEAL : WIN_OPEN], env: { [OPEN_PATH_VAR]: path.split("/").join("\\") } }];
  const mac: Opener = { argv: reveal ? ["open", "-R", path] : ["open", path] };
  if (os === "darwin") return [mac];
  const xdg: Opener = { argv: ["xdg-open", reveal ? folderOf(path) : path] };
  return os === undefined ? [xdg, mac] : [xdg];
}

/** A path's last segment, a folder's too: what a toast names. */
export function baseName(path: string): string {
  const p = path.split("\\").join("/").replace(/\/+$/, "");
  return p.slice(p.lastIndexOf("/") + 1) || p;
}
