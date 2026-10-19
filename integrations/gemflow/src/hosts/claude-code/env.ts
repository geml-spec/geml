// Where the session runs, in a few words: the machine it runs on (under Remote
// Control the machine at the other end, not the one in the person's hand), the
// checkout and its branch, and whether Remote Control is in play. Pure and
// Node-free: the bridge reads the machine (os.hostname), the hooks module the
// clients attached and where the last prompt came from.
import { ZH, type T } from "./text.js";

/** The machine the session runs on and its checkout, as the bridge reads them (it runs beside the session). */
export interface HostInfo {
  /** The machine's name (os.hostname). */
  name: string;
  /** process.platform: win32, darwin, linux. */
  platform: string;
  /** The account the session runs as. */
  user?: string;
  /** The checkout's current branch. */
  branch?: string;
}

/** A client attached to the session (session.attach): where it draws, and its id. */
export interface AttachedClient { clientId: string; surface: string }

/** The environment as parts of one short line: 运行于 <machine>, the checkout's folder, the branch, 远程控制 when in play. What is not known is left out. */
export function envParts(o: { host: HostInfo | null; root: string | null; remote: boolean; t?: T }): string[] {
  const t = o.t ?? ZH;
  const parts: string[] = [];
  if (o.host !== null) parts.push(t("运行于 {0}", o.host.name));
  const folder = (o.root ?? "").split(/[\\/]/).filter((s) => s !== "").pop();
  if (folder !== undefined) parts.push(folder);
  if (o.host?.branch !== undefined && o.host.branch !== "") parts.push(o.host.branch);
  if (o.remote) parts.push(t("远程控制"));
  return parts;
}

/**
 * Whether Remote Control is in play: the band is drawn on a phone, or a phone
 * is attached, or the last prompt came over Remote Control — the times a
 * person may not be at the machine the session runs on.
 */
export function remoteInPlay(o: { surface?: string; clients: readonly AttachedClient[]; origin?: string }): boolean {
  return o.surface === "mobile" || o.clients.some((c) => c.surface === "mobile") || o.origin === "bridge";
}
