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
 * Locate the CLI that ships inside the desktop app — the one that asks the
 * running app instead of opening its locked sqlite file.
 * @returns {{command: string, argsPrefix: string[], env: Record<string,string>, how: string}|null}
 */
export function findAppCli(probe) {
  // Node refuses to exec .cmd/.bat without a shell, so Windows looks for the
  // executable only; everywhere else the shim is extensionless.
  const names = probe.platform === "win32" ? ["logseq.exe"] : ["logseq"];

  // The separator follows the probed platform, not the host running this code —
  // splitting a Windows PATH on ":" would cut every drive letter off.
  const sep = probe.platform === "win32" ? ";" : ":";
  const dirs = (probe.env.PATH || "").split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (probe.exists(candidate)) {
        return { command: candidate, argsPrefix: [], env: {}, how: "found on PATH" };
      }
    }
  }

  const shim = join(probe.home, ".local", "bin", "logseq");
  if (probe.platform !== "win32" && probe.exists(shim)) {
    return { command: shim, argsPrefix: [], env: {}, how: "the shim the app installs" };
  }

  // No shim: drive the app bundle the way the shim would have. The binary is
  // Electron, so without ELECTRON_RUN_AS_NODE it opens the GUI instead.
  if (probe.platform === "darwin" && probe.exists(MAC_APP)) {
    return {
      command: MAC_APP,
      argsPrefix: [MAC_APP_CLI_JS],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      how: "the Logseq.app bundle",
    };
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
  if (open.length === 1) return { name: open[0], how: "open in the app" };
  if (all.length === 1) return { name: all[0], how: "the only graph" };

  return { candidates: all };
}
