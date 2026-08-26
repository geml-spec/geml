#!/usr/bin/env node
// CLI Companion for Logseq GEML Sync
// Runs continuous or one-shot sync from a Logseq DB graph to a local Git-versioned GEML folder.
//
// Usage:
//   node watcher/bin/geml-sync.mjs <graph-name> <target-dir> [flags]
//
// Flags:
//   --watch               Run in continuous watch/sync loop
//   --interval <seconds>  Poll interval for watch mode (positive integer, default: 10)
//   --git-commit          Auto-commit changes to git (scoped strictly to sync folder)
//   --message <text>      Custom git commit message template
//   --signal <file>       Sync immediately when this file changes (the in-app
//                         plugin writes it via logseq.FileStorage), and write
//                         the sync result to geml-sync-status.json beside it
//                         so the plugin can show it. Interval stays as fallback.
//   --app-cli <path>      Export through the Logseq DESKTOP APP's own CLI
//                         instead of @logseq/cli. The app CLI talks to the
//                         running app's db-worker, so it is the only route that
//                         works while the app has the graph open — @logseq/cli
//                         opens db.sqlite directly and hits the app's exclusive
//                         lock ("database is locked"). Point it at the
//                         executable, not a .cmd/.bat shim.
//   --api-server-token <token>
//                         Export the graph the Logseq app currently has OPEN,
//                         over its HTTP API server, instead of opening the
//                         graph's sqlite file directly. Required for continuous
//                         sync: while the app is running, its db-worker holds an
//                         exclusive lock on db.sqlite and a local export fails
//                         with "database is locked". Prefer the environment
//                         variable LOGSEQ_API_SERVER_TOKEN — a token in argv is
//                         visible to every process on the machine via `ps`.

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync, statSync, mkdirSync, watch } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { syncEdnToDisk, atomicWriteFileSync } from "../../core/src/sync-engine.mjs";
import { STATUS_FILE } from "../../core/src/bridge.mjs";

const args = process.argv.slice(2);
const positional = [];
const flags = {
  watch: false,
  gitCommit: false,
  interval: 10,
  message: null,
  signal: null,
  apiServerToken: null,
  appCli: null,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--watch") {
    flags.watch = true;
  } else if (arg === "--git-commit") {
    flags.gitCommit = true;
  } else if (arg === "--interval") {
    if (i + 1 >= args.length) {
      console.error("Error: --interval requires a value.");
      process.exit(2);
    }
    const rawVal = args[++i];
    const val = Number(rawVal);
    if (!Number.isInteger(val) || val <= 0) {
      console.error(`Error: --interval must be a positive integer >= 1 (got "${rawVal}").`);
      process.exit(2);
    }
    flags.interval = val;
  } else if (arg === "--message") {
    if (i + 1 >= args.length) {
      console.error("Error: --message requires a value.");
      process.exit(2);
    }
    flags.message = args[++i];
  } else if (arg === "--signal") {
    if (i + 1 >= args.length) {
      console.error("Error: --signal requires a value.");
      process.exit(2);
    }
    flags.signal = args[++i];
  } else if (arg === "--app-cli") {
    if (i + 1 >= args.length) {
      console.error("Error: --app-cli requires a value.");
      process.exit(2);
    }
    flags.appCli = args[++i];
  } else if (arg === "--api-server-token") {
    if (i + 1 >= args.length) {
      console.error("Error: --api-server-token requires a value.");
      process.exit(2);
    }
    flags.apiServerToken = args[++i];
  } else if (arg.startsWith("--")) {
    console.error(`Error: Unknown flag "${arg}".`);
    process.exit(2);
  } else {
    positional.push(arg);
  }
}

if (positional.length < 2) {
  console.error("Usage: node watcher/bin/geml-sync.mjs <graph-name> <target-dir> [--watch] [--interval <sec>] [--git-commit] [--message <text>] [--signal <file>] [--app-cli <path>] [--api-server-token <token>]");
  process.exit(2);
}

const [graphName, targetDirRaw] = positional;

// Validate graph name to prevent command/path injection
if (!/^[a-zA-Z0-9_.-]+$/.test(graphName)) {
  console.error(`Error: Invalid graph name "${graphName}". Only alphanumeric characters, hyphens, and underscores are allowed.`);
  process.exit(2);
}

const targetDir = resolve(targetDirRaw);
const cliCwd = process.env.LOGSEQ_CLI_DIR ?? process.cwd();
const signalPath = flags.signal ? resolve(flags.signal) : null;

// An explicit flag beats the environment; an empty value counts as absent, so
// `LOGSEQ_API_SERVER_TOKEN=` reads as "unset" rather than as an empty token.
const apiServerToken = (flags.apiServerToken || process.env.LOGSEQ_API_SERVER_TOKEN || "").trim() || null;

// execFileSync puts the whole failed argv — token included — into err.message,
// and that message is both printed and written into the status file the plugin
// renders in the toolbar. Scrub it on every path that surfaces an error.
// split/join, not a regex: a token is arbitrary text, not an escaped pattern.
// Which exporter to drive. The app CLI goes through the running app; the npm
// @logseq/cli opens the graph's sqlite file. They are different programs with
// different argument shapes, so combining one with the other's transport flag
// has no meaning — say so instead of silently ignoring half the request.
const appCli = (flags.appCli || process.env.LOGSEQ_APP_CLI || "").trim() || null;

if (appCli && apiServerToken) {
  console.error(
    "Error: --app-cli and --api-server-token are mutually exclusive — the app CLI reaches the running app directly, so it needs no token."
  );
  process.exit(2);
}
if (appCli && /\.(cmd|bat)$/i.test(appCli)) {
  console.error(
    `Error: --app-cli "${appCli}" is a .cmd/.bat shim; Node cannot run one without a shell. Point --app-cli at the Logseq executable itself.`
  );
  process.exit(2);
}

function redact(text) {
  const str = String(text ?? "");
  return apiServerToken ? str.split(apiServerToken).join("***") : str;
}

// The status file lands beside the signal file — the plugin's storage
// directory — the one place logseq.FileStorage.getItem can read it back from.
function writeStatus(status) {
  if (!signalPath) return;
  try {
    atomicWriteFileSync(join(dirname(signalPath), STATUS_FILE), JSON.stringify(status, null, 1) + "\n");
  } catch (err) {
    console.error(`Could not write status file: ${redact(err.message)}`);
  }
}

// Find @logseq/cli entry point or run via npx without shell: true
function runLogseqCli(...cmdArgs) {
  const directCliPath = resolve(cliCwd, "node_modules", "@logseq", "cli", "cli.mjs");
  if (existsSync(directCliPath)) {
    return execFileSync(process.execPath, [directCliPath, ...cmdArgs], {
      cwd: cliCwd,
      encoding: "utf8",
      shell: false,
      maxBuffer: 1 << 28,
    });
  }

  // Fallback to npx (executable npx.cmd on Windows, npx on Unix) without shell: true
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  return execFileSync(npxCmd, ["-y", "@logseq/cli", ...cmdArgs], {
    cwd: cliCwd,
    encoding: "utf8",
    shell: false,
    maxBuffer: 1 << 28,
  });
}

// 2.0 renamed the human-readable graph export: :graph now means the datoms
// dump, and :graph-human is the {:pages-and-blocks ...} shape this converter
// reads. Verified against the 2.0.1 app bundle.
function runAppCli(outFile) {
  return execFileSync(
    appCli,
    ["graph", "export", "--graph", graphName, "--type", "edn", "--file", outFile,
     "-e", "{:export-type :graph-human}"],
    { encoding: "utf8", shell: false, maxBuffer: 1 << 28 }
  );
}

let lastEdnHash = null;

async function performSync() {
  const tempEdnPath = join(tmpdir(), `logseq-export-${process.pid}-${Date.now()}-${randomUUID()}.edn`);
  try {
    // 1. Export from Logseq DB via official CLI.
    // With a token the CLI goes through the running app's HTTP API server and
    // exports whatever graph the app has OPEN — the graph name is not part of
    // that request, so -a REPLACES -g rather than joining it. Without a token
    // the CLI opens the named graph's sqlite directly, which only works while
    // the app does not hold the lock on it.
    if (appCli) {
      runAppCli(tempEdnPath);
    } else {
      const exportSource = apiServerToken ? ["-a", apiServerToken] : ["-g", graphName];
      runLogseqCli("export-edn", ...exportSource, "-f", tempEdnPath);
    }

    if (!existsSync(tempEdnPath)) {
      throw new Error(`Export failed: ${tempEdnPath} was not created.`);
    }

    const stat = statSync(tempEdnPath);
    if (stat.size === 0) {
      throw new Error(`Export produced an empty (0 byte) EDN file.`);
    }

    const ednText = readFileSync(tempEdnPath, "utf8");

    // 2. Efficiency: In watch mode, skip disk scanning if export content is bit-for-bit identical
    const currentHash = createHash("sha256").update(ednText).digest("hex");
    if (flags.watch && currentHash === lastEdnHash) {
      return;
    }

    // 3. Incremental sync to disk
    const res = await syncEdnToDisk(ednText, targetDir, {
      autoCommit: flags.gitCommit,
      commitMessage: flags.message || `logseq-geml: sync graph "${graphName}" (${new Date().toISOString()})`,
    });

    lastEdnHash = currentHash;
    writeStatus({
      ok: true,
      at: new Date().toISOString(),
      graph: graphName,
      written: res.written.length,
      unchanged: res.unchanged.length,
      orphaned: res.orphaned.length,
      deleted: res.deleted.length,
    });

    const timestamp = new Date().toLocaleTimeString();
    const parts = [`${res.written.length} written`, `${res.unchanged.length} unchanged`];
    if (res.orphaned && res.orphaned.length > 0) {
      parts.push(`${res.orphaned.length} orphaned/absent from export (preserved safely)`);
    }
    if (res.deleted && res.deleted.length > 0) {
      parts.push(`${res.deleted.length} deleted`);
    }

    if (res.written.length > 0 || res.deleted.length > 0) {
      console.log(`[${timestamp}] Synced: ${parts.join(", ")}.`);
      if (res.gitResult && res.gitResult.committed) {
        console.log(`  Git: ${res.gitResult.output}`);
      }
    } else if (!flags.watch) {
      console.log(`[${timestamp}] Graph is up-to-date (${parts.join(", ")}).`);
    }
  } catch (err) {
    writeStatus({ ok: false, at: new Date().toISOString(), graph: graphName, error: redact(err.message) });
    throw err;
  } finally {
    if (existsSync(tempEdnPath)) {
      try { unlinkSync(tempEdnPath); } catch {}
    }
  }
}

async function main() {
  console.log(`Starting GEML Sync: Graph "${graphName}" ➔ ${targetDir}`);
  // Never echo the token itself — these logs get pasted into bug reports.
  if (appCli) {
    console.log(`Export source: the Logseq desktop app's own CLI (${appCli}) — works while the app has the graph open`);
  }
  if (apiServerToken) {
    console.log("Export source: the running app's API server — the graph the app has OPEN, whichever that is");
  }
  if (flags.gitCommit) console.log("Git auto-commit: enabled (scoped to target paths)");

  if (!flags.watch) {
    // One-shot mode: fail loudly with non-zero exit code if sync fails
    try {
      await performSync();
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Sync failed:`, redact(err.message));
      process.exit(1);
    }
    return;
  }

  // Watch mode: sequential non-overlapping syncs. The interval loop is the
  // heartbeat; a --signal file, when given, triggers a sync the moment the
  // in-app plugin reports a change, instead of waiting out the interval.
  console.log(`Watch mode active (polling every ${flags.interval}s). Press Ctrl+C to stop.`);

  let running = true;
  let timer = null;
  let isSyncing = false;
  let queued = false;
  let fsWatcher = null;
  let signalTimer = null;

  const cleanup = () => {
    running = false;
    if (timer) clearTimeout(timer);
    if (signalTimer) clearTimeout(signalTimer);
    if (fsWatcher) fsWatcher.close();
    console.log("\nWatch mode stopped.");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  async function requestSync() {
    if (!running) return;
    if (isSyncing) {
      // A change arrived mid-sync: run once more when this one finishes,
      // rather than dropping it or overlapping exports.
      queued = true;
      return;
    }
    isSyncing = true;
    try {
      await performSync();
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Sync error:`, redact(err.message));
    } finally {
      isSyncing = false;
    }
    if (queued) {
      queued = false;
      await requestSync();
    }
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(async () => {
      await requestSync();
      scheduleNext();
    }, flags.interval * 1000);
  }

  if (signalPath) {
    const signalDir = dirname(signalPath);
    mkdirSync(signalDir, { recursive: true });
    try {
      // Watch the directory, not the file: the plugin's storage write may
      // replace the file, and a watch pinned to the old inode goes silent.
      fsWatcher = watch(signalDir, (eventType, filename) => {
        // A null filename is legal on some platforms; treat it as a hit.
        if (filename && filename !== basename(signalPath)) return;
        if (signalTimer) clearTimeout(signalTimer);
        signalTimer = setTimeout(() => {
          signalTimer = null;
          requestSync();
        }, 300);
      });
      console.log(`Signal file watched: ${signalPath}`);
    } catch (err) {
      console.error(`Signal watch failed (${redact(err.message)}); interval polling only.`);
    }
  }

  await requestSync();
  scheduleNext();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
