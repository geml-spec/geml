#!/usr/bin/env node
// PostToolUse hook — auto-version GEML edits.
//
// After the agent edits a `*.geml` file (Edit/Write), snapshot it into its
// `.gemlhistory` sidecar via `geml history commit`, so every edit step is
// retained and any block can later be rolled back (`geml revert <file> #id`).
// This is what makes "addressable + versioned" real for agent editing without
// relying on the agent to remember to commit each step.
//
// Contract: reads the hook payload as JSON on stdin, NEVER blocks the tool
// (always exits 0), and is a silent no-op for anything that isn't an existing
// `.geml` file. On a commit failure it prints one line to stderr and moves on.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

let raw = "";
try { for await (const chunk of process.stdin) raw += chunk; } catch { process.exit(0); }

let file, tool;
try {
  const j = JSON.parse(raw);
  file = j?.tool_input?.file_path;
  tool = j?.tool_name;
} catch { process.exit(0); }

if (typeof file !== "string" || !file.endsWith(".geml") || !existsSync(file)) process.exit(0);

const args = ["history", "commit", file, "-m", `auto: ${tool ?? "edit"}`];

// Prefer this repo's built CLI (dogfood, and no PATH/shim quirks); otherwise a
// globally installed `geml`. `file` is absolute, so the working directory is
// irrelevant — the sidecar is always written next to the edited file.
const localCli = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "geml-parser", "dist", "geml.js");
const r = existsSync(localCli)
  ? spawnSync(process.execPath, [localCli, ...args], { encoding: "utf8" })
  : spawnSync("geml", args, { encoding: "utf8", shell: true });

if (r.status !== 0) {
  const why = (r.stderr || r.error?.message || "commit failed").toString().trim();
  process.stderr.write(`[geml autocommit] skipped ${file}: ${why}\n`);
}
process.exit(0);
