#!/usr/bin/env node
// CLI Companion for Logseq GEML Sync
// Runs continuous or one-shot sync from a Logseq DB graph to a local Git-versioned GEML folder.
//
// Usage:
//   node bin/geml-sync.mjs <graph-name> <target-dir> [flags]
//
// Flags:
//   --watch               Run in continuous watch/sync loop
//   --interval <seconds>  Poll interval for watch mode (positive integer, default: 10)
//   --git-commit          Auto-commit changes to git (scoped strictly to sync folder)
//   --message <text>      Custom git commit message template

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { syncEdnToDisk } from "../src/sync-engine.mjs";

const args = process.argv.slice(2);
const positional = [];
const flags = {
  watch: false,
  gitCommit: false,
  interval: 10,
  message: null,
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
  } else if (arg.startsWith("--")) {
    console.error(`Error: Unknown flag "${arg}".`);
    process.exit(2);
  } else {
    positional.push(arg);
  }
}

if (positional.length < 2) {
  console.error("Usage: node bin/geml-sync.mjs <graph-name> <target-dir> [--watch] [--interval <sec>] [--git-commit] [--message <text>]");
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

let lastEdnHash = null;

async function performSync() {
  const tempEdnPath = join(tmpdir(), `logseq-export-${process.pid}-${Date.now()}-${randomUUID()}.edn`);
  try {
    // 1. Export from Logseq DB via official CLI
    runLogseqCli("export-edn", "-g", graphName, "-f", tempEdnPath);

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
  } finally {
    if (existsSync(tempEdnPath)) {
      try { unlinkSync(tempEdnPath); } catch {}
    }
  }
}

async function main() {
  console.log(`Starting GEML Sync: Graph "${graphName}" ➔ ${targetDir}`);
  if (flags.gitCommit) console.log("Git auto-commit: enabled (scoped to target paths)");

  if (!flags.watch) {
    // One-shot mode: fail loudly with non-zero exit code if sync fails
    try {
      await performSync();
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Sync failed:`, err.message);
      process.exit(1);
    }
    return;
  }

  // Watch mode: sequential non-overlapping setTimeout loop
  console.log(`Watch mode active (polling every ${flags.interval}s). Press Ctrl+C to stop.`);

  let running = true;
  let timer = null;
  let isSyncing = false;

  const cleanup = () => {
    running = false;
    if (timer) clearTimeout(timer);
    console.log("\nWatch mode stopped.");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  async function loop() {
    if (!running) return;
    if (!isSyncing) {
      isSyncing = true;
      try {
        await performSync();
      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] Sync error:`, err.message);
      } finally {
        isSyncing = false;
      }
    }
    if (running) {
      timer = setTimeout(loop, flags.interval * 1000);
    }
  }

  await loop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
