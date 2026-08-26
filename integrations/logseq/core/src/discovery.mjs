// Everything the watcher can work out for itself. Each function takes a
// `probe` — { platform, env, home, exists, read, listDir } — so the logic is
// testable on any OS without a Logseq installation, and so `doctor` can report
// exactly what was found and where.
import { join } from "node:path";
import { SIGNAL_FILE } from "./bridge.mjs";

export const PLUGIN_ID = "logseq-plugin-sync-vault-with-geml";

// The app bundle path is stable across macOS installs, and the shim the app
// writes to ~/.local/bin is a two-line wrapper around exactly this pair.
const MAC_APP = "/Applications/Logseq.app/Contents/MacOS/Logseq";
const MAC_APP_CLI_JS = "/Applications/Logseq.app/Contents/Resources/app.asar/js/logseq-cli.js";

/** Config, plugins and plugin storage — NOT where graphs live. */
export function logseqDotDir(probe) {
  return probe.env.LOGSEQ_DOTDIR || join(probe.home, ".logseq");
}

/** Graph root: `<root>/graphs/<name>/db.sqlite`. The app CLI calls it --root-dir. */
export function logseqRootDir(probe) {
  return probe.env.LOGSEQ_ROOT_DIR || join(probe.home, "logseq");
}

/** The file the in-app plugin touches to say "the graph changed". */
export function signalFilePath(probe) {
  return join(logseqDotDir(probe), "storages", PLUGIN_ID, SIGNAL_FILE);
}

/**
 * What the user set in the plugin's own settings panel. Absent or half-written
 * settings are not an error — they just mean "nothing configured yet".
 */
export function pluginSettings(probe) {
  const path = join(logseqDotDir(probe), "settings", `${PLUGIN_ID}.json`);
  try {
    const parsed = JSON.parse(probe.read(path));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The launcher the app writes to its CLI install directory is a two-line
 * wrapper it generates itself, and it stamps "logseq-cli-managed" into the
 * file. On Windows that launcher is a .cmd, which Node cannot exec without a
 * shell — but the two paths it names can be exec'd directly, which is all the
 * wrapper does anyway. So: read it, do not run it.
 * @returns {{command: string, argsPrefix: string[], env: Record<string,string>, how: string}|null}
 */
export function parseManagedShim(probe, path) {
  let text;
  try {
    text = probe.read(path);
  } catch {
    return null;
  }
  if (!text.includes("logseq-cli-managed")) return null;
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const exe = quoted[0];
  const cliJs = quoted.find((q) => q.endsWith(".js"));
  if (!exe || !cliJs) return null;
  return {
    command: exe,
    argsPrefix: [cliJs],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    how: `read from the launcher at ${path}`,
  };
}

/**
 * Every plausible way to reach the app's CLI, best first.
 *
 * The ranking matters more than the search: what the app itself installed is
 * something it chose, on a platform we may never have run on. Anything we
 * DEDUCE — a launcher we parse, a bundle path we hardcoded — ranks below it,
 * because those are our assumptions rather than the app's own answer.
 *
 * @returns {{command: string, argsPrefix: string[], env: Record<string,string>, how: string}[]}
 */
export function appCliCandidates(probe) {
  const win = probe.platform === "win32";
  const out = [];
  const seen = new Set();
  const add = (c) => {
    if (c && !seen.has(c.command)) { seen.add(c.command); out.push(c); }
  };

  // A launcher, wherever we find it: exec it directly when we can, and read
  // the paths out of it when we cannot (Windows .cmd).
  const launcher = (path, how) => {
    if (!probe.exists(path)) return null;
    if (/\.(cmd|bat)$/i.test(path)) {
      const parsed = parseManagedShim(probe, path);
      return parsed && { ...parsed, how: `${how}, read rather than run` };
    }
    return { command: path, argsPrefix: [], env: {}, how };
  };

  // 1. On PATH — the app put it there for exactly this.
  const sep = win ? ";" : ":";
  for (const dir of (probe.env.PATH || "").split(sep).filter(Boolean)) {
    for (const name of win ? ["logseq.exe", "logseq.cmd"] : ["logseq"]) {
      add(launcher(join(dir, name), "found on PATH"));
    }
  }

  // 2. The app's default CLI install directory, even when it is not on PATH.
  for (const name of win ? ["logseq.exe", "logseq.cmd"] : ["logseq"]) {
    add(launcher(join(probe.home, ".local", "bin", name), "the launcher the app installs"));
  }

  // 3. Last: a path we hardcoded. Verified before use, never assumed.
  if (probe.platform === "darwin" && probe.exists(MAC_APP)) {
    add({
      command: MAC_APP,
      argsPrefix: [MAC_APP_CLI_JS],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      how: "the Logseq.app bundle",
    });
  }

  return out;
}

/**
 * The CLI to use. Pass `verify` — a function that actually tries a candidate —
 * and the first one that works is returned, which beats any amount of guessing
 * about where things live on an OS or version we have not run on.
 * @param {(candidate: object) => boolean} [verify]
 */
export function findAppCli(probe, verify) {
  const candidates = appCliCandidates(probe);
  if (!verify) return candidates[0] ?? null;
  for (const c of candidates) {
    if (verify(c)) return c;
  }
  return null;
}

/**
 * Which graph to sync.
 * @returns {{name: string, how: string}|{candidates: string[]}|null}
 *   a name when it is unambiguous, a candidate list when the user must choose,
 *   null when there are no graphs at all.
 */
export function detectGraph(probe) {
  const graphsDir = join(logseqRootDir(probe), "graphs");
  const all = probe.listDir(graphsDir).filter((n) => !n.startsWith("."));
  if (all.length === 0) return null;

  // A db-worker lock says a worker exists, not that the app has the graph open:
  // every `logseq graph export` starts one of its own and leaves the file
  // behind. Only the desktop app stamps owner-source "electron", and that is
  // the graph whose sqlite the direct exporter cannot read.
  const open = all.filter((name) => {
    try {
      return JSON.parse(probe.read(join(graphsDir, name, "db-worker.lock")))["owner-source"] === "electron";
    } catch {
      return false;
    }
  });
  if (open.length === 1) return { name: open[0], how: "open in the app", graphs: all };
  if (all.length === 1) return { name: all[0], how: "the only graph", graphs: all };

  return { candidates: all, graphs: all };
}

/**
 * The same question as detectGraph, asked of the CLI instead of the filesystem.
 * `graph list` and `server list` are the app's own answers, so this holds on
 * any OS and for a graph root nobody left in the default place — and
 * owner-source comes from the app rather than from reading its lock files.
 *
 * @param {(args: string[]) => string} runCli returns stdout, or throws
 * @returns {{name: string, how: string, graphs: string[], rootDir: string|null}
 *          |{candidates: string[], graphs: string[], rootDir: string|null}
 *          |null} null means "could not ask" — the caller should fall back.
 */
export function detectGraphViaCli(runCli) {
  let graphs;
  try {
    graphs = JSON.parse(runCli(["graph", "list", "-o", "json"]))?.data?.graphs;
  } catch {
    return null;
  }
  if (!Array.isArray(graphs) || graphs.length === 0) return null;

  // Servers are a bonus, not a requirement: with none running we still know
  // the graphs, we just cannot tell which one the app has open.
  let open = null;
  let rootDir = null;
  try {
    const servers = JSON.parse(runCli(["server", "list", "-o", "json"]))?.data?.servers ?? [];
    rootDir = servers[0]?.["root-dir"] ?? null;
    const appOwned = servers.filter((s) => s?.["owner-source"] === "electron");
    if (appOwned.length === 1) open = appOwned[0].graph;
  } catch {}

  if (open && graphs.includes(open)) return { name: open, how: "open in the app", graphs, rootDir };
  if (graphs.length === 1) return { name: graphs[0], how: "the only graph", graphs, rootDir };
  return { candidates: graphs, graphs, rootDir };
}
