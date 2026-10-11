// The GEML MCP server, offered to the editor's chat.
//
// Two ways to run the same tools, and the only difference is where the document
// is:
//
//   • hosted — the Cloudflare Worker. Nothing to install and nothing is kept:
//     the text travels in each call and a write comes back as the new text.
//     It serves no history and no code graph, because it holds no files.
//   • local  — `geml mcp --root .`, the same CLI this extension already runs for
//     diagnostics and the outline. It reads and writes one folder, serves the
//     `.gemlhistory` verbs and the code graph, and sends nothing anywhere.
//
// Nothing here parses GEML either: both servers ARE the reference parser, one
// over a socket and one over a pipe. This file only decides which to put on the
// editor's list — whether one ever STARTS is the editor's own prompt.
import * as vscode from "vscode";
import { childEnvOverrides, forShell, invocation, shellSafe } from "./cli.js";

/** The Worker the project deploys. `geml.mcp.url` overrides it. */
export const HOSTED_URL = "https://geml-mcp.supermarket.workers.dev/mcp";

/** The contribution id in package.json, and the activation event derived from it. */
export const PROVIDER_ID = "geml";

export type ServerChoice = "both" | "hosted" | "local" | "none";

export interface PlannedHttp {
  kind: "http";
  label: string;
  url: string;
}

export interface PlannedStdio {
  kind: "stdio";
  label: string;
  command: string;
  args: string[];
  /** The one directory the server is confined to; `--root .` resolves against it. */
  cwd: string;
}

export type Planned = PlannedHttp | PlannedStdio;

export interface PlanInput {
  choice: ServerChoice;
  url: string;
  /** Restricted Mode runs no CLI, so it offers no local server either. */
  trusted: boolean;
  folders: readonly { name: string; path: string }[];
  /** How the CLI is invoked, or null when it could not be found. */
  cli: { bin: string; lead: string[] } | null;
  windows: boolean;
  comspec?: string | undefined;
}

/**
 * Which servers to offer. Pure, because this is the whole of the extension's own
 * judgement here — everything else is the editor's API or the CLI's.
 */
export function plan(input: PlanInput): Planned[] {
  const out: Planned[] = [];

  if (input.choice === "both" || input.choice === "hosted") {
    const url = endpoint(input.url);
    if (url !== null) out.push({ kind: "http", label: "GEML (hosted)", url });
  }

  if ((input.choice === "both" || input.choice === "local") && input.trusted && input.cli !== null) {
    for (const folder of input.folders) {
      const server = local(input, input.cli, folder);
      if (server !== null) out.push(server);
    }
  }

  return out;
}

/**
 * The endpoint, when it is one we will send documents to.
 *
 * TLS is required: every call carries the whole document, and `workers.dev`
 * answers plain `http` with a 200 rather than a redirect, so a URL that merely
 * looks right would ship the text in clear. Loopback is the exception — that is
 * `wrangler dev`, where there is no network to listen on.
 */
function endpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url.toString();
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "http:" && loopback ? url.toString() : null;
}

/**
 * One local server per workspace folder.
 *
 * The folder's path never enters argv: it goes in `cwd`, which is a spawn option
 * no shell ever parses, and `--root .` resolves against it. That is the same
 * rule spawnCli() follows, and it is what keeps a checkout at `C:\work\a&b` from
 * reaching cmd.exe. What is left in argv is constant, plus whatever the user put
 * in `geml.check.path` themselves.
 */
function local(
  input: PlanInput,
  cli: { bin: string; lead: string[] },
  folder: { name: string; path: string },
): PlannedStdio | null {
  const label = input.folders.length > 1 ? `GEML (${folder.name})` : "GEML (local)";
  const args = [...cli.lead, "mcp", "--root", "."];

  // npm's `geml.cmd` shim has no .exe behind it, and a server definition is
  // spawned with no shell to run one — so cmd.exe becomes the command itself.
  if (!(input.windows && /\.(cmd|bat)$/i.test(cli.bin))) {
    return { kind: "stdio", label, command: cli.bin, args, cwd: folder.path };
  }
  if (input.comspec === undefined || input.comspec === "") return null;
  if (!shellSafe(cli.bin) || args.some((a) => !shellSafe(a))) return null;
  return {
    kind: "stdio",
    label,
    command: input.comspec,
    args: ["/d", "/s", "/c", forShell(cli.bin), ...args.map(forShell)],
    cwd: folder.path,
  };
}

/** What the settings and the open window currently say. */
function current(): Planned[] {
  const cfg = vscode.workspace.getConfiguration("geml");
  const choice = cfg.get<ServerChoice>("mcp.servers", "both");
  return plan({
    choice,
    url: cfg.get<string>("mcp.url", HOSTED_URL) || HOSTED_URL,
    trusted: vscode.workspace.isTrusted,
    folders: (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === "file")
      .map((f) => ({ name: f.name, path: f.uri.fsPath })),
    // Quiet: the editor polls this on its own schedule, so a missing CLI must not
    // become a popup nobody asked for. It shows up as the local server not being
    // on the list, which is the honest answer to the question that was asked.
    cli: choice === "hosted" || choice === "none" ? null : invocation(true),
    windows: process.platform === "win32",
    comspec: process.env.ComSpec ?? process.env.COMSPEC,
  });
}

function definition(p: Planned, version: string): vscode.McpServerDefinition {
  if (p.kind === "http") {
    return new vscode.McpHttpServerDefinition(p.label, vscode.Uri.parse(p.url), {}, version);
  }
  // The same PATH every CLI run gets: stripped of its relative entries, which
  // would otherwise name the folder the server was started in to whatever the
  // server starts in turn — a `#!/usr/bin/env node` line, or the `node` that
  // npm's geml.cmd shim calls.
  const server = new vscode.McpStdioServerDefinition(p.label, p.command, p.args, childEnvOverrides(), version);
  server.cwd = vscode.Uri.file(p.cwd);
  return server;
}

/**
 * Put the servers on the editor's list.
 *
 * Returns nothing on an editor that does not have the API: the same .vsix goes
 * to Open VSX, which reaches editors that are not VS Code, and an extension whose
 * activate() throws there would take the highlighting and the preview down with
 * it. `engines.vscode` already states the floor; this is what happens when
 * something claims it and does not mean it.
 */
export function register(context: vscode.ExtensionContext): vscode.Disposable[] {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== "function") return [];

  const version = String(context.extension.packageJSON.version ?? "");
  const changed = new vscode.EventEmitter<void>();
  const refresh = (): void => changed.fire();

  return [
    changed,
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => current().map((p) => definition(p, version)),
    }),
    // The list is derived from three things that all change while a window is
    // open; a stale list would offer a server that no longer makes sense.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("geml.mcp") || e.affectsConfiguration("geml.check.path")) refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidGrantWorkspaceTrust(refresh),
  ];
}
