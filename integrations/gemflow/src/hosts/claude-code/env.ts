// Where the session runs and who is driving it, in a line: the machine (its
// name, its system, the account), the checkout and its branch, the session,
// the clients attached to it (the desktop app, a phone), and where the last
// prompt came from (this machine's prompt box, or Remote Control). With Remote
// Control a phone can drive a session on another machine; this line says which
// one, and which checkout a command will act in. Pure and Node-free: the bridge
// reads the machine (os.hostname), the hooks module the roster and the prompt.
import { ZH, type T } from "./text.js";

/** The machine and checkout, as the bridge reads them. */
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

const SYSTEM: Readonly<Record<string, string>> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

/** A surface's name for people. */
export function surfaceWords(surface: string, t: T = ZH): string {
  switch (surface) {
    case "desktop": return t("桌面端");
    case "mobile": return t("手机");
    case "vscode": return "VS Code";
    case "terminal": return t("终端");
    default: return surface;
  }
}

/** Where a prompt came from, for people: Remote Control (a phone or the web), this machine's prompt box, an SDK host. */
export function originWords(kind: string, t: T = ZH): string | undefined {
  switch (kind) {
    case "bridge": return t("远程控制");
    case "composer": return t("本机输入框");
    case "sdk": return "SDK";
    default: return undefined;
  }
}

/** The clients attached, by surface: "桌面端、手机 ×2". */
export function clientsWords(clients: readonly AttachedClient[], t: T = ZH): string {
  const counts = new Map<string, number>();
  for (const c of clients) counts.set(c.surface, (counts.get(c.surface) ?? 0) + 1);
  return [...counts].map(([s, n]) => (n > 1 ? `${surfaceWords(s, t)} ×${n}` : surfaceWords(s, t))).join("、");
}

/**
 * The environment, as parts of one line: machine · system · account,
 * checkout, branch, session, clients attached, the last prompt's origin.
 * What is not known is left out.
 */
export function envParts(o: {
  host: HostInfo | null; root: string | null; session?: string; clients: readonly AttachedClient[]; origin?: string; t?: T;
}): string[] {
  const t = o.t ?? ZH;
  const parts: string[] = [];
  if (o.host !== null) {
    const system = SYSTEM[o.host.platform] ?? o.host.platform;
    parts.push(o.host.user !== undefined && o.host.user !== "" ? `${o.host.name} · ${system} · ${o.host.user}` : `${o.host.name} · ${system}`);
  }
  if (o.root !== null && o.root !== "") parts.push(o.root);
  if (o.host?.branch !== undefined && o.host.branch !== "") parts.push(o.host.branch);
  if (o.session !== undefined && o.session !== "") parts.push(t("会话 {0}", o.session.slice(0, 8)));
  if (o.clients.length > 0) parts.push(t("连着 {0}", clientsWords(o.clients, t)));
  const from = o.origin === undefined ? undefined : originWords(o.origin, t);
  if (from !== undefined) parts.push(t("上一句来自 {0}", from));
  return parts;
}

/**
 * Whether the band should name the machine: when it is drawn on a phone, or a
 * phone is attached, or the last prompt came over Remote Control — the times
 * a person may not be at the machine the session runs on.
 */
export function remoteInPlay(o: { surface?: string; clients: readonly AttachedClient[]; origin?: string }): boolean {
  return o.surface === "mobile" || o.clients.some((c) => c.surface === "mobile") || o.origin === "bridge";
}
